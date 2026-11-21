/** Shared shapes for the Phase 2 tactical locomotion scorer. OWNER: Person A. */
import type { Vec2 } from "../types/mechfight.ts"

export type P3 = readonly [number, number, number]

export type CandidateKind = "hold" | "goal" | "tangent" | "loot" | "ring"

/** A place we could walk to this decision. (dx, dy) is the offset from us; z is the feet height we would stand at. */
export interface Candidate {
  x: number
  y: number
  z: number
  dx: number
  dy: number
  dist: number
  kind: CandidateKind
  /** tangent slides only: +1 = rotated counter-clockwise from the goal bearing, -1 = clockwise */
  side?: number
}

/** A tracked enemy mech, pre-digested so the per-candidate loop does no lookups. */
export interface Threat {
  id: number
  x: number
  y: number
  /** feet height */
  z: number
  /** enemy muzzle height in world z (cube-scaled) */
  muzzleZ: number
  aimYaw: number
  charging: boolean
  hasLaser: boolean
  hasLightning: boolean
  /** horizontal distance to us */
  distToSelf: number
}

/** Where an airborne mortar shell will land, and the radius around it we must not be in. */
export interface MortarImpact {
  x: number
  y: number
  t: number
  radius: number
}

/** A visible bullet's path over the next bulletHorizonS seconds. */
export interface BulletPath {
  ax: number
  ay: number
  az: number
  bx: number
  by: number
  bz: number
}

/** The mech body used for walkability and exposure (cube-scaled). */
export interface Body {
  radius: number
  height: number
  stepUp: number
}

/** A candidate after scoring. `terms` is the per-factor breakdown (tests and debugging read it). */
export interface Scored {
  c: Candidate
  score: number
  exposedCount: number
  exposure: number
  chargingExposed: number
  midExposed: number
  inSplash: boolean
  terms: Record<string, number>
}

export type { Vec2 }
