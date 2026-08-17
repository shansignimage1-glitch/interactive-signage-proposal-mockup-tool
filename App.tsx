
import React, { useState, useCallback, useRef, useEffect, Suspense } from 'react';
import { auth, googleProvider } from './firebase';
import { getIdTokenResult, getRedirectResult, onAuthStateChanged, signInWithPopup, signOut, type User as FirebaseUser } from 'firebase/auth';

import ControlsPanel from './components/ControlsPanel';
import MockupCanvas from './components/MockupCanvas';
// Lazy-loaded: these features are only downloaded when opened.
const CleanupTool = React.lazy(() => import('./components/CleanupTool'));
const Assistant = React.lazy(() => import('./components/Assistant'));
const ProjectManager = React.lazy(() => import('./components/ProjectManager'));
const ElementStudio = React.lazy(() => import('./components/ElementStudio'));
const DriveSettings = React.lazy(() => import('./components/DriveSettings'));
const AccountSettings = React.lazy(() => import('./components/AccountSettings'));
const Proposal3DViewer = React.lazy(() => import('./components/Proposal3DViewer'));
const MobileSiteCapture = React.lazy(() => import('./components/MobileSiteCapture'));
import { MockupState, AppImages, Point, Sign, Dimension, TitleBlock, TitleBlockField, Canvas, Calibration, SignElement, Size, ConnectorStatus, CloudProvider, UserProfile, SiteCapturePhoto } from './types';
import { getActiveConnector, getPreferredProvider, setConnectorUid, connectors, getConnectorForRef } from './services/driveConnectors';
import { distance } from './utils/math';
import { isPhoneSizedTouchDevice, readDeviceModeEnvironment, shouldUsePhoneCapture, type DeviceModeEnvironment } from './utils/deviceMode';
import { isMissingRedirectStateError } from './utils/authErrors';
import { measureLine, measureBox, getMmPerPx } from './utils/measure';
import { normalizeProjectState } from './utils/projectMigration';
import CalibrationWizard, { CalibrationDraft } from './components/CalibrationWizard';
import { TITLE_BLOCK_TEMPLATES } from './data/titleBlockTemplates';
import { getSiteCaptureAsset, StorageService } from './services/StorageService';
import { Wifi, WifiOff, RefreshCw, LogIn, LogOut, Loader2, AlertTriangle, User as UserIcon, HardDrive, Database, Settings, Building2 } from 'lucide-react';
import { notify } from './services/toast';
import { reportError, reportWarning } from './services/monitoring';
import { captureElement } from './utils/exportCapture';
import { optimizeImageFile } from './services/imageProcessing';
import { blobToDataUri } from './services/imageHash';

const GUEST_PROJECT_ID_KEY = 'signagepro_guest_project_id';
const AUTH_BOOT_TIMEOUT_MS = 20_000;
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
  const [syncStatus, setSyncStatus] = useState<'synced' | 'local_only' | 'error'>('synced');
  const [lastCloudSavedAt, setLastCloudSavedAt] = useState<number | null>(null);
  const [syncConflict, setSyncConflict] = useState(false);
  
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
  const [showAccountSettings, setShowAccountSettings] = useState(false);
  const [showProposal3D, setShowProposal3D] = useState(false);
  const [isPhoneCapture, setIsPhoneCapture] = useState(() => shouldUsePhoneCapture(readDeviceModeEnvironment(window)));
  const [useTabletSidePanel, setUseTabletSidePanel] = useState(() => shouldUseTabletSidePanel(readDeviceModeEnvironment(window)));
  const [driveStatus, setDriveStatus] = useState<ConnectorStatus>('disconnected');
  const [driveNeedsReconnect, setDriveNeedsReconnect] = useState(false);
  const [driveReconnectProvider, setDriveReconnectProvider] = useState<CloudProvider | null>(null);
  
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef(state);
  const authObserverCalledRef = useRef(false);
  const authAttemptInProgressRef = useRef(false);
  const authSessionRef = useRef<{ uid: string | null; epoch: number }>({ uid: null, epoch: 0 });
  const completedAuthUidRef = useRef<string | null>(null);
  const authBootstrapPromisesRef = useRef(new Map<string, { epoch: number; promise: Promise<void> }>());
  useEffect(() => { stateRef.current = state; }, [state]);
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
  const startSession = useCallback((state: MockupState) => {
      const newState = normalizeProjectState(state);
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

              const projects = await withTimeout(
                  StorageService.listProjectsCloud(uid),
                  10_000,
                  'Cloud project list',
              );
              if (!isCurrentSession()) return;
              if (projects.length > 0) {
                  const latest = projects.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))[0];
                  const loaded = await withTimeout(
                      StorageService.loadProjectCloud(uid, latest.id, ({ needsReconnect, failedRefs }) => {
                          if (!isCurrentSession() || !needsReconnect) return;
                          setDriveNeedsReconnect(true);
                          setDriveReconnectProvider(failedRefs[0] ? getConnectorForRef(failedRefs[0])?.id ?? null : null);
                          setDriveStatus('expired');
                      }),
                      AUTH_BOOT_TIMEOUT_MS,
                      'Cloud project load',
                  );
                  if (!isCurrentSession()) return;
                  if (loaded) {
                      startSession({ ...loaded, user, isOnline: navigator.onLine, isSyncing: false });
                      completedAuthUidRef.current = uid;
                      return;
                  }
              }

              startSession({ ...getInitialState(), user, isOnline: navigator.onLine });
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
      const existingProject = existingProjectId ? await StorageService.loadProjectLocal(existingProjectId) : null;

      const newState: MockupState = existingProject
        ? { ...existingProject, user: guestUser, isOnline: false }
        : { ...getInitialState(), user: guestUser, isOnline: false };

      localStorage.setItem(GUEST_PROJECT_ID_KEY, newState.projectId);

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

  // Re-open the current project after the user reconnects their drive, so
  // unresolved gdrive:// refs get another chance to materialize.
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
        const reloaded = await StorageService.loadProjectCloud(current.user.uid, current.projectId);
        if (reloaded) {
          startSession({ ...reloaded, user: current.user, isOnline: navigator.onLine, isSyncing: false });
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
      const credential = await signInWithPopup(auth, googleProvider);
      await bootstrapFirebaseUser(credential.user);
    } catch (err: any) {
      authAttemptInProgressRef.current = false;
      setIsLoginPending(false);
      setIsAuthLoading(false);
      const code = err?.code ?? '';
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
      if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
        setAuthError('Google sign-in was blocked. Allow pop-ups for this site, then tap Sign in with Google again.');
      } else {
        setAuthError(err?.message ?? 'Sign-in failed. Please try again.');
      }
    }
  };

  const handleLogout = async () => {
    authAttemptInProgressRef.current = false;
    setIsLoginPending(false);
    selectAuthUser(null);
    await signOut(auth);
    const initialState = getInitialState();
    stateRef.current = initialState;
    setState(initialState);
  };

  const updateState = useCallback((updates: Partial<MockupState>) => {
    setState(prev => ({ ...prev, ...updates }));
  }, []);

  // --- Connectivity & Persistence Logic ---

  // Trigger Sync
  const triggerBackendSync = useCallback((currentState: MockupState) => {
      if (!currentState.user) return;

      updateState({ isSyncing: true });
      
      StorageService.saveProject(currentState.user.uid, currentState).then((result) => {
          updateState({ isSyncing: false, lastSaved: Date.now() });
          
          if (result === 'local') {
              setSyncStatus('local_only');
          } else if (result === 'queued') {
              setSyncStatus('local_only');
              notify('Saved offline. Cloud sync will resume when a connection is available.', 'info');
          } else if (result === 'conflict') {
              setSyncStatus('error');
              setSyncConflict(true);
              notify('This project changed on another device. Choose which copy to keep.', 'warning');
          } else if (result === 'cloud') {
              setSyncStatus('synced');
              setLastCloudSavedAt(Date.now());
          } else {
              setSyncStatus('error');
              reportWarning('sync', 'Project save returned an error', { projectId: currentState.projectId });
          }
      }).catch(error => {
          updateState({ isSyncing: false });
          setSyncStatus('error');
          reportError('sync', error, { projectId: currentState.projectId });
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
      const remote = await StorageService.loadProjectCloud(state.user.uid, state.projectId);
      if (remote) {
          startSession({ ...remote, user: state.user, isOnline: navigator.onLine, isSyncing: false });
          setSyncConflict(false); setSyncStatus('synced');
          notify('Loaded the newer cloud version.', 'success');
      }
  };

  // Online/Offline Listeners
  useEffect(() => {
      const handleOnline = () => {
          updateState({ isOnline: true });
          if (stateRef.current.user && !stateRef.current.user.uid.startsWith('guest_')) {
             void StorageService.flushSyncQueue(stateRef.current.user.uid).finally(() => triggerBackendSync(stateRef.current));
          }
      };
      const handleOffline = () => updateState({ isOnline: false });

      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);

      return () => {
          window.removeEventListener('online', handleOnline);
          window.removeEventListener('offline', handleOffline);
      };
  }, [triggerBackendSync, updateState]);

  // Auto-save debounce
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
      if (state.user) {
          if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
          syncTimeoutRef.current = setTimeout(() => {
              triggerBackendSync(state);
          }, 3000); // 3s debounce
      }
      return () => {
          if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
      };
  }, [state.canvases, state.titleBlock, state.notes, state.referenceImages, state.siteCaptures, triggerBackendSync, state.user, state.projectName]);


  const activeCanvas = state.canvases.find(c => c.id === state.activeCanvasId) || state.canvases[0];

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

  const undo = useCallback(() => {
      if (historyIndex > 0) {
          const prevState = history[historyIndex - 1];
          // Keep the live session user — history snapshots must never log the user out
          setState(s => ({ ...prevState, user: s.user }));
          setHistoryIndex(prev => prev - 1);
      }
  }, [history, historyIndex]);

  const redo = useCallback(() => {
      if (historyIndex < history.length - 1) {
          const nextState = history[historyIndex + 1];
          setState(s => ({ ...nextState, user: s.user }));
          setHistoryIndex(prev => prev + 1);
      }
  }, [history, historyIndex]);

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
  const openCalibration = (options?: { addPlane?: boolean }) => {
      const existing = activeCanvas?.calibration ?? null;
      const existingPlanes = existing?.planes?.length
          ? existing.planes
          : existing?.plane ? [{ id: 'legacy-plane', name: 'Wall 1', ...existing.plane }] : [];
      const activeExistingPlane = existingPlanes.find(plane => plane.id === existing?.activePlaneId) ?? existingPlanes[0];
      const isPlane = !!existing?.plane && !options?.addPlane;
      setCalibrationDraft({
          stage: 'choose',
          method: options?.addPlane ? 'plane' : isPlane ? 'plane' : existing ? 'line' : null,
          points: options?.addPlane ? [] : activeExistingPlane ? [...activeExistingPlane.corners] : existing ? [existing.start, existing.end] : [],
          presetId: isPlane ? 'custom_plane' : existing ? 'custom' : 'door_height',
          value: existing && !isPlane ? String(existing.realValue) : '',
          width: options?.addPlane ? '0.813' : activeExistingPlane ? String(activeExistingPlane.widthMm / 1000) : '0.813',
          height: options?.addPlane ? '2.032' : activeExistingPlane ? String(activeExistingPlane.heightMm / 1000) : '2.032',
          unit: options?.addPlane ? 'mm' : isPlane ? 'm' : existing?.unit ?? 'm',
          reapply: false,
          planeName: options?.addPlane ? `Wall ${existingPlanes.length + 1}` : (activeExistingPlane?.name ?? 'Wall 1'),
          addPlane: !!options?.addPlane,
          editingPlaneId: options?.addPlane ? null : activeExistingPlane?.id ?? null,
          planeMode: activeExistingPlane?.calibrationKind === 'parallel-offset' ? 'parallel-offset' : 'known-size',
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
          // The AI cleanup pipeline can resize the image (max-dim cap), so the
          // old pixel scale is no longer trustworthy — require recalibration
          updateActiveCanvas({
              backgroundImage: newImageUrl,
              backgroundSize: { width: img.width, height: img.height },
              calibration: null,
              placement: activeCanvas ? { ...(activeCanvas.placement ?? { snapEnabled: true, showVanishingGuides: false, lens: { enabled: false, k1: 0, k2: 0 }, camera: { enabled: false, fieldOfViewDeg: 60, estimated: true } }), lens: { enabled: false, k1: 0, k2: 0 }, camera: { enabled: false, fieldOfViewDeg: 60, estimated: true } } : undefined,
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

  const handleProjectLoad = (loadedState: MockupState) => {
      // Ensure user context is preserved if needed, though loaded state should have data
      // We might want to keep the current session user info if the loaded project was anonymous
      const mergedState = {
          ...normalizeProjectState(loadedState),
          user: state.user // Keep current user
      };
      setState(mergedState);
      setHistory([mergedState]);
      setHistoryIndex(0);
  };

  const handleProjectSave = async (name: string) => {
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
      triggerBackendSync(newState);
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
      await StorageService.deleteProjectLocal(projectId);
      if (state.user && !state.user.uid.startsWith('guest_')) {
          await StorageService.deleteProjectCloud(state.user.uid, projectId);
      }
      if (projectId !== state.projectId) return;

      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
      const replacement = { ...getInitialState(), user: state.user, isOnline: state.isOnline, isSyncing: false };
      if (state.user?.uid.startsWith('guest_')) localStorage.setItem(GUEST_PROJECT_ID_KEY, replacement.projectId);
      startSession(replacement);
      await StorageService.saveProjectLocal(replacement);
  };

  const handleNewProject = async () => {
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
      setCalibrationDraft(null);
      setShowCalibrationReference(false);
      setIsCropping(false);
      const cleanState = createCleanProjectState(state.user, state.isOnline);
      if (state.user?.uid.startsWith('guest_')) localStorage.setItem(GUEST_PROJECT_ID_KEY, cleanState.projectId);
      startSession(cleanState);
      await StorageService.saveProjectLocal(cleanState);
      notify('New clean project started.', 'success');
  };

  const handlePromoteSiteCapture = async (capture: SiteCapturePhoto) => {
      if (capture.promotedCanvasId) return;
      let backgroundImage = capture.workingRef;
      if (capture.workingRef.startsWith('site-capture://')) {
          const blob = await getSiteCaptureAsset(capture.workingRef);
          if (!blob) throw new Error('The working photograph is missing from this device.');
          backgroundImage = await blobToDataUri(blob);
      }
      const current = stateRef.current;
      const newCanvas = createDefaultCanvas(current.canvases.length);
      const replaceableCanvas = current.canvases.length === 1 && !current.canvases[0].backgroundImage && current.canvases[0].signs.length === 0 && current.canvases[0].dimensions.length === 0 && !current.canvases[0].calibration;
      if (replaceableCanvas) newCanvas.id = current.canvases[0].id;
      newCanvas.name = capture.label;
      newCanvas.sheetTitle = capture.label.toUpperCase();
      newCanvas.backgroundImage = backgroundImage;
      newCanvas.backgroundSize = { width: capture.workingPixelWidth, height: capture.workingPixelHeight };
      const nextCaptures = (current.siteCaptures ?? []).map(item => item.id === capture.id ? { ...item, promotedCanvasId: newCanvas.id } : item);
      let titleBlock = current.titleBlock;
      if (capture.location?.address) {
          titleBlock = { ...titleBlock, fields: titleBlock.fields.map(field => field.label === 'ADDRESS' && !field.value ? { ...field, value: capture.location!.address! } : field) };
      }
      const nextCanvases = replaceableCanvas ? [newCanvas] : [...current.canvases, newCanvas];
      const next = { ...current, canvases: nextCanvases, activeCanvasId: newCanvas.id, siteCaptures: nextCaptures, titleBlock, lastSaved: Date.now() };
      stateRef.current = next;
      setState(next);
      addToHistory(next);
      notify(`${capture.label} is ready in the iPad and desktop editor.`, 'success');
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
        canUndo={historyIndex > 0}
        canRedo={historyIndex < history.length - 1}
        
        showAssistant={showAssistant}
        setShowAssistant={setShowAssistant}
        onOpenProjectManager={() => setShowProjectManager(true)}
      />
      <div className="flex-1 relative overflow-hidden bg-gray-950">
         <MockupCanvas
           images={{ background: activeCanvas.backgroundImage, backgroundSize: activeCanvas.backgroundSize }}
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
           canUndo={historyIndex > 0}
           canRedo={historyIndex < history.length - 1}
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
