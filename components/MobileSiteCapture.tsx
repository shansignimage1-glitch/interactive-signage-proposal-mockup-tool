import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight, Camera, Check, ChevronDown, Cloud, CloudOff, FolderOpen, Images,
  Loader2, LogOut, MapPin, Mic, NotebookPen, Plus, Ruler, Save, Square, Trash2, WifiOff,
} from 'lucide-react';
import { MeasureUnit, MockupState, ProjectMetadata, ReferenceWallFieldMeasurement, SiteCapturePhoto } from '../types';
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

const DictationButton: React.FC<{
  onTranscript: (text: string) => void;
  disabled?: boolean;
  label: string;
}> = ({ onTranscript, disabled, label }) => {
  const [status, setStatus] = useState<DictationState>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const forceRecorderRef = useRef(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach(track => track.stop());
  }, []);

  const transcribeRecording = async (blob: Blob) => {
    setStatus('transcribing');
    try {
      const transcript = await transcribeAudio(blob);
      onTranscript(transcript);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Dictation could not be transcribed.', 'error');
    } finally { setStatus('idle'); }
  };

  const startRecorder = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      notify('Use the microphone on your phone keyboard for dictation on this browser.', 'warning');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' });
        if (blob.size > 0) void transcribeRecording(blob); else setStatus('idle');
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
    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = navigator.language || 'en-US';
    recognition.onstart = () => setStatus('listening');
    recognition.onresult = (event: any) => onTranscript(event.results[0][0].transcript);
    recognition.onend = () => setStatus('idle');
    recognition.onerror = (event: any) => {
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

const MobileSiteCapture: React.FC<MobileSiteCaptureProps> = ({ state, syncStatus, onUpdate, onLoadProject, onNewProject, onSaveProject, onPromoteCapture, onLogout }) => {
  const captures = state.siteCaptures ?? [];
  const [tab, setTab] = useState<MobileTab>('capture');
  const [activeCaptureId, setActiveCaptureId] = useState<string | null>(captures[0]?.id ?? null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectMetadata[]>([]);
  const [projectNameDraft, setProjectNameDraft] = useState(state.projectName);
  const [isSavingProject, setIsSavingProject] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState(state.projectId);
  const [measurementUnit, setMeasurementUnit] = useState<MeasureUnit>('m');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeCapture = captures.find(capture => capture.id === activeCaptureId) ?? captures[0] ?? null;

  useEffect(() => {
    if (!activeCaptureId && captures[0]) setActiveCaptureId(captures[0].id);
  }, [captures, activeCaptureId]);

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

  const capturePhoto = async (file: File) => {
    setIsProcessing(true);
    const id = `capture_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    try {
      await navigator.storage?.persist?.().catch(() => false);
      const dimensions = await readImageDimensions(file);
      const workingBlob = await optimizeImageBlob(file, 4096);
      const workingDimensions = await readImageDimensions(workingBlob);
      const thumbnailBlob = await optimizeImageBlob(file, 720);
      const originalRef = makeSiteCaptureAssetRef(state.projectId, id, 'original');
      const workingRef = makeSiteCaptureAssetRef(state.projectId, id, 'working');
      const thumbnailRef = makeSiteCaptureAssetRef(state.projectId, id, 'thumbnail');
      await Promise.all([
        putSiteCaptureAsset(originalRef, file),
        putSiteCaptureAsset(workingRef, workingBlob),
        putSiteCaptureAsset(thumbnailRef, thumbnailBlob),
      ]);

      let location: SiteCapturePhoto['location'];
      try {
        const coordinates = await currentCoordinates();
        location = { ...coordinates };
        try { location.address = (await reverseGeocode(coordinates, 'device')).address; } catch { /* coordinates remain useful */ }
      } catch { /* location is optional */ }

      const capture: SiteCapturePhoto = {
        id,
        label: `Elevation ${captures.length + 1}`,
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
        notes: '',
        location,
        referenceWall: {
          wallName: 'Reference wall',
          planeDepthMm: 0,
          planeDepthDirection: 'behind',
          referencePlaneName: 'Main façade',
          method: 'laser',
          notes: '',
        },
      };
      onUpdate({ siteCaptures: [...captures, capture], lastSaved: Date.now() });
      setActiveCaptureId(id);
      setTab('measure');
      notify('Original photo saved. Add the field measurements for this elevation.', 'success');
    } catch (error) {
      await deleteSiteCaptureAssets(state.projectId, id).catch(() => undefined);
      notify(error instanceof Error ? error.message : 'The photograph could not be saved.', 'error');
    } finally {
      setIsProcessing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const openProjectPicker = async () => {
    setProjectNameDraft(state.projectName);
    setSelectedProjectId(state.projectId);
    setProjects((await StorageService.listProjectsLocal()).sort((a, b) => b.lastModified - a.lastModified));
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
      setProjects((await StorageService.listProjectsLocal()).sort((a, b) => b.lastModified - a.lastModified));
      notify(`${name} saved.`, 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The project could not be saved.', 'error');
    } finally {
      setIsSavingProject(false);
    }
  };

  const loadProject = async (projectId: string) => {
    const project = await StorageService.loadProjectLocal(projectId);
    if (project) onLoadProject(normalizeProjectState(project));
    setProjectPickerOpen(false);
  };

  const deleteCapture = async (capture: SiteCapturePhoto) => {
    if (!window.confirm(`Delete ${capture.label} and its locally stored photographs?`)) return;
    await StorageService.deleteSiteCapture(state.user?.uid ?? 'guest_unknown', state.projectId, capture.id);
    onUpdate({ siteCaptures: captures.filter(item => item.id !== capture.id), lastSaved: Date.now() });
    if (activeCaptureId === capture.id) setActiveCaptureId(captures.find(item => item.id !== capture.id)?.id ?? null);
  };

  const appendProjectNote = (text: string) => onUpdate({ notes: state.notes ? `${state.notes} ${text}` : text, lastSaved: Date.now() });
  const appendCaptureNote = (text: string) => activeCapture && patchCapture(activeCapture.id, { notes: activeCapture.notes ? `${activeCapture.notes} ${text}` : text });

  const MeasurementField = ({ label, field }: { label: string; field: 'widthMm' | 'heightMm' | 'planeDepthMm' }) => (
    <label className="block rounded-2xl border border-slate-800 bg-[#111821] p-3">
      <span className="mb-2 block text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">{label}</span>
      <span className="flex items-center gap-2">
        <input inputMode="decimal" type="number" min="0" step="any" value={displayMeasurement(activeCapture?.referenceWall[field], measurementUnit)} onChange={event => patchReferenceWall({ [field]: event.target.value === '' ? undefined : parseSpokenMeasurementMm(event.target.value, measurementUnit) ?? undefined })} className="h-12 min-w-0 flex-1 rounded-xl border border-slate-700 bg-[#090d12] px-3 font-mono text-lg text-white outline-none focus:border-orange-400" aria-label={`${label} in ${measurementUnit}`} />
        <span className="w-7 text-xs font-bold text-orange-300">{measurementUnit}</span>
        <DictationButton label={`Dictate ${label.toLowerCase()}`} onTranscript={text => {
          const mm = parseSpokenMeasurementMm(text, measurementUnit);
          if (mm === null) notify(`I could not find a measurement in “${text}”.`, 'warning'); else patchReferenceWall({ [field]: mm });
        }} />
      </span>
    </label>
  );

  const syncLabel = !state.isOnline ? 'Offline — saved on phone' : state.isSyncing ? 'Uploading project' : syncStatus === 'synced' ? 'Cloud saved' : syncStatus === 'error' ? 'Sync needs attention' : 'Saved on phone';

  return (
    <div className="fixed inset-0 z-[100] flex flex-col overflow-hidden bg-[#080c11] text-slate-100" data-testid="mobile-site-capture">
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
                  <input ref={fileInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={event => event.target.files?.[0] && void capturePhoto(event.target.files[0])} />
                  <button onClick={() => fileInputRef.current?.click()} disabled={isProcessing} className="flex min-h-16 w-full items-center justify-center gap-3 rounded-2xl bg-orange-500 px-5 text-sm font-black uppercase tracking-[0.12em] text-black shadow-[0_14px_38px_rgba(249,115,22,0.3)] transition active:scale-[0.98] disabled:opacity-60" aria-label="Take high-resolution site photo">
                    {isProcessing ? <><Loader2 className="h-6 w-6 animate-spin" /> Preserving original…</> : <><Camera className="h-6 w-6" /> Take site photo</>}
                  </button>
                </div>
              </div>
            </section>
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => setTab('views')} className="min-h-20 rounded-2xl border border-slate-800 bg-[#111821] p-4 text-left"><Images className="h-5 w-5 text-cyan-300" /><span className="mt-2 block text-sm font-semibold">{captures.length} captured</span></button>
              <button onClick={() => setTab('measure')} disabled={!activeCapture} className="min-h-20 rounded-2xl border border-slate-800 bg-[#111821] p-4 text-left disabled:opacity-40"><Ruler className="h-5 w-5 text-orange-300" /><span className="mt-2 block text-sm font-semibold">Field dimensions</span></button>
            </div>
          </div>
        )}

        {tab === 'views' && (
          <div className="space-y-4">
            <div><h1 className="text-2xl font-semibold tracking-tight">Captured views</h1><p className="mt-1 text-xs text-slate-500">Original photographs are retained separately from editor images.</p></div>
            {!captures.length && <button onClick={() => setTab('capture')} className="min-h-32 w-full rounded-2xl border border-dashed border-slate-700 text-sm text-slate-400">Capture your first elevation</button>}
            {captures.map(capture => (
              <article key={capture.id} onClick={() => setActiveCaptureId(capture.id)} className={`overflow-hidden rounded-2xl border bg-[#111821] ${activeCaptureId === capture.id ? 'border-orange-400/60' : 'border-slate-800'}`}>
                <div className="flex gap-3 p-3"><CaptureImage assetRef={capture.thumbnailRef} alt={capture.label} className="h-24 w-24 shrink-0 rounded-xl object-cover" /><div className="min-w-0 flex-1"><input value={capture.label} onChange={event => patchCapture(capture.id, { label: event.target.value })} onClick={event => event.stopPropagation()} className="w-full bg-transparent text-sm font-semibold outline-none focus:text-orange-200" aria-label="Elevation label" /><p className="mt-1 font-mono text-[10px] text-slate-500">{capture.pixelWidth} × {capture.pixelHeight} · {(capture.byteSize / 1048576).toFixed(1)} MB</p>{capture.location?.address && <p className="mt-2 line-clamp-2 flex gap-1 text-[10px] leading-relaxed text-slate-400"><MapPin className="mt-0.5 h-3 w-3 shrink-0 text-orange-300" />{capture.location.address}</p>}</div></div>
                <div className="flex border-t border-white/5">
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
              <MeasurementField label="Known wall width" field="widthMm" />
              <MeasurementField label="Known wall height" field="heightMm" />
              <section className="rounded-2xl border border-cyan-400/20 bg-cyan-400/[0.06] p-3">
                <div className="mb-3"><h2 className="text-sm font-semibold text-cyan-100">Plane depth</h2><p className="mt-1 text-[10px] leading-relaxed text-cyan-100/55">Distance from the confirmed reference plane to this wall plane.</p></div>
                <MeasurementField label="Plane depth / offset" field="planeDepthMm" />
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
              <button onClick={() => void onNewProject().then(() => setProjectPickerOpen(false))} className="flex min-h-11 items-center gap-2 rounded-xl bg-orange-500 px-3 text-xs font-bold text-black"><Plus className="h-4 w-4" />New project</button>
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
            <div className="mb-2 flex items-center justify-between"><h3 className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Projects on this device</h3><span className="font-mono text-[10px] text-slate-600">{projects.length}</span></div>
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
