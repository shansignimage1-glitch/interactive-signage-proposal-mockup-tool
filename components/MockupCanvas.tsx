
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { AppImages, MockupState, Point, Sign, Dimension, TitleBlock, Revision, PaperSize, Orientation } from '../types';
import { hexToRgb, isPointInPolygon, distance } from '../utils/math';
import { ZoomIn, ZoomOut, Maximize, Check, X } from 'lucide-react';
import { ToolMode } from '../App';
import { TITLE_BLOCK_TEMPLATES } from '../data/titleBlockTemplates';

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
  onDrawComplete: (start: Point, end: Point, variant: 'linear' | 'box') => void;
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

const SCALE_HANDLE_OFFSET = 30; 

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
    onDrawComplete,
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
  const glRef = useRef<WebGLRenderingContext | null>(null);
  const programRef = useRef<WebGLProgram | null>(null);
  
  // --- Viewport State (Zoom/Pan) ---
  const [view, setView] = useState({ scale: 0.9, x: 0, y: 0 });
  const [baseScale, setBaseScale] = useState(1);

  // Crop State
  const [cropRect, setCropRect] = useState<{ x: number, y: number, w: number, h: number } | null>(null);
  const [cropDragMode, setCropDragMode] = useState<'move' | 'nw' | 'ne' | 'sw' | 'se' | null>(null);
  
  // Drawing State (Dimensions)
  const [isDrawing, setIsDrawing] = useState(false);
  const [tick, setTick] = useState(0); 
  const drawingStart = useRef<Point | null>(null);
  const drawingCurrent = useRef<Point | null>(null);

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

  const [activeHandle, setActiveHandle] = useState<number | null>(null); 
  const [hoveredHandle, setHoveredHandle] = useState<number | null>(null);

  const startMousePos = useRef<Point>({ x: 0, y: 0 });
  const startCornersRef = useRef<[Point, Point, Point, Point] | null>(null);
  const startDimRef = useRef<{ start: Point, end: Point } | null>(null);
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

  // Escape to Cancel Drawing
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && isDrawing) {
            setIsDrawing(false);
            drawingStart.current = null;
            drawingCurrent.current = null;
        }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isDrawing]);

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
    
    // Reset view position and zoom
    setView(v => ({ scale: 1, x: 0, y: 0 }));

    if (titleBlock.viewMode === 'canvas') {
        setCropRect({ x: 0, y: 0, w: contentW, h: contentH });
    }
  }, [getContainerSize, titleBlock.viewMode]);

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
    }
  }, [isCropping, images.backgroundSize]);

  useEffect(() => {
     setIsDrawing(false);
     drawingStart.current = null;
     drawingCurrent.current = null;
  }, [toolMode]);

  const getMousePos = (e: MouseEvent | React.MouseEvent | React.PointerEvent) => {
    if (!containerRef.current) return { x: 0, y: 0 };
    
    const containerSize = getContainerSize();
    const rect = containerRef.current.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    const cx = rect.width / 2;
    const cy = rect.height / 2;
    
    const totalScale = baseScale * view.scale;
    const offsetX = view.x;
    const offsetY = view.y;
    
    // World coordinates relative to the center of the container object (Image or Paper)
    const worldX = (screenX - cx - offsetX) / totalScale + containerSize.width / 2;
    const worldY = (screenY - cy - offsetY) / totalScale + containerSize.height / 2;

    return { x: worldX, y: worldY };
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (isCropping) return; 
    e.preventDefault();
    const zoomIntensity = 0.001;
    const newScale = Math.min(Math.max(0.1, view.scale - e.deltaY * zoomIntensity), 10);
    setView(v => ({ ...v, scale: newScale }));
  };

  const handleContainerPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || e.buttons === 4 || e.shiftKey) {
        e.preventDefault();
        containerRef.current?.setPointerCapture(e.pointerId);
        lastPanPos.current = { x: e.clientX, y: e.clientY };
        setActiveHandle(-99); 
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
    if (activeHandle === -99) {
        const dx = e.clientX - lastPanPos.current.x;
        const dy = e.clientY - lastPanPos.current.y;
        lastPanPos.current = { x: e.clientX, y: e.clientY };
        setView(v => ({ ...v, x: v.x + dx, y: v.y + dy }));
        return;
    }
    if (isCropping && activeHandle === -10 && cropRect) {
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
      setActiveHandle(null);
      containerRef.current?.releasePointerCapture(e.pointerId);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setCanvasRef(canvas);

    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, alpha: true });
    if (!gl) return;
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
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return null;
      return shader;
    };

    const vs = createShader(gl.VERTEX_SHADER, vsSource);
    const fs = createShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return;

    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;

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
  }, [setCanvasRef]);

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
           if ((img.width & (img.width - 1)) === 0 && (img.height & (img.height - 1)) === 0) {
              gl.generateMipmap(gl.TEXTURE_2D);
           } else {
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
           }
           setTexturesLoaded(n => n + 1);
        };
      }
    });
  }, [signs]);

  const render = useCallback(() => {
    const gl = glRef.current;
    const program = programRef.current;
    const canvas = canvasRef.current;
    if (!gl || !program || !canvas) return;

    if (canvas.width !== images.backgroundSize.width || canvas.height !== images.backgroundSize.height) {
        canvas.width = images.backgroundSize.width;
        canvas.height = images.backgroundSize.height;
    }
    
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(program);

    const uniforms = uniformsRef.current;
    const posBuffer = posBufferRef.current;
    const texBuffer = texBufferRef.current;
    if (!uniforms || !posBuffer || !texBuffer) return;

    gl.uniform2f(uniforms.resolution, gl.canvas.width, gl.canvas.height);

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
    });

  }, [signs, texturesLoaded, images.backgroundSize]);

  useEffect(() => { requestAnimationFrame(render); }, [render]);

  const handlePointerDown = (index: number) => (e: React.PointerEvent) => {
    if (isCropping || toolMode !== 'select') return;
    if (titleBlock.viewMode === 'sheet') return; // Disable interaction in sheet view
    if (e.button !== 0) return; // Only allow left click for manipulation

    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    
    // We update startMousePos just in case, but getMousePos depends on view/scale not event target
    startMousePos.current = getMousePos(e);

    if (activeSignId) {
        const activeSign = signs.find(s => s.id === activeSignId);
        if (activeSign) startCornersRef.current = [...activeSign.corners];
    } else if (activeDimensionId) {
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
        }
    }
    setActiveHandle(index);
    setHoveredHandle(null);
  };

  const handleCanvasPointerDown = (e: React.PointerEvent) => {
      if (isCropping) return;
      if (titleBlock.viewMode === 'sheet') return; // Disable interaction in sheet view

      if (e.button === 2) { if (isDrawing) { setIsDrawing(false); drawingStart.current = null; drawingCurrent.current = null; return; } }
      const pos = getMousePos(e);
      if (toolMode === 'draw_line') { e.preventDefault(); e.stopPropagation(); if (!isDrawing) { e.currentTarget.setPointerCapture(e.pointerId); setIsDrawing(true); drawingStart.current = pos; drawingCurrent.current = pos; setActiveSign(null); setActiveDimension(''); } else { if (drawingStart.current) { onDrawComplete(drawingStart.current, pos, 'linear'); } setIsDrawing(false); drawingStart.current = null; drawingCurrent.current = null; } return; }
      if (toolMode === 'draw_box') { e.preventDefault(); e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setIsDrawing(true); drawingStart.current = pos; drawingCurrent.current = pos; setActiveSign(null); setActiveDimension(''); return; }
      
      let hitFound = false;
      if (state.showDimensions) { for (const dim of dimensions) { let isHit = false; if (dim.variant === 'box') { const x = Math.min(dim.start.x, dim.end.x); const y = Math.min(dim.start.y, dim.end.y); const w = Math.abs(dim.end.x - dim.start.x); const h = Math.abs(dim.end.y - dim.start.y); if (pos.x >= x && pos.x <= x + w && pos.y >= y && pos.y <= y + h) isHit = true; } else { const xMin = Math.min(dim.start.x, dim.end.x) - 10; const xMax = Math.max(dim.start.x, dim.end.x) + 10; const yMin = Math.min(dim.start.y, dim.end.y) - 10; const yMax = Math.max(dim.start.y, dim.end.y) + 10; if (pos.x >= xMin && pos.x <= xMax && pos.y >= yMin && pos.y <= yMax) isHit = true; } if (isHit) { setActiveDimension(dim.id); if (dim.id === activeDimensionId) { e.currentTarget.setPointerCapture(e.pointerId); startMousePos.current = pos; startDimRef.current = { start: { ...dim.start }, end: { ...dim.end } }; setActiveHandle(2); } hitFound = true; return; } } }
      if (!hitFound) { for (let i = signs.length - 1; i >= 0; i--) { const sign = signs[i]; if (isPointInPolygon(pos, sign.corners)) { setActiveSign(sign.id); if (sign.id === activeSignId) { e.currentTarget.setPointerCapture(e.pointerId); startMousePos.current = pos; startCornersRef.current = [...sign.corners]; setActiveHandle(4); } return; } } }
      if (!hitFound) { setActiveSign(null); setActiveDimension(''); }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isCropping) return;
    
    // If we are dragging a handle, handle it here and stop propagation
    if (activeHandle !== null) {
        e.preventDefault();
        e.stopPropagation();
        
        const pos = getMousePos(e);
        const dx = pos.x - startMousePos.current.x;
        const dy = pos.y - startMousePos.current.y;
        
        if (activeSignId && startCornersRef.current) {
            const activeSign = signs.find(s => s.id === activeSignId);
            if (!activeSign) return;
            const startCorners = startCornersRef.current;
            if (activeHandle < 4) { 
                const newCorners = [...activeSign.corners] as [Point, Point, Point, Point]; 
                newCorners[activeHandle] = pos; 
                updateSignById(activeSignId, { corners: newCorners }); 
            } 
            else if (activeHandle === 4) { 
                const movedCorners = startCorners.map(p => ({ x: p.x + dx, y: p.y + dy })) as [Point, Point, Point, Point]; 
                updateSignById(activeSignId, { corners: movedCorners }); 
            } 
            else if (activeHandle === 5) { 
                const center = { x: (startCorners[0].x + startCorners[2].x) / 2, y: (startCorners[0].y + startCorners[2].y) / 2 }; 
                const distStart = distance(center, startMousePos.current); 
                const distCurr = distance(center, pos); 
                if (distStart < 1) return; 
                const scale = distCurr / distStart; 
                const newCorners = startCorners.map(p => ({ x: center.x + (p.x - center.x) * scale, y: center.y + (p.y - center.y) * scale })) as [Point, Point, Point, Point]; 
                updateSignById(activeSignId, { corners: newCorners }); 
            }
        } else if (activeDimensionId && startDimRef.current) {
            const activeDim = dimensions.find(d => d.id === activeDimensionId);
            if (!activeDim) return;
            const start = startDimRef.current.start;
            const end = startDimRef.current.end;
            if (activeHandle === 0) { updateDimension(activeDimensionId, { start: { x: start.x + dx, y: start.y + dy } }); } 
            else if (activeHandle === 1) { updateDimension(activeDimensionId, { end: { x: end.x + dx, y: end.y + dy } }); } 
            else if (activeHandle === 2) { updateDimension(activeDimensionId, { start: { x: start.x + dx, y: start.y + dy }, end: { x: end.x + dx, y: end.y + dy } }); } 
            else if (activeHandle >= 10) { const targets = boxDragTargetsRef.current; const newStart = { ...start }; const newEnd = { ...end }; if (targets.x === 'start') newStart.x += dx; else if (targets.x === 'end') newEnd.x += dx; if (targets.y === 'start') newStart.y += dy; else if (targets.y === 'end') newEnd.y += dy; updateDimension(activeDimensionId, { start: newStart, end: newEnd }); }
        }
        return;
    }

    const pos = getMousePos(e);
    if (isDrawing && drawingStart.current) { drawingCurrent.current = pos; setTick(t => t + 1); return; }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (isDrawing) {
        const dStart = drawingStart.current;
        const dCurr = drawingCurrent.current;
        if (dStart && dCurr) {
            if (toolMode === 'draw_box') { onDrawComplete(dStart, dCurr, 'box'); setIsDrawing(false); drawingStart.current = null; drawingCurrent.current = null; } 
            else if (toolMode === 'draw_line') { const worldDist = distance(dStart, dCurr); const screenDist = worldDist * (baseScale * view.scale); if (screenDist > 10) { onDrawComplete(dStart, dCurr, 'linear'); setIsDrawing(false); drawingStart.current = null; drawingCurrent.current = null; } }
        }
    }
    
    // Capture release and cleanup
    if (e.currentTarget.hasPointerCapture(e.pointerId)) { 
        e.currentTarget.releasePointerCapture(e.pointerId); 
    }
    
    // Only stop propagation if we were dragging a handle
    if (activeHandle !== null) {
        e.stopPropagation();
    }
    
    setActiveHandle(null); startCornersRef.current = null; startDimRef.current = null;
  };

  const confirmCrop = () => {
    if (!cropRect) return;
    const tempCanvas = document.createElement('canvas');
    const ctx = tempCanvas.getContext('2d');
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
        tempCanvas.width = cropRect.w;
        tempCanvas.height = cropRect.h;
        ctx?.drawImage(img, cropRect.x, cropRect.y, cropRect.w, cropRect.h, 0, 0, cropRect.w, cropRect.h);
        const newUrl = tempCanvas.toDataURL();
        onCropConfirm(newUrl, { x: cropRect.x, y: cropRect.y }, { width: cropRect.w, height: cropRect.h });
    };
    img.src = images.background;
  };

  const activeSign = signs.find(s => s.id === activeSignId);
  const activeSignCenter = activeSign ? { x: (activeSign.corners[0].x + activeSign.corners[1].x + activeSign.corners[2].x + activeSign.corners[3].x) / 4, y: (activeSign.corners[0].y + activeSign.corners[1].y + activeSign.corners[2].y + activeSign.corners[3].y) / 4 } : null;
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

  // Filter fields by section
  const projectFields = titleBlock.fields.filter(f => f.section === 'project');
  const drawingFields = titleBlock.fields.filter(f => f.section === 'drawing');
  const sheetFields = titleBlock.fields.filter(f => f.section === 'sheet');

  return (
    <div 
      ref={containerRef} 
      className="w-full h-full flex items-center justify-center overflow-hidden relative select-none"
      onWheel={handleWheel}
      onPointerDown={handleContainerPointerDown}
      onPointerMove={handleContainerPointerMove}
      onPointerUp={handleContainerPointerUp}
      onPointerLeave={handleContainerPointerUp}
      onContextMenu={(e) => e.preventDefault()}
      style={{ touchAction: 'none', cursor: (toolMode === 'draw_line' || toolMode === 'draw_box') ? 'crosshair' : 'default', backgroundColor: isSheetView ? '#333' : '#0a0a0a' }} 
    >
      {/* Zoom Controls ... (kept from previous) */}
      <div className="absolute top-4 right-4 flex flex-col gap-2 z-50">
        <button onClick={() => setView(v => ({ ...v, scale: v.scale * 1.2 }))} className="p-2 bg-gray-800 hover:bg-gray-700 text-white rounded shadow border border-gray-600"><ZoomIn className="w-5 h-5" /></button>
        <button onClick={() => setView(v => ({ ...v, scale: v.scale / 1.2 }))} className="p-2 bg-gray-800 hover:bg-gray-700 text-white rounded shadow border border-gray-600"><ZoomOut className="w-5 h-5" /></button>
        <button onClick={() => setView({ scale: 1, x: 0, y: 0 })} className="p-2 bg-gray-800 hover:bg-gray-700 text-white rounded shadow border border-gray-600"><Maximize className="w-5 h-5" /></button>
      </div>

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
        className={`relative shadow-2xl origin-center transition-transform duration-75 ease-out`}
        onPointerDown={!isCropping ? handleCanvasPointerDown : undefined} 
        onPointerMove={!isCropping ? handlePointerMove : undefined}
        onPointerUp={!isCropping ? handlePointerUp : undefined}
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
            className="absolute inset-0 transition-transform duration-300 ease-in-out"
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
                        opacity: state.isNightMode ? 0.5 : 1,
                        filter: state.isNightMode ? 'brightness(0.6) contrast(1.2) hue-rotate(-10deg)' : 'none',
                    }}
                />
            )}
            <canvas ref={canvasRef} width={images.backgroundSize.width} height={images.backgroundSize.height} className="absolute inset-0 z-10 w-full h-full pointer-events-none" style={{ opacity: isCropping ? 0.3 : 1 }} />
            {!isCropping && (
            <>
                <svg className="absolute inset-0 z-20 w-full h-full overflow-visible pointer-events-none" viewBox={`0 0 ${images.backgroundSize.width} ${images.backgroundSize.height}`}>
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
                                <g key={dim.id} className="pointer-events-auto" style={{ cursor: 'move' }}>
                                    <rect x={minX} y={minY} width={w} height={h} fill={isActive ? "rgba(59, 130, 246, 0.2)" : "rgba(255, 255, 255, 0.1)"} stroke={dimColor} strokeWidth={strokeWidth} strokeDasharray="4 2" />
                                    {isActive && !isSheetView && toolMode === 'select' && (
                                        <>
                                            <circle cx={minX} cy={minY} r={6 * handleScale} fill="white" stroke={dimColor} strokeWidth={2*handleScale} cursor="nw-resize" 
                                                    onPointerDown={handlePointerDown(10)} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} />
                                            <circle cx={minX+w} cy={minY+h} r={6 * handleScale} fill="white" stroke={dimColor} strokeWidth={2*handleScale} cursor="se-resize" 
                                                    onPointerDown={handlePointerDown(14)} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} />
                                            <rect x={minX + 10*handleScale} y={minY + 10*handleScale} width={Math.max(0, w - 20*handleScale)} height={Math.max(0, h - 20*handleScale)} fill="transparent" 
                                                  onPointerDown={handlePointerDown(2)} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} className="cursor-move" />
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
                                <g key={dim.id} className="pointer-events-auto" style={{ cursor: 'move' }}>
                                    <line x1={dim.start.x} y1={dim.start.y} x2={dim.end.x} y2={dim.end.y} stroke={dimColor} strokeWidth={strokeWidth} />
                                    <path d={drawArrow(dim.start.x, dim.start.y, angle + Math.PI)} fill={dimColor} />
                                    <path d={drawArrow(dim.end.x, dim.end.y, angle)} fill={dimColor} />

                                    {!isSheetView && toolMode === 'select' && (
                                        <>
                                            <circle cx={dim.start.x} cy={dim.start.y} r={6 * handleScale} fill="white" stroke={dimColor} strokeWidth={2 * handleScale} className="cursor-move" 
                                                    onPointerDown={handlePointerDown(0)} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} />
                                            <circle cx={dim.end.x} cy={dim.end.y} r={6 * handleScale} fill="white" stroke={dimColor} strokeWidth={2 * handleScale} className="cursor-move" 
                                                    onPointerDown={handlePointerDown(1)} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} />
                                        </>
                                    )}
                                </g>
                            );
                        }
                    })}
                    {isDrawing && drawingStart.current && drawingCurrent.current && (
                        <g className="pointer-events-none">
                            {toolMode === 'draw_box' ? (
                                <rect x={Math.min(drawingStart.current.x, drawingCurrent.current.x)} y={Math.min(drawingStart.current.y, drawingCurrent.current.y)} width={Math.abs(drawingCurrent.current.x - drawingStart.current.x)} height={Math.abs(drawingCurrent.current.y - drawingStart.current.y)} fill="rgba(59, 130, 246, 0.2)" stroke="#3b82f6" strokeWidth={2 * handleScale} strokeDasharray="4 2" />
                            ) : (
                                <line x1={drawingStart.current.x} y1={drawingStart.current.y} x2={drawingCurrent.current.x} y2={drawingCurrent.current.y} stroke="#3b82f6" strokeWidth={2 * handleScale} />
                            )}
                        </g>
                    )}
                    {activeSign && activeSignCenter && (
                        <>
                            <path d={`M ${activeSign.corners[0].x} ${activeSign.corners[0].y} L ${activeSign.corners[1].x} ${activeSign.corners[1].y} L ${activeSign.corners[2].x} ${activeSign.corners[2].y} L ${activeSign.corners[3].x} ${activeSign.corners[3].y} Z`} fill="none" stroke="#3b82f6" strokeWidth={1 * handleScale} strokeDasharray={`${4*handleScale} ${2*handleScale}`} opacity="0.6" />
                            <line x1={activeSignCenter.x} y1={activeSignCenter.y} x2={activeSignCenter.x + SCALE_HANDLE_OFFSET * handleScale} y2={activeSignCenter.y} stroke="#3b82f6" strokeWidth={1 * handleScale} opacity="0.8" />
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
                                <input type="text" value={dim.text} onChange={(e) => updateDimension(dim.id, { text: e.target.value })} onPointerDown={(e) => e.stopPropagation()} className="bg-black text-white text-xs px-2 py-1 rounded border focus:border-blue-500 outline-none text-center shadow-sm font-mono absolute pointer-events-auto" style={{ width: `${Math.max(4, dim.text.length + 2)}ch`, borderColor: dimColor, transform: `translate(-50%, -50%) rotate(${rotation}deg) scale(${handleScale})`, transformOrigin: 'center center' }} />
                            </div>
                        );
                    })}
                    {activeSign && activeSignCenter && !isSheetView && toolMode === 'select' && (
                        <>
                        {activeSign.corners.map((p, i) => {
                        const isActive = activeHandle === i;
                        return (
                            <div key={i} className={`absolute rounded-full border-2 transition-all duration-150 cursor-move pointer-events-auto flex items-center justify-center ${isActive ? 'bg-blue-100 border-blue-600 shadow-[0_0_15px_rgba(59,130,246,1)]' : 'bg-white border-blue-500 hover:bg-blue-50 shadow-md'}`} style={{ left: p.x, top: p.y, width: '16px', height: '16px', transform: `translate(-50%, -50%) scale(${isActive ? 1.25 * handleScale : handleScale})`, zIndex: isActive ? 50 : 30, touchAction: 'none' }} 
                                 onPointerDown={handlePointerDown(i)} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} 
                                 onPointerEnter={() => setHoveredHandle(i)} onPointerLeave={() => setHoveredHandle(null)} />
                        );
                        })}
                        <div className={`absolute rounded-full border-2 flex items-center justify-center cursor-move transition-all duration-150 backdrop-blur-sm pointer-events-auto ${activeHandle === 4 ? 'bg-white/40 border-white shadow-[0_0_20px_rgba(255,255,255,0.8)]' : 'bg-white/20 border-white/50 hover:bg-white/30 shadow-lg'}`} style={{ left: activeSignCenter.x, top: activeSignCenter.y, width: '32px', height: '32px', transform: `translate(-50%, -50%) scale(${activeHandle === 4 ? 1.1 * handleScale : handleScale})`, zIndex: activeHandle === 4 ? 40 : 25, touchAction: 'none' }} 
                             onPointerDown={handlePointerDown(4)} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} 
                             onPointerEnter={() => setHoveredHandle(4)} onPointerLeave={() => setHoveredHandle(null)}><div className={`w-1 h-1 rounded-full transition-colors ${activeHandle === 4 ? 'bg-blue-400' : 'bg-white'}`} style={{ transform: `scale(${totalScale})`}} /></div>
                        <div className={`absolute rounded-sm border-2 flex items-center justify-center cursor-ew-resize transition-all duration-150 pointer-events-auto ${activeHandle === 5 ? 'bg-blue-100 border-blue-600 shadow-[0_0_15px_rgba(59,130,246,1)]' : 'bg-white border-blue-500 hover:bg-blue-50 shadow-md'}`} style={{ left: activeSignCenter.x + SCALE_HANDLE_OFFSET * handleScale, top: activeSignCenter.y, width: '16px', height: '16px', transform: `translate(-50%, -50%) scale(${activeHandle === 5 ? 1.25 * handleScale : handleScale})`, zIndex: activeHandle === 5 ? 40 : 25, touchAction: 'none' }} 
                             onPointerDown={handlePointerDown(5)} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} 
                             onPointerEnter={() => setHoveredHandle(5)} onPointerLeave={() => setHoveredHandle(null)} />
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
