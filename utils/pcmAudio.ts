// Gemini TTS returns raw, headerless 16-bit little-endian PCM described by a
// MIME type such as "audio/L16;codec=pcm;rate=24000". AudioContext
// .decodeAudioData only understands container formats (WAV, MP3, …) and
// rejects raw PCM, so it has to be converted to samples by hand.

const DEFAULT_PCM_RATE = 24_000;

export const isRawPcm = (mimeType: string): boolean =>
    /audio\/(l16|pcm)\b|codec=pcm/i.test(mimeType);

export const pcmSampleRate = (mimeType: string): number => {
    const rate = Number(/rate=(\d+)/i.exec(mimeType)?.[1]);
    return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_PCM_RATE;
};

/** Signed 16-bit little-endian PCM → Float32 samples in [-1, 1). */
export const pcm16ToFloat32 = (bytes: Uint8Array): Float32Array => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    return samples;
};
