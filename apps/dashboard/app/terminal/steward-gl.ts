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

type Slot = {
  canvas: HTMLCanvasElement;
  kind: StewardBotKind;
  alive: boolean;
  delayMs: number;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  figure: THREE.Group;
  leftEye: THREE.Mesh;
  rightEye: THREE.Mesh;
  key: THREE.DirectionalLight;
  visible: boolean;
};

const slots = new Set<Slot>();
const bodyGeo = new Map<StewardBotKind, THREE.BufferGeometry>();
let renderer: THREE.WebGLRenderer | null = null;
let raf = 0;
let originMs = 0;

const MAX_DPR = 2;
const EYE_VERT = `
varying vec3 vObjN;
void main() {
  vObjN = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const EYE_FRAG = `
varying vec3 vObjN;
uniform vec3 uFur;
uniform vec3 uFurDeep;
uniform float uLid;
uniform float uTilt;
uniform vec2 uGlance;
uniform float uPulse;
void main() {
  vec3 N = normalize(vObjN);
  vec3 lidDir = normalize(vec3(sin(uTilt), cos(uTilt), 0.12));
  float thresh = mix(1.0, -0.96, clamp(uLid, 0.0, 1.0));
  if (dot(N, lidDir) > thresh) {
    float wrap = N.y * 0.45 + 0.55;
    gl_FragColor = vec4(mix(uFurDeep, uFur, wrap), 1.0);
    return;
  }
  vec2 pc = vec2(uGlance.x, -0.16 + uGlance.y);
  float pupil = length(N.xy - pc) * (1.2 - max(N.z, 0.0));
  if (N.z > 0.18 && pupil < 0.3 * uPulse) {
    gl_FragColor = vec4(0.09, 0.08, 0.11, 1.0);
    return;
  }
  float glint = step(length(N.xy - vec2(-0.16, 0.04)), 0.07) * step(0.35, N.z);
  vec3 white = mix(vec3(0.93, 0.91, 0.88), vec3(1.0), pow(max(N.z, 0.0), 5.0));
  gl_FragColor = vec4(mix(white, vec3(1.0), glint), 1.0);
}
`;

export function attachStewardCanvas(
  canvas: HTMLCanvasElement,
  kind: StewardBotKind,
  alive: boolean,
  delayMs: number,
): () => void {
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
  ensureLoop();
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

  const leftEye = eyeMesh(fur.base, fur.deep);
  const rightEye = eyeMesh(fur.base, fur.deep);
  placeEye(leftEye, -spec.eyeSpread, spec);
  placeEye(rightEye, spec.eyeSpread, spec);
  figure.add(leftEye);
  figure.add(rightEye);

  const hemi = new THREE.HemisphereLight(fur.lit, fur.deep, 0.9);
  const key = new THREE.DirectionalLight(0xfff6ea, 0.72);
  key.position.set(-1.15, 1.55, 1.45);
  const fill = new THREE.DirectionalLight(fur.deep, 0.28);
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

function placeEye(mesh: THREE.Mesh, x: number, spec: ReturnType<typeof stewardMeshSpec>) {
  mesh.position.set(x * 1.55, spec.eyeY, spec.eyeZ);
  mesh.scale.setScalar(spec.eyeR * 1.15);
}

function eyeMesh(fur: string, deep: string): THREE.Mesh {
  const uniforms = {
    uFur: { value: new THREE.Color(fur) },
    uFurDeep: { value: new THREE.Color(deep) },
    uLid: { value: 0.5 },
    uTilt: { value: 0 },
    uGlance: { value: new THREE.Vector2(0, 0) },
    uPulse: { value: 1 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: EYE_VERT,
    fragmentShader: EYE_FRAG,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24), material);
  mesh.name = 'eye';
  return mesh;
}

function plushMaterial(base: string, lit: string): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: base,
    roughness: 0.86,
    metalness: 0,
    sheen: 1,
    sheenRoughness: 0.52,
    sheenColor: new THREE.Color(lit),
    clearcoat: 0.05,
    clearcoatRoughness: 0.78,
  });
}

function bodyGeometry(kind: StewardBotKind): THREE.BufferGeometry {
  const hit = bodyGeo.get(kind);
  if (hit) return hit;
  const spec = stewardMeshSpec(kind);
  const geo = new THREE.IcosahedronGeometry(1, 3);
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
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'low-power',
  });
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
  slot.figure.scale.set(1 - breathe * 0.012, 1 + breathe * 0.03, 1 - breathe * 0.01);
  slot.figure.position.y = breathe * 0.03;
  slot.key.intensity = slot.alive ? 0.68 + breathe * 0.22 : 0.72;
  writeEye(slot.leftEye, blink, spec.lidTiltL, glance, pulse);
  writeEye(slot.rightEye, blink, spec.lidTiltR, glance, pulse);

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
  gl.setPixelRatio(1);
  gl.setSize(bw, bh, false);
  gl.render(slot.scene, slot.camera);
  const ctx = slot.canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, bw, bh);
  ctx.drawImage(gl.domElement, 0, 0, bw, bh);
}

function writeEye(
  mesh: THREE.Mesh,
  lid: number,
  tilt: number,
  glance: number,
  pulse: number,
) {
  const material = mesh.material;
  if (!(material instanceof THREE.ShaderMaterial)) return;
  material.uniforms.uLid.value = lid;
  material.uniforms.uTilt.value = tilt;
  material.uniforms.uGlance.value.set(glance, 0);
  material.uniforms.uPulse.value = pulse;
}

function disposeScene(scene: THREE.Scene) {
  const shared = new Set(bodyGeo.values());
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
