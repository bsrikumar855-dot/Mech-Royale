/**
 * Kinematic zone model: current circle (interpolated through the shrink), the next circle, and an urgency that
 * rises only as the time we need to walk into the next circle approaches the time the shrink ends.
 * Inside, a flat plateau on the rim band: we hug the quiet perimeter instead of diving into the crowded centre.
 */
import { LOCOMOTION as L } from "../config/index.ts"
import { clamp, dist2d } from "../world/geom.ts"
import type { WorldModel } from "../world/world.ts"
import type { Vec2 } from "./types.ts"

export interface ZoneModel {
  curC: Vec2
  curR: number
  nextC: Vec2
  nextR: number
  /** radius we aim to be inside of the next circle (nextSafeFrac * nextR) */
  safeNextR: number
  /** 0 = plenty of time, 1 = we must be moving in now */
  urgency: number
  dps: number
  alive: number
  /** the circle the rim band and "safe" tests use */
  activeC: Vec2
  activeR: number
}

export function buildZone(world: WorldModel, selfX: number, selfY: number, walkSpeed: number): ZoneModel {
  const obs = world.obs
  const t = world.t
  const cur = world.zoneAt(t)
  const z = obs?.zone
  const nextC: Vec2 = z ? [z.next_center[0], z.next_center[1]] : [cur.center[0], cur.center[1]]
  const nextR = z ? z.next_radius : cur.radius
  const safeNextR = Math.max(0, nextR * L.nextSafeFrac)
  const timeToShrinkEnd = Math.max(0.5, (z?.shrink_end ?? t) - t)
  const travel = Math.max(0, dist2d(selfX, selfY, nextC[0], nextC[1]) - safeNextR) / Math.max(1, walkSpeed)
  const slack = timeToShrinkEnd - L.shrinkSafetyBufferS - travel
  const urgency = clamp(1 - slack / L.urgencyRampS, 0, 1)
  const useNext = urgency >= L.activeCircleUrgency
  return {
    curC: [cur.center[0], cur.center[1]],
    curR: cur.radius,
    nextC,
    nextR,
    safeNextR,
    urgency,
    dps: z?.dps ?? 0,
    alive: obs?.alive ?? 16,
    activeC: useNext ? nextC : [cur.center[0], cur.center[1]],
    activeR: useNext ? safeNextR : cur.radius,
  }
}

/** Signed distance to the current edge: positive inside, negative outside. */
export const distToCurrentEdge = (z: ZoneModel, x: number, y: number): number => z.curR - dist2d(x, y, z.curC[0], z.curC[1])

/** Metres still to walk to be inside the next circle's safe radius (0 once inside). */
export const distToNextSafe = (z: ZoneModel, x: number, y: number): number =>
  Math.max(0, dist2d(x, y, z.nextC[0], z.nextC[1]) - z.safeNextR)

/** Zone utility of standing at (x, y). Higher is better; 0 on the comfortable rim plateau. */
export function zoneScore(z: ZoneModel, x: number, y: number): number {
  let s = 0
  const edge = distToCurrentEdge(z, x, y)
  if (edge < 0) s -= (L.outsideCliff + L.outsidePerM * -edge) * Math.max(1, z.dps / L.refZoneDps)
  s -= L.nextPullPerM * z.urgency * distToNextSafe(z, x, y)
  const R = Math.max(1, z.activeR)
  const r = dist2d(x, y, z.activeC[0], z.activeC[1]) / R
  if (r > L.rimBandOuter) s -= L.rimOutPerM * (r - L.rimBandOuter) * R
  else if (r < L.deadCenterFrac && z.alive > L.deadCenterMinAlive) s -= L.deadCenterPerM * (L.deadCenterFrac - r) * R
  return s
}

/** Is (x, y) a place we are happy to be (inside, on the plateau of the active circle)? */
export function zoneSafe(z: ZoneModel, x: number, y: number): boolean {
  if (distToCurrentEdge(z, x, y) <= 0) return false
  if (z.urgency >= L.activeCircleUrgency && distToNextSafe(z, x, y) > 0) return false
  return dist2d(x, y, z.activeC[0], z.activeC[1]) <= L.rimBandOuter * Math.max(1, z.activeR)
}

/**
 * Where to head when the zone needs us to move: the nearest point a little inside the rim (goalRimFrac of the
 * radius from the centre, along our bearing), never the dead centre. Null when we are already fine.
 */
export function zoneGoal(z: ZoneModel, x: number, y: number): Vec2 | null {
  const outside = distToCurrentEdge(z, x, y) < 0
  const c = outside ? z.curC : z.nextC
  const R = outside ? z.curR : z.safeNextR
  if (!outside && (z.urgency <= 0 || distToNextSafe(z, x, y) <= 0)) return null
  const d = dist2d(x, y, c[0], c[1])
  if (d < 1e-6) return null
  const k = Math.min(d, R * L.goalRimFrac) / d
  return [c[0] + (x - c[0]) * k, c[1] + (y - c[1]) * k]
}
