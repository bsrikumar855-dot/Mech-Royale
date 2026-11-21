/**
 * Locomotion v6: ground-only 2v1+ corner slicing. Runs ONLY when at least sliceMinLosEnemies enemy mechs have a shot
 * line on us (never in a 1v1, however wounded: we finish 1v1s). Probes sliceProbes evenly spaced ground bearings at
 * sliceProbeM: each costs 3 walkability point checks plus at most sliceMaxEnemies shot-line raycasts (<= 24 per
 * decision). Probes outside the safe zone are skipped. The probe the fewest of the nearest shooters can hit wins; ties
 * go to moving away from the threat centroid and keeping the previous slice heading (hysteresis). No jumping, no jets.
 */
import { LOCOMOTION as L } from "../config/index.ts"
import type { Vec2, Vec3 } from "../types/mechfight.ts"
import type { MapQuery } from "../world/map.ts"
import type { WorldModel } from "../world/world.ts"
import type { Sensed } from "./sense.ts"
import { bodyOf } from "./steer.ts"

export interface SlicePick {
  /** unit heading toward the chosen probe */
  dir: Vec2
  x: number
  y: number
  /** shooters (of the nearest sliceMaxEnemies with a shot line now) that could still hit us at the probe */
  exposed: number
  /** the same count where we stand (all of them, by construction) */
  current: number
}

/** Strictly crossfire: two or more enemy mechs with a shot line. */
export const shouldSlice = (sn: Sensed): boolean => sn.losCount >= L.sliceMinLosEnemies

/** Best ground cover probe inside the safe zone, or null. The caller steers there only if exposed < current. */
export function sliceCover(
  map: MapQuery,
  world: WorldModel,
  sn: Sensed,
  opts: { inSafe: (x: number, y: number) => boolean; prevHeading: Vec2 | null },
): SlicePick | null {
  const shooters = sn.enemies
    .filter((e) => e.los)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, L.sliceMaxEnemies)
  if (shooters.length === 0) return null
  const [px, py, pz] = world.self.pos
  const body = bodyOf(world)
  const b = map.bounds

  let cx = 0
  let cy = 0
  for (const e of shooters) {
    cx += e.x / shooters.length
    cy += e.y / shooters.length
  }
  const al = Math.hypot(px - cx, py - cy)
  const away: Vec2 = al > 1e-9 ? [(px - cx) / al, (py - cy) / al] : [0, 0]

  let best: SlicePick | null = null
  let bestScore = Infinity
  for (let k = 0; k < L.sliceProbes; k++) {
    const a = (k / L.sliceProbes) * Math.PI * 2
    const u: Vec2 = [Math.cos(a), Math.sin(a)]
    const qx = px + u[0] * L.sliceProbeM
    const qy = py + u[1] * L.sliceProbeM
    if (!opts.inSafe(qx, qy)) continue
    let ok = true
    for (const f of [1 / 3, 2 / 3, 1]) {
      const sx = px + u[0] * L.sliceProbeM * f
      const sy = py + u[1] * L.sliceProbeM * f
      if (sx < b.minX + body.radius || sx > b.maxX - body.radius || sy < b.minY + body.radius || sy > b.maxY - body.radius) {
        ok = false
        break
      }
      const ground = map.heightAt(sx, sy)
      if (map.isBlockedAt(sx, sy, Math.max(pz, ground), body)) {
        ok = false
        break
      }
    }
    if (!ok) continue
    const q: Vec3 = [qx, qy, map.standingHeightAt(qx, qy, pz, body.stepUp, body.height) + body.height / 2]
    let exposed = 0
    for (const e of shooters) if (map.hasShotLOS(e.muzzle, q)) exposed++
    const prev = opts.prevHeading ? u[0] * opts.prevHeading[0] + u[1] * opts.prevHeading[1] : 0
    const score = exposed * L.sliceExposedWeight - (u[0] * away[0] + u[1] * away[1]) * L.sliceAwayWeight - prev * L.sliceHeadingWeight
    if (score < bestScore) {
      bestScore = score
      best = { dir: u, x: qx, y: qy, exposed, current: shooters.length }
    }
  }
  return best
}
