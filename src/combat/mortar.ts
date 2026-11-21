/**
 * OWNER: Person B. Mortar ballistics: the only weapon with real projectile motion (gravity, flight time), so it is
 * the one place in combat/ that solves an arc instead of a straight line (gun) or a flat lead point (gun/laser).
 *
 * v1 (submission 17, reverted -0.07): lobbed at the same single LOS mech target the rest of Combat already picked.
 * Diagnosed cause of the loss: it never sought out clustered enemies, so the splash-vs-convergence upside the whole
 * idea was built on was incidental, not engineered -- most shots landed on a lone target a gun burst would have
 * handled as well or better.
 *
 * v2 (submission 22, reverted -0.08): mortar now ONLY ever fires at a cluster of 2+ visible enemy mechs (bestCluster
 * below) -- never a lone target, closing exactly the gap v1 left. Still a regression. Diagnosed cause this time:
 * economy/index.ts's wantsSwap had no path to trade a held mortar away for a better weapon later (lightning could
 * only ever be replaced by a laser), so taking one opportunistically could waste the one empty slot for the rest
 * of the match -- a cost independent of whether the clustering logic itself works.
 *
 * v3 (submission 29): the firing logic here is unchanged from v2 (still cluster-only, still LOS-only, still within
 * mortarMaxRangeM -- an unseen, memory-only target stays a known limitation, needing the arc checked against the
 * map, not just a muzzle-to-target LOS test). The fix is economy-side: wantsSwap is now generalized to trade any
 * held non-gun weapon for a strictly-better-ranked pickup, so a held mortar can be swapped out for a laser or
 * lightning later instead of being stuck for good.
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

export interface ClusterCand {
  pos: readonly [number, number, number]
  vel: readonly [number, number, number]
  /** muzzle-to-centre-of-mass distance, for the range filter. */
  dist: number
}

/**
 * The densest group of 2+ candidates within `clusterRadiusM` of each other, among those within `maxRangeM` of the
 * muzzle. O(n^2) (n = visible enemy mechs, at most 15): for each candidate, count how many others (including
 * itself) fall within clusterRadiusM of it; keep the largest such group (first found wins a tie). Returns the
 * group's centroid position and average velocity (a simple collective lead -- see mortarSolve's own header for why
 * a constant-velocity assumption is an accepted limitation already, same as the gun's leadPoint).
 * Null when fewer than 2 candidates are in range, or none has another in range of it (no real cluster exists).
 */
export function bestCluster(cands: readonly ClusterCand[], clusterRadiusM: number, maxRangeM: number): { centroid: Vec3; avgVel: Vec3; size: number } | null {
  const inRange = cands.filter((c) => c.dist <= maxRangeM)
  let bestMembers: readonly ClusterCand[] | null = null
  for (const anchor of inRange) {
    const members = inRange.filter((c) => Math.hypot(c.pos[0] - anchor.pos[0], c.pos[1] - anchor.pos[1], c.pos[2] - anchor.pos[2]) <= clusterRadiusM)
    if (members.length >= 2 && (!bestMembers || members.length > bestMembers.length)) bestMembers = members
  }
  if (!bestMembers) return null
  const n = bestMembers.length
  const sum = (f: (c: ClusterCand) => number): number => bestMembers!.reduce((s, c) => s + f(c), 0)
  return {
    centroid: [sum((c) => c.pos[0]) / n, sum((c) => c.pos[1]) / n, sum((c) => c.pos[2]) / n],
    avgVel: [sum((c) => c.vel[0]) / n, sum((c) => c.vel[1]) / n, sum((c) => c.vel[2]) / n],
    size: n,
  }
}
