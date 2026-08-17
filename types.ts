

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export type PlacementAnchor = 'center' | 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';

export interface CalibrationPlane {
  id: string;
  name: string;
  corners: [Point, Point, Point, Point];
  widthMm: number;
  heightMm: number;
  /** Image points mapped to the reference plane's millimetre coordinate system. */
  worldCornersMm?: [Point, Point, Point, Point];
  /** Base plane used to estimate the shared camera pose. */
  referencePlaneId?: string;
  /** Signed normal offset: positive is farther from the camera, negative is forward. */
  offsetMm?: number;
  calibrationKind?: 'known-size' | 'parallel-offset';
  cameraConfidence?: 'verified' | 'estimated';
}

export interface LensCorrection {
  enabled: boolean;
  /** Brown-Conrady radial coefficients. Positive k1 corrects barrel distortion. */
  k1: number;
  k2: number;
}

export interface CameraModel {
  enabled: boolean;
  /** Horizontal field of view used when focalLengthPx is not known. */
  fieldOfViewDeg: number;
  focalLengthPx?: number;
  principalPoint?: Point;
  estimated: boolean;
}

export interface PlacementSettings {
  snapEnabled: boolean;
  showVanishingGuides: boolean;
  lens: LensCorrection;
  camera: CameraModel;
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

// A distinct visual element (letter, logo mark, border) isolated from the
// sign's flat artwork, carrying its own extrusion depth. Contours live in
// sign-image pixel space and are simplified before persisting.
export interface SignElement {
  id: string;
  name: string;          // "Element 1", editable later
  contours: Point[][];   // sign-image px space, simplified outlines
  depth: number;         // extrusion depth in sign-image px
  enabled: boolean;
}

export interface Sign {
  id: string;
  name: string;
  image: string;
  corners: [Point, Point, Point, Point]; // TL, TR, BR, BL
  signType: SignType; // New field for specification
  extrusionEnabled: boolean; // New field
  extrusionDepth: number; // Relative visual-depth units (15 = 5% of placed sign width).
  extrusionAngle: number; // in degrees
  extrusionMode?: 'backed' | 'individual'; // Raised copy on a board, or individual letters/logo only.
  backingDepth?: number; // Relative visual-depth units; kept shallower than the raised artwork.
  opacity: number;
  blendMode: string;
  sideColor: string;
  realWidthMm?: number;
  realHeightMm?: number;
  aspectLocked?: boolean; // Undefined is treated as locked for existing projects.
  placementAnchor?: PlacementAnchor;
  calibrationPlaneId?: string;
  projectionMode?: 'planar' | 'camera-3d';
  physicalDepthMm?: number;

  // Per-element variable extrusion (undefined/empty = classic single-slab)
  elements?: SignElement[];
  elementsSourceSize?: Size; // image dims detection ran against (guards image swaps)
  elementDepthModel?: 'relative-width-v1'; // Auto-detected depths are proportional to artwork width.
}

export interface Dimension {
  id: string;
  variant: 'linear' | 'box'; // New field: line or box
  type: 'horizontal' | 'vertical'; // Still used for linear ticks
  start: Point;
  end: Point;
  text: string; // e.g. "200cm"
  color: string;
  autoMeasured?: boolean; // true = label computed from calibration; cleared on hand-edit
}

// --- Measurement / Calibration ---

export type MeasureUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';
export type UnitSystem = 'metric' | 'imperial';

// A reference line drawn over a known-size object in the background photo.
// The scale factor (mm per image pixel) is always derived from this, never stored:
// mmPerPx = toMm(realValue, unit) / distance(start, end)
export interface Calibration {
  start: Point;      // image-space px
  end: Point;
  realValue: number; // e.g. 85.6
  unit: MeasureUnit; // e.g. 'mm'
  plane?: {
    corners: [Point, Point, Point, Point]; // TL, TR, BR, BL on one wall plane
    widthMm: number;
    heightMm: number;
  };
  /** Multiple independently calibrated surfaces. plane mirrors the active item for old projects. */
  planes?: CalibrationPlane[];
  activePlaneId?: string;
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

export interface CanvasAnnotation {
  id: string;
  points: Point[];
  color: string;
  width: number;
  note: string;
  createdAt: number;
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
  annotations?: CanvasAnnotation[];

  // Real-world scale reference for this view's photo (null/undefined = not calibrated)
  calibration?: Calibration | null;
  placement?: PlacementSettings;

  // Sheet Specifics
  sheetTitle: string; 
  sheetNumber: string; 
}

export type BuildingFaceId = 'front' | 'right' | 'rear' | 'left';
export type BuildingSurfaceCoverage = 'measured' | 'estimated' | 'unsurveyed';

export interface BuildingFaceAssignment {
  canvasId: string | null;
  coverage: BuildingSurfaceCoverage;
}

/** Shared real-world shell used by the optional rotatable proposal viewer. */
export interface BuildingModelSettings {
  widthMm: number;
  depthMm: number;
  heightMm: number;
  faceAssignments: Record<BuildingFaceId, BuildingFaceAssignment>;
}

export type FieldMeasurementMethod = 'laser' | 'tape' | 'drawing' | 'estimate';
export type PlaneDepthDirection = 'behind' | 'forward';

export interface ReferenceWallFieldMeasurement {
  wallName: string;
  widthMm?: number;
  heightMm?: number;
  planeDepthMm?: number;
  planeDepthDirection: PlaneDepthDirection;
  referencePlaneName: string;
  method: FieldMeasurementMethod;
  notes: string;
}

export interface SiteCaptureSupportingPhoto {
  id: string;
  originalRef: string;
  workingRef: string;
  thumbnailRef: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  pixelWidth: number;
  pixelHeight: number;
  workingPixelWidth: number;
  workingPixelHeight: number;
  capturedAt: number;
}

export interface SiteCapturePhoto {
  id: string;
  label: string;
  originalRef: string;
  workingRef: string;
  thumbnailRef: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  pixelWidth: number;
  pixelHeight: number;
  workingPixelWidth: number;
  workingPixelHeight: number;
  capturedAt: number;
  notes: string;
  location?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
    address?: string;
  };
  supportingPhotos?: SiteCaptureSupportingPhoto[];
  referenceWall: ReferenceWallFieldMeasurement;
  promotedCanvasId?: string;
}

export interface UserProfile {
  uid: string;
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
  isAdmin?: boolean;
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
  unitSystem: UnitSystem; // display units for calibrated measurements
  titleBlock: TitleBlock;
  savedTemplates: TitleBlockTemplate[]; 
  notes: string; // Project General Notes
  referenceImages: ReferenceImage[]; // Global references
  siteCaptures?: SiteCapturePhoto[];
  buildingModel?: BuildingModelSettings;
  
  // Sync & Connectivity
  lastSaved: number; // Timestamp
  cloudRevision?: number; // optimistic-concurrency base revision
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

// Where a library template lives: bundled with the app, the shared company
// catalog (admin-curated, Firestore), or the user's personal cloud library.
export type TemplateSource = 'builtin' | 'shared' | 'personal';

export interface SignTemplate {
  id: string;
  name: string;
  category: string; // 'Fascia', 'Projecting', 'Pylon', 'Window'
  image: string; // URL
  width: number; // Suggested width in relative units (mm)
  height: number; // Suggested height in relative units (mm)

  // Cloud library metadata (absent on builtin templates)
  source?: TemplateSource;
  docId?: string;       // Firestore doc id (for delete)
  storagePath?: string; // Firebase Storage path of the image (for delete)
  ownerUid?: string;    // personal templates only
  brand?: string;
  tags?: string[];
  signType?: SignType;
  rightsNote?: string;
  version?: number;
  updatedAt?: number;
  recovered?: boolean; // Storage object whose Firestore metadata was lost
  deleting?: boolean;  // Personal-library tombstone for retry-safe deletion
  deletionId?: string; // Identifies the exact cleanup operation
}

export interface Brand {
  id: string;
  name: string;
  logo: string; // Icon URL
  templates: SignTemplate[];
}

export type CloudProvider = 'google_drive' | 'dropbox' | 'onedrive';

// --- Cloud Drive Storage ---

// Images stored in a user's own cloud drive are persisted in project JSON as
// opaque refs (e.g. "gdrive://<fileId>") instead of https URLs; the
// AssetResolver materializes them back into data URIs at load time.
export const GDRIVE_REF_PREFIX = 'gdrive://';
export const ONEDRIVE_REF_PREFIX = 'onedrive://';
export const DROPBOX_REF_PREFIX = 'dropbox://';

export type ConnectorStatus = 'disconnected' | 'connected' | 'expired';
