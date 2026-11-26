import { z } from 'zod'
import { dayInJakarta, shiftDay, type Metrics } from '../shared/domain'
import type { FastifyInstance } from 'fastify'
import type { Database } from './db'
import { ApiError, requireUser, schema } from './http'
import { dayInput, validateRange } from './orders'

const kpiQuery = z.object({ from: dayInput.optional(), to: dayInput.optional() })
interface DailyRow {
  day: string
  channel: string
  revenue: number | string
  orders: number | string
  cancelled: number | string
  revenue_orders: number | string
}

function summarize(rows: DailyRow[]): Metrics {
  let revenue = 0n
  let orders = 0, cancelled = 0, paid = 0
  for (const row of rows) {
    revenue += BigInt(row.revenue)
    orders += Number(row.orders)
    cancelled += Number(row.cancelled)
    paid += Number(row.revenue_orders)
  }
  const paidCount = BigInt(paid)
  return {
    revenue: revenue.toString(), orders,
    average: paid ? Number((revenue + paidCount / 2n) / paidCount) : 0,
    cancellation: orders ? (cancelled / orders) * 100 : 0,
  }
}

export function kpiRoutes(app: FastifyInstance, db: Database, refreshed: () => string) {
  app.get('/api/kpi', { schema: schema('Ringkasan penjualan per periode', ['Ringkasan'], { query: kpiQuery }) }, async (request) => {
    requireUser(request, ['admin', 'manager'])
    const query = kpiQuery.parse(request.query)
    const to = query.to ?? dayInJakarta()
    const from = query.from ?? shiftDay(to, -6)
    validateRange(from, to)
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1
    if (days > 365 || to > dayInJakarta()) throw new ApiError(400, 'KPI_RANGE_INVALID', 'Pilih rentang sampai hari ini dengan durasi maksimal 365 hari.')
    const rows = await db.rows<DailyRow>('SELECT day::text,channel,revenue,orders,cancelled,revenue_orders FROM sales_daily WHERE day BETWEEN $1::date AND $2::date', [shiftDay(from, -days), to])
    const currentRows = rows.filter((row) => row.day >= from)
    const current = summarize(currentRows)
    const previous = summarize(rows.filter((row) => row.day < from))
    const series = new Map(Array.from({ length: days }, (_, index) => [shiftDay(from, index), 0n]))
    const channels = new Map<string, number>()
    for (const row of currentRows) {
      series.set(row.day, (series.get(row.day) ?? 0n) + BigInt(row.revenue))
      channels.set(row.channel, (channels.get(row.channel) ?? 0) + Number(row.orders))
    }
    const change = (key: 'revenue' | 'orders' | 'average') => {
      const before = Number(previous[key])
      const after = Number(current[key])
      return before ? (after - before) / before * 100 : after === 0 ? 0 : null
    }
    return {
      current, previous,
      changes: { orders: change('orders'), revenue: change('revenue'), average: change('average'), cancellation: current.cancellation - previous.cancellation },
      series: Array.from(series, ([day, revenue]) => ({ day, revenue: revenue.toString() })),
      channels: Array.from(channels, ([channel, orders]) => ({ channel, orders })).sort((a, b) => b.orders - a.orders),
      refreshed_at: refreshed(),
    }
  })
}
