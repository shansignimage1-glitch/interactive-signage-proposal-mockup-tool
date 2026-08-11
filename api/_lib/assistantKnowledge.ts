/**
 * Product facts supplied to the in-app guide on every request.
 *
 * Keep this file factual and versioned. The assistant must not infer a feature
 * from marketing copy or from an earlier conversation when the workflow has
 * changed.
 */
export const SIGNAGEPRO_KNOWLEDGE_VERSION = '2026-08-11';

export const SIGNAGEPRO_PRODUCT_KNOWLEDGE = `
PRODUCT KNOWLEDGE — SignagePro (${SIGNAGEPRO_KNOWLEDGE_VERSION})

Device workflows
- Phones use the dedicated Site Capture workflow. It is designed for field work, not full canvas editing. On iPhone and Android it can capture/import elevation photos, record per-view notes, use supported browser dictation, enter reference-wall measurements and plane depth, choose/save projects, and prepare a captured view for later editing.
- Browser dictation and camera/location access depend on device support, browser permissions and a secure connection. Never promise that speech recognition is available in every browser; typing remains the fallback.
- iPad and desktop provide the full proposal editor: calibration, canvas navigation, sign placement and scaling, perspective, dimensions, title block, 3D controls, cleanup and export.

Projects and views
- Save project persists the current project. In the phone project chooser, Save project returns the user to the saved-project screen. New project starts clean, without earlier photos, calibration, signs, dimensions or title-block data.
- Users can save, open, rename/edit and delete projects. Adding a view starts with a blank canvas. Deleting a view renumbers the remaining views, elevation titles and sheet numbers in order.
- Placement changes have Undo and Redo. These are for editor actions; they are not a substitute for saving the project.

Phone site capture and image quality
- The original captured file is retained untouched. SignagePro stores a separate editor working image with a maximum dimension of 4096 px and a 720 px thumbnail. A small thumbnail is never used as the editor source.
- HEIC/HEIF and other non-web-safe captures are converted to a web-safe JPEG working copy when the browser can decode them; the original file remains separate. JPEG, PNG and WebP are supported working formats.
- Each captured elevation can store wall name, confirmed width, confirmed height, plane depth/offset, Further back or Closer to camera direction, confirmed reference-plane name, measurement method and notes.
- Create editor view becomes available only after width, height and plane depth have been entered. Calibration points are refined later on iPad or desktop.
- If location permission is granted, the phone capture can store coordinates and use Google Maps reverse geocoding for an address. In the desktop/iPad uploader, Use photo location reads photo GPS when available, falls back to current device location, and only populates the title-block ADDRESS after the user confirms it.

Photo preparation
- Make photo horizontal is optional. For a live camera it can show a level guide where supported. For an existing photo, draw a long line along a known horizontal edge, then Apply level. Leveling changes image coordinates, so old calibration is cleared and must be redone.
- The editor keeps the highest practical working resolution. WebGL display previews may be capped for device safety, but final editing geometry remains in image coordinates and export is rendered separately.

Calibration and measurement
- A simple two-point reference establishes one scale along the selected line. Four-corner Perspective wall calibration maps a known rectangular wall plane with a homography and is the correct choice for placing and measuring signs on that flat plane.
- A pixel (picture element) is one sample in the rectangular grid of a digital image. An image pixel has no fixed physical width or height in millimetres: its apparent size on a screen depends on display density and zoom, while the area it represents on the building depends on camera distance, angle, lens and the selected surface. Do not describe a pixel as a fixed number of millimetres, centimetres or inches before calibration. If the user specifically means a hardware display or print dot, its nominal pitch is 25.4 divided by PPI/DPI in millimetres, but a CSS pixel may cover multiple device pixels and neither value is used to measure the photographed building.
- SignagePro calculations use intrinsic image pixels—the stored image-coordinate grid—not CSS/display pixels. Panning, Fit view and zoom only change how large the photo looks on screen; they do not change the calculated dimension.
- For two-point calibration, the app measures the reference span in pixels with the Pythagorean distance formula: pixel distance = sqrt((x2-x1)^2 + (y2-y1)^2). It converts the confirmed reference length to millimetres, then calculates mm per pixel = confirmed millimetres / reference pixel distance. A measured line is line pixel distance × mm per pixel. Example: a confirmed 2,000 mm edge spanning 1,000 intrinsic pixels gives 2 mm/px; a 350 px line on the same plane is 700 mm.
- A single mm/px value assumes the reference and measured item lie on the same approximately flat plane and that perspective is insignificant. It is not valid across walls at different depths: farther surfaces usually represent more millimetres per image pixel than nearer surfaces.
- For four-corner Perspective wall calibration, the app maps the selected image corners to real wall coordinates (0,0), (width,0), (width,height), (0,height) in millimetres using a homography. It maps measurement endpoints into that wall coordinate system before calculating their real distance, so there is no single constant mm/px across a perspective wall.
- A calibrated line uses the straight-line distance between its two transformed wall points. A calibrated width × height box uses the absolute horizontal and vertical coordinate differences on that plane. A sign's displayed width is the average of its transformed top and bottom edge lengths; its height is the average of its transformed left and right edge lengths.
- Displayed values are rounded for readability after calculation. Metric values display as millimetres below 10 mm, centimetres below 1 m and metres at 1 m or more; imperial values display as inches or feet-and-inches. Rounding the label does not change the underlying sign geometry.
- Measurement accuracy is limited by the confirmed reference measurement, handle placement, photo sharpness/resolution, perspective-plane choice, lens distortion and whether the real surface is actually flat. Higher resolution allows finer point placement but does not create real-world scale by itself. Treat outputs as proposal/site-estimation measurements unless the capture and calibration process has been independently verified; do not present them as survey-grade.
- A homography models only one flat plane. It does not correct lens distortion, recover a complete building or accurately place blade signs, pylons and other objects extending away from the wall.
- Use separate calibrated planes for adjoining or angled walls. For a second wall that is parallel to a confirmed reference wall, add a Parallel offset plane, enter the signed distance (Further back is away from the camera; Closer is toward it), place its four corners, and verify it with a known check dimension on that plane.
- Parallel-offset accuracy depends on a sound reference plane and shared camera estimate. A wall 500 mm farther back should use a +500 mm offset; a wall 500 mm closer should use a -500 mm offset. Do not treat an angled wall as a parallel offset.
- Camera-pose estimation is the next stage for true depth projection. Lens correction can refine barrel/pincushion distortion, but changing it changes photo geometry, so calibration points must be refined afterward.
- Dimensions displayed on a calibrated sign update when the sign is scaled. Manual or uncalibrated values should not be described as surveyed measurements.

Professional sign placement
- Select & adjust supports moving, panning/zooming and editing sign or dimension handles. Touch editing provides a magnified placement view so a finger does not hide the target; desktop precision editing also supports magnification.
- Sign placement offers proportional aspect-locked scaling, independent width/height scaling when aspect lock is disabled, a selectable placement anchor, centre snapping, vanishing-point guides and assignment to a calibrated surface.
- A sign with confirmed real width/height can be placed at physical size on its calibrated plane. Without calibration, size is visual only and cannot be claimed as real-world accurate.
- Four-corner sign perspective refines artwork on a wall plane. Planar perspective is appropriate for fascia and flat-wall artwork; projecting or freestanding signs need camera-pose/3D treatment.

3D extrusion
- Choose the construction first: Backing board + raised artwork, or Individual letters/logo (no board). In backed construction the board has its own, shallower depth; the raised letters/logo sit farther forward. In individual construction, only detected artwork elements are extruded over the building photo.
- Visual 2D extrusion is a presentation mode. Its depth is relative to the placed sign width, so it remains visible on high-resolution photos and across desktop/iPad display sizes. The default visual depth of 15 units equals 5% of placed sign width; per-element depths remain independent.
- Auto-detected letters/logo use the relative-width-v1 depth model. Users can enable elements and set their depths separately. The current editor applies one return/side colour to the sign; separate logo, letter and backing-board side colours are not yet available. Returns and faces share the same selected wall perspective so they remain attached rather than appearing as a displaced outline.
- Camera-pose 3D is the physically based option. Selecting it enables camera estimation, requires a calibrated plane, uses physical depth in millimetres and projects the return through the camera model. Turning Camera pose off returns camera-3D signs to planar projection.
- A convincing extrusion requires visible side-wall area; a thin duplicate outline or drop shadow is not correct extrusion. Increase letter/logo depth, confirm the correct construction mode and element detection, then adjust extrusion direction/side colours. For physical accuracy, calibrate the wall and use Camera-pose 3D.

Libraries and storage
- Catalog > Shared Library contains company templates visible to authorised users. My Library contains the signed-in user's uploads. Save Current Sign adds a personal item unless an authorised admin selects Publish to shared library.
- Cloud library images use authenticated Firebase metadata/storage and refresh expiring download URLs. A failed thumbnail or 403 should be treated as an access, missing-object or stale-session problem—not as a cue to invent a local workaround. Recommend signing in again, checking connectivity and retrying; persistent failures need administrator/storage investigation.
- Projects save locally and can sync to the SignagePro Firebase project when signed in. Optional Google Drive, OneDrive or Dropbox connections are separate export/storage destinations; do not claim every project or library item is stored in Google Drive.

3D proposal viewer
- The optional 3D Proposal Viewer creates honest rectangular building massing from entered width, depth and height, with project elevations assigned to front/right/rear/left faces.
- A photographed four-point calibrated elevation is labelled Measured; a supplied but uncalibrated elevation is Estimated; an absent face is Not surveyed. If only one or two elevations are available, show those faces and leave the others unsurveyed. Never invent missing elevations or describe the massing model as a surveyed photogrammetry/digital-twin model.

Other editor tools
- Title Block fields, Notes, Magic Cleanup, day/night presentation, reference images and PDF/PNG export are editor features. Download saves to the device; Save to drive requires a connected provider.
`;

export interface AssistantKnowledgeMessage { text: string; role?: 'user' | 'model' }

const SECTION_ROUTES = [
  { title: 'Projects and views', keywords: /\b(project|projects|view|views|save|saved|rename|delete|undo|redo|blank canvas|new page)\b/i },
  { title: 'Phone site capture and image quality', keywords: /\b(phone|mobile|iphone|android|capture|camera|photo|image|resolution|pixel|heic|heif|jpeg|thumbnail|address|location|dictation|notes)\b/i },
  { title: 'Photo preparation', keywords: /\b(level|leveling|horizontal|horizon|roofline|rotate|orientation|lens|barrel|pincushion)\b/i },
  { title: 'Calibration and measurement', keywords: /\b(calibrat|measure|measurement|dimension|pixel|scale|size|big|calculat|length|distance|mm|millimet|centimet|metre|meter|inch|feet|wall|plane|homography|perspective|offset|parallax|accuracy)\w*/i },
  { title: 'Professional sign placement', keywords: /\b(place|placement|select|adjust|move|resize|scale|size|big|handle|anchor|snap|vanishing|perspective|loupe|magnif|width|height)\w*/i },
  { title: '3D extrusion', keywords: /\b(3d|extrus|extrud|depth|return|backing|board|letter|logo|side colour|side color|camera-pose|projection)\w*/i },
  { title: 'Libraries and storage', keywords: /\b(library|catalog|template|upload|shared|firebase|403|thumbnail|drive|dropbox|onedrive|storage|fetch)\w*/i },
  { title: '3D proposal viewer', keywords: /\b(3d viewer|proposal viewer|building model|building mass|elevation|rotate building|digital twin|photogrammetry|surveyed face)\w*/i },
  { title: 'Other editor tools', keywords: /\b(title block|magic cleanup|night|day view|pdf|png|export|download|reference image)\w*/i },
] as const;

const SECTION_TITLES = ['Device workflows', ...SECTION_ROUTES.map(route => route.title)] as const;
const FULL_KNOWLEDGE_REQUEST = /\b(all features|everything|full overview|complete overview|teach me|getting started|show me around|where do i start|how (do|can) i (start|begin|get started)|help me (start|get started)|what can (you|the app|signagepro) do)\b/i;

const readSection = (title: string): string => {
  const source = SIGNAGEPRO_PRODUCT_KNOWLEDGE.trim();
  const marker = `${title}\n`;
  const start = source.indexOf(marker);
  if (start < 0) return '';
  const contentStart = start + marker.length;
  const nextStart = SECTION_TITLES
    .map(nextTitle => source.indexOf(`\n${nextTitle}\n`, contentStart))
    .filter(index => index >= 0)
    .sort((a, b) => a - b)[0] ?? source.length;
  return `${title}\n${source.slice(contentStart, nextStart).trim()}`;
};

export function selectAssistantProductKnowledge(messages: AssistantKnowledgeMessage[] = []): string {
  const recent = messages.slice(-6);
  const latest = [...recent].reverse().find(message => message.role === 'user') ?? recent[recent.length - 1];
  const latestQuery = latest?.text ?? '';
  const contextQuery = recent.filter(message => message !== latest).map(message => message.text).join(' ');
  const latestTitles = SECTION_ROUTES.filter(route => route.keywords.test(latestQuery)).map(route => route.title);
  if (!latestTitles.length && FULL_KNOWLEDGE_REQUEST.test(latestQuery)) return SIGNAGEPRO_PRODUCT_KNOWLEDGE.trim();

  const contextTitles = SECTION_ROUTES
    .filter(route => route.keywords.test(contextQuery) && !latestTitles.includes(route.title))
    .map(route => route.title);
  const matchedTitles = [...latestTitles, ...contextTitles.slice(0, Math.max(0, 4 - latestTitles.length))];
  const selectedTitles = matchedTitles.length ? matchedTitles : ['Projects and views', 'Other editor tools'];
  const sections = ['Device workflows', ...selectedTitles]
    .filter((title, index, titles) => titles.indexOf(title) === index)
    .map(readSection)
    .filter(Boolean);
  return `PRODUCT KNOWLEDGE — SignagePro (${SIGNAGEPRO_KNOWLEDGE_VERSION})\n\n${sections.join('\n\n')}`;
}

export function buildAssistantSystemInstruction(messages: AssistantKnowledgeMessage[] = []): string {
  return `You are Pro Guide, the in-app product specialist for SignagePro, a professional signage proposal and mockup tool.

Answer the user's actual question first. Be concise, friendly and practical. Give numbered steps when explaining a workflow and use the exact control names found in the product knowledge. Tailor instructions to phone versus iPad/desktop. Ask at most one necessary clarifying question.

Ground every product claim in the knowledge below. Do not invent controls, storage locations, automatic accuracy, completed saves/syncs, or capabilities that are not listed. Clearly distinguish visual approximation, calibrated measurement and physically based projection. If the knowledge does not establish an answer, say that you are not certain and recommend checking with SignagePro support rather than guessing. For unrelated topics, briefly steer the user back to SignagePro.

${selectAssistantProductKnowledge(messages)}`;
}
