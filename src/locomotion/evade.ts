/**
 * Predictive bullet evasion (experiment "evade"). No fixed trigger distance: every visible enemy bullet (gun / NPC) is
 * a known straight line (pos + vel t, no drop), and our own motion over the next fraction of a second is predictable
 * from the movement rules (accelerate toward the commanded velocity at ground_accel, air_accel while airborne after a
 * jump, gravity, walls stop us). For each candidate manoeuvre (16 headings + stop, walk / boost, stay grounded / jump)
 * we predict whether each bullet passes through our body (vertical cylinder, radius + projectile radius), and pick the
 * manoeuvre with the least predicted damage, breaking ties toward the heading Locomotion wanted. When the wanted move
 * is already predicted safe nothing changes. So the reaction depends on time to impact, our momentum, the walls around
 * us and our energy, instead of a single distance threshold.
 */
import { LOCOMOTION as L } from "../config/index.ts"
import type { Vec2 } from "../types/mechfight.ts"
import type { MapQuery } from "../world/map.ts"
import type { WorldModel } from "../world/world.ts"

export interface Bullet {
  pos: readonly [number, number, number]
  vel: readonly [number, number, number]
  /** damage if it hits */
  damage: number
  /** projectile radius */
  radius: number
}

export interface Manoeuvre {
  /** unit heading, or null = stop */
  dir: Vec2 | null
  boost: boolean
  jump: boolean
  /** predicted damage over the horizon */
  damage: number
}

export interface Body {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  grounded: boolean
  radius: number
  height: number
  walk: number
  boostSpeed: number
  groundAccel: number
  airAccel: number
  jumpSpeed: number
  gravity: number
  stepUp: number
  energy: number
}

/**
 * Our position at time t under a constant commanded velocity (cx, cy), accelerating at `accel` (closed form), with an
 * optional jump at t = 0 (air control `airAccel` until we land again).
 */
export function predictPos(b: Body, cx: number, cy: number, jump: boolean, t: number): [number, number, number] {
  const airT = jump && b.grounded ? (2 * b.jumpSpeed) / Math.max(b.gravity, 1e-6) : 0
  const ax = Math.min(t, airT)
  // phase 1: airborne (weak control), phase 2: grounded (strong control)
  let x = b.x
  let y = b.y
  let vx = b.vx
  let vy = b.vy
  const leg = (dt: number, a: number): void => {
    if (dt <= 0) return
    const dvx = cx - vx
    const dvy = cy - vy
    const dv = Math.hypot(dvx, dvy)
    const T = dv / Math.max(a, 1e-6)
    const ux = dv > 1e-9 ? dvx / dv : 0
    const uy = dv > 1e-9 ? dvy / dv : 0
    const ta = Math.min(dt, T)
    x += vx * ta + 0.5 * a * ux * ta * ta
    y += vy * ta + 0.5 * a * uy * ta * ta
    vx += a * ux * ta
    vy += a * uy * ta
    const rest = dt - ta
    x += vx * rest
    y += vy * rest
  }
  leg(ax, b.airAccel)
  leg(t - ax, b.groundAccel)
  const z = ax > 0 && t < airT ? b.z + b.jumpSpeed * t - 0.5 * b.gravity * t * t : b.z
  return [x, y, z]
}

/** Predicted damage of one manoeuvre: bullets whose path crosses our body cylinder within the horizon. */
export function manoeuvreDamage(b: Body, bullets: readonly Bullet[], cx: number, cy: number, jump: boolean, horizon: number, blockedAfter: number): number {
  let dmg = 0
  for (const u of bullets) {
    const reach = b.radius + u.radius + L.evadeMarginM
    // Continuous test: within each step our motion is ~linear and the bullet's is exactly linear, so the closest
    // approach of the RELATIVE motion is solved in closed form (sampling at 0.05 s would let a 252 m/s bullet, 12.6 m
    // per step, tunnel straight through a 5 m wide body).
    let prev = predictPos(b, cx, cy, jump, 0)
    for (let t0 = 0; t0 < horizon - 1e-9; t0 += L.evadeStepS) {
      const t1 = Math.min(horizon, t0 + L.evadeStepS)
      const cur = predictPos(b, cx, cy, jump, Math.min(t1, blockedAfter))
      const h = t1 - t0
      // relative position (bullet - us) at t0 and its rate over the step
      const rx = u.pos[0] + u.vel[0] * t0 - prev[0]
      const ry = u.pos[1] + u.vel[1] * t0 - prev[1]
      const wx = u.vel[0] - (cur[0] - prev[0]) / h
      const wy = u.vel[1] - (cur[1] - prev[1]) / h
      const ww = wx * wx + wy * wy
      const s = ww > 1e-12 ? Math.max(0, Math.min(h, -(rx * wx + ry * wy) / ww)) : 0
      const dx = rx + wx * s
      const dy = ry + wy * s
      if (Math.hypot(dx, dy) <= reach) {
        const ourZ = prev[2] + ((cur[2] - prev[2]) * s) / h
        const bz = u.pos[2] + u.vel[2] * (t0 + s)
        if (bz >= ourZ - u.radius && bz <= ourZ + b.height + u.radius) {
          dmg += u.damage
          break
        }
      }
      prev = cur
    }
  }
  return dmg
}

/**
 * The best manoeuvre for `wanted` (Locomotion's heading, null = it wanted to stand still). Returns null when the wanted
 * move is already predicted safe (no change), or when there are no threatening bullets.
 */
export function planEvasion(world: WorldModel, map: MapQuery | null, wanted: Vec2 | null, wantedBoost: boolean, bullets: readonly Bullet[]): Manoeuvre | null {
  if (bullets.length === 0) return null
  const self = world.self
  const charging = L.evadeChargeAware && self.weapons.some((w) => w?.kind === "laser" && (w.charge ?? 0) > 0)
  const speedMult = charging ? world.selfStat("charge_move_mult", 1) : 1
  const sizeMult = L.evadeCubeSize ? 1 + cubeSize(world) * Math.max(0, self.cubes ?? 0) : 1
  const b: Body = {
    x: self.pos[0],
    y: self.pos[1],
    z: self.pos[2],
    vx: self.vel[0],
    vy: self.vel[1],
    grounded: self.grounded,
    radius: Math.max(world.selfStat("radius", world.rules.radius), world.rules.radius * sizeMult),
    height: Math.max(world.selfStat("height", world.rules.height), world.rules.height * sizeMult),
    walk: world.selfStat("walk_speed", 11.7) * speedMult,
    boostSpeed: world.selfStat("boost_speed", 19.5) * speedMult,
    groundAccel: world.selfStat("ground_accel", 58.5),
    airAccel: world.selfStat("air_accel", 12),
    jumpSpeed: world.selfStat("jump_speed", 11),
    gravity: world.selfStat("gravity", 22),
    stepUp: world.rules.stepUp,
    energy: self.energy,
  }
  // horizon: until the last threatening bullet could reach us (capped)
  let horizon = 0
  for (const u of bullets) {
    const sp = Math.hypot(u.vel[0], u.vel[1])
    const d = Math.hypot(u.pos[0] - b.x, u.pos[1] - b.y)
    horizon = Math.max(horizon, sp > 1 ? d / sp : 0)
  }
  horizon = Math.min(horizon + L.evadeStepS, L.evadeHorizonS)

  const wallClock = (dir: Vec2 | null, speed: number, jump: boolean): number => {
    if (!dir || !map) return Infinity
    for (const t of L.evadeWallChecksS) {
      if (t > horizon) break
      const p = predictPos(b, dir[0] * speed, dir[1] * speed, jump, t)
      if (map.isBlockedAt(p[0], p[1], Math.max(b.z, map.heightAt(p[0], p[1])), { radius: b.radius, height: b.height, stepUp: b.stepUp })) return Math.max(0, t - L.evadeStepS)
    }
    return Infinity
  }
  const evalMove = (dir: Vec2 | null, boost: boolean, jump: boolean): Manoeuvre => {
    const speed = boost ? b.boostSpeed : b.walk
    const cx = dir ? dir[0] * speed : 0
    const cy = dir ? dir[1] * speed : 0
    return { dir, boost, jump, damage: manoeuvreDamage(b, bullets, cx, cy, jump, horizon, wallClock(dir, speed, jump)) }
  }

  const wantedMove = evalMove(wanted, wantedBoost && b.energy > 1, false)
  if (wantedMove.damage <= 0) return null

  const canBoost = b.energy >= L.evadeBoostMinEnergy
  const canJump = b.grounded && L.evadeAllowJump
  let best = wantedMove
  let bestCost = wantedMove.damage
  const cost = (m: Manoeuvre): number => {
    let c = m.damage
    if (wanted && m.dir) c += L.evadeDeviationWeight * (1 - (m.dir[0] * wanted[0] + m.dir[1] * wanted[1])) * 0.5
    else if (wanted && !m.dir) c += L.evadeDeviationWeight * 0.5
    if (m.boost) c += L.evadeBoostCost
    if (m.jump) c += L.evadeJumpCost
    return c
  }
  const dirs: Array<Vec2 | null> = [null]
  for (let k = 0; k < L.evadeHeadings; k++) {
    const a = (2 * Math.PI * k) / L.evadeHeadings
    dirs.push([Math.cos(a), Math.sin(a)])
  }
  if (wanted) dirs.push(wanted)
  for (const d of dirs) {
    for (const boost of canBoost ? [false, true] : [false]) {
      for (const jump of canJump ? [false, true] : [false]) {
        if (!d && boost) continue
        const m = evalMove(d, boost, jump)
        const c = cost(m)
        if (c < bestCost - 1e-9) {
          best = m
          bestCost = c
        }
      }
    }
  }
  return best === wantedMove ? null : best
}

/** cubes.size_per_cube from hello.config (0 when absent). */
function cubeSize(world: WorldModel): number {
  const v = (world.config.cubes as Record<string, number | undefined> | undefined)?.["size_per_cube"]
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

/** Visible enemy bullets (gun / NPC) that can still reach us. */
export function threateningBullets(world: WorldModel): Bullet[] {
  const obs = world.obs
  if (!obs) return []
  const [px, py] = world.self.pos
  const cfg = world.config
  const proj = cfg.projectile as Record<string, number | undefined>
  const gunDmg = (cfg.weapons.gun as Record<string, number | undefined>)["damage"] ?? 45
  const npcDmg = (cfg.npc as Record<string, number | undefined>)["damage"] ?? 25
  const out: Bullet[] = []
  for (const p of obs.projectiles ?? []) {
    if (p.kind !== "gun" && p.kind !== "npc") continue
    // moving away from us: cannot hit
    const rx = px - p.pos[0]
    const ry = py - p.pos[1]
    if (rx * p.vel[0] + ry * p.vel[1] <= 0) continue
    if (Math.hypot(rx, ry) > L.evadeMaxBulletDistM) continue
    out.push({
      pos: p.pos,
      vel: p.vel,
      damage: p.kind === "gun" ? gunDmg : npcDmg,
      radius: (p.kind === "gun" ? proj["gun_radius"] : proj["npc_radius"]) ?? 0.3,
    })
  }
  return out
}
