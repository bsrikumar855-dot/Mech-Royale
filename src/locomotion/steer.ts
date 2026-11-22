/** Lightweight wall feeler with side commitment (no pathfinder, a handful of point probes per decision). */
import { LOCOMOTION as L } from "../config/index.ts"
import type { Vec2 } from "../types/mechfight.ts"
import type { MapQuery } from "../world/map.ts"
import type { WorldModel } from "../world/world.ts"
import type { LocoState } from "./state.ts"

const DEG = Math.PI / 180

export const rotate = (d: Vec2, deg: number): Vec2 => {
  const c = Math.cos(deg * DEG)
  const s = Math.sin(deg * DEG)
  return [d[0] * c - d[1] * s, d[0] * s + d[1] * c]
}

export function bodyOf(world: WorldModel): { radius: number; height: number; stepUp: number } {
  return { radius: world.selfStat("radius", world.rules.radius), height: world.selfStat("height", world.rules.height), stepUp: world.rules.stepUp }
}

/**
 * Is walking along unit heading `d` blocked within `dist` (map edge, a ledge or slope we cannot climb, a wall)?
 * Walks the segment in NAV-free steps of feelerSampleM, carrying the feet height along the ground the way the server
 * moves us: a rise of more than step_up between two samples, or a climb steeper than max_slope_deg, is a wall
 * (protocol section 7). The old two-probe check only called terrain a wall when the probe point ITSELF was steeper
 * than 50 deg, so the flat top of an embankment read as open and the mech pushed into its face indefinitely.
 */
export function blockedAhead(map: MapQuery, world: WorldModel, d: Vec2, dist: number = L.feelerStepM): boolean {
  const [x, y, z] = world.self.pos
  const body = bodyOf(world)
  const b = map.bounds
  const step = L.feelerSampleM
  const maxRise = Math.tan(world.rules.maxSlopeDeg * DEG) * step
  let fz = z
  let prevGround = map.heightAt(x, y)
  for (let s = step; s <= dist + 1e-9; s += step) {
    const qx = x + d[0] * s
    const qy = y + d[1] * s
    if (qx < b.minX + body.radius || qx > b.maxX - body.radius || qy < b.minY + body.radius || qy > b.maxY - body.radius) return true
    const ground = map.heightAt(qx, qy)
    // terrain: a ledge (more than step_up above our feet) or a climb steeper than the walkable slope
    if (ground > fz + body.stepUp) return true
    if (ground > fz && ground - prevGround > maxRise) return true
    prevGround = ground
    fz = map.standingHeightAt(qx, qy, fz, body.stepUp, body.height)
    if (map.isBlockedAt(qx, qy, fz, body)) return true
  }
  return false
}

/**
 * `d` if open; else the smallest open rotation (30, 60, 90, 120 deg). Uncommitted: try both sides at each angle.
 * Committed: exhaust EVERY angle on the committed side before considering the other one (otherwise a wall that needs
 * 60 deg on our side but is open at 30 deg on the other flip-flops us). Choosing a side commits to it for wallCommitS.
 * Null when boxed in (stand still rather than walk into a wall).
 */
export function steer(map: MapQuery | null, world: WorldModel, state: LocoState, d: Vec2): Vec2 | null {
  if (!map || !blockedAhead(map, world, d)) return d
  const t = world.t
  const c = state.committedSide(t)
  const order: [number, 1 | -1][] =
    c === 0
      ? L.steerAnglesDeg.flatMap((deg) => [[deg, 1], [deg, -1]] as [number, 1 | -1][])
      : [...L.steerAnglesDeg.map((deg) => [deg, c] as [number, 1 | -1]), ...L.steerAnglesDeg.map((deg) => [deg, c === 1 ? -1 : 1] as [number, 1 | -1])]
  for (const [deg, s] of order) {
    const r = rotate(d, deg * s)
    if (!blockedAhead(map, world, r)) {
      state.commitWall(t, s)
      return r
    }
  }
  return null
}
