import React, { useEffect, useState } from 'react';
import { Images } from 'lucide-react';
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

  useEffect(() => {
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
  }, [assetRef]);

  return src
    ? <img src={src} alt={alt} className={className} />
    : <div className={`${className ?? ''} grid place-items-center bg-slate-900 text-slate-600`}><Images className="h-7 w-7" /></div>;
};

export default SiteCaptureImage;
