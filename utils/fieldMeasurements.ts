import { MeasureUnit } from '../types';
import { toMm } from './measure';

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const spokenNumber = (text: string): number | null => {
  const numeric = text.match(/-?\d+(?:[.,]\d+)?/);
  if (numeric) return Number(numeric[0].replace(',', '.'));
  const words = text.toLowerCase().replace(/-/g, ' ').split(/\s+/);
  let total = 0;
  let current = 0;
  let decimal = '';
  let afterPoint = false;
  let found = false;
  for (const word of words) {
    if (word === 'point' || word === 'comma') { afterPoint = true; found = true; continue; }
    if (!(word in SMALL) && word !== 'hundred' && word !== 'thousand') continue;
    found = true;
    if (afterPoint) {
      if (word in SMALL && SMALL[word] < 10) decimal += String(SMALL[word]);
      continue;
    }
    if (word === 'hundred') current = Math.max(1, current) * 100;
    else if (word === 'thousand') { total += Math.max(1, current) * 1000; current = 0; }
    else current += SMALL[word];
  }
  if (!found) return null;
  const value = total + current;
  return decimal ? Number(`${value}.${decimal}`) : value;
};

export const parseSpokenMeasurementMm = (transcript: string, fallbackUnit: MeasureUnit = 'mm'): number | null => {
  const normalized = transcript.toLowerCase();
  const value = spokenNumber(normalized);
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  let unit: MeasureUnit = fallbackUnit;
  if (/\b(millimet(?:er|re)s?|mm)\b/.test(normalized)) unit = 'mm';
  else if (/\b(centimet(?:er|re)s?|cm)\b/.test(normalized)) unit = 'cm';
  else if (/\b(met(?:er|re)s?|m)\b/.test(normalized)) unit = 'm';
  else if (/\b(inch(?:es)?|in)\b/.test(normalized)) unit = 'in';
  else if (/\b(feet|foot|ft)\b/.test(normalized)) unit = 'ft';
  return Math.round(toMm(value, unit) * 100) / 100;
};

export const displayMeasurement = (mm: number | undefined, unit: MeasureUnit): string => {
  if (mm === undefined || !Number.isFinite(mm)) return '';
  const divisors: Record<MeasureUnit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
  return String(Math.round((mm / divisors[unit]) * 1000) / 1000);
};

