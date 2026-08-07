import { GoogleGenAI, Modality } from '@google/genai';
import { allowPost, enforceRateLimit, requireApiKey, requireFirebaseUser, sendApiError, type VercelRequest, type VercelResponse } from './_lib/security.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!allowPost(req, res)) return;
  try {
    const uid = await requireFirebaseUser(req);
    enforceRateLimit(uid, 'tts', 10, 60_000);
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 2_000) return res.status(400).json({ error: 'Invalid speech text.' });
    const ai = new GoogleGenAI({ apiKey: requireApiKey() });
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-preview-tts',
      contents: [{ parts: [{ text }] }],
      config: { responseModalities: [Modality.AUDIO], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } } },
    });
    const audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!audio) throw new Error('EMPTY_RESPONSE');
    return res.status(200).json({ audio });
  } catch (error) { sendApiError(res, error); }
}
