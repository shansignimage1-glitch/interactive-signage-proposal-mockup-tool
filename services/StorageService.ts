
import { db } from '../firebase';
import { MockupState, ProjectMetadata } from '../types';

const FIRESTORE_COLLECTION = 'projects';
const DB_NAME = 'SignageProDB';
const STORE_PROJECTS = 'projects';
const STORE_METADATA = 'metadata';
const DB_VERSION = 2; // Incremented for new stores

// --- IndexedDB Wrapper ---

// Cached promise — only one DB connection opened for the lifetime of the page
let _dbPromise: Promise<IDBDatabase> | null = null;

const initDB = (): Promise<IDBDatabase> => {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => {
      _dbPromise = null; // allow retry on next call
      reject(request.error);
    };
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Store for full project data (JSON)
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'projectId' });
      }

      // Store for lightweight metadata (Lists)
      if (!db.objectStoreNames.contains(STORE_METADATA)) {
        db.createObjectStore(STORE_METADATA, { keyPath: 'id' });
      }
    };
  });

  return _dbPromise;
};

const idbOperation = async <T>(
    storeName: string, 
    mode: IDBTransactionMode, 
    operation: (store: IDBObjectStore) => IDBRequest<T> | void
): Promise<T> => {
    const db = await initDB();
    return new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const req = operation(store);
        
        if (req) {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        } else {
             tx.oncomplete = () => resolve(undefined as unknown as T);
             tx.onerror = () => reject(tx.error);
        }
    });
};

export const StorageService = {
  
  // --- Local Project Management (IndexedDB) ---

  saveProjectLocal: async (state: MockupState, thumbnail?: string): Promise<void> => {
      const { projectId, projectName, lastSaved } = state;
      const metadata: ProjectMetadata = {
          id: projectId,
          name: projectName,
          lastModified: lastSaved,
          canvasCount: state.canvases.length,
          thumbnail: thumbnail || undefined
      };

      // Save Full Data
      await idbOperation(STORE_PROJECTS, 'readwrite', (store) => store.put(state));
      // Save Metadata
      await idbOperation(STORE_METADATA, 'readwrite', (store) => store.put(metadata));
  },

  loadProjectLocal: async (projectId: string): Promise<MockupState | null> => {
      return await idbOperation<MockupState>(STORE_PROJECTS, 'readonly', (store) => store.get(projectId));
  },

  listProjectsLocal: async (): Promise<ProjectMetadata[]> => {
      return await idbOperation<ProjectMetadata[]>(STORE_METADATA, 'readonly', (store) => store.getAll());
  },

  deleteProjectLocal: async (projectId: string): Promise<void> => {
      await idbOperation(STORE_PROJECTS, 'readwrite', (store) => store.delete(projectId));
      await idbOperation(STORE_METADATA, 'readwrite', (store) => store.delete(projectId));
  },

  // --- Cloud Sync (Legacy / Future) ---
  
  // Note: We currently prefer Local DB for full asset saving as it is more robust for large Base64 strings 
  // without requiring a full Firebase Storage implementation for this scope.
  // This satisfies "Save in App Database" by using the Browser's persistent database.
  
  saveProject: async (userId: string, state: MockupState): Promise<'cloud' | 'local' | 'error'> => {
      // 1. Always save to Local DB
      try {
          await StorageService.saveProjectLocal(state);
      } catch (e) {
          console.error("Local save failed", e);
          return 'error';
      }
      
      return 'local';
  }
};
