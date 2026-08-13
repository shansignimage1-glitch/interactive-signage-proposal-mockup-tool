import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';

type Page = 'privacy' | 'terms' | 'support';
const copy: Record<Page, { title: string; body: React.ReactNode }> = {
  privacy: { title: 'Privacy policy', body: <><p>SignagePro processes account details, project designs, customer building photographs and uploaded artwork to provide proposal, sync and export features.</p><p>Projects are stored locally and, when signed in, in the dedicated SignagePro Firebase project. If you connect a drive, app-created files may also be stored in your chosen provider. We do not sell project data.</p><p>You can export or delete your data from Account & data. Cloud-provider files may remain after disconnect until you delete them in SignagePro or directly in that provider.</p></> },
  terms: { title: 'Terms of use', body: <><p>You remain responsible for the accuracy of measurements, proposals, uploaded artwork, licensing and customer approvals. Camera-calibrated measurements are estimates and must be verified on site before manufacture.</p><p>Do not upload content you do not have permission to use. The service is provided without a guarantee of uninterrupted availability.</p></> },
  support: { title: 'Support', body: <><p>For account, privacy, deletion or technical help, contact <a className="text-blue-400 underline" href="mailto:shansignimage1@gmail.com">shansignimage1@gmail.com</a>.</p><p>Include the browser/device, approximate time and project name. Do not email confidential customer photographs unless requested through a secure channel.</p></> },
};

export default function LegalCenter() {
  const readHash = (): Page | null => ['privacy','terms','support'].includes(location.hash.slice(2)) ? location.hash.slice(2) as Page : null;
  const [page, setPage] = useState<Page | null>(readHash);
  useEffect(() => { const update = () => setPage(readHash()); addEventListener('hashchange', update); return () => removeEventListener('hashchange', update); }, []);
  return <><nav className="legal-center-nav fixed bottom-1 left-2 z-[60] flex gap-3 text-[11px] text-gray-400"><a href="#/privacy">Privacy</a><a href="#/terms">Terms</a><a href="#/support">Support</a></nav>{page && <div className="fixed inset-0 z-[250] bg-gray-950 text-white overflow-y-auto"><main className="max-w-2xl mx-auto p-6 md:p-12"><button onClick={() => { history.pushState(null, '', `${location.pathname}${location.search}`); setPage(null); }} className="float-right p-2" aria-label="Close"><X/></button><h1 className="text-3xl font-bold mb-6">{copy[page].title}</h1><div className="space-y-4 text-gray-300 leading-7">{copy[page].body}</div><p className="mt-10 text-xs text-gray-500">Effective 7 August 2026</p></main></div>}</>;
}
