/**
 * OWNER: Person A. Locomotion: world + map + LootTarget[] -> move / boost / jump.
 * Contract: src/types/contracts.ts (LocomotionOutput). Never throws past decide().
 *
 * Phase 1 (rules): zone safety using world.zoneAt(); Phase 2 (utility scoring + hysteresis) is DEFERRED
 * until v1 has a measured score.
 *
 * STUB: stands still. (A standing mech is a sitting target; Phase 1 replaces this with zone-aware movement.)
 */
import type { Locomotion, LocomotionOutput, LootTarget, TickContext } from "../types/contracts.ts"

export class StubLocomotion implements Locomotion {
  decide(_ctx: TickContext, _loot: readonly LootTarget[]): LocomotionOutput {
    return { move: [0, 0], boost: false, jump: false }
  }
}
