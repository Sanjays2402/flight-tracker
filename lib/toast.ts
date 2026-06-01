// [BATCH-A] tiny pub/sub toast bus
export type ToastKind = 'info' | 'success' | 'warn' | 'error'
export interface ToastMsg { id: string; kind: ToastKind; text: string; t: number }

type Listener = (toasts: ToastMsg[]) => void
const listeners = new Set<Listener>()
let queue: ToastMsg[] = []

function emit() { listeners.forEach(l => l(queue.slice())) }

export function subscribeToast(l: Listener) {
  listeners.add(l); l(queue.slice())
  return () => { listeners.delete(l) }
}

export function pushToast(text: string, kind: ToastKind = 'info', ttlMs = 3500) {
  const id = Math.random().toString(36).slice(2, 9)
  const msg: ToastMsg = { id, kind, text, t: Date.now() }
  queue = [...queue, msg]
  emit()
  setTimeout(() => { queue = queue.filter(m => m.id !== id); emit() }, ttlMs)
  return id
}
