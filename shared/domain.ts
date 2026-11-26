export const roles = ['admin', 'manager', 'warehouse'] as const
export type Role = (typeof roles)[number]

export const statuses = ['pending', 'paid', 'processing', 'shipped', 'completed', 'cancelled', 'refunded'] as const
export type OrderStatus = (typeof statuses)[number]

export const adjustmentReasons = ['rusak', 'hilang', 'koreksi hitung'] as const
export const stockStates = ['aman', 'menipis', 'habis'] as const
export type StockState = (typeof stockStates)[number]

export const roleLabels: Record<Role, string> = {
  admin: 'Admin',
  manager: 'Manajer',
  warehouse: 'Staf gudang',
}

export const statusLabels: Record<OrderStatus, string> = {
  pending: 'Menunggu bayar',
  paid: 'Dibayar',
  processing: 'Diproses',
  shipped: 'Dikirim',
  completed: 'Selesai',
  cancelled: 'Dibatalkan',
  refunded: 'Dikembalikan',
}

export interface SessionUser {
  id: number
  name: string
  email: string
  role: Role
}

export interface Order {
  id: number
  order_no: string
  channel: string
  status: OrderStatus
  customer_name: string
  customer_contact?: string
  total_amount?: number
  ordered_at: string
}

export interface Product {
  id: number
  sku: string
  name: string
  stock: number
  min_stock: number
  state: StockState
}

export interface Page<T> {
  items: T[]
  page: number
  page_size: number
  total: number
}

export interface Metrics {
  revenue: string
  orders: number
  average: number
  cancellation: number
}

export interface Kpi {
  current: Metrics
  previous: Metrics
  changes: Record<keyof Metrics, number | null>
  series: { day: string; revenue: string }[]
  channels: { channel: string; orders: number }[]
  refreshed_at: string
}

const jakartaDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
})

export function dayInJakarta(date = new Date()) {
  const parts = Object.fromEntries(jakartaDay.formatToParts(date).map(({ type, value }) => [type, value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function shiftDay(day: string, amount: number) {
  const date = new Date(day)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}
