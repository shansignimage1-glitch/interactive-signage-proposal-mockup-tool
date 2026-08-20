
import React, { useRef, useState, useEffect } from 'react';
import { BLEND_MODES, MockupState, Sign, Point, Dimension, SignTemplate, ReferenceImage, TitleBlockField, Canvas, PaperSize, Orientation, SIGN_TYPES, SignType, UnitSystem, PlacementAnchor, PlacementSettings, SiteCapturePhoto } from '../types';
import { getMmPerPx, formatLength, toMm, measureLine, measureBox, measureSignSizeMm, resizeSignToRealSize } from '../utils/measure';
import { Upload, Download, Sun, Moon, Move3d, Palette, Image as ImageIcon, Plus, Trash2, Layers, Eye, Copy, Box, Minus, Maximize, Ruler, ArrowRight, ArrowDown, ArrowLeft, ArrowUp, Scissors, Check, X, Eraser, Loader2, Square, PenTool, MousePointer2, Hand, Mic, EyeOff, Undo2, Redo2, Layout, FileText, Settings, Briefcase, User, Calendar, MapPin, Notebook, Camera, Library, Sparkles, PencilLine, Grid, Save, ChevronDown, ChevronRight, Monitor, Printer, FolderOpen, HardDrive, Lock, Unlock, MessageSquareText } from 'lucide-react';
import ImageUploader from './ImageUploader';
import SignLibrary from './SignLibrary';
import { ToolMode } from '../App';
import { TITLE_BLOCK_TEMPLATES } from '../data/titleBlockTemplates';
import { notify } from '../services/toast';
import { optimizeDataUri } from '../services/imageProcessing';
import { materializeTemplateDataUri } from '../services/LibraryService';
import { calibrationForPlane, getCalibrationPlanes } from '../utils/cameraGeometry';
import { detectSignArtwork } from '../utils/elementDetection';
import { defaultExtrusionModeForType, getBackingDepth, getSignExtrusionMode, VISUAL_EXTRUSION_REFERENCE_WIDTH_PX } from '../utils/signExtrusion';
import { isValidSurveyPlaneSize } from '../utils/fieldMeasurements';
import { transcribeAudio } from '../services/GeminiService';

interface ControlsPanelProps {
  state: MockupState;
  activeCanvas: Canvas;
  forceSidePanel?: boolean;
  updateState: (updates: Partial<MockupState>) => void;
  updateStateWithHistory: (updates: Partial<MockupState>) => void;
  updateActiveCanvas: (updates: Partial<Canvas>) => void;
  updateActiveCanvasWithHistory: (updates: Partial<Canvas>) => void;

  updateActiveSign: (updates: Partial<Sign>) => void;
  updateSignById: (id: string, updates: Partial<Sign>) => void;
  addSign: () => void;
  duplicateSign: (id: string) => void;
  removeSign: (id: string) => void;
  setActiveSign: (id: string | null) => void;
  
  addCanvas: () => void;
  deleteCanvas: () => void;

  toolMode: ToolMode;
  setToolMode: (mode: ToolMode) => void;
  viewLocked: boolean;
  onViewLockedChange: (locked: boolean) => void;
  onOpenCalibration: (options?: { addPlane?: boolean; widthMm?: number; heightMm?: number; planeName?: string }) => void;
  onPromoteCapture: (capture: SiteCapturePhoto) => Promise<void>;
  showCalibrationReference: boolean;
  setShowCalibrationReference: (show: boolean) => void;
  updateDimension: (id: string, updates: Partial<Dimension>) => void;
  removeDimension: (id: string) => void;
  setActiveDimension: (id: string) => void;

  onBackgroundUpload: (file: File) => void;
  onForegroundUpload: (file: File) => void;
  onLogoUpload: (file: File) => void;
  onDownload: (destination?: 'device' | 'drive') => void;

  isCropping: boolean;
  setIsCropping: (v: boolean) => void;

  onOpenCleanup: () => void;
  onOpenElementStudio: () => void;

  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  
  showAssistant: boolean;
  setShowAssistant: (show: boolean) => void;
  onOpenProjectManager: () => void;
}

export const readImageAspectRatio = (src: string): Promise<number | null> => new Promise(resolve => {
  const image = new Image();
  let settled = false;
  const finish = (ratio: number | null) => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    image.onload = null;
    image.onerror = null;
    resolve(ratio);
  };
  const timer = window.setTimeout(() => finish(null), 3_000);
  image.onload = () => {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    finish(width > 0 && height > 0 ? width / height : null);
  };
  image.onerror = () => finish(null);
  image.src = src;
});

type NoteRecordingState = 'idle' | 'recording' | 'transcribing';

const NoteRecorder: React.FC<{ label: string; onTranscript: (text: string) => void }> = ({ label, onTranscript }) => {
  const [status, setStatus] = useState<NoteRecordingState>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timeoutRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const releaseMicrophone = () => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        if (recorder.state === 'recording') recorder.stop();
      }
      releaseMicrophone();
    };
  }, []);

  const transcribe = async (blob: Blob) => {
    setStatus('transcribing');
    try {
      const transcript = await transcribeAudio(blob);
      if (mountedRef.current && transcript.trim()) onTranscript(transcript.trim());
    } catch (error) {
      if (mountedRef.current) notify(error instanceof Error ? error.message : 'Recording could not be transcribed.', 'error');
    } finally {
      if (mountedRef.current) setStatus('idle');
    }
  };

  const toggleRecording = async () => {
    if (status === 'recording') {
      recorderRef.current?.stop();
      return;
    }
    if (status !== 'idle') return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      notify('Audio recording is not supported in this browser.', 'warning');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) {
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
        releaseMicrophone();
        recorderRef.current = null;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' });
        chunksRef.current = [];
        if (mountedRef.current && blob.size > 0) void transcribe(blob);
        else if (mountedRef.current) setStatus('idle');
      };
      recorder.start(500);
      setStatus('recording');
      timeoutRef.current = window.setTimeout(() => recorder.state === 'recording' && recorder.stop(), 55_000);
    } catch {
      releaseMicrophone();
      if (mountedRef.current) setStatus('idle');
      notify('Microphone permission was not granted.', 'warning');
    }
  };

  return <button type="button" onClick={toggleRecording} disabled={status === 'transcribing'} aria-label={`${label}${status === 'recording' ? ' — stop recording' : ''}`} className={`flex min-h-9 items-center justify-center gap-1.5 rounded-md border px-2.5 text-[10px] font-semibold transition ${status === 'recording' ? 'animate-pulse border-red-400 bg-red-500/15 text-red-300' : status === 'transcribing' ? 'border-orange-400/50 bg-orange-500/10 text-orange-200' : 'border-gray-700 bg-gray-800 text-gray-300 hover:border-orange-400 hover:text-orange-200'}`}>
    {status === 'transcribing' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : status === 'recording' ? <Square className="h-3 w-3 fill-current" /> : <Mic className="h-3.5 w-3.5" />}
    {status === 'transcribing' ? 'Transcribing…' : status === 'recording' ? 'Stop' : 'Record'}
  </button>;
};

const ControlsPanel: React.FC<ControlsPanelProps> = ({
  state,
  activeCanvas,
  forceSidePanel = false,
  updateState,
  updateStateWithHistory,
  updateActiveCanvas,
  updateActiveCanvasWithHistory,
  updateActiveSign,
  updateSignById,
  addSign,
  duplicateSign,
  removeSign,
  setActiveSign,
  
  addCanvas,
  deleteCanvas,

  toolMode,
  setToolMode,
  viewLocked,
  onViewLockedChange,
  onOpenCalibration,
  onPromoteCapture,
  showCalibrationReference,
  setShowCalibrationReference,
  updateDimension,
  removeDimension,
  setActiveDimension,

  onBackgroundUpload,
  onForegroundUpload,
  onLogoUpload,
  onDownload,

  isCropping,
  setIsCropping,

  onOpenCleanup,
  onOpenElementStudio,
  undo,
  redo,
  canUndo,
  canRedo,
  
  showAssistant,
  setShowAssistant,
  onOpenProjectManager
}) => {
  const logoInputRef = useRef<HTMLInputElement>(null);
  
  const [isUploaderOpen, setIsUploaderOpen] = useState(false);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  
  const [uploadTarget, setUploadTarget] = useState<'sign' | 'reference' | 'background'>('sign');
  const [activeRefId, setActiveRefId] = useState<string | null>(null);
  
  // Voice Input State
  const [listeningTarget, setListeningTarget] = useState<'dimension' | 'notes' | 'ref_note' | null>(null);
  
  // New state for Template Library Modal
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);
  const [isViewMenuOpen, setIsViewMenuOpen] = useState(false);
  
  const [activeTab, setActiveTab] = useState<'editor' | 'page' | 'notes' | 'survey'>('editor');
  const [mobilePanelExpanded, setMobilePanelExpanded] = useState(false);
  const [selectedSiteCaptureId, setSelectedSiteCaptureId] = useState<string | null>(null);
  const [promotingSiteCaptureId, setPromotingSiteCaptureId] = useState<string | null>(null);

  // Target real-world dimensions for calibrated sign placement.
  const [targetWidth, setTargetWidth] = useState('');
  const [targetHeight, setTargetHeight] = useState('');
  const [nudgeStep, setNudgeStep] = useState<1 | 5>(1);
  const [preparingExtrusionId, setPreparingExtrusionId] = useState<string | null>(null);
  const preparedExtrusionKeysRef = useRef(new Set<string>());

  const applyPerspectivePreset = (preset: 'flat' | 'left' | 'right') => {
      if (!activeSign) return;
      const [tl, tr, br, bl] = activeSign.corners;
      const minX = Math.min(tl.x, tr.x, br.x, bl.x);
      const maxX = Math.max(tl.x, tr.x, br.x, bl.x);
      const minY = Math.min(tl.y, tr.y, br.y, bl.y);
      const maxY = Math.max(tl.y, tr.y, br.y, bl.y);
      const inset = Math.min((maxX - minX) * 0.14, (maxY - minY) * 0.3);
      const corners: Sign['corners'] = preset === 'flat'
          ? [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }]
          : preset === 'left'
              ? [{ x: minX + inset, y: minY + inset }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX + inset, y: maxY - inset }]
              : [{ x: minX, y: minY }, { x: maxX - inset, y: minY + inset }, { x: maxX - inset, y: maxY - inset }, { x: minX, y: maxY }];
      updateActiveSign({ corners });
      activateTool('select');
  };
  
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>, callback: (f: File) => void) => {
    if (e.target.files && e.target.files[0]) {
      callback(e.target.files[0]);
    }
    e.target.value = '';
  };

  const activeDimension = activeCanvas.dimensions.find(d => d.id === activeCanvas.activeDimensionId);
  const siteCaptures = state.siteCaptures ?? [];
  const linkedSiteCapture = siteCaptures.find(capture => capture.promotedCanvasId === activeCanvas.id);
  const selectedSiteCapture = siteCaptures.find(capture => capture.id === selectedSiteCaptureId)
      ?? linkedSiteCapture
      ?? siteCaptures[0];
  const siteCaptureIds = siteCaptures.map(capture => capture.id).join('|');

  useEffect(() => {
      const linked = siteCaptures.find(capture => capture.promotedCanvasId === activeCanvas.id);
      setSelectedSiteCaptureId(linked?.id ?? siteCaptures[0]?.id ?? null);
  }, [state.projectId, activeCanvas.id, siteCaptureIds]);

  const updateSelectedSiteCapture = (updates: Partial<SiteCapturePhoto>) => {
      if (!selectedSiteCapture) return;
      updateState({
          siteCaptures: siteCaptures.map(capture => capture.id === selectedSiteCapture.id ? { ...capture, ...updates } : capture),
      });
  };

  const createEditorViewForSurvey = async () => {
      if (!selectedSiteCapture || selectedSiteCapture.promotedCanvasId) return;
      setPromotingSiteCaptureId(selectedSiteCapture.id);
      try {
          await onPromoteCapture(selectedSiteCapture);
      } catch (error) {
          notify(error instanceof Error ? error.message : 'The editor view could not be created.', 'error');
      } finally {
          setPromotingSiteCaptureId(null);
      }
  };
  const selectedSurveyLocation = selectedSiteCapture?.location;
  const selectedSurveyHasGps = Number.isFinite(selectedSurveyLocation?.latitude)
      && Number.isFinite(selectedSurveyLocation?.longitude);
  const selectedSurveyHasValidWallSize = isValidSurveyPlaneSize(
      selectedSiteCapture?.referenceWall.widthMm,
      selectedSiteCapture?.referenceWall.heightMm,
  );
  const selectedSurveyCoordinates = selectedSurveyHasGps
      ? `${selectedSurveyLocation!.latitude.toFixed(6)}, ${selectedSurveyLocation!.longitude.toFixed(6)}`
      : '';
  const selectedSurveyMapUrl = selectedSurveyHasGps
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${selectedSurveyLocation!.latitude},${selectedSurveyLocation!.longitude}`)}`
      : '';

  useEffect(() => {
    if (listeningTarget === 'dimension') {
        setListeningTarget(null);
    }
  }, [activeCanvas.activeDimensionId]);
  
  // Sync view mode with tab (Only 'page' tab enables sheet view)
  useEffect(() => {
      const viewMode = activeTab === 'page' ? 'sheet' : 'canvas';
      if (state.titleBlock.viewMode !== viewMode) {
          updateState({ titleBlock: { ...state.titleBlock, viewMode } });
      }
  }, [activeTab, state.titleBlock.viewMode]);

  const handleVoiceInput = (target: 'dimension' | 'notes' | 'ref_note' = 'dimension') => {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        notify('Speech recognition is not supported in this browser.', 'warning');
        return;
    }

    if (listeningTarget) return;

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onstart = () => setListeningTarget(target);
    recognition.onend = () => setListeningTarget(null);
    recognition.onerror = () => setListeningTarget(null);
    
    recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        
        if (target === 'dimension' && activeCanvas.activeDimensionId) {
            updateDimension(activeCanvas.activeDimensionId, { text: transcript });
        } else if (target === 'notes') {
            const newNotes = state.notes ? `${state.notes} ${transcript}` : transcript;
            updateState({ notes: newNotes });
        } else if (target === 'ref_note' && activeRefId) {
            const newRefs = state.referenceImages.map(r => 
                r.id === activeRefId ? { ...r, note: r.note ? `${r.note} ${transcript}` : transcript } : r
            );
            updateState({ referenceImages: newRefs });
        }
    };

    recognition.start();
  };

  const handleImageReady = async (rawDataUrl: string) => {
    let dataUrl = rawDataUrl;
    // Background photos remain at source resolution throughout editing. The
    // cloud-save pipeline creates its smaller transport copy later, without
    // replacing this full-resolution local working image.
    // Sign artwork is already bounded to a GPU-safe 4K edge by ImageUploader.
    // Do not run it through the generic photo compressor again: that path can
    // convert transparent PNG artwork to lossy WebP and soften text/logo edges.
    if (uploadTarget === 'reference') {
      try { dataUrl = await optimizeDataUri(rawDataUrl, 3072); }
      catch (error) { notify(error instanceof Error ? error.message : 'Could not optimize this image.', 'error'); return; }
    }
    if (uploadTarget === 'sign') {
        let targetSignId = activeCanvas.activeSignId;
        let activeSign = activeCanvas.signs.find(s => s.id === targetSignId);

        // Failsafe: If no sign is active (can happen if touch clears selection), create a new one automatically
        if (!activeSign) {
             const cx = activeCanvas.backgroundSize.width / 2;
             const cy = activeCanvas.backgroundSize.height / 2;
             const newId = Date.now().toString();

             // Create sign with the image directly
             const img = new Image();
             img.onload = () => {
                 const aspect = img.width / img.height;
                 const w = 300;
                 const h = 300 / aspect;
                 
                 const newSign: Sign = {
                      id: newId,
                      name: 'Uploaded Sign',
                      image: dataUrl,
                      corners: [
                          { x: cx - w/2, y: cy - h/2 },
                          { x: cx + w/2, y: cy - h/2 },
                          { x: cx + w/2, y: cy + h/2 },
                          { x: cx - w/2, y: cy + h/2 }
                      ],
                      signType: 'fascia_ill',
                      extrusionEnabled: true,
                      extrusionDepth: 15,
                      extrusionAngle: 45,
                      opacity: 1,
                      blendMode: 'normal',
                      sideColor: '#111111',
                      aspectLocked: true,
                 };
                 
                 updateActiveCanvas({
                     signs: [...activeCanvas.signs, newSign],
                     activeSignId: newId
                 });
             };
             img.src = dataUrl;
             return;
        }

        const img = new Image();
        img.onload = () => {
          const aspectRatio = img.height / img.width;
          const xs = activeSign!.corners.map(c => c.x);
          const minX = Math.min(...xs);
          const maxX = Math.max(...xs);
          const currentWidth = Math.max(maxX - minX, 100); 
          
          const cx = (activeSign!.corners[0].x + activeSign!.corners[2].x) / 2;
          const cy = (activeSign!.corners[0].y + activeSign!.corners[2].y) / 2;

          const halfW = currentWidth / 2;
          const halfH = (currentWidth * aspectRatio) / 2;

          const c0: Point = { x: cx - halfW, y: cy - halfH };
          const c1: Point = { x: cx + halfW, y: cy - halfH };
          const c2: Point = { x: cx + halfW, y: cy + halfH };
          const c3: Point = { x: cx - halfW, y: cy + halfH };

          // New artwork invalidates detected element contours
          updateActiveSign({ image: dataUrl, corners: [c0, c1, c2, c3], elements: undefined, elementsSourceSize: undefined });
        };
        img.src = dataUrl;
    } else if (uploadTarget === 'reference') {
        const newRef: ReferenceImage = {
            id: Date.now().toString(),
            image: dataUrl,
            note: ''
        };
        updateStateWithHistory({ referenceImages: [...state.referenceImages, newRef] });
        setActiveRefId(newRef.id);
    } else if (uploadTarget === 'background') {
        const img = new Image();
        img.onload = () => {
             updateActiveCanvas({
                 backgroundImage: dataUrl,
                 backgroundSize: { width: img.width, height: img.height },
                 calibration: null, // new or levelled photo — old image coordinates are invalid
                 placement: { ...placement, lens: { enabled: false, k1: 0, k2: 0 }, camera: { enabled: false, fieldOfViewDeg: 60, estimated: true } },
                 dimensions: [],
                 activeDimensionId: null,
             });
        };
        img.src = dataUrl;
    }
  };

  const handlePhotoAddressReady = (address: string) => {
    const fields = state.titleBlock.fields.map(field =>
      field.label.trim().toUpperCase() === 'ADDRESS' ? { ...field, value: address } : field
    );
    updateStateWithHistory({ titleBlock: { ...state.titleBlock, fields } });
    notify('Title-block address updated from the confirmed photo location.', 'success');
  };

  const mapCategoryToType = (cat: string): SignType => {
      const c = cat.toLowerCase();
      if (c.includes('projecting')) return 'blade_sign';
      if (c.includes('pylon') || c.includes('totem')) return 'totem';
      if (c.includes('window')) return 'window_vinyl';
      if (c.includes('fascia')) return 'fascia_ill';
      return 'fascia_non_ill';
  };

  const handleLibrarySelect = async (template: SignTemplate) => {
      let image = template.image;
      try {
          // Cloud URLs may display in a normal <img> but fail WebGL's CORS rules.
          // A local data URI is stable in the canvas and in saved projects.
          if (template.source) image = await materializeTemplateDataUri(template);
      } catch (error) {
          notify(error instanceof Error ? error.message : 'Could not load this library sign.', 'error');
          return;
      }

      // 1. If we have an active Dimension that is a BOX, we fit the new sign to that box.
      if (activeDimension && activeDimension.variant === 'box') {
          const id = Date.now().toString();
          const { start, end } = activeDimension;
          
          // Determine box bounds
          const minX = Math.min(start.x, end.x);
          const minY = Math.min(start.y, end.y);
          const maxX = Math.max(start.x, end.x);
          const maxY = Math.max(start.y, end.y);
          
          const newSign: Sign = {
              id,
              name: template.name,
              image,
              corners: [
                  { x: minX, y: minY },
                  { x: maxX, y: minY },
                  { x: maxX, y: maxY },
                  { x: minX, y: maxY }
              ],
              signType: template.signType ?? mapCategoryToType(template.category),
              extrusionEnabled: false,
              extrusionDepth: 15,
              extrusionAngle: 45,
              opacity: 1,
              blendMode: 'normal',
              sideColor: '#111111',
              realWidthMm: template.width,
              realHeightMm: template.height,
              aspectLocked: true,
              placementAnchor: 'center',
              calibrationPlaneId: calibration?.activePlaneId,
              projectionMode: 'planar',
              physicalDepthMm: 100,
          };
          const measuredBox = calibration ? measureSignSizeMm(newSign.corners, calibration) : null;
          if (measuredBox) {
              newSign.realWidthMm = measuredBox.width;
              newSign.realHeightMm = measuredBox.height;
          }
          
          // Add to active canvas
          updateActiveCanvas({
             signs: [...activeCanvas.signs, newSign],
             activeSignId: id,
             activeDimensionId: null
          });
      } 
      else if (activeSign) {
          const resizedCorners = calibration && activeSign && template.width > 0 && template.height > 0
              ? resizeSignToRealSize(activeSign.corners, template.width, template.height, calibration)
              : null;
          updateActiveSign({
              image,
              name: template.name,
              signType: template.signType ?? mapCategoryToType(template.category),
              extrusionEnabled: false,
              elements: undefined,
              elementsSourceSize: undefined,
              corners: resizedCorners ?? activeSign.corners,
              realWidthMm: template.width,
              realHeightMm: template.height,
              aspectLocked: true,
              placementAnchor: 'center',
              calibrationPlaneId: calibration?.activePlaneId,
              projectionMode: 'planar',
              physicalDepthMm: 100,
          });
      }
      else {
          const id = Date.now().toString();
          const cx = calibration?.plane
              ? calibration.plane.corners.reduce((sum, point) => sum + point.x, 0) / calibration.plane.corners.length
              : activeCanvas.backgroundSize.width / 2;
          const cy = calibration?.plane
              ? calibration.plane.corners.reduce((sum, point) => sum + point.y, 0) / calibration.plane.corners.length
              : activeCanvas.backgroundSize.height / 2;
          const storedAspect = template.width / template.height;
          const recoveredAspect = template.recovered ? await readImageAspectRatio(image) : null;
          const aspect = recoveredAspect && Number.isFinite(recoveredAspect) && recoveredAspect > 0
              ? recoveredAspect
              : (Number.isFinite(storedAspect) && storedAspect > 0 ? storedAspect : 1);
          const w = 300;
          const h = w / aspect;
          
          const newSign: Sign = {
              id,
              name: template.name,
              image,
              corners: [
                  { x: cx - w/2, y: cy - h/2 },
                  { x: cx + w/2, y: cy - h/2 },
                  { x: cx + w/2, y: cy + h/2 },
                  { x: cx - w/2, y: cy + h/2 }
              ],
              signType: template.signType ?? mapCategoryToType(template.category),
              extrusionEnabled: false,
              extrusionDepth: 15,
              extrusionAngle: 45,
              opacity: 1,
              blendMode: 'normal',
              sideColor: '#111111',
              realWidthMm: template.width,
              realHeightMm: template.height,
              aspectLocked: true,
          };
          if (calibration && template.width > 0 && template.height > 0) {
              newSign.corners = resizeSignToRealSize(newSign.corners, template.width, template.height, calibration) ?? newSign.corners;
          }
          
          updateActiveCanvas({
              signs: [...activeCanvas.signs, newSign],
              activeSignId: id
          });
      }
      // A library sign must be immediately editable even when the user opened
      // the library while Pan or a measurement tool was active.
      activateTool('select');
      setIsLibraryOpen(false);
  };

  // Helper to add a new custom field to title block
  const addTitleBlockField = () => {
    const newField: TitleBlockField = {
      id: Date.now().toString(),
      label: 'NEW FIELD',
      value: '',
      section: 'project',
      isCustom: true
    };
    updateStateWithHistory({
      titleBlock: {
        ...state.titleBlock,
        fields: [...state.titleBlock.fields, newField]
      }
    });
  };

  const updateTitleBlockField = (id: string, updates: Partial<TitleBlockField>) => {
    const newFields = state.titleBlock.fields.map(f => f.id === id ? { ...f, ...updates } : f);
    updateState({
      titleBlock: { ...state.titleBlock, fields: newFields }
    });
  };

  const removeTitleBlockField = (id: string) => {
    const newFields = state.titleBlock.fields.filter(f => f.id !== id);
    updateStateWithHistory({
      titleBlock: { ...state.titleBlock, fields: newFields }
    });
  };
  
  const saveCustomTemplate = () => {
      const name = prompt("Enter a name for your custom template:", "My Custom Template");
      if (!name) return;
      
      const newTemplate = {
          ...state.titleBlock.style,
          id: `custom-${Date.now()}`,
          name: name
      };
      
      updateState({
          savedTemplates: [...state.savedTemplates, newTemplate],
          titleBlock: { ...state.titleBlock, style: newTemplate }
      });
      notify('Template saved to library!', 'success');
  };

  const activeSign = activeCanvas.signs.find(s => s.id === activeCanvas.activeSignId);

  useEffect(() => {
      if (!activeSign?.extrusionEnabled || activeSign.elements?.length || !activeSign.image) return;
      const sign = activeSign;
      const detectionKey = `${sign.id}|${sign.image}`;
      if (preparedExtrusionKeysRef.current.has(detectionKey)) return;
      preparedExtrusionKeysRef.current.add(detectionKey);
      let cancelled = false;
      setPreparingExtrusionId(sign.id);
      void detectSignArtwork(sign.image, { sensitivity: 0.5, minAreaPct: 0.05 })
        .then(({ elements, sourceSize }) => {
          if (cancelled) return;
          if (!elements.length) {
            notify('No letters or logo could be isolated. Open 3D Elements to refine detection.', 'warning');
            return;
          }
          const elementDepth = Math.max(
            2,
            sourceSize.width * sign.extrusionDepth / VISUAL_EXTRUSION_REFERENCE_WIDTH_PX,
          );
          updateSignById(sign.id, {
            elements: elements.map((element, index) => ({
              id: `auto-${index}-${Math.round(element.bbox.x)}-${Math.round(element.bbox.y)}`,
              name: `Letter / logo ${index + 1}`,
              contours: element.contours,
              depth: elementDepth,
              enabled: true,
            })),
            elementsSourceSize: sourceSize,
            elementDepthModel: 'relative-width-v1',
          });
        })
        .catch(error => {
          if (!cancelled) notify(error instanceof Error ? error.message : 'Could not prepare 3D artwork.', 'error');
        })
        .finally(() => {
          if (!cancelled) setPreparingExtrusionId(current => current === sign.id ? null : current);
        });
      return () => {
        cancelled = true;
        preparedExtrusionKeysRef.current.delete(detectionKey);
      };
  }, [activeSign?.elements?.length, activeSign?.extrusionEnabled, activeSign?.id, activeSign?.image]);

  const updateLetterDepth = (depth: number) => {
      if (!activeSign) return;
      const ratio = depth / Math.max(1, activeSign.extrusionDepth);
      updateActiveSign({
          extrusionDepth: depth,
          backingDepth: Math.min(getBackingDepth(activeSign), depth * 0.8),
          elements: activeSign.elements?.map(element => ({ ...element, depth: Math.max(1, element.depth * ratio) })),
      });
  };

  // --- Measurement / Calibration ---
  const calibration = activeCanvas.calibration ?? null;
  const planes = getCalibrationPlanes(calibration);
  const selectedPlane = planes.find(plane => plane.id === calibration?.activePlaneId) ?? planes[0];
  const placement: PlacementSettings = activeCanvas.placement ?? {
      snapEnabled: true,
      showVanishingGuides: false,
      lens: { enabled: false, k1: 0, k2: 0 },
      camera: { enabled: false, fieldOfViewDeg: 60, estimated: true },
  };
  const updatePlacement = (updates: Partial<PlacementSettings>) => updateActiveCanvas({ placement: { ...placement, ...updates } });
  const updateCameraEnabled = (enabled: boolean) => {
      updateActiveCanvasWithHistory({
          placement: { ...placement, camera: { ...placement.camera, enabled } },
          signs: enabled
              ? activeCanvas.signs
              : activeCanvas.signs.map(sign => sign.projectionMode === 'camera-3d' ? { ...sign, projectionMode: 'planar' as const } : sign),
      });
  };
  const updateProjectionMode = (projectionMode: 'planar' | 'camera-3d') => {
      if (!activeSign) return;
      const camera = projectionMode === 'camera-3d'
          ? { ...placement.camera, enabled: true }
          : placement.camera;
      updateActiveCanvasWithHistory({
          signs: activeCanvas.signs.map(sign => sign.id === activeSign.id ? { ...sign, projectionMode } : sign),
          placement: { ...placement, camera },
      });
  };
  const selectPlane = (planeId: string) => {
      if (!calibration) return;
      const plane = planes.find(item => item.id === planeId);
      if (!plane) return;
      updateActiveCanvasWithHistory({
          calibration: { ...calibration, activePlaneId: plane.id, plane: { corners: plane.corners, widthMm: plane.widthMm, heightMm: plane.heightMm } },
          signs: activeSign
              ? activeCanvas.signs.map(sign => sign.id === activeSign.id ? { ...sign, calibrationPlaneId: plane.id } : sign)
              : activeCanvas.signs,
      });
  };
  const mmPerPx = calibration ? getMmPerPx(calibration) : null;

  const activateTool = (mode: ToolMode) => {
      setToolMode(mode);
      setMobilePanelExpanded(false);
  };

  const activatePan = () => {
      if (viewLocked) onViewLockedChange(false);
      activateTool('pan');
  };

  const startCalibration = () => {
      setMobilePanelExpanded(false);
      onOpenCalibration();
  };

  const startLineMeasurement = () => {
      if (calibration) activateTool('draw_line');
      else startCalibration();
  };

  const setUnitSystem = (system: UnitSystem) => {
      // Re-label every auto-measured dimension across all views in the new units
      const newCanvases = state.canvases.map(c => {
          if (!c.calibration) return c;
          return {
              ...c,
              dimensions: c.dimensions.map(d => d.autoMeasured ? {
                  ...d,
                  text: d.variant === 'box'
                      ? measureBox(d.start, d.end, c.calibration!, system)
                      : measureLine(d.start, d.end, c.calibration!, system)
              } : d)
          };
      });
      updateState({ unitSystem: system, canvases: newCanvases });
  };

  const signCalibration = calibrationForPlane(calibration, activeSign?.calibrationPlaneId);
  const signSizeMm = activeSign && signCalibration ? measureSignSizeMm(activeSign.corners, signCalibration) : null;
  const sizeInputUnit = state.unitSystem === 'metric' ? 'm' : 'ft';
  const sizeInputFactor = toMm(1, sizeInputUnit);
  const aspectLocked = activeSign?.aspectLocked !== false;
  const currentAspect = activeSign?.realWidthMm && activeSign?.realHeightMm
      ? activeSign.realWidthMm / activeSign.realHeightMm
      : signSizeMm && signSizeMm.height > 0 ? signSizeMm.width / signSizeMm.height : null;

  useEffect(() => {
      if (!signSizeMm) {
          setTargetWidth('');
          setTargetHeight('');
          return;
      }
      const decimals = state.unitSystem === 'metric' ? 3 : 2;
      setTargetWidth(Number((signSizeMm.width / sizeInputFactor).toFixed(decimals)).toString());
      setTargetHeight(Number((signSizeMm.height / sizeInputFactor).toFixed(decimals)).toString());
  }, [activeSign?.id, signSizeMm?.width, signSizeMm?.height, sizeInputFactor, state.unitSystem]);

  const updateTargetWidth = (value: string) => {
      setTargetWidth(value);
      const numeric = Number(value);
      if (aspectLocked && currentAspect && numeric > 0) setTargetHeight(Number((numeric / currentAspect).toFixed(3)).toString());
  };

  const updateTargetHeight = (value: string) => {
      setTargetHeight(value);
      const numeric = Number(value);
      if (aspectLocked && currentAspect && numeric > 0) setTargetWidth(Number((numeric * currentAspect).toFixed(3)).toString());
  };

  const applySignSize = () => {
      if (!activeSign || !signCalibration) return;
      const widthMm = toMm(Number(targetWidth), sizeInputUnit);
      const heightMm = toMm(Number(targetHeight), sizeInputUnit);
      if (!(widthMm > 0) || !(heightMm > 0)) return;
      const corners = resizeSignToRealSize(activeSign.corners, widthMm, heightMm, signCalibration);
      if (!corners) {
          notify('Could not project that size onto the calibrated wall.', 'error');
          return;
      }
      updateActiveSign({ corners, realWidthMm: widthMm, realHeightMm: heightMm });
      activateTool('select');
  };

  const nudgeActiveSign = (dx: number, dy: number) => {
      if (!activeSign) return;
      const signs = activeCanvas.signs.map(sign => sign.id === activeSign.id ? {
          ...sign,
          corners: sign.corners.map(point => ({ x: point.x + dx, y: point.y + dy })) as [Point, Point, Point, Point]
      } : sign);
      updateActiveCanvasWithHistory({ signs });
  };

  return (
    <>
      <div
        data-testid="controls-panel"
        data-mobile-expanded={mobilePanelExpanded}
        data-layout={forceSidePanel ? 'tablet-side-panel' : 'responsive'}
        className={forceSidePanel
          ? 'static z-20 flex h-full w-80 flex-shrink-0 flex-col border-r border-gray-700 bg-gray-900 shadow-xl pointer-events-auto'
          : `fixed inset-x-0 bottom-0 z-[80] flex flex-col transition-[height] duration-300 ease-out lg:static lg:z-20 lg:h-full lg:w-80 lg:flex-shrink-0 lg:border-r lg:border-gray-700 lg:bg-gray-900 lg:shadow-xl lg:pointer-events-auto ${mobilePanelExpanded ? 'h-[min(78dvh,720px)] rounded-t-3xl border-t border-gray-700 bg-gray-900 shadow-[0_-18px_60px_rgba(0,0,0,0.55)]' : 'h-[calc(78px+env(safe-area-inset-bottom))] pointer-events-none'}`}
      >
        {!forceSidePanel && !mobilePanelExpanded && (
          <div data-testid="mobile-tool-dock" className="pointer-events-auto mx-2 mb-[max(0.5rem,env(safe-area-inset-bottom))] mt-auto rounded-2xl border border-gray-700/90 bg-gray-900/95 p-1.5 shadow-2xl backdrop-blur-xl lg:hidden">
            <div className="grid grid-cols-5 gap-1">
              <MobileDockButton label="Select" ariaLabel="Select & adjust" active={toolMode === 'select'} onClick={() => activateTool('select')} icon={<MousePointer2 className="h-5 w-5" />} />
              <MobileDockButton
                label={viewLocked ? 'Locked' : 'Pan'}
                ariaLabel={viewLocked ? 'Unlock view' : 'Pan view'}
                active={!viewLocked && toolMode === 'pan'}
                warning={viewLocked}
                onClick={activatePan}
                icon={viewLocked ? <Lock className="h-5 w-5" /> : <Hand className="h-5 w-5" />}
              />
              <MobileDockButton label="Draw" ariaLabel="Draw and take a note" active={toolMode === 'annotate'} onClick={() => activateTool('annotate')} icon={<PencilLine className="h-5 w-5" />} />
              <MobileDockButton label={calibration ? 'Calibrated' : 'Scale'} ariaLabel={calibration ? 'Edit calibration' : 'Set real-world scale'} active={toolMode === 'calibrate' || toolMode === 'calibrate_plane'} accent onClick={startCalibration} icon={<Ruler className="h-5 w-5" />} />
              <MobileDockButton label="More" ariaLabel="Open all controls" onClick={() => setMobilePanelExpanded(true)} icon={<Settings className="h-5 w-5" />} />
            </div>
          </div>
        )}

        {!forceSidePanel && mobilePanelExpanded && <button onClick={() => setMobilePanelExpanded(false)} className="grid min-h-6 w-full place-items-center lg:hidden" aria-label="Collapse controls"><span className="h-1 w-10 rounded-full bg-gray-600" /></button>}

        <div className={`${forceSidePanel || mobilePanelExpanded ? 'flex' : 'hidden'} flex-shrink-0 items-center justify-between border-b border-gray-700 bg-gray-800 ${forceSidePanel ? 'p-6' : 'px-3 py-2.5 lg:flex lg:p-6'}`}>
          <div className="flex-1 min-w-0 pr-2">
            <h1 className="flex items-center gap-2 truncate text-base font-bold text-white lg:text-xl">
                <Move3d className="h-5 w-5 flex-shrink-0 text-blue-400 lg:h-6 lg:w-6" />
                <span className="truncate">{state.projectName || 'SignagePro'}</span>
            </h1>
            <p className="mt-0.5 hidden truncate text-[11px] text-gray-400 sm:block lg:mt-1 lg:text-xs">Proposal Mockup Tool</p>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
             <button 
                onClick={onOpenProjectManager} 
                aria-label="Manage projects"
                className={`inline-flex items-center gap-1.5 rounded-lg px-2 text-blue-300 transition-colors hover:bg-gray-700 hover:text-white ${forceSidePanel ? 'min-h-11 min-w-11 justify-center' : 'min-h-9'}`}
                title="Manage Projects"
             >
                <FolderOpen className="w-4 h-4" />
                <span className="hidden text-xs font-semibold xl:inline">Projects</span>
             </button>
             <div className="w-px h-4 bg-gray-600 mx-1"></div>
             <button 
                onClick={() => setShowAssistant(!showAssistant)} 
                className={`${forceSidePanel ? 'grid h-11 w-11 place-items-center' : 'p-1.5'} transition-colors rounded hover:bg-gray-700 ${showAssistant ? 'text-blue-400 bg-blue-900/30' : 'text-gray-400 hover:text-white'}`}
                title={showAssistant ? "Hide Assistant" : "Show Assistant"}
             >
                <Sparkles className="w-4 h-4" />
             </button>
             <div className="w-px h-4 bg-gray-600 mx-1"></div>
             <button 
                onClick={undo} 
                disabled={!canUndo}
                className={`${forceSidePanel ? 'grid h-11 w-11 place-items-center' : 'p-1.5'} text-gray-400 hover:text-white disabled:opacity-30 disabled:hover:text-gray-400 transition-colors rounded hover:bg-gray-700`}
                title="Undo"
             >
                <Undo2 className="w-4 h-4" />
             </button>
             <button 
                onClick={redo} 
                disabled={!canRedo}
                className={`${forceSidePanel ? 'grid h-11 w-11 place-items-center' : 'p-1.5'} text-gray-400 hover:text-white disabled:opacity-30 disabled:hover:text-gray-400 transition-colors rounded hover:bg-gray-700`}
                title="Redo"
             >
                <Redo2 className="w-4 h-4" />
             </button>
             {!forceSidePanel && <button onClick={() => setMobilePanelExpanded(false)} className="ml-1 grid h-10 w-10 place-items-center rounded-xl text-gray-300 hover:bg-gray-700 lg:hidden" aria-label="Collapse controls"><ChevronDown className="h-5 w-5" /></button>}
          </div>
        </div>

        {/* Tab Header */}
        <div className={`${forceSidePanel || mobilePanelExpanded ? 'flex' : 'hidden'} flex-shrink-0 overflow-x-auto border-b border-gray-700 bg-gray-900 no-scrollbar lg:flex`}>
           <button 
              onClick={() => setActiveTab('editor')}
              className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors border-b-2 min-w-[80px] ${activeTab === 'editor' ? 'text-blue-400 border-blue-400 bg-gray-800' : 'text-gray-400 border-transparent hover:text-gray-200 hover:bg-gray-800/50'}`}
           >
              <Layout className="w-4 h-4" /> Editor
           </button>
           <button 
              onClick={() => setActiveTab('page')}
              className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors border-b-2 min-w-[100px] ${activeTab === 'page' ? 'text-blue-400 border-blue-400 bg-gray-800' : 'text-gray-400 border-transparent hover:text-gray-200 hover:bg-gray-800/50'}`}
           >
              <FileText className="w-4 h-4" /> Title Block
           </button>
           <button 
              onClick={() => setActiveTab('notes')}
              className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors border-b-2 min-w-[80px] ${activeTab === 'notes' ? 'text-blue-400 border-blue-400 bg-gray-800' : 'text-gray-400 border-transparent hover:text-gray-200 hover:bg-gray-800/50'}`}
           >
              <Notebook className="w-4 h-4" /> Notes
           </button>
           <button
              onClick={() => setActiveTab('survey')}
              className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors border-b-2 min-w-[80px] ${activeTab === 'survey' ? 'text-cyan-300 border-cyan-300 bg-gray-800' : 'text-gray-400 border-transparent hover:text-gray-200 hover:bg-gray-800/50'}`}
           >
              <MapPin className="w-4 h-4" /> Survey
           </button>
        </div>

        <div className={`${forceSidePanel || mobilePanelExpanded ? 'block' : 'hidden'} flex-1 overflow-y-auto custom-scrollbar ${forceSidePanel ? 'space-y-8 p-6' : 'space-y-5 p-3 lg:block lg:space-y-8 lg:p-6'}`}>
          
          {/* EDITOR TAB CONTENT */}
          {activeTab === 'editor' && (
            <>
              {/* Canvas/Scene Manager */}
              <div className="bg-gray-800 rounded-lg p-3 border border-gray-700">
                   <div className="flex items-center justify-between mb-2">
                        <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider flex items-center gap-1">
                            <Monitor className="w-3 h-3" /> Scene View
                        </h2>
                        <button 
                            onClick={deleteCanvas}
                            className="text-gray-500 hover:text-red-400"
                            title="Delete current view"
                        >
                            <Trash2 className="w-3 h-3" />
                        </button>
                   </div>
                   <div className="relative">
                        <button 
                            onClick={() => setIsViewMenuOpen(!isViewMenuOpen)}
                            className="w-full flex items-center justify-between bg-gray-900 border border-gray-600 text-white text-sm px-3 py-2 rounded hover:bg-gray-700 transition-colors"
                        >
                            <span>{activeCanvas.name}</span>
                            <ChevronDown className="w-4 h-4 text-gray-400" />
                        </button>
                        {isViewMenuOpen && (
                            <div className="absolute top-full left-0 right-0 mt-1 bg-gray-800 border border-gray-600 rounded shadow-xl z-50 overflow-hidden">
                                {state.canvases.map(canvas => (
                                    <button
                                        key={canvas.id}
                                        onClick={() => {
                                            updateState({ activeCanvasId: canvas.id });
                                            setIsViewMenuOpen(false);
                                        }}
                                        className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-gray-700 ${canvas.id === activeCanvas.id ? 'text-blue-400 bg-blue-900/20' : 'text-gray-300'}`}
                                    >
                                        {canvas.name}
                                        {canvas.id === activeCanvas.id && <Check className="w-3 h-3" />}
                                    </button>
                                ))}
                                <div className="border-t border-gray-700 p-1">
                                    <button 
                                        onClick={() => { addCanvas(); setIsViewMenuOpen(false); }}
                                        className="w-full flex items-center justify-center gap-2 text-xs text-blue-400 hover:text-white py-1.5 hover:bg-blue-600 rounded"
                                    >
                                        <Plus className="w-3 h-3" /> Add New View
                                    </button>
                                </div>
                            </div>
                        )}
                   </div>
                   <div className="mt-2 space-y-2">
                        <input 
                             type="text" 
                             value={activeCanvas.name} 
                             onChange={(e) => updateActiveCanvas({ name: e.target.value })}
                             className="view-name-input w-full rounded-sm border-b border-gray-700 bg-transparent pb-1 text-xs text-gray-400 outline-none focus:border-blue-400 focus:text-white"
                             placeholder="View Name"
                        />
                   </div>
              </div>

              {/* Scene Settings */}
              <div className="space-y-4">
                <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Background</h2>
                <div className="flex gap-2 flex-wrap">
                    <button 
                      onClick={() => { setUploadTarget('background'); setIsUploaderOpen(true); }}
                      className="flex-grow flex items-center justify-center p-3 bg-gray-800 rounded-lg hover:bg-gray-700 border border-gray-600 transition-colors gap-2"
                      title="Upload Background"
                    >
                      <ImageIcon className="w-4 h-4 text-gray-400" />
                      <span className="text-xs text-gray-300">New Image / Camera</span>
                    </button>

                    <button 
                      onClick={() => { setIsCropping(!isCropping); }}
                      className={`flex items-center justify-center p-3 rounded-lg border transition-all gap-2 ${
                        isCropping 
                          ? 'bg-blue-600 border-blue-500 text-white shadow-lg shadow-blue-900/50' 
                          : 'bg-gray-800 border-gray-600 text-gray-300 hover:bg-gray-750'
                      }`}
                      title="Crop Background"
                    >
                      <Scissors className="w-4 h-4" />
                    </button>

                    <button 
                      onClick={onOpenCleanup}
                      className="flex items-center justify-center p-3 rounded-lg border transition-all gap-2 bg-gray-800 border-gray-600 text-gray-300 hover:bg-gray-750"
                      title="Magic Clean Up (Eraser)"
                    >
                      <Eraser className="w-4 h-4" />
                    </button>
                    
                    <button
                      onClick={() => updateState({ isNightMode: !state.isNightMode })}
                      aria-pressed={state.isNightMode}
                      className={`flex min-w-[132px] flex-1 items-center justify-center p-3 rounded-lg border transition-all gap-2 ${
                        state.isNightMode 
                          ? 'bg-indigo-950 border-cyan-400/70 text-cyan-100 shadow-[0_0_18px_rgba(34,211,238,0.16)]'
                          : 'bg-gray-800 border-gray-600 text-gray-300 hover:bg-gray-750'
                      }`}
                      title="Preview illuminated signage after dark"
                    >
                      {state.isNightMode ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
                      <span className="text-xs font-medium">{state.isNightMode ? 'Night preview on' : 'Night preview'}</span>
                    </button>
                </div>
              </div>
              
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider flex items-center gap-2">
                        <Ruler className="w-4 h-4" /> Dimensions
                    </h2>
                    <div className="flex items-center gap-1">
                        <button
                            onClick={() => setUnitSystem(state.unitSystem === 'metric' ? 'imperial' : 'metric')}
                            className="px-2 py-1 rounded text-[10px] font-bold text-gray-400 hover:text-white bg-gray-800 border border-gray-700 transition-colors"
                            title={`Switch to ${state.unitSystem === 'metric' ? 'imperial (ft/in)' : 'metric (m/cm)'} units`}
                        >
                            {state.unitSystem === 'metric' ? 'm · cm' : 'ft · in'}
                        </button>
                        <button
                            onClick={() => updateState({ showDimensions: !state.showDimensions })}
                            className={`p-1.5 rounded transition-colors ${state.showDimensions ? 'text-blue-400 bg-blue-900/20' : 'text-gray-500 hover:text-gray-300'}`}
                        >
                            {state.showDimensions ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                        </button>
                    </div>
                </div>
                <div>
                    <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-500">Canvas navigation</p>
                    <div className="grid grid-cols-2 gap-2">
                        <button onClick={() => activateTool('select')} className={`flex min-h-11 items-center justify-center gap-2 rounded-lg border text-xs transition-colors ${toolMode === 'select' ? 'border-blue-500 bg-blue-600 text-white' : 'border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-600 hover:text-white'}`}><MousePointer2 className="h-4 w-4" /> Select & adjust</button>
                        <button onClick={activatePan} className={`flex min-h-11 items-center justify-center gap-2 rounded-lg border text-xs transition-colors ${toolMode === 'pan' && !viewLocked ? 'border-blue-500 bg-blue-600 text-white' : 'border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-600 hover:text-white'}`} title="Drag to move the view; pinch with two fingers to zoom"><Hand className="h-4 w-4" /> Pan view</button>
                        <button
                            type="button"
                            aria-label={viewLocked ? 'Unlock view' : 'Lock view'}
                            aria-pressed={viewLocked}
                            onClick={() => onViewLockedChange(!viewLocked)}
                            className={`col-span-2 flex min-h-12 items-center gap-3 rounded-xl border px-3 text-left transition-colors ${viewLocked ? 'border-amber-400/70 bg-amber-500/15 text-amber-100' : 'border-gray-700 bg-gray-800 text-gray-200 hover:border-gray-600 hover:bg-gray-750'}`}
                        >
                            <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${viewLocked ? 'bg-amber-400/20 text-amber-300' : 'bg-gray-700 text-gray-300'}`}>
                                {viewLocked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                            </span>
                            <span className="min-w-0">
                                <strong className="block text-xs">{viewLocked ? 'View locked — tap to unlock' : 'Lock pan and zoom'}</strong>
                                <span className="mt-0.5 block text-[10px] text-gray-400">Sign, dimension and calibration editing stays active.</span>
                            </span>
                        </button>
                    </div>
                </div>

                {calibration && mmPerPx ? (
                    <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-3">
                        <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                                <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">Calibrated</p>
                                <p className="mt-1 truncate text-xs font-medium text-white">
                                    {calibration.plane ? `Perspective wall · ${formatLength(calibration.plane.widthMm, state.unitSystem)} × ${formatLength(calibration.plane.heightMm, state.unitSystem)}` : `Straight-on reference · ${calibration.realValue}${calibration.unit}`}
                                </p>
                            </div>
                            <Grid className={`h-5 w-5 shrink-0 ${calibration.plane ? 'text-emerald-300' : 'text-blue-300'}`} />
                        </div>
                        <div className="mt-3 grid grid-cols-3 gap-2">
                            <button onClick={startCalibration} className="min-h-10 rounded-lg bg-gray-800 px-2 text-xs text-gray-200 hover:bg-gray-700">Edit scale</button>
                            <button onClick={() => setShowCalibrationReference(!showCalibrationReference)} className="min-h-10 rounded-lg bg-gray-800 px-2 text-xs text-gray-200 hover:bg-gray-700">{showCalibrationReference ? 'Hide ref' : 'Show ref'}</button>
                            <button onClick={() => { updateActiveCanvasWithHistory({ calibration: null }); setShowCalibrationReference(false); }} className="min-h-10 rounded-lg bg-gray-800 px-2 text-xs text-red-300 hover:bg-red-950/60">Clear</button>
                        </div>
                    </div>
                ) : (
                    <button onClick={startCalibration} className="flex min-h-16 w-full items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-left transition hover:border-amber-400 hover:bg-amber-500/15">
                        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-500/20 text-amber-300"><Ruler className="h-5 w-5" /></span>
                        <span><strong className="block text-sm text-white">Set real-world scale</strong><span className="mt-0.5 block text-xs text-gray-400">Guided 2-point or perspective-wall calibration</span></span>
                    </button>
                )}

                <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/5 p-3 space-y-3">
                    <div className="flex items-center justify-between"><div><p className="text-xs font-semibold text-cyan-100">Professional placement</p><p className="text-[10px] text-gray-500">Planes, guides and camera correction</p></div><Move3d className="h-5 w-5 text-cyan-300" /></div>
                    <div className="grid grid-cols-2 gap-2">
                        <label className="flex min-h-10 items-center justify-between rounded-lg bg-gray-800 px-2 text-[11px] text-gray-300">Centre snapping<input aria-label="Centre snapping" type="checkbox" checked={placement.snapEnabled} onChange={event => updatePlacement({ snapEnabled: event.target.checked })} className="accent-cyan-500" /></label>
                        <label className="flex min-h-10 items-center justify-between rounded-lg bg-gray-800 px-2 text-[11px] text-gray-300">Vanishing guides<input aria-label="Vanishing-point guides" type="checkbox" checked={placement.showVanishingGuides} onChange={event => updatePlacement({ showVanishingGuides: event.target.checked })} className="accent-cyan-500" /></label>
                    </div>
                    {planes.length > 0 && <div className="grid grid-cols-[1fr_auto] gap-2"><select aria-label="Active calibrated plane" value={calibration?.activePlaneId ?? planes[0].id} onChange={event => selectPlane(event.target.value)} className="min-h-10 rounded-lg border border-gray-700 bg-gray-900 px-2 text-xs text-white">{planes.map(plane => <option key={plane.id} value={plane.id}>{plane.name}</option>)}</select><button type="button" onClick={() => onOpenCalibration({ addPlane: true })} className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 text-xs text-cyan-200 hover:bg-cyan-500/20">+ Plane</button></div>}
                    {selectedPlane?.calibrationKind === 'parallel-offset' && (
                        <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-2.5 py-2 text-[10px] text-cyan-100">
                            Parallel offset · {Math.abs(selectedPlane.offsetMm ?? 0).toFixed(0)}mm {Number(selectedPlane.offsetMm) < 0 ? 'forward' : 'behind'} · {selectedPlane.cameraConfidence === 'verified' ? 'verified camera' : 'estimated camera'}
                        </div>
                    )}
                    <div className="border-t border-gray-700 pt-3 space-y-2">
                        <label className="flex min-h-10 items-center justify-between text-xs text-gray-300"><span>Lens correction <span className="block text-[9px] text-gray-500">Non-destructive radial model</span></span><input aria-label="Lens distortion correction" type="checkbox" checked={placement.lens.enabled} onChange={event => updatePlacement({ lens: { ...placement.lens, enabled: event.target.checked } })} className="accent-cyan-500" /></label>
                        {placement.lens.enabled && <><div><div className="flex justify-between text-[10px] text-gray-400"><span>Barrel / pincushion</span><span>{placement.lens.k1.toFixed(2)}</span></div><input aria-label="Primary lens correction" type="range" min="-0.5" max="0.5" step="0.01" value={placement.lens.k1} onChange={event => updatePlacement({ lens: { ...placement.lens, k1: Number(event.target.value) } })} className="w-full accent-cyan-500" /></div><div><div className="flex justify-between text-[10px] text-gray-400"><span>Edge refinement</span><span>{placement.lens.k2.toFixed(2)}</span></div><input aria-label="Secondary lens correction" type="range" min="-0.25" max="0.25" step="0.01" value={placement.lens.k2} onChange={event => updatePlacement({ lens: { ...placement.lens, k2: Number(event.target.value) } })} className="w-full accent-cyan-500" /></div><p className="text-[9px] text-amber-300">Changing correction changes photo geometry; refine calibration points afterward.</p></>}
                    </div>
                    <div className="border-t border-gray-700 pt-3 space-y-2">
                        <label className="flex min-h-10 items-center justify-between text-xs text-gray-300"><span>Camera pose <span className="block text-[9px] text-gray-500">For projecting and freestanding signs</span></span><input aria-label="Camera pose estimation" type="checkbox" checked={placement.camera.enabled} onChange={event => updateCameraEnabled(event.target.checked)} className="accent-cyan-500" /></label>
                        {placement.camera.enabled && <label className="block text-[10px] text-gray-400">Horizontal field of view · {placement.camera.fieldOfViewDeg}°<input aria-label="Camera field of view" type="range" min="25" max="100" step="1" value={placement.camera.fieldOfViewDeg} onChange={event => updatePlacement({ camera: { ...placement.camera, fieldOfViewDeg: Number(event.target.value), estimated: true, focalLengthPx: undefined } })} className="mt-1 w-full accent-cyan-500" /><span className="mt-1 block text-[9px] text-amber-300">Estimated pose · enter verified camera data in a future EXIF workflow for survey-grade output.</span></label>}
                    </div>
                </div>

                <div>
                    <div className="mb-1.5 flex items-center justify-between"><p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Measure</p>{!calibration && <span className="text-[10px] text-amber-400">Set scale first</span>}</div>
                    <div className="grid grid-cols-2 gap-2">
                        <button onClick={startLineMeasurement} className={`flex min-h-11 items-center justify-center gap-2 rounded-lg border text-xs transition-colors ${toolMode === 'draw_line' ? 'border-blue-500 bg-blue-600 text-white' : 'border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-600 hover:text-white'}`}><PenTool className="h-4 w-4" /> Measure line</button>
                        <button onClick={() => calibration ? activateTool('draw_box') : startCalibration()} className={`flex min-h-11 items-center justify-center gap-2 rounded-lg border text-xs transition-colors ${toolMode === 'draw_box' ? 'border-blue-500 bg-blue-600 text-white' : 'border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-600 hover:text-white'}`}><Square className="h-4 w-4" /> Width × height</button>
                    </div>
                    <p className="mt-1.5 text-[10px] leading-snug text-gray-500">Tap the first point, then the second. Select a finished measurement to adjust its large handles.</p>
                </div>
                {activeCanvas.dimensions.length > 0 && state.showDimensions && (
                    <div className="space-y-2 max-h-32 overflow-y-auto pr-1 custom-scrollbar">
                        {activeCanvas.dimensions.map(dim => (
                            <div key={dim.id} onClick={() => { setActiveDimension(dim.id); activateTool('select'); }} className={`flex items-center justify-between p-2 rounded border cursor-pointer transition-all ${dim.id === activeCanvas.activeDimensionId ? 'bg-blue-900/20 border-blue-500/50' : 'bg-gray-800 border-gray-700 hover:border-gray-600'}`}>
                                <div className="flex items-center gap-2 text-sm text-gray-300">
                                    {dim.variant === 'box' ? <Square className="w-3 h-3 text-gray-500" /> : <PenTool className="w-3 h-3 text-gray-500" />}
                                    <span className="font-mono text-xs truncate max-w-[120px]">{dim.text || 'Untitled'}</span>
                                </div>
                                <button onClick={(e) => { e.stopPropagation(); removeDimension(dim.id); }} className="text-gray-500 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
                            </div>
                        ))}
                    </div>
                )}
                <div className="rounded-xl border border-orange-500/30 bg-orange-500/5 p-3">
                    <div className="flex items-center justify-between gap-3">
                        <div><p className="text-xs font-semibold text-orange-100">Draw & note</p><p className="mt-0.5 text-[10px] text-gray-500">Use a pen, finger, or mouse on the image.</p></div>
                        <button type="button" onClick={() => activateTool('annotate')} className={`flex min-h-10 items-center gap-2 rounded-lg border px-3 text-xs transition-colors ${toolMode === 'annotate' ? 'border-orange-400 bg-orange-500 text-gray-950' : 'border-orange-500/40 bg-gray-800 text-orange-200 hover:border-orange-400'}`}><PencilLine className="h-4 w-4" /> {toolMode === 'annotate' ? 'Drawing' : 'Draw'}</button>
                    </div>
                    {(activeCanvas.annotations ?? []).length > 0 && <div className="mt-3 space-y-2">
                        {(activeCanvas.annotations ?? []).map((annotation, index) => <div key={annotation.id} className="rounded-lg border border-gray-700 bg-gray-900 p-2">
                            <div className="mb-1.5 flex items-center gap-2"><MessageSquareText className="h-3.5 w-3.5 text-orange-400" /><span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Note {index + 1}</span><button type="button" aria-label={`Delete note ${index + 1}`} onClick={() => updateActiveCanvasWithHistory({ annotations: (activeCanvas.annotations ?? []).filter(item => item.id !== annotation.id) })} className="ml-auto rounded p-1 text-gray-500 hover:bg-red-950 hover:text-red-300"><Trash2 className="h-3.5 w-3.5" /></button></div>
                            <textarea aria-label={`Annotation note ${index + 1}`} value={annotation.note} placeholder="Type a note about this mark…" onChange={event => updateActiveCanvas({ annotations: (activeCanvas.annotations ?? []).map(item => item.id === annotation.id ? { ...item, note: event.target.value } : item) })} rows={2} className="w-full resize-none rounded-md border border-gray-700 bg-gray-800 px-2.5 py-2 text-xs text-white outline-none placeholder:text-gray-600 focus:border-orange-400" />
                            <div className="mt-2 flex items-center justify-between gap-2">
                                <span className="text-[9px] text-gray-600">Up to 55 seconds</span>
                                <NoteRecorder label={`Record note ${index + 1}`} onTranscript={transcript => updateActiveCanvasWithHistory({ annotations: (activeCanvas.annotations ?? []).map(item => item.id === annotation.id ? { ...item, note: item.note ? `${item.note} ${transcript}` : transcript } : item) })} />
                            </div>
                        </div>)}
                    </div>}
                </div>
              </div>

              {/* Signs List */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider flex items-center gap-2">
                    <Layers className="w-4 h-4" /> Signs
                  </h2>
                  <div className="flex gap-1">
                      <button onClick={() => setIsLibraryOpen(true)} className="p-1.5 bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors flex items-center gap-1 text-xs"><Library className="w-3.5 h-3.5" /> Lib</button>
                      <button onClick={addSign} className="p-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"><Plus className="w-4 h-4" /></button>
                  </div>
                </div>
                <div className="space-y-2 max-h-48 overflow-y-auto pr-1 custom-scrollbar">
                  {activeCanvas.signs.map((sign) => (
                    <div key={sign.id} onClick={() => { setActiveSign(sign.id); activateTool('select'); }} className={`flex items-center justify-between p-3 rounded border cursor-pointer transition-all ${sign.id === activeCanvas.activeSignId ? 'bg-blue-900/20 border-blue-500/50 ring-1 ring-blue-500/50' : 'bg-gray-800 border-gray-700 hover:border-gray-600'}`}>
                      <div className="flex items-center gap-3 overflow-hidden flex-1 min-w-0 mr-2">
                        <div className="w-8 h-8 rounded bg-gray-700 overflow-hidden flex-shrink-0 border border-gray-600">
                          <img src={sign.image} className="w-full h-full object-cover" alt="" />
                        </div>
                        <span className="text-sm text-white truncate">{sign.name}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={(e) => { e.stopPropagation(); duplicateSign(sign.id); }} className="p-1.5 text-gray-500 hover:text-blue-400"><Copy className="w-3.5 h-3.5" /></button>
                        <button onClick={(e) => { e.stopPropagation(); removeSign(sign.id); }} className="p-1.5 text-gray-500 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              
              {/* Properties Section */}
              <div className="border-t border-gray-700 pt-4 space-y-4">
                 <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Properties</h2>
                 {activeSign && (
                    <div className="space-y-4 animate-in fade-in duration-200">
                          <div className="flex gap-2">
                              <button onClick={() => setIsLibraryOpen(true)} className="flex-1 flex items-center justify-center p-3 bg-gray-800 rounded-lg hover:bg-gray-700 border border-gray-600 transition-colors group gap-2">
                                <Library className="w-4 h-4 text-gray-400 group-hover:text-blue-400" />
                                <span className="text-xs text-gray-300">Library</span>
                              </button>
                             <button onClick={() => { setUploadTarget('sign'); setIsUploaderOpen(true); }} className="flex-1 flex items-center justify-center p-3 bg-gray-800 rounded-lg hover:bg-gray-700 border border-gray-600 transition-colors group gap-2">
                                <Upload className="w-4 h-4 text-gray-400 group-hover:text-green-400" />
                                <span className="text-xs text-gray-300">Upload</span>
                              </button>
                          </div>

                          <div className="bg-blue-500/5 border border-blue-500/20 rounded-lg p-3 space-y-3">
                              <div className="flex items-center justify-between gap-3">
                                  <div>
                                      <div className="text-xs font-medium text-blue-200">Fine position</div>
                                      <div className="text-[10px] text-gray-500">Pinch to zoom, drag the sign, then nudge into place.</div>
                                  </div>
                                  <div className="flex rounded-md overflow-hidden border border-gray-600 flex-shrink-0">
                                      {([1, 5] as const).map(step => (
                                          <button
                                              key={step}
                                              type="button"
                                              aria-label={`${step} pixel nudge step`}
                                              aria-pressed={nudgeStep === step}
                                              onClick={() => setNudgeStep(step)}
                                              className={`min-h-9 px-2 text-[10px] font-mono ${nudgeStep === step ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                                          >{step}px</button>
                                      ))}
                                  </div>
                              </div>
                              <div className="grid grid-cols-3 gap-1.5 w-[142px] mx-auto">
                                  <span />
                                  <button type="button" aria-label="Nudge sign up" onClick={() => nudgeActiveSign(0, -nudgeStep)} className="min-h-11 rounded-md bg-gray-800 border border-gray-600 text-gray-200 hover:bg-blue-600 active:bg-blue-500 flex items-center justify-center"><ArrowUp className="w-4 h-4" /></button>
                                  <span />
                                  <button type="button" aria-label="Nudge sign left" onClick={() => nudgeActiveSign(-nudgeStep, 0)} className="min-h-11 rounded-md bg-gray-800 border border-gray-600 text-gray-200 hover:bg-blue-600 active:bg-blue-500 flex items-center justify-center"><ArrowLeft className="w-4 h-4" /></button>
                                  <div className="min-h-11 rounded-md bg-gray-900 border border-gray-700 text-[10px] text-gray-500 flex items-center justify-center font-mono">{nudgeStep}px</div>
                                  <button type="button" aria-label="Nudge sign right" onClick={() => nudgeActiveSign(nudgeStep, 0)} className="min-h-11 rounded-md bg-gray-800 border border-gray-600 text-gray-200 hover:bg-blue-600 active:bg-blue-500 flex items-center justify-center"><ArrowRight className="w-4 h-4" /></button>
                                  <span />
                                  <button type="button" aria-label="Nudge sign down" onClick={() => nudgeActiveSign(0, nudgeStep)} className="min-h-11 rounded-md bg-gray-800 border border-gray-600 text-gray-200 hover:bg-blue-600 active:bg-blue-500 flex items-center justify-center"><ArrowDown className="w-4 h-4" /></button>
                                  <span />
                              </div>
                          </div>

                          <div className="overflow-hidden rounded-xl border border-cyan-500/30 bg-gradient-to-br from-cyan-500/10 via-gray-900 to-gray-950">
                              <div className="flex items-center justify-between border-b border-cyan-500/20 px-3 py-2.5">
                                  <div className="flex items-center gap-2">
                                      <Move3d className="h-4 w-4 text-cyan-300" />
                                      <div>
                                          <p className="text-xs font-semibold text-white">Perspective & 3D</p>
                                          <p className="text-[10px] text-gray-400">Shape the face, then add physical depth.</p>
                                      </div>
                                  </div>
                                  <span className="rounded-full bg-cyan-400/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-cyan-300">Selected sign</span>
                              </div>
                              <div className="space-y-4 p-3">
                                  <div className="grid grid-cols-2 gap-2">
                                      <label className="text-[10px] uppercase tracking-wider text-gray-500">Placement anchor<select aria-label="Sign placement anchor" value={activeSign.placementAnchor ?? 'center'} onChange={event => updateActiveSign({ placementAnchor: event.target.value as PlacementAnchor })} className="mt-1 min-h-10 w-full rounded-lg border border-gray-700 bg-gray-800 px-2 text-xs normal-case text-white"><option value="center">Centre</option><option value="top-left">Top left</option><option value="top-center">Top centre</option><option value="top-right">Top right</option><option value="bottom-left">Bottom left</option><option value="bottom-center">Bottom centre</option><option value="bottom-right">Bottom right</option></select></label>
                                      {planes.length > 0 && <label className="text-[10px] uppercase tracking-wider text-gray-500">Surface<select aria-label="Sign calibrated plane" value={activeSign.calibrationPlaneId ?? calibration?.activePlaneId ?? planes[0].id} onChange={event => updateActiveSign({ calibrationPlaneId: event.target.value })} className="mt-1 min-h-10 w-full rounded-lg border border-gray-700 bg-gray-800 px-2 text-xs normal-case text-white">{planes.map(plane => <option key={plane.id} value={plane.id}>{plane.name}</option>)}</select></label>}
                                  </div>
                                  <div>
                                      <div className="mb-2 flex items-center justify-between">
                                          <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Perspective</span>
                                          <span className="text-[10px] text-gray-500">Drag blue corners to refine</span>
                                      </div>
                                      <div className="grid grid-cols-3 gap-2">
                                          <button type="button" onClick={() => applyPerspectivePreset('left')} className="min-h-10 rounded-lg border border-gray-700 bg-gray-800 text-xs text-gray-300 transition hover:border-cyan-500 hover:text-white">Left wall</button>
                                          <button type="button" onClick={() => applyPerspectivePreset('flat')} className="min-h-10 rounded-lg border border-gray-700 bg-gray-800 text-xs text-gray-300 transition hover:border-cyan-500 hover:text-white">Straight</button>
                                          <button type="button" onClick={() => applyPerspectivePreset('right')} className="min-h-10 rounded-lg border border-gray-700 bg-gray-800 text-xs text-gray-300 transition hover:border-cyan-500 hover:text-white">Right wall</button>
                                      </div>
                                  </div>
                                  <div className="border-t border-gray-700/70 pt-3">
                                      <label className="flex min-h-10 cursor-pointer items-center justify-between rounded-lg bg-gray-800 px-3">
                                          <span className="flex items-center gap-2 text-xs font-medium text-gray-200"><Box className="h-4 w-4 text-cyan-300" /> 3D extrusion</span>
                                          <input type="checkbox" checked={activeSign.extrusionEnabled} onChange={(e) => updateActiveSign({ extrusionEnabled: e.target.checked })} className="h-4 w-4 accent-cyan-500" />
                                      </label>
                                      {activeSign.extrusionEnabled && (
                                          <div className="mt-3 space-y-3">
                                              <label className="block text-xs text-gray-400">Sign construction<select aria-label="Sign extrusion construction" value={getSignExtrusionMode(activeSign)} onChange={event => updateActiveSign({ extrusionMode: event.target.value as 'backed' | 'individual' })} className="mt-1 min-h-10 w-full rounded-lg border border-gray-700 bg-gray-900 px-2 text-xs text-white"><option value="backed">Backing board + raised letters/logo</option><option value="individual">Individual letters/logo (no board)</option></select></label>
                                              {preparingExtrusionId === activeSign.id && <div data-testid="extrusion-detection-status" className="flex items-center gap-2 rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-[10px] text-cyan-200"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Isolating letters and logo…</div>}
                                              {planes.length > 0 && <label className="block text-xs text-gray-400">Projection model<select aria-label="Sign projection model" value={activeSign.projectionMode ?? 'planar'} onChange={event => updateProjectionMode(event.target.value as 'planar' | 'camera-3d')} className="mt-1 min-h-10 w-full rounded-lg border border-gray-700 bg-gray-900 px-2 text-xs text-white"><option value="planar">Visual 2D extrusion</option><option value="camera-3d">Camera-pose 3D</option></select></label>}
                                              {activeSign.projectionMode === 'camera-3d' && <div><div className="mb-1 flex justify-between"><label className="text-xs text-gray-400">Physical depth</label><span className="font-mono text-xs text-cyan-300">{activeSign.physicalDepthMm ?? 100}mm</span></div><input aria-label="Physical sign depth" type="range" min="10" max="2000" step="10" value={activeSign.physicalDepthMm ?? 100} onChange={event => updateActiveSign({ physicalDepthMm: Number(event.target.value) })} className="h-2 w-full accent-cyan-500" /><p className="mt-1 text-[9px] text-gray-500">Projected with the selected plane and camera field of view.</p></div>}
                                              <div><div className="mb-1 flex justify-between"><label className="text-xs text-gray-400">Visual letter / logo depth</label><span className="font-mono text-xs text-cyan-300">{(activeSign.extrusionDepth / VISUAL_EXTRUSION_REFERENCE_WIDTH_PX * 100).toFixed(1)}%</span></div><input aria-label="Letter and logo extrusion depth" type="range" min="1" max="100" value={activeSign.extrusionDepth} onChange={(e) => updateLetterDepth(parseInt(e.target.value))} className="h-2 w-full accent-cyan-500" /><p className="mt-1 text-[9px] text-gray-500">Relative to the placed sign width, so depth stays consistent on desktop and iPad.</p></div>
                                              {getSignExtrusionMode(activeSign) === 'backed' && <div><div className="mb-1 flex justify-between"><label className="text-xs text-gray-400">Backing board depth</label><span className="font-mono text-xs text-cyan-300">{(getBackingDepth(activeSign) / VISUAL_EXTRUSION_REFERENCE_WIDTH_PX * 100).toFixed(1)}%</span></div><input aria-label="Backing board extrusion depth" type="range" min="0" max={Math.max(1, Math.floor(activeSign.extrusionDepth * 0.8))} value={getBackingDepth(activeSign)} onChange={event => updateActiveSign({ backingDepth: Number(event.target.value) })} className="h-2 w-full accent-cyan-500" /><p className="mt-1 text-[9px] text-gray-500">The board remains shallower than the raised copy.</p></div>}
                                              <div><div className="mb-1 flex justify-between"><label className="text-xs text-gray-400">Direction</label><span className="font-mono text-xs text-cyan-300">{activeSign.extrusionAngle}°</span></div><input aria-label="Extrusion direction" type="range" min="0" max="360" value={activeSign.extrusionAngle} onChange={(e) => updateActiveSign({ extrusionAngle: parseInt(e.target.value) })} className="h-2 w-full accent-cyan-500" /></div>
                                              <label className="flex items-center justify-between text-xs text-gray-400"><span>Side colour</span><input type="color" value={activeSign.sideColor} onChange={(e) => updateActiveSign({ sideColor: e.target.value })} className="h-8 w-12 cursor-pointer rounded border border-gray-600 bg-transparent p-0.5" /></label>
                                          </div>
                                      )}
                                  </div>
                              </div>
                          </div>

                          {/* Per-element 3D extrusion */}
                          <button
                              onClick={onOpenElementStudio}
                              className="w-full flex items-center justify-center gap-2 p-3 bg-purple-600/20 border border-purple-500/40 hover:bg-purple-600/30 text-purple-300 rounded-lg transition-colors"
                              title="Detect the sign's letters/logo and give each its own extrusion depth"
                          >
                              <Box className="w-4 h-4" />
                              <span className="text-xs font-medium">3D Elements</span>
                              {activeSign.elements && activeSign.elements.length > 0 && (
                                  <span className="text-[10px] bg-purple-500/30 border border-purple-400/40 rounded-full px-1.5 py-0.5 font-mono">
                                      {activeSign.elements.filter(e => e.enabled).length}
                                  </span>
                              )}
                          </button>

                          {/* Real-world size (requires calibration) */}
                          {calibration && signSizeMm && (
                              <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3 space-y-2">
                                  <div className="flex justify-between items-center text-xs">
                                      <span className="text-gray-400">{calibration.plane ? 'Wall-plane size' : 'Estimated size'}</span>
                                      <span className="text-amber-300 font-mono">
                                          {formatLength(signSizeMm.width, state.unitSystem)} × {formatLength(signSizeMm.height, state.unitSystem)}
                                      </span>
                                  </div>
                                  <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
                                      <label className="text-[10px] text-gray-500 uppercase">Width ({sizeInputUnit})<input aria-label={`Sign width in ${sizeInputUnit}`} type="number" min="0" step="any" value={targetWidth} onChange={(e) => updateTargetWidth(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && applySignSize()} className="mt-1 w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white focus:border-amber-500 outline-none" /></label>
                                      <button type="button" aria-label={aspectLocked ? 'Unlock sign proportions' : 'Lock sign proportions'} aria-pressed={aspectLocked} onClick={() => updateActiveSign({ aspectLocked: !aspectLocked })} title={aspectLocked ? 'Width and height stay proportional' : 'Width and height can change independently'} className={`mb-0.5 grid h-8 w-8 place-items-center rounded border ${aspectLocked ? 'border-amber-500/60 bg-amber-500/15 text-amber-300' : 'border-gray-600 bg-gray-800 text-gray-400'}`}>{aspectLocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}</button>
                                      <label className="text-[10px] text-gray-500 uppercase">Height ({sizeInputUnit})<input aria-label={`Sign height in ${sizeInputUnit}`} type="number" min="0" step="any" value={targetHeight} onChange={(e) => updateTargetHeight(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && applySignSize()} className="mt-1 w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white focus:border-amber-500 outline-none" /></label>
                                  </div>
                                  <button onClick={applySignSize} className="w-full rounded bg-amber-600/80 px-2 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-500">Place at exact size</button>
                                  <p className="text-[10px] leading-relaxed text-gray-500">{calibration.plane ? 'Projected through the calibrated wall perspective.' : 'Uses one reference scale; use Perspective wall for depth-correct placement.'}</p>
                              </div>
                          )}

                          {/* Sign Type Selector */}
                          <div>
                              <label className="text-xs text-gray-400 mb-1 block">Sign Type</label>
                              <select 
                                value={activeSign.signType || 'fascia_non_ill'} 
                                onChange={(e) => { const signType = e.target.value as SignType; updateActiveSign({ signType, extrusionMode: defaultExtrusionModeForType(signType) }); }}
                                className="w-full bg-gray-800 text-sm text-white border border-gray-600 rounded p-1"
                              >
                                {SIGN_TYPES.map(type => (
                                  <option key={type.value} value={type.value}>{type.label}</option>
                                ))}
                              </select>
                          </div>

                          <div><div className="flex justify-between mb-1"><label className="text-xs text-gray-400">Opacity</label><span className="text-xs text-gray-500">{Math.round(activeSign.opacity * 100)}%</span></div><input type="range" min="0" max="1" step="0.05" value={activeSign.opacity} onChange={(e) => updateActiveSign({ opacity: parseFloat(e.target.value) })} className="w-full h-2 bg-gray-700 rounded-lg accent-purple-500" /></div>
                          <div><label className="text-xs text-gray-400 mb-1 block">Blend Mode</label><select value={activeSign.blendMode} onChange={(e) => updateActiveSign({ blendMode: e.target.value })} className="w-full bg-gray-800 text-sm text-white border border-gray-600 rounded p-1">{BLEND_MODES.map(mode => <option key={mode} value={mode}>{mode}</option>)}</select></div>
                    </div>
                 )}
                 {activeDimension && (
                     <div className="space-y-4 animate-in fade-in duration-200">
                         <input type="text" value={activeDimension.text} onChange={(e) => updateDimension(activeDimension.id, { text: e.target.value })} className="w-full bg-gray-800 border border-gray-600 rounded p-2 text-white" />
                         <div className="flex gap-2">
                             <input type="color" value={activeDimension.color || '#ffffff'} onChange={(e) => updateDimension(activeDimension.id, { color: e.target.value })} className="bg-transparent border-none w-8 h-8" />
                             <button onClick={() => handleVoiceInput('dimension')} className={`p-2 rounded border border-gray-600 ${listeningTarget === 'dimension' ? 'bg-red-500/20 text-red-400' : ''}`}><Mic className="w-4 h-4" /></button>
                         </div>
                         {activeDimension.variant === 'box' && (<button onClick={() => setIsLibraryOpen(true)} className="w-full flex items-center justify-center gap-2 p-3 bg-blue-600/20 border border-blue-500/50 hover:bg-blue-600/30 text-blue-300 rounded-lg transition-colors"><Library className="w-4 h-4" /><span>Find Sign for this Box</span></button>)}
                     </div>
                 )}
              </div>
            </>
          )}

          {/* PAGE SETUP TAB CONTENT */}
          {activeTab === 'page' && (
             <div className="space-y-6 animate-in fade-in duration-300 pb-20">
                {/* Canvas/Sheet Selector for Title Block */}
                <div className="bg-gray-800 rounded-lg p-3 border border-gray-700 mb-4">
                   <h3 className="text-xs font-bold text-gray-400 uppercase mb-2">Current Sheet View</h3>
                   <select 
                        value={state.activeCanvasId}
                        onChange={(e) => updateState({ activeCanvasId: e.target.value })}
                        className="w-full bg-gray-900 border border-gray-600 text-white text-sm rounded p-2"
                   >
                        {state.canvases.map(c => (
                            <option key={c.id} value={c.id}>{c.name} - {c.sheetNumber}</option>
                        ))}
                   </select>
                </div>
                
                {/* Page Format & Size */}
                <div className="bg-gray-800 rounded-lg p-3 border border-gray-700">
                    <h2 className="text-xs font-bold text-gray-400 uppercase mb-3 flex items-center gap-2">
                        <Printer className="w-4 h-4" /> Page Setup
                    </h2>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="text-[10px] text-gray-500 block mb-1">Size</label>
                            <select 
                                value={state.titleBlock.paperSize}
                                onChange={(e) => updateState({ titleBlock: { ...state.titleBlock, paperSize: e.target.value as PaperSize } })}
                                className="w-full bg-gray-900 border border-gray-600 text-white text-sm rounded p-2"
                            >
                                <option value="A4">A4</option>
                                <option value="A3">A3</option>
                                <option value="A2">A2</option>
                                <option value="Letter">Letter</option>
                                <option value="Tabloid">Tabloid</option>
                            </select>
                        </div>
                         <div>
                            <label className="text-[10px] text-gray-500 block mb-1">Orientation</label>
                            <select 
                                value={state.titleBlock.orientation}
                                onChange={(e) => updateState({ titleBlock: { ...state.titleBlock, orientation: e.target.value as Orientation } })}
                                className="w-full bg-gray-900 border border-gray-600 text-white text-sm rounded p-2"
                            >
                                <option value="landscape">Landscape</option>
                                <option value="portrait">Portrait</option>
                            </select>
                        </div>
                    </div>
                </div>

                {/* Style & Template Selector */}
                <div>
                    <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-2">Page Style</h2>
                    <div className="space-y-2">
                        <button 
                            onClick={() => setIsTemplateModalOpen(true)}
                            className="w-full flex items-center justify-between p-3 bg-gray-800 rounded-lg border border-gray-700 hover:border-blue-500 transition-colors group"
                        >
                            <div className="flex items-center gap-3">
                                <Grid className="w-5 h-5 text-blue-400" />
                                <div className="text-left">
                                    <div className="text-sm font-medium text-white group-hover:text-blue-300">
                                        {state.titleBlock.style.name}
                                    </div>
                                    <div className="text-[10px] text-gray-500">Click to change template</div>
                                </div>
                            </div>
                            <ArrowRight className="w-4 h-4 text-gray-500" />
                        </button>
                        
                        {/* Style Editor */}
                        <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 space-y-3">
                            <div className="flex items-center justify-between">
                                <span className="text-xs text-gray-400">Layout</span>
                                <select 
                                    value={state.titleBlock.style.layout} 
                                    onChange={(e) => updateState({ titleBlock: { ...state.titleBlock, style: { ...state.titleBlock.style, layout: e.target.value as any } } })}
                                    className="bg-gray-900 border border-gray-600 text-xs text-white rounded px-2 py-1"
                                >
                                    <option value="vertical-right">Sidebar Right</option>
                                    <option value="horizontal-bottom">Bottom Bar</option>
                                </select>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-xs text-gray-400">Colors</span>
                                <div className="flex gap-2">
                                    <div className="flex flex-col items-center"><input type="color" value={state.titleBlock.style.backgroundColor} onChange={(e) => updateState({ titleBlock: { ...state.titleBlock, style: { ...state.titleBlock.style, backgroundColor: e.target.value } } })} className="w-5 h-5 bg-transparent border-none p-0" /><span className="text-[9px] text-gray-500">BG</span></div>
                                    <div className="flex flex-col items-center"><input type="color" value={state.titleBlock.style.headerColor} onChange={(e) => updateState({ titleBlock: { ...state.titleBlock, style: { ...state.titleBlock.style, headerColor: e.target.value } } })} className="w-5 h-5 bg-transparent border-none p-0" /><span className="text-[9px] text-gray-500">Header</span></div>
                                    <div className="flex flex-col items-center"><input type="color" value={state.titleBlock.style.textColor} onChange={(e) => updateState({ titleBlock: { ...state.titleBlock, style: { ...state.titleBlock.style, textColor: e.target.value } } })} className="w-5 h-5 bg-transparent border-none p-0" /><span className="text-[9px] text-gray-500">Text</span></div>
                                </div>
                            </div>
                             <div className="flex items-center justify-between">
                                <span className="text-xs text-gray-400">Font</span>
                                <select 
                                    value={state.titleBlock.style.fontFamily} 
                                    onChange={(e) => updateState({ titleBlock: { ...state.titleBlock, style: { ...state.titleBlock.style, fontFamily: e.target.value } } })}
                                    className="bg-gray-900 border border-gray-600 text-xs text-white rounded px-2 py-1"
                                >
                                    <option value="sans-serif">Sans Serif</option>
                                    <option value="serif">Serif</option>
                                    <option value="monospace">Monospace</option>
                                </select>
                            </div>
                            
                             <button 
                                onClick={saveCustomTemplate}
                                className="w-full flex items-center justify-center gap-2 py-2 mt-2 bg-gray-700 hover:bg-gray-600 text-white text-xs rounded border border-gray-600 transition-colors"
                             >
                                <Save className="w-3 h-3" /> Save as Template
                             </button>
                        </div>
                    </div>
                </div>

                {/* Branding */}
                <div>
                   <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-2">Branding</h2>
                   <div className="flex items-center gap-4 bg-gray-800 p-3 rounded border border-gray-700">
                       <div className="w-16 h-16 bg-white rounded flex items-center justify-center overflow-hidden">
                           {state.titleBlock.logoImage ? (
                               <img src={state.titleBlock.logoImage} alt="Logo" className="max-w-full max-h-full object-contain" />
                           ) : (
                               <span className="text-gray-400 text-xs text-center">No Logo</span>
                           )}
                       </div>
                       <div>
                           <button onClick={() => logoInputRef.current?.click()} className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded">Upload Logo</button>
                           <input type="file" ref={logoInputRef} className="hidden" accept="image/*" onChange={(e) => handleFileChange(e, onLogoUpload)} />
                           
                           <div className="mt-2 flex items-center gap-2">
                               <span className="text-[10px] text-gray-400">Position:</span>
                               <select 
                                    value={state.titleBlock.style.logoPosition} 
                                    onChange={(e) => updateState({ titleBlock: { ...state.titleBlock, style: { ...state.titleBlock.style, logoPosition: e.target.value as any } } })}
                                    className="bg-gray-900 text-[10px] text-white border border-gray-600 rounded px-1"
                               >
                                   <option value="top">Top/Left</option>
                                   <option value="bottom">Bottom/Right</option>
                               </select>
                           </div>
                       </div>
                   </div>
                </div>

                {/* Sheet Details - Specific to Active Canvas */}
                <div>
                    <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-2">Sheet Details</h2>
                    <div className="bg-gray-800 p-3 rounded border border-gray-700 space-y-3">
                        <div>
                            <label className="text-[10px] text-gray-500 uppercase font-bold">Sheet Title</label>
                            <input 
                                type="text" 
                                value={activeCanvas.sheetTitle}
                                onChange={(e) => updateActiveCanvas({ sheetTitle: e.target.value })}
                                className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-sm text-white"
                            />
                        </div>
                        <div>
                            <label className="text-[10px] text-gray-500 uppercase font-bold">Sheet Number</label>
                            <input 
                                type="text" 
                                value={activeCanvas.sheetNumber}
                                onChange={(e) => updateActiveCanvas({ sheetNumber: e.target.value })}
                                className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-sm text-white"
                            />
                        </div>
                    </div>
                </div>

                {/* Project Fields (Global) */}
                <div>
                    <div className="flex justify-between items-center mb-2">
                        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Project Fields</h2>
                        <button 
                            onClick={addTitleBlockField}
                            className="text-xs flex items-center gap-1 bg-gray-700 hover:bg-gray-600 text-white px-2 py-1 rounded transition-colors"
                        >
                            <Plus className="w-3 h-3" /> Field
                        </button>
                    </div>

                    <div className="space-y-3">
                        {state.titleBlock.fields.filter(f => f.section !== 'sheet').map((field) => (
                            <div key={field.id} className="bg-gray-800 p-3 rounded border border-gray-700 space-y-2 relative group">
                                <div className="flex justify-between gap-2">
                                    <div className="flex-1">
                                        <label className="text-[10px] text-gray-500 uppercase font-bold flex items-center gap-1">
                                            Label
                                            <PencilLine className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                                        </label>
                                        <input 
                                            type="text" 
                                            value={field.label}
                                            onChange={(e) => updateTitleBlockField(field.id, { label: e.target.value })}
                                            className="w-full bg-transparent border-b border-gray-700 text-gray-400 text-xs focus:text-white focus:border-blue-500 outline-none pb-1"
                                        />
                                    </div>
                                    <div className="flex-[2]">
                                        <label className="text-[10px] text-gray-500 uppercase font-bold">Value</label>
                                        <input 
                                            type="text" 
                                            value={field.value}
                                            onChange={(e) => updateTitleBlockField(field.id, { value: e.target.value })}
                                            className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-sm text-white focus:border-blue-500 outline-none"
                                        />
                                    </div>
                                    <button 
                                        onClick={() => removeTitleBlockField(field.id)}
                                        className="text-gray-600 hover:text-red-400 self-end p-1"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Revision History Table */}
                <div>
                   <div className="flex justify-between items-center mb-2">
                       <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Revisions</h2>
                       <button 
                           onClick={() => updateStateWithHistory({ 
                               titleBlock: { 
                                   ...state.titleBlock, 
                                   revisions: [...state.titleBlock.revisions, { id: Date.now().toString(), rev: String.fromCharCode(65 + state.titleBlock.revisions.length), date: new Date().toLocaleDateString(), description: 'REVISION', drawnBy: 'JD' }] 
                               } 
                           })}
                           className="text-xs bg-gray-700 hover:bg-gray-600 text-white px-2 py-1 rounded"
                        >
                           + Row
                       </button>
                   </div>
                   <div className="space-y-2">
                       {state.titleBlock.revisions.map((rev) => {
                           const updateRev = (field: 'rev' | 'date' | 'description' | 'drawnBy', value: string) => {
                               // Immutable update — mutating the row object in place corrupts undo history snapshots
                               const newRevs = state.titleBlock.revisions.map(r => r.id === rev.id ? { ...r, [field]: value } : r);
                               updateState({ titleBlock: { ...state.titleBlock, revisions: newRevs } });
                           };
                           return (
                           <div key={rev.id} className="grid grid-cols-12 gap-1 text-xs">
                               <input value={rev.rev} onChange={(e) => updateRev('rev', e.target.value)} className="col-span-1 bg-gray-800 border border-gray-700 rounded px-1 text-center" />
                               <input value={rev.date} onChange={(e) => updateRev('date', e.target.value)} className="col-span-3 bg-gray-800 border border-gray-700 rounded px-1" />
                               <input value={rev.description} onChange={(e) => updateRev('description', e.target.value)} className="col-span-6 bg-gray-800 border border-gray-700 rounded px-1" />
                               <div className="col-span-2 flex gap-1">
                                    <input value={rev.drawnBy} onChange={(e) => updateRev('drawnBy', e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded px-1 text-center" />
                                    <button onClick={() => {
                                        const newRevs = state.titleBlock.revisions.filter(r => r.id !== rev.id);
                                        updateStateWithHistory({ titleBlock: { ...state.titleBlock, revisions: newRevs } });
                                    }} className="text-red-400 hover:text-red-300"><X className="w-3 h-3" /></button>
                               </div>
                           </div>
                           );
                       })}
                   </div>
                </div>

             </div>
          )}

          {/* SITE SURVEY TAB CONTENT */}
          {activeTab === 'survey' && (
              <div data-testid="site-survey-panel" className="space-y-5 animate-in fade-in duration-300 pb-20">
                  <div>
                      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-cyan-200"><MapPin className="h-4 w-4" /> Site capture survey</h2>
                      <p className="mt-1 text-[11px] leading-relaxed text-gray-500">Phone measurements, GPS and elevation notes stay attached to the project and are available on every signed-in device.</p>
                  </div>

                  {!selectedSiteCapture ? (
                      <div className="rounded-xl border border-dashed border-gray-700 bg-gray-800/50 p-5 text-center">
                          <Camera className="mx-auto h-7 w-7 text-gray-600" />
                          <p className="mt-2 text-xs text-gray-400">No phone site captures are saved in this project.</p>
                      </div>
                  ) : (
                      <>
                          <div className="space-y-2 rounded-xl border border-gray-700 bg-gray-800 p-3">
                              <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500">Survey elevation
                                  <select aria-label="Survey elevation" value={selectedSiteCapture.id} onChange={event => setSelectedSiteCaptureId(event.target.value)} className="mt-1.5 min-h-11 w-full rounded-lg border border-gray-600 bg-gray-900 px-2 text-sm normal-case tracking-normal text-white">
                                      {siteCaptures.map(capture => <option key={capture.id} value={capture.id}>{capture.label}</option>)}
                                  </select>
                              </label>
                              <div className="flex items-center justify-between gap-2 text-[10px] text-gray-500">
                                  <span>{new Date(selectedSiteCapture.capturedAt).toLocaleString()}</span>
                                  <span className={`rounded-full px-2 py-1 font-semibold ${selectedSiteCapture.promotedCanvasId === activeCanvas.id ? 'bg-emerald-500/15 text-emerald-300' : 'bg-gray-700 text-gray-400'}`}>{selectedSiteCapture.promotedCanvasId === activeCanvas.id ? 'Current editor view' : selectedSiteCapture.promotedCanvasId ? 'Editor view ready' : 'Capture only'}</span>
                              </div>
                          </div>

                          <section className="space-y-3 rounded-xl border border-orange-500/25 bg-orange-500/5 p-3">
                              <div className="flex items-center gap-2"><Ruler className="h-4 w-4 text-orange-300" /><h3 className="text-xs font-semibold uppercase tracking-wider text-orange-100">Field dimensions</h3></div>
                              <div className="grid grid-cols-2 gap-2">
                                  <div className="rounded-lg bg-gray-900/80 p-2"><p className="text-[9px] uppercase tracking-wider text-gray-500">Wall width</p><p data-testid="survey-wall-width" className="mt-1 font-mono text-sm text-white">{selectedSiteCapture.referenceWall.widthMm === undefined ? 'Not recorded' : formatLength(selectedSiteCapture.referenceWall.widthMm, state.unitSystem)}</p></div>
                                  <div className="rounded-lg bg-gray-900/80 p-2"><p className="text-[9px] uppercase tracking-wider text-gray-500">Wall height</p><p data-testid="survey-wall-height" className="mt-1 font-mono text-sm text-white">{selectedSiteCapture.referenceWall.heightMm === undefined ? 'Not recorded' : formatLength(selectedSiteCapture.referenceWall.heightMm, state.unitSystem)}</p></div>
                              </div>
                              <div className="rounded-lg bg-gray-900/80 p-2">
                                  <p className="text-[9px] uppercase tracking-wider text-gray-500">Plane depth from {selectedSiteCapture.referenceWall.referencePlaneName || 'reference plane'}</p>
                                  <p data-testid="survey-plane-depth" className="mt-1 font-mono text-sm text-white">{selectedSiteCapture.referenceWall.planeDepthMm === undefined ? 'Not recorded' : `${formatLength(selectedSiteCapture.referenceWall.planeDepthMm, state.unitSystem)} ${selectedSiteCapture.referenceWall.planeDepthDirection === 'forward' ? 'closer to camera' : 'further back'}`}</p>
                              </div>
                              <p className="text-[10px] text-gray-500">{selectedSiteCapture.referenceWall.wallName} · {selectedSiteCapture.referenceWall.method}</p>
                          </section>

                          <section className="space-y-3 rounded-xl border border-cyan-500/25 bg-cyan-500/5 p-3">
                              <div className="flex items-center gap-2"><MapPin className="h-4 w-4 text-cyan-300" /><h3 className="text-xs font-semibold uppercase tracking-wider text-cyan-100">GPS location</h3></div>
                              <p data-testid="survey-address" className="text-sm leading-relaxed text-white">{selectedSurveyLocation?.address || 'No street address recorded'}</p>
                              {selectedSurveyHasGps ? (
                                  <div className="space-y-2">
                                      <p data-testid="survey-gps-coordinates" className="font-mono text-xs text-cyan-200">{selectedSurveyCoordinates}</p>
                                      <div className="flex items-center justify-between gap-2">
                                          <p data-testid="survey-gps-accuracy" className="text-[10px] text-gray-400">{Number.isFinite(selectedSurveyLocation?.accuracy) ? `Accuracy ±${Math.round(selectedSurveyLocation!.accuracy!)}m` : 'GPS accuracy not supplied'}</p>
                                          <a href={selectedSurveyMapUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1.5 text-[10px] font-semibold text-cyan-200 hover:bg-cyan-500/20">Open map</a>
                                      </div>
                                  </div>
                              ) : <p data-testid="survey-gps-coordinates" className="text-xs text-gray-500">No GPS coordinates recorded</p>}
                          </section>

                          <section className="space-y-3 rounded-xl border border-blue-500/20 bg-blue-500/5 p-3">
                              <div className="flex items-center gap-2"><Notebook className="h-4 w-4 text-blue-300" /><h3 className="text-xs font-semibold uppercase tracking-wider text-blue-100">Site notes</h3></div>
                              <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500">Elevation notes
                                  <textarea data-testid="survey-elevation-notes" aria-label={`${selectedSiteCapture.label} notes`} value={selectedSiteCapture.notes} onChange={event => updateSelectedSiteCapture({ notes: event.target.value })} rows={4} placeholder="No elevation notes recorded" className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-900 p-2.5 text-sm font-normal normal-case tracking-normal text-white outline-none focus:border-blue-400" />
                              </label>
                              <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500">Measurement notes
                                  <textarea data-testid="survey-measurement-notes" aria-label="Measurement notes" value={selectedSiteCapture.referenceWall.notes} onChange={event => updateSelectedSiteCapture({ referenceWall: { ...selectedSiteCapture.referenceWall, notes: event.target.value } })} rows={4} placeholder="No measurement notes recorded" className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-900 p-2.5 text-sm font-normal normal-case tracking-normal text-white outline-none focus:border-blue-400" />
                              </label>
                          </section>

                          {!selectedSiteCapture.promotedCanvasId ? (
                              <button type="button" onClick={() => void createEditorViewForSurvey()} disabled={promotingSiteCaptureId === selectedSiteCapture.id || !selectedSurveyHasValidWallSize || !Number.isFinite(selectedSiteCapture.referenceWall.planeDepthMm)} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-cyan-500 px-3 text-sm font-semibold text-gray-950 disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-500">
                                  {promotingSiteCaptureId === selectedSiteCapture.id ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating editor view</> : <><ArrowUp className="h-4 w-4" /> Create editor view</>}
                              </button>
                          ) : selectedSiteCapture.promotedCanvasId !== activeCanvas.id ? (
                              <button type="button" onClick={() => updateState({ activeCanvasId: selectedSiteCapture.promotedCanvasId! })} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-cyan-500/40 bg-cyan-500/10 px-3 text-sm font-semibold text-cyan-200 hover:bg-cyan-500/20"><ArrowRight className="h-4 w-4" /> Open editor view</button>
                          ) : (
                              <button data-testid="calibrate-from-survey" type="button" onClick={() => onOpenCalibration({ widthMm: selectedSiteCapture.referenceWall.widthMm, heightMm: selectedSiteCapture.referenceWall.heightMm, planeName: selectedSiteCapture.referenceWall.wallName })} disabled={!selectedSurveyHasValidWallSize} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-orange-400/50 bg-orange-500/10 px-3 text-sm font-semibold text-orange-100 hover:bg-orange-500/20 disabled:cursor-not-allowed disabled:border-gray-700 disabled:bg-gray-800 disabled:text-gray-500"><Ruler className="h-4 w-4" /> Calibrate from survey</button>
                          )}
                      </>
                  )}
              </div>
          )}

          {/* NOTES TAB CONTENT */}
          {activeTab === 'notes' && (
              <div className="space-y-6 animate-in fade-in duration-300 pb-20">
                  {/* Notes Text Area */}
                  <div>
                      <div className="flex items-center justify-between mb-2">
                        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider flex items-center gap-2">
                            <Notebook className="w-4 h-4" /> General Project Notes
                        </h2>
                        <button 
                             onClick={() => handleVoiceInput('notes')}
                             className={`p-1.5 rounded-full transition-all ${listeningTarget === 'notes' ? 'bg-red-500 text-white animate-pulse' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
                             title="Dictate Notes"
                        >
                             <Mic className="w-4 h-4" />
                        </button>
                      </div>
                      <textarea 
                          value={state.notes}
                          onChange={(e) => updateState({ notes: e.target.value })}
                          placeholder="Type general project notes here..."
                          className="w-full h-32 bg-gray-800 border border-gray-700 rounded-lg p-3 text-sm text-white resize-y focus:ring-1 focus:ring-blue-500 outline-none"
                      />
                  </div>

                  {/* Reference Images Gallery */}
                  <div>
                      <div className="flex items-center justify-between mb-2">
                          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider flex items-center gap-2">
                              <Camera className="w-4 h-4" /> Reference Images
                          </h2>
                          <button 
                              onClick={() => { setUploadTarget('reference'); setIsUploaderOpen(true); }}
                              className="text-xs flex items-center gap-1 bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors"
                          >
                              <Plus className="w-3 h-3" /> Add Image
                          </button>
                      </div>
                      {state.referenceImages.length === 0 ? (
                          <div className="border-2 border-dashed border-gray-700 rounded-lg p-8 flex flex-col items-center justify-center text-gray-500 gap-2">
                              <ImageIcon className="w-8 h-8 opacity-50" />
                              <span className="text-xs">No reference images added yet</span>
                          </div>
                      ) : (
                          <div className="space-y-4">
                              <div className="grid grid-cols-3 gap-2">
                                  {state.referenceImages.map((img) => (
                                      <div 
                                        key={img.id} 
                                        onClick={() => setActiveRefId(img.id)}
                                        className={`relative group rounded-lg overflow-hidden border aspect-square cursor-pointer transition-all ${activeRefId === img.id ? 'border-blue-500 ring-2 ring-blue-500/50' : 'border-gray-700 hover:border-gray-500'}`}
                                      >
                                          <img src={img.image} alt="Reference" className="w-full h-full object-cover" />
                                      </div>
                                  ))}
                              </div>
                              {activeRefId && (() => {
                                  const activeImg = state.referenceImages.find(r => r.id === activeRefId);
                                  if (!activeImg) return null;
                                  return (
                                      <div className="bg-gray-800 rounded-lg p-3 border border-gray-700 animate-in slide-in-from-top-2 duration-200">
                                          <div className="flex justify-between items-start mb-2">
                                              <span className="text-xs font-semibold text-gray-400">Image Note</span>
                                              <div className="flex items-center gap-1">
                                                  <button 
                                                      onClick={() => handleVoiceInput('ref_note')}
                                                      className={`p-1 rounded transition-all ${listeningTarget === 'ref_note' ? 'bg-red-500/20 text-red-500 animate-pulse' : 'text-gray-400 hover:text-white'}`}
                                                      title="Dictate Note"
                                                  >
                                                      <Mic className="w-3.5 h-3.5" />
                                                  </button>
                                                  <button 
                                                      onClick={() => {
                                                          const newRefs = state.referenceImages.filter(r => r.id !== activeRefId);
                                                          updateStateWithHistory({ referenceImages: newRefs });
                                                          setActiveRefId(null);
                                                      }}
                                                      className="text-red-400 hover:text-red-300 p-1"
                                                      title="Delete Image"
                                                  >
                                                      <Trash2 className="w-3.5 h-3.5" />
                                                  </button>
                                              </div>
                                          </div>
                                          <textarea 
                                              value={activeImg.note}
                                              onChange={(e) => {
                                                  const newRefs = state.referenceImages.map(r => 
                                                      r.id === activeRefId ? { ...r, note: e.target.value } : r
                                                  );
                                                  updateState({ referenceImages: newRefs });
                                              }}
                                              placeholder="Add details about this specific image..."
                                              className="w-full h-20 bg-gray-900 border border-gray-600 rounded p-2 text-sm text-white resize-y focus:ring-1 focus:ring-blue-500 outline-none"
                                          />
                                      </div>
                                  );
                              })()}
                          </div>
                      )}
                  </div>
              </div>
          )}
        </div>

        <div className={`${forceSidePanel || mobilePanelExpanded ? 'block' : 'hidden'} flex-shrink-0 border-t border-gray-700 bg-gray-800 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 lg:block lg:px-3 lg:pb-8 lg:pt-3`}>
          <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onDownload('device')}
            aria-label="Download PDF/PNG to device"
            className="flex min-h-9 items-center justify-center gap-1.5 rounded-md bg-blue-600 px-2 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500"
            title="Download PDF or PNG to this device"
          >
            <Download className="h-4 w-4" />
            Download
          </button>
          {!state.user?.uid.startsWith('guest_') && (
            <button onClick={() => onDownload('drive')} aria-label="Save PDF/PNG to selected drive" className="flex min-h-9 items-center justify-center gap-1.5 rounded-md border border-gray-600 bg-gray-700 px-2 py-2 text-xs font-semibold text-white transition-colors hover:bg-gray-600" title="Save PDF or PNG to the selected cloud drive">
              <HardDrive className="h-4 w-4" /> Save to drive
            </button>
          )}
          </div>
          <nav className="mt-2 flex justify-center gap-4 text-[11px] text-gray-500 lg:hidden" aria-label="Legal and support">
            <a href="#/privacy">Privacy</a><a href="#/terms">Terms</a><a href="#/support">Support</a>
          </nav>
        </div>
      </div>

      <ImageUploader 
        isOpen={isUploaderOpen}
        onClose={() => setIsUploaderOpen(false)}
        onImageReady={handleImageReady}
        preserveSourcePixels={uploadTarget === 'background'}
        maxOutputDimension={uploadTarget === 'sign' ? 4096 : 1024}
        enableLeveling={uploadTarget === 'background'}
        enableLocation={uploadTarget === 'background'}
        onAddressReady={handlePhotoAddressReady}
      />
      
      <SignLibrary
          isOpen={isLibraryOpen}
          onClose={() => setIsLibraryOpen(false)}
          onSelect={handleLibrarySelect}
          activeDimension={activeDimension}
          user={state.user}
          activeSign={activeCanvas.signs.find(s => s.id === activeCanvas.activeSignId) ?? null}
      />

      {/* Template Library Modal */}
      {isTemplateModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
              <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[80vh]">
                  <div className="p-4 border-b border-gray-700 bg-gray-800 flex justify-between items-center">
                      <h2 className="text-lg font-bold text-white flex items-center gap-2"><Layout className="w-5 h-5 text-blue-400" /> Title Block Library</h2>
                      <button onClick={() => setIsTemplateModalOpen(false)} className="text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
                  </div>
                  <div className="p-6 overflow-y-auto">
                     <h3 className="text-sm font-bold text-gray-400 uppercase mb-3">Standard Templates</h3>
                     <div className="grid grid-cols-2 gap-4 mb-6">
                        {TITLE_BLOCK_TEMPLATES.map(template => (
                            <button
                                key={template.id}
                                onClick={() => {
                                    updateState({ titleBlock: { ...state.titleBlock, style: template } });
                                    setIsTemplateModalOpen(false);
                                }}
                                className={`p-4 rounded-lg border text-left transition-all ${state.titleBlock.style.id === template.id ? 'border-blue-500 bg-blue-900/20 ring-1 ring-blue-500' : 'border-gray-700 bg-gray-800 hover:bg-gray-700 hover:border-gray-500'}`}
                            >
                                <h3 className="text-white font-medium mb-1">{template.name}</h3>
                                <p className="text-xs text-gray-400 mb-3">{template.layout === 'vertical-right' ? 'Sidebar Layout' : 'Bottom Bar Layout'}</p>
                                
                                {/* Mini Preview */}
                                <div className="w-full h-24 bg-white rounded overflow-hidden relative border border-gray-600">
                                    {template.layout === 'vertical-right' ? (
                                        <div className="absolute top-0 right-0 bottom-0 w-1/4" style={{ backgroundColor: template.backgroundColor, borderLeft: '1px solid #ccc' }}>
                                            <div className="w-full h-2 mt-2 bg-gray-300 mx-auto w-3/4"></div>
                                            <div className="w-full h-1 mt-1 bg-gray-300 mx-auto w-1/2"></div>
                                        </div>
                                    ) : (
                                        <div className="absolute bottom-0 left-0 right-0 h-1/4" style={{ backgroundColor: template.backgroundColor, borderTop: '1px solid #ccc' }}>
                                            <div className="w-full h-full flex items-center justify-around">
                                                <div className="w-10 h-2 bg-gray-300"></div>
                                                <div className="w-10 h-2 bg-gray-300"></div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </button>
                        ))}
                     </div>

                     {state.savedTemplates.length > 0 && (
                         <>
                            <h3 className="text-sm font-bold text-gray-400 uppercase mb-3">My Custom Templates</h3>
                            <div className="grid grid-cols-2 gap-4">
                                {state.savedTemplates.map(template => (
                                    <div key={template.id} className="relative group">
                                        <button
                                            onClick={() => {
                                                updateState({ titleBlock: { ...state.titleBlock, style: template } });
                                                setIsTemplateModalOpen(false);
                                            }}
                                            className={`w-full p-4 rounded-lg border text-left transition-all ${state.titleBlock.style.id === template.id ? 'border-blue-500 bg-blue-900/20 ring-1 ring-blue-500' : 'border-gray-700 bg-gray-800 hover:bg-gray-700 hover:border-gray-500'}`}
                                        >
                                            <h3 className="text-white font-medium mb-1">{template.name}</h3>
                                            <p className="text-xs text-gray-400 mb-3">{template.layout === 'vertical-right' ? 'Sidebar Layout' : 'Bottom Bar Layout'}</p>
                                            <div className="w-full h-24 bg-white rounded overflow-hidden relative border border-gray-600">
                                                 {/* Preview logic simplified */}
                                                <div className={`absolute ${template.layout === 'vertical-right' ? 'top-0 right-0 bottom-0 w-1/4' : 'bottom-0 left-0 right-0 h-1/4'}`} style={{ backgroundColor: template.backgroundColor }}></div>
                                            </div>
                                        </button>
                                        <button 
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                const newSaved = state.savedTemplates.filter(t => t.id !== template.id);
                                                updateState({ savedTemplates: newSaved });
                                            }}
                                            className="absolute top-2 right-2 p-1.5 bg-gray-900/80 text-red-400 rounded-full opacity-0 group-hover:opacity-100 hover:bg-white hover:text-red-600 transition-all"
                                            title="Delete Template"
                                        >
                                            <Trash2 className="w-3 h-3" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                         </>
                     )}
                  </div>
              </div>
          </div>
      )}
    </>
  );
};

const MobileDockButton: React.FC<{
  label: string;
  ariaLabel: string;
  icon: React.ReactNode;
  active?: boolean;
  accent?: boolean;
  warning?: boolean;
  onClick: () => void;
}> = ({ label, ariaLabel, icon, active = false, accent = false, warning = false, onClick }) => (
  <button
    type="button"
    aria-label={ariaLabel}
    aria-pressed={active || warning}
    onClick={onClick}
    className={`flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[10px] font-semibold transition active:scale-95 ${warning ? 'bg-amber-500/15 text-amber-200 ring-1 ring-inset ring-amber-400/50' : active ? 'bg-blue-600 text-white shadow-lg shadow-blue-950/40' : accent ? 'text-amber-300 hover:bg-amber-500/10' : 'text-gray-300 hover:bg-gray-800'}`}
  >
    {icon}
    <span className="max-w-full truncate">{label}</span>
  </button>
);

export default ControlsPanel;
