
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, Upload, X, Check, RotateCcw, ZoomIn, ZoomOut, Move } from 'lucide-react';

interface ImageUploaderProps {
  isOpen: boolean;
  onClose: () => void;
  onImageReady: (dataUrl: string) => void;
}

type Step = 'select' | 'camera' | 'crop';

interface Rect { x: number; y: number; w: number; h: number; }
interface Point { x: number; y: number; }

const HANDLE_RADIUS = 8;
const HIT_RADIUS = 50; // Increased to 50px for better tablet touch sensitivity

const ImageUploader: React.FC<ImageUploaderProps> = ({ isOpen, onClose, onImageReady }) => {
  const [step, setStep] = useState<Step>('select');
  const [sourceImage, setSourceImage] = useState<string | null>(null);
  const [videoStream, setVideoStream] = useState<MediaStream | null>(null);
  
  // Camera Refs
  const videoRef = useRef<HTMLVideoElement>(null);

  // Crop State
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  
  // Crop Geometry (in Image Pixel Coordinates)
  const [cropRect, setCropRect] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 });
  
  // Viewport State
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  
  // Interaction State
  const [isDragging, setIsDragging] = useState(false);
  const [dragMode, setDragMode] = useState<'create' | 'move' | 'resize' | 'pan'>('create');
  const [activeHandle, setActiveHandle] = useState<string | null>(null);
  const lastMousePos = useRef<Point>({ x: 0, y: 0 });

  useEffect(() => {
    if (!isOpen) {
      stopCamera();
      setStep('select');
      setSourceImage(null);
      setCropRect({ x: 0, y: 0, w: 0, h: 0 });
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
  }, [isOpen]);

  const stopCamera = () => {
    if (videoStream) {
      videoStream.getTracks().forEach(track => track.stop());
      setVideoStream(null);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      const reader = new FileReader();
      reader.onload = (evt) => {
        if (typeof evt.target?.result === 'string') {
          setSourceImage(evt.target.result);
          setStep('crop');
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      setVideoStream(stream);
      setStep('camera');
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      }, 100);
    } catch (err) {
      console.error("Camera access denied", err);
      alert("Could not access camera. Please allow permissions.");
    }
  };

  const capturePhoto = () => {
    if (videoRef.current) {
      const vid = videoRef.current;
      const canvas = document.createElement('canvas');
      canvas.width = vid.videoWidth;
      canvas.height = vid.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(vid, 0, 0);
        setSourceImage(canvas.toDataURL('image/jpeg'));
        stopCamera();
        setStep('crop');
      }
    }
  };

  // --- Cropping & Rendering Logic ---

  // Helper: World (Image) -> Screen (Canvas) coords
  const toScreen = useCallback((x: number, y: number, canvasW: number, canvasH: number, imgW: number, imgH: number) => {
    // Center of canvas
    const cx = canvasW / 2;
    const cy = canvasH / 2;
    
    // Image is drawn centered at (0,0) then translated by pan and scaled by zoom
    // ScreenX = cx + pan.x + (worldX - imgW/2) * zoom
    return {
        x: cx + pan.x + (x - imgW / 2) * zoom,
        y: cy + pan.y + (y - imgH / 2) * zoom
    };
  }, [pan, zoom]);

  // Initialize Canvas & Image
  useEffect(() => {
    if (step === 'crop' && sourceImage) {
      const img = new Image();
      img.onload = () => {
        imageRef.current = img;
        
        // Initial Fit
        const canvas = canvasRef.current;
        if (canvas) {
           // Use clientHeight to match the flex-grow layout height
           const containerW = canvas.parentElement?.clientWidth || 600;
           const containerH = canvas.parentElement?.clientHeight || 400;
           
           canvas.width = containerW;
           canvas.height = containerH;

           // Calculate min zoom to fit
           const scaleX = (containerW - 40) / img.width;
           const scaleY = (containerH - 40) / img.height;
           const fitZoom = Math.min(scaleX, scaleY);
           
           setZoom(fitZoom);
           setPan({ x: 0, y: 0 });

           // Default Crop: 80% of image centered
           const cw = img.width * 0.8;
           const ch = img.height * 0.8;
           setCropRect({
               x: (img.width - cw) / 2,
               y: (img.height - ch) / 2,
               w: cw,
               h: ch
           });
        }
      };
      img.src = sourceImage;
    }
  }, [step, sourceImage]);

  // Render Loop
  useEffect(() => {
      if (step !== 'crop' || !imageRef.current || !canvasRef.current) return;
      
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      const img = imageRef.current;
      if (!ctx) return;

      // Clear
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      // Save context for transform
      ctx.save();
      
      // 1. Draw Image with transforms
      // Origin at center of canvas + pan
      ctx.translate(canvas.width / 2 + pan.x, canvas.height / 2 + pan.y);
      ctx.scale(zoom, zoom);
      // Draw image centered at origin
      ctx.drawImage(img, -img.width / 2, -img.height / 2);
      
      // 2. Draw Overlay
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillRect(-img.width / 2, -img.height / 2, img.width, img.height);
      
      // 3. 'Cut out' the crop rect
      const { x, y, w, h } = cropRect;
      ctx.drawImage(img, 
          x, y, w, h, // source
          x - img.width / 2, y - img.height / 2, w, h // dest (relative to translated origin)
      );

      // 4. Draw Crop Border
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2 / zoom; // Keep line width constant on screen
      ctx.strokeRect(x - img.width / 2, y - img.height / 2, w, h);

      // Restore to Screen Space for Handles
      ctx.restore();

      // 5. Draw Handles (Screen Space)
      const handles = getHandleCoords(cropRect, canvas.width, canvas.height, img.width, img.height);
      
      ctx.fillStyle = '#3b82f6';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;

      Object.entries(handles).forEach(([key, pos]) => {
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, HANDLE_RADIUS, 0, Math.PI * 2); 
          ctx.fill();
          ctx.stroke();
      });

  }, [step, cropRect, zoom, pan]);

  // Handle Logic
  const getHandleCoords = (rect: Rect, cw: number, ch: number, iw: number, ih: number) => {
    const tl = toScreen(rect.x, rect.y, cw, ch, iw, ih);
    const tr = toScreen(rect.x + rect.w, rect.y, cw, ch, iw, ih);
    const bl = toScreen(rect.x, rect.y + rect.h, cw, ch, iw, ih);
    const br = toScreen(rect.x + rect.w, rect.y + rect.h, cw, ch, iw, ih);
    
    // Midpoints
    const tm = { x: (tl.x + tr.x)/2, y: (tl.y + tr.y)/2 };
    const bm = { x: (bl.x + br.x)/2, y: (bl.y + br.y)/2 };
    const lm = { x: (tl.x + bl.x)/2, y: (tl.y + bl.y)/2 };
    const rm = { x: (tr.x + br.x)/2, y: (tr.y + br.y)/2 };

    return { nw: tl, n: tm, ne: tr, e: rm, se: br, s: bm, sw: bl, w: lm };
  };

  // Helper to map Screen (Client) coordinates to Internal Canvas coordinates
  // Essential for responsive layouts where CSS size != Canvas resolution
  const getMousePos = (e: React.PointerEvent) => {
      if (!canvasRef.current) return { x: 0, y: 0 };
      const rect = canvasRef.current.getBoundingClientRect();
      const scaleX = canvasRef.current.width / rect.width;
      const scaleY = canvasRef.current.height / rect.height;
      return {
          x: (e.clientX - rect.left) * scaleX,
          y: (e.clientY - rect.top) * scaleY
      };
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    if (!canvasRef.current || !imageRef.current) return;
    
    // Capture pointer
    (e.target as Element).setPointerCapture(e.pointerId);

    const { x: mouseX, y: mouseY } = getMousePos(e);
    lastMousePos.current = { x: mouseX, y: mouseY };
    
    // Hit Test Handles
    const handles = getHandleCoords(cropRect, canvasRef.current.width, canvasRef.current.height, imageRef.current.width, imageRef.current.height);
    let hitHandle = null;
    
    for (const [key, pos] of Object.entries(handles)) {
        if (Math.hypot(pos.x - mouseX, pos.y - mouseY) < HIT_RADIUS) {
            hitHandle = key;
            break;
        }
    }

    if (hitHandle) {
        setDragMode('resize');
        setActiveHandle(hitHandle);
        setIsDragging(true);
        return;
    }

    // Hit Test Crop Box (Screen Space)
    const tl = handles.nw;
    const br = handles.se;
    if (mouseX >= tl.x && mouseX <= br.x && mouseY >= tl.y && mouseY <= br.y) {
        setDragMode('move');
        setIsDragging(true);
        return;
    }

    // Otherwise Pan
    setDragMode('pan');
    setIsDragging(true);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    e.preventDefault();
    if (!isDragging || !canvasRef.current || !imageRef.current) return;

    const { x: mouseX, y: mouseY } = getMousePos(e);
    const dx = mouseX - lastMousePos.current.x;
    const dy = mouseY - lastMousePos.current.y;
    lastMousePos.current = { x: mouseX, y: mouseY };

    if (dragMode === 'pan') {
        setPan(p => ({ x: p.x + dx, y: p.y + dy }));
        return;
    }

    // Convert delta to World Space for crop manips
    const dw = dx / zoom;
    const dh = dy / zoom;

    if (dragMode === 'move') {
        setCropRect(prev => {
            let nx = prev.x + dw;
            let ny = prev.y + dh;
            
            // Clamp to image bounds
            const img = imageRef.current!;
            nx = Math.max(0, Math.min(nx, img.width - prev.w));
            ny = Math.max(0, Math.min(ny, img.height - prev.h));
            
            return { ...prev, x: nx, y: ny };
        });
    }

    if (dragMode === 'resize' && activeHandle) {
        setCropRect(prev => {
            const next = { ...prev };
            const minSize = 20;

            if (activeHandle.includes('n')) {
                const newY = Math.min(next.y + next.h - minSize, Math.max(0, next.y + dh));
                next.h += next.y - newY;
                next.y = newY;
            }
            if (activeHandle.includes('s')) {
                next.h = Math.max(minSize, Math.min(imageRef.current!.height - next.y, next.h + dh));
            }
            if (activeHandle.includes('w')) {
                const newX = Math.min(next.x + next.w - minSize, Math.max(0, next.x + dw));
                next.w += next.x - newX;
                next.x = newX;
            }
            if (activeHandle.includes('e')) {
                next.w = Math.max(minSize, Math.min(imageRef.current!.width - next.x, next.w + dw));
            }
            return next;
        });
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    e.preventDefault();
    setIsDragging(false);
    setActiveHandle(null);
    (e.target as Element).releasePointerCapture(e.pointerId);
  };

  const processCrop = () => {
    if (!imageRef.current) return;
    
    // Max dimension for output to prevent mobile canvas crashes (textures > 4096 often fail, 1024 is safe and fast)
    const MAX_DIM = 1024;
    
    let w = cropRect.w;
    let h = cropRect.h;
    
    // Prevent zero dimension issues
    if (w <= 0 || h <= 0) return;

    if (w > MAX_DIM || h > MAX_DIM) {
        const scale = Math.min(MAX_DIM / w, MAX_DIM / h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
    }
    
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    
    const ctx = canvas.getContext('2d');
    if (ctx) {
        // High quality scaling
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        
        ctx.drawImage(
            imageRef.current,
            cropRect.x, cropRect.y, cropRect.w, cropRect.h,
            0, 0, w, h
        );
        onImageReady(canvas.toDataURL('image/png'));
        onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-gray-800 border border-gray-700 rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700 bg-gray-900">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            {step === 'select' && 'Select Image Source'}
            {step === 'camera' && 'Take Photo'}
            {step === 'crop' && 'Crop & Convert'}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6 flex flex-col items-center justify-center min-h-[300px]">
          
          {step === 'select' && (
            <div className="grid grid-cols-2 gap-6 w-full max-w-md">
              <label className="flex flex-col items-center justify-center gap-4 p-8 bg-gray-700/50 hover:bg-gray-700 border-2 border-dashed border-gray-600 hover:border-blue-500 rounded-xl cursor-pointer transition-all group">
                <div className="p-4 bg-gray-800 rounded-full group-hover:bg-blue-600 transition-colors">
                  <Upload className="w-8 h-8 text-gray-300 group-hover:text-white" />
                </div>
                <span className="text-gray-300 font-medium group-hover:text-white">Upload File</span>
                <input type="file" className="hidden" accept="image/*" onChange={handleFileSelect} />
              </label>

              <button 
                onClick={startCamera}
                className="flex flex-col items-center justify-center gap-4 p-8 bg-gray-700/50 hover:bg-gray-700 border-2 border-dashed border-gray-600 hover:border-purple-500 rounded-xl cursor-pointer transition-all group"
              >
                <div className="p-4 bg-gray-800 rounded-full group-hover:bg-purple-600 transition-colors">
                  <Camera className="w-8 h-8 text-gray-300 group-hover:text-white" />
                </div>
                <span className="text-gray-300 font-medium group-hover:text-white">Use Camera</span>
              </button>
            </div>
          )}

          {step === 'camera' && (
            <div className="relative w-full max-w-lg bg-black rounded-lg overflow-hidden">
               <video ref={videoRef} autoPlay playsInline className="w-full h-auto object-cover" />
               <div className="absolute bottom-4 left-0 right-0 flex justify-center">
                 <button 
                   onClick={capturePhoto}
                   className="w-16 h-16 rounded-full border-4 border-white bg-white/20 hover:bg-white/40 backdrop-blur transition-all flex items-center justify-center"
                 >
                   <div className="w-12 h-12 rounded-full bg-white" />
                 </button>
               </div>
            </div>
          )}

          {step === 'crop' && (
             <div className="flex flex-col items-center gap-4 w-full h-full">
                <div className="flex items-center gap-4 bg-gray-900 p-2 rounded-lg border border-gray-700">
                    <button 
                        onClick={() => setZoom(z => Math.max(0.1, z - 0.1))} 
                        className="p-1 hover:bg-gray-700 rounded text-gray-300" 
                        title="Zoom Out"
                    >
                        <ZoomOut className="w-5 h-5" />
                    </button>
                    <span className="text-xs text-gray-400 w-12 text-center">{Math.round(zoom * 100)}%</span>
                    <button 
                        onClick={() => setZoom(z => z + 0.1)} 
                        className="p-1 hover:bg-gray-700 rounded text-gray-300"
                        title="Zoom In"
                    >
                        <ZoomIn className="w-5 h-5" />
                    </button>
                    <div className="w-px h-4 bg-gray-700 mx-2" />
                    <div className="flex items-center gap-2 text-xs text-gray-400">
                        <Move className="w-4 h-4" />
                        <span>Drag outside to pan</span>
                    </div>
                </div>

                <div className="relative border border-gray-600 shadow-lg bg-black/50 overflow-hidden w-full flex-1 min-h-[300px] cursor-grab active:cursor-grabbing">
                    <canvas 
                        ref={canvasRef}
                        onPointerDown={handlePointerDown}
                        onPointerMove={handlePointerMove}
                        onPointerUp={handlePointerUp}
                        onPointerLeave={handlePointerUp}
                        className="block w-full h-full touch-none"
                    />
                </div>
             </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-700 bg-gray-900 flex justify-between">
           {step !== 'select' && (
             <button 
                onClick={() => { stopCamera(); setStep('select'); }}
                className="flex items-center gap-2 px-4 py-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors"
             >
                <RotateCcw className="w-4 h-4" /> Back
             </button>
           )}
           
           <div className="flex-1"></div>

           {step === 'crop' && (
             <button 
                onClick={processCrop}
                className="flex items-center gap-2 px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded shadow-lg shadow-blue-900/20 transition-all"
             >
                <Check className="w-4 h-4" /> 
                Crop & Save PNG
             </button>
           )}
        </div>
      </div>
    </div>
  );
};

export default ImageUploader;
