import React, { useState } from 'react';
import { MeasureUnit } from '../types';
import { CALIBRATION_PRESETS } from '../utils/measure';
import { Ruler, X, AlertTriangle } from 'lucide-react';

interface CalibrationModalProps {
  pixelLength: number;          // length of the drawn reference line, in image px
  existingDimensionCount: number;
  onConfirm: (realValue: number, unit: MeasureUnit, reapply: boolean) => void;
  onCancel: () => void;
}

const CalibrationModal: React.FC<CalibrationModalProps> = ({ pixelLength, existingDimensionCount, onConfirm, onCancel }) => {
  const [presetId, setPresetId] = useState<string>(CALIBRATION_PRESETS[0].id);
  const [customValue, setCustomValue] = useState<string>('');
  const [customUnit, setCustomUnit] = useState<MeasureUnit>('cm');
  const [reapply, setReapply] = useState(false);

  const isCustom = presetId === 'custom';
  const preset = CALIBRATION_PRESETS.find(p => p.id === presetId);
  const parsedCustom = parseFloat(customValue);
  const canConfirm = isCustom ? (isFinite(parsedCustom) && parsedCustom > 0) : !!preset;

  const handleConfirm = () => {
    if (!canConfirm) return;
    if (isCustom) {
      onConfirm(parsedCustom, customUnit, reapply);
    } else {
      onConfirm(preset!.mm, 'mm', reapply);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[200] flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white font-bold text-lg flex items-center gap-2">
            <Ruler className="w-5 h-5 text-amber-400" /> Set Real-World Scale
          </h2>
          <button onClick={onCancel} className="text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>

        <p className="text-gray-400 text-sm mb-4">
          You drew a reference line of <strong className="text-white">{Math.round(pixelLength)}px</strong> over the photo.
          Tell us the real-world length of the object under that line, and all measurements on this view will be calculated automatically.
        </p>

        <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Reference Object</label>
        <select
          value={presetId}
          onChange={e => setPresetId(e.target.value)}
          className="w-full bg-gray-800 border border-gray-600 text-white text-sm rounded-lg px-3 py-2 mb-3 focus:outline-none focus:border-blue-500"
        >
          {CALIBRATION_PRESETS.map(p => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
          <option value="custom">Custom length…</option>
        </select>

        {isCustom && (
          <div className="flex gap-2 mb-3">
            <input
              type="number"
              min="0"
              step="any"
              placeholder="e.g. 2.4"
              value={customValue}
              onChange={e => setCustomValue(e.target.value)}
              autoFocus
              className="flex-1 bg-gray-800 border border-gray-600 text-white px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-blue-500"
            />
            <select
              value={customUnit}
              onChange={e => setCustomUnit(e.target.value as MeasureUnit)}
              className="bg-gray-800 border border-gray-600 text-white text-sm rounded-lg px-2 focus:outline-none focus:border-blue-500"
            >
              <option value="mm">mm</option>
              <option value="cm">cm</option>
              <option value="m">m</option>
              <option value="in">in</option>
              <option value="ft">ft</option>
            </select>
          </div>
        )}

        {existingDimensionCount > 0 && (
          <label className="flex items-start gap-2 text-sm text-gray-300 mb-3 cursor-pointer">
            <input type="checkbox" checked={reapply} onChange={e => setReapply(e.target.checked)} className="mt-0.5" />
            <span>
              Also recalculate the {existingDimensionCount} existing dimension label{existingDimensionCount > 1 ? 's' : ''} on this view
              <span className="block text-xs text-gray-500">This overwrites any hand-typed labels.</span>
            </span>
          </label>
        )}

        <p className="text-amber-400/80 text-xs mb-4 flex gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>Measurements are most accurate on straight-on photos, for objects on the same wall plane as the reference.</span>
        </p>

        <div className="flex gap-2">
          <button
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white py-2 rounded-lg text-sm font-semibold transition-colors"
          >
            Set Scale
          </button>
          <button onClick={onCancel} className="px-4 bg-gray-700 hover:bg-gray-600 text-gray-300 py-2 rounded-lg text-sm transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default CalibrationModal;
