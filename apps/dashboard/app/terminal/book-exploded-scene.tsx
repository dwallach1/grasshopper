'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

import { slabTone, type BookSlab } from '../../lib/book-slabs';
import { NOT_IN_LEDGER } from '../../lib/book-performance';
import type { BookExplodedProps } from './book-exploded';

const COLOR = {
  up: 0x3ddc84,
  down: 0xff5c33,
  neutral: 0x5b9fd4,
  cash: 0xffb000,
  grid: 0x1c242e,
  hover: 0xe8edf2,
} as const;

const OPACITY = {
  live: 0.92,
  muted: 0.28,
  cash: 0.7,
  hover: 1,
} as const;

type SlabMesh = {
  id: string;
  slab: BookSlab;
  group: THREE.Group;
  edges: THREE.LineSegments;
  hit: THREE.Mesh;
};

function toneColor(tone: ReturnType<typeof slabTone>): number {
  return COLOR[tone];
}

function slabOpacity(slab: BookSlab): number {
  if (slab.kind === 'cash') return slab.muted ? OPACITY.muted : OPACITY.cash;
  return slab.muted ? OPACITY.muted : OPACITY.live;
}

function massScale(mass: number, maxMass: number): number {
  if (maxMass <= 0 || mass <= 0) return 0.22;
  return 0.22 + Math.sqrt(mass / maxMass) * 0.78;
}

function hexRing(radius: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 6; i += 1) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
  }
  pts.push(pts[0]!.clone());
  return pts;
}

function hexGrid(rings: number): THREE.LineSegments {
  const positions: number[] = [];
  const hexR = 0.52;
  for (let q = -rings; q <= rings; q += 1) {
    for (let r = -rings; r <= rings; r += 1) {
      if (Math.abs(q + r) > rings) continue;
      const x = hexR * (1.5 * q);
      const z = hexR * ((Math.sqrt(3) / 2) * q + Math.sqrt(3) * r);
      const ring = hexRing(hexR * 0.92);
      for (let i = 0; i < ring.length - 1; i += 1) {
        positions.push(ring[i]!.x + x, 0, ring[i]!.y + z);
        positions.push(ring[i + 1]!.x + x, 0, ring[i + 1]!.y + z);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({
    color: COLOR.grid,
    transparent: true,
    opacity: 0.45,
  });
  return new THREE.LineSegments(geo, mat);
}

function makeSlab(slab: BookSlab, scale: number, index: number, lotCount: number): SlabMesh {
  const tone = slabTone(slab);
  const isCash = slab.kind === 'cash';
  const height = isCash ? 0.28 + scale * 0.7 : 0.45 + scale * 2.35;
  const width = isCash ? 0.7 + scale * 0.55 : 0.38 + scale * 0.5;
  const depth = isCash ? 0.7 + scale * 0.55 : 0.38 + scale * 0.5;
  const geo = new THREE.BoxGeometry(width, height, depth);
  const edgesGeo = new THREE.EdgesGeometry(geo);
  const mat = new THREE.LineBasicMaterial({
    color: toneColor(tone),
    transparent: true,
    opacity: slabOpacity(slab),
  });
  const edges = new THREE.LineSegments(edgesGeo, mat);
  edges.userData.slabId = slab.id;
  const hit = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
    }),
  );
  hit.userData.slabId = slab.id;
  const group = new THREE.Group();
  group.add(hit);
  group.add(edges);
  if (isCash) {
    group.position.set(2.15, height / 2, 0.15);
  } else {
    const t = lotCount <= 1 ? 0 : (index / Math.max(1, lotCount - 1)) * Math.PI - Math.PI / 2;
    const radius = 0.85 + lotCount * 0.08;
    group.position.set(
      Math.cos(t) * radius,
      height / 2 + index * 0.42,
      Math.sin(t) * radius * 0.55,
    );
  }
  group.userData.slabId = slab.id;
  return { id: slab.id, slab, group, edges, hit };
}

function readoutFor(slab: BookSlab): string {
  const notion = slab.notional;
  const notionText = notion === null
    ? slab.note || NOT_IN_LEDGER
    : new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }).format(notion);
  if (slab.kind === 'cash') {
    return notion === null
      ? `CASH · ${NOT_IN_LEDGER}`
      : `CASH · ${notionText} leftover`;
  }
  return slab.muted
    ? `${slab.symbol} · ${notionText}`
    : `${slab.symbol} · ${notionText}`;
}

function disposeMesh(mesh: SlabMesh) {
  mesh.edges.geometry.dispose();
  mesh.hit.geometry.dispose();
  const edgeMat = mesh.edges.material;
  if (Array.isArray(edgeMat)) edgeMat.forEach((item) => item.dispose());
  else edgeMat.dispose();
  const hitMat = mesh.hit.material;
  if (Array.isArray(hitMat)) hitMat.forEach((item) => item.dispose());
  else hitMat.dispose();
}

function paintHighlight(meshes: SlabMesh[], selectedId: string | null, hoverId: string | null) {
  for (const mesh of meshes) {
    const mat = mesh.edges.material;
    if (!(mat instanceof THREE.LineBasicMaterial)) continue;
    const active = mesh.id === selectedId || mesh.id === hoverId;
    mat.color.setHex(active ? COLOR.hover : toneColor(slabTone(mesh.slab)));
    mat.opacity = active ? OPACITY.hover : slabOpacity(mesh.slab);
  }
}

export function BookExplodedScene({ slabs, selectedId, onSelect }: BookExplodedProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<BookSlab | null>(null);
  const selectedRef = useRef(selectedId);
  const hoverIdRef = useRef<string | null>(null);
  const onSelectRef = useRef(onSelect);
  selectedRef.current = selectedId;
  onSelectRef.current = onSelect;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x07080a);
    scene.fog = new THREE.Fog(0x07080a, 8, 16);

    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 40);
    camera.position.set(4.6, 3.4, 6.2);
    camera.lookAt(0.35, 1.15, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, Math.max(host.clientHeight, 200));
    renderer.domElement.setAttribute('aria-hidden', 'true');
    host.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0x6f7c8c, 0.7));
    const key = new THREE.DirectionalLight(0xb9d4ff, 1.1);
    key.position.set(3, 6, 4);
    scene.add(key);
    const fill = new THREE.PointLight(0x5b9fd4, 0.55, 12);
    fill.position.set(-2, 3, 2);
    scene.add(fill);

    const grid = hexGrid(5);
    scene.add(grid);

    const cluster = new THREE.Group();
    scene.add(cluster);

    const lots = slabs.filter((row) => row.kind === 'lot');
    const maxMass = Math.max(1, ...slabs.map((row) => row.mass));
    const meshes: SlabMesh[] = [];
    lots.forEach((slab, index) => {
      const mesh = makeSlab(slab, massScale(slab.mass, maxMass), index, lots.length);
      meshes.push(mesh);
      cluster.add(mesh.group);
    });
    const cash = slabs.find((row) => row.kind === 'cash');
    if (cash) {
      const mesh = makeSlab(cash, massScale(cash.mass, maxMass), 0, lots.length);
      meshes.push(mesh);
      cluster.add(mesh.group);
    }
    paintHighlight(meshes, selectedRef.current, null);

    const raycaster = new THREE.Raycaster();
    raycaster.params.Line = { ...raycaster.params.Line, threshold: 0.18 };
    const pointer = new THREE.Vector2();
    const hitToId = new Map<THREE.Object3D, string>();
    for (const mesh of meshes) hitToId.set(mesh.hit, mesh.id);

    function hitId(event: PointerEvent): string | null {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects([...hitToId.keys()], false);
      const obj = hits[0]?.object;
      if (!obj) return null;
      return hitToId.get(obj) ?? null;
    }

    function onMove(event: PointerEvent) {
      const id = hitId(event);
      hoverIdRef.current = id;
      const mesh = meshes.find((row) => row.id === id) ?? null;
      setHover(mesh?.slab ?? null);
      paintHighlight(meshes, selectedRef.current, id);
      renderer.domElement.style.cursor = id ? 'pointer' : 'default';
    }

    function onClick(event: PointerEvent) {
      const id = hitId(event);
      onSelectRef.current(id);
    }

    function onLeave() {
      hoverIdRef.current = null;
      setHover(null);
      paintHighlight(meshes, selectedRef.current, null);
      renderer.domElement.style.cursor = 'default';
    }

    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('click', onClick);
    renderer.domElement.addEventListener('pointerleave', onLeave);

    const resize = () => {
      const width = host.clientWidth;
      const height = Math.max(host.clientHeight, 200);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    let frame = 0;
    const tick = () => {
      frame = window.requestAnimationFrame(tick);
      paintHighlight(meshes, selectedRef.current, hoverIdRef.current);
      if (!hoverIdRef.current) {
        cluster.rotation.y += 0.0016;
      }
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      window.cancelAnimationFrame(frame);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('click', onClick);
      renderer.domElement.removeEventListener('pointerleave', onLeave);
      meshes.forEach(disposeMesh);
      grid.geometry.dispose();
      if (grid.material instanceof THREE.LineBasicMaterial) grid.material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [slabs]);

  const lots = slabs.filter((row) => row.kind === 'lot');
  const cash = slabs.find((row) => row.kind === 'cash');
  const focus = hover ?? slabs.find((row) => row.id === selectedId) ?? null;

  return (
    <div className="term-exploded">
      <b className="term-exploded-mark" aria-hidden="true">AGENTIC</b>
      <div ref={hostRef} className="term-exploded-stage" />
      <div className="term-exploded-hud">
        <span>
          <i className="live" />
          READY
        </span>
        <span>{lots.length} open lot{lots.length === 1 ? '' : 's'}</span>
        <span>
          {cash?.notional === null
            ? `leftover ${NOT_IN_LEDGER}`
            : 'leftover cash'}
        </span>
        <span className="term-exploded-focus">
          {focus ? readoutFor(focus) : 'hover a slab'}
        </span>
      </div>
    </div>
  );
}
