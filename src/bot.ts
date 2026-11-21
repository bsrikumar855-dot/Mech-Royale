/**
 * Bot: the per-tick pipeline. OWNER: Person A.
 * world.update -> economy -> combat -> locomotion -> arbiter. Each module is fault-isolated: a throw in one falls
 * back to that module's neutral output so the others still act. A world.update failure propagates to Session,
 * which answers with its crash fallback (last good move/aim, see session.ts).
 */
import { mergeAction } from "./arbiter.ts"
import { RuleCombat } from "./combat/index.ts"
import { RuleEconomy } from "./economy/index.ts"
import { RuleLocomotion } from "./locomotion/index.ts"
import { warn } from "./runtime/log.ts"
import type { Deadline } from "./runtime/deadline.ts"
import type { Combat, CombatOutput, Economy, EconomyOutput, Locomotion, LocomotionOutput, TickContext } from "./types/contracts.ts"
import type { Action, Observation } from "./types/mechfight.ts"
import type { MapQuery } from "./world/map.ts"
import type { WorldModel } from "./world/world.ts"

export interface Modules {
  economy: Economy
  combat: Combat
  locomotion: Locomotion
}

export const defaultModules = (): Modules => ({ economy: new RuleEconomy(), combat: new RuleCombat(), locomotion: new RuleLocomotion() })

export class Bot {
  readonly world: WorldModel
  readonly map: MapQuery | null
  readonly modules: Modules

  constructor(world: WorldModel, map: MapQuery | null, modules: Modules = defaultModules()) {
    this.world = world
    this.map = map
    this.modules = modules
  }

  decide(obs: Observation, deadline: Deadline): Action {
    this.world.update(obs) // a throw here propagates: Session answers with its crash fallback
    const ctx: TickContext = { world: this.world, map: this.map, deadline }

    const economy = this.guard<EconomyOutput>("economy", () => this.modules.economy.decide(ctx), { lootTargets: [] })
    const combat = this.guard<CombatOutput>("combat", () => this.modules.combat.decide(ctx), {
      aim: [obs.self.aim[0], obs.self.aim[1]],
      fire: [false, false],
      reload: false,
      moveConstraint: "NONE",
      hasTarget: false,
    })
    const locomotion = this.guard<LocomotionOutput>("locomotion", () => this.modules.locomotion.decide(ctx, economy.lootTargets), {
      move: [0, 0],
      boost: false,
      jump: false,
    })
    return mergeAction({ tick: obs.tick, world: this.world, economy, combat, locomotion })
  }

  private guard<T>(name: string, fn: () => T, neutral: T): T {
    try {
      return fn()
    } catch (e) {
      warn(`${name} threw`, e)
      return neutral
    }
  }
}
