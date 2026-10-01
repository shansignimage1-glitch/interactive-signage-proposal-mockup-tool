import { GoogleGenAI, Modality } from '@google/genai';
import { allowPost, enforceDailyBudget, enforceRateLimit, requireApiKey, requireFirebaseUser, sendApiError, type VercelRequest, type VercelResponse } from './_lib/security.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!allowPost(req, res)) return;
  try {
    const uid = await requireFirebaseUser(req);
    await enforceRateLimit(uid, 'tts', 10, 60_000);
    await enforceDailyBudget('tts', 500);
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 2_000) return res.status(400).json({ error: 'Invalid speech text.' });
    const ai = new GoogleGenAI({ apiKey: requireApiKey() });
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-preview-tts',
      contents: [{ parts: [{ text }] }],
      config: { responseModalities: [Modality.AUDIO], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } } },
    });
    const inline = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (!inline?.data) throw new Error('EMPTY_RESPONSE');
    // Gemini TTS returns headerless PCM (e.g. "audio/L16;codec=pcm;rate=24000").
    // The client needs the format to decode it — decodeAudioData cannot.
    return res.status(200).json({ audio: inline.data, mimeType: inline.mimeType ?? 'audio/L16;codec=pcm;rate=24000' });
  } catch (error) { sendApiError(res, error); }
}
