import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Sign, SignElement, Size, UnitSystem } from '../types';
import { classicalDetector } from '../utils/elementDetection';
import { formatLength } from '../utils/measure';
import { Boxes, X, Loader2, RefreshCw, Trash2, Check, MousePointerClick } from 'lucide-react';

interface ElementStudioProps {
  sign: Sign;
  // Real-world width of the sign's quad in mm (from view calibration), or
  // null when uncalibrated — depths show px then.
  quadWidthMm: number | null;
  unitSystem: UnitSystem;
  onApply: (elements: SignElement[] | undefined, sourceSize: Size | undefined) => void;
  onClose: () => void;
}

const HUE_STEP = 137.5; // golden-angle hues keep adjacent elements distinct

const contoursToPath = (contours: { x: number; y: number }[][]): string =>
  contours.map(c => c.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') + ' Z').join(' ');

const ElementStudio: React.FC<ElementStudioProps> = ({ sign, quadWidthMm, unitSystem, onApply, onClose }) => {
  const [imgSize, setImgSize] = useState<Size | null>(null);
  const [elements, setElements] = useState<SignElement[]>([]);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [sensitivity, setSensitivity] = useState(0.5);
  const [minAreaPct, setMinAreaPct] = useState(0.05);
  const [isDetecting, setIsDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seededRef = useRef(false);

  const defaultDepth = (size: Size) => Math.min(60, Math.max(4, Math.round(size.height * 0.06)));

  const runDetection = useCallback(async (sens: number, minArea: number) => {
    setIsDetecting(true);
    setError(null);
    try {
      const detected = await classicalDetector.detect(sign.image, { sensitivity: sens, minAreaPct: minArea });
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const size = { width: img.naturalWidth, height: img.naturalHeight };
        setImgSize(size);
        setElements(detected.map((d, i) => ({
          id: `el-${Date.now()}-${i}`,
          name: `Element ${i + 1}`,
          contours: d.contours,
          depth: defaultDepth(size),
          enabled: true,
        })));
        setSelection(new Set());
        setIsDetecting(false);
      };
      img.src = sign.image;
    } catch (e: any) {
      setError(e.message ?? 'Detection failed');
      setIsDetecting(false);
    }
  }, [sign.image]);

  // Seed from existing elements when they match this image; otherwise detect
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    if (sign.elements?.length && sign.elementsSourceSize) {
      setImgSize(sign.elementsSourceSize);
      setElements(sign.elements);
    } else {
      runDetection(sensitivity, minAreaPct);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleDetection = (sens: number, minArea: number) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runDetection(sens, minArea), 350);
  };

  const toggleSelect = (id: string, additive: boolean) => {
    setSelection(prev => {
      const next = additive ? new Set(prev) : new Set<string>();
      if (prev.has(id) && additive) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const updateSelected = (updates: Partial<SignElement>) => {
    setElements(prev => prev.map(el => selection.has(el.id) ? { ...el, ...updates } : el));
  };

  const updateOne = (id: string, updates: Partial<SignElement>) => {
    setElements(prev => prev.map(el => el.id === id ? { ...el, ...updates } : el));
  };

  const mmPerSignPx = quadWidthMm && imgSize ? quadWidthMm / imgSize.width : null;
  const fmtDepth = (px: number): string =>
    mmPerSignPx ? formatLength(px * mmPerSignPx, unitSystem) : `${Math.round(px)}px`;

  const selectedElements = elements.filter(el => selection.has(el.id));
  const sliderMax = imgSize ? Math.max(100, Math.round(imgSize.height * 0.3)) : 100;
  const sharedDepth = selectedElements.length ? selectedElements[0].depth : 0;

  return (
    <div className="fixed inset-0 z-[150] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700 bg-gray-800 flex-shrink-0">
          <h2 className="text-white font-bold text-lg flex items-center gap-2">
            <Boxes className="w-5 h-5 text-purple-400" /> 3D Elements
            <span className="text-xs font-normal text-gray-500 bg-gray-900 px-2 py-0.5 rounded border border-gray-700">{sign.name}</span>
          </h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* Preview */}
          <div className="flex-1 bg-gray-950 flex items-center justify-center p-6 min-w-0 relative">
            {isDetecting && (
              <div className="absolute inset-0 bg-black/50 z-10 flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
              </div>
            )}
            {error && <p className="text-red-400 text-sm">{error}</p>}
            {imgSize && !error && (
              <svg
                viewBox={`0 0 ${imgSize.width} ${imgSize.height}`}
                className="max-w-full max-h-full"
                style={{ aspectRatio: `${imgSize.width} / ${imgSize.height}` }}
              >
                <image href={sign.image} width={imgSize.width} height={imgSize.height} opacity={0.9} />
                {elements.map((el, i) => {
                  const selected = selection.has(el.id);
                  const hue = (i * HUE_STEP) % 360;
                  return (
                    <path
                      key={el.id}
                      d={contoursToPath(el.contours)}
                      fill={`hsla(${hue}, 90%, 60%, ${selected ? 0.5 : el.enabled ? 0.22 : 0.06})`}
                      stroke={`hsl(${hue}, 90%, ${selected ? 70 : 55}%)`}
                      strokeWidth={selected ? imgSize.width * 0.004 : imgSize.width * 0.002}
                      style={{ cursor: 'pointer' }}
                      onClick={(e) => toggleSelect(el.id, e.shiftKey)}
                    />
                  );
                })}
              </svg>
            )}
          </div>

          {/* Sidebar */}
          <div className="w-80 border-l border-gray-700 bg-gray-900 flex flex-col flex-shrink-0">
            {/* Detection controls */}
            <div className="p-4 border-b border-gray-800 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold text-gray-400 uppercase">Detection</h3>
                <button
                  onClick={() => runDetection(sensitivity, minAreaPct)}
                  className="text-xs flex items-center gap-1 text-purple-300 hover:text-white"
                  title="Re-run detection (replaces current elements)"
                >
                  <RefreshCw className="w-3 h-3" /> Re-detect
                </button>
              </div>
              <div>
                <div className="flex justify-between text-[10px] text-gray-500 mb-1"><span>SENSITIVITY</span><span>{Math.round(sensitivity * 100)}%</span></div>
                <input type="range" min="0" max="1" step="0.05" value={sensitivity}
                  onChange={e => { const v = parseFloat(e.target.value); setSensitivity(v); scheduleDetection(v, minAreaPct); }}
                  className="w-full h-1.5 bg-gray-700 rounded-lg accent-purple-500" />
              </div>
              <div>
                <div className="flex justify-between text-[10px] text-gray-500 mb-1"><span>MIN ELEMENT SIZE</span><span>{minAreaPct.toFixed(2)}%</span></div>
                <input type="range" min="0.01" max="2" step="0.01" value={minAreaPct}
                  onChange={e => { const v = parseFloat(e.target.value); setMinAreaPct(v); scheduleDetection(sensitivity, v); }}
                  className="w-full h-1.5 bg-gray-700 rounded-lg accent-purple-500" />
              </div>
            </div>

            {/* Depth control for selection */}
            <div className={`p-4 border-b border-gray-800 space-y-2 ${selection.size === 0 ? 'opacity-40 pointer-events-none' : ''}`}>
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold text-gray-400 uppercase">Depth {selection.size > 0 && `(${selection.size} selected)`}</h3>
                <span className="text-xs font-mono text-purple-300">{selection.size ? fmtDepth(sharedDepth) : '—'}</span>
              </div>
              <input type="range" min="0" max={sliderMax} step="1" value={sharedDepth}
                onChange={e => updateSelected({ depth: parseInt(e.target.value) })}
                className="w-full h-2 bg-gray-700 rounded-lg accent-purple-500" />
              {selection.size === 0 && (
                <p className="text-[10px] text-gray-500 flex items-center gap-1"><MousePointerClick className="w-3 h-3" /> Click elements in the preview to select (Shift for multiple)</p>
              )}
            </div>

            {/* Element list */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {elements.map((el, i) => {
                const hue = (i * HUE_STEP) % 360;
                const selected = selection.has(el.id);
                return (
                  <div
                    key={el.id}
                    onClick={(e) => toggleSelect(el.id, e.shiftKey)}
                    className={`flex items-center gap-2 p-2 rounded border cursor-pointer text-xs transition-colors ${selected ? 'bg-purple-900/30 border-purple-500/50' : 'bg-gray-800 border-gray-700 hover:border-gray-600'}`}
                  >
                    <span className="w-3 h-3 rounded-sm flex-shrink-0" style={{ backgroundColor: `hsl(${hue}, 90%, 55%)` }} />
                    <span className={`flex-1 truncate ${el.enabled ? 'text-gray-200' : 'text-gray-500 line-through'}`}>{el.name}</span>
                    <span className="font-mono text-gray-400">{fmtDepth(el.depth)}</span>
                    <input
                      type="checkbox"
                      checked={el.enabled}
                      onClick={e => e.stopPropagation()}
                      onChange={e => updateOne(el.id, { enabled: e.target.checked })}
                      title="Include in 3D render"
                    />
                  </div>
                );
              })}
              {elements.length === 0 && !isDetecting && (
                <p className="text-xs text-gray-500 p-3 text-center">No elements detected — try raising sensitivity or lowering min size.</p>
              )}
            </div>

            {/* Actions */}
            <div className="p-4 border-t border-gray-800 space-y-2">
              <button
                onClick={() => onApply(elements, imgSize ?? undefined)}
                disabled={!imgSize || elements.length === 0}
                className="w-full flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white py-2.5 rounded-lg text-sm font-semibold transition-colors"
              >
                <Check className="w-4 h-4" /> Apply {elements.filter(e => e.enabled).length} Element{elements.filter(e => e.enabled).length !== 1 ? 's' : ''}
              </button>
              {sign.elements && sign.elements.length > 0 && (
                <button
                  onClick={() => onApply(undefined, undefined)}
                  className="w-full flex items-center justify-center gap-2 bg-gray-800 hover:bg-gray-700 text-red-400 py-2 rounded-lg text-xs transition-colors border border-gray-700"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Remove 3D Elements (back to slab)
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ElementStudio;
