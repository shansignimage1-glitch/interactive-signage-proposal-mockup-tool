
import React, { useRef, useState, useEffect } from 'react';
import { BLEND_MODES, MockupState, Sign, Point, Dimension, SignTemplate, ReferenceImage, TitleBlockField, Canvas, PaperSize, Orientation, SIGN_TYPES, SignType } from '../types';
import { Upload, Download, Sun, Moon, Move3d, Palette, Image as ImageIcon, Plus, Trash2, Layers, Eye, Copy, Box, Minus, Maximize, Ruler, ArrowRight, ArrowDown, Scissors, Check, X, Eraser, Loader2, Square, PenTool, MousePointer2, Mic, EyeOff, Undo2, Redo2, Layout, FileText, Settings, Briefcase, User, Calendar, MapPin, Notebook, Camera, Library, Sparkles, PencilLine, Grid, Save, ChevronDown, ChevronRight, Monitor, Printer, FolderOpen } from 'lucide-react';
import ImageUploader from './ImageUploader';
import SignLibrary from './SignLibrary';
import { ToolMode } from '../App';
import { TITLE_BLOCK_TEMPLATES } from '../data/titleBlockTemplates';

interface ControlsPanelProps {
  state: MockupState;
  activeCanvas: Canvas;
  updateState: (updates: Partial<MockupState>) => void;
  updateStateWithHistory: (updates: Partial<MockupState>) => void;
  updateActiveCanvas: (updates: Partial<Canvas>) => void;
  
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
  updateDimension: (id: string, updates: Partial<Dimension>) => void;
  removeDimension: (id: string) => void;
  setActiveDimension: (id: string) => void;

  onBackgroundUpload: (file: File) => void;
  onForegroundUpload: (file: File) => void;
  onLogoUpload: (file: File) => void;
  onDownload: () => void;

  isCropping: boolean;
  setIsCropping: (v: boolean) => void;

  onOpenCleanup: () => void;

  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  
  showAssistant: boolean;
  setShowAssistant: (show: boolean) => void;
  onOpenProjectManager: () => void;
}

const ControlsPanel: React.FC<ControlsPanelProps> = ({
  state,
  activeCanvas,
  updateState,
  updateStateWithHistory,
  updateActiveCanvas,
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
  
  const [activeTab, setActiveTab] = useState<'editor' | 'page' | 'notes'>('editor');
  
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>, callback: (f: File) => void) => {
    if (e.target.files && e.target.files[0]) {
      callback(e.target.files[0]);
    }
    e.target.value = '';
  };

  const activeDimension = activeCanvas.dimensions.find(d => d.id === activeCanvas.activeDimensionId);

  useEffect(() => {
    if (listeningTarget === 'dimension') {
        setListeningTarget(null);
    }
  }, [activeCanvas.activeDimensionId]);
  
  // Sync view mode with tab (Only 'page' tab enables sheet view)
  useEffect(() => {
      updateState({ titleBlock: { ...state.titleBlock, viewMode: activeTab === 'page' ? 'sheet' : 'canvas' } });
  }, [activeTab]);

  const handleVoiceInput = (target: 'dimension' | 'notes' | 'ref_note' = 'dimension') => {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        alert("Speech recognition is not supported in this browser.");
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

  const handleImageReady = (dataUrl: string) => {
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
                      sideColor: '#111111'
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

          updateActiveSign({ image: dataUrl, corners: [c0, c1, c2, c3] });
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
                 backgroundSize: { width: img.width, height: img.height }
             });
        };
        img.src = dataUrl;
    }
  };

  const mapCategoryToType = (cat: string): SignType => {
      const c = cat.toLowerCase();
      if (c.includes('projecting')) return 'blade_sign';
      if (c.includes('pylon') || c.includes('totem')) return 'totem';
      if (c.includes('window')) return 'window_vinyl';
      if (c.includes('fascia')) return 'fascia_ill';
      return 'fascia_non_ill';
  };

  const handleLibrarySelect = (template: SignTemplate) => {
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
              image: template.image,
              corners: [
                  { x: minX, y: minY },
                  { x: maxX, y: minY },
                  { x: maxX, y: maxY },
                  { x: minX, y: maxY }
              ],
              signType: mapCategoryToType(template.category),
              extrusionEnabled: true,
              extrusionDepth: 15,
              extrusionAngle: 45,
              opacity: 1,
              blendMode: 'normal',
              sideColor: '#111111'
          };
          
          // Add to active canvas
          updateActiveCanvas({
             signs: [...activeCanvas.signs, newSign],
             activeSignId: id,
             activeDimensionId: null
          });
      } 
      else if (activeCanvas.activeSignId) {
          updateActiveSign({ image: template.image, name: template.name });
      } 
      else {
          addSign();
          const id = Date.now().toString();
          const cx = 1920 / 2; 
          const cy = 1080 / 2;
          const aspect = template.width / template.height;
          const w = 300;
          const h = w / aspect;
          
          const newSign: Sign = {
              id,
              name: template.name,
              image: template.image,
              corners: [
                  { x: cx - w/2, y: cy - h/2 },
                  { x: cx + w/2, y: cy - h/2 },
                  { x: cx + w/2, y: cy + h/2 },
                  { x: cx - w/2, y: cy + h/2 }
              ],
              signType: mapCategoryToType(template.category),
              extrusionEnabled: true,
              extrusionDepth: 15,
              extrusionAngle: 45,
              opacity: 1,
              blendMode: 'normal',
              sideColor: '#111111'
          };
          
          updateActiveCanvas({
              signs: [...activeCanvas.signs, newSign],
              activeSignId: id
          });
      }
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
      alert("Template saved to library!");
  };

  const activeSign = activeCanvas.signs.find(s => s.id === activeCanvas.activeSignId);

  return (
    <>
      <div className="w-full lg:w-80 h-[45%] lg:h-full bg-gray-900 border-t lg:border-t-0 lg:border-r border-gray-700 flex flex-col shadow-xl z-20">
        <div className="p-4 md:p-6 border-b border-gray-700 bg-gray-800 flex-shrink-0 flex items-center justify-between">
          <div className="flex-1 min-w-0 pr-2">
            <h1 className="text-xl font-bold text-white flex items-center gap-2 truncate">
                <Move3d className="w-6 h-6 text-blue-400 flex-shrink-0" />
                <span className="truncate">{state.projectName || 'SignagePro'}</span>
            </h1>
            <p className="text-xs text-gray-400 mt-1 truncate">Proposal Mockup Tool</p>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
             <button 
                onClick={onOpenProjectManager} 
                className="p-1.5 text-blue-400 hover:text-white hover:bg-gray-700 transition-colors rounded"
                title="Manage Projects"
             >
                <FolderOpen className="w-4 h-4" />
             </button>
             <div className="w-px h-4 bg-gray-600 mx-1"></div>
             <button 
                onClick={() => setShowAssistant(!showAssistant)} 
                className={`p-1.5 transition-colors rounded hover:bg-gray-700 ${showAssistant ? 'text-blue-400 bg-blue-900/30' : 'text-gray-400 hover:text-white'}`}
                title={showAssistant ? "Hide Assistant" : "Show Assistant"}
             >
                <Sparkles className="w-4 h-4" />
             </button>
             <div className="w-px h-4 bg-gray-600 mx-1"></div>
             <button 
                onClick={undo} 
                disabled={!canUndo}
                className="p-1.5 text-gray-400 hover:text-white disabled:opacity-30 disabled:hover:text-gray-400 transition-colors rounded hover:bg-gray-700"
                title="Undo"
             >
                <Undo2 className="w-4 h-4" />
             </button>
             <button 
                onClick={redo} 
                disabled={!canRedo}
                className="p-1.5 text-gray-400 hover:text-white disabled:opacity-30 disabled:hover:text-gray-400 transition-colors rounded hover:bg-gray-700"
                title="Redo"
             >
                <Redo2 className="w-4 h-4" />
             </button>
          </div>
        </div>

        {/* Tab Header */}
        <div className="flex border-b border-gray-700 bg-gray-900 overflow-x-auto no-scrollbar">
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
        </div>

        <div className="p-4 md:p-6 space-y-6 md:space-y-8 flex-1 overflow-y-auto custom-scrollbar">
          
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
                             className="w-full bg-transparent border-b border-gray-700 text-xs text-gray-400 focus:text-white focus:border-blue-500 outline-none pb-1"
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
                      className={`flex items-center justify-center p-3 rounded-lg border transition-all gap-2 ${
                        state.isNightMode 
                          ? 'bg-blue-900/30 border-blue-500 text-blue-200' 
                          : 'bg-gray-800 border-gray-600 text-gray-300 hover:bg-gray-750'
                      }`}
                      title="Toggle Night Mode"
                    >
                      {state.isNightMode ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
                    </button>
                </div>
              </div>
              
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider flex items-center gap-2">
                        <Ruler className="w-4 h-4" /> Dimensions
                    </h2>
                    <button
                        onClick={() => updateState({ showDimensions: !state.showDimensions })}
                        className={`p-1.5 rounded transition-colors ${state.showDimensions ? 'text-blue-400 bg-blue-900/20' : 'text-gray-500 hover:text-gray-300'}`}
                    >
                        {state.showDimensions ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                    </button>
                </div>
                <div className="flex bg-gray-800 p-1 rounded-lg border border-gray-700">
                    <button onClick={() => setToolMode('select')} className={`flex-1 flex items-center justify-center p-2 rounded gap-2 text-xs transition-colors ${toolMode === 'select' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}><MousePointer2 className="w-4 h-4" /> Select</button>
                    <button onClick={() => setToolMode('draw_line')} className={`flex-1 flex items-center justify-center p-2 rounded gap-2 text-xs transition-colors ${toolMode === 'draw_line' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}><PenTool className="w-4 h-4" /> Line</button>
                    <button onClick={() => setToolMode('draw_box')} className={`flex-1 flex items-center justify-center p-2 rounded gap-2 text-xs transition-colors ${toolMode === 'draw_box' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}><Square className="w-4 h-4" /> Box</button>
                </div>
                {activeCanvas.dimensions.length > 0 && state.showDimensions && (
                    <div className="space-y-2 max-h-32 overflow-y-auto pr-1 custom-scrollbar">
                        {activeCanvas.dimensions.map(dim => (
                            <div key={dim.id} onClick={() => { setActiveDimension(dim.id); setToolMode('select'); }} className={`flex items-center justify-between p-2 rounded border cursor-pointer transition-all ${dim.id === activeCanvas.activeDimensionId ? 'bg-blue-900/20 border-blue-500/50' : 'bg-gray-800 border-gray-700 hover:border-gray-600'}`}>
                                <div className="flex items-center gap-2 text-sm text-gray-300">
                                    {dim.variant === 'box' ? <Square className="w-3 h-3 text-gray-500" /> : <PenTool className="w-3 h-3 text-gray-500" />}
                                    <span className="font-mono text-xs truncate max-w-[120px]">{dim.text || 'Untitled'}</span>
                                </div>
                                <button onClick={(e) => { e.stopPropagation(); removeDimension(dim.id); }} className="text-gray-500 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
                            </div>
                        ))}
                    </div>
                )}
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
                    <div key={sign.id} onClick={() => { setActiveSign(sign.id); setToolMode('select'); }} className={`flex items-center justify-between p-3 rounded border cursor-pointer transition-all ${sign.id === activeCanvas.activeSignId ? 'bg-blue-900/20 border-blue-500/50 ring-1 ring-blue-500/50' : 'bg-gray-800 border-gray-700 hover:border-gray-600'}`}>
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
                          
                          {/* Sign Type Selector */}
                          <div>
                              <label className="text-xs text-gray-400 mb-1 block">Sign Type</label>
                              <select 
                                value={activeSign.signType || 'fascia_non_ill'} 
                                onChange={(e) => updateActiveSign({ signType: e.target.value as SignType })} 
                                className="w-full bg-gray-800 text-sm text-white border border-gray-600 rounded p-1"
                              >
                                {SIGN_TYPES.map(type => (
                                  <option key={type.value} value={type.value}>{type.label}</option>
                                ))}
                              </select>
                          </div>

                          <div className="space-y-4 pt-2">
                             <div className="flex items-center justify-between"><span className="text-xs text-gray-300">Extrusion 3D</span><input type="checkbox" checked={activeSign.extrusionEnabled} onChange={(e) => updateActiveSign({ extrusionEnabled: e.target.checked })} /></div>
                             {activeSign.extrusionEnabled && (
                                <>
                                   <div><div className="flex justify-between mb-1"><label className="text-xs text-gray-400">Depth</label><span className="text-xs text-gray-500">{activeSign.extrusionDepth}px</span></div><input type="range" min="0" max="100" value={activeSign.extrusionDepth} onChange={(e) => updateActiveSign({ extrusionDepth: parseInt(e.target.value) })} className="w-full h-2 bg-gray-700 rounded-lg accent-blue-500" /></div>
                                   <div><div className="flex justify-between mb-1"><label className="text-xs text-gray-400">Angle</label><span className="text-xs text-gray-500">{activeSign.extrusionAngle}°</span></div><input type="range" min="0" max="360" value={activeSign.extrusionAngle} onChange={(e) => updateActiveSign({ extrusionAngle: parseInt(e.target.value) })} className="w-full h-2 bg-gray-700 rounded-lg accent-blue-500" /></div>
                                   <div className="flex gap-2 items-center"><label className="text-xs text-gray-400">Color</label><input type="color" value={activeSign.sideColor} onChange={(e) => updateActiveSign({ sideColor: e.target.value })} className="bg-transparent border-none w-6 h-6 p-0" /></div>
                                </>
                             )}
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
                       {state.titleBlock.revisions.map((rev, idx) => (
                           <div key={rev.id} className="grid grid-cols-12 gap-1 text-xs">
                               <input value={rev.rev} onChange={(e) => {
                                   const newRevs = [...state.titleBlock.revisions]; newRevs[idx].rev = e.target.value;
                                   updateState({ titleBlock: { ...state.titleBlock, revisions: newRevs } });
                               }} className="col-span-1 bg-gray-800 border border-gray-700 rounded px-1 text-center" />
                               <input value={rev.date} onChange={(e) => {
                                   const newRevs = [...state.titleBlock.revisions]; newRevs[idx].date = e.target.value;
                                   updateState({ titleBlock: { ...state.titleBlock, revisions: newRevs } });
                               }} className="col-span-3 bg-gray-800 border border-gray-700 rounded px-1" />
                               <input value={rev.description} onChange={(e) => {
                                   const newRevs = [...state.titleBlock.revisions]; newRevs[idx].description = e.target.value;
                                   updateState({ titleBlock: { ...state.titleBlock, revisions: newRevs } });
                               }} className="col-span-6 bg-gray-800 border border-gray-700 rounded px-1" />
                               <div className="col-span-2 flex gap-1">
                                    <input value={rev.drawnBy} onChange={(e) => {
                                        const newRevs = [...state.titleBlock.revisions]; newRevs[idx].drawnBy = e.target.value;
                                        updateState({ titleBlock: { ...state.titleBlock, revisions: newRevs } });
                                    }} className="w-full bg-gray-800 border border-gray-700 rounded px-1 text-center" />
                                    <button onClick={() => {
                                        const newRevs = state.titleBlock.revisions.filter(r => r.id !== rev.id);
                                        updateStateWithHistory({ titleBlock: { ...state.titleBlock, revisions: newRevs } });
                                    }} className="text-red-400 hover:text-red-300"><X className="w-3 h-3" /></button>
                               </div>
                           </div>
                       ))}
                   </div>
                </div>

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

        <div className="p-4 md:p-6 border-t border-gray-700 bg-gray-800 flex-shrink-0">
          <button
            onClick={onDownload}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white py-3 rounded-lg font-semibold transition-colors shadow-lg shadow-blue-900/20"
          >
            <Download className="w-5 h-5" />
            Export PDF/PNG
          </button>
        </div>
      </div>

      <ImageUploader 
        isOpen={isUploaderOpen}
        onClose={() => setIsUploaderOpen(false)}
        onImageReady={handleImageReady}
      />
      
      <SignLibrary 
          isOpen={isLibraryOpen}
          onClose={() => setIsLibraryOpen(false)}
          onSelect={handleLibrarySelect}
          activeDimension={activeDimension}
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

export default ControlsPanel;
