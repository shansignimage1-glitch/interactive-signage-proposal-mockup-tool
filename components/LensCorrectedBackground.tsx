import React, { useEffect, useRef } from 'react';
import { LensCorrection, Size } from '../types';
import { distortedSourcePoint } from '../utils/cameraGeometry';

interface Props {
  src: string;
  size: Size;
  lens: LensCorrection;
  className?: string;
  style?: React.CSSProperties;
}

const drawMappedTriangle = (
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  source: [{x:number;y:number},{x:number;y:number},{x:number;y:number}],
  target: [{x:number;y:number},{x:number;y:number},{x:number;y:number}],
  outputScale: number,
) => {
  const [s0,s1,s2] = source;
  const [d0,d1,d2] = target.map(point => ({ x: point.x * outputScale, y: point.y * outputScale })) as typeof target;
  const denominator = s0.x*(s1.y-s2.y)+s1.x*(s2.y-s0.y)+s2.x*(s0.y-s1.y);
  if (Math.abs(denominator) < 1e-8) return;
  const a = (d0.x*(s1.y-s2.y)+d1.x*(s2.y-s0.y)+d2.x*(s0.y-s1.y))/denominator;
  const c = (d0.x*(s2.x-s1.x)+d1.x*(s0.x-s2.x)+d2.x*(s1.x-s0.x))/denominator;
  const e = (d0.x*(s1.x*s2.y-s2.x*s1.y)+d1.x*(s2.x*s0.y-s0.x*s2.y)+d2.x*(s0.x*s1.y-s1.x*s0.y))/denominator;
  const b = (d0.y*(s1.y-s2.y)+d1.y*(s2.y-s0.y)+d2.y*(s0.y-s1.y))/denominator;
  const d = (d0.y*(s2.x-s1.x)+d1.y*(s0.x-s2.x)+d2.y*(s1.x-s0.x))/denominator;
  const f = (d0.y*(s1.x*s2.y-s2.x*s1.y)+d1.y*(s2.x*s0.y-s0.x*s2.y)+d2.y*(s0.x*s1.y-s1.x*s0.y))/denominator;
  context.save();
  context.beginPath(); context.moveTo(d0.x,d0.y); context.lineTo(d1.x,d1.y); context.lineTo(d2.x,d2.y); context.closePath(); context.clip();
  context.setTransform(a,b,c,d,e,f); context.drawImage(image,0,0); context.restore();
};

/** Non-destructive mesh resampling: project data remains in corrected image coordinates. */
const LensCorrectedBackground: React.FC<Props> = ({ src, size, lens, className, style }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !src) return;
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      const maxPreview = 4096;
      const previewScale = Math.min(1, maxPreview / Math.max(size.width, size.height));
      canvas.width = Math.max(1, Math.round(size.width * previewScale));
      canvas.height = Math.max(1, Math.round(size.height * previewScale));
      const context = canvas.getContext('2d');
      if (!context) return;
      context.clearRect(0,0,size.width,size.height);
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
      const columns = 24, rows = Math.max(8, Math.round(columns * size.height / size.width));
      for (let row=0; row<rows; row++) for (let col=0; col<columns; col++) {
        const x0=col*size.width/columns, x1=(col+1)*size.width/columns;
        const y0=row*size.height/rows, y1=(row+1)*size.height/rows;
        const d00={x:x0,y:y0}, d10={x:x1,y:y0}, d11={x:x1,y:y1}, d01={x:x0,y:y1};
        const s00=distortedSourcePoint(d00,size,lens.k1,lens.k2), s10=distortedSourcePoint(d10,size,lens.k1,lens.k2);
        const s11=distortedSourcePoint(d11,size,lens.k1,lens.k2), s01=distortedSourcePoint(d01,size,lens.k1,lens.k2);
        drawMappedTriangle(context,image,[s00,s10,s11],[d00,d10,d11],previewScale);
        drawMappedTriangle(context,image,[s00,s11,s01],[d00,d11,d01],previewScale);
      }
    };
    image.src = src;
  }, [src,size.width,size.height,lens.k1,lens.k2]);
  return <canvas ref={ref} aria-label="Lens-corrected background" className={className} style={style} />;
};

export default LensCorrectedBackground;
