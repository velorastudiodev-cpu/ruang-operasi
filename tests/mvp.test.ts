import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { setTimeout as pause } from 'node:timers/promises'
import { buildApp } from '../server/app'
import { demoPassword } from '../server/seed'
import { dayInJakarta, shiftDay } from '../shared/domain'

let app: Awaited<ReturnType<typeof buildApp>>['app']
let db: Awaited<ReturnType<typeof buildApp>>['db']
let refresh: Awaited<ReturnType<typeof buildApp>>['refreshKpi']
let folder: string
let admin: Headers
let warehouse: Headers
let manager: Headers

type Headers = { cookie: string; 'x-csrf-token': string }
async function login(name: string): Promise<Headers> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${name}@ruangoperasi.test`, password: demoPassword } })
  assert.equal(response.statusCode, 200, response.body)
  assert.match(String(response.headers['set-cookie']), /HttpOnly; SameSite=Lax/)
  return { cookie: String(response.headers['set-cookie']).split(';')[0], 'x-csrf-token': response.json().csrf_token }
}

before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'ruang-operasi-test-'))
  const result = await buildApp({ databaseUrl: process.env.TEST_DATABASE_URL, databasePath: 'memory://', demo: true, ingestKey: 'test-key', dataFolder: folder })
  app = result.app
  db = result.db
  refresh = result.refreshKpi
  admin = await login('admin')
  warehouse = await login('gudang')
  manager = await login('manajer')
})

after(async () => {
  await app?.close()
  if (folder) await rm(folder, { recursive: true, force: true })
})

test('sesi wajib dan staf gudang tidak melihat kontak atau mencari nama lengkap', async () => {
  assert.equal((await app.inject('/api/orders')).statusCode, 401)
  const orders = await app.inject({ url: '/api/orders', headers: warehouse })
  assert.equal(orders.statusCode, 200, orders.body)
  assert.ok(orders.json().items.length > 0)
  assert.match(orders.json().items[0].customer_name, /^\S\. \S\./)
  assert.ok(!Object.hasOwn(orders.json().items[0], 'customer_contact'))
  const searched = await app.inject({ url: '/api/orders?q=Aulia%20Ramadhani', headers: warehouse })
  assert.equal(searched.json().total, 0)
  assert.equal((await app.inject({ url: '/api/kpi', headers: warehouse })).statusCode, 403)
  assert.equal((await app.inject({ url: '/api/audit-logs', headers: manager })).statusCode, 403)
  assert.equal((await app.inject({ method: 'POST', url: '/api/orders/export', headers: { cookie: admin.cookie }, payload: {} })).json().error.code, 'CSRF_INVALID')
})

test('KPI sesuai query mentah dan filter gabungan menghasilkan hitungan SQL', async () => {
  const to = dayInJakarta()
  const from = shiftDay(to, -6)
  const response = await app.inject({ url: `/api/kpi?from=${from}&to=${to}`, headers: admin })
  assert.equal(response.statusCode, 200, response.body)
  const [raw] = await db.rows<{ revenue: string; total: string; cancelled: string; paid: string }>(`
    SELECT sum(CASE WHEN status IN ('paid','processing','shipped','completed')
      THEN total_amount - refunded_amount ELSE 0 END) AS revenue, count(*) AS total,
      count(*) FILTER (WHERE status='cancelled') AS cancelled,
      count(*) FILTER (WHERE status IN ('paid','processing','shipped','completed')) AS paid
    FROM orders WHERE (ordered_at AT TIME ZONE 'Asia/Jakarta')::date BETWEEN $1 AND $2
  `, [from, to])
  assert.deepEqual(response.json().current, {
    revenue: String(raw.revenue), orders: Number(raw.total),
    cancellation: Number(raw.cancelled) / Number(raw.total) * 100,
    average: Math.round(Number(raw.revenue) / Number(raw.paid)),
  })
  const filtered = await app.inject({ url: `/api/orders?channel=Shopee&status=completed&q=Aulia&from=${from}&to=${to}`, headers: admin })
  const [{ total }] = await db.rows<{ total: string }>(`SELECT count(*) AS total FROM orders WHERE channel='Shopee' AND status='completed'
    AND customer_name ILIKE '%Aulia%' AND (ordered_at AT TIME ZONE 'Asia/Jakarta')::date BETWEEN $1 AND $2`, [from, to])
  assert.equal(filtered.statusCode, 200, filtered.body)
  assert.equal(filtered.json().total, Number(total))
})

test('ingest membedakan kanal, menolak kunci salah dan mengabaikan pembaruan lama', async () => {
  const at = new Date().toISOString()
  const payload = { orders: ['Website', 'Shopee'].map((channel) => ({
    channel, order_no: 'TEST-INGEST-001', status: 'paid', customer_name: 'Pelanggan Uji',
    total_amount: 50000, ordered_at: at, source_updated_at: at,
  })) }
  const send = (body: typeof payload, key = 'test-key') => app.inject({ method: 'POST', url: '/api/ingest/orders', headers: { 'x-api-key': key }, payload: body })
  assert.equal((await send(payload, 'wrong-key')).statusCode, 401)
  const response = await send(payload)
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().changed, 2)
  assert.equal((await send(payload)).json().changed, 0)
  const updates = (source_updated_at: string) => ({ orders: [{ ...payload.orders[0], status: 'cancelled', source_updated_at }] })
  assert.equal((await send(updates(new Date(Date.parse(at) - 1000).toISOString()))).json().changed, 0)
  assert.equal((await send(updates(new Date(Date.parse(at) + 1000).toISOString()))).json().changed, 1)
  const csv = [
    'order_no,channel,status,customer_name,total_amount,ordered_at,source_updated_at',
    `TEST-CSV-001,Website,paid,Pelanggan CSV,20000,${at},${at}`,
  ].join('\n')
  const imported = await app.inject({ method: 'POST', url: '/api/orders/import', headers: admin, payload: { csv } })
  assert.equal(imported.statusCode, 200, imported.body)
  assert.equal(imported.json().changed, 1)
  await refresh()
  assert.equal((await app.inject({ url: '/api/orders?q=TEST-INGEST-001', headers: admin })).json().total, 2)
})

test('penyesuaian bersamaan menjaga stok, audit, dan batas peringatan', async () => {
  const [product] = await db.rows<{ id: number }>("SELECT id FROM products WHERE sku='MUG-011'")
  const adjust = (delta: number, headers = warehouse) => app.inject({ method: 'POST', url: `/api/products/${product.id}/adjust`, headers, payload: { delta, reason: 'koreksi hitung' } })
  assert.equal((await adjust(-1, manager)).statusCode, 403)
  const results = await Promise.all([adjust(-32), adjust(-32)])
  assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 409], results.map((result) => result.body).join(' '))
  assert.equal((await adjust(30)).statusCode, 200)
  assert.equal((await adjust(-31)).statusCode, 200)
  const [moves] = await db.rows<{ count: string }>("SELECT count(*) FROM stock_movements WHERE product_id=$1 AND ref_type='manual'", [product.id])
  const [notifications] = await db.rows<{ count: string }>("SELECT count(*) FROM jobs WHERE kind='email'")
  assert.equal(Number(moves.count), 3)
  assert.equal(Number(notifications.count), 1)
  const logs = await app.inject({ url: '/api/audit-logs', headers: admin })
  assert.equal(logs.statusCode, 200, logs.body)
  assert.equal(logs.json().items.filter((item: { action: string }) => item.action === 'stock.adjust').length, 3)
  await assert.rejects(db.rows('DELETE FROM audit_logs'), /append-only/)
})

test('ekspor CSV mengikuti filter dan hasil hanya tersedia bagi pemilik', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/orders/export', headers: manager, payload: { q: 'TEST-INGEST-001', status: 'paid' } })
  assert.equal(response.statusCode, 202, response.body)
  const id = response.json().job_id
  const url = `/api/orders/exports/${id}/download`
  assert.equal((await app.inject({ url, headers: admin })).statusCode, 404)
  let file = await app.inject({ url, headers: manager })
  for (let attempt = 0; file.statusCode === 404 && attempt < 30; attempt++) {
    await pause(160)
    file = await app.inject({ url, headers: manager })
  }
  assert.equal(file.statusCode, 200, file.body)
  assert.match(file.body, /"TEST-INGEST-001","Shopee","Dibayar"/)
  assert.equal(file.body.trim().split('\n').length, 2)
  assert.ok((await readdir(join(folder, 'exports'))).includes(id + '.csv'))
})

test('admin terakhir terlindungi, undangan sekali pakai, dan penonaktifan mencabut sesi', async () => {
  const forbidden = await app.inject({ method: 'PATCH', url: '/api/users/1', headers: admin, payload: { is_active: false } })
  assert.equal(forbidden.json().error.code, 'LAST_ADMIN')
  const invited = await app.inject({ method: 'POST', url: '/api/users', headers: admin,
    payload: { email: 'anggota@example.test', name: 'Anggota Uji', role: 'warehouse' } })
  assert.equal(invited.statusCode, 201, invited.body)
  const token = new URL(invited.json().preview_url).searchParams.get('undangan')
  const accept = () => app.inject({ method: 'POST', url: '/api/auth/accept-invite', payload: { token, password: 'KataSandiPengujian2026!' } })
  assert.equal((await accept()).statusCode, 200)
  assert.equal((await accept()).json().error.code, 'INVITATION_INVALID')
  const disabled = await app.inject({ method: 'PATCH', url: '/api/users/2', headers: admin, payload: { is_active: false } })
  assert.equal(disabled.statusCode, 200, disabled.body)
  assert.equal((await app.inject({ url: '/api/auth/session', headers: manager })).statusCode, 401)
})

test('lima kegagalan mengunci akun dan sesi tidak aktif berakhir setelah delapan jam', async () => {
  const failed = () => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'gudang@ruangoperasi.test', password: 'wrong-password' } })
  for (let i = 0; i < 4; i++) assert.equal((await failed()).statusCode, 401)
  assert.equal((await failed()).statusCode, 423)
  await db.rows("UPDATE sessions SET last_seen=now() - interval '8 hours 1 minute' WHERE user_id=3")
  assert.equal((await app.inject({ url: '/api/auth/session', headers: warehouse })).statusCode, 401)
})
