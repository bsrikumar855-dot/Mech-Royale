/**
 * Threat model: the top-K most dangerous tracked enemy mechs (including memory-tracked ones within vision.memory_s),
 * and how much a given spot is worth to each of them (their field of view and the weapon they carry).
 */
import { LOCOMOTION as L } from "../config/index.ts"
import { angleDiff, dist2d, yawTo } from "../world/geom.ts"
import type { WorldModel } from "../world/world.ts"
import type { Threat } from "./types.ts"

export interface ThreatRules {
  nearRange: number
  fovDeg: number
  laserRange: number
  /** beyond this an enemy cannot hit us with anything it can hold */
  maxThreatRange: number
}

const num = (rec: Record<string, number | undefined> | undefined, key: string, fallback: number): number => {
  const v = rec?.[key]
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

export function threatRules(world: WorldModel): ThreatRules {
  const w = world.config.weapons
  const laserRange = num(w.laser, "range", 0)
  const gunRange = num(w.gun, "range", 0)
  return {
    nearRange: world.rules.nearRange,
    fovDeg: world.rules.fovDeg,
    laserRange,
    maxThreatRange: Math.max(gunRange, laserRange) * L.threatRangeMargin,
  }
}

export function sizeScale(world: WorldModel, cubes: number | undefined): number {
  const per = world.config.cubes["size_per_cube"]
  return 1 + (typeof per === "number" ? per : 0) * Math.max(0, cubes ?? 0)
}

/** Weapon danger of `e` toward a spot `d` metres away (horizontal). Charging laser dominates everything. */
export function weaponMult(e: Threat, d: number, tr: ThreatRules): number {
  if (e.charging) return L.laserChargeMult
  let m = 1
  if (e.hasLaser && d <= tr.laserRange) m = Math.max(m, L.laserHoldMult)
  if (e.hasLightning && d < L.lightningDangerM) m = Math.max(m, L.lightningMult)
  return m
}

/** 1 if the spot is within near_range of `e` or inside its fov wedge (centred on its torso aim yaw); else discounted. */
export function fovMult(e: Threat, x: number, y: number, tr: ThreatRules): number {
  const d = dist2d(e.x, e.y, x, y)
  if (d <= tr.nearRange) return 1
  const off = Math.abs(angleDiff(e.aimYaw, yawTo(e.x, e.y, x, y)))
  return off <= (tr.fovDeg * Math.PI) / 360 ? 1 : L.fovDiscount
}

/** Full threat multiplier of `e` toward spot (x, y): fov x weapon x distance falloff. */
export function threatMult(e: Threat, x: number, y: number, tr: ThreatRules): number {
  const d = dist2d(e.x, e.y, x, y)
  return fovMult(e, x, y, tr) * weaponMult(e, d, tr) * (1 / (1 + d / L.threatDistScaleM))
}

/** Top-K tracked enemy mechs by danger-weighted proximity. */
export function selectThreats(world: WorldModel, selfX: number, selfY: number): Threat[] {
  const tr = threatRules(world)
  const muzzleBase = world.rules.muzzleHeight
  const out: (Threat & { priority: number })[] = []
  for (const e of world.enemies()) {
    if (world.t - e.lastListedT > world.rules.memoryS) continue
    const d = dist2d(selfX, selfY, e.pos[0], e.pos[1])
    const t: Threat = {
      id: e.id,
      x: e.pos[0],
      y: e.pos[1],
      z: e.pos[2],
      muzzleZ: e.pos[2] + muzzleBase * sizeScale(world, e.cubes),
      aimYaw: e.aim[0],
      charging: e.charging,
      hasLaser: e.weapons.includes("laser"),
      hasLightning: e.weapons.includes("lightning"),
      distToSelf: d,
    }
    out.push({ ...t, priority: d / weaponMult(t, d, tr) })
  }
  out.sort((a, b) => a.priority - b.priority || a.id - b.id)
  return out.slice(0, L.maxThreats).map(({ priority: _p, ...t }) => t)
}
