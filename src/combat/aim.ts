import { COMBAT } from "../config/index.ts"
import type { Vec2, Vec3 } from "../types/mechfight.ts"

/** [yaw, pitch] pointing from `from` to `to` (yaw 0 = east, counter-clockwise; pitch up-positive). */
export function aimAt(from: readonly number[], to: readonly number[]): Vec2 {
  const dx = (to[0] as number) - (from[0] as number)
  const dy = (to[1] as number) - (from[1] as number)
  const dz = (to[2] as number) - (from[2] as number)
  return [Math.atan2(dy, dx), Math.atan2(dz, Math.hypot(dx, dy))]
}

/**
 * Intercept point for a projectile of constant speed fired from `muzzle` at a target moving with constant velocity.
 * Fixed-point iteration on the flight time (target speed << projectile speed, so it converges in 2-3 steps). The gun
 * flies straight (no drop). Flight time is capped so a bad velocity can never aim us at the horizon.
 */
export function leadPoint(muzzle: readonly number[], pos: readonly number[], vel: readonly number[], speed: number): Vec3 {
  const dist = (p: readonly number[]): number => Math.hypot((p[0] as number) - (muzzle[0] as number), (p[1] as number) - (muzzle[1] as number), (p[2] as number) - (muzzle[2] as number))
  if (!(speed > 0)) return [pos[0] as number, pos[1] as number, pos[2] as number]
  let t = dist(pos) / speed
  let p: Vec3 = [pos[0] as number, pos[1] as number, pos[2] as number]
  for (let i = 0; i < COMBAT.leadIterations; i++) {
    t = Math.min(t, COMBAT.leadMaxTimeS)
    p = [(pos[0] as number) + (vel[0] as number) * t, (pos[1] as number) + (vel[1] as number) * t, (pos[2] as number) + (vel[2] as number) * t]
    t = dist(p) / speed
  }
  return p
}
