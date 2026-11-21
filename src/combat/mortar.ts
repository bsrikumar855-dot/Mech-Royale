/**
 * OWNER: Person B. Mortar ballistics: the only weapon with real projectile motion (gravity, flight time), so it is
 * the one place in combat/ that solves an arc instead of a straight line (gun) or a flat lead point (gun/laser).
 *
 * v1 scope (deliberately conservative): mortar only ever engages the SAME line-of-sight mech target the rest of
 * Combat already picked (never an unseen, memory-only target), within COMBAT.mortarMaxRangeM, so the arc is short
 * and the straight-line velocity prediction stays reasonable. Firing over cover at an unseen target is a known v2
 * limitation (it would need the arc checked against the map, not just a muzzle-to-target LOS test).
 */
import { COMBAT } from "../config/index.ts"
import type { Vec2, Vec3 } from "../types/mechfight.ts"
import { clamp } from "../world/geom.ts"

/**
 * [yaw, pitch] and flight time (s) to land at (pos + vel * t) from `muzzle`, launched at `speed` under `gravity`.
 * Of the two ballistic solutions (low arc / high arc) for a given horizontal range, picks the flatter one so the
 * flight time (and so the window for the target to dodge) stays as short as possible; falls back to the other arc
 * only if the flatter one needs a pitch outside [minPitch, maxPitch].
 *
 * Fixed-point iteration on flight time (COMBAT.leadIterations steps, same style as leadPoint in aim.ts: the target's
 * speed is far below the shell's, so re-aiming at where it will be by the previous estimate converges fast).
 *
 * Null when no real solution exists within maxTimeS: out of range for this speed/gravity (the quadratic's
 * discriminant goes negative), or every valid root needs a pitch past the mech's own limits.
 */
export function mortarSolve(args: {
  muzzle: readonly number[]
  pos: readonly number[]
  vel: readonly number[]
  speed: number
  gravity: number
  maxTimeS: number
  minPitch: number
  maxPitch: number
}): { aim: Vec2; flightTimeS: number } | null {
  const { muzzle, pos, vel, speed, gravity, maxTimeS, minPitch, maxPitch } = args
  if (!(speed > 0) || !(gravity > 0) || !(maxTimeS > 0)) return null
  const mx = muzzle[0] as number
  const my = muzzle[1] as number
  const mz = muzzle[2] as number
  let t = Math.hypot((pos[0] as number) - mx, (pos[1] as number) - my) / speed
  let yaw = 0
  let pitch = 0
  let flight = 0
  for (let i = 0; i < COMBAT.leadIterations; i++) {
    t = Math.min(t, maxTimeS)
    const px = (pos[0] as number) + (vel[0] as number) * t
    const py = (pos[1] as number) + (vel[1] as number) * t
    const pz = (pos[2] as number) + (vel[2] as number) * t
    const dx = px - mx
    const dy = py - my
    const dz = pz - mz
    const range = Math.hypot(dx, dy)
    if (range < 1e-6) return null // directly overhead/underfoot: no horizontal launch solves this
    yaw = Math.atan2(dy, dx)
    // Standard projectile-to-point solve: dz = R*tan(p) - (g R^2 / (2 v^2))*(1 + tan(p)^2). Quadratic in u = tan(p).
    const a = (gravity * range * range) / (2 * speed * speed)
    const b = -range
    const c = dz + a
    const disc = b * b - 4 * a * c
    if (disc < 0) return null // target is out of range for this speed/gravity at any angle
    const sqrtD = Math.sqrt(disc)
    const roots = [(-b - sqrtD) / (2 * a), (-b + sqrtD) / (2 * a)].map((u) => Math.atan(u)).filter((p) => p >= minPitch && p <= maxPitch)
    if (roots.length === 0) return null // both arcs need a pitch outside the mech's pitch limits
    pitch = roots.reduce((lo, hi) => (Math.abs(lo) <= Math.abs(hi) ? lo : hi))
    const flightNow = range / (speed * Math.cos(pitch))
    if (!Number.isFinite(flightNow) || flightNow <= 0 || flightNow > maxTimeS) return null // would self-destruct (ttl) first
    flight = flightNow
    t = flightNow
  }
  return { aim: [yaw, pitch], flightTimeS: flight }
}

/** Where the shell actually lands: muzzle + the ballistic arc flown for `flightTimeS` at `aim`/`speed`/`gravity`. */
export function mortarImpact(muzzle: readonly number[], aim: Vec2, speed: number, gravity: number, flightTimeS: number): Vec3 {
  const [yaw, pitch] = aim
  const vx = speed * Math.cos(pitch) * Math.cos(yaw)
  const vy = speed * Math.cos(pitch) * Math.sin(yaw)
  const vz = speed * Math.sin(pitch)
  return [(muzzle[0] as number) + vx * flightTimeS, (muzzle[1] as number) + vy * flightTimeS, (muzzle[2] as number) + vz * flightTimeS - 0.5 * gravity * flightTimeS * flightTimeS]
}

/** Never fire if the blast would still reach our OWN current position (self_damage_mult hurts us too). */
export function mortarSafeToFire(selfPos: readonly number[], impact: readonly number[], splashRadius: number, marginM: number): boolean {
  const d = Math.hypot((impact[0] as number) - (selfPos[0] as number), (impact[1] as number) - (selfPos[1] as number), (impact[2] as number) - (selfPos[2] as number))
  return d > splashRadius + marginM
}

/** Fire tolerance: splash forgives a miss up to splashRadius, so the torso-alignment gate is far looser than the gun's. */
export function mortarFireTolerance(splashRadius: number, dist: number): number {
  return clamp(Math.atan2(splashRadius, Math.max(dist, 1e-6)), COMBAT.minFireAngleRad, COMBAT.mortarMaxAimErrorRad)
}
