
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleGenAI } from "@google/genai";
import { auth, googleProvider } from './firebase';

import ControlsPanel from './components/ControlsPanel';
import MockupCanvas from './components/MockupCanvas';
import CleanupTool from './components/CleanupTool';
import Assistant from './components/Assistant';
import ProjectManager from './components/ProjectManager';
import { MockupState, AppImages, Point, Sign, Dimension, TitleBlock, TitleBlockField, Canvas } from './types';
import { hexToRgb } from './utils/math';
import { TITLE_BLOCK_TEMPLATES } from './data/titleBlockTemplates';
import { StorageService } from './services/StorageService';
import { Wifi, WifiOff, RefreshCw, LogIn, LogOut, Loader2, AlertTriangle, User as UserIcon, HardDrive, Database, KeyRound, X as XIcon } from 'lucide-react';

// Declare globals for UMD libraries
declare global {
  interface Window {
    html2canvas: any;
    jspdf: any;
  }
}

// Placeholder images
const DEFAULT_BG = 'https://picsum.photos/1920/1080';
const DEFAULT_FG = 'https://picsum.photos/400/400';

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
  opacity: 0.95,
  blendMode: 'normal',
  sideColor: '#1e3a8a',
  image: DEFAULT_FG,
});

const createDefaultCanvas = (index: number): Canvas => ({
    id: `canvas-${Date.now()}`,
    name: `View ${index + 1}`,
    backgroundImage: DEFAULT_BG,
    backgroundSize: { width: 1920, height: 1080 },
    signs: [],
    activeSignId: null,
    dimensions: [],
    activeDimensionId: null,
    sheetTitle: `ELEVATION ${index + 1}`,
    sheetNumber: `A-${100 + index + 1}`
});

export type ToolMode = 'select' | 'draw_line' | 'draw_box';

const DEFAULT_FIELDS: TitleBlockField[] = [
    { id: '1', label: 'PROJECT TITLE', value: 'PROPOSED SIGNAGE INSTALLATION', section: 'project' },
    { id: '2', label: 'CLIENT', value: 'ACME Corp', section: 'project' },
    { id: '3', label: 'ADDRESS', value: '123 Innovation Drive, Tech City', section: 'project' },
    { id: '4', label: 'DRAWN BY', value: 'J. Doe', section: 'drawing' },
    { id: '5', label: 'CHECKED BY', value: '', section: 'drawing' },
    { id: '6', label: 'DATE', value: new Date().toLocaleDateString(), section: 'drawing' },
    { id: '7', label: 'SCALE', value: 'N.T.S.', section: 'drawing' },
    { id: '8', label: 'SHEET TITLE', value: '', section: 'sheet' },
    { id: '9', label: 'SHEET NO.', value: '', section: 'sheet' },
];

const getInitialState = (): MockupState => {
    const initialCanvas = createDefaultCanvas(0);
    const cx = 1920 / 2;
    const cy = 1080 / 2;
    const signId = Date.now().toString();
    initialCanvas.signs.push(createDefaultSign(signId, cx, cy, 0));
    initialCanvas.activeSignId = signId;

    return {
        user: null,
        projectId: `proj_${Date.now()}`,
        projectName: 'Untitled Project',
        canvases: [initialCanvas],
        activeCanvasId: initialCanvas.id,
        isNightMode: false,
        showDimensions: true,
        titleBlock: {
            enabled: false,
            viewMode: 'canvas',
            paperSize: 'A3',
            orientation: 'landscape',
            style: TITLE_BLOCK_TEMPLATES[0],
            logoImage: null,
            fields: DEFAULT_FIELDS,
            revisions: [
                { id: '1', rev: 'A', date: new Date().toLocaleDateString(), description: 'ISSUED FOR APPROVAL', drawnBy: 'JD' }
            ]
        },
        savedTemplates: [],
        notes: '',
        referenceImages: [],
        lastSaved: Date.now(),
        isOnline: navigator.onLine,
        isSyncing: false
    };
};

const App: React.FC = () => {
  const [state, setState] = useState<MockupState>(getInitialState);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  
  // Track sync status beyond just boolean
  const [syncStatus, setSyncStatus] = useState<'synced' | 'local_only' | 'error'>('synced');
  
  // History for Undo/Redo
  const [history, setHistory] = useState<MockupState[]>([state]);
  const [historyIndex, setHistoryIndex] = useState(0);
  // Ref mirrors historyIndex so addToHistory never captures a stale closure value
  const historyIndexRef = useRef(0);
  useEffect(() => { historyIndexRef.current = historyIndex; }, [historyIndex]);

  const [toolMode, setToolMode] = useState<ToolMode>('select');
  const [isCropping, setIsCropping] = useState(false);
  const [showCleanupTool, setShowCleanupTool] = useState(false);
  const [showAssistant, setShowAssistant] = useState(false);
  const [showProjectManager, setShowProjectManager] = useState(false);
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [geminiKey, setGeminiKey] = useState<string>(() => localStorage.getItem('gemini_api_key') ?? '');
  const effectiveApiKey = geminiKey.trim() || process.env.API_KEY;
  
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const handleGuestLogin = useCallback(() => {
      const guestId = 'guest_' + Date.now();
      const guestUser = {
          uid: guestId,
          displayName: 'Guest User',
          email: null,
          photoURL: null
      };

      const newState = { 
        ...getInitialState(),
        user: guestUser,
        isOnline: false
      };
      
      setState(newState);
      setIsAuthLoading(false);
  }, []);

  // --- Auth & Data Loading ---
  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged(async (firebaseUser) => {
      if (firebaseUser) {
        const user = {
          uid: firebaseUser.uid,
          displayName: firebaseUser.displayName,
          email: firebaseUser.email,
          photoURL: firebaseUser.photoURL,
        };
        // Try to load the most recent project from cloud, fall back to local
        const projects = await StorageService.listProjectsCloud(user.uid);
        if (projects.length > 0) {
          const latest = projects.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))[0];
          const loaded = await StorageService.loadProjectCloud(user.uid, latest.id);
          if (loaded) {
            setState({ ...loaded, user, isOnline: navigator.onLine, isSyncing: false });
            setIsAuthLoading(false);
            return;
          }
        }
        // No cloud project — start fresh
        setState({ ...getInitialState(), user, isOnline: navigator.onLine });
      } else {
        // Not signed in — show login screen
        setState(getInitialState());
      }
      setIsAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const handleLogin = async () => {
    setAuthError(null);
    try {
      await auth.signInWithPopup(googleProvider);
      // onAuthStateChanged above handles the rest
    } catch (err: any) {
      setAuthError(err.message ?? 'Sign-in failed. Please try again.');
    }
  };

  const handleLogout = async () => {
    await auth.signOut();
    setState(getInitialState());
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
          } else if (result === 'cloud') {
              setSyncStatus('synced');
          }
      });
  }, [updateState]);

  // Online/Offline Listeners
  useEffect(() => {
      const handleOnline = () => {
          updateState({ isOnline: true });
          if (stateRef.current.user && !stateRef.current.user.uid.startsWith('guest_')) {
             triggerBackendSync(stateRef.current);
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
  }, [state.canvases, state.titleBlock, state.notes, state.referenceImages, triggerBackendSync, state.user, state.projectName]);


  const activeCanvas = state.canvases.find(c => c.id === state.activeCanvasId) || state.canvases[0];

  const addToHistory = useCallback((newState: MockupState) => {
      setHistory(prev => {
          // Use the ref so this callback never captures a stale historyIndex value
          const newHistory = prev.slice(0, historyIndexRef.current + 1);
          newHistory.push(newState);
          if (newHistory.length > 20) newHistory.shift();
          return newHistory;
      });
      setHistoryIndex(prev => Math.min(prev + 1, 19));
  }, []); // stable — reads historyIndexRef.current at call time

  const undo = useCallback(() => {
      if (historyIndex > 0) {
          const prevState = history[historyIndex - 1];
          setState(prevState);
          setHistoryIndex(prev => prev - 1);
      }
  }, [history, historyIndex]);

  const redo = useCallback(() => {
      if (historyIndex < history.length - 1) {
          const nextState = history[historyIndex + 1];
          setState(nextState);
          setHistoryIndex(prev => prev + 1);
      }
  }, [history, historyIndex]);

  const updateStateWithHistory = useCallback((updates: Partial<MockupState>) => {
      setState(prev => {
          const newState = { ...prev, ...updates };
          addToHistory(newState);
          return newState;
      });
  }, [addToHistory]);

  const updateActiveCanvas = useCallback((canvasUpdates: Partial<Canvas>) => {
      setState(prev => {
          const newCanvases = prev.canvases.map(c => 
              c.id === prev.activeCanvasId ? { ...c, ...canvasUpdates } : c
          );
          return { ...prev, canvases: newCanvases };
      });
  }, []);
  
  const updateActiveCanvasWithHistory = useCallback((canvasUpdates: Partial<Canvas>) => {
      setState(prev => {
          const newCanvases = prev.canvases.map(c => 
              c.id === prev.activeCanvasId ? { ...c, ...canvasUpdates } : c
          );
          const newState = { ...prev, canvases: newCanvases };
          addToHistory(newState);
          return newState;
      });
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
          alert("Project must have at least one view.");
          return;
      }
      const newCanvases = state.canvases.filter(c => c.id !== state.activeCanvasId);
      updateStateWithHistory({
          canvases: newCanvases,
          activeCanvasId: newCanvases[0].id
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
      setState(prev => {
        const canvas = prev.canvases.find(c => c.id === prev.activeCanvasId);
        if (!canvas) return prev;
        const newSigns = canvas.signs.map(s => s.id === id ? { ...s, ...updates } : s);
        const newCanvas = { ...canvas, signs: newSigns };
        return {
            ...prev,
            canvases: prev.canvases.map(c => c.id === prev.activeCanvasId ? newCanvas : c)
        };
      });
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
      const newDim: Dimension = { id, variant, type, start, end, text: '...', color: '#ffffff' };
      updateActiveCanvasWithHistory({
          dimensions: [...activeCanvas.dimensions, newDim],
          activeDimensionId: id,
          activeSignId: null
      });
      updateState({ showDimensions: true });
      setToolMode('select');
  };

  const updateDimension = useCallback((id: string, updates: Partial<Dimension>) => {
    setState(prev => {
        const canvas = prev.canvases.find(c => c.id === prev.activeCanvasId);
        if (!canvas) return prev;
        const newDims = canvas.dimensions.map(d => d.id === id ? { ...d, ...updates } : d);
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
  const handleImageUpload = (file: File, type: 'background' | 'foreground' | 'logo') => {
    const reader = new FileReader();
    reader.onload = (e) => {
      if (e.target?.result && typeof e.target.result === 'string') {
        if (type === 'background') {
          const img = new Image();
          img.onload = () => {
             updateActiveCanvas({
                 backgroundImage: e.target!.result as string,
                 backgroundSize: { width: img.width, height: img.height }
             });
          }
          img.src = e.target.result;
        } else if (type === 'logo') {
           // Use functional setState so we never close over a stale titleBlock
           setState(prev => ({ ...prev, titleBlock: { ...prev.titleBlock, logoImage: e.target!.result as string } }));
        } else {
           if (activeCanvas?.activeSignId) {
             updateActiveSign({ image: e.target.result as string });
           }
        }
      }
    };
    reader.readAsDataURL(file);
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
    updateActiveCanvasWithHistory({
        backgroundImage: newImageUrl,
        backgroundSize: newSize,
        signs: newSigns,
        dimensions: newDims
    });
    setIsCropping(false);
  };
  
  const handleCleanupSave = (newImageUrl: string) => {
      const img = new Image();
      img.onload = () => {
          updateActiveCanvas({
              backgroundImage: newImageUrl,
              backgroundSize: { width: img.width, height: img.height }
          });
          setShowCleanupTool(false);
      };
      img.src = newImageUrl;
  };
  
  const handleDownload = async () => {
    const element = document.getElementById('export-target');
    if (!element || !window.html2canvas || !window.jspdf) return;

    const prevCursor = document.body.style.cursor;
    document.body.style.cursor = 'wait';

    try {
        const canvas = await window.html2canvas(element, {
            useCORS: true,
            allowTaint: true,
            backgroundColor: null,
            scale: 2, 
            logging: false,
            onclone: (clonedDoc: Document) => {
                const clonedElement = clonedDoc.getElementById('export-target');
                if (clonedElement) {
                    clonedElement.style.transform = 'none';
                    clonedElement.style.margin = '0';
                    clonedElement.style.boxShadow = 'none'; 
                }
            }
        });

        const imgData = canvas.toDataURL('image/png');

        if (state.titleBlock.viewMode === 'sheet') {
            const { paperSize, orientation } = state.titleBlock;
            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF({
                orientation: orientation,
                unit: 'mm',
                format: paperSize.toLowerCase()
            });

            const pdfWidth = pdf.internal.pageSize.getWidth();
            const pdfHeight = pdf.internal.pageSize.getHeight();
            
            pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
            pdf.save(`${activeCanvas.sheetNumber || 'presentation'}.pdf`);
        } else {
            const link = document.createElement('a');
            link.href = imgData;
            link.download = `${activeCanvas.name || 'mockup'}.png`;
            link.click();
        }
    } catch (error) {
        console.error("Export failed:", error);
        alert("Export failed. Please check console for details.");
    } finally {
        document.body.style.cursor = prevCursor;
    }
  };

  const handleProjectLoad = (loadedState: MockupState) => {
      // Ensure user context is preserved if needed, though loaded state should have data
      // We might want to keep the current session user info if the loaded project was anonymous
      const mergedState = {
          ...loadedState,
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
      if (element && window.html2canvas) {
           try {
               const canvas = await window.html2canvas(element, { scale: 0.2, logging: false, useCORS: true });
               thumbnail = canvas.toDataURL('image/jpeg', 0.7);
           } catch (e) { console.warn("Thumbnail generation failed", e); }
      }

      await StorageService.saveProjectLocal(newState, thumbnail);
      // Also trigger cloud sync if needed
      triggerBackendSync(newState);
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
                      className="w-full bg-white hover:bg-gray-100 text-gray-900 font-bold py-3 px-4 rounded-lg transition-colors flex items-center justify-center gap-3 mb-3 opacity-60"
                      title="Temporarily disabled"
                  >
                      <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" className="w-5 h-5" alt="" />
                      Sign in with Google
                  </button>

                  <button 
                      onClick={handleGuestLogin}
                      className="w-full bg-gray-800 hover:bg-gray-700 text-gray-300 font-semibold py-3 px-4 rounded-lg transition-colors flex items-center justify-center gap-3"
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

  if (!activeCanvas) return null;

  return (
    <div className="flex flex-col-reverse lg:flex-row w-full h-full bg-black overflow-hidden relative">
      {/* Top Bar Status */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 pointer-events-none flex items-center gap-2">
          {!state.isOnline && !state.user.uid.startsWith('guest_') && (
              <div className="bg-red-600/90 text-white px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1 shadow-lg backdrop-blur">
                  <WifiOff className="w-3 h-3" /> Offline Mode
              </div>
          )}
          {state.user.uid.startsWith('guest_') && (
              <div className="bg-gray-700/90 text-gray-300 px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1 shadow-lg backdrop-blur border border-gray-600">
                  <UserIcon className="w-3 h-3" /> Guest Mode (Local)
              </div>
          )}
          {state.isSyncing && state.isOnline && (
              <div className="bg-blue-600/90 text-white px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1 shadow-lg backdrop-blur">
                  <RefreshCw className="w-3 h-3 animate-spin" /> Syncing...
              </div>
          )}
          {/* New Status for Local Only Mode due to large payload */}
          {syncStatus === 'local_only' && !state.user.uid.startsWith('guest_') && (
              <div className="bg-green-600/90 text-white px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1 shadow-lg backdrop-blur" title="Project saved to local database.">
                  <Database className="w-3 h-3" /> Saved Locally
              </div>
          )}
      </div>

      {/* User Profile / Logout (Top Right) */}
      <div className="absolute top-4 right-4 z-50 flex items-center gap-3 bg-gray-900/80 backdrop-blur p-1 pr-3 rounded-full border border-gray-700">
          <img src={state.user.photoURL || 'https://via.placeholder.com/32'} className="w-8 h-8 rounded-full border border-gray-600" alt="User" />
          <span className="text-xs font-medium text-gray-300 hidden md:block">{state.user.displayName}</span>
          <button onClick={() => setShowApiKeyModal(true)} className={`p-1.5 rounded-full transition-colors ${geminiKey.trim() ? 'text-green-400 hover:bg-green-500/20' : 'text-yellow-400 hover:bg-yellow-500/20'}`} title={geminiKey.trim() ? 'Gemini API Key set (your key)' : 'Set your Gemini API Key'}>
              <KeyRound className="w-4 h-4" />
          </button>
          <button onClick={handleLogout} className="p-1.5 hover:bg-red-500/20 hover:text-red-400 text-gray-400 rounded-full transition-colors" title="Sign Out">
              <LogOut className="w-4 h-4" />
          </button>
      </div>

      {/* Gemini API Key Modal */}
      {showApiKeyModal && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[200] flex items-center justify-center p-4" onClick={() => setShowApiKeyModal(false)}>
              <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center justify-between mb-4">
                      <h2 className="text-white font-bold text-lg flex items-center gap-2"><KeyRound className="w-5 h-5 text-yellow-400" /> Gemini AI Settings</h2>
                      <button onClick={() => setShowApiKeyModal(false)} className="text-gray-400 hover:text-white"><XIcon className="w-5 h-5" /></button>
                  </div>
                  <p className="text-gray-400 text-sm mb-4">
                      Enter your own <strong className="text-white">Google Gemini API key</strong> to use AI features (Pro Guide &amp; Magic Cleanup) on your own quota. Leave blank to use the shared key (Sign Image account).
                  </p>
                  <input
                      type="password"
                      placeholder="AIza..."
                      value={geminiKey}
                      onChange={e => setGeminiKey(e.target.value)}
                      className="w-full bg-gray-800 border border-gray-600 text-white px-3 py-2 rounded-lg text-sm font-mono mb-4 focus:outline-none focus:border-blue-500"
                  />
                  <div className="flex gap-2">
                      <button onClick={() => { localStorage.setItem('gemini_api_key', geminiKey.trim()); setShowApiKeyModal(false); }} className="flex-1 bg-blue-600 hover:bg-blue-500 text-white py-2 rounded-lg text-sm font-semibold transition-colors">Save Key</button>
                      {geminiKey.trim() && (
                          <button onClick={() => { setGeminiKey(''); localStorage.removeItem('gemini_api_key'); }} className="px-4 bg-gray-700 hover:bg-gray-600 text-red-400 py-2 rounded-lg text-sm transition-colors">Clear</button>
                      )}
                  </div>
                  {!geminiKey.trim() && !process.env.API_KEY && (
                      <p className="text-red-400 text-xs mt-3 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> No key available — AI features will be disabled.</p>
                  )}
              </div>
          </div>
      )}

      <Assistant isOpen={showAssistant} setIsOpen={setShowAssistant} apiKey={effectiveApiKey} />
      
      <ControlsPanel
        state={state}
        activeCanvas={activeCanvas}
        updateState={updateState}
        updateStateWithHistory={updateStateWithHistory}
        updateActiveCanvas={updateActiveCanvas}
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
           
           state={state}
           titleBlock={{ ...state.titleBlock, fields: state.titleBlock.fields.map(f => {
              if (f.label === 'SHEET TITLE') return { ...f, value: activeCanvas.sheetTitle || f.value };
              if (f.label === 'SHEET NO.') return { ...f, value: activeCanvas.sheetNumber || f.value };
              return f;
           })}}

           toolMode={toolMode}
           onDrawComplete={handleDrawComplete}
           updateSignById={updateSignById}
           setActiveSign={setActiveSign}
           updateDimension={updateDimension}
           setActiveDimension={setActiveDimension}
           updateTitleBlock={updateTitleBlock}
           setCanvasRef={(ref) => canvasRef.current = ref}
           isCropping={isCropping}
           onCropConfirm={handleCrop}
           onCancelCrop={() => setIsCropping(false)}
         />
      </div>

      {showProjectManager && (
          <ProjectManager 
              isOpen={showProjectManager}
              onClose={() => setShowProjectManager(false)}
              currentState={state}
              onLoadProject={handleProjectLoad}
              onSaveProject={handleProjectSave}
          />
      )}

      {showCleanupTool && (
        <CleanupTool 
           isOpen={showCleanupTool}
           imageUrl={activeCanvas.backgroundImage}
           onClose={() => setShowCleanupTool(false)}
           onSave={handleCleanupSave}
           apiKey={effectiveApiKey}
        />
      )}
    </div>
  );
};

export default App;
