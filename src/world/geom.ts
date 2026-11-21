/** Small pure math helpers. Yaw: 0 = east (+x), counter-clockwise, radians. */
export const TAU = Math.PI * 2

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** Wrap to (-PI, PI]. */
export function normalizeAngle(a: number): number {
  if (a > -Math.PI && a <= Math.PI) return a // already in range: keep it bit-exact
  let r = (a + Math.PI) % TAU
  if (r < 0) r += TAU
  return r - Math.PI
}

/** Signed shortest rotation from `from` to `to`. */
export const angleDiff = (from: number, to: number): number => normalizeAngle(to - from)

export const dist2d = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(bx - ax, by - ay)

export const yawTo = (ax: number, ay: number, bx: number, by: number): number => Math.atan2(by - ay, bx - ax)

export const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
