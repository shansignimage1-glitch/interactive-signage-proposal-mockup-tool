import { execFileSync, execSync } from 'node:child_process';

// Usage:
//   node scripts/apply-storage-cors.mjs          # apply and verify
//   node scripts/apply-storage-cors.mjs --check  # verify without changing state
// Requires an authenticated Google Cloud CLI session with bucket permission.

const bucket = 'sunny-ship-437805-c5.firebasestorage.app';
const cors = [{
  origin: [
    'https://signage-proposal-mockup-tool.vercel.app',
    'http://localhost:3000',
    'http://localhost:4173',
    'http://localhost:5173',
    'http://127.0.0.1:4173',
    'http://127.0.0.1:5173',
  ],
  method: ['GET', 'HEAD'],
  responseHeader: ['Content-Type', 'Content-Length', 'Content-Disposition', 'ETag'],
  maxAgeSeconds: 3600,
}];

const accessToken = (process.platform === 'win32'
  ? execSync('gcloud auth print-access-token', { encoding: 'utf8', windowsHide: true })
  : execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' })
).trim();
if (!accessToken) throw new Error('Google Cloud CLI did not return an access token.');

const endpoint = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}?fields=cors`;
const request = async (method, body) => {
  const response = await fetch(endpoint, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`Storage CORS ${method} failed (${response.status}): ${await response.text()}`);
  return response.json();
};

if (!process.argv.includes('--check')) await request('PATCH', { cors });
const current = (await request('GET')).cors ?? [];
if (JSON.stringify(current) !== JSON.stringify(cors)) {
  throw new Error(`Storage CORS verification failed. Expected ${JSON.stringify(cors)}, received ${JSON.stringify(current)}`);
}

console.log(`Storage CORS is configured and verified for gs://${bucket}.`);
