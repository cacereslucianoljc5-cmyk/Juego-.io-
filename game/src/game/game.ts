/**
 * Integración del juego: carga de assets, cambio de personaje (1-9/0 y Tab),
 * bucle de simulación con hit-stop/slow-mo y ensamblado del render por frame.
 */
import { d } from 'typegpu';
import { ARENA_R } from '../core/constants';
import { Input } from '../core/input';
import { clamp01 } from '../core/mathx';
import { bakeCharacter } from '../gfx/animBake';
import { buildAtlas } from '../gfx/atlas';
import { loadGlb } from '../gfx/glb';
import { Gfx } from '../gfx/gpu';
import { Renderer } from '../gfx/renderer';
import { GameCamera } from './camera';
import { CHARACTERS } from './defs';
import { Enemies } from './enemies';
import { Player, type CharAsset } from './player';
import { Vfx } from './vfx';
import { buildWorld, type World } from './world';
import { MAX_SKINNED } from '../core/constants';

export class Game {
  gfx!: Gfx;
  renderer!: Renderer;
  input!: Input;
  camera!: GameCamera;
  vfx!: Vfx;
  world!: World;
  enemies!: Enemies;
  player!: Player;

  private chars = new Map<string, CharAsset>();
  private loading = new Set<string>();
  private currentChar = 0;
  private pendingSwitch = -1;
  private time = 0;
  private last = 0;
  private aim = { x: 0, z: 1 };
  private fpsAccum = 0;
  private fpsCount = 0;
  private frameNo = 0;
  /** en headless (swiftshader) el raster CPU no aguanta 60fps: render diezmado */
  headless = false;

  static async create(canvas: HTMLCanvasElement, headless: boolean): Promise<Game> {
    const g = new Game();
    g.headless = headless;
    g.gfx = await Gfx.create(canvas, headless);
    const atlasTex = await g.gfx.uploadTexture(buildAtlas(), false);
    g.renderer = new Renderer(g.gfx, atlasTex.createView(d.texture2d(d.f32)));
    g.input = new Input(canvas);
    g.camera = new GameCamera();
    g.vfx = new Vfx(g.gfx, g.renderer, g.camera);
    g.world = await buildWorld(g.gfx, g.renderer);
    g.player = new Player(g.input, g.renderer, g.vfx, g.world, g.camera);
    g.enemies = new Enemies(g.gfx, g.renderer, g.vfx, g.world, g.player);
    g.player.enemies = g.enemies;

    // iluminación global
    g.gfx.sunColorLights.set([1.18, 1.06, 0.9, 0]);
    g.gfx.ambientSky.set([0.35, 0.44, 0.6, 0]);
    g.gfx.ambientGround.set([0.17, 0.15, 0.13, 0]);

    await g.enemies.load();
    await g.ensureChar(0);
    g.player.setCharacter(g.chars.get(CHARACTERS[0].slug)!, false);

    // precarga en segundo plano del resto de personajes
    (async () => {
      for (let i = 1; i < CHARACTERS.length; i++) {
        try {
          await g.ensureChar(i);
        } catch (e) {
          console.warn('precarga falló:', CHARACTERS[i].slug, e);
        }
      }
      console.log('todos los personajes listos');
    })();

    return g;
  }

  async ensureChar(idx: number): Promise<CharAsset> {
    const def = CHARACTERS[idx];
    const existing = this.chars.get(def.slug);
    if (existing) return existing;
    if (this.loading.has(def.slug)) {
      // espera activa simple
      return new Promise((resolve) => {
        const check = () => {
          const a = this.chars.get(def.slug);
          if (a) resolve(a);
          else setTimeout(check, 120);
        };
        check();
      });
    }
    this.loading.add(def.slug);
    const model = await loadGlb(`./assets/chars/${def.slug}.glb`);
    const baked = bakeCharacter(model);
    const prim = model.primitives[0];
    const mesh = this.gfx.uploadSkinnedMesh(prim.positions, prim.normals, prim.uvs, prim.joints!, prim.weights!, prim.indices);
    const tex = await this.gfx.uploadTexture(model.materials[prim.materialIdx]?.image ?? null);
    const type = this.renderer.skinned.createType(mesh, baked, tex.createView(d.texture2d(d.f32)), MAX_SKINNED);
    const height = model.bboxMax[1] - Math.min(0, model.bboxMin[1]);
    const worldScale = def.scale / Math.max(height, 0.01);
    const ci = type.clipIndex;
    const walk = ci['walk'] ?? 0;
    const clips = {
      idle: ci['idle'] ?? walk,
      walk,
      run: ci['run'] ?? walk,
      attack: ci['attack'] ?? walk,
      dead: ci['dead'] ?? walk,
    };
    const bc = baked.clips;
    const durations = {
      idle: bc['idle']?.duration ?? bc['walk']?.duration ?? 1,
      walk: bc['walk']?.duration ?? 1,
      run: bc['run']?.duration ?? 1,
      attack: bc['attack']?.duration ?? 1,
      dead: bc['dead']?.duration ?? 1,
    };
    const asset: CharAsset = { def, type, baked, clips, durations, worldScale };
    this.chars.set(def.slug, asset);
    this.renderer.skinnedTypes.push(type);
    this.enemies.registerShadow({
      type,
      walk: clips.walk, run: clips.run, attack: clips.attack, dead: clips.dead,
      attackDur: durations.attack,
      scale: worldScale,
      yBase: 0,
      tint: def.weapon.trail,
    });
    this.loading.delete(def.slug);
    return asset;
  }

  private trySwitch(idx: number): void {
    if (idx === this.currentChar || idx >= CHARACTERS.length) return;
    const asset = this.chars.get(CHARACTERS[idx].slug);
    if (asset) {
      this.currentChar = idx;
      this.pendingSwitch = -1;
      this.player.setCharacter(asset, true);
    } else {
      this.pendingSwitch = idx;
      void this.ensureChar(idx);
    }
  }

  private handleSwitching(): void {
    const digits = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];
    for (let i = 0; i < digits.length; i++) {
      if (this.input.pressed.has(digits[i])) this.trySwitch(i);
    }
    if (this.input.pressed.has('Tab') || this.input.pressed.has('KeyE')) {
      this.trySwitch((this.currentChar + 1) % CHARACTERS.length);
    }
    if (this.input.pressed.has('KeyQ')) {
      this.trySwitch((this.currentChar + CHARACTERS.length - 1) % CHARACTERS.length);
    }
    if (this.pendingSwitch >= 0) {
      const asset = this.chars.get(CHARACTERS[this.pendingSwitch].slug);
      if (asset) this.trySwitch(this.pendingSwitch);
    }
  }

  frame(now: number): void {
    const realDt = Math.min((now - this.last) / 1000 || 0.016, 1 / 20);
    this.last = now;
    const ts = this.vfx.timeScale();
    const dt = realDt * ts;
    this.time += dt;

    if (this.gfx.ensureSize()) this.renderer.onResize();

    // apuntado
    this.camera.cursorToGround(this.gfx, this.input.mouseX, this.input.mouseY, this.aim);
    if (this.input.wheel !== 0) this.camera.zoomWheel(this.input.wheel);

    this.handleSwitching();

    // simulación
    this.player.update(dt, realDt, this.aim);
    this.enemies.update(dt);
    this.vfx.update(realDt);
    this.renderer.sprites.update(realDt);
    this.renderer.trails.update(realDt);

    // pulso del muro si el jugador está cerca del borde
    const borderDist = ARENA_R - Math.hypot(this.player.x, this.player.z);
    if (borderDist < 7) {
      this.vfx.wallPulse = Math.max(this.vfx.wallPulse, clamp01(1 - borderDist / 7));
    }

    // cámara: intensidad por presión de enemigos
    let near = 0;
    this.enemies.forNear(this.player.x, this.player.z, 16, () => near++);
    const intensity = clamp01(near / 26) * 0.7 + (this.enemies.bossIdx >= 0 ? 0.5 : 0);
    this.camera.update(dt, realDt, this.player.x, this.player.z, this.player.vx, this.player.vz, this.aim.x, this.aim.z, intensity);
    this.camera.writeScene(this.gfx);
    this.gfx.camPosTime[3] = this.time;
    this.gfx.playerGlow[0] = this.player.x;
    this.gfx.playerGlow[1] = 0.9;
    this.gfx.playerGlow[2] = this.player.z;

    // ---- ensamblado de render ----
    for (const t of this.renderer.skinnedTypes) {
      t.count = 0;
      t.ghostCount = 0;
    }
    this.enemies.buildInstances();
    this.player.buildInstances();
    this.enemies.pushTelegraphs();
    this.vfx.pushMarks();

    this.frameNo++;
    if (!this.headless || this.frameNo % 15 === 0) {
      this.renderer.frame(dt, this.time);
    }
    this.input.endFrame();

    this.fpsAccum += realDt;
    this.fpsCount++;
    if (this.fpsAccum > 5) {
      console.log(`fps≈${Math.round(this.fpsCount / this.fpsAccum)} enemigos=${this.enemies.aliveCount} kills=${this.enemies.killCount}`);
      this.fpsAccum = 0;
      this.fpsCount = 0;
    }
  }
}
