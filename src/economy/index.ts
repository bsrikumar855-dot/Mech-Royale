/**
 * OWNER: Person B. Economy: offer picking, weapon take/swap, and valuing loot into LootTarget[].
 * Contract: src/types/contracts.ts (EconomyOutput). Read-only access to WorldModel. Never throws past decide().
 *
 * Rules (survival first: placement counts, kills do not):
 *  - pick: whenever an offer is pending, choose the best-ranked choice by ECONOMY.upgradePriority.
 *  - take: laser, lightning or mortar (in that preference order) into an EMPTY slot, within loot.pickup_radius
 *    (horizontal) and 4 m (vertical). Mortar is lowest preference: Combat only lobs it at a cluster of 2+ visible
 *    enemy mechs within mortarMaxRangeM (see combat/mortar.ts), so it is a fine third weapon but not worth
 *    swapping a laser or lightning away for.
 *  - swap: holding lightning, a laser in reach and no enemy mech within swapNoEnemyM -> take the laser, drop the
 *    lightning's slot. (The Arbiter independently refuses any drop of a slot whose laser is charging.)
 *  - lootTargets: visible cubes, pickups we would take or swap to, and uncontested supply drops landing within
 *    10 s and 45 m; value falls with distance.
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

/** Would we pick this up into an empty slot? (a kind we take, a free slot, not already held) */
export function wantsPickup(self: SelfObs, p: PickupObs): boolean {
  return ECONOMY.takeKinds.includes(p.kind) && hasEmptySlot(self) && !heldKinds(self).includes(p.kind)
}

/** Would we swap our lightning for this pickup? (a laser, both slots full, holding lightning, no laser yet) */
export function wantsSwap(self: SelfObs, p: PickupObs): boolean {
  const held = heldKinds(self)
  return p.kind === "laser" && !hasEmptySlot(self) && held.includes("lightning") && !held.includes("laser")
}

const horiz = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(bx - ax, by - ay)
const valueAt = (base: number, dist: number): number => base / (1 + dist / ECONOMY.halfValueDistanceM)
const preference = (kind: string): number => {
  const i = ECONOMY.takeKinds.indexOf(kind)
  return i === -1 ? Infinity : i
}

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
    const enemyClose = (obs.mechs ?? []).some((m) => m.kind === "mech" && horiz(sx, sy, m.pos[0], m.pos[1]) < ECONOMY.swapNoEnemyM)
    let take: { id: number; pref: number; d: number; drop?: 0 | 1 } | null = null
    for (const p of obs.pickups ?? []) {
      const fill = wantsPickup(self, p)
      const swap = wantsSwap(self, p)
      if (!fill && !swap) continue
      const d = horiz(sx, sy, p.pos[0], p.pos[1])
      out.lootTargets.push(target(p.pos, valueAt(ECONOMY.lootBaseValue[p.kind] ?? 0, d), "weapon"))
      if (d > reach || Math.abs(p.pos[2] - sz) > ECONOMY.pickupVerticalM) continue
      if (swap && enemyClose) continue
      const pref = preference(p.kind)
      if (!take || pref < take.pref || (pref === take.pref && d < take.d)) {
        take = { id: p.id, pref, d }
        if (swap) {
          const slot = self.weapons.findIndex((w) => w?.kind === "lightning")
          if (slot === 0 || slot === 1) take.drop = slot
        }
      }
    }
    if (take) {
      out.take = take.id
      if (take.drop !== undefined) out.drop = take.drop
    }
    for (const c of obs.cubes ?? []) {
      out.lootTargets.push(target(c.pos, valueAt(ECONOMY.lootBaseValue["cube"] ?? 0, horiz(sx, sy, c.pos[0], c.pos[1])), "cube"))
    }
    // Supply drops (3 cubes + full HP + full energy): only uncontested ones that land soon and are close.
    for (const d of obs.drops ?? []) {
      const dist = horiz(sx, sy, d.pos[0], d.pos[1])
      const free = d.holder === null || d.holder === self.id
      if (free && d.lands_in <= ECONOMY.dropMaxLandsInS && dist <= ECONOMY.dropRangeM) {
        out.lootTargets.push(target(d.pos, valueAt(ECONOMY.lootBaseValue["supply_drop"] ?? 0, dist), "supply_drop"))
      }
    }
    return out
  }
}

function target(pos: readonly [number, number, number], value: number, kind: LootTarget["kind"]): LootTarget {
  return { x: pos[0], y: pos[1], z: pos[2], value, kind }
}
