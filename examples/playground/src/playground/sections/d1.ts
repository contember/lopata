import { registerSection } from '../registry'

const SEED_SQL = `
        CREATE TABLE IF NOT EXISTS categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          description TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          sku TEXT NOT NULL UNIQUE,
          category_id INTEGER REFERENCES categories(id),
          price REAL NOT NULL,
          stock INTEGER NOT NULL DEFAULT 0,
          weight_kg REAL,
          is_active INTEGER NOT NULL DEFAULT 1,
          description TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS customers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL UNIQUE,
          first_name TEXT NOT NULL,
          last_name TEXT NOT NULL,
          phone TEXT,
          city TEXT,
          country TEXT NOT NULL DEFAULT 'CZ',
          note TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS orders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_id INTEGER NOT NULL REFERENCES customers(id),
          status TEXT NOT NULL DEFAULT 'pending',
          total REAL NOT NULL DEFAULT 0,
          shipping_address TEXT,
          tracking_number TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          shipped_at TEXT
        );
        CREATE TABLE IF NOT EXISTS order_items (
          order_id INTEGER NOT NULL REFERENCES orders(id),
          product_id INTEGER NOT NULL REFERENCES products(id),
          quantity INTEGER NOT NULL,
          unit_price REAL NOT NULL,
          PRIMARY KEY (order_id, product_id)
        );
        CREATE TABLE IF NOT EXISTS tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          label TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS product_tags (
          product_id INTEGER NOT NULL REFERENCES products(id),
          tag_id INTEGER NOT NULL REFERENCES tags(id),
          PRIMARY KEY (product_id, tag_id)
        );

        DELETE FROM order_items;
        DELETE FROM orders;
        DELETE FROM product_tags;
        DELETE FROM products;
        DELETE FROM customers;
        DELETE FROM categories;
        DELETE FROM tags;

        INSERT INTO categories (name, slug, description, sort_order) VALUES
          ('Electronics', 'electronics', 'Gadgets and devices', 1),
          ('Books', 'books', 'Physical and digital books', 2),
          ('Clothing', 'clothing', NULL, 3),
          ('Home & Garden', 'home-garden', 'Furniture, decor, tools', 4),
          ('Food & Drink', 'food-drink', 'Gourmet items and beverages', 5);

        INSERT INTO products (name, sku, category_id, price, stock, weight_kg, is_active, description) VALUES
          ('Wireless Mouse', 'ELEC-001', 1, 29.99, 150, 0.12, 1, 'Ergonomic wireless mouse with USB-C receiver'),
          ('Mechanical Keyboard', 'ELEC-002', 1, 89.50, 42, 0.85, 1, 'Cherry MX Brown switches, TKL layout'),
          ('USB-C Hub', 'ELEC-003', 1, 45.00, 0, 0.15, 0, 'Out of stock — 7-port hub'),
          ('27" Monitor', 'ELEC-004', 1, 349.99, 18, 5.2, 1, NULL),
          ('Clean Code', 'BOOK-001', 2, 35.90, 200, 0.65, 1, 'Robert C. Martin — A Handbook of Agile Software Craftsmanship'),
          ('DDIA', 'BOOK-002', 2, 42.00, 85, 0.9, 1, 'Designing Data-Intensive Applications by Martin Kleppmann'),
          ('The Pragmatic Programmer', 'BOOK-003', 2, 39.99, 120, 0.7, 1, NULL),
          ('TypeScript Handbook', 'BOOK-004', 2, 0, 999, NULL, 1, 'Free digital download'),
          ('Cotton T-Shirt', 'CLTH-001', 3, 19.99, 500, 0.2, 1, '100% organic cotton, unisex'),
          ('Winter Jacket', 'CLTH-002', 3, 129.00, 35, 1.1, 1, 'Water-resistant, -20°C rated'),
          ('Standing Desk', 'HOME-001', 4, 599.00, 8, 32.0, 1, 'Electric height-adjustable, 160x80cm'),
          ('Desk Lamp', 'HOME-002', 4, 34.50, 67, 1.2, 1, 'LED, adjustable color temperature'),
          ('Espresso Beans 1kg', 'FOOD-001', 5, 18.90, 300, 1.0, 1, 'Single-origin Ethiopian Yirgacheffe'),
          ('Matcha Powder', 'FOOD-002', 5, 24.50, 0, 0.1, 0, NULL);

        INSERT INTO tags (label) VALUES ('bestseller'), ('new'), ('sale'), ('eco-friendly'), ('premium');

        INSERT INTO product_tags (product_id, tag_id) VALUES
          (1, 1), (1, 4),
          (2, 2), (2, 5),
          (5, 1),
          (6, 1), (6, 5),
          (9, 4),
          (11, 2), (11, 5),
          (13, 1), (13, 4);

        INSERT INTO customers (email, first_name, last_name, phone, city, country, note) VALUES
          ('alice@example.com', 'Alice', 'Nováková', '+420601111111', 'Praha', 'CZ', NULL),
          ('bob@example.com', 'Bob', 'Dvořák', '+420602222222', 'Brno', 'CZ', 'VIP customer'),
          ('charlie@example.com', 'Charlie', 'Smith', NULL, 'London', 'GB', NULL),
          ('diana@example.com', 'Diana', 'Müller', '+491701234567', 'Berlin', 'DE', 'Prefers DHL shipping'),
          ('eva@example.com', 'Eva', 'Svobodová', '+420605555555', 'Ostrava', 'CZ', NULL),
          ('frank@example.com', 'Frank', 'Kovář', NULL, NULL, 'CZ', 'Wholesale buyer'),
          ('grace@example.com', 'Grace', 'Hopper', '+1-555-0100', 'New York', 'US', NULL),
          ('hana@example.com', 'Hana', 'Procházková', '+420608888888', 'Plzeň', 'CZ', NULL);

        INSERT INTO orders (customer_id, status, total, shipping_address, tracking_number, shipped_at) VALUES
          (1, 'delivered', 119.49, 'Vinohradská 12, Praha 2', 'CZ12345678', '2025-12-01 10:00:00'),
          (1, 'shipped', 349.99, 'Vinohradská 12, Praha 2', 'CZ23456789', '2026-01-15 14:30:00'),
          (2, 'pending', 89.50, 'Masarykova 5, Brno', NULL, NULL),
          (3, 'delivered', 75.89, '42 Baker St, London', 'GB98765432', '2025-11-20 09:00:00'),
          (4, 'processing', 633.50, 'Friedrichstr. 100, Berlin', NULL, NULL),
          (5, 'pending', 19.99, 'Stodolní 7, Ostrava', NULL, NULL),
          (6, 'cancelled', 599.00, NULL, NULL, NULL),
          (7, 'delivered', 77.90, '123 Broadway, New York', 'US11223344', '2025-10-05 16:00:00'),
          (2, 'delivered', 42.00, 'Masarykova 5, Brno', 'CZ34567890', '2026-02-01 11:00:00'),
          (8, 'shipped', 164.49, 'Americká 42, Plzeň', 'CZ45678901', '2026-02-10 08:00:00');

        INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
          (1, 1, 1, 29.99),
          (1, 2, 1, 89.50),
          (2, 4, 1, 349.99),
          (3, 2, 1, 89.50),
          (4, 5, 1, 35.90),
          (4, 9, 2, 19.99),
          (5, 11, 1, 599.00),
          (5, 12, 1, 34.50),
          (6, 9, 1, 19.99),
          (7, 11, 1, 599.00),
          (8, 5, 1, 35.90),
          (8, 6, 1, 42.00),
          (9, 6, 1, 42.00),
          (10, 10, 1, 129.00),
          (10, 5, 1, 35.49);
      `

registerSection({
	slug: 'd1',
	title: 'D1 Database',
	html: `
  <div class="links">
    <a href="#" onclick="api('POST','/d1/seed');return false">Seed sample data</a>
    <a href="#" onclick="api('POST','/d1/exec',{sql:'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL)'});return false">Create table</a>
    <a href="#" onclick="api('GET','/d1/query?sql='+encodeURIComponent('SELECT * FROM users'));return false">SELECT * FROM users</a>
    <a href="#" onclick="api('GET','/d1/tables');return false">List tables</a>
  </div>
  <form onsubmit="api('POST','/d1/query',{sql:formVal('d1-sql'),params:formVal('d1-params')?JSON.parse(formVal('d1-params')):[]});return false">
    <label>SQL <textarea id="d1-sql">INSERT INTO users (name, email) VALUES (?, ?)</textarea></label>
    <label>Params (JSON array) <input id="d1-params" value='["Alice","alice@example.com"]'></label>
    <button type="submit">Execute</button>
  </form>
  `,
	async handle(request, env) {
		const url = new URL(request.url)
		const path = url.pathname
		const method = request.method

		if (path === '/d1/tables' && method === 'GET') {
			const result = await env.DB.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
			).all()
			return Response.json(result)
		}
		if (path === '/d1/query' && method === 'GET') {
			const sql = url.searchParams.get('sql')
			if (!sql) return new Response('Missing sql param', { status: 400 })
			const result = await env.DB.prepare(sql).all()
			return Response.json(result)
		}
		if (path === '/d1/query' && method === 'POST') {
			const body = (await request.json()) as { sql: string; params?: unknown[] }
			const stmt = body.params?.length
				? env.DB.prepare(body.sql).bind(...body.params)
				: env.DB.prepare(body.sql)
			const result = await stmt.all()
			return Response.json(result)
		}
		if (path === '/d1/exec' && method === 'POST') {
			const body = (await request.json()) as { sql: string }
			const result = await env.DB.exec(body.sql)
			return Response.json(result)
		}
		if (path === '/d1/seed' && method === 'POST') {
			await env.DB.exec(SEED_SQL)
			return Response.json({ ok: true, message: 'Seeded 7 tables with sample data' })
		}
		return null
	},
})
