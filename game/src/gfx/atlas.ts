/**
 * Atlas procedural 8×8 (512×512) para partículas, dígitos de daño y glifos.
 * Se genera en un canvas al arrancar: cero descargas, una sola textura.
 */
export const ATLAS_GRID = 8;

export const CELL = {
  softCircle: 0,
  hardCircle: 1,
  spark: 2,
  smoke: 3,
  ring: 4,
  flare: 5,
  shard: 6,
  slash: 7,
  digit0: 8, // 8..17 = dígitos 0-9
  crit: 18,  // estrella de crítico
  drop: 19,  // gota
} as const;

export function buildAtlas(): HTMLCanvasElement {
  const size = 512;
  const cs = size / ATLAS_GRID; // 64
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.clearRect(0, 0, size, size);

  const cellRect = (idx: number): [number, number] => [(idx % ATLAS_GRID) * cs, Math.floor(idx / ATLAS_GRID) * cs];

  const inCell = (idx: number, fn: (g: CanvasRenderingContext2D, s: number) => void) => {
    const [x, y] = cellRect(idx);
    g.save();
    g.translate(x, y);
    g.beginPath();
    g.rect(0, 0, cs, cs);
    g.clip();
    fn(g, cs);
    g.restore();
  };

  // círculo suave
  inCell(CELL.softCircle, (g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.35, 'rgba(255,255,255,0.65)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  });
  // círculo duro
  inCell(CELL.hardCircle, (g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.72, 'rgba(255,255,255,1)');
    r.addColorStop(0.85, 'rgba(255,255,255,0.4)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  });
  // chispa alargada
  inCell(CELL.spark, (g, s) => {
    const r = g.createLinearGradient(0, s / 2, s, s / 2);
    r.addColorStop(0, 'rgba(255,255,255,0)');
    r.addColorStop(0.5, 'rgba(255,255,255,1)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.beginPath();
    g.ellipse(s / 2, s / 2, s * 0.48, s * 0.08, 0, 0, Math.PI * 2);
    g.fill();
    const r2 = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s * 0.12);
    r2.addColorStop(0, 'rgba(255,255,255,1)');
    r2.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r2;
    g.fillRect(0, 0, s, s);
  });
  // humo: blobs superpuestos
  inCell(CELL.smoke, (g, s) => {
    const blobs = [[0.5, 0.52, 0.34], [0.36, 0.42, 0.22], [0.66, 0.4, 0.2], [0.45, 0.66, 0.24], [0.62, 0.62, 0.2]];
    for (const [bx, by, br] of blobs) {
      const r = g.createRadialGradient(bx * s, by * s, 0, bx * s, by * s, br * s);
      r.addColorStop(0, 'rgba(255,255,255,0.45)');
      r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r;
      g.fillRect(0, 0, s, s);
    }
  });
  // anillo
  inCell(CELL.ring, (g, s) => {
    g.strokeStyle = 'rgba(255,255,255,1)';
    g.lineWidth = s * 0.09;
    g.shadowColor = 'rgba(255,255,255,0.8)';
    g.shadowBlur = s * 0.1;
    g.beginPath();
    g.arc(s / 2, s / 2, s * 0.36, 0, Math.PI * 2);
    g.stroke();
  });
  // destello en cruz
  inCell(CELL.flare, (g, s) => {
    for (const rot of [0, Math.PI / 2]) {
      g.save();
      g.translate(s / 2, s / 2);
      g.rotate(rot);
      const r = g.createLinearGradient(-s / 2, 0, s / 2, 0);
      r.addColorStop(0, 'rgba(255,255,255,0)');
      r.addColorStop(0.5, 'rgba(255,255,255,1)');
      r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r;
      g.beginPath();
      g.ellipse(0, 0, s * 0.5, s * 0.05, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
    const r2 = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s * 0.16);
    r2.addColorStop(0, 'rgba(255,255,255,1)');
    r2.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r2;
    g.fillRect(0, 0, s, s);
  });
  // esquirla triangular
  inCell(CELL.shard, (g, s) => {
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.beginPath();
    g.moveTo(s * 0.5, s * 0.08);
    g.lineTo(s * 0.72, s * 0.62);
    g.lineTo(s * 0.5, s * 0.92);
    g.lineTo(s * 0.28, s * 0.62);
    g.closePath();
    g.fill();
  });
  // arco de slash (media luna)
  inCell(CELL.slash, (g, s) => {
    g.strokeStyle = 'rgba(255,255,255,1)';
    g.lineCap = 'round';
    g.lineWidth = s * 0.13;
    g.shadowColor = 'rgba(255,255,255,0.9)';
    g.shadowBlur = s * 0.12;
    g.beginPath();
    g.arc(s / 2, s * 0.95, s * 0.62, Math.PI * 1.18, Math.PI * 1.82);
    g.stroke();
  });
  // dígitos 0-9
  for (let dg = 0; dg <= 9; dg++) {
    inCell(CELL.digit0 + dg, (g, s) => {
      g.font = `900 ${s * 0.82}px "Arial Black", system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = s * 0.14;
      g.strokeStyle = 'rgba(0,0,0,0.9)';
      g.strokeText(String(dg), s / 2, s * 0.56);
      g.fillStyle = 'rgba(255,255,255,1)';
      g.fillText(String(dg), s / 2, s * 0.56);
    });
  }
  // estrella de crítico
  inCell(CELL.crit, (g, s) => {
    g.fillStyle = 'rgba(255,255,255,1)';
    g.shadowColor = 'rgba(255,255,255,0.9)';
    g.shadowBlur = s * 0.1;
    g.beginPath();
    const spikes = 4;
    for (let i = 0; i < spikes * 2; i++) {
      const r = i % 2 === 0 ? s * 0.46 : s * 0.14;
      const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
      const x = s / 2 + Math.cos(a) * r;
      const y = s / 2 + Math.sin(a) * r;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    g.fill();
  });
  // gota
  inCell(CELL.drop, (g, s) => {
    const r = g.createRadialGradient(s / 2, s * 0.6, 0, s / 2, s * 0.6, s * 0.34);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.7, 'rgba(255,255,255,0.9)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.beginPath();
    g.ellipse(s / 2, s * 0.6, s * 0.22, s * 0.3, 0, 0, Math.PI * 2);
    g.fill();
  });

  return canvas;
}
