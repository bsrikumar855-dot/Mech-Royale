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
import { LOCOMOTION as L } from "../config/index.ts"
import type { Locomotion, LocomotionOutput, LootTarget, TickContext } from "../types/contracts.ts"
import type { Vec2, Vec3 } from "../types/mechfight.ts"
import { angleDiff, clamp, dist2d, unit2 } from "../world/geom.ts"
import type { MapQuery } from "../world/map.ts"
import type { WorldModel } from "../world/world.ts"
import { sense, type Sensed } from "./sense.ts"
import { LocoState } from "./state.ts"
import { blockedAhead, bodyOf, steer } from "./steer.ts"

export type Mode = "hunt" | "mortar" | "outside" | "laserDodge" | "shrink" | "retreat" | "backpedal" | "approach" | "strafe" | "loot" | "rim" | "hold" | "patrol" | "idle"

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

  reset(): void {
    this.state.reset()
  }

  decide(ctx: TickContext, _loot: readonly LootTarget[]): LocomotionOutput {
    const { world, map } = ctx
    const obs = world.obs
    if (!obs) return { move: [0, 0], boost: false, jump: false }
    const S = this.state
    S.sync(world)

    const self = world.self
    const t = world.t
    const [px, py] = self.pos
    const hpFrac = self.max_hp > 0 ? self.hp / self.max_hp : 1
    const energy = self.energy
    const ourLaserCharging = self.weapons.some((w) => w?.kind === "laser" && (w.charge ?? 0) > 0)
    const radius = world.selfStat("radius", world.rules.radius)
    const sn = sense(world, map, radius)
    this.lastSense = sn
    S.threats.ingest(world) // v11: sightings + weapon sounds, decaying over threatDecayS

    // ---- zone geometry
    const cur = world.zoneAt(t)
    const z = obs.zone
    const nextC: Vec2 = [z.next_center[0], z.next_center[1]]
    const safeR = cur.radius * L.safeRadiusFrac
    const inSafe = (x: number, y: number): boolean => dist2d(x, y, cur.center[0], cur.center[1]) <= safeR
    const distNextSafe = Math.max(0, dist2d(px, py, nextC[0], nextC[1]) - z.next_radius * L.nextSafeFrac)
    const walk = Math.max(1, world.selfStat("walk_speed", 1))
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

    if (sn.mortarEscape) {
      mode = "mortar"
      dir = sn.mortarEscape
      boost = energy > L.mortarBoostMinEnergy
    } else if (outside) {
      mode = "outside"
      const inward = toward(cur.center[0], cur.center[1])
      dir = inward && perp && underFire ? norm(add(inward, perp, L.outsideWeave)) : inward
      boost = energy > L.outsideBoostMinEnergy
    } else if (sn.chargers.length > 0 && perp) {
      mode = "laserDodge"
      dir = perp
      boost = !ourLaserCharging && energy > L.laserDodgeBoostMinEnergy
    } else if (urgent) {
      mode = "shrink"
      const inward = toward(nextC[0], nextC[1])
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
      } else if (sn.bearingDist > L.farM) {
        // v11: no voluntary chase of a healthy bot. Finish exception: ONE shooter nearly dead, us healthy, in the rim.
        const shooter = sn.losCount === 1 ? sn.enemies.find((e) => e.los) : undefined
        const shooterHp = shooter ? world.tracks.get(shooter.id)?.hp : undefined
        if (shooterHp !== undefined && shooterHp < L.finishMaxHp && hpFrac > L.finishMinHpFrac && inSafe(px, py)) {
          mode = "approach"
          dir = norm(add(perp, towardThreat, L.finishBlend))
        } else {
          mode = "strafe"
          dir = perp
          // near the centre: drift the strafe toward the quiet rim sector (out of the mosh pit), never forward
          const rc = this.rimCircle(world, cur.center, cur.radius, nextC, z.next_radius)
          if (dist2d(px, py, rc.c[0], rc.c[1]) < rc.R * L.rimStrafeBiasInsideFrac) {
            const pick = this.pickRimSector(world, map, inSafe, cur, rc)
            const out = pick ? toward(pick.x, pick.y) : null
            // never a bias toward the shooter (that would be a chase by another name)
            if (out && out[0] * towardThreat[0] + out[1] * towardThreat[1] < 0) dir = norm(add(perp, out, L.rimStrafeBias)) ?? perp
          }
        }
      } else {
        mode = "strafe"
        dir = perp
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
      const loot = this.pickLoot(world, inSafe, Infinity, { hunt: huntOpen, threatAware: true })
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
        dir = toward(cur.center[0], cur.center[1])
      } else if (hpFrac < L.regenHoldHpFrac) {
        mode = "hold" // wounded, safe and quiet: let the regen run
      } else {
        mode = "patrol"
        dir = this.rimPatrol(world, map, inSafe, cur, this.rimCircle(world, cur.center, cur.radius, nextC, z.next_radius))
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
    if ((sn.losCount >= 1 || sn.damagedForJump) && self.grounded && !ourLaserCharging && mode !== "mortar" && S.canJump(t)) {
      jump = true
      S.didJump(t)
    }

    this.lastMode = mode
    if (!dir) return { move: [0, 0], boost: false, jump }
    const mag = clamp(Math.hypot(dir[0], dir[1]), 0, 1)
    const steered = steer(map, world, S, [dir[0] / mag, dir[1] / mag])
    if (!steered) return { move: [0, 0], boost: false, jump }
    return { move: [steered[0] * mag, steered[1] * mag], boost, jump }
  }

  /**
   * Best loot in reach, read straight from the observation (Economy decides what it will take).
   * `hunt` (the v5 snowball gate is open): longer laser / drop / cube reach, plus NPC drones and crates as targets that
   * we approach to a stand-off so Combat shoots them. `cubesOnly`: the post-kill scoop under fire.
   */
  private pickLoot(world: WorldModel, inSafe: (x: number, y: number) => boolean, maxDist: number, opts: { hunt?: boolean; cubesOnly?: boolean; threatAware?: boolean } = {}): LootPick | null {
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
      let value = (L.lootBase[kind] ?? L.huntBase[kind] ?? 0) / (1 + d / L.lootHalfValueM)
      if (opts.threatAware) {
        // v11: prefer the quiet side; never walk up to a drone / crate next to a recent sighting or gunfire
        const threats = this.state.threats
        if ((kind === "npc" || kind === "crate") && threats.near(x, y, L.lootThreatSkipM, world.t)) return
        value /= 1 + L.lootThreatWeight * threats.score(x, y, world.t)
      }
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

  /** The circle the rim patrol works on: the next one (large enough), else the current one. */
  private rimCircle(_world: WorldModel, curC: readonly number[], curR: number, nextC: Vec2, nextR: number): { c: Vec2; R: number } {
    return nextR >= L.patrolMinRadiusM ? { c: nextC, R: nextR } : { c: [curC[0] as number, curC[1] as number], R: curR }
  }

  /**
   * v11 quiet rim sector: rimSectors candidates around rc; each uses the outermost of rimFracs that lies inside the
   * safe rim, rimMarginM inside the current radius, in bounds and walkable. Score = threat * rimThreatWeight + arc
   * travel (rad) * rimTravelWeight, minus rimHysteresis for the committed sector. O(sectors * (fracs + threat entries)).
   */
  pickRimSector(
    world: WorldModel,
    map: MapQuery | null,
    inSafe: (x: number, y: number) => boolean,
    cur: { center: readonly number[]; radius: number },
    rc: { c: Vec2; R: number },
  ): { k: number; x: number; y: number; r: number } | null {
    const S = this.state
    const t = world.t
    const [px, py] = world.self.pos
    const thUs = Math.atan2(py - rc.c[1], px - rc.c[0])
    const body = bodyOf(world)
    // falloff scaled to the circle: on a 500 m circle a fight 60 m from the centre still marks its side of the rim
    const scale = Math.max(L.threatScaleM, L.rimThreatScaleFrac * rc.R)
    let best: { k: number; x: number; y: number; r: number } | null = null
    let bestScore = Infinity
    for (let k = 0; k < L.rimSectors; k++) {
      const a = (k / L.rimSectors) * Math.PI * 2
      let q: { x: number; y: number; r: number } | null = null
      for (const f of L.rimFracs) {
        const r = f * rc.R
        const x = rc.c[0] + Math.cos(a) * r
        const y = rc.c[1] + Math.sin(a) * r
        if (!inSafe(x, y) || dist2d(x, y, cur.center[0] as number, cur.center[1] as number) > cur.radius - L.rimMarginM) continue
        if (map) {
          const bd = map.bounds
          if (x < bd.minX + body.radius || x > bd.maxX - body.radius || y < bd.minY + body.radius || y > bd.maxY - body.radius) continue
          if (map.isBlockedAt(x, y, map.heightAt(x, y), body)) continue
        }
        q = { x, y, r }
        break
      }
      if (!q) continue
      const score = S.threats.score(q.x, q.y, t, scale) * L.rimThreatWeight + Math.abs(angleDiff(thUs, a)) * L.rimTravelWeight - (k === S.rimSector ? L.rimHysteresis : 0)
      if (score < bestScore) {
        bestScore = score
        best = { k, ...q }
      }
    }
    if (best) S.rimSector = best.k
    return best
  }

  /**
   * v11 healthy idle patrol on the quiet outer rim. Far around the circle (> rimArcDirectRad): follow the rim arc
   * (tangent + radial hold at the sector radius), never across the centre; the arc side is chosen once per sector by
   * arc length + threat at the arc midpoint. Close: walk to the sector point. Arrived: wander +-rimWanderRad along the
   * rim (never a sitting duck). No walkable sector: circle at the middle rim radius.
   */
  private rimPatrol(
    world: WorldModel,
    map: MapQuery | null,
    inSafe: (x: number, y: number) => boolean,
    cur: { center: readonly number[]; radius: number },
    rc: { c: Vec2; R: number },
  ): Vec2 | null {
    const S = this.state
    const t = world.t
    const [px, py] = world.self.pos
    const d = dist2d(px, py, rc.c[0], rc.c[1])
    const pick = this.pickRimSector(world, map, inSafe, cur, rc)
    const rr = pick ? pick.r : (L.rimFracs[1] ?? 0.83) * rc.R
    if (d < 1e-6) return pick ? norm([pick.x - px, pick.y - py]) : [1, 0]
    const u: Vec2 = [(px - rc.c[0]) / d, (py - rc.c[1]) / d]
    const radial = clamp((rr - d) / Math.max(1, L.rimRadialScaleFrac * rc.R), -1, 1)
    const along = (sign: 1 | -1): Vec2 | null => norm(add([-u[1] * sign, u[0] * sign], u, radial))
    if (!pick) return along(S.patrolSign)
    const thUs = Math.atan2(u[1], u[0])
    const thP = Math.atan2(pick.y - rc.c[1], pick.x - rc.c[0])
    const delta = angleDiff(thUs, thP)
    if (dist2d(px, py, pick.x, pick.y) <= L.rimArriveM) {
      // wander along the rim around the sector point, turning back past +-rimWanderRad
      if (angleDiff(thP, thUs) * S.patrolSign > L.rimWanderRad) S.patrolSign = S.patrolSign === 1 ? -1 : 1
      return along(S.patrolSign)
    }
    if (Math.abs(delta) > L.rimArcDirectRad) {
      if (S.rimArcFor !== pick.k || S.rimArcSign === 0) {
        // choose the arc side once per sector: shorter arc vs quieter arc (threat at each side's midpoint)
        const side = (sign: 1 | -1): number => {
          const len = sign === Math.sign(delta) ? Math.abs(delta) : 2 * Math.PI - Math.abs(delta)
          const mid = thUs + (sign * len) / 2
          return len * L.rimTravelWeight + S.threats.score(rc.c[0] + Math.cos(mid) * rr, rc.c[1] + Math.sin(mid) * rr, t, Math.max(L.threatScaleM, L.rimThreatScaleFrac * rc.R)) * L.rimThreatWeight
        }
        S.rimArcSign = side(1) <= side(-1) ? 1 : -1
        S.rimArcFor = pick.k
      }
      return along(S.rimArcSign === -1 ? -1 : 1)
    }
    return norm([pick.x - px, pick.y - py])
  }
}

/** Kept so src/bot.ts (out of scope for this experiment) needs no change. */
export const RuleLocomotion = EvasiveLocomotion
