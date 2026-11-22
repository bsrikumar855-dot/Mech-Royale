/**
 * Vanish when wounded (experiment "vanish"). Protocol facts it relies on (protocol.md section 8):
 *  - a mech sees us within near_range (45 m) in any direction unless a BUILDING blocks the line (canopy does not), or
 *    within vision range (200 m) in its wedge with no building in the way, a dense tree crown also hiding us;
 *  - once seen we stay tracked for memory_s (5 s) after leaving view, then we vanish from its list;
 *  - walking slower than step_speed (5 m/s) or standing still is SILENT (steps carry 40 m, boost 90 m).
 * So: find the nearest reachable spot that no known enemy can see (neither our centre nor our top), go there, then
 * keep quiet while the 5 s no-damage regen (45 HP/s) heals us.
 */
import { LOCOMOTION as L } from "../config/index.ts"
import type { NavGrid } from "../nav/grid.ts"
import type { MapQuery } from "../world/map.ts"
import type { WorldModel } from "../world/world.ts"

export interface Watcher {
  x: number
  y: number
  /** eye height (world z) */
  eye: number
}

/** Can any watcher see a mech standing with its feet at (x, y, z)? (centre or top visible = seen) */
export function seenBy(map: MapQuery, watchers: readonly Watcher[], x: number, y: number, z: number, height: number, nearRange: number): boolean {
  for (const w of watchers) {
    const near = Math.hypot(w.x - x, w.y - y) <= nearRange
    const from: [number, number, number] = [w.x, w.y, w.eye]
    // inside the proximity radius canopy does not hide us; beyond it a dense crown does
    const opts = { canopy: !near }
    if (map.hasVisionLOS(from, [x, y, z + height / 2], opts) || map.hasVisionLOS(from, [x, y, z + height], opts)) return true
  }
  return false
}

/** Enemies that may still be looking for us: tracked within vision memory. */
export function watchersOf(world: WorldModel): Watcher[] {
  const eyeH = world.rules.eyeHeight
  const [px, py] = world.self.pos
  return world
    .enemies()
    .filter((e) => world.t - e.lastListedT <= world.rules.memoryS)
    .sort((a, b) => Math.hypot(a.pos[0] - px, a.pos[1] - py) - Math.hypot(b.pos[0] - px, b.pos[1] - py))
    .slice(0, L.vanishMaxWatchers)
    .map((e) => ({ x: e.pos[0], y: e.pos[1], eye: e.pos[2] + eyeH }))
}

/**
 * Nearest spot (ring search, small radii first) that is walkable in a straight line from us, inside the safe zone,
 * and hidden from every watcher. Among hidden spots on the first ring that has any, the one farthest from the nearest
 * watcher wins. Null when nothing qualifies (the caller keeps the old retreat).
 */
export function findHideSpot(
  world: WorldModel,
  map: MapQuery,
  grid: NavGrid | null,
  watchers: readonly Watcher[],
  inSafe: (x: number, y: number) => boolean,
  /** unseen: instead of the nearest hidden spot, the hidden spot farthest from here (where we were last seen) */
  away: readonly [number, number] | null = null,
): { x: number; y: number } | null {
  const [px, py, pz] = world.self.pos
  const height = world.selfStat("height", world.rules.height)
  const near = world.config.vision.near_range
  const radius = world.selfStat("radius", world.rules.radius)
  const body = { radius, height, stepUp: world.rules.stepUp }
  const b = map.bounds
  const reachable = (x: number, y: number): boolean => (grid ? grid.segmentClear(px, py, pz, x, y) : true)
  const away_: Array<{ x: number; y: number; score: number }> = []
  for (const r of L.vanishRadiiM) {
    const ring: Array<{ x: number; y: number; score: number }> = []
    for (let k = 0; k < L.vanishDirections; k++) {
      const a = (2 * Math.PI * k) / L.vanishDirections
      const x = px + Math.cos(a) * r
      const y = py + Math.sin(a) * r
      if (x < b.minX + 5 || x > b.maxX - 5 || y < b.minY + 5 || y > b.maxY - 5) continue
      if (!inSafe(x, y)) continue
      const g = map.heightAt(x, y)
      if (map.isBlockedAt(x, y, g, body)) continue
      if (seenBy(map, watchers, x, y, g, height, near)) continue
      const score = away ? Math.hypot(x - away[0], y - away[1]) : watchers.length ? Math.min(...watchers.map((w) => Math.hypot(w.x - x, w.y - y))) : 0
      ;(away ? away_ : ring).push({ x, y, score })
    }
    if (!away && ring.length) {
      // seen: the nearest ring with a hidden spot; best-scored first, the (expensive) walkability check last and only
      // until one passes
      ring.sort((p, q) => q.score - p.score)
      for (const c of ring.slice(0, L.vanishMaxSegmentChecks)) if (reachable(c.x, c.y)) return { x: c.x, y: c.y }
    }
  }
  away_.sort((p, q) => q.score - p.score)
  for (const c of away_.slice(0, L.vanishMaxSegmentChecks)) if (reachable(c.x, c.y)) return { x: c.x, y: c.y }
  return null
}
