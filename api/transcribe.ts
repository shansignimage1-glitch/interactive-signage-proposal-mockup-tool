import { GoogleGenAI } from '@google/genai';
import { allowPost, enforceRateLimit, requireApiKey, requireFirebaseUser, sendApiError, type VercelRequest, type VercelResponse } from './_lib/security.js';

const ALLOWED_AUDIO = new Set(['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/aac']);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!allowPost(req, res)) return;
  try {
    const uid = await requireFirebaseUser(req);
    enforceRateLimit(uid, 'transcribe', 30, 60_000);
    const data = req.body?.audio as string;
    const mimeType = String(req.body?.mimeType ?? '').split(';')[0];
    if (!ALLOWED_AUDIO.has(mimeType) || typeof data !== 'string' || data.length < 20) return res.status(400).json({ error: 'Invalid audio recording.' });
    if (data.length > 4_000_000) return res.status(413).json({ error: 'Recording is too long. Keep dictation under one minute.' });

    const ai = new GoogleGenAI({ apiKey: requireApiKey() });
    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: [{ role: 'user', parts: [
        { inlineData: { mimeType, data } },
        { text: 'Transcribe this field note exactly. Preserve spoken numbers and measurement units. Return only the transcript, without commentary or quotation marks.' },
      ] }],
      config: { maxOutputTokens: 800 },
    });
    const text = response.text?.trim();
    if (!text) throw new Error('EMPTY_RESPONSE');
    return res.status(200).json({ text });
  } catch (error) { sendApiError(res, error); }
}
