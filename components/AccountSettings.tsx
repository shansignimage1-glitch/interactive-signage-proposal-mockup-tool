import React, { useState } from 'react';
import { Download, Loader2, Trash2, UserX, X } from 'lucide-react';
import { UserProfile } from '../types';
import { StorageService } from '../services/StorageService';
import { connectors } from '../services/driveConnectors';
import { auth } from '../firebase';
import { deleteUser } from 'firebase/auth';
import { notify } from '../services/toast';
import { reportError } from '../services/monitoring';

export default function AccountSettings({ user, onClose, onAccountDeleted }: { user: UserProfile; onClose: () => void; onAccountDeleted: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');

  const exportAll = async () => {
    setBusy('export');
    try {
      const data = await StorageService.exportAllUserData(user.uid);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `signagepro-backup-${new Date().toISOString().slice(0, 10)}.json`; link.click();
      URL.revokeObjectURL(url); notify('Your SignagePro backup was downloaded.', 'success');
    } catch (error) { reportError('account-export', error); notify('Could not export your data.', 'error'); }
    finally { setBusy(null); }
  };

  const deleteData = async () => {
    if (confirmText !== 'DELETE MY DATA') return;
    setBusy('data');
    try { await StorageService.deleteAllUserData(user.uid); setConfirmText(''); notify('All SignagePro project data was deleted.', 'success'); }
    catch (error) { reportError('account-delete-data', error); notify('Some data could not be deleted. Please contact support.', 'error'); }
    finally { setBusy(null); }
  };

  const deleteAccount = async () => {
    if (confirmText !== 'DELETE MY ACCOUNT') return;
    setBusy('account');
    try {
      await StorageService.deleteAllUserData(user.uid);
      await Promise.all(connectors.filter(c => c.isConnected()).map(c => c.disconnect()));
      if (auth.currentUser) await deleteUser(auth.currentUser);
      onAccountDeleted();
    } catch (error: any) {
      reportError('account-delete', error);
      notify(error?.code === 'auth/requires-recent-login' ? 'For security, sign out and sign in again before deleting your account.' : 'Account deletion failed. Your remaining data was not hidden.', 'error');
    } finally { setBusy(null); }
  };

  return <div className="fixed inset-0 z-[180] bg-black/80 grid place-items-center p-4"><section className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-gray-700 bg-gray-900 text-white shadow-2xl">
    <header className="flex items-center justify-between border-b border-gray-700 p-4"><h2 className="font-bold text-lg">Account & data</h2><button onClick={onClose} aria-label="Close account settings"><X /></button></header>
    <div className="p-5 space-y-6 text-sm">
      <div><p className="font-semibold">Signed in as</p><p className="text-gray-400">{user.email}</p></div>
      <div className="rounded-xl bg-gray-800 p-4"><h3 className="font-semibold">Download your data</h3><p className="text-gray-400 mt-1">Exports local and cloud project JSON, including project settings and available image data.</p><button onClick={exportAll} disabled={!!busy} className="mt-3 bg-blue-600 rounded-lg px-3 py-2 flex gap-2">{busy === 'export' ? <Loader2 className="animate-spin"/> : <Download/>} Export all project data</button></div>
      <div className="rounded-xl border border-amber-800 bg-amber-950/30 p-4"><h3 className="font-semibold">Cloud drives</h3><p className="text-amber-100/80 mt-1">Disconnecting revokes SignagePro access but does not delete files already stored in your SignagePro folder. Delete project data first if you also want app-created project images removed.</p></div>
      <div className="rounded-xl border border-red-900 p-4 space-y-3"><h3 className="font-semibold text-red-300">Danger zone</h3><input value={confirmText} onChange={e => setConfirmText(e.target.value)} className="w-full rounded bg-gray-950 border border-gray-700 px-3 py-2" placeholder="Type DELETE MY DATA or DELETE MY ACCOUNT"/><div className="flex flex-wrap gap-2"><button onClick={deleteData} disabled={busy !== null || confirmText !== 'DELETE MY DATA'} className="bg-red-800 disabled:opacity-40 rounded px-3 py-2 flex gap-2"><Trash2/> Delete all project data</button><button onClick={deleteAccount} disabled={busy !== null || confirmText !== 'DELETE MY ACCOUNT'} className="bg-red-950 disabled:opacity-40 rounded px-3 py-2 flex gap-2"><UserX/> Delete account</button></div></div>
    </div>
  </section></div>;
}
