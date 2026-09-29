import { describe, expect, it } from 'vitest';
import { isRawPcm, pcm16ToFloat32, pcmSampleRate } from '../../utils/pcmAudio';

describe('Gemini TTS PCM decoding', () => {
  it('recognises Gemini raw PCM MIME types but not container formats', () => {
    expect(isRawPcm('audio/L16;codec=pcm;rate=24000')).toBe(true);
    expect(isRawPcm('audio/pcm')).toBe(true);
    expect(isRawPcm('audio/l16')).toBe(true);
    expect(isRawPcm('audio/wav')).toBe(false);
    expect(isRawPcm('audio/mpeg')).toBe(false);
  });

  it('reads the sample rate, defaulting to Gemini\'s 24 kHz', () => {
    expect(pcmSampleRate('audio/L16;codec=pcm;rate=16000')).toBe(16000);
    expect(pcmSampleRate('audio/L16;codec=pcm')).toBe(24000);
  });

  it('converts signed 16-bit little-endian samples to [-1, 1)', () => {
    const bytes = new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x00, 0x40]);
    const samples = pcm16ToFloat32(bytes);
    expect(Array.from(samples)).toEqual([0, 32767 / 32768, -1, 0.5]);
  });

  it('respects a view offset into a larger buffer and ignores a trailing odd byte', () => {
    const backing = new Uint8Array([0xaa, 0x00, 0x40, 0x01]);
    expect(Array.from(pcm16ToFloat32(backing.subarray(1)))).toEqual([0x4000 / 32768]);
  });
});
