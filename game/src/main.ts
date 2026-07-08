/**
 * Escena de humo temporal para validar el stack gráfico completo:
 * suelo + muro + props + personaje skinned animado + partículas + bloom.
 * (Se reemplaza por el juego completo.)
 */
import { Gfx } from './gfx/gpu';
import { Renderer } from './gfx/renderer';
import { buildAtlas } from './gfx/atlas';
import { rockMesh, crystalMesh } from './gfx/meshes';
import { writeInstance } from './gfx/staticPipeline';
import { writeAnimState } from './gfx/skinnedPipeline';
import { loadGlb } from './gfx/glb';
import { bakeCharacter } from './gfx/animBake';
import { GameCamera } from './game/camera';
import { mat4 } from 'wgpu-matrix';
import { d } from 'typegpu';

async function boot() {
  const canvas = document.getElementById('gfx') as HTMLCanvasElement;
  const headless = new URLSearchParams(location.search).has('headless');
  console.log('boot: gfx...'); const gfx = await Gfx.create(canvas, headless); console.log('boot: gfx ok');
  const atlasTex = await gfx.uploadTexture(buildAtlas(), false);
  console.log('boot: renderer...'); const renderer = new Renderer(gfx, atlasTex.createView(d.texture2d(d.f32))); console.log('boot: renderer ok');
  const camera = new GameCamera();

  const white = await gfx.uploadTexture(null);
  const whiteView = white.createView(d.texture2d(d.f32));

  // props de prueba
  const rocks = renderer.statics.createBatch(gfx.uploadMesh(rockMesh(7)), whiteView, 16);
  const m = new Float32Array(16);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    mat4.identity(m);
    mat4.translate(m, [Math.cos(a) * 12, 0, Math.sin(a) * 12], m);
    mat4.uniformScale(m, 1.5, m);
    writeInstance(rocks.raw, i, m, 0.55, 0.52, 0.5, 0, 0, 0, 0, 0);
  }
  rocks.count = 10;
  const crystals = renderer.statics.createBatch(gfx.uploadMesh(crystalMesh(3)), whiteView, 8);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.5;
    mat4.identity(m);
    mat4.translate(m, [Math.cos(a) * 18, 0, Math.sin(a) * 18], m);
    mat4.uniformScale(m, 2.2, m);
    writeInstance(crystals.raw, i, m, 0.4, 0.9, 1.0, 0, 0, 0, 2.5, 0);
  }
  crystals.count = 5;
  renderer.staticBatches.push(rocks, crystals);

  // personaje skinned
  console.log('boot: glb...'); const model = await loadGlb('./assets/chars/01_knife.glb'); console.log('boot: glb ok');
  const baked = bakeCharacter(model);
  const prim = model.primitives[0];
  const mesh = gfx.uploadSkinnedMesh(prim.positions, prim.normals, prim.uvs, prim.joints!, prim.weights!, prim.indices);
  const charTex = await gfx.uploadTexture(model.materials[prim.materialIdx]?.image ?? null);
  const type = renderer.skinned.createType(mesh, baked, charTex.createView(d.texture2d(d.f32)), 8); console.log('boot: type ok');
  renderer.skinnedTypes.push(type);
  console.log('clips:', Object.keys(type.clipIndex), 'bones:', baked.boneCount);

  // luces de prueba
  gfx.lightsRaw[0] = 6; gfx.lightsRaw[1] = 1.5; gfx.lightsRaw[2] = 0; gfx.lightsRaw[3] = 12;
  gfx.lightsRaw[4] = 1.0; gfx.lightsRaw[5] = 0.4; gfx.lightsRaw[6] = 0.1; gfx.lightsRaw[7] = 3;
  gfx.sunColorLights.set([1.15, 1.05, 0.92, 1]);
  gfx.ambientSky.set([0.34, 0.42, 0.55, 0]);
  gfx.ambientGround.set([0.16, 0.14, 0.12, 0]);

  let time = 0;
  let last = performance.now();
  const walkClip = type.clipIndex['walk'] ?? 0;
  const runClip = type.clipIndex['run'] ?? walkClip;

  function frame(now: number) {
    const dt = Math.min((now - last) / 1000, 1 / 20);
    last = now;
    time += dt;

    if (gfx.ensureSize()) renderer.onResize();

    // personaje corriendo en círculo
    const ang = time * 0.8;
    const px = Math.cos(ang) * 6;
    const pz = Math.sin(ang) * 6;
    mat4.identity(m);
    mat4.translate(m, [px, 0, pz], m);
    mat4.rotateY(m, -ang, m);
    writeInstance(type.raw, 0, m, 1, 1, 1, 0, 0, 0, 0, 0);
    writeAnimState(type, 0, runClip, walkClip, time % 0.63, 0, 0);
    type.count = 1;

    camera.update(dt, dt, px * 0.4, pz * 0.4, 0, 0, 0, 0, 0.2);
    camera.writeScene(gfx);
    gfx.camPosTime[3] = time;

    // chorro de partículas de prueba
    renderer.particles.emit({
      x: 0, y: 0.4, z: 0, shape: 3, count: 14, spread: 0.7,
      speedMin: 3, speedMax: 7, upBias: 3,
      lifeMin: 0.5, lifeMax: 1.4, size0: 0.22, size1: 0.05,
      kind: 2, r0: 1.0, g0: 0.75, b0: 0.2, gravity: 9, drag: 0.4,
      collide: true, align: true, stretch: 2,
    });

    renderer.sprites.update(dt);
    if (Math.floor(time * 2) !== Math.floor((time - dt) * 2)) {
      renderer.sprites.spawnDamage(px, 2.2, pz, Math.floor(100 + Math.random() * 900), Math.random() < 0.3);
    }
    renderer.trails.update(dt);
    renderer.decals.push(0, 0, 3.4, 0, 0, (time * 0.6) % 1, 0, 0.9, 1.0, 0.5, 0.1);

    renderer.frame(dt, time);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // hook de captura para verificación headless
  (window as any).__shot = async () => {
    const img = await renderer.capture();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d')!.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  };
  (window as any).__ready = true;
}

boot().catch((e) => {
  console.error('BOOT ERROR', e);
  (window as any).__bootError = String(e?.stack ?? e);
});
