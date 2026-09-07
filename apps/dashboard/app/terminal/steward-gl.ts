/**
 * Shared WebGL steward runtime.
 * One renderer copies into retina 2d canvases so Board + Team stay under the
 * browser context cap. Rive would need authored .riv files (none in-repo) and
 * is 2D — fluffy plush is a sheen/halo mesh, not SVG noise.
 */
import * as THREE from 'three';

import {
  stewardFurTone,
  stewardMeshSpec,
  type StewardBotKind,
} from '../../lib/desk-avatar';
import {
  stewardBlinkCover,
  stewardBreathe,
  stewardGlanceX,
  stewardPulse,
} from '../../lib/steward-motion';
import { attachFlatCanvas } from './steward-flat';

type EyeRig = {
  group: THREE.Group;
  lid: THREE.Mesh;
  pupil: THREE.Mesh;
  tilt: number;
};

type Slot = {
  canvas: HTMLCanvasElement;
  kind: StewardBotKind;
  alive: boolean;
  delayMs: number;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  figure: THREE.Group;
  leftEye: EyeRig;
  rightEye: EyeRig;
  key: THREE.DirectionalLight;
  visible: boolean;
};

const slots = new Set<Slot>();
const bodyGeo = new Map<StewardBotKind, THREE.BufferGeometry>();
let renderer: THREE.WebGLRenderer | null = null;
let glBlocked = false;
let raf = 0;
let originMs = 0;

const MAX_DPR = 2;
const LID_GEO = new THREE.SphereGeometry(1.05, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.58);
const EYE_GEO = new THREE.SphereGeometry(1, 32, 24);
const PUPIL_GEO = new THREE.SphereGeometry(0.34, 20, 16);

export function attachStewardCanvas(
  canvas: HTMLCanvasElement,
  kind: StewardBotKind,
  alive: boolean,
  delayMs: number,
): () => void {
  try {
    ensureLoop();
  } catch {
    glBlocked = true;
  }
  if (glBlocked || !renderer) {
    return attachFlatCanvas(canvas, kind, alive, delayMs);
  }
  const slot = buildSlot(canvas, kind, alive, delayMs);
  slots.add(slot);
  const observer = new IntersectionObserver((entries) => {
    slot.visible = entries.some((entry) => entry.isIntersecting);
  }, { threshold: 0.05 });
  observer.observe(canvas);
  const resize = new ResizeObserver(() => {
    if (slot.visible) paintSlot(slot, performance.now() - originMs, reducedMotion());
  });
  resize.observe(canvas);
  canvas.dataset.runtime = 'three';
  paintSlot(slot, 0, reducedMotion());

  return () => {
    observer.disconnect();
    resize.disconnect();
    slots.delete(slot);
    disposeScene(slot.scene);
    if (slots.size === 0) stopLoop();
  };
}

function buildSlot(
  canvas: HTMLCanvasElement,
  kind: StewardBotKind,
  alive: boolean,
  delayMs: number,
): Slot {
  const spec = stewardMeshSpec(kind);
  const fur = stewardFurTone(kind);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 12);
  camera.position.set(0, 0.12, 3.35);
  camera.lookAt(0, -0.08, 0);

  const figure = new THREE.Group();
  const bodyMat = plushMaterial(fur.base, fur.lit);
  const body = new THREE.Mesh(bodyGeometry(kind), bodyMat);
  body.name = 'mound';
  figure.add(body);

  const halo = new THREE.Mesh(
    bodyGeometry(kind),
    new THREE.MeshBasicMaterial({
      color: fur.lit,
      transparent: true,
      opacity: 0.16,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  halo.scale.setScalar(1.045);
  halo.name = 'halo';
  figure.add(halo);

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.72, 32),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -0.92;
  shadow.scale.set(spec.girth * 0.72, 0.38, 1);
  scene.add(shadow);

  const leftEye = eyeRig(fur.base, fur.deep, spec.lidTiltL);
  const rightEye = eyeRig(fur.base, fur.deep, spec.lidTiltR);
  placeEye(leftEye.group, -spec.eyeSpread, spec);
  placeEye(rightEye.group, spec.eyeSpread, spec);
  figure.add(leftEye.group);
  figure.add(rightEye.group);

  const hemi = new THREE.HemisphereLight(fur.lit, fur.deep, 1.15);
  const key = new THREE.DirectionalLight(0xfff8f0, 1.05);
  key.position.set(-1.15, 1.55, 1.45);
  const fill = new THREE.DirectionalLight(fur.deep, 0.22);
  fill.position.set(1.35, 0.15, 0.7);
  scene.add(hemi);
  scene.add(key);
  scene.add(fill);
  scene.add(figure);

  return {
    canvas,
    kind,
    alive,
    delayMs,
    scene,
    camera,
    figure,
    leftEye,
    rightEye,
    key,
    visible: true,
  };
}

function placeEye(group: THREE.Group, x: number, spec: ReturnType<typeof stewardMeshSpec>) {
  group.position.set(x * 1.55, spec.eyeY, spec.eyeZ);
  group.scale.setScalar(spec.eyeR * 1.22);
}

function eyeRig(fur: string, deep: string, tilt: number): EyeRig {
  const group = new THREE.Group();
  const white = new THREE.Mesh(
    EYE_GEO,
    new THREE.MeshPhysicalMaterial({
      color: 0xf7f2ea,
      roughness: 0.28,
      metalness: 0,
      clearcoat: 0.35,
      clearcoatRoughness: 0.35,
    }),
  );
  white.name = 'eye';
  const pupil = new THREE.Mesh(
    PUPIL_GEO,
    new THREE.MeshStandardMaterial({ color: 0x16141c, roughness: 0.45 }),
  );
  pupil.position.set(0, -0.12, 0.78);
  const lid = new THREE.Mesh(LID_GEO, plushMaterial(deep, fur));
  lid.name = 'lid';
  lid.rotation.z = tilt;
  group.add(white);
  group.add(pupil);
  group.add(lid);
  return { group, lid, pupil, tilt };
}

function plushMaterial(base: string, lit: string): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: base,
    roughness: 0.72,
    metalness: 0,
    emissive: new THREE.Color(base),
    emissiveIntensity: 0.12,
    sheen: 1,
    sheenRoughness: 0.4,
    sheenColor: new THREE.Color(lit),
    clearcoat: 0.08,
    clearcoatRoughness: 0.7,
  });
}

function bodyGeometry(kind: StewardBotKind): THREE.BufferGeometry {
  const hit = bodyGeo.get(kind);
  if (hit) return hit;
  const spec = stewardMeshSpec(kind);
  const geo = new THREE.SphereGeometry(1, 48, 36);
  const pos = geo.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 1) {
    v.fromBufferAttribute(pos, i);
    const h = (v.y + 1) * 0.5;
    v.y *= spec.peak;
    const slim = 0.56;
    v.x *= THREE.MathUtils.lerp(spec.girth, slim, h);
    v.z *= THREE.MathUtils.lerp(spec.girth * 0.9, slim + 0.04, h);
    if (v.y < -0.15) v.y = THREE.MathUtils.lerp(v.y, -0.88, spec.flatten);
    const dx = v.x - spec.bumpX;
    const dy = v.y - spec.bumpY;
    const fall = Math.exp(-(dx * dx + dy * dy) * 6.4);
    v.x += spec.bumpX * spec.bumpGain * fall;
    v.y += spec.bumpGain * 0.32 * fall;
    const plump = Math.sin(v.x * 2.15 + v.z * 1.55) * Math.cos(v.y * 2.4);
    v.addScaledVector(v.clone().normalize(), plump * 0.028);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  bodyGeo.set(kind, geo);
  return geo;
}

function ensureLoop() {
  if (renderer || glBlocked) return;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'low-power',
      failIfMajorPerformanceCaveat: false,
    });
  } catch {
    glBlocked = true;
    renderer = null;
    return;
  }
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  originMs = performance.now();
  if (reducedMotion()) return;
  const tick = (now: number) => {
    raf = window.requestAnimationFrame(tick);
    const elapsed = now - originMs;
    for (const slot of slots) {
      if (slot.visible) paintSlot(slot, elapsed, false);
    }
  };
  raf = window.requestAnimationFrame(tick);
}

function stopLoop() {
  window.cancelAnimationFrame(raf);
  raf = 0;
  renderer?.dispose();
  renderer = null;
}

function paintSlot(slot: Slot, elapsed: number, still: boolean) {
  const gl = renderer;
  if (!gl) return;
  const spec = stewardMeshSpec(slot.kind);
  const rest = spec.lidCover;
  const breathe = still ? 0.5 : stewardBreathe(elapsed, slot.delayMs, slot.alive);
  const blink = still ? rest : stewardBlinkCover(elapsed, slot.delayMs, rest);
  const glance = still ? 0 : stewardGlanceX(elapsed, slot.delayMs);
  const pulse = still ? 1 : stewardPulse(elapsed, slot.delayMs, slot.alive);
  slot.figure.scale.set(1 - breathe * 0.03, 1 + breathe * 0.06, 1 - breathe * 0.02);
  slot.figure.position.y = breathe * 0.07;
  slot.key.intensity = slot.alive ? 0.95 + breathe * 0.2 : 1.05;
  writeEye(slot.leftEye, blink, spec.lidCover, glance, pulse);
  writeEye(slot.rightEye, blink, spec.lidCover, glance, pulse);

  const css = slot.canvas.clientWidth || slot.canvas.offsetWidth || 72;
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const bw = Math.max(1, Math.round(css * dpr));
  const bh = bw;
  if (slot.canvas.width !== bw || slot.canvas.height !== bh) {
    slot.canvas.width = bw;
    slot.canvas.height = bh;
  }
  slot.camera.aspect = 1;
  slot.camera.updateProjectionMatrix();
  const ss = 2;
  gl.setPixelRatio(1);
  gl.setSize(bw * ss, bh * ss, false);
  gl.render(slot.scene, slot.camera);
  const ctx = slot.canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, bw, bh);
  ctx.drawImage(gl.domElement, 0, 0, bw, bh);
}

function writeEye(
  rig: EyeRig,
  lid: number,
  rest: number,
  glance: number,
  pulse: number,
) {
  const close = rest >= 1 ? 1 : Math.max(0, (lid - rest) / (1 - rest));
  rig.lid.rotation.z = rig.tilt;
  rig.lid.rotation.x = close * 1.15;
  rig.pupil.position.set(glance * 0.28, -0.12, 0.78);
  rig.pupil.scale.setScalar(pulse);
}

function disposeScene(scene: THREE.Scene) {
  const shared = new Set<THREE.BufferGeometry>([...bodyGeo.values(), LID_GEO, EYE_GEO, PUPIL_GEO]);
  scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (!shared.has(obj.geometry)) obj.geometry.dispose();
    const mat = obj.material;
    if (Array.isArray(mat)) mat.forEach((item) => item.dispose());
    else mat.dispose();
  });
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
