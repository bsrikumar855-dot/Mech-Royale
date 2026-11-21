/**
 * OWNER: Person B. Economy: offer picking, weapon take/drop, and valuing loot into LootTarget[].
 * Contract: src/types/contracts.ts (EconomyOutput). Read-only access to WorldModel. Never throws past decide().
 *
 * STUB: inert passthrough so the pipeline runs end to end. (With no pick, the server applies choice 0 after the
 * offer expires, which is safe.) SURVIVAL FIRST: placement counts, kills do not; value loot that is safe to reach.
 */
import type { Economy, EconomyOutput, TickContext } from "../types/contracts.ts"

export class StubEconomy implements Economy {
  decide(_ctx: TickContext): EconomyOutput {
    return { lootTargets: [] }
  }
}
