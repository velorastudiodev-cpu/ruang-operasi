import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { parse as parseCsv } from 'csv-parse/sync'
import { z } from 'zod'
import { shiftDay, statuses, type Order } from '../shared/domain'
import type { FastifyInstance } from 'fastify'
import type { Database, Sql } from './db'
import { ApiError, audit, equalTokens, pageInput, requireUser, schema } from './http'

export const dayInput = z.iso.date()
export const rangeInput = z.object({ from: dayInput.optional(), to: dayInput.optional() })
const sortFields = ['ordered_at', 'order_no', 'status', 'channel', 'total_amount'] as const
const sortDirections = ['asc', 'desc'] as const
export const orderFilters = rangeInput.extend({
  status: z.enum(statuses).optional(),
  channel: z.string().trim().min(1).max(80).optional(),
  q: z.string().trim().max(120).optional(),
  sort: z.enum(sortFields).default('ordered_at'),
  direction: z.enum(sortDirections).default('desc'),
})
const listInput = orderFilters.extend(pageInput.shape)
export type Filters = z.infer<typeof orderFilters>

const receivedOrder = z.object({
  order_no: z.string().trim().min(1).max(120),
  channel: z.string().trim().min(1).max(80),
  status: z.enum(statuses),
  customer_name: z.string().trim().min(1).max(200),
  customer_contact: z.string().trim().max(200).default(''),
  total_amount: z.number().int().min(0).max(100_000_000_000),
  refunded_amount: z.number().int().min(0).max(100_000_000_000).default(0),
  ordered_at: z.iso.datetime({ offset: true }),
  source_updated_at: z.iso.datetime({ offset: true }),
}).refine((value) => value.refunded_amount <= value.total_amount, { message: 'Refund melebihi total pesanan.', path: ['refunded_amount'] })
const receivedBatch = z.object({ orders: z.array(receivedOrder).min(1).max(5_000) })
const csvBody = z.object({ csv: z.string().min(1).max(4_000_000) })
const exportId = z.object({ id: z.uuid() })

export interface OrderRow extends Omit<Order, 'ordered_at' | 'total_amount'> {
  ordered_at: string | Date
  total_amount: number | string
}
export const orderFields = 'id,order_no,channel,status,customer_name,customer_contact,total_amount,ordered_at'

export function validateRange(from?: string, to?: string) {
  if (from && to && from > to) throw new ApiError(400, 'DATE_RANGE_INVALID', 'Tanggal mulai harus sebelum atau sama dengan tanggal akhir.')
}

export function whereOrders(filters: Filters, hideCustomers = false) {
  validateRange(filters.from, filters.to)
  const values: unknown[] = []
  const parts: string[] = []
  const value = (newValue: unknown) => { values.push(newValue); return '$' + values.length }
  if (filters.status) parts.push(`status=${value(filters.status)}`)
  if (filters.channel) parts.push(`channel=${value(filters.channel)}`)
  if (filters.from) parts.push(`ordered_at >= (${value(filters.from)}::date::timestamp AT TIME ZONE 'Asia/Jakarta')`)
  if (filters.to) parts.push(`ordered_at < (${value(shiftDay(filters.to, 1))}::date::timestamp AT TIME ZONE 'Asia/Jakarta')`)
  if (filters.q) {
    const pattern = value('%' + filters.q.replace(/[\\%_]/g, '\\$&') + '%')
    parts.push(hideCustomers ? `order_no ILIKE ${pattern}` : `(order_no ILIKE ${pattern} OR customer_name ILIKE ${pattern})`)
  }
  return { values, where: parts.length ? 'WHERE ' + parts.join(' AND ') : '' }
}

export function orderBy(filters: Filters) {
  return `${filters.sort} ${filters.direction}, id ${filters.direction}`
}

function presentOrder(row: OrderRow, warehouse: boolean): Order {
  const { customer_contact, customer_name, total_amount, ...order } = row
  const initials = customer_name.trim().split(/\s+/).slice(0, 3).map((name) => Array.from(name)[0].toUpperCase() + '.').join(' ')
  return {
    ...order,
    ordered_at: new Date(row.ordered_at).toISOString(),
    ...(warehouse ? { customer_name: initials } : { customer_name, customer_contact, total_amount: Number(total_amount) }),
  }
}

async function ingest(db: Database, orders: z.infer<typeof receivedOrder>[], actor: number | null, source: string) {
  return db.transaction(async (sql) => {
    const changed = await sql.rows<{ channel: string; order_no: string }>(`
      INSERT INTO orders (order_no,channel,status,customer_name,customer_contact,total_amount,refunded_amount,ordered_at,source_updated_at)
      SELECT DISTINCT ON (channel, order_no) order_no,channel,status,customer_name,customer_contact,total_amount,refunded_amount,ordered_at,source_updated_at
      FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS item(body, position)
      CROSS JOIN LATERAL jsonb_to_record(item.body) AS r(order_no text,channel text,status text,customer_name text,customer_contact text,
        total_amount bigint,refunded_amount bigint,ordered_at timestamptz,source_updated_at timestamptz)
      ORDER BY channel, order_no, source_updated_at DESC, position
      ON CONFLICT (channel,order_no) DO UPDATE SET status=excluded.status, customer_name=excluded.customer_name,
        customer_contact=excluded.customer_contact,total_amount=excluded.total_amount,refunded_amount=excluded.refunded_amount,
        ordered_at=excluded.ordered_at,source_updated_at=excluded.source_updated_at
      WHERE excluded.source_updated_at > orders.source_updated_at
      RETURNING channel,order_no
    `, [JSON.stringify(orders)])
    const result = { received: orders.length, changed: changed.length, skipped: orders.length - changed.length }
    if (changed.length) await audit(sql, actor, `orders.${source}`, 'orders', null, null, { ...result, orders: changed })
    return result
  })
}

export async function orderRoutes(app: FastifyInstance, db: Database, ingestKey: string) {
  app.get('/api/orders', { schema: schema('Daftar pesanan', ['Pesanan'], { query: listInput }) }, async (request) => {
    const user = requireUser(request)
    const filters = listInput.parse(request.query)
    const warehouse = user.role === 'warehouse'
    if (warehouse && filters.sort === 'total_amount') throw new ApiError(403, 'FORBIDDEN_SORT', 'Pengurutan ini tidak tersedia untuk staf gudang.')
    const { where, values } = whereOrders(filters, warehouse)
    const fields = warehouse ? orderFields.replace(',customer_contact,total_amount', '') : orderFields
    const [result] = await db.rows<{ total: string | number; items: OrderRow[] }>(`
      SELECT (SELECT count(*) FROM orders ${where}) AS total,
        coalesce((SELECT jsonb_agg(p) FROM (
          SELECT ${fields} FROM orders ${where} ORDER BY ${orderBy(filters)}
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}
        ) p), '[]'::jsonb) AS items
    `, [...values, filters.page_size, (filters.page - 1) * filters.page_size])
    return { items: result.items.map((order) => presentOrder(order, warehouse)), total: Number(result.total), page: filters.page, page_size: filters.page_size }
  })

  app.get('/api/orders/channels', { schema: schema('Kanal penjualan', ['Pesanan']) }, async (request) => {
    requireUser(request)
    const channels = await db.rows<{ channel: string }>('SELECT DISTINCT channel FROM sales_daily ORDER BY channel')
    return { items: channels.map((row) => row.channel) }
  })

  app.post('/api/orders/export', { schema: schema('Antrekan ekspor CSV', ['Pesanan'], { body: orderFilters }) }, async (request, reply) => {
    const actor = requireUser(request, ['admin', 'manager'])
    const filters = orderFilters.parse(request.body ?? {})
    validateRange(filters.from, filters.to)
    const id = randomUUID()
    await db.transaction(async (sql) => {
      await sql.rows("INSERT INTO jobs (id,kind,owner_id,payload) VALUES($1,'export',$2,$3::jsonb)", [id, actor.id, JSON.stringify(filters)])
      const { q, ...logged } = filters
      await audit(sql, actor.id, 'orders.export', 'orders', id, null, { ...logged, keyword_filter: Boolean(q) })
    })
    return reply.code(202).send({ job_id: id })
  })

  app.get('/api/orders/exports', { schema: schema('Status ekspor milik pengguna', ['Pesanan']) }, async (request) => {
    const actor = requireUser(request, ['admin', 'manager'])
    return { items: await db.rows(`SELECT id,status,row_count,created_at,expires_at,
      (status='done' AND expires_at > now() AND result_path IS NOT NULL) AS downloadable
      FROM jobs WHERE owner_id=$1 AND kind='export' ORDER BY created_at DESC LIMIT 20`, [actor.id]) }
  })

  app.get('/api/orders/exports/:id/download', { schema: schema('Unduh hasil ekspor', ['Pesanan'], { params: exportId }) }, async (request, reply) => {
    const actor = requireUser(request, ['admin', 'manager'])
    const { id } = exportId.parse(request.params)
    const [job] = await db.rows<{ result_path: string }>(`SELECT result_path FROM jobs
      WHERE id=$1 AND owner_id=$2 AND kind='export' AND status='done' AND expires_at > now() AND result_path IS NOT NULL`, [id, actor.id])
    if (!job) throw new ApiError(404, 'EXPORT_UNAVAILABLE', 'Hasil ekspor belum siap atau tautan sudah kedaluwarsa.')
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="pesanan-${id.slice(0, 8)}.csv"`).send(createReadStream(job.result_path))
  })

  const ingestSchema = schema('Terima batch pesanan', ['Ingest'], { body: receivedBatch, public: true })
  app.post('/api/ingest/orders', { bodyLimit: 5_000_000, schema: { ...ingestSchema, security: [{ ingestKey: [] }] } }, async (request) => {
    if (!ingestKey || !equalTokens(String(request.headers['x-api-key'] ?? ''), ingestKey)) {
      throw new ApiError(401, 'INGEST_KEY_INVALID', 'Kunci ingest tidak valid.')
    }
    return ingest(db, receivedBatch.parse(request.body).orders, null, 'ingest')
  })

  app.post('/api/orders/import', { bodyLimit: 5_000_000, schema: schema('Impor CSV pesanan', ['Ingest'], { body: csvBody }) }, async (request) => {
    const actor = requireUser(request, ['admin'])
    const { csv } = csvBody.parse(request.body)
    let rows: Record<string, string>[]
    try {
      rows = parseCsv(csv, { columns: true, bom: true, skip_empty_lines: true, trim: true })
    } catch {
      throw new ApiError(400, 'CSV_INVALID', 'Format CSV tidak valid. Periksa header dan pemisah koma.')
    }
    if (!rows.length || rows.length > 5000) throw new ApiError(400, 'CSV_SIZE_INVALID', 'Impor harus berisi 1 hingga 5.000 pesanan.')
    const orders = rows.map((row, index) => {
      const result = receivedOrder.safeParse({
        ...row, total_amount: row.total_amount ? Number(row.total_amount) : undefined,
        refunded_amount: row.refunded_amount ? Number(row.refunded_amount) : 0,
      })
      if (!result.success) throw new ApiError(400, 'CSV_ROW_INVALID', `Baris data ${index + 1} tidak valid (${result.error.issues[0].path.join('.')}).`)
      return result.data
    })
    return ingest(db, orders, actor.id, 'import')
  })
}

export function countOrders(sql: Sql, where: string, values: unknown[]) {
  return sql.rows<{ count: string | number }>(`SELECT count(*) FROM orders ${where}`, values)
}
