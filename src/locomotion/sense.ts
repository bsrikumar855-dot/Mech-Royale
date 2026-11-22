/**
 * What is shooting at us, cheaply: tracked enemy mechs (a few line-of-sight checks), recent damage and combat
 * sounds, mortar shells (predicted impact point) and bullets (rays over the next fraction of a second).
 */
import { LOCOMOTION as L } from "../config/index.ts"
import { dist2d, yawTo } from "../world/geom.ts"
import type { MapQuery } from "../world/map.ts"
import type { WorldModel } from "../world/world.ts"
import type { Vec2, Vec3 } from "../types/mechfight.ts"

export interface SensedEnemy {
  id: number
  x: number
  y: number
  dist: number
  /** listed in this observation (not just remembered) */
  listed: boolean
  /** we have a shot line to it (only checked for the nearest listed ones) */
  los: boolean
  charging: boolean
  lightning: boolean
  /** absolute hp when the server shows it, else Infinity */
  hp: number
  muzzle: Vec3
}

export interface Sensed {
  enemies: SensedEnemy[]
  losCount: number
  /** world yaw toward the primary threat, or null */
  bearing: number | null
  /** distance to the threat the bearing points at (Infinity if not a mech) */
  bearingDist: number
  damagedRecently: boolean
  /** damaged within the (shorter) hop window */
  damagedForJump: boolean
  heard: boolean
  projectileNear: boolean
  /** any trigger: tracked enemy, damage, sound or projectile */
  active: boolean
  /** enemies charging a laser with a line of sight on us */
  chargers: SensedEnemy[]
  /** unit vector away from the predicted mortar impacts we stand in, or null */
  mortarEscape: Vec2 | null
  /** unit vector away from a bullet ray about to pass through us, or null */
  bulletEscape: Vec2 | null
}

const num = (rec: Record<string, number | undefined> | undefined, k: string, f: number): number => {
  const v = rec?.[k]
  return typeof v === "number" && Number.isFinite(v) ? v : f
}

export function sense(world: WorldModel, map: MapQuery | null, ourRadius: number): Sensed {
  const obs = world.obs!
  const self = world.self
  const [px, py, pz] = self.pos
  const t = world.t
  const muzzleH = world.rules.muzzleHeight
  const ourMuzzle: Vec3 = [px, py, pz + world.selfStat("muzzle_height", muzzleH)]
  const comH = world.selfStat("height", world.rules.height) / 2

  // enemies: tracked within vision memory; LOS for the nearest listed ones (chargers first)
  const enemies: SensedEnemy[] = world
    .enemies()
    .filter((e) => t - e.lastListedT <= world.rules.memoryS)
    .map((e) => ({
      id: e.id,
      x: e.pos[0],
      y: e.pos[1],
      dist: dist2d(px, py, e.pos[0], e.pos[1]),
      listed: e.lastListedT === t,
      los: false,
      charging: e.charging,
      lightning: e.weapons.includes("lightning"),
      hp: typeof e.hp === "number" ? e.hp : Infinity,
      muzzle: [e.pos[0], e.pos[1], e.pos[2] + muzzleH] as Vec3,
    }))
    .sort((a, b) => Number(b.charging) - Number(a.charging) || a.dist - b.dist)
  let checks = 0
  for (const e of enemies) {
    if (!e.listed || checks >= L.maxLosChecks) continue
    checks++
    e.los = map ? map.hasShotLOS(ourMuzzle, [e.x, e.y, e.muzzle[2] - muzzleH + comH]) : true
  }
  const losEnemies = enemies.filter((e) => e.los).sort((a, b) => a.dist - b.dist)
  const chargers = enemies.filter((e) => e.charging && e.los)

  const damage = world.damage.filter((d) => d.weapon !== "zone" && d.bearing !== null)
  const lastDamage = damage[damage.length - 1]
  const damagedRecently = !!lastDamage && t - lastDamage.t <= L.damageMemoryS
  const damagedForJump = !!lastDamage && t - lastDamage.t <= L.jumpDamageWindowS
  const sounds = world.sounds.filter((s) => (s.dist === "near" || s.dist === "mid") && L.threatSoundKinds.includes(s.kind) && t - s.t <= L.soundMemoryS)
  const heard = sounds.length > 0

  const projs = (obs.projectiles ?? []).filter((p) => dist2d(px, py, p.pos[0], p.pos[1]) <= L.projectileAlertM)

  // primary threat bearing: nearest LOS enemy > nearest tracked enemy > damage > sound > projectile
  let bearing: number | null = null
  let bearingDist = Infinity
  const nearest = losEnemies[0] ?? enemies.slice().sort((a, b) => a.dist - b.dist)[0]
  if (nearest) {
    bearing = yawTo(px, py, nearest.x, nearest.y)
    bearingDist = nearest.dist
  } else if (damagedRecently && lastDamage) bearing = lastDamage.bearing
  else if (heard) bearing = sounds[sounds.length - 1]!.bearing
  else if (projs[0]) bearing = yawTo(px, py, projs[0].pos[0], projs[0].pos[1])

  // mortar shells: step the parabola against terrain and buildings
  const mortarCfg = world.config.weapons.mortar
  const g = num(mortarCfg, "gravity", 0)
  const danger = num(mortarCfg, "splash_radius", 0) + ourRadius + L.mortarMarginM
  const horizon = Math.min(L.mortarHorizonS, num(mortarCfg, "ttl", L.mortarHorizonS))
  let ex = 0
  let ey = 0
  let inSplash = false
  for (const p of obs.projectiles ?? []) {
    if (p.kind !== "mortar") continue
    for (let s = L.mortarStepS; s <= horizon + 1e-9; s += L.mortarStepS) {
      const x = p.pos[0] + p.vel[0] * s
      const y = p.pos[1] + p.vel[1] * s
      const z = p.pos[2] + p.vel[2] * s - 0.5 * g * s * s
      if (map ? map.isSolid(x, y, z) : z <= pz) {
        const d = dist2d(px, py, x, y)
        if (d < danger) {
          inSplash = true
          if (d > 1e-6) {
            ex += (px - x) / d
            ey += (py - y) / d
          } else {
            ex += 1 // dead centre: any direction out is fine
          }
        }
        break
      }
    }
  }
  const el = Math.hypot(ex, ey)
  const mortarEscape: Vec2 | null = inSplash ? (el > 1e-9 ? [ex / el, ey / el] : [1, 0]) : null

  // bullets: does the next-0.45 s ray pass within our radius + clearance?
  let bulletEscape: Vec2 | null = null
  let bestMiss = Infinity
  for (const p of obs.projectiles ?? []) {
    if (p.kind !== "gun" && p.kind !== "npc") continue
    const bx = p.vel[0] * L.bulletHorizonS
    const by = p.vel[1] * L.bulletHorizonS
    const len2 = bx * bx + by * by
    const u = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - p.pos[0]) * bx + (py - p.pos[1]) * by) / len2))
    const cx = p.pos[0] + bx * u
    const cy = p.pos[1] + by * u
    const miss = dist2d(px, py, cx, cy)
    if (miss <= ourRadius + L.bulletClearanceExtraM && miss < bestMiss) {
      bestMiss = miss
      if (miss > 1e-6) bulletEscape = [(px - cx) / miss, (py - cy) / miss]
      else {
        const l = Math.hypot(bx, by) || 1
        bulletEscape = [-by / l, bx / l] // dead centre: either side, pick the left of the bullet
      }
    }
  }

  const losCount = losEnemies.length
  return {
    enemies,
    losCount,
    bearing,
    bearingDist,
    damagedRecently,
    damagedForJump,
    heard,
    projectileNear: projs.length > 0,
    active: enemies.length > 0 || damagedRecently || heard || projs.length > 0,
    chargers,
    mortarEscape,
    bulletEscape,
  }
}
