/**
 * OWNER: Person A. Locomotion v3: evasive anti-lead movement. Contract: src/types/contracts.ts (LocomotionOutput).
 *
 * The forensic replay showed v1 standing still on 300/300 real ticks while a hunter shot it from 55-153 m. v3 never
 * offers a stationary target under threat. Priority order each decision:
 *  1. mortar about to land on us  -> run straight out of the splash, emergency boost
 *  2. outside the zone            -> run in (weaving if under fire), boost
 *  3. a laser charging on us      -> perpendicular sprint toward a side that breaks its line, boost
 *  4. the shrink will catch us    -> strong pull into the next circle (weaving if under fire)
 *  5. under fire                  -> A-D strafe perpendicular to the threat with range control and anti-lead hops
 *  6. loot                        -> supply drops, lasers, lightning, cubes in reach (weaving if alerted)
 *  7. idle                        -> wounded: hold still for regen; healthy: patrol the next circle's mid band
 * Every heading goes through a wall feeler with side commitment. All numbers: src/config/locomotion.ts.
 */
import { LOCOMOTION as L, NAV } from "../config/index.ts"
import type { Locomotion, LocomotionOutput, LootTarget, TickContext } from "../types/contracts.ts"
import type { Vec2, Vec3 } from "../types/mechfight.ts"
import { angleDiff, clamp, dist2d, unit2, yawTo } from "../world/geom.ts"
import type { WorldModel } from "../world/world.ts"
import { navGridFor, Navigator } from "../nav/index.ts"
import { sense, type Sensed } from "./sense.ts"
import { LocoState } from "./state.ts"
import { blockedAhead, steer } from "./steer.ts"

export type Mode = "arm" | "hunt" | "mortar" | "outside" | "laserDodge" | "shrink" | "retreat" | "backpedal" | "approach" | "strafe" | "loot" | "rim" | "hold" | "patrol" | "idle"

const add = (a: Vec2, b: Vec2, k: number): Vec2 => [a[0] + b[0] * k, a[1] + b[1] * k]
const norm = (v: Vec2): Vec2 | null => unit2(v[0], v[1])

interface LootPick {
  x: number
  y: number
  kind: string
  dist: number
  value: number
  ringRadius?: number
  /** hunt targets (drone, crate): centre to shoot at and the muzzle distance to hold at once there is a shot line */
  com?: Vec3
  standoff?: number
}

const cfg = (rec: unknown, key: string, fallback: number): number => {
  const v = (rec as Record<string, unknown> | undefined)?.[key]
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

export class EvasiveLocomotion implements Locomotion {
  readonly state = new LocoState()
  /** Last decision's mode and senses (tests, audits). */
  lastMode: Mode = "idle"
  lastSense: Sensed | null = null
  /** Zone navigator (path-planned zone runs). Null without a map. Fields are per match: cleared on a world reset. */
  private nav: Navigator | null = null
  private navMap: unknown = null
  private navEpoch = -1
  /** P5: the loot target chosen this decision (banned if we get stuck walking to it) */
  private lastLootPick: { x: number; y: number } | null = null
  /** P6: torso yaw to look along this decision (opening sweep / arming walk), if any */
  private scanYaw: number | undefined = undefined

  reset(): void {
    this.state.reset()
    this.nav?.clear()
  }

  private navFor(ctx: TickContext): Navigator | null {
    const map = ctx.map
    if (!map) return null
    if (this.navMap !== map) {
      this.nav = new Navigator(navGridFor(map, ctx.world.rules))
      this.navMap = map
      this.navEpoch = ctx.world.resetCount
    } else if (this.navEpoch !== ctx.world.resetCount) {
      this.nav?.clear()
      this.navEpoch = ctx.world.resetCount
    }
    return this.nav
  }

  decide(ctx: TickContext, loot: readonly LootTarget[]): LocomotionOutput {
    this.scanYaw = undefined
    const out = this.decideMode(ctx, loot)
    if (this.scanYaw !== undefined && Number.isFinite(this.scanYaw)) out.scanYaw = this.scanYaw
    return L.stuckEscape ? this.stuckEscape(ctx, out) : out
  }

  /**
   * P5: physical stuck detector on the server's reported velocity (independent of our map model) and the escape.
   * Airborne decisions neither count nor reset the stuck streak.
   */
  private stuckEscape(ctx: TickContext, out: LocomotionOutput): LocomotionOutput {
    const { world, map } = ctx
    const S = this.state
    if (!world.obs) return out
    const self = world.self
    const t = world.t
    const hs = Math.hypot(self.vel[0], self.vel[1])
    const walk = world.selfStat("walk_speed", 0)
    if (self.grounded) S.stuckN = S.lastCmdSpeed > L.stuckCmdMinWalkFrac * walk && hs < L.stuckSpeedRatio * S.lastCmdSpeed ? S.stuckN + 1 : 0
    S.lootBans = S.lootBans.filter((b) => b.until > t)
    if (S.stuckN >= L.stuckDecisions && S.lastCmdDir) {
      S.stuckN = 0
      const deg = L.stuckEscapeDeg[S.escapes % L.stuckEscapeDeg.length] ?? 90
      S.escapes++
      const a = (deg * Math.PI) / 180
      const [dx, dy] = S.lastCmdDir
      S.escapeDir = [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)]
      S.escapeUntilT = t + L.stuckEscapeS
      S.patrolSign = S.patrolSign === 1 ? -1 : 1
      if (this.lastLootPick) S.lootBans.push({ x: this.lastLootPick.x, y: this.lastLootPick.y, until: t + L.stuckLootBanS })
    }
    let res = out
    if (S.escapeDir && t < S.escapeUntilT) {
      const d = (map ? steer(map, world, S, S.escapeDir) : null) ?? S.escapeDir
      res = { move: [d[0], d[1]], boost: !self.grounded && self.energy > L.stuckJetMinEnergy, jump: self.grounded }
    }
    const m = Math.hypot(res.move[0], res.move[1])
    S.lastCmdMag = m
    const charging = self.weapons.some((w) => w?.kind === "laser" && (w.charge ?? 0) > 0)
    const top = res.boost && self.grounded ? world.selfStat("boost_speed", walk) : walk
    S.lastCmdSpeed = Math.min(1, m) * top * (charging ? cfg(world.config.mech, "charge_move_mult", 1) : 1)
    S.lastCmdDir = m > 1e-9 ? [res.move[0] / m, res.move[1] / m] : null
    return res
  }

  private decideMode(ctx: TickContext, _loot: readonly LootTarget[]): LocomotionOutput {
    const { world, map } = ctx
    const obs = world.obs
    if (!obs) return { move: [0, 0], boost: false, jump: false }
    const S = this.state
    S.sync(world)
    this.lastLootPick = null
    if (L.armEarly) this.rememberPickups(world, map)

    const self = world.self
    const t = world.t
    const [px, py] = self.pos
    const hpFrac = self.max_hp > 0 ? self.hp / self.max_hp : 1
    const energy = self.energy
    const ourLaserCharging = self.weapons.some((w) => w?.kind === "laser" && (w.charge ?? 0) > 0)
    const radius = world.selfStat("radius", world.rules.radius)
    const sn = sense(world, map, radius)
    this.lastSense = sn

    // ---- zone geometry
    const cur = world.zoneAt(t)
    const z = obs.zone
    const nextC: Vec2 = [z.next_center[0], z.next_center[1]]
    const safeR = cur.radius * L.safeRadiusFrac
    const inSafe = (x: number, y: number): boolean => dist2d(x, y, cur.center[0], cur.center[1]) <= safeR
    let distNextSafe = Math.max(0, dist2d(px, py, nextC[0], nextC[1]) - z.next_radius * L.nextSafeFrac)
    const walk = Math.max(1, world.selfStat("walk_speed", 1))
    // Path-planned zone runs: a path-distance field toward the NEXT circle's centre (known all phase long), built a few
    // thousand heap pops per tick. Straight-line travel time under-estimates a detour around buildings and the local
    // wall feeler cannot leave a concave pocket (it stands still); the field gives both a real distance and a way out.
    const nav = this.navFor(ctx)
    const navField = nav ? nav.field(nextC[0], nextC[1], z.next_radius) : null
    if (nav && navField) {
      nav.pump(!self.in_zone)
      if (NAV.pathUrgency) {
        const pl = nav.pathLength(navField, px, py)
        if (Number.isFinite(pl)) distNextSafe = Math.max(distNextSafe, pl)
      }
    }
    /** Heading toward the next circle's centre along the planned path (null: not ready / unreachable / arrived). */
    const zoneDir = (): Vec2 | null => (nav && navField ? nav.direction(navField, px, py, self.pos[2]) : null)
    const urgent = distNextSafe > 0 && distNextSafe / walk >= Math.max(1, z.shrink_end - t) - L.shrinkBufferS
    const outside = !self.in_zone

    // ---- strafe side: timer, bullet snap, laser dodge, blocked side
    const underFire = sn.losCount > 0 || sn.damagedRecently || sn.projectileNear
    if (sn.active) S.tickStrafe(t)
    const b = sn.bearing
    const side = (): Vec2 | null => (b === null ? null : [-Math.sin(b) * S.strafeSign, Math.cos(b) * S.strafeSign])
    if (b !== null) {
      const left: Vec2 = [-Math.sin(b), Math.cos(b)]
      if (sn.bulletEscape) S.setStrafe(t, left[0] * sn.bulletEscape[0] + left[1] * sn.bulletEscape[1] >= 0 ? 1 : -1)
      const charger = sn.chargers[0]
      if (charger && map) {
        // max 2 raycasts: which side, laserDodgeStepM over, can the charger NOT see?
        for (const s of [S.strafeSign, S.strafeSign === 1 ? -1 : 1] as const) {
          const qx = px + left[0] * s * L.laserDodgeStepM
          const qy = py + left[1] * s * L.laserDodgeStepM
          const qz = map.heightAt(qx, qy) + world.selfStat("height", world.rules.height) / 2
          if (!map.hasShotLOS(charger.muzzle, [qx, qy, qz])) {
            S.setStrafe(t, s)
            break
          }
        }
      }
      const cur0 = side()
      if (sn.active && cur0 && map && blockedAhead(map, world, cur0, L.strafeBlockProbeM)) S.flipStrafe(t)
    }
    const perp = side()

    // ---- pick a heading
    let dir: Vec2 | null = null
    let boost = false
    let mode: Mode = "idle"
    const toward = (x: number, y: number): Vec2 | null => norm([x - px, y - py])

    // P6 opening sweep: turn the torso all the way round once so vision finds the nearby weapons
    if (L.armEarly && t < L.openingSweepS && !sn.active) this.scanYaw = self.aim[0] + L.sweepLeadRad
    const armPick = L.armEarly ? this.armTarget(world, inSafe) : null

    if (sn.mortarEscape) {
      mode = "mortar"
      dir = sn.mortarEscape
      boost = energy > L.mortarBoostMinEnergy
    } else if (outside) {
      mode = "outside"
      const inward = zoneDir() ?? toward(cur.center[0], cur.center[1])
      dir = inward && perp && underFire ? norm(add(inward, perp, L.outsideWeave)) : inward
      boost = energy > L.outsideBoostMinEnergy
    } else if (sn.chargers.length > 0 && perp) {
      mode = "laserDodge"
      dir = perp
      boost = !ourLaserCharging && energy > L.laserDodgeBoostMinEnergy
    } else if (urgent) {
      mode = "shrink"
      const inward = zoneDir() ?? toward(nextC[0], nextC[1])
      dir = inward && perp && underFire ? norm(add(inward, perp, L.shrinkWeave)) : inward
    } else if (underFire && perp && b !== null) {
      const towardThreat: Vec2 = [Math.cos(b), Math.sin(b)]
      const close = sn.enemies.some((e) => e.dist < (e.lightning ? L.closeLightningM : L.closeM))
      const close18 = hpFrac > L.closeLootMinHpFrac && sn.losCount <= 1 ? this.pickLoot(world, inSafe, L.closeLootM) : null
      // v5 post-kill scoop: no shot line on us -> cubes up to 25 m; one shooter -> a cube within 14 m above 45% HP
      const scoopR = sn.losCount === 0 ? L.scoopNoLosM : sn.losCount === 1 && hpFrac > L.scoopOneLosMinHpFrac ? L.scoopOneLosM : 0
      const loot = close18 ?? (scoopR > 0 ? this.pickLoot(world, inSafe, scoopR, { cubesOnly: true }) : null)
      if (sn.losCount >= 2 || hpFrac < L.woundedHpFrac) {
        mode = "retreat"
        dir = norm(add(perp, towardThreat, L.retreatBlend))
      } else if (close) {
        mode = "backpedal"
        dir = norm(add(perp, towardThreat, L.backpedalBlend))
      } else if (loot) {
        mode = "loot"
        const tl = toward(loot.x, loot.y)
        dir = tl ? norm(add(tl, perp, L.lootWeave)) : perp
      } else if (sn.bearingDist > L.farM && hpFrac > L.approachMinHpFrac && inSafe(px, py)) {
        mode = "approach"
        dir = norm(add(perp, towardThreat, L.approachBlend))
      } else {
        mode = "strafe"
        dir = perp
      }
    } else if (armPick) {
      mode = "arm"
      this.lastLootPick = { x: armPick.x, y: armPick.y }
      if (armPick.dist > L.lootArriveM) {
        let ad: Vec2 | null = null
        if (armPick.dist > L.armStraightM && nav && navField?.done) {
          const af = nav.field(armPick.x, armPick.y, L.armFieldRadiusM)
          if (af) {
            nav.pump(false)
            if (af.done) ad = nav.direction(af, px, py, self.pos[2])
          }
        }
        const tl = ad ?? toward(armPick.x, armPick.y)
        dir = tl && perp && sn.active ? norm(add(tl, perp, L.lootWeave)) : tl
        if (dir && !sn.active) this.scanYaw = Math.atan2(dir[1], dir[0])
      }
    } else {
      // v5 snowball gate: nobody can shoot us, nobody tracked within 50 m, inside the safe rim, not yet at 10 cubes + laser
      const holdsLaser = self.weapons.some((w) => w?.kind === "laser")
      const huntOpen =
        sn.losCount === 0 &&
        !sn.enemies.some((e) => e.dist < L.huntEnemyClearM) &&
        self.in_zone &&
        inSafe(px, py) &&
        (self.cubes < L.huntCubeCap || !holdsLaser)
      const loot = this.pickLoot(world, inSafe, Infinity, { hunt: huntOpen })
      if (loot) this.lastLootPick = { x: loot.x, y: loot.y }
      if (loot && loot.standoff !== undefined && loot.com) {
        // drone / crate: walk in until Combat has a shot line within the stand-off, then hold still while it shoots
        mode = "hunt"
        const muzzle: Vec3 = [px, py, self.pos[2] + world.selfStat("muzzle_height", world.rules.muzzleHeight)]
        const d3 = Math.hypot(loot.com[0] - muzzle[0], loot.com[1] - muzzle[1], loot.com[2] - muzzle[2])
        const inPosition = d3 <= loot.standoff && (!map || map.hasShotLOS(muzzle, loot.com))
        if (!inPosition) {
          const tl = toward(loot.x, loot.y)
          dir = tl && perp && sn.active ? norm(add(tl, perp, L.lootWeave)) : tl
        }
      } else if (loot) {
        mode = "loot"
        if (loot.ringRadius !== undefined && loot.dist < loot.ringRadius - L.dropRingInsetM) {
          // inside the capture ring: micro-strafe, never leave it
          const tn = norm([-(py - loot.y), px - loot.x])
          dir = tn ? [tn[0] * L.dropMicroStrafe * S.strafeSign, tn[1] * L.dropMicroStrafe * S.strafeSign] : null
        } else if (loot.dist > L.lootArriveM) {
          const tl = toward(loot.x, loot.y)
          dir = tl && perp && sn.active ? norm(add(tl, perp, L.lootWeave)) : tl
        }
      } else if (sn.active && perp) {
        mode = "strafe" // alerted (heard / remembered) but nothing in sight: never a sitting duck
        dir = perp
      } else if (!inSafe(px, py)) {
        mode = "rim"
        dir = zoneDir() ?? toward(cur.center[0], cur.center[1])
      } else if (hpFrac < L.regenHoldHpFrac) {
        mode = "hold" // wounded, safe and quiet: let the regen run
      } else {
        mode = "patrol"
        dir = this.patrol(world, cur.center, cur.radius, nextC, z.next_radius)
      }
    }

    // keep evasive / loot / patrol moves inside the safe rim (the zone modes already point inward)
    const rimChecked: readonly Mode[] = ["hunt", "retreat", "backpedal", "approach", "strafe", "loot", "patrol", "laserDodge"]
    if (dir && rimChecked.includes(mode)) {
      const m = Math.hypot(dir[0], dir[1])
      if (!inSafe(px + (dir[0] / m) * L.rimLookaheadM, py + (dir[1] / m) * L.rimLookaheadM)) {
        const inward = toward(cur.center[0], cur.center[1])
        if (inward) dir = norm(add(dir, inward, 1)) ?? inward
      }
    }

    // tactical boost latch: escaping crossfire or a wounded retreat (never while our own laser charges)
    if (mode === "retreat" && !ourLaserCharging) {
      S.isBoosting = energy >= (S.isBoosting ? L.tacticalBoostHoldEnergy : L.tacticalBoostStartEnergy)
      boost = S.isBoosting
    } else {
      S.isBoosting = false
    }

    // anti-lead hop
    let jump = false
    if (L.antiLeadHops && (sn.losCount >= 1 || sn.damagedForJump) && self.grounded && !ourLaserCharging && mode !== "mortar" && S.canJump(t)) {
      jump = true
      S.didJump(t)
    }

    this.lastMode = mode
    if (!dir) return { move: [0, 0], boost: false, jump }
    const mag = clamp(Math.hypot(dir[0], dir[1]), 0, 1)
    const unit: Vec2 = [dir[0] / mag, dir[1] / mag]
    let steered = steer(map, world, S, unit)
    // Unstick: the local feeler is boxed in. Ask the Dijkstra grid for a real route toward where we were already
    // heading, instead of standing still (see LOCOMOTION.unstickLookaheadM).
    if (!steered && nav) {
      const uf = nav.field(px + unit[0] * L.unstickLookaheadM, py + unit[1] * L.unstickLookaheadM, L.unstickRadiusM)
      if (uf) {
        nav.pump(true)
        steered = nav.direction(uf, px, py, self.pos[2])
      }
    }
    if (!steered) return { move: [0, 0], boost: false, jump }
    return { move: [steered[0] * mag, steered[1] * mag], boost, jump }
  }

  /**
   * Best loot in reach, read straight from the observation (Economy decides what it will take).
   * `hunt` (the v5 snowball gate is open): longer laser / drop / cube reach, plus NPC drones and crates as targets that
   * we approach to a stand-off so Combat shoots them. `cubesOnly`: the post-kill scoop under fire.
   */
  private pickLoot(world: WorldModel, inSafe: (x: number, y: number) => boolean, maxDist: number, opts: { hunt?: boolean; cubesOnly?: boolean } = {}): LootPick | null {
    const obs = world.obs!
    const self = world.self
    const [px, py] = self.pos
    const hunt = opts.hunt === true
    const held = self.weapons.flatMap((w) => (w ? [w.kind] : []))
    const emptySlot = self.weapons.some((w) => w === null)
    let best: LootPick | null = null
    const consider = (x: number, y: number, kind: string, range: number, ring?: number, target?: { com: Vec3; standoff: number }): void => {
      const d = dist2d(px, py, x, y)
      if (d > Math.min(range, maxDist) || !inSafe(x, y)) return
      for (const b of this.state.lootBans) if (dist2d(x, y, b.x, b.y) < L.stuckLootBanM) return
      const value = (L.lootBase[kind] ?? L.huntBase[kind] ?? 0) / (1 + d / L.lootHalfValueM)
      if (best && value <= best.value) return
      const pick: LootPick = { x, y, kind, dist: d, value }
      if (ring !== undefined) pick.ringRadius = ring
      if (target) {
        pick.com = target.com
        pick.standoff = target.standoff
      }
      best = pick
    }
    if (!opts.cubesOnly) {
      for (const d of obs.drops ?? []) {
        if ((d.holder === null || d.holder === self.id) && d.lands_in <= L.dropMaxLandsInS) consider(d.pos[0], d.pos[1], "supply_drop", hunt ? L.huntDropRangeM : L.dropRangeM, d.radius)
      }
      for (const pk of obs.pickups ?? []) {
        if (pk.kind === "laser" && !held.includes("laser")) consider(pk.pos[0], pk.pos[1], "laser", hunt ? L.huntLaserRangeM : L.laserPickupRangeM)
        else if (pk.kind === "lightning" && emptySlot && !held.includes("lightning") && !held.includes("laser")) consider(pk.pos[0], pk.pos[1], "lightning", L.lightningPickupRangeM)
      }
    }
    for (const c of obs.cubes ?? []) consider(c.pos[0], c.pos[1], "cube", hunt ? L.huntCubeRangeM : L.cubeRangeM)
    if (!hunt || opts.cubesOnly) return best
    const hpFrac = self.max_hp > 0 ? self.hp / self.max_hp : 1
    const mechs = obs.mechs ?? []
    // Combat only shoots drones while no enemy mech is listed at all: do not walk up to one it will not shoot.
    if (hpFrac > L.huntNpcMinHpFrac && !mechs.some((m) => m.kind === "mech")) {
      const h = cfg(world.config.npc, "height", world.rules.height)
      for (const m of mechs) {
        if (m.kind === "npc") consider(m.pos[0], m.pos[1], "npc", L.huntTargetRangeM, undefined, { com: [m.pos[0], m.pos[1], m.pos[2] + h / 2], standoff: L.huntNpcStandoffM })
      }
    }
    if (hpFrac > L.huntCrateMinHpFrac) {
      const h = cfg(world.config.crates, "height", 0)
      for (const c of obs.crates ?? []) consider(c.pos[0], c.pos[1], "crate", L.huntTargetRangeM, undefined, { com: [c.pos[0], c.pos[1], c.pos[2] + h / 2], standoff: L.huntCrateStandoffM })
    }
    return best
  }

  /**
   * P6: remember every laser / lightning pickup we see; forget one when its spot is in view (near range all round, or
   * the vision wedge around our torso yaw, with a line of sight) and it is not listed, or after armMemoryS.
   */
  private rememberPickups(world: WorldModel, map: TickContext["map"]): void {
    const mem = this.state.pickupMem
    const obs = world.obs!
    const t = world.t
    const listed = new Set<number>()
    for (const p of obs.pickups ?? []) {
      listed.add(p.id)
      if (p.kind === "laser" || p.kind === "lightning") mem.set(p.id, { x: p.pos[0], y: p.pos[1], z: p.pos[2], kind: p.kind, seenT: t })
    }
    if (mem.size === 0) return
    const self = world.self
    const [px, py, pz] = self.pos
    const eye: Vec3 = [px, py, pz + world.selfStat("eye_height", world.rules.eyeHeight)]
    const near = world.rules.nearRange * L.armRecheckFrac
    const far = world.rules.visionRange * L.armRecheckFrac
    const half = ((world.rules.fovDeg / 2) * L.armRecheckFrac * Math.PI) / 180
    for (const [id, m] of mem) {
      if (t - m.seenT > L.armMemoryS) {
        mem.delete(id)
        continue
      }
      if (listed.has(id)) continue
      const d = dist2d(px, py, m.x, m.y)
      const inView = d <= near || (d <= far && Math.abs(angleDiff(yawTo(px, py, m.x, m.y), self.aim[0])) <= half)
      if (inView && (!map || map.hasVisionLOS(eye, [m.x, m.y, m.z + 0.5]))) mem.delete(id)
    }
  }

  /** P6: until we hold a laser or lightning (with a free slot), the best remembered one in range inside the safe zone. */
  private armTarget(world: WorldModel, inSafe: (x: number, y: number) => boolean): { x: number; y: number; kind: string; dist: number } | null {
    const self = world.self
    if (!self.weapons.some((w) => w === null)) return null
    if (self.weapons.some((w) => w?.kind === "laser" || w?.kind === "lightning")) return null
    const [px, py] = self.pos
    let best: { x: number; y: number; kind: string; dist: number } | null = null
    let bestV = 0
    for (const m of this.state.pickupMem.values()) {
      const d = dist2d(px, py, m.x, m.y)
      if (d > L.armRangeM || !inSafe(m.x, m.y)) continue
      if (this.state.lootBans.some((b) => dist2d(m.x, m.y, b.x, b.y) < L.stuckLootBanM)) continue
      const v = (L.armBase[m.kind] ?? 0) / (1 + d / L.armHalfValueM)
      if (v > bestV) {
        bestV = v
        best = { x: m.x, y: m.y, kind: m.kind, dist: d }
      }
    }
    return best
  }

  /** Healthy and idle: circle the next zone's mid band so we keep moving and keep finding loot. */
  private patrol(world: WorldModel, curC: readonly number[], curR: number, nextC: Vec2, nextR: number): Vec2 | null {
    const [px, py] = world.self.pos
    const useNext = nextR >= L.patrolMinRadiusM
    const c: Vec2 = useNext ? nextC : [curC[0] as number, curC[1] as number]
    const R = useNext ? nextR : curR
    const d = dist2d(px, py, c[0], c[1])
    if (d < 1e-6) return [1, 0]
    const u: Vec2 = [(px - c[0]) / d, (py - c[1]) / d]
    const tangent: Vec2 = [-u[1] * this.state.patrolSign, u[0] * this.state.patrolSign]
    const mid = ((L.patrolInnerFrac + L.patrolOuterFrac) / 2) * R
    const radial = clamp((mid - d) / Math.max(1, 0.2 * R), -1, 1)
    return norm(add(tangent, u, radial))
  }
}

/** Kept so src/bot.ts (out of scope for this experiment) needs no change. */
export const RuleLocomotion = EvasiveLocomotion
