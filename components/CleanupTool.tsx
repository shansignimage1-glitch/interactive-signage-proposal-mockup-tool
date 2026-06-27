
import React, { useRef, useState, useEffect, useCallback } from 'react';
import { GoogleGenAI } from "@google/genai";
import { X, Check, Undo2, Redo2, Mic, Eraser, Loader2, Brush, Hand, ZoomIn, ZoomOut, Maximize, RotateCcw, Trash2 } from 'lucide-react';

interface CleanupToolProps {
  isOpen: boolean;
  imageUrl: string;
  onClose: () => void;
  onSave: (newImageUrl: string) => void;
  apiKey: string | undefined;
}

// History stack size
const MAX_HISTORY = 10;
const MAX_MASK_HISTORY = 20;

const CleanupTool: React.FC<CleanupToolProps> = ({ isOpen, imageUrl, onClose, onSave, apiKey }) => {
  const [currentImage, setCurrentImage] = useState<string>(imageUrl);
  const [history, setHistory] = useState<string[]>([imageUrl]);
  const [historyIndex, setHistoryIndex] = useState(0);
  
  // Mask History (Undo/Redo for painting)
  const [maskHistory, setMaskHistory] = useState<ImageData[]>([]);

  const [mode, setMode] = useState<'brush' | 'pan'>('brush');
  const [brushSize, setBrushSize] = useState(40);
  const [prompt, setPrompt] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isListening, setIsListening] = useState(false);

  // Viewport State
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [baseScale, setBaseScale] = useState(1);
  const [imgDimensions, setImgDimensions] = useState({ width: 0, height: 0 });
  
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Canvas refs
  const canvasRef = useRef<HTMLCanvasElement>(null); // Display Image
  const maskCanvasRef = useRef<HTMLCanvasElement>(null); // Brush Mask
  const cursorRef = useRef<HTMLDivElement>(null); // Visual Cursor
  
  // Interaction State
  const isDrawing = useRef(false);
  const isPanning = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  // Load Image and Init Canvas
  useEffect(() => {
    if (!containerRef.current) return;
    
    const img = new Image();
    img.crossOrigin = "anonymous"; // Important for editing external images (CORS)
    img.src = currentImage;
    img.onload = () => {
       const container = containerRef.current!;
       if (container.clientWidth === 0) return;

       const imgW = img.width;
       const imgH = img.height;
       
       setImgDimensions({ width: imgW, height: imgH });

       // Calculate Base Fit Scale
       const contW = container.clientWidth;
       const contH = container.clientHeight;
       const scaleX = contW / imgW;
       const scaleY = contH / imgH;
       const fitScale = Math.min(scaleX, scaleY) * 0.9; // 90% fit
       
       setBaseScale(fitScale);
       setView({ scale: 1, x: 0, y: 0 }); // Reset View

       // We need to defer canvas drawing slightly to ensure refs and dims are ready
       requestAnimationFrame(() => {
           if (canvasRef.current && maskCanvasRef.current) {
              canvasRef.current.width = imgW;
              canvasRef.current.height = imgH;
              maskCanvasRef.current.width = imgW;
              maskCanvasRef.current.height = imgH;

              const ctx = canvasRef.current.getContext('2d');
              ctx?.drawImage(img, 0, 0);
              
              // Clear mask
              const maskCtx = maskCanvasRef.current.getContext('2d');
              maskCtx?.clearRect(0, 0, imgW, imgH);
              setMaskHistory([]); // Reset mask history on new image
           }
       });
    };
  }, [currentImage]);

  // --- History Management ---
  const pushHistory = (newImg: string) => {
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newImg);
    if (newHistory.length > MAX_HISTORY) newHistory.shift();
    
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
    setCurrentImage(newImg);
    
    // Reset mask history when moving to a new image state
    setMaskHistory([]);
    const maskCtx = maskCanvasRef.current?.getContext('2d');
    if (maskCtx && maskCanvasRef.current) {
      maskCtx.clearRect(0, 0, maskCanvasRef.current.width, maskCanvasRef.current.height);
    }
  };

  const handleUndo = () => {
    if (historyIndex > 0) {
      setHistoryIndex(prev => prev - 1);
      setCurrentImage(history[historyIndex - 1]);
    }
  };

  const handleRedo = () => {
    if (historyIndex < history.length - 1) {
      setHistoryIndex(prev => prev + 1);
      setCurrentImage(history[historyIndex + 1]);
    }
  };
  
  // --- Mask Undo Management ---
  const saveMaskState = () => {
      if (!maskCanvasRef.current) return;
      const ctx = maskCanvasRef.current.getContext('2d');
      if (!ctx) return;
      
      const data = ctx.getImageData(0, 0, maskCanvasRef.current.width, maskCanvasRef.current.height);
      setMaskHistory(prev => [...prev.slice(-(MAX_MASK_HISTORY - 1)), data]);
  };
  
  const handleMaskUndo = () => {
      if (maskHistory.length === 0 || !maskCanvasRef.current) return;
      
      const ctx = maskCanvasRef.current.getContext('2d');
      if (!ctx) return;
      
      const lastState = maskHistory[maskHistory.length - 1];
      ctx.putImageData(lastState, 0, 0);
      setMaskHistory(prev => prev.slice(0, -1));
  };
  
  const handleClearMask = () => {
      if (!maskCanvasRef.current) return;
      saveMaskState(); // Save before clearing
      const ctx = maskCanvasRef.current.getContext('2d');
      ctx?.clearRect(0, 0, maskCanvasRef.current.width, maskCanvasRef.current.height);
  };

  // --- Helpers ---
  
  // Accurately map Screen Coordinates (clientX, Y) to Image Pixel Coordinates
  const getCoords = (clientX: number, clientY: number) => {
     if (!containerRef.current || imgDimensions.width === 0) return { x: 0, y: 0 };
     
     const rect = containerRef.current.getBoundingClientRect();
     // Center of the viewport/container
     const cx = rect.left + rect.width / 2;
     const cy = rect.top + rect.height / 2;
     
     const totalScale = baseScale * view.scale;
     
     // Calculate vector from viewport center to mouse
     const screenDx = clientX - cx;
     const screenDy = clientY - cy;

     // Apply inverse transform:
     // The CSS transform is: translate(-50%, -50%) translate(view.x, view.y) scale(totalScale)
     // This means the image center is at (cx + view.x, cy + view.y)
     // And coordinates are scaled by totalScale.
     
     // Inverse:
     // 1. Subtract Center Offset (view.x, view.y) from Screen Delta
     // 2. Divide by Scale
     // 3. Add Image Center (imgDimensions / 2)
     
     const x = (screenDx - view.x) / totalScale + imgDimensions.width / 2;
     const y = (screenDy - view.y) / totalScale + imgDimensions.height / 2;

     return { x, y };
  };

  // --- Interactions ---

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const mx = e.clientX - cx;
    const my = e.clientY - cy;

    const oldTotalScale = baseScale * view.scale;
    const wx = (mx - view.x) / oldTotalScale;
    const wy = (my - view.y) / oldTotalScale;

    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.min(Math.max(0.1, view.scale * zoomFactor), 20);
    const newTotalScale = baseScale * newScale;

    const newX = mx - (wx * newTotalScale);
    const newY = my - (wy * newTotalScale);

    setView({ scale: newScale, x: newX, y: newY });
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    containerRef.current?.setPointerCapture(e.pointerId);

    // Pan Mode or Middle Click
    if (mode === 'pan' || e.button === 1 || e.shiftKey) {
        isPanning.current = true;
        lastPos.current = { x: e.clientX, y: e.clientY };
        setMode(prev => prev === 'brush' && e.shiftKey ? 'brush' : prev); // Don't switch mode perm if just shift
        return;
    }

    // Brush Mode
    if (mode === 'brush') {
        saveMaskState(); // Save state BEFORE drawing starts
        isDrawing.current = true;
        
        const coords = getCoords(e.clientX, e.clientY);
        lastPos.current = coords;
        
        // Draw single dot on click
        const ctx = maskCanvasRef.current?.getContext('2d');
        if (ctx) {
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.lineWidth = brushSize;
            ctx.fillStyle = 'rgba(255, 0, 255, 0.7)';
            ctx.beginPath();
            ctx.arc(coords.x, coords.y, brushSize / 2, 0, Math.PI * 2);
            ctx.fill();
        }
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    // Direct DOM update for cursor to avoid React render lag
    // Using FIXED positioning ensures it aligns perfectly with the hardware mouse position (clientX/Y)
    // independent of container offsets or scroll positions.
    if (cursorRef.current) {
        cursorRef.current.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -50%)`;
        cursorRef.current.style.opacity = (mode === 'brush' && !isPanning.current) ? '1' : '0';
    }

    if (isPanning.current) {
        const dx = e.clientX - lastPos.current.x; // These are screen pixels
        const dy = e.clientY - lastPos.current.y;
        lastPos.current = { x: e.clientX, y: e.clientY };
        setView(v => ({ ...v, x: v.x + dx, y: v.y + dy }));
        return;
    }

    if (isDrawing.current && maskCanvasRef.current) {
        const ctx = maskCanvasRef.current.getContext('2d');
        if (!ctx) return;

        const coords = getCoords(e.clientX, e.clientY);
        
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = brushSize;
        ctx.strokeStyle = 'rgba(255, 0, 255, 0.7)'; 
        ctx.fillStyle = 'rgba(255, 0, 255, 0.7)';

        ctx.beginPath();
        // Move to last known IMAGE coordinate
        ctx.moveTo(lastPos.current.x, lastPos.current.y);
        // Draw to new IMAGE coordinate
        ctx.lineTo(coords.x, coords.y);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(coords.x, coords.y, brushSize / 2, 0, Math.PI * 2);
        ctx.fill();

        lastPos.current = coords;
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    isDrawing.current = false;
    isPanning.current = false;
    containerRef.current?.releasePointerCapture(e.pointerId);
  };
  
  const handlePointerLeave = (e: React.PointerEvent) => {
      handlePointerUp(e);
      if (cursorRef.current) cursorRef.current.style.opacity = '0';
  }

  // --- Voice Input ---
  const toggleVoice = () => {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      alert("Speech recognition is not supported in this browser.");
      return;
    }

    if (isListening) {
      setIsListening(false);
      return;
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => setIsListening(false);
    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      setPrompt(prev => prev + (prev ? ' ' : '') + transcript);
    };

    recognition.start();
  };

  // --- Gemini Generation ---
  const handleGenerate = async () => {
    if (!apiKey) return alert("API Key missing");
    
    const maskCanvas = maskCanvasRef.current;
    const imgCanvas = canvasRef.current;
    if (!maskCanvas || !imgCanvas) return;

    setIsProcessing(true);

    try {
      // 1. Resize Image Logic
      // High resolution images can cause the API to fail or time out.
      // We resize to a max dimension (e.g., 1536px) to ensure reliability.
      const MAX_DIM = 1536;
      let width = imgCanvas.width;
      let height = imgCanvas.height;

      if (width > MAX_DIM || height > MAX_DIM) {
        const ratio = width / height;
        if (ratio > 1) {
            width = MAX_DIM;
            height = Math.round(MAX_DIM / ratio);
        } else {
            height = MAX_DIM;
            width = Math.round(MAX_DIM * ratio);
        }
      }

      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = width;
      tempCanvas.height = height;
      const ctx = tempCanvas.getContext('2d');
      if (!ctx) throw new Error("Context lost");

      // Draw original image resized
      ctx.drawImage(imgCanvas, 0, 0, width, height);

      const maskCtx = maskCanvas.getContext('2d');
      const maskData = maskCtx?.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
      const hasMask = maskData?.data.some(channel => channel > 0);

      let base64Image = '';
      let finalPrompt = '';

      if (hasMask) {
        // Draw the mask on top of the resized image
        // We must draw the mask resized as well
        ctx.drawImage(maskCanvas, 0, 0, width, height);

        base64Image = tempCanvas.toDataURL('image/png').split(',')[1];
        // Updated prompt for better robustness with Gemini 2.5
        finalPrompt = `Look at the image. There is a magenta (pink) colored area painted over an object. Remove the object covered by the magenta color and fill in the background naturally to match the surroundings. ${prompt ? `Additional instruction: ${prompt}` : ''}`;
      } else {
        if (!prompt.trim()) {
            setIsProcessing(false);
            return alert("Please paint an area to remove or describe what to remove.");
        }
        // No mask, just prompt based
        base64Image = tempCanvas.toDataURL('image/png').split(',')[1];
        finalPrompt = `Remove ${prompt} from the image. Fill the area naturally to match the background.`;
      }

      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: {
          parts: [
            { inlineData: { data: base64Image, mimeType: 'image/png' } },
            { text: finalPrompt }
          ]
        }
      });

      let newImageData = null;
        if (response.candidates?.[0]?.content?.parts) {
            for (const part of response.candidates[0].content.parts) {
                if (part.inlineData) {
                    newImageData = `data:image/png;base64,${part.inlineData.data}`;
                    break;
                }
            }
        }

      if (newImageData) {
        pushHistory(newImageData);
        setPrompt(''); 
      } else {
        console.warn("API Response:", response);
        alert("The AI did not return an image. It might have refused the request or encountered an error.");
      }

    } catch (e: any) {
      console.error(e);
      alert(`Failed to process image: ${e.message || "Unknown error"}. Try a simpler request or smaller image.`);
    } finally {
      setIsProcessing(false);
    }
  };

  // Calculate transforms
  const totalScale = baseScale * view.scale;
  
  return (
    <div className="fixed inset-0 z-[100] bg-gray-950 flex flex-col">
      {/* Header */}
      <div className="bg-gray-900 border-b border-gray-800 p-4 flex items-center justify-between shadow-md z-10">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <Eraser className="w-5 h-5 text-blue-400" />
          Magic Clean Up <span className="text-xs font-normal text-gray-500 bg-gray-800 px-2 py-0.5 rounded border border-gray-700">Gemini 2.5</span>
        </h2>
        <div className="flex gap-2">
           <button onClick={handleUndo} disabled={historyIndex <= 0} className="p-2 text-gray-400 hover:text-white disabled:opacity-30" title="Undo Image">
             <Undo2 className="w-5 h-5" />
           </button>
           <button onClick={handleRedo} disabled={historyIndex >= history.length - 1} className="p-2 text-gray-400 hover:text-white disabled:opacity-30" title="Redo Image">
             <Redo2 className="w-5 h-5" />
           </button>
           <div className="w-px h-6 bg-gray-700 mx-2 self-center"></div>
           <button onClick={() => onSave(currentImage)} className="flex items-center gap-2 px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded font-medium shadow-lg shadow-blue-900/20">
             <Check className="w-4 h-4" /> Save
           </button>
           <button onClick={onClose} className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded">
             <X className="w-5 h-5" />
           </button>
        </div>
      </div>

      {/* Main Canvas Area */}
      <div 
        ref={containerRef} 
        className="flex-1 relative overflow-hidden bg-black/50 flex items-center justify-center touch-none select-none"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        style={{ cursor: mode === 'pan' || isPanning.current ? 'grab' : 'none' }} 
      >
         {/* Render Layer Group */}
         <div style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: imgDimensions.width,
            height: imgDimensions.height,
            // Order of transforms: 
            // 1. Center origin (-50%, -50%) 
            // 2. Pan (view.x, view.y) 
            // 3. Zoom (scale)
            transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${totalScale})`,
            transformOrigin: 'center center',
            boxShadow: '0 0 20px rgba(0,0,0,0.5)'
         }}>
             <canvas 
               ref={canvasRef}
               className="absolute top-0 left-0 pointer-events-none"
             />
             <canvas 
               ref={maskCanvasRef}
               className="absolute top-0 left-0"
               style={{ opacity: 0.8 }}
             />
         </div>

         {/* Zoom Controls Overlay */}
         <div className="absolute top-4 right-4 flex flex-col gap-2 z-20" onPointerDown={(e) => e.stopPropagation()}>
            <button 
                onClick={() => setView(v => ({ ...v, scale: Math.min(v.scale * 1.2, 8) }))} 
                className="p-2 bg-gray-800/90 hover:bg-gray-700 text-white rounded shadow border border-gray-600 backdrop-blur"
                title="Zoom In"
            >
                <ZoomIn className="w-5 h-5" />
            </button>
            <button 
                onClick={() => setView(v => ({ ...v, scale: Math.max(v.scale / 1.2, 0.1) }))} 
                className="p-2 bg-gray-800/90 hover:bg-gray-700 text-white rounded shadow border border-gray-600 backdrop-blur"
                title="Zoom Out"
            >
                <ZoomOut className="w-5 h-5" />
            </button>
            <button 
                onClick={() => setView({ scale: 1, x: 0, y: 0 })} 
                className="p-2 bg-gray-800/90 hover:bg-gray-700 text-white rounded shadow border border-gray-600 backdrop-blur"
                title="Reset View"
            >
                <Maximize className="w-5 h-5" />
            </button>
         </div>
         
         {/* Hint for Pan */}
         <div className="absolute top-4 left-4 bg-black/40 text-white text-xs px-2 py-1 rounded pointer-events-none backdrop-blur">
            Hold Shift or Middle Click to Pan
         </div>

         {isProcessing && (
           <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center z-50">
             <Loader2 className="w-10 h-10 text-blue-500 animate-spin mb-4" />
             <p className="text-white font-medium">Gemini is removing objects...</p>
             <p className="text-sm text-gray-400 mt-2">This may take a few seconds.</p>
           </div>
         )}
      </div>
      
      {/* Visual Cursor - Placed outside the relative container to avoid overflow clipping and ensure accurate fixed positioning */}
      <div 
        ref={cursorRef}
        className="fixed pointer-events-none rounded-full border border-white shadow-[0_0_2px_rgba(0,0,0,0.8)] z-[200] mix-blend-difference will-change-transform"
        style={{
            width: brushSize * totalScale,
            height: brushSize * totalScale,
            backgroundColor: 'rgba(255, 0, 255, 0.3)',
            top: 0,
            left: 0,
            opacity: 0,
            // Initial transform off-screen
            transform: 'translate(-1000px, -1000px)'
        }}
     />

      {/* Toolbar */}
      <div className="bg-gray-900 border-t border-gray-800 p-4 z-10 shadow-[0_-5px_15px_rgba(0,0,0,0.3)]">
        <div className="max-w-4xl mx-auto flex flex-col md:flex-row gap-6 items-center">
            
            {/* Tools */}
            <div className="flex items-center gap-4 border-r border-gray-700 pr-6">
                <div className="flex bg-gray-800 rounded-lg p-1 border border-gray-700">
                    <button 
                      onClick={() => setMode('brush')}
                      className={`p-2 rounded ${mode === 'brush' ? 'bg-blue-600 text-white shadow' : 'text-gray-400 hover:text-white'}`}
                      title="Brush Tool"
                    >
                      <Brush className="w-5 h-5" />
                    </button>
                    <button 
                      onClick={() => setMode('pan')}
                      className={`p-2 rounded ${mode === 'pan' ? 'bg-blue-600 text-white shadow' : 'text-gray-400 hover:text-white'}`}
                      title="Pan Tool"
                    >
                      <Hand className="w-5 h-5" />
                    </button>
                </div>
                
                <div className="flex items-center gap-1">
                    <button 
                        onClick={handleMaskUndo} 
                        disabled={maskHistory.length === 0}
                        className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded disabled:opacity-30" 
                        title="Undo Stroke"
                    >
                        <RotateCcw className="w-4 h-4" />
                    </button>
                    <button 
                        onClick={handleClearMask}
                        className="p-2 text-gray-400 hover:text-red-400 hover:bg-gray-800 rounded" 
                        title="Clear Mask"
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                </div>

                <div className={`flex flex-col w-32 transition-opacity duration-200 ${mode === 'brush' ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
                  <label className="text-[10px] text-gray-500 uppercase font-bold mb-1">Brush Size</label>
                  <input 
                    type="range" 
                    min="5" 
                    max="200" 
                    value={brushSize} 
                    onChange={(e) => setBrushSize(parseInt(e.target.value))}
                    className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                  />
                </div>
            </div>

            {/* Prompt Input */}
            <div className="flex-1 w-full flex gap-2">
               <div className="relative flex-1">
                 <input 
                    type="text" 
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="Describe what to remove (optional if brushing)..."
                    className="w-full bg-gray-800 border border-gray-600 rounded-lg pl-4 pr-10 py-2.5 text-sm text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none shadow-sm"
                    onKeyDown={(e) => e.key === 'Enter' && handleGenerate()}
                 />
                 <button 
                   onClick={toggleVoice}
                   className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full transition-colors ${isListening ? 'bg-red-500/20 text-red-500 animate-pulse' : 'text-gray-400 hover:text-white'}`}
                 >
                   <Mic className="w-4 h-4" />
                 </button>
               </div>
               <button 
                 onClick={handleGenerate}
                 disabled={isProcessing}
                 className="bg-white text-gray-900 px-6 py-2.5 rounded-lg font-bold hover:bg-gray-200 transition-colors disabled:opacity-50 flex items-center gap-2 shadow-lg"
               >
                 {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Generate'}
               </button>
            </div>
        </div>
      </div>
    </div>
  );
};

export default CleanupTool;
