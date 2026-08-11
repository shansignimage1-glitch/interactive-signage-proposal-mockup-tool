
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { AppImages, MockupState, Point, Sign, Dimension, TitleBlock, Revision, PaperSize, Orientation, Calibration } from '../types';
import { hexToRgb, isPointInPolygon, distance, computeHomography } from '../utils/math';
import { measureLine, measureBox } from '../utils/measure';
import { buildElementMask } from '../utils/elementDetection';
import { reportError } from '../services/monitoring';
import { notify } from '../services/toast';
import { MAX_SOURCE_BYTES } from '../services/imageProcessing';
import { ZoomIn, ZoomOut, Maximize, Check, X, Lock, Unlock } from 'lucide-react';
import { ToolMode } from '../App';
import { TITLE_BLOCK_TEMPLATES } from '../data/titleBlockTemplates';
import { clampViewScale, viewForPinch, zoomViewAtPoint, type ViewTransform } from '../utils/viewport';

interface MockupCanvasProps {
  images: AppImages;
  
  // Pass these explicitly from the active canvas
  signs: Sign[];
  activeSignId: string | null;
  dimensions: Dimension[];
  activeDimensionId: string | null;
  
  state: MockupState; // Kept for global settings like showDimensions, isNightMode, etc.
  titleBlock: TitleBlock; // Passed explicitly to allow injection of sheet data
  
  toolMode: ToolMode;
  viewLocked: boolean;
  onViewLockedChange: (locked: boolean) => void;
  onDrawComplete: (start: Point, end: Point, variant: 'linear' | 'box') => void;
  calibration: Calibration | null;
  calibrationDraft: { method: 'line' | 'plane'; points: Point[]; editable: boolean } | null;
  onCalibrationDraftPointsChange: (points: Point[]) => void;
  showCalibrationReference: boolean;
  updateSignById: (id: string, updates: Partial<Sign>) => void;
  setActiveSign: (id: string | null) => void;
  updateDimension: (id: string, updates: Partial<Dimension>) => void;
  setActiveDimension: (id: string) => void;
  updateTitleBlock: (updates: Partial<TitleBlock>) => void;
  setCanvasRef: (ref: HTMLCanvasElement | null) => void;
  isCropping: boolean;
  onCropConfirm: (newUrl: string, offset: Point, newSize: { width: number, height: number }) => void;
  onCancelCrop: () => void;
}

const SCALE_HANDLE_GAP = 30;
const SIGN_CORNER_HIT_SIZE = 52;
const DIMENSION_HANDLE_HIT_RADIUS = 32;
const SIGN_CORNER_VISUAL_SIZE = 18;
const SIGN_MOVE_HIT_SIZE = 60;
const SIGN_MOVE_VISUAL_SIZE = 30;
const PRECISION_LOUPE_SIZE = 128;
const PRECISION_LOUPE_GAP = 32;
const TOUCH_DRAW_THRESHOLD = 8;
const MAX_WEBGL_PREVIEW_DIMENSION = 4096;
const MAX_WEBGL_PREVIEW_PIXELS = 4_194_304;
const MAX_FULL_RESOLUTION_CROP_PIXELS = 12_000_000;

type PrecisionLoupeKind = 'calibration' | 'drawing' | 'dimension' | 'sign';

interface PrecisionLoupeState {
  clientX: number;
  clientY: number;
  point: Point;
  pointerId: number;
  kind: PrecisionLoupeKind;
}

const precisionLoupePosition = (clientX: number, clientY: number, viewportWidth: number, viewportHeight: number) => {
    const safeEdge = 12;
    const preferredLeft = clientX > viewportWidth / 2
        ? clientX - PRECISION_LOUPE_SIZE - PRECISION_LOUPE_GAP
        : clientX + PRECISION_LOUPE_GAP;
    const preferredTop = clientY - PRECISION_LOUPE_SIZE - 38;
    const fallbackTop = clientY + 38;
    const top = preferredTop >= safeEdge ? preferredTop : fallbackTop;

    return {
        left: Math.min(Math.max(safeEdge, preferredLeft), Math.max(safeEdge, viewportWidth - PRECISION_LOUPE_SIZE - safeEdge)),
        top: Math.min(Math.max(safeEdge, top), Math.max(safeEdge, viewportHeight - PRECISION_LOUPE_SIZE - safeEdge)),
    };
};

const webGlPreviewSize = (gl: WebGLRenderingContext, sourceWidth: number, sourceHeight: number) => {
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | number[] | null;
    const renderbufferLimit = Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)) || MAX_WEBGL_PREVIEW_DIMENSION;
    const maxWidth = Math.max(1, Math.min(MAX_WEBGL_PREVIEW_DIMENSION, renderbufferLimit, viewport?.[0] ?? MAX_WEBGL_PREVIEW_DIMENSION));
    const maxHeight = Math.max(1, Math.min(MAX_WEBGL_PREVIEW_DIMENSION, renderbufferLimit, viewport?.[1] ?? MAX_WEBGL_PREVIEW_DIMENSION));
    const pixelScale = Math.sqrt(MAX_WEBGL_PREVIEW_PIXELS / Math.max(1, sourceWidth * sourceHeight));
    const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight, pixelScale);
    return {
        width: Math.max(1, Math.floor(sourceWidth * scale)),
        height: Math.max(1, Math.floor(sourceHeight * scale)),
    };
};

const pointToSegmentDistance = (point: Point, start: Point, end: Point) => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return distance(point, start);
    const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
    return distance(point, { x: start.x + t * dx, y: start.y + t * dy });
};

// Paper Dimensions in Millimeters
const PAPER_DIMENSIONS_MM: Record<PaperSize, { width: number, height: number }> = {
    'A4': { width: 210, height: 297 },
    'A3': { width: 297, height: 420 },
    'A2': { width: 420, height: 594 },
    'Letter': { width: 215.9, height: 279.4 },
    'Tabloid': { width: 279.4, height: 431.8 }
};

// Pixels per mm for display (Approx 96 DPI / 25.4mm ~ 3.78)
// Using 4 for slightly cleaner integers and better default zoom
const PX_PER_MM = 4;

const MockupCanvas: React.FC<MockupCanvasProps> = ({ 
    images, 
    signs,
    activeSignId,
    dimensions,
    activeDimensionId,
    state,
    titleBlock,
    toolMode,
    viewLocked,
    onViewLockedChange,
    onDrawComplete,
    calibration,
    calibrationDraft,
    onCalibrationDraftPointsChange,
    showCalibrationReference,
    updateSignById,
    setActiveSign, 
    updateDimension,
    setActiveDimension,
    updateTitleBlock,
    setCanvasRef,
    isCropping,
    onCropConfirm,
    onCancelCrop
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loupeCanvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<WebGLRenderingContext | null>(null);
  const programRef = useRef<WebGLProgram | null>(null);
  
  // --- Viewport State (Zoom/Pan) ---
  const [view, setView] = useState<ViewTransform>({ scale: 0.9, x: 0, y: 0 });
  const [baseScale, setBaseScale] = useState(1);
  const viewRef = useRef<ViewTransform>(view);
  const baseScaleRef = useRef(1);
  const pendingViewRef = useRef<ViewTransform | null>(null);
  const viewFrameRef = useRef<number | null>(null);
  const activePointersRef = useRef<Map<number, Point>>(new Map());
  const touchGestureRef = useRef<
    | { mode: 'pan'; pointerId: number; start: Point; last: Point; moved: boolean }
    | { mode: 'pinch'; pointerIds: [number, number]; startView: ViewTransform; startCentroid: Point; startDistance: number }
    | null
  >(null);
  const [isNavigating, setIsNavigating] = useState(false);

  // Crop State
  const [cropRect, setCropRect] = useState<{ x: number, y: number, w: number, h: number } | null>(null);
  const [cropDragMode, setCropDragMode] = useState<'move' | 'nw' | 'ne' | 'sw' | 'se' | null>(null);
  const [isCropProcessing, setIsCropProcessing] = useState(false);
  const cropOperationRef = useRef(0);
  
  // Drawing State (Dimensions)
  const [isDrawing, setIsDrawing] = useState(false);
  const [tick, setTick] = useState(0); 
  const drawingStart = useRef<Point | null>(null);
  const drawingCurrent = useRef<Point | null>(null);
  const drawingTouchRef = useRef<{
    pointerId: number;
    startClient: Point;
    completesOnUp: boolean;
  } | null>(null);
  const [calibrationDragIndex, setCalibrationDragIndex] = useState<number | null>(null);
  const precisionPointerRef = useRef<{ pointerId: number; kind: PrecisionLoupeKind } | null>(null);
  const [precisionLoupe, setPrecisionLoupe] = useState<PrecisionLoupeState | null>(null);
  const [webGlGeneration, setWebGlGeneration] = useState(0);

  const showPrecisionLoupe = (kind: PrecisionLoupeKind, e: React.PointerEvent, point: Point) => {
    precisionPointerRef.current = { pointerId: e.pointerId, kind };
    setPrecisionLoupe({ clientX: e.clientX, clientY: e.clientY, point, pointerId: e.pointerId, kind });
  };

  const clearPrecisionLoupe = useCallback(() => {
    precisionPointerRef.current = null;
    setPrecisionLoupe(null);
  }, []);

  const boxDragTargetsRef = useRef<{ x: 'start'|'end'|null, y: 'start'|'end'|null }>({ x: null, y: null });
  const textureCacheRef = useRef<Map<string, WebGLTexture>>(new Map());
  const [texturesLoaded, setTexturesLoaded] = useState(0);

  // Pre-allocated WebGL buffers — created once, reused every frame
  const posBufferRef = useRef<WebGLBuffer | null>(null);
  const texBufferRef = useRef<WebGLBuffer | null>(null);
  // Cached uniform locations — looked up once after program link
  const uniformsRef = useRef<{
    resolution: WebGLUniformLocation | null;
    color: WebGLUniformLocation | null;
    isTexture: WebGLUniformLocation | null;
    attribPosition: number;
    attribTexCoord: number;
  } | null>(null);

  // --- Per-element extrusion (homography program) ---
  const elemProgramRef = useRef<WebGLProgram | null>(null);
  const elemLocsRef = useRef<{
    H: WebGLUniformLocation | null;
    resolution: WebGLUniformLocation | null;
    extrude: WebGLUniformLocation | null;
    signSize: WebGLUniformLocation | null;
    color: WebGLUniformLocation | null;
    mode: WebGLUniformLocation | null;
    image: WebGLUniformLocation | null;
    mask: WebGLUniformLocation | null;
    aPos: number;
    aTop: number;
    aShade: number;
  } | null>(null);
  // Static per-sign element geometry: rebuilt only when contours/image change
  // (an elementsVersion string), NEVER during corner drags or depth tweaks.
  const elementCacheRef = useRef<Map<string, {
    version: string;
    faceBuffer: WebGLBuffer;
    elements: Map<string, { sideBuffer: WebGLBuffer; sideVertexCount: number; maskTexture: WebGLTexture }>;
  }>>(new Map());

  const [activeHandle, setActiveHandleState] = useState<number | null>(null);
  const activeHandleRef = useRef<number | null>(null);
  const setActiveHandle = useCallback((handle: number | null) => {
    activeHandleRef.current = handle;
    setActiveHandleState(handle);
  }, []);
  const [hoveredHandle, setHoveredHandle] = useState<number | null>(null);

  const startMousePos = useRef<Point>({ x: 0, y: 0 });
  const startCornersRef = useRef<[Point, Point, Point, Point] | null>(null);
  const dragSignIdRef = useRef<string | null>(null);
  const dragDimensionIdRef = useRef<string | null>(null);
  const startDimRef = useRef<{ start: Point, end: Point } | null>(null);
  const activeEditPointerRef = useRef<number | null>(null);
  const lastPanPos = useRef<Point>({ x: 0, y: 0 });

  // Helper to update revision rows dynamically
  const updateRevision = (id: string, field: keyof Revision, value: string) => {
      const newRevs = titleBlock.revisions.map(r => 
          r.id === id ? { ...r, [field]: value } : r
      );
      updateTitleBlock({ revisions: newRevs });
  };
  
  const updateField = (id: string, value: string) => {
      const newFields = titleBlock.fields.map(f => f.id === id ? { ...f, value } : f);
      updateTitleBlock({ fields: newFields });
  };

  // Helper to calculate current main container size (Paper or Image)
  const getContainerSize = useCallback(() => {
    if (titleBlock.viewMode === 'sheet') {
        const mm = PAPER_DIMENSIONS_MM[titleBlock.paperSize];
        const isLandscape = titleBlock.orientation === 'landscape';
        return {
            width: (isLandscape ? mm.height : mm.width) * PX_PER_MM,
            height: (isLandscape ? mm.width : mm.height) * PX_PER_MM
        };
    } else {
        return images.backgroundSize;
    }
  }, [titleBlock.viewMode, titleBlock.paperSize, titleBlock.orientation, images.backgroundSize]);

  const applyView = useCallback((next: ViewTransform) => {
    viewRef.current = next;
    setView(next);
  }, []);

  // Pointer events can arrive faster than React should render. Keep the latest
  // transform in a ref and commit at most once per animation frame.
  const scheduleView = useCallback((next: ViewTransform) => {
    viewRef.current = next;
    pendingViewRef.current = next;
    if (viewFrameRef.current !== null) return;
    viewFrameRef.current = window.requestAnimationFrame(() => {
      viewFrameRef.current = null;
      const pending = pendingViewRef.current;
      pendingViewRef.current = null;
      if (pending) setView(pending);
    });
  }, []);

  useEffect(() => () => {
    if (viewFrameRef.current !== null) window.cancelAnimationFrame(viewFrameRef.current);
  }, []);

  useEffect(() => {
    if (!viewLocked) return;

    if (viewFrameRef.current !== null) {
      window.cancelAnimationFrame(viewFrameRef.current);
      viewFrameRef.current = null;
    }
    const pending = pendingViewRef.current;
    pendingViewRef.current = null;
    if (pending) applyView(pending);

    activePointersRef.current.clear();
    touchGestureRef.current = null;
    if (activeHandleRef.current === -99) setActiveHandle(null);
    setIsNavigating(false);
  }, [applyView, setActiveHandle, viewLocked]);

  const viewportSize = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
  }, []);

  const screenPoint = useCallback((clientX: number, clientY: number): Point => {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  }, []);

  const zoomAt = useCallback((point: Point, requestedScale: number) => {
    const next = zoomViewAtPoint(
      viewRef.current,
      requestedScale,
      point,
      viewportSize(),
      getContainerSize(),
      baseScaleRef.current,
    );
    applyView(next);
  }, [applyView, getContainerSize, viewportSize]);

  // Escape to Cancel Drawing
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && isDrawing) {
            setIsDrawing(false);
            drawingStart.current = null;
            drawingCurrent.current = null;
            drawingTouchRef.current = null;
            clearPrecisionLoupe();
        }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [clearPrecisionLoupe, isDrawing]);

  // --- Reset View & Calc Base Scale ---
  const fitToContainer = useCallback(() => {
    if (!containerRef.current) return;
    const { width: contW, height: contH } = containerRef.current.getBoundingClientRect();
    const { width: contentW, height: contentH } = getContainerSize();
    
    if (contentW === 0 || contentH === 0) return;

    const scaleX = contW / contentW;
    const scaleY = contH / contentH;
    const scale = Math.min(scaleX, scaleY) * 0.90; 

    setBaseScale(scale);
    baseScaleRef.current = scale;
    
    // Reset view position and zoom
    applyView({ scale: 1, x: 0, y: 0 });

    if (titleBlock.viewMode === 'canvas') {
        setCropRect({ x: 0, y: 0, w: contentW, h: contentH });
    }
  }, [applyView, getContainerSize, titleBlock.viewMode]);

  // Re-fit when view mode or paper size changes
  useEffect(() => {
    fitToContainer();
  }, [titleBlock.viewMode, titleBlock.paperSize, titleBlock.orientation, fitToContainer]);

  useEffect(() => {
    // Also fit on resize
    const observer = new ResizeObserver(fitToContainer);
    if (containerRef.current) observer.observe(containerRef.current);
    window.addEventListener('resize', fitToContainer);
    return () => { observer.disconnect(); window.removeEventListener('resize', fitToContainer); };
  }, [fitToContainer]);

  useEffect(() => {
    if (isCropping) {
        setCropRect({ x: 0, y: 0, w: images.backgroundSize.width, h: images.backgroundSize.height });
    } else {
        cropOperationRef.current += 1;
        setIsCropProcessing(false);
    }
  }, [isCropping, images.backgroundSize]);

  useEffect(() => {
     setIsDrawing(false);
     drawingStart.current = null;
     drawingCurrent.current = null;
     drawingTouchRef.current = null;
     clearPrecisionLoupe();
  }, [clearPrecisionLoupe, toolMode]);

  const getMousePos = (e: MouseEvent | React.MouseEvent | React.PointerEvent) => {
    if (!containerRef.current) return { x: 0, y: 0 };
    
    const containerSize = getContainerSize();
    const rect = containerRef.current.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    const cx = rect.width / 2;
    const cy = rect.height / 2;
    
    const currentView = viewRef.current;
    const totalScale = baseScaleRef.current * currentView.scale;
    const offsetX = currentView.x;
    const offsetY = currentView.y;
    
    // World coordinates relative to the center of the container object (Image or Paper)
    const worldX = (screenX - cx - offsetX) / totalScale + containerSize.width / 2;
    const worldY = (screenY - cy - offsetY) / totalScale + containerSize.height / 2;

    return { x: worldX, y: worldY };
  };

  const isEditableAt = (world: Point, target: EventTarget | null): boolean => {
    if (target instanceof Element && target.closest('[data-canvas-object], input, button, select, textarea')) return true;
    if (signs.some(sign => isPointInPolygon(world, sign.corners))) return true;

    const hitSlop = 14 / Math.max(0.01, baseScaleRef.current * viewRef.current.scale);
    return state.showDimensions && dimensions.some(dim => {
      if (dim.variant === 'box') {
        const x = Math.min(dim.start.x, dim.end.x) - hitSlop;
        const y = Math.min(dim.start.y, dim.end.y) - hitSlop;
        const width = Math.abs(dim.end.x - dim.start.x) + hitSlop * 2;
        const height = Math.abs(dim.end.y - dim.start.y) + hitSlop * 2;
        return world.x >= x && world.x <= x + width && world.y >= y && world.y <= y + height;
      }
      const minX = Math.min(dim.start.x, dim.end.x) - hitSlop;
      const maxX = Math.max(dim.start.x, dim.end.x) + hitSlop;
      const minY = Math.min(dim.start.y, dim.end.y) - hitSlop;
      const maxY = Math.max(dim.start.y, dim.end.y) + hitSlop;
      return world.x >= minX && world.x <= maxX && world.y >= minY && world.y <= maxY;
    });
  };

  const beginPinch = () => {
    const pointers = [...activePointersRef.current.entries()];
    if (pointers.length < 2) return;
    const [[firstId, first], [secondId, second]] = pointers;
    const centroid = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    touchGestureRef.current = {
      mode: 'pinch',
      pointerIds: [firstId, secondId],
      startView: { ...viewRef.current },
      startCentroid: centroid,
      startDistance: Math.max(1, distance(first, second)),
    };
    setActiveHandle(null);
    activeEditPointerRef.current = null;
    startCornersRef.current = null;
    dragSignIdRef.current = null;
    dragDimensionIdRef.current = null;
    startDimRef.current = null;
    if (isDrawing || drawingStart.current) {
      setIsDrawing(false);
      drawingStart.current = null;
      drawingCurrent.current = null;
    }
    drawingTouchRef.current = null;
    setCalibrationDragIndex(null);
    clearPrecisionLoupe();
    setIsNavigating(true);
  };

  const handleTouchPointerDownCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'touch') return;
    if (e.target instanceof Element && e.target.closest('[data-canvas-ui]')) return;

    const point = screenPoint(e.clientX, e.clientY);
    activePointersRef.current.set(e.pointerId, point);

    if (activePointersRef.current.size >= 2) {
      e.preventDefault();
      e.stopPropagation();
      beginPinch();
      for (const pointerId of activePointersRef.current.keys()) {
        try { e.currentTarget.setPointerCapture(pointerId); } catch { /* pointer may already have ended */ }
      }
      return;
    }

    if (viewLocked) return;

    if (isCropping) return;
    const shouldPan = toolMode === 'pan' ||
      (toolMode === 'select' && !isEditableAt(getMousePos(e), e.target));
    if (!shouldPan) return;

    e.preventDefault();
    e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* best effort */ }
    touchGestureRef.current = { mode: 'pan', pointerId: e.pointerId, start: point, last: point, moved: false };
    setIsNavigating(true);
  };

  const handleTouchPointerMoveCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'touch' || !activePointersRef.current.has(e.pointerId)) return;
    const point = screenPoint(e.clientX, e.clientY);
    activePointersRef.current.set(e.pointerId, point);
    const gesture = touchGestureRef.current;
    if (!gesture) return;

    e.preventDefault();
    e.stopPropagation();
    if (viewLocked) return;
    if (gesture.mode === 'pan') {
      if (gesture.pointerId !== e.pointerId) return;
      const dx = point.x - gesture.last.x;
      const dy = point.y - gesture.last.y;
      gesture.last = point;
      gesture.moved = gesture.moved || distance(gesture.start, point) > 4;
      scheduleView({ ...viewRef.current, x: viewRef.current.x + dx, y: viewRef.current.y + dy });
      return;
    }

    const [firstId, secondId] = gesture.pointerIds;
    const first = activePointersRef.current.get(firstId);
    const second = activePointersRef.current.get(secondId);
    if (!first || !second) return;
    const centroid = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    scheduleView(viewForPinch(
      gesture.startView,
      gesture.startCentroid,
      centroid,
      gesture.startDistance,
      distance(first, second),
      viewportSize(),
      getContainerSize(),
      baseScaleRef.current,
    ));
  };

  const finishTouchPointer = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    if (e.pointerType !== 'touch') return;
    const gesture = touchGestureRef.current;
    activePointersRef.current.delete(e.pointerId);
    if (!gesture) return;

    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);

    if (gesture.mode === 'pinch' && activePointersRef.current.size >= 2) {
      beginPinch();
      return;
    }

    if (gesture.mode === 'pinch' && activePointersRef.current.size === 1) {
      const [pointerId, point] = [...activePointersRef.current.entries()][0];
      touchGestureRef.current = { mode: 'pan', pointerId, start: point, last: point, moved: true };
      return;
    }

    if (gesture.mode === 'pan' && gesture.pointerId === e.pointerId && !cancelled && !gesture.moved && toolMode === 'select') {
      setActiveSign(null);
      setActiveDimension('');
    }
    touchGestureRef.current = null;
    if (activePointersRef.current.size === 0) setIsNavigating(false);
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (viewLocked) {
      e.preventDefault();
      return;
    }
    if (isCropping) return; 
    e.preventDefault();
    const point = screenPoint(e.clientX, e.clientY);
    const newScale = clampViewScale(viewRef.current.scale * Math.exp(-e.deltaY * 0.0015));
    zoomAt(point, newScale);
  };

  const handleContainerPointerDown = (e: React.PointerEvent) => {
    if (e.target instanceof Element && e.target.closest('[data-canvas-ui]')) return;
    if (toolMode === 'pan' || e.button === 1 || e.buttons === 4 || e.shiftKey) {
        if (viewLocked) return;
        e.preventDefault();
        containerRef.current?.setPointerCapture(e.pointerId);
        lastPanPos.current = { x: e.clientX, y: e.clientY };
        setActiveHandle(-99);
        setIsNavigating(true);
        return;
    }
    if (isCropping && cropRect) {
        const m = getMousePos(e);
        const handleSize = 20 / (baseScale * view.scale); 
        
        if (distance(m, { x: cropRect.x, y: cropRect.y }) < handleSize) { setCropDragMode('nw'); setActiveHandle(-10); return; }
        if (distance(m, { x: cropRect.x + cropRect.w, y: cropRect.y }) < handleSize) { setCropDragMode('ne'); setActiveHandle(-10); return; }
        if (distance(m, { x: cropRect.x, y: cropRect.y + cropRect.h }) < handleSize) { setCropDragMode('sw'); setActiveHandle(-10); return; }
        if (distance(m, { x: cropRect.x + cropRect.w, y: cropRect.y + cropRect.h }) < handleSize) { setCropDragMode('se'); setActiveHandle(-10); return; }
        
        if (m.x > cropRect.x && m.x < cropRect.x + cropRect.w && m.y > cropRect.y && m.y < cropRect.y + cropRect.h) {
            setCropDragMode('move');
            startMousePos.current = m;
            setActiveHandle(-10);
            return;
        }
    }
  };

  const handleContainerPointerMove = (e: React.PointerEvent) => {
    const interactionHandle = activeHandleRef.current;
    if (interactionHandle === -99) {
        if (viewLocked) return;
        const dx = e.clientX - lastPanPos.current.x;
        const dy = e.clientY - lastPanPos.current.y;
        lastPanPos.current = { x: e.clientX, y: e.clientY };
        scheduleView({ ...viewRef.current, x: viewRef.current.x + dx, y: viewRef.current.y + dy });
        return;
    }
    if (isCropping && interactionHandle === -10 && cropRect) {
        const m = getMousePos(e);
        const containerSize = getContainerSize(); // Should be image size in crop mode
        if (cropDragMode === 'move') {
            const dx = m.x - startMousePos.current.x;
            const dy = m.y - startMousePos.current.y;
            startMousePos.current = m;
            setCropRect(r => r ? ({
                ...r,
                x: Math.min(Math.max(0, r.x + dx), containerSize.width - r.w),
                y: Math.min(Math.max(0, r.y + dy), containerSize.height - r.h)
            }) : null);
        } 
    }
  };

  const handleContainerPointerUp = (e: React.PointerEvent) => {
      if (activeHandleRef.current === -99) setIsNavigating(false);
      setActiveHandle(null);
      if (containerRef.current?.hasPointerCapture(e.pointerId)) {
        containerRef.current.releasePointerCapture(e.pointerId);
      }
  };

  const zoomFromCenter = (factor: number) => {
    if (viewLocked) return;
    const viewport = viewportSize();
    zoomAt(
      { x: viewport.width / 2, y: viewport.height / 2 },
      viewRef.current.scale * factor,
    );
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setCanvasRef(canvas);

    const removeContextListeners = () => {
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored);
    };
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      glRef.current = null;
    };
    const handleContextRestored = () => {
      textureCacheRef.current.clear();
      elementCacheRef.current.clear();
      setWebGlGeneration(generation => generation + 1);
    };
    canvas.addEventListener('webglcontextlost', handleContextLost);
    canvas.addEventListener('webglcontextrestored', handleContextRestored);

    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, alpha: true });
    if (!gl) return removeContextListeners;
    glRef.current = gl;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const vsSource = `
      attribute vec2 a_position;
      attribute vec2 a_texCoord;
      uniform vec2 u_resolution;
      varying vec2 v_texCoord;
      void main() {
        vec2 zeroToOne = a_position / u_resolution;
        vec2 zeroToTwo = zeroToOne * 2.0;
        vec2 clipSpace = zeroToTwo - 1.0;
        gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);
        v_texCoord = a_texCoord;
      }
    `;

    const fsSource = `
      precision mediump float;
      uniform sampler2D u_image;
      uniform vec4 u_color;
      uniform int u_isTexture;
      varying vec2 v_texCoord;
      void main() {
        if (u_isTexture == 1) {
          gl_FragColor = texture2D(u_image, v_texCoord);
          gl_FragColor.a *= u_color.a;
        } else {
          gl_FragColor = u_color;
        }
      }
    `;

    const createShader = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        reportError('webgl-shader', new Error(gl.getShaderInfoLog(shader) ?? 'Shader compilation failed'), { type });
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vs = createShader(gl.VERTEX_SHADER, vsSource);
    const fs = createShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return removeContextListeners;

    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      reportError('webgl-program', new Error(gl.getProgramInfoLog(program) ?? 'Shader program linking failed'));
      return removeContextListeners;
    }

    programRef.current = program;

    // Cache uniform/attrib locations once — avoids repeated lookups every render
    uniformsRef.current = {
      resolution: gl.getUniformLocation(program, 'u_resolution'),
      color: gl.getUniformLocation(program, 'u_color'),
      isTexture: gl.getUniformLocation(program, 'u_isTexture'),
      attribPosition: gl.getAttribLocation(program, 'a_position'),
      attribTexCoord: gl.getAttribLocation(program, 'a_texCoord'),
    };

    // Pre-allocate GPU buffers — reused every frame, never recreated
    posBufferRef.current = gl.createBuffer();
    texBufferRef.current = gl.createBuffer();

    // Upload static texCoord data once (0,0 → 1,1 quad)
    gl.bindBuffer(gl.ARRAY_BUFFER, texBufferRef.current);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1
    ]), gl.STATIC_DRAW);

    // --- Second program: per-element extrusion via homography ---
    // Geometry lives in sign-image px space in static buffers; the vertex
    // shader maps it through u_H every frame, so corner drags only update
    // uniforms — no CPU tessellation, no buffer re-uploads.
    const elemVs = createShader(gl.VERTEX_SHADER, `
      attribute vec2 a_pos;      // sign-image px
      attribute float a_top;     // 0 = base plane, 1 = extruded top
      attribute float a_shade;
      uniform mat3 u_H;          // sign-image px -> background-image px homography
      uniform vec2 u_resolution;
      uniform vec2 u_extrude;    // direction * depth (background px), post-divide
      uniform vec2 u_signSize;
      varying vec2 v_uv;
      varying float v_shade;
      void main() {
        vec3 p = u_H * vec3(a_pos, 1.0);
        vec2 img = p.xy / p.z + a_top * u_extrude;
        vec2 clip = (img / u_resolution) * 2.0 - 1.0;
        gl_Position = vec4(clip * vec2(1, -1), 0, 1);
        v_uv = a_pos / u_signSize;
        v_shade = a_shade;
      }
    `);
    const elemFs = createShader(gl.FRAGMENT_SHADER, `
      precision mediump float;
      uniform sampler2D u_image;
      uniform sampler2D u_mask;
      uniform vec4 u_color;
      uniform int u_mode;        // 0 = flat side wall, 1 = masked texture face
      varying vec2 v_uv;
      varying float v_shade;
      void main() {
        if (u_mode == 1) {
          vec4 tex = texture2D(u_image, v_uv);
          float m = texture2D(u_mask, v_uv).a;
          gl_FragColor = vec4(tex.rgb, tex.a * m * u_color.a);
        } else {
          gl_FragColor = vec4(u_color.rgb * v_shade, u_color.a);
        }
      }
    `);
    if (elemVs && elemFs) {
      const elemProgram = gl.createProgram()!;
      gl.attachShader(elemProgram, elemVs);
      gl.attachShader(elemProgram, elemFs);
      gl.linkProgram(elemProgram);
      if (gl.getProgramParameter(elemProgram, gl.LINK_STATUS)) {
        elemProgramRef.current = elemProgram;
        elemLocsRef.current = {
          H: gl.getUniformLocation(elemProgram, 'u_H'),
          resolution: gl.getUniformLocation(elemProgram, 'u_resolution'),
          extrude: gl.getUniformLocation(elemProgram, 'u_extrude'),
          signSize: gl.getUniformLocation(elemProgram, 'u_signSize'),
          color: gl.getUniformLocation(elemProgram, 'u_color'),
          mode: gl.getUniformLocation(elemProgram, 'u_mode'),
          image: gl.getUniformLocation(elemProgram, 'u_image'),
          mask: gl.getUniformLocation(elemProgram, 'u_mask'),
          aPos: gl.getAttribLocation(elemProgram, 'a_pos'),
          aTop: gl.getAttribLocation(elemProgram, 'a_top'),
          aShade: gl.getAttribLocation(elemProgram, 'a_shade'),
        };
      } else reportError('webgl-element-program', new Error(gl.getProgramInfoLog(elemProgram) ?? 'Element shader linking failed'));
    }
    return removeContextListeners;
  }, [setCanvasRef, webGlGeneration]);

  useEffect(() => {
    const gl = glRef.current;
    if (!gl) return;
    const cache = textureCacheRef.current;

    // Evict textures for images no longer referenced by any sign
    const currentImages = new Set(signs.map(s => s.image));
    cache.forEach((tex, key) => {
      if (!currentImages.has(key)) {
        gl.deleteTexture(tex);
        cache.delete(key);
      }
    });

    signs.forEach(sign => {
      if (!cache.has(sign.image)) {
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
        cache.set(sign.image, tex);

        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = sign.image;
        img.onload = () => {
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            if ((img.width & (img.width - 1)) === 0 && (img.height & (img.height - 1)) === 0) {
              gl.generateMipmap(gl.TEXTURE_2D);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
            } else {
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            }
            setTexturesLoaded(n => n + 1);
        };
      }
    });
  }, [signs, webGlGeneration]);

  // Build/evict static per-element geometry. Keyed by an elementsVersion that
  // covers ONLY contours + image — depth and enabled changes are uniforms at
  // draw time, so slider tweaks and corner drags never rebuild buffers.
  useEffect(() => {
    const gl = glRef.current;
    if (!gl) return;
    const cache = elementCacheRef.current;

    const destroyEntry = (entry: { faceBuffer: WebGLBuffer; elements: Map<string, { sideBuffer: WebGLBuffer; sideVertexCount: number; maskTexture: WebGLTexture }> }) => {
      gl.deleteBuffer(entry.faceBuffer);
      entry.elements.forEach(el => { gl.deleteBuffer(el.sideBuffer); gl.deleteTexture(el.maskTexture); });
    };

    const liveIds = new Set(signs.filter(s => s.elements?.length && s.elementsSourceSize).map(s => s.id));
    cache.forEach((entry, id) => {
      if (!liveIds.has(id)) { destroyEntry(entry); cache.delete(id); }
    });

    signs.forEach(sign => {
      if (!sign.elements?.length || !sign.elementsSourceSize) return;
      const version = `${sign.image}|${sign.elementsSourceSize.width}x${sign.elementsSourceSize.height}|` +
        JSON.stringify(sign.elements.map(e => ({ i: e.id, c: e.contours })));
      const existing = cache.get(sign.id);
      if (existing?.version === version) return;
      if (existing) { destroyEntry(existing); cache.delete(sign.id); }

      const { width: w, height: h } = sign.elementsSourceSize;

      // Face quad: full sign area at a_top=1 so u_extrude pops it forward;
      // the per-element mask texture limits it to the element's shape
      const faceBuffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, faceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        0, 0, 1, 1,   w, 0, 1, 1,   0, h, 1, 1,
        0, h, 1, 1,   w, 0, 1, 1,   w, h, 1, 1,
      ]), gl.STATIC_DRAW);

      const elements = new Map<string, { sideBuffer: WebGLBuffer; sideVertexCount: number; maskTexture: WebGLTexture }>();
      const lightX = Math.SQRT1_2, lightY = -Math.SQRT1_2;

      sign.elements.forEach(el => {
        if (!el.contours.some(points => points.length >= 3)) return;

        // Independent side-wall triangles for outer and hole contours.
        const verts: number[] = [];
        el.contours.forEach(pts => {
          for (let i = 0; i < pts.length; i++) {
            const p = pts[i], nxt = pts[(i + 1) % pts.length];
            let nx = nxt.y - p.y, ny = -(nxt.x - p.x); const len = Math.hypot(nx, ny) || 1;
            nx /= len; ny /= len; const shade = 0.68 + 0.32 * Math.abs(nx * lightX + ny * lightY);
            verts.push(p.x,p.y,0,shade, nxt.x,nxt.y,0,shade, p.x,p.y,1,shade, p.x,p.y,1,shade, nxt.x,nxt.y,0,shade, nxt.x,nxt.y,1,shade);
          }
        });
        const sideBuffer = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, sideBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);

        const maskCanvas = buildElementMask(el.contours, sign.elementsSourceSize!);
        const maskTexture = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, maskTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

        elements.set(el.id, { sideBuffer, sideVertexCount: verts.length / 4, maskTexture });
      });

      cache.set(sign.id, { version, faceBuffer, elements });
    });
  }, [signs, webGlGeneration]);

  const render = useCallback(() => {
    const gl = glRef.current;
    const program = programRef.current;
    const canvas = canvasRef.current;
    if (!gl || !program || !canvas) return;

    const sourceWidth = Math.max(1, Math.round(images.backgroundSize.width));
    const sourceHeight = Math.max(1, Math.round(images.backgroundSize.height));
    const previewSize = webGlPreviewSize(gl, sourceWidth, sourceHeight);
    if (canvas.width !== previewSize.width || canvas.height !== previewSize.height) {
        canvas.width = previewSize.width;
        canvas.height = previewSize.height;
    }
    
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(program);

    const uniforms = uniformsRef.current;
    const posBuffer = posBufferRef.current;
    const texBuffer = texBufferRef.current;
    if (!uniforms || !posBuffer || !texBuffer) return;

    // Geometry stays in full-resolution background coordinates while the GPU
    // backing buffer is capped to a device-safe preview size. The DOM photo
    // underneath remains untouched and retains all source pixels for editing.
    gl.uniform2f(uniforms.resolution, sourceWidth, sourceHeight);

    // Set up texCoord attrib once — buffer data is static, set during init
    gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
    gl.enableVertexAttribArray(uniforms.attribTexCoord);
    gl.vertexAttribPointer(uniforms.attribTexCoord, 2, gl.FLOAT, false, 0, 0);

    const drawQuad = (p1: Point, p2: Point, p3: Point, p4: Point, color: number[], isTex: boolean) => {
      // Reuse pre-allocated position buffer — no new allocations per frame
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
      const positions = [ p1.x, p1.y, p2.x, p2.y, p4.x, p4.y, p4.x, p4.y, p2.x, p2.y, p3.x, p3.y ];
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(uniforms.attribPosition);
      gl.vertexAttribPointer(uniforms.attribPosition, 2, gl.FLOAT, false, 0, 0);

      // Re-bind texCoord buffer after position upload
      gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
      gl.vertexAttribPointer(uniforms.attribTexCoord, 2, gl.FLOAT, false, 0, 0);

      gl.uniform4fv(uniforms.color, color);
      gl.uniform1i(uniforms.isTexture, isTex ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };

    signs.forEach(sign => {
      const c = sign.corners;
      const rgb = hexToRgb(sign.sideColor);
      const sideColor = [rgb[0], rgb[1], rgb[2], sign.opacity];
      const shadowColor = [rgb[0]*0.7, rgb[1]*0.7, rgb[2]*0.7, sign.opacity];

      if (sign.extrusionEnabled) {
        const rad = (sign.extrusionAngle * Math.PI) / 180;
        const depthX = Math.cos(rad) * sign.extrusionDepth;
        const depthY = Math.sin(rad) * sign.extrusionDepth;
        const backC = c.map(p => ({ x: p.x + depthX, y: p.y + depthY }));
        
        drawQuad(c[0], c[1], backC[1], backC[0], sideColor, false);
        drawQuad(c[1], c[2], backC[2], backC[1], shadowColor, false);
        drawQuad(c[2], c[3], backC[3], backC[2], sideColor, false);
        drawQuad(c[3], c[0], backC[0], backC[3], shadowColor, false);
      }

      const tex = textureCacheRef.current.get(sign.image);
      if (tex) {
          gl.bindTexture(gl.TEXTURE_2D, tex);
          drawQuad(c[0], c[1], c[2], c[3], [1,1,1, sign.opacity], true);
      }

      // --- Per-element variable extrusion pass ---
      const elemCache = elementCacheRef.current.get(sign.id);
      const elemProgram = elemProgramRef.current;
      const eLocs = elemLocsRef.current;
      const activeElements = sign.elements?.filter(e => e.enabled) ?? [];
      if (elemCache && elemProgram && eLocs && activeElements.length && sign.elementsSourceSize && tex) {
        const { width: sw, height: sh } = sign.elementsSourceSize;
        gl.useProgram(elemProgram);

        // Homography: sign-image px -> background-image px (the quad's plane).
        // Recomputed per render (an 8x8 solve, microseconds) — the geometry
        // itself never leaves the GPU.
        const Hm = computeHomography(
          [{ x: 0, y: 0 }, { x: sw, y: 0 }, { x: sw, y: sh }, { x: 0, y: sh }],
          c
        );
        gl.uniformMatrix3fv(eLocs.H, false, [Hm[0], Hm[3], Hm[6], Hm[1], Hm[4], Hm[7], Hm[2], Hm[5], Hm[8]]);
        gl.uniform2f(eLocs.resolution, sourceWidth, sourceHeight);
        gl.uniform2f(eLocs.signSize, sw, sh);
        gl.uniform1i(eLocs.image, 0);
        gl.uniform1i(eLocs.mask, 1);

        const rad2 = (sign.extrusionAngle * Math.PI) / 180;
        // Converts element depths (sign-image px) to background px on the quad
        const pxScale = ((distance(c[0], c[1]) + distance(c[3], c[2])) / 2) / sw;

        const setAttribs = (buffer: WebGLBuffer) => {
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
          gl.enableVertexAttribArray(eLocs.aPos);
          gl.vertexAttribPointer(eLocs.aPos, 2, gl.FLOAT, false, 16, 0);
          gl.enableVertexAttribArray(eLocs.aTop);
          gl.vertexAttribPointer(eLocs.aTop, 1, gl.FLOAT, false, 16, 8);
          gl.enableVertexAttribArray(eLocs.aShade);
          gl.vertexAttribPointer(eLocs.aShade, 1, gl.FLOAT, false, 16, 12);
        };

        [...activeElements].sort((a, b) => a.depth - b.depth).forEach(elDef => {
          const geo = elemCache.elements.get(elDef.id);
          if (!geo) return;
          const off = elDef.depth * pxScale;
          // Elements rise TOWARD the viewer — opposite the slab's receding sides
          gl.uniform2f(eLocs.extrude, -Math.cos(rad2) * off, -Math.sin(rad2) * off);

          // Side walls
          gl.uniform1i(eLocs.mode, 0);
          gl.uniform4f(eLocs.color, rgb[0], rgb[1], rgb[2], sign.opacity);
          setAttribs(geo.sideBuffer);
          gl.drawArrays(gl.TRIANGLES, 0, geo.sideVertexCount);

          // Masked face, popped forward by the same offset
          gl.uniform1i(eLocs.mode, 1);
          gl.uniform4f(eLocs.color, 1, 1, 1, sign.opacity);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, geo.maskTexture);
          setAttribs(elemCache.faceBuffer);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
          gl.activeTexture(gl.TEXTURE0);
        });

        // Restore classic-program state for subsequent signs
        gl.disableVertexAttribArray(eLocs.aTop);
        gl.disableVertexAttribArray(eLocs.aShade);
        gl.useProgram(program);
        gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
        gl.enableVertexAttribArray(uniforms.attribTexCoord);
        gl.vertexAttribPointer(uniforms.attribTexCoord, 2, gl.FLOAT, false, 0, 0);
      }
    });

  }, [signs, texturesLoaded, images.backgroundSize]);

  useEffect(() => { requestAnimationFrame(render); }, [render]);

  const handlePointerDown = (index: number, dimensionId?: string) => (e: React.PointerEvent) => {
    if (isCropping || toolMode !== 'select') return;
    if (titleBlock.viewMode === 'sheet') return; // Disable interaction in sheet view
    if (e.button !== 0) return; // Only allow left click for manipulation

    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    activeEditPointerRef.current = e.pointerId;
    
    // We update startMousePos just in case, but getMousePos depends on view/scale not event target
    startMousePos.current = getMousePos(e);

    if (dimensionId) {
        const targetDimension = dimensions.find(dimension => dimension.id === dimensionId);
        if (!targetDimension) return;
        setActiveSign(null);
        setActiveDimension(dimensionId);
        dragSignIdRef.current = null;
        dragDimensionIdRef.current = dimensionId;
        startDimRef.current = { start: { ...targetDimension.start }, end: { ...targetDimension.end } };
        if (targetDimension.variant === 'box' && index >= 10) {
            const isStartLeft = targetDimension.start.x < targetDimension.end.x;
            const isStartTop = targetDimension.start.y < targetDimension.end.y;
            let targetX: 'start'|'end'|null = null;
            let targetY: 'start'|'end'|null = null;
            if ([10, 16, 17].includes(index)) targetX = isStartLeft ? 'start' : 'end';
            else if ([12, 13, 14].includes(index)) targetX = isStartLeft ? 'end' : 'start';
            if ([10, 11, 12].includes(index)) targetY = isStartTop ? 'start' : 'end';
            else if ([14, 15, 16].includes(index)) targetY = isStartTop ? 'end' : 'start';
            boxDragTargetsRef.current = { x: targetX, y: targetY };
        }
        if (index === 0 || index === 1 || index >= 10) {
            showPrecisionLoupe('dimension', e, startMousePos.current);
        }
    } else if (activeSignId) {
        const activeSign = signs.find(s => s.id === activeSignId);
        if (activeSign) {
            startCornersRef.current = [...activeSign.corners];
            dragSignIdRef.current = activeSign.id;
            if (index >= 0 && index < 4) {
                showPrecisionLoupe('sign', e, startMousePos.current);
            }
        }
    } else if (activeDimensionId) {
        dragSignIdRef.current = null;
        dragDimensionIdRef.current = activeDimensionId;
        const activeDim = dimensions.find(d => d.id === activeDimensionId);
        if (activeDim) {
             startDimRef.current = { start: { ...activeDim.start }, end: { ...activeDim.end } };
             if (activeDim.variant === 'box' && index >= 10) {
                 const isStartLeft = activeDim.start.x < activeDim.end.x;
                 const isStartTop = activeDim.start.y < activeDim.end.y;
                 let targetX: 'start'|'end'|null = null;
                 let targetY: 'start'|'end'|null = null;
                 if ([10, 16, 17].includes(index)) targetX = isStartLeft ? 'start' : 'end';
                 else if ([12, 13, 14].includes(index)) targetX = isStartLeft ? 'end' : 'start';
                 if ([10, 11, 12].includes(index)) targetY = isStartTop ? 'start' : 'end';
                 else if ([14, 15, 16].includes(index)) targetY = isStartTop ? 'end' : 'start';
                 boxDragTargetsRef.current = { x: targetX, y: targetY };
             }
              if (index === 0 || index === 1 || index >= 10) {
                  showPrecisionLoupe('dimension', e, startMousePos.current);
              }
        }
    }
    setActiveHandle(index);
    setHoveredHandle(null);
  };

  const beginSignBodyDrag = (sign: Sign, e: React.PointerEvent) => {
      if (isCropping || toolMode !== 'select' || titleBlock.viewMode === 'sheet' || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      activeEditPointerRef.current = e.pointerId;
      setActiveSign(sign.id);
      startMousePos.current = getMousePos(e);
      startCornersRef.current = [...sign.corners];
      dragSignIdRef.current = sign.id;
      setActiveHandle(4);
      setHoveredHandle(null);
  };

  const beginCalibrationPointDrag = (index: number) => (e: React.PointerEvent) => {
      if (!calibrationDraft?.editable || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      setCalibrationDragIndex(index);
      showPrecisionLoupe('calibration', e, calibrationDraft.points[index]);
  };

  const handleCanvasPointerDown = (e: React.PointerEvent) => {
      if (isCropping) return;
      if (titleBlock.viewMode === 'sheet') return; // Disable interaction in sheet view
      if (toolMode === 'pan') return; // Let the outer viewport handler pan instead of selecting content

      if (e.button === 2) {
        if (isDrawing) {
          setIsDrawing(false);
          drawingStart.current = null;
          drawingCurrent.current = null;
          drawingTouchRef.current = null;
          clearPrecisionLoupe();
          return;
        }
      }
      const pos = getMousePos(e);
      if (toolMode === 'calibrate' || toolMode === 'calibrate_plane') {
        e.preventDefault(); e.stopPropagation();
        const expectedMethod = toolMode === 'calibrate_plane' ? 'plane' : 'line';
        const maxPoints = expectedMethod === 'plane' ? 4 : 2;
        if (calibrationDraft?.editable && calibrationDraft.method === expectedMethod && calibrationDraft.points.length < maxPoints) {
          onCalibrationDraftPointsChange([...calibrationDraft.points, pos]);
        }
        setActiveSign(null); setActiveDimension(''); return;
      }
      if (toolMode === 'draw_line' || toolMode === 'draw_box') {
        e.preventDefault(); e.stopPropagation();
        if (e.pointerType === 'touch') {
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* best effort on mobile browsers */ }
          const completesOnUp = drawingStart.current !== null;
          if (!drawingStart.current) {
            setIsDrawing(true);
            drawingStart.current = pos;
            drawingCurrent.current = pos;
            setActiveSign(null);
            setActiveDimension('');
          } else {
            drawingCurrent.current = pos;
            setTick(value => value + 1);
          }
          drawingTouchRef.current = {
            pointerId: e.pointerId,
            startClient: { x: e.clientX, y: e.clientY },
            completesOnUp,
          };
          showPrecisionLoupe('drawing', e, pos);
          return;
        }
        if (!isDrawing) {
          setIsDrawing(true);
          drawingStart.current = pos;
          drawingCurrent.current = pos;
          setActiveSign(null);
          setActiveDimension('');
        } else if (drawingStart.current) {
          onDrawComplete(drawingStart.current, pos, toolMode === 'draw_box' ? 'box' : 'linear');
          setIsDrawing(false);
          drawingStart.current = null;
          drawingCurrent.current = null;
        }
        return;
      }
      
      let hitFound = false;
      if (state.showDimensions) { for (const dim of dimensions) { let isHit = false; if (dim.variant === 'box') { const x = Math.min(dim.start.x, dim.end.x); const y = Math.min(dim.start.y, dim.end.y); const w = Math.abs(dim.end.x - dim.start.x); const h = Math.abs(dim.end.y - dim.start.y); if (pos.x >= x && pos.x <= x + w && pos.y >= y && pos.y <= y + h) isHit = true; } else { const hitRadius = 20 / Math.max(baseScale * view.scale, 0.01); isHit = pointToSegmentDistance(pos, dim.start, dim.end) <= hitRadius; } if (isHit) { setActiveDimension(dim.id); if (dim.id === activeDimensionId) { e.currentTarget.setPointerCapture(e.pointerId); activeEditPointerRef.current = e.pointerId; dragDimensionIdRef.current = dim.id; startMousePos.current = pos; startDimRef.current = { start: { ...dim.start }, end: { ...dim.end } }; setActiveHandle(2); } hitFound = true; return; } } }
      if (!hitFound) {
        for (let i = signs.length - 1; i >= 0; i--) {
          const sign = signs[i];
          if (!isPointInPolygon(pos, sign.corners)) continue;
          beginSignBodyDrag(sign, e);
          return;
        }
      }
      if (!hitFound) { dragSignIdRef.current = null; setActiveSign(null); setActiveDimension(''); }
  };

  const updateDraggedDimension = (interactionHandle: number, pos: Point) => {
      const draggedDimensionId = dragDimensionIdRef.current ?? activeDimensionId;
      if (!draggedDimensionId || !startDimRef.current) return false;
      const dx = pos.x - startMousePos.current.x;
      const dy = pos.y - startMousePos.current.y;
      const start = startDimRef.current.start;
      const end = startDimRef.current.end;

      if (interactionHandle === 0) updateDimension(draggedDimensionId, { start: { x: start.x + dx, y: start.y + dy } });
      else if (interactionHandle === 1) updateDimension(draggedDimensionId, { end: { x: end.x + dx, y: end.y + dy } });
      else if (interactionHandle === 2) updateDimension(draggedDimensionId, { start: { x: start.x + dx, y: start.y + dy }, end: { x: end.x + dx, y: end.y + dy } });
      else if (interactionHandle >= 10) {
          const targets = boxDragTargetsRef.current;
          const newStart = { ...start };
          const newEnd = { ...end };
          if (targets.x === 'start') newStart.x += dx;
          else if (targets.x === 'end') newEnd.x += dx;
          if (targets.y === 'start') newStart.y += dy;
          else if (targets.y === 'end') newEnd.y += dy;
          updateDimension(draggedDimensionId, { start: newStart, end: newEnd });
      } else return false;

      return true;
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isCropping) return;

    if (calibrationDragIndex !== null && calibrationDraft?.editable) {
        e.preventDefault();
        e.stopPropagation();
        const next = [...calibrationDraft.points];
        const point = getMousePos(e);
        next[calibrationDragIndex] = point;
        onCalibrationDraftPointsChange(next);
        showPrecisionLoupe('calibration', e, point);
        return;
    }
    
    // If we are dragging a handle, handle it here and stop propagation
    const interactionHandle = activeHandleRef.current;
    if (interactionHandle !== null) {
        if (activeEditPointerRef.current !== null && activeEditPointerRef.current !== e.pointerId) return;
        e.preventDefault();
        e.stopPropagation();
        
        const pos = getMousePos(e);
        const dx = pos.x - startMousePos.current.x;
        const dy = pos.y - startMousePos.current.y;
        
        const dragSignId = dragSignIdRef.current ?? activeSignId;
        if (dragSignId && startCornersRef.current) {
            const activeSign = signs.find(s => s.id === dragSignId);
            if (!activeSign) return;
            const startCorners = startCornersRef.current;
            if (interactionHandle < 4) {
                const newCorners = [...activeSign.corners] as [Point, Point, Point, Point]; 
                newCorners[interactionHandle] = pos;
                updateSignById(dragSignId, { corners: newCorners });
                if (precisionPointerRef.current?.kind === 'sign' && precisionPointerRef.current.pointerId === e.pointerId) {
                    showPrecisionLoupe('sign', e, pos);
                }
            } 
            else if (interactionHandle === 4) {
                const movedCorners = startCorners.map(p => ({ x: p.x + dx, y: p.y + dy })) as [Point, Point, Point, Point]; 
                updateSignById(dragSignId, { corners: movedCorners });
            } 
            else if (interactionHandle === 5) {
                const center = {
                    x: startCorners.reduce((sum, point) => sum + point.x, 0) / startCorners.length,
                    y: startCorners.reduce((sum, point) => sum + point.y, 0) / startCorners.length,
                };
                const startDistance = startMousePos.current.x - center.x;
                if (Math.abs(startDistance) < 1) return;
                const scaleX = Math.max(0.05, (pos.x - center.x) / startDistance);
                const newCorners = startCorners.map(p => ({ x: center.x + (p.x - center.x) * scaleX, y: p.y })) as [Point, Point, Point, Point];
                updateSignById(dragSignId, { corners: newCorners });
            }
            else if (interactionHandle === 6) {
                const center = {
                    x: startCorners.reduce((sum, point) => sum + point.x, 0) / startCorners.length,
                    y: startCorners.reduce((sum, point) => sum + point.y, 0) / startCorners.length,
                };
                const startDistance = startMousePos.current.y - center.y;
                if (Math.abs(startDistance) < 1) return;
                const scaleY = Math.max(0.05, (pos.y - center.y) / startDistance);
                const newCorners = startCorners.map(p => ({ x: p.x, y: center.y + (p.y - center.y) * scaleY })) as [Point, Point, Point, Point];
                updateSignById(dragSignId, { corners: newCorners });
            }
        } else if (updateDraggedDimension(interactionHandle, pos)) {
            if (precisionPointerRef.current?.kind === 'dimension' && precisionPointerRef.current.pointerId === e.pointerId) {
                showPrecisionLoupe('dimension', e, pos);
            }
        }
        return;
    }

    const pos = getMousePos(e);
    if (isDrawing && drawingStart.current) {
        drawingCurrent.current = pos;
        setTick(t => t + 1);
        if (drawingTouchRef.current?.pointerId === e.pointerId) showPrecisionLoupe('drawing', e, pos);
        return;
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (activeHandleRef.current !== null && activeEditPointerRef.current !== null && activeEditPointerRef.current !== e.pointerId) return;

    // Capture release and cleanup
    if (e.currentTarget.hasPointerCapture(e.pointerId)) { 
        e.currentTarget.releasePointerCapture(e.pointerId); 
    }

    const touchDrawing = drawingTouchRef.current;
    if (touchDrawing?.pointerId === e.pointerId) {
        const end = getMousePos(e);
        drawingCurrent.current = end;
        const moved = distance(touchDrawing.startClient, { x: e.clientX, y: e.clientY }) >= TOUCH_DRAW_THRESHOLD;
        const shouldComplete = touchDrawing.completesOnUp || moved;
        if (shouldComplete && drawingStart.current) {
            onDrawComplete(drawingStart.current, end, toolMode === 'draw_box' ? 'box' : 'linear');
            setIsDrawing(false);
            drawingStart.current = null;
            drawingCurrent.current = null;
        } else {
            setTick(value => value + 1);
        }
        drawingTouchRef.current = null;
        clearPrecisionLoupe();
        e.stopPropagation();
        return;
    }

    if (activeHandleRef.current !== null) updateDraggedDimension(activeHandleRef.current, getMousePos(e));
    
    // Only stop propagation if we were dragging a handle
    if (activeHandleRef.current !== null) {
        e.stopPropagation();
    }
    
    setCalibrationDragIndex(null);
    clearPrecisionLoupe();
    activeEditPointerRef.current = null;
    setActiveHandle(null); startCornersRef.current = null; dragSignIdRef.current = null; dragDimensionIdRef.current = null; startDimRef.current = null;
  };

  const handleCanvasPointerCancel = (e: React.PointerEvent) => {
    setIsDrawing(false);
    drawingStart.current = null;
    drawingCurrent.current = null;
    drawingTouchRef.current = null;
    setActiveHandle(null);
    setCalibrationDragIndex(null);
    clearPrecisionLoupe();
    activeEditPointerRef.current = null;
    startCornersRef.current = null;
    dragSignIdRef.current = null;
    startDimRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const confirmCrop = () => {
    if (!cropRect) return;
    const sourceWidth = Math.max(1, Math.round(images.backgroundSize.width));
    const sourceHeight = Math.max(1, Math.round(images.backgroundSize.height));
    const cropX = Math.max(0, Math.min(sourceWidth - 1, Math.round(cropRect.x)));
    const cropY = Math.max(0, Math.min(sourceHeight - 1, Math.round(cropRect.y)));
    const cropWidth = Math.min(sourceWidth - cropX, Math.max(1, Math.round(cropRect.w)));
    const cropHeight = Math.min(sourceHeight - cropY, Math.max(1, Math.round(cropRect.h)));
    const fullFrame = cropX === 0 && cropY === 0 && cropWidth === sourceWidth && cropHeight === sourceHeight;

    if (fullFrame) {
        onCropConfirm(images.background, { x: 0, y: 0 }, { width: sourceWidth, height: sourceHeight });
        return;
    }
    if (cropWidth * cropHeight > MAX_FULL_RESOLUTION_CROP_PIXELS) {
        notify('This full-resolution crop is too large for this device. Tighten the crop area, or keep the complete image.', 'error');
        return;
    }

    const operation = ++cropOperationRef.current;
    setIsCropProcessing(true);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
        if (cropOperationRef.current !== operation) return;
        try {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = cropWidth;
            tempCanvas.height = cropHeight;
            const ctx = tempCanvas.getContext('2d');
            if (!ctx) throw new Error('This device could not allocate the full-resolution crop canvas.');
            ctx.drawImage(img, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
            const sourceMime = images.background.match(/^data:(image\/(?:png|jpe?g|webp|avif));/i)?.[1]?.toLowerCase();
            const outputMime = sourceMime === 'image/jpeg' || sourceMime === 'image/jpg'
                ? 'image/jpeg'
                : sourceMime === 'image/webp'
                    ? 'image/webp'
                    : sourceMime === 'image/png'
                        ? 'image/png'
                        : 'image/webp';
            tempCanvas.toBlob(blob => {
                if (cropOperationRef.current !== operation) return;
                if (!blob) {
                    setIsCropProcessing(false);
                    notify('The full-resolution crop could not be encoded.', 'error');
                    return;
                }
                if (blob.size > MAX_SOURCE_BYTES) {
                    setIsCropProcessing(false);
                    notify('This full-resolution crop exceeds 40 MB. Tighten the crop area and try again.', 'error');
                    return;
                }
                const reader = new FileReader();
                reader.onload = () => {
                    if (cropOperationRef.current !== operation) return;
                    setIsCropProcessing(false);
                    onCropConfirm(
                        reader.result as string,
                        { x: cropX, y: cropY },
                        { width: tempCanvas.width, height: tempCanvas.height },
                    );
                };
                reader.onerror = () => {
                    if (cropOperationRef.current !== operation) return;
                    setIsCropProcessing(false);
                    notify('The full-resolution crop could not be read.', 'error');
                };
                reader.readAsDataURL(blob);
            }, outputMime, 0.96);
        } catch (error) {
            if (cropOperationRef.current !== operation) return;
            setIsCropProcessing(false);
            reportError('background-crop', error, { cropWidth, cropHeight });
            notify(error instanceof Error ? error.message : 'This crop could not be processed at full resolution.', 'error');
        }
    };
    img.onerror = () => {
        if (cropOperationRef.current !== operation) return;
        setIsCropProcessing(false);
        notify('The background image could not be loaded for cropping.', 'error');
    };
    img.src = images.background;
  };

  const activeSign = signs.find(s => s.id === activeSignId);
  const activeSignCenter = activeSign ? { x: (activeSign.corners[0].x + activeSign.corners[1].x + activeSign.corners[2].x + activeSign.corners[3].x) / 4, y: (activeSign.corners[0].y + activeSign.corners[1].y + activeSign.corners[2].y + activeSign.corners[3].y) / 4 } : null;
  const activeSignBounds = activeSign ? {
      maxX: Math.max(...activeSign.corners.map(point => point.x)),
      maxY: Math.max(...activeSign.corners.map(point => point.y)),
  } : null;
  const totalScale = baseScale * view.scale;

  // Render Title Block Layout Overlay
  const isSheetView = titleBlock.viewMode === 'sheet';
  const containerSize = getContainerSize();

  // Common Input Style for Title Block
  const inputStyle = "w-full bg-transparent border border-transparent hover:border-gray-400 focus:border-blue-500 focus:bg-white px-1 rounded outline-none text-inherit font-inherit";

  // --- Sheet View Layout Calculation ---
  
  const { width: paperW, height: paperH } = containerSize;
  const { width: imgW, height: imgH } = images.backgroundSize;

  // Use the style object directly from the TitleBlock state
  const template = titleBlock.style;
  const isVertical = template.layout === 'vertical-right';
  
  let sceneScale = 1;
  let sceneTx = 0;
  let sceneTy = 0;
  let sbStyle: React.CSSProperties = {};

  if (isSheetView) {
      if (isVertical) {
          // Vertical Layout: Sidebar at Right
          const sbW = Math.max(240, paperW * 0.20); // Relative to paper width
          const viewW = paperW - sbW;

          // Fit image into viewW, preserving aspect ratio
          const scale = Math.min(viewW / imgW, paperH / imgH) * 0.96; // 96% fit for padding
          sceneScale = scale;
          
          const fitW = imgW * scale;
          const fitH = imgH * scale;
          sceneTx = (viewW - fitW) / 2;
          sceneTy = (paperH - fitH) / 2;
          
          sbStyle = { top: 0, right: 0, bottom: 0, width: sbW, borderLeft: '2px solid black' };
      } else {
          // Horizontal Layout: Sidebar at Bottom
          const sbH = Math.max(150, paperH * 0.15); // Relative to paper height
          const viewH = paperH - sbH;

          // Fit image into viewH
          const scale = Math.min(paperW / imgW, viewH / imgH) * 0.96;
          sceneScale = scale;

          const fitW = imgW * scale;
          const fitH = imgH * scale;
          sceneTx = (paperW - fitW) / 2;
          sceneTy = (viewH - fitH) / 2;

          sbStyle = { top: viewH, left: 0, right: 0, height: sbH, borderTop: '2px solid black' };
      }
      
      // Override with template styles
      sbStyle = {
          ...sbStyle,
          backgroundColor: template.backgroundColor,
          color: template.textColor,
          fontFamily: template.fontFamily
      };
  } else {
      // In Editor mode, Scene fills the container 1:1 (before viewport zoom)
      sceneScale = 1;
      sceneTx = 0;
      sceneTy = 0;
  }

  // In sheet view the scene div is further scaled by sceneScale, so annotation
  // strokes/labels must compensate for both transforms to stay constant on screen.
  const handleScale = 1 / (totalScale * (isSheetView ? sceneScale : 1));
  const dimensionLabelScale = handleScale * Math.max(0.35, Math.min(1, view.scale));
  const loupeScale = Math.min(8, Math.max(1.4, totalScale * (isSheetView ? sceneScale : 1) * 4));
  const loupePosition = precisionLoupe
      ? precisionLoupePosition(
          precisionLoupe.clientX,
          precisionLoupe.clientY,
          typeof window === 'undefined' ? 1024 : window.innerWidth,
          typeof window === 'undefined' ? 768 : window.innerHeight,
        )
      : null;
  const loupeCenter = PRECISION_LOUPE_SIZE / 2;

  useEffect(() => {
    const source = canvasRef.current;
    const target = loupeCanvasRef.current;
    if (!precisionLoupe || !source || !target) return;

    const frame = window.requestAnimationFrame(() => {
      const context = target.getContext('2d');
      if (!context) return;
      const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const targetPixels = Math.round(PRECISION_LOUPE_SIZE * pixelRatio);
      if (target.width !== targetPixels || target.height !== targetPixels) {
        target.width = targetPixels;
        target.height = targetPixels;
      }
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, target.width, target.height);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';

      const sourceSize = PRECISION_LOUPE_SIZE / loupeScale;
      const sourceLeft = precisionLoupe.point.x - sourceSize / 2;
      const sourceTop = precisionLoupe.point.y - sourceSize / 2;
      const clippedLeft = Math.max(0, sourceLeft);
      const clippedTop = Math.max(0, sourceTop);
      const clippedRight = Math.min(images.backgroundSize.width, sourceLeft + sourceSize);
      const clippedBottom = Math.min(images.backgroundSize.height, sourceTop + sourceSize);
      const clippedWidth = clippedRight - clippedLeft;
      const clippedHeight = clippedBottom - clippedTop;
      if (clippedWidth <= 0 || clippedHeight <= 0) return;

      const backingScaleX = source.width / Math.max(1, images.backgroundSize.width);
      const backingScaleY = source.height / Math.max(1, images.backgroundSize.height);

      context.drawImage(
        source,
        clippedLeft * backingScaleX,
        clippedTop * backingScaleY,
        clippedWidth * backingScaleX,
        clippedHeight * backingScaleY,
        (clippedLeft - sourceLeft) * loupeScale,
        (clippedTop - sourceTop) * loupeScale,
        clippedWidth * loupeScale,
        clippedHeight * loupeScale,
      );
    });

    return () => window.cancelAnimationFrame(frame);
  }, [images.backgroundSize, loupeScale, precisionLoupe, signs, texturesLoaded]);

  // Filter fields by section
  const projectFields = titleBlock.fields.filter(f => f.section === 'project');
  const drawingFields = titleBlock.fields.filter(f => f.section === 'drawing');
  const sheetFields = titleBlock.fields.filter(f => f.section === 'sheet');

  return (
    <div 
      ref={containerRef} 
      data-testid="canvas-viewport"
      className="w-full h-full flex items-center justify-center overflow-hidden relative select-none"
      onWheel={handleWheel}
      onPointerDownCapture={handleTouchPointerDownCapture}
      onPointerMoveCapture={handleTouchPointerMoveCapture}
      onPointerUpCapture={(e) => finishTouchPointer(e, false)}
      onPointerCancelCapture={(e) => finishTouchPointer(e, true)}
      onPointerDown={handleContainerPointerDown}
      onPointerMove={handleContainerPointerMove}
      onPointerUp={handleContainerPointerUp}
      onPointerCancel={handleContainerPointerUp}
      onContextMenu={(e) => e.preventDefault()}
      style={{ touchAction: 'none', cursor: isNavigating ? 'grabbing' : toolMode === 'pan' ? 'grab' : (toolMode === 'draw_line' || toolMode === 'draw_box' || toolMode === 'calibrate' || toolMode === 'calibrate_plane') ? 'crosshair' : 'default', backgroundColor: isSheetView ? '#333' : '#0a0a0a' }}
    >
      {/* Zoom Controls — offset below the user profile pill rendered by App at top-right */}
      <div data-canvas-ui className="absolute top-20 right-4 flex flex-col gap-2 z-40">
        <button disabled={viewLocked} aria-label="Zoom in" title={viewLocked ? 'Unlock the view to zoom' : 'Zoom in'} onClick={() => zoomFromCenter(1.2)} className="p-3 md:p-2 bg-gray-800 enabled:hover:bg-gray-700 text-white rounded shadow border border-gray-600 disabled:cursor-not-allowed disabled:opacity-35"><ZoomIn className="w-5 h-5" /></button>
        <button disabled={viewLocked} aria-label="Zoom out" title={viewLocked ? 'Unlock the view to zoom' : 'Zoom out'} onClick={() => zoomFromCenter(1 / 1.2)} className="p-3 md:p-2 bg-gray-800 enabled:hover:bg-gray-700 text-white rounded shadow border border-gray-600 disabled:cursor-not-allowed disabled:opacity-35"><ZoomOut className="w-5 h-5" /></button>
        <button disabled={viewLocked} aria-label="Fit canvas to screen" title={viewLocked ? 'Unlock the view to fit the canvas' : 'Fit canvas to screen'} onClick={fitToContainer} className="p-3 md:p-2 bg-gray-800 enabled:hover:bg-gray-700 text-white rounded shadow border border-gray-600 disabled:cursor-not-allowed disabled:opacity-35"><Maximize className="w-5 h-5" /></button>
        <button
          type="button"
          data-testid="view-lock-toggle"
          aria-label={viewLocked ? 'Unlock canvas view' : 'Lock canvas view'}
          aria-pressed={viewLocked}
          title={viewLocked ? 'Unlock pan and zoom' : 'Lock pan and zoom'}
          onClick={() => onViewLockedChange(!viewLocked)}
          className={`p-3 md:p-2 rounded shadow border transition-colors ${viewLocked ? 'border-amber-300 bg-amber-500 text-gray-950 hover:bg-amber-400' : 'border-gray-600 bg-gray-800 text-white hover:bg-gray-700'}`}
        >
          {viewLocked ? <Lock className="h-5 w-5" /> : <Unlock className="h-5 w-5" />}
        </button>
      </div>
      {(toolMode === 'draw_line' || toolMode === 'draw_box') && (
        <div data-canvas-ui className="pointer-events-none absolute bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-40 -translate-x-1/2 rounded-full border border-blue-400/40 bg-gray-950/90 px-4 py-2 text-center text-sm font-medium text-white shadow-xl backdrop-blur">
          {isDrawing
            ? `Press and drag, or tap the opposite ${toolMode === 'draw_box' ? 'corner' : 'endpoint'} · ${viewLocked ? 'view locked' : 'pinch to zoom'}`
            : `Tap the first ${toolMode === 'draw_box' ? 'corner' : 'endpoint'}, or press and drag`}
        </div>
      )}
      {isCropping && cropRect && (
        <div data-canvas-ui className="absolute bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-[80] flex -translate-x-1/2 items-center gap-2 rounded-xl border border-sky-400/40 bg-slate-950/95 p-2 shadow-2xl backdrop-blur">
          <span className="hidden px-2 text-xs font-semibold text-sky-200 sm:inline">Full-resolution crop</span>
          <button
            type="button"
            disabled={isCropProcessing}
            onClick={() => { cropOperationRef.current += 1; setIsCropProcessing(false); onCancelCrop(); }}
            className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800 disabled:cursor-wait disabled:opacity-40"
          >Cancel</button>
          <button
            type="button"
            disabled={isCropProcessing}
            onClick={confirmCrop}
            className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-bold text-slate-950 hover:bg-sky-400 disabled:cursor-wait disabled:opacity-60"
          >{isCropProcessing ? 'Processing…' : 'Apply crop'}</button>
        </div>
      )}
      {precisionLoupe && loupePosition && (
        <div
          data-canvas-ui
          data-testid="precision-loupe"
          data-loupe-kind={precisionLoupe.kind}
          aria-hidden="true"
          className="pointer-events-none fixed z-[195] overflow-hidden rounded-full bg-slate-950 shadow-2xl"
          style={{
            width: PRECISION_LOUPE_SIZE,
            height: PRECISION_LOUPE_SIZE,
            left: loupePosition.left,
            top: loupePosition.top,
            outline: '4px solid white',
            boxShadow: `0 0 0 3px ${precisionLoupe.kind === 'calibration' ? '#f59e0b' : '#38bdf8'}, 0 18px 42px rgba(0, 0, 0, 0.55)`,
          }}
        >
          {images.background && (
            <img
              src={images.background}
              alt=""
              crossOrigin="anonymous"
              className="absolute max-w-none select-none"
              style={{
                width: images.backgroundSize.width * loupeScale,
                height: images.backgroundSize.height * loupeScale,
                left: loupeCenter - precisionLoupe.point.x * loupeScale,
                top: loupeCenter - precisionLoupe.point.y * loupeScale,
                opacity: state.isNightMode ? 0.82 : 1,
                filter: state.isNightMode ? 'brightness(0.32) contrast(1.32) saturate(0.72) hue-rotate(8deg)' : 'none',
              }}
            />
          )}
          {state.isNightMode && <span className="absolute inset-0 bg-slate-950/20" />}
          <canvas
            ref={loupeCanvasRef}
            data-testid="precision-loupe-sign-layer"
            width={PRECISION_LOUPE_SIZE}
            height={PRECISION_LOUPE_SIZE}
            className="absolute inset-0 h-full w-full"
            style={{ filter: state.isNightMode ? 'brightness(1.16) saturate(1.22) drop-shadow(0 0 5px rgba(125,211,252,0.32))' : 'none' }}
          />
          <svg
            className="absolute max-w-none overflow-visible"
            viewBox={`0 0 ${images.backgroundSize.width} ${images.backgroundSize.height}`}
            style={{
              width: images.backgroundSize.width * loupeScale,
              height: images.backgroundSize.height * loupeScale,
              left: loupeCenter - precisionLoupe.point.x * loupeScale,
              top: loupeCenter - precisionLoupe.point.y * loupeScale,
            }}
          >
            {state.showDimensions && dimensions.map(dimension => dimension.variant === 'box' ? (
              <rect
                key={`loupe-${dimension.id}`}
                x={Math.min(dimension.start.x, dimension.end.x)}
                y={Math.min(dimension.start.y, dimension.end.y)}
                width={Math.abs(dimension.end.x - dimension.start.x)}
                height={Math.abs(dimension.end.y - dimension.start.y)}
                fill={dimension.id === activeDimensionId ? 'rgba(56, 189, 248, 0.18)' : 'rgba(255, 255, 255, 0.08)'}
                stroke={dimension.id === activeDimensionId ? '#38bdf8' : (dimension.color || '#ffffff')}
                strokeWidth={2 / loupeScale}
                strokeDasharray={`${5 / loupeScale} ${3 / loupeScale}`}
              />
            ) : (
              <line
                key={`loupe-${dimension.id}`}
                x1={dimension.start.x}
                y1={dimension.start.y}
                x2={dimension.end.x}
                y2={dimension.end.y}
                stroke={dimension.id === activeDimensionId ? '#38bdf8' : (dimension.color || '#ffffff')}
                strokeWidth={2 / loupeScale}
              />
            ))}
            {drawingStart.current && drawingCurrent.current && (toolMode === 'draw_line' || toolMode === 'draw_box') && (
              toolMode === 'draw_box' ? (
                <rect
                  x={Math.min(drawingStart.current.x, drawingCurrent.current.x)}
                  y={Math.min(drawingStart.current.y, drawingCurrent.current.y)}
                  width={Math.abs(drawingCurrent.current.x - drawingStart.current.x)}
                  height={Math.abs(drawingCurrent.current.y - drawingStart.current.y)}
                  fill="rgba(56, 189, 248, 0.2)"
                  stroke="#38bdf8"
                  strokeWidth={2 / loupeScale}
                  strokeDasharray={`${5 / loupeScale} ${3 / loupeScale}`}
                />
              ) : (
                <line
                  x1={drawingStart.current.x}
                  y1={drawingStart.current.y}
                  x2={drawingCurrent.current.x}
                  y2={drawingCurrent.current.y}
                  stroke="#38bdf8"
                  strokeWidth={2 / loupeScale}
                />
              )
            )}
            {calibrationDraft && calibrationDraft.points.length > 1 && (
              <polyline
                points={calibrationDraft.points.map(point => `${point.x},${point.y}`).join(' ')}
                fill="none"
                stroke="#f59e0b"
                strokeWidth={2 / loupeScale}
              />
            )}
          </svg>
          <span
            className="absolute left-1/2 top-2 h-[calc(100%-1rem)] w-px -translate-x-1/2 shadow-[0_0_0_1px_rgba(0,0,0,.7)]"
            style={{ backgroundColor: precisionLoupe.kind === 'calibration' ? '#f59e0b' : '#38bdf8' }}
          />
          <span
            className="absolute left-2 top-1/2 h-px w-[calc(100%-1rem)] -translate-y-1/2 shadow-[0_0_0_1px_rgba(0,0,0,.7)]"
            style={{ backgroundColor: precisionLoupe.kind === 'calibration' ? '#f59e0b' : '#38bdf8' }}
          />
          <span
            data-testid="precision-loupe-crosshair-center"
            className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
            style={{ backgroundColor: precisionLoupe.kind === 'calibration' ? '#f59e0b' : '#0ea5e9' }}
          />
        </div>
      )}

      {/* Main Canvas Wrapper */}
      <div 
        id="export-target"
        style={{
            width: containerSize.width,
            height: containerSize.height,
            transform: `translate(${view.x}px, ${view.y}px) scale(${totalScale})`,
            transformOrigin: 'center center',
            flexShrink: 0,
            boxShadow: isSheetView ? '0 0 20px rgba(0,0,0,0.5)' : 'none',
            backgroundColor: '#fff' 
        }}
        className="relative shadow-2xl origin-center"
        onPointerDown={!isCropping ? handleCanvasPointerDown : undefined} 
        onPointerMove={!isCropping ? handlePointerMove : undefined}
        onPointerUp={!isCropping ? handlePointerUp : undefined}
        onPointerCancel={!isCropping ? handleCanvasPointerCancel : undefined}
      >
        {/* Title Block Sidebar Overlay (Only in Sheet Mode) */}
        {isSheetView && (
            <div className={`absolute z-40 flex ${isVertical ? 'flex-col' : 'flex-row'} pointer-events-auto overflow-hidden`} style={sbStyle} onPointerDown={(e) => e.stopPropagation()}>
                {/* ... Title Block Content ... */}
                {template.logoPosition === 'top' && (
                    <div className={`${isVertical ? 'h-[15%] border-b w-full' : 'w-[10%] border-r h-full'} border-gray-300 flex items-center justify-center p-4`}>
                        {titleBlock.logoImage ? (
                            <img src={titleBlock.logoImage} className="max-w-full max-h-full object-contain" alt="Logo" />
                        ) : (
                            <span className="opacity-40 text-xl font-bold border-4 border-current p-2">LOGO</span>
                        )}
                    </div>
                )}
                
                {/* Revision History */}
                <div className={`${isVertical ? 'h-[25%] border-b w-full' : 'w-[25%] border-r h-full'} border-gray-300 flex flex-col`}>
                    <div className="text-white font-bold px-2 py-1 text-sm" style={{ backgroundColor: template.headerColor }}>REVISION HISTORY</div>
                    <div className="flex-1 p-2 overflow-y-auto">
                        <table className="w-full text-xs border-collapse">
                            <thead>
                                <tr className="border-b border-gray-400">
                                    <th className="text-left w-8 p-1">REV</th>
                                    <th className="text-left w-16 p-1">DATE</th>
                                    <th className="text-left p-1">DESCRIPTION</th>
                                </tr>
                            </thead>
                            <tbody>
                                {titleBlock.revisions.map(rev => (
                                    <tr key={rev.id} className="border-b border-gray-200">
                                        <td><input type="text" value={rev.rev} onChange={(e) => updateRevision(rev.id, 'rev', e.target.value)} className={inputStyle} /></td>
                                        <td><input type="text" value={rev.date} onChange={(e) => updateRevision(rev.id, 'date', e.target.value)} className={inputStyle} /></td>
                                        <td><input type="text" value={rev.description} onChange={(e) => updateRevision(rev.id, 'description', e.target.value)} className={inputStyle} /></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Project Info */}
                <div className={`flex-1 flex flex-col ${isVertical ? 'border-b w-full' : 'border-r h-full'} border-gray-300`}>
                     <div className="text-white font-bold px-2 py-1 text-sm" style={{ backgroundColor: template.headerColor }}>PROJECT INFORMATION</div>
                     <div className="p-4 space-y-4 overflow-y-auto">
                         {projectFields.map(field => (
                             <div key={field.id}>
                                 <div className="text-[10px] opacity-60 uppercase">{field.label}:</div>
                                 <input type="text" value={field.value} onChange={(e) => updateField(field.id, e.target.value)} className={`text-sm font-bold ${inputStyle}`} />
                             </div>
                         ))}
                     </div>
                </div>

                {/* Drawing/Sheet Info (Bottom) */}
                <div className={`flex flex-col flex-shrink-0 ${isVertical ? 'w-full' : 'w-[30%] h-full'}`} style={{ minHeight: isVertical ? '150px' : 'auto' }}>
                    {/* Drawing Fields Grid */}
                    <div className={`grid ${isVertical ? 'grid-cols-2 border-b' : 'grid-rows-2 border-r'} border-gray-300`}>
                        {drawingFields.map(field => (
                            <div key={field.id} className="p-2 border-gray-300 border-r last:border-r-0 border-b last:border-b-0">
                                <span className="block text-[9px] opacity-60 uppercase">{field.label}</span>
                                <input type="text" value={field.value} onChange={(e) => updateField(field.id, e.target.value)} className={`text-xs ${inputStyle}`} />
                            </div>
                        ))}
                    </div>
                    
                    {/* Sheet Number Area */}
                    <div className="flex-1 flex bg-white/50">
                        {template.logoPosition === 'bottom' && (
                             <div className="w-[80px] border-r border-gray-300 flex items-center justify-center p-1">
                                {titleBlock.logoImage ? <img src={titleBlock.logoImage} className="max-w-full max-h-full" /> : <div className="text-[9px]">LOGO</div>}
                             </div>
                        )}
                        <div className="flex-1 p-2 flex flex-col justify-center overflow-hidden">
                             {sheetFields.filter(f => f.label.includes('TITLE')).map(f => (
                                 <input key={f.id} type="text" value={f.value} onChange={(e) => updateField(f.id, e.target.value)} className={`font-bold text-xl leading-tight ${inputStyle}`} />
                             ))}
                        </div>
                        <div className="w-[100px] p-2 flex flex-col justify-center border-l border-gray-300 bg-white">
                             {sheetFields.filter(f => f.label.includes('NO')).map(f => (
                                 <div key={f.id}>
                                    <div className="text-[9px] text-gray-500">{f.label}</div>
                                    <input type="text" value={f.value} onChange={(e) => updateField(f.id, e.target.value)} className={`font-bold text-2xl text-black ${inputStyle}`} />
                                 </div>
                             ))}
                        </div>
                    </div>
                </div>
            </div>
        )}
        
        {/* --- SCENE WRAPPER --- */}
        <div 
            className="absolute inset-0 bg-white transition-transform duration-300 ease-in-out"
            style={{
                transform: `translate(${sceneTx}px, ${sceneTy}px) scale(${sceneScale})`,
                transformOrigin: '0 0',
                width: imgW,
                height: imgH,
                pointerEvents: isSheetView ? 'none' : 'auto' // Prevent scene interaction in sheet view
            }}
        >
            {images.background && (
                <img 
                    src={images.background}
                    alt="Background"
                    crossOrigin="anonymous"
                    className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none max-w-none"
                    style={{
                        opacity: state.isNightMode ? 0.82 : 1,
                        filter: state.isNightMode ? 'brightness(0.32) contrast(1.32) saturate(0.72) hue-rotate(8deg)' : 'none',
                        transition: 'filter 320ms ease, opacity 320ms ease',
                    }}
                />
            )}
            {isCropping && cropRect && (
                <svg
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 z-30 h-full w-full overflow-visible"
                    viewBox={`0 0 ${images.backgroundSize.width} ${images.backgroundSize.height}`}
                >
                    <defs>
                        <mask id="background-crop-mask">
                            <rect width={images.backgroundSize.width} height={images.backgroundSize.height} fill="white" />
                            <rect x={cropRect.x} y={cropRect.y} width={cropRect.w} height={cropRect.h} fill="black" />
                        </mask>
                    </defs>
                    <rect width={images.backgroundSize.width} height={images.backgroundSize.height} fill="rgba(2, 6, 23, 0.68)" mask="url(#background-crop-mask)" />
                    <rect x={cropRect.x} y={cropRect.y} width={cropRect.w} height={cropRect.h} fill="none" stroke="#38bdf8" strokeWidth={3 * handleScale} strokeDasharray={`${8 * handleScale} ${4 * handleScale}`} />
                    {[
                        { x: cropRect.x, y: cropRect.y },
                        { x: cropRect.x + cropRect.w, y: cropRect.y },
                        { x: cropRect.x + cropRect.w, y: cropRect.y + cropRect.h },
                        { x: cropRect.x, y: cropRect.y + cropRect.h },
                    ].map((point, index) => (
                        <circle key={index} cx={point.x} cy={point.y} r={10 * handleScale} fill="#f8fafc" stroke="#0ea5e9" strokeWidth={3 * handleScale} />
                    ))}
                </svg>
            )}
            {state.isNightMode && (
                <div
                    aria-hidden="true"
                    className="absolute inset-0 z-[5] pointer-events-none"
                    style={{
                        background: 'radial-gradient(ellipse at 50% 42%, rgba(15,35,58,0.02) 0%, rgba(2,8,23,0.26) 62%, rgba(0,3,12,0.62) 100%), linear-gradient(180deg, rgba(5,18,38,0.32) 0%, rgba(6,12,24,0.08) 48%, rgba(1,5,14,0.36) 100%)',
                        boxShadow: 'inset 0 0 140px rgba(0,0,12,0.75)',
                    }}
                />
            )}
            <canvas ref={canvasRef} className="absolute inset-0 z-10 w-full h-full pointer-events-none" style={{ opacity: isCropping ? 0.3 : 1, filter: state.isNightMode ? 'brightness(1.16) saturate(1.22) drop-shadow(0 0 9px rgba(125,211,252,0.32))' : 'none', transition: 'filter 320ms ease' }} />
            {!isCropping && (
            <>
                <svg className="absolute inset-0 z-20 w-full h-full overflow-visible pointer-events-none" viewBox={`0 0 ${images.backgroundSize.width} ${images.backgroundSize.height}`}>
                    {calibrationDraft && calibrationDraft.points.length > 0 && (() => {
                        const points = calibrationDraft.points;
                        const closed = calibrationDraft.method === 'plane' && points.length === 4;
                        const lerp = (a: Point, b: Point, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
                        const gridLines = closed ? [0.2, 0.4, 0.6, 0.8].flatMap(t => {
                            const horizontalStart = lerp(points[0], points[3], t);
                            const horizontalEnd = lerp(points[1], points[2], t);
                            const verticalStart = lerp(points[0], points[1], t);
                            const verticalEnd = lerp(points[3], points[2], t);
                            return [[horizontalStart, horizontalEnd], [verticalStart, verticalEnd]] as [Point, Point][];
                        }) : [];
                        return (
                            <g>
                                {closed ? (
                                    <>
                                        <polygon points={points.map(p => `${p.x},${p.y}`).join(' ')} fill="rgba(245,158,11,0.10)" stroke="#f59e0b" strokeWidth={3 * handleScale} />
                                        {gridLines.map(([start, end], index) => <line key={index} x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke="#fbbf24" strokeOpacity={0.55} strokeWidth={1.5 * handleScale} />)}
                                    </>
                                ) : points.length > 1 ? (
                                    <polyline points={points.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#f59e0b" strokeWidth={3 * handleScale} strokeDasharray={`${8 * handleScale} ${4 * handleScale}`} />
                                ) : null}
                                {points.map((point, index) => (
                                    <g key={index}>
                                        {calibrationDraft.editable && <circle data-calibration-handle={index} cx={point.x} cy={point.y} r={26 * handleScale} fill="transparent" pointerEvents="all" className="cursor-move" onPointerDown={beginCalibrationPointDrag(index)} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} />}
                                        <circle cx={point.x} cy={point.y} r={10 * handleScale} fill="#f59e0b" stroke="white" strokeWidth={2.5 * handleScale} pointerEvents="none" />
                                        <text x={point.x} y={point.y + 4.5 * handleScale} textAnchor="middle" fill="#111827" fontWeight={900} fontSize={12 * handleScale} pointerEvents="none">{index + 1}</text>
                                    </g>
                                ))}
                            </g>
                        );
                    })()}
                    {toolMode === 'select' && signs.map(sign => (
                        <polygon
                            key={`hit-${sign.id}`}
                            data-canvas-object
                            data-testid={`sign-hit-area-${sign.id}`}
                            points={sign.corners.map(point => `${point.x},${point.y}`).join(' ')}
                            fill="transparent"
                            pointerEvents="all"
                            onPointerDown={(event) => beginSignBodyDrag(sign, event)}
                        />
                    ))}
                    {state.showDimensions && dimensions.map(dim => {
                        const isActive = dim.id === activeDimensionId;
                        const dimColor = dim.color || '#ffffff';
                        const strokeWidth = (isActive ? 2 : 1.5) * handleScale;
                        if (dim.variant === 'box') {
                            const minX = Math.min(dim.start.x, dim.end.x);
                            const minY = Math.min(dim.start.y, dim.end.y);
                            const w = Math.abs(dim.end.x - dim.start.x);
                            const h = Math.abs(dim.end.y - dim.start.y);
                            return (
                                <g key={dim.id} data-canvas-object className="pointer-events-auto" style={{ cursor: 'move' }}>
                                    <rect x={minX} y={minY} width={w} height={h} fill={isActive ? "rgba(59, 130, 246, 0.2)" : "rgba(255, 255, 255, 0.1)"} stroke={dimColor} strokeWidth={strokeWidth} strokeDasharray="4 2" />
                                    {isActive && !isSheetView && toolMode === 'select' && (
                                        <>
                                            {[
                                                { x: minX, y: minY, index: 10, cursor: 'nw-resize' },
                                                { x: minX + w, y: minY, index: 12, cursor: 'ne-resize' },
                                                { x: minX + w, y: minY + h, index: 14, cursor: 'se-resize' },
                                                { x: minX, y: minY + h, index: 16, cursor: 'sw-resize' },
                                            ].map(handle => (
                                                <g key={handle.index}>
                                                    <circle data-testid={`dimension-handle-${dim.id}-${handle.index}`} data-dimension-handle={handle.index} aria-label="Resize dimension block" cx={handle.x} cy={handle.y} r={DIMENSION_HANDLE_HIT_RADIUS * handleScale} fill="transparent" pointerEvents="all" style={{ cursor: handle.cursor }} onPointerDown={handlePointerDown(handle.index, dim.id)} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} />
                                                    <circle cx={handle.x} cy={handle.y} r={9 * handleScale} fill="white" stroke={dimColor} strokeWidth={2.5 * handleScale} pointerEvents="none" />
                                                </g>
                                            ))}
                                            <rect x={minX + 10*handleScale} y={minY + 10*handleScale} width={Math.max(0, w - 20*handleScale)} height={Math.max(0, h - 20*handleScale)} fill="transparent" 
                                                  onPointerDown={handlePointerDown(2, dim.id)} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} className="cursor-move" />
                                        </>
                                    )}
                                </g>
                            );
                        } else {
                            const angle = Math.atan2(dim.end.y - dim.start.y, dim.end.x - dim.start.x);
                            // ... arrow drawing ...
                            const arrowLength = 12 * handleScale;
                            const arrowWidth = 4 * handleScale;
                            const drawArrow = (x: number, y: number, theta: number) => {
                                const backX = x - arrowLength * Math.cos(theta);
                                const backY = y - arrowLength * Math.sin(theta);
                                const perpX = Math.cos(theta + Math.PI/2);
                                const perpY = Math.sin(theta + Math.PI/2);
                                return `M ${x} ${y} L ${backX + arrowWidth * perpX} ${backY + arrowWidth * perpY} L ${backX - arrowWidth * perpX} ${backY - arrowWidth * perpY} Z`;
                            };

                            return (
                                <g key={dim.id} data-canvas-object className="pointer-events-auto" style={{ cursor: 'move' }}>
                                    <line x1={dim.start.x} y1={dim.start.y} x2={dim.end.x} y2={dim.end.y} stroke={dimColor} strokeWidth={strokeWidth} />
                                    <path d={drawArrow(dim.start.x, dim.start.y, angle + Math.PI)} fill={dimColor} />
                                    <path d={drawArrow(dim.end.x, dim.end.y, angle)} fill={dimColor} />

                                    {!isSheetView && toolMode === 'select' && (
                                        <>
                                            {[
                                                { point: dim.start, index: 0 },
                                                { point: dim.end, index: 1 },
                                            ].map(handle => (
                                                <g key={handle.index}>
                                                    <circle data-testid={`dimension-handle-${dim.id}-${handle.index}`} data-dimension-handle={handle.index} aria-label="Resize dimension endpoint" cx={handle.point.x} cy={handle.point.y} r={DIMENSION_HANDLE_HIT_RADIUS * handleScale} fill="transparent" pointerEvents="all" className="cursor-move" onPointerDown={handlePointerDown(handle.index, dim.id)} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} />
                                                    <circle cx={handle.point.x} cy={handle.point.y} r={9 * handleScale} fill="white" stroke={dimColor} strokeWidth={2.5 * handleScale} pointerEvents="none" />
                                                </g>
                                            ))}
                                        </>
                                    )}
                                </g>
                            );
                        }
                    })}
                    {isDrawing && drawingStart.current && drawingCurrent.current && (() => {
                        // Non-null: guarded by the render condition above (refs don't narrow into closures)
                        const dStart = drawingStart.current!;
                        const dCurr = drawingCurrent.current!;
                        const isCalibrating = toolMode === 'calibrate';
                        const previewColor = isCalibrating ? '#f59e0b' : '#3b82f6';
                        // Live measurement readout: px length while calibrating,
                        // real-world length when drawing with a calibration set
                        const label = isCalibrating
                            ? `${Math.round(distance(dStart, dCurr))}px`
                            : calibration
                                ? (toolMode === 'draw_box'
                                    ? measureBox(dStart, dCurr, calibration, state.unitSystem)
                                    : measureLine(dStart, dCurr, calibration, state.unitSystem))
                                : null;
                        return (
                        <g className="pointer-events-none">
                            {toolMode === 'draw_box' ? (
                                <rect x={Math.min(dStart.x, dCurr.x)} y={Math.min(dStart.y, dCurr.y)} width={Math.abs(dCurr.x - dStart.x)} height={Math.abs(dCurr.y - dStart.y)} fill="rgba(59, 130, 246, 0.2)" stroke="#3b82f6" strokeWidth={2 * handleScale} strokeDasharray="4 2" />
                            ) : (
                                <line x1={dStart.x} y1={dStart.y} x2={dCurr.x} y2={dCurr.y} stroke={previewColor} strokeWidth={2 * handleScale} />
                            )}
                            {label && (
                                <text
                                    x={(dStart.x + dCurr.x) / 2}
                                    y={(dStart.y + dCurr.y) / 2 - 10 * handleScale}
                                    textAnchor="middle"
                                    fill={previewColor}
                                    stroke="#000000"
                                    strokeWidth={3 * handleScale}
                                    style={{ paintOrder: 'stroke', fontWeight: 700 }}
                                    fontSize={13 * handleScale}
                                    fontFamily="monospace"
                                >{label}</text>
                            )}
                        </g>
                        );
                    })()}
                    {/* Stored calibration reference line (editor view only) */}
                    {calibration && showCalibrationReference && !isSheetView && (
                        <g className="pointer-events-none">
                            {calibration.plane && <polygon points={calibration.plane.corners.map(p => `${p.x},${p.y}`).join(' ')} fill="rgba(245,158,11,0.08)" stroke="#f59e0b" strokeWidth={1.5 * handleScale} strokeDasharray={`${6 * handleScale} ${3 * handleScale}`}/>}
                            <line x1={calibration.start.x} y1={calibration.start.y} x2={calibration.end.x} y2={calibration.end.y} stroke="#f59e0b" strokeWidth={1.5 * handleScale} strokeDasharray={`${6 * handleScale} ${3 * handleScale}`} />
                            <rect x={calibration.start.x - 3 * handleScale} y={calibration.start.y - 3 * handleScale} width={6 * handleScale} height={6 * handleScale} fill="#f59e0b" />
                            <rect x={calibration.end.x - 3 * handleScale} y={calibration.end.y - 3 * handleScale} width={6 * handleScale} height={6 * handleScale} fill="#f59e0b" />
                            <text
                                x={(calibration.start.x + calibration.end.x) / 2}
                                y={(calibration.start.y + calibration.end.y) / 2 - 8 * handleScale}
                                textAnchor="middle"
                                fill="#f59e0b"
                                stroke="#000000"
                                strokeWidth={3 * handleScale}
                                style={{ paintOrder: 'stroke', fontWeight: 700 }}
                                fontSize={11 * handleScale}
                                fontFamily="monospace"
                            >REF {calibration.realValue}{calibration.unit}</text>
                        </g>
                    )}
                    {activeSign && activeSignCenter && activeSignBounds && (
                        <>
                            <path d={`M ${activeSign.corners[0].x} ${activeSign.corners[0].y} L ${activeSign.corners[1].x} ${activeSign.corners[1].y} L ${activeSign.corners[2].x} ${activeSign.corners[2].y} L ${activeSign.corners[3].x} ${activeSign.corners[3].y} Z`} fill="none" stroke="#3b82f6" strokeWidth={1 * handleScale} strokeDasharray={`${4*handleScale} ${2*handleScale}`} opacity="0.6" />
                            <line x1={activeSignBounds.maxX} y1={activeSignCenter.y} x2={activeSignBounds.maxX + SCALE_HANDLE_GAP * handleScale} y2={activeSignCenter.y} stroke="#3b82f6" strokeWidth={1 * handleScale} opacity="0.8" />
                            <line x1={activeSignCenter.x} y1={activeSignBounds.maxY} x2={activeSignCenter.x} y2={activeSignBounds.maxY + SCALE_HANDLE_GAP * handleScale} stroke="#3b82f6" strokeWidth={1 * handleScale} opacity="0.8" />
                        </>
                    )}
                </svg>
                <div className="absolute inset-0 z-30 w-full h-full pointer-events-none">
                    {state.showDimensions && dimensions.map(dim => {
                        const mx = (dim.start.x + dim.end.x) / 2;
                        const my = (dim.start.y + dim.end.y) / 2;
                        const dimColor = dim.color || '#ffffff';
                        const dx = dim.end.x - dim.start.x;
                        const dy = dim.end.y - dim.start.y;
                        const isVertical = Math.abs(dy) > Math.abs(dx);
                        const rotation = dim.variant === 'linear' && isVertical ? -90 : 0;
                        return (
                            <div key={`text-${dim.id}`} style={{ position: 'absolute', left: mx, top: my, width: '0px', height: '0px', zIndex: 45, pointerEvents: 'none' }}>
                                <input data-testid={`dimension-label-${dim.id}`} type="text" value={dim.text} onChange={(e) => updateDimension(dim.id, { text: e.target.value })} onPointerDown={(e) => e.stopPropagation()} className="bg-black text-white text-xs px-2 py-1 rounded border focus:border-blue-500 outline-none text-center shadow-sm font-mono absolute pointer-events-auto" style={{ width: `${Math.max(4, dim.text.length + 2)}ch`, borderColor: dimColor, transform: `translate(-50%, -50%) rotate(${rotation}deg) scale(${dimensionLabelScale})`, transformOrigin: 'center center' }} />
                            </div>
                        );
                    })}
                    {activeSign && activeSignCenter && activeSignBounds && !isSheetView && toolMode === 'select' && (
                        <>
                        {activeSign.corners.map((p, i) => {
                        const isActive = activeHandle === i;
                        return (
                        <div key={i} data-canvas-object data-testid={`sign-corner-handle-${i}`} role="button" aria-label={`Move sign corner ${i + 1}`} title={`Drag corner ${i + 1} to match the building perspective`} className="absolute cursor-move pointer-events-auto flex items-center justify-center" style={{ left: p.x, top: p.y, width: SIGN_CORNER_HIT_SIZE, height: SIGN_CORNER_HIT_SIZE, transform: `translate(-50%, -50%) scale(${handleScale})`, zIndex: isActive ? 50 : 30, touchAction: 'none' }}
                                 onPointerDown={handlePointerDown(i)} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} 
                                 onPointerEnter={() => setHoveredHandle(i)} onPointerLeave={() => setHoveredHandle(null)}>
                            <div aria-hidden="true" className={`rounded-full border-2 transition-transform duration-100 ${isActive ? 'bg-blue-100 border-blue-600 shadow-[0_0_15px_rgba(59,130,246,1)] scale-125' : 'bg-white border-blue-500 shadow-md'}`} style={{ width: SIGN_CORNER_VISUAL_SIZE, height: SIGN_CORNER_VISUAL_SIZE }} />
                        </div>
                        );
                        })}
                        <div data-canvas-object data-testid="sign-move-handle" role="button" aria-label="Move sign" title="Drag to move the whole sign" className="absolute flex items-center justify-center cursor-move pointer-events-auto" style={{ left: activeSignCenter.x, top: activeSignCenter.y, width: SIGN_MOVE_HIT_SIZE, height: SIGN_MOVE_HIT_SIZE, transform: `translate(-50%, -50%) scale(${handleScale})`, zIndex: activeHandle === 4 ? 40 : 25, touchAction: 'none' }}
                             onPointerDown={handlePointerDown(4)} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} 
                             onPointerEnter={() => setHoveredHandle(4)} onPointerLeave={() => setHoveredHandle(null)}>
                            <div aria-hidden="true" className={`rounded-full border-2 backdrop-blur-sm flex items-center justify-center transition-transform duration-100 ${activeHandle === 4 ? 'bg-white/50 border-white shadow-[0_0_20px_rgba(255,255,255,0.8)] scale-110' : 'bg-white/20 border-white/60 shadow-lg'}`} style={{ width: SIGN_MOVE_VISUAL_SIZE, height: SIGN_MOVE_VISUAL_SIZE }}>
                                <div className={`w-1.5 h-1.5 rounded-full ${activeHandle === 4 ? 'bg-blue-400' : 'bg-white'}`} />
                            </div>
                        </div>
                        <div data-canvas-object data-testid="sign-scale-x-handle" role="button" aria-label="Scale sign horizontally" title="Drag to change the sign width" className="absolute flex items-center justify-center cursor-ew-resize pointer-events-auto" style={{ left: activeSignBounds.maxX + SCALE_HANDLE_GAP * handleScale, top: activeSignCenter.y, width: SIGN_CORNER_HIT_SIZE, height: SIGN_CORNER_HIT_SIZE, transform: `translate(-50%, -50%) scale(${handleScale})`, zIndex: activeHandle === 5 ? 50 : 40, touchAction: 'none' }}
                             onPointerDown={handlePointerDown(5)} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} 
                             onPointerEnter={() => setHoveredHandle(5)} onPointerLeave={() => setHoveredHandle(null)}>
                            <div aria-hidden="true" className={`rounded-sm border-2 transition-transform duration-100 ${activeHandle === 5 ? 'bg-blue-100 border-blue-600 shadow-[0_0_15px_rgba(59,130,246,1)] scale-125' : 'bg-white border-blue-500 shadow-md'}`} style={{ width: SIGN_CORNER_VISUAL_SIZE, height: SIGN_CORNER_VISUAL_SIZE }} />
                        </div>
                        <div data-canvas-object data-testid="sign-scale-y-handle" role="button" aria-label="Scale sign vertically" title="Drag to change the sign height" className="absolute flex items-center justify-center cursor-ns-resize pointer-events-auto" style={{ left: activeSignCenter.x, top: activeSignBounds.maxY + SCALE_HANDLE_GAP * handleScale, width: SIGN_CORNER_HIT_SIZE, height: SIGN_CORNER_HIT_SIZE, transform: `translate(-50%, -50%) scale(${handleScale})`, zIndex: activeHandle === 6 ? 50 : 40, touchAction: 'none' }}
                             onPointerDown={handlePointerDown(6)} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}
                             onPointerEnter={() => setHoveredHandle(6)} onPointerLeave={() => setHoveredHandle(null)}>
                            <div aria-hidden="true" className={`rounded-sm border-2 transition-transform duration-100 ${activeHandle === 6 ? 'bg-blue-100 border-blue-600 shadow-[0_0_15px_rgba(59,130,246,1)] scale-125' : 'bg-white border-blue-500 shadow-md'}`} style={{ width: SIGN_CORNER_VISUAL_SIZE, height: SIGN_CORNER_VISUAL_SIZE }} />
                        </div>
                        </>
                    )}
                </div>
            </>
            )}
        </div>
      </div>
    </div>
  );
};

export default MockupCanvas;
