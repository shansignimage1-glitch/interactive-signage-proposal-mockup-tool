import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Box, Building2, Eye, Maximize2, MousePointer2, Rotate3D, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { BuildingFaceId, BuildingModelSettings, Canvas, Sign } from '../types';
import { getActiveCalibrationPlane } from '../utils/cameraGeometry';
import { imagePointToPlane } from '../utils/measure';
import { BUILDING_FACE_IDS, normalizeBuildingModel } from '../utils/buildingModel';

interface Proposal3DViewerProps {
  canvases: Canvas[];
  settings?: BuildingModelSettings;
  isNightMode: boolean;
  onChange: (settings: BuildingModelSettings) => void;
  onClose: () => void;
}

type CameraPreset = BuildingFaceId | 'iso';

const FACE_LABELS: Record<BuildingFaceId, string> = {
  front: 'Front', right: 'Right', rear: 'Rear', left: 'Left',
};

const COVERAGE_STYLES = {
  measured: { label: 'Measured', icon: ShieldCheck, className: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' },
  estimated: { label: 'Estimated', icon: TriangleAlert, className: 'border-amber-400/30 bg-amber-400/10 text-amber-300' },
  unsurveyed: { label: 'Not surveyed', icon: Eye, className: 'border-slate-500/40 bg-slate-700/50 text-slate-400' },
} as const;

const setUvFromImageQuad = (
  geometry: THREE.PlaneGeometry,
  corners: { x: number; y: number }[],
  imageWidth: number,
  imageHeight: number,
) => {
  const [tl, tr, br, bl] = corners;
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
  const points = [tl, tr, bl, br];
  points.forEach((point, index) => uv.setXY(index, point.x / imageWidth, 1 - point.y / imageHeight));
  uv.needsUpdate = true;
};

const getPlaneForSign = (canvas: Canvas, sign: Sign) => {
  if (!canvas.calibration) return null;
  const planeId = sign.calibrationPlaneId ?? canvas.calibration.activePlaneId;
  const planes = canvas.calibration.planes ?? [];
  return planes.find(plane => plane.id === planeId) ?? getActiveCalibrationPlane(canvas.calibration);
};

const Proposal3DViewer: React.FC<Proposal3DViewerProps> = ({ canvases, settings, isNightMode, onChange, onClose }) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const model = useMemo(() => normalizeBuildingModel(settings, canvases), [settings, canvases]);

  const setCameraPreset = (preset: CameraPreset) => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    const width = model.widthMm / 1000;
    const depth = model.depthMm / 1000;
    const height = model.heightMm / 1000;
    const distance = Math.max(width, depth, height) * 1.45;
    const positions: Record<CameraPreset, [number, number, number]> = {
      front: [0, height * 0.55, distance],
      right: [distance, height * 0.55, 0],
      rear: [0, height * 0.55, -distance],
      left: [-distance, height * 0.55, 0],
      iso: [distance * 0.72, height * 0.95, distance * 0.72],
    };
    camera.position.set(...positions[preset]);
    controls.target.set(0, height * 0.42, 0);
    controls.update();
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(isNightMode ? '#05080d' : '#111821');
    scene.fog = new THREE.Fog(scene.background, 24, 80);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 300);
    cameraRef.current = camera;
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.minDistance = 1;
    controls.maxDistance = 120;
    controls.maxPolarAngle = Math.PI * 0.49;
    controlsRef.current = controls;

    const width = model.widthMm / 1000;
    const depth = model.depthMm / 1000;
    const height = model.heightMm / 1000;
    const shellMaterials = Array.from({ length: 6 }, () => new THREE.MeshStandardMaterial({
      color: isNightMode ? '#17202b' : '#364452',
      roughness: 0.88,
      metalness: 0.05,
    }));
    const shell = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), shellMaterials);
    shell.position.y = height / 2;
    shell.castShadow = true;
    shell.receiveShadow = true;
    scene.add(shell);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(shell.geometry),
      new THREE.LineBasicMaterial({ color: isNightMode ? '#415063' : '#77899a', transparent: true, opacity: 0.45 }),
    );
    edges.position.copy(shell.position);
    scene.add(edges);

    scene.add(new THREE.HemisphereLight(isNightMode ? 0x91b9e8 : 0xdceeff, isNightMode ? 0x050609 : 0x30363d, isNightMode ? 1.15 : 2.1));
    const sun = new THREE.DirectionalLight(isNightMode ? 0xb4d4ff : 0xfff4df, isNightMode ? 1.4 : 2.8);
    sun.position.set(width, height * 2, depth * 1.4);
    sun.castShadow = true;
    scene.add(sun);
    if (isNightMode) {
      const proposalLight = new THREE.PointLight(0x83b8ff, 16, Math.max(width, depth) * 2.5);
      proposalLight.position.set(0, height * 0.8, Math.max(2, depth));
      scene.add(proposalLight);
    }

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.max(width, depth) * 5, Math.max(width, depth) * 5),
      new THREE.MeshStandardMaterial({ color: isNightMode ? '#080c11' : '#171e25', roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    const grid = new THREE.GridHelper(Math.max(width, depth) * 5, 30, isNightMode ? 0x233448 : 0x344657, isNightMode ? 0x14202d : 0x263441);
    grid.position.y = 0.004;
    scene.add(grid);

    const textures: THREE.Texture[] = [];
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    const loadTexture = (src: string) => {
      const texture = loader.load(src);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      textures.push(texture);
      return texture;
    };

    const transforms: Record<BuildingFaceId, { position: [number, number, number]; rotationY: number; faceWidth: number }> = {
      front: { position: [0, 0, depth / 2 + 0.008], rotationY: 0, faceWidth: width },
      right: { position: [width / 2 + 0.008, 0, 0], rotationY: Math.PI / 2, faceWidth: depth },
      rear: { position: [0, 0, -depth / 2 - 0.008], rotationY: Math.PI, faceWidth: width },
      left: { position: [-width / 2 - 0.008, 0, 0], rotationY: -Math.PI / 2, faceWidth: depth },
    };

    BUILDING_FACE_IDS.forEach(faceId => {
      const assignment = model.faceAssignments[faceId];
      const canvas = canvases.find(item => item.id === assignment.canvasId);
      if (!canvas?.backgroundImage) return;
      const transform = transforms[faceId];
      const facade = new THREE.Group();
      facade.position.set(...transform.position);
      facade.rotation.y = transform.rotationY;
      scene.add(facade);

      const activePlane = getActiveCalibrationPlane(canvas.calibration ?? null);
      const facadeWidth = activePlane ? activePlane.widthMm / 1000 : transform.faceWidth;
      const facadeHeight = activePlane ? activePlane.heightMm / 1000 : height;
      const wallGeometry = new THREE.PlaneGeometry(facadeWidth, facadeHeight);
      if (activePlane) setUvFromImageQuad(wallGeometry, activePlane.corners, canvas.backgroundSize.width, canvas.backgroundSize.height);
      const wallTexture = loadTexture(canvas.backgroundImage);
      const wall = new THREE.Mesh(wallGeometry, new THREE.MeshStandardMaterial({ map: wallTexture, roughness: 0.92 }));
      wall.position.set(0, facadeHeight / 2, 0);
      wall.receiveShadow = true;
      facade.add(wall);

      canvas.signs.forEach(sign => {
        if (!sign.image) return;
        const signPlane = getPlaneForSign(canvas, sign);
        let localCorners: { x: number; y: number }[];
        let coordinateWidthMm: number;
        let coordinateHeightMm: number;
        if (canvas.calibration && signPlane) {
          const signCalibration = { ...canvas.calibration, activePlaneId: signPlane.id, plane: { corners: signPlane.corners, widthMm: signPlane.widthMm, heightMm: signPlane.heightMm } };
          const mapped = sign.corners.map(point => imagePointToPlane(point, signCalibration));
          if (mapped.some(point => !point)) return;
          localCorners = mapped as { x: number; y: number }[];
          const sourceCoordinates = signPlane.worldCornersMm ?? [{ x: 0, y: 0 }, { x: signPlane.widthMm, y: 0 }, { x: signPlane.widthMm, y: signPlane.heightMm }, { x: 0, y: signPlane.heightMm }];
          const minX = Math.min(...sourceCoordinates.map(point => point.x));
          const minY = Math.min(...sourceCoordinates.map(point => point.y));
          localCorners = localCorners.map(point => ({ x: point.x - minX, y: point.y - minY }));
          coordinateWidthMm = signPlane.widthMm;
          coordinateHeightMm = signPlane.heightMm;
        } else {
          coordinateWidthMm = facadeWidth * 1000;
          coordinateHeightMm = facadeHeight * 1000;
          localCorners = sign.corners.map(point => ({
            x: point.x / canvas.backgroundSize.width * coordinateWidthMm,
            y: point.y / canvas.backgroundSize.height * coordinateHeightMm,
          }));
        }
        const xs = localCorners.map(point => point.x);
        const ys = localCorners.map(point => point.y);
        const signWidth = (Math.max(...xs) - Math.min(...xs)) / 1000;
        const signHeight = (Math.max(...ys) - Math.min(...ys)) / 1000;
        if (!(signWidth > 0) || !(signHeight > 0)) return;
        const centerX = ((Math.min(...xs) + Math.max(...xs)) / 2) / 1000 - facadeWidth / 2;
        const centerY = facadeHeight - ((Math.min(...ys) + Math.max(...ys)) / 2) / 1000;
        const depthM = Math.max(0.015, (sign.physicalDepthMm ?? 100) / 1000);
        const signTexture = loadTexture(sign.image);
        const signGroup = new THREE.Group();
        signGroup.position.set(centerX, centerY, 0.006);
        facade.add(signGroup);

        if (sign.extrusionMode === 'backed') {
          const backingDepth = Math.min(depthM * 0.45, 0.12);
          const backing = new THREE.Mesh(
            new THREE.BoxGeometry(signWidth, signHeight, backingDepth),
            new THREE.MeshStandardMaterial({ color: sign.sideColor || '#263849', roughness: 0.6 }),
          );
          backing.position.z = backingDepth / 2;
          backing.castShadow = true;
          signGroup.add(backing);
        } else if (sign.extrusionEnabled) {
          const layers = 6;
          const sideMaterial = new THREE.MeshBasicMaterial({ color: sign.sideColor || '#263849', alphaMap: signTexture, transparent: true, alphaTest: 0.08, opacity: sign.opacity });
          for (let layer = 0; layer < layers; layer += 1) {
            const side = new THREE.Mesh(new THREE.PlaneGeometry(signWidth, signHeight), sideMaterial);
            side.position.z = depthM * (layer / layers);
            signGroup.add(side);
          }
        }
        const face = new THREE.Mesh(
          new THREE.PlaneGeometry(signWidth, signHeight),
          new THREE.MeshBasicMaterial({ map: signTexture, transparent: true, alphaTest: 0.02, opacity: sign.opacity }),
        );
        face.position.z = sign.extrusionEnabled ? depthM : 0.008;
        face.castShadow = true;
        signGroup.add(face);
      });
    });

    const maxSize = Math.max(width, depth, height);
    camera.position.set(maxSize * 1.05, height * 1.05, maxSize * 1.05);
    controls.target.set(0, height * 0.42, 0);
    controls.update();

    const resize = () => {
      const rect = mount.getBoundingClientRect();
      renderer.setSize(rect.width, rect.height, false);
      camera.aspect = Math.max(rect.width, 1) / Math.max(rect.height, 1);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();
    let frame = 0;
    const render = () => {
      frame = requestAnimationFrame(render);
      controls.update();
      renderer.render(scene, camera);
    };
    render();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      textures.forEach(texture => texture.dispose());
      scene.traverse(object => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach(material => material.dispose());
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
      cameraRef.current = null;
      controlsRef.current = null;
    };
  }, [canvases, model, isNightMode]);

  const updateDimension = (key: 'widthMm' | 'depthMm' | 'heightMm', metres: string) => {
    const value = Number(metres);
    if (Number.isFinite(value) && value > 0) onChange({ ...model, [key]: Math.round(value * 1000) });
  };

  const assignCanvas = (face: BuildingFaceId, canvasId: string) => {
    const canvas = canvases.find(item => item.id === canvasId);
    const coverage = !canvas?.backgroundImage ? 'unsurveyed' : getActiveCalibrationPlane(canvas.calibration ?? null) ? 'measured' : 'estimated';
    onChange({
      ...model,
      faceAssignments: { ...model.faceAssignments, [face]: { canvasId: canvasId || null, coverage } },
    });
  };

  return (
    <div className="fixed inset-0 z-[90] flex flex-col bg-[#080c11] text-slate-100" data-testid="proposal-3d-viewer">
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-white/10 bg-[#0d131b]/95 px-4 backdrop-blur-xl lg:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-cyan-400/25 bg-cyan-400/10 text-cyan-300"><Building2 className="h-5 w-5" /></div>
          <div className="min-w-0"><h2 className="truncate text-sm font-semibold tracking-wide">3D Proposal Viewer</h2><p className="truncate text-[11px] text-slate-500">Measured elevations + honest building massing</p></div>
        </div>
        <button onClick={onClose} className="grid h-10 w-10 place-items-center rounded-lg border border-white/10 text-slate-400 transition hover:bg-white/10 hover:text-white" aria-label="Close 3D proposal viewer"><X className="h-5 w-5" /></button>
      </header>

      <main className="relative flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="relative min-h-[48vh] flex-1 overflow-hidden bg-[#080c11]">
          <div ref={mountRef} className="absolute inset-0" aria-label="Rotatable 3D building proposal" />
          <div className="pointer-events-none absolute left-4 top-4 rounded-lg border border-white/10 bg-[#0b1118]/80 px-3 py-2 text-[11px] text-slate-400 shadow-xl backdrop-blur">
            <span className="flex items-center gap-2"><MousePointer2 className="h-3.5 w-3.5 text-cyan-300" /> Drag to rotate · Wheel or pinch to zoom</span>
          </div>
          <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-white/10 bg-[#0b1118]/90 p-1.5 shadow-2xl backdrop-blur-xl">
            {(['iso', 'front', 'right', 'rear', 'left'] as CameraPreset[]).map(preset => (
              <button key={preset} onClick={() => setCameraPreset(preset)} className="min-h-9 rounded-lg px-3 text-[11px] font-semibold capitalize text-slate-300 transition hover:bg-cyan-400/12 hover:text-cyan-200" title={`View ${preset}`}>
                {preset === 'iso' ? <span className="flex items-center gap-1.5"><Rotate3D className="h-3.5 w-3.5" /> 3D</span> : preset}
              </button>
            ))}
          </div>
        </section>

        <aside className="max-h-[52vh] shrink-0 overflow-y-auto border-t border-white/10 bg-[#0d131b] lg:max-h-none lg:w-[360px] lg:border-l lg:border-t-0">
          <div className="space-y-6 p-5">
            <section>
              <div className="mb-3 flex items-center gap-2"><Maximize2 className="h-4 w-4 text-cyan-300" /><h3 className="text-xs font-bold uppercase tracking-[0.16em] text-slate-300">Building massing</h3></div>
              <div className="grid grid-cols-3 gap-2">
                {([['widthMm', 'Width'], ['depthMm', 'Depth'], ['heightMm', 'Height']] as const).map(([key, label]) => (
                  <label key={key} className="rounded-lg border border-white/10 bg-black/20 p-2.5">
                    <span className="block text-[9px] font-bold uppercase tracking-wider text-slate-500">{label}</span>
                    <span className="mt-1 flex items-baseline gap-1"><input aria-label={`Building ${label.toLowerCase()} in metres`} type="number" min="0.5" step="0.1" value={(model[key] / 1000).toFixed(1)} onChange={event => updateDimension(key, event.target.value)} className="min-w-0 w-full bg-transparent font-mono text-sm text-white outline-none" /><span className="text-[10px] text-slate-500">m</span></span>
                  </label>
                ))}
              </div>
              <p className="mt-2 text-[10px] leading-relaxed text-slate-500">Massing completes the silhouette only. It does not turn missing façades into measured geometry.</p>
            </section>

            <section>
              <div className="mb-3 flex items-center gap-2"><Box className="h-4 w-4 text-cyan-300" /><h3 className="text-xs font-bold uppercase tracking-[0.16em] text-slate-300">Elevation coverage</h3></div>
              <div className="space-y-2">
                {BUILDING_FACE_IDS.map(face => {
                  const assignment = model.faceAssignments[face];
                  const coverage = COVERAGE_STYLES[assignment.coverage];
                  const CoverageIcon = coverage.icon;
                  return (
                    <div key={face} className="rounded-xl border border-white/10 bg-black/20 p-3">
                      <div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold text-slate-200">{FACE_LABELS[face]} elevation</span><span className={`flex items-center gap-1 rounded-full border px-2 py-1 text-[9px] font-bold uppercase tracking-wider ${coverage.className}`}><CoverageIcon className="h-3 w-3" />{coverage.label}</span></div>
                      <select aria-label={`${FACE_LABELS[face]} elevation source`} value={assignment.canvasId ?? ''} onChange={event => assignCanvas(face, event.target.value)} className="h-9 w-full rounded-lg border border-white/10 bg-[#121b26] px-2.5 text-xs text-slate-300 outline-none focus:border-cyan-400/50">
                        <option value="">No elevation supplied</option>
                        {canvases.map(canvas => <option key={canvas.id} value={canvas.id}>{canvas.name}{canvas.backgroundImage ? '' : ' · blank'}</option>)}
                      </select>
                    </div>
                  );
                })}
              </div>
            </section>

            <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-3 text-[10px] leading-relaxed text-amber-100/70">
              <strong className="block text-[11px] text-amber-200">Accuracy rule</strong>
              Only a photographed, four-point calibrated elevation is marked Measured. A photograph without calibration is Estimated; an empty face remains Not surveyed.
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
};

export default Proposal3DViewer;
