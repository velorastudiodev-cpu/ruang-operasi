import { useEffect, useRef, type ReactNode } from 'react'
import { AlertCircle, ArrowLeft, ArrowRight, ArrowUpDown, Backpack, CheckCircle2, Coffee, HatGlasses, Inbox, LoaderCircle, Notebook, Package, ShoppingBag, X } from 'lucide-react'
import { statusLabels, type OrderStatus, type Product, type StockState } from '../shared/domain'

const integer = new Intl.NumberFormat('id-ID')
const decimal = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1, minimumFractionDigits: 1 })
export const number = (value: number) => integer.format(value)
export const percentage = (value: number) => decimal.format(value) + '%'
export const rupiah = (value: number | bigint) => 'Rp' + integer.format(value)
export const shortDay = (day: string) => new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(day))
export const longDay = (day: string) => new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(day))
export const time = (value: string) => new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }).format(new Date(value)).replace('.', ':')
export const dateTime = (value: string) => `${new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' }).format(new Date(value))}, ${time(value)} WIB`
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Terjadi kesalahan.'

export function Spinner({ size = 19 }: { size?: number }) { return <LoaderCircle className="spin" size={size} aria-hidden="true" /> }

export function Loading({ text = 'Memuat data…' }: { text?: string }) {
  return <div className="empty" role="status"><Spinner />{text}</div>
}

export function Empty({ text, description }: { text: string; description?: string }) {
  return <div className="empty"><span className="empty-icon"><Inbox size={22} aria-hidden="true" /></span><strong>{text}</strong>{description && <span>{description}</span>}</div>
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return <div className="empty" role="alert"><span className="empty-icon error-icon"><AlertCircle size={22} aria-hidden="true" /></span><strong>{errorMessage(error)}</strong>{retry && <button className="button" onClick={retry}>Coba lagi</button>}</div>
}

export function FormError({ error }: { error: unknown }) {
  return error ? <div className="form-error" role="alert"><AlertCircle size={17} aria-hidden="true" />{errorMessage(error)}</div> : null
}

export function Toast({ message, close }: { message: string; close: () => void }) {
  return <div className="toast"><span role="status"><CheckCircle2 size={19} aria-hidden="true" />{message}</span><button className="icon-button" onClick={close} aria-label="Tutup notifikasi"><X size={16} /></button></div>
}

export function OrderPill({ status }: { status: OrderStatus }) {
  return <span className={`pill order-${status}`}><i />{statusLabels[status]}</span>
}

export function StockPill({ state }: { state: StockState }) {
  return <span className={`pill stock-${state}`}><i />{{ aman: 'Aman', menipis: 'Menipis', habis: 'Habis' }[state]}</span>
}

const productIcons = { TOT: ShoppingBag, BOT: Coffee, NBK: Notebook, CAP: HatGlasses, MUG: Coffee, POU: Backpack }
export function ProductIcon({ product }: { product: Product }) {
  const key = product.sku.split('-')[0] as keyof typeof productIcons
  const Icon = productIcons[key] ?? Package
  return <span className={`product-icon product-${key.toLowerCase()}`}><Icon size={18} strokeWidth={1.8} aria-hidden="true" /></span>
}

export function Modal({ title, description, onClose, children }: { title: string; description?: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => { if (element?.open) element.close() }
  }, [])
  return <dialog ref={dialog} className="modal" aria-label={title}
    onCancel={(event) => { event.preventDefault(); onClose() }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="modal-inner">
      <div className="modal-heading">
        <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Tutup"><X size={20} /></button>
      </div>
      {children}
    </div>
  </dialog>
}

export function Pagination({ page, size, total, onPage, onSize }: { page: number; size: number; total: number; onPage: (page: number) => void; onSize: (size: number) => void }) {
  const last = Math.max(1, Math.ceil(total / size))
  return <div className="pagination">
    <span>{total ? `${number((page - 1) * size + 1)}–${number(Math.min(page * size, total))} dari ${number(total)}` : '0 hasil'}</span>
    <div>
      <label>Baris <select aria-label="Baris per halaman" value={size} onChange={(e) => onSize(Number(e.target.value))}>{[25, 50, 100].map((n) => <option key={n}>{n}</option>)}</select></label>
      <button className="icon-button" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Halaman sebelumnya"><ArrowLeft size={17} /></button>
      <span aria-live="polite">{page} / {last}</span>
      <button className="icon-button" disabled={page >= last} onClick={() => onPage(page + 1)} aria-label="Halaman berikutnya"><ArrowRight size={17} /></button>
    </div>
  </div>
}

export function SortLabel({ children, active, direction, onClick }: { children: ReactNode; active: boolean; direction: string; onClick: () => void }) {
  return <button type="button" className={`sort-label ${active ? 'active' : ''}`} onClick={onClick}>
    {children}<ArrowUpDown size={13} aria-hidden="true" /><span className="sr-only">{active ? direction === 'asc' ? 'Urutan naik' : 'Urutan turun' : 'Urutkan'}</span>
  </button>
}
