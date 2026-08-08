import React, { useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { reportError } from '../services/monitoring';

export default function PwaUpdatePrompt() {
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateError, setUpdateError] = useState('');
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisterError(error) {
      reportError('pwa-register', error);
    },
  });

  if (!needRefresh && !offlineReady) return null;

  const applyUpdate = () => {
    setIsUpdating(true);
    setUpdateError('');
    void updateServiceWorker(true).catch(error => {
      reportError('pwa-update', error);
      setUpdateError('The update could not be applied. Please reload the page.');
      setIsUpdating(false);
    });
  };

  return (
    <aside
      aria-live="polite"
      className="fixed inset-x-3 bottom-3 z-[400] mx-auto max-w-xl rounded-xl border border-blue-400/60 bg-slate-950 p-4 text-white shadow-2xl sm:bottom-5"
    >
      {needRefresh ? (
        <>
          <p className="font-semibold">New SignagePro version ready</p>
          <p className="mt-1 text-sm text-slate-300">
            Save any work in progress, then update to receive the latest fixes.
          </p>
          {updateError && <p role="alert" className="mt-2 text-sm text-red-300">{updateError}</p>}
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setNeedRefresh(false)}
              disabled={isUpdating}
              className="min-h-11 rounded-lg border border-slate-600 px-4 text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
            >
              Later
            </button>
            <button
              type="button"
              onClick={applyUpdate}
              disabled={isUpdating}
              className="min-h-11 rounded-lg bg-blue-600 px-4 text-sm font-semibold hover:bg-blue-500 disabled:opacity-60"
            >
              {isUpdating ? 'Updating…' : 'Update now'}
            </button>
          </div>
        </>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm">SignagePro is ready to work offline.</p>
          <button
            type="button"
            onClick={() => setOfflineReady(false)}
            className="min-h-11 rounded-lg border border-slate-600 px-4 text-sm font-medium hover:bg-slate-800"
          >
            Dismiss
          </button>
        </div>
      )}
    </aside>
  );
}
