import React, { useEffect, useState } from 'react';
import { ImageOff, Images } from 'lucide-react';
import { getCachedAsset, getSiteCaptureAsset } from '../services/StorageService';

const EMBEDDED_ASSET = /^(data:|blob:)/;
const HOSTED_ASSET = /^https?:/;

interface SiteCaptureImageProps {
  assetRef: string;
  alt: string;
  className?: string;
}

const SiteCaptureImage: React.FC<SiteCaptureImageProps> = ({ assetRef, alt, className }) => {
  const [src, setSrc] = useState(EMBEDDED_ASSET.test(assetRef) ? assetRef : '');
  // A cloud photo that can't be reached shows a placeholder with Retry
  // instead of a broken image; the app also retries in the background.
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setFailed(false);
    if (EMBEDDED_ASSET.test(assetRef)) {
      setSrc(assetRef);
      return;
    }

    let objectUrl = '';
    let active = true;
    setSrc('');
    const loadCachedBlob = assetRef.startsWith('site-capture://')
      ? getSiteCaptureAsset(assetRef)
      : getCachedAsset(assetRef).then(asset => asset?.blob ?? null);
    void loadCachedBlob.then(blob => {
      if (!active) return;
      if (blob) {
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      } else if (HOSTED_ASSET.test(assetRef)) {
        setSrc(assetRef);
      }
    }).catch(() => {
      if (active && HOSTED_ASSET.test(assetRef)) setSrc(assetRef);
    });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetRef, attempt]);

  if (failed) {
    return (
      <div className={`${className ?? ''} grid place-items-center bg-slate-900 text-slate-400`} data-testid="site-photo-unavailable">
        <div className="flex flex-col items-center gap-1 p-2 text-center">
          <ImageOff className="h-6 w-6 text-amber-300/80" />
          <span className="text-[10px] font-semibold">Photo unavailable</span>
          <button
            type="button"
            onClick={event => { event.stopPropagation(); setAttempt(value => value + 1); }}
            className="rounded bg-slate-800 px-2 py-0.5 text-[10px] font-bold text-amber-200 hover:bg-slate-700"
          >Retry</button>
        </div>
      </div>
    );
  }

  return src
    ? <img src={src} alt={alt} className={className} onError={() => setFailed(true)} />
    : <div className={`${className ?? ''} grid place-items-center bg-slate-900 text-slate-600`}><Images className="h-7 w-7" /></div>;
};

export default SiteCaptureImage;
