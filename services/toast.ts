export type ToastKind = 'success' | 'error' | 'info' | 'warning';
export interface ToastMessage { id: string; kind: ToastKind; message: string }

export const notify = (message: string, kind: ToastKind = 'info'): void => {
  window.dispatchEvent(new CustomEvent<ToastMessage>('signagepro:toast', {
    detail: { id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, kind, message },
  }));
};
