import { auth } from '../firebase';

export interface GeminiMessage { role: 'user' | 'model'; text: string; }

async function authenticatedPost<T>(path: string, body: unknown): Promise<T> {
  const user = auth.currentUser;
  if (!user) throw new Error('Please sign in with Google to use AI features.');
  const token = await user.getIdToken();
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(payload.error || `AI request failed (${response.status}).`);
  return payload;
}

export async function askSignageAssistant(messages: GeminiMessage[]): Promise<string> {
  return (await authenticatedPost<{ text: string }>('/api/assistant', { messages })).text;
}

export async function generateSpeech(text: string): Promise<string> {
  return (await authenticatedPost<{ audio: string }>('/api/tts', { text })).audio;
}

export async function cleanupImage(image: string, mimeType: string, prompt: string): Promise<string> {
  const result = await authenticatedPost<{ image: string; mimeType: string }>('/api/cleanup', { image, mimeType, prompt });
  return `data:${result.mimeType};base64,${result.image}`;
}
