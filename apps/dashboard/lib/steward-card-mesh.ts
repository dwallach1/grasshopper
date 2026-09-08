/**
 * Laminated card body: front paper, dark core, rear paper, printed faces.
 */
import {
  Group,
  Mesh,
  MeshPhysicalMaterial,
  PlaneGeometry,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

import { STEWARD_CARD } from './steward-card-stock';
import { StewardFoilMaterial } from './steward-foil';

export function buildStewardCard(ink: string) {
  const group = new Group();
  group.name = 'steward-card';

  const core = new Mesh(
    new RoundedBoxGeometry(
      STEWARD_CARD.width,
      STEWARD_CARD.height,
      STEWARD_CARD.core,
      3,
      STEWARD_CARD.radius,
    ),
    new MeshPhysicalMaterial({
      color: 0x07090c,
      roughness: 0.92,
      metalness: 0.02,
    }),
  );
  core.name = 'card-core';

  const paperMat = new MeshPhysicalMaterial({
    color: ink,
    roughness: 0.62,
    metalness: 0.08,
    clearcoat: 0.35,
    clearcoatRoughness: 0.4,
  });
  const frontPaper = new Mesh(
    new RoundedBoxGeometry(
      STEWARD_CARD.width,
      STEWARD_CARD.height,
      STEWARD_CARD.paper,
      3,
      STEWARD_CARD.radius,
    ),
    paperMat,
  );
  frontPaper.position.z = STEWARD_CARD.core / 2 + STEWARD_CARD.paper / 2;
  frontPaper.name = 'card-paper-front';
  const backPaper = new Mesh(
    new RoundedBoxGeometry(
      STEWARD_CARD.width,
      STEWARD_CARD.height,
      STEWARD_CARD.paper,
      3,
      STEWARD_CARD.radius,
    ),
    paperMat.clone(),
  );
  backPaper.position.z = -(STEWARD_CARD.core / 2 + STEWARD_CARD.paper / 2);
  backPaper.name = 'card-paper-back';

  const foil = new StewardFoilMaterial(ink);
  const printW = STEWARD_CARD.width * 0.986;
  const printH = STEWARD_CARD.height * 0.986;
  const front = new Mesh(new PlaneGeometry(printW, printH), foil);
  front.position.z = STEWARD_CARD.core / 2 + STEWARD_CARD.paper + 0.0009;
  front.name = 'card-print-front';

  const back = new Mesh(
    new PlaneGeometry(printW, printH),
    new MeshPhysicalMaterial({
      color: 0x10141a,
      roughness: 0.7,
      metalness: 0.12,
      clearcoat: 0.4,
    }),
  );
  back.rotation.y = Math.PI;
  back.position.z = -(STEWARD_CARD.core / 2 + STEWARD_CARD.paper + 0.0009);
  back.name = 'card-print-back';

  group.add(core, frontPaper, backPaper, front, back);
  group.userData.foil = foil;
  return { group, foil, front };
}
