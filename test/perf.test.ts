/** Worst-case decision cost with the REAL rule modules on the REAL map (informational numbers + a hard budget check). */
import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import { describe, test } from "node:test"
import { Bot } from "../src/bot.ts"
import { RUNTIME } from "../src/config/index.ts"
import { NO_DEADLINE } from "../src/runtime/deadline.ts"
import { WorldModel } from "../src/world/world.ts"
import { cleanObs, enemy, fixtureHello, HAS_ARENA, lightningWeapon, realMap } from "./helpers.ts"

describe("decision cost, worst case", { skip: !HAS_ARENA && "arena not found" }, () => {
  test(`worst case (15 enemies, 80 cubes, 40 pickups, 10 projectiles, real map): p99 < 6 ms, p99.9 < 10 ms, max < COMPUTE_BUDGET_MS (${RUNTIME.computeBudgetMs} ms)`, { timeout: 60_000 }, () => {
    const { map } = realMap()
    const trial = (): number[] => {
    const bot = new Bot(new WorldModel(fixtureHello()), map)
    const times: number[] = []
    for (let i = 0; i < 900; i++) {
      const o = cleanObs((x) => {
        x.tick = 200 + i * 2
        x.t = 10 + i * 0.1
        x.self.pos = [-210 + (i % 50), -20 + (i % 30), map.heightAt(-210 + (i % 50), -20 + (i % 30))]
        x.self.aim = [(i % 628) / 100 - 3.14, 0]
        x.self.weapons = [x.self.weapons[0] ?? null, lightningWeapon()]
        x.zone = { center: [-200, -20], radius: 400, next_center: [-190, -10], next_radius: 250, shrink_start: 5, shrink_end: 60, dps: 20 }
        x.mechs = Array.from({ length: 15 }, (_, k) => {
          const px = -210 + ((k * 37 + i) % 200) - 100
          const py = -20 + ((k * 53 + i * 3) % 160) - 80
          return enemy(k + 1, [px, py, map.heightAt(px, py)], { vel: [5, -3, 0], hp: 300 + k * 60 })
        })
        x.cubes = Array.from({ length: 80 }, (_, k) => ({ id: 5000 + k, pos: [-210 + ((k * 13) % 90), -20 + ((k * 7) % 70), 0] as [number, number, number] }))
        x.pickups = Array.from({ length: 40 }, (_, k) => ({ id: 8000 + k, kind: (["mortar", "laser", "lightning"] as const)[k % 3]!, pos: [-210 + k, -20 + k, 0] as [number, number, number] }))
        x.sounds = Array.from({ length: 30 }, () => ({ kind: "gun", bearing: 1, dist: "mid" as const, age: 0.05 }))
        const [sx, sy, sz] = x.self.pos
        x.projectiles = [
          ...Array.from({ length: 5 }, (_, k) => ({ id: 300 + k, kind: "mortar" as const, pos: [sx + k * 6 - 12, sy + 8, sz + 25] as [number, number, number], vel: [3, -2, -5] as [number, number, number] })),
          ...Array.from({ length: 5 }, (_, k) => ({ id: 400 + k, kind: "gun" as const, pos: [sx - 60, sy + k * 3, sz + 6] as [number, number, number], vel: [252, 0, 0] as [number, number, number] })),
        ]
        x.events = i % 7 === 0 ? [{ type: "damaged" as const, amount: 45, weapon: "gun", bearing: 2.5, by: 99, rear: true }] : []
        x.self.hp = 400 + (i % 900)
      })
      const t0 = performance.now()
      bot.decide(o, NO_DEADLINE)
      times.push(performance.now() - t0)
    }
    return times.slice(100).sort((a, b) => a - b)
    }
    // Timing under contention (node --test runs files in parallel) is noise, not cost: best of 3 trials, as check.py does.
    const trials = [trial(), trial(), trial()]
    const warm = trials.reduce((best, t) => ((t[Math.floor(0.999 * t.length)] as number) < (best[Math.floor(0.999 * best.length)] as number) ? t : best))
    const q = (p: number): number => warm[Math.min(warm.length - 1, Math.floor(p * warm.length))] as number
    console.error(`[bench] worst-case decide(): p50 ${q(0.5).toFixed(3)} ms  p95 ${q(0.95).toFixed(3)} ms  p99 ${q(0.99).toFixed(3)} ms  p99.9 ${q(0.999).toFixed(3)} ms  max ${warm[warm.length - 1]!.toFixed(3)} ms  (budget ${RUNTIME.computeBudgetMs} ms)`)
    assert.ok(q(0.99) < 6, `p99 ${q(0.99).toFixed(3)} ms must stay under the 6 ms locomotion gate`)
    assert.ok(q(0.999) < 10, `p99.9 ${q(0.999).toFixed(3)} ms must stay under the 10 ms hard cap`)
    assert.ok((warm[warm.length - 1] as number) < RUNTIME.computeBudgetMs)
  })
})
