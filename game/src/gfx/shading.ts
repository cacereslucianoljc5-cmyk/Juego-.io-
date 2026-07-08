/**
 * Sombreado estilizado compartido: half-lambert + hemisferio + luces puntuales,
 * rim light fresnel, especular toon y sombras PCF del shadow map.
 * Factoría que captura los recursos fijos del contexto (se auto-enlazan).
 */
import tgpu, { d, std } from 'typegpu';
import { perlin3d } from '@typegpu/noise';
import type { Gfx } from './gpu';

export interface Shading {
  shadowFactor: (worldPos: d.v3f, nDotL: number) => number;
  shade: (albedo: d.v3f, n: d.v3f, worldPos: d.v3f, emissive: d.v3f) => d.v3f;
  fresnel: (n: d.v3f, v: d.v3f, power: number) => number;
  surface: (texel: d.v4f, tint: d.v4f, fx: d.v4f, lpos: d.v3f, nrm: d.v3f, wpos: d.v3f) => d.v4f;
}

export function makeShading(gfx: Gfx): Shading {
  const scene = gfx.scene;
  const lights = gfx.lights;
  const shadowMap = gfx.shadowSampleView;
  const shadowSamp = gfx.shadowSampler;

  const shadowFactor = (worldPos: d.v3f, nDotL: number): number => {
    'use gpu';
    const sp = std.mul(scene.$.shadowVP, d.vec4f(worldPos, 1));
    const uv = d.vec2f(sp.x * 0.5 + 0.5, 0.5 - sp.y * 0.5);
    // fuera del shadow map → sin sombra
    if (uv.x < 0.001 || uv.x > 0.999 || uv.y < 0.001 || uv.y > 0.999 || sp.z > 0.999) {
      return d.f32(1);
    }
    const bias = std.clamp(0.0035 * (1.0 - nDotL) + 0.0012, 0.001, 0.005);
    const ref = sp.z - bias;
    const texel = d.f32(1) / 2048;
    let vis = d.f32(0);
    for (const dy of tgpu.unroll([-0.5, 0.5])) {
      for (const dx of tgpu.unroll([-0.5, 0.5])) {
        vis += std.textureSampleCompareLevel(
          shadowMap.$,
          shadowSamp.$,
          uv + d.vec2f(dx, dy) * texel * 1.4,
          ref,
        );
      }
    }
    return vis * 0.25;
  };

  const fresnel = (n: d.v3f, v: d.v3f, power: number): number => {
    'use gpu';
    const f = 1 - std.clamp(std.dot(n, v), 0, 1);
    return std.pow(f, power);
  };

  /** Iluminación completa en HDR. `emissive` se suma sin atenuación. */
  const shade = (albedo: d.v3f, n: d.v3f, worldPos: d.v3f, emissive: d.v3f): d.v3f => {
    'use gpu';
    const L = scene.$.sunDirHurt.xyz;
    const V = std.normalize(scene.$.camPosTime.xyz - worldPos);
    const nDotL = std.dot(n, L);
    const shadow = shadowFactor(worldPos, nDotL);
    // half-lambert estilizado con corte suave
    const hl = std.clamp(nDotL * 0.5 + 0.5, 0, 1);
    const sunTerm = std.smoothstep(0.22, 0.78, hl) * shadow;
    const sun = scene.$.sunColorLights.rgb * sunTerm;
    // hemisferio
    const hemi = std.mix(scene.$.ambientGround.rgb, scene.$.ambientSky.rgb, n.y * 0.5 + 0.5);
    // especular toon del sol
    const H = std.normalize(L + V);
    const specRaw = std.pow(std.clamp(std.dot(n, H), 0, 1), 42);
    const spec = std.smoothstep(0.28, 0.42, specRaw) * 0.55 * shadow;
    // luces puntuales
    let point = d.vec3f();
    const count = d.u32(scene.$.sunColorLights.w);
    for (let i = d.u32(0); i < count; i++) {
      const pl = lights.$[i];
      const toL = pl.posRange.xyz - worldPos;
      const dist = std.length(toL);
      const att = std.clamp(1 - dist / std.max(pl.posRange.w, 0.001), 0, 1);
      const fall = att * att * pl.colorIntensity.w;
      const ln = std.clamp(std.dot(n, toL / std.max(dist, 0.001)) * 0.5 + 0.5, 0, 1);
      point += pl.colorIntensity.rgb * (fall * ln);
    }
    // rim: aro fresnel con el color del cielo
    const rim = fresnel(n, V, 3.2) * 0.5;
    const rimCol = scene.$.ambientSky.rgb * (rim * (0.4 + sunTerm));
    return albedo * (sun + hemi + point) + d.vec3f(spec) * scene.$.sunColorLights.rgb + rimCol + emissive;
  };

  /**
   * Superficie estándar de personajes/props: dissolve con borde incandescente,
   * flash blanco de impacto, glow emisivo controlado por luminancia y tinte.
   */
  const surface = (texel: d.v4f, tint: d.v4f, fx: d.v4f, lpos: d.v3f, nrm: d.v3f, wpos: d.v3f): d.v4f => {
    'use gpu';
    const dissolve = fx.y;
    let edge = d.f32(0);
    if (dissolve > 0.001) {
      const nz = perlin3d.sample(lpos * 2.6) * 0.5 + 0.5;
      if (nz < dissolve) {
        std.discard();
      }
      edge = (1 - std.smoothstep(0.0, 0.1, nz - dissolve)) * std.smoothstep(0.0, 0.02, dissolve);
    }
    let albedo = texel.rgb * tint.rgb;
    albedo = std.mix(albedo, d.vec3f(1.65), fx.x);
    const n = std.normalize(nrm);
    const luma = std.dot(texel.rgb, d.vec3f(0.299, 0.587, 0.114));
    const glowMask = std.smoothstep(0.42, 0.85, luma);
    const emissive = albedo * (fx.z * glowMask)
      + tint.rgb * (edge * 5.5)
      + d.vec3f(1.5, 0.62, 0.18) * (edge * 2.5);
    const lit = shade(albedo, n, wpos, emissive);
    return d.vec4f(lit, 1);
  };

  return { shadowFactor, shade, fresnel, surface };
}
