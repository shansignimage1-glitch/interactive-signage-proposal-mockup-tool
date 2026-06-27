
import React, { useState, useEffect } from 'react';
import { BRANDS } from '../data/brands';
import { Brand, Dimension, SignTemplate, CloudProvider } from '../types';
import { Search, Sparkles, X, LayoutGrid, Cloud, Loader2, HardDrive } from 'lucide-react';
import { CloudService } from '../services/CloudService';

interface SignLibraryProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (template: SignTemplate) => void;
  activeDimension?: Dimension;
}

const SignLibrary: React.FC<SignLibraryProps> = ({ isOpen, onClose, onSelect, activeDimension }) => {
  const [selectedBrandId, setSelectedBrandId] = useState<string>(BRANDS[0].id);
  const [suggestions, setSuggestions] = useState<SignTemplate[]>([]);
  const [isImporting, setIsImporting] = useState<CloudProvider | null>(null);

  const selectedBrand = BRANDS.find(b => b.id === selectedBrandId) || BRANDS[0];

  useEffect(() => {
    if (activeDimension && activeDimension.variant === 'box') {
        // Calculate Dimension Aspect Ratio
        const dimW = Math.abs(activeDimension.end.x - activeDimension.start.x);
        const dimH = Math.abs(activeDimension.end.y - activeDimension.start.y);
        const dimRatio = dimW / dimH;

        // Try to parse text number (e.g. "3000")
        const textNum = parseInt(activeDimension.text.replace(/[^0-9]/g, ''));
        const hasTextNum = !isNaN(textNum) && textNum > 0;

        // Flatten all templates from all brands for suggestions
        const allTemplates = BRANDS.flatMap(b => b.templates);

        const scored = allTemplates.map(t => {
            const tRatio = t.width / t.height;
            // Lower score is better
            let score = Math.abs(tRatio - dimRatio);
            
            // If text matches real world size, boost significantly
            if (hasTextNum) {
                // Check if text matches Width OR Height within 15%
                if (Math.abs(t.width - textNum) / t.width < 0.15) score -= 2;
                if (Math.abs(t.height - textNum) / t.height < 0.15) score -= 2;
            }

            return { t, score };
        });

        // Filter valid matches and sort
        const top = scored.sort((a, b) => a.score - b.score).slice(0, 3).map(i => i.t);
        setSuggestions(top);
    } else {
        setSuggestions([]);
    }
  }, [activeDimension]);

  const handleCloudImport = async (provider: CloudProvider) => {
      setIsImporting(provider);
      try {
          const template = await CloudService.importFromProvider(provider);
          if (template) {
              onSelect(template);
              onClose();
          }
      } catch (e) {
          alert("Failed to import from cloud provider.");
      } finally {
          setIsImporting(null);
      }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-4xl h-[80vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
        
        {/* Header */}
        <div className="p-4 border-b border-gray-700 flex items-center justify-between bg-gray-800">
            <div className="flex items-center gap-3">
                <LayoutGrid className="w-6 h-6 text-blue-400" />
                <h2 className="text-xl font-bold text-white">Asset Library</h2>
            </div>
            <button onClick={onClose} className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-full">
                <X className="w-5 h-5" />
            </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
            {/* Sidebar: Brands & Sources */}
            <div className="w-64 border-r border-gray-700 bg-gray-800/50 flex flex-col overflow-y-auto">
                <div className="p-4">
                    <label className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 block">Cloud Import</label>
                    <div className="space-y-2 mb-6">
                         <button onClick={() => handleCloudImport('google_drive')} disabled={!!isImporting} className="w-full flex items-center gap-3 p-2 rounded bg-gray-800 border border-gray-700 hover:bg-gray-700 hover:border-gray-500 transition-all text-sm text-gray-300">
                             {isImporting === 'google_drive' ? <Loader2 className="w-4 h-4 animate-spin" /> : <HardDrive className="w-4 h-4 text-blue-500" />}
                             Google Drive
                         </button>
                         <button onClick={() => handleCloudImport('onedrive')} disabled={!!isImporting} className="w-full flex items-center gap-3 p-2 rounded bg-gray-800 border border-gray-700 hover:bg-gray-700 hover:border-gray-500 transition-all text-sm text-gray-300">
                             {isImporting === 'onedrive' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Cloud className="w-4 h-4 text-blue-300" />}
                             OneDrive
                         </button>
                         <button onClick={() => handleCloudImport('dropbox')} disabled={!!isImporting} className="w-full flex items-center gap-3 p-2 rounded bg-gray-800 border border-gray-700 hover:bg-gray-700 hover:border-gray-500 transition-all text-sm text-gray-300">
                             {isImporting === 'dropbox' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Cloud className="w-4 h-4 text-indigo-400" />}
                             Dropbox
                         </button>
                    </div>

                    <label className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 block">Internal Brands</label>
                    <div className="space-y-1">
                        {BRANDS.map(brand => (
                            <button
                                key={brand.id}
                                onClick={() => setSelectedBrandId(brand.id)}
                                className={`w-full flex items-center gap-3 p-3 rounded-lg transition-all ${selectedBrandId === brand.id ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-400 hover:bg-gray-700 hover:text-white'}`}
                            >
                                <div className="w-8 h-8 bg-white rounded-full p-1 flex items-center justify-center">
                                    <img src={brand.logo} alt={brand.name} className="w-full h-full object-contain" />
                                </div>
                                <span className="font-medium">{brand.name}</span>
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* Main Content */}
            <div className="flex-1 overflow-y-auto p-6 bg-gray-900">
                
                {/* Suggestions Section */}
                {suggestions.length > 0 && (
                    <div className="mb-8">
                        <div className="flex items-center gap-2 mb-4">
                            <Sparkles className="w-5 h-5 text-yellow-400" />
                            <h3 className="text-lg font-semibold text-white">Suggested for Dimensions</h3>
                            <span className="text-xs text-gray-400 bg-gray-800 px-2 py-0.5 rounded border border-gray-700">
                                Based on {activeDimension?.variant} ratio
                            </span>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                            {suggestions.map((template, idx) => (
                                <TemplateCard key={`sugg-${idx}`} template={template} onClick={() => onSelect(template)} isSuggestion />
                            ))}
                        </div>
                    </div>
                )}

                {/* Library Grid */}
                <div>
                    <h3 className="text-lg font-semibold text-white mb-4">{selectedBrand.name} Catalog</h3>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                        {selectedBrand.templates.map((template) => (
                             <TemplateCard key={template.id} template={template} onClick={() => onSelect(template)} />
                        ))}
                    </div>
                </div>
            </div>
        </div>

      </div>
    </div>
  );
};

const TemplateCard: React.FC<{ template: SignTemplate, onClick: () => void, isSuggestion?: boolean }> = ({ template, onClick, isSuggestion }) => (
    <div 
        onClick={onClick}
        className={`group relative aspect-video bg-gray-800 rounded-lg border overflow-hidden cursor-pointer transition-all hover:scale-[1.02] ${isSuggestion ? 'border-yellow-500/50 ring-1 ring-yellow-500/20' : 'border-gray-700 hover:border-blue-500'}`}
    >
        <div className="absolute inset-0 p-4 flex items-center justify-center">
            <img src={template.image} alt={template.name} className="max-w-full max-h-full object-contain drop-shadow-2xl" />
        </div>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-3 pt-8">
            <p className="text-white font-medium text-sm truncate">{template.name}</p>
            <div className="flex justify-between items-center mt-1">
                <span className="text-xs text-gray-400">{template.category}</span>
                <span className="text-[10px] text-gray-500 bg-black/50 px-1.5 py-0.5 rounded">{template.width}x{template.height}mm</span>
            </div>
        </div>
    </div>
);

export default SignLibrary;
