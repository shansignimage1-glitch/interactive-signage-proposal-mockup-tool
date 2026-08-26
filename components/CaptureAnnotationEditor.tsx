import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Eraser, Loader2, Mic, PencilLine, Undo2, X } from 'lucide-react';
import { getCachedAsset, getSiteCaptureAsset } from '../services/StorageService';
import { optimizeImageBlob } from '../services/imageProcessing';
import { SiteCaptureAnnotationPoint, SiteCaptureAnnotationStroke, SiteCapturePhoto } from '../types';

interface CaptureAnnotationSave {
  annotations: SiteCaptureAnnotationStroke[];
  note: string;
  workingBlob?: Blob;
  thumbnailBlob?: Blob;
}

interface CaptureAnnotationEditorProps {
  capture: SiteCapturePhoto;
  onCancel: () => void;
  onSave: (result: CaptureAnnotationSave) => Promise<void>;
  onDictate?: (append: (text: string) => void) => React.ReactNode;
}

type DecodedImage = CanvasImageSource & { width: number; height: number; close: () => void };

const INK_COLORS = [
  { name: 'Orange', value: '#ff6b00' },
  { name: 'Cyan', value: '#22d3ee' },
  { name: 'Yellow', value: '#fde047' },
  { name: 'White', value: '#ffffff' },
  { name: 'Red', value: '#fb3f4a' },
];
const BRUSH_WIDTHS = [
  { name: 'Fine', value: 0.0035 },
  { name: 'Medium', value: 0.007 },
  { name: 'Bold', value: 0.013 },
];

const cloneStrokes = (strokes: SiteCaptureAnnotationStroke[] | undefined): SiteCaptureAnnotationStroke[] =>
  (strokes ?? []).map(stroke => ({ ...stroke, points: stroke.points.map(point => ({ ...point })) }));

const loadAssetBlob = async (assetRef: string): Promise<Blob> => {
  const cached = await getCachedAsset(assetRef).catch(() => null);
  if (cached) return cached.blob;
  if (assetRef.startsWith('site-capture://')) {
    const blob = await getSiteCaptureAsset(assetRef);
    if (!blob) throw new Error('The photograph is missing from this device.');
    return blob;
  }
  const response = await fetch(assetRef);
  if (!response.ok) throw new Error('The photograph could not be downloaded for drawing.');
  return response.blob();
};

const decodeWithImageElement = async (blob: Blob): Promise<DecodedImage> => {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    return Object.assign(image, { close: () => URL.revokeObjectURL(url) }) as DecodedImage;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
};

const decodeImage = async (blob: Blob): Promise<DecodedImage> => {
  if ('createImageBitmap' in globalThis) {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' }) as DecodedImage;
    } catch { /* iOS camera formats can require the image-element decoder */ }
  }
  return decodeWithImageElement(blob);
};

const pressureScale = (point: SiteCaptureAnnotationPoint): number =>
  Number.isFinite(point.pressure) && (point.pressure ?? 0) > 0
    ? 0.65 + Math.min(1, Math.max(0, point.pressure!)) * 0.7
    : 1;

const renderStroke = (context: CanvasRenderingContext2D, stroke: SiteCaptureAnnotationStroke, width: number, height: number) => {
  if (!stroke.points.length) return;
  const shortestSide = Math.min(width, height);
  const first = stroke.points[0];
  context.strokeStyle = stroke.color;
  context.fillStyle = stroke.color;
  context.lineCap = 'round';
  context.lineJoin = 'round';

  if (stroke.points.length === 1) {
    const radius = stroke.width * shortestSide * pressureScale(first) / 2;
    context.beginPath();
    context.arc(first.x * width, first.y * height, Math.max(1, radius), 0, Math.PI * 2);
    context.fill();
    return;
  }

  for (let index = 1; index < stroke.points.length; index += 1) {
    const from = stroke.points[index - 1];
    const to = stroke.points[index];
    context.lineWidth = Math.max(1, stroke.width * shortestSide * pressureScale(to));
    context.beginPath();
    context.moveTo(from.x * width, from.y * height);
    context.lineTo(to.x * width, to.y * height);
    context.stroke();
  }
};

const canvasToBlob = (canvas: HTMLCanvasElement): Promise<Blob> => new Promise((resolve, reject) => {
  canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The marked-up photo could not be encoded.')), 'image/jpeg', 0.9);
});

const CaptureAnnotationEditor: React.FC<CaptureAnnotationEditorProps> = ({ capture, onCancel, onSave, onDictate }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseImageRef = useRef<DecodedImage | null>(null);
  const strokesRef = useRef<SiteCaptureAnnotationStroke[]>(cloneStrokes(capture.annotations));
  const activePointerRef = useRef<{ pointerId: number; stroke: SiteCaptureAnnotationStroke } | null>(null);
  const drawingChangedRef = useRef(false);
  const [strokeCount, setStrokeCount] = useState(strokesRef.current.length);
  const [note, setNote] = useState(capture.notes ?? '');
  const [color, setColor] = useState(INK_COLORS[0].value);
  const [brushWidth, setBrushWidth] = useState(BRUSH_WIDTHS[1].value);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const redraw = useCallback((strokes = strokesRef.current) => {
    const canvas = canvasRef.current;
    const image = baseImageRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !image || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    strokes.forEach(stroke => renderStroke(context, stroke, canvas.width, canvas.height));
  }, []);

  useEffect(() => {
    let active = true;
    const baseRef = capture.annotationBaseRef ?? capture.workingRef;
    void loadAssetBlob(baseRef).then(decodeImage).then(image => {
      if (!active) {
        image.close();
        return;
      }
      baseImageRef.current = image;
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = Math.max(1, Math.round(capture.workingPixelWidth || image.width));
      canvas.height = Math.max(1, Math.round(capture.workingPixelHeight || image.height));
      redraw();
      setReady(true);
    }).catch(loadError => {
      if (active) setError(loadError instanceof Error ? loadError.message : 'The photograph could not be prepared for drawing.');
    });
    return () => {
      active = false;
      baseImageRef.current?.close();
      baseImageRef.current = null;
    };
  }, [capture.annotationBaseRef, capture.workingPixelHeight, capture.workingPixelWidth, capture.workingRef, redraw]);

  const pointFromEvent = (event: React.PointerEvent<HTMLCanvasElement>): SiteCaptureAnnotationPoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height))),
      pressure: event.pressure > 0 ? event.pressure : undefined,
    };
  };

  const appendPointerPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const activePointer = activePointerRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!activePointer || activePointer.pointerId !== event.pointerId || !canvas || !context) return;
    const point = pointFromEvent(event);
    const previous = activePointer.stroke.points[activePointer.stroke.points.length - 1];
    if (Math.hypot(point.x - previous.x, point.y - previous.y) < 0.0005) return;
    activePointer.stroke.points.push(point);
    renderStroke(context, { ...activePointer.stroke, points: [previous, point] }, canvas.width, canvas.height);
  };

  const beginStroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready || saving || activePointerRef.current || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    const stroke: SiteCaptureAnnotationStroke = {
      id: crypto.randomUUID?.() ?? `stroke_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      color,
      width: brushWidth,
      points: [pointFromEvent(event)],
    };
    strokesRef.current = [...strokesRef.current, stroke];
    activePointerRef.current = { pointerId: event.pointerId, stroke };
    drawingChangedRef.current = true;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Older Safari and synthetic test pointers may not expose capture. */ }
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (canvas && context) renderStroke(context, stroke, canvas.width, canvas.height);
    setStrokeCount(strokesRef.current.length);
  };

  const endStroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointerRef.current?.pointerId !== event.pointerId) return;
    appendPointerPoint(event);
    activePointerRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } catch { /* Pointer already ended. */ }
  };

  const undo = () => {
    if (!strokesRef.current.length || saving) return;
    strokesRef.current = strokesRef.current.slice(0, -1);
    drawingChangedRef.current = true;
    activePointerRef.current = null;
    setStrokeCount(strokesRef.current.length);
    redraw();
  };

  const clear = () => {
    if (!strokesRef.current.length || saving) return;
    strokesRef.current = [];
    drawingChangedRef.current = true;
    activePointerRef.current = null;
    setStrokeCount(0);
    redraw([]);
  };

  const save = async () => {
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      let workingBlob: Blob | undefined;
      let thumbnailBlob: Blob | undefined;
      if (drawingChangedRef.current) {
        redraw();
        const canvas = canvasRef.current;
        if (!canvas) throw new Error('The drawing canvas is unavailable.');
        workingBlob = await canvasToBlob(canvas);
        thumbnailBlob = await optimizeImageBlob(workingBlob, 720);
      }
      await onSave({
        annotations: cloneStrokes(strokesRef.current),
        note,
        workingBlob,
        thumbnailBlob,
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The annotation could not be saved.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[160] flex flex-col bg-[#06090d] text-slate-100" role="dialog" aria-modal="true" aria-label="Draw & Note">
      <header className="flex shrink-0 items-center gap-3 border-b border-white/10 bg-[#0c1219]/98 px-3 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button type="button" onClick={onCancel} disabled={saving} className="grid h-11 w-11 place-items-center rounded-xl border border-slate-700 text-slate-300 disabled:opacity-40" aria-label="Cancel"><X className="h-5 w-5" /></button>
        <div className="min-w-0 flex-1"><p className="text-[9px] font-black uppercase tracking-[0.18em] text-orange-300">Photo markup</p><h1 className="truncate text-base font-semibold">Draw & Note · {capture.label}</h1></div>
        <button type="button" onClick={() => void save()} disabled={!ready || saving} className="flex min-h-11 items-center gap-2 rounded-xl bg-orange-500 px-3 text-xs font-black uppercase tracking-[0.08em] text-black disabled:opacity-40" aria-label="Save annotation">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Save</button>
      </header>

      <main className="min-h-0 flex-1 bg-[radial-gradient(circle_at_50%_40%,#1b2733_0,#090d12_60%,#05070a_100%)] p-3">
        <div className="flex h-full items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl">
          {!ready && !error && <div className="absolute z-10 text-center"><Loader2 className="mx-auto h-8 w-8 animate-spin text-orange-400" /><p className="mt-3 text-xs text-slate-400">Preparing photograph…</p></div>}
          <canvas
            ref={canvasRef}
            data-testid="capture-annotation-canvas"
            className={`max-h-full max-w-full select-none object-contain ${ready ? 'touch-none cursor-crosshair opacity-100' : 'pointer-events-none opacity-0'}`}
            onPointerDown={beginStroke}
            onPointerMove={appendPointerPoint}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
            aria-label={`Draw on ${capture.label} photograph`}
          />
        </div>
      </main>

      <section className="max-h-[48vh] shrink-0 overflow-y-auto border-t border-white/10 bg-[#0c1219] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        {error && <div className="mb-3 rounded-xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-200" role="alert">{error}</div>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-1.5" aria-label="Ink color">
            {INK_COLORS.map(ink => <button key={ink.value} type="button" onClick={() => setColor(ink.value)} disabled={saving} aria-label={`Ink ${ink.name.toLowerCase()}`} aria-pressed={color === ink.value} className={`h-9 w-9 rounded-full border-2 transition ${color === ink.value ? 'scale-110 border-white shadow-[0_0_0_3px_rgba(249,115,22,0.28)]' : 'border-slate-700'}`} style={{ backgroundColor: ink.value }} />)}
          </div>
          <div className="flex rounded-xl border border-slate-700 bg-[#080c11] p-1" aria-label="Brush size">
            {BRUSH_WIDTHS.map(size => <button key={size.name} type="button" onClick={() => setBrushWidth(size.value)} disabled={saving} aria-label={`${size.name} brush`} aria-pressed={brushWidth === size.value} className={`grid h-9 w-9 place-items-center rounded-lg ${brushWidth === size.value ? 'bg-orange-500 text-black' : 'text-slate-400'}`}><span className="rounded-full bg-current" style={{ width: 3 + size.value * 450, height: 3 + size.value * 450 }} /></button>)}
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" onClick={undo} disabled={!strokeCount || saving} className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-700 text-xs font-semibold text-slate-300 disabled:opacity-35" aria-label="Undo"><Undo2 className="h-4 w-4" />Undo</button>
          <button type="button" onClick={clear} disabled={!strokeCount || saving} className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-700 text-xs font-semibold text-slate-300 disabled:opacity-35" aria-label="Clear drawing"><Eraser className="h-4 w-4" />Clear drawing</button>
        </div>
        <label className="mt-3 block text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">Photo note
          <div className="mt-1.5 flex items-start gap-2">
            <textarea aria-label="Photo note" value={note} onChange={event => setNote(event.target.value)} rows={3} placeholder="Circle the issue and describe what needs attention…" className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-[#080c11] p-3 text-base font-normal normal-case tracking-normal text-white outline-none focus:border-cyan-400" />
            {onDictate ? onDictate(text => setNote(current => current ? `${current} ${text}` : text)) : <span className="grid h-12 w-12 place-items-center rounded-xl border border-slate-800 text-slate-600" aria-hidden="true"><Mic className="h-5 w-5" /></span>}
          </div>
        </label>
        <p className="mt-2 flex items-center gap-2 text-[10px] leading-relaxed text-slate-500"><PencilLine className="h-3.5 w-3.5 shrink-0 text-cyan-300" />Use a finger or tablet pen. The original photograph always stays untouched.</p>
      </section>
    </div>
  );
};

export type { CaptureAnnotationSave };
export default CaptureAnnotationEditor;
