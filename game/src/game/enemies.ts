/**
 * Hordas de enemigos: pools SoA, spatial hash para separación, IA por
 * comportamiento (melee, flanker, carga, nova, slam, boss por fases),
 * director de oleadas, élites (incluidas "sombras" skinned) y animación
 * puppet horneada en la matriz de instancia.
 */
import { mat4 } from 'wgpu-matrix';
import { ARENA_R, MAX_ENEMIES } from '../core/constants';
import { angleDelta, clamp, dampAngle, dist2, makeRng } from '../core/mathx';
import { CELL } from '../gfx/atlas';
import { DECAL } from '../gfx/decalsPipeline';
import { loadGlb } from '../gfx/glb';
import { writeInstance, type StaticBatch } from '../gfx/staticPipeline';
import { writeAnimState, type SkinnedType } from '../gfx/skinnedPipeline';
import type { Gfx } from '../gfx/gpu';
import type { Renderer } from '../gfx/renderer';
import { ENEMIES, ENEMY_INDEX, type EnemyDef } from './defs';
import type { Vfx } from './vfx';
import type { World } from './world';
import { d } from 'typegpu';

// estados
const SPAWN = 0, CHASE = 1, WINDUP = 2, ATTACK = 3, RECOVER = 4, STAGGER = 5, DYING = 6;

export interface PlayerRef {
  x: number; z: number; radius: number;
  alive: boolean;
  takeDamage(dmg: number, dirX: number, dirZ: number): void;
}

export interface ShadowTypeRef {
  type: SkinnedType;
  walk: number; run: number; attack: number; dead: number;
  attackDur: number;
  scale: number;
  yBase: number;
  tint: [number, number, number];
}

interface KindRender {
  batches: StaticBatch[];
  scale: number;   // factor GLB → mundo
  yBase: number;   // compensación de los pies
}

export class Enemies {
  gfx: Gfx;
  renderer: Renderer;
  vfx: Vfx;
  world: World;
  player: PlayerRef;
  rng = makeRng(1337);

  // SoA
  posX = new Float32Array(MAX_ENEMIES);
  posZ = new Float32Array(MAX_ENEMIES);
  velX = new Float32Array(MAX_ENEMIES);
  velZ = new Float32Array(MAX_ENEMIES);
  koX = new Float32Array(MAX_ENEMIES);
  koZ = new Float32Array(MAX_ENEMIES);
  hp = new Float32Array(MAX_ENEMIES);
  maxHp = new Float32Array(MAX_ENEMIES);
  kind = new Uint8Array(MAX_ENEMIES);
  state = new Uint8Array(MAX_ENEMIES);
  stateT = new Float32Array(MAX_ENEMIES);
  animT = new Float32Array(MAX_ENEMIES);
  facing = new Float32Array(MAX_ENEMIES);
  flash = new Float32Array(MAX_ENEMIES);
  slow = new Float32Array(MAX_ENEMIES);
  elite = new Uint8Array(MAX_ENEMIES);   // 0 normal, 1 élite, 2 sombra
  shadowType = new Int8Array(MAX_ENEMIES);
  aimX = new Float32Array(MAX_ENEMIES);  // dirección fijada del ataque
  aimZ = new Float32Array(MAX_ENEMIES);
  deathRoll = new Float32Array(MAX_ENEMIES); // lado del derrumbe
  alive = new Uint8Array(MAX_ENEMIES);
  attackDone = new Uint8Array(MAX_ENEMIES);
  bossPhase = 0;
  bossAttackCd = 0;
  bossIdx = -1;

  aliveCount = 0;
  killCount = 0;
  elapsed = 0;
  private spawnTimer = 2;
  private minibossTimer = 60;
  private bossTimer = 240;

  // spatial hash
  private static CELL = 2.5;
  private static GRID = Math.ceil((ARENA_R * 2 + 12) / 2.5);
  private heads = new Int32Array(Enemies.GRID * Enemies.GRID).fill(-1);
  private next = new Int32Array(MAX_ENEMIES).fill(-1);

  private renders: KindRender[] = [];
  shadowTypes: ShadowTypeRef[] = [];
  private m = new Float32Array(16);

  constructor(gfx: Gfx, renderer: Renderer, vfx: Vfx, world: World, player: PlayerRef) {
    this.gfx = gfx;
    this.renderer = renderer;
    this.vfx = vfx;
    this.world = world;
    this.player = player;
  }

  async load(): Promise<void> {
    for (const def of ENEMIES) {
      const model = await loadGlb(`./assets/enemies/${def.slug}.glb`);
      const height = model.bboxMax[1] - model.bboxMin[1];
      const scale = def.scale / Math.max(height, 0.001);
      const yBase = -model.bboxMin[1] * scale;
      const batches: StaticBatch[] = [];
      let owner: StaticBatch | null = null;
      for (const prim of model.primitives) {
        const mesh = this.gfx.uploadMeshFrom(prim.positions, prim.normals, prim.uvs, prim.indices);
        const tex = await this.gfx.uploadTexture(model.materials[prim.materialIdx]?.image ?? null);
        const view = tex.createView(d.texture2d(d.f32));
        const cap = def.behavior === 'boss' ? 2 : def.behavior === 'slam' ? 4 : 120;
        const b: StaticBatch = owner
          ? this.renderer.statics.createBatchPart(mesh, view, owner)
          : this.renderer.statics.createBatch(mesh, view, cap);
        if (!owner) owner = b;
        batches.push(b);
        this.renderer.staticBatches.push(b);
      }
      this.renders.push({ batches, scale, yBase });
    }
  }

  /** registra un personaje jugable como posible "sombra" élite */
  registerShadow(ref: ShadowTypeRef): void {
    this.shadowTypes.push(ref);
  }

  spawn(kindIdx: number, x: number, z: number, elite: number): number {
    for (let i = 0; i < MAX_ENEMIES; i++) {
      if (this.alive[i]) continue;
      const def = ENEMIES[kindIdx];
      this.alive[i] = 1;
      this.kind[i] = kindIdx;
      this.posX[i] = x; this.posZ[i] = z;
      this.velX[i] = 0; this.velZ[i] = 0;
      this.koX[i] = 0; this.koZ[i] = 0;
      const hpMul = (elite === 1 ? 2.4 : elite === 2 ? 4.5 : 1) * (1 + this.elapsed / 240);
      this.hp[i] = this.maxHp[i] = def.hp * hpMul;
      this.state[i] = SPAWN;
      this.stateT[i] = 0;
      this.animT[i] = this.rng() * 10;
      this.facing[i] = this.rng() * Math.PI * 2;
      this.flash[i] = 0;
      this.slow[i] = 0;
      this.elite[i] = elite;
      this.shadowType[i] = elite === 2 && this.shadowTypes.length > 0
        ? Math.floor(this.rng() * this.shadowTypes.length) : -1;
      this.deathRoll[i] = this.rng() > 0.5 ? 1 : -1;
      this.attackDone[i] = 0;
      this.aliveCount++;
      if (def.behavior === 'boss') {
        this.bossIdx = i;
        this.bossPhase = 1;
        this.bossAttackCd = 2.5;
        this.vfx.slowmo(0.9, 0.25);
        this.vfx.shockwave(1.0);
        this.vfx.camera.addShake(1.0);
      }
      this.vfx.spawnBurst(x, z, def.scale * 0.6, 0.65, 0.3, 1.0);
      return i;
    }
    return -1;
  }

  /** daño del jugador a un enemigo */
  damage(i: number, amount: number, crit: boolean, kbX: number, kbZ: number, kb: number, color: [number, number, number], kind: number): void {
    if (!this.alive[i] || this.state[i] === DYING) return;
    const def = ENEMIES[this.kind[i]];
    this.hp[i] -= amount;
    this.flash[i] = 1;
    const resist = def.behavior === 'boss' ? 0.12 : def.behavior === 'slam' ? 0.25 : 1;
    this.koX[i] += kbX * kb * resist;
    this.koZ[i] += kbZ * kb * resist;
    const y = def.scale * 0.62;
    this.renderer.sprites.spawnDamage(this.posX[i], y + 0.6, this.posZ[i], amount, crit);
    this.vfx.hitImpact(this.posX[i], y, this.posZ[i], kbX, kbZ, color, kind, crit);
    if (this.hp[i] <= 0) {
      this.kill(i);
    } else if (resist === 1 && kb > 7 && this.state[i] !== ATTACK) {
      this.state[i] = STAGGER;
      this.stateT[i] = 0;
    }
  }

  applySlow(i: number): void {
    this.slow[i] = 1;
  }

  private kill(i: number): void {
    const def = ENEMIES[this.kind[i]];
    this.state[i] = DYING;
    this.stateT[i] = 0;
    this.killCount++;
    const col: [number, number, number] = this.elite[i] === 2
      ? [0.6, 0.2, 1.0] : this.elite[i] === 1 ? [1.0, 0.8, 0.2] : [0.9, 0.4, 0.25];
    this.vfx.enemyDeath(this.posX[i], def.scale * 0.5, this.posZ[i], def.scale * 0.55, col);
    if (def.behavior === 'boss') {
      this.bossIdx = -1;
      this.vfx.slowmo(1.4, 0.18);
      this.vfx.shockwave(1.4);
      this.vfx.camera.addShake(1.2);
      this.vfx.slam(this.posX[i], this.posZ[i], 7, [0.9, 0.4, 1.0], true);
      this.bossTimer = 240;
    } else if (def.behavior === 'slam') {
      this.vfx.slowmo(0.6, 0.35);
      this.vfx.camera.addShake(0.7);
    } else if (this.killCount % 12 === 0) {
      this.vfx.hitstop(0.05);
    }
  }

  /** enemigos dentro de un arco (para el ataque del jugador) */
  queryArc(x: number, z: number, reach: number, dirAngle: number, arc: number, cb: (i: number) => void): void {
    const r2 = reach * reach;
    this.forNear(x, z, reach + 1.5, (i) => {
      if (!this.alive[i] || this.state[i] === DYING || this.state[i] === SPAWN) return;
      const def = ENEMIES[this.kind[i]];
      const dx = this.posX[i] - x;
      const dz = this.posZ[i] - z;
      const dd = dx * dx + dz * dz;
      const rr = reach + def.radius;
      if (dd > rr * rr) return;
      const ang = Math.atan2(dz, dx);
      if (Math.abs(angleDelta(dirAngle, ang)) < arc * 0.5 + Math.atan2(def.radius, Math.sqrt(dd) + 0.001)) cb(i);
    });
  }

  private cellIdx(x: number, z: number): number {
    const g = Enemies.GRID;
    const cx = clamp(Math.floor((x + ARENA_R + 6) / Enemies.CELL), 0, g - 1);
    const cz = clamp(Math.floor((z + ARENA_R + 6) / Enemies.CELL), 0, g - 1);
    return cz * g + cx;
  }

  private rebuildHash(): void {
    this.heads.fill(-1);
    for (let i = 0; i < MAX_ENEMIES; i++) {
      if (!this.alive[i]) continue;
      const c = this.cellIdx(this.posX[i], this.posZ[i]);
      this.next[i] = this.heads[c];
      this.heads[c] = i;
    }
  }

  forNear(x: number, z: number, radius: number, cb: (i: number) => void): void {
    const g = Enemies.GRID;
    const c0x = clamp(Math.floor((x - radius + ARENA_R + 6) / Enemies.CELL), 0, g - 1);
    const c1x = clamp(Math.floor((x + radius + ARENA_R + 6) / Enemies.CELL), 0, g - 1);
    const c0z = clamp(Math.floor((z - radius + ARENA_R + 6) / Enemies.CELL), 0, g - 1);
    const c1z = clamp(Math.floor((z + radius + ARENA_R + 6) / Enemies.CELL), 0, g - 1);
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        let i = this.heads[cz * g + cx];
        while (i >= 0) {
          cb(i);
          i = this.next[i];
        }
      }
    }
  }

  // ---------- director de oleadas ----------
  private director(dt: number): void {
    this.elapsed += dt;
    this.spawnTimer -= dt;
    this.minibossTimer -= dt;
    this.bossTimer -= dt;

    if (this.spawnTimer <= 0 && this.aliveCount < MAX_ENEMIES - 30) {
      this.spawnTimer = Math.max(0.9, 1.9 - this.elapsed / 200);
      let budget = Math.min(3 + this.elapsed / 14, 22) * (this.bossIdx >= 0 ? 0.45 : 1);
      let guard = 24;
      while (budget > 0 && guard-- > 0) {
        const options = ENEMIES.filter((e) =>
          e.cost > 0 && e.cost <= budget && this.elapsed >= e.unlockAt);
        if (options.length === 0) break;
        const def = options[Math.floor(this.rng() * options.length)];
        const pos = this.spawnPos();
        let elite = 0;
        if (this.elapsed > 75 && this.rng() < 0.1) elite = 1;
        if (this.elapsed > 130 && this.rng() < 0.05 && this.shadowTypes.length > 0) elite = 2;
        this.spawn(ENEMY_INDEX[def.slug], pos.x, pos.z, elite);
        budget -= def.cost * (elite ? 2.5 : 1);
      }
    }
    if (this.minibossTimer <= 0) {
      this.minibossTimer = Math.max(45, 80 - this.elapsed / 30);
      const pos = this.spawnPos();
      this.spawn(ENEMY_INDEX['Gigante'], pos.x, pos.z, 0);
    }
    if (this.bossTimer <= 0 && this.bossIdx < 0) {
      this.bossTimer = 999; // se rearma al morir
      this.spawn(ENEMY_INDEX['Pekka'], 0, 0, 0);
    }
  }

  private spawnPos(): { x: number; z: number } {
    const a = this.rng() * Math.PI * 2;
    const r = 26 + this.rng() * 8;
    const p = { x: this.player.x + Math.cos(a) * r, z: this.player.z + Math.sin(a) * r };
    const dd = Math.hypot(p.x, p.z);
    if (dd > ARENA_R - 3) {
      const s = (ARENA_R - 3) / dd;
      p.x *= s; p.z *= s;
    }
    this.world.collide(p, 0.6);
    return p;
  }

  // ---------- update ----------
  private scratch = { x: 0, z: 0 };

  update(dt: number): void {
    if (dt <= 0) return;
    this.director(dt);
    this.rebuildHash();
    const p = this.player;

    for (let i = 0; i < MAX_ENEMIES; i++) {
      if (!this.alive[i]) continue;
      const def = ENEMIES[this.kind[i]];
      const st = this.state[i];
      this.stateT[i] += dt;
      this.flash[i] = Math.max(0, this.flash[i] - dt * 6);
      this.slow[i] = Math.max(0, this.slow[i] - dt * 0.4);
      const slowK = 1 - this.slow[i] * 0.55;

      const dx = p.x - this.posX[i];
      const dz = p.z - this.posZ[i];
      const distP = Math.hypot(dx, dz) || 0.001;
      const dirX = dx / distP;
      const dirZ = dz / distP;

      let targetVX = 0;
      let targetVZ = 0;
      let desiredFacing = Math.atan2(dirZ, dirX);

      switch (st) {
        case SPAWN: {
          if (this.stateT[i] > 0.55) this.state[i] = CHASE;
          break;
        }
        case CHASE: {
          const speed = def.speed * slowK * (this.elite[i] === 1 ? 1.15 : 1);
          if (def.behavior === 'flanker' && distP > def.attackRange * 1.6) {
            // orbita en diagonal hacia el jugador
            const side = (i % 2 === 0 ? 1 : -1);
            targetVX = (dirX * 0.75 - dirZ * 0.65 * side) * speed;
            targetVZ = (dirZ * 0.75 + dirX * 0.65 * side) * speed;
          } else {
            targetVX = dirX * speed;
            targetVZ = dirZ * speed;
          }
          const inRange = def.behavior === 'nova'
            ? distP < def.attackRange * 0.75
            : def.behavior === 'charge'
              ? distP < 13 && distP > 4
              : distP < def.attackRange + p.radius - 0.25;
          if (inRange && p.alive) {
            this.state[i] = WINDUP;
            this.stateT[i] = 0;
            this.aimX[i] = dirX;
            this.aimZ[i] = dirZ;
            this.attackDone[i] = 0;
          }
          if (def.behavior === 'boss') this.bossThink(i, distP, dirX, dirZ, dt);
          break;
        }
        case WINDUP: {
          // frenado + telegraph
          const wind = def.windup * (this.bossPhase >= 2 && def.behavior === 'boss' ? 0.75 : 1);
          desiredFacing = Math.atan2(this.aimZ[i], this.aimX[i]);
          if (this.stateT[i] >= wind) {
            this.state[i] = ATTACK;
            this.stateT[i] = 0;
            if (def.behavior === 'charge') {
              this.velX[i] = this.aimX[i] * 26;
              this.velZ[i] = this.aimZ[i] * 26;
              this.vfx.dust(this.posX[i], this.posZ[i], this.aimX[i], this.aimZ[i], 10);
            }
          }
          break;
        }
        case ATTACK: {
          this.doAttack(i, def, distP, dirX, dirZ, dt);
          break;
        }
        case RECOVER: {
          if (this.stateT[i] >= def.recover) {
            this.state[i] = CHASE;
            this.stateT[i] = 0;
          }
          break;
        }
        case STAGGER: {
          if (this.stateT[i] > 0.32) {
            this.state[i] = CHASE;
            this.stateT[i] = 0;
          }
          break;
        }
        case DYING: {
          if (this.stateT[i] > 0.65) {
            this.alive[i] = 0;
            this.aliveCount--;
          }
          break;
        }
      }

      // separación con vecinos
      if (st === CHASE || st === WINDUP) {
        let sepX = 0;
        let sepZ = 0;
        this.forNear(this.posX[i], this.posZ[i], 1.6, (j) => {
          if (j === i || !this.alive[j] || this.state[j] === DYING) return;
          const ddx = this.posX[i] - this.posX[j];
          const ddz = this.posZ[i] - this.posZ[j];
          const dd = ddx * ddx + ddz * ddz;
          const rr = def.radius + ENEMIES[this.kind[j]].radius + 0.15;
          if (dd < rr * rr && dd > 0.0001) {
            const l = Math.sqrt(dd);
            const push = (rr - l) / l;
            sepX += ddx * push;
            sepZ += ddz * push;
          }
        });
        targetVX += sepX * 7;
        targetVZ += sepZ * 7;
      }

      // integración con suavizado + knockback
      const accel = st === ATTACK && def.behavior === 'charge' ? 0 : 8;
      this.velX[i] += (targetVX - this.velX[i]) * Math.min(1, accel * dt);
      this.velZ[i] += (targetVZ - this.velZ[i]) * Math.min(1, accel * dt);
      this.koX[i] *= Math.max(0, 1 - 7 * dt);
      this.koZ[i] *= Math.max(0, 1 - 7 * dt);
      this.posX[i] += (this.velX[i] + this.koX[i]) * dt;
      this.posZ[i] += (this.velZ[i] + this.koZ[i]) * dt;

      // colisión con mundo
      this.scratch.x = this.posX[i];
      this.scratch.z = this.posZ[i];
      this.world.collide(this.scratch, def.radius * 0.8);
      // cuerpo del jugador: los enemigos no lo atraviesan
      if (p.alive && st !== DYING) {
        const bdx = this.scratch.x - p.x;
        const bdz = this.scratch.z - p.z;
        const rr = def.radius * 0.85 + p.radius;
        const bd2 = bdx * bdx + bdz * bdz;
        if (bd2 < rr * rr && bd2 > 1e-6) {
          const bl = Math.sqrt(bd2);
          const push = (rr - bl) / bl;
          this.scratch.x += bdx * push;
          this.scratch.z += bdz * push;
        }
      }
      this.posX[i] = this.scratch.x;
      this.posZ[i] = this.scratch.z;

      // facing suave
      if (st !== DYING) {
        this.facing[i] = dampAngle(this.facing[i], desiredFacing, st === ATTACK ? 4 : 9, dt);
      }
      const speedNow = Math.hypot(this.velX[i], this.velZ[i]);
      this.animT[i] += dt * (0.6 + speedNow * 0.22) * def.bob;
    }
  }

  private doAttack(i: number, def: EnemyDef, distP: number, dirX: number, dirZ: number, dt: number): void {
    const p = this.player;
    switch (def.behavior) {
      case 'melee':
      case 'flanker': {
        // embestida corta con ventana de daño
        if (this.stateT[i] < 0.14) {
          this.velX[i] = this.aimX[i] * def.speed * 2.6;
          this.velZ[i] = this.aimZ[i] * def.speed * 2.6;
        }
        if (!this.attackDone[i] && this.stateT[i] > 0.1 && this.stateT[i] < 0.3) {
          if (distP < def.attackRange + p.radius && p.alive) {
            this.attackDone[i] = 1;
            p.takeDamage(def.damage, dirX, dirZ);
          }
        }
        if (this.stateT[i] > 0.34) {
          this.state[i] = RECOVER;
          this.stateT[i] = 0;
        }
        break;
      }
      case 'charge': {
        // corre en línea recta hasta agotar el tiempo o golpear
        this.velX[i] = this.aimX[i] * 26;
        this.velZ[i] = this.aimZ[i] * 26;
        if (Math.floor(this.stateT[i] * 30) % 2 === 0) {
          this.vfx.dust(this.posX[i], this.posZ[i], this.aimX[i], this.aimZ[i], 2);
        }
        if (!this.attackDone[i] && distP < def.radius + p.radius + 0.6 && p.alive) {
          this.attackDone[i] = 1;
          p.takeDamage(def.damage, this.aimX[i], this.aimZ[i]);
          this.vfx.camera.addShake(0.35);
        }
        const hitWall = Math.hypot(this.posX[i], this.posZ[i]) > ARENA_R - 1.6;
        if (this.stateT[i] > 0.55 || hitWall) {
          if (hitWall) {
            this.vfx.slam(this.posX[i], this.posZ[i], 2, [0.9, 0.6, 0.3], false);
            this.vfx.wallPulse = 1;
          }
          this.velX[i] = 0; this.velZ[i] = 0;
          this.state[i] = RECOVER;
          this.stateT[i] = 0;
        }
        break;
      }
      case 'nova': {
        // explosión radial tras el telegraph
        if (!this.attackDone[i] && this.stateT[i] > 0.1) {
          this.attackDone[i] = 1;
          const r = def.attackRange;
          this.vfx.slam(this.posX[i], this.posZ[i], r * 0.55, [1.0, 0.45, 0.15], false);
          this.vfx.addLight(this.posX[i], 1, this.posZ[i], 1, 0.45, 0.1, 6, r * 2.2, 0.35);
          if (distP < r + p.radius && p.alive) {
            p.takeDamage(def.damage, dirX, dirZ);
          }
        }
        if (this.stateT[i] > 0.5) {
          this.state[i] = RECOVER;
          this.stateT[i] = 0;
        }
        break;
      }
      case 'slam':
      case 'boss': {
        if (!this.attackDone[i] && this.stateT[i] > 0.12) {
          this.attackDone[i] = 1;
          const r = def.attackRange;
          const big = def.behavior === 'boss';
          this.vfx.slam(this.posX[i] + this.aimX[i] * r * 0.5, this.posZ[i] + this.aimZ[i] * r * 0.5, r * 0.6, big ? [0.75, 0.35, 1.0] : [0.75, 0.6, 0.4], big);
          this.vfx.hitstop(big ? 0.05 : 0.03);
          const hx = this.posX[i] + this.aimX[i] * r * 0.5;
          const hz = this.posZ[i] + this.aimZ[i] * r * 0.5;
          if (dist2(hx, hz, p.x, p.z) < (r * 0.85 + p.radius) ** 2 && p.alive) {
            p.takeDamage(def.damage, dirX, dirZ);
          }
        }
        if (this.stateT[i] > 0.5) {
          this.state[i] = RECOVER;
          this.stateT[i] = 0;
        }
        break;
      }
    }
  }

  // ---------- boss ----------
  private bossThink(i: number, distP: number, dirX: number, dirZ: number, dt: number): void {
    const hpFrac = this.hp[i] / this.maxHp[i];
    if (hpFrac < 0.5 && this.bossPhase === 1) {
      this.bossPhase = 2;
      this.vfx.slowmo(0.7, 0.3);
      this.vfx.shockwave(1.0);
      this.vfx.slam(this.posX[i], this.posZ[i], 5, [1.0, 0.2, 0.2], true);
      this.summonAdds(i, 4);
    } else if (hpFrac < 0.22 && this.bossPhase === 2) {
      this.bossPhase = 3;
      this.vfx.slowmo(0.7, 0.3);
      this.vfx.shockwave(1.2);
      this.vfx.slam(this.posX[i], this.posZ[i], 6.5, [1.0, 0.1, 0.4], true);
      this.summonAdds(i, 6);
    }
    this.bossAttackCd -= dt;
    if (this.bossAttackCd <= 0) {
      const roll = this.rng();
      if (roll < 0.4 || distP < 5) {
        // slam frontal (usa WINDUP→ATTACK genérico)
        this.state[i] = WINDUP;
        this.stateT[i] = 0;
        this.aimX[i] = dirX; this.aimZ[i] = dirZ;
        this.attackDone[i] = 0;
      } else if (roll < 0.7) {
        // carga
        this.state[i] = WINDUP;
        this.stateT[i] = 0;
        this.aimX[i] = dirX; this.aimZ[i] = dirZ;
        this.attackDone[i] = 0;
        // marca de carga: convertimos el ataque en embestida manual
        this.velX[i] = 0; this.velZ[i] = 0;
      } else {
        this.summonAdds(i, this.bossPhase >= 3 ? 5 : 3);
      }
      this.bossAttackCd = (this.bossPhase >= 2 ? 2.4 : 3.4) + this.rng() * 1.2;
    }
  }

  private summonAdds(i: number, n: number): void {
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + this.rng();
      const x = this.posX[i] + Math.cos(a) * 4;
      const z = this.posZ[i] + Math.sin(a) * 4;
      this.spawn(ENEMY_INDEX['Esqueleto'], x, z, this.elapsed > 150 ? 1 : 0);
    }
  }

  /** telegraphs de windup (se llama cada frame al armar los decals) */
  pushTelegraphs(): void {
    for (let i = 0; i < MAX_ENEMIES; i++) {
      if (!this.alive[i] || this.state[i] !== WINDUP) continue;
      const def = ENEMIES[this.kind[i]];
      const prog = clamp(this.stateT[i] / def.windup, 0, 1);
      const ang = Math.atan2(this.aimZ[i], this.aimX[i]);
      switch (def.behavior) {
        case 'nova':
          this.renderer.decals.push(this.posX[i], this.posZ[i], def.attackRange, 0, DECAL.telegraphCircle, prog, 0, 0.85, 1.0, 0.45, 0.12);
          break;
        case 'charge': {
          const len = 12;
          this.renderer.decals.push(
            this.posX[i] + this.aimX[i] * len * 0.5, this.posZ[i] + this.aimZ[i] * len * 0.5,
            len * 0.5, ang, DECAL.line, prog, 0.14, 0.8, 1.0, 0.55, 0.15,
          );
          break;
        }
        case 'slam':
        case 'boss': {
          const r = def.attackRange;
          this.renderer.decals.push(
            this.posX[i] + this.aimX[i] * r * 0.5, this.posZ[i] + this.aimZ[i] * r * 0.5,
            r * 0.85, 0, DECAL.telegraphCircle, prog, 0, 0.9,
            def.behavior === 'boss' ? 0.8 : 1.0, def.behavior === 'boss' ? 0.3 : 0.6, def.behavior === 'boss' ? 1.0 : 0.25,
          );
          break;
        }
        default:
          this.renderer.decals.push(
            this.posX[i] + this.aimX[i] * def.attackRange * 0.55,
            this.posZ[i] + this.aimZ[i] * def.attackRange * 0.55,
            def.attackRange * 0.8, ang, DECAL.sector, prog, 0.7, 0.55, 1.0, 0.35, 0.15,
          );
      }
      // boss: anillo de vida bajo los pies
      if (def.behavior === 'boss' || def.behavior === 'slam') {
        this.renderer.decals.push(
          this.posX[i], this.posZ[i], def.radius + 0.9, 0, DECAL.hpArc,
          clamp(this.hp[i] / this.maxHp[i], 0, 1), 0, 0.8, 1.0, 0.25, 0.3,
        );
      }
    }
  }

  /** escribe las instancias de render (puppet o sombra skinned) */
  buildInstances(): void {
    for (const kr of this.renders) {
      for (const b of kr.batches) b.count = 0;
    }
    for (const sh of this.shadowTypes) {
      // el jugador ocupa el slot 0 de su tipo; las sombras se añaden después
      // (game.ts resetea counts antes de llamar aquí)
    }

    for (let i = 0; i < MAX_ENEMIES; i++) {
      if (!this.alive[i]) continue;
      const def = ENEMIES[this.kind[i]];
      const st = this.state[i];
      const t = this.stateT[i];

      // parámetros puppet
      let squash = 1;
      let lean = 0;
      let roll = 0;
      let y = 0;
      let dissolve = 0;
      const speedNow = Math.hypot(this.velX[i], this.velZ[i]);
      const runK = clamp(speedNow / (def.speed + 2), 0, 1);
      const bobPhase = this.animT[i] * 9;
      y += Math.abs(Math.sin(bobPhase)) * 0.09 * runK * def.scale * 0.5;
      squash += Math.sin(bobPhase * 2) * 0.035 * runK;
      lean = runK * 0.14;

      if (st === SPAWN) {
        const k = clamp(t / 0.55, 0, 1);
        dissolve = 1 - k;
        squash *= 0.7 + 0.3 * k;
      } else if (st === WINDUP) {
        const k = clamp(t / def.windup, 0, 1);
        lean = -0.22 * k;              // se echa atrás
        squash *= 1 + 0.12 * k;        // se estira
      } else if (st === ATTACK) {
        lean = 0.38;
        squash *= 0.92;
      } else if (st === STAGGER) {
        lean = -0.3 * (1 - t / 0.32);
        squash *= 0.88;
      } else if (st === DYING) {
        const k = clamp(t / 0.6, 0, 1);
        roll = this.deathRoll[i] * k * k * 1.5;
        y -= k * 0.25 * def.scale;
        dissolve = k * 0.95;
      }

      const flash = this.flash[i];
      const isElite = this.elite[i] === 1;
      const isShadow = this.elite[i] === 2;
      const frost = this.slow[i];

      if (isShadow && this.shadowType[i] >= 0) {
        // élite sombra: personaje skinned oscuro
        const sh = this.shadowTypes[this.shadowType[i]];
        const tp = sh.type;
        if (tp.count < tp.capacity - 3) {
          const idx = tp.count++;
          mat4.identity(this.m);
          mat4.translate(this.m, [this.posX[i], y, this.posZ[i]], this.m);
          mat4.rotateY(this.m, -this.facing[i] + Math.PI * 0.5, this.m);
          if (roll) mat4.rotateZ(this.m, roll, this.m);
          mat4.uniformScale(this.m, sh.scale * 1.12, this.m);
          writeInstance(tp.raw, idx, this.m, 0.16, 0.05, 0.3, 0, flash, dissolve, 0.85, 0);
          let clip = sh.run;
          let ct = this.animT[i] * 0.35;
          if (st === ATTACK || st === WINDUP) {
            clip = sh.attack;
            ct = clamp((st === WINDUP ? t / def.windup * 0.3 : 0.3 + (t / 0.4) * 0.5) * sh.attackDur, 0, sh.attackDur);
          } else if (st === DYING) {
            clip = sh.dead;
            ct = t;
          }
          writeAnimState(tp, idx, clip, clip, ct, ct, 0);
        }
        continue;
      }

      const kr = this.renders[this.kind[i]];
      const owner = kr.batches[0];
      if (owner.count >= owner.capacity) continue;
      const idx = owner.count;
      mat4.identity(this.m);
      mat4.translate(this.m, [this.posX[i], y + kr.yBase * squash, this.posZ[i]], this.m);
      mat4.rotateY(this.m, -this.facing[i] - Math.PI * 0.5, this.m);
      if (roll) mat4.rotateZ(this.m, roll, this.m);
      if (lean) mat4.rotateX(this.m, lean, this.m);
      const es = isElite ? 1.16 : 1;
      mat4.scale(this.m, [kr.scale * es, kr.scale * squash * es, kr.scale * es], this.m);

      let tr = 1, tg = 1, tb = 1, em = 0;
      if (isElite) {
        tr = 1.15; tg = 0.95; tb = 0.5;
        em = 0.4 + 0.2 * Math.sin(this.animT[i] * 6);
      }
      if (frost > 0) {
        tr *= 1 - frost * 0.4; tg *= 1 - frost * 0.1; tb *= 1 + frost * 0.35;
      }
      if (def.behavior === 'boss' && this.bossPhase >= 2) {
        tr = 1.3; tg = 0.5; tb = 0.55;
        em = 0.5 + 0.25 * Math.sin(this.animT[i] * 10);
      }
      writeInstance(owner.raw, idx, this.m, tr, tg, tb, 0, flash, dissolve, em, 0);
      for (const b of kr.batches) b.count = idx + 1;
      owner.dirty = true;
    }
  }
}
