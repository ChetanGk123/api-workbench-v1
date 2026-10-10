// Panel/launcher geometry: validation, viewport clamping and per-origin storage (host localStorage is origin-scoped).
// Stored values are preferences; they are clamped on every apply and never rewritten just because the viewport shrank.

export interface Pos { x: number; y: number }
export interface Size { w: number; h: number }
export interface Geometry { panel?: Pos; size?: Size; launcher?: Pos }

export const GEOMETRY_KEY = 'api-workbench:geometry:v1';
export const MIN_SIZE: Size = { w: 320, h: 240 };
const MAX_DIM = 10_000;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pos = (v: unknown): Pos | undefined => {
  const p = v as Record<string, unknown> | null | undefined;
  return p && finite(p.x) && finite(p.y) && Math.abs(p.x) <= MAX_DIM && Math.abs(p.y) <= MAX_DIM ? { x: p.x, y: p.y } : undefined;
};

/** Accept only finite, in-range numbers; anything else is dropped so defaults apply. */
export function parseGeometry(text: string | null): Geometry {
  let raw: Record<string, unknown> | null;
  try { raw = JSON.parse(text ?? 'null'); } catch { return {}; }
  if (!raw || typeof raw !== 'object') return {};
  const out: Geometry = {};
  const panel = pos(raw.panel);
  const launcher = pos(raw.launcher);
  const s = raw.size as Record<string, unknown> | undefined;
  if (panel) out.panel = panel;
  if (launcher) out.launcher = launcher;
  if (s && finite(s.w) && finite(s.h) && s.w >= MIN_SIZE.w && s.h >= MIN_SIZE.h && s.w <= MAX_DIM && s.h <= MAX_DIM) out.size = { w: s.w, h: s.h };
  return out;
}

/** Keep a box of the given rendered size fully inside the viewport (top-left wins when it cannot fit). */
export function clampPos(p: Pos, w: number, h: number, vw: number, vh: number): Pos {
  return { x: clamp(p.x, 0, vw - w), y: clamp(p.y, 0, vh - h) };
}

const clamp = (v: number, lo: number, hi: number) => Math.round(Math.min(Math.max(v, lo), Math.max(lo, hi)));

export function readGeometry(): Geometry {
  try { return parseGeometry(localStorage.getItem(GEOMETRY_KEY)); } catch { return {}; }
}

/** False when storage is unavailable; geometry then lasts for this page session only. */
export function writeGeometry(g: Geometry): boolean {
  try {
    localStorage.setItem(GEOMETRY_KEY, JSON.stringify(g));
    return true;
  } catch {
    return false;
  }
}
