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
import type { Vec2 } from "../types/mechfight.ts"
import { clamp, dist2d, unit2 } from "../world/geom.ts"
import type { WorldModel } from "../world/world.ts"
import { climbStep, findLedge, findRoof, type ClimbTarget } from "./climb.ts"
import { shouldSlice, sliceCover, type SlicePick } from "./cover.ts"
import { sense, type Sensed } from "./sense.ts"
import { LocoState } from "./state.ts"
import { blockedAhead, onRoof, steer } from "./steer.ts"

export type Mode = "climb" | "cover" | "mortar" | "outside" | "laserDodge" | "shrink" | "retreat" | "backpedal" | "approach" | "strafe" | "loot" | "rim" | "hold" | "patrol" | "idle"

const add = (a: Vec2, b: Vec2, k: number): Vec2 => [a[0] + b[0] * k, a[1] + b[1] * k]
const norm = (v: Vec2): Vec2 | null => unit2(v[0], v[1])

interface LootPick {
  x: number
  y: number
  kind: string
  dist: number
  value: number
  ringRadius?: number
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
    const zoneForced = outside || urgent
    const roof = onRoof(map, world)
    // on a roof, a deep drop is a wall for the feelers, unless the zone is forcing us off
    const avoidDrop = roof && !zoneForced && !sn.mortarEscape

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
      if (sn.active && cur0 && map && blockedAhead(map, world, cur0, L.strafeBlockProbeM, avoidDrop)) S.flipStrafe(t)
    }
    const perp = side()

    // ---- v4: an active climb runs until it lands or aborts (a mortar on us or the zone take over at once)
    if (S.climb.active) {
      if (sn.mortarEscape) S.climb.abort("abort-mortar")
      else if (zoneForced) S.climb.abort("abort-zone")
      else {
        const c = climbStep(S.climb, world, sn)
        if (c) {
          this.lastMode = "climb"
          return c
        }
      }
    }

    // ---- v4: 2v1+ corner slicing / rooftop escape (only on crossfire or critically wounded ticks)
    let slice: SlicePick | null = null
    if (map && underFire && !zoneForced && !sn.mortarEscape && sn.chargers.length === 0 && shouldSlice(world, sn, roof)) {
      const prev = S.sliceHeading && t - S.sliceT <= L.sliceHeadingMemoryS ? S.sliceHeading : null
      slice = sliceCover(map, world, sn, { inSafe, prevHeading: prev, roof })
    }
    const sliceWins = slice !== null && slice.exposed < slice.current
    const nearestDist = sn.enemies.reduce((m, e) => Math.min(m, e.dist), Infinity)
    const pressure = sn.losCount >= 2 || (hpFrac < L.roofPressureHpFrac && nearestDist < L.roofPressureNearM)
    let roofTarget: ClimbTarget | null = null
    if (map && !sliceWins && underFire && pressure && !zoneForced && !sn.mortarEscape && sn.chargers.length === 0 && self.grounded && energy >= L.roofMinEnergy && !ourLaserCharging) {
      roofTarget = findRoof(map, world, inSafe)
    }

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
      const loot = hpFrac > L.closeLootMinHpFrac && sn.losCount <= 1 ? this.pickLoot(world, inSafe, L.closeLootM) : null
      if (sliceWins && slice) {
        mode = "cover" // a probe that fewer shooters can hit: slip behind the corner, turn the 2v1 into a 1v1
        dir = slice.dir
      } else if (roofTarget) {
        S.climb.start(roofTarget, t)
        const c = climbStep(S.climb, world, sn)
        if (c) {
          this.lastMode = "climb"
          return c
        }
        mode = "retreat"
        dir = norm(add(perp, towardThreat, L.retreatBlend))
      } else if (sn.losCount >= 2 || hpFrac < L.woundedHpFrac) {
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
    } else {
      const loot = this.pickLoot(world, inSafe, Infinity)
      if (loot) {
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
        dir = this.patrol(world, cur.center, cur.radius, nextC, z.next_radius)
      }
    }

    // keep evasive / loot / patrol moves inside the safe rim (the zone modes already point inward)
    const rimChecked: readonly Mode[] = ["cover", "retreat", "backpedal", "approach", "strafe", "loot", "patrol", "laserDodge"]
    if (dir && rimChecked.includes(mode)) {
      const m = Math.hypot(dir[0], dir[1])
      if (!inSafe(px + (dir[0] / m) * L.rimLookaheadM, py + (dir[1] / m) * L.rimLookaheadM)) {
        const inward = toward(cur.center[0], cur.center[1])
        if (inward) dir = norm(add(dir, inward, 1)) ?? inward
      }
    }

    // v4 ledge clear: the heading runs into a step we can jump-jet over (open sky, headroom on top)
    if (dir && map && mode !== "mortar" && mode !== "laserDodge" && self.grounded && energy >= L.ledgeMinEnergy && !ourLaserCharging) {
      const m = Math.hypot(dir[0], dir[1])
      const u: Vec2 = [dir[0] / m, dir[1] / m]
      if (blockedAhead(map, world, u)) {
        const ledge = findLedge(map, world, u)
        if (ledge && (zoneForced || inSafe(ledge.x, ledge.y))) {
          S.climb.start(ledge, t)
          const c = climbStep(S.climb, world, sn)
          if (c) {
            this.lastMode = "climb"
            return c
          }
        }
      }
    }

    // tactical boost latch: escaping crossfire or a wounded retreat (never while our own laser charges)
    if (mode === "retreat" && !ourLaserCharging) {
      S.isBoosting = energy >= (S.isBoosting ? L.tacticalBoostHoldEnergy : L.tacticalBoostStartEnergy)
      boost = S.isBoosting
    } else {
      S.isBoosting = false
    }
    // v4 slice boost latch: snap behind the corner
    if (mode === "cover" && dir && !ourLaserCharging) {
      S.sliceBoosting = energy >= (S.sliceBoosting ? L.sliceBoostHoldEnergy : L.sliceBoostStartEnergy)
      boost = S.sliceBoosting
      S.sliceHeading = [dir[0], dir[1]]
      S.sliceT = t
    } else {
      S.sliceBoosting = false
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
    const steered = steer(map, world, S, [dir[0] / mag, dir[1] / mag], avoidDrop && mode !== "outside" && mode !== "shrink")
    if (!steered) return { move: [0, 0], boost: false, jump }
    return { move: [steered[0] * mag, steered[1] * mag], boost, jump }
  }

  /** Best loot in reach, read straight from the observation (Economy decides what it will take). */
  private pickLoot(world: WorldModel, inSafe: (x: number, y: number) => boolean, maxDist: number): LootPick | null {
    const obs = world.obs!
    const self = world.self
    const [px, py] = self.pos
    const held = self.weapons.flatMap((w) => (w ? [w.kind] : []))
    const emptySlot = self.weapons.some((w) => w === null)
    let best: LootPick | null = null
    const consider = (x: number, y: number, kind: string, range: number, ring?: number): void => {
      const d = dist2d(px, py, x, y)
      if (d > Math.min(range, maxDist) || !inSafe(x, y)) return
      const value = (L.lootBase[kind] ?? 0) / (1 + d / L.lootHalfValueM)
      if (!best || value > best.value) best = ring === undefined ? { x, y, kind, dist: d, value } : { x, y, kind, dist: d, value, ringRadius: ring }
    }
    for (const d of obs.drops ?? []) {
      if ((d.holder === null || d.holder === self.id) && d.lands_in <= L.dropMaxLandsInS) consider(d.pos[0], d.pos[1], "supply_drop", L.dropRangeM, d.radius)
    }
    for (const pk of obs.pickups ?? []) {
      if (pk.kind === "laser" && !held.includes("laser")) consider(pk.pos[0], pk.pos[1], "laser", L.laserPickupRangeM)
      else if (pk.kind === "lightning" && emptySlot && !held.includes("lightning") && !held.includes("laser")) consider(pk.pos[0], pk.pos[1], "lightning", L.lightningPickupRangeM)
    }
    for (const c of obs.cubes ?? []) consider(c.pos[0], c.pos[1], "cube", L.cubeRangeM)
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
