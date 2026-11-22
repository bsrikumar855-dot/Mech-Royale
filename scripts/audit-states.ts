/**
 * State audit: runs the REAL Bot on the REAL map through the kinematic harness (scripts/lib/sim.ts) with random zone
 * phases and 0-3 scripted enemies, and flags decisions where the bot is doing nothing useful:
 *   IDLE_UNDER_FIRE  hit within 2 s and not moving
 *   STUCK            asks to move but has moved < 1 m in the last 1 s
 *   DITHER           not in an evasive mode, yet 3 s of walking produced < 4 m of net progress
 *   ZONE_WRONG_WAY   outside the zone and moving away from its centre
 *   OUT_IDLE         outside the zone and not moving
 *   REAR_EXPOSED     hit within 1.5 s while the torso faces > 100 deg away from the attacker (rear hits x1.5)
 *   node scripts/audit-states.ts [--n 20] [--root .]
 * Constructed scenarios: frequencies show WHERE to look, not what the official score will do.
 */
import { join, resolve } from "node:path"
import { load, phases, rng, run, type Decision, type Enemy } from "./lib/sim.ts"

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf("--" + k)
  return i >= 0 ? process.argv[i + 1]! : d
}
const root = resolve(arg("root", join(import.meta.dirname, "..")))
const kit = resolve(arg("kit", join(import.meta.dirname, "..", "_kit")))
const N = Number(arg("n", "20"))
const L = await load(root, kit)
const map = L.map
const body = { radius: 2.5, height: 9, stepUp: 1.2 }
const FLAGS = ["IDLE_UNDER_FIRE", "STUCK", "DITHER", "ZONE_WRONG_WAY", "OUT_IDLE", "REAR_EXPOSED"] as const
type Flag = (typeof FLAGS)[number]
const EVASIVE = new Set(["strafe", "dodge", "laserDodge", "backpedal", "retreat", "approach", "mortar"])
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

const counts: Record<Flag, Record<string, number>> = Object.fromEntries(FLAGS.map((f) => [f, {}])) as never
const modeTicks: Record<string, number> = {}
let decisions = 0
let hitTicks = 0
const deaths = { zone: 0, enemy: 0, survived: 0 }
const examples: Record<Flag, string[]> = Object.fromEntries(FLAGS.map((f) => [f, []])) as never

for (let phase = 0; phase <= 4; phase++) {
  for (let k = 0; k < N; k++) {
    const seed = 7000 + phase * 1000 + k
    const rand = rng(seed * 7 + 3)
    const ph = phases(L.hello, rng(seed), map.bounds)[phase]
    // enemies: 0-3, placed later relative to our spawn is unknown here; put them around the phase centre
    const nE = Math.floor(rand() * 4)
    const enemies: Enemy[] = []
    for (let e = 0; e < nE; e++) {
      for (let tries = 0; tries < 50; tries++) {
        const a = rand() * 2 * Math.PI
        const d = ph.r0 * Math.sqrt(rand())
        const x = ph.c0[0] + Math.cos(a) * d
        const y = ph.c0[1] + Math.sin(a) * d
        if (map.isBlockedAt(x, y, map.heightAt(x, y), body)) continue
        const pol = (["pursue", "orbit", "static"] as const)[Math.floor(rand() * 3)]!
        enemies.push({ id: 10 + e, x, y, vx: 0, vy: 0, hp: 1400, policy: pol, speed: 9 + rand() * 3, hitProb: 0.08 })
        break
      }
    }
    const hist: Array<{ t: number; x: number; y: number }> = []
    const tag = `phase ${phase} seed ${seed}`
    const res = await run(L, {
      root,
      kit,
      seed,
      startPhase: phase,
      enemies,
      onDecision: (d: Decision) => {
        decisions++
        modeTicks[d.mode] = (modeTicks[d.mode] ?? 0) + 1
        hist.push({ t: d.t, x: d.x, y: d.y })
        while (hist.length && d.t - hist[0]!.t > 3.05) hist.shift()
        const mv = d.act.move ?? [0, 0]
        const sp = Math.hypot(mv[0], mv[1])
        const hitRecent = d.t - d.lastHitT <= 2
        if (hitRecent) hitTicks++
        const flag = (f: Flag) => {
          counts[f][d.mode] = (counts[f][d.mode] ?? 0) + 1
          if (examples[f].length < 4) examples[f].push(`${tag} t=${d.t.toFixed(1)} (${d.x.toFixed(0)},${d.y.toFixed(0)}) mode=${d.mode}`)
        }
        if (hitRecent && sp < 0.1) flag("IDLE_UNDER_FIRE")
        // STUCK: travelled (path length, not net displacement: strafing reverses on purpose) < 1 m in the last 1 s
        if (sp > 0.5 && d.t - hist[0]!.t >= 1) {
          let walked = 0
          for (let i = hist.length - 1; i > 0 && d.t - hist[i - 1]!.t <= 1.0; i--) walked += Math.hypot(hist[i]!.x - hist[i - 1]!.x, hist[i]!.y - hist[i - 1]!.y)
          if (walked < 1) flag("STUCK")
        }
        if (!EVASIVE.has(d.mode) && hist.length > 25 && d.t - hist[0]!.t >= 2.9) {
          let path = 0
          for (let i = 1; i < hist.length; i++) path += Math.hypot(hist[i]!.x - hist[i - 1]!.x, hist[i]!.y - hist[i - 1]!.y)
          const net = Math.hypot(d.x - hist[0]!.x, d.y - hist[0]!.y)
          if (path > 15 && net < 4) flag("DITHER")
        }
        if (!d.inZone) {
          if (sp < 0.1) flag("OUT_IDLE")
          else if (mv[0] * (d.circle.c[0] - d.x) + mv[1] * (d.circle.c[1] - d.y) < 0) flag("ZONE_WRONG_WAY")
        }
        if (d.lastHitBy && d.t - d.lastHitT <= 1.5) {
          const brg = Math.atan2(d.lastHitBy.y - d.y, d.lastHitBy.x - d.x)
          if (Math.abs(wrap(d.aim - brg)) > (100 * Math.PI) / 180) flag("REAR_EXPOSED")
        }
      },
    })
    if (!res.died) deaths.survived++
    else if (res.zoneDamage >= res.enemyDamage) deaths.zone++
    else deaths.enemy++
  }
}

console.log(`root=${root.split(/[\\/]/).pop()} runs=${5 * N} decisions=${decisions} hit-recent decisions=${hitTicks}`)
console.log(`outcomes: survived ${deaths.survived}, died to zone ${deaths.zone}, died to enemies ${deaths.enemy}`)
for (const f of FLAGS) {
  const tot = Object.values(counts[f]).reduce((a, b) => a + b, 0)
  const byMode = Object.entries(counts[f]).sort((a, b) => b[1] - a[1]).map(([m, c]) => `${m}:${c}`).join(" ")
  console.log(`${f.padEnd(16)} ${String(tot).padStart(6)} (${((100 * tot) / decisions).toFixed(2)}% of decisions)  ${byMode}`)
  for (const e of examples[f]) console.log(`      e.g. ${e}`)
}
console.log("modes:", Object.entries(modeTicks).sort((a, b) => b[1] - a[1]).map(([m, c]) => `${m}:${((100 * c) / decisions).toFixed(1)}%`).join(" "))
