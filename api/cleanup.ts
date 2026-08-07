import { GoogleGenAI } from '@google/genai';
import { allowPost, enforceRateLimit, requireApiKey, requireFirebaseUser, sendApiError, type VercelRequest, type VercelResponse } from './_lib/security.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!allowPost(req, res)) return;
  try {
    const uid = await requireFirebaseUser(req);
    enforceRateLimit(uid, 'cleanup', 5, 10 * 60_000);
    const { image, mimeType, prompt } = req.body ?? {};
    if (typeof image !== 'string' || image.length < 100 || image.length > 12_000_000) return res.status(413).json({ error: 'Image is missing or too large.' });
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) return res.status(400).json({ error: 'Unsupported image type.' });
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 1_500) return res.status(400).json({ error: 'Invalid cleanup instruction.' });
    const ai = new GoogleGenAI({ apiKey: requireApiKey() });
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-image',
      contents: { parts: [{ inlineData: { data: image, mimeType } }, { text: prompt }] },
      config: { responseModalities: ['Image'] },
    });
    const output = response.candidates?.[0]?.content?.parts?.find(part => part.inlineData)?.inlineData;
    if (!output?.data) throw new Error('EMPTY_RESPONSE');
    return res.status(200).json({ image: output.data, mimeType: output.mimeType || 'image/png' });
  } catch (error) { sendApiError(res, error); }
}
