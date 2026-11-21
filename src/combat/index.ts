/**
 * OWNER: Person B. Combat: aim, fire, reload, MoveConstraint, threat bearing.
 * Contract: src/types/contracts.ts (CombatOutput). Read-only access to WorldModel. Never throws past decide().
 *
 * Mechanics to respect (all numbers from world.config.weapons / self.weapons[i].stats, never hardcoded):
 *  - Shots leave along the ACTUAL slewed self.aim, not the commanded one.
 *  - gun: projectile (lead moving targets); mortar: ballistic arc + 50% self-splash + concussion;
 *    laser: hold trigger to charge, release to fire, half speed while charging; lightning: cone + energy cost.
 *  - Rear hits deal x rear_mult: when there is no target, return hasTarget=false and a threatBearing so the
 *    Arbiter can face the threat. SURVIVAL FIRST: placement counts, kills do not.
 *
 * STUB: holds the current aim and never fires.
 */
import type { Combat, CombatOutput, TickContext } from "../types/contracts.ts"

export class StubCombat implements Combat {
  decide(ctx: TickContext): CombatOutput {
    return {
      aim: [ctx.world.self.aim[0], ctx.world.self.aim[1]],
      fire: [false, false],
      reload: false,
      moveConstraint: "NONE",
      hasTarget: false,
    }
  }
}
