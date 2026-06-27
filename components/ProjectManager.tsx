
import React, { useState, useEffect } from 'react';
import { StorageService } from '../services/StorageService';
import { ProjectMetadata, MockupState } from '../types';
import { Save, FolderOpen, Trash2, X, Plus, Clock, FileImage, Layout, Loader2 } from 'lucide-react';

interface ProjectManagerProps {
    isOpen: boolean;
    onClose: () => void;
    currentState: MockupState;
    onLoadProject: (state: MockupState) => void;
    onSaveProject: (name: string) => void;
}

const ProjectManager: React.FC<ProjectManagerProps> = ({ isOpen, onClose, currentState, onLoadProject, onSaveProject }) => {
    const [mode, setMode] = useState<'save' | 'load'>('load');
    const [projects, setProjects] = useState<ProjectMetadata[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [saveName, setSaveName] = useState(currentState.projectName || 'My Project');
    const [searchQuery, setSearchQuery] = useState('');

    useEffect(() => {
        if (isOpen) {
            loadProjects();
            setSaveName(currentState.projectName || 'My Project');
        }
    }, [isOpen, currentState.projectName]);

    const loadProjects = async () => {
        setIsLoading(true);
        try {
            const list = await StorageService.listProjectsLocal();
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
            setMode('load'); // Switch to load view to see it
            loadProjects();
        } finally {
            setIsLoading(false);
        }
    };

    const handleLoad = async (id: string) => {
        setIsLoading(true);
        try {
            const project = await StorageService.loadProjectLocal(id);
            if (project) {
                onLoadProject(project);
                onClose();
            }
        } catch (e) {
            alert("Failed to load project.");
        } finally {
            setIsLoading(false);
        }
    };

    const handleDelete = async (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (confirm("Are you sure you want to delete this project? This cannot be undone.")) {
            await StorageService.deleteProjectLocal(id);
            loadProjects();
        }
    };

    const filteredProjects = projects.filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase()));

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
            <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[85vh] animate-in zoom-in-95 duration-200">
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-gray-700 bg-gray-800">
                    <h2 className="text-xl font-bold text-white flex items-center gap-2">
                        <FolderOpen className="w-6 h-6 text-blue-400" />
                        Project Manager
                    </h2>
                    <button onClick={onClose} className="p-2 text-gray-400 hover:text-white rounded-full hover:bg-gray-700">
                        <X className="w-5 h-5" />
                    </button>
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
                                    <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Project Name</label>
                                    <input 
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
                                                        <h4 className="text-white font-medium truncate pr-6" title={project.name}>{project.name}</h4>
                                                        <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                                                            <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {new Date(project.lastModified).toLocaleDateString()}</span>
                                                            <span className="flex items-center gap-1"><Layout className="w-3 h-3" /> {project.canvasCount} Views</span>
                                                        </div>
                                                    </div>
                                                    <div className="flex justify-between items-end mt-2">
                                                        <span className="text-[10px] text-gray-600 font-mono">{project.id.slice(-8)}</span>
                                                        <button 
                                                            onClick={(e) => handleDelete(project.id, e)}
                                                            className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-gray-700 rounded transition-colors"
                                                            title="Delete Project"
                                                        >
                                                            <Trash2 className="w-4 h-4" />
                                                        </button>
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
        </div>
    );
};

export default ProjectManager;
