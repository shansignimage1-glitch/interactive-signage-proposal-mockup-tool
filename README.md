# SignagePro

SignagePro is a React 19 proposal and mockup application for signage companies. It combines facade photography, perspective-warped sign artwork, custom WebGL extrusion, calibrated measurements, project exports, cloud sync and a managed signage library.

## Architecture

- React 19, TypeScript, Vite and Tailwind CSS.
- Custom WebGL/SVG canvas for perspective, extrusion, selection and dimensions.
- IndexedDB is the offline/local project store.
- The installable PWA caches the app shell; offline signed-in edits are queued in IndexedDB and uploaded when connectivity returns.
- The dedicated Firebase project `sunny-ship-437805-c5` provides Google authentication, Firestore metadata and Firebase Storage fallback. Never point this app at the shared `signimage-cc` project.
- Optional Google Drive, OneDrive and Dropbox connectors store user-owned project images and exports.
- Vercel functions under `api/` proxy Gemini requests so the API key never enters the browser bundle.
- html2canvas and jsPDF are bundled and dynamically imported only during export.
- Optional Sentry browser monitoring is dynamically loaded when `VITE_SENTRY_DSN` is set.

## Environment variables

Copy `.env.example` to `.env.local`.

| Variable | Location | Purpose |
|---|---|---|
| `VITE_GOOGLE_OAUTH_CLIENT_ID` | browser | Google Drive OAuth client |
| `VITE_MICROSOFT_CLIENT_ID` | browser | Microsoft Entra SPA client |
| `VITE_DROPBOX_APP_KEY` | browser | Dropbox App Folder key |
| `VITE_SENTRY_DSN` | browser | Optional error-reporting DSN |
| `VITE_APP_VERSION` | browser | Release identifier sent to monitoring |
| `GEMINI_API_KEY` | server only | Vercel AI functions; never prefix with `VITE_` |

## Firebase and OAuth setup

Enable Google authentication and authorize both `http://localhost:3000` and the production Vercel domain in Firebase Authentication. Deploy only to the dedicated Firebase project using `.firebaserc`:

```powershell
firebase deploy --only firestore:rules,firestore:indexes,storage
```

Cloud-drive registrations:

- Google: web OAuth client with `drive.file`; add localhost and production JavaScript origins.
- Microsoft: Entra SPA with `Files.ReadWrite.AppFolder` and `User.Read`; add exact SPA redirect URLs.
- Dropbox: scoped App Folder application with `files.content.read` and `files.content.write`; add exact redirect URLs.

Users may connect multiple providers and select one for new images and PDF/PNG exports. Existing provider references remain associated with their original provider. Disconnecting revokes access but does not delete files already in the provider.

## Local development

```powershell
npm ci
npx vercel dev --listen 3000
```

Open [http://localhost:3000](http://localhost:3000). `npm run dev` runs only Vite and is suitable when server-side AI functions are not needed.

## Testing

```powershell
npm test                 # unit and IndexedDB integration tests
npm run test:rules       # Firestore/Storage emulator rules; Java 21 required
npm run test:e2e         # desktop and iPad Playwright workflows
npm run test:all         # complete release sequence
npx tsc --noEmit         # TypeScript verification
npm run build            # production bundle
npm audit                # dependency audit
```

## Deployment

1. Run all release checks above.
2. Configure all environment variables in Vercel for Production and Preview as appropriate.
3. Confirm Firebase authorized domains and every OAuth redirect exactly match the deployment URL.
4. Push the reviewed commit; the connected Vercel project deploys from GitHub.
5. Verify Google login, guest mode, project save/reopen, export, selected-drive upload and iPad layout.

`vercel.json` applies CSP, camera permissions, referrer, MIME-sniffing and frame-embedding protections. When adding a third-party endpoint, update CSP deliberately instead of weakening it globally.

## Backup and recovery

Account & data → **Export all project data** downloads a JSON backup containing locally available and cloud-only projects. Firebase/Drive content remains subject to each provider's retention and trash behavior. Test recovery before relying on a backup for production work.

Deleting all data removes local projects, Firestore projects, user Firebase Storage objects and personal-library records. App-created Drive files are removed when their project references can be resolved and the relevant provider is connected. Disconnecting by itself leaves provider files in place.

## Signage library administration

Administrator access is enforced with a Firebase Auth custom claim, never an editable email address. To grant or revoke it, first run `gcloud auth application-default login`, find the user's Firebase UID, and run:

```powershell
npm run admin:claim -- FIREBASE_UID true   # grant
npm run admin:claim -- FIREBASE_UID false  # revoke
```

The user must sign out and back in to receive the refreshed token. Administrators can publish, edit, replace, version and delete shared templates. Each template should include category, dimensions, sign type, brand, tags and an artwork-rights note. Do not upload customer or brand artwork without documented permission.

## Field use, image limits and sync conflicts

- Install SignagePro from Safari's **Share → Add to Home Screen** on iPad. Open it once online before relying on the offline app shell.
- Photos are resized to a maximum 4096-pixel edge before Drive or Firebase upload. Sources over 40 MB or 80 megapixels are rejected with a safe, actionable message.
- Device storage is checked before local saves. If space is low, free storage and reopen the project before retrying.
- Use **Plane** calibration for angled walls: tap the visible wall corners clockwise (top-left, top-right, bottom-right, bottom-left), then enter its known width and height.
- If another device saves a newer revision, autosave pauses and offers **Load cloud** or **Keep this device**. Choosing the latter intentionally creates the next cloud revision.

## Privacy, terms and support

Public in-app pages are available at `#/privacy`, `#/terms` and `#/support`. Review these texts with qualified legal counsel before public launch. Support contact: `shansignimage1@gmail.com`.

## Release management

- Update `package.json` and `VITE_APP_VERSION` together.
- Keep changes in a reviewable branch and record user-visible changes in the release/PR description.
- Do not deploy with a failing audit, type-check, rules test, production build or iPad workflow.
- Vercel monitoring access currently requires connector reauthentication before automated deployment/runtime diagnostics can be relied on.
