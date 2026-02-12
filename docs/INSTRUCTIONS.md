# Agent Instructions

Instrukce pro AI agenta implementujícího bunflare runtime.

## Dostupné dokumenty

1. **`docs/issues/`** - Jednotlivé implementační úkoly
2. **`docs/STATUS.md`** - Aktuální stav projektu (průběžně aktualizuj)
3. **`CLAUDE.md`** - Pravidla projektu (Bun, ne Node.js)

## Workflow

### 1. Zjisti aktuální stav

```
1. Přečti docs/STATUS.md
2. Najdi první nevyřešený issue (status: pending)
```

### 2. Implementuj issue

```
1. Přečti detailně issue soubor (např. docs/issues/00-persistence-layer.md)
2. Zkontroluj závislosti - issues s nižším číslem musí být completed
3. Implementuj dle requirements v issue
4. Piš čistý TypeScript kód
```

**DŮLEŽITÉ:** Navržená implementace v issue souborech je orientační. Můžeš se odchýlit, pokud to vede k lepšímu dosažení cíle. Důležité je splnit requirements, ne kopírovat navržený kód 1:1.

### 3. Ověř implementaci

```
1. Spusť testy: bun test runtime/tests/
2. Spusť type check: bunx tsc --noEmit
3. Ověř že stávající funkcionalita stále funguje (všechny testy prochází)
```

**DŮLEŽITÉ:** Nespouštěj `bun runtime/dev.ts` pro testování — používej integrační testy. Pokud přeci jen spustíš server, vždy ho ukonči (kill) aby neblokoval port 8787.

### 4. Commitni změny

Po úspěšném ověření **vždy commitni**:

```bash
git add <relevant files>
git commit -m "feat: implement #XX - short description"
```

### 5. Aktualizuj dokumentaci

```
1. Aktualizuj docs/STATUS.md:
   - Změň status issue na "completed"
   - Přidej záznam do CHANGELOG sekce
   - Aktualizuj "Current Focus" na další issue
   - Přidej learned lessons pokud jsou relevantní
2. NEPŘEPISUJ issue soubor - nech ho jako referenci
3. Commitni STATUS.md update
```

### 6. Zapiš learned lessons

Do sekce "Lessons Learned" v STATUS.md zapisuj **užitečné poznatky** pro budoucí sessions:

- Problémy na které jsi narazil a jak jsi je vyřešil
- Neintuitivní chování Bun API nebo bun:sqlite
- Workaroundy které bylo třeba použít
- Cokoliv co by příští agent neměl znovu objevovat

## Pravidla implementace

### Kód

- **TypeScript** - žádné `any`, žádné `@ts-ignore`
- **Bun APIs** - `bun:sqlite`, `Bun.file()`, `Bun.serve()`, `Bun.write()` (viz CLAUDE.md)
- **Persistence** - všechno do SQLite nebo souborů, nic in-memory (kromě cache DO instancí)
- **Jednoduchý kód** - žádné over-engineering, žádné zbytečné abstrakce

### Struktura

```
runtime/
  dev.ts                      # Main entrypoint
  config.ts                   # Parse wrangler.jsonc
  plugin.ts                   # Bun plugin shimming cloudflare:workers
  env.ts                      # Build env object from config
  db.ts                       # Shared SQLite database singleton
  bindings/
    kv.ts                     # KVNamespace
    r2.ts                     # R2Bucket
    durable-object.ts         # DurableObject + namespace + storage
    workflow.ts               # WorkflowEntrypoint + binding
    d1.ts                     # D1Database
    queue.ts                  # Queue producer + consumer
    cache.ts                  # Cache API
    service-binding.ts        # Service Bindings
    static-assets.ts          # Static Assets
    images.ts                 # Images binding
```

### Testování

Ke každému issue **napiš integrační testy** do `runtime/tests/`. Testy ověřují binding implementace přímo (bez HTTP serveru):

```ts
// runtime/tests/kv.test.ts
import { test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteKVNamespace } from "../bindings/kv";

let kv: SqliteKVNamespace;

beforeEach(() => {
  const db = new Database(":memory:");
  // create tables...
  kv = new SqliteKVNamespace(db, "TEST_KV");
});

test("put and get", async () => {
  await kv.put("key", "value");
  expect(await kv.get("key")).toBe("value");
});

test("get non-existent key returns null", async () => {
  expect(await kv.get("missing")).toBeNull();
});

test("delete removes key", async () => {
  await kv.put("key", "value");
  await kv.delete("key");
  expect(await kv.get("key")).toBeNull();
});
```

Pravidla:
- Při migraci existujícího bindingu (issues 14-17) VŽDY aktualizuj odpovídající test soubor — import, constructor, beforeEach setup
- Když přidáváš nový binding, přidej jeho config fields do `WranglerConfig` v `runtime/config.ts`
- Každý binding má vlastní test soubor: `runtime/tests/<binding>.test.ts`
- Testuj přímo třídu bindingu, ne přes HTTP
- Používej in-memory SQLite (`:memory:`) v testech pro izolaci
- Testuj edge cases: neexistující klíče, expiraci, list s prefixem, prázdné výsledky
- Spouštěj testy: `bun test runtime/tests/`
- Type check: `bunx tsc --noEmit`

## Quick Reference

```bash
# Run tests
bun test runtime/tests/

# Type check
bunx tsc --noEmit

# Start dev server
bun runtime/dev.ts
```

## Ukončení

Když jsou **všechny issues completed** (žádné pending), odpověz pouze:

```
<done>promise</done>
```
