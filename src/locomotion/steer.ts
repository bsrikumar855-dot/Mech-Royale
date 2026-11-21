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

/** Is walking along unit heading `d` blocked within `dist` (map edge, a slope we cannot climb, a wall)? */
export function blockedAhead(map: MapQuery, world: WorldModel, d: Vec2, dist: number = L.feelerStepM): boolean {
  const [x, y, z] = world.self.pos
  const body = bodyOf(world)
  const b = map.bounds
  for (const k of [0.5, 1]) {
    const qx = x + d[0] * dist * k
    const qy = y + d[1] * dist * k
    if (qx < b.minX + body.radius || qx > b.maxX - body.radius || qy < b.minY + body.radius || qy > b.maxY - body.radius) return true
    const ground = map.heightAt(qx, qy)
    if (ground > z + body.stepUp && map.slopeDegAt(qx, qy) > world.rules.maxSlopeDeg) return true
    if (map.isBlockedAt(qx, qy, Math.max(z, ground), body)) return true
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
