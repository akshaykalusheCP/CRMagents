import { useEffect, useRef } from 'react';

// Decorative silk ribbon: hundreds of thin translucent strands along one curved band, coloured blue → violet →
// pink → orange across the band. Drawn once on a canvas (crisp at any DPI) and redrawn only when its size changes;
// the slow sway is a CSS transform the GPU composites, so it costs no drawing per frame (redrawing every frame
// made pages stutter). Purely decorative: aria-hidden, pointer-events none.

/** Colour sets, one per area of the app; all soft enough to sit behind content. */
export const RIBBON_PALETTES = {
  sunset: ['#6aa8ff', '#8f6bff', '#c45cf0', '#ff5fa8', '#ff7a45', '#ffb03a'],
  ocean: ['#67d4ff', '#3fa2ff', '#5b7cff', '#7d6bff', '#a78bfa', '#cbbcff'],
  mint: ['#8be6c9', '#3ccfb0', '#2bb3c8', '#4c9bff', '#7c8cff', '#b4b9ff'],
  dusk: ['#8ea6ff', '#7a6bff', '#9b5cf0', '#c65fd6', '#e879b9', '#f6a6c8'],
  amber: ['#ffd36a', '#ffb03a', '#ff8a4c', '#ff6b6b', '#f45ba0', '#d77bff'],
  silver: ['#c7d2fe', '#a5b4fc', '#c4b5fd', '#ddd6fe', '#e9d5ff', '#f5d0fe'],
} as const;
export type RibbonPalette = keyof typeof RIBBON_PALETTES;

export function Ribbon({ className = '', strands = 420, angle = 0.62, width = 0.34, palette = 'sunset' }: { className?: string; strands?: number; angle?: number; width?: number; palette?: RibbonPalette }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawn = useRef(false);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    // Fixed per-strand jitter so the ribbon doesn't shimmer between frames.
    const jitter = Array.from({ length: strands }, (_, i) => Math.sin(i * 12.9898) * 43758.5453 % 1);
    let raf = 0;
    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const band = Math.max(w, h) * width;
      const sway = 0;
      const grad = ctx.createLinearGradient(w * 0.35, 0, w, h * 0.4);
      const stops = RIBBON_PALETTES[palette] ?? RIBBON_PALETTES.sunset;
      stops.forEach((s, i) => grad.addColorStop(i / (stops.length - 1), s));
      const curve = (u: number, i: number) => {
        const off = u * band + jitter[i % strands] * 6;
        const bend = (0.18 + sway + u * 0.05) * h;
        const x0 = w * angle + off, y0 = -40;
        const x3 = w * 1.08 + off * 0.6, y3 = h + 40;
        return [x0, y0, x0 + bend * 0.35, y0 + h * 0.35, x3 - bend, y3 - h * 0.45, x3, y3] as const;
      };
      // Glowing body: the band's outline filled and blurred, under the strands.
      const a = curve(-0.42, 0), b = curve(0.42, strands - 1);
      ctx.save();
      ctx.filter = `blur(${Math.round(band * 0.08)}px)`;
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]); ctx.bezierCurveTo(a[2], a[3], a[4], a[5], a[6], a[7]);
      ctx.lineTo(b[6], b[7]); ctx.bezierCurveTo(b[4], b[5], b[2], b[3], b[0], b[1]);
      ctx.closePath(); ctx.fill();
      ctx.restore();
      // Silk strands on top.
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = grad;
      for (let i = 0; i < strands; i++) {
        const u = i / (strands - 1) - 0.5;
        const p = curve(u, i);
        ctx.globalAlpha = 0.22 + 0.45 * (1 - Math.abs(u) * 2);
        ctx.beginPath();
        ctx.moveTo(p[0], p[1]);
        ctx.bezierCurveTo(p[2], p[3], p[4], p[5], p[6], p[7]);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    // Redraw only when the canvas changes size (one frame later, so a resize burst draws once).
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); };
    // A new palette (another page) fades in instead of switching abruptly.
    if (drawn.current) {
      c.style.opacity = '0';
      raf = requestAnimationFrame(() => { draw(); requestAnimationFrame(() => { c.style.opacity = ''; }); });
    } else schedule();
    drawn.current = true;
    const ro = new ResizeObserver(schedule);
    ro.observe(c);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [strands, angle, width, palette]);
  return <canvas ref={ref} className={'ribbon ' + className} aria-hidden="true" />;
}
