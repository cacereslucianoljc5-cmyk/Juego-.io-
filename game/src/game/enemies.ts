/**
 * Enemigos: los otros 13 personajes del elenco te cazan por la arena.
 * Cada uno lucha con su propia arma (alcance, arco, daño y color derivados
 * de su definición), con esqueleto animado completo en GPU: walk/run al
 * perseguir, su clip de ataque al golpear y su clip de muerte al caer.
 * Pools SoA + spatial hash para hordas; élites doradas con más vida.
 */
import { mat4 } from 'wgpu-matrix';
import { ARENA_R, MAX_ENEMIES, MAX_SKINNED, MAX_TRAILS } from '../core/constants';
import { angleDelta, clamp, clamp01, dampAngle, makeRng } from '../core/mathx';
import { CELL } from '../gfx/atlas';
import { DECAL } from '../gfx/decalsPipeline';
import { sampleBoneWorld } from '../gfx/animBake';
import { writeInstance } from '../gfx/staticPipeline';
import { writeAnimState } from '../gfx/skinnedPipeline';
import type { Gfx } from '../gfx/gpu';
import type { Renderer } from '../gfx/renderer';
import { CHARACTERS, enemyStatsFor } from './defs';
import type { CharAsset } from './player';
import type { Vfx } from './vfx';
import type { World } from './world';

// estados
const SPAWN = 0, CHASE = 1, WINDUP = 2, ATTACK = 3, RECOVER = 4, STAGGER = 5, DYING = 6;

export interface PlayerRef {
  x: number; z: number; radius: number;
  alive: boolean;
  takeDamage(dmg: number, dirX: number, dirZ: number): void;
}

export class Enemies {
  gfx: Gfx;
  renderer: Renderer;
  vfx: Vfx;
  world: World;
  player: PlayerRef;
  rng = makeRng(1337);

  /** assets por índice de personaje (los registra game.ts al cargarlos) */
  charAssets: (CharAsset | null)[] = CHARACTERS.map(() => null);
  /** personaje actual del jugador: no se generan enemigos de ese tipo */
  playerCharIdx = 0;

  // SoA
  posX = new Float32Array(MAX_ENEMIES);
  posZ = new Float32Array(MAX_ENEMIES);
  velX = new Float32Array(MAX_ENEMIES);
  velZ = new Float32Array(MAX_ENEMIES);
  koX = new Float32Array(MAX_ENEMIES);
  koZ = new Float32Array(MAX_ENEMIES);
  hp = new Float32Array(MAX_ENEMIES);
  maxHp = new Float32Array(MAX_ENEMIES);
  kind = new Uint8Array(MAX_ENEMIES);      // índice en CHARACTERS
  state = new Uint8Array(MAX_ENEMIES);
  stateT = new Float32Array(MAX_ENEMIES);
  animT = new Float32Array(MAX_ENEMIES);
  facing = new Float32Array(MAX_ENEMIES);
  flash = new Float32Array(MAX_ENEMIES);
  slow = new Float32Array(MAX_ENEMIES);
  elite = new Uint8Array(MAX_ENEMIES);
  aimX = new Float32Array(MAX_ENEMIES);
  aimZ = new Float32Array(MAX_ENEMIES);
  alive = new Uint8Array(MAX_ENEMIES);
  attackDone = new Uint8Array(MAX_ENEMIES);
  // stats congeladas al spawnear
  sHp = new Float32Array(MAX_ENEMIES);
  sSpeed = new Float32Array(MAX_ENEMIES);
  sDamage = new Float32Array(MAX_ENEMIES);
  sRange = new Float32Array(MAX_ENEMIES);
  sArc = new Float32Array(MAX_ENEMIES);
  sWindup = new Float32Array(MAX_ENEMIES);
  sRecover = new Float32Array(MAX_ENEMIES);

  aliveCount = 0;
  killCount = 0;
  elapsed = 0;
  private spawnTimer = 1.2;
  private perTypeCount = new Uint8Array(CHARACTERS.length);

  // spatial hash
  private static CELL = 2.5;
  private static GRID = Math.ceil((ARENA_R * 2 + 12) / 2.5);
  private heads = new Int32Array(Enemies.GRID * Enemies.GRID).fill(-1);
  private next = new Int32Array(MAX_ENEMIES).fill(-1);

  private m = new Float32Array(16);
  private scratch = { x: 0, z: 0 };

  // trails de arma para enemigos atacando: slots 1..MAX_TRAILS-1 (0 = jugador)
  private trailOwner = new Int32Array(MAX_TRAILS).fill(-1);
  private boneM = new Float32Array(16);
  private handM = new Float32Array(16);
  private foreM = new Float32Array(16);

  /** libera el slot de trail de un enemigo (al terminar o morir) */
  freeTrail(i: number): void {
    for (let s = 1; s < MAX_TRAILS; s++) {
      if (this.trailOwner[s] === i) {
        this.trailOwner[s] = -1;
        this.renderer.trails.trails[s].clear();
      }
    }
  }

  private trailSlotFor(i: number): number {
    for (let s = 1; s < MAX_TRAILS; s++) {
      if (this.trailOwner[s] === i) return s;
    }
    for (let s = 1; s < MAX_TRAILS; s++) {
      if (this.trailOwner[s] < 0) {
        this.trailOwner[s] = i;
        return s;
      }
    }
    return -1;
  }

  constructor(gfx: Gfx, renderer: Renderer, vfx: Vfx, world: World, player: PlayerRef) {
    this.gfx = gfx;
    this.renderer = renderer;
    this.vfx = vfx;
    this.world = world;
    this.player = player;
  }

  registerCharacter(idx: number, asset: CharAsset): void {
    this.charAssets[idx] = asset;
  }

  private radiusOf(i: number): number {
    return 0.55;
  }

  spawn(kindIdx: number, x: number, z: number, elite: number): number {
    if (!this.charAssets[kindIdx]) return -1;
    for (let i = 0; i < MAX_ENEMIES; i++) {
      if (this.alive[i]) continue;
      const def = CHARACTERS[kindIdx];
      const st = enemyStatsFor(def, this.elapsed);
      this.alive[i] = 1;
      this.kind[i] = kindIdx;
      this.posX[i] = x; this.posZ[i] = z;
      this.velX[i] = 0; this.velZ[i] = 0;
      this.koX[i] = 0; this.koZ[i] = 0;
      const hpMul = elite === 1 ? 2.6 : 1;
      this.hp[i] = this.maxHp[i] = st.hp * hpMul;
      this.sHp[i] = st.hp;
      this.sSpeed[i] = st.speed * (elite === 1 ? 1.12 : 1);
      this.sDamage[i] = st.damage;
      this.sRange[i] = st.attackRange;
      this.sArc[i] = st.arc;
      this.sWindup[i] = st.windup;
      this.sRecover[i] = st.recover;
      this.state[i] = SPAWN;
      this.stateT[i] = 0;
      this.animT[i] = this.rng() * 10;
      this.facing[i] = this.rng() * Math.PI * 2;
      this.flash[i] = 0;
      this.slow[i] = 0;
      this.elite[i] = elite;
      this.attackDone[i] = 0;
      this.aliveCount++;
      this.perTypeCount[kindIdx]++;
      const c = def.weapon.trail;
      this.vfx.spawnBurst(x, z, 0.9, c[0], c[1], c[2]);
      return i;
    }
    return -1;
  }

  /** daño del jugador a un enemigo */
  damage(i: number, amount: number, crit: boolean, kbX: number, kbZ: number, kb: number, color: [number, number, number], kind: number): void {
    if (!this.alive[i] || this.state[i] === DYING) return;
    this.hp[i] -= amount;
    this.flash[i] = 1;
    this.koX[i] += kbX * kb;
    this.koZ[i] += kbZ * kb;
    const y = 1.15;
    this.renderer.sprites.spawnDamage(this.posX[i], y + 0.6, this.posZ[i], amount, crit);
    this.vfx.hitImpact(this.posX[i], y, this.posZ[i], kbX, kbZ, color, kind, crit);
    if (this.hp[i] <= 0) {
      this.kill(i);
    } else if (kb > 7 && this.state[i] !== ATTACK) {
      this.state[i] = STAGGER;
      this.stateT[i] = 0;
    }
  }

  applySlow(i: number): void {
    this.slow[i] = 1;
  }

  private kill(i: number): void {
    const def = CHARACTERS[this.kind[i]];
    this.state[i] = DYING;
    this.stateT[i] = 0;
    this.freeTrail(i);
    this.killCount++;
    const col: [number, number, number] = this.elite[i] === 1
      ? [1.0, 0.8, 0.2] : def.weapon.trail;
    this.vfx.enemyDeath(this.posX[i], 1.0, this.posZ[i], 1.1, col);
    if (this.killCount % 12 === 0) {
      this.vfx.hitstop(0.05);
    }
  }

  /** enemigos dentro de un arco (para el ataque del jugador) */
  queryArc(x: number, z: number, reach: number, dirAngle: number, arc: number, cb: (i: number) => void): void {
    this.forNear(x, z, reach + 1.5, (i) => {
      if (!this.alive[i] || this.state[i] === DYING || this.state[i] === SPAWN) return;
      const radius = this.radiusOf(i);
      const dx = this.posX[i] - x;
      const dz = this.posZ[i] - z;
      const dd = dx * dx + dz * dz;
      const rr = reach + radius;
      if (dd > rr * rr) return;
      const ang = Math.atan2(dz, dx);
      if (Math.abs(angleDelta(dirAngle, ang)) < arc * 0.5 + Math.atan2(radius, Math.sqrt(dd) + 0.001)) cb(i);
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
  // Arranque tranquilo que crece con el tiempo hasta un tope seguro:
  //   t=0   → ~8 enemigos como máximo, 1 por oleada cada ~3 s
  //   t=2m  → ~30 vivos, oleadas de 2
  //   t=5m+ → tope de ~85 vivos, oleadas de 4 cada ~1.3 s
  private director(dt: number): void {
    this.elapsed += dt;
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    const aliveCap = Math.min(8 + this.elapsed * 0.26, 85);
    if (this.aliveCount >= aliveCap) {
      this.spawnTimer = 0.6;
      return;
    }
    this.spawnTimer = Math.max(1.3, 3.0 - this.elapsed / 130);

    // candidatos: personajes cargados, distintos del jugador, sin saturar su tipo
    const candidates: number[] = [];
    for (let k = 0; k < CHARACTERS.length; k++) {
      if (k === this.playerCharIdx) continue;
      if (!this.charAssets[k]) continue;
      if (this.perTypeCount[k] >= MAX_SKINNED - 4) continue;
      candidates.push(k);
    }
    if (candidates.length === 0) return;

    let toSpawn = Math.min(1 + Math.floor(this.elapsed / 55), 4);
    while (toSpawn-- > 0 && this.aliveCount < aliveCap) {
      const k = candidates[Math.floor(this.rng() * candidates.length)];
      if (this.perTypeCount[k] >= MAX_SKINNED - 4) continue;
      const pos = this.spawnPos();
      const elite = this.elapsed > 90 && this.rng() < 0.08 ? 1 : 0;
      this.spawn(k, pos.x, pos.z, elite);
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
  update(dt: number): void {
    if (dt <= 0) return;
    this.director(dt);
    this.rebuildHash();
    const p = this.player;

    for (let i = 0; i < MAX_ENEMIES; i++) {
      if (!this.alive[i]) continue;
      const def = CHARACTERS[this.kind[i]];
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
          const speed = this.sSpeed[i] * slowK;
          // los rápidos flanquean un poco en vez de ir en línea recta
          if (def.speed > 8.8 && distP > this.sRange[i] * 2.2) {
            const side = (i % 2 === 0 ? 1 : -1);
            targetVX = (dirX * 0.8 - dirZ * 0.55 * side) * speed;
            targetVZ = (dirZ * 0.8 + dirX * 0.55 * side) * speed;
          } else {
            targetVX = dirX * speed;
            targetVZ = dirZ * speed;
          }
          if (distP < this.sRange[i] + p.radius - 0.2 && p.alive) {
            this.state[i] = WINDUP;
            this.stateT[i] = 0;
            this.aimX[i] = dirX;
            this.aimZ[i] = dirZ;
            this.attackDone[i] = 0;
          }
          break;
        }
        case WINDUP: {
          desiredFacing = Math.atan2(this.aimZ[i], this.aimX[i]);
          if (this.stateT[i] >= this.sWindup[i]) {
            this.state[i] = ATTACK;
            this.stateT[i] = 0;
            // destello del arma al lanzar el golpe
            const c = def.weapon.trail;
            this.vfx.addLight(this.posX[i], 1.2, this.posZ[i], c[0], c[1], c[2], 2.2, 4.5, 0.22);
          }
          break;
        }
        case ATTACK: {
          const asset = this.charAssets[this.kind[i]]!;
          const T = def.weapon.attackTime * 1.35; // swing algo más lento: se lee mejor
          // paso corto hacia delante (sin embestida: el golpe lo da el arma)
          if (this.stateT[i] < T * 0.2) {
            this.velX[i] = this.aimX[i] * this.sSpeed[i] * 1.15;
            this.velZ[i] = this.aimZ[i] * this.sSpeed[i] * 1.15;
          }
          if (!this.attackDone[i] && this.stateT[i] > T * asset.hitFrac) {
            this.attackDone[i] = 1;
            // arco del enemigo contra el jugador
            const ang = Math.atan2(this.aimZ[i], this.aimX[i]);
            const angToP = Math.atan2(dz, dx);
            const inArc = Math.abs(angleDelta(ang, angToP)) < this.sArc[i] * 0.5 + 0.3;
            if (p.alive && inArc && distP < this.sRange[i] + p.radius + 0.3) {
              p.takeDamage(this.sDamage[i], dirX, dirZ);
            }
            // slash visual con el color de su arma
            const c = def.weapon.trail;
            this.renderer.particles.emit({
              x: this.posX[i] + this.aimX[i] * 1.2, y: 1.1, z: this.posZ[i] + this.aimZ[i] * 1.2,
              shape: 0, dirX: this.aimX[i], dirY: 0.05, dirZ: this.aimZ[i], spread: 0.05,
              count: 1, speedMin: 3, speedMax: 3.5, lifeMin: 0.16, lifeMax: 0.18,
              size0: 0.8, size1: 1.5, kind: def.weapon.hitKind,
              r0: c[0] * 1.5, g0: c[1] * 1.5, b0: c[2] * 1.5, drag: 2,
            });
          }
          if (this.stateT[i] > T) {
            this.state[i] = RECOVER;
            this.stateT[i] = 0;
            this.freeTrail(i);
          }
          break;
        }
        case RECOVER: {
          if (this.stateT[i] >= this.sRecover[i]) {
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
          if (this.stateT[i] > 1.1) {
            this.alive[i] = 0;
            this.aliveCount--;
            this.perTypeCount[this.kind[i]]--;
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
          const rr = 1.25;
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

      // integración + knockback
      const accel = 8;
      this.velX[i] += (targetVX - this.velX[i]) * Math.min(1, accel * dt);
      this.velZ[i] += (targetVZ - this.velZ[i]) * Math.min(1, accel * dt);
      this.koX[i] *= Math.max(0, 1 - 7 * dt);
      this.koZ[i] *= Math.max(0, 1 - 7 * dt);
      this.posX[i] += (this.velX[i] + this.koX[i]) * dt;
      this.posZ[i] += (this.velZ[i] + this.koZ[i]) * dt;

      // colisión con mundo y con el cuerpo del jugador
      this.scratch.x = this.posX[i];
      this.scratch.z = this.posZ[i];
      this.world.collide(this.scratch, 0.45);
      if (p.alive && st !== DYING) {
        const bdx = this.scratch.x - p.x;
        const bdz = this.scratch.z - p.z;
        const rr = 0.5 + p.radius;
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

      if (st !== DYING) {
        this.facing[i] = dampAngle(this.facing[i], desiredFacing, st === ATTACK ? 5 : 9, dt);
      }
      const speedNow = Math.hypot(this.velX[i], this.velZ[i]);
      this.animT[i] += dt * (0.3 + speedNow / Math.max(this.sSpeed[i], 0.1) * 0.7);
    }
  }

  /** telegraphs de windup */
  pushTelegraphs(): void {
    for (let i = 0; i < MAX_ENEMIES; i++) {
      if (!this.alive[i] || this.state[i] !== WINDUP) continue;
      const def = CHARACTERS[this.kind[i]];
      const prog = clamp(this.stateT[i] / this.sWindup[i], 0, 1);
      const ang = Math.atan2(this.aimZ[i], this.aimX[i]);
      const c = def.weapon.trail;
      this.renderer.decals.push(
        this.posX[i] + this.aimX[i] * this.sRange[i] * 0.5,
        this.posZ[i] + this.aimZ[i] * this.sRange[i] * 0.5,
        this.sRange[i] * 0.75, ang, DECAL.sector, prog, this.sArc[i] * 0.5, 0.6,
        Math.max(c[0], 0.7), c[1] * 0.55, c[2] * 0.45,
      );
    }
  }

  /** escribe las instancias skinned de los enemigos */
  buildInstances(): void {
    for (let i = 0; i < MAX_ENEMIES; i++) {
      if (!this.alive[i]) continue;
      const asset = this.charAssets[this.kind[i]];
      if (!asset) continue;
      const tp = asset.type;
      // deja hueco para el jugador + fantasmas en su tipo
      if (tp.count >= tp.capacity - 4) continue;
      const def = CHARACTERS[this.kind[i]];
      const st = this.state[i];
      const t = this.stateT[i];

      let dissolve = 0;
      let squash = 1;
      if (st === SPAWN) {
        dissolve = 1 - clamp01(t / 0.55);
      } else if (st === STAGGER) {
        squash = 0.9;
      } else if (st === DYING) {
        dissolve = clamp01((t - 0.35) / 0.75) * 0.98;
      }

      const idx = tp.count++;
      mat4.identity(this.m);
      mat4.translate(this.m, [this.posX[i], 0, this.posZ[i]], this.m);
      mat4.rotateY(this.m, -this.facing[i] + Math.PI * 0.5, this.m);
      const es = this.elite[i] === 1 ? 1.18 : 1;
      const s = asset.worldScale * es;
      mat4.scale(this.m, [s, s * squash, s], this.m);

      // tinte: hostil (ligero rojizo) / élite dorado pulsante
      let tr = 1.0, tg = 0.78, tb = 0.74, em = def.emissive * 0.6;
      if (this.elite[i] === 1) {
        tr = 1.2; tg = 0.95; tb = 0.45;
        em = 0.45 + 0.2 * Math.sin(this.animT[i] * 6);
      }
      if (this.slow[i] > 0) {
        tr *= 1 - this.slow[i] * 0.4; tb *= 1 + this.slow[i] * 0.45;
      }
      writeInstance(tp.raw, idx, this.m, tr, tg, tb, 0, this.flash[i], dissolve, em, 0);

      // animación
      const c = asset.clips;
      const durs = asset.durations;
      let clip = c.walk;
      let ct = 0;
      if (st === ATTACK || st === WINDUP) {
        clip = c.attack;
        // WINDUP = pura anticipación (el clip ANTES de que arranque el swing);
        // ATTACK = la ventana completa del swing a velocidad natural
        const w0 = asset.window[0];
        const w1 = asset.window[1];
        if (st === WINDUP) {
          const k = clamp01(t / this.sWindup[i]);
          const pre = Math.max(0, w0 - 0.22);
          ct = (pre + k * (w0 - pre)) * durs.attack;
          squash = 1 + 0.1 * k; // se estira al armar el golpe
        } else {
          const swingT = clamp01(t / (def.weapon.attackTime * 1.35));
          ct = (w0 + swingT * (w1 - w0)) * durs.attack;
          // trail del arma durante el swing (igual que el jugador)
          if (swingT > 0.04 && swingT < 0.96) {
            const slot = this.trailSlotFor(i);
            if (slot > 0) {
              const w = def.weapon;
              sampleBoneWorld(asset.baked, 'attack', ct, asset.baked.handJoint, this.boneM);
              mat4.multiply(this.m, this.boneM, this.handM);
              sampleBoneWorld(asset.baked, 'attack', ct, asset.baked.handParent, this.boneM);
              mat4.multiply(this.m, this.boneM, this.foreM);
              const bx = this.handM[12];
              const by = this.handM[13];
              const bz = this.handM[14];
              let ddx = bx - this.foreM[12];
              let ddy = by - this.foreM[13];
              let ddz = bz - this.foreM[14];
              const dl = Math.hypot(ddx, ddy, ddz) || 1;
              ddx /= dl; ddy /= dl; ddz /= dl;
              const tr = this.renderer.trails.trails[slot];
              tr.setColor(w.trail[0], w.trail[1], w.trail[2], w.trailGlow * 0.8);
              tr.push(
                bx, Math.max(by, 0.15), bz,
                bx + ddx * w.trailLen, Math.max(by + ddy * w.trailLen, 0.2), bz + ddz * w.trailLen,
              );
            }
          }
        }
      } else if (st === DYING) {
        clip = c.dead;
        ct = Math.min(t, durs.dead - 0.02);
      } else if (st === SPAWN || st === RECOVER || st === STAGGER) {
        clip = c.idle;
        ct = this.animT[i] % durs.idle;
      } else {
        const speedNow = Math.hypot(this.velX[i], this.velZ[i]);
        const running = speedNow > this.sSpeed[i] * 0.7;
        clip = running ? c.run : c.walk;
        const dur = running ? durs.run : durs.walk;
        ct = (this.animT[i] * dur * 0.9) % dur;
      }
      writeAnimState(tp, idx, clip, clip, ct, ct, 0);
    }
  }
}
