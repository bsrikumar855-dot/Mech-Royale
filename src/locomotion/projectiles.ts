/**
 * Incoming fire we can still dodge: airborne mortar shells (predict the impact point by stepping the parabola
 * against terrain and buildings) and visible bullets (the corridor they sweep in the next fraction of a second).
 */
import { LOCOMOTION as L } from "../config/index.ts"
import type { Observation } from "../types/mechfight.ts"
import type { BulletPath, MortarImpact } from "./types.ts"

export interface MortarPhysics {
  gravity: number
  splashRadius: number
  ttl: number
}

/** Predicted impacts of every visible mortar shell that lands within the horizon. */
export function predictMortars(
  obs: Observation,
  phys: MortarPhysics,
  ourRadius: number,
  isSolid: (x: number, y: number, z: number) => boolean,
): MortarImpact[] {
  const out: MortarImpact[] = []
  const horizon = Math.min(L.mortarHorizonS, phys.ttl > 0 ? phys.ttl : L.mortarHorizonS)
  const radius = phys.splashRadius + ourRadius + L.mortarMarginM
  for (const p of obs.projectiles ?? []) {
    if (p.kind !== "mortar") continue
    const [x0, y0, z0] = p.pos
    const [vx, vy, vz] = p.vel
    for (let t = L.mortarStepS; t <= horizon + 1e-9; t += L.mortarStepS) {
      const x = x0 + vx * t
      const y = y0 + vy * t
      const z = z0 + vz * t - 0.5 * phys.gravity * t * t
      if (isSolid(x, y, z)) {
        out.push({ x, y, t, radius })
        break
      }
    }
  }
  return out
}

/** Bullet (gun / npc) paths over the next bulletHorizonS. */
export function bulletPaths(obs: Observation): BulletPath[] {
  const out: BulletPath[] = []
  for (const p of obs.projectiles ?? []) {
    if (p.kind !== "gun" && p.kind !== "npc") continue
    const h = L.bulletHorizonS
    out.push({ ax: p.pos[0], ay: p.pos[1], az: p.pos[2], bx: p.pos[0] + p.vel[0] * h, by: p.pos[1] + p.vel[1] * h, bz: p.pos[2] + p.vel[2] * h })
  }
  return out
}

/** Does a mech standing at (x, y) with feet z and the given height sit inside the bullet's corridor? */
export function bulletHits(b: BulletPath, x: number, y: number, feet: number, height: number, corridor: number): boolean {
  const dx = b.bx - b.ax
  const dy = b.by - b.ay
  const len2 = dx * dx + dy * dy
  const s = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((x - b.ax) * dx + (y - b.ay) * dy) / len2))
  const cx = b.ax + dx * s
  const cy = b.ay + dy * s
  if (Math.hypot(x - cx, y - cy) > corridor) return false
  const bz = b.az + (b.bz - b.az) * s
  return bz >= feet - corridor && bz <= feet + height + corridor
}
