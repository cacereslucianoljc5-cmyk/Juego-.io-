/**
 * Pipeline de assets: convierte los GLB crudos de Meshy (../models) y los
 * modelos Clash (../../Juego-clash-/models) en GLBs optimizados para web.
 *
 * Por personaje riggeado:
 *  - fusiona los clips (walk/run/attack/dead/idle/hit) de los GLB separados
 *    en un solo GLB, retargeteando canales por nombre de nodo
 *  - elimina la textura emissive (la iluminación la hace el motor)
 *  - simplifica la malla (meshoptimizer) y comprime texturas a WebP 512
 *
 * Uso: node tools/prepare-assets.mjs
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup, prune, resample, simplify, textureCompress, weld,
} from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS = join(HERE, '../../models');
const CLASH = join(HERE, '../../../Juego-clash-/models');
const OUT = join(HERE, '../public/assets');

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

const CHARACTERS = [
  '01_knife', '02_cowboy_sword', '03_cowboy_pirate_sword', '04_pirate_cutlass',
  '05_astronaut_wrench', '06_robot_baton', '07_reaper_scythe', '08_king_scepter',
  '09_agent_gun', '10_ice_sword', '11_slime_mace', '14_shark_katana',
  '15_gamer_katana', '17_diamond_mace',
];
const STATUES = ['12_devil_trident', '13_banana_katana', '16_ghost_lantern'];
const ENEMIES = ['Esqueleto', 'Barbaro', 'Arquero', 'Gigante', 'Pekka', 'MontaPuercos', 'MagoFuego'];

/** Copia la animación 0 de srcDoc a dstDoc, retargeteando canales por nombre de nodo. */
function copyAnimation(srcDoc, dstDoc, name) {
  const srcAnim = srcDoc.getRoot().listAnimations()[0];
  if (!srcAnim) return null;
  const buffer = dstDoc.getRoot().listBuffers()[0];
  const nodeByName = new Map(dstDoc.getRoot().listNodes().map((n) => [n.getName(), n]));
  const dstAnim = dstDoc.createAnimation(name);
  const samplerMap = new Map();
  let duration = 0;
  for (const ch of srcAnim.listChannels()) {
    const target = ch.getTargetNode();
    const dstNode = target && nodeByName.get(target.getName());
    if (!dstNode) continue;
    const srcSampler = ch.getSampler();
    let dstSampler = samplerMap.get(srcSampler);
    if (!dstSampler) {
      const inArr = srcSampler.getInput().getArray();
      duration = Math.max(duration, inArr[inArr.length - 1]);
      const input = dstDoc.createAccessor().setType('SCALAR').setArray(inArr.slice()).setBuffer(buffer);
      const output = dstDoc.createAccessor()
        .setType(srcSampler.getOutput().getType())
        .setArray(srcSampler.getOutput().getArray().slice())
        .setBuffer(buffer);
      dstSampler = dstDoc.createAnimationSampler()
        .setInput(input).setOutput(output)
        .setInterpolation(srcSampler.getInterpolation());
      dstAnim.addSampler(dstSampler);
      samplerMap.set(srcSampler, dstSampler);
    }
    dstAnim.addChannel(
      dstDoc.createAnimationChannel()
        .setTargetNode(dstNode).setTargetPath(ch.getTargetPath()).setSampler(dstSampler),
    );
  }
  return duration;
}

function stripExtraMaps(doc) {
  for (const mat of doc.getRoot().listMaterials()) {
    mat.setEmissiveTexture(null);
    mat.setEmissiveFactor([0, 0, 0]);
    mat.setMetallicRoughnessTexture(null);
    mat.setNormalTexture(null);
    mat.setOcclusionTexture(null);
    mat.setExtension('KHR_materials_specular', null);
    mat.setExtension('KHR_materials_ior', null);
  }
}

function bbox(doc) {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const pmin = pos.getMin([]);
      const pmax = pos.getMax([]);
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], pmin[i]);
        max[i] = Math.max(max[i], pmax[i]);
      }
    }
  }
  return { min, max };
}

async function optimize(doc, { ratio = 0.45, texSize = 512, quality = 82 } = {}) {
  await doc.transform(
    dedup(),
    prune(),
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.001 }),
    resample(),
    prune(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [texSize, texSize], quality }),
  );
}

function tris(doc) {
  let t = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      t += (idx ? idx.getCount() : prim.getAttribute('POSITION').getCount()) / 3;
    }
  }
  return Math.round(t);
}

const manifest = { characters: {}, statues: {}, enemies: {} };

mkdirSync(join(OUT, 'chars'), { recursive: true });
mkdirSync(join(OUT, 'props'), { recursive: true });
mkdirSync(join(OUT, 'enemies'), { recursive: true });

for (const slug of CHARACTERS) {
  const dir = join(MODELS, slug);
  const files = readdirSync(dir);
  const find = (tag) => {
    const f = files.find((f) => f.includes(tag) && f.endsWith('.glb'));
    return f ? join(dir, f) : null;
  };
  const doc = await io.read(find('_rigged'));
  // el clip "clip0" del rig no sirve como animación de juego
  for (const anim of doc.getRoot().listAnimations()) anim.dispose();

  const clips = {};
  for (const [tag, name] of [
    ['_anim_walk', 'walk'], ['_anim_run', 'run'], ['_anim_attack', 'attack'],
    ['_anim_dead', 'dead'], ['_anim_idle', 'idle'], ['_anim_hit', 'hit'],
  ]) {
    const file = find(tag);
    if (!file) continue;
    const srcDoc = await io.read(file);
    const dur = copyAnimation(srcDoc, doc, name);
    if (dur != null) clips[name] = Number(dur.toFixed(4));
  }

  stripExtraMaps(doc);
  await optimize(doc, { ratio: 0.42, texSize: 512 });
  const { min, max } = bbox(doc);
  const out = join(OUT, 'chars', `${slug}.glb`);
  await io.write(out, doc);
  manifest.characters[slug] = { clips, tris: tris(doc), height: Number(max[1].toFixed(3)), radius: Number(Math.max(max[0], max[2]).toFixed(3)) };
  console.log(`char ${slug}: clips=[${Object.keys(clips)}] tris=${tris(doc)}`);
}

for (const slug of STATUES) {
  const dir = join(MODELS, slug);
  const file = readdirSync(dir).find((f) => f.includes('_mesh_textured') && f.endsWith('.glb'));
  const doc = await io.read(join(dir, file));
  stripExtraMaps(doc);
  await optimize(doc, { ratio: 0.28, texSize: 384, quality: 78 });
  const { min, max } = bbox(doc);
  await io.write(join(OUT, 'props', `${slug}.glb`), doc);
  manifest.statues[slug] = { tris: tris(doc), height: Number(max[1].toFixed(3)) };
  console.log(`statue ${slug}: tris=${tris(doc)}`);
}

for (const name of ENEMIES) {
  const doc = await io.read(join(CLASH, `${name}.glb`));
  // ya vienen cuantizados: solo recomprimir texturas, sin tocar geometría
  await doc.transform(
    prune(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512], quality: 80 }),
  );
  const { min, max } = bbox(doc);
  await io.write(join(OUT, 'enemies', `${name}.glb`), doc);
  manifest.enemies[name] = { tris: tris(doc), height: Number(max[1].toFixed(3)), minY: Number(min[1].toFixed(3)) };
  console.log(`enemy ${name}: tris=${tris(doc)} height=${max[1].toFixed(2)}`);
}

const ts = `// Generado por tools/prepare-assets.mjs — no editar a mano.
export const ASSET_MANIFEST = ${JSON.stringify(manifest, null, 2)} as const;
`;
mkdirSync(join(HERE, '../src/gen'), { recursive: true });
writeFileSync(join(HERE, '../src/gen/assets-manifest.ts'), ts);
console.log('manifest escrito en src/gen/assets-manifest.ts');
