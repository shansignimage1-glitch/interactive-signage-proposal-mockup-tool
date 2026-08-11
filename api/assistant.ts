import { GoogleGenAI } from '@google/genai';
import { allowPost, enforceRateLimit, requireApiKey, requireFirebaseUser, sendApiError, type VercelRequest, type VercelResponse } from './_lib/security.js';
import { buildAssistantSystemInstruction } from './_lib/assistantKnowledge.js';

type Message = { role: 'user' | 'model'; text: string };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!allowPost(req, res)) return;
  try {
    const uid = await requireFirebaseUser(req);
    enforceRateLimit(uid, 'assistant', 20, 60_000);
    const messages = (req.body?.messages ?? []) as Message[];
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 24) return res.status(400).json({ error: 'Invalid conversation.' });
    let total = 0;
    for (const message of messages) {
      if (!['user', 'model'].includes(message?.role) || typeof message?.text !== 'string') return res.status(400).json({ error: 'Invalid conversation.' });
      total += message.text.length;
      if (message.text.length > 4_000 || total > 24_000) return res.status(413).json({ error: 'Conversation is too long. Start a new chat and try again.' });
    }
    const ai = new GoogleGenAI({ apiKey: requireApiKey() });
    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: messages.map(message => ({ role: message.role, parts: [{ text: message.text }] })),
      config: { systemInstruction: buildAssistantSystemInstruction(messages), maxOutputTokens: 800 },
    });
    const text = response.text?.trim();
    if (!text) throw new Error('EMPTY_RESPONSE');
    return res.status(200).json({ text });
  } catch (error) { sendApiError(res, error); }
}
