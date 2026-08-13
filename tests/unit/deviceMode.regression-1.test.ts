import { describe, expect, it } from 'vitest';
import { shouldUsePhoneCapture, type DeviceModeEnvironment } from '../../utils/deviceMode';

const environment = (overrides: Partial<DeviceModeEnvironment> = {}): DeviceModeEnvironment => ({
  search: '',
  screenWidth: 390,
  screenHeight: 844,
  viewportWidth: 390,
  viewportHeight: 664,
  coarsePointer: true,
  mobileUserAgent: true,
  ...overrides,
});

// Regression: ISSUE-IPAD-001 — compact Safari chrome routed iPad to the phone capture shell
// Found by /qa on 2026-08-13
// Report: .gstack/qa-reports/qa-report-ipad-routing-2026-08-13.md
describe('phone capture device routing', () => {
  it('keeps landscape iPad Safari in the tablet editor when browser chrome reduces viewport height', () => {
    expect(shouldUsePhoneCapture(environment({
      screenWidth: 834,
      screenHeight: 1194,
      viewportWidth: 1024,
      viewportHeight: 650,
    }))).toBe(false);
  });

  it('keeps phone capture active in portrait and landscape', () => {
    expect(shouldUsePhoneCapture(environment())).toBe(true);
    expect(shouldUsePhoneCapture(environment({
      screenWidth: 844,
      screenHeight: 390,
      viewportWidth: 844,
      viewportHeight: 390,
    }))).toBe(true);
  });

  it('keeps a phone in capture mode when desktop-site mode masks its mobile user agent', () => {
    expect(shouldUsePhoneCapture(environment({ mobileUserAgent: false }))).toBe(true);
  });

  it('does not treat a narrow desktop window as a phone', () => {
    expect(shouldUsePhoneCapture(environment({
      screenWidth: 1920,
      screenHeight: 1080,
      viewportWidth: 500,
      viewportHeight: 800,
      coarsePointer: false,
      mobileUserAgent: false,
    }))).toBe(false);
  });

  it('does not treat a highly scaled Windows touchscreen as a phone', () => {
    expect(shouldUsePhoneCapture(environment({
      screenWidth: 960,
      screenHeight: 540,
      viewportWidth: 960,
      viewportHeight: 540,
      coarsePointer: false,
      mobileUserAgent: false,
    }))).toBe(false);
  });

  it('honours explicit editor and mobile capture overrides on every device size', () => {
    expect(shouldUsePhoneCapture(environment({ search: '?editor=1' }))).toBe(false);
    expect(shouldUsePhoneCapture(environment({
      search: '?mobileCapture=1',
      screenWidth: 834,
      screenHeight: 1194,
    }))).toBe(true);
    expect(shouldUsePhoneCapture(environment({ search: '?editor=1&mobileCapture=1' }))).toBe(false);
  });

  it('falls back to viewport dimensions when the Screen API is unavailable', () => {
    expect(shouldUsePhoneCapture(environment({ screenWidth: 0, screenHeight: 0 }))).toBe(true);
  });
});
