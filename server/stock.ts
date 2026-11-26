import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { adjustmentReasons, stockStates, type Product, type StockState } from '../shared/domain.js'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Database, Sql } from './db.js'
import { ApiError, audit, identifier, pageInput, requireUser, schema } from './http.js'

const productId = z.object({ id: identifier })
const productQuery = pageInput.extend({ state: z.enum([...stockStates, 'peringatan']).optional(), q: z.string().trim().max(120).optional() })
const adjustmentInput = z.object({
  delta: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0, 'Masukkan perubahan selain nol.'),
  reason: z.enum(adjustmentReasons),
})
const thresholdInput = z.object({ min_stock: z.number().int().min(0).max(1_000_000) })
const stateField = "CASE WHEN stock=0 THEN 'habis' WHEN stock<min_stock THEN 'menipis' ELSE 'aman' END"
const productFields = 'id,sku,name,stock,min_stock'

function state(product: Pick<Product, 'stock' | 'min_stock'>): StockState {
  if (product.stock === 0) return 'habis'
  return product.stock < product.min_stock ? 'menipis' : 'aman'
}

async function alertOnCrossing(sql: Sql, before: Product, after: Product, origin: string) {
  if (before.stock < before.min_stock || after.stock >= after.min_stock) return
  const managers = await sql.rows<{ email: string }>("SELECT email FROM users WHERE role='manager' AND is_active AND password_hash IS NOT NULL")
  if (!managers.length) return
  const [updated] = await sql.rows(`UPDATE products SET alert_enqueued_at=now() WHERE id=$1
    AND (alert_enqueued_at IS NULL OR alert_enqueued_at <= now() - interval '24 hours') RETURNING id`, [after.id])
  if (!updated) return
  await sql.rows("INSERT INTO jobs(id,kind,payload) VALUES($1,'email',$2::jsonb)", [randomUUID(), JSON.stringify({
    recipients: managers.map((manager) => manager.email),
    subject: `Peringatan stok · ${after.name}`,
    text: `${after.name} (${after.sku}) tersisa ${after.stock} unit. Ambang minimum ${after.min_stock} unit.\n\n${origin}/stok?sku=${encodeURIComponent(after.sku)}`,
  })])
}

export function stockRoutes(app: FastifyInstance, db: Database, origin?: string) {
  const siteOrigin = (request: FastifyRequest) => origin ?? `${request.protocol}://${request.host}`
  app.get('/api/products', { schema: schema('Daftar stok produk', ['Stok'], { query: productQuery }) }, async (request) => {
    requireUser(request)
    const query = productQuery.parse(request.query)
    const values: unknown[] = []
    const conditions = ['is_active']
    if (query.state === 'peringatan') {
      conditions.push('(stock=0 OR stock<min_stock)')
    } else if (query.state) {
      values.push(query.state)
      conditions.push(`(${stateField})=$${values.length}`)
    }
    if (query.q) {
      values.push('%' + query.q.replace(/[\\%_]/g, '\\$&') + '%')
      conditions.push(`(sku ILIKE $${values.length} OR name ILIKE $${values.length})`)
    }
    const where = 'WHERE ' + conditions.join(' AND ')
    const [result] = await db.rows<{ total: number | string; items: Product[] }>(`
      SELECT (SELECT count(*) FROM products ${where}) AS total,
        coalesce((SELECT jsonb_agg(p) FROM (
          SELECT ${productFields},(${stateField}) AS state FROM products ${where}
          ORDER BY (stock >= min_stock AND stock <> 0), stock, name, id
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}
        ) p), '[]'::jsonb) AS items
    `, [...values, query.page_size, (query.page - 1) * query.page_size])
    return { items: result.items, total: Number(result.total), page: query.page, page_size: query.page_size }
  })

  app.get('/api/products/alerts', { schema: schema('Produk yang perlu diperiksa', ['Stok']) }, async (request) => {
    requireUser(request)
    const [counts] = await db.rows<{ out: number; low: number; safe: number }>(`
      SELECT count(*) FILTER (WHERE stock=0)::int AS out,
        count(*) FILTER (WHERE stock>0 AND stock<min_stock)::int AS low,
        count(*) FILTER (WHERE stock>0 AND stock>=min_stock)::int AS safe FROM products WHERE is_active
    `)
    const items = await db.rows<Product>(`SELECT ${productFields},(${stateField}) AS state
      FROM products WHERE is_active AND (stock=0 OR stock<min_stock) ORDER BY stock,name,id LIMIT 4`)
    return { ...counts, items }
  })

  app.get('/api/products/:id/movements', { schema: schema('Riwayat penyesuaian stok', ['Stok'], { params: productId }) }, async (request) => {
    requireUser(request)
    const { id } = productId.parse(request.params)
    return { items: await db.rows(`SELECT m.id,m.delta,m.reason,m.created_at,u.name AS actor
      FROM stock_movements m LEFT JOIN users u ON u.id=m.created_by WHERE m.product_id=$1
      ORDER BY m.created_at DESC,m.id DESC LIMIT 50`, [id]) }
  })

  app.post('/api/products/:id/adjust', { schema: schema('Sesuaikan stok fisik', ['Stok'], { body: adjustmentInput, params: productId }) }, async (request) => {
    const actor = requireUser(request, ['admin', 'warehouse'])
    const { id } = productId.parse(request.params)
    const { delta, reason } = adjustmentInput.parse(request.body)
    return db.transaction(async (sql) => {
      const [before] = await sql.rows<Product>(`SELECT ${productFields} FROM products WHERE id=$1 AND is_active FOR UPDATE`, [id])
      if (!before) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Produk tidak ditemukan.')
      const after = { ...before, stock: before.stock + delta }
      if (after.stock < 0 || after.stock > 2147483647) throw new ApiError(409, 'STOCK_OUT_OF_RANGE', 'Penyesuaian membuat jumlah stok di luar batas.')
      await sql.rows('UPDATE products SET stock=$1 WHERE id=$2', [after.stock, id])
      const [movement] = await sql.rows<{ id: number }>(`INSERT INTO stock_movements(product_id,delta,reason,ref_type,created_by)
        VALUES($1,$2,$3,'manual',$4) RETURNING id`, [id, delta, reason, actor.id])
      await audit(sql, actor.id, 'stock.adjust', 'products', id, { stock: before.stock }, { stock: after.stock, delta, reason, movement_id: movement.id })
      await alertOnCrossing(sql, before, after, siteOrigin(request))
      return { ...after, state: state(after) }
    })
  })

  app.patch('/api/products/:id/threshold', { schema: schema('Ubah ambang minimum', ['Stok'], { body: thresholdInput, params: productId }) }, async (request) => {
    const actor = requireUser(request, ['admin'])
    const { id } = productId.parse(request.params)
    const { min_stock } = thresholdInput.parse(request.body)
    return db.transaction(async (sql) => {
      const [before] = await sql.rows<Product>(`SELECT ${productFields} FROM products WHERE id=$1 AND is_active FOR UPDATE`, [id])
      if (!before) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Produk tidak ditemukan.')
      const after = { ...before, min_stock }
      if (min_stock !== before.min_stock) {
        await sql.rows('UPDATE products SET min_stock=$1 WHERE id=$2', [min_stock, id])
        await audit(sql, actor.id, 'stock.threshold', 'products', id, { min_stock: before.min_stock }, { min_stock })
        await alertOnCrossing(sql, before, after, siteOrigin(request))
      }
      return { ...after, state: state(after) }
    })
  })
}
