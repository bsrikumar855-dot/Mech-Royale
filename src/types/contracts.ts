/**
 * Cross-owner contracts (Person A freezes these before the 3 PM handoff).
 * Hand-written, separate from the GENERATED ./mechfight.ts. Changing a shape = both owners agree first.
 *
 * SURVIVAL FIRST: score is mean(16 - place). Placement counts; kills do not. Never take a risky trade.
 */
import type { Action, Vec2, Vec3 } from "./mechfight.ts"
import type { WorldModel } from "../world/world.ts"
import type { MapQuery } from "../world/map.ts"
import type { Deadline } from "../runtime/deadline.ts"

export type BotAction = Action

export type LootKind = "cube" | "crate" | "npc" | "weapon" | "supply_drop"

/** Where something worth walking to is. `value` is Economy's own unit; Locomotion only compares them. */
export interface LootTarget {
  x: number
  y: number
  z: number
  value: number
  kind: LootKind
}

/** Combat -> Arbiter: what weapon mechanics demand of the legs.
 *  NONE: legs free. HOLD_POSITION: arbiter zeroes move/boost/jump. FACE_TARGET: legs free, but torso aim stays Combat's. */
export type MoveConstraint = "NONE" | "HOLD_POSITION" | "FACE_TARGET"

export interface EconomyOutput {
  pick?: number
  take?: number
  drop?: 0 | 1
  lootTargets: LootTarget[]
}

export interface CombatOutput {
  /** Desired [yaw, pitch] (radians). The torso slews toward it; shots leave along the ACTUAL aim. */
  aim: Vec2
  fire: [boolean, boolean]
  reload: boolean
  moveConstraint: MoveConstraint
  /** True while Combat is deliberately aiming at something. False lets the Arbiter apply defensive facing. */
  hasTarget: boolean
  /** World-frame yaw toward the primary threat (damage bearing / sound), for rear-armor-safe facing. */
  threatBearing?: number
}

export interface LocomotionOutput {
  move: Vec2
  boost: boolean
  jump: boolean
}

export interface TickContext {
  world: WorldModel
  /** null when the map failed to load: modules must degrade, never throw. */
  map: MapQuery | null
  deadline: Deadline
}

export interface Economy {
  decide(ctx: TickContext): EconomyOutput
}
export interface Combat {
  decide(ctx: TickContext): CombatOutput
}
export interface Locomotion {
  decide(ctx: TickContext, loot: readonly LootTarget[]): LocomotionOutput
}

export type { Vec2, Vec3 }
