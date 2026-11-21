/**
 * OWNER: Person B. Economy: offer picking, weapon take, and valuing loot into LootTarget[].
 * Contract: src/types/contracts.ts (EconomyOutput). Read-only access to WorldModel. Never throws past decide().
 *
 * v1 rules (survival first: placement counts, kills do not):
 *  - pick: whenever an offer is pending, choose the best-ranked choice by ECONOMY.upgradePriority.
 *  - take: ONLY lightning, ONLY into an EMPTY slot, ONLY within loot.pickup_radius (horizontal) and 4 m (vertical).
 *    mortar (cook-off exposure, no ballistics yet) and laser are skipped on purpose.
 *  - lootTargets: visible cubes, plus lightning pickups while slot 1 could take one; value falls with distance.
 */
import { ECONOMY } from "../config/index.ts"
import type { Economy, EconomyOutput, LootTarget, TickContext } from "../types/contracts.ts"
import type { OfferChoice, PickupObs, SelfObs } from "../types/mechfight.ts"

/** Index of the best choice by priority (unlisted ids rank last; ties keep the server's order). Undefined if none. */
export function bestUpgradeIndex(choices: readonly OfferChoice[]): number | undefined {
  let best: number | undefined
  let bestRank = Infinity
  choices.forEach((c, i) => {
    const r = ECONOMY.upgradePriority.indexOf(c.id)
    const rank = r === -1 ? ECONOMY.upgradePriority.length : r
    if (rank < bestRank) {
      bestRank = rank
      best = i
    }
  })
  return best
}

const heldKinds = (self: SelfObs): string[] => self.weapons.flatMap((w) => (w ? [w.kind] : []))
const hasEmptySlot = (self: SelfObs): boolean => self.weapons.some((w) => w === null)

/** Would we take this pickup if we were standing on it? (right kind, free slot, not already held) */
export function wantsPickup(self: SelfObs, p: PickupObs): boolean {
  return ECONOMY.takeKinds.includes(p.kind) && hasEmptySlot(self) && !heldKinds(self).includes(p.kind)
}

const horiz = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(bx - ax, by - ay)
const valueAt = (base: number, dist: number): number => base / (1 + dist / ECONOMY.halfValueDistanceM)

export class RuleEconomy implements Economy {
  decide(ctx: TickContext): EconomyOutput {
    const { world } = ctx
    const obs = world.obs
    if (!obs) return { lootTargets: [] }
    const self = world.self
    const [sx, sy, sz] = self.pos
    const out: EconomyOutput = { lootTargets: [] }

    if (obs.offer) {
      const i = bestUpgradeIndex(obs.offer.choices)
      if (i !== undefined) out.pick = i
    }

    const reach = world.config.loot.pickup_radius
    let takeDist = Infinity
    for (const p of obs.pickups ?? []) {
      if (!wantsPickup(self, p)) continue
      const d = horiz(sx, sy, p.pos[0], p.pos[1])
      if (d <= reach && Math.abs(p.pos[2] - sz) <= ECONOMY.pickupVerticalM && d < takeDist) {
        takeDist = d
        out.take = p.id
      }
      out.lootTargets.push(target(p.pos, valueAt(ECONOMY.lootBaseValue["weapon"] ?? 0, d), "weapon"))
    }
    for (const c of obs.cubes ?? []) {
      out.lootTargets.push(target(c.pos, valueAt(ECONOMY.lootBaseValue["cube"] ?? 0, horiz(sx, sy, c.pos[0], c.pos[1])), "cube"))
    }
    return out
  }
}

function target(pos: readonly [number, number, number], value: number, kind: LootTarget["kind"]): LootTarget {
  return { x: pos[0], y: pos[1], z: pos[2], value, kind }
}
