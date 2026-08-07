import type { MockupState } from '../../types';

export const makeProject = (overrides: Partial<MockupState> = {}): MockupState => ({
  user: { uid: 'user-1', displayName: 'Test User', email: 'test@example.com', photoURL: null },
  projectId: 'project-1',
  projectName: 'Test Project',
  canvases: [{
    id: 'canvas-1', name: 'Facade', backgroundImage: '', backgroundSize: { width: 1000, height: 500 },
    signs: [], activeSignId: null, dimensions: [], activeDimensionId: null,
    calibration: null, sheetTitle: 'Facade', sheetNumber: '01',
  }],
  activeCanvasId: 'canvas-1',
  isNightMode: false,
  showDimensions: true,
  unitSystem: 'metric',
  titleBlock: {
    enabled: false, viewMode: 'canvas', paperSize: 'A3', orientation: 'landscape',
    style: { id: 'default', name: 'Default', layout: 'vertical-right', headerColor: '#000', textColor: '#000', backgroundColor: '#fff', fontFamily: 'Arial', logoPosition: 'top' },
    logoImage: null, fields: [], revisions: [],
  },
  savedTemplates: [], notes: '', referenceImages: [], lastSaved: 1,
  isOnline: true, isSyncing: false,
  ...overrides,
});
