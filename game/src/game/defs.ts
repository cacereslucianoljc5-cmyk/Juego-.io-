/**
 * Definiciones de los 14 personajes jugables (armas cuerpo a cuerpo con
 * identidad propia) y de los tipos de enemigo.
 */

export interface WeaponDef {
  reach: number;        // alcance del arco (m)
  arc: number;          // apertura del arco (rad)
  attackTime: number;   // duración del ataque (s)
  hitFrac: number;      // momento del impacto dentro del ataque (0..1)
  damage: number;
  knockback: number;
  critChance: number;
  trail: [number, number, number]; // color del trail
  trailGlow: number;
  trailLen: number;     // longitud visual de la hoja
  hitKind: number;      // celda del atlas para partículas de impacto
  hitColor: [number, number, number];
  /** firma de estilo: efecto especial del personaje */
  signature: 'none' | 'frost' | 'lightning' | 'souls' | 'goo' | 'bleed' | 'shards'
    | 'sparks' | 'golden' | 'neon' | 'flame' | 'tide' | 'venom' | 'gears';
}

export interface CharacterDef {
  slug: string;
  name: string;
  speed: number;      // velocidad de movimiento
  scale: number;      // altura objetivo en metros
  tint: [number, number, number];
  emissive: number;   // boost emisivo base (neones)
  weapon: WeaponDef;
  animWindow: [number, number]; // fracción útil del clip de ataque
}

import { CELL } from '../gfx/atlas';

export const CHARACTERS: CharacterDef[] = [
  {
    slug: '01_knife', name: 'Cuchillo', speed: 9.2, scale: 1.85,
    tint: [1, 1, 1], emissive: 0,
    weapon: {
      reach: 2.3, arc: 1.5, attackTime: 0.3, hitFrac: 0.45, damage: 16,
      knockback: 5, critChance: 0.28, trail: [0.9, 0.95, 1.0], trailGlow: 1.2,
      trailLen: 0.9, hitKind: CELL.spark, hitColor: [1, 0.9, 0.6], signature: 'sparks',
    },
    animWindow: [0.12, 0.55],
  },
  {
    slug: '02_cowboy_sword', name: 'Machete', speed: 8.4, scale: 1.9,
    tint: [1, 1, 1], emissive: 0,
    weapon: {
      reach: 2.9, arc: 2.3, attackTime: 0.48, hitFrac: 0.5, damage: 26,
      knockback: 8, critChance: 0.12, trail: [1.0, 0.62, 0.2], trailGlow: 1.0,
      trailLen: 1.25, hitKind: CELL.slash, hitColor: [1, 0.7, 0.35], signature: 'flame',
    },
    animWindow: [0.2, 0.72],
  },
  {
    slug: '03_cowboy_pirate_sword', name: 'Sable', speed: 8.7, scale: 1.9,
    tint: [1, 1, 1], emissive: 0,
    weapon: {
      reach: 2.8, arc: 2.0, attackTime: 0.42, hitFrac: 0.48, damage: 22,
      knockback: 7, critChance: 0.16, trail: [1.0, 0.85, 0.4], trailGlow: 1.0,
      trailLen: 1.2, hitKind: CELL.slash, hitColor: [1, 0.85, 0.5], signature: 'golden',
    },
    animWindow: [0.18, 0.66],
  },
  {
    slug: '04_pirate_cutlass', name: 'Alfanje', speed: 8.5, scale: 1.9,
    tint: [1, 1, 1], emissive: 0,
    weapon: {
      reach: 2.9, arc: 2.1, attackTime: 0.52, hitFrac: 0.52, damage: 28,
      knockback: 9, critChance: 0.14, trail: [0.35, 0.8, 1.0], trailGlow: 1.1,
      trailLen: 1.25, hitKind: CELL.slash, hitColor: [0.5, 0.85, 1], signature: 'tide',
    },
    animWindow: [0.22, 0.74],
  },
  {
    slug: '05_astronaut_wrench', name: 'Llave Inglesa', speed: 8.0, scale: 1.95,
    tint: [1, 1, 1], emissive: 0.15,
    weapon: {
      reach: 2.6, arc: 1.9, attackTime: 0.56, hitFrac: 0.5, damage: 32,
      knockback: 12, critChance: 0.18, trail: [1.0, 0.75, 0.25], trailGlow: 1.1,
      trailLen: 1.1, hitKind: CELL.spark, hitColor: [1, 0.8, 0.3], signature: 'gears',
    },
    animWindow: [0.2, 0.7],
  },
  {
    slug: '06_robot_baton', name: 'Bastón Energético', speed: 8.8, scale: 1.95,
    tint: [1, 1, 1], emissive: 0.55,
    weapon: {
      reach: 2.7, arc: 1.8, attackTime: 0.4, hitFrac: 0.44, damage: 20,
      knockback: 6, critChance: 0.15, trail: [0.3, 0.9, 1.0], trailGlow: 1.6,
      trailLen: 1.2, hitKind: CELL.flare, hitColor: [0.4, 0.9, 1], signature: 'lightning',
    },
    animWindow: [0.14, 0.6],
  },
  {
    slug: '07_reaper_scythe', name: 'Guadaña', speed: 8.2, scale: 2.0,
    tint: [1, 1, 1], emissive: 0.25,
    weapon: {
      reach: 3.6, arc: 2.7, attackTime: 0.62, hitFrac: 0.52, damage: 34,
      knockback: 9, critChance: 0.2, trail: [0.55, 1.0, 0.5], trailGlow: 1.5,
      trailLen: 1.6, hitKind: CELL.slash, hitColor: [0.6, 1, 0.55], signature: 'souls',
    },
    animWindow: [0.22, 0.75],
  },
  {
    slug: '08_king_scepter', name: 'Cetro Real', speed: 8.0, scale: 1.95,
    tint: [1, 1, 1], emissive: 0.3,
    weapon: {
      reach: 2.8, arc: 2.0, attackTime: 0.58, hitFrac: 0.5, damage: 30,
      knockback: 10, critChance: 0.15, trail: [1.0, 0.85, 0.3], trailGlow: 1.5,
      trailLen: 1.15, hitKind: CELL.flare, hitColor: [1, 0.9, 0.4], signature: 'golden',
    },
    animWindow: [0.2, 0.72],
  },
  {
    slug: '09_agent_gun', name: 'Bastón Táctico', speed: 9.4, scale: 1.88,
    tint: [1, 1, 1], emissive: 0,
    weapon: {
      reach: 2.2, arc: 1.4, attackTime: 0.3, hitFrac: 0.42, damage: 15,
      knockback: 4, critChance: 0.32, trail: [0.85, 0.85, 0.9], trailGlow: 0.9,
      trailLen: 0.85, hitKind: CELL.spark, hitColor: [1, 1, 0.8], signature: 'sparks',
    },
    animWindow: [0.12, 0.5],
  },
  {
    slug: '10_ice_sword', name: 'Lanza de Hielo', speed: 8.3, scale: 2.0,
    tint: [1, 1, 1], emissive: 0.4,
    weapon: {
      reach: 3.1, arc: 1.9, attackTime: 0.5, hitFrac: 0.48, damage: 24,
      knockback: 7, critChance: 0.15, trail: [0.5, 0.85, 1.0], trailGlow: 1.6,
      trailLen: 1.35, hitKind: CELL.shard, hitColor: [0.6, 0.9, 1], signature: 'frost',
    },
    animWindow: [0.18, 0.68],
  },
  {
    slug: '11_slime_mace', name: 'Maza Espinada', speed: 7.8, scale: 1.95,
    tint: [1, 1, 1], emissive: 0.2,
    weapon: {
      reach: 2.7, arc: 2.0, attackTime: 0.66, hitFrac: 0.52, damage: 38,
      knockback: 13, critChance: 0.1, trail: [0.5, 1.0, 0.3], trailGlow: 1.2,
      trailLen: 1.15, hitKind: CELL.drop, hitColor: [0.55, 1, 0.35], signature: 'goo',
    },
    animWindow: [0.22, 0.74],
  },
  {
    slug: '14_shark_katana', name: 'Hoja Dentada', speed: 8.9, scale: 1.95,
    tint: [1, 1, 1], emissive: 0.1,
    weapon: {
      reach: 3.0, arc: 2.0, attackTime: 0.44, hitFrac: 0.46, damage: 24,
      knockback: 6, critChance: 0.22, trail: [0.9, 0.25, 0.3], trailGlow: 1.2,
      trailLen: 1.35, hitKind: CELL.drop, hitColor: [1, 0.3, 0.3], signature: 'bleed',
    },
    animWindow: [0.16, 0.62],
  },
  {
    slug: '15_gamer_katana', name: 'Katana Neón', speed: 9.0, scale: 1.9,
    tint: [1, 1, 1], emissive: 0.65,
    weapon: {
      reach: 3.0, arc: 2.1, attackTime: 0.4, hitFrac: 0.45, damage: 21,
      knockback: 6, critChance: 0.2, trail: [1.0, 0.2, 0.9], trailGlow: 2.0,
      trailLen: 1.4, hitKind: CELL.flare, hitColor: [1, 0.3, 0.95], signature: 'neon',
    },
    animWindow: [0.14, 0.6],
  },
  {
    slug: '17_diamond_mace', name: 'Maza Cristalina', speed: 7.6, scale: 2.05,
    tint: [1, 1, 1], emissive: 0.45,
    weapon: {
      reach: 2.8, arc: 2.1, attackTime: 0.7, hitFrac: 0.54, damage: 42,
      knockback: 14, critChance: 0.12, trail: [0.7, 0.9, 1.0], trailGlow: 1.7,
      trailLen: 1.2, hitKind: CELL.shard, hitColor: [0.8, 0.95, 1], signature: 'shards',
    },
    animWindow: [0.24, 0.76],
  },
];

// ---------- enemigos: los otros 13 personajes ----------

/** Stats de un personaje cuando actúa como enemigo (derivadas de su arma). */
export interface EnemyStats {
  hp: number;
  speed: number;
  damage: number;
  attackRange: number;
  arc: number;
  windup: number;
  recover: number;
  radius: number;
}

export function enemyStatsFor(def: CharacterDef, elapsed: number): EnemyStats {
  const w = def.weapon;
  return {
    hp: (46 + w.damage * 2.6) * (1 + elapsed / 210),
    speed: def.speed * 0.6,
    damage: Math.round(w.damage * 0.45),
    attackRange: w.reach * 0.95,
    arc: w.arc,
    windup: 0.55,
    recover: 0.55 + w.attackTime * 0.5,
    radius: 0.55,
  };
}
