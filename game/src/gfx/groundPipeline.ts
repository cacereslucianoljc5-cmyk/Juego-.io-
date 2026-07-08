/**
 * Suelo procedural de la arena (100% WGSL: praderas con parches, grid sutil,
 * emblema central, banda de peligro del borde y vacío exterior con rejilla)
 * + muro de energía cilíndrico aditivo del borde del mapa.
 */
import tgpu, { d, std } from 'typegpu';
import { perlin2d } from '@typegpu/noise';
import { ARENA_R, WALL_H } from '../core/constants';
import { DEPTH_FORMAT, HDR_FORMAT, staticVertexLayout } from './gpu';
import type { Gfx, GpuMesh } from './gpu';
import type { Shading } from './shading';

export interface GroundPipelines {
  drawGround(pass: GPURenderPassEncoder): void;
  drawWall(pass: GPURenderPassEncoder): void;
}

export function createGroundPipelines(gfx: Gfx, shading: Shading, groundMesh: GpuMesh, wallMesh: GpuMesh): GroundPipelines {
  const scene = gfx.scene;
  const lights = gfx.lights;

  const vert = tgpu.vertexFn({
    in: { pos: d.vec3f, nrm: d.vec3f, uv: d.vec2f },
    out: { position: d.builtin.position, wpos: d.vec3f },
  })((input) => {
    'use gpu';
    return {
      position: std.mul(scene.$.viewProj, d.vec4f(input.pos, 1)),
      wpos: input.pos,
    };
  });

  const ringMask = (r: number, target: number, width: number): number => {
    'use gpu';
    return 1 - std.smoothstep(0, width, std.abs(r - target));
  };

  const frag = tgpu.fragmentFn({
    in: { wpos: d.vec3f },
    out: d.vec4f,
  })((input) => {
    'use gpu';
    const p = input.wpos.xz;
    const r = std.length(p);
    const time = scene.$.camPosTime.w;

    // --- terreno base (multicapa) ---
    const n1 = perlin2d.sample(p * 0.045);
    const n2 = perlin2d.sample(p * 0.22 + d.vec2f(37.7, 11.3));
    const n3 = perlin2d.sample(p * 1.1 + d.vec2f(91.1, 53.9));
    const n4 = perlin2d.sample(p * 2.6 + d.vec2f(17.3, 71.9));   // detalle fino
    const n5 = perlin2d.sample(p * 0.6 + d.vec2f(5.1, 133.7));   // parches medianos
    const grassA = d.vec3f(0.15, 0.29, 0.13);
    const grassB = d.vec3f(0.22, 0.37, 0.16);
    const grassC = d.vec3f(0.27, 0.4, 0.14); // hierba seca amarillenta
    const dirt = d.vec3f(0.30, 0.24, 0.16);
    let albedo = std.mix(grassA, grassB, std.clamp(n1 * 1.4 + 0.5, 0, 1));
    albedo = std.mix(albedo, grassC, std.smoothstep(0.25, 0.6, n5) * 0.5);
    const dirtMask = std.smoothstep(0.18, 0.5, n2) * 0.85;
    albedo = std.mix(albedo, dirt, dirtMask);
    // briznas direccionales (anisotropía sutil de hierba)
    const blades = perlin2d.sample(d.vec2f(p.x * 0.7 + p.y * 2.9, p.y * 0.5 - p.x * 2.4));
    albedo = albedo * (0.94 + blades * 0.09 * (1 - dirtMask));
    albedo = albedo * (0.93 + n3 * 0.12 + n4 * 0.06);
    // motas oscuras (matas) y claras (calvas)
    albedo = albedo * (1 - std.smoothstep(0.62, 0.78, n3) * 0.25);
    albedo = std.mix(albedo, albedo * 1.22, std.smoothstep(0.66, 0.8, n4) * (1 - dirtMask) * 0.5);

    // flores dispersas en la hierba
    const fNoise = perlin2d.sample(p * 3.4 + d.vec2f(211.7, 89.3));
    const flower = std.smoothstep(0.66, 0.8, fNoise) * (1 - dirtMask) * (1 - std.smoothstep(0.3, 0.55, n2));
    const fPick = std.fract(fNoise * 37.0);
    let flowerCol = d.vec3f(0.95, 0.9, 0.55);
    if (fPick > 0.66) {
      flowerCol = d.vec3f(0.95, 0.55, 0.75);
    } else if (fPick > 0.33) {
      flowerCol = d.vec3f(0.85, 0.88, 0.95);
    }
    albedo = std.mix(albedo, flowerCol, flower * 0.85);

    // piedrecitas en las zonas de tierra
    const pebble = std.smoothstep(0.6, 0.75, perlin2d.sample(p * 4.2 + d.vec2f(57.1, 23.9))) * dirtMask;
    albedo = std.mix(albedo, d.vec3f(0.42, 0.41, 0.4), pebble * 0.7);

    // grietas orgánicas finas, solo dentro de los parches de tierra
    const crackN = perlin2d.sample(p * 0.7 + d.vec2f(313.1, 7.7));
    const crack = (1 - std.smoothstep(0.0, 0.035, std.abs(crackN))) * dirtMask;
    albedo = albedo * (1 - crack * 0.22);

    // grid sutil estilo .io
    const cell = std.abs(std.fract(p / 4.0) - 0.5) * 2.0;
    const gridLine = 1 - std.smoothstep(0.0, 0.06, std.min(1 - cell.x, 1 - cell.y));
    albedo = albedo * (1 - gridLine * 0.05);

    // círculos de arena desgastados, con musgo en el borde
    const wear = ringMask(r, 24, 6.0) * 0.3 + ringMask(r, 46, 8.0) * 0.22;
    albedo = std.mix(albedo, dirt * 0.82, wear * (0.4 + n2 * 0.3));
    const moss = (ringMask(r, 27.5, 1.6) + ringMask(r, 42.5, 1.8)) * std.smoothstep(0.1, 0.5, n3);
    albedo = std.mix(albedo, d.vec3f(0.14, 0.3, 0.1), moss * 0.4);

    let emissive = d.vec3f();

    // --- emblema central ---
    const emblem = ringMask(r, 6.4, 0.28) + ringMask(r, 4.0, 0.18);
    const ang = std.atan2(p.y, p.x);
    const spokes = std.smoothstep(0.86, 0.99, std.cos(ang * 8 + time * 0.15)) * (1 - std.smoothstep(3.4, 6.2, r)) * std.smoothstep(1.2, 2.2, r);
    const emblemGlow = (emblem + spokes) * (0.55 + 0.25 * std.sin(time * 1.7));
    emissive += d.vec3f(0.2, 0.85, 1.0) * emblemGlow * 0.8;
    albedo = std.mix(albedo, d.vec3f(0.13, 0.15, 0.17), std.smoothstep(6.8, 6.2, r) * 0.55);

    // --- banda de peligro del borde ---
    const band = std.smoothstep(ARENA_R - 3.2, ARENA_R - 1.4, r) * (1 - std.smoothstep(ARENA_R - 0.2, ARENA_R + 0.4, r));
    const stripe = std.smoothstep(0.2, 0.8, std.sin(ang * 48 - time * 1.2) * 0.5 + 0.5);
    const pulse = 0.55 + 0.45 * std.sin(time * 3.1);
    const wallPulse = scene.$.ambientSky.w;
    const warnCol = std.mix(d.vec3f(1.0, 0.45, 0.1), d.vec3f(1.0, 0.12, 0.1), wallPulse);
    emissive += warnCol * (band * stripe * pulse * (0.6 + wallPulse * 1.6));
    albedo = std.mix(albedo, d.vec3f(0.1, 0.08, 0.08), band * 0.5);

    // --- vacío exterior ---
    const outside = std.smoothstep(ARENA_R, ARENA_R + 0.9, r);
    const voidCol = d.vec3f(0.012, 0.014, 0.028);
    const gcell = std.abs(std.fract(p / 6.0) - 0.5) * 2.0;
    const gline = 1 - std.smoothstep(0.0, 0.05, std.min(1 - gcell.x, 1 - gcell.y));
    const fall = std.exp((ARENA_R - r) * 0.05);
    const voidGlow = d.vec3f(0.05, 0.3, 0.5) * (gline * fall * (0.5 + 0.3 * std.sin(time * 0.9 + r * 0.3)));

    // --- iluminación ---
    const shadow = shading.shadowFactor(input.wpos, 1);
    const sun = scene.$.sunColorLights.rgb * (shadow * 0.85 + 0.1);
    const hemi = scene.$.ambientSky.rgb * 0.55 + scene.$.ambientGround.rgb * 0.45;
    let point = d.vec3f();
    const count = d.u32(scene.$.sunColorLights.w);
    for (let i = d.u32(0); i < count; i++) {
      const pl = lights.$[i];
      const toL = pl.posRange.xyz - input.wpos;
      const dist = std.length(toL);
      const att = std.clamp(1 - dist / std.max(pl.posRange.w, 0.001), 0, 1);
      point += pl.colorIntensity.rgb * (att * att * pl.colorIntensity.w);
    }
    let lit = albedo * (sun + hemi + point) + emissive;
    lit = std.mix(lit, voidCol + voidGlow + point * 0.15, outside);
    return d.vec4f(lit, 1);
  });

  const groundPipeline = gfx.root.createRenderPipeline({
    attribs: { ...(staticVertexLayout as any).attrib },
    vertex: vert,
    fragment: frag,
    targets: { format: HDR_FORMAT },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
  });

  // ---- muro de energía ----
  const wallVert = tgpu.vertexFn({
    in: { pos: d.vec3f, nrm: d.vec3f, uv: d.vec2f },
    out: { position: d.builtin.position, wpos: d.vec3f, nrm: d.vec3f, uv: d.vec2f },
  })((input) => {
    'use gpu';
    const wp = d.vec3f(input.pos.x * ARENA_R, input.pos.y * WALL_H, input.pos.z * ARENA_R);
    return {
      position: std.mul(scene.$.viewProj, d.vec4f(wp, 1)),
      wpos: wp,
      nrm: input.nrm,
      uv: input.uv,
    };
  });

  const wallFrag = tgpu.fragmentFn({
    in: { wpos: d.vec3f, nrm: d.vec3f, uv: d.vec2f },
    out: d.vec4f,
  })((input) => {
    'use gpu';
    const time = scene.$.camPosTime.w;
    const wallPulse = scene.$.ambientSky.w;
    // bandas hexagonales desplazándose
    const bands = perlin2d.sample(d.vec2f(input.uv.x * 4.0, input.uv.y * 2.2 - time * 0.35));
    const cells = std.smoothstep(0.12, 0.5, std.abs(bands));
    const scan = 0.5 + 0.5 * std.sin(input.uv.y * 28 - time * 3.5);
    const vFade = std.pow(1 - input.uv.y, 1.6);
    const v = std.normalize(scene.$.camPosTime.xyz - input.wpos);
    const n = std.normalize(input.nrm);
    const grazing = 1 - std.abs(std.dot(n, v));
    const base = std.mix(d.vec3f(0.06, 0.5, 0.75), d.vec3f(0.9, 0.12, 0.12), wallPulse);
    const intensity = vFade * (0.35 + cells * 0.5 + scan * 0.12) * (0.5 + grazing * 0.9) * (0.75 + wallPulse);
    return d.vec4f(base * intensity, 0);
  });

  const wallPipeline = gfx.root.createRenderPipeline({
    attribs: { ...(staticVertexLayout as any).attrib },
    vertex: wallVert,
    fragment: wallFrag,
    targets: {
      format: HDR_FORMAT,
      blend: {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      },
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'less' },
  });

  return {
    drawGround(pass: GPURenderPassEncoder) {
      groundPipeline
        .with(pass)
        .with(staticVertexLayout as any, groundMesh.vertexBuffer)
        .withIndexBuffer(groundMesh.indexBuffer)
        .drawIndexed(groundMesh.indexCount);
    },
    drawWall(pass: GPURenderPassEncoder) {
      wallPipeline
        .with(pass)
        .with(staticVertexLayout as any, wallMesh.vertexBuffer)
        .withIndexBuffer(wallMesh.indexBuffer)
        .drawIndexed(wallMesh.indexCount);
    },
  };
}
