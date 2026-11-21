/**
 * Zone-navigation evaluation: the real Bot on the real map, no enemies, many random spawns, per zone phase.
 *   node scripts/nav-eval.ts --root <repo root> --phase 3 --n 60 --seed 1
 * Reports deaths, zone damage and time outside the circle. Kinematic harness only (see scripts/lib/sim.ts):
 * it validates navigation, it does not predict official placement.
 */
import { join, resolve } from "node:path"
import { load, run, type SimResult } from "./lib/sim.ts"

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf("--" + k)
  return i >= 0 ? process.argv[i + 1]! : d
}
const root = resolve(arg("root", join(import.meta.dirname, "..")))
const kit = resolve(arg("kit", join(import.meta.dirname, "..", "_kit")))
const phase = Number(arg("phase", "3"))
const n = Number(arg("n", "40"))
const seed0 = Number(arg("seed", "1"))
const L = await load(root, kit)
const rows: SimResult[] = []
const t0 = Date.now()
for (let k = 0; k < n; k++) rows.push(await run(L, { root, kit, seed: seed0 * 1000 + k, startPhase: phase }))
const mean = (f: (r: SimResult) => number) => +(rows.reduce((a, r) => a + f(r), 0) / rows.length).toFixed(2)
const q = (f: (r: SimResult) => number, p: number) => +[...rows].map(f).sort((a, b) => a - b)[Math.min(rows.length - 1, Math.floor(p * rows.length))]!.toFixed(1)
console.log(
  JSON.stringify({
    root: root.split(/[\\/]/).pop(),
    phase,
    n,
    deaths: rows.filter((r) => r.died).length,
    zoneDmgMean: mean((r) => r.zoneDamage),
    zoneDmgP90: q((r) => r.zoneDamage, 0.9),
    zoneDmgMax: q((r) => r.zoneDamage, 0.999),
    outsideS_mean: mean((r) => r.timeOutside),
    outsideS_p90: q((r) => r.timeOutside, 0.9),
    endHpMean: mean((r) => r.hp),
    decideMs: (() => {
      // the first 3 decisions of a run are dropped: in a real match Session's warm-up ticks pay the JIT cost before `ready`
      const all = rows.flatMap((r) => r.decideMs.slice(3)).sort((a, b) => a - b)
      const at = (p: number) => +all[Math.min(all.length - 1, Math.floor(p * all.length))]!.toFixed(2)
      return { n: all.length, p50: at(0.5), p99: at(0.99), p999: at(0.999), over5ms: all.filter((v) => v > 5).length, over10ms: all.filter((v) => v > 10).length, over20ms: all.filter((v) => v > 20).length, max: +all[all.length - 1]!.toFixed(1) }
    })(),
    seconds: Math.round((Date.now() - t0) / 1000),
  }),
)
