import { Point, Calibration, MeasureUnit, UnitSystem } from '../types';
import { distance } from './math';

// --- Unit conversion ---

const MM_PER_UNIT: Record<MeasureUnit, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};

export const toMm = (value: number, unit: MeasureUnit): number => value * MM_PER_UNIT[unit];

// Millimetres of real-world length represented by one intrinsic image pixel.
// Returns null when the calibration line is degenerate (zero length).
export const getMmPerPx = (cal: Calibration): number | null => {
  const px = distance(cal.start, cal.end);
  if (px < 1) return null;
  return toMm(cal.realValue, cal.unit) / px;
};

// --- Formatting ---

// Metric: 8mm / 60cm / 2.40m — Imperial: 4" / 9'6"
export const formatLength = (mm: number, system: UnitSystem): string => {
  if (!isFinite(mm) || mm < 0) return '?';

  if (system === 'imperial') {
    const totalInches = mm / 25.4;
    if (totalInches < 12) {
      return `${(Math.round(totalInches * 10) / 10)}"`;
    }
    const feet = Math.floor(totalInches / 12);
    const inches = Math.round(totalInches - feet * 12);
    if (inches === 12) return `${feet + 1}'0"`;
    return `${feet}'${inches}"`;
  }

  if (mm < 10) return `${Math.round(mm)}mm`;
  if (mm < 1000) return `${Math.round(mm / 10)}cm`;
  return `${(mm / 1000).toFixed(2)}m`;
};

// --- Measuring drawn shapes ---

export const measureLine = (start: Point, end: Point, cal: Calibration, system: UnitSystem): string => {
  const mmPerPx = getMmPerPx(cal);
  if (mmPerPx === null) return '?';
  return formatLength(distance(start, end) * mmPerPx, system);
};

// Box dimensions read as "width × height"
export const measureBox = (start: Point, end: Point, cal: Calibration, system: UnitSystem): string => {
  const mmPerPx = getMmPerPx(cal);
  if (mmPerPx === null) return '?';
  const w = Math.abs(end.x - start.x) * mmPerPx;
  const h = Math.abs(end.y - start.y) * mmPerPx;
  return `${formatLength(w, system)} × ${formatLength(h, system)}`;
};

// --- Calibration reference presets ---

export interface CalibrationPreset {
  id: string;
  label: string;
  mm: number;
}

export const CALIBRATION_PRESETS: CalibrationPreset[] = [
  { id: 'credit_card', label: 'Credit / bank card width (8.56cm)', mm: 85.6 },
  { id: 'a4_long', label: 'A4 sheet long edge (29.7cm)', mm: 297 },
  { id: 'door_width', label: 'Standard door width (81.3cm)', mm: 813 },
  { id: 'door_height', label: 'Standard door height (2.03m)', mm: 2032 },
  { id: 'brick', label: 'Brick length (22.2cm)', mm: 222 },
];
