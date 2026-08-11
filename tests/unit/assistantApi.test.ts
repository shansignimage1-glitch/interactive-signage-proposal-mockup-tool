import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAssistantSystemInstruction } from '../../api/_lib/assistantKnowledge';

const aiMocks = vi.hoisted(() => ({
  constructorOptions: [] as unknown[],
  generateContent: vi.fn(),
}));

const securityMocks = vi.hoisted(() => ({
  allowPost: vi.fn(),
  enforceRateLimit: vi.fn(),
  requireApiKey: vi.fn(),
  requireFirebaseUser: vi.fn(),
  sendApiError: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: aiMocks.generateContent };
    constructor(options: unknown) { aiMocks.constructorOptions.push(options); }
  },
}));

vi.mock('../../api/_lib/security.js', () => securityMocks);

import handler from '../../api/assistant';

const response = () => {
  const result: { statusCode?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  const res = {
    setHeader: (name: string, value: string) => { result.headers[name] = value; return res; },
    status: (code: number) => { result.statusCode = code; return res; },
    json: (body: unknown) => { result.body = body; return res; },
  };
  return { result, res };
};

describe('SignagePro assistant endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aiMocks.constructorOptions.length = 0;
    securityMocks.allowPost.mockReturnValue(true);
    securityMocks.requireFirebaseUser.mockResolvedValue('user-1');
    securityMocks.requireApiKey.mockReturnValue('test-key');
    securityMocks.sendApiError.mockImplementation((res, error) => {
      const status = error instanceof Error && error.message === 'UNAUTHORIZED' ? 401 : 500;
      return res.status(status).json({ error: status === 401 ? 'Please sign in again to use AI features.' : 'The AI service could not complete this request.' });
    });
    aiMocks.generateContent.mockResolvedValue({ text: 'Use a four-corner wall calibration.' });
  });

  it('sends the relevant versioned product knowledge to Gemini', async () => {
    const { result, res } = response();
    await handler({
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
      body: { messages: [{ role: 'user', text: 'How are dimensions calculated?' }] },
    }, res);

    expect(securityMocks.requireFirebaseUser).toHaveBeenCalledOnce();
    expect(securityMocks.enforceRateLimit).toHaveBeenCalledWith('user-1', 'assistant', 20, 60_000);
    expect(aiMocks.constructorOptions).toEqual([{ apiKey: 'test-key' }]);
    expect(aiMocks.generateContent).toHaveBeenCalledWith({
      model: 'gemini-3.6-flash',
      contents: [{ role: 'user', parts: [{ text: 'How are dimensions calculated?' }] }],
      config: { systemInstruction: buildAssistantSystemInstruction([{ text: 'How are dimensions calculated?' }]), maxOutputTokens: 800 },
    });
    expect(result).toMatchObject({ statusCode: 200, body: { text: 'Use a four-corner wall calibration.' } });
  });

  it('rejects an invalid conversation before calling Gemini', async () => {
    const { result, res } = response();
    await handler({ method: 'POST', headers: {}, body: { messages: [] } }, res);
    expect(result.statusCode).toBe(400);
    expect(aiMocks.generateContent).not.toHaveBeenCalled();
  });

  it('does not call Gemini when authentication fails', async () => {
    securityMocks.requireFirebaseUser.mockRejectedValue(new Error('UNAUTHORIZED'));
    const { result, res } = response();
    await handler({ method: 'POST', headers: {}, body: { messages: [{ role: 'user', text: 'Help' }] } }, res);
    expect(result.statusCode).toBe(401);
    expect(aiMocks.generateContent).not.toHaveBeenCalled();
  });
});
