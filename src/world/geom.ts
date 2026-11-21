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

/** Unit direction for [yaw, pitch]: [cos(p)cos(y), cos(p)sin(y), sin(p)] (protocol.md section 5). */
export const aimDirection = (yaw: number, pitch: number): [number, number, number] => [
  Math.cos(pitch) * Math.cos(yaw),
  Math.cos(pitch) * Math.sin(yaw),
  Math.sin(pitch),
]

/** Angle (radians) between two aim directions [yaw, pitch]. 0 = same direction. */
export function aimErrorRad(a: readonly number[], b: readonly number[]): number {
  const da = aimDirection(a[0] as number, a[1] as number)
  const db = aimDirection(b[0] as number, b[1] as number)
  return Math.acos(clamp(da[0] * db[0] + da[1] * db[1] + da[2] * db[2], -1, 1))
}

export const unit2 = (x: number, y: number): [number, number] | null => {
  const l = Math.hypot(x, y)
  return l < 1e-9 ? null : [x / l, y / l]
}
