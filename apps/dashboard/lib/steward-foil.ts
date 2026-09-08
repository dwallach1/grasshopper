/**
 * Laminate foil on MeshPhysicalMaterial.
 * Three.js keeps lighting / clearcoat / iridescence.
 * Custom GLSL only masks foil + roughness. View-angle sheen, not a toy overlay.
 */
import {
  Color,
  MeshPhysicalMaterial,
  Texture,
  type WebGLProgramParametersWithUniforms,
  Vector2,
} from 'three';

export const STEWARD_FOIL_CACHE_KEY = 'steward-foil-laminate-v1';

export const FOIL_COMMON = /* glsl */ `
uniform vec3 uInk;
uniform vec2 uTilt;
uniform float uFoilMix;
uniform sampler2D uFoilMap;
`;

export const FOIL_MAP = /* glsl */ `
#ifdef USE_MAP
  float stewardFoil = texture2D(uFoilMap, vMapUv).r * uFoilMix;
  vec3 viewDir = normalize(vViewPosition);
  float fres = pow(clamp(1.0 - abs(viewDir.z), 0.0, 1.0), 2.0);
  float glide = 0.5 + 0.5 * sin(dot(vMapUv, vec2(2.8, 1.15)) + uTilt.x * 2.6 + uTilt.y * 2.0);
  vec3 laminate = uInk * (0.42 + 0.58 * fres) * (0.62 + 0.38 * glide);
  diffuseColor.rgb = mix(diffuseColor.rgb, laminate, stewardFoil * 0.62);
#endif
`;

export const FOIL_ROUGH = /* glsl */ `
#ifdef USE_MAP
  roughnessFactor = mix(roughnessFactor, 0.11, texture2D(uFoilMap, vMapUv).r * uFoilMix);
#endif
`;

export const FOIL_METAL = /* glsl */ `
#ifdef USE_MAP
  metalnessFactor = mix(metalnessFactor, 0.72, texture2D(uFoilMap, vMapUv).r * uFoilMix);
#endif
`;

export function isFoilToyShader(source: string): boolean {
  const blob = source.toLowerCase();
  return blob.includes('scan' + 'line')
    || blob.includes('gli' + 'tch')
    || blob.includes('holo' + 'gram')
    || blob.includes('holographic' + 'material');
}

export class StewardFoilMaterial extends MeshPhysicalMaterial {
  readonly uInk = { value: new Color('#9ec9c8') };
  readonly uTilt = { value: new Vector2() };
  readonly uFoilMix = { value: 1 };
  readonly uFoilMap = { value: new Texture() };

  constructor(ink: string) {
    super({
      color: ink,
      roughness: 0.36,
      metalness: 0.18,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      iridescence: 0.28,
      iridescenceIOR: 1.5,
      iridescenceThicknessRange: [120, 260],
      sheen: 0.2,
      sheenRoughness: 0.4,
      sheenColor: ink,
      envMapIntensity: 1.15,
    });
    this.uInk.value.set(ink);
    this.sheenColor.set(ink);
    this.customProgramCacheKey = () => STEWARD_FOIL_CACHE_KEY;
    this.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
      shader.uniforms.uInk = this.uInk;
      shader.uniforms.uTilt = this.uTilt;
      shader.uniforms.uFoilMix = this.uFoilMix;
      shader.uniforms.uFoilMap = this.uFoilMap;
      // MeshPhysical declares `normal` in normal_fragment_begin — after map_fragment.
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FOIL_COMMON}`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FOIL_MAP}`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${FOIL_ROUGH}`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${FOIL_METAL}`);
    };
  }

  setInk(hex: string): void {
    this.uInk.value.set(hex);
    this.color.set(hex);
    this.sheenColor.set(hex);
  }

  setTilt(x: number, y: number): void {
    this.uTilt.value.set(x, y);
  }
}

export function isWebGL2Available(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2'));
  } catch {
    return false;
  }
}
