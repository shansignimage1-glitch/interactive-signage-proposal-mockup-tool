
import React, { useState, useEffect, useMemo } from 'react';
import { BRANDS } from '../data/brands';
import { Dimension, SignTemplate, Sign, UserProfile } from '../types';
import { Sparkles, X, LayoutGrid, Loader2, User as UserIcon, Trash2, UploadCloud, BookmarkPlus, Globe, LogIn } from 'lucide-react';
import { LibraryService, isLibraryAdmin, materializeDataUri, NewTemplateInput } from '../services/LibraryService';

interface SignLibraryProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (template: SignTemplate) => void;
  activeDimension?: Dimension;
  user?: UserProfile | null;
  activeSign?: Sign | null;
}

type LibTab = 'catalog' | 'personal';

// Categories the ControlsPanel's mapCategoryToType understands
const CATEGORY_OPTIONS = ['Fascia', 'Projecting', 'Pylon', 'Totem', 'Window'];

const SignLibrary: React.FC<SignLibraryProps> = ({ isOpen, onClose, onSelect, activeDimension, user, activeSign }) => {
  const [selectedBrandId, setSelectedBrandId] = useState<string>(BRANDS[0].id);
  const [tab, setTab] = useState<LibTab>('catalog');

  const [shared, setShared] = useState<SignTemplate[]>([]);
  const [personal, setPersonal] = useState<SignTemplate[]>([]);
  const [isLoadingCloud, setIsLoadingCloud] = useState(false);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // template id or action key

  // Save/upload form state (used by both "save active sign" and file upload)
  const [form, setForm] = useState<{ dataUri: string; name: string; category: string; widthMm: number; heightMm: number; publishShared: boolean } | null>(null);

  const isGuest = !user || user.uid.startsWith('guest_');
  const admin = isLibraryAdmin(user?.email);

  const SHARED_BRAND_ID = '__shared__';

  // Load cloud catalogs when the modal opens for a signed-in user
  useEffect(() => {
    if (!isOpen || isGuest) return;
    let cancelled = false;
    setIsLoadingCloud(true);
    setCloudError(null);
    Promise.all([
      LibraryService.listShared(),
      LibraryService.listPersonal(user!.uid),
    ]).then(([s, p]) => {
      if (cancelled) return;
      setShared(s);
      setPersonal(p);
    }).catch(e => {
      if (!cancelled) setCloudError(e?.message ?? 'Could not load cloud library');
    }).finally(() => {
      if (!cancelled) setIsLoadingCloud(false);
    });
    return () => { cancelled = true; };
  }, [isOpen, isGuest, user?.uid]);

  // Suggestions score across ALL sources: builtin + shared + personal
  const suggestions = useMemo(() => {
    if (!activeDimension || activeDimension.variant !== 'box') return [];
    const dimW = Math.abs(activeDimension.end.x - activeDimension.start.x);
    const dimH = Math.abs(activeDimension.end.y - activeDimension.start.y);
    if (dimH === 0) return [];
    const dimRatio = dimW / dimH;

    const textNum = parseInt(activeDimension.text.replace(/[^0-9]/g, ''));
    const hasTextNum = !isNaN(textNum) && textNum > 0;

    const allTemplates = [...BRANDS.flatMap(b => b.templates), ...shared, ...personal];
    const scored = allTemplates.map(t => {
      const tRatio = t.width / t.height;
      let score = Math.abs(tRatio - dimRatio);
      if (hasTextNum) {
        if (Math.abs(t.width - textNum) / t.width < 0.15) score -= 2;
        if (Math.abs(t.height - textNum) / t.height < 0.15) score -= 2;
      }
      return { t, score };
    });
    return scored.sort((a, b) => a.score - b.score).slice(0, 3).map(i => i.t);
  }, [activeDimension, shared, personal]);

  if (!isOpen) return null;

  const openSaveActiveSignForm = async () => {
    if (!activeSign) return;
    setBusy('materialize');
    setCloudError(null);
    try {
      const dataUri = await materializeDataUri(activeSign.image);
      setForm({
        dataUri,
        name: activeSign.name,
        category: 'Fascia',
        widthMm: 2000,
        heightMm: 500,
        publishShared: false,
      });
    } catch (e: any) {
      setCloudError(e?.message ?? 'Could not read the sign image');
    } finally {
      setBusy(null);
    }
  };

  const handleUploadFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      setForm({
        dataUri: reader.result as string,
        name: file.name.replace(/\.[^.]+$/, ''),
        category: 'Fascia',
        widthMm: 2000,
        heightMm: 500,
        publishShared: false,
      });
    };
    reader.readAsDataURL(file);
  };

  const submitForm = async () => {
    if (!form || isGuest) return;
    setBusy('save');
    setCloudError(null);
    const input: NewTemplateInput = {
      name: form.name.trim() || 'Untitled Sign',
      category: form.category,
      widthMm: form.widthMm,
      heightMm: form.heightMm,
      dataUri: form.dataUri,
    };
    try {
      if (form.publishShared && admin) {
        const t = await LibraryService.saveToShared(input);
        setShared(prev => [...prev.filter(x => x.id !== t.id), t].sort((a, b) => a.name.localeCompare(b.name)));
      } else {
        const t = await LibraryService.saveToPersonal(user!.uid, input);
        setPersonal(prev => [...prev.filter(x => x.id !== t.id), t].sort((a, b) => a.name.localeCompare(b.name)));
        setTab('personal');
      }
      setForm(null);
    } catch (e: any) {
      setCloudError(e?.message ?? 'Save failed');
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (template: SignTemplate) => {
    if (!template.docId) return;
    setBusy(template.id);
    try {
      if (template.source === 'personal') {
        await LibraryService.deletePersonal(template);
        setPersonal(prev => prev.filter(t => t.id !== template.id));
      } else if (template.source === 'shared' && admin) {
        await LibraryService.deleteShared(template);
        setShared(prev => prev.filter(t => t.id !== template.id));
      }
    } catch (e: any) {
      setCloudError(e?.message ?? 'Delete failed');
    } finally {
      setBusy(null);
    }
  };

  const selectedBrand = BRANDS.find(b => b.id === selectedBrandId);
  const catalogTemplates = selectedBrandId === SHARED_BRAND_ID ? shared : (selectedBrand?.templates ?? []);
  const catalogTitle = selectedBrandId === SHARED_BRAND_ID ? 'Shared Library' : `${selectedBrand?.name} Catalog`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-4xl h-[80vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">

        {/* Header */}
        <div className="p-4 border-b border-gray-700 flex items-center justify-between bg-gray-800">
            <div className="flex items-center gap-3">
                <LayoutGrid className="w-6 h-6 text-blue-400" />
                <h2 className="text-xl font-bold text-white">Asset Library</h2>
                <div className="flex bg-gray-900 rounded-lg border border-gray-700 overflow-hidden ml-2">
                    <button onClick={() => setTab('catalog')} className={`px-3 py-1.5 text-xs font-semibold transition-colors ${tab === 'catalog' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>Catalog</button>
                    <button onClick={() => setTab('personal')} className={`px-3 py-1.5 text-xs font-semibold transition-colors flex items-center gap-1 ${tab === 'personal' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                        <UserIcon className="w-3 h-3" /> My Library {personal.length > 0 && <span className="bg-black/40 rounded px-1">{personal.length}</span>}
                    </button>
                </div>
            </div>
            <div className="flex items-center gap-2">
                {!isGuest && activeSign && (
                    <button
                        onClick={openSaveActiveSignForm}
                        disabled={busy === 'materialize'}
                        className="flex items-center gap-1.5 text-xs font-semibold bg-gray-700 hover:bg-gray-600 text-purple-300 px-3 py-2 rounded-lg border border-gray-600"
                        title="Save the selected sign's artwork into your cloud library"
                    >
                        {busy === 'materialize' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BookmarkPlus className="w-3.5 h-3.5" />}
                        Save Current Sign
                    </button>
                )}
                <button onClick={onClose} className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-full">
                    <X className="w-5 h-5" />
                </button>
            </div>
        </div>

        {cloudError && (
            <div className="px-4 py-2 bg-red-950/60 border-b border-red-900 text-red-300 text-xs">{cloudError}</div>
        )}

        <div className="flex flex-1 overflow-hidden">
            {/* Sidebar (catalog tab only) */}
            {tab === 'catalog' && (
                <div className="w-64 border-r border-gray-700 bg-gray-800/50 flex flex-col overflow-y-auto">
                    <div className="p-4">
                        {!isGuest && (
                            <>
                                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 block">Cloud</label>
                                <div className="space-y-1 mb-6">
                                    <button
                                        onClick={() => setSelectedBrandId(SHARED_BRAND_ID)}
                                        className={`w-full flex items-center gap-3 p-3 rounded-lg transition-all ${selectedBrandId === SHARED_BRAND_ID ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-400 hover:bg-gray-700 hover:text-white'}`}
                                    >
                                        <div className="w-8 h-8 bg-blue-950 rounded-full flex items-center justify-center">
                                            <Globe className="w-4 h-4 text-blue-300" />
                                        </div>
                                        <span className="font-medium">Shared Library</span>
                                        {isLoadingCloud
                                            ? <Loader2 className="w-3 h-3 animate-spin ml-auto" />
                                            : <span className="text-xs ml-auto opacity-70">{shared.length}</span>}
                                    </button>
                                </div>
                            </>
                        )}

                        <label className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 block">Built-in Brands</label>
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
            )}

            {/* Main Content */}
            <div className="flex-1 overflow-y-auto p-6 bg-gray-900">

                {/* Suggestions */}
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

                {tab === 'catalog' ? (
                    <div>
                        <h3 className="text-lg font-semibold text-white mb-4">{catalogTitle}</h3>
                        {selectedBrandId === SHARED_BRAND_ID && shared.length === 0 && !isLoadingCloud && (
                            <p className="text-sm text-gray-500">No shared templates yet.{admin ? ' Use "Save Current Sign" and tick "Publish to shared library" to add the first one.' : ''}</p>
                        )}
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                            {catalogTemplates.map((template) => (
                                <TemplateCard
                                    key={template.id}
                                    template={template}
                                    onClick={() => onSelect(template)}
                                    onDelete={admin && template.source === 'shared' ? () => handleDelete(template) : undefined}
                                    deleting={busy === template.id}
                                />
                            ))}
                        </div>
                    </div>
                ) : (
                    <div>
                        <h3 className="text-lg font-semibold text-white mb-4">My Library</h3>
                        {isGuest ? (
                            <div className="text-center py-16 text-gray-500">
                                <LogIn className="w-8 h-8 mx-auto mb-3 opacity-60" />
                                <p className="text-sm">Sign in with Google to build your personal cloud sign library.</p>
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                                {/* Upload card */}
                                <label className="aspect-video rounded-lg border-2 border-dashed border-gray-700 hover:border-blue-500 cursor-pointer flex flex-col items-center justify-center text-gray-500 hover:text-blue-400 transition-colors">
                                    <UploadCloud className="w-8 h-8 mb-2" />
                                    <span className="text-xs font-semibold">Upload sign image</span>
                                    <input
                                        type="file"
                                        accept="image/*"
                                        className="hidden"
                                        onChange={e => { const f = e.target.files?.[0]; if (f) handleUploadFile(f); e.target.value = ''; }}
                                    />
                                </label>
                                {personal.map((template) => (
                                    <TemplateCard
                                        key={template.id}
                                        template={template}
                                        onClick={() => onSelect(template)}
                                        onDelete={() => handleDelete(template)}
                                        deleting={busy === template.id}
                                    />
                                ))}
                            </div>
                        )}
                        {!isGuest && personal.length === 0 && !isLoadingCloud && (
                            <p className="text-sm text-gray-500 mt-4">Nothing saved yet — upload an image or use "Save Current Sign".</p>
                        )}
                    </div>
                )}
            </div>
        </div>

        {/* Save-to-library form */}
        {form && (
            <div className="absolute inset-0 z-10 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setForm(null)}>
                <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl p-5 w-full max-w-md" onClick={e => e.stopPropagation()}>
                    <h3 className="text-white font-bold mb-4 flex items-center gap-2"><BookmarkPlus className="w-5 h-5 text-purple-400" /> Save to Library</h3>
                    <div className="aspect-video bg-gray-800 rounded-lg mb-4 flex items-center justify-center p-3 border border-gray-700">
                        <img src={form.dataUri} alt="" className="max-w-full max-h-full object-contain" />
                    </div>
                    <div className="space-y-3">
                        <input
                            value={form.name}
                            onChange={e => setForm({ ...form, name: e.target.value })}
                            placeholder="Template name"
                            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:border-blue-500 outline-none"
                        />
                        <div className="grid grid-cols-3 gap-2">
                            <select
                                value={form.category}
                                onChange={e => setForm({ ...form, category: e.target.value })}
                                className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white outline-none"
                            >
                                {CATEGORY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                            <input
                                type="number" min={1}
                                value={form.widthMm}
                                onChange={e => setForm({ ...form, widthMm: parseInt(e.target.value) || 0 })}
                                title="Width (mm)"
                                className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white outline-none"
                            />
                            <input
                                type="number" min={1}
                                value={form.heightMm}
                                onChange={e => setForm({ ...form, heightMm: parseInt(e.target.value) || 0 })}
                                title="Height (mm)"
                                className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white outline-none"
                            />
                        </div>
                        <p className="text-[10px] text-gray-500 -mt-1">Category · Width (mm) · Height (mm)</p>
                        {admin && (
                            <label className="flex items-center gap-2 text-xs text-gray-300">
                                <input
                                    type="checkbox"
                                    checked={form.publishShared}
                                    onChange={e => setForm({ ...form, publishShared: e.target.checked })}
                                />
                                <Globe className="w-3 h-3 text-blue-400" /> Publish to shared library (visible to all users)
                            </label>
                        )}
                        <div className="flex gap-2 pt-1">
                            <button onClick={() => setForm(null)} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 py-2 rounded-lg text-sm border border-gray-700">Cancel</button>
                            <button
                                onClick={submitForm}
                                disabled={busy === 'save' || !form.dataUri}
                                className="flex-1 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-2"
                            >
                                {busy === 'save' && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        )}

      </div>
    </div>
  );
};

const TemplateCard: React.FC<{ template: SignTemplate, onClick: () => void, isSuggestion?: boolean, onDelete?: () => void, deleting?: boolean }> = ({ template, onClick, isSuggestion, onDelete, deleting }) => (
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
        {onDelete && (
            <button
                onClick={e => { e.stopPropagation(); onDelete(); }}
                className="absolute top-2 right-2 p-1.5 rounded-full bg-black/60 text-red-400 opacity-0 group-hover:opacity-100 hover:bg-red-950 transition-opacity"
                title="Delete from library"
            >
                {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            </button>
        )}
    </div>
);

export default SignLibrary;
