/**
 * Arbiter. OWNER: Person A (single owner). Merges Economy + Combat + Locomotion into ONE schema-valid action and
 * is the only place that enforces the safety invariants, so a module bug can never emit an illegal action.
 */
import type { Action, Vec2 } from "./types/mechfight.ts"
import type { CombatOutput, EconomyOutput, LocomotionOutput } from "./types/contracts.ts"
import type { WorldModel } from "./world/world.ts"
import { clamp, isFiniteNum, normalizeAngle } from "./world/geom.ts"

export interface ArbiterInput {
  tick: number
  world: WorldModel
  economy: EconomyOutput
  combat: CombatOutput
  locomotion: LocomotionOutput
}

const finiteVec2 = (v: unknown): v is Vec2 => Array.isArray(v) && v.length === 2 && isFiniteNum(v[0]) && isFiniteNum(v[1])

/** Clamp a move vector to length <= 1; garbage becomes standing still. */
export function clampMove(v: unknown): Vec2 {
  if (!finiteVec2(v)) return [0, 0]
  const len = Math.hypot(v[0], v[1])
  return len > 1 ? [v[0] / len, v[1] / len] : [v[0], v[1]]
}

/** Wrap yaw to (-PI, PI] and clamp pitch to the mech's pitch limits. */
export function clampAim(v: unknown, minPitch: number, maxPitch: number): Vec2 | undefined {
  if (!finiteVec2(v)) return undefined
  return [normalizeAngle(v[0]), clamp(v[1], minPitch, maxPitch)]
}

export function laserChargingInSlot(world: WorldModel, slot: number): boolean {
  const w = world.obs?.self.weapons[slot]
  return !!w && w.kind === "laser" && (w.charge ?? 0) > 0
}

export function mergeAction(inp: ArbiterInput): Action {
  const { tick, world, economy, combat, locomotion } = inp
  const action: Action = { tick }

  // --- legs
  let move = clampMove(locomotion.move)
  let boost = locomotion.boost === true
  let jump = locomotion.jump === true
  if (combat.moveConstraint === "HOLD_POSITION") {
    move = [0, 0]
    boost = false
    jump = false
  }
  action.move = move
  action.boost = boost
  action.jump = jump

  // --- torso: Combat owns aim; with no target, face the threat (rear hits deal x rear_mult)
  let aim: unknown = combat.aim
  if (!combat.hasTarget && isFiniteNum(combat.threatBearing)) aim = [combat.threatBearing, 0]
  const clamped = clampAim(aim, world.rules.minPitch, world.rules.maxPitch)
  if (clamped) action.aim = clamped
  action.fire = [combat.fire[0] === true, combat.fire[1] === true]
  action.reload = combat.reload === true

  // --- economy
  const offer = world.obs?.offer
  if (offer && Number.isInteger(economy.pick) && (economy.pick as number) >= 0 && (economy.pick as number) < offer.choices.length) {
    action.pick = economy.pick as number
  }
  let take = isFiniteNum(economy.take) && Number.isInteger(economy.take) ? economy.take : undefined
  let drop: 0 | 1 | undefined = economy.drop === 0 || economy.drop === 1 ? economy.drop : undefined
  // Never drop (or swap out) a laser that is charging: the server refuses it ("busy") and the charge is wasted.
  if (drop !== undefined && laserChargingInSlot(world, drop)) {
    drop = undefined
    take = undefined
  }
  if (take !== undefined) action.take = take
  if (drop !== undefined) action.drop = drop
  return action
}

/** Final line check: <= max_line_bytes (drop debug, then fall back to the minimal valid action). */
export function fitToLine(action: Action, maxBytes: number): Action {
  const size = (a: Action): number => Buffer.byteLength(JSON.stringify(a), "utf8")
  if (size(action) <= maxBytes) return action
  if (action.debug !== undefined) {
    const { debug: _debug, ...rest } = action
    if (size(rest) <= maxBytes) return rest
  }
  return { tick: action.tick }
}
