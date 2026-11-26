import { useEffect, useState, type FormEvent } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Download, FileSpreadsheet, Search, Upload, X } from 'lucide-react'
import { statuses, statusLabels, type Order, type OrderStatus, type Page } from '../shared/domain'
import { api, searchUrl, type Session } from './api'
import { dateTime, Empty, ErrorState, FormError, Loading, Modal, number, OrderPill, Pagination, rupiah, SortLabel, Spinner } from './ui'

interface ExportJob {
  id: string
  status: 'pending' | 'running' | 'done' | 'failed'
  row_count: number | null
  created_at: string
  downloadable: boolean
}

type Sort = 'order_no' | 'ordered_at' | 'channel' | 'status' | 'total_amount'
type Filter = { q: string; status: string; channel: string; from: string; to: string; sort: Sort; direction: 'asc' | 'desc' }
const initialFilters: Filter = { q: '', status: '', channel: '', from: '', to: '', sort: 'ordered_at', direction: 'desc' }

export function Orders({ session, params, notify }: { session: Session; params: URLSearchParams; notify: (message: string) => void }) {
  const rawStatus = params.get('status') as OrderStatus | null
  const [filters, setFilters] = useState<Filter>({ ...initialFilters, status: rawStatus && statuses.includes(rawStatus) ? rawStatus : '' })
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(25)
  const [exportDialog, setExportDialog] = useState(false)
  const [importDialog, setImportDialog] = useState(false)
  const [selected, setSelected] = useState<Order | null>(null)
  const query = useQueryClient()
  const warehouse = session.user.role === 'warehouse'
  const validDate = !filters.from || !filters.to || filters.from <= filters.to
  const reqBody = Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== ''))
  function update(next: Partial<Filter>) { setPage(1); setFilters((current) => ({ ...current, ...next })) }
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (keyword !== filters.q) update({ q: keyword })
    }, 230)
    return () => clearTimeout(timeout)
  }, [keyword, filters.q])
  const orders = useQuery({
    queryKey: ['orders', session.user.id, filters, page, size],
    queryFn: () => api<Page<Order>>(searchUrl('/orders', { ...reqBody, page, page_size: size })),
    enabled: validDate, placeholderData: keepPreviousData,
  })
  const channels = useQuery({ queryKey: ['channels'], queryFn: () => api<{ items: string[] }>('/orders/channels') })
  const createExport = useMutation({
    mutationFn: () => api<{ job_id: string }>('/orders/export', { method: 'POST', body: { ...reqBody, q: keyword.trim() }, csrf: session.csrf_token }),
    onSuccess: () => {
      void query.invalidateQueries({ queryKey: ['exports'] })
      setExportDialog(true)
      notify('Ekspor ditambahkan ke antrean.')
    },
  })

  function sort(field: Sort) { update({ sort: field, direction: filters.sort === field && filters.direction === 'desc' ? 'asc' : 'desc' }) }
  const sortColumn = (field: Sort, label: string, numeric = false) => <th scope="col" className={numeric ? 'numeric' : undefined}
    aria-sort={filters.sort === field ? filters.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
    <SortLabel active={filters.sort === field} direction={filters.direction} onClick={() => sort(field)}>{label}</SortLabel>
  </th>
  const hasFilter = !!(keyword || filters.status || filters.channel || filters.from || filters.to)
  return <>
    <section className="page-heading">
      <div><h1>Pesanan</h1><p>Cari dan pantau pesanan dari seluruh kanal penjualan.</p></div>
      {!warehouse && <div className="page-actions">
        {session.user.role === 'admin' && <button className="button" onClick={() => setImportDialog(true)}><Upload size={17} />Impor CSV</button>}
        <button className="button primary" onClick={() => createExport.mutate()} disabled={!validDate || createExport.isPending}>{createExport.isPending ? <Spinner size={17} /> : <Download size={17} />}Ekspor CSV</button>
      </div>}
    </section>
    {!warehouse && <FormError error={createExport.error} />}
    <section className="panel listing-panel">
      <div className="panel-header"><div><h2>Daftar pesanan</h2><p>{orders.data ? `${number(orders.data.total)} pesanan ditemukan` : 'Filter berdasarkan status, kanal, atau tanggal.'}</p></div>
        {!warehouse && <button className="text-button" onClick={() => setExportDialog(true)}><FileSpreadsheet size={16} />Riwayat ekspor</button>}</div>
      <div className="filter-bar">
        <label className="search-input"><Search size={18} aria-hidden="true" /><span className="sr-only">Cari pesanan</span><input value={keyword} maxLength={120} onChange={(e) => setKeyword(e.target.value)} placeholder={warehouse ? 'Cari nomor pesanan…' : 'Cari nomor atau pelanggan…'} /></label>
        <label className="filter-select"><span className="sr-only">Status pesanan</span><select value={filters.status} onChange={(e) => update({ status: e.target.value })}><option value="">Semua status</option>{statuses.map((status) => <option value={status} key={status}>{statusLabels[status]}</option>)}</select><ChevronDown size={14} /></label>
        <label className="filter-select"><span className="sr-only">Kanal penjualan</span><select value={filters.channel} onChange={(e) => update({ channel: e.target.value })}><option value="">Semua kanal</option>{channels.data?.items.map((channel) => <option key={channel} value={channel}>{channel}</option>)}</select><ChevronDown size={14} /></label>
        <label className="date-filter"><span>Dari</span><input type="date" value={filters.from} onChange={(e) => update({ from: e.target.value })} /></label>
        <label className="date-filter"><span>Sampai</span><input type="date" value={filters.to} onChange={(e) => update({ to: e.target.value })} /></label>
        {hasFilter && <button className="text-button reset-filter" onClick={() => { setKeyword(''); update(initialFilters) }}><X size={15} />Reset filter</button>}
      </div>
      {!validDate && <FormError error={new Error('Tanggal mulai harus sebelum atau sama dengan tanggal akhir.')} />}
      {validDate && orders.isPending && <Loading />}
      {validDate && orders.isError && <ErrorState error={orders.error} retry={() => void orders.refetch()} />}
      {validDate && orders.data && <div aria-busy={orders.isFetching}>
        {orders.data.items.length ? <div className="table-wrap" tabIndex={0} role="region" aria-label="Tabel pesanan"><table className="data-table">
          <thead><tr>{sortColumn('order_no', 'Nomor pesanan')}<th scope="col">Pelanggan</th>{sortColumn('channel', 'Kanal')}{sortColumn('status', 'Status')}{sortColumn('ordered_at', 'Waktu pesanan')}{!warehouse && sortColumn('total_amount', 'Total', true)}</tr></thead>
          <tbody>{orders.data.items.map((order) => <tr key={order.id}>
            <td><button className="table-link" onClick={() => setSelected(order)}>{order.order_no}</button></td><td>{order.customer_name}</td><td><Channel value={order.channel} /></td>
            <td><OrderPill status={order.status} /></td><td className="nowrap">{dateTime(order.ordered_at)}</td>{!warehouse && <td className="numeric"><strong>{rupiah(order.total_amount ?? 0)}</strong></td>}
          </tr>)}</tbody>
        </table></div> : <Empty text="Pesanan tidak ditemukan" description={hasFilter ? 'Coba ganti kata kunci atau filter.' : 'Pesanan yang diterima akan muncul di sini.'} />}
        <Pagination page={page} size={size} total={orders.data.total} onPage={setPage} onSize={(next) => { setSize(next); setPage(1) }} />
      </div>}
    </section>
    {selected && <Modal title={selected.order_no} description={dateTime(selected.ordered_at)} onClose={() => setSelected(null)}>
      <dl className="detail-list"><div><dt>Status</dt><dd><OrderPill status={selected.status} /></dd></div><div><dt>Kanal</dt><dd>{selected.channel}</dd></div><div><dt>Pelanggan</dt><dd>{selected.customer_name}</dd></div>
        {selected.customer_contact && <div><dt>Kontak</dt><dd>{selected.customer_contact}</dd></div>}
        {selected.total_amount !== undefined && <div><dt>Total pesanan</dt><dd><strong>{rupiah(selected.total_amount)}</strong></dd></div>}</dl>
    </Modal>}
    {exportDialog && <ExportDialog session={session} onClose={() => setExportDialog(false)} />}
    {importDialog && <ImportDialog session={session} onClose={() => setImportDialog(false)} notify={notify} />}
  </>
}

function Channel({ value }: { value: string }) {
  const tone = ({ Tokopedia: 'green', Shopee: 'orange', Website: 'violet', 'TikTok Shop': 'slate' } as Record<string, string>)[value] ?? 'slate'
  return <span className="channel-badge"><i className={tone} />{value}</span>
}

function ExportDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const jobs = useQuery({
    queryKey: ['exports', session.user.id], queryFn: () => api<{ items: ExportJob[] }>('/orders/exports', { background: true }),
    refetchInterval: (query) => query.state.data?.items.some((job) => ['pending', 'running'].includes(job.status)) ? 1700 : false,
  })
  return <Modal title="Riwayat ekspor" description="Hasil tersedia selama 48 jam. Ekspor di atas 100.000 baris juga dikirim lewat email." onClose={onClose}>
    {jobs.isPending && <Loading />}
    {jobs.isError && <ErrorState error={jobs.error} retry={() => void jobs.refetch()} />}
    {jobs.data?.items.length === 0 && <Empty text="Belum ada ekspor" />}
    {!!jobs.data?.items.length && <ul className="job-list">{jobs.data.items.map((job) => <li key={job.id}>
      <span className="kpi-icon violet"><FileSpreadsheet size={18} /></span><div><strong>{dateTime(job.created_at)}</strong><small>{job.row_count === null ? 'CSV pesanan' : `${number(job.row_count)} baris`}</small></div>
      {job.downloadable ? <a className="button small" href={`/api/orders/exports/${job.id}/download`} download><Download size={15} />Unduh</a>
        : <span className="muted">{({ pending: 'Dalam antrean', running: 'Diproses', failed: 'Gagal', done: 'Kedaluwarsa' })[job.status]}</span>}
    </li>)}</ul>}
  </Modal>
}

const csvExample = 'order_no,channel,status,customer_name,customer_contact,total_amount,refunded_amount,ordered_at,source_updated_at\nIMP-0001,Website,paid,Contoh Pelanggan,pelanggan@example.test,150000,0,2026-11-26T09:00:00+07:00,2026-11-26T09:00:00+07:00\n'
function ImportDialog({ session, onClose, notify }: { session: Session; onClose: () => void; notify: (message: string) => void }) {
  const [file, setFile] = useState<File>()
  const query = useQueryClient()
  const upload = useMutation({
    mutationFn: async () => {
      if (!file || file.size > 4_000_000) throw new Error('Pilih file CSV berukuran maksimal 4 MB.')
      return api<{ changed: number; skipped: number }>('/orders/import', { method: 'POST', body: { csv: await file.text() }, csrf: session.csrf_token })
    },
    onSuccess: ({ changed, skipped }) => {
      void query.invalidateQueries({ queryKey: ['orders'] })
      void query.invalidateQueries({ queryKey: ['recent-orders'] })
      notify(`${number(changed)} pesanan disimpan, ${number(skipped)} dilewati.`)
      onClose()
    },
  })
  return <Modal title="Impor pesanan" description="Unggah CSV berisi maksimal 5.000 pesanan. Nomor pesanan dan kanal menentukan identitasnya." onClose={onClose}>
    <form className="modal-form" onSubmit={(event: FormEvent) => { event.preventDefault(); upload.mutate() }}>
      <label className="field">File CSV<input type="file" accept=".csv,text/csv" required onChange={(e) => setFile(e.target.files?.[0])} /></label>
      <a className="text-button" href={'data:text/csv;charset=utf-8,' + encodeURIComponent(csvExample)} download="format-impor-pesanan.csv"><Download size={15} />Unduh contoh CSV</a>
      <FormError error={upload.error} />
      <div className="modal-actions"><button type="button" className="button" onClick={onClose}>Batal</button><button className="button primary" disabled={upload.isPending}>{upload.isPending && <Spinner size={16} />}Impor pesanan</button></div>
    </form>
  </Modal>
}
