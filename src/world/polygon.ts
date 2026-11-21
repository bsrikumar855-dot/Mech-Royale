import { MAP } from "../config/index.ts"

/** An extruded footprint: solid where inside `ring`, outside every hole, and base <= z <= top. */
export interface Prism {
  kind: string
  base: number
  top: number
  /** flat [x0, y0, x1, y1, ...], open (last point does NOT repeat the first) */
  ring: Float64Array
  holes: Float64Array[]
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export function makePrism(kind: string, base: number, top: number, ring: ArrayLike<number>, holes: ArrayLike<number>[] = []): Prism {
  const r = Float64Array.from(ring)
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i + 1 < r.length; i += 2) {
    const x = r[i] as number
    const y = r[i + 1] as number
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { kind, base, top, ring: r, holes: holes.map((h) => Float64Array.from(h)), minX, maxX, minY, maxY }
}

/** Even-odd point-in-polygon on a flat ring. */
export function pointInRing(x: number, y: number, ring: Float64Array): boolean {
  let inside = false
  const n = ring.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i] as number
    const yi = ring[2 * i + 1] as number
    const xj = ring[2 * j] as number
    const yj = ring[2 * j + 1] as number
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** XY containment: inside the ring and not inside any hole. */
export function pointInPrismXY(p: Prism, x: number, y: number): boolean {
  if (x < p.minX || x > p.maxX || y < p.minY || y > p.maxY) return false
  if (!pointInRing(x, y, p.ring)) return false
  for (const h of p.holes) if (pointInRing(x, y, h)) return false
  return true
}

/** Full 3D containment (base and top inclusive). */
export function pointInPrism(p: Prism, x: number, y: number, z: number): boolean {
  return z >= p.base && z <= p.top && pointInPrismXY(p, x, y)
}

function distToSegment2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  return (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2
}

function minDist2ToRing(x: number, y: number, ring: Float64Array): number {
  let best = Infinity
  const n = ring.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const d = distToSegment2(x, y, ring[2 * j] as number, ring[2 * j + 1] as number, ring[2 * i] as number, ring[2 * i + 1] as number)
    if (d < best) best = d
  }
  return best
}

/** Does a vertical cylinder footprint (circle radius r at x,y) overlap the prism's XY footprint? */
export function circleOverlapsPrismXY(p: Prism, x: number, y: number, r: number): boolean {
  if (x + r < p.minX || x - r > p.maxX || y + r < p.minY || y - r > p.maxY) return false
  if (pointInPrismXY(p, x, y)) return true
  const r2 = r * r
  if (minDist2ToRing(x, y, p.ring) < r2) return true
  for (const h of p.holes) if (minDist2ToRing(x, y, h) < r2) return true
  return false
}

/** Parameter t in the open interval (t0, t1) where segment A->B crosses edge C->D, pushed onto `out`. */
function pushCrossings(ax: number, ay: number, bx: number, by: number, ring: Float64Array, t0: number, t1: number, out: number[]): void {
  const rx = bx - ax
  const ry = by - ay
  const n = ring.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const cx = ring[2 * j] as number
    const cy = ring[2 * j + 1] as number
    const sx = (ring[2 * i] as number) - cx
    const sy = (ring[2 * i + 1] as number) - cy
    const denom = rx * sy - ry * sx
    if (Math.abs(denom) < MAP.geomEps) continue // parallel
    const qx = cx - ax
    const qy = cy - ay
    const t = (qx * sy - qy * sx) / denom
    const u = (qx * ry - qy * rx) / denom
    if (u >= 0 && u <= 1 && t > t0 && t < t1) out.push(t)
  }
}

/**
 * Exact test: does segment A->B (3D) pass through the solid prism?
 * Clips the segment to the prism's [base, top] slab, then checks whether any sub-interval of the clipped
 * part lies inside (ring minus holes) by splitting at every edge crossing and probing midpoints.
 */
export function segmentHitsPrism(p: Prism, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  let t0 = 0
  let t1 = 1
  const dz = bz - az
  if (Math.abs(dz) < MAP.geomEps) {
    if (az < p.base || az > p.top) return false
  } else {
    const ta = (p.base - az) / dz
    const tb = (p.top - az) / dz
    t0 = Math.max(t0, Math.min(ta, tb))
    t1 = Math.min(t1, Math.max(ta, tb))
    if (t0 > t1) return false
  }
  const dx = bx - ax
  const dy = by - ay
  // Cheap XY AABB reject on the clipped part.
  const x0 = ax + dx * t0
  const x1 = ax + dx * t1
  const y0 = ay + dy * t0
  const y1 = ay + dy * t1
  if (Math.max(x0, x1) < p.minX || Math.min(x0, x1) > p.maxX || Math.max(y0, y1) < p.minY || Math.min(y0, y1) > p.maxY) return false

  if (t1 - t0 <= MAP.geomEps) return pointInPrismXY(p, x0, y0)

  const ts: number[] = [t0, t1]
  pushCrossings(ax, ay, bx, by, p.ring, t0, t1, ts)
  for (const h of p.holes) pushCrossings(ax, ay, bx, by, h, t0, t1, ts)
  ts.sort((m, n) => m - n)
  for (let k = 0; k + 1 < ts.length; k++) {
    const u = ts[k] as number
    const v = ts[k + 1] as number
    if (v - u <= MAP.geomEps) continue
    const m = (u + v) / 2
    if (pointInPrismXY(p, ax + dx * m, ay + dy * m)) return true
  }
  return false
}

/**
 * Interval [tIn, tOut] (clipped to [0,1]) of segment A->B inside a vertical cylinder (center cx,cy; radius R)
 * restricted to z in [z0, z1]. Returns null if none.
 */
export function segmentCylinderInterval(
  ax: number, ay: number, az: number, bx: number, by: number, bz: number,
  cx: number, cy: number, R: number, z0: number, z1: number,
): [number, number] | null {
  const dx = bx - ax
  const dy = by - ay
  const a = dx * dx + dy * dy
  const fx = ax - cx
  const fy = ay - cy
  let lo = 0
  let hi = 1
  if (a < MAP.geomEps) {
    if (fx * fx + fy * fy > R * R) return null
  } else {
    const b = 2 * (fx * dx + fy * dy)
    const c = fx * fx + fy * fy - R * R
    const disc = b * b - 4 * a * c
    if (disc < 0) return null
    const s = Math.sqrt(disc)
    lo = Math.max(lo, (-b - s) / (2 * a))
    hi = Math.min(hi, (-b + s) / (2 * a))
    if (lo > hi) return null
  }
  const dz = bz - az
  if (Math.abs(dz) < MAP.geomEps) {
    if (az < z0 || az > z1) return null
  } else {
    const ta = (z0 - az) / dz
    const tb = (z1 - az) / dz
    lo = Math.max(lo, Math.min(ta, tb))
    hi = Math.min(hi, Math.max(ta, tb))
    if (lo > hi) return null
  }
  return [lo, hi]
}

/**
 * Length of segment A->B inside a vertical ellipsoid (horizontal radius R, vertical half-height H, center cx,cy,cz).
 * Scale z by R/H to get a sphere; the parameter t is unchanged, so chord length = (t2 - t1) * |AB|.
 */
export function segmentEllipsoidChord(
  ax: number, ay: number, az: number, bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number, R: number, H: number,
): number {
  if (R <= 0 || H <= 0) return 0
  const k = R / H
  const dx = bx - ax
  const dy = by - ay
  const dz = (bz - az) * k
  const fx = ax - cx
  const fy = ay - cy
  const fz = (az - cz) * k
  const a = dx * dx + dy * dy + dz * dz
  if (a < MAP.geomEps) return 0
  const b = 2 * (fx * dx + fy * dy + fz * dz)
  const c = fx * fx + fy * fy + fz * fz - R * R
  const disc = b * b - 4 * a * c
  if (disc <= 0) return 0
  const s = Math.sqrt(disc)
  const t1 = Math.max(0, (-b - s) / (2 * a))
  const t2 = Math.min(1, (-b + s) / (2 * a))
  if (t2 <= t1) return 0
  return (t2 - t1) * Math.hypot(bx - ax, by - ay, bz - az)
}
