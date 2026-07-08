/**
 * Orquestador de efectos: presets de partículas por evento de combate,
 * pool de luces puntuales, shockwaves de pantalla, hit-stop y pulso de daño.
 */
import { CELL } from '../gfx/atlas';
import { MAX_LIGHTS } from '../gfx/gpu';
import type { Gfx } from '../gfx/gpu';
import type { Renderer } from '../gfx/renderer';
import type { GameCamera } from './camera';

interface Light {
  x: number; y: number; z: number;
  r: number; g: number; b: number;
  radius: number; intensity: number;
  t: number; life: number;
}

export class Vfx {
  gfx: Gfx;
  renderer: Renderer;
  camera: GameCamera;
  private lights: Light[] = [];
  private shockT = 99;
  private shockLife = 0.5;
  private shockAmp = 0;
  hurtPulse = 0;
  hitstopT = 0;
  slowmoT = 0;
  slowmoScale = 1;
  wallPulse = 0;
  deathFade = 0;

  private marks: { type: number; x: number; z: number; size: number; rot: number; r: number; g: number; b: number; t: number; ttl: number }[] = [];

  constructor(gfx: Gfx, renderer: Renderer, camera: GameCamera) {
    this.gfx = gfx;
    this.renderer = renderer;
    this.camera = camera;
  }

  /** marca persistente en el suelo (quemaduras, charcos) */
  addGroundMark(type: number, x: number, z: number, size: number, rot: number, r: number, g: number, b: number, ttl: number): void {
    if (this.marks.length > 36) this.marks.shift();
    this.marks.push({ type, x, z, size, rot, r, g, b, t: 0, ttl });
  }

  /** vuelca las marcas persistentes a los decals de este frame */
  pushMarks(): void {
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const mk = this.marks[i];
      if (mk.t >= mk.ttl) {
        this.marks.splice(i, 1);
        continue;
      }
      const fade = Math.min(1, (mk.ttl - mk.t) / 1.5);
      this.renderer.decals.push(mk.x, mk.z, mk.size, mk.rot, mk.type, 1, 0, 0.6 * fade, mk.r, mk.g, mk.b);
    }
  }

  /** escala de tiempo de simulación actual (hit-stop + slow-mo) */
  timeScale(): number {
    if (this.hitstopT > 0) return 0.06;
    return this.slowmoT > 0 ? this.slowmoScale : 1;
  }

  hitstop(seconds: number): void {
    this.hitstopT = Math.max(this.hitstopT, seconds);
  }

  slowmo(seconds: number, scale: number): void {
    this.slowmoT = Math.max(this.slowmoT, seconds);
    this.slowmoScale = scale;
  }

  addLight(x: number, y: number, z: number, r: number, g: number, b: number, intensity: number, radius: number, life: number): void {
    if (this.lights.length >= MAX_LIGHTS) this.lights.shift();
    this.lights.push({ x, y, z, r, g, b, radius, intensity, t: 0, life });
  }

  shockwave(amp: number): void {
    this.shockT = 0;
    this.shockAmp = amp;
    this.shockLife = 0.55;
  }

  update(realDt: number): void {
    for (const mk of this.marks) mk.t += realDt;
    this.hitstopT = Math.max(0, this.hitstopT - realDt);
    this.slowmoT = Math.max(0, this.slowmoT - realDt);
    this.hurtPulse = Math.max(0, this.hurtPulse - realDt * 1.8);
    this.wallPulse = Math.max(0, this.wallPulse - realDt * 2.2);
    this.shockT += realDt;

    // luces
    const raw = this.gfx.lightsRaw;
    let n = 0;
    for (let i = this.lights.length - 1; i >= 0; i--) {
      const l = this.lights[i];
      l.t += realDt;
      if (l.t >= l.life) {
        this.lights.splice(i, 1);
        continue;
      }
    }
    for (const l of this.lights) {
      if (n >= MAX_LIGHTS) break;
      const k = 1 - l.t / l.life;
      const o = n * 8;
      raw[o] = l.x; raw[o + 1] = l.y; raw[o + 2] = l.z; raw[o + 3] = l.radius;
      raw[o + 4] = l.r; raw[o + 5] = l.g; raw[o + 6] = l.b; raw[o + 7] = l.intensity * k * k;
      n++;
    }
    this.gfx.sunColorLights[3] = n;

    // parámetros post en el uniforme de escena
    const shockK = Math.min(1, this.shockT / this.shockLife);
    this.gfx.camUpShockR[3] = shockK * 0.75;
    this.gfx.camFwdShockAmp[3] = this.shockT < this.shockLife ? this.shockAmp * (1 - shockK) : 0;
    this.gfx.sunDirHurt[3] = Math.min(1, this.hurtPulse);
    this.gfx.ambientSky[3] = this.wallPulse;
    this.gfx.ambientGround[3] = this.deathFade;
  }

  // ---------- presets ----------

  /** impacto de arma sobre un enemigo */
  hitImpact(x: number, y: number, z: number, dirX: number, dirZ: number, color: [number, number, number], kind: number, crit: boolean): void {
    const p = this.renderer.particles;
    // chispas direccionales
    p.emit({
      x, y, z, shape: 0, dirX, dirY: 0.45, dirZ, spread: 0.45,
      count: crit ? 26 : 14, speedMin: 6, speedMax: crit ? 17 : 12,
      lifeMin: 0.16, lifeMax: 0.42, size0: 0.16, size1: 0.02,
      kind: CELL.spark, r0: color[0] * 1.6, g0: color[1] * 1.6, b0: color[2] * 1.6,
      gravity: 16, drag: 1.2, align: true, stretch: 2.4, collide: true,
    });
    // flash del golpe
    p.emit({
      x, y, z, shape: 0, count: 1, speedMin: 0, speedMax: 0,
      lifeMin: 0.11, lifeMax: 0.11, size0: crit ? 1.2 : 0.75, size1: 0.15,
      kind: CELL.flare, r0: 1.0, g0: 0.95, b0: 0.85,
    });
    // arco del slash
    p.emit({
      x, y: y + 0.1, z, shape: 0, dirX, dirY: 0.1, dirZ, spread: 0.05,
      count: 1, speedMin: 3.5, speedMax: 4, lifeMin: 0.18, lifeMax: 0.2,
      size0: 0.9, size1: 1.7, kind, r0: color[0] * 1.8, g0: color[1] * 1.8, b0: color[2] * 1.8,
      drag: 2,
    });
    this.addLight(x, y, z, color[0], color[1], color[2], crit ? 5 : 2.6, 6.5, 0.18);
  }

  /** muerte de enemigo: explosión + alma que vuela al jugador */
  enemyDeath(x: number, y: number, z: number, scale: number, color: [number, number, number]): void {
    const p = this.renderer.particles;
    p.emit({
      x, y, z, shape: 1, count: Math.round(16 * scale), radius: 0.3 * scale,
      speedMin: 3, speedMax: 8 * scale, upBias: 2.5,
      lifeMin: 0.3, lifeMax: 0.8, size0: 0.22 * scale, size1: 0.03,
      kind: CELL.softCircle, r0: color[0], g0: color[1], b0: color[2],
      gravity: 9, drag: 0.8, collide: true,
    });
    p.emit({
      x, y: 0.06, z, shape: 2, count: 10, radius: 0.35 * scale,
      speedMin: 4, speedMax: 7, lifeMin: 0.28, lifeMax: 0.5,
      size0: 0.34 * scale, size1: 0.5 * scale, kind: CELL.smoke,
      r0: 0.35, g0: 0.32, b0: 0.3, a0: 0.55, a1: 0, drag: 3,
    });
    // almas al jugador
    p.emit({
      x, y: y + 0.4, z, shape: 1, count: Math.round(3 * scale), radius: 0.2,
      speedMin: 2, speedMax: 5, upBias: 4,
      lifeMin: 1.6, lifeMax: 2.2, size0: 0.2, size1: 0.09,
      kind: CELL.softCircle, r0: 0.5, g0: 1.6, b0: 1.2,
      drag: 0.5, attract: true, turb: 6,
    });
    this.addLight(x, 1, z, color[0], color[1], color[2], 3.2 * scale, 7 * scale, 0.32);
  }

  /** polvo de pasos / dash */
  dust(x: number, z: number, dirX: number, dirZ: number, amount: number): void {
    this.renderer.particles.emit({
      x, y: 0.12, z, shape: 0, dirX: -dirX, dirY: 0.4, dirZ: -dirZ, spread: 0.55,
      count: amount, speedMin: 1.2, speedMax: 3.2,
      lifeMin: 0.3, lifeMax: 0.7, size0: 0.3, size1: 0.75,
      kind: CELL.smoke, r0: 0.5, g0: 0.46, b0: 0.4, a0: 0.4, a1: 0,
      gravity: -0.4, drag: 2.4, rotVel: 3,
    });
  }

  /** golpe de área contra el suelo (slam del gigante, heavy del jugador) */
  slam(x: number, z: number, radius: number, color: [number, number, number], big: boolean): void {
    const p = this.renderer.particles;
    p.emit({
      x, y: 0.15, z, shape: 2, count: big ? 48 : 26, radius: radius * 0.35,
      speedMin: radius * 2.2, speedMax: radius * 3.4, upBias: 1,
      lifeMin: 0.25, lifeMax: 0.6, size0: 0.34, size1: 0.05,
      kind: CELL.spark, r0: color[0] * 1.7, g0: color[1] * 1.7, b0: color[2] * 1.7,
      gravity: 10, drag: 1.6, align: true, stretch: 1.6, collide: true,
    });
    p.emit({
      x, y: 0.1, z, shape: 2, count: big ? 30 : 16, radius: radius * 0.3,
      speedMin: 5, speedMax: 9, lifeMin: 0.4, lifeMax: 1.0,
      size0: 0.55, size1: 1.5, kind: CELL.smoke,
      r0: 0.45, g0: 0.4, b0: 0.34, a0: 0.5, a1: 0, drag: 2.8, rotVel: 2,
    });
    if (big) {
      p.emit({
        x, y: 0.4, z, shape: 3, count: 22, spread: 0.7,
        speedMin: 6, speedMax: 14, lifeMin: 0.5, lifeMax: 1.1,
        size0: 0.3, size1: 0.06, kind: CELL.shard,
        r0: 0.6, g0: 0.55, b0: 0.5, a0: 1, a1: 1,
        gravity: 22, drag: 0.3, collide: true, rotVel: 9,
      });
    }
    this.addLight(x, 0.8, z, color[0], color[1], color[2], big ? 7 : 3.5, radius * 3, 0.3);
    this.camera.addShake(big ? 0.75 : 0.4);
    if (big) this.shockwave(0.9);
  }

  /** aparición con dissolve (spawn de enemigos/boss, cambio de personaje) */
  spawnBurst(x: number, z: number, scale: number, r: number, g: number, b: number): void {
    this.renderer.particles.emit({
      x, y: 0.2, z, shape: 2, count: Math.round(14 * scale), radius: 0.5 * scale,
      speedMin: 1.5, speedMax: 3.5, upBias: 3,
      lifeMin: 0.4, lifeMax: 0.9, size0: 0.2, size1: 0.05,
      kind: CELL.softCircle, r0: r, g0: g, b0: b, drag: 1, turb: 4,
    });
    this.addLight(x, 1, z, r, g, b, 2.5 * scale, 5 * scale, 0.4);
  }

  /** ráfaga curativa/pickup */
  sparkleRing(x: number, z: number, r: number, g: number, b: number): void {
    this.renderer.particles.emit({
      x, y: 0.3, z, shape: 2, count: 18, radius: 0.7,
      speedMin: 0.5, speedMax: 1.4, upBias: 3.2,
      lifeMin: 0.5, lifeMax: 1.0, size0: 0.16, size1: 0.03,
      kind: CELL.flare, r0: r, g0: g, b0: b, drag: 0.6,
    });
  }
}
