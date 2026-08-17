import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight, Camera, Check, ChevronDown, Cloud, CloudOff, FolderOpen, Images,
  ImagePlus, Loader2, LogOut, MapPin, Mic, NotebookPen, Plus, Ruler, Save, Square, Trash2, WifiOff, X,
} from 'lucide-react';
import { MeasureUnit, MockupState, ProjectMetadata, ReferenceWallFieldMeasurement, SiteCapturePhoto, SiteCaptureSupportingPhoto } from '../types';
import { currentCoordinates, reverseGeocode } from '../services/PhotoLocationService';
import { optimizeImageBlob, readImageDimensions } from '../services/imageProcessing';
import {
  deleteSiteCaptureAssets, getSiteCaptureAsset, makeSiteCaptureAssetRef, putSiteCaptureAsset, StorageService,
} from '../services/StorageService';
import { transcribeAudio } from '../services/GeminiService';
import { notify } from '../services/toast';
import { displayMeasurement, parseSpokenMeasurementMm } from '../utils/fieldMeasurements';
import { normalizeProjectState } from '../utils/projectMigration';

type MobileTab = 'capture' | 'views' | 'measure' | 'notes';
type DictationState = 'idle' | 'listening' | 'recording' | 'transcribing';
type CaptureIntent = 'new-elevation' | 'same-elevation';
type CaptureRequest = { intent: CaptureIntent; targetCaptureId: string | null; projectId: string; epoch: number };

class CaptureContextChangedError extends Error {}

interface MobileSiteCaptureProps {
  state: MockupState;
  syncStatus: 'synced' | 'local_only' | 'error';
  onUpdate: (updates: Partial<MockupState>) => void;
  onLoadProject: (state: MockupState) => void;
  onNewProject: () => Promise<void>;
  onSaveProject: (name: string) => Promise<void>;
  onPromoteCapture: (capture: SiteCapturePhoto) => Promise<void>;
  onLogout: () => Promise<void>;
}

const DIRECT_ASSET = /^(https?:|data:|blob:)/;

const CaptureImage: React.FC<{ assetRef: string; alt: string; className?: string }> = ({ assetRef, alt, className }) => {
  const [src, setSrc] = useState(DIRECT_ASSET.test(assetRef) ? assetRef : '');
  useEffect(() => {
    if (DIRECT_ASSET.test(assetRef)) { setSrc(assetRef); return; }
    let objectUrl = '';
    let active = true;
    getSiteCaptureAsset(assetRef).then(blob => {
      if (!active || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setSrc(objectUrl);
    });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [assetRef]);
  return src
    ? <img src={src} alt={alt} className={className} />
    : <div className={`${className ?? ''} grid place-items-center bg-slate-900 text-slate-600`}><Images className="h-7 w-7" /></div>;
};

const CameraLevelGuide: React.FC = () => (
  <div className="pointer-events-none absolute inset-0 z-10" data-testid="camera-level-guide" aria-hidden="true">
    <div className="absolute left-1/2 top-1/2 flex w-[78%] -translate-x-1/2 -translate-y-1/2 items-center drop-shadow-[0_1px_2px_rgba(0,0,0,0.95)]">
      <span className="h-px flex-1 bg-white/95" />
      <span className="relative h-4 w-4 shrink-0 rounded-full border-2 border-white bg-emerald-400/80 shadow-[0_0_0_2px_rgba(0,0,0,0.45)]">
        <span className="absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white" />
      </span>
      <span className="h-px flex-1 bg-white/95" />
    </div>
    <div className="absolute left-1/2 top-[calc(50%+1.15rem)] -translate-x-1/2 rounded-full bg-black/55 px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.18em] text-white/90 backdrop-blur-sm">
      Level guide
    </div>
  </div>
);

const DictationButton: React.FC<{
  onTranscript: (text: string) => void;
  disabled?: boolean;
  label: string;
}> = ({ onTranscript, disabled, label }) => {
  const [status, setStatus] = useState<DictationState>('idle');
  const recognitionRef = useRef<any>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const forceRecorderRef = useRef(false);
  const timeoutRef = useRef<number | null>(null);
  const sessionRef = useRef(0);

  useEffect(() => {
    const stopActiveDictation = () => {
      sessionRef.current += 1;
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      try { recognitionRef.current?.abort(); } catch { /* already stopped */ }
      recognitionRef.current = null;
      const recorder = recorderRef.current;
      recorderRef.current = null;
      chunksRef.current = [];
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        if (recorder.state === 'recording') recorder.stop();
      }
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    };
    const stopWhenInactive = () => { if (document.visibilityState === 'hidden') stopActiveDictation(); };
    document.addEventListener('visibilitychange', stopWhenInactive);
    window.addEventListener('pagehide', stopActiveDictation);
    return () => {
      document.removeEventListener('visibilitychange', stopWhenInactive);
      window.removeEventListener('pagehide', stopActiveDictation);
      stopActiveDictation();
    };
  }, []);

  const transcribeRecording = async (blob: Blob, session: number) => {
    setStatus('transcribing');
    try {
      const transcript = await transcribeAudio(blob);
      if (session === sessionRef.current && document.visibilityState !== 'hidden') onTranscript(transcript);
    } catch (error) {
      if (session === sessionRef.current && document.visibilityState !== 'hidden') {
        notify(error instanceof Error ? error.message : 'Dictation could not be transcribed.', 'error');
      }
    } finally {
      if (session === sessionRef.current) setStatus('idle');
    }
  };

  const startRecorder = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      notify('Use the microphone on your phone keyboard for dictation on this browser.', 'warning');
      return;
    }
    const session = ++sessionRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (session !== sessionRef.current || document.visibilityState === 'hidden') {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      streamRef.current = stream;
      const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];
      const mimeType = candidates.find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = event => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
        stream.getTracks().forEach(track => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' });
        if (session !== sessionRef.current || document.visibilityState === 'hidden') {
          chunksRef.current = [];
          setStatus('idle');
          return;
        }
        if (blob.size > 0) void transcribeRecording(blob, session); else setStatus('idle');
      };
      recorder.start(500);
      setStatus('recording');
      timeoutRef.current = window.setTimeout(() => recorder.state === 'recording' && recorder.stop(), 55_000);
    } catch {
      setStatus('idle');
      notify('Microphone permission was not granted. You can still use keyboard dictation.', 'warning');
    }
  };

  const start = () => {
    if (status === 'recording') { recorderRef.current?.stop(); return; }
    if (status !== 'idle' || disabled) return;
    const Recognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Recognition || forceRecorderRef.current) { void startRecorder(); return; }
    const session = ++sessionRef.current;
    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = navigator.language || 'en-US';
    recognition.onstart = () => { if (session === sessionRef.current) setStatus('listening'); };
    recognition.onresult = (event: any) => {
      if (session === sessionRef.current && document.visibilityState !== 'hidden') {
        onTranscript(event.results[0][0].transcript);
      }
      try { recognition.stop(); } catch { /* recognition already completed */ }
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      if (session === sessionRef.current) setStatus('idle');
    };
    recognition.onerror = (event: any) => {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      if (session !== sessionRef.current) return;
      setStatus('idle');
      if (event.error !== 'not-allowed') {
        forceRecorderRef.current = true;
        notify('Live dictation was unavailable. Tap again to use recorded dictation.', 'info');
      }
    };
    recognition.start();
  };

  const busy = status !== 'idle';
  return (
    <button type="button" onClick={start} disabled={disabled || status === 'transcribing'} aria-label={`${label}${status === 'recording' ? ' — stop recording' : ''}`} className={`grid h-12 w-12 shrink-0 place-items-center rounded-xl border transition ${status === 'recording' ? 'border-red-400 bg-red-500/20 text-red-300 animate-pulse' : busy ? 'border-orange-400/50 bg-orange-400/15 text-orange-200' : 'border-slate-700 bg-slate-900 text-slate-300 active:scale-95'}`}>
      {status === 'transcribing' ? <Loader2 className="h-5 w-5 animate-spin" /> : status === 'recording' ? <Square className="h-4 w-4 fill-current" /> : <Mic className="h-5 w-5" />}
    </button>
  );
};

const MeasurementField: React.FC<{
  label: string;
  valueMm: number | undefined;
  unit: MeasureUnit;
  onChange: (valueMm: number | undefined) => void;
}> = ({ label, valueMm, unit, onChange }) => (
  <label className="block rounded-2xl border border-slate-800 bg-[#111821] p-3">
    <span className="mb-2 block text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">{label}</span>
    <span className="flex items-center gap-2">
      <input inputMode="decimal" type="number" min="0" step="any" value={displayMeasurement(valueMm, unit)} onChange={event => onChange(event.target.value === '' ? undefined : parseSpokenMeasurementMm(event.target.value, unit) ?? undefined)} className="h-12 min-w-0 flex-1 rounded-xl border border-slate-700 bg-[#090d12] px-3 font-mono text-lg text-white outline-none focus:border-orange-400" aria-label={`${label} in ${unit}`} />
      <span className="w-7 text-xs font-bold text-orange-300">{unit}</span>
      <DictationButton label={`Dictate ${label.toLowerCase()}`} onTranscript={text => {
        const mm = parseSpokenMeasurementMm(text, unit);
        if (mm === null) notify(`I could not find a measurement in “${text}”.`, 'warning'); else onChange(mm);
      }} />
    </span>
  </label>
);

const MobileSiteCapture: React.FC<MobileSiteCaptureProps> = ({ state, syncStatus, onUpdate, onLoadProject, onNewProject, onSaveProject, onPromoteCapture, onLogout }) => {
  const captures = state.siteCaptures ?? [];
  const [tab, setTab] = useState<MobileTab>('capture');
  const [activeCaptureId, setActiveCaptureId] = useState<string | null>(captures[0]?.id ?? null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectMetadata[]>([]);
  const [projectNameDraft, setProjectNameDraft] = useState(state.projectName);
  const [isSavingProject, setIsSavingProject] = useState(false);
  const [cameraPreviewOpen, setCameraPreviewOpen] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraCapturing, setCameraCapturing] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState(state.projectId);
  const [measurementUnit, setMeasurementUnit] = useState<MeasureUnit>('m');
  const captureProjectIdRef = useRef(state.projectId);
  const captureRequestEpochRef = useRef(0);
  const captureRequestRef = useRef<CaptureRequest>({
    intent: 'new-elevation', targetCaptureId: null, projectId: state.projectId, epoch: 0,
  });
  const captureChooserOpenRef = useRef(false);
  const capturesRef = useRef(captures);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const cameraSessionRef = useRef(0);
  const cameraCaptureSessionRef = useRef<number | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const activeCapture = captures.find(capture => capture.id === activeCaptureId) ?? captures[0] ?? null;

  const stopCameraTracks = () => {
    const stream = cameraStreamRef.current;
    if (!stream) return;
    cameraStreamRef.current = null;
    stream.getTracks().forEach(track => track.stop());
  };

  if (captureProjectIdRef.current !== state.projectId) {
    captureProjectIdRef.current = state.projectId;
    captureRequestEpochRef.current += 1;
    if (!captureChooserOpenRef.current) {
      captureRequestRef.current = {
        intent: 'new-elevation', targetCaptureId: null, projectId: state.projectId, epoch: captureRequestEpochRef.current,
      };
    }
  }

  useEffect(() => {
    if (!activeCaptureId && captures[0]) setActiveCaptureId(captures[0].id);
  }, [captures, activeCaptureId]);
  useEffect(() => { capturesRef.current = captures; }, [captures]);
  useEffect(() => {
    captureRequestRef.current = {
      intent: 'new-elevation', targetCaptureId: null, projectId: captureProjectIdRef.current, epoch: captureRequestEpochRef.current,
    };
    return () => { captureRequestEpochRef.current += 1; };
  }, []);
  useEffect(() => {
    const video = cameraVideoRef.current;
    if (!video || !cameraStream) return;
    video.srcObject = cameraStream;
    void video.play().catch(() => undefined);
    return () => {
      video.pause();
      video.srcObject = null;
    };
  }, [cameraStream, cameraPreviewOpen]);
  useEffect(() => {
    const stopCameraForInactiveApp = () => {
      cameraSessionRef.current += 1;
      setCameraPreviewOpen(false);
      stopCameraTracks();
      setCameraStream(null);
    };
    const stopWhenHidden = () => { if (document.visibilityState === 'hidden') stopCameraForInactiveApp(); };
    document.addEventListener('visibilitychange', stopWhenHidden);
    window.addEventListener('pagehide', stopCameraForInactiveApp);
    return () => {
      document.removeEventListener('visibilitychange', stopWhenHidden);
      window.removeEventListener('pagehide', stopCameraForInactiveApp);
      cameraSessionRef.current += 1;
      stopCameraTracks();
    };
  }, []);

  const patchCapture = (id: string, updates: Partial<SiteCapturePhoto>) => {
    onUpdate({
      siteCaptures: captures.map(capture => capture.id === id ? { ...capture, ...updates } : capture),
      lastSaved: Date.now(),
    });
  };

  const patchReferenceWall = (updates: Partial<ReferenceWallFieldMeasurement>) => {
    if (!activeCapture) return;
    patchCapture(activeCapture.id, { referenceWall: { ...activeCapture.referenceWall, ...updates } });
  };

  const closeCameraPreview = () => {
    cameraSessionRef.current += 1;
    cameraCaptureSessionRef.current = null;
    setCameraPreviewOpen(false);
    setCameraStarting(false);
    setCameraReady(false);
    setCameraCapturing(false);
    setCameraError(null);
    stopCameraTracks();
    setCameraStream(null);
  };

  const openDeviceCameraFallback = () => {
    if (cameraCaptureSessionRef.current !== null) return;
    closeCameraPreview();
    captureChooserOpenRef.current = true;
    fileInputRef.current?.click();
  };

  const choosePhoto = async (intent: CaptureIntent, targetCaptureId = activeCapture?.id ?? null) => {
    captureRequestRef.current = {
      intent,
      targetCaptureId: intent === 'same-elevation' ? targetCaptureId : null,
      projectId: state.projectId,
      epoch: captureRequestEpochRef.current,
    };
    setCameraPreviewOpen(true);
    setCameraStarting(true);
    setCameraReady(false);
    setCameraError(null);
    const session = ++cameraSessionRef.current;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera preview is unavailable in this browser.');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1920 } },
        audio: false,
      });
      if (session !== cameraSessionRef.current || captureRequestRef.current.projectId !== captureProjectIdRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      cameraStreamRef.current = stream;
      setCameraStream(stream);
    } catch {
      if (session !== cameraSessionRef.current) return;
      setCameraError('Live preview could not start. You can still use the device camera.');
    } finally {
      if (session === cameraSessionRef.current) setCameraStarting(false);
    }
  };

  const captureCameraFrame = async () => {
    const video = cameraVideoRef.current;
    const session = cameraSessionRef.current;
    if (
      !video || !cameraReady || cameraCaptureSessionRef.current !== null
      || video.readyState < 2 || !video.videoWidth || !video.videoHeight
    ) return;
    cameraCaptureSessionRef.current = session;
    setCameraCapturing(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Camera canvas is unavailable.');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.94));
      if (!blob) throw new Error('The camera frame could not be encoded.');
      if (session !== cameraSessionRef.current || captureProjectIdRef.current !== captureRequestRef.current.projectId) return;
      const request = captureRequestRef.current;
      const file = new File([blob], `guided-site-photo-${Date.now()}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
      closeCameraPreview();
      await capturePhoto(file, request);
    } catch {
      if (session === cameraSessionRef.current) {
        notify('The guided photo could not be captured. Try again or use the full-resolution camera.', 'error');
      }
    } finally {
      if (cameraCaptureSessionRef.current === session) {
        cameraCaptureSessionRef.current = null;
        setCameraCapturing(false);
      }
    }
  };

  const capturePhoto = async (file: File, request: CaptureRequest) => {
    setIsProcessing(true);
    const id = `capture_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const assertCurrentRequest = () => {
      if (request.epoch !== captureRequestEpochRef.current || request.projectId !== captureProjectIdRef.current) {
        throw new CaptureContextChangedError('Photo discarded because the active project changed.');
      }
    };
    try {
      assertCurrentRequest();
      await navigator.storage?.persist?.().catch(() => false);
      const dimensions = await readImageDimensions(file);
      const workingBlob = await optimizeImageBlob(file, 4096);
      const workingDimensions = await readImageDimensions(workingBlob);
      const thumbnailBlob = await optimizeImageBlob(file, 720);
      assertCurrentRequest();
      const originalRef = makeSiteCaptureAssetRef(request.projectId, id, 'original');
      const workingRef = makeSiteCaptureAssetRef(request.projectId, id, 'working');
      const thumbnailRef = makeSiteCaptureAssetRef(request.projectId, id, 'thumbnail');
      await Promise.all([
        putSiteCaptureAsset(originalRef, file),
        putSiteCaptureAsset(workingRef, workingBlob),
        putSiteCaptureAsset(thumbnailRef, thumbnailBlob),
      ]);
      assertCurrentRequest();

      const photo: SiteCaptureSupportingPhoto = {
        id,
        originalRef,
        workingRef,
        thumbnailRef,
        fileName: file.name || `site-photo-${Date.now()}.jpg`,
        mimeType: file.type || 'image/jpeg',
        byteSize: file.size,
        pixelWidth: dimensions.width,
        pixelHeight: dimensions.height,
        workingPixelWidth: workingDimensions.width,
        workingPixelHeight: workingDimensions.height,
        capturedAt: Date.now(),
      };

      const latestCaptures = capturesRef.current;
      const targetCapture = latestCaptures.find(capture => capture.id === request.targetCaptureId);
      if (request.intent === 'same-elevation') {
        if (!targetCapture) {
          throw new CaptureContextChangedError('Photo discarded because the selected elevation no longer exists.');
        }
        onUpdate({
          siteCaptures: latestCaptures.map(capture => capture.id === targetCapture.id
            ? { ...capture, supportingPhotos: [...(capture.supportingPhotos ?? []), photo] }
            : capture),
          lastSaved: Date.now(),
        });
        setTab('views');
        notify(`Photo added to ${targetCapture.label}.`, 'success');
        return;
      }

      let location: SiteCapturePhoto['location'];
      try {
        const coordinates = await currentCoordinates();
        location = { ...coordinates };
        try { location.address = (await reverseGeocode(coordinates, 'device')).address; } catch { /* coordinates remain useful */ }
      } catch { /* location is optional */ }
      assertCurrentRequest();
      const commitCaptures = capturesRef.current;

      const capture: SiteCapturePhoto = {
        ...photo,
        label: `Elevation ${commitCaptures.length + 1}`,
        notes: '',
        location,
        supportingPhotos: [],
        referenceWall: {
          wallName: 'Reference wall',
          planeDepthMm: 0,
          planeDepthDirection: 'behind',
          referencePlaneName: 'Main façade',
          method: 'laser',
          notes: '',
        },
      };
      onUpdate({ siteCaptures: [...commitCaptures, capture], lastSaved: Date.now() });
      setActiveCaptureId(id);
      setTab('measure');
      notify('Original photo saved. Add the field measurements for this elevation.', 'success');
    } catch (error) {
      await deleteSiteCaptureAssets(request.projectId, id).catch(() => undefined);
      notify(
        error instanceof Error ? error.message : 'The photograph could not be saved.',
        error instanceof CaptureContextChangedError ? 'info' : 'error',
      );
    } finally {
      setIsProcessing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const openProjectPicker = async () => {
    setProjectNameDraft(state.projectName);
    setSelectedProjectId(state.projectId);
    setProjects(await StorageService.listProjects(state.user?.uid ?? 'guest_unknown'));
    setProjectPickerOpen(true);
  };

  const saveCurrentProject = async () => {
    const name = projectNameDraft.trim();
    if (!name) {
      notify('Enter a project name before saving.', 'warning');
      return;
    }
    setIsSavingProject(true);
    try {
      await onSaveProject(name);
      (document.activeElement as HTMLElement | null)?.blur();
      setSelectedProjectId(state.projectId);
      setProjects(await StorageService.listProjects(state.user?.uid ?? 'guest_unknown'));
      notify(`${name} saved.`, 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The project could not be saved.', 'error');
    } finally {
      setIsSavingProject(false);
    }
  };

  const loadProject = async (projectId: string) => {
    captureRequestEpochRef.current += 1;
    const project = await StorageService.loadProject(state.user?.uid ?? 'guest_unknown', projectId);
    if (project) onLoadProject(normalizeProjectState(project));
    setProjectPickerOpen(false);
  };

  const deleteCapture = async (capture: SiteCapturePhoto) => {
    if (!window.confirm(`Delete ${capture.label} and all of its photographs?`)) return;
    onUpdate({ siteCaptures: captures.filter(item => item.id !== capture.id), lastSaved: Date.now() });
    if (activeCaptureId === capture.id) setActiveCaptureId(captures.find(item => item.id !== capture.id)?.id ?? null);
  };

  const appendProjectNote = (text: string) => onUpdate({ notes: state.notes ? `${state.notes} ${text}` : text, lastSaved: Date.now() });
  const appendCaptureNote = (text: string) => activeCapture && patchCapture(activeCapture.id, { notes: activeCapture.notes ? `${activeCapture.notes} ${text}` : text });

  const syncLabel = !state.isOnline ? 'Offline — saved on phone' : state.isSyncing ? 'Uploading project' : syncStatus === 'synced' ? 'Cloud saved' : syncStatus === 'error' ? 'Sync needs attention' : 'Saved on phone';

  return (
    <div className="fixed inset-0 z-[100] flex flex-col overflow-hidden bg-[#080c11] text-slate-100" data-testid="mobile-site-capture">
      <input ref={fileInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={event => {
        captureChooserOpenRef.current = false;
        if (event.target.files?.[0]) void capturePhoto(event.target.files[0], captureRequestRef.current);
      }} />
      {cameraPreviewOpen && (
        <div className="fixed inset-0 z-[130] flex flex-col bg-black text-white" role="dialog" aria-modal="true" aria-label="Site camera with level guide">
          <div className="relative min-h-0 flex-1 overflow-hidden bg-[#05080b]">
            <video
              ref={cameraVideoRef}
              autoPlay
              muted
              playsInline
              onLoadedData={() => setCameraReady(true)}
              onCanPlay={() => setCameraReady(true)}
              className="h-full w-full object-cover"
              aria-label="Live rear camera preview"
            />
            <CameraLevelGuide />
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-28 bg-gradient-to-b from-black/75 to-transparent" />
            <button type="button" onClick={closeCameraPreview} className="absolute right-4 top-[max(1rem,env(safe-area-inset-top))] z-30 grid h-12 w-12 place-items-center rounded-full border border-white/25 bg-black/55 backdrop-blur-md" aria-label="Close camera"><X className="h-6 w-6" /></button>
            <div className="absolute left-4 top-[max(1.1rem,env(safe-area-inset-top))] z-30 rounded-full border border-white/20 bg-black/55 px-3 py-2 text-[10px] font-black uppercase tracking-[0.18em] backdrop-blur-md">Align the building with the line</div>
            {(cameraStarting || cameraError) && (
              <div className="absolute inset-0 z-20 grid place-items-center bg-black/65 px-8 text-center backdrop-blur-sm">
                {cameraStarting ? <div><Loader2 className="mx-auto h-9 w-9 animate-spin text-orange-400" /><p className="mt-4 text-sm font-semibold">Starting rear camera…</p></div> : <div><Camera className="mx-auto h-10 w-10 text-slate-400" /><p className="mt-4 text-sm font-semibold">{cameraError}</p><button type="button" onClick={openDeviceCameraFallback} className="mt-5 min-h-12 rounded-2xl bg-white px-5 text-xs font-black uppercase tracking-[0.12em] text-black"><ImagePlus className="mr-2 inline h-4 w-4" />Use full-resolution camera</button></div>}
              </div>
            )}
          </div>
          <div className="shrink-0 border-t border-white/10 bg-[#080c11] px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
            <div className="mx-auto grid max-w-md grid-cols-[1fr_auto_1fr] items-end gap-4">
              <button type="button" onClick={openDeviceCameraFallback} disabled={cameraCapturing} className="flex min-h-16 flex-col items-center justify-center rounded-2xl border border-white/15 bg-white/5 px-2 text-[9px] font-black uppercase tracking-[0.1em] text-slate-200 disabled:opacity-40" aria-label="Take full-resolution photo"><ImagePlus className="mb-1 h-5 w-5" />Full resolution</button>
              <div className="flex flex-col items-center gap-2">
                <button type="button" onClick={() => void captureCameraFrame()} disabled={!cameraReady || cameraStarting || cameraCapturing || !!cameraError} className="grid h-20 w-20 place-items-center rounded-full border-4 border-white bg-white/20 shadow-[0_0_0_5px_rgba(255,255,255,0.16)] transition active:scale-95 disabled:opacity-35" aria-label="Capture guided photo"><span className="h-14 w-14 rounded-full bg-white" /></button>
                <span className="text-[9px] font-black uppercase tracking-[0.12em] text-white/80">Guided photo</span>
              </div>
              <div className="pb-6 text-center text-[9px] font-medium leading-tight text-slate-500">Use full resolution for final artwork</div>
            </div>
          </div>
        </div>
      )}
      <header className="shrink-0 border-b border-white/10 bg-[#0c1219]/95 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-xl">
        <div className="flex items-center justify-between gap-3">
          <button onClick={openProjectPicker} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-label="Choose project">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-orange-400/25 bg-orange-400/10 text-orange-300"><FolderOpen className="h-5 w-5" /></span>
            <span className="min-w-0"><span className="block text-[9px] font-bold uppercase tracking-[0.18em] text-slate-500">Site capture</span><span className="flex items-center gap-1 truncate text-sm font-semibold">{state.projectName}<ChevronDown className="h-3.5 w-3.5 text-slate-500" /></span></span>
          </button>
          <button onClick={() => void onLogout()} className="grid h-11 w-11 place-items-center rounded-xl border border-slate-800 text-slate-400" aria-label="Sign out"><LogOut className="h-4 w-4" /></button>
        </div>
        <div className={`mt-3 flex items-center gap-2 text-[10px] font-medium ${syncStatus === 'error' ? 'text-red-300' : state.isOnline ? 'text-emerald-300' : 'text-amber-300'}`}>
          {!state.isOnline ? <WifiOff className="h-3.5 w-3.5" /> : syncStatus === 'synced' ? <Cloud className="h-3.5 w-3.5" /> : <CloudOff className="h-3.5 w-3.5" />}{syncLabel}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 pb-28 pt-5">
        {tab === 'capture' && (
          <div className="space-y-5">
            <section className="overflow-hidden rounded-[28px] border border-white/10 bg-[#111821] shadow-2xl">
              <div className="relative aspect-[4/5] max-h-[58vh] bg-[radial-gradient(circle_at_50%_35%,#243140_0,#111821_42%,#080c11_100%)]">
                {captures.length ? <CaptureImage assetRef={captures[captures.length - 1].thumbnailRef} alt="Latest site capture" className="h-full w-full object-cover opacity-55" /> : <div className="absolute inset-0 grid place-items-center text-center"><div><Camera className="mx-auto h-12 w-12 text-slate-600" /><p className="mt-3 text-sm font-medium text-slate-400">Capture the first elevation</p><p className="mt-1 text-xs text-slate-600">The original file remains untouched</p></div></div>}
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/45 to-transparent px-5 pb-5 pt-16">
                  <button onClick={() => choosePhoto('new-elevation')} disabled={isProcessing} className="flex min-h-16 w-full items-center justify-center gap-3 rounded-2xl bg-orange-500 px-5 text-sm font-black uppercase tracking-[0.12em] text-black shadow-[0_14px_38px_rgba(249,115,22,0.3)] transition active:scale-[0.98] disabled:opacity-60" aria-label="Open camera with level guide">
                    {isProcessing ? <><Loader2 className="h-6 w-6 animate-spin" /> Preserving original…</> : <><Camera className="h-6 w-6" /> Take site photo</>}
                  </button>
                </div>
              </div>
            </section>
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => setTab('views')} className="min-h-20 rounded-2xl border border-slate-800 bg-[#111821] p-4 text-left"><Images className="h-5 w-5 text-cyan-300" /><span className="mt-2 block text-sm font-semibold">{captures.length} captured</span></button>
              <button onClick={() => setTab('measure')} disabled={!activeCapture} className="min-h-20 rounded-2xl border border-slate-800 bg-[#111821] p-4 text-left disabled:opacity-40"><Ruler className="h-5 w-5 text-orange-300" /><span className="mt-2 block text-sm font-semibold">Field dimensions</span></button>
            </div>
            {captures.length > 0 && <div className="grid grid-cols-2 gap-3">
              <button onClick={() => choosePhoto('same-elevation')} disabled={isProcessing || !activeCapture} className="min-h-14 rounded-2xl border border-cyan-400/30 bg-cyan-400/[0.07] px-3 text-xs font-bold text-cyan-200 disabled:opacity-40"><Plus className="mx-auto mb-1 h-4 w-4" />Add to this elevation</button>
              <button onClick={() => choosePhoto('new-elevation')} disabled={isProcessing} className="min-h-14 rounded-2xl border border-orange-400/30 bg-orange-400/[0.07] px-3 text-xs font-bold text-orange-200 disabled:opacity-40"><Camera className="mx-auto mb-1 h-4 w-4" />Add another elevation</button>
            </div>}
          </div>
        )}

        {tab === 'views' && (
          <div className="space-y-4">
            <div><h1 className="text-2xl font-semibold tracking-tight">Captured views</h1><p className="mt-1 text-xs text-slate-500">Original photographs are retained separately from editor images.</p></div>
            {!captures.length && <button onClick={() => setTab('capture')} className="min-h-32 w-full rounded-2xl border border-dashed border-slate-700 text-sm text-slate-400">Capture your first elevation</button>}
            {captures.map(capture => (
              <article key={capture.id} onClick={() => setActiveCaptureId(capture.id)} className={`overflow-hidden rounded-2xl border bg-[#111821] ${activeCaptureId === capture.id ? 'border-orange-400/60' : 'border-slate-800'}`}>
                <div className="flex gap-3 p-3"><CaptureImage assetRef={capture.thumbnailRef} alt={capture.label} className="h-24 w-24 shrink-0 rounded-xl object-cover" /><div className="min-w-0 flex-1"><input value={capture.label} onChange={event => patchCapture(capture.id, { label: event.target.value })} onClick={event => event.stopPropagation()} className="w-full bg-transparent text-sm font-semibold outline-none focus:text-orange-200" aria-label="Elevation label" /><p className="mt-1 font-mono text-[10px] text-slate-500">{1 + (capture.supportingPhotos?.length ?? 0)} photo{capture.supportingPhotos?.length ? 's' : ''} · {capture.pixelWidth} × {capture.pixelHeight}</p>{capture.location?.address && <p className="mt-2 line-clamp-2 flex gap-1 text-[10px] leading-relaxed text-slate-400"><MapPin className="mt-0.5 h-3 w-3 shrink-0 text-orange-300" />{capture.location.address}</p>}</div></div>
                {!!capture.supportingPhotos?.length && <div className="flex gap-2 overflow-x-auto border-t border-white/5 px-3 py-2">{capture.supportingPhotos.map((photo, index) => <CaptureImage key={photo.id} assetRef={photo.thumbnailRef} alt={`${capture.label} supporting photo ${index + 2}`} className="h-16 w-16 shrink-0 rounded-lg object-cover" />)}</div>}
                <div className="flex border-t border-white/5">
                  <button onClick={() => { setActiveCaptureId(capture.id); choosePhoto('same-elevation', capture.id); }} className="grid min-h-12 w-12 place-items-center text-cyan-300" aria-label={`Add photo to ${capture.label}`}><Plus className="h-4 w-4" /></button>
                  <button onClick={() => { setActiveCaptureId(capture.id); setTab('measure'); }} className="min-h-12 flex-1 text-xs font-semibold text-slate-300">Measurements</button>
                  <button disabled={!!capture.promotedCanvasId || capture.referenceWall.widthMm === undefined || capture.referenceWall.heightMm === undefined || capture.referenceWall.planeDepthMm === undefined} onClick={() => void onPromoteCapture(capture)} className="flex min-h-12 flex-1 items-center justify-center gap-1 border-l border-white/5 px-2 text-xs font-semibold text-cyan-300 disabled:text-slate-600">{capture.promotedCanvasId ? <><Check className="h-3.5 w-3.5" /> Editor ready</> : capture.referenceWall.widthMm === undefined || capture.referenceWall.heightMm === undefined || capture.referenceWall.planeDepthMm === undefined ? 'Measurements required' : <>Create editor view<ArrowUpRight className="h-3.5 w-3.5" /></>}</button>
                  <button onClick={() => void deleteCapture(capture)} className="grid min-h-12 w-12 place-items-center border-l border-white/5 text-slate-500" aria-label={`Delete ${capture.label}`}><Trash2 className="h-4 w-4" /></button>
                </div>
              </article>
            ))}
          </div>
        )}

        {tab === 'measure' && (
          <div className="space-y-4">
            <div><h1 className="text-2xl font-semibold tracking-tight">Reference wall</h1><p className="mt-1 text-xs leading-relaxed text-slate-500">Enter confirmed site measurements. Calibration points are placed later on iPad or desktop.</p></div>
            {!activeCapture ? <button onClick={() => setTab('capture')} className="min-h-32 w-full rounded-2xl border border-dashed border-slate-700 text-sm text-slate-400">Capture an elevation before entering measurements</button> : <>
              <select value={activeCapture.id} onChange={event => setActiveCaptureId(event.target.value)} className="h-13 w-full rounded-2xl border border-slate-700 bg-[#111821] px-4 text-sm text-white" aria-label="Measurement elevation">{captures.map(capture => <option key={capture.id} value={capture.id}>{capture.label}</option>)}</select>
              <div className="flex rounded-xl border border-slate-800 bg-[#111821] p-1">{(['mm', 'cm', 'm'] as MeasureUnit[]).map(unit => <button key={unit} onClick={() => setMeasurementUnit(unit)} className={`min-h-10 flex-1 rounded-lg text-xs font-bold ${measurementUnit === unit ? 'bg-orange-500 text-black' : 'text-slate-500'}`}>{unit}</button>)}</div>
              <label className="block"><span className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Wall name</span><input value={activeCapture.referenceWall.wallName} onChange={event => patchReferenceWall({ wallName: event.target.value })} className="h-12 w-full rounded-xl border border-slate-700 bg-[#111821] px-3 text-base outline-none focus:border-orange-400" /></label>
              <MeasurementField label="Known wall width" valueMm={activeCapture.referenceWall.widthMm} unit={measurementUnit} onChange={valueMm => patchReferenceWall({ widthMm: valueMm })} />
              <MeasurementField label="Known wall height" valueMm={activeCapture.referenceWall.heightMm} unit={measurementUnit} onChange={valueMm => patchReferenceWall({ heightMm: valueMm })} />
              <section className="rounded-2xl border border-cyan-400/20 bg-cyan-400/[0.06] p-3">
                <div className="mb-3"><h2 className="text-sm font-semibold text-cyan-100">Plane depth</h2><p className="mt-1 text-[10px] leading-relaxed text-cyan-100/55">Distance from the confirmed reference plane to this wall plane.</p></div>
                <MeasurementField label="Plane depth / offset" valueMm={activeCapture.referenceWall.planeDepthMm} unit={measurementUnit} onChange={valueMm => patchReferenceWall({ planeDepthMm: valueMm })} />
                <div className="mt-3 grid grid-cols-2 gap-2"><button onClick={() => patchReferenceWall({ planeDepthDirection: 'behind' })} className={`min-h-12 rounded-xl border text-xs font-semibold ${activeCapture.referenceWall.planeDepthDirection === 'behind' ? 'border-cyan-300 bg-cyan-400/15 text-cyan-100' : 'border-slate-700 text-slate-500'}`}>Further back</button><button onClick={() => patchReferenceWall({ planeDepthDirection: 'forward' })} className={`min-h-12 rounded-xl border text-xs font-semibold ${activeCapture.referenceWall.planeDepthDirection === 'forward' ? 'border-cyan-300 bg-cyan-400/15 text-cyan-100' : 'border-slate-700 text-slate-500'}`}>Closer to camera</button></div>
                <label className="mt-3 block text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Confirmed reference plane<input value={activeCapture.referenceWall.referencePlaneName} onChange={event => patchReferenceWall({ referencePlaneName: event.target.value })} className="mt-1.5 h-12 w-full rounded-xl border border-slate-700 bg-[#090d12] px-3 text-base normal-case tracking-normal text-white outline-none focus:border-cyan-400" /></label>
              </section>
              <label className="block text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Measurement method<select value={activeCapture.referenceWall.method} onChange={event => patchReferenceWall({ method: event.target.value as ReferenceWallFieldMeasurement['method'] })} className="mt-1.5 h-12 w-full rounded-xl border border-slate-700 bg-[#111821] px-3 text-base normal-case tracking-normal text-white"><option value="laser">Laser</option><option value="tape">Tape measure</option><option value="drawing">Confirmed drawing</option><option value="estimate">Estimate</option></select></label>
              <label className="block"><span className="mb-2 block text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Measurement notes</span><div className="flex items-start gap-2"><textarea value={activeCapture.referenceWall.notes} onChange={event => patchReferenceWall({ notes: event.target.value })} rows={4} className="min-w-0 flex-1 rounded-2xl border border-slate-700 bg-[#111821] p-3 text-base leading-relaxed outline-none focus:border-orange-400" placeholder="Laser position, obstructions, confidence…" /><DictationButton label="Dictate measurement notes" onTranscript={text => patchReferenceWall({ notes: activeCapture.referenceWall.notes ? `${activeCapture.referenceWall.notes} ${text}` : text })} /></div></label>
            </>}
          </div>
        )}

        {tab === 'notes' && (
          <div className="space-y-5">
            <div><h1 className="text-2xl font-semibold tracking-tight">Site notes</h1><p className="mt-1 text-xs text-slate-500">Type, use the phone keyboard microphone, or tap the in-app microphone.</p></div>
            <label className="block"><span className="mb-2 block text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Project notes</span><div className="flex items-start gap-2"><textarea value={state.notes} onChange={event => onUpdate({ notes: event.target.value, lastSaved: Date.now() })} rows={7} className="min-w-0 flex-1 rounded-2xl border border-slate-700 bg-[#111821] p-4 text-base leading-relaxed outline-none focus:border-orange-400" placeholder="Access, power, installation conditions, client instructions…" /><DictationButton label="Dictate project notes" onTranscript={appendProjectNote} /></div></label>
            {activeCapture && <label className="block"><span className="mb-2 block text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">{activeCapture.label} notes</span><div className="flex items-start gap-2"><textarea value={activeCapture.notes} onChange={event => patchCapture(activeCapture.id, { notes: event.target.value })} rows={6} className="min-w-0 flex-1 rounded-2xl border border-slate-700 bg-[#111821] p-4 text-base leading-relaxed outline-none focus:border-cyan-400" placeholder="Condition of this elevation…" /><DictationButton label={`Dictate notes for ${activeCapture.label}`} onTranscript={appendCaptureNote} /></div></label>}
          </div>
        )}
      </main>

      <nav className="absolute inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t border-white/10 bg-[#0c1219]/96 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur-xl" aria-label="Site capture navigation">
        {([
          ['capture', Camera, 'Capture'], ['views', Images, 'Views'], ['measure', Ruler, 'Measure'], ['notes', NotebookPen, 'Notes'],
        ] as const).map(([id, Icon, label]) => <button key={id} onClick={() => setTab(id)} className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl text-[9px] font-bold uppercase tracking-wider ${tab === id ? 'bg-orange-400/12 text-orange-300' : 'text-slate-500'}`} aria-current={tab === id ? 'page' : undefined}><Icon className="h-5 w-5" />{label}</button>)}
      </nav>

      {projectPickerOpen && (
        <div className="absolute inset-0 z-40 flex items-end bg-black/70 backdrop-blur-sm" onClick={() => setProjectPickerOpen(false)}>
          <section onClick={event => event.stopPropagation()} className="max-h-[78vh] w-full overflow-y-auto rounded-t-[28px] border-t border-white/10 bg-[#111821] p-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]" aria-label="Saved projects">
            <div className="mx-auto mb-4 h-1 w-12 rounded-full bg-slate-700" />
            <div className="mb-4 flex items-center justify-between gap-3">
              <div><p className="text-[9px] font-bold uppercase tracking-[0.2em] text-orange-300">Project storage</p><h2 className="mt-1 text-lg font-semibold">Saved projects</h2></div>
              <button onClick={() => {
                captureRequestEpochRef.current += 1;
                void onNewProject().then(() => setProjectPickerOpen(false));
              }} className="flex min-h-11 items-center gap-2 rounded-xl bg-orange-500 px-3 text-xs font-bold text-black"><Plus className="h-4 w-4" />New project</button>
            </div>
            <div className="mb-5 rounded-2xl border border-orange-400/25 bg-orange-400/[0.06] p-3">
              <label className="block text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">
                Current project name
                <input value={projectNameDraft} onChange={event => setProjectNameDraft(event.target.value)} className="mt-1.5 h-12 w-full rounded-xl border border-slate-700 bg-[#090d12] px-3 text-base normal-case tracking-normal text-white outline-none focus:border-orange-400" />
              </label>
              <button onClick={() => void saveCurrentProject()} disabled={isSavingProject || !projectNameDraft.trim()} className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-orange-500 px-4 text-sm font-black uppercase tracking-[0.1em] text-black shadow-[0_12px_30px_rgba(249,115,22,0.22)] active:scale-[0.99] disabled:opacity-40" aria-label="Save current project">
                {isSavingProject ? <><Loader2 className="h-5 w-5 animate-spin" />Saving project…</> : <><Save className="h-5 w-5" />Save project</>}
              </button>
            </div>
            <div className="mb-2 flex items-center justify-between"><h3 className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">{state.user?.uid.startsWith('guest_') ? 'Projects on this device' : 'Projects on your account'}</h3><span className="font-mono text-[10px] text-slate-600">{projects.length}</span></div>
            <div className="space-y-2">
              {projects.map(project => (
                <button key={project.id} onClick={() => void loadProject(project.id)} aria-current={project.id === selectedProjectId ? 'true' : undefined} data-testid={project.id === selectedProjectId ? 'current-saved-project' : undefined} className={`flex min-h-16 w-full items-center justify-between rounded-2xl border p-3 text-left ${project.id === selectedProjectId ? 'border-orange-400/60 bg-orange-400/10' : 'border-slate-800 bg-[#0b1016]'}`}>
                  <span><span className="block text-sm font-semibold">{project.name}</span><span className="mt-1 block text-[10px] text-slate-500">{project.canvasCount} editor view{project.canvasCount === 1 ? '' : 's'} · {new Date(project.lastModified).toLocaleDateString()}</span></span>
                  {project.id === selectedProjectId && <Check className="h-5 w-5 text-orange-300" />}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
};

export default MobileSiteCapture;
