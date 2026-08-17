
import React, { useState, useEffect } from 'react';
import { StorageService } from '../services/StorageService';
import { ProjectMetadata, MockupState } from '../types';
import { Save, FolderOpen, Trash2, X, Clock, FileImage, Layout, Loader2, Pencil, Check, AlertTriangle, Plus } from 'lucide-react';
import { notify } from '../services/toast';
import { reportError } from '../services/monitoring';

interface ProjectManagerProps {
    isOpen: boolean;
    onClose: () => void;
    currentState: MockupState;
    onLoadProject: (state: MockupState) => void;
    onSaveProject: (name: string) => void;
    onRenameProject: (id: string, name: string) => Promise<void>;
    onDeleteProject: (id: string) => Promise<void>;
    onNewProject: () => Promise<void>;
}

const ProjectManager: React.FC<ProjectManagerProps> = ({ isOpen, onClose, currentState, onLoadProject, onSaveProject, onRenameProject, onDeleteProject, onNewProject }) => {
    const [mode, setMode] = useState<'save' | 'load'>('load');
    const [projects, setProjects] = useState<ProjectMetadata[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [saveName, setSaveName] = useState(currentState.projectName || 'My Project');
    const [searchQuery, setSearchQuery] = useState('');
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState('');
    const [deleteTarget, setDeleteTarget] = useState<ProjectMetadata | null>(null);
    const [justSaved, setJustSaved] = useState(false);

    useEffect(() => {
        if (isOpen) {
            loadProjects();
            setSaveName(currentState.projectName || 'My Project');
            setJustSaved(false);
        }
    }, [isOpen]);

    const loadProjects = async () => {
        setIsLoading(true);
        try {
            const list = await StorageService.listProjects(currentState.user?.uid ?? 'guest_unknown');
            // Sort by newest first
            setProjects(list.sort((a, b) => b.lastModified - a.lastModified));
        } catch (e) {
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    const handleSave = async () => {
        if (!saveName.trim()) return;
        setIsLoading(true);
        try {
            await onSaveProject(saveName);
            notify('Project saved.', 'success');
            setJustSaved(true);
            setMode('load'); // Switch to load view to see it
            await loadProjects();
        } catch (error) {
            reportError('project-save', error);
            notify(error instanceof Error ? error.message : 'Project could not be saved.', 'error');
        } finally {
            setIsLoading(false);
        }
    };

    const handleLoad = async (id: string) => {
        setIsLoading(true);
        try {
            const project = await StorageService.loadProject(currentState.user?.uid ?? 'guest_unknown', id);
            if (project) {
                onLoadProject(project);
                onClose();
            }
        } catch (e) {
            reportError('project-load', e, { id });
            notify('Failed to load project.', 'error');
        } finally {
            setIsLoading(false);
        }
    };

    const handleRename = async () => {
        if (!editingId || !editName.trim()) return;
        setIsLoading(true);
        try {
            await onRenameProject(editingId, editName);
            setEditingId(null);
            notify('Project name updated.', 'success');
            await loadProjects();
        } catch (error) {
            reportError('project-rename', error, { id: editingId });
            notify(error instanceof Error ? error.message : 'Project could not be renamed.', 'error');
        } finally { setIsLoading(false); }
    };

    const handleDelete = async () => {
        if (!deleteTarget) return;
        setIsLoading(true);
        try {
            const wasCurrent = deleteTarget.id === currentState.projectId;
            await onDeleteProject(deleteTarget.id);
            notify(wasCurrent ? 'Project deleted. A new blank project is ready.' : 'Project deleted.', 'success');
            setDeleteTarget(null);
            if (wasCurrent) onClose();
            else await loadProjects();
        } catch (error) {
            reportError('project-delete', error, { id: deleteTarget.id });
            notify(error instanceof Error ? error.message : 'Project could not be deleted.', 'error');
        } finally { setIsLoading(false); }
    };

    const handleStartNew = async () => {
        setIsLoading(true);
        try {
            await onNewProject();
            setJustSaved(false);
            onClose();
        } catch (error) {
            reportError('project-new', error);
            notify(error instanceof Error ? error.message : 'A new project could not be started.', 'error');
        } finally { setIsLoading(false); }
    };

    const filteredProjects = projects.filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase()));

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
            <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[85vh] animate-in zoom-in-95 duration-200">
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-gray-700 bg-gray-800">
                    <h2 className="text-xl font-bold text-white flex items-center gap-2">
                        <FolderOpen className="w-6 h-6 text-blue-400" />
                        Project Manager
                    </h2>
                    <div className="flex items-center gap-2">
                        <button onClick={() => setMode('save')} aria-label="Save current project" className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-blue-600 px-3 text-xs font-bold text-white hover:bg-blue-500"><Save className="h-4 w-4" /> Save project</button>
                        <button onClick={onClose} aria-label="Close project manager" className="p-2 text-gray-400 hover:text-white rounded-full hover:bg-gray-700"><X className="w-5 h-5" /></button>
                    </div>
                </div>

                {/* Tabs */}
                <div className="flex border-b border-gray-700 bg-gray-800/50">
                    <button 
                        onClick={() => setMode('load')}
                        className={`flex-1 py-3 text-sm font-medium transition-colors border-b-2 ${mode === 'load' ? 'border-blue-500 text-blue-400 bg-gray-800' : 'border-transparent text-gray-400 hover:text-white'}`}
                    >
                        My Projects
                    </button>
                    <button 
                        onClick={() => setMode('save')}
                        className={`flex-1 py-3 text-sm font-medium transition-colors border-b-2 ${mode === 'save' ? 'border-blue-500 text-blue-400 bg-gray-800' : 'border-transparent text-gray-400 hover:text-white'}`}
                    >
                        Save Current
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-6 bg-gray-950">
                    {mode === 'save' && (
                        <div className="max-w-md mx-auto space-y-6 py-8">
                            <div className="text-center space-y-2">
                                <div className="w-16 h-16 bg-blue-900/30 rounded-full flex items-center justify-center mx-auto mb-4 border border-blue-500/30">
                                    <Save className="w-8 h-8 text-blue-400" />
                                </div>
                                <h3 className="text-xl font-semibold text-white">Save Project</h3>
                                <p className="text-sm text-gray-400">Save your work to the App Database (Browser Storage). <br/>This includes all images and assets.</p>
                            </div>

                            <div className="space-y-4">
                                <div>
                                    <label htmlFor="project-save-name" className="block text-xs font-bold text-gray-500 uppercase mb-1">Project Name</label>
                                    <input 
                                        id="project-save-name"
                                        type="text" 
                                        value={saveName}
                                        onChange={(e) => setSaveName(e.target.value)}
                                        className="w-full bg-gray-800 border border-gray-700 rounded-lg p-3 text-white focus:border-blue-500 outline-none"
                                        placeholder="e.g. Acme Facade V1"
                                    />
                                </div>
                                
                                <button 
                                    onClick={handleSave}
                                    disabled={isLoading || !saveName.trim()}
                                    className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 rounded-lg transition-all shadow-lg shadow-blue-900/20 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
                                    Save to Database
                                </button>
                                
                                <p className="text-xs text-center text-gray-500">
                                    Current ID: <span className="font-mono text-gray-600">{currentState.projectId}</span>
                                </p>
                            </div>
                        </div>
                    )}

                    {mode === 'load' && (
                        <div className="space-y-4">
                            {justSaved && (
                                <div data-testid="post-save-new-project" className="relative overflow-hidden rounded-xl border border-emerald-400/35 bg-emerald-400/10 p-4 shadow-[0_12px_35px_rgba(16,185,129,.08)]">
                                    <div className="absolute -right-8 -top-8 h-24 w-24 rounded-full border border-emerald-300/20" />
                                    <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                        <div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-400 text-gray-950"><Check className="h-5 w-5" /></span><div><p className="font-bold text-white">Project saved safely</p><p className="mt-0.5 text-xs text-emerald-100/70">Continue editing this project, or open a completely clean workspace.</p></div></div>
                                        <button onClick={handleStartNew} disabled={isLoading} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-white px-4 text-sm font-bold text-gray-950 hover:bg-emerald-50 disabled:opacity-50"><Plus className="h-4 w-4" /> Start new project</button>
                                    </div>
                                </div>
                            )}
                            <div className="flex gap-2">
                                <div className="relative flex-1">
                                    <input 
                                        type="text"
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        placeholder="Search projects..."
                                        className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-4 pr-4 py-2 text-sm text-white focus:border-blue-500 outline-none"
                                    />
                                </div>
                            </div>

                            {isLoading ? (
                                <div className="flex justify-center py-10">
                                    <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
                                </div>
                            ) : filteredProjects.length === 0 ? (
                                <div className="text-center py-10 text-gray-500">
                                    <FolderOpen className="w-12 h-12 mx-auto mb-3 opacity-20" />
                                    <p>No projects found.</p>
                                    <button onClick={() => setMode('save')} className="text-blue-400 hover:underline text-sm mt-2">Save your current work</button>
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    {filteredProjects.map((project) => (
                                        <div 
                                            key={project.id} 
                                            onClick={() => handleLoad(project.id)}
                                            className={`bg-gray-800 border ${currentState.projectId === project.id ? 'border-blue-500 ring-1 ring-blue-500/50' : 'border-gray-700 hover:border-gray-500'} rounded-lg overflow-hidden cursor-pointer group transition-all`}
                                        >
                                            <div className="flex h-full">
                                                <div className="w-24 bg-gray-900 flex-shrink-0 flex items-center justify-center border-r border-gray-700">
                                                    {project.thumbnail ? (
                                                        <img src={project.thumbnail} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
                                                    ) : (
                                                        <FileImage className="w-8 h-8 text-gray-600" />
                                                    )}
                                                </div>
                                                <div className="flex-1 p-3 flex flex-col justify-between min-w-0">
                                                    <div>
                                                        {editingId === project.id ? (
                                                            <div className="flex items-center gap-1" onClick={event => event.stopPropagation()}>
                                                                <input autoFocus aria-label={`Edit project name ${project.name}`} value={editName} onChange={event => setEditName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void handleRename(); if (event.key === 'Escape') setEditingId(null); }} className="min-w-0 flex-1 rounded border border-blue-500 bg-gray-950 px-2 py-1 text-sm text-white outline-none" />
                                                                <button onClick={handleRename} disabled={!editName.trim() || isLoading} aria-label="Save project name" className="grid h-8 w-8 place-items-center rounded bg-emerald-500 text-gray-950 hover:bg-emerald-400 disabled:opacity-40"><Check className="h-4 w-4" /></button>
                                                                <button onClick={() => setEditingId(null)} aria-label="Cancel editing project name" className="grid h-8 w-8 place-items-center rounded bg-gray-700 text-gray-300 hover:bg-gray-600"><X className="h-4 w-4" /></button>
                                                            </div>
                                                        ) : <h4 className="truncate pr-2 font-medium text-white" title={project.name}>{project.name}</h4>}
                                                        <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                                                            <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {new Date(project.lastModified).toLocaleDateString()}</span>
                                                            <span className="flex items-center gap-1"><Layout className="w-3 h-3" /> {project.canvasCount} Views</span>
                                                        </div>
                                                    </div>
                                                    <div className="flex justify-between items-end mt-2 gap-2">
                                                        <span className="text-[10px] text-gray-600 font-mono">{project.id.slice(-8)}</span>
                                                        <div className="flex items-center gap-1" onClick={event => event.stopPropagation()}>
                                                            <button onClick={() => { setEditingId(project.id); setEditName(project.name); }} aria-label={`Edit project ${project.name}`} className="inline-flex min-h-8 items-center gap-1 rounded px-2 text-[11px] font-semibold text-gray-300 hover:bg-gray-700 hover:text-white"><Pencil className="h-3.5 w-3.5" /> Edit</button>
                                                            <button onClick={() => setDeleteTarget(project)} aria-label={`Delete project ${project.name}`} className="inline-flex min-h-8 items-center gap-1 rounded px-2 text-[11px] font-semibold text-red-300 hover:bg-red-950/60"><Trash2 className="h-3.5 w-3.5" /> Delete</button>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
            {deleteTarget && (
                <div className="absolute inset-0 z-10 grid place-items-center bg-black/65 p-5 backdrop-blur-sm">
                    <div role="alertdialog" aria-modal="true" aria-labelledby="delete-project-title" className="w-full max-w-sm rounded-2xl border border-red-500/35 bg-gray-900 p-5 shadow-2xl shadow-black/60">
                        <div className="mb-4 flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-red-500/15 text-red-300"><AlertTriangle className="h-5 w-5" /></span><div><h3 id="delete-project-title" className="font-bold text-white">Delete “{deleteTarget.name}”?</h3><p className="mt-1 text-sm text-gray-400">This permanently removes the local project{currentState.user && !currentState.user.uid.startsWith('guest_') ? ' and its cloud copy' : ''}. This action cannot be undone.</p></div></div>
                        {deleteTarget.id === currentState.projectId && <p className="mb-4 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">This project is currently open. A new blank project will replace it after deletion.</p>}
                        <div className="flex justify-end gap-2"><button onClick={() => setDeleteTarget(null)} disabled={isLoading} className="min-h-10 rounded-lg px-4 text-sm font-semibold text-gray-300 hover:bg-gray-800">Cancel</button><button onClick={handleDelete} disabled={isLoading} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-red-600 px-4 text-sm font-bold text-white hover:bg-red-500 disabled:opacity-50">{isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Delete project</button></div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ProjectManager;
