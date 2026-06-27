

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export type SignType = 
  | 'fascia_non_ill'
  | 'fascia_ill'
  | 'channel_face'
  | 'channel_face_alu'
  | 'channel_face_side'
  | 'channel_halo'
  | 'channel_face_halo'
  | 'lightbox_cabinet'
  | 'blade_sign'
  | 'flat_cut_standoff'
  | 'totem'
  | 'window_vinyl'
  | 'awning';

export const SIGN_TYPES: { value: SignType; label: string }[] = [
  { value: 'fascia_non_ill', label: 'Fascia Panel (Non-Illuminated)' },
  { value: 'fascia_ill', label: 'Fascia Panel / Tray (Illuminated)' },
  { value: 'channel_face', label: 'Channel Letters (Face Lit - Standard)' },
  { value: 'channel_face_alu', label: 'Channel Letters (Plexiglass Front / Solid Alu Returns)' },
  { value: 'channel_face_side', label: 'Plexiglass Channel Letters (Front & Side Lit)' },
  { value: 'channel_halo', label: 'Channel Letters (Halo Lit)' },
  { value: 'channel_face_halo', label: 'Channel Letters (Front & Back Lit)' },
  { value: 'lightbox_cabinet', label: 'Cabinet / Lightbox' },
  { value: 'blade_sign', label: 'Projection / Blade Sign' },
  { value: 'flat_cut_standoff', label: 'Flat Cut Letters (Stand-off)' },
  { value: 'totem', label: 'Totem / Pylon' },
  { value: 'window_vinyl', label: 'Window Graphics / Vinyl' },
  { value: 'awning', label: 'Awning / Canopy' },
];

export interface Sign {
  id: string;
  name: string;
  image: string;
  corners: [Point, Point, Point, Point]; // TL, TR, BR, BL
  signType: SignType; // New field for specification
  extrusionEnabled: boolean; // New field
  extrusionDepth: number;
  extrusionAngle: number; // in degrees
  opacity: number;
  blendMode: string;
  sideColor: string;
}

export interface Dimension {
  id: string;
  variant: 'linear' | 'box'; // New field: line or box
  type: 'horizontal' | 'vertical'; // Still used for linear ticks
  start: Point;
  end: Point;
  text: string; // e.g. "200cm"
  color: string;
}

export interface Revision {
  id: string;
  rev: string;
  date: string;
  description: string;
  drawnBy: string;
}

export interface TitleBlockField {
  id: string;
  label: string;
  value: string;
  section: 'project' | 'drawing' | 'sheet'; // Used for grouping in rendering
  isCustom?: boolean;
}

export interface TitleBlockTemplate {
  id: string;
  name: string;
  layout: 'vertical-right' | 'horizontal-bottom';
  headerColor: string;
  textColor: string;
  backgroundColor: string;
  fontFamily: string;
  logoPosition: 'top' | 'bottom';
}

export type PaperSize = 'A4' | 'A3' | 'A2' | 'Letter' | 'Tabloid';
export type Orientation = 'portrait' | 'landscape';

export interface TitleBlock {
  enabled: boolean;
  viewMode: 'canvas' | 'sheet'; 
  
  // Page Settings
  paperSize: PaperSize;
  orientation: Orientation;

  // Store the full active style configuration here
  style: TitleBlockTemplate;
  
  logoImage: string | null; 
  
  // Dynamic fields replace the hardcoded ones
  fields: TitleBlockField[];

  // Revisions remain a dedicated table
  revisions: Revision[];
}

export interface ReferenceImage {
  id: string;
  image: string; // URL or DataURI
  note: string;
}

export interface Canvas {
  id: string;
  name: string; // Internal name e.g. "Front Facade"
  
  // Background
  backgroundImage: string;
  backgroundSize: Size;

  // Objects
  signs: Sign[];
  activeSignId: string | null;
  dimensions: Dimension[];
  activeDimensionId: string | null;

  // Sheet Specifics
  sheetTitle: string; 
  sheetNumber: string; 
}

export interface UserProfile {
  uid: string;
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
}

export interface MockupState {
  // User
  user: UserProfile | null;

  // Project Identity
  projectId: string;
  projectName: string;

  // Project Level
  canvases: Canvas[];
  activeCanvasId: string;
  
  // Project Settings
  isNightMode: boolean;
  showDimensions: boolean;
  titleBlock: TitleBlock;
  savedTemplates: TitleBlockTemplate[]; 
  notes: string; // Project General Notes
  referenceImages: ReferenceImage[]; // Global references
  
  // Sync & Connectivity
  lastSaved: number; // Timestamp
  isOnline: boolean;
  isSyncing: boolean;
}

export interface ProjectMetadata {
  id: string;
  name: string;
  lastModified: number;
  thumbnail?: string; // Data URI
  canvasCount: number;
}

export interface AppImages {
  background: string; // URL or Data URI
  backgroundSize: Size;
}

export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten'
];

// --- Library Types ---

export interface SignTemplate {
  id: string;
  name: string;
  category: string; // 'Fascia', 'Projecting', 'Pylon', 'Window'
  image: string; // URL
  width: number; // Suggested width in relative units (mm)
  height: number; // Suggested height in relative units (mm)
}

export interface Brand {
  id: string;
  name: string;
  logo: string; // Icon URL
  templates: SignTemplate[];
}

export type CloudProvider = 'google_drive' | 'dropbox' | 'onedrive';