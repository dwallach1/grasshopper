'use client';

import { useEffect, useRef, useState } from 'react';
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
  islandAllowsComposer,
  islandDrawingOk,
  islandHitThesisId,
  islandHostSize,
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
  const [webgl, setWebgl] = useState(true);
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
    scene.fog = new Fog(ISLAND_CREAM, 36, 72);

    const camera = new PerspectiveCamera(ISLAND_CAMERA.fov, 1, 0.1, 90);
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
      setWebgl(false);
      return undefined;
    }
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.setClearColor(ISLAND_CREAM, 1);
    const webgl2 = isWebGL2Available();
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    renderer.domElement.setAttribute('aria-hidden', 'true');
    renderer.domElement.hidden = true;
    root.appendChild(renderer.domElement);

    function dropWebgl(): void {
      setWebgl(false);
      renderer.domElement.hidden = true;
    }

    function onContextLost(event: Event): void {
      event.preventDefault();
      dropWebgl();
    }
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);

    const pmrem = new PMREMGenerator(renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.48;

    scene.add(new AmbientLight(0xf6efe2, 0.32));
    scene.add(new HemisphereLight(0xfff6e8, 0xc4b49a, 0.7));
    const key = new DirectionalLight(0xfff3d6, 1.62);
    key.position.set(-5.1, 11.4, 7.2);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 42;
    key.shadow.camera.left = -11;
    key.shadow.camera.right = 11;
    key.shadow.camera.top = 11;
    key.shadow.camera.bottom = -11;
    key.shadow.radius = 2.2;
    key.shadow.bias = -0.0009;
    scene.add(key);
    const fill = new DirectionalLight(0xe4edff, 0.42);
    fill.position.set(5.5, 3.4, -2.2);
    scene.add(fill);

    const island = buildThesisIsland(districtRef.current, peekRef.current);
    scene.add(island.group);

    let composer: EffectComposer | null = null;
    if (islandAllowsComposer({
      webgl2,
      userAgent: navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints,
    })) {
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
    let presented = false;

    function viewportBox(): { width: number; height: number } {
      const view = window.visualViewport;
      return {
        width: view?.width || window.innerWidth,
        height: Math.max(120, (view?.height || window.innerHeight) - 88),
      };
    }

    function resize(): boolean {
      const box = islandHostSize(root, viewportBox());
      if (!islandDrawingOk(box.width, box.height)) return false;
      renderer.setPixelRatio(islandPixelRatio(window.devicePixelRatio || 1));
      renderer.setSize(box.width, box.height, false);
      composer?.setSize(box.width, box.height);
      camera.aspect = box.width / box.height;
      camera.updateProjectionMatrix();
      return true;
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
      if (!presented) {
        presented = true;
        renderer.domElement.hidden = false;
        setWebgl(true);
      }
    }

    function tick(now: number): void {
      if (!visible) return;
      if (!resize()) {
        dropWebgl();
        return;
      }
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
      visible = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0.05)
        || root.clientWidth >= 8;
      if (visible && !reduceRef.current && frame === 0) {
        frame = window.requestAnimationFrame(tick);
      }
      if (!visible) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
    }, { threshold: [0, 0.05, 0.2, 0.6] });
    io.observe(root);

    const ro = new ResizeObserver(() => {
      if (!resize()) return;
      draw(performance.now());
    });
    ro.observe(root);
    if (resize()) {
      draw(performance.now());
      if (!reduceMotion) frame = window.requestAnimationFrame(tick);
    } else {
      dropWebgl();
    }

    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('pointerup', onPointerUp);
    return () => {
      io.disconnect();
      ro.disconnect();
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      window.cancelAnimationFrame(frame);
      renderer.domElement.remove();
      island.dispose();
      env.dispose();
      pmrem.dispose();
      composer?.dispose();
      renderer.dispose();
    };
  }, [district.id, peek?.id, reduceMotion]);

  return (
    <div
      ref={hostRef}
      className="thesis-island"
      data-webgl={webgl ? '1' : '0'}
    >
      <ThesisIslandPoster district={district} />
    </div>
  );
}

export function ThesisIslandPoster({ district }: { district: ThesisDistrict }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const host = canvas.parentElement;
    const box = islandHostSize(
      { clientWidth: host?.clientWidth ?? 0, clientHeight: host?.clientHeight ?? 0 },
      {
        width: typeof window === 'undefined' ? 390 : window.innerWidth,
        height: typeof window === 'undefined' ? 640 : Math.max(120, window.innerHeight - 88),
      },
    );
    canvas.width = box.width;
    canvas.height = box.height;
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
