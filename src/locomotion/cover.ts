/**
 * Locomotion v4: lightweight 2v1+ corner slicing. Only runs on crossfire / critically wounded ticks.
 * Probes sliceProbes evenly spaced bearings at sliceProbeM (sliceRoofProbeM on a roof, never past a drop): each probe
 * costs 3 walkability point checks plus at most sliceMaxEnemies shot-line raycasts (<= 24 raycasts per decision).
 * The probe that leaves the fewest of the nearest shot-line enemies able to hit us wins; ties go to staying inside the
 * safe zone, moving away from the threat centroid, and keeping the previous slice heading (hysteresis).
 */
import { LOCOMOTION as L } from "../config/index.ts"
import type { Vec2, Vec3 } from "../types/mechfight.ts"
import type { MapQuery } from "../world/map.ts"
import type { WorldModel } from "../world/world.ts"
import type { Sensed } from "./sense.ts"
import { bodyOf, dropAt, surfaceAt } from "./steer.ts"

export interface SlicePick {
  /** unit heading toward the chosen probe */
  dir: Vec2
  x: number
  y: number
  /** enemies (of the nearest sliceMaxEnemies with a shot line now) that could still hit us at the probe */
  exposed: number
  /** the same count where we stand (all of them, by construction) */
  current: number
}

/** Should this decision run the slicer? Crossfire, or a losing 1v1 (wounded and the shooter is not finishable). */
export function shouldSlice(world: WorldModel, sn: Sensed, roof: boolean): boolean {
  if (sn.losCount >= L.sliceMinLosEnemies) return true
  if (sn.losCount < 1) return false
  const self = world.self
  const hpFrac = self.max_hp > 0 ? self.hp / self.max_hp : 1
  if (hpFrac >= (roof ? L.sliceRoofWoundedHpFrac : L.sliceWoundedHpFrac)) return false
  const nearest = sn.enemies.filter((e) => e.los).sort((a, b) => a.dist - b.dist)[0]
  const hp = nearest ? world.tracks.get(nearest.id)?.hp : undefined
  return hp === undefined || hp > L.sliceFinishableHp
}

/** Best cover probe, or null when nothing is walkable. The caller steers only if exposed < current. */
export function sliceCover(
  map: MapQuery,
  world: WorldModel,
  sn: Sensed,
  opts: { inSafe: (x: number, y: number) => boolean; prevHeading: Vec2 | null; roof: boolean },
): SlicePick | null {
  const shooters = sn.enemies
    .filter((e) => e.los)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, L.sliceMaxEnemies)
  if (shooters.length === 0) return null
  const [px, py, pz] = world.self.pos
  const body = bodyOf(world)
  const comH = body.height / 2
  const b = map.bounds

  let cx = 0
  let cy = 0
  for (const e of shooters) {
    cx += e.x / shooters.length
    cy += e.y / shooters.length
  }
  const al = Math.hypot(px - cx, py - cy)
  const away: Vec2 = al > 1e-9 ? [(px - cx) / al, (py - cy) / al] : [0, 0]

  const R = opts.roof ? L.sliceRoofProbeM : L.sliceProbeM
  let best: SlicePick | null = null
  let bestScore = Infinity
  for (let k = 0; k < L.sliceProbes; k++) {
    const a = (k / L.sliceProbes) * Math.PI * 2
    const u: Vec2 = [Math.cos(a), Math.sin(a)]
    let ok = true
    for (const f of [1 / 3, 2 / 3, 1]) {
      const qx = px + u[0] * R * f
      const qy = py + u[1] * R * f
      if (qx < b.minX + body.radius || qx > b.maxX - body.radius || qy < b.minY + body.radius || qy > b.maxY - body.radius) {
        ok = false
        break
      }
      const ground = map.heightAt(qx, qy)
      if (map.isBlockedAt(qx, qy, Math.max(pz, ground), body) || (opts.roof && dropAt(map, world, qx, qy))) {
        ok = false
        break
      }
    }
    if (!ok) continue
    const qx = px + u[0] * R
    const qy = py + u[1] * R
    const q: Vec3 = [qx, qy, surfaceAt(map, world, qx, qy) + comH]
    let exposed = 0
    for (const e of shooters) if (map.hasShotLOS(e.muzzle, q)) exposed++
    const prev = opts.prevHeading ? u[0] * opts.prevHeading[0] + u[1] * opts.prevHeading[1] : 0
    const score =
      exposed * L.sliceExposedWeight +
      (opts.inSafe(qx, qy) ? 0 : L.sliceOutsideSafePenalty) -
      (u[0] * away[0] + u[1] * away[1]) * L.sliceAwayWeight -
      prev * L.sliceHeadingWeight
    if (score < bestScore) {
      bestScore = score
      best = { dir: u, x: qx, y: qy, exposed, current: shooters.length }
    }
  }
  return best
}
