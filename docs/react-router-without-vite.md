# React Router bez Vite — co by to znamenalo

React Router v7 je navržený jako Vite-first framework. Všechna jeho "magie" (file-based routing, type-safe loaders, client/server code splitting) žije ve Vite pluginu (`@react-router/dev/vite`). Tento dokument popisuje, co by bylo potřeba reimplementovat, aby React Router fungoval v Bunflare čistě přes Bun bez Vite.

## Co dělá React Router Vite plugin

### 1. Route discovery (~800 řádků v pluginu)

Skenuje `app/routes/` a z file struktury staví route manifest:

```
app/routes/
  _index.tsx          → /
  about.tsx           → /about
  admin._layout.tsx   → /admin (layout)
  admin.users.tsx     → /admin/users
  admin.users.$id.tsx → /admin/users/:id
```

Výstup je strom `RouteConfig` objektů s `id`, `path`, `file`, `children`, `index`.

**Reimplementace:** Středně složité. Je to čistá logika (scan directory + naming conventions), žádné AST transformy. ~200-300 řádků. Ale musí trackovat React Router konvence, které se můžou měnit mezi verzemi.

### 2. Virtual modul `virtual:react-router/server-build` (~300 řádků)

Generuje modul, který importuje všechny route soubory a exportuje `ServerBuild` objekt:

```typescript
// Generovaný kód (zjednodušeně)
import * as route0 from "./app/root.tsx";
import * as route1 from "./app/routes/_index.tsx";
import * as route2 from "./app/routes/about.tsx";

export const routes = {
  "root": { id: "root", path: "", module: route0, hasLoader: true, ... },
  "routes/_index": { id: "routes/_index", index: true, module: route1, ... },
  // ...
};
export const assets = { /* client manifest - URL mapování chunků */ };
export { default as entry } from "./app/entry.server.tsx";
```

**Reimplementace:** `Bun.plugin()` s `build.module()` umí vytvořit virtuální moduly. Problém je `assets` — client manifest vyžaduje znalost client build outputu (hash chunků, URL cesty). Bez client bundleru toto nejde vygenerovat.

### 3. Client/server code splitting (~400 řádků, Babel transform)

Route soubor exportuje loader (server) i component (client) z jednoho souboru:

```typescript
import { db } from "bun:sqlite"          // server-only

export const loader = async () => {       // server-only
  return db.query("SELECT * FROM users")
}

export default function Users({ loaderData }) {  // client + server
  return <ul>{loaderData.map(u => <li>{u.name}</li>)}</ul>
}
```

Vite plugin přes Babel transform vytvoří **client verzi** kde jsou server exporty (`loader`, `action`, `headers`) odstraněny. Tree-shaking pak vyhodí nepoužívané server-only importy (`bun:sqlite`).

**Reimplementace:** Hlavní blocker. Bun's bundler nemá plugin API pro AST transformy. Možnosti:
- **Babel transform** — napsat vlastní Babel plugin (~100 řádků), ale potřebuješ Babel pipeline
- **es-module-lexer** — detekuje exporty, ale neumí je bezpečně odstranit (nemá AST)
- **Separátní soubory** — jiná konvence: `route.server.ts` + `route.client.tsx`. Funguje ale rozbíjí React Router standard
- **Shimování** — místo strippingu poskytnout client shimy pro `cloudflare:workers`, `bun:sqlite` atd. Funguje pro přímé importy, ale selhává na tranzitivní závislosti (container → database driver → node:crypto → ...)

### 4. React Fast Refresh (~200 řádků, Babel transform)

Babel transform (`react-refresh/babel`) instrumentuje každou React komponentu pro hot-reloading bez ztráty stavu. Vite přidává HMR runtime, který při změně souboru nahradí jen změněnou komponentu.

**Reimplementace:** Bun má `--hot` (full module reload), ale ne component-level HMR. Výsledek: každá změna = full page reload, ztráta stavu formulářů, scrollu, atd. Pro implementaci Fast Refresh by bylo potřeba:
- Babel transform pro instrumentaci komponent
- WebSocket server pro HMR komunikaci s browserem
- HMR runtime v browseru (~500 řádků)

### 5. Client manifest a asset serving

React Router SSR potřebuje vědět, které JS/CSS soubory patří ke které route, aby mohl generovat správné `<script>` a `<link>` tagy:

```html
<link rel="stylesheet" href="/assets/admin-D4f2x.css">
<script type="module" src="/assets/admin-layout-Bk9x2.js"></script>
<script type="module" src="/assets/admin-users-A3m1p.js"></script>
```

Toto vyžaduje client build s content-hash pojmenováním a manifest soubor.

**Reimplementace:** `Bun.build()` umí bundlovat s `naming: "[name]-[hash].[ext]"`. Ale potřebuješ:
- Entry pointy z každé route (ne z jednoho souboru)
- Code splitting per-route
- Manifest generování (který chunk patří ke které route)
- Dev server pro servírování assetů s proper MIME types

### 6. Type generování (~500 řádků)

Generuje `.react-router/types/` s type-safe interfaces:

```typescript
// .react-router/types/app/routes/admin/users/+types/$id.ts
export namespace Route {
  export type LoaderArgs = { params: { id: string }, context: AppLoadContext }
  export type ComponentProps = { loaderData: Awaited<ReturnType<typeof loader>> }
}
```

**Reimplementace:** Samostatný skript, nezávislý na Vite. React Router má CLI pro toto (`react-router typegen`). Šlo by volat separátně.

### 7. Lazy route discovery

V SPA módu servíruje `/__manifest` endpoint pro client-side route discovery.

**Reimplementace:** Triviální — JSON endpoint s route manifestem.

## Celkový odhad

| Komponenta | Složitost | Řádků | Blocker? |
|---|---|---|---|
| Route discovery | střední | ~300 | ne |
| Virtual server-build modul | střední | ~200 | ne |
| Client/server code splitting | **vysoká** | ~500+ | **ano** |
| React Fast Refresh | vysoká | ~800+ | ne (ale velký DX hit) |
| Client manifest + asset serving | střední | ~300 | ne |
| Type generování | nízká | ~50 (volání CLI) | ne |
| File watcher + rebuild | nízká | ~100 | ne |
| **Celkem** | | **~2000-2500** | |

## Hlavní rizika

1. **Fragilita** — React Router interní `ServerBuild` formát není veřejné API. Může se změnit v minor verzi.
2. **Tranzitivní importy** — shimování server-only modulů pro client nefunguje genericky. Každý projekt importuje jiné server packages.
3. **DX regrese** — bez Fast Refresh je dev experience výrazně horší (full page reload místo component update).
4. **Údržba** — musíš trackovat změny ve dvou projektech (React Router + Bun), bez žádné garance kompatibility.

## Porovnání s Vite plugin přístupem

Alternativa: napsat `@bunflare/vite-plugin` jako drop-in replacement pro `@cloudflare/vite-plugin`. Vite + React Router plugin řeší body 1-6 výše. Bunflare plugin jen dodá:
- Resolving `cloudflare:workers` → lokální bindings (~50 řádků)
- Globální CF APIs (caches, HTMLRewriter) (~50 řádků)
- Dev server middleware s `buildEnv()` (~200 řádků)
- Config hook pro SSR environment (~30 řádků)

Celkem ~500-700 řádků, žádné AST transformy, žádné trackování React Router internals.

## Závěr

Bez Vite je to proveditelné, ale vyžaduje ~4x více kódu, horší DX, a dlouhodobě neudržitelné kvůli závislosti na interních API React Routeru. Vite plugin přístup deleguje složitost na Vite a frameworkové pluginy, které jsou navrženy přesně pro toto.
