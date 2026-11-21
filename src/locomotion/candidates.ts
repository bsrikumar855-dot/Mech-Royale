/**
 * Candidate generation: hold, goal-directed steps (with wall-tangent slides when the goal ray is blocked), a loot
 * step, and three concentric rings. Every candidate is reachable in a straight walk (or clamped to the last
 * walkable point of its ray), so the scorer never chooses a spot behind a wall.
 */
import { LOCOMOTION as L } from "../config/index.ts"
import type { Deadline } from "../runtime/deadline.ts"
import { dist2d } from "../world/geom.ts"
import type { Candidate, CandidateKind, Vec2 } from "./types.ts"

export interface Ray {
  /** farthest walkable distance reached along the ray (0 if the first sample is blocked) */
  reach: number
  /** feet height standing at distance d (d <= reach) */
  zAt(d: number): number
}

/** Walk along unit heading (ux, uy), sampling at raySampleM plus every distance in `stops`. */
export type WalkFn = (ux: number, uy: number, stops: readonly number[]) => Ray

export interface CandidateInput {
  x: number
  y: number
  z: number
  walk: WalkFn
  goal: Vec2 | null
  loot: Vec2 | null
  deadline: Deadline
}

const DEG = Math.PI / 180

export function generateCandidates(inp: CandidateInput): Candidate[] {
  const out: Candidate[] = [{ x: inp.x, y: inp.y, z: inp.z, dx: 0, dy: 0, dist: 0, kind: "hold" }]
  const time = (): boolean => inp.deadline.hasTimeRemaining(L.deadlineReserveMs)

  const add = (ux: number, uy: number, r: number, ray: Ray, kind: CandidateKind, side?: number): void => {
    let d = r
    if (ray.reach < r - 1e-9) {
      if (ray.reach < L.clampMinM) return
      d = ray.reach
    }
    const x = inp.x + ux * d
    const y = inp.y + uy * d
    for (const c of out) if (dist2d(c.x, c.y, x, y) < L.dedupeM) return
    out.push(side === undefined ? { x, y, z: ray.zAt(d), dx: ux * d, dy: uy * d, dist: d, kind } : { x, y, z: ray.zAt(d), dx: ux * d, dy: uy * d, dist: d, kind, side })
  }

  // 1. zone goal: direct steps, and tangent slides around a wall that blocks the direct line
  if (inp.goal && time()) {
    const gd = dist2d(inp.x, inp.y, inp.goal[0], inp.goal[1])
    if (gd > 1e-6) {
      const ux = (inp.goal[0] - inp.x) / gd
      const uy = (inp.goal[1] - inp.y) / gd
      const stops = [...new Set(L.goalStepsM.map((s) => Math.min(s, gd)))]
      const ray = inp.walk(ux, uy, stops)
      for (const s of stops) add(ux, uy, s, ray, "goal")
      const firstStop = Math.min(...stops)
      if (ray.reach < firstStop - 1e-9) {
        for (const deg of L.tangentAnglesDeg) {
          if (!time()) break
          const c = Math.cos(deg * DEG)
          const s = Math.sin(deg * DEG)
          const rx = ux * c - uy * s
          const ry = ux * s + uy * c
          const tray = inp.walk(rx, ry, L.tangentStepsM)
          for (const step of L.tangentStepsM) add(rx, ry, step, tray, "tangent", Math.sign(deg))
        }
      }
    }
  }

  // 2. loot step
  if (inp.loot && time()) {
    const ld = dist2d(inp.x, inp.y, inp.loot[0], inp.loot[1])
    if (ld > 1e-6 && ld <= L.lootCandidateMaxM) {
      const ux = (inp.loot[0] - inp.x) / ld
      const uy = (inp.loot[1] - inp.y) / ld
      add(ux, uy, ld, inp.walk(ux, uy, [ld]), "loot")
    }
  }

  // 3. rings: rays are shared between rings that use the same bearing (close ring first)
  const byBearing = new Map<number, number[]>()
  for (const ring of L.rings) {
    for (let k = 0; k < ring.bearings; k++) {
      const key = Math.round(((k * 360) / ring.bearings) * 1e6) / 1e6
      const list = byBearing.get(key) ?? []
      list.push(ring.radiusM)
      byBearing.set(key, list)
    }
  }
  const ordered = [...byBearing.entries()].sort((a, b) => Math.min(...a[1]) - Math.min(...b[1]) || a[0] - b[0])
  for (const [deg, radii] of ordered) {
    if (!time()) break
    const ux = Math.cos(deg * DEG)
    const uy = Math.sin(deg * DEG)
    const ray = inp.walk(ux, uy, radii)
    for (const r of radii) add(ux, uy, r, ray, "ring")
  }
  return out
}
