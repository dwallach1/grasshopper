'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

import type { NavPoint } from '../../lib/book-nav-path';
import { chartLayout } from './nav-chart-layout';

const COL = {
  line: 0x5b9fd4,
  up: 0x3ddc84,
  down: 0xff5c33,
  grid: 0x1c242e,
  ref: 0xffb000,
};

function endpointColor(dayPnl: number | null): number {
  if (dayPnl === null) return COL.line;
  if (dayPnl > 0) return COL.up;
  if (dayPnl < 0) return COL.down;
  return COL.line;
}

function writePositions(geo: THREE.BufferGeometry, coords: { x: number; y: number }[]) {
  const positions = new Float32Array(Math.max(1, coords.length) * 3);
  coords.forEach((pt, i) => {
    positions[i * 3] = pt.x;
    positions[i * 3 + 1] = pt.y;
    positions[i * 3 + 2] = 0;
  });
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setDrawRange(0, coords.length);
  geo.computeBoundingSphere();
}

export function BookNavRibbon({
  points,
  value,
  startingNav,
  dayPnl,
  width,
  height,
  reducedMotion,
}: {
  points: readonly NavPoint[];
  value: number | null;
  startingNav: number | null;
  dayPnl: number | null;
  width: number;
  height: number;
  reducedMotion: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const pointsRef = useRef(points);
  const valueRef = useRef(value);
  const startRef = useRef(startingNav);
  const pnlRef = useRef(dayPnl);
  const reducedRef = useRef(reducedMotion);
  const shownRef = useRef(value);
  pointsRef.current = points;
  valueRef.current = value;
  startRef.current = startingNav;
  pnlRef.current = dayPnl;
  reducedRef.current = reducedMotion;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || width < 8 || height < 8) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x07080a);
    const camera = new THREE.OrthographicCamera(0, width, 0, height, -40, 40);
    camera.position.z = 20;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.domElement.setAttribute('aria-hidden', 'true');
    host.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0x8aa0b8, 0.9));
    const key = new THREE.DirectionalLight(0xd7e7ff, 0.65);
    key.position.set(width * 0.25, height * 0.2, 40);
    scene.add(key);

    const gridMat = new THREE.LineBasicMaterial({ color: COL.grid, transparent: true, opacity: 0.85 });
    const gridLines: THREE.Line[] = [];
    for (let i = 0; i < 5; i += 1) {
      const geo = new THREE.BufferGeometry();
      const ln = new THREE.Line(geo, gridMat);
      gridLines.push(ln);
      scene.add(ln);
    }

    const lineGeo = new THREE.BufferGeometry();
    const lineMat = new THREE.LineBasicMaterial({ color: COL.line });
    const line = new THREE.Line(lineGeo, lineMat);
    scene.add(line);
    const glow = new THREE.PointLight(COL.line, 1.5, 110);
    const coreMat = new THREE.MeshBasicMaterial({ color: COL.line });
    const core = new THREE.Mesh(new THREE.SphereGeometry(4.2, 16, 16), coreMat);
    scene.add(glow);
    scene.add(core);

    const refGeo = new THREE.BufferGeometry();
    const refLine = new THREE.Line(refGeo, new THREE.LineBasicMaterial({
      color: COL.ref,
      transparent: true,
      opacity: 0.4,
    }));
    scene.add(refLine);

    let frame = 0;
    const tick = () => {
      frame = window.requestAnimationFrame(tick);
      const target = valueRef.current;
      if (reducedRef.current || shownRef.current === null || target === null) {
        shownRef.current = target;
      } else {
        shownRef.current += (target - shownRef.current) * 0.08;
        if (Math.abs(shownRef.current - target) < 0.01) shownRef.current = target;
      }
      const layout = chartLayout({
        points: pointsRef.current,
        displayValue: shownRef.current,
        startingNav: startRef.current,
        width,
        height,
      });
      layout.gridY.forEach((gy, i) => {
        const ln = gridLines[i];
        if (!ln) return;
        writePositions(ln.geometry, [
          { x: layout.pad.left, y: gy },
          { x: width - layout.pad.right, y: gy },
        ]);
      });
      writePositions(lineGeo, layout.coords);
      const tip = layout.coords[layout.coords.length - 1];
      const hex = endpointColor(pnlRef.current);
      glow.color.setHex(hex);
      coreMat.color.setHex(hex);
      if (tip) {
        glow.position.set(tip.x, tip.y, 8);
        core.position.set(tip.x, tip.y, 1);
        core.visible = true;
        glow.visible = true;
      } else {
        core.visible = false;
        glow.visible = false;
      }
      if (layout.refY === null) {
        refLine.visible = false;
      } else {
        refLine.visible = true;
        writePositions(refGeo, [
          { x: layout.pad.left, y: layout.refY },
          { x: width - layout.pad.right, y: layout.refY },
        ]);
      }
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      window.cancelAnimationFrame(frame);
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
          obj.geometry.dispose();
          const mat = obj.material;
          if (Array.isArray(mat)) mat.forEach((item) => item.dispose());
          else mat.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [height, width]);

  return <div ref={hostRef} className="term-nav-stage" />;
}
