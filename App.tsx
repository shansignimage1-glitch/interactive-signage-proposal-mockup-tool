
import React, { useState, useCallback, useRef, useEffect, Suspense } from 'react';
import { auth, googleProvider } from './firebase';
import { getIdTokenResult, getRedirectResult, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut, type User as FirebaseUser } from 'firebase/auth';

import ControlsPanel from './components/ControlsPanel';
import MockupCanvas from './components/MockupCanvas';
// Lazy-loaded: these features are only downloaded when opened.
const CleanupTool = React.lazy(() => import('./components/CleanupTool'));
const Assistant = React.lazy(() => import('./components/Assistant'));
const ProjectManager = React.lazy(() => import('./components/ProjectManager'));
const ElementStudio = React.lazy(() => import('./components/ElementStudio'));
const DriveSettings = React.lazy(() => import('./components/DriveSettings'));
const FinishMeasuringDialog = React.lazy(() => import('./components/FinishMeasuringDialog'));
const AccountSettings = React.lazy(() => import('./components/AccountSettings'));
const Proposal3DViewer = React.lazy(() => import('./components/Proposal3DViewer'));
const MobileSiteCapture = React.lazy(() => import('./components/MobileSiteCapture'));
import { MockupState, AppImages, Point, Sign, Dimension, TitleBlock, TitleBlockField, Canvas, Calibration, SignElement, Size, ConnectorStatus, CloudProvider, UserProfile, SiteCapturePhoto } from './types';
import { getActiveConnector, getPreferredProvider, setConnectorUid, connectors, getConnectorForRef } from './services/driveConnectors';
import { distance } from './utils/math';
import { isPhoneSizedTouchDevice, readDeviceModeEnvironment, shouldUsePhoneCapture, type DeviceModeEnvironment } from './utils/deviceMode';
import { isAuthCancellationError, isMissingRedirectStateError } from './utils/authErrors';
import { prefersRedirectSignIn } from './utils/authSignIn';
import { measureLine, measureBox, getMmPerPx } from './utils/measure';
import { normalizeProjectState } from './utils/projectMigration';
import { isValidSurveyPlaneSize } from './utils/fieldMeasurements';
import CalibrationWizard, { CalibrationDraft } from './components/CalibrationWizard';
import { TITLE_BLOCK_TEMPLATES } from './data/titleBlockTemplates';
import { deleteLocalAsset, getAssetBlob, getSiteCaptureAsset, StorageService, type ProjectSaveResult } from './services/StorageService';
import { Wifi, WifiOff, RefreshCw, LogIn, LogOut, Loader2, AlertTriangle, User as UserIcon, HardDrive, Database, Settings, Building2 } from 'lucide-react';
import { notify } from './services/toast';
import { reportError, reportWarning } from './services/monitoring';
import { captureElement } from './utils/exportCapture';
import { optimizeImageBlob, optimizeImageFile } from './services/imageProcessing';
import { blobToDataUri } from './services/imageHash';
import { getFinishMeasuringInfo, LEAN_MAX_DIMENSION, leanSize, scaleCanvasGeometry } from './utils/precisionPhoto';
import { resolveProjectImages } from './services/AssetResolver';
import { hasSameEditableContent } from './utils/historyContent';

const GUEST_PROJECT_ID_KEY = 'signagepro_guest_project_id';
// Large Storage-backed projects (dense sign contours plus site captures) can
// take substantially longer to download/decompress in iOS/Desktop WebKit.
// Falling back to Untitled too early makes a valid phone project look missing.
const AUTH_BOOT_TIMEOUT_MS = 90_000;
const AUTH_OBSERVER_BOOT_TIMEOUT_MS = 12_000;
const TABLET_SIDE_PANEL_MIN_VIEWPORT_WIDTH = 640;

const shouldUseTabletSidePanel = (environment: DeviceModeEnvironment): boolean =>
  (environment.coarsePointer || environment.mobileUserAgent)
  && !isPhoneSizedTouchDevice(environment)
  && environment.viewportWidth >= TABLET_SIDE_PANEL_MIN_VIEWPORT_WIDTH;

const withTimeout = <T,>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    promise.then(
      value => { window.clearTimeout(timer); resolve(value); },
      error => { window.clearTimeout(timer); reject(error); },
    );
  });
const DEFAULT_AVATAR = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' rx='16' fill='%23374151'/%3E%3Ccircle cx='16' cy='12' r='5' fill='%239ca3af'/%3E%3Cpath d='M7 29c1-7 5-10 9-10s8 3 9 10' fill='%239ca3af'/%3E%3C/svg%3E";

// SVG sign face: deep-blue fascia with white channel letters
const DEFAULT_FG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='260'%3E%3Crect width='800' height='260' fill='%231e3a8a'/%3E%3Crect x='8' y='8' width='784' height='244' fill='none' stroke='%2393c5fd' stroke-width='4' rx='2'/%3E%3Ctext x='400' y='138' text-anchor='middle' dominant-baseline='middle' font-family='Arial Black%2CArial%2Csans-serif' font-size='88' font-weight='900' fill='white' letter-spacing='8'%3ESIGN IMAGE%3C/text%3E%3Ctext x='400' y='216' text-anchor='middle' dominant-baseline='middle' font-family='Arial%2Csans-serif' font-size='26' fill='%2393c5fd' letter-spacing='18'%3ESIGNAGE SOLUTIONS%3C/text%3E%3C/svg%3E";

const createDefaultSign = (id: string, cx: number, cy: number, index: number): Sign => ({
  id,
  name: `Sign ${index + 1}`,
  corners: [
    { x: cx - 150, y: cy - 100 },
    { x: cx + 150, y: cy - 100 },
    { x: cx + 150, y: cy + 100 },
    { x: cx - 150, y: cy + 100 },
  ],
  signType: 'fascia_non_ill',
  extrusionEnabled: true,
  extrusionDepth: 15,
  extrusionAngle: 45,
  extrusionMode: 'backed',
  backingDepth: 5,
  opacity: 0.95,
  blendMode: 'normal',
  sideColor: '#1e3a8a',
  image: DEFAULT_FG,
});

const createDefaultCanvas = (index: number): Canvas => ({
    id: `canvas-${Date.now()}`,
    name: `View ${index + 1}`,
    backgroundImage: '',
    backgroundSize: { width: 1920, height: 1080 },
    signs: [],
    activeSignId: null,
    dimensions: [],
    activeDimensionId: null,
    sheetTitle: `ELEVATION ${index + 1}`,
    sheetNumber: `A-${100 + index + 1}`
});

const renumberDefaultCanvases = (canvases: Canvas[]): Canvas[] => canvases.map((canvas, index) => ({
    ...canvas,
    name: `View ${index + 1}`,
    sheetTitle: /^ELEVATION \d+$/.test(canvas.sheetTitle) ? `ELEVATION ${index + 1}` : canvas.sheetTitle,
    sheetNumber: /^A-\d+$/.test(canvas.sheetNumber) ? `A-${101 + index}` : canvas.sheetNumber,
}));

export type ToolMode = 'select' | 'pan' | 'draw_line' | 'draw_box' | 'annotate' | 'calibrate' | 'calibrate_plane';

const DEFAULT_FIELDS: TitleBlockField[] = [
    { id: '1', label: 'PROJECT TITLE', value: '', section: 'project' },
    { id: '2', label: 'CLIENT', value: '', section: 'project' },
    { id: '3', label: 'ADDRESS', value: '', section: 'project' },
    { id: '4', label: 'DRAWN BY', value: '', section: 'drawing' },
    { id: '5', label: 'CHECKED BY', value: '', section: 'drawing' },
    { id: '6', label: 'DATE', value: '', section: 'drawing' },
    { id: '7', label: 'SCALE', value: '', section: 'drawing' },
    { id: '8', label: 'SHEET TITLE', value: '', section: 'sheet' },
    { id: '9', label: 'SHEET NO.', value: '', section: 'sheet' },
];

const getInitialState = (): MockupState => {
    const initialCanvas = createDefaultCanvas(0);

    return {
        user: null,
        projectId: `proj_${Date.now()}`,
        projectName: 'Untitled Project',
        canvases: [initialCanvas],
        activeCanvasId: initialCanvas.id,
        isNightMode: false,
        showDimensions: true,
        unitSystem: 'metric',
        titleBlock: {
            enabled: false,
            viewMode: 'canvas',
            paperSize: 'A3',
            orientation: 'landscape',
            style: TITLE_BLOCK_TEMPLATES[0],
            logoImage: null,
            fields: DEFAULT_FIELDS,
            revisions: []
        },
        savedTemplates: [],
        notes: '',
        referenceImages: [],
        siteCaptures: [],
        lastSaved: Date.now(),
        isOnline: navigator.onLine,
        isSyncing: false
    };
};

const createCleanProjectState = (user: UserProfile | null, isOnline: boolean): MockupState => {
    const base = getInitialState();
    const canvas = createDefaultCanvas(0);
    canvas.backgroundImage = '';
    canvas.signs = [];
    canvas.activeSignId = null;
    canvas.dimensions = [];
    canvas.activeDimensionId = null;
    canvas.calibration = null;
    canvas.sheetTitle = '';
    canvas.sheetNumber = '';
    return {
        ...base,
        user,
        projectId: `proj_${Date.now()}`,
        projectName: 'Untitled Project',
        canvases: [canvas],
        activeCanvasId: canvas.id,
        titleBlock: {
            ...base.titleBlock,
            enabled: false,
            logoImage: null,
            fields: base.titleBlock.fields.map(field => ({ ...field, value: '' })),
            revisions: [],
        },
        savedTemplates: [],
        notes: '',
        referenceImages: [],
        siteCaptures: [],
        lastSaved: Date.now(),
        isOnline,
        isSyncing: false,
        cloudRevision: undefined,
    };
};

const App: React.FC = () => {
  const [state, setState] = useState<MockupState>(getInitialState);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isLoginPending, setIsLoginPending] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  
  // Track sync status beyond just boolean
  // Cloud status is only confirmed after a real cloud read or write. Starting
  // as synced made sign-in look successful until the first autosave ran.
  const [syncStatus, setSyncStatus] = useState<'synced' | 'local_only' | 'error'>('local_only');
  const [lastCloudSavedAt, setLastCloudSavedAt] = useState<number | null>(null);
  const [syncConflict, setSyncConflict] = useState(false);
  // The open project was deleted on another device; the user restores or discards it.
  const [deletedElsewhere, setDeletedElsewhere] = useState(false);
  const deletedElsewhereRef = useRef(false);
  const [needsCloudDiscovery, setNeedsCloudDiscovery] = useState(false);
  
  // History for Undo/Redo
  const [history, setHistory] = useState<MockupState[]>([state]);
  const [historyIndex, setHistoryIndex] = useState(0);
  // Ref mirrors historyIndex so addToHistory never captures a stale closure value
  const historyIndexRef = useRef(0);
  useEffect(() => { historyIndexRef.current = historyIndex; }, [historyIndex]);

  const [toolMode, setToolMode] = useState<ToolMode>('select');
  const [viewLocked, setViewLocked] = useState(false);
  const [calibrationDraft, setCalibrationDraft] = useState<CalibrationDraft | null>(null);
  const [showCalibrationReference, setShowCalibrationReference] = useState(false);
  const [isCropping, setIsCropping] = useState(false);
  const [showCleanupTool, setShowCleanupTool] = useState(false);
  const [showElementStudio, setShowElementStudio] = useState(false);
  const [showAssistant, setShowAssistant] = useState(false);
  const [showProjectManager, setShowProjectManager] = useState(false);
  const [showDriveSettings, setShowDriveSettings] = useState(false);
  // "Measure sharp, store lean": full-resolution loupe source for the active
  // view, and the Finish measuring dialog (view id + preloaded original).
  const [precisionBackground, setPrecisionBackground] = useState<string | null>(null);
  const [finishMeasuringCanvasId, setFinishMeasuringCanvasId] = useState<string | null>(null);
  const [finishOriginal, setFinishOriginal] = useState<
      { status: 'loading' } | { status: 'ready'; file: File } | { status: 'unavailable'; reason: string }
  >({ status: 'loading' });
  const [showAccountSettings, setShowAccountSettings] = useState(false);
  const [showProposal3D, setShowProposal3D] = useState(false);
  const [isPhoneCapture, setIsPhoneCapture] = useState(() => shouldUsePhoneCapture(readDeviceModeEnvironment(window)));
  const [useTabletSidePanel, setUseTabletSidePanel] = useState(() => shouldUseTabletSidePanel(readDeviceModeEnvironment(window)));
  const [driveStatus, setDriveStatus] = useState<ConnectorStatus>('disconnected');
  const [driveNeedsReconnect, setDriveNeedsReconnect] = useState(false);
  const [driveReconnectProvider, setDriveReconnectProvider] = useState<CloudProvider | null>(null);
  
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef(state);
  const syncAttemptRef = useRef(0);
  const suppressNextAutosaveRef = useRef(false);
  const authObserverCalledRef = useRef(false);
  const authAttemptInProgressRef = useRef(false);
  const authSessionRef = useRef<{ uid: string | null; epoch: number }>({ uid: null, epoch: 0 });
  const completedAuthUidRef = useRef<string | null>(null);
  const authBootstrapPromisesRef = useRef(new Map<string, { epoch: number; promise: Promise<void> }>());
  const userInteractionEpochRef = useRef(0);
  const cloudDiscoveryFallbackRef = useRef<{ uid: string; state: MockupState; interactionEpoch: number } | null>(null);
  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => {
      const markUserInteraction = () => {
          userInteractionEpochRef.current += 1;
          // Once the user begins any pointer, keyboard, form, crop, recording,
          // drawing, or calibration action, a delayed discovery response may
          // no longer replace the workspace underneath that in-flight work.
          if (cloudDiscoveryFallbackRef.current) {
              cloudDiscoveryFallbackRef.current = null;
              setNeedsCloudDiscovery(false);
          }
      };
      window.addEventListener('pointerdown', markUserInteraction, true);
      window.addEventListener('keydown', markUserInteraction, true);
      window.addEventListener('input', markUserInteraction, true);
      window.addEventListener('change', markUserInteraction, true);
      return () => {
          window.removeEventListener('pointerdown', markUserInteraction, true);
          window.removeEventListener('keydown', markUserInteraction, true);
          window.removeEventListener('input', markUserInteraction, true);
          window.removeEventListener('change', markUserInteraction, true);
      };
  }, []);
  useEffect(() => {
      document.documentElement.classList.toggle('signagepro-authenticated', !!state.user);
      return () => document.documentElement.classList.remove('signagepro-authenticated');
  }, [state.user]);
  useEffect(() => {
      const pointerMedia = window.matchMedia('(pointer: coarse)');
      const updateMode = () => {
          const environment = readDeviceModeEnvironment(window);
          setIsPhoneCapture(shouldUsePhoneCapture(environment));
          setUseTabletSidePanel(shouldUseTabletSidePanel(environment));
      };
      window.addEventListener('resize', updateMode);
      window.addEventListener('orientationchange', updateMode);
      window.addEventListener('popstate', updateMode);
      pointerMedia.addEventListener('change', updateMode);
      return () => {
          window.removeEventListener('resize', updateMode);
          window.removeEventListener('orientationchange', updateMode);
          window.removeEventListener('popstate', updateMode);
          pointerMedia.removeEventListener('change', updateMode);
      };
  }, []);

  const handleViewLockedChange = useCallback((locked: boolean) => {
      setViewLocked(locked);
      if (locked) {
          setToolMode(current => current === 'pan' ? 'select' : current);
      }
  }, []);

  // Start a fresh session: replace state AND the undo history so undo can
  // never step back into a pre-login (user: null) state
  const startSession = useCallback((state: MockupState, suppressAutosave = true) => {
      const newState = normalizeProjectState(state);
      syncAttemptRef.current += 1;
      // A debounced edit belongs to the session being replaced. Callers that
      // must keep it flush first (flushPendingAutosave); any left here was
      // intentionally discarded and must never be saved later.
      pendingAutosaveRef.current = null;
      // The deleted-elsewhere prompt belongs to the project being opened.
      const openedDeletedProject = Boolean(newState.user
          && StorageService.isProjectDeletedRemotely(newState.user.uid, newState.projectId));
      deletedElsewhereRef.current = openedDeletedProject;
      setDeletedElsewhere(openedDeletedProject);
      suppressNextAutosaveRef.current = suppressAutosave;
      stateRef.current = newState;
      setState(newState);
      setHistory([newState]);
      setHistoryIndex(0);
      historyIndexRef.current = 0;
      setViewLocked(false);
      setToolMode('select');
  }, []);

  const selectAuthUser = useCallback((uid: string | null): number => {
      const current = authSessionRef.current;
      if (current.uid !== uid) {
          authSessionRef.current = { uid, epoch: current.epoch + 1 };
          completedAuthUidRef.current = null;
      }
      return authSessionRef.current.epoch;
  }, []);

  // Firebase can deliver a successful sign-in through the popup result, a
  // legacy redirect result, and onAuthStateChanged. Run one bootstrap per user
  // and let any of those signals recover an iPad session if another is missed.
  const bootstrapFirebaseUser = useCallback((firebaseUser: FirebaseUser): Promise<void> => {
      const uid = firebaseUser.uid;
      const epoch = selectAuthUser(uid);
      if (completedAuthUidRef.current === uid && stateRef.current.user?.uid === uid) {
          return Promise.resolve();
      }

      const existing = authBootstrapPromisesRef.current.get(uid);
      if (existing?.epoch === epoch) return existing.promise;

      const isCurrentSession = () => {
          const current = authSessionRef.current;
          return current.uid === uid && current.epoch === epoch;
      };

      let promise!: Promise<void>;
      promise = Promise.resolve().then(async () => {
          setIsLoginPending(false);
          setIsAuthLoading(true);
          try {
              let isAdmin = false;
              try {
                  const token = await withTimeout(getIdTokenResult(firebaseUser), 8_000, 'Authentication token');
                  isAdmin = token.claims.admin === true;
              } catch (error) {
                  reportWarning('auth-bootstrap', 'Could not load token claims; continuing as a standard user', { error: String(error) });
              }

              if (!isCurrentSession()) return;
              const user = {
                  uid,
                  displayName: firebaseUser.displayName,
                  email: firebaseUser.email,
                  photoURL: firebaseUser.photoURL,
                  isAdmin,
              };
              setConnectorUid(uid);
              setDriveStatus(getActiveConnector() ? 'connected' : 'disconnected');

              // A queued phone edit is already the newest durable copy. Do not
              // start its upload while the fresh iPhone WebKit auth channel is
              // still initializing: timing that upload out cannot cancel the
              // Firebase request, and a second retry would then wait behind it.
              // The merged local/cloud load below always keeps a queued local
              // copy, and the post-bootstrap retry effect uploads it exactly
              // once after the editor session and auth channel are stable.

              // Always load local metadata first. Cloud listing is best-effort:
              // a slow Firebase channel must not hide or replace a saved phone
              // project during sign-in.
              const localProjectCandidates = await withTimeout(
                  StorageService.listProjectsLocal(),
                  8_000,
                  'Local project list',
              );
              const localOwnership = await Promise.all(localProjectCandidates.map(async project => {
                  const localState = await StorageService.loadProjectLocal(project.id);
                  const ownerUid = localState?.user?.uid;
                  return !ownerUid || ownerUid.startsWith('guest_') || ownerUid === uid;
              }));
              const localProjects = localProjectCandidates.filter((_, index) => localOwnership[index]);
              let cloudProjects: typeof localProjects = [];
              let cloudBootstrapUnconfirmed = false;
              try {
                  cloudProjects = await withTimeout(
                      StorageService.listProjectsCloud(uid, true),
                      10_000,
                      'Cloud project list',
                  );
              } catch (error) {
                  cloudBootstrapUnconfirmed = true;
                  reportWarning('auth-bootstrap', 'Cloud project list is not ready; opening the newest phone copy', {
                      error: String(error),
                  });
              }
              const projectsById = new Map(localProjects.map(project => [project.id, project]));
              for (const project of cloudProjects) {
                  const local = projectsById.get(project.id);
                  if (!local || project.lastModified > local.lastModified) projectsById.set(project.id, project);
              }
              const projects = [...projectsById.values()];
              if (!isCurrentSession()) return;
              if (projects.length > 0) {
                  const latest = projects.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))[0];
                  const latestHasCloudMetadata = cloudProjects.some(project => project.id === latest.id);
                  let loaded: MockupState | null = null;
                  try {
                      loaded = await withTimeout(
                          StorageService.loadProject(uid, latest.id, ({ needsReconnect, failedRefs }) => {
                              if (!isCurrentSession() || !needsReconnect) return;
                              setDriveNeedsReconnect(true);
                              setDriveReconnectProvider(failedRefs[0] ? getConnectorForRef(failedRefs[0])?.id ?? null : null);
                              setDriveStatus('expired');
                          }, true),
                          AUTH_BOOT_TIMEOUT_MS,
                          'Cloud project load',
                      );
                  } catch (error) {
                      cloudBootstrapUnconfirmed = true;
                      reportWarning('auth-bootstrap', 'Cloud project data is not ready; opening the saved device copy', {
                          projectId: latest.id,
                          error: String(error),
                      });
                      loaded = localProjects.some(project => project.id === latest.id)
                          ? await StorageService.loadProjectLocal(latest.id)
                          : null;
                  }
                  if (!loaded && latestHasCloudMetadata) cloudBootstrapUnconfirmed = true;
                  if (!isCurrentSession()) return;
                  if (loaded) {
                      const cloudMetadata = cloudProjects.find(project => project.id === loaded.projectId);
                      let hasPendingSync = await StorageService.hasQueuedProjectSync(uid, loaded.projectId);
                      const cloudCopyConfirmed = !cloudBootstrapUnconfirmed && Boolean(
                          cloudMetadata
                          && (loaded.cloudRevision ?? 0) > 0
                          && cloudMetadata.lastModified >= loaded.lastSaved,
                      );
                      if (!cloudCopyConfirmed && !hasPendingSync && (loaded.cloudRevision ?? 0) === 0) {
                          await StorageService.queueProjectSync(uid, loaded.projectId);
                          hasPendingSync = true;
                      }
                      const sessionState = { ...loaded, user, isOnline: navigator.onLine, isSyncing: false };
                      if (loaded.user?.uid !== uid) {
                          await StorageService.saveProjectLocal(sessionState).catch(error => {
                              reportWarning('auth-bootstrap', 'The adopted phone project could not be recached locally', {
                                  projectId: loaded.projectId,
                                  error: String(error),
                              });
                          });
                          if (localStorage.getItem(GUEST_PROJECT_ID_KEY) === loaded.projectId) {
                              localStorage.removeItem(GUEST_PROJECT_ID_KEY);
                          }
                      }
                      startSession(sessionState);
                      if (cloudBootstrapUnconfirmed) {
                          cloudDiscoveryFallbackRef.current = {
                              uid,
                              state: stateRef.current,
                              interactionEpoch: userInteractionEpochRef.current,
                          };
                          setNeedsCloudDiscovery(true);
                      } else {
                          cloudDiscoveryFallbackRef.current = null;
                          setNeedsCloudDiscovery(false);
                      }
                      const cloudSynced = cloudCopyConfirmed && !hasPendingSync;
                      setSyncStatus(cloudSynced ? 'synced' : 'local_only');
                      setLastCloudSavedAt(cloudSynced ? Date.now() : null);
                      completedAuthUidRef.current = uid;
                      return;
                  }
              }

              startSession({ ...getInitialState(), user, isOnline: navigator.onLine });
              if (cloudBootstrapUnconfirmed) {
                  cloudDiscoveryFallbackRef.current = {
                      uid,
                      state: stateRef.current,
                      interactionEpoch: userInteractionEpochRef.current,
                  };
                  setNeedsCloudDiscovery(true);
              } else {
                  cloudDiscoveryFallbackRef.current = null;
                  setNeedsCloudDiscovery(false);
              }
              setSyncStatus('local_only');
              setLastCloudSavedAt(null);
              completedAuthUidRef.current = uid;
          } catch (error) {
              reportError('auth-bootstrap', error, { uid });
              if (!isCurrentSession()) return;
              const user = {
                  uid,
                  displayName: firebaseUser.displayName,
                  email: firebaseUser.email,
                  photoURL: firebaseUser.photoURL,
                  isAdmin: false,
              };
              startSession({ ...getInitialState(), user, isOnline: navigator.onLine, isSyncing: false });
              completedAuthUidRef.current = uid;
              setSyncStatus('error');
              notify('Signed in. Cloud projects are taking too long to load; you can continue working and retry sync.', 'warning');
          } finally {
              const entry = authBootstrapPromisesRef.current.get(uid);
              if (entry?.promise === promise) authBootstrapPromisesRef.current.delete(uid);
              if (isCurrentSession()) {
                  authAttemptInProgressRef.current = false;
                  setIsAuthLoading(false);
              }
          }
      });

      authBootstrapPromisesRef.current.set(uid, { epoch, promise });
      return promise;
  }, [selectAuthUser, startSession]);

  const handleGuestLogin = useCallback(async () => {
      authAttemptInProgressRef.current = false;
      setIsLoginPending(false);
      const guestId = 'guest_' + Date.now();
      const guestUser = {
          uid: guestId,
          displayName: 'Guest User',
          email: null,
          photoURL: null
      };

      // Resume the same local project across guest sessions instead of minting a
      // fresh projectId every login — otherwise autosave quietly accumulates a new
      // "Sign Image Demo" copy in IndexedDB every time Guest is clicked.
      const existingProjectId = localStorage.getItem(GUEST_PROJECT_ID_KEY);
      const existingProjectCandidate = existingProjectId ? await StorageService.loadProjectLocal(existingProjectId) : null;
      const existingOwnerUid = existingProjectCandidate?.user?.uid;
      const existingProject = !existingOwnerUid || existingOwnerUid.startsWith('guest_')
          ? existingProjectCandidate
          : null;
      if (existingProjectId && !existingProject) localStorage.removeItem(GUEST_PROJECT_ID_KEY);

      const newState: MockupState = existingProject
        ? { ...existingProject, user: guestUser, isOnline: false }
        : { ...getInitialState(), user: guestUser, isOnline: false };

      localStorage.setItem(GUEST_PROJECT_ID_KEY, newState.projectId);
      // Session loads are intentionally read-only, but a brand-new guest
      // workspace still needs an immediate durable record so reload can resume
      // the same project even before the first edit.
      await StorageService.saveProjectLocal(newState);

      startSession(newState);
      setIsAuthLoading(false);
  }, [startSession]);

  // Complete redirects created by older app versions. Missing redirect state is
  // recoverable: Safari may partition or clear the temporary session storage.
  useEffect(() => {
    getRedirectResult(auth).then(result => {
      if (!result?.user) return;
      authAttemptInProgressRef.current = true;
      return bootstrapFirebaseUser(result.user);
    }).catch((err: any) => {
      const authIsAlreadyRecovering = authAttemptInProgressRef.current
        || !!auth.currentUser
        || authBootstrapPromisesRef.current.size > 0;
      if (authIsAlreadyRecovering) {
        reportWarning('auth-redirect', 'Ignored a stale redirect result while an authenticated session was loading', { error: String(err) });
        return;
      }
      authAttemptInProgressRef.current = false;
      setIsLoginPending(false);
      if (isAuthCancellationError(err)) {
        notify('Google sign-in was cancelled. Tap Sign in with Google again and choose Continue.', 'info');
        setIsAuthLoading(false);
        return;
      }
      if (isMissingRedirectStateError(err)) {
        reportWarning('auth-redirect', 'Discarded stale redirect result because browser state was unavailable');
        setIsAuthLoading(false);
        return;
      }
      setAuthError(err?.message ?? 'Sign-in failed after returning from Google.');
      setIsAuthLoading(false);
    });
  }, [bootstrapFirebaseUser]);

  // --- Auth & Data Loading ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      authObserverCalledRef.current = true;
      if (firebaseUser) {
        void bootstrapFirebaseUser(firebaseUser);
        return;
      }

      // Ignore a stale null callback if Firebase already exposes a signed-in
      // user through a popup or redirect result.
      if (auth.currentUser) {
        void bootstrapFirebaseUser(auth.currentUser);
        return;
      }

      // A late initial signed-out callback must not erase a guest session the
      // user deliberately entered after Safari's observer fallback appeared.
      if (stateRef.current.user?.uid.startsWith('guest_')) {
        authAttemptInProgressRef.current = false;
        setIsLoginPending(false);
        setIsAuthLoading(false);
        return;
      }

      selectAuthUser(null);
      setConnectorUid(null);
      const initialState = getInitialState();
      stateRef.current = initialState;
      setState(initialState);
      if (authBootstrapPromisesRef.current.size > 0) {
        authAttemptInProgressRef.current = false;
        setIsAuthLoading(false);
      } else if (!authAttemptInProgressRef.current) {
        setIsAuthLoading(false);
      }
    });
    return unsubscribe;
  }, [bootstrapFirebaseUser, selectAuthUser]);

  // If Safari never delivers the initial observer callback, reveal a usable
  // login screen without inventing an error or creating an authenticated blank
  // project. A current Firebase user is bootstrapped directly instead.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (authObserverCalledRef.current || authAttemptInProgressRef.current || authBootstrapPromisesRef.current.size > 0) return;
      if (auth.currentUser) {
        void bootstrapFirebaseUser(auth.currentUser);
        return;
      }
      setIsAuthLoading(false);
    }, AUTH_OBSERVER_BOOT_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [bootstrapFirebaseUser]);

  // After the user reconnects their drive, give the unresolved drive refs still
  // held in the editor another chance to materialize. Resolve them in place —
  // reloading the cloud copy here used to replace the editor and discard any
  // edits made (and queued) while the drive was disconnected.
  const handleDriveReconnect = async () => {
    const connector = connectors.find(c => c.id === (driveReconnectProvider ?? getPreferredProvider()));
    if (!connector) return;
    try {
      await connector.connect(); // user gesture — popup/redirect allowed
      setDriveStatus('connected');
      setDriveNeedsReconnect(false);
      setDriveReconnectProvider(null);
      const current = stateRef.current;
      if (current.user && !current.user.uid.startsWith('guest_')) {
        const { state: resolved, failedRefs } = await resolveProjectImages(current);
        // Only apply if nothing changed while images were fetched; otherwise
        // the edits win and the refs resolve on the next project open.
        if (stateRef.current === current) {
          updateState({
            canvases: resolved.canvases,
            titleBlock: resolved.titleBlock,
            referenceImages: resolved.referenceImages,
          });
        }
        if (failedRefs.length > 0) {
          notify(`${failedRefs.length} image${failedRefs.length === 1 ? '' : 's'} could not be loaded from ${connector.label}.`, 'warning');
        }
      }
    } catch (e) {
      reportError('drive-refresh', e, { provider: connector.id });
      notify(`Could not reconnect ${connector.label}. Please try again.`, 'error');
    }
  };

  const handleLogin = async () => {
    setAuthError(null);
    authAttemptInProgressRef.current = true;
    setIsLoginPending(true);
    try {
      if (prefersRedirectSignIn(window)) {
        await signInWithRedirect(auth, googleProvider);
        return;
      }
      const credential = await signInWithPopup(auth, googleProvider);
      await bootstrapFirebaseUser(credential.user);
    } catch (err: any) {
      authAttemptInProgressRef.current = false;
      setIsLoginPending(false);
      setIsAuthLoading(false);
      const code = err?.code ?? '';
      if (isAuthCancellationError(err)) {
        notify('Google sign-in was cancelled. Tap Sign in with Google again and choose Continue.', 'info');
        return;
      }
      if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
        setAuthError('Google sign-in was blocked. Allow pop-ups for this site, then tap Sign in with Google again.');
      } else {
        setAuthError(err?.message ?? 'Sign-in failed. Please try again.');
      }
    }
  };

  const handleLogout = async () => {
    // Persist the last few seconds of edits while still signed in. The local
    // write lands almost immediately; cap the wait so a slow cloud upload
    // can't hold sign-out hostage (an unfinished upload re-queues on next
    // sign-in because the local copy is then newer than the cloud one).
    await Promise.race([
      flushPendingAutosave(),
      new Promise(resolve => setTimeout(resolve, 10_000)),
    ]);
    authAttemptInProgressRef.current = false;
    setIsLoginPending(false);
    selectAuthUser(null);
    await signOut(auth);
    if (localStorage.getItem(GUEST_PROJECT_ID_KEY) === stateRef.current.projectId
        && stateRef.current.user?.uid && !stateRef.current.user.uid.startsWith('guest_')) {
      localStorage.removeItem(GUEST_PROJECT_ID_KEY);
    }
    const initialState = getInitialState();
    stateRef.current = initialState;
    setState(initialState);
  };

  const updateState = useCallback((updates: Partial<MockupState>) => {
    setState(prev => {
      const next = { ...prev, ...updates };
      stateRef.current = next;
      return next;
    });
  }, []);

  // --- Connectivity & Persistence Logic ---

  // Trigger Sync
  const triggerBackendSync = useCallback((currentState: MockupState, silentQueuedNotice = false) => {
      if (!currentState.user) return Promise.resolve<'error'>('error');

      const syncAttempt = ++syncAttemptRef.current;
      updateState({ isSyncing: true });
      
      return StorageService.saveProject(currentState.user.uid, currentState).then(async (result) => {
          // A save started for the previous project may finish after the user
          // opens another one. Never let that stale result change the active
          // project's spinner, timestamp, or Cloud saved status.
          const active = stateRef.current;
          if (syncAttempt !== syncAttemptRef.current
              || active.projectId !== currentState.projectId
              || active.user?.uid !== currentState.user?.uid) {
              return result;
          }
          let persistedCloudState: MockupState | null = null;
          if (result === 'cloud') {
              persistedCloudState = await StorageService.loadProjectLocal(currentState.projectId);
              const latest = stateRef.current;
              if (syncAttempt !== syncAttemptRef.current
                  || latest.projectId !== currentState.projectId
                  || latest.user?.uid !== currentState.user?.uid) {
                  return result;
              }
          }
          updateState({
              isSyncing: false,
              lastSaved: persistedCloudState?.lastSaved ?? Date.now(),
              ...(persistedCloudState?.cloudRevision !== undefined
                  ? { cloudRevision: persistedCloudState.cloudRevision }
                  : {}),
          });
          
          if (result === 'local') {
              setSyncStatus('local_only');
          } else if (result === 'queued') {
              setSyncStatus('local_only');
              if (!silentQueuedNotice) {
                  notify('Saved on this device. Cloud sync will retry automatically.', 'info');
              }
          } else if (result === 'conflict') {
              setSyncStatus('error');
              setSyncConflict(true);
              notify('This project changed on another device. Choose which copy to keep.', 'warning');
          } else if (result === 'deleted') {
              setSyncStatus('local_only');
              setLastCloudSavedAt(null);
              // Notify once; autosave keeps returning 'deleted' until the user decides.
              if (!deletedElsewhereRef.current) {
                  notify('This project was deleted on another device. Restore it, or discard this copy.', 'warning');
              }
              deletedElsewhereRef.current = true;
              setDeletedElsewhere(true);
          } else if (result === 'cloud') {
              setSyncStatus('synced');
              setLastCloudSavedAt(Date.now());
          } else {
              setSyncStatus('error');
              reportWarning('sync', 'Project save returned an error', { projectId: currentState.projectId });
          }
          return result;
      }).catch(error => {
          const active = stateRef.current;
          if (syncAttempt !== syncAttemptRef.current
              || active.projectId !== currentState.projectId
              || active.user?.uid !== currentState.user?.uid) {
              reportError('sync-stale', error, { projectId: currentState.projectId });
              return 'error' as const;
          }
          updateState({ isSyncing: false });
          setSyncStatus('error');
          reportError('sync', error, { projectId: currentState.projectId });
          return 'error' as const;
      });
  }, [updateState]);

  const keepLocalConflictCopy = async () => {
      if (!state.user) return;
      const result = await StorageService.saveProject(state.user.uid, state, false, true);
      if (result === 'cloud') {
          setSyncConflict(false); setSyncStatus('synced'); setLastCloudSavedAt(Date.now());
          notify('This device copy replaced the cloud version.', 'success');
      }
  };

  const loadCloudConflictCopy = async () => {
      if (!state.user) return;
      // The user chose the cloud copy; the local pending edit is discarded.
      discardPendingAutosave();
      const remote = await StorageService.loadProjectCloud(state.user.uid, state.projectId, undefined, true);
      if (remote) {
          await StorageService.saveProjectLocal(remote);
          await StorageService.discardQueuedProjectSync(state.user.uid, state.projectId);
          StorageService.adoptCloudRevision(state.user.uid, state.projectId, remote.cloudRevision ?? 0);
          startSession({ ...remote, user: state.user, isOnline: navigator.onLine, isSyncing: false });
          setSyncConflict(false); setSyncStatus('synced');
          notify('Loaded the newer cloud version.', 'success');
      }
  };

  // --- Deleted on another device: restore or discard ---
  const restoreDeletedProject = async () => {
      const current = stateRef.current;
      if (!current.user) return;
      const result = await StorageService.restoreDeletedProject(current.user.uid, current);
      if (result === 'cloud') {
          deletedElsewhereRef.current = false;
          setDeletedElsewhere(false);
          setSyncConflict(false);
          setSyncStatus('synced');
          setLastCloudSavedAt(Date.now());
          const persisted = await StorageService.loadProjectLocal(current.projectId);
          if (persisted?.cloudRevision !== undefined) updateState({ cloudRevision: persisted.cloudRevision });
          notify('Project restored to the cloud.', 'success');
      } else {
          notify(result === 'queued'
              ? 'You are offline. Restore will be available once you are back online.'
              : 'The project could not be restored right now. Please try again.', 'error');
      }
  };

  const discardDeletedProject = async () => {
      const current = stateRef.current;
      if (!current.user) return;
      discardPendingAutosave();
      await StorageService.discardDeletedProject(current.user.uid, current.projectId);
      const cleanState = createCleanProjectState(current.user, current.isOnline);
      if (current.user.uid.startsWith('guest_')) localStorage.setItem(GUEST_PROJECT_ID_KEY, cleanState.projectId);
      startSession(cleanState);
      await StorageService.saveProjectLocal(cleanState);
      setSyncStatus('local_only');
      setLastCloudSavedAt(null);
      notify('Discarded this copy. A new project has been started.', 'info');
      void triggerBackendSync(cleanState);
  };

  const retryPendingCloudSync = useCallback(async (uid: string) => {
      const initial = stateRef.current;
      if (initial.user?.uid !== uid || !initial.isOnline) return;
      const projectId = initial.projectId;
      const hadAnyQueuedChanges = await StorageService.hasQueuedProjectSync(uid);
      const hadQueuedChanges = await StorageService.hasQueuedProjectSync(uid, projectId);
      if (hadAnyQueuedChanges) await StorageService.flushSyncQueue(uid);

      const active = stateRef.current;
      if (active.user?.uid !== uid || active.projectId !== projectId || !active.isOnline) return;
      // Queue flushing is account-wide so a phone edit to Project A is not
      // stranded merely because Project B is the active tablet workspace.
      // Only the active project needs UI/revision reconciliation below.
      if (hadAnyQueuedChanges && !hadQueuedChanges) return;
      if (StorageService.isProjectDeletedRemotely(uid, projectId)) {
          deletedElsewhereRef.current = true;
          setDeletedElsewhere(true);
          setSyncStatus('local_only');
          return;
      }
      if (await StorageService.hasQueuedProjectSync(uid, projectId)) {
          if (StorageService.hasProjectSyncConflict(uid, projectId)) {
              setSyncConflict(true);
              setSyncStatus('error');
          }
          return;
      }

      if (hadQueuedChanges) {
          const persisted = await StorageService.loadProjectLocal(projectId);
          if (!persisted || (persisted.cloudRevision ?? 0) === 0) return;
          const liveStateChangedDuringRetry = active !== initial;
          const rebasedActive = {
              ...active,
              isSyncing: false,
              cloudRevision: persisted.cloudRevision,
              lastSaved: liveStateChangedDuringRetry
                  ? Math.max(active.lastSaved, persisted.lastSaved)
                  : persisted.lastSaved,
          };
          updateState({
              isSyncing: false,
              cloudRevision: rebasedActive.cloudRevision,
              lastSaved: rebasedActive.lastSaved,
          });
          if (liveStateChangedDuringRetry) {
              setSyncStatus('local_only');
              setLastCloudSavedAt(null);
              await triggerBackendSync(rebasedActive, true);
              return;
          }
          setSyncConflict(false);
          setSyncStatus('synced');
          setLastCloudSavedAt(Date.now());
          return;
      }

      // A clean cloud-backed project opened from cache has nothing to upload.
      // Confirm its revision with a read so reconnect cannot turn that read into
      // a stale write merely to restore the Cloud saved indicator.
      const localRevision = active.cloudRevision ?? 0;
      if (localRevision === 0) return;
      const remote = await StorageService.loadProjectCloud(uid, projectId, undefined, true);
      const latest = stateRef.current;
      if (!remote || latest.user?.uid !== uid || latest.projectId !== projectId) return;
      const remoteRevision = remote.cloudRevision ?? 0;
      if (remoteRevision > localRevision) {
          setSyncConflict(true);
          setSyncStatus('error');
          return;
      }
      if (remoteRevision === localRevision) {
          setSyncConflict(false);
          setSyncStatus('synced');
          setLastCloudSavedAt(Date.now());
      }
  }, [triggerBackendSync, updateState]);

  // A clean device can occasionally finish authentication before Safari's
  // Firestore channel returns its first project list. Keep retrying discovery
  // while the temporary local workspace is still completely untouched. The
  // identity check is intentionally strict: any editor update cancels the
  // replacement so a delayed cloud response can never erase new work.
  useEffect(() => {
      const fallback = cloudDiscoveryFallbackRef.current;
      const uid = state.user?.uid;
      const fallbackIsUntouched = (current: MockupState) => fallback?.interactionEpoch === userInteractionEpochRef.current
          && current.projectId === fallback.state.projectId
          && current.projectName === fallback.state.projectName
          && current.canvases === fallback.state.canvases
          && current.activeCanvasId === fallback.state.activeCanvasId
          && current.isNightMode === fallback.state.isNightMode
          && current.showDimensions === fallback.state.showDimensions
          && current.unitSystem === fallback.state.unitSystem
          && current.titleBlock === fallback.state.titleBlock
          && current.buildingModel === fallback.state.buildingModel
          && current.savedTemplates === fallback.state.savedTemplates
          && current.notes === fallback.state.notes
          && current.referenceImages === fallback.state.referenceImages
          && current.siteCaptures === fallback.state.siteCaptures;
      if (!needsCloudDiscovery || isAuthLoading || !uid || uid.startsWith('guest_')
          || fallback?.uid !== uid || !fallbackIsUntouched(stateRef.current)) return;

      let cancelled = false;
      let running = false;
      const discover = async () => {
          if (running || cancelled) return;
          if (!fallbackIsUntouched(stateRef.current)) {
              cloudDiscoveryFallbackRef.current = null;
              setNeedsCloudDiscovery(false);
              return;
          }
          running = true;
          try {
              // Do not wrap these Firebase reads in Promise.race timeouts. A
              // timed-out Firestore promise keeps running and repeated retries
              // would accumulate orphaned requests on iOS. `running` keeps one
              // discovery attempt in flight; rejected attempts retry on the
              // 30-second backoff below.
              const projects = await StorageService.listProjectsCloud(uid, true);
              if (cancelled || !fallbackIsUntouched(stateRef.current)) return;
              if (projects.length === 0) {
                  // A successful server response with no projects is
                  // authoritative, not a transient failure.
                  cloudDiscoveryFallbackRef.current = null;
                  setNeedsCloudDiscovery(false);
                  return;
              }
              const latest = [...projects].sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))[0];
              const loaded = await StorageService.loadProject(uid, latest.id, undefined, true);
              if (!loaded) throw new Error(`Cloud project ${latest.id} could not be loaded.`);
              if (cancelled || !fallbackIsUntouched(stateRef.current)) return;
              const currentUser = stateRef.current.user;
              if (!currentUser?.uid || currentUser.uid !== uid) return;
              const hasPendingSync = await StorageService.hasQueuedProjectSync(uid, loaded.projectId);
              if (cancelled || !fallbackIsUntouched(stateRef.current)) return;
              startSession({ ...loaded, user: currentUser, isOnline: navigator.onLine, isSyncing: false });
              cloudDiscoveryFallbackRef.current = null;
              setNeedsCloudDiscovery(false);
              setSyncConflict(false);
              const cloudSynced = (loaded.cloudRevision ?? 0) > 0 && !hasPendingSync;
              setSyncStatus(cloudSynced ? 'synced' : 'local_only');
              setLastCloudSavedAt(cloudSynced ? Date.now() : null);
          } catch (error) {
              reportWarning('cloud-discovery', 'Cloud projects are still unavailable; another retry is scheduled', {
                  uid,
                  error: String(error),
              });
          } finally {
              running = false;
          }
      };

      void discover();
      const interval = window.setInterval(() => void discover(), 30_000);
      return () => {
          cancelled = true;
          window.clearInterval(interval);
      };
  }, [isAuthLoading, needsCloudDiscovery, startSession, state.user?.uid]);

  // Online/Offline Listeners
  useEffect(() => {
      const handleOnline = () => {
          updateState({ isOnline: true });
          if (stateRef.current.user && !stateRef.current.user.uid.startsWith('guest_')) {
             void retryPendingCloudSync(stateRef.current.user.uid)
                 .catch(error => reportWarning('sync-retry', 'Online cloud sync retry failed', { error: String(error) }));
          }
      };
      const handleOffline = () => updateState({ isOnline: false });

      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);

      return () => {
          window.removeEventListener('online', handleOnline);
          window.removeEventListener('offline', handleOffline);
      };
  }, [retryPendingCloudSync, updateState]);

  // Auto-save debounce
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The edit waiting out the debounce. The local IndexedDB write happens only
  // inside the save, so a pending edit that is merely cancelled (project
  // switch, new project, sign-out, iOS killing a backgrounded tab) is lost
  // everywhere. Those paths flush it instead.
  const pendingAutosaveRef = useRef<MockupState | null>(null);
  useEffect(() => {
      if (suppressNextAutosaveRef.current) {
          suppressNextAutosaveRef.current = false;
          return;
      }
      if (state.user) {
          if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
          pendingAutosaveRef.current = state;
          syncTimeoutRef.current = setTimeout(() => {
              pendingAutosaveRef.current = null;
              triggerBackendSync(state);
          }, 3000); // 3s debounce
      }
      return () => {
          if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
      };
  }, [state.canvases, state.titleBlock, state.notes, state.referenceImages, state.siteCaptures, triggerBackendSync, state.user, state.projectName]);

  /** Save the debounced edit now (if any). Call before leaving a session. */
  const flushPendingAutosave = useCallback((): Promise<unknown> => {
      const pending = pendingAutosaveRef.current;
      pendingAutosaveRef.current = null;
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
      return pending ? triggerBackendSync(pending) : Promise.resolve();
  }, [triggerBackendSync]);

  /** Drop the debounced edit without saving (the user discarded it). */
  const discardPendingAutosave = useCallback(() => {
      pendingAutosaveRef.current = null;
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
  }, []);

  // iOS can kill a backgrounded tab without further events; persist promptly.
  useEffect(() => {
      const flushWhenHidden = () => {
          if (document.visibilityState === 'hidden') void flushPendingAutosave();
      };
      const flushOnPageHide = () => { void flushPendingAutosave(); };
      document.addEventListener('visibilitychange', flushWhenHidden);
      window.addEventListener('pagehide', flushOnPageHide);
      return () => {
          document.removeEventListener('visibilitychange', flushWhenHidden);
          window.removeEventListener('pagehide', flushOnPageHide);
      };
  }, [flushPendingAutosave]);

  // `navigator.onLine` only reports network attachment, not whether Firebase
  // was temporarily reachable. Check the entire user's durable queue after
  // bootstrap even when the active project is already cloud-saved; otherwise
  // an edit queued for a different phone project could remain device-only.
  useEffect(() => {
      const uid = state.user?.uid;
      if (isAuthLoading || !state.isOnline || !uid || uid.startsWith('guest_')) return;
      let running = false;
      const retry = async () => {
          if (running) return;
          running = true;
          try {
              const hasQueuedChanges = await StorageService.hasQueuedProjectSync(uid);
              if (syncStatus !== 'local_only' && !hasQueuedChanges) return;
              await retryPendingCloudSync(uid);
          } catch (error) {
              reportWarning('sync-retry', 'Queued cloud sync retry failed', { error: String(error) });
          } finally {
              running = false;
          }
      };
      // Let the authenticated Firebase channel settle, then drain promptly.
      const initialRetry = window.setTimeout(() => void retry(), 1_000);
      const retryInterval = window.setInterval(() => void retry(), 30_000);
      return () => {
          window.clearTimeout(initialRetry);
          window.clearInterval(retryInterval);
      };
  }, [isAuthLoading, state.isOnline, state.user?.uid, syncStatus, retryPendingCloudSync]);


  const activeCanvas = state.canvases.find(c => c.id === state.activeCanvasId) || state.canvases[0];

  // Untracked edits (see recordUntrackedEdits) are undoable too, and they make
  // any redo branch stale.
  const hasUntrackedEdits = !!history[historyIndex] && !hasSameEditableContent(state, history[historyIndex]);
  const canUndo = historyIndex > 0 || hasUntrackedEdits;
  const canRedo = historyIndex < history.length - 1 && !hasUntrackedEdits;

  // --- Cloud site photos that could not be downloaded to this device ---
  // A project opens even when some photos can't be fetched; they show as
  // unavailable and are retried in the background until they arrive.
  const [unavailablePhotoCount, setUnavailablePhotoCount] = useState(0);
  const unavailablePhotoCountRef = useRef(0);
  const setUnavailablePhotos = useCallback((count: number) => {
      unavailablePhotoCountRef.current = count;
      setUnavailablePhotoCount(count);
  }, []);
  const retryUnavailablePhotos = useCallback(async (announce = false) => {
      const project = stateRef.current;
      if (!project.user || project.user.uid.startsWith('guest_')) return;
      const stillMissing = await StorageService.cacheCapturePhotos(project).catch(() => null);
      if (stillMissing === null || stateRef.current.projectId !== project.projectId) return;
      const previous = unavailablePhotoCountRef.current;
      setUnavailablePhotos(stillMissing.length);
      if (previous > 0 && stillMissing.length === 0) notify('All site photos are now available on this device.', 'success');
      else if (announce && stillMissing.length > 0) notify('Some site photos are still unavailable. The app will keep retrying.', 'info');
  }, [setUnavailablePhotos]);
  useEffect(() => {
      const project = stateRef.current;
      if (!project.user || project.user.uid.startsWith('guest_')) { setUnavailablePhotos(0); return; }
      let cancelled = false;
      void StorageService.findUncachedCapturePhotos(project)
          .then(missing => { if (!cancelled) setUnavailablePhotos(missing.length); })
          .catch(() => undefined);
      return () => { cancelled = true; };
  }, [state.projectId, state.siteCaptures, state.user?.uid, setUnavailablePhotos]);
  useEffect(() => {
      if (unavailablePhotoCount === 0) return;
      void retryUnavailablePhotos();
      const interval = window.setInterval(() => void retryUnavailablePhotos(), 30_000);
      const retryWhenOnline = () => void retryUnavailablePhotos();
      window.addEventListener('online', retryWhenOnline);
      return () => {
          window.clearInterval(interval);
          window.removeEventListener('online', retryWhenOnline);
      };
      // Restart the loop only when photos go from none-missing to some-missing.
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unavailablePhotoCount > 0, state.projectId, retryUnavailablePhotos]);

  // --- High-resolution measuring ("measure sharp, store lean") ---
  const finishMeasuringInfo = activeCanvas ? getFinishMeasuringInfo(activeCanvas, state.siteCaptures) : null;
  const precisionOriginalRef = finishMeasuringInfo?.kind === 'capture-original' ? finishMeasuringInfo.originalRef : null;
  const activeBackgroundWidth = activeCanvas?.backgroundSize.width ?? 0;
  const activeBackgroundHeight = activeCanvas?.backgroundSize.height ?? 0;

  // A promoted site photo is edited on its 4096 px working copy; the loupe
  // shows its full-resolution original instead. Uploaded backgrounds need
  // nothing extra — they are already full resolution on the uploading device.
  useEffect(() => {
      setPrecisionBackground(null);
      if (!precisionOriginalRef || !activeBackgroundWidth || !activeBackgroundHeight) return;
      let cancelled = false;
      let objectUrl: string | null = null;
      const expectedRatio = activeBackgroundWidth / activeBackgroundHeight;
      void (async () => {
          const blob = await getAssetBlob(precisionOriginalRef).catch(() => null);
          if (!blob || cancelled) return;
          objectUrl = URL.createObjectURL(blob);
          const image = new Image();
          image.onload = () => {
              if (cancelled || !objectUrl) return;
              // Use it only with identical framing, or loupe points would drift.
              const ratio = image.naturalWidth / image.naturalHeight;
              if (Math.abs(ratio - expectedRatio) / expectedRatio < 0.01) setPrecisionBackground(objectUrl);
          };
          image.src = objectUrl;
      })();
      return () => {
          cancelled = true;
          if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
  }, [precisionOriginalRef, activeBackgroundWidth, activeBackgroundHeight]);

  const openFinishMeasuring = () => {
      if (!activeCanvas || !finishMeasuringInfo) return;
      const canvasId = activeCanvas.id;
      const info = finishMeasuringInfo;
      const backgroundRef = activeCanvas.backgroundImage;
      setFinishMeasuringCanvasId(canvasId);
      setFinishOriginal({ status: 'loading' });
      // Preload so "Save original" runs inside the tap (iOS share-sheet rule).
      void (async () => {
          // An uploaded background is full resolution only on the uploading
          // device; elsewhere the project holds just the lean cloud copy.
          const sourceRef = info.kind === 'capture-original' ? info.originalRef
              : backgroundRef.startsWith('data:') ? backgroundRef : null;
          const blob = sourceRef ? await getAssetBlob(sourceRef).catch(() => null) : null;
          const reason = info.kind === 'oversized-background'
              ? 'The full-resolution original is only on the device that uploaded this photo.'
              : 'The original could not be loaded on this device right now.';
          if (!blob) { setFinishOriginal({ status: 'unavailable', reason }); return; }
          const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' } as Record<string, string>)[blob.type] ?? 'jpg';
          const safe = (text: string) => text.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'photo';
          const name = info.kind === 'capture-original' && info.capture.fileName
              ? info.capture.fileName
              : `${safe(stateRef.current.projectName)}-${safe(activeCanvas.name)}-original.${extension}`;
          setFinishOriginal({ status: 'ready', file: new File([blob], name, { type: blob.type || 'image/jpeg' }) });
      })();
  };

  const loadImageSize = (src: string) => new Promise<{ width: number; height: number }>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error('The photo could not be loaded.'));
      image.src = src;
  });

  const finishMeasuring = async () => {
      const current = stateRef.current;
      const canvas = current.canvases.find(c => c.id === finishMeasuringCanvasId);
      const info = canvas ? getFinishMeasuringInfo(canvas, current.siteCaptures) : null;
      if (!canvas || !info) { setFinishMeasuringCanvasId(null); return; }
      try {
          let next: MockupState;
          let releasedLocalRef: string | null = null;
          if (info.kind === 'capture-original') {
              // The view already uses the 4096 px working copy; unlinking the
              // original is all that's needed. Cloud cleanup then deletes the
              // stored original once no retained revision references it.
              next = {
                  ...current,
                  siteCaptures: (current.siteCaptures ?? []).map(capture => {
                      if (capture.id !== info.capture.id) return capture;
                      const { originalRef: _released, ...kept } = capture;
                      return kept;
                  }),
              };
              releasedLocalRef = info.originalRef;
          } else {
              // Shrink this device's full-resolution copy (other devices already
              // hold the lean cloud copy) and map every coordinate into it, so
              // all measurements keep their real-world values.
              let backgroundImage = canvas.backgroundImage;
              // Vector backgrounds are resolution-independent: keep the file and
              // only move the coordinates into the lean size.
              if (backgroundImage.startsWith('data:') && !backgroundImage.startsWith('data:image/svg+xml')) {
                  const source = await getAssetBlob(backgroundImage);
                  if (!source) throw new Error('The full-resolution photo is missing.');
                  backgroundImage = await blobToDataUri(await optimizeImageBlob(source, LEAN_MAX_DIMENSION));
              }
              const natural = await loadImageSize(backgroundImage);
              // Never rescale into something larger than the lean size.
              const target = Math.max(natural.width, natural.height) > LEAN_MAX_DIMENSION
                  ? leanSize(natural.width, natural.height)
                  : natural;
              const scaled = {
                  ...scaleCanvasGeometry(canvas, target.width / canvas.backgroundSize.width, target.height / canvas.backgroundSize.height),
                  backgroundImage,
                  backgroundSize: target,
              };
              next = { ...current, canvases: current.canvases.map(c => c.id === canvas.id ? scaled : c) };
          }
          // Deliberately not undoable: undo would re-link an original that is
          // about to be deleted, and a save would then fail looking for it.
          startSession({ ...next, isSyncing: false }, true);
          const result = await triggerBackendSync(stateRef.current);
          // Remove this device's copy only once the unlinked project is saved.
          if (result !== 'error' && releasedLocalRef) await deleteLocalAsset(releasedLocalRef).catch(() => undefined);
          setFinishMeasuringCanvasId(null);
          notify('Measuring finished. This view now keeps only its lighter working copy.', 'success');
      } catch (error) {
          reportError('finish-measuring', error, { canvasId: canvas.id, kind: info.kind });
          notify(error instanceof Error ? error.message : 'Measuring could not be finished. Nothing was changed.', 'error');
      }
  };

  const addToHistory = useCallback((newState: MockupState) => {
      const currentIndex = historyIndexRef.current;
      const nextIndex = Math.min(currentIndex + 1, 19);
      setHistory(prev => {
          const newHistory = prev.slice(0, currentIndex + 1);
          newHistory.push(newState);
          if (newHistory.length > 20) newHistory.shift();
          return newHistory;
      });
      historyIndexRef.current = nextIndex;
      setHistoryIndex(nextIndex);
  }, []); // stable — reads historyIndexRef.current at call time

  const addHistoryTransaction = useCallback((before: MockupState, after: MockupState) => {
      const currentIndex = historyIndexRef.current;
      const nextIndex = Math.min(currentIndex + 2, 19);
      setHistory(prev => {
          const newHistory = prev.slice(0, currentIndex + 1);
          newHistory.push(before, after);
          return newHistory.length > 20 ? newHistory.slice(-20) : newHistory;
      });
      historyIndexRef.current = nextIndex;
      setHistoryIndex(nextIndex);
  }, []);

  const signPlacementStartRef = useRef<MockupState | null>(null);
  const beginSignPlacement = useCallback(() => {
      signPlacementStartRef.current = stateRef.current;
  }, []);
  const finishSignPlacement = useCallback((changed: boolean) => {
      const before = signPlacementStartRef.current;
      signPlacementStartRef.current = null;
      if (!changed || !before || before === stateRef.current) return;
      addHistoryTransaction(before, stateRef.current);
  }, [addHistoryTransaction]);

  // Restore a history snapshot's CONTENT while keeping the live session: the
  // signed-in user (a snapshot must never log the user out) and sync
  // bookkeeping. A snapshot's stale cloudRevision/isOnline/isSyncing used to
  // come back too, causing false sync conflicts and a stuck retry loop.
  const restoreHistorySnapshot = useCallback((snapshot: MockupState) => {
      const live = stateRef.current;
      const next: MockupState = {
          ...snapshot,
          user: live.user,
          isOnline: live.isOnline,
          isSyncing: live.isSyncing,
          lastSaved: live.lastSaved,
          cloudRevision: live.cloudRevision,
      };
      stateRef.current = next;
      setState(next);
  }, []);

  // Many edits (dimension drags, property sliders, library inserts, …) update
  // state without a history entry, leaving the live state ahead of
  // history[index]. Undo must revert THOSE edits first; jumping straight to
  // history[index - 1] reverted two steps at once and the skipped edit could
  // not be recovered with redo. Record the live state, then step back to it.
  // Returns the recorded snapshot the live state diverged from, or null.
  const recordUntrackedEdits = useCallback((): MockupState | null => {
      const recorded = history[historyIndexRef.current];
      if (!recorded || hasSameEditableContent(stateRef.current, recorded)) return null;
      addToHistory(stateRef.current);
      return recorded;
  }, [history, addToHistory]);

  const undo = useCallback(() => {
      const recorded = recordUntrackedEdits();
      if (recorded) {
          // addToHistory put the live state on top, so the recorded snapshot
          // sits directly beneath it — also when the 20-entry cap trimmed one.
          const recordedIndex = historyIndexRef.current - 1;
          restoreHistorySnapshot(recorded);
          historyIndexRef.current = recordedIndex;
          setHistoryIndex(recordedIndex);
          return;
      }
      const index = historyIndexRef.current;
      if (index > 0) {
          restoreHistorySnapshot(history[index - 1]);
          historyIndexRef.current = index - 1;
          setHistoryIndex(index - 1);
      }
  }, [history, recordUntrackedEdits, restoreHistorySnapshot]);

  const redo = useCallback(() => {
      // A new (untracked) edit after an undo starts a new branch: record it,
      // which discards the redo branch, instead of overwriting it.
      if (recordUntrackedEdits()) return;

      const index = historyIndexRef.current;
      if (index < history.length - 1) {
          restoreHistorySnapshot(history[index + 1]);
          historyIndexRef.current = index + 1;
          setHistoryIndex(index + 1);
      }
  }, [history, recordUntrackedEdits, restoreHistorySnapshot]);

  // Compute the new state eagerly (from stateRef) instead of inside the setState
  // updater — updaters must be pure, and StrictMode double-invokes them, which
  // pushed every change onto the history stack twice.
  const updateStateWithHistory = useCallback((updates: Partial<MockupState>) => {
      const newState = { ...stateRef.current, ...updates };
      stateRef.current = newState;
      setState(newState);
      addToHistory(newState);
  }, [addToHistory]);

  const updateActiveCanvas = useCallback((canvasUpdates: Partial<Canvas>) => {
      const prev = stateRef.current;
      const newCanvases = prev.canvases.map(c =>
          c.id === prev.activeCanvasId ? { ...c, ...canvasUpdates } : c
      );
      const newState = { ...prev, canvases: newCanvases };
      stateRef.current = newState;
      setState(newState);
  }, []);
  
  const updateActiveCanvasWithHistory = useCallback((canvasUpdates: Partial<Canvas>) => {
      const prev = stateRef.current;
      const newCanvases = prev.canvases.map(c =>
          c.id === prev.activeCanvasId ? { ...c, ...canvasUpdates } : c
      );
      const newState = { ...prev, canvases: newCanvases };
      stateRef.current = newState;
      setState(newState);
      addToHistory(newState);
  }, [addToHistory]);


  // --- Canvas Management ---
  const addCanvas = () => {
      const newCanvas = createDefaultCanvas(state.canvases.length);
      updateStateWithHistory({
          canvases: [...state.canvases, newCanvas],
          activeCanvasId: newCanvas.id
      });
  };

  const deleteActiveCanvas = () => {
      if (state.canvases.length <= 1) {
          notify('Project must have at least one view.', 'warning');
          return;
      }
      const deletedIndex = state.canvases.findIndex(c => c.id === state.activeCanvasId);
      const newCanvases = renumberDefaultCanvases(
          state.canvases.filter(c => c.id !== state.activeCanvasId)
      );
      const nextActiveIndex = Math.min(Math.max(deletedIndex, 0), newCanvases.length - 1);
      updateStateWithHistory({
          canvases: newCanvases,
          activeCanvasId: newCanvases[nextActiveIndex].id
      });
  };


  // --- Sign / Object Handlers ---
  const updateActiveSign = useCallback((updates: Partial<Sign>) => {
    setState(prev => {
        const canvas = prev.canvases.find(c => c.id === prev.activeCanvasId);
        if (!canvas || !canvas.activeSignId) return prev;
        const newSigns = canvas.signs.map(s => s.id === canvas.activeSignId ? { ...s, ...updates } : s);
        const newCanvas = { ...canvas, signs: newSigns };
        return {
            ...prev,
            canvases: prev.canvases.map(c => c.id === prev.activeCanvasId ? newCanvas : c)
        };
    });
  }, []);
  
  const updateSignById = useCallback((id: string, updates: Partial<Sign>) => {
      const prev = stateRef.current;
      const canvas = prev.canvases.find(c => c.id === prev.activeCanvasId);
      if (!canvas) return;
      const newSigns = canvas.signs.map(s => s.id === id ? { ...s, ...updates } : s);
      const newCanvas = { ...canvas, signs: newSigns };
      const newState = {
          ...prev,
          canvases: prev.canvases.map(c => c.id === prev.activeCanvasId ? newCanvas : c)
      };
      stateRef.current = newState;
      setState(newState);
  }, []);

  const updateTitleBlock = useCallback((updates: Partial<TitleBlock>) => {
    setState(prev => ({
        ...prev,
        titleBlock: { ...prev.titleBlock, ...updates }
    }));
  }, []);

  const addSign = useCallback(() => {
    if (!activeCanvas) return;
    const cx = activeCanvas.backgroundSize.width / 2;
    const cy = activeCanvas.backgroundSize.height / 2;
    const id = Date.now().toString();
    const newSign = createDefaultSign(id, cx + 50, cy + 50, activeCanvas.signs.length);
    updateActiveCanvasWithHistory({
        signs: [...activeCanvas.signs, newSign],
        activeSignId: id,
        activeDimensionId: null
    });
    setToolMode('select');
  }, [activeCanvas, updateActiveCanvasWithHistory]);

  const duplicateSign = useCallback((id: string) => {
    if (!activeCanvas) return;
    const sourceSign = activeCanvas.signs.find(s => s.id === id);
    if (!sourceSign) return;
    const newId = Date.now().toString();
    const offset = 30;
    const newCorners = sourceSign.corners.map(p => ({ x: p.x + offset, y: p.y + offset })) as [Point, Point, Point, Point];
    const newSign: Sign = { ...sourceSign, id: newId, name: `${sourceSign.name} Copy`, corners: newCorners };
    updateActiveCanvasWithHistory({
        signs: [...activeCanvas.signs, newSign],
        activeSignId: newId,
        activeDimensionId: null
    });
  }, [activeCanvas, updateActiveCanvasWithHistory]);

  const removeSign = useCallback((id: string) => {
    if (!activeCanvas) return;
    const newSigns = activeCanvas.signs.filter(s => s.id !== id);
    updateActiveCanvasWithHistory({
        signs: newSigns,
        activeSignId: activeCanvas.activeSignId === id ? (newSigns.length > 0 ? newSigns[newSigns.length - 1].id : null) : activeCanvas.activeSignId
    });
  }, [activeCanvas, updateActiveCanvasWithHistory]);

  const setActiveSign = useCallback((id: string | null) => {
    updateActiveCanvas({ activeSignId: id, activeDimensionId: null });
  }, [updateActiveCanvas]);

  // --- Dimension Handlers ---
  const handleDrawComplete = (start: Point, end: Point, variant: 'linear' | 'box') => {
      if (!activeCanvas) return;
      const id = `dim-${Date.now()}`;
      const dx = Math.abs(end.x - start.x);
      const dy = Math.abs(end.y - start.y);
      const type = dx > dy ? 'horizontal' : 'vertical';
      // With a calibration set, the label is computed from real-world scale
      const cal = activeCanvas.calibration;
      const text = cal
          ? (variant === 'box' ? measureBox(start, end, cal, state.unitSystem) : measureLine(start, end, cal, state.unitSystem))
          : '...';
      const newDim: Dimension = { id, variant, type, start, end, text, color: '#ffffff', autoMeasured: !!cal };
      updateActiveCanvasWithHistory({
          dimensions: [...activeCanvas.dimensions, newDim],
          activeDimensionId: id,
          activeSignId: null
      });
      updateState({ showDimensions: true });
      setToolMode('select');
  };

  const handleAnnotationComplete = useCallback((points: Point[]) => {
      if (!activeCanvas || points.length < 2) return;
      const createdAt = Date.now();
      updateActiveCanvasWithHistory({
          annotations: [...(activeCanvas.annotations ?? []), {
              id: `annotation-${createdAt}`,
              points,
              color: '#f97316',
              width: 5,
              note: '',
              createdAt,
          }]
      });
  }, [activeCanvas, updateActiveCanvasWithHistory]);

  // --- Guided calibration workflow ---
  const openCalibration = (options?: { addPlane?: boolean; widthMm?: number; heightMm?: number; planeName?: string }) => {
      const existing = activeCanvas?.calibration ?? null;
      const existingPlanes = existing?.planes?.length
          ? existing.planes
          : existing?.plane ? [{ id: 'legacy-plane', name: 'Wall 1', ...existing.plane }] : [];
      const activeExistingPlane = existingPlanes.find(plane => plane.id === existing?.activePlaneId) ?? existingPlanes[0];
      const isPlane = !!existing?.plane && !options?.addPlane;
      const surveyPlaneRequested = options?.widthMm !== undefined || options?.heightMm !== undefined;
      const hasSurveyPlane = isValidSurveyPlaneSize(options?.widthMm, options?.heightMm);
      if (surveyPlaneRequested && !hasSurveyPlane) {
          notify('Enter a wall width and height greater than zero before calibrating.', 'warning');
          return;
      }
      // One draft `unit` serves both plane modes: wall width/height defaults are
      // in metres ('0.813' × '2.032' = door) and the parallel-offset default is
      // in millimetres ('500'). A mismatch read a new wall as 0.8 mm wide, or an
      // offset as 500 m — a silent 1000x error in every measurement on it.
      const initialPlaneMode: CalibrationDraft['planeMode'] =
          activeExistingPlane?.calibrationKind === 'parallel-offset' ? 'parallel-offset' : 'known-size';
      const planeModeUnit = initialPlaneMode === 'parallel-offset' ? 'mm' : 'm';
      setCalibrationDraft({
          stage: 'choose',
          method: options?.addPlane || hasSurveyPlane ? 'plane' : isPlane ? 'plane' : existing ? 'line' : null,
          points: options?.addPlane ? [] : activeExistingPlane ? [...activeExistingPlane.corners] : hasSurveyPlane ? [] : existing ? [existing.start, existing.end] : [],
          presetId: hasSurveyPlane || isPlane ? 'custom_plane' : existing ? 'custom' : 'door_height',
          value: existing && !isPlane ? String(existing.realValue) : '',
          width: hasSurveyPlane ? String(Number(options?.widthMm) / 1000) : options?.addPlane ? '0.813' : activeExistingPlane ? String(activeExistingPlane.widthMm / 1000) : '0.813',
          height: hasSurveyPlane ? String(Number(options?.heightMm) / 1000) : options?.addPlane ? '2.032' : activeExistingPlane ? String(activeExistingPlane.heightMm / 1000) : '2.032',
          unit: hasSurveyPlane ? 'm' : (options?.addPlane || isPlane) ? planeModeUnit : existing?.unit ?? 'm',
          reapply: false,
          planeName: options?.planeName || (options?.addPlane ? `Wall ${existingPlanes.length + 1}` : (activeExistingPlane?.name ?? 'Wall 1')),
          addPlane: !!options?.addPlane,
          editingPlaneId: options?.addPlane ? null : activeExistingPlane?.id ?? null,
          planeMode: initialPlaneMode,
          referencePlaneId: activeExistingPlane?.referencePlaneId ?? existingPlanes.find(plane => plane.calibrationKind !== 'parallel-offset')?.id ?? '',
          offset: activeExistingPlane?.offsetMm !== undefined ? String(Math.abs(activeExistingPlane.offsetMm)) : '500',
          offsetDirection: (activeExistingPlane?.offsetMm ?? 0) < 0 ? 'forward' : 'behind',
      });
  };

  const cancelCalibration = () => {
      setCalibrationDraft(null);
      setToolMode('select');
  };

  const applyCalibration = (calibration: Calibration, reapply: boolean) => {
      if (!activeCanvas) return;
      if (calibrationDraft?.addPlane && calibration.plane) {
          const current = activeCanvas.calibration;
          const currentPlanes = current?.planes?.length
              ? current.planes
              : current?.plane ? [{ id: 'legacy-plane', name: 'Wall 1', ...current.plane }] : [];
          const added = calibration.planes?.[0] ?? { id: `plane-${Date.now()}`, name: calibrationDraft.planeName || `Wall ${currentPlanes.length + 1}`, ...calibration.plane };
          calibration = {
              ...calibration,
              planes: [...currentPlanes, added],
              activePlaneId: added.id,
              plane: { corners: added.corners, widthMm: added.widthMm, heightMm: added.heightMm },
          };
      } else if (calibration.plane && calibration.planes?.length) {
          const incoming = calibration.planes[0];
          const current = activeCanvas.calibration;
          const currentPlanes = current?.planes?.length
              ? current.planes
              : current?.plane ? [{ id: 'legacy-plane', name: 'Wall 1', ...current.plane }] : [];
          if (calibrationDraft?.editingPlaneId && currentPlanes.length) {
              const edited = { ...incoming, id: calibrationDraft.editingPlaneId, name: calibrationDraft.planeName || incoming.name };
              const planes = currentPlanes.map(plane => plane.id === edited.id ? edited : plane);
              calibration = { ...calibration, planes, activePlaneId: edited.id, plane: { corners: edited.corners, widthMm: edited.widthMm, heightMm: edited.heightMm } };
          } else {
              calibration.activePlaneId = incoming.id;
          }
      }
      let newDims = activeCanvas.dimensions;
      if (reapply) {
          newDims = activeCanvas.dimensions.map(d => ({
              ...d,
              text: d.variant === 'box'
                  ? measureBox(d.start, d.end, calibration, state.unitSystem)
                  : measureLine(d.start, d.end, calibration, state.unitSystem),
              autoMeasured: true
          }));
      }
      updateActiveCanvasWithHistory({ calibration, dimensions: newDims });
      setCalibrationDraft(null);
      setShowCalibrationReference(false);
      setToolMode('select');
  };

  useEffect(() => {
      if (!calibrationDraft) return;
      if (calibrationDraft.stage === 'place' && calibrationDraft.method) {
          const calibrationTool = calibrationDraft.method === 'plane' ? 'calibrate_plane' : 'calibrate';
          // Pan is a deliberate temporary navigation mode during calibration.
          // Keep it selected until the user returns to Select & adjust.
          if (toolMode !== 'pan' && toolMode !== calibrationTool) setToolMode(calibrationTool);
      } else if (toolMode === 'calibrate' || toolMode === 'calibrate_plane') {
          setToolMode('select');
      }
  }, [calibrationDraft?.stage, calibrationDraft?.method, toolMode]);

  // --- Per-Element Extrusion (Element Studio) ---
  const applySignElements = (elements: SignElement[] | undefined, sourceSize: Size | undefined) => {
      const prev = stateRef.current;
      const canvas = prev.canvases.find(c => c.id === prev.activeCanvasId);
      if (!canvas || !canvas.activeSignId) return;
      const newSigns = canvas.signs.map(s =>
          s.id === canvas.activeSignId ? {
              ...s,
              elements,
              elementsSourceSize: sourceSize,
              elementDepthModel: 'relative-width-v1' as const,
              extrusionEnabled: Boolean(elements?.length),
          } : s
      );
      updateActiveCanvasWithHistory({ signs: newSigns });
      setShowElementStudio(false);
  };

  const updateDimension = useCallback((id: string, updates: Partial<Dimension>) => {
    setState(prev => {
        const canvas = prev.canvases.find(c => c.id === prev.activeCanvasId);
        if (!canvas) return prev;
        const newDims = canvas.dimensions.map(d => {
            if (d.id !== id) return d;
            const next = { ...d, ...updates };
            // A plain text update (no autoMeasured flag alongside) is the user
            // hand-typing a label — stop auto-measuring this dimension
            if (updates.text !== undefined && updates.autoMeasured === undefined) {
                next.autoMeasured = false;
            }
            // Endpoint drags recompute the label live from the calibration scale
            const geometryChanged = updates.start !== undefined || updates.end !== undefined;
            if (geometryChanged && next.autoMeasured && canvas.calibration) {
                next.text = next.variant === 'box'
                    ? measureBox(next.start, next.end, canvas.calibration, prev.unitSystem)
                    : measureLine(next.start, next.end, canvas.calibration, prev.unitSystem);
            }
            return next;
        });
        const newCanvas = { ...canvas, dimensions: newDims };
        return {
            ...prev,
            canvases: prev.canvases.map(c => c.id === prev.activeCanvasId ? newCanvas : c)
        };
    });
  }, []);

  const removeDimension = useCallback((id: string) => {
    if (!activeCanvas) return;
    const newDims = activeCanvas.dimensions.filter(d => d.id !== id);
    updateActiveCanvasWithHistory({
        dimensions: newDims,
        activeDimensionId: null
    });
  }, [activeCanvas, updateActiveCanvasWithHistory]);

  const setActiveDimension = useCallback((id: string) => {
    updateActiveCanvas({ activeDimensionId: id, activeSignId: null });
  }, [updateActiveCanvas]);

  // --- Upload Handlers ---
  const handleImageUpload = async (file: File, type: 'background' | 'foreground' | 'logo') => {
    try {
      const result = await optimizeImageFile(file, type === 'background' ? 4096 : 3072);
        if (type === 'background') {
          const img = new Image();
          img.onload = () => {
             updateActiveCanvas({
                 backgroundImage: result,
                 backgroundSize: { width: img.width, height: img.height },
                 siteCaptureLink: undefined,
                 calibration: null, // new photo, old scale no longer applies
                 placement: activeCanvas ? { ...(activeCanvas.placement ?? { snapEnabled: true, showVanishingGuides: false, lens: { enabled: false, k1: 0, k2: 0 }, camera: { enabled: false, fieldOfViewDeg: 60, estimated: true } }), lens: { enabled: false, k1: 0, k2: 0 }, camera: { enabled: false, fieldOfViewDeg: 60, estimated: true } } : undefined,
             });
          }
          img.src = result;
        } else if (type === 'logo') {
           // Use functional setState so we never close over a stale titleBlock
           setState(prev => ({ ...prev, titleBlock: { ...prev.titleBlock, logoImage: result } }));
        } else {
           if (activeCanvas?.activeSignId) {
             // New artwork invalidates detected element contours
             updateActiveSign({ image: result, elements: undefined, elementsSourceSize: undefined });
           }
        }
    } catch (error) {
      reportError('image-import', error, { bytes: file.size, type: file.type });
      notify(error instanceof Error ? error.message : 'Could not process this image.', 'error');
    }
  };

  const handleCrop = (newImageUrl: string, cropOffset: Point, newSize: { width: number, height: number }) => {
    if (!activeCanvas) return;
    const newSigns = activeCanvas.signs.map(sign => ({
        ...sign,
        corners: sign.corners.map(p => ({ x: p.x - cropOffset.x, y: p.y - cropOffset.y })) as [Point, Point, Point, Point]
    }));
    const newDims = activeCanvas.dimensions.map(dim => ({
        ...dim,
        start: { x: dim.start.x - cropOffset.x, y: dim.start.y - cropOffset.y },
        end: { x: dim.end.x - cropOffset.x, y: dim.end.y - cropOffset.y }
    }));
    const newAnnotations = (activeCanvas.annotations ?? []).map(annotation => ({
        ...annotation,
        points: annotation.points.map(point => ({ x: point.x - cropOffset.x, y: point.y - cropOffset.y }))
    }));
    // Crop cuts pixels without resampling, so the calibration scale stays valid —
    // its line just shifts by the crop offset like everything else
    const newCalibration = activeCanvas.calibration ? {
        ...activeCanvas.calibration,
        start: { x: activeCanvas.calibration.start.x - cropOffset.x, y: activeCanvas.calibration.start.y - cropOffset.y },
        end: { x: activeCanvas.calibration.end.x - cropOffset.x, y: activeCanvas.calibration.end.y - cropOffset.y },
        plane: activeCanvas.calibration.plane ? { ...activeCanvas.calibration.plane, corners: activeCanvas.calibration.plane.corners.map(p => ({ x: p.x - cropOffset.x, y: p.y - cropOffset.y })) as [Point, Point, Point, Point] } : undefined,
        planes: activeCanvas.calibration.planes?.map(plane => ({ ...plane, corners: plane.corners.map(p => ({ x: p.x - cropOffset.x, y: p.y - cropOffset.y })) as [Point, Point, Point, Point] })),
    } : activeCanvas.calibration;
    updateActiveCanvasWithHistory({
        backgroundImage: newImageUrl,
        backgroundSize: newSize,
        siteCaptureLink: undefined,
        signs: newSigns,
        dimensions: newDims,
        annotations: newAnnotations,
        calibration: newCalibration,
        placement: activeCanvas.placement?.camera.principalPoint ? {
            ...activeCanvas.placement,
            camera: { ...activeCanvas.placement.camera, principalPoint: { x: activeCanvas.placement.camera.principalPoint.x - cropOffset.x, y: activeCanvas.placement.camera.principalPoint.y - cropOffset.y } }
        } : activeCanvas.placement
    });
    setIsCropping(false);
  };
  
  const handleCleanupSave = (newImageUrl: string) => {
      const img = new Image();
      img.onload = () => {
          const canvas = stateRef.current.canvases.find(c => c.id === stateRef.current.activeCanvasId);
          if (!canvas) return;
          // The AI cleanup pipeline resizes the photo (1536px cap, and the model
          // may return another size). Signs, dimensions and annotations are in
          // image pixels, so map them into the new pixel space — otherwise a
          // sign on a 4032px photo lands ~2.6x off-image after cleanup.
          const sx = img.width / (canvas.backgroundSize.width || img.width);
          const sy = img.height / (canvas.backgroundSize.height || img.height);
          const scalePoint = (p: Point): Point => ({ x: p.x * sx, y: p.y * sy });
          // The old pixel scale is no longer trustworthy — require recalibration.
          // Undoable, so an unwanted cleanup can be reverted with the original photo.
          updateActiveCanvasWithHistory({
              backgroundImage: newImageUrl,
              backgroundSize: { width: img.width, height: img.height },
              signs: canvas.signs.map(sign => ({
                  ...sign,
                  corners: sign.corners.map(scalePoint) as [Point, Point, Point, Point],
              })),
              dimensions: canvas.dimensions.map(dim => ({ ...dim, start: scalePoint(dim.start), end: scalePoint(dim.end) })),
              annotations: (canvas.annotations ?? []).map(annotation => ({ ...annotation, points: annotation.points.map(scalePoint) })),
              siteCaptureLink: undefined,
              calibration: null,
              placement: { ...(canvas.placement ?? { snapEnabled: true, showVanishingGuides: false, lens: { enabled: false, k1: 0, k2: 0 }, camera: { enabled: false, fieldOfViewDeg: 60, estimated: true } }), lens: { enabled: false, k1: 0, k2: 0 }, camera: { enabled: false, fieldOfViewDeg: 60, estimated: true } },
          });
          setShowCleanupTool(false);
      };
      img.src = newImageUrl;
  };
  
  const handleDownload = async (destination: 'device' | 'drive' = 'device') => {
    const element = document.getElementById('export-target');
    if (!element) return;

    const prevCursor = document.body.style.cursor;
    document.body.style.cursor = 'wait';

    try {
        const [{ jsPDF }, canvas] = await Promise.all([import('jspdf'), captureElement(element, 2)]);

        const imgData = canvas.toDataURL('image/png');

        if (state.titleBlock.viewMode === 'sheet') {
            const { paperSize, orientation } = state.titleBlock;
            const pdf = new jsPDF({
                orientation: orientation,
                unit: 'mm',
                format: paperSize.toLowerCase()
            });

            const pdfWidth = pdf.internal.pageSize.getWidth();
            const pdfHeight = pdf.internal.pageSize.getHeight();
            
            pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
            const fileName = `${activeCanvas.sheetNumber || 'presentation'}.pdf`;
            if (destination === 'drive') {
                const connector = getActiveConnector();
                if (!connector || !(await connector.ensureReady(true))) throw new Error('Connect and select a cloud drive first.');
                await connector.uploadFile(pdf.output('blob'), fileName);
                notify(`${fileName} saved to ${connector.label}.`, 'success');
            } else pdf.save(fileName);
        } else {
            const fileName = `${activeCanvas.name || 'mockup'}.png`;
            if (destination === 'drive') {
                const connector = getActiveConnector();
                if (!connector || !(await connector.ensureReady(true))) throw new Error('Connect and select a cloud drive first.');
                const blob = await (await fetch(imgData)).blob();
                await connector.uploadFile(blob, fileName);
                notify(`${fileName} saved to ${connector.label}.`, 'success');
            } else {
                const link = document.createElement('a');
                link.href = imgData;
                link.download = fileName;
                link.click();
            }
        }
    } catch (error) {
        reportError('export', error, { destination, projectId: state.projectId });
        notify(error instanceof Error ? error.message : 'Export failed. Please try again.', 'error');
    } finally {
        document.body.style.cursor = prevCursor;
    }
  };

  const handleProjectLoad = async (loadedState: MockupState) => {
      // Persist the outgoing project's last few seconds of edits first.
      void flushPendingAutosave();
      // Treat project switching as a full session boundary. Updating React
      // state alone left stateRef/history on the previous Untitled project,
      // allowing an in-flight autosave to switch the phone back immediately.
      const current = stateRef.current;
      const mergedState = {
          ...normalizeProjectState(loadedState),
          user: current.user,
          isOnline: navigator.onLine,
          isSyncing: false,
      };
      const hasPendingSync = Boolean(
          current.user
          && !current.user.uid.startsWith('guest_')
          && await StorageService.hasQueuedProjectSync(current.user.uid, loadedState.projectId),
      );
      const loadedFromCloud = (loadedState.cloudRevision ?? 0) > 0 && !hasPendingSync;
      setSyncStatus(loadedFromCloud ? 'synced' : 'local_only');
      setLastCloudSavedAt(loadedFromCloud ? Date.now() : null);
      // Opening an unchanged cloud revision is read-only. A legacy phone-only
      // revision still needs its first cloud save after the user selects it.
      startSession(mergedState, loadedFromCloud);
  };

  const handleProjectSave = async (name: string): Promise<ProjectSaveResult> => {
      const newState = { 
          ...state, 
          projectName: name, 
          projectId: state.projectId || `proj_${Date.now()}`,
          lastSaved: Date.now() 
      };
      setState(newState);
      
      // Capture a thumbnail from the current canvas
      let thumbnail = undefined;
      const element = document.getElementById('export-target');
      if (element) {
           try {
               const canvas = await captureElement(element, 0.2);
               thumbnail = canvas.toDataURL('image/jpeg', 0.7);
           } catch (e) { reportWarning('thumbnail', 'Thumbnail generation failed', { error: String(e) }); }
      }

      await StorageService.saveProjectLocal(newState, thumbnail);
      // Also trigger cloud sync if needed
      return await triggerBackendSync(newState);
  };

  const handleProjectRename = async (projectId: string, name: string) => {
      const trimmedName = name.trim();
      if (!trimmedName) throw new Error('Project name is required.');
      const stored = projectId === state.projectId ? state : await StorageService.loadProjectLocal(projectId);
      if (!stored) throw new Error('Project could not be found.');
      const renamed = { ...stored, user: state.user, projectName: trimmedName, lastSaved: Date.now() };
      await StorageService.saveProjectLocal(renamed);
      if (projectId === state.projectId) setState(renamed);
      if (state.user) triggerBackendSync(renamed);
  };

  const handleProjectDelete = async (projectId: string) => {
      if (projectId === stateRef.current.projectId) {
          // Pending edits to a project being deleted must not recreate it.
          discardPendingAutosave();
          syncAttemptRef.current += 1;
      }
      if (state.user && !state.user.uid.startsWith('guest_')) {
          await StorageService.deleteProjectCloud(state.user.uid, projectId);
      }
      // Keep the recoverable local copy until the authoritative cloud pointer
      // has definitely been removed.
      await StorageService.deleteProjectLocal(projectId);
      if (projectId !== state.projectId) return;

      const replacement = { ...getInitialState(), user: state.user, isOnline: state.isOnline, isSyncing: false };
      if (state.user?.uid.startsWith('guest_')) localStorage.setItem(GUEST_PROJECT_ID_KEY, replacement.projectId);
      startSession(replacement);
      await StorageService.saveProjectLocal(replacement);
      setSyncStatus('local_only');
      setLastCloudSavedAt(null);
      if (replacement.user && !replacement.user.uid.startsWith('guest_')) {
          await triggerBackendSync(replacement);
      }
  };

  const handleNewProject = async () => {
      // Save (don't cancel) the outgoing project's pending edits.
      void flushPendingAutosave();
      setCalibrationDraft(null);
      setShowCalibrationReference(false);
      setIsCropping(false);
      const cleanState = createCleanProjectState(state.user, state.isOnline);
      if (state.user?.uid.startsWith('guest_')) localStorage.setItem(GUEST_PROJECT_ID_KEY, cleanState.projectId);
      startSession(cleanState);
      await StorageService.saveProjectLocal(cleanState);
      setSyncStatus('local_only');
      setLastCloudSavedAt(null);
      if (cleanState.user && !cleanState.user.uid.startsWith('guest_')) {
          await triggerBackendSync(cleanState);
      }
      notify('New clean project started.', 'success');
  };

  const handlePromoteSiteCapture = async (capture: SiteCapturePhoto) => {
      if (capture.promotedCanvasId) return;
      const expectedProjectId = stateRef.current.projectId;
      const requestedCapture = (stateRef.current.siteCaptures ?? []).find(item => item.id === capture.id);
      if (!requestedCapture) throw new Error('This site capture no longer belongs to the active project.');
      if (requestedCapture.promotedCanvasId) return;
      let backgroundImage = requestedCapture.workingRef;
      if (requestedCapture.workingRef.startsWith('site-capture://')) {
          const blob = await getSiteCaptureAsset(requestedCapture.workingRef);
          if (!blob) throw new Error('The working photograph is missing from this device.');
          backgroundImage = await blobToDataUri(blob);
      }
      const current = stateRef.current;
      if (current.projectId !== expectedProjectId) {
          throw new Error('Editor view creation stopped because the active project changed.');
      }
      const liveCapture = (current.siteCaptures ?? []).find(item => item.id === capture.id);
      if (!liveCapture) throw new Error('This site capture was removed before its editor view was created.');
      // A second concurrent click can finish while the first blob is loading.
      // Re-check the live record so only one canvas is ever created.
      if (liveCapture.promotedCanvasId) return;
      if (!isValidSurveyPlaneSize(liveCapture.referenceWall.widthMm, liveCapture.referenceWall.heightMm)) {
          throw new Error('Enter a wall width and height greater than zero before creating an editor view.');
      }
      const newCanvas = createDefaultCanvas(current.canvases.length);
      const replaceableCanvas = current.canvases.length === 1 && !current.canvases[0].backgroundImage && current.canvases[0].signs.length === 0 && current.canvases[0].dimensions.length === 0 && !current.canvases[0].calibration;
      if (replaceableCanvas) newCanvas.id = current.canvases[0].id;
      newCanvas.name = liveCapture.label;
      newCanvas.sheetTitle = liveCapture.label.toUpperCase();
      newCanvas.backgroundImage = backgroundImage;
      newCanvas.backgroundSize = { width: liveCapture.workingPixelWidth, height: liveCapture.workingPixelHeight };
      newCanvas.siteCaptureLink = {
          captureId: liveCapture.id,
          annotationUpdatedAt: liveCapture.annotationUpdatedAt ?? liveCapture.capturedAt,
      };
      const nextCaptures = (current.siteCaptures ?? []).map(item => item.id === liveCapture.id ? { ...item, promotedCanvasId: newCanvas.id } : item);
      let titleBlock = current.titleBlock;
      if (liveCapture.location?.address) {
          titleBlock = { ...titleBlock, fields: titleBlock.fields.map(field => field.label === 'ADDRESS' && !field.value ? { ...field, value: liveCapture.location!.address! } : field) };
      }
      const nextCanvases = replaceableCanvas ? [newCanvas] : [...current.canvases, newCanvas];
      const next = { ...current, canvases: nextCanvases, activeCanvasId: newCanvas.id, siteCaptures: nextCaptures, titleBlock, lastSaved: Date.now() };
      stateRef.current = next;
      setState(next);
      addToHistory(next);
      notify(`${liveCapture.label} is ready in the iPad and desktop editor.`, 'success');
  };

  // --- Render ---
  if (isAuthLoading) {
      return (
          <div className="w-full h-full bg-gray-900 flex items-center justify-center">
              <div className="flex flex-col items-center gap-4">
                  <Loader2 className="w-10 h-10 text-blue-500 animate-spin" />
                  <p className="text-gray-400">Loading Interactive Signage...</p>
              </div>
          </div>
      );
  }

  if (!state.user) {
      return (
          <div className="w-full h-full bg-gray-950 flex flex-col items-center justify-center p-6 text-center">
              <div className="max-w-md w-full bg-gray-900 border border-gray-800 p-8 rounded-2xl shadow-2xl">
                  <div className="w-16 h-16 bg-blue-600 rounded-xl flex items-center justify-center mx-auto mb-6 shadow-lg shadow-blue-900/40">
                      <LogIn className="w-8 h-8 text-white" />
                  </div>
                  <h1 className="text-3xl font-bold text-white mb-2">SignagePro</h1>
                  <p className="text-gray-400 mb-8">Sign in to sync your projects and access them from anywhere.</p>
                  
                  {authError && (
                      <div className="bg-red-500/10 border border-red-500/50 rounded-lg p-3 mb-6 flex gap-3 text-left animate-in fade-in slide-in-from-top-2">
                          <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                          <div className="text-sm text-red-200">
                             <p className="font-bold mb-1">Login Error</p>
                             <p>{authError}</p>
                          </div>
                      </div>
                  )}

                  <button
                      onClick={handleLogin}
                      disabled={isLoginPending}
                      className="w-full bg-white hover:bg-gray-100 disabled:cursor-wait disabled:bg-gray-200 disabled:text-gray-500 text-gray-900 font-bold py-3 px-4 rounded-lg transition-colors flex items-center justify-center gap-3 mb-3"
                      title="Sign in with your Google account"
                  >
                      {isLoginPending
                        ? <Loader2 className="h-5 w-5 animate-spin" />
                        : <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" className="w-5 h-5" alt="" />}
                      {isLoginPending ? 'Complete sign-in in Google' : 'Sign in with Google'}
                  </button>

                  <button 
                      onClick={handleGuestLogin}
                      disabled={isLoginPending}
                      className="w-full bg-gray-800 hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50 text-gray-300 font-semibold py-3 px-4 rounded-lg transition-colors flex items-center justify-center gap-3"
                  >
                      Continue as Guest
                  </button>
                  
                  <p className="text-xs text-gray-500 mt-6">
                      Guest mode saves data to your local device only.
                  </p>
              </div>
          </div>
      );
  }

  if (isPhoneCapture) {
      return (
        <Suspense fallback={<div className="fixed inset-0 grid place-items-center bg-[#080c11] text-slate-400"><Loader2 className="h-7 w-7 animate-spin" /></div>}>
          <MobileSiteCapture
            state={state}
            syncStatus={syncStatus}
            onUpdate={updateState}
            onLoadProject={handleProjectLoad}
            onNewProject={handleNewProject}
            onSaveProject={handleProjectSave}
            onPromoteCapture={handlePromoteSiteCapture}
            onLogout={handleLogout}
          />
        </Suspense>
      );
  }

  if (!activeCanvas) return null;

  return (
    <div className="relative flex h-[100dvh] w-full overflow-hidden bg-black lg:flex-row">
      {/* Top Bar Status */}
      <div className={`pointer-events-none absolute top-[max(0.75rem,env(safe-area-inset-top))] z-50 flex items-center gap-2 ${useTabletSidePanel ? 'left-[21rem] max-w-[calc(100vw-28rem)]' : 'left-3 max-w-[48vw] lg:left-1/2 lg:max-w-none lg:-translate-x-1/2'}`}>
          {!state.isOnline && !state.user.uid.startsWith('guest_') && (
              <div className="bg-red-600/90 text-white px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1 shadow-lg backdrop-blur">
                  <WifiOff className="w-3 h-3" /> Offline Mode
              </div>
          )}
          {state.user.uid.startsWith('guest_') && (
              <div className="flex min-h-9 max-w-full items-center gap-1 rounded-full border border-gray-600 bg-gray-700/90 px-3 py-1 text-xs font-bold text-gray-300 shadow-lg backdrop-blur">
                  <UserIcon className="h-3 w-3 shrink-0" /> <span className="truncate">Guest Mode (Local)</span>
              </div>
          )}
          {state.isSyncing && state.isOnline && (
              <div className="bg-blue-600/90 text-white px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1 shadow-lg backdrop-blur">
                  <RefreshCw className="w-3 h-3 animate-spin" /> Syncing...
              </div>
          )}
          {lastCloudSavedAt && syncStatus === 'synced' && !state.isSyncing && !state.user.uid.startsWith('guest_') && (
              <div className="bg-gray-800/90 text-gray-300 px-3 py-1 rounded-full text-xs font-medium shadow-lg backdrop-blur" title={new Date(lastCloudSavedAt).toLocaleString()}>
                  Cloud saved {new Date(lastCloudSavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
          )}
          {/* New Status for Local Only Mode due to large payload */}
          {syncStatus === 'local_only' && !state.user.uid.startsWith('guest_') && (
              <div className="bg-green-600/90 text-white px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1 shadow-lg backdrop-blur" title="Project saved to local database.">
                  <Database className="w-3 h-3" /> Saved Locally
              </div>
          )}
          {driveNeedsReconnect && (
              <div className="bg-amber-600/95 text-white px-3 py-1 rounded-full text-xs font-bold flex items-center gap-2 shadow-lg backdrop-blur pointer-events-auto">
                  <HardDrive className="w-3 h-3" /> Some images need {driveReconnectProvider ? connectors.find(c => c.id === driveReconnectProvider)?.label : 'your selected cloud drive'}
                  <button onClick={handleDriveReconnect} className="underline hover:text-amber-100">Reconnect</button>
              </div>
          )}
          {syncConflict && (
              <div className="bg-red-700/95 text-white px-3 py-1 rounded-full text-xs font-bold flex items-center gap-2 pointer-events-auto">
                  <AlertTriangle className="w-3 h-3" /> Project changed elsewhere
                  <button className="underline" onClick={loadCloudConflictCopy}>Load cloud</button>
                  <button className="underline" onClick={keepLocalConflictCopy}>Keep this device</button>
              </div>
          )}
          {unavailablePhotoCount > 0 && (
              <div role="status" data-testid="unavailable-photos-banner" className="bg-gray-800/95 text-amber-200 border border-amber-500/40 px-3 py-1 rounded-full text-xs font-bold flex items-center gap-2 pointer-events-auto">
                  <AlertTriangle className="w-3 h-3" /> {unavailablePhotoCount} site photo{unavailablePhotoCount === 1 ? '' : 's'} unavailable
                  <button className="underline" onClick={() => void retryUnavailablePhotos(true)}>Retry now</button>
              </div>
          )}
          {deletedElsewhere && (
              <div role="alert" data-testid="deleted-elsewhere-banner" className="bg-amber-600/95 text-white px-3 py-1 rounded-full text-xs font-bold flex items-center gap-2 pointer-events-auto">
                  <AlertTriangle className="w-3 h-3" /> Deleted on another device
                  <button className="underline" onClick={restoreDeletedProject}>Restore it</button>
                  <button className="underline" onClick={discardDeletedProject}>Discard this copy</button>
              </div>
          )}
      </div>

      {/* User Profile / Logout (Top Right) */}
      <div className="absolute right-3 top-[max(0.75rem,env(safe-area-inset-top))] z-50 flex items-center gap-1 rounded-full border border-gray-700 bg-gray-900/85 p-1 pr-1.5 shadow-xl backdrop-blur lg:right-4 lg:gap-2 lg:pr-3">
          <img src={state.user.photoURL || DEFAULT_AVATAR} className="h-9 w-9 rounded-full border border-gray-600 lg:h-8 lg:w-8" alt="User" />
          <span className="text-xs font-medium text-gray-300 hidden md:block">{state.user.displayName}</span>
          {!state.user.uid.startsWith('guest_') && (
              <button onClick={() => setShowDriveSettings(true)} className={`grid h-11 w-11 place-items-center rounded-full transition-colors ${driveStatus === 'connected' ? 'text-green-400 hover:bg-green-500/20' : driveStatus === 'expired' ? 'text-amber-400 hover:bg-amber-500/20' : 'text-gray-400 hover:bg-blue-500/20 hover:text-blue-400'}`} title={driveStatus === 'connected' ? 'Cloud drive connected' : 'Connect your cloud drive'} aria-label={driveStatus === 'connected' ? 'Cloud drive connected' : 'Connect your cloud drive'}>
                  <HardDrive className="w-4 h-4" />
              </button>
          )}
          {!state.user.uid.startsWith('guest_') && <button onClick={() => setShowAccountSettings(true)} className="grid h-11 w-11 place-items-center rounded-full text-gray-400 hover:bg-gray-700 hover:text-white" title="Account and data" aria-label="Account and data"><Settings className="w-4 h-4" /></button>}
          <button onClick={handleLogout} className="grid h-11 w-11 place-items-center rounded-full text-gray-400 transition-colors hover:bg-red-500/20 hover:text-red-400" title="Sign Out" aria-label="Sign Out">
              <LogOut className="w-4 h-4" />
          </button>
      </div>

      {calibrationDraft && (
          <CalibrationWizard
              draft={calibrationDraft}
              imageSize={activeCanvas.backgroundSize}
              existingCalibration={activeCanvas.calibration ?? null}
              camera={activeCanvas.placement?.camera ?? { enabled: false, fieldOfViewDeg: 60, estimated: true }}
              existingDimensionCount={activeCanvas.dimensions.length}
              onChange={setCalibrationDraft}
              onApply={applyCalibration}
              onCancel={cancelCalibration}
          />
      )}

      <Suspense fallback={null}>
        <Assistant isOpen={showAssistant} setIsOpen={setShowAssistant} />
      </Suspense>
      
      <ControlsPanel
        state={state}
        activeCanvas={activeCanvas}
        forceSidePanel={useTabletSidePanel}
        updateState={updateState}
        updateStateWithHistory={updateStateWithHistory}
        updateActiveCanvas={updateActiveCanvas}
        updateActiveCanvasWithHistory={updateActiveCanvasWithHistory}
        updateActiveSign={updateActiveSign}
        updateSignById={updateSignById}
        addSign={addSign}
        duplicateSign={duplicateSign}
        removeSign={removeSign}
        setActiveSign={setActiveSign}
        
        addCanvas={addCanvas}
        deleteCanvas={deleteActiveCanvas}

        toolMode={toolMode}
        setToolMode={setToolMode}
        viewLocked={viewLocked}
        onViewLockedChange={handleViewLockedChange}
        onOpenCalibration={openCalibration}
        highResolutionPhoto={finishMeasuringInfo ? { width: finishMeasuringInfo.width, height: finishMeasuringInfo.height } : null}
        onFinishMeasuring={openFinishMeasuring}
        onPromoteCapture={handlePromoteSiteCapture}
        showCalibrationReference={showCalibrationReference}
        setShowCalibrationReference={setShowCalibrationReference}
        updateDimension={updateDimension}
        removeDimension={removeDimension}
        setActiveDimension={setActiveDimension}

        onBackgroundUpload={(f) => handleImageUpload(f, 'background')}
        onForegroundUpload={(f) => handleImageUpload(f, 'foreground')}
        onLogoUpload={(f) => handleImageUpload(f, 'logo')}
        onDownload={handleDownload} 
        
        isCropping={isCropping}
        setIsCropping={setIsCropping}

        onOpenCleanup={() => setShowCleanupTool(true)}
        onOpenElementStudio={() => setShowElementStudio(true)}

        undo={undo}
        redo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        
        showAssistant={showAssistant}
        setShowAssistant={setShowAssistant}
        onOpenProjectManager={() => setShowProjectManager(true)}
      />
      <div className="flex-1 relative overflow-hidden bg-gray-950">
         <MockupCanvas
           images={{ background: activeCanvas.backgroundImage, backgroundSize: activeCanvas.backgroundSize }}
           precisionBackground={precisionBackground}
           signs={activeCanvas.signs}
           activeSignId={activeCanvas.activeSignId}
           dimensions={activeCanvas.dimensions}
           activeDimensionId={activeCanvas.activeDimensionId}
           annotations={activeCanvas.annotations ?? []}
           
           state={state}
           titleBlock={{ ...state.titleBlock, fields: state.titleBlock.fields.map(f => {
              if (f.label === 'SHEET TITLE') return { ...f, value: activeCanvas.sheetTitle || f.value };
              if (f.label === 'SHEET NO.') return { ...f, value: activeCanvas.sheetNumber || f.value };
              return f;
           })}}

           toolMode={toolMode}
           viewLocked={viewLocked}
           onViewLockedChange={handleViewLockedChange}
           onDrawComplete={handleDrawComplete}
           onAnnotationComplete={handleAnnotationComplete}
           calibration={activeCanvas.calibration ?? null}
           calibrationDraft={calibrationDraft && calibrationDraft.method ? {
             method: calibrationDraft.method,
             points: calibrationDraft.points,
             editable: calibrationDraft.stage === 'place',
           } : null}
           onCalibrationDraftPointsChange={points => setCalibrationDraft(current => current ? { ...current, points } : current)}
           showCalibrationReference={showCalibrationReference}
           updateSignById={updateSignById}
           undo={undo}
           redo={redo}
           canUndo={canUndo}
           canRedo={canRedo}
           onSignPlacementStart={beginSignPlacement}
           onSignPlacementEnd={finishSignPlacement}
           setActiveSign={setActiveSign}
           updateDimension={updateDimension}
           setActiveDimension={setActiveDimension}
           updateTitleBlock={updateTitleBlock}
           setCanvasRef={(ref) => canvasRef.current = ref}
           isCropping={isCropping}
           onCropConfirm={handleCrop}
           onCancelCrop={() => setIsCropping(false)}
         />
         <button
           type="button"
           onClick={() => setShowProposal3D(true)}
           className="absolute left-3 top-[max(4.5rem,calc(env(safe-area-inset-top)+4.5rem))] z-40 flex h-11 items-center gap-2 rounded-xl border border-cyan-400/25 bg-gray-950/85 px-3 text-[11px] font-bold uppercase tracking-[0.12em] text-cyan-200 shadow-xl backdrop-blur transition hover:border-cyan-300/50 hover:bg-cyan-400/10 lg:left-4 lg:top-4"
           aria-label="Open 3D proposal viewer"
           title="Open rotatable 3D proposal"
         >
           <Building2 className="h-4 w-4" /> 3D proposal
         </button>
      </div>

      {showProposal3D && (
        <Suspense fallback={<div className="fixed inset-0 z-[90] grid place-items-center bg-gray-950 text-sm text-gray-400"><Loader2 className="mr-2 inline h-5 w-5 animate-spin" /> Preparing 3D proposal…</div>}>
          <Proposal3DViewer
            canvases={state.canvases}
            settings={state.buildingModel}
            isNightMode={state.isNightMode}
            onChange={buildingModel => updateStateWithHistory({ buildingModel })}
            onClose={() => setShowProposal3D(false)}
          />
        </Suspense>
      )}

      {showProjectManager && (
          <Suspense fallback={null}>
            <ProjectManager
                isOpen={showProjectManager}
                onClose={() => setShowProjectManager(false)}
                currentState={state}
                onLoadProject={handleProjectLoad}
                onSaveProject={handleProjectSave}
                onRenameProject={handleProjectRename}
                onDeleteProject={handleProjectDelete}
                onNewProject={handleNewProject}
            />
          </Suspense>
      )}

      {showCleanupTool && (
        <Suspense fallback={null}>
          <CleanupTool
             isOpen={showCleanupTool}
             imageUrl={activeCanvas.backgroundImage}
             onClose={() => setShowCleanupTool(false)}
             onSave={handleCleanupSave}
          />
        </Suspense>
      )}

      {finishMeasuringCanvasId && finishMeasuringInfo && activeCanvas.id === finishMeasuringCanvasId && (
        <Suspense fallback={null}>
          <FinishMeasuringDialog
             info={finishMeasuringInfo}
             viewName={activeCanvas.name}
             original={finishOriginal}
             onConfirm={finishMeasuring}
             onClose={() => setFinishMeasuringCanvasId(null)}
          />
        </Suspense>
      )}

      {showDriveSettings && (
        <Suspense fallback={null}>
          <DriveSettings
             isOpen={showDriveSettings}
             onClose={() => setShowDriveSettings(false)}
             onStatusChange={(status) => {
                 setDriveStatus(status);
                 if (status === 'connected') setDriveNeedsReconnect(false);
             }}
          />
        </Suspense>
      )}

      {showAccountSettings && !state.user.uid.startsWith('guest_') && (
        <Suspense fallback={null}><AccountSettings user={state.user} onClose={() => setShowAccountSettings(false)} onAccountDeleted={() => { setShowAccountSettings(false); setState(getInitialState()); }} /></Suspense>
      )}

      {showElementStudio && (() => {
          const studioSign = activeCanvas.signs.find(s => s.id === activeCanvas.activeSignId);
          if (!studioSign) return null;
          // Real quad width in mm when this view is calibrated — lets the
          // Studio express element depths in real units (channel-letter returns)
          const mmPerBgPx = activeCanvas.calibration ? getMmPerPx(activeCanvas.calibration) : null;
          const sc = studioSign.corners;
          const quadWidthMm = mmPerBgPx
              ? ((distance(sc[0], sc[1]) + distance(sc[3], sc[2])) / 2) * mmPerBgPx
              : null;
          return (
            <Suspense fallback={null}>
              <ElementStudio
                  sign={studioSign}
                  quadWidthMm={quadWidthMm}
                  unitSystem={state.unitSystem}
                  onApply={applySignElements}
                  onClose={() => setShowElementStudio(false)}
              />
            </Suspense>
          );
      })()}
    </div>
  );
};

export default App;
