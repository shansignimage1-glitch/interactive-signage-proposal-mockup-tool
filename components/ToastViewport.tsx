import React, { useEffect, useState } from 'react';
import { ToastMessage } from '../services/toast';

const colors: Record<ToastMessage['kind'], string> = {
  success: 'bg-emerald-700 border-emerald-500', error: 'bg-red-800 border-red-500',
  warning: 'bg-amber-700 border-amber-500', info: 'bg-blue-800 border-blue-500',
};

export default function ToastViewport() {
  const [items, setItems] = useState<ToastMessage[]>([]);
  useEffect(() => {
    const onToast = (event: Event) => {
      const item = (event as CustomEvent<ToastMessage>).detail;
      setItems(current => [...current.slice(-3), item]);
      window.setTimeout(() => setItems(current => current.filter(x => x.id !== item.id)), 4500);
    };
    window.addEventListener('signagepro:toast', onToast);
    return () => window.removeEventListener('signagepro:toast', onToast);
  }, []);
  return <div aria-live="polite" className="fixed right-4 bottom-4 z-[300] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 pointer-events-none">
    {items.map(item => <div key={item.id} className={`${colors[item.kind]} border text-white rounded-lg px-4 py-3 shadow-2xl text-sm`}>{item.message}</div>)}
  </div>;
}
