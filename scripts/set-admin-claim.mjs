import { execFileSync } from 'node:child_process';

const [uid, value = 'true'] = process.argv.slice(2);
if (!uid || !['true', 'false'].includes(value)) {
  console.error('Usage: npm run admin:claim -- <firebase-uid> [true|false]');
  process.exit(1);
}

const projectId = process.env.FIREBASE_PROJECT_ID || 'sunny-ship-437805-c5';
let token = process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
if (!token) {
  try {
    token = execFileSync('gcloud', ['auth', 'application-default', 'print-access-token'], { encoding: 'utf8' }).trim();
  } catch {
    console.error('Run `gcloud auth application-default login`, or set GOOGLE_OAUTH_ACCESS_TOKEN, then retry.');
    process.exit(1);
  }
}

const response = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:update`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    // User OAuth credentials need an explicit consumer project for API quota.
    // Without this header Google attributes the call to the Cloud SDK's own
    // project and rejects Identity Toolkit access with SERVICE_DISABLED.
    'x-goog-user-project': projectId,
  },
  body: JSON.stringify({ localId: uid, customAttributes: JSON.stringify({ admin: value === 'true' }) }),
});

if (!response.ok) {
  console.error(`Claim update failed (${response.status}): ${await response.text()}`);
  process.exit(1);
}
console.log(`Admin claim ${value === 'true' ? 'granted to' : 'removed from'} ${uid}. The user must sign out and back in.`);
