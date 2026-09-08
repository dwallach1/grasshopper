'use client';

import { useEffect, useRef } from 'react';
import {
  ACESFilmicToneMapping,
  AmbientLight,
  CanvasTexture,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshPhysicalMaterial,
  NoColorSpace,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  RectAreaLight,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import {
  cardPixelRatio,
  paintCardAlbedo,
  paintFoilMask,
  stampStewardFace,
  STEWARD_CARD_TEX,
  stewardCardInk,
} from '../../lib/steward-card-stock';
import { buildStewardCard } from '../../lib/steward-card-mesh';
import type { StewardIdCard as StewardIdCardModel } from '../../lib/steward-id';

const IDLE_X = 0.055;
const IDLE_Y = 0.1;
const FOLLOW_X = 0.38;
const FOLLOW_Y = 0.5;

export function StewardHeroCard({
  card,
  reduceMotion,
  iconHost,
}: {
  card: StewardIdCardModel;
  reduceMotion: boolean;
  iconHost: HTMLElement | null;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef(card);
  const iconHostRef = useRef(iconHost);
  const reduceRef = useRef(reduceMotion);
  cardRef.current = card;
  iconHostRef.current = iconHost;
  reduceRef.current = reduceMotion;

  useEffect(() => {
    const mount = hostRef.current;
    if (!mount) return;
    const root: HTMLDivElement = mount;

    RectAreaLightUniformsLib.init();

    const scene = new Scene();
    scene.background = new Color(0x07080a);
    const camera = new PerspectiveCamera(28, 1, 0.1, 20);
    camera.position.set(0, 0.06, 4.15);
    camera.lookAt(0, 0, 0);

    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch {
      return undefined;
    }
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.domElement.setAttribute('aria-hidden', 'true');
    root.appendChild(renderer.domElement);

    const pmrem = new PMREMGenerator(renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;

    scene.add(new AmbientLight(0x8a93a0, 0.22));
    scene.add(new HemisphereLight(0xf3eee4, 0x12151a, 0.35));
    const key = new RectAreaLight(0xfff1d6, 8.5, 2.8, 2.2);
    key.position.set(-1.4, 1.6, 2.4);
    key.lookAt(0, 0, 0);
    scene.add(key);
    const fill = new RectAreaLight(0xcdd8ff, 4.2, 2.2, 2.6);
    fill.position.set(1.7, 0.2, 2.1);
    fill.lookAt(0, 0, 0);
    scene.add(fill);
    const rim = new DirectionalLight(0xe8edf2, 1.15);
    rim.position.set(-2.2, 1.4, -2.4);
    scene.add(rim);

    const floor = new Mesh(
      new PlaneGeometry(6, 6),
      new MeshPhysicalMaterial({
        color: 0x07080a,
        roughness: 0.95,
        metalness: 0,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.72;
    scene.add(floor);

    const built = buildStewardCard('#9EC9C8');
    const group = built.group;
    const foil = built.foil;
    scene.add(group);

    const albedo = document.createElement('canvas');
    albedo.width = STEWARD_CARD_TEX.width;
    albedo.height = STEWARD_CARD_TEX.height;
    const mask = document.createElement('canvas');
    mask.width = STEWARD_CARD_TEX.width;
    mask.height = STEWARD_CARD_TEX.height;
    const face = document.createElement('canvas');
    face.width = STEWARD_CARD_TEX.width;
    face.height = STEWARD_CARD_TEX.height;
    const albedoCtx = albedo.getContext('2d');
    const maskCtx = mask.getContext('2d');
    const faceCtx = face.getContext('2d');
    if (!albedoCtx || !maskCtx || !faceCtx) {
      renderer.dispose();
      return undefined;
    }
    paintFoilMask(maskCtx);
    const faceMap = new CanvasTexture(face);
    faceMap.colorSpace = SRGBColorSpace;
    const foilMap = new CanvasTexture(mask);
    foilMap.colorSpace = NoColorSpace;
    foil.map = faceMap;
    foil.uFoilMap.value = foilMap;

    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    let frame = 0;
    let visible = true;
    let lastSlug = '';

    function paintStock(next: StewardIdCardModel) {
      const ink = stewardCardInk(next.slug, next.display_name);
      ink.domain = next.domain;
      paintCardAlbedo(albedoCtx!, ink);
      foil.setInk(ink.fill);
      lastSlug = next.slug;
    }

    function resize() {
      const w = root.clientWidth;
      const h = root.clientHeight;
      if (w < 8 || h < 8) return;
      renderer.setPixelRatio(cardPixelRatio(window.devicePixelRatio || 1));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    function applyTilt(groupRef: Group, elapsed: number) {
      const reduced = reduceRef.current;
      if (reduced) {
        groupRef.rotation.x = 0.04;
        groupRef.rotation.y = -0.06;
        foil.setTilt(0, 0);
        return;
      }
      pointer.x += (pointer.tx - pointer.x) * 0.12;
      pointer.y += (pointer.ty - pointer.y) * 0.12;
      const idleX = Math.sin(elapsed / 2200) * IDLE_X;
      const idleY = Math.cos(elapsed / 2800) * IDLE_Y;
      groupRef.rotation.x = idleX + pointer.y;
      groupRef.rotation.y = idleY + pointer.x;
      foil.setTilt(groupRef.rotation.y, groupRef.rotation.x);
    }

    function draw(now: number) {
      const next = cardRef.current;
      if (next.slug !== lastSlug) paintStock(next);
      const mark = readIcon(iconHostRef.current);
      if (mark) stampStewardFace(faceCtx!, albedo, mark);
      else {
        faceCtx!.clearRect(0, 0, face.width, face.height);
        faceCtx!.drawImage(albedo, 0, 0);
      }
      faceMap.needsUpdate = true;
      applyTilt(group, now);
      renderer.render(scene, camera);
    }

    function tick(now: number) {
      if (!visible) return;
      draw(now);
      if (reduceRef.current) return;
      frame = window.requestAnimationFrame(tick);
    }

    function onPointer(event: PointerEvent) {
      if (reduceRef.current) return;
      const box = root.getBoundingClientRect();
      if (box.width < 8 || box.height < 8) return;
      const nx = MathUtils.clamp((event.clientX - box.left) / box.width, 0, 1) - 0.5;
      const ny = MathUtils.clamp((event.clientY - box.top) / box.height, 0, 1) - 0.5;
      pointer.tx = nx * FOLLOW_Y;
      pointer.ty = -ny * FOLLOW_X;
    }

    function restPointer() {
      pointer.tx = 0;
      pointer.ty = 0;
    }

    const io = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0.15);
      if (visible && !reduceRef.current && frame === 0) {
        frame = window.requestAnimationFrame(tick);
      }
      if (!visible) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
    }, { threshold: [0, 0.15, 0.6] });
    io.observe(root);

    const ro = new ResizeObserver(() => {
      resize();
      draw(performance.now());
    });
    ro.observe(root);
    resize();
    paintStock(cardRef.current);
    draw(performance.now());
    if (!reduceMotion) frame = window.requestAnimationFrame(tick);

    root.addEventListener('pointermove', onPointer);
    root.addEventListener('pointerleave', restPointer);
    return () => {
      io.disconnect();
      ro.disconnect();
      root.removeEventListener('pointermove', onPointer);
      root.removeEventListener('pointerleave', restPointer);
      window.cancelAnimationFrame(frame);
      if (renderer.domElement.parentNode === root) root.removeChild(renderer.domElement);
      faceMap.dispose();
      foilMap.dispose();
      env.dispose();
      pmrem.dispose();
      renderer.dispose();
    };
  }, [reduceMotion]);

  return <div ref={hostRef} className="id-card-webgl" />;
}

function readIcon(host: HTMLElement | null): HTMLCanvasElement | null {
  const node = host?.querySelector('canvas[data-icon="circle-eyes"]');
  return node instanceof HTMLCanvasElement ? node : null;
}
