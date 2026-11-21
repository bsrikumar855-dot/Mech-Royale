/**
 * Boost controller. Energy only regenerates after energy_regen_delay without spending, so we never boost-tap:
 *  - Emergency (down to emergencyBoostMinEnergy): outside the zone; leaving a charging laser's line; leaving a
 *    predicted mortar splash.
 *  - Tactical, latched with hysteresis (start >= coverBoostStartEnergy, hold until < coverBoostHoldEnergy): moving to a
 *    strictly less exposed spot, or opening distance from an enemy closer than escapeEnemyM.
 *  - Otherwise no boost, so energy refills.
 */
import { LOCOMOTION as L } from "../config/index.ts"
import { dist2d } from "../world/geom.ts"
import type { Scored, Threat } from "./types.ts"

export interface BoostInput {
  best: Scored
  self: Scored
  outsideZone: boolean
  selfInSplash: boolean
  energy: number
  nearest: Threat | null
}

export function decideBoost(inp: BoostInput, latch: { isBoosting: boolean }): boolean {
  const { best, self, energy } = inp
  if (best.c.dist <= 0) {
    latch.isBoosting = false
    return false
  }
  if (energy > L.emergencyBoostMinEnergy) {
    if (inp.outsideZone) return true
    if (self.chargingExposed > 0 && best.chargingExposed < self.chargingExposed) return true
    if (inp.selfInSplash && !best.inSplash) return true
  }
  const n = inp.nearest
  const escaping = !!n && n.distToSelf < L.escapeEnemyM && dist2d(best.c.x, best.c.y, n.x, n.y) > n.distToSelf
  const cond = (self.exposedCount >= 1 && best.exposedCount < self.exposedCount) || escaping
  latch.isBoosting = cond && energy >= (latch.isBoosting ? L.coverBoostHoldEnergy : L.coverBoostStartEnergy)
  return latch.isBoosting
}
