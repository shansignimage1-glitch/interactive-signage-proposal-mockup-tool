import { describe, expect, it } from 'vitest';
import { displayMeasurement, parseSpokenMeasurementMm } from '../../utils/fieldMeasurements';

describe('mobile field measurements', () => {
  it('normalizes typed and dictated metric measurements to millimetres', () => {
    expect(parseSpokenMeasurementMm('2.5 metres')).toBe(2500);
    expect(parseSpokenMeasurementMm('two point five meters')).toBe(2500);
    expect(parseSpokenMeasurementMm('450 millimetres')).toBe(450);
    expect(parseSpokenMeasurementMm('320', 'cm')).toBe(3200);
  });

  it('supports imperial field dictation and stable display conversion', () => {
    expect(parseSpokenMeasurementMm('twelve inches')).toBeCloseTo(304.8);
    expect(parseSpokenMeasurementMm('six feet')).toBeCloseTo(1828.8);
    expect(displayMeasurement(2500, 'm')).toBe('2.5');
  });

  it('rejects transcripts without a usable measurement', () => {
    expect(parseSpokenMeasurementMm('the back wall')).toBeNull();
  });
});

