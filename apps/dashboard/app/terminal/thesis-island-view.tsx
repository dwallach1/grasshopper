'use client';

import { useEffect, useRef } from 'react';
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { isWebGL2Available } from '../../lib/steward-foil';
import {
  buildThesisIsland,
  ISLAND_CAMERA,
  ISLAND_CREAM,
  islandHitThesisId,
  islandPixelRatio,
  paintIslandPoster,
} from '../../lib/thesis-island';
import type { ThesisBuilding, ThesisDistrict } from '../../lib/thesis-districts';

export function ThesisIslandView({
  district,
  peek,
  reduceMotion,
  onOpen,
}: {
  district: ThesisDistrict;
  peek?: ThesisDistrict | null;
  reduceMotion: boolean;
  onOpen: (building: ThesisBuilding) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(onOpen);
  const districtRef = useRef(district);
  const peekRef = useRef(peek);
  const reduceRef = useRef(reduceMotion);
  openRef.current = onOpen;
  districtRef.current = district;
  peekRef.current = peek;
  reduceRef.current = reduceMotion;

  useEffect(() => {
    const mount = hostRef.current;
    if (!mount) return undefined;
    const root: HTMLDivElement = mount;

    const scene = new Scene();
    scene.background = new Color(ISLAND_CREAM);
    scene.fog = new Fog(ISLAND_CREAM, 14, 28);

    const camera = new PerspectiveCamera(ISLAND_CAMERA.fov, 1, 0.1, 60);
    camera.position.set(ISLAND_CAMERA.x, ISLAND_CAMERA.y, ISLAND_CAMERA.z);
    camera.lookAt(ISLAND_CAMERA.lookX, ISLAND_CAMERA.lookY, ISLAND_CAMERA.lookZ);

    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
        failIfMajorPerformanceCaveat: false,
        preserveDrawingBuffer: true,
      });
    } catch {
      const poster = document.createElement('canvas');
      poster.className = 'thesis-island-poster';
      poster.setAttribute('aria-hidden', 'true');
      root.appendChild(poster);
      const box = root.getBoundingClientRect();
      poster.width = Math.max(8, Math.round(box.width || 390));
      poster.height = Math.max(8, Math.round(box.height || 640));
      const ctx = poster.getContext('2d');
      if (ctx) paintIslandPoster(ctx, districtRef.current);
      return () => {
        if (poster.parentNode === root) root.removeChild(poster);
      };
    }
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setClearColor(ISLAND_CREAM, 1);
    const webgl2 = isWebGL2Available();
    renderer.shadowMap.enabled = webgl2;
    if (webgl2) renderer.shadowMap.type = PCFSoftShadowMap;
    renderer.domElement.setAttribute('aria-hidden', 'true');
    root.appendChild(renderer.domElement);

    const pmrem = new PMREMGenerator(renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.32;

    scene.add(new AmbientLight(0xf2ead8, 0.42));
    scene.add(new HemisphereLight(0xf7f0e4, 0xc4b49a, 0.72));
    const key = new DirectionalLight(0xfff6e8, 1.28);
    key.position.set(6.2, 9.4, 4.2);
    key.castShadow = webgl2;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 28;
    key.shadow.camera.left = -8;
    key.shadow.camera.right = 8;
    key.shadow.camera.top = 8;
    key.shadow.camera.bottom = -8;
    key.shadow.radius = 2.2;
    key.shadow.bias = -0.0009;
    scene.add(key);

    const island = buildThesisIsland(districtRef.current, peekRef.current);
    scene.add(island.group);

    let composer: EffectComposer | null = null;
    if (webgl2) {
      try {
        composer = new EffectComposer(renderer);
        composer.addPass(new RenderPass(scene, camera));
        const focus = camera.position.distanceTo(island.group.position.clone().setY(0.9));
        composer.addPass(new BokehPass(scene, camera, {
          focus,
          aperture: 0.00016,
          maxblur: 0.009,
        }));
      } catch {
        composer = null;
      }
    }

    const raycaster = new Raycaster();
    const pointer = new Vector2();
    const tap = { x: 0, y: 0, active: false };
    let frame = 0;
    let visible = true;

    function resize(): void {
      const parent = root.parentElement;
      const w = Math.max(root.clientWidth, parent?.clientWidth ?? 0);
      const h = Math.max(root.clientHeight, parent?.clientHeight ?? 0, window.innerHeight - 88);
      if (w < 8 || h < 8) return;
      renderer.setPixelRatio(islandPixelRatio(window.devicePixelRatio || 1));
      renderer.setSize(w, h, false);
      composer?.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    function draw(now: number): void {
      if (!reduceRef.current) {
        const yaw = Math.sin(now / 4200) * 0.028;
        island.group.rotation.y = yaw;
        for (const blades of island.turbines) blades.rotation.x += 0.012;
      } else {
        island.group.rotation.y = 0;
      }
      if (composer) composer.render();
      else renderer.render(scene, camera);
    }

    function tick(now: number): void {
      if (!visible) return;
      draw(now);
      if (reduceRef.current) return;
      frame = window.requestAnimationFrame(tick);
    }

    function hitAt(clientX: number, clientY: number): ThesisBuilding | undefined {
      const box = root.getBoundingClientRect();
      if (box.width < 8 || box.height < 8) return undefined;
      pointer.x = ((clientX - box.left) / box.width) * 2 - 1;
      pointer.y = -((clientY - box.top) / box.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(island.hits, true);
      const id = islandHitThesisId(hits[0]?.object ?? null);
      return districtRef.current.buildings.find((row) => row.id === id);
    }

    function onPointerDown(event: PointerEvent): void {
      tap.x = event.clientX;
      tap.y = event.clientY;
      tap.active = true;
    }

    function onPointerUp(event: PointerEvent): void {
      if (!tap.active) return;
      tap.active = false;
      if (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 12) return;
      const building = hitAt(event.clientX, event.clientY);
      if (building) openRef.current(building);
    }

    const io = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0.2);
      if (visible && !reduceRef.current && frame === 0) {
        frame = window.requestAnimationFrame(tick);
      }
      if (!visible) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
    }, { threshold: [0, 0.2, 0.6] });
    io.observe(root);

    const ro = new ResizeObserver(() => {
      resize();
      draw(performance.now());
    });
    ro.observe(root);
    resize();
    draw(performance.now());
    if (!reduceMotion) frame = window.requestAnimationFrame(tick);

    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('pointerup', onPointerUp);
    return () => {
      io.disconnect();
      ro.disconnect();
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('pointerup', onPointerUp);
      window.cancelAnimationFrame(frame);
      renderer.domElement.remove();
      island.dispose();
      env.dispose();
      pmrem.dispose();
      composer?.dispose();
      renderer.dispose();
    };
  }, [district.id, peek?.id, reduceMotion]);

  return <div ref={hostRef} className="thesis-island" />;
}

export function ThesisIslandPoster({ district }: { district: ThesisDistrict }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const box = canvas.parentElement?.getBoundingClientRect();
    canvas.width = Math.max(8, Math.round(box?.width ?? 390));
    canvas.height = Math.max(8, Math.round(box?.height ?? 640));
    const ctx = canvas.getContext('2d');
    if (ctx) paintIslandPoster(ctx, district);
  }, [district]);

  return (
    <canvas
      ref={canvasRef}
      className="thesis-island-poster"
      aria-hidden="true"
    />
  );
}
