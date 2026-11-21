/**
 * OWNER: Person B. Combat: aim, fire, reload, MoveConstraint, threat bearing.
 * Contract: src/types/contracts.ts (CombatOutput). Read-only access to WorldModel. Never throws past decide().
 *
 * Combat v2 (SURVIVAL FIRST: placement counts, kills do not; never chase):
 *  - Target: visible enemy MECHS with a clear MapQuery.hasShotLOS in range, ranked by time-to-kill (HP left) then
 *    distance, with bonuses (mortar carrier when we hold a laser, close, charging a laser, rear arc exposed). Drones only within
 *    npcEngageRangeM and only when no enemy mech is visible at all.
 *  - v9 sticky focus: the last mech target gets cost * (1 - stickyFocusBonus) for stickyMemoryS, so a similar-HP
 *    newcomer never flips us; another shot-line enemy below stickySwitchHp cancels the bonus (finish it).
 *  - v9 always shoot back: no hold-fire at low HP (the old regen discipline let shared-vision squads kill us free).
 *  - Gun: linear lead; fire only when self.aim, projected slewLeadS ahead toward the commanded aim at the live
 *    turn/pitch rates (the trigger is held while the torso slews), is within the angle the target's body subtends.
 *    The laser release and the lightning cone keep using the raw self.aim (hitscan fires on the first tick).
 *  - Flicker lock: the last LOS mech target out of sight for < flickerAimHoldS and no other mech with a shot line ->
 *    keep the torso on its extrapolated lead point (never fires without LOS).
 *  - Laser: hold to charge, release to fire (hitscan: aim at the centre, no lead). Vs a mech, release when the RAW
 *    aim is within atan2(radius * 1.15, dist) and charged laserReleaseChargeS (0.65 s), or when the charge already
 *    kills, or when the target is about to slip behind cover. Max-crawl: always release by laserMaxCrawlS (1.25 s);
 *    release after 0.3 s without a target; never start outside the zone or with an enemy within 22 m (half speed).
 *  - Lightning (if held): instant; LOS, range, inside the cone of the actual yaw, energy.
 *  - Safe crate farming: no enemy mech has LOS or is within 50 m, in the zone, > 65% HP -> shoot the nearest crate.
 *  - v9 laser farming: no enemy mech listed at all, in the zone, laser ready -> laser the drone / crate (full charge
 *    unless it kills already); the gun waits while the laser is busy. A mech appearing redirects the laser at once,
 *    or (no shot line on it) drops the farm charge immediately.
 *  - Laser + gun weave vs mechs: the gun keeps leading and firing while the laser charges or cools down.
 *  - Reload at once when empty; reload early (ammo low) only after proactiveReloadDelayS with no enemy shot line and
 *    no tracked enemy within proactiveReloadClearM (anti-blink: a 2.4 s reload is uninterruptible).
 *  - No target: hasTarget=false + threatBearing so the Arbiter faces the threat (rear hits deal x rear_mult).
 */
import { COMBAT } from "../config/index.ts"
import type { Combat, CombatOutput, TickContext } from "../types/contracts.ts"
import type { ActorObs, SelfObs, Vec2, Vec3, WeaponKind, WeaponObs } from "../types/mechfight.ts"
import { aimErrorRad, angleDiff, clamp, yawTo } from "../world/geom.ts"
import type { MapQuery } from "../world/map.ts"
import type { WorldModel } from "../world/world.ts"
import { aimAt, leadPoint, projectAim } from "./aim.ts"
import { pickThreatBearing } from "./threat.ts"

const DEG = Math.PI / 180

const stat = (w: WeaponObs, key: string, fallback = 0): number => {
  const v = w.stats[key]
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}
const cfgNum = (rec: Record<string, unknown> | undefined, key: string, fallback: number): number => {
  const v = rec?.[key]
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

const slotOf = (self: SelfObs, kind: WeaponKind): number => self.weapons.findIndex((w) => w?.kind === kind)

/** Something we might shoot: an enemy mech, an NPC drone, or a crate. */
export interface Cand {
  kind: "mech" | "npc" | "crate"
  id: number
  a?: ActorObs
  com: Vec3
  dist: number
  los: boolean
  /** body radius (cube-scaled for mechs) used by the fire gates */
  radius: number
  hp?: number
}

export interface PriorityContext {
  /** we hold a laser (cook-off bonus vs mortar carriers) */
  holdsLaser: boolean
  /** our position, for the rear-arc test */
  selfX: number
  selfY: number
  /** an enemy's front arc in degrees (mech.front_arc_deg) */
  frontArcDeg: number
  /** a full mech's HP (config.mech.hp), for targets whose HP we cannot see */
  fullHp: number
  /** v9 sticky focus: the mech we were shooting (null = none / stale) */
  stickyId?: number | null
}

/** Gun fire tolerance: the angle the target's body subtends at this distance (plus a margin), clamped. */
export function gunFireTolerance(targetRadius: number, dist: number): number {
  return clamp(Math.atan2(targetRadius + COMBAT.gunAimMarginM, Math.max(dist, 1e-6)), COMBAT.minFireAngleRad, COMBAT.maxFireAngleErrorRad)
}

/** Are we behind `a` (outside its front arc, centred on its torso aim yaw)? */
export function inRearArc(a: ActorObs, x: number, y: number, frontArcDeg: number): boolean {
  return Math.abs(angleDiff(a.aim[0], yawTo(a.pos[0], a.pos[1], x, y))) > (frontArcDeg * DEG) / 2
}

/**
 * Kill-confirm focus. Lower cost wins: HP left * (1 + dist / killDistScaleM) * product of (1 - bonus).
 * Time-to-kill (HP) dominates; distance breaks near-ties. Unknown HP counts as the target's max (or a full mech).
 */
export function targetCost(c: Cand, p?: PriorityContext): number {
  const hp = c.hp ?? c.a?.max_hp ?? p?.fullHp ?? 1
  let cost = Math.max(hp, 1) * (1 + c.dist / COMBAT.killDistScaleM)
  if (c.kind !== "mech" || !c.a || !p) return cost
  const a = c.a
  if (p.holdsLaser && (a.weapons ?? []).includes("mortar")) cost *= 1 - COMBAT.cookoffTargetBonus
  if (c.dist < COMBAT.closeThreatM) cost *= 1 - COMBAT.closeThreatBonus
  if (a.charging) cost *= 1 - COMBAT.chargingThreatBonus
  if (inRearArc(a, p.selfX, p.selfY, p.frontArcDeg)) cost *= 1 - COMBAT.rearArcBonus
  return cost
}

/**
 * Lowest cost wins. Sticky focus: the previous mech target (p.stickyId) gets cost * (1 - stickyFocusBonus), so a
 * similar-HP newcomer never flips us, unless ANOTHER candidate is critically low (hp < stickySwitchHp).
 */
export function pickTarget(pool: readonly Cand[], p?: PriorityContext): Cand | null {
  const sticky = p?.stickyId ?? null
  const otherCritical = sticky !== null && pool.some((c) => c.id !== sticky && c.hp !== undefined && c.hp < COMBAT.stickySwitchHp)
  let best: Cand | null = null
  let bestCost = Infinity
  for (const c of pool) {
    let cost = targetCost(c, p)
    if (c.kind === "mech" && c.id === sticky && !otherCritical) cost *= 1 - COMBAT.stickyFocusBonus
    if (cost < bestCost) {
      bestCost = cost
      best = c
    }
  }
  return best
}

/** The gun can fire: rounds in the magazine and not mid-reload. */
export const gunReady = (gun: WeaponObs): boolean => (gun.ammo ?? 0) > 0 && (gun.reload ?? 0) === 0

/**
 * Reload now if empty, or (proactive reload not blocked and the mag is at/below the threshold); never while already
 * reloading. `proactiveBlocked` = an enemy mech had a shot line within proactiveReloadDelayS or is within
 * proactiveReloadClearM (RuleCombat computes it).
 */
export function needsReload(gun: WeaponObs, proactiveBlocked: boolean): boolean {
  if ((gun.reload ?? 0) > 0) return false
  const ammo = gun.ammo ?? 0
  const mag = stat(gun, "mag", Infinity)
  if (ammo >= mag) return false
  return ammo === 0 || (!proactiveBlocked && ammo <= COMBAT.reloadAmmoThreshold)
}

/** Gun gate aim: self.aim projected COMBAT.slewLeadS ahead toward the commanded aim at the live turn/pitch rates. */
export function postSlewAim(world: WorldModel, commanded: Vec2): Vec2 {
  const self = world.self
  return projectAim(
    [self.aim[0], self.aim[1]],
    commanded,
    world.selfStat("turn_rate", 0),
    world.selfStat("pitch_rate", 0),
    COMBAT.slewLeadS,
  )
}

/** Damage a laser release at `charge` seconds would deal to `target` (cube-scaled, with cook-off). */
export function laserDamage(world: WorldModel, laser: WeaponObs, charge: number, target: Cand): number {
  const full = stat(laser, "charge", 1)
  const minFrac = stat(laser, "min_frac", 0)
  const frac = minFrac + (1 - minFrac) * clamp(full > 0 ? charge / full : 1, 0, 1)
  const cubes = world.config.cubes
  const perCube = cfgNum(cubes, "damage_per_cube", 0)
  const cap = cfgNum(cubes, "stat_cap", 0)
  const cubeScale = 1 + perCube * Math.min(world.self.cubes, cap)
  const cookoff = (target.a?.weapons ?? []).includes("mortar") ? 1 + stat(laser, "cookoff", 0) : 1
  return stat(laser, "damage", 0) * frac * cubeScale * cookoff
}

/**
 * Laser trigger for this decision: true = keep holding (charging), false = released (fires if charged).
 * Pure given its inputs; see the module header for the rules.
 */
export function laserTrigger(args: {
  world: WorldModel
  map: MapQuery | null
  laser: WeaponObs
  muzzle: Vec3
  target: Cand | null
  canStart: boolean
  /** seconds since the charge last had a line-of-sight target (0 while it has one) */
  losLostFor: number
  /** farming a crate / drone: release only at full charge (a 0.65 s shot leaves a 300 HP crate alive) unless it kills */
  farm?: boolean
}): boolean {
  const { world, map, laser, muzzle, target, canStart, losLostFor } = args
  const charge = laser.charge ?? 0
  if (charge <= 0) return canStart && target !== null
  // Target out of sight: keep the charge briefly (it may step back out), then release so we stop crawling at half speed.
  if (!target) return losLostFor <= COMBAT.laserLosLossS
  // Max-crawl safety: past laserMaxCrawlS (or the auto-fire limit) release, aligned or not, and get full speed back.
  const limit = Math.min(COMBAT.laserMaxCrawlS, stat(laser, "charge", 0) + stat(laser, "hold_s", 0) - COMBAT.laserHoldSafetyS)
  if (charge >= limit) return false
  // Hitscan fires along the RAW self.aim the tick we release: no post-slew projection here.
  const aligned = aimErrorRad(world.self.aim, aimAt(muzzle, target.com)) <= Math.atan2(target.radius * COMBAT.laserReleaseAimFrac, Math.max(target.dist, 1e-6))
  if (!aligned) return true
  const full = stat(laser, "charge", 0)
  if (charge >= (args.farm ? full : Math.min(COMBAT.laserReleaseChargeS, full))) return false
  if (charge >= stat(laser, "min_charge", 0) && target.hp !== undefined && laserDamage(world, laser, charge, target) >= target.hp) return false
  if (map && target.a) {
    const t = COMBAT.laserCoverLookaheadS
    const v = target.a.vel
    const next: Vec3 = [target.com[0] + v[0] * t, target.com[1] + v[1] * t, target.com[2] + v[2] * t]
    if (!map.hasShotLOS(muzzle, next)) return false // about to slip behind cover: take the shot now
  }
  return true
}

export class RuleCombat implements Combat {
  // Per-match state. Reset when the WorldModel was reset (resetCount) or the tick did not advance (same pattern as
  // locomotion/state.ts; no position heuristics).
  /** Last match time the laser had a line-of-sight target. */
  private laserSeenT = Number.NEGATIVE_INFINITY
  /** Last match time ANY enemy mech had a clear shot line (anti-blink reload delay). */
  private lastEnemyLosT = Number.NEGATIVE_INFINITY
  /** The last mech target that had a shot line, and when (short-flicker aim lock). */
  private lastLosTarget: { id: number; t: number } | null = null
  /** v9 sticky focus: the last mech we targeted and when. */
  private lastTargetId: number | null = null
  private lastTargetT = Number.NEGATIVE_INFINITY
  /** v9: the laser charge in progress is on a crate / drone (an enemy mech appearing aborts it at once). */
  private laserFarming = false
  private epoch = -1
  private lastTick: number | null = null

  /** Sticky id for this decision (null when stale or none). */
  stickyId(t: number): number | null {
    return this.lastTargetId !== null && t - this.lastTargetT <= COMBAT.stickyMemoryS ? this.lastTargetId : null
  }

  private sync(world: WorldModel): void {
    if (world.resetCount !== this.epoch || (this.lastTick !== null && world.tick <= this.lastTick)) {
      this.laserSeenT = Number.NEGATIVE_INFINITY
      this.lastEnemyLosT = Number.NEGATIVE_INFINITY
      this.lastLosTarget = null
      this.lastTargetId = null
      this.lastTargetT = Number.NEGATIVE_INFINITY
      this.laserFarming = false
      this.epoch = world.resetCount
    }
    this.lastTick = world.tick
  }

  decide(ctx: TickContext): CombatOutput {
    const { world, map } = ctx
    const obs = world.obs
    const self = world.self
    const idle: CombatOutput = { aim: [self.aim[0], self.aim[1]], fire: [false, false], reload: false, moveConstraint: "NONE", hasTarget: false }
    if (!obs) return idle
    this.sync(world)

    const gunSlot = slotOf(self, "gun")
    const ltSlot = slotOf(self, "lightning")
    const lzSlot = slotOf(self, "laser")
    const gun = gunSlot >= 0 ? (self.weapons[gunSlot] as WeaponObs) : null
    const lightning = ltSlot >= 0 ? (self.weapons[ltSlot] as WeaponObs) : null
    const laser = lzSlot >= 0 ? (self.weapons[lzSlot] as WeaponObs) : null
    const gunRange = gun ? stat(gun, "range") * COMBAT.rangeMargin : 0
    const lightningRange = lightning ? stat(lightning, "range") : 0
    const laserRange = laser ? stat(laser, "range") : 0
    const engageRange = Math.max(gunRange, lightningRange, laserRange)

    const muzzle: Vec3 = [self.pos[0], self.pos[1], self.pos[2] + world.selfStat("muzzle_height", world.rules.muzzleHeight)]
    const cubesCfg = world.config.cubes as Record<string, unknown>
    const sizePer = cfgNum(cubesCfg, "size_per_cube", 0)
    const npcCfg = world.config.npc as Record<string, unknown>
    const view = (a: ActorObs): Cand => {
      const isNpc = a.kind === "npc"
      const h = isNpc ? cfgNum(npcCfg, "height", world.rules.height) : world.rules.height * (1 + sizePer * (a.cubes ?? 0))
      const r = isNpc ? cfgNum(npcCfg, "radius", world.rules.radius) : world.rules.radius * (1 + sizePer * (a.cubes ?? 0))
      const com: Vec3 = [a.pos[0], a.pos[1], a.pos[2] + h * COMBAT.comHeightFrac]
      const c: Cand = { kind: isNpc ? "npc" : "mech", id: a.id, a, com, dist: dist3(muzzle, com), los: map ? map.hasShotLOS(muzzle, com) : true, radius: r }
      if (a.hp !== undefined) c.hp = a.hp
      return c
    }

    const mechs = (obs.mechs ?? []).filter((m) => m.kind === "mech").map(view)
    const mechHasLos = mechs.some((c) => c.los)
    let pool = mechs.filter((c) => c.los && c.dist <= engageRange)
    if (mechs.length === 0) {
      // No enemy mech in sight at all: a nearby drone is fair game (cubes), but never a distraction from a mech.
      pool = (obs.mechs ?? [])
        .filter((m) => m.kind === "npc")
        .map(view)
        .filter((c) => c.los && c.dist <= Math.min(engageRange, COMBAT.npcEngageRangeM))
    }
    const fullHp = cfgNum(world.config.mech as Record<string, unknown>, "hp", self.max_hp)
    const prio: PriorityContext = { holdsLaser: laser !== null, selfX: self.pos[0], selfY: self.pos[1], frontArcDeg: world.rules.frontArcDeg, fullHp, stickyId: this.stickyId(world.t) }
    const target = pickTarget(pool, prio)
    const hpFrac = self.max_hp > 0 ? self.hp / self.max_hp : 1
    // v9: no hold-fire discipline. Whenever a valid target has a shot line we shoot back, whatever our HP.

    const fire: [boolean, boolean] = [false, false]
    let aim: Vec2 = idle.aim
    let hasTarget = false
    let moveConstraint: CombatOutput["moveConstraint"] = "NONE"

    const nearestMech = Math.min(Infinity, ...mechs.map((c) => c.dist))
    const laserCharging = !!laser && (laser.charge ?? 0) > 0
    const laserReady = !!laser && (laser.cooldown ?? 0) <= 0

    // Short flicker (pillar, trunk): keep the torso on the lost mech target's extrapolated lead point. No fire (no LOS).
    let flickerLock = false
    if (!target && !mechHasLos && this.lastLosTarget && world.t - this.lastLosTarget.t < COMBAT.flickerAimHoldS) {
      const track = world.tracks.get(this.lastLosTarget.id)
      if (track && track.kind === "mech") {
        const vel = world.estimateVelocity(track)
        const since = Math.max(0, world.t - track.lastListedT)
        const h = world.rules.height * (1 + sizePer * (track.cubes ?? 0))
        const com: Vec3 = [track.pos[0] + vel[0] * since, track.pos[1] + vel[1] * since, track.pos[2] + vel[2] * since + h * COMBAT.comHeightFrac]
        aim = gun ? aimAt(muzzle, leadPoint(muzzle, com, vel, stat(gun, "speed"))) : aimAt(muzzle, com)
        hasTarget = true
        moveConstraint = "FACE_TARGET"
        flickerLock = true
      }
    }

    // Safe crate farming gate (unchanged): no enemy mech has LOS, none tracked nearby, inside the zone, healthy.
    let crate: Cand | null = null
    if (!target && !flickerLock && !mechHasLos && self.in_zone && hpFrac > COMBAT.crateFarmMinHpFrac && !enemyNear(world, COMBAT.crateFarmEnemyClearM)) {
      const crateCfg = world.config.crates as Record<string, unknown>
      const ch = cfgNum(crateCfg, "height", 0)
      const cr = cfgNum(crateCfg, "radius", 0)
      for (const c of obs.crates ?? []) {
        const com: Vec3 = [c.pos[0], c.pos[1], c.pos[2] + ch / 2]
        const d = dist3(muzzle, com)
        if (d > COMBAT.crateFarmRangeM || (crate && d >= crate.dist)) continue
        if (map && !map.hasShotLOS(muzzle, com)) continue
        crate = { kind: "crate", id: c.id, com, dist: d, los: true, radius: cr, hp: c.hp ?? cfgNum(crateCfg, "hp", 0) }
      }
    }

    // v9 laser farm: NO enemy mech listed at all and inside the zone -> the drone target (<= npcEngageRangeM) or the
    // crate (<= crateFarmRangeM) is laser-farmed. An enemy mech appearing takes over at once (below).
    const mechTarget = target && target.kind === "mech" ? target : null
    const farmTarget = laser && mechs.length === 0 && self.in_zone ? (target && target.kind === "npc" ? target : crate) : null
    const laserCanStart =
      !!laser &&
      laserReady &&
      self.in_zone &&
      (mechTarget ? mechTarget.dist <= laserRange && nearestMech > COMBAT.laserMinStartDistM : farmTarget !== null)
    /** the laser is (about to be) busy with a crate / drone: the gun waits (magazine, 2.4 s reload) */
    const laserOnFarm = !mechTarget && farmTarget !== null && (laserCanStart || laserCharging)

    if (target) {
      hasTarget = true
      moveConstraint = "FACE_TARGET"
      const track = world.tracks.get(target.id)
      const vel = track ? world.estimateVelocity(track) : (target.a?.vel ?? [0, 0, 0])
      const leadAim = gun ? aimAt(muzzle, leadPoint(muzzle, target.com, vel, stat(gun, "speed"))) : aimAt(muzzle, target.com)
      // The laser is hitscan: while it is (about to be) charging, aim at the centre, not the lead point.
      aim = laserCanStart || laserCharging ? aimAt(muzzle, target.com) : leadAim
      // Post-slew gate: the torso keeps slewing toward `aim` while the trigger is held, so judge where it will be.
      if (gun && gunSlot >= 0 && gunReady(gun) && !laserOnFarm && target.dist <= gunRange && aimErrorRad(postSlewAim(world, aim), leadAim) <= gunFireTolerance(target.radius, target.dist)) {
        fire[gunSlot as 0 | 1] = true
      }
      if (target.kind === "mech") {
        this.lastLosTarget = { id: target.id, t: world.t }
        this.lastTargetId = target.id
        this.lastTargetT = world.t
      }
    }

    if (laser && lzSlot >= 0) {
      const laserTarget = mechTarget ?? farmTarget
      if (this.laserFarming && laserCharging && mechs.length > 0 && !mechTarget) {
        // an enemy mech showed up mid farm-charge without a shot line: drop the crate / drone charge now (full speed)
        fire[lzSlot as 0 | 1] = false
      } else {
        if (laserTarget) this.laserSeenT = world.t
        const farm = !mechTarget && farmTarget !== null
        fire[lzSlot as 0 | 1] = laserTrigger({ world, map, laser, muzzle, target: laserTarget, canStart: laserCanStart, losLostFor: world.t - this.laserSeenT, farm })
      }
      this.laserFarming = fire[lzSlot as 0 | 1] && !mechTarget && farmTarget !== null
    }

    if (lightning && ltSlot >= 0 && self.energy > COMBAT.lightningMinEnergy && self.energy >= stat(lightning, "energy")) {
      const near = pool.filter((c) => c.dist <= lightningRange).sort((x, y) => x.dist - y.dist)[0]
      const half = (stat(lightning, "cone_deg") * DEG) / 2
      if (near && near.a && Math.abs(angleDiff(self.aim[0], yawTo(self.pos[0], self.pos[1], near.a.pos[0], near.a.pos[1]))) <= half) fire[ltSlot as 0 | 1] = true
    }

    if (crate) {
      hasTarget = true
      aim = aimAt(muzzle, crate.com)
      if (gun && gunSlot >= 0 && !laserOnFarm && gunReady(gun) && aimErrorRad(postSlewAim(world, aim), aim) <= gunFireTolerance(crate.radius, crate.dist)) fire[gunSlot as 0 | 1] = true
    }

    // Anti-blink reload: a proactive (ammo > 0) reload needs proactiveReloadDelayS without any enemy shot line and no
    // enemy close by; an empty magazine reloads at once (needsReload).
    if (mechHasLos) this.lastEnemyLosT = world.t
    const proactiveBlocked = world.t - this.lastEnemyLosT < COMBAT.proactiveReloadDelayS || enemyNear(world, COMBAT.proactiveReloadClearM)
    const reload = !!gun && needsReload(gun, proactiveBlocked)
    const out: CombatOutput = { aim, fire, reload, moveConstraint, hasTarget }
    if (!hasTarget) {
      const bearing = pickThreatBearing(world)
      if (bearing !== undefined) out.threatBearing = bearing
    }
    return out
  }
}

const dist3 = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot((a[0] as number) - (b[0] as number), (a[1] as number) - (b[1] as number), (a[2] as number) - (b[2] as number))

/** Any tracked enemy mech (seen within vision.memory_s) closer than `r`? */
function enemyNear(world: WorldModel, r: number): boolean {
  const [x, y] = world.self.pos
  return world.enemies().some((e) => world.t - e.lastListedT <= world.rules.memoryS && Math.hypot(e.pos[0] - x, e.pos[1] - y) < r)
}
