import React from 'react';
import { AlertTriangle, ArrowLeft, Check, Grid3X3, LocateFixed, RotateCcw, Ruler, Undo2, X } from 'lucide-react';
import { Calibration, MeasureUnit, Point, Size } from '../types';
import { CALIBRATION_PRESETS, toMm } from '../utils/measure';
import { assessCalibrationQuality, CalibrationMethod } from '../utils/calibrationQuality';

export type CalibrationStage = 'choose' | 'place' | 'details' | 'review';

export interface CalibrationDraft {
  stage: CalibrationStage;
  method: CalibrationMethod | null;
  points: Point[];
  presetId: string;
  value: string;
  width: string;
  height: string;
  unit: MeasureUnit;
  reapply: boolean;
}

interface CalibrationWizardProps {
  draft: CalibrationDraft;
  imageSize: Size;
  existingDimensionCount: number;
  onChange: (next: CalibrationDraft) => void;
  onApply: (calibration: Calibration, reapply: boolean) => void;
  onCancel: () => void;
}

const PLANE_PRESETS = [
  { id: 'door', label: 'Door opening', width: '0.813', height: '2.032', unit: 'm' as MeasureUnit },
  { id: 'a4', label: 'A4 sheet', width: '21', height: '29.7', unit: 'cm' as MeasureUnit },
  { id: 'custom_plane', label: 'Custom rectangle', width: '', height: '', unit: 'm' as MeasureUnit },
];

const qualityStyles = {
  good: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  fair: 'border-blue-500/40 bg-blue-500/10 text-blue-200',
  poor: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  invalid: 'border-red-500/40 bg-red-500/10 text-red-200',
};

const CalibrationWizard: React.FC<CalibrationWizardProps> = ({
  draft,
  imageSize,
  existingDimensionCount,
  onChange,
  onApply,
  onCancel,
}) => {
  const requiredPoints = draft.method === 'plane' ? 4 : 2;
  const quality = draft.method
    ? assessCalibrationQuality(draft.method, draft.points, imageSize)
    : null;

  const patch = (updates: Partial<CalibrationDraft>) => onChange({ ...draft, ...updates });

  const selectMethod = (method: CalibrationMethod) => {
    const keepPoints = draft.method === method ? draft.points : [];
    if (method === 'plane') {
      patch({ method, stage: 'place', points: keepPoints, presetId: draft.method === 'plane' ? draft.presetId : 'door', width: draft.method === 'plane' ? draft.width : '0.813', height: draft.method === 'plane' ? draft.height : '2.032', unit: draft.method === 'plane' ? draft.unit : 'm' });
    } else {
      patch({ method, stage: 'place', points: keepPoints, presetId: draft.method === 'line' ? draft.presetId : 'door_height', value: draft.method === 'line' ? draft.value : '', unit: draft.method === 'line' ? draft.unit : 'm' });
    }
  };

  const selectPreset = (presetId: string) => {
    if (draft.method === 'plane') {
      const preset = PLANE_PRESETS.find(item => item.id === presetId)!;
      patch({ presetId, width: preset.width, height: preset.height, unit: preset.unit });
      return;
    }
    patch({ presetId });
  };

  const buildCalibration = (): Calibration | null => {
    if (!draft.method || !quality?.valid || draft.points.length !== requiredPoints) return null;
    if (draft.method === 'line') {
      const preset = CALIBRATION_PRESETS.find(item => item.id === draft.presetId);
      const customValue = Number(draft.value);
      if (!preset && (!Number.isFinite(customValue) || customValue <= 0)) return null;
      return {
        start: draft.points[0],
        end: draft.points[1],
        realValue: preset ? preset.mm : customValue,
        unit: preset ? 'mm' : draft.unit,
      };
    }

    const width = Number(draft.width);
    const height = Number(draft.height);
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return null;
    const widthMm = toMm(width, draft.unit);
    const heightMm = toMm(height, draft.unit);
    const corners = draft.points as [Point, Point, Point, Point];
    return {
      start: corners[0],
      end: corners[1],
      realValue: widthMm,
      unit: 'mm',
      plane: { corners, widthMm, heightMm },
    };
  };

  const calibration = buildCalibration();

  if (draft.stage === 'place') {
    const placed = Math.min(draft.points.length, requiredPoints);
    const instruction = draft.method === 'plane'
      ? placed < 4
        ? `Tap corner ${placed + 1} of 4 — ${['top-left', 'top-right', 'bottom-right', 'bottom-left'][placed]}`
        : 'Drag any numbered corner to refine it, then continue.'
      : placed === 0
        ? 'Tap the first end of the known edge.'
        : placed === 1
          ? 'Tap the other end of the known edge.'
          : 'Drag either endpoint to refine it, then continue.';

    return (
      <div className="fixed z-[190] bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 lg:left-[calc(50%+10rem)] -translate-x-1/2 w-[min(94vw,640px)] rounded-2xl border border-amber-400/40 bg-gray-950/95 p-3 shadow-2xl backdrop-blur-xl">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-500/15 text-amber-300">
            {draft.method === 'plane' ? <Grid3X3 className="h-5 w-5" /> : <LocateFixed className="h-5 w-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-white">{draft.method === 'plane' ? 'Perspective wall' : 'Known length'}</p>
              <span className="rounded-full bg-gray-800 px-2 py-1 text-[11px] font-semibold text-gray-300">{placed}/{requiredPoints} points</span>
            </div>
            <p className="mt-1 text-sm text-gray-300">{instruction}</p>
            <p className="mt-1 text-xs text-gray-500">Pinch to zoom and move · choose Pan view to drag the photo · return to Select & adjust to place points.</p>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-4 gap-2">
          <button onClick={onCancel} className="min-h-11 rounded-xl border border-gray-700 px-3 text-sm text-gray-300 hover:bg-gray-800">Cancel</button>
          <button onClick={() => patch({ points: draft.points.slice(0, -1) })} disabled={draft.points.length === 0} className="flex min-h-11 items-center justify-center gap-1 rounded-xl border border-gray-700 px-3 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-35"><Undo2 className="h-4 w-4" /> Undo</button>
          <button onClick={() => patch({ points: [] })} disabled={draft.points.length === 0} className="flex min-h-11 items-center justify-center gap-1 rounded-xl border border-gray-700 px-3 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-35"><RotateCcw className="h-4 w-4" /> Reset</button>
          <button onClick={() => patch({ stage: 'details' })} disabled={draft.points.length !== requiredPoints || !quality?.valid} className="min-h-11 rounded-xl bg-amber-600 px-3 text-sm font-semibold text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40">Continue</button>
        </div>
        {draft.points.length === requiredPoints && quality && (
          <div className={`mt-2 rounded-lg border px-3 py-2 text-xs ${qualityStyles[quality.level]}`}>
            <strong>{quality.title}.</strong> {quality.message}
          </div>
        )}
      </div>
    );
  }

  const isNavigableDetails = draft.stage === 'details';

  return (
    <div
      className={isNavigableDetails
        ? 'pointer-events-none fixed inset-0 z-[190] flex items-end justify-center p-4 lg:pl-[324px]'
        : 'fixed inset-0 z-[200] grid place-items-center bg-black/75 p-4 backdrop-blur-sm'}
      onClick={isNavigableDetails ? undefined : onCancel}
    >
      <div className={`pointer-events-auto w-full max-w-lg rounded-2xl border border-gray-700 bg-gray-950 p-5 shadow-2xl ${isNavigableDetails ? 'max-h-[min(72vh,620px)] overflow-y-auto border-amber-400/40 bg-gray-950/95 backdrop-blur-xl' : ''}`} onClick={event => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-400">Set real-world scale</p>
            <h2 className="mt-1 text-xl font-bold text-white">
              {draft.stage === 'choose' ? 'How was this photo taken?' : draft.stage === 'details' ? 'Enter the known size' : 'Review calibration'}
            </h2>
          </div>
          <button onClick={onCancel} className="grid h-11 w-11 place-items-center rounded-xl text-gray-400 hover:bg-gray-800 hover:text-white" aria-label="Close calibration"><X className="h-5 w-5" /></button>
        </div>

        {draft.stage === 'choose' && (
          <>
            <p className="mt-2 text-sm text-gray-400">Choose the method that matches the building photo. This decision controls the measurement math.</p>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <button onClick={() => selectMethod('plane')} className="min-h-40 rounded-2xl border border-amber-500/50 bg-amber-500/10 p-4 text-left transition hover:border-amber-300 hover:bg-amber-500/15">
                <div className="flex items-center justify-between"><Grid3X3 className="h-6 w-6 text-amber-300" /><span className="rounded-full bg-amber-400 px-2 py-1 text-[10px] font-bold text-gray-950">RECOMMENDED</span></div>
                <h3 className="mt-4 font-semibold text-white">Angled facade</h3>
                <p className="mt-1 text-sm text-gray-300">Mark four corners of a known rectangle on the wall. Corrects measurements for perspective.</p>
              </button>
              <button onClick={() => selectMethod('line')} className="min-h-40 rounded-2xl border border-gray-700 bg-gray-900 p-4 text-left transition hover:border-blue-400 hover:bg-gray-800">
                <Ruler className="h-6 w-6 text-blue-300" />
                <h3 className="mt-4 font-semibold text-white">Straight-on photo</h3>
                <p className="mt-1 text-sm text-gray-300">Mark one known edge with two points. Use only when the camera is square to the wall.</p>
              </button>
            </div>
          </>
        )}

        {draft.stage === 'details' && draft.method && (
          <>
            <div className="mb-2 rounded-lg border border-blue-400/20 bg-blue-500/10 px-3 py-2 text-xs text-blue-100">
              The photo remains live: drag empty space to pan, pinch or scroll to zoom, and use the controls on the right.
            </div>
            <button onClick={() => patch({ stage: 'place' })} className="mt-3 flex min-h-11 items-center gap-1 text-sm text-gray-300 hover:text-white"><ArrowLeft className="h-4 w-4" /> Adjust points</button>
            <label className="mt-2 block text-xs font-bold uppercase tracking-wider text-gray-500">Reference object</label>
            <select value={draft.presetId} onChange={event => selectPreset(event.target.value)} className="mt-1 min-h-12 w-full rounded-xl border border-gray-700 bg-gray-900 px-3 text-sm text-white focus:border-blue-500 focus:outline-none">
              {draft.method === 'line' ? (
                <>
                  {CALIBRATION_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
                  <option value="custom">Custom known length</option>
                </>
              ) : PLANE_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
            </select>

            {draft.method === 'line' && draft.presetId === 'custom' && (
              <div className="mt-3 grid grid-cols-[1fr_100px] gap-2">
                <input aria-label="Known length" inputMode="decimal" type="number" min="0" step="any" value={draft.value} onChange={event => patch({ value: event.target.value })} placeholder="Known length" className="min-h-12 rounded-xl border border-gray-700 bg-gray-900 px-3 text-white focus:border-blue-500 focus:outline-none" />
                <UnitSelect value={draft.unit} onChange={unit => patch({ unit })} />
              </div>
            )}

            {draft.method === 'plane' && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <label className="text-xs text-gray-400">Known width<input aria-label="Known width" inputMode="decimal" type="number" min="0" step="any" value={draft.width} onChange={event => patch({ width: event.target.value, presetId: 'custom_plane' })} className="mt-1 min-h-12 w-full rounded-xl border border-gray-700 bg-gray-900 px-3 text-base text-white focus:border-blue-500 focus:outline-none" /></label>
                <label className="text-xs text-gray-400">Known height<input aria-label="Known height" inputMode="decimal" type="number" min="0" step="any" value={draft.height} onChange={event => patch({ height: event.target.value, presetId: 'custom_plane' })} className="mt-1 min-h-12 w-full rounded-xl border border-gray-700 bg-gray-900 px-3 text-base text-white focus:border-blue-500 focus:outline-none" /></label>
                <div className="col-span-2"><UnitSelect value={draft.unit} onChange={unit => patch({ unit, presetId: 'custom_plane' })} /></div>
              </div>
            )}

            <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100">
              {draft.method === 'plane' ? 'Measurements are valid on this wall plane. Objects projecting toward or away from the wall need a separate reference.' : 'A two-point scale is accurate only on a straight-on photo and on the same flat wall as the reference.'}
            </div>
            <button onClick={() => patch({ stage: 'review' })} disabled={!calibration} className="mt-4 min-h-12 w-full rounded-xl bg-blue-600 font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40">Review calibration</button>
          </>
        )}

        {draft.stage === 'review' && draft.method && quality && (
          <>
            <button onClick={() => patch({ stage: 'details' })} className="mt-3 flex min-h-11 items-center gap-1 text-sm text-gray-300 hover:text-white"><ArrowLeft className="h-4 w-4" /> Change reference size</button>
            <div className={`mt-2 rounded-xl border p-4 ${qualityStyles[quality.level]}`}>
              <div className="flex items-start gap-3"><Check className="mt-0.5 h-5 w-5 shrink-0" /><div><p className="font-semibold">{quality.title}</p><p className="mt-1 text-sm opacity-85">{quality.message}</p></div></div>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-3 rounded-xl bg-gray-900 p-4 text-sm">
              <div><dt className="text-gray-500">Method</dt><dd className="mt-1 font-medium text-white">{draft.method === 'plane' ? 'Perspective wall · 4 points' : 'Known length · 2 points'}</dd></div>
              <div><dt className="text-gray-500">Reference coverage</dt><dd className="mt-1 font-medium text-white">{Math.round(quality.coverage * 100)}% of photo {draft.method === 'plane' ? 'area' : 'width'}</dd></div>
              <div className="col-span-2"><dt className="text-gray-500">Known size</dt><dd className="mt-1 font-medium text-white">{draft.method === 'plane' ? `${draft.width} × ${draft.height} ${draft.unit}` : CALIBRATION_PRESETS.find(item => item.id === draft.presetId)?.label ?? `${draft.value} ${draft.unit}`}</dd></div>
            </dl>
            {existingDimensionCount > 0 && (
              <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-gray-700 p-3 text-sm text-gray-300">
                <input type="checkbox" checked={draft.reapply} onChange={event => patch({ reapply: event.target.checked })} className="mt-1 h-4 w-4" />
                <span>Recalculate {existingDimensionCount} existing measurement{existingDimensionCount === 1 ? '' : 's'}<span className="block text-xs text-gray-500">This replaces hand-entered labels on those measurements.</span></span>
              </label>
            )}
            {!quality.valid && <p className="mt-3 flex gap-2 text-sm text-red-300"><AlertTriangle className="h-5 w-5 shrink-0" />Return to the canvas and correct the reference before applying.</p>}
            <button onClick={() => calibration && onApply(calibration, draft.reapply)} disabled={!calibration || !quality.valid} className="mt-4 min-h-12 w-full rounded-xl bg-emerald-600 font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40">Apply calibration</button>
          </>
        )}
      </div>
    </div>
  );
};

const UnitSelect: React.FC<{ value: MeasureUnit; onChange: (unit: MeasureUnit) => void }> = ({ value, onChange }) => (
  <select aria-label="Measurement unit" value={value} onChange={event => onChange(event.target.value as MeasureUnit)} className="min-h-12 w-full rounded-xl border border-gray-700 bg-gray-900 px-3 text-sm text-white focus:border-blue-500 focus:outline-none">
    <option value="mm">millimetres</option>
    <option value="cm">centimetres</option>
    <option value="m">metres</option>
    <option value="in">inches</option>
    <option value="ft">feet</option>
  </select>
);

export default CalibrationWizard;
