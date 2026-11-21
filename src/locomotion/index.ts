/**
 * OWNER: Person A. Locomotion: world + map + LootTarget[] -> move / boost / jump.
 * Contract: src/types/contracts.ts (LocomotionOutput). Never throws past decide().
 *
 * Phase 1 (simple rules; NO pathfinder, NO utility grid, NO hysteresis until v1 is scored). Priority order:
 *  1. Zone safety: outside the zone, or outside 85% of the current/upcoming radius -> head to the upcoming centre
 *     (zoneAt(t + 10)); boost only when actually outside the zone and energy is above the minimum.
 *  2. Kite: safely inside and an enemy mech within 40 m -> back away with a mild strafe, never out of the safe zone.
 *  3. Loot: no enemy mech within 35 m -> walk to the most valuable LootTarget within 25 m (inside the safe zone).
 *  4. Otherwise stand still: a motionless mech is silent (sound.step_speed) and hard to find. SURVIVAL FIRST.
 * Every chosen heading goes through a wall feeler (MapQuery) that steers around walls and steep slopes.
 */
import { LOCOMOTION } from "../config/index.ts"
import type { Locomotion, LocomotionOutput, LootTarget, TickContext } from "../types/contracts.ts"
import type { Vec2 } from "../types/mechfight.ts"
import { dist2d, unit2 } from "../world/geom.ts"
import type { MapQuery } from "../world/map.ts"
import type { WorldModel } from "../world/world.ts"

const DEG = Math.PI / 180

const rotate = (d: Vec2, deg: number): Vec2 => {
  const c = Math.cos(deg * DEG)
  const s = Math.sin(deg * DEG)
  return [d[0] * c - d[1] * s, d[0] * s + d[1] * c]
}

/** Is walking from our position along unit heading `d` blocked within the feeler distance (wall, steep slope, map edge)? */
export function blockedAhead(map: MapQuery, world: WorldModel, d: Vec2): boolean {
  const [x, y, z] = world.self.pos
  const body = { radius: world.selfStat("radius", world.rules.radius), height: world.selfStat("height", world.rules.height), stepUp: world.rules.stepUp }
  const b = map.bounds
  for (const k of [0.5, 1]) {
    const qx = x + d[0] * LOCOMOTION.feelerStepM * k
    const qy = y + d[1] * LOCOMOTION.feelerStepM * k
    if (qx < b.minX + body.radius || qx > b.maxX - body.radius || qy < b.minY + body.radius || qy > b.maxY - body.radius) return true
    if (map.slopeDegAt(qx, qy) > world.rules.maxSlopeDeg) return true
    // Feet at the higher of ours and the local ground: a taller wall in the way still blocks; terrain steepness is the slope test.
    if (map.isBlockedAt(qx, qy, Math.max(z, map.heightAt(qx, qy)), body)) return true
  }
  return false
}

/** `d` if open, else the first open rotated heading (+-30, 60, 90, 120 deg), else null (boxed in: stand still). */
export function steerAround(map: MapQuery | null, world: WorldModel, d: Vec2): Vec2 | null {
  if (!map) return d
  if (!blockedAhead(map, world, d)) return d
  for (const deg of LOCOMOTION.steerAnglesDeg) {
    const r = rotate(d, deg)
    if (!blockedAhead(map, world, r)) return r
  }
  return null
}

export class RuleLocomotion implements Locomotion {
  decide(ctx: TickContext, loot: readonly LootTarget[]): LocomotionOutput {
    const { world, map } = ctx
    const obs = world.obs
    const still: LocomotionOutput = { move: [0, 0], boost: false, jump: false }
    if (!obs) return still
    const self = world.self
    const [px, py] = self.pos

    const now = world.zoneAt(world.t)
    const future = world.zoneAt(world.t + LOCOMOTION.zoneLeadS)
    const inSafe = (x: number, y: number): boolean =>
      dist2d(x, y, now.center[0], now.center[1]) <= now.radius * LOCOMOTION.safeRadiusFrac &&
      dist2d(x, y, future.center[0], future.center[1]) <= future.radius * LOCOMOTION.safeRadiusFrac
    const inward = unit2(future.center[0] - px, future.center[1] - py)

    let dir: Vec2 | null = null
    let boost = false

    if (!self.in_zone || !inSafe(px, py)) {
      dir = inward
      boost = !self.in_zone && self.energy > LOCOMOTION.boostMinEnergy
    } else {
      let enemy: { x: number; y: number; d: number } | null = null
      for (const m of obs.mechs ?? []) {
        if (m.kind !== "mech") continue
        const d = dist2d(px, py, m.pos[0], m.pos[1])
        if (!enemy || d < enemy.d) enemy = { x: m.pos[0], y: m.pos[1], d }
      }
      if (enemy && enemy.d <= LOCOMOTION.kiteRangeM) {
        const away = unit2(px - enemy.x, py - enemy.y) ?? [1, 0]
        let perp: Vec2 = [-away[1], away[0]]
        if (inward && perp[0] * inward[0] + perp[1] * inward[1] < 0) perp = [-perp[0], -perp[1]] // strafe toward the safe side
        dir = unit2(away[0] + perp[0] * LOCOMOTION.kiteStrafeBlend, away[1] + perp[1] * LOCOMOTION.kiteStrafeBlend)
        if (dir && inward && !inSafe(px + dir[0] * LOCOMOTION.kiteLookaheadM, py + dir[1] * LOCOMOTION.kiteLookaheadM)) {
          dir = unit2(dir[0] + inward[0], dir[1] + inward[1]) ?? dir
        }
      } else if (!enemy || enemy.d > LOCOMOTION.lootEnemyClearM) {
        let best: LootTarget | null = null
        for (const t of loot) {
          const d = dist2d(px, py, t.x, t.y)
          if (d <= LOCOMOTION.lootDetourM && inSafe(t.x, t.y) && (!best || t.value > best.value)) best = t
        }
        if (best && dist2d(px, py, best.x, best.y) > LOCOMOTION.lootArriveM) dir = unit2(best.x - px, best.y - py)
      }
    }

    if (!dir) return still
    const steered = steerAround(map, world, dir)
    if (!steered) return still
    return { move: steered, boost, jump: false }
  }
}
