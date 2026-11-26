import { hash, argon2id } from 'argon2'
import type { Database } from './db.js'

export const demoPassword = 'RuangOperasi2026!'

export async function seedDemo(db: Database) {
  const passwordHash = await hash(demoPassword, { type: argon2id })
  await db.transaction(async (sql) => {
    const [{ exists }] = await sql.rows<{ exists: boolean }>('SELECT EXISTS (SELECT 1 FROM users) AS exists')
    if (exists) return

    await sql.rows(`
      INSERT INTO users (email, name, password_hash, role) VALUES
      ('admin@ruangoperasi.test', 'Raka Pratama', $1, 'admin'),
      ('manajer@ruangoperasi.test', 'Nadia Putri', $1, 'manager'),
      ('gudang@ruangoperasi.test', 'Dimas Saputra', $1, 'warehouse')
    `, [passwordHash])
    await sql.rows(`
      WITH opening AS (
        INSERT INTO products (sku, name, stock, min_stock) VALUES
        ('TOT-001', 'Everyday Canvas Tote', 4, 15),
        ('BOT-014', 'Tumbler Studio 500 ml', 7, 20),
        ('NBK-002', 'Notebook Grid A5', 3, 10),
        ('CAP-008', 'Studio Dad Cap', 0, 8),
        ('MUG-011', 'Ceramic Mug 300 ml', 37, 12),
        ('POU-004', 'Travel Organizer', 26, 8),
        ('SLV-005', 'Laptop Sleeve 13”', 18, 10),
        ('KEY-017', 'Studio Keyring', 120, 20)
        RETURNING id, stock
      )
      INSERT INTO stock_movements (product_id, delta, reason, ref_type)
      SELECT id, stock, 'saldo awal demo', 'opening' FROM opening WHERE stock > 0
    `)
    await sql.rows(`
      WITH days AS (
        SELECT (now() AT TIME ZONE 'Asia/Jakarta')::date - offset_day AS day, offset_day
        FROM generate_series(0, 75) AS offset_day
      ), samples AS (
        SELECT day, offset_day, n,
          ARRAY['Tokopedia', 'Shopee', 'Website', 'TikTok Shop'] AS channels,
          ARRAY['Aulia Ramadhani','Kevin Wijaya','Maya Salsabila','Fajar Aditya','Shinta Larasati',
            'Bagas Prakoso','Nabila Putri','Dewi Kartika','Tio Wibowo','Rani Maharani','Iqbal Maulana','Putri Ananda'] AS buyers
        FROM days
        CROSS JOIN LATERAL generate_series(1, (CASE offset_day % 7
          WHEN 0 THEN 42 WHEN 1 THEN 82 WHEN 2 THEN 71 WHEN 3 THEN 51
          WHEN 4 THEN 75 WHEN 5 THEN 47 ELSE 60 END) - least(offset_day / 7 * 3, 25)) AS n
      )
      INSERT INTO orders (order_no, channel, status, customer_name, customer_contact, total_amount, ordered_at, source_updated_at)
      SELECT 'PS-' || to_char(day, 'YYMMDD') || '-' || lpad(n::text, 3, '0'),
        channels[CASE WHEN (n * 7 + offset_day) % 20 < 8 THEN 1
          WHEN (n * 7 + offset_day) % 20 < 14 THEN 2 WHEN (n * 7 + offset_day) % 20 < 18 THEN 3 ELSE 4 END],
        CASE WHEN n % 37 = 0 OR (offset_day BETWEEN 7 AND 13 AND n % 17 = 0) THEN 'cancelled'
          WHEN offset_day = 0 AND n % 5 = 0 THEN 'shipped'
          WHEN offset_day = 0 AND n % 3 = 0 THEN 'processing'
          WHEN offset_day = 0 AND n % 3 = 1 THEN 'paid'
          ELSE 'completed' END,
        buyers[(n + offset_day) % 12 + 1],
        'pelanggan' || n || '@example.test',
        (55 + (n * 37 + offset_day * 13) % 390) * 1000,
        CASE WHEN offset_day = 0 THEN now() - make_interval(mins => n * 3)
          ELSE (day + time '09:00') AT TIME ZONE 'Asia/Jakarta' + make_interval(mins => n * 7) END,
        now()
      FROM samples
    `)
  })
}
