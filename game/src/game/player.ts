/**
 * Jugador: movimiento WASD + apuntado con ratón, ataque en arco, ataque
 * pesado cargado con giro 360°, dash con i-frames y afterimages, firmas de
 * arma únicas por personaje, HP con regen y muerte/respawn cinemático.
 */
import { mat4 } from 'wgpu-matrix';
import { clamp, clamp01, dampAngle } from '../core/mathx';
import { CELL } from '../gfx/atlas';
import { DECAL } from '../gfx/decalsPipeline';
import { sampleBoneWorld, type BakedCharacter } from '../gfx/animBake';
import { writeAnimState, type SkinnedType } from '../gfx/skinnedPipeline';
import { writeInstance as writeSkinnedInstance } from '../gfx/staticPipeline';
import type { Input } from '../core/input';
import type { Renderer } from '../gfx/renderer';
import type { GameCamera } from './camera';
import type { CharacterDef } from './defs';
import type { Enemies } from './enemies';
import type { Vfx } from './vfx';
import type { World } from './world';

export interface CharAsset {
  def: CharacterDef;
  type: SkinnedType;
  baked: BakedCharacter;
  clips: { idle: number; walk: number; run: number; attack: number; dead: number };
  durations: { idle: number; walk: number; run: number; attack: number; dead: number };
  worldScale: number;
  /** ventana real del swing dentro del clip de ataque (fracciones 0..1), detectada
   *  analizando la velocidad del hueso de la mano; hitFrac = momento del impacto */
  window: [number, number];
  hitFrac: number;
}

const MODEL_YAW = Math.PI; // corrección de orientación del rig de Meshy

interface Ghost {
  m: Float32Array;
  age: number;
  clipTime: number;
}

interface DelayedHit {
  enemy: number;
  t: number;
  dmg: number;
}

export class Player {
  x = 0;
  z = 8;
  vx = 0;
  vz = 0;
  radius = 0.55;
  yaw = 0;
  hp = 120;
  maxHp = 120;
  alive = true;

  asset!: CharAsset;

  // locomoción / animación
  private locoClip = 0;
  private locoTime = 0;
  private prevClip = 0;
  private prevTime = 0;
  private blend = 0;
  private idlePhase = 0;

  // combate
  attackT = -1;
  private heavyT = -1;
  private heavyCharge = 0;
  private heavyCd = 0;
  private didHit = false;
  private comboFlow = 0;
  private spinYaw = 0;
  private hitBuffer = false;
  private goldenCounter = 0;
  private neonStacks = 0;
  private delayedHits: DelayedHit[] = [];

  // dash
  private dashT = -1;
  private dashCd = 0;
  private dashDirX = 1;
  private dashDirZ = 0;
  iframes = 0;
  private ghosts: Ghost[] = [];

  // vida
  private sinceHurt = 99;
  private deadT = -1;
  private switchDissolve = 0; // 1→0 al aparecer

  private aim = { x: 0, z: 1 };
  private scratch = { x: 0, z: 0 };
  private m = new Float32Array(16);
  private handM = new Float32Array(16);
  private boneM = new Float32Array(16);

  constructor(
    private input: Input,
    private renderer: Renderer,
    private vfx: Vfx,
    private world: World,
    private camera: GameCamera,
  ) {}

  setCharacter(asset: CharAsset, burst: boolean): void {
    this.asset = asset;
    this.locoClip = asset.clips.walk;
    this.prevClip = asset.clips.walk;
    this.locoTime = 0;
    this.blend = 0;
    this.attackT = -1;
    this.heavyT = -1;
    this.switchDissolve = 1;
    if (burst) {
      const c = asset.def.weapon.trail;
      this.vfx.spawnBurst(this.x, this.z, 1.2, c[0], c[1], c[2]);
      this.vfx.shockwave(0.35);
      this.vfx.camera.addShake(0.25);
      this.vfx.addLight(this.x, 1.2, this.z, c[0], c[1], c[2], 5, 8, 0.5);
      this.iframes = Math.max(this.iframes, 0.6);
    }
  }

  takeDamage(dmg: number, dirX: number, dirZ: number): void {
    if (!this.alive || this.iframes > 0 || this.switchDissolve > 0.3) return;
    this.hp -= dmg;
    this.sinceHurt = 0;
    this.iframes = 0.35;
    this.vfx.hurtPulse = 1;
    this.camera.addShake(0.38);
    this.camera.addKick(dirX, dirZ, 0.5);
    this.vx += dirX * 9;
    this.vz += dirZ * 9;
    this.vfx.hitstop(0.03);
    if (this.hp <= 0 && this.alive) {
      this.die();
    }
  }

  private die(): void {
    this.alive = false;
    this.deadT = 0;
    this.vfx.slowmo(1.3, 0.18);
    this.camera.addShake(0.8);
  }

  private respawn(): void {
    this.alive = true;
    this.hp = this.maxHp;
    this.x = 0;
    this.z = 0;
    this.vx = this.vz = 0;
    this.deadT = -1;
    this.iframes = 1.6;
    this.switchDissolve = 1;
    this.vfx.deathFade = 0;
    this.vfx.slam(0, 0, 5, [0.5, 0.9, 1.0], true);
    this.vfx.hitstop(0.04);
    // nova de respawn: empuja a todos los enemigos cercanos
    const en = this.enemies!;
    en.forNear(0, 0, 12, (i) => {
      const dx = en.posX[i];
      const dz = en.posZ[i];
      const dd = Math.hypot(dx, dz) || 1;
      en.damage(i, 30, false, dx / dd, dz / dd, 26, [0.5, 0.9, 1.0], CELL.flare);
    });
  }

  enemies: Enemies | null = null;

  update(dt: number, realDt: number, aimWorld: { x: number; z: number }): void {
    const asset = this.asset;
    const def = asset.def;
    const w = def.weapon;
    const input = this.input;
    const en = this.enemies!;

    this.iframes = Math.max(0, this.iframes - dt);
    this.sinceHurt += dt;
    this.heavyCd -= dt;
    this.dashCd -= dt;
    this.switchDissolve = Math.max(0, this.switchDissolve - realDt * 3.2);
    this.idlePhase += realDt;

    // muerte / respawn
    if (!this.alive) {
      this.deadT += realDt;
      this.vfx.deathFade = clamp01(this.deadT * 1.2);
      if (this.deadT > 2.3) this.respawn();
      this.updateAnim(dt, 0);
      return;
    }

    // regen
    if (this.sinceHurt > 4.5 && this.hp < this.maxHp) {
      this.hp = Math.min(this.maxHp, this.hp + 15 * dt);
      if (Math.random() < dt * 6) {
        this.vfx.sparkleRing(this.x, this.z, 0.35, 1.0, 0.6);
      }
    }

    // apuntado
    const adx = aimWorld.x - this.x;
    const adz = aimWorld.z - this.z;
    const alen = Math.hypot(adx, adz);
    if (alen > 0.2) {
      this.aim.x = adx / alen;
      this.aim.z = adz / alen;
    }
    const aimYaw = Math.atan2(this.aim.z, this.aim.x);

    // movimiento
    const mx = input.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']);
    const mz = input.axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']);
    let mlen = Math.hypot(mx, mz);
    const moveX = mlen > 0 ? mx / mlen : 0;
    const moveZ = mlen > 0 ? mz / mlen : 0;
    const attacking = this.attackT >= 0 || this.heavyT >= 0;
    const speedMax = def.speed * (attacking ? 0.35 : 1);

    // dash
    if ((input.pressed.has('Space') || input.pressed.has('ShiftLeft')) && this.dashCd <= 0) {
      this.dashCd = 0.85;
      this.dashT = 0;
      this.iframes = Math.max(this.iframes, 0.26);
      this.dashDirX = mlen > 0 ? moveX : this.aim.x;
      this.dashDirZ = mlen > 0 ? moveZ : this.aim.z;
      this.vfx.dust(this.x, this.z, this.dashDirX, this.dashDirZ, 12);
      this.camera.addKick(-this.dashDirX, -this.dashDirZ, 0.28);
    }
    if (this.dashT >= 0) {
      this.dashT += dt;
      const k = 1 - clamp01(this.dashT / 0.17);
      this.vx = this.dashDirX * 26 * k + this.vx * (1 - k);
      this.vz = this.dashDirZ * 26 * k + this.vz * (1 - k);
      if (this.dashT > 0.17) this.dashT = -1;
      // afterimages
      if (this.ghosts.length < 3 && Math.floor(this.dashT * 60) % 3 === 0) {
        const g: Ghost = { m: new Float32Array(16), age: 0, clipTime: this.locoTime };
        this.buildModelMatrix(g.m, 1);
        this.ghosts.push(g);
      }
    } else {
      const accel = 42;
      this.vx += (moveX * speedMax - this.vx) * Math.min(1, accel * dt / 4);
      this.vz += (moveZ * speedMax - this.vz) * Math.min(1, accel * dt / 4);
    }
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.scratch.x = this.x;
    this.scratch.z = this.z;
    this.world.collide(this.scratch, this.radius);
    this.x = this.scratch.x;
    this.z = this.scratch.z;

    // polvo al correr
    const speedNow = Math.hypot(this.vx, this.vz);
    if (speedNow > 5 && Math.random() < dt * 9) {
      this.vfx.dust(this.x, this.z, this.vx / speedNow, this.vz / speedNow, 1);
    }

    // orientación: hacia el cursor (combate) con inercia
    this.yaw = dampAngle(this.yaw, aimYaw + this.spinYaw, attacking ? 18 : 11, dt);
    this.spinYaw *= Math.max(0, 1 - dt * 8);

    // ---- ataque ligero ----
    if (input.mouseDown[0] && this.attackT < 0 && this.heavyT < 0) {
      this.startAttack();
    } else if (input.mousePressed[0] && this.attackT >= 0) {
      this.hitBuffer = true;
    }
    if (this.attackT >= 0) {
      const T = w.attackTime;
      const prev = this.attackT;
      this.attackT += dt;
      // impacto (momento real del swing, detectado del clip)
      const hf = this.asset.hitFrac;
      if (!this.didHit && prev < T * hf && this.attackT >= T * hf) {
        this.resolveHits(false, aimYaw);
      }
      // trail activo alrededor del golpe
      this.pushTrail(clamp01(this.attackT / T));
      if (this.attackT >= T) {
        this.attackT = -1;
        if (this.hitBuffer || input.mouseDown[0]) {
          this.hitBuffer = false;
          this.startAttack();
        } else {
          this.renderer.trails.trails[0].clear();
        }
      }
    }

    // ---- ataque pesado ----
    if (input.mousePressed[2] && this.heavyT < 0 && this.attackT < 0 && this.heavyCd <= 0) {
      this.heavyT = 0;
      this.heavyCharge = 0;
      this.didHit = false;
    }
    if (this.heavyT >= 0) {
      const windup = 0.42;
      const swing = w.attackTime * 0.9;
      this.heavyT += dt;
      if (this.heavyT < windup) {
        this.heavyCharge = this.heavyT / windup;
        // partículas de carga que convergen
        if (Math.random() < dt * 40) {
          const c = w.trail;
          this.renderer.particles.emit({
            x: this.x + (Math.random() - 0.5) * 2.4, y: 0.4 + Math.random() * 1.4,
            z: this.z + (Math.random() - 0.5) * 2.4,
            count: 1, speedMin: 0, speedMax: 0.5,
            lifeMin: 0.3, lifeMax: 0.4, size0: 0.12, size1: 0.02,
            kind: CELL.flare, r0: c[0] * 2, g0: c[1] * 2, b0: c[2] * 2,
            attract: true,
          });
        }
      } else if (!this.didHit) {
        // liberación: giro 360 + arco completo
        this.resolveHits(true, aimYaw);
        this.spinYaw = Math.PI * 2;
        this.heavyCd = 2.4;
      }
      this.pushTrail(clamp01((this.heavyT - windup) / swing));
      if (this.heavyT >= windup + swing) {
        this.heavyT = -1;
        this.renderer.trails.trails[0].clear();
      }
    }

    // golpes retardados (bleed)
    for (let i = this.delayedHits.length - 1; i >= 0; i--) {
      const h = this.delayedHits[i];
      h.t -= dt;
      if (h.t <= 0) {
        this.delayedHits.splice(i, 1);
        if (en.alive[h.enemy] && en.state[h.enemy] !== 6) {
          en.damage(h.enemy, h.dmg, false, 0, 0, 0, [1, 0.25, 0.25], CELL.drop);
        }
      }
    }

    // fantasmas del dash
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      this.ghosts[i].age += realDt;
      if (this.ghosts[i].age > 0.26) this.ghosts.splice(i, 1);
    }

    this.updateAnim(dt, speedNow);
  }

  private startAttack(): void {
    this.attackT = 0;
    this.didHit = false;
    this.comboFlow = Math.min(this.comboFlow + 1, 4);
    // micro-lunge hacia el cursor
    this.vx += this.aim.x * 5;
    this.vz += this.aim.z * 5;
    const t = this.renderer.trails.trails[0];
    const w = this.asset.def.weapon;
    t.setColor(w.trail[0], w.trail[1], w.trail[2], w.trailGlow);
  }

  /** aplica el arco de golpe a los enemigos */
  private resolveHits(heavy: boolean, aimYaw: number): void {
    this.didHit = true;
    const en = this.enemies!;
    const w = this.asset.def.weapon;
    const reach = w.reach * (heavy ? 1.5 : 1);
    const arc = heavy ? Math.PI * 2 : w.arc;
    const dmgBase = w.damage * (heavy ? 2.4 : 1);
    let hits = 0;
    let kills0 = en.killCount;
    en.queryArc(this.x, this.z, reach, aimYaw, arc, (i) => {
      hits++;
      const crit = Math.random() < w.critChance;
      const dx = en.posX[i] - this.x;
      const dz = en.posZ[i] - this.z;
      const dd = Math.hypot(dx, dz) || 1;
      const dmg = dmgBase * (crit ? 2.1 : 1) * (0.92 + Math.random() * 0.16);
      en.damage(i, dmg, crit, dx / dd, dz / dd, w.knockback * (heavy ? 2.2 : 1), w.trail, w.hitKind);
      this.applySignature(i, crit, dx / dd, dz / dd);
    });
    if (hits > 0) {
      const kills = en.killCount - kills0;
      this.vfx.hitstop(heavy ? 0.085 : hits > 2 ? 0.06 : 0.042);
      this.camera.addShake(heavy ? 0.55 : 0.16 + hits * 0.04);
      this.camera.addKick(this.aim.x, this.aim.z, heavy ? 0.5 : 0.22);
      if (kills > 0 && this.asset.def.weapon.signature === 'souls') {
        this.hp = Math.min(this.maxHp, this.hp + kills * 3);
      }
    }
    if (heavy) {
      this.vfx.slam(this.x + this.aim.x, this.z + this.aim.z, reach * 0.55, w.trail, true);
      this.renderer.decals.push(this.x, this.z, reach, aimYaw, DECAL.ring, 0.25, 0, 0.9, w.trail[0], w.trail[1], w.trail[2]);
    }
  }

  /** firma única del arma */
  private applySignature(i: number, crit: boolean, dirX: number, dirZ: number): void {
    const en = this.enemies!;
    const w = this.asset.def.weapon;
    const ex = en.posX[i];
    const ez = en.posZ[i];
    switch (w.signature) {
      case 'frost':
        en.applySlow(i);
        break;
      case 'goo':
        en.applySlow(i);
        this.renderer.particles.emit({
          x: ex, y: 0.3, z: ez, shape: 3, count: 6, spread: 0.8,
          speedMin: 1, speedMax: 3, lifeMin: 0.3, lifeMax: 0.7,
          size0: 0.2, size1: 0.05, kind: CELL.drop,
          r0: 0.5, g0: 1.0, b0: 0.3, a0: 0.85, gravity: 8, collide: true,
        });
        break;
      case 'lightning': {
        // cadena al enemigo más cercano de la víctima
        let best = -1;
        let bestD = 36;
        en.forNear(ex, ez, 6, (j) => {
          if (j === i || !en.alive[j] || en.state[j] === 6) return;
          const dd = (en.posX[j] - ex) ** 2 + (en.posZ[j] - ez) ** 2;
          if (dd < bestD) { bestD = dd; best = j; }
        });
        if (best >= 0) {
          const bx = en.posX[best];
          const bz = en.posZ[best];
          const steps = 6;
          for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            this.renderer.particles.emit({
              x: ex + (bx - ex) * t + (Math.random() - 0.5) * 0.5,
              y: 1 + Math.random() * 0.5,
              z: ez + (bz - ez) * t + (Math.random() - 0.5) * 0.5,
              count: 1, speedMin: 0, speedMax: 0.5, lifeMin: 0.12, lifeMax: 0.2,
              size0: 0.2, size1: 0.05, kind: CELL.flare,
              r0: 0.5, g0: 0.9, b0: 1.8,
            });
          }
          en.damage(best, this.asset.def.weapon.damage * 0.45, false, 0, 0, 3, [0.4, 0.8, 1.8], CELL.flare);
        }
        break;
      }
      case 'bleed':
        this.delayedHits.push({ enemy: i, t: 0.45, dmg: this.asset.def.weapon.damage * 0.35 });
        break;
      case 'shards':
        if (crit) {
          this.vfx.slam(ex, ez, 2.2, [0.75, 0.92, 1.0], false);
          en.forNear(ex, ez, 2.6, (j) => {
            if (j === i || !en.alive[j] || en.state[j] === 6) return;
            en.damage(j, this.asset.def.weapon.damage * 0.5, false, (en.posX[j] - ex), (en.posZ[j] - ez), 5, [0.75, 0.92, 1.0], CELL.shard);
          });
        }
        break;
      case 'golden':
        this.goldenCounter++;
        if (this.goldenCounter >= 4) {
          this.goldenCounter = 0;
          en.damage(i, this.asset.def.weapon.damage * 0.8, true, dirX, dirZ, 4, [1.1, 0.9, 0.3], CELL.flare);
          this.vfx.addLight(ex, 1.2, ez, 1.1, 0.85, 0.25, 5, 7, 0.3);
        }
        break;
      case 'neon':
        this.neonStacks++;
        if (this.neonStacks >= 8) {
          this.neonStacks = 0;
          this.vfx.slam(this.x, this.z, 4.2, [1.0, 0.25, 0.95], true);
          en.forNear(this.x, this.z, 4.6, (j) => {
            if (!en.alive[j] || en.state[j] === 6) return;
            const ddx = en.posX[j] - this.x;
            const ddz = en.posZ[j] - this.z;
            const dd = Math.hypot(ddx, ddz) || 1;
            en.damage(j, this.asset.def.weapon.damage * 0.9, false, ddx / dd, ddz / dd, 9, [1, 0.3, 0.95], CELL.flare);
          });
        }
        break;
      case 'flame':
        this.vfx.addGroundMark(DECAL.scorch, ex, ez, 1.1, Math.random() * 6.3, 0.05, 0.03, 0.02, 6);
        this.renderer.particles.emit({
          x: ex, y: 0.6, z: ez, shape: 0, dirY: 1, spread: 0.5, count: 8,
          speedMin: 1, speedMax: 3, lifeMin: 0.25, lifeMax: 0.6,
          size0: 0.3, size1: 0.06, kind: CELL.softCircle,
          r0: 1.6, g0: 0.7, b0: 0.15, gravity: -3, turb: 5,
        });
        break;
      case 'tide':
        en.koX[i] += dirX * 6;
        en.koZ[i] += dirZ * 6;
        break;
      default:
        break;
    }
  }

  private forearmM = new Float32Array(16);

  /** cinta del arma: de la mano hacia fuera, en la dirección antebrazo→mano */
  private pushTrail(swingT: number): void {
    if (swingT <= 0.05 || swingT > 0.95) return;
    const asset = this.asset;
    const w = asset.def.weapon;
    const window = asset.window;
    const clipT = (window[0] + swingT * (window[1] - window[0])) * asset.durations.attack;
    sampleBoneWorld(asset.baked, 'attack', clipT, asset.baked.handJoint, this.boneM);
    this.buildModelMatrix(this.m, 1);
    mat4.multiply(this.m, this.boneM, this.handM);
    sampleBoneWorld(asset.baked, 'attack', clipT, asset.baked.handParent, this.boneM);
    mat4.multiply(this.m, this.boneM, this.forearmM);
    const bx = this.handM[12];
    const by = this.handM[13];
    const bz = this.handM[14];
    let dx = bx - this.forearmM[12];
    let dy = by - this.forearmM[13];
    let dz = bz - this.forearmM[14];
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    const len = w.trailLen;
    this.renderer.trails.trails[0].push(
      bx, Math.max(by, 0.15), bz,
      bx + dx * len, Math.max(by + dy * len, 0.2), bz + dz * len,
    );
  }

  private attackClipName(): string {
    return 'attack';
  }

  // ---------- animación ----------
  private setLoco(clip: number, blendTime: number): void {
    if (this.locoClip === clip) return;
    this.prevClip = this.locoClip;
    this.prevTime = this.locoTime;
    this.locoClip = clip;
    this.locoTime = 0;
    this.blend = 1;
  }

  private updateAnim(dt: number, speedNow: number): void {
    const asset = this.asset;
    const c = asset.clips;
    const d = asset.durations;
    this.blend = Math.max(0, this.blend - dt * 7);

    if (!this.alive) {
      this.setLoco(c.dead, 0.05);
      this.locoTime = Math.min(this.locoTime + dt, d.dead - 0.02);
      return;
    }
    if (this.attackT >= 0 || this.heavyT >= 0) {
      this.setLoco(c.attack, 0.04);
      const w = asset.def.weapon;
      const window = asset.window;
      let swingT: number;
      if (this.heavyT >= 0) {
        const windup = 0.42;
        const swing = w.attackTime * 0.9;
        swingT = this.heavyT < windup
          ? (this.heavyT / windup) * 0.25
          : 0.25 + ((this.heavyT - windup) / swing) * 0.75;
      } else {
        swingT = clamp01(this.attackT / w.attackTime);
      }
      this.locoTime = (window[0] + swingT * (window[1] - window[0])) * d.attack;
      return;
    }
    if (speedNow > 5.2) {
      this.setLoco(c.run, 0.1);
      this.locoTime = (this.locoTime + dt * (speedNow / asset.def.speed)) % d.run;
    } else if (speedNow > 0.6) {
      this.setLoco(c.walk, 0.1);
      this.locoTime = (this.locoTime + dt * (0.5 + speedNow * 0.12)) % d.walk;
    } else {
      // idle: clip propio si existe; si no, walk casi congelado
      if (c.idle !== c.walk) {
        this.setLoco(c.idle, 0.15);
        this.locoTime = (this.locoTime + dt) % d.idle;
      } else {
        this.setLoco(c.walk, 0.15);
        this.locoTime = (this.locoTime + dt * 0.13) % d.walk;
      }
    }
  }

  private buildModelMatrix(out: Float32Array, breathe: number): void {
    const asset = this.asset;
    mat4.identity(out);
    const bob = this.alive && this.attackT < 0 ? Math.sin(this.idlePhase * 2.2) * 0.012 : 0;
    mat4.translate(out, [this.x, bob, this.z], out);
    mat4.rotateY(out, -this.yaw + MODEL_YAW * 0.5, out);
    const s = asset.worldScale;
    const squash = 1 + (breathe ? Math.sin(this.idlePhase * 2.2) * 0.008 : 0);
    mat4.scale(out, [s, s * squash, s], out);
  }

  /** escribe la instancia del jugador (+fantasmas) en su tipo skinned */
  buildInstances(): void {
    const asset = this.asset;
    const tp = asset.type;
    const idx = tp.count++;
    this.buildModelMatrix(this.m, 1);
    const w = this.asset.def.weapon;
    const chargeGlow = this.heavyT >= 0 && this.heavyT < 0.42 ? this.heavyCharge * 1.2 : 0;
    writeSkinnedInstance(
      tp.raw, idx, this.m,
      1, 1, 1, 0,
      this.iframes > 0.05 && this.alive ? 0.25 + 0.2 * Math.sin(this.idlePhase * 40) : 0,
      this.switchDissolve + (this.alive ? 0 : clamp01((this.deadT - 1.2) / 1.1) * 0.9),
      asset.def.emissive + chargeGlow,
      0,
    );
    writeAnimState(tp, idx, this.locoClip, this.prevClip, this.locoTime, this.prevTime, this.blend);

    // fantasmas del dash (instancias al final, dibujadas aditivas)
    for (const g of this.ghosts) {
      const gi = tp.count + tp.ghostCount;
      if (gi >= tp.capacity) break;
      const alpha = 1 - g.age / 0.26;
      writeSkinnedInstance(tp.raw, gi, g.m, w.trail[0], w.trail[1], w.trail[2], 0, 0, 0, 1.5, alpha);
      writeAnimState(tp, gi, this.locoClip, this.locoClip, g.clipTime, g.clipTime, 0);
      tp.ghostCount++;
    }

    // anillo de vida bajo los pies (solo si no está a tope)
    if (this.alive && this.hp < this.maxHp - 1) {
      const frac = clamp01(this.hp / this.maxHp);
      const r = frac > 0.5 ? 0.4 + (1 - frac) : 1.0;
      const g = frac > 0.5 ? 1.0 : frac * 2;
      this.renderer.decals.push(this.x, this.z, this.radius + 0.55, 0, DECAL.hpArc, frac, 0, 0.85, r, g, 0.25);
    }
  }
}
