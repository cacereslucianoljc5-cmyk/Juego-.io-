/** Estado de teclado y ratón. Sin UI: solo captura eventos crudos. */
export class Input {
  keys = new Set<string>();
  pressed = new Set<string>(); // teclas que bajaron este frame
  mouseX = 0;
  mouseY = 0;
  mouseDown = [false, false, false];
  mousePressed = [false, false, false];
  wheel = 0;

  constructor(target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseDown = [false, false, false];
    });
    target.addEventListener('pointermove', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    });
    target.addEventListener('pointerdown', (e) => {
      if (e.button < 3) {
        this.mouseDown[e.button] = true;
        this.mousePressed[e.button] = true;
      }
      target.setPointerCapture(e.pointerId);
    });
    target.addEventListener('pointerup', (e) => {
      if (e.button < 3) this.mouseDown[e.button] = false;
    });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    target.addEventListener('wheel', (e) => {
      this.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    }, { passive: false });
  }

  /** Eje -1..1 a partir de pares de teclas. */
  axis(neg: string[], pos: string[]): number {
    let v = 0;
    for (const k of neg) if (this.keys.has(k)) { v -= 1; break; }
    for (const k of pos) if (this.keys.has(k)) { v += 1; break; }
    return v;
  }

  endFrame(): void {
    this.pressed.clear();
    this.mousePressed = [false, false, false];
    this.wheel = 0;
  }
}
