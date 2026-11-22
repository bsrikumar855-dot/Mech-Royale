/**
 * Vanish evaluation: we start WOUNDED (500 / 1400 HP) with 1-3 hunters 80-140 m away that can see us. The hunter squad
 * (scripts/lib/sim.ts, policy "hunter") shares sight and hearing per the protocol's vision / sound rules, keeps ~90 m
 * while it sees us, and otherwise walks to our last known position and searches around it. Vanish OFF vs ON, same
 * seeds, same spawns. We have no weapons here: this measures escape and recovery, never kills or placement.
 *   node scripts/vanish-eval.ts [--n 30] [--dur 60]
 */
import { join, resolve } from "node:path"
import { LOCOMOTION } from "../src/config/index.ts"
import { load, rng, run, type Enemy } from "./lib/sim.ts"

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf("--" + k)
  return i >= 0 ? process.argv[i + 1]! : d
}
const root = resolve(arg("root", join(import.meta.dirname, "..")))
const kit = resolve(arg("kit", join(import.meta.dirname, "..", "_kit")))
const N = Number(arg("n", "30"))
const DUR = Number(arg("dur", "60"))
const HIT = Number(arg("hit", "0.10"))
const OFF = Number(arg("seed", "0"))
const L = await load(root, kit)
const map = L.map
const body = { radius: 2.5, height: 9, stepUp: 1.2 }
const DEFAULTS: Record<string, unknown> = { ...LOCOMOTION }
const open = (x: number, y: number) => !map.isBlockedAt(x, y, map.heightAt(x, y), body) && map.slopeDegAt(x, y) < 20

function setup(seed: number, nH: number) {
  const rand = rng(seed)
  const b = map.bounds
  for (let k = 0; k < 3000; k++) {
    const x = b.minX + 80 + rand() * (b.maxX - b.minX - 160)
    const y = b.minY + 80 + rand() * (b.maxY - b.minY - 160)
    if (!open(x, y)) continue
    const hs: Enemy[] = []
    for (let h = 0; h < nH; h++) {
      for (let tries = 0; tries < 60; tries++) {
        const a = rand() * 2 * Math.PI
        const d = 80 + rand() * 60
        const ex = x + Math.cos(a) * d
        const ey = y + Math.sin(a) * d
        if (!open(ex, ey)) continue
        if (!map.hasVisionLOS([ex, ey, map.heightAt(ex, ey) + 8], [x, y, map.heightAt(x, y) + 4.5], { canopy: true })) continue
        hs.push({ id: 10 + h, x: ex, y: ey, vx: 0, vy: 0, hp: 1400, policy: "hunter", speed: 10 + rand() * 1.7, hitProb: HIT })
        break
      }
    }
    if (hs.length === nH) return { pos: [x, y] as [number, number], hunters: hs }
  }
  return null
}

const zone = (x: number, y: number) => [{ t0: 0, shrinkStart: 1e6, shrinkEnd: 1e6 + 1, c0: [x, y], r0: 5000, c1: [x, y], r1: 5000, dps: 0 }]
type Agg = { n: number; died: number; hp: number; seen: number; dmg: number; healed: number }
const arms: Array<[string, Record<string, unknown>]> = [
  ["off", { vanishEnabled: false }],
  ["on", { vanishEnabled: true }],
]
console.log(`start HP 500/1400, ${DUR}s, hunter hit prob ${HIT}`)
const total: Record<string, Agg> = {}
const onModes: Record<string, number> = {}
for (const nH of [1, 2, 3]) {
  const agg: Record<string, Agg> = {}
  for (let k = 0; k < N; k++) {
    const sc = setup(5000 * nH + k + OFF, nH)
    if (!sc) continue
    for (const [name, o] of arms) {
      Object.assign(LOCOMOTION as Record<string, unknown>, DEFAULTS, o)
      const r = await run(L, { root, kit, seed: 99 + k + OFF, startPhase: 0, pos: sc.pos, enemies: sc.hunters.map((h) => ({ ...h })), zoneOverride: zone(sc.pos[0], sc.pos[1]), startHp: 500, untilT: DUR })
      if (name === "on") for (const [m, c] of Object.entries(r.modes)) onModes[m] = (onModes[m] ?? 0) + c
      for (const key of [name, `${name}#all`]) {
        const a = (key.endsWith("#all") ? total : agg)[key.replace("#all", "")] ?? { n: 0, died: 0, hp: 0, seen: 0, dmg: 0, healed: 0 }
        a.n++
        a.died += r.died ? 1 : 0
        a.hp += r.hp
        a.seen += r.seenS
        a.dmg += r.enemyDamage
        a.healed += !r.died && r.hp >= 1100 ? 1 : 0
        ;(key.endsWith("#all") ? total : agg)[key.replace("#all", "")] = a
      }
    }
  }
  const row = (n: string) => {
    const a = agg[n]!
    return `${n}: died ${a.died}/${a.n}, end HP ${(a.hp / a.n).toFixed(0)}, healed>=1100 ${a.healed}, seen ${(a.seen / a.n).toFixed(1)}s, dmg taken ${(a.dmg / a.n).toFixed(0)}`
  }
  console.log(`hunters=${nH}  ${row("off")}  ||  ${row("on")}`)
}
const tr = (n: string) => {
  const a = total[n]!
  return `${n}: died ${a.died}/${a.n} (${((100 * a.died) / a.n).toFixed(0)}%), end HP ${(a.hp / a.n).toFixed(0)}, healed ${a.healed}, seen ${(a.seen / a.n).toFixed(1)}s, dmg ${(a.dmg / a.n).toFixed(0)}`
}
console.log(`ALL  ${tr("off")}  ||  ${tr("on")}`)
const tm = Object.values(onModes).reduce((a, b) => a + b, 0)
console.log('vanish ON modes:', Object.entries(onModes).sort((a, b) => b[1] - a[1]).map(([m, c]) => `${m}:${((100 * c) / tm).toFixed(1)}%`).join(' '))
