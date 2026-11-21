/**
 * Multi-factor survival utility. Every candidate gets the same terms; the highest total wins (ties keep the earlier
 * candidate, and hold is candidate 0). Pure given its ScoreEnv: tests inject `los` to build exact exposure cases.
 *
 * Terms: zone, cover (+crossfire), regen discipline, midpoint path exposure, mortar splash, bullet corridors,
 * spacing (enemy mechs, drones), unseen-threat direction, safe loot, wall-tangent escape, silent hold, move cost,
 * hysteresis, anti-stuck.
 */
import { LOCOMOTION as L } from "../config/index.ts"
import type { Deadline } from "../runtime/deadline.ts"
import { clamp, dist2d } from "../world/geom.ts"
import { bulletHits } from "./projectiles.ts"
import { threatMult, type ThreatRules } from "./threats.ts"
import type { Body, BulletPath, Candidate, MortarImpact, P3, Scored, Threat, Vec2 } from "./types.ts"
import { distToCurrentEdge, zoneSafe, zoneScore, type ZoneModel } from "./zone.ts"

export interface LootGoal {
  x: number
  y: number
  value: number
}

export interface ScoreEnv {
  self: { x: number; y: number; z: number; hpFrac: number }
  body: Body
  threats: readonly Threat[]
  tr: ThreatRules
  /** shot line of sight (true = clear). */
  los(a: P3, b: P3): boolean
  groundZ(x: number, y: number): number
  zone: ZoneModel
  mortars: readonly MortarImpact[]
  bullets: readonly BulletPath[]
  npcs: readonly { x: number; y: number }[]
  /** world-frame bearings of recent threats we cannot see (damage from unseen shooters, near combat sounds) */
  unseenBearings: readonly number[]
  /** best safe loot target (Economy's LootTarget[], filtered to the safe zone and range) */
  loot: LootGoal | null
  /** safe loot lies within holdLootBlockM: no silent-hold bonus */
  lootNearby: boolean
  lastMoveDir: Vec2 | null
  lastTargetPos: Vec2 | null
  stuckTangent: Vec2 | null
  /** committed wall-slide side (+1 / -1), or null when not committed */
  escapeSide: number | null
}

export interface Evaluation {
  all: Scored[]
  best: Scored
  /** the hold candidate (our current spot) */
  self: Scored
  emergency: boolean
  selfInSplash: boolean
}

interface Exposure {
  exposure: number
  count: number
  charging: number
}

export function hpScale(hpFrac: number): number {
  const f = clamp((L.hpScaleStart - hpFrac) / (L.hpScaleStart - L.hpScaleFull), 0, 1)
  return 1 + (L.hpScaleMax - 1) * f
}

/** Crossfire: nothing for 0-1 viewers, (n - 1)^2 * weight beyond (super-linear). */
export const crossfirePenalty = (count: number): number => (count >= 2 ? L.crossfireWeight * (count - 1) ** 2 : 0)

function exposureAt(env: ScoreEnv, x: number, y: number, z: number): Exposure {
  const target: P3 = [x, y, z + env.body.height / 2]
  let exposure = 0
  let count = 0
  let charging = 0
  for (const e of env.threats) {
    if (Math.hypot(e.x - x, e.y - y) > env.tr.maxThreatRange) continue
    if (!env.los([e.x, e.y, e.muzzleZ], target)) continue
    count++
    exposure += threatMult(e, x, y, env.tr)
    if (e.charging) charging++
  }
  return { exposure, count, charging }
}

export function evaluate(env: ScoreEnv, cands: readonly Candidate[], deadline: Deadline): Evaluation {
  const hold = cands[0] as Candidate
  const s = env.self
  const selfExp = exposureAt(env, hold.x, hold.y, hold.z)
  const selfInSplash = env.mortars.some((m) => dist2d(s.x, s.y, m.x, m.y) < m.radius)
  const corridor = env.body.radius + L.bulletCorridorExtraM
  const selfBullet = env.bullets.some((b) => bulletHits(b, s.x, s.y, s.z, env.body.height, corridor))
  const outside = distToCurrentEdge(env.zone, s.x, s.y) < 0
  // Lethal, fast threats drop all inertia. Being outside the zone does NOT: sliding along a wall needs side commitment.
  const emergency = selfExp.charging > 0 || selfInSplash
  const hf = emergency ? L.emergencyHystFactor : 1
  const zonePressure = outside ? 1 : env.zone.urgency
  const hs = hpScale(s.hpFrac)
  const holdEligible = zoneSafe(env.zone, s.x, s.y) && selfExp.count === 0 && !selfInSplash && !selfBullet && !env.lootNearby
  const farRing = Math.max(...L.rings.map((r) => r.radiusM))
  const midThreats = [...env.threats].sort((a, b) => a.distToSelf - b.distToSelf).slice(0, L.midpointThreats)
  const unseenActive = s.hpFrac < L.unseenHpFrac || selfExp.count > 0

  const scoreOne = (c: Candidate, idx: number): Scored => {
    const t: Record<string, number> = {}
    const e = idx === 0 ? selfExp : exposureAt(env, c.x, c.y, c.z)
    t["zone"] = zoneScore(env.zone, c.x, c.y)
    t["cover"] = -L.coverWeight * hs * e.exposure - hs * crossfirePenalty(e.count)
    t["regen"] = s.hpFrac < L.regenHpFrac && distToCurrentEdge(env.zone, c.x, c.y) > 0 ? -L.regenExposedWeight * e.count : 0

    let midExposed = 0
    if (c.dist > 0 && (selfExp.count > 0 || c.dist > L.midpointMinDistM)) {
      const mx = s.x + c.dx / 2
      const my = s.y + c.dy / 2
      const mid: P3 = [mx, my, env.groundZ(mx, my) + env.body.height / 2]
      for (const th of midThreats) {
        if (Math.hypot(th.x - mx, th.y - my) > env.tr.maxThreatRange) continue
        if (env.los([th.x, th.y, th.muzzleZ], mid)) midExposed++
      }
    }
    t["midpoint"] = -L.midpointWeight * hs * midExposed

    let inSplash = false
    let mortar = 0
    for (const m of env.mortars) {
      const d = dist2d(c.x, c.y, m.x, m.y)
      if (d < m.radius) {
        inSplash = true
        mortar -= L.mortarWeight * (0.5 + 0.5 * (1 - d / m.radius))
      }
    }
    t["mortar"] = mortar
    let bullets = 0
    for (const b of env.bullets) if (bulletHits(b, c.x, c.y, c.z, env.body.height, corridor)) bullets -= L.bulletWeight
    t["bullets"] = bullets

    let spacing = 0
    for (const th of env.threats) {
      const d = dist2d(c.x, c.y, th.x, th.y)
      if (d >= L.spacingRangeM) continue
      const k = (L.spacingRangeM - d) / L.spacingRangeM
      spacing -= L.spacingWeight * k * k * (th.hasLightning ? L.spacingLightningMult : 1) * (s.hpFrac < L.spacingLowHpFrac ? L.spacingLowHpMult : 1)
    }
    if (s.hpFrac < L.npcHpFrac) {
      for (const n of env.npcs) {
        const d = dist2d(c.x, c.y, n.x, n.y)
        if (d < L.npcRangeM) spacing -= (L.npcWeight * (L.npcRangeM - d)) / L.npcRangeM
      }
    }
    t["spacing"] = spacing

    const ux = c.dist > 0 ? c.dx / c.dist : 0
    const uy = c.dist > 0 ? c.dy / c.dist : 0
    let unseen = 0
    if (unseenActive && c.dist > 0) {
      for (const b of env.unseenBearings) {
        const dot = ux * Math.cos(b) + uy * Math.sin(b)
        if (dot > 0) unseen -= L.unseenWeight * dot * (c.dist / farRing)
      }
    }
    t["unseen"] = unseen

    let loot = 0
    if (env.loot && e.count === 0 && s.hpFrac > L.lootMinHpFrac && zoneSafe(env.zone, c.x, c.y)) {
      const dSelf = dist2d(s.x, s.y, env.loot.x, env.loot.y)
      const dP = dist2d(c.x, c.y, env.loot.x, env.loot.y)
      const progress = dP < L.lootArriveM ? 1 : clamp((dSelf - dP) / Math.max(dSelf, 1), -1, 1)
      loot = L.lootWeight * env.loot.value * progress
    }
    t["loot"] = loot

    const sideOk = env.escapeSide === null || c.side === env.escapeSide
    t["escape"] = c.kind === "tangent" && sideOk ? L.tangentEscapeBonus * zonePressure : 0
    t["hold"] = idx === 0 && holdEligible ? L.holdBonus : 0
    t["moveCost"] = -L.moveCostPerM * c.dist

    let hyst = 0
    if (c.dist > 0 && env.lastMoveDir) hyst += L.hystDirWeight * Math.max(0, ux * env.lastMoveDir[0] + uy * env.lastMoveDir[1])
    if (c.dist > 0 && env.lastTargetPos) hyst += L.hystTargetWeight * Math.max(0, 1 - dist2d(c.x, c.y, env.lastTargetPos[0], env.lastTargetPos[1]) / L.hystTargetRadiusM)
    t["hysteresis"] = hyst * hf
    t["stuck"] = c.dist > 0 && env.stuckTangent ? L.stuckBiasWeight * Math.max(0, ux * env.stuckTangent[0] + uy * env.stuckTangent[1]) : 0

    let score = 0
    for (const v of Object.values(t)) score += v
    return { c, score, exposedCount: e.count, exposure: e.exposure, chargingExposed: e.charging, midExposed, inSplash, terms: t }
  }

  const all: Scored[] = []
  for (let i = 0; i < cands.length; i++) {
    if (i > 0 && !deadline.hasTimeRemaining(L.deadlineReserveMs)) break
    all.push(scoreOne(cands[i] as Candidate, i))
  }
  let best = all[0] as Scored
  for (const sc of all) if (sc.score > best.score) best = sc
  return { all, best, self: all[0] as Scored, emergency, selfInSplash }
}
