/**
 * Cámara cenital inclinada estilo .io: seguimiento suave con anticipación,
 * sesgo hacia el cursor, zoom dinámico, screen shake por trauma y kick de
 * impacto. También produce la matriz del shadow map y el ray de apuntado.
 */
import { mat4, vec3 } from 'wgpu-matrix';
import { clamp, damp, shakeNoise } from '../core/mathx';
import type { Gfx } from '../gfx/gpu';

const PITCH = 0.96; // rad desde la horizontal (~55°)
const FOV = 40 * (Math.PI / 180);

export class GameCamera {
  x = 0;
  z = 6;
  zoomBase = 26;
  zoomExtra = 0;
  zoomUser = 0;
  trauma = 0;
  kickX = 0;
  kickZ = 0;
  time = 0;

  // scratch
  private eye = new Float32Array(3);
  private target = new Float32Array(3);
  private up = new Float32Array([0, 1, 0]);
  private view = new Float32Array(16);
  private proj = new Float32Array(16);
  private vp = new Float32Array(16);
  private invVp = new Float32Array(16);
  private shadowView = new Float32Array(16);
  private shadowProj = new Float32Array(16);
  private sunDir = new Float32Array([0.45, 0.78, 0.32]);

  constructor() {
    vec3.normalize(this.sunDir, this.sunDir);
  }

  addShake(amount: number): void {
    this.trauma = Math.min(1.2, this.trauma + amount);
  }

  /** kick direccional al golpear (retroceso de cámara) */
  addKick(dx: number, dz: number, power: number): void {
    this.kickX += dx * power;
    this.kickZ += dz * power;
  }

  update(
    dt: number, realDt: number,
    px: number, pz: number, pvx: number, pvz: number,
    aimX: number, aimZ: number,
    intensity: number, // 0..1 densidad de combate → zoom out
  ): void {
    this.time += realDt;
    // objetivo: jugador + anticipación de velocidad + sesgo al cursor
    const tx = px + pvx * 0.32 + (aimX - px) * 0.14;
    const tz = pz + pvz * 0.32 + (aimZ - pz) * 0.14;
    this.x = damp(this.x, tx, 6.5, realDt);
    this.z = damp(this.z, tz, 6.5, realDt);
    this.zoomExtra = damp(this.zoomExtra, intensity * 6, 2.2, realDt);
    this.trauma = Math.max(0, this.trauma - realDt * 1.6);
    this.kickX = damp(this.kickX, 0, 11, realDt);
    this.kickZ = damp(this.kickZ, 0, 11, realDt);
  }

  zoomWheel(steps: number): void {
    this.zoomUser = clamp(this.zoomUser + steps * 2, -6, 8);
  }

  /** Vuelca matrices y vectores de cámara + sombra al uniforme de escena. */
  writeScene(gfx: Gfx): void {
    const dist = this.zoomBase + this.zoomExtra + this.zoomUser;
    const sh = this.trauma * this.trauma;
    const shx = shakeNoise(this.time * 1.7, 1) * sh * 0.55;
    const shz = shakeNoise(this.time * 1.7, 7) * sh * 0.55;
    const shy = shakeNoise(this.time * 1.7, 13) * sh * 0.35;

    const cx = this.x + shx + this.kickX;
    const cz = this.z + shz + this.kickZ;
    const cy = Math.sin(PITCH) * dist;
    const back = Math.cos(PITCH) * dist;

    this.eye[0] = cx; this.eye[1] = cy + shy; this.eye[2] = cz - back;
    this.target[0] = cx; this.target[1] = 0.9; this.target[2] = cz + 2.2;
    // roll sutil del shake
    const roll = shakeNoise(this.time * 1.9, 23) * sh * 0.03;
    this.up[0] = Math.sin(roll); this.up[1] = Math.cos(roll); this.up[2] = 0;

    mat4.lookAt(this.eye, this.target, this.up, this.view);
    const aspect = gfx.width / gfx.height;
    mat4.perspective(FOV, aspect, 2, 220, this.proj);
    mat4.multiply(this.proj, this.view, this.vp);
    mat4.invert(this.vp, this.invVp);

    gfx.viewProj.set(this.vp);
    gfx.camPosTime[0] = this.eye[0]; gfx.camPosTime[1] = this.eye[1]; gfx.camPosTime[2] = this.eye[2];
    // right/up/fwd de cámara para billboards
    const fwd = [this.target[0] - this.eye[0], this.target[1] - this.eye[1], this.target[2] - this.eye[2]];
    vec3.normalize(fwd, fwd);
    const right = vec3.cross(fwd, this.up);
    vec3.normalize(right, right);
    const upv = vec3.cross(right, fwd);
    gfx.camRightAspect[0] = right[0]; gfx.camRightAspect[1] = right[1]; gfx.camRightAspect[2] = right[2];
    gfx.camRightAspect[3] = aspect;
    gfx.camUpShockR[0] = upv[0]; gfx.camUpShockR[1] = upv[1]; gfx.camUpShockR[2] = upv[2];
    gfx.camFwdShockAmp[0] = fwd[0]; gfx.camFwdShockAmp[1] = fwd[1]; gfx.camFwdShockAmp[2] = fwd[2];

    // sol
    gfx.sunDirHurt[0] = this.sunDir[0]; gfx.sunDirHurt[1] = this.sunDir[1]; gfx.sunDirHurt[2] = this.sunDir[2];

    // shadow map orto alrededor del jugador
    const ext = 34;
    const sunEye = [this.x + this.sunDir[0] * 50, this.sunDir[1] * 50, this.z + this.sunDir[2] * 50];
    mat4.lookAt(sunEye, [this.x, 0, this.z], [0, 1, 0], this.shadowView);
    mat4.ortho(-ext, ext, -ext, ext, 6, 110, this.shadowProj);
    mat4.multiply(this.shadowProj, this.shadowView, gfx.shadowVP);
  }

  /** Proyecta el cursor (px de pantalla) al plano del suelo y=0. */
  cursorToGround(gfx: Gfx, mx: number, my: number, out: { x: number; z: number }): void {
    const ndcX = (mx / gfx.canvas.clientWidth) * 2 - 1;
    const ndcY = 1 - (my / gfx.canvas.clientHeight) * 2;
    const near = vec3.transformMat4([ndcX, ndcY, 0], this.invVp);
    const far = vec3.transformMat4([ndcX, ndcY, 1], this.invVp);
    const dy = far[1] - near[1];
    const t = Math.abs(dy) < 1e-6 ? 0 : -near[1] / dy;
    out.x = near[0] + (far[0] - near[0]) * t;
    out.z = near[2] + (far[2] - near[2]) * t;
  }
}
