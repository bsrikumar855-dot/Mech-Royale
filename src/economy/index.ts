/**
 * OWNER: Person B. Economy: offer picking, weapon take/swap, and valuing loot into LootTarget[].
 * Contract: src/types/contracts.ts (EconomyOutput). Read-only access to WorldModel. Never throws past decide().
 *
 * Rules (survival first: placement counts, kills do not):
 *  - pick: whenever an offer is pending, choose the best-ranked choice by ECONOMY.upgradePriority.
 *  - take: laser, lightning or mortar (in that preference order) into an EMPTY slot, within loot.pickup_radius
 *    (horizontal) and 4 m (vertical).
 *  - swap (v3, submission 29): both slots full, a pickup we do not hold and no enemy mech within swapNoEnemyM ->
 *    trade out whichever held non-gun weapon ranks WORST in takeKinds, as long as the pickup ranks strictly
 *    better. Generalizes the old lightning-for-laser-only rule: previously a held mortar had no swap path at all
 *    (it could only sit in the slot forever once taken), which v2 (submission 22) found was a likely real cost.
 *    (The Arbiter independently refuses any drop of a slot whose laser is charging.)
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

const preference = (kind: string): number => {
  const i = ECONOMY.takeKinds.indexOf(kind)
  return i === -1 ? Infinity : i
}

/** The non-gun weapon we hold with the worst (highest) takeKinds preference rank, and its slot, if any. */
function worstHeldSwappable(self: SelfObs): { slot: 0 | 1; pref: number } | null {
  let worst: { slot: 0 | 1; pref: number } | null = null
  self.weapons.forEach((w, i) => {
    if (!w || w.kind === "gun") return
    const pref = preference(w.kind)
    if (!worst || pref > worst.pref) worst = { slot: i as 0 | 1, pref }
  })
  return worst
}

/**
 * Would we swap a held weapon for this pickup, and which slot? Both slots full, a kind we do not already hold,
 * strictly better ranked (in takeKinds) than the worst non-gun weapon we currently carry. Null if no swap applies.
 */
export function wantsSwap(self: SelfObs, p: PickupObs): { slot: 0 | 1 } | null {
  if (hasEmptySlot(self) || heldKinds(self).includes(p.kind)) return null
  const pPref = preference(p.kind)
  if (pPref === Infinity) return null
  const worst = worstHeldSwappable(self)
  if (!worst || pPref >= worst.pref) return null
  return { slot: worst.slot }
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
        if (swap) take.drop = swap.slot
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
