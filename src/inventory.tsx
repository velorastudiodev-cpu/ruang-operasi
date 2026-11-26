import { useState, type FormEvent } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, History, PackageCheck, PackageMinus, Search, Settings2, SlidersHorizontal, TriangleAlert } from 'lucide-react'
import { adjustmentReasons, type Page, type Product } from '../shared/domain'
import { api, searchUrl, type Session } from './api'
import type { Alerts } from './app'
import { dateTime, Empty, ErrorState, FormError, Loading, Modal, number, Pagination, ProductIcon, Spinner, StockPill } from './ui'

type StockAction = 'adjust' | 'threshold' | 'history'

export function Inventory({ session, params, notify }: { session: Session; params: URLSearchParams; notify: (message: string) => void }) {
  const [state, setState] = useState(params.has('peringatan') ? 'peringatan' : '')
  const [keyword, setKeyword] = useState(params.get('sku') ?? '')
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(25)
  const [selection, setSelection] = useState<{ product: Product; action: StockAction }>()
  const alerts = useQuery({ queryKey: ['alerts', session.user.id], queryFn: () => api<Alerts>('/products/alerts', { background: true }) })
  const products = useQuery({
    queryKey: ['products', page, size, state, keyword], placeholderData: keepPreviousData,
    queryFn: () => api<Page<Product>>(searchUrl('/products', { state, q: keyword, page, page_size: size })),
  })
  const chooseState = (value: string) => { setState(value); setPage(1) }
  const admin = session.user.role === 'admin'
  return <>
    <section className="page-heading"><div><h1>Stok produk</h1><p>Pantau saldo fisik, ambang minimum, dan penyesuaian stok.</p></div></section>
    <section className="stock-summary" aria-label="Ringkasan status stok">
      {([
        ['aman', 'Stok aman', alerts.data?.safe, 'teal', PackageCheck],
        ['menipis', 'Stok menipis', alerts.data?.low, 'amber', TriangleAlert],
        ['habis', 'Stok habis', alerts.data?.out, 'rose', PackageMinus],
      ] as const).map(([value, label, count, color, Icon]) => <button type="button" key={value} className={`panel summary-card ${state === value ? 'active' : ''}`} aria-pressed={state === value} onClick={() => chooseState(state === value ? '' : value)}>
        <span className={`kpi-icon ${color}`}><Icon size={20} /></span><span><strong>{count === undefined ? '—' : number(count)}</strong><small>{label}</small></span></button>)}
    </section>
    <section className="panel listing-panel">
      <div className="panel-header"><div><h2>Daftar produk</h2><p>{products.data ? `${number(products.data.total)} produk ditemukan` : 'Stok fisik berdasarkan catatan gudang'}</p></div></div>
      <div className="filter-bar">
        <label className="search-input"><Search size={18} aria-hidden="true" /><span className="sr-only">Cari produk</span><input value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1) }} maxLength={120} placeholder="Cari SKU atau produk…" /></label>
        <label className="filter-select"><span className="sr-only">Status stok</span><select value={state} onChange={(e) => chooseState(e.target.value)}><option value="">Semua status</option><option value="peringatan">Perlu diperiksa</option><option value="aman">Aman</option><option value="menipis">Menipis</option><option value="habis">Habis</option></select><ChevronDown size={14} /></label>
      </div>
      {products.isPending && <Loading />}
      {products.isError && <ErrorState error={products.error} retry={() => void products.refetch()} />}
      {products.data && <div aria-busy={products.isFetching}>
        {products.data.items.length ? <div className="table-wrap" tabIndex={0} role="region" aria-label="Tabel stok produk"><table className="data-table">
          <thead><tr><th scope="col">Produk</th><th scope="col">SKU</th><th scope="col" className="numeric">Stok saat ini</th><th scope="col" className="numeric">Ambang</th><th scope="col">Status</th><th scope="col">Tindakan</th></tr></thead>
          <tbody>{products.data.items.map((product) => <tr key={product.id}><td><div className="product-cell"><ProductIcon product={product} /><strong>{product.name}</strong></div></td>
            <td className="muted">{product.sku}</td><td className="numeric"><strong>{number(product.stock)}</strong></td><td className="numeric">{number(product.min_stock)}</td><td><StockPill state={product.state} /></td>
            <td><div className="row-actions">
              {session.user.role !== 'manager' && <button className="button small" onClick={() => setSelection({ product, action: 'adjust' })}><SlidersHorizontal size={14} />Sesuaikan</button>}
              {admin && <button className="icon-button" title="Ubah ambang" aria-label={`Ubah ambang ${product.name}`} onClick={() => setSelection({ product, action: 'threshold' })}><Settings2 size={17} /></button>}
              <button className="icon-button" title="Riwayat stok" aria-label={`Riwayat stok ${product.name}`} onClick={() => setSelection({ product, action: 'history' })}><History size={17} /></button>
            </div></td>
          </tr>)}</tbody></table></div> : <Empty text="Produk tidak ditemukan" description="Coba ubah pencarian atau status stok." />}
        <Pagination page={page} size={size} total={products.data.total} onPage={setPage} onSize={(next) => { setSize(next); setPage(1) }} />
      </div>}
    </section>
    {selection?.action === 'history' && <MovementHistory product={selection.product} close={() => setSelection(undefined)} />}
    {selection && selection.action !== 'history' && <ChangeStock product={selection.product} action={selection.action} session={session} close={() => setSelection(undefined)} notify={notify} />}
  </>
}

function ChangeStock({ product, action, session, close, notify }: { product: Product; action: 'adjust' | 'threshold'; session: Session; close: () => void; notify: (message: string) => void }) {
  const updatingThreshold = action === 'threshold'
  const [value, setValue] = useState(updatingThreshold ? String(product.min_stock) : '')
  const [reason, setReason] = useState('')
  const query = useQueryClient()
  const next = product.stock + Number(value)
  const change = useMutation({
    mutationFn: () => api<Product>(`/products/${product.id}/${action}`, {
      method: updatingThreshold ? 'PATCH' : 'POST',
      body: updatingThreshold ? { min_stock: Number(value) } : { delta: Number(value), reason }, csrf: session.csrf_token,
    }),
    onSuccess: () => {
      void query.invalidateQueries({ queryKey: ['products'] })
      void query.invalidateQueries({ queryKey: ['alerts'] })
      void query.invalidateQueries({ queryKey: ['movements', product.id] })
      notify(updatingThreshold ? 'Ambang minimum diperbarui.' : 'Penyesuaian stok disimpan.')
      close()
    },
  })
  return <Modal title={updatingThreshold ? 'Ubah ambang minimum' : 'Sesuaikan stok'} description={`${product.name} · ${product.sku}`} onClose={close}>
    <form className="modal-form" onSubmit={(event: FormEvent) => { event.preventDefault(); change.mutate() }}>
      <div className="value-preview"><span>Stok saat ini</span><strong>{number(product.stock)} unit</strong></div>
      <label className="field">{updatingThreshold ? 'Ambang minimum baru' : 'Perubahan jumlah'}<input type="number" step="1" min={updatingThreshold ? 0 : -1_000_000} max={1_000_000} placeholder="Contoh -2 atau 5" value={value} required onChange={(e) => setValue(e.target.value)} /></label>
      {!updatingThreshold && <>
        <label className="field">Alasan<select required value={reason} onChange={(e) => setReason(e.target.value)}><option value="">Pilih alasan</option>{adjustmentReasons.map((item) => <option key={item} value={item}>{item.charAt(0).toUpperCase() + item.slice(1)}</option>)}</select></label>
        {value !== '' && <div className={`value-preview ${next < 0 ? 'negative' : ''}`}><span>Stok setelah penyesuaian</span><strong>{number(next)} unit</strong></div>}
      </>}
      <FormError error={change.error ?? (!updatingThreshold && next < 0 ? new Error('Stok tidak boleh negatif.') : undefined)} />
      <div className="modal-actions"><button type="button" className="button" onClick={close}>Batal</button>
        <button className="button primary" disabled={change.isPending || !value || (!updatingThreshold && (!reason || next < 0 || Number(value) === 0))}>{change.isPending && <Spinner size={16} />}Simpan</button></div>
    </form>
  </Modal>
}

function MovementHistory({ product, close }: { product: Product; close: () => void }) {
  const history = useQuery({ queryKey: ['movements', product.id], queryFn: () => api<{ items: { id: number; delta: number; reason: string; actor: string | null; created_at: string }[] }>(`/products/${product.id}/movements`) })
  return <Modal title="Riwayat stok" description={`${product.name} · ${product.sku}`} onClose={close}>
    {history.isPending && <Loading />}
    {history.isError && <ErrorState error={history.error} retry={() => void history.refetch()} />}
    {history.data?.items.length === 0 && <Empty text="Belum ada perubahan stok" />}
    {!!history.data?.items.length && <ul className="movement-list">{history.data.items.map((row) => <li key={row.id}><div><strong>{row.reason}</strong><small>{dateTime(row.created_at)} · {row.actor ?? 'Sistem'}</small></div><b className={row.delta > 0 ? 'positive' : 'negative'}>{row.delta > 0 ? '+' : ''}{number(row.delta)}</b></li>)}</ul>}
  </Modal>
}
