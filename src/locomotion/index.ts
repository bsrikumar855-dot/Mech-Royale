/**
 * OWNER: Person A. Locomotion (Phase 2): a deterministic, deadline-guarded tactical utility scorer.
 * Contract: src/types/contracts.ts (LocomotionOutput). Never throws past decide() (Bot also guards it).
 *
 * SURVIVAL FIRST: score is mean(16 - place). Each decision we generate ~40 reachable candidate spots (hold, goal
 * steps with wall-tangent slides, a loot step, three rings), score them for zone safety (rim-hugging, shrink
 * timing), 3D cover against the top tracked enemies (fov, weapon, crossfire, path midpoint), mortar/bullet dodging,
 * spacing, unseen threats, safe loot, silent holding and hysteresis, then walk toward the best one. Boost is a
 * separate latched controller. jump stays false in this experiment.
 */
import { LOCOMOTION as L } from "../config/index.ts"
import type { Locomotion, LocomotionOutput, LootTarget, TickContext } from "../types/contracts.ts"
import { dist2d } from "../world/geom.ts"
import type { MapQuery } from "../world/map.ts"
import type { WorldModel } from "../world/world.ts"
import { generateCandidates, type Ray, type WalkFn } from "./candidates.ts"
import { decideBoost } from "./energy.ts"
import { bulletPaths, predictMortars } from "./projectiles.ts"
import { evaluate, type Evaluation, type LootGoal } from "./score.ts"
import { LocomotionState } from "./state.ts"
import { selectThreats, sizeScale, threatRules } from "./threats.ts"
import type { Body, Vec2 } from "./types.ts"
import { buildZone, distToCurrentEdge, zoneGoal, zoneSafe } from "./zone.ts"

const num = (rec: Record<string, number | undefined> | undefined, key: string, fallback: number): number => {
  const v = rec?.[key]
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

/** Straight-line walkability from (x, y, feet z) using MapQuery: map edge, slopes we cannot climb, walls, low decks. */
export function makeWalk(map: MapQuery | null, world: WorldModel, x: number, y: number, z: number, body: Body): WalkFn {
  return (ux: number, uy: number, stops: readonly number[]): Ray => {
    const maxD = Math.max(0, ...stops)
    if (!map) return { reach: maxD, zAt: () => z }
    const ds = new Set<number>(stops)
    for (let d = L.raySampleM; d < maxD; d += L.raySampleM) ds.add(d)
    const sorted = [...ds].sort((a, b) => a - b)
    const b = map.bounds
    const zs: [number, number][] = []
    let feet = z
    let reach = 0
    for (const d of sorted) {
      const qx = x + ux * d
      const qy = y + uy * d
      if (qx < b.minX + body.radius || qx > b.maxX - body.radius || qy < b.minY + body.radius || qy > b.maxY - body.radius) break
      const ground = map.heightAt(qx, qy)
      if (ground > feet + body.stepUp && map.slopeDegAt(qx, qy) > world.rules.maxSlopeDeg) break
      const nf = map.standingHeightAt(qx, qy, feet, body.stepUp, body.height)
      if (map.isBlockedAt(qx, qy, nf, body)) break
      feet = nf
      reach = d
      zs.push([d, feet])
    }
    return {
      reach,
      zAt: (d: number): number => {
        let out = z
        for (const [sd, sz] of zs) if (sd <= d + 1e-9) out = sz
        return out
      },
    }
  }
}

export class TacticalLocomotion implements Locomotion {
  readonly state = new LocomotionState()
  /** The last evaluation (tests and debugging). */
  last: Evaluation | null = null

  reset(): void {
    this.state.reset()
    this.last = null
  }

  decide(ctx: TickContext, loot: readonly LootTarget[]): LocomotionOutput {
    const { world, map, deadline } = ctx
    const still: LocomotionOutput = { move: [0, 0], boost: false, jump: false }
    const obs = world.obs
    if (!obs) return still
    this.state.sync(world)

    const self = world.self
    const [sx, sy, sz] = self.pos
    const scale = sizeScale(world, self.cubes)
    const body: Body = {
      radius: Math.max(world.selfStat("radius", world.rules.radius), world.rules.radius * scale),
      height: Math.max(world.selfStat("height", world.rules.height), world.rules.height * scale),
      stepUp: world.rules.stepUp,
    }
    const hpFrac = self.max_hp > 0 ? self.hp / self.max_hp : 1
    const zone = buildZone(world, sx, sy, world.selfStat("walk_speed", 1))
    const threats = selectThreats(world, sx, sy)
    const tr = threatRules(world)
    const mortarCfg = world.config.weapons.mortar
    const groundZ = (x: number, y: number): number => (map ? map.heightAt(x, y) : sz)
    const mortars = predictMortars(
      obs,
      { gravity: num(mortarCfg, "gravity", 0), splashRadius: num(mortarCfg, "splash_radius", 0), ttl: num(mortarCfg, "ttl", 0) },
      body.radius,
      map ? (x, y, z) => map.isSolid(x, y, z) : (_x, _y, z) => z <= sz,
    )

    // safe loot from Economy
    let lootGoal: LootGoal | null = null
    let lootNearby = false
    for (const t of loot) {
      const d = dist2d(sx, sy, t.x, t.y)
      if (d > L.lootCandidateMaxM || !zoneSafe(zone, t.x, t.y)) continue
      if (d <= L.holdLootBlockM) lootNearby = true
      if (!lootGoal || t.value > lootGoal.value) lootGoal = { x: t.x, y: t.y, value: t.value }
    }

    // threats we hear or feel but cannot see
    const listedNow = new Set((obs.mechs ?? []).map((m) => m.id))
    const unseen: number[] = []
    for (const d of world.damage) {
      if (world.t - d.t <= L.unseenMemoryS && d.bearing !== null && d.by !== null && !listedNow.has(d.by)) unseen.push(d.bearing)
    }
    for (const s of world.sounds) {
      if (world.t - s.t <= L.unseenMemoryS && s.dist === "near" && L.unseenSoundKinds.includes(s.kind)) unseen.push(s.bearing)
    }

    const cands = generateCandidates({
      x: sx,
      y: sy,
      z: sz,
      walk: makeWalk(map, world, sx, sy, sz, body),
      goal: zoneGoal(zone, sx, sy),
      loot: lootGoal ? [lootGoal.x, lootGoal.y] : null,
      deadline,
    })

    const ev = evaluate(
      {
        self: { x: sx, y: sy, z: sz, hpFrac },
        body,
        threats,
        tr,
        los: map ? (a, b) => map.hasShotLOS(a, b) : () => true,
        groundZ,
        zone,
        mortars,
        bullets: bulletPaths(obs),
        npcs: (obs.mechs ?? []).filter((m) => m.kind === "npc").map((m) => ({ x: m.pos[0], y: m.pos[1] })),
        unseenBearings: unseen,
        loot: lootGoal,
        lootNearby,
        lastMoveDir: this.state.lastMoveDir,
        lastTargetPos: this.state.lastTargetPos,
        stuckTangent: this.state.stuckBias(world.t),
        escapeSide: this.state.committedSide(world.t),
      },
      cands,
      deadline,
    )
    this.last = ev

    const best = ev.best
    const move: Vec2 = best.c.dist > 0 ? [best.c.dx / best.c.dist, best.c.dy / best.c.dist] : [0, 0]
    const nearest = threats.reduce<(typeof threats)[number] | null>((a, t) => (!a || t.distToSelf < a.distToSelf ? t : a), null)
    const boost = decideBoost(
      { best, self: ev.self, outsideZone: distToCurrentEdge(zone, sx, sy) < 0, selfInSplash: ev.selfInSplash, energy: self.energy, nearest },
      this.state,
    )
    if (best.c.kind === "tangent") this.state.commitEscape(world.t, best.c.side)
    this.state.remember(world, move, best.c.dist > 0 ? [best.c.x, best.c.y] : null)
    return { move, boost, jump: false }
  }
}

/** Kept so src/bot.ts (out of scope for this experiment) needs no change. */
export const RuleLocomotion = TacticalLocomotion
