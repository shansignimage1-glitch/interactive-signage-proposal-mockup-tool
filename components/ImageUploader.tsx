
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, Upload, X, Check, RotateCcw, ZoomIn, ZoomOut, Move } from 'lucide-react';
import { notify } from '../services/toast';
import { reportError } from '../services/monitoring';
import { MAX_SOURCE_BYTES, MAX_SOURCE_PIXELS } from '../services/imageProcessing';

interface ImageUploaderProps {
  isOpen: boolean;
  onClose: () => void;
  onImageReady: (dataUrl: string) => void;
  preserveSourcePixels?: boolean;
  maxOutputDimension?: number;
}

type Step = 'select' | 'camera' | 'crop';

interface Rect { x: number; y: number; w: number; h: number; }
interface Point { x: number; y: number; }

const HANDLE_RADIUS = 8;
const HIT_RADIUS = 50; // Increased to 50px for better tablet touch sensitivity
const MAX_FULL_RESOLUTION_CROP_PIXELS = 12_000_000;

const ImageUploader: React.FC<ImageUploaderProps> = ({
  isOpen,
  onClose,
  onImageReady,
  preserveSourcePixels = false,
  maxOutputDimension = 1024,
}) => {
  const [step, setStep] = useState<Step>('select');
  const [sourceImage, setSourceImage] = useState<string | null>(null);
  const [videoStream, setVideoStream] = useState<MediaStream | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDecoding, setIsDecoding] = useState(false);
  
  // Camera Refs
  const videoRef = useRef<HTMLVideoElement>(null);

  // Crop State
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const processingGenerationRef = useRef(0);
  
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
      processingGenerationRef.current += 1;
      stopCamera();
      setStep('select');
      setSourceImage(null);
      imageRef.current = null;
      setCropRect({ x: 0, y: 0, w: 0, h: 0 });
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setIsProcessing(false);
      setIsDecoding(false);
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
      if (file.size > MAX_SOURCE_BYTES) {
        notify('This photo is larger than 40 MB. Use the device photo editor to reduce its file size first.', 'error');
        e.target.value = '';
        return;
      }
      const selectionGeneration = ++processingGenerationRef.current;
      imageRef.current = null;
      setIsDecoding(true);
      const reader = new FileReader();
      reader.onload = (evt) => {
        if (processingGenerationRef.current !== selectionGeneration) return;
        if (typeof evt.target?.result === 'string') {
          setSourceImage(evt.target.result);
          setStep('crop');
        }
      };
      reader.onerror = () => {
        if (processingGenerationRef.current !== selectionGeneration) return;
        setIsDecoding(false);
        notify('This image could not be read.', 'error');
      };
      reader.readAsDataURL(file);
    }
  };

  const startCamera = async () => {
    const cameraGeneration = ++processingGenerationRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      if (processingGenerationRef.current !== cameraGeneration) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      setVideoStream(stream);
      setStep('camera');
      setTimeout(() => {
        if (processingGenerationRef.current === cameraGeneration && videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      }, 100);
    } catch (err) {
      if (processingGenerationRef.current !== cameraGeneration) return;
      reportError('camera', err);
      notify('Could not access camera. Please allow camera permission and try again.', 'error');
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
        processingGenerationRef.current += 1;
        imageRef.current = null;
        setIsDecoding(true);
        ctx.drawImage(vid, 0, 0);
        setSourceImage(canvas.toDataURL('image/jpeg', 0.98));
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
      const decodeGeneration = processingGenerationRef.current;
      const img = new Image();
      img.onload = () => {
        if (processingGenerationRef.current !== decodeGeneration) return;
        const sourceWidth = img.naturalWidth || img.width;
        const sourceHeight = img.naturalHeight || img.height;
        if (sourceWidth * sourceHeight > MAX_SOURCE_PIXELS) {
          notify('This photo exceeds 80 megapixels and cannot be processed safely on this device.', 'error');
          imageRef.current = null;
          setSourceImage(null);
          setStep('select');
          setIsDecoding(false);
          return;
        }
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

            // Start with the complete source selected. Cropping must be an
            // explicit user choice; silently trimming the image discards pixels.
            const cw = img.width;
            const ch = img.height;
            setCropRect({
                x: 0,
                y: 0,
                w: cw,
                h: ch
            });
            setIsDecoding(false);
        }
      };
      img.onerror = () => {
        if (processingGenerationRef.current !== decodeGeneration) return;
        notify('This image format could not be decoded on this device.', 'error');
        imageRef.current = null;
        setSourceImage(null);
        setStep('select');
        setIsDecoding(false);
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

  const processCrop = async () => {
    const image = imageRef.current;
    if (!image) return;

    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    const sourceX = Math.max(0, Math.min(sourceWidth - 1, Math.round(cropRect.x)));
    const sourceY = Math.max(0, Math.min(sourceHeight - 1, Math.round(cropRect.y)));
    let sourceCropWidth = Math.max(1, Math.round(cropRect.w));
    let sourceCropHeight = Math.max(1, Math.round(cropRect.h));
    sourceCropWidth = Math.min(sourceCropWidth, sourceWidth - sourceX);
    sourceCropHeight = Math.min(sourceCropHeight, sourceHeight - sourceY);

    const isFullFrame = sourceX === 0
        && sourceY === 0
        && sourceCropWidth === sourceWidth
        && sourceCropHeight === sourceHeight;

    // Browser-portable raster formats can pass through byte-for-byte when the
    // full frame is selected. This avoids a second source-sized canvas and the
    // large PNG expansion that would otherwise occur for phone JPEGs.
    if (preserveSourcePixels && isFullFrame && sourceImage && /^data:image\/(?:png|jpe?g|webp|avif);/i.test(sourceImage)) {
        onImageReady(sourceImage);
        onClose();
        return;
    }

    const scale = preserveSourcePixels
      ? 1
      : Math.min(1, maxOutputDimension / Math.max(sourceCropWidth, sourceCropHeight));
    const outputWidth = Math.max(1, Math.round(sourceCropWidth * scale));
    const outputHeight = Math.max(1, Math.round(sourceCropHeight * scale));

    if (preserveSourcePixels && outputWidth * outputHeight > MAX_FULL_RESOLUTION_CROP_PIXELS) {
        notify('This full-resolution crop is too large for this device. Tighten the crop area, or use the complete image without cropping.', 'error');
        return;
    }

    const processingGeneration = ++processingGenerationRef.current;
    setIsProcessing(true);
    try {
        const canvas = document.createElement('canvas');
        canvas.width = outputWidth;
        canvas.height = outputHeight;

        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('This device could not allocate the full-resolution crop canvas.');
        // High quality scaling
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        
        ctx.drawImage(
            image,
            sourceX, sourceY, sourceCropWidth, sourceCropHeight,
            0, 0, outputWidth, outputHeight
        );
        const sourceMime = sourceImage?.match(/^data:(image\/(?:png|jpe?g|webp|avif));/i)?.[1]?.toLowerCase();
        const outputMime = sourceMime === 'image/jpeg' || sourceMime === 'image/jpg'
            ? 'image/jpeg'
            : sourceMime === 'image/webp'
                ? 'image/webp'
                : 'image/png';
        const result = await new Promise<string>((resolve, reject) => {
            canvas.toBlob(blob => {
                if (!blob) { reject(new Error('The full-resolution crop could not be encoded.')); return; }
                if (blob.size > MAX_SOURCE_BYTES) {
                    reject(new Error('This full-resolution crop exceeds 40 MB. Tighten the crop area and try again.'));
                    return;
                }
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result as string);
                reader.onerror = () => reject(reader.error ?? new Error('The full-resolution crop could not be read.'));
                reader.readAsDataURL(blob);
            }, outputMime, 0.96);
        });
        if (processingGenerationRef.current !== processingGeneration) return;
        onImageReady(result);
        onClose();
    } catch (error) {
        reportError('image-crop', error, { outputWidth, outputHeight, preserveSourcePixels });
        notify(error instanceof Error ? error.message : 'This crop could not be processed at full resolution.', 'error');
    } finally {
        if (processingGenerationRef.current === processingGeneration) setIsProcessing(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="flex max-h-[calc(100dvh-1rem)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-gray-700 bg-gray-800 shadow-2xl sm:max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700 bg-gray-900">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            {step === 'select' && 'Select Image Source'}
            {step === 'camera' && 'Take Photo'}
            {step === 'crop' && 'Crop & Convert'}
          </h3>
          <button onClick={onClose} disabled={isProcessing} className="text-gray-400 hover:text-white disabled:cursor-wait disabled:opacity-40 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto p-3 sm:min-h-[300px] sm:p-6">
          
          {step === 'select' && (
            <div className="grid w-full max-w-md grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-6">
              <label className="group flex min-h-28 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-gray-600 bg-gray-700/50 p-4 transition-all hover:border-blue-500 hover:bg-gray-700 sm:gap-4 sm:p-8">
                <div className="p-4 bg-gray-800 rounded-full group-hover:bg-blue-600 transition-colors">
                  <Upload className="w-8 h-8 text-gray-300 group-hover:text-white" />
                </div>
                <span className="text-gray-300 font-medium group-hover:text-white">Upload File</span>
                <input type="file" className="hidden" accept="image/*" onChange={handleFileSelect} />
              </label>

              <button 
                onClick={startCamera}
                className="group flex min-h-28 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-gray-600 bg-gray-700/50 p-4 transition-all hover:border-purple-500 hover:bg-gray-700 sm:gap-4 sm:p-8"
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
                onClick={() => {
                  processingGenerationRef.current += 1;
                  stopCamera();
                  imageRef.current = null;
                  setSourceImage(null);
                  setIsDecoding(false);
                  setStep('select');
                }}
                disabled={isProcessing}
                className="flex items-center gap-2 px-4 py-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors"
             >
                <RotateCcw className="w-4 h-4" /> Back
             </button>
           )}
           
           <div className="flex-1"></div>

           {step === 'crop' && (
             <button 
                onClick={processCrop}
                data-testid="confirm-image-crop"
                aria-label="Crop & Save PNG"
                disabled={isProcessing || isDecoding || !imageRef.current}
                className="flex items-center gap-2 px-6 py-2 bg-blue-600 hover:bg-blue-500 disabled:cursor-wait disabled:opacity-60 text-white font-semibold rounded shadow-lg shadow-blue-900/20 transition-all"
             >
                <Check className="w-4 h-4" /> 
                 {isDecoding ? 'Preparing full resolution…' : isProcessing ? 'Processing full resolution…' : preserveSourcePixels ? 'Use full-resolution crop' : 'Crop & Save PNG'}
             </button>
           )}
        </div>
      </div>
    </div>
  );
};

export default ImageUploader;
