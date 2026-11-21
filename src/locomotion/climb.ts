/**
 * Locomotion v4: ledge and rooftop climbing. Protocol: ledges above step_up are walls "unless your feet are already
 * above it: jump and jet (boost in the air) until they clear the edge, then move over it".
 *
 * State machine (one target at a time, per-match state in LocoState.climb):
 *   rise: grounded -> jump (no boost); airborne below top + climbReleaseAboveM -> boost (jets) toward the edge
 *   land: at/above top + climbReleaseAboveM -> release boost, keep steering onto the top for climbLandS, then done
 *   abort: energy < climbAbortEnergy, climb older than climbTimeoutS, or a mortar shell predicted to land on the spot
 * Triggers:
 *   A ledge: the desired heading is blocked by a step whose walkable top is step_up..ledgeMaxRiseM above our feet
 *   B roof:  heavy pressure, a building roof roofMinRiseM..roofMaxRiseM above us within roofSearchM, in the safe zone
 * Both need open sky above us (no bridge/eave stops the jet) and headroom on the top.
 */
import { LOCOMOTION as L } from "../config/index.ts"
import type { LocomotionOutput } from "../types/contracts.ts"
import type { Vec2 } from "../types/mechfight.ts"
import { dist2d } from "../world/geom.ts"
import type { MapQuery } from "../world/map.ts"
import type { WorldModel } from "../world/world.ts"
import type { Sensed } from "./sense.ts"
import { bodyOf } from "./steer.ts"

export type ClimbKind = "ledge" | "roof"

export interface ClimbTarget {
  kind: ClimbKind
  /** landing point on the top */
  x: number
  y: number
  /** height of the walkable top */
  top: number
}

export class ClimbState {
  active: ClimbTarget | null = null
  phase: "rise" | "land" = "rise"
  startT = Number.NEGATIVE_INFINITY
  landUntilT = Number.NEGATIVE_INFINITY
  /** last outcome, for tests and audits */
  last: "none" | "started" | "rise-jump" | "rise-jet" | "land" | "done" | "abort-energy" | "abort-timeout" | "abort-mortar" | "abort-zone" = "none"

  reset(): void {
    this.active = null
    this.phase = "rise"
    this.startT = Number.NEGATIVE_INFINITY
    this.landUntilT = Number.NEGATIVE_INFINITY
    this.last = "none"
  }

  start(target: ClimbTarget, t: number): void {
    this.active = target
    this.phase = "rise"
    this.startT = t
    this.landUntilT = Number.NEGATIVE_INFINITY
    this.last = "started"
  }

  abort(why: ClimbState["last"]): void {
    this.active = null
    this.phase = "rise"
    this.last = why
  }
}

/** Open sky above our feet for a jet of `rise` metres (a bridge deck or an eave stops it)? */
function skyClear(map: MapQuery, world: WorldModel, rise: number): boolean {
  const [x, y, z] = world.self.pos
  return map.overheadClearance(x, y, z) >= rise + bodyOf(world).height
}

/** Can a mech stand at (x, y) on a top at height `top` (headroom, no wall overlapping the body)? */
function canStandOn(map: MapQuery, world: WorldModel, x: number, y: number, top: number): boolean {
  const body = bodyOf(world)
  return map.overheadClearance(x, y, top) >= body.height && !map.isBlockedAt(x, y, top, body)
}

/** Trigger A: the heading `d` runs into a ledge we can jump-jet over. */
export function findLedge(map: MapQuery, world: WorldModel, d: Vec2): ClimbTarget | null {
  const [px, py, pz] = world.self.pos
  const body = bodyOf(world)
  for (const k of [0.5, 1, 1.5]) {
    const qx = px + d[0] * L.ledgeProbeM * k
    const qy = py + d[1] * L.ledgeProbeM * k
    // highest walkable surface at most ledgeMaxRiseM above our feet with headroom (a taller wall yields a lower one)
    const top = map.standingHeightAt(qx, qy, pz + L.ledgeMaxRiseM, 0, body.height)
    const rise = top - pz
    if (rise <= body.stepUp || rise > L.ledgeMaxRiseM) continue
    if (!skyClear(map, world, rise)) return null
    // land a little past the edge if that spot is on the same top, else on the edge sample itself
    const lx = qx + d[0] * L.climbLandInsetM
    const ly = qy + d[1] * L.climbLandInsetM
    const landTop = map.standingHeightAt(lx, ly, top + body.stepUp, body.stepUp, body.height)
    if (Math.abs(landTop - top) <= body.stepUp && canStandOn(map, world, lx, ly, landTop)) return { kind: "ledge", x: lx, y: ly, top: Math.max(top, landTop) }
    if (canStandOn(map, world, qx, qy, top)) return { kind: "ledge", x: qx, y: qy, top }
  }
  return null
}

/** Trigger B: an adjacent building roof to escape onto (nearest and lowest first, inside the safe zone). */
export function findRoof(map: MapQuery, world: WorldModel, inSafe: (x: number, y: number) => boolean): ClimbTarget | null {
  const [px, py, pz] = world.self.pos
  let best: ClimbTarget | null = null
  let bestCost = Infinity
  for (let k = 0; k < L.roofSearchBearings; k++) {
    const a = (k / L.roofSearchBearings) * Math.PI * 2
    const u: Vec2 = [Math.cos(a), Math.sin(a)]
    for (const r of L.roofSearchM) {
      const qx = px + u[0] * r
      const qy = py + u[1] * r
      let top: number | null = null
      for (const p of map.prismsAt(qx, qy)) {
        if (p.kind !== "building") continue
        if (p.top >= pz + L.roofMinRiseM && p.top <= pz + L.roofMaxRiseM && (top === null || p.top > top)) top = p.top
      }
      if (top === null || !inSafe(qx, qy)) continue
      const cost = r + (top - pz) * 0.25
      if (cost >= bestCost || !canStandOn(map, world, qx, qy, top) || !skyClear(map, world, top - pz)) continue
      bestCost = cost
      best = { kind: "roof", x: qx, y: qy, top }
      break // the nearer search radius on this bearing already works
    }
  }
  return best
}

/** One decision of an active climb, or null when it finished / aborted (the caller then moves normally). */
export function climbStep(state: ClimbState, world: WorldModel, sn: Sensed): LocomotionOutput | null {
  const c = state.active
  if (!c) return null
  const self = world.self
  const t = world.t
  if (self.energy < L.climbAbortEnergy) {
    state.abort("abort-energy")
    return null
  }
  if (t - state.startT > L.climbTimeoutS + L.climbTimeEpsS) {
    state.abort("abort-timeout")
    return null
  }
  if (sn.mortarImpacts.some((m) => dist2d(m[0], m[1], c.x, c.y) < sn.mortarDangerM)) {
    state.abort("abort-mortar")
    return null
  }
  const [px, py, pz] = self.pos
  const d = dist2d(px, py, c.x, c.y)
  const move: Vec2 = d > 1e-6 ? [(c.x - px) / d, (c.y - py) / d] : [0, 0]

  if (state.phase === "rise" && pz >= c.top + L.climbReleaseAboveM) {
    state.phase = "land"
    state.landUntilT = t + L.climbLandS
  }
  if (state.phase === "land") {
    if (t >= state.landUntilT - L.climbTimeEpsS) {
      state.active = null
      state.phase = "rise"
      state.last = "done"
      return null
    }
    state.last = "land"
    return { move, boost: false, jump: false }
  }
  if (self.grounded) {
    if (pz >= c.top - bodyOf(world).stepUp) {
      // already standing on it (walked up, or landed between decisions)
      state.active = null
      state.last = "done"
      return null
    }
    state.last = "rise-jump"
    return { move, boost: false, jump: true }
  }
  state.last = "rise-jet"
  return { move, boost: pz < c.top + L.climbJetBelowAboveM, jump: false }
}
