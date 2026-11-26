import { useState, type FormEvent } from 'react'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import {
  ArrowDownRight, ArrowRight, ArrowUpRight, CalendarDays, ChartNoAxesCombined, CircleX, Coins,
  PackageOpen, ShoppingBag, TriangleAlert, Wallet, type LucideIcon,
} from 'lucide-react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { dayInJakarta, shiftDay, type Kpi, type Metrics, type Order, type Page } from '../shared/domain'
import { api, searchUrl } from './api'
import type { Alerts } from './app'
import { dateTime, Empty, ErrorState, Loading, longDay, Modal, number, OrderPill, percentage, ProductIcon, rupiah, shortDay, time } from './ui'

type Range = { from: string; to: string }
type Period = 'today' | 'week' | 'month' | 'custom'
const cards: { key: keyof Metrics; label: string; color: string; icon: LucideIcon }[] = [
  { key: 'revenue', label: 'Pendapatan', color: 'violet', icon: Wallet },
  { key: 'orders', label: 'Jumlah pesanan', color: 'blue', icon: ShoppingBag },
  { key: 'average', label: 'Rata-rata pesanan', color: 'teal', icon: Coins },
  { key: 'cancellation', label: 'Pembatalan', color: 'rose', icon: CircleX },
]

function Trend({ value, inverse = false }: { value: number | null; inverse?: boolean }) {
  if (value === null) return <span className="trend flat">Periode baru</span>
  const tone = Math.abs(value) < 0.05 ? 'flat' : (value < 0) === inverse ? 'positive' : 'negative'
  const formatted = inverse ? percentage(Math.abs(value)).replace('%', ' pp') : percentage(Math.abs(value))
  return <span className={`trend ${tone}`}>{tone !== 'flat' && (value > 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />)}{tone === 'flat' ? inverse ? '0 pp' : '0%' : formatted}</span>
}

export function Dashboard({ alerts, open }: { alerts: UseQueryResult<Alerts>; open: (path: string) => void }) {
  const today = dayInJakarta()
  const [period, setPeriod] = useState<Period>('week')
  const [custom, setCustom] = useState<Range>({ from: shiftDay(today, -6), to: today })
  const [dateDialog, setDateDialog] = useState(false)
  const range = period === 'custom' ? custom : { from: shiftDay(today, { today: 0, week: -6, month: -29 }[period]), to: today }
  const key = [range.from, range.to]
  const sales = useQuery({
    queryKey: ['kpi', ...key], queryFn: () => api<Kpi>(searchUrl('/kpi', range), { background: true }),
    refetchInterval: 30_000,
  })
  const recent = useQuery({
    queryKey: ['recent-orders'], queryFn: () => api<Page<Order>>('/orders?page_size=25'),
  })
  const refreshed = sales.data?.refreshed_at
  const metrics = sales.data?.current
  const display = metrics && {
    revenue: rupiah(BigInt(metrics.revenue)),
    orders: number(metrics.orders),
    average: rupiah(metrics.average),
    cancellation: percentage(metrics.cancellation),
  }
  const stale = refreshed && Date.now() - Date.parse(refreshed) > 300_000
  return <>
    <section className="page-heading dashboard-heading">
      <div><p className="date-kicker"><CalendarDays size={15} aria-hidden="true" />{longDay(today)}</p><h1>Ringkasan penjualan</h1><p>Pantau kinerja toko dan aktivitas operasional terkini.</p></div>
      <div className="period-control" role="group" aria-label="Periode ringkasan">
        {[['today', 'Hari ini'], ['week', '7 hari'], ['month', '30 hari']].map(([value, label]) => <button key={value} className={value === period ? 'selected' : ''} aria-pressed={value === period} onClick={() => setPeriod(value as Period)}>{label}</button>)}
        <button className={period === 'custom' ? 'selected custom-period' : 'custom-period'} aria-pressed={period === 'custom'} aria-haspopup="dialog" onClick={() => setDateDialog(true)}><CalendarDays size={16} />{period === 'custom' ? 'Kustom' : 'Pilih tanggal'}</button>
      </div>
    </section>

    <div className="overview-line"><span><strong>{range.from === range.to ? shortDay(range.from) : `${shortDay(range.from)} – ${shortDay(range.to)}`}</strong> · WIB</span>
      {refreshed && <span className={`live-label ${stale ? 'stale' : ''}`}><i />{stale ? 'Data tertunda' : `Diperbarui ${time(refreshed)} WIB`}</span>}
    </div>
    <section className="kpi-grid" aria-label="Indikator penjualan">
      {cards.map((card) => <article className="panel kpi-card" key={card.key}>
        <div className="kpi-title"><span className={`kpi-icon ${card.color}`}><card.icon size={19} strokeWidth={1.85} aria-hidden="true" /></span><h2>{card.label}</h2></div>
        <div className="kpi-value">{display?.[card.key] ?? '—'}</div>
        <div className="kpi-caption">{sales.data ? <><Trend value={sales.data.changes[card.key]} inverse={card.key === 'cancellation'} /><span>vs periode sebelumnya</span></> : <span>{sales.isPending ? 'Memuat data…' : 'Data tidak tersedia'}</span>}</div>
      </article>)}
    </section>

    <div className="dashboard-grid primary-grid">
      <section className="panel revenue-panel">
        <div className="panel-header"><div><h2>Tren pendapatan</h2><p>Pendapatan bersih harian pada periode ini</p></div><span className="chart-legend"><i />Pendapatan</span></div>
        {sales.isPending && <Loading />}
        {sales.isError && !sales.data && <ErrorState error={sales.error} retry={() => void sales.refetch()} />}
        {sales.data && <RevenueChart series={sales.data.series} />}
      </section>
      <section className="panel alert-panel">
        <div className="panel-header"><div><h2>Peringatan stok</h2><p>Produk yang perlu diperiksa</p></div><span className="panel-alert-icon"><TriangleAlert size={20} strokeWidth={1.85} /></span></div>
        {alerts.isPending && <Loading />}
        {alerts.isError && !alerts.data && <ErrorState error={alerts.error} retry={() => void alerts.refetch()} />}
        {alerts.data?.items.length === 0 && <Empty text="Stok aman" description="Tidak ada produk yang perlu diperiksa." />}
        {alerts.data && alerts.data.items.length > 0 && <ul className="stock-alert-list">
          {alerts.data.items.slice(0, 3).map((product) => <li key={product.id}>
            <button onClick={() => open('/stok?sku=' + encodeURIComponent(product.sku))} className="stock-alert-row">
              <ProductIcon product={product} />
              <span><strong>{product.name}</strong><small>{product.sku} · Min. {product.min_stock}</small></span>
              <span className={`alert-count ${product.state === 'habis' ? 'critical' : ''}`}>{product.stock === 0 ? 'Habis' : `${product.stock} tersisa`}</span>
            </button>
          </li>)}
        </ul>}
        <div className="alert-footer"><button className="text-button" onClick={() => open('/stok?peringatan=1')}>Lihat seluruh peringatan <ArrowRight size={16} /></button>{alerts.data && <span>{alerts.data.out + alerts.data.low} produk</span>}</div>
      </section>
    </div>
    <div className="dashboard-grid secondary-grid">
      <section className="panel recent-panel">
        <div className="panel-header"><div><h2>Pesanan terbaru</h2><p>Pesanan yang terakhir masuk</p></div><button className="button small" onClick={() => open('/pesanan')}>Lihat pesanan <ArrowRight size={15} /></button></div>
        {recent.isPending && <Loading />}
        {recent.isError && <ErrorState error={recent.error} retry={() => void recent.refetch()} />}
        {recent.data?.items.length === 0 && <Empty text="Belum ada pesanan" />}
        {!!recent.data?.items.length && <div className="table-wrap" tabIndex={0} role="region" aria-label="Tabel pesanan terbaru"><table className="data-table recent-table"><thead><tr><th>Pesanan</th><th>Kanal</th><th>Status</th><th className="numeric">Total</th></tr></thead>
          <tbody>{recent.data.items.slice(0, 5).map((order) => <tr key={order.id}>
            <td><strong>{order.order_no}</strong><small>{dateTime(order.ordered_at)}</small></td>
            <td>{order.channel}</td><td><OrderPill status={order.status} /></td><td className="numeric"><strong>{rupiah(order.total_amount ?? 0)}</strong></td>
          </tr>)}</tbody></table></div>}
      </section>
      <section className="panel channels-panel">
        <div className="panel-header"><div><h2>Pesanan per kanal</h2><p>Distribusi pada periode ini</p></div><span className="kpi-icon violet"><ChartNoAxesCombined size={19} /></span></div>
        {sales.isPending && <Loading />}
        {sales.isError && !sales.data && <ErrorState error={sales.error} />}
        {sales.data && sales.data.channels.length === 0 && <Empty text="Belum ada pesanan" />}
        {sales.data && sales.data.channels.length > 0 && <ul className="channel-list">{sales.data.channels.map((channel, i) => {
          const portion = channel.orders / sales.data.current.orders * 100
          return <li key={channel.channel}><div><strong>{channel.channel}</strong><span>{number(channel.orders)} pesanan</span></div>
            <div className="channel-track"><span className={`channel-fill channel-${i % 4}`} style={{ width: `${portion}%` }} /></div></li>
        })}</ul>}
      </section>
    </div>
    {dateDialog && <DateDialog current={range} today={today} close={() => setDateDialog(false)} apply={(value) => { setCustom(value); setPeriod('custom'); setDateDialog(false) }} />}
  </>
}

function DateDialog({ current, today, apply, close }: { current: Range; today: string; apply: (range: Range) => void; close: () => void }) {
  const [from, setFrom] = useState(current.from)
  const [to, setTo] = useState(current.to)
  const valid = !!from && !!to && from <= to && to <= today && shiftDay(from, 364) >= to
  function submit(event: FormEvent) { event.preventDefault(); if (valid) apply({ from, to }) }
  return <Modal title="Pilih rentang tanggal" description="Tanggal mengikuti WIB. Rentang maksimal 365 hari." onClose={close}>
    <form onSubmit={submit} className="modal-form">
      <div className="field-grid"><label className="field">Dari<input required type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">Sampai<input required type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} /></label></div>
      {!valid && <p className="muted">Pilih tanggal mulai dan akhir dalam rentang yang berlaku.</p>}
      <div className="modal-actions"><button type="button" className="button" onClick={close}>Batal</button><button className="button primary" disabled={!valid}>Terapkan</button></div>
    </form>
  </Modal>
}

function RevenueChart({ series }: { series: Kpi['series'] }) {
  if (!series.some((point) => point.revenue !== '0')) return <Empty text="Belum ada pendapatan" description="Coba pilih periode lain." />
  const plot = series.map((point) => ({ ...point, amount: Number(point.revenue) }))
  const axis = (value: number) => value >= 1_000_000 ? `Rp${number(Math.round(value / 1_000_000 * 10) / 10)} jt` : value >= 1000 ? `Rp${number(Math.round(value / 1000))} rb` : `Rp${value}`
  return <div className="chart" aria-label="Grafik pendapatan harian">
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={plot} margin={{ top: 9, right: 14, left: 0, bottom: 6 }} accessibilityLayer>
        <defs><linearGradient id="revenue-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#7763ee" stopOpacity={0.25} /><stop offset="100%" stopColor="#7763ee" stopOpacity={0.025} /></linearGradient></defs>
        <CartesianGrid stroke="#eae9f2" strokeDasharray="4 5" vertical={false} />
        <XAxis dataKey="day" tickFormatter={shortDay} tickLine={false} axisLine={false} tick={{ fill: '#68677b', fontSize: 11 }} tickMargin={11} minTickGap={14} />
        <YAxis tickFormatter={axis} tickLine={false} axisLine={false} tick={{ fill: '#68677b', fontSize: 11 }} width={62} tickMargin={7} />
        <Tooltip labelFormatter={(value) => longDay(String(value))} formatter={(value, _name, item) => [rupiah(item.payload?.revenue ? BigInt(item.payload.revenue) : Number(value)), 'Pendapatan']} contentStyle={{ borderRadius: 10, border: '1px solid #e3e1ef', fontSize: 12 }} />
        <Area type="monotone" dataKey="amount" stroke="#6650dd" strokeWidth={3} fill="url(#revenue-fill)" activeDot={{ r: 5, fill: '#6650dd', stroke: '#fff', strokeWidth: 2 }}
          dot={series.length === 1 ? { r: 5, fill: '#6650dd' } : false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
    <details className="chart-data"><summary><PackageOpen size={14} />Data grafik</summary><ul>{series.map((point) => <li key={point.day}>{shortDay(point.day)} <strong>{rupiah(BigInt(point.revenue))}</strong></li>)}</ul></details>
  </div>
}
