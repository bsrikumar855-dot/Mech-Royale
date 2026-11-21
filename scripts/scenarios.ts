/**
 * Constructed survival scenarios: the REAL Bot on the REAL map inside the kinematic harness (scripts/lib/sim.ts).
 *   node scripts/scenarios.ts --root <repo root>
 * Each scenario prints: initial state, expected behaviour, actual metrics, and a verdict against a stated predicate.
 * These are CONSTRUCTED unit scenarios (static / simple scripted enemies, expected-DPS shooting, no weapons on our side):
 * they document behaviour, they do not predict placement.
 */
import { join, resolve } from "node:path"
import { circleAt, load, phases, rng, run, type Enemy, type SimResult } from "./lib/sim.ts"

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf("--" + k)
  return i >= 0 ? process.argv[i + 1]! : d
}
const root = resolve(arg("root", join(import.meta.dirname, "..")))
const kit = resolve(arg("kit", join(import.meta.dirname, "..", "_kit")))
const L = await load(root, kit)
const map = L.map
const body = { radius: 2.5, height: 9, stepUp: 1.2 }

/** Nearest open (unblocked, gentle) ground to (x, y). */
function open(x: number, y: number): [number, number] {
  for (let r = 0; r < 80; r += 2) {
    for (let a = 0; a < 360; a += 20) {
      const qx = x + Math.cos((a * Math.PI) / 180) * r
      const qy = y + Math.sin((a * Math.PI) / 180) * r
      if (map.isBlockedAt(qx, qy, map.heightAt(qx, qy), body) || map.slopeDegAt(qx, qy) > 25) continue
      return [qx, qy]
    }
  }
  return [x, y]
}
const enemy = (id: number, x: number, y: number, policy: Enemy["policy"], hitProb: number, speed = 11.7): Enemy => {
  const [ex, ey] = open(x, y)
  return { id, x: ex, y: ey, vx: 0, vy: 0, hp: 1400, policy, speed, hitProb }
}
const bigZone = (cx: number, cy: number) => [{ t0: 0, shrinkStart: 1e6, shrinkEnd: 1e6 + 1, c0: [cx, cy] as [number, number], r0: 5000, c1: [cx, cy] as [number, number], r1: 5000, dps: 0 }]
const fmt = (r: SimResult) => `died=${r.died}${r.died ? `@${r.deathT?.toFixed(0)}s` : ""} hp=${r.hp.toFixed(0)} zoneDmg=${r.zoneDamage.toFixed(0)} enemyDmg=${r.enemyDamage.toFixed(0)} outside=${r.timeOutside.toFixed(1)}s minEnemy=${Number.isFinite(r.minEnemyDist) ? r.minEnemyDist.toFixed(0) + "m" : "-"} modes=${JSON.stringify(r.modes)}`

interface Scenario {
  name: string
  initial: string
  expected: string
  predicate: string
  go: () => Promise<{ r: SimResult; ok: boolean; note?: string }>
}

const zoneSeed = 7
const ph = phases(L.hello, rng(zoneSeed), map.bounds)
const scenarios: Scenario[] = [
  {
    name: "1. outside the zone while it closes",
    initial: "phase 3 start (circle r=140 -> 70, 60 dps from its hold on); we stand 40 m OUTSIDE the next circle's edge",
    expected: "run in by the shortest walkable route; little zone damage",
    predicate: "zone damage < 400 and alive",
    go: async () => {
      const P = ph[3]
      const a = Math.atan2(P.c0[1] - P.c1[1], P.c0[0] - P.c1[0])
      const [x, y] = open(P.c1[0] + Math.cos(a + 2) * (P.r1 + 40), P.c1[1] + Math.sin(a + 2) * (P.r1 + 40))
      const r = await run(L, { root, kit, seed: zoneSeed, startPhase: 3, pos: [x, y], untilT: P.shrinkEnd + 5 })
      return { r, ok: !r.died && r.zoneDamage < 400 }
    },
  },
  {
    name: "2. safe but distant final destination",
    initial: "phase 2 start; we stand on the far rim of the current circle, opposite the next centre (~200+ m of walking)",
    expected: "leave early enough to be inside the next circle when it finishes closing",
    predicate: "zone damage < 150 and alive",
    go: async () => {
      const P = ph[2]
      const dx = P.c0[0] - P.c1[0]
      const dy = P.c0[1] - P.c1[1]
      const l = Math.hypot(dx, dy) || 1
      const [x, y] = open(P.c0[0] + (dx / l) * P.r0 * 0.9, P.c0[1] + (dy / l) * P.r0 * 0.9)
      const r = await run(L, { root, kit, seed: zoneSeed, startPhase: 2, pos: [x, y], untilT: P.shrinkEnd + 5 })
      return { r, ok: !r.died && r.zoneDamage < 150 }
    },
  },
  {
    name: "3. dangerous position at the zone centre with a shooter ring",
    initial: "huge safe zone; we stand at (41,-73); 4 static gunners (expected 15% hit rate) at 90 m on the compass points",
    expected: "do not stand still in the crossfire; leave the ring or at least keep moving",
    predicate: "alive after 30 s with > 40% HP",
    go: async () => {
      const es = [0, 90, 180, 270].map((d, i) => enemy(10 + i, 41 + Math.cos((d * Math.PI) / 180) * 90, -73 + Math.sin((d * Math.PI) / 180) * 90, "static", 0.15))
      const r = await run(L, { root, kit, seed: 1, startPhase: 0, pos: open(41, -73), enemies: es, zoneOverride: bigZone(41, -73), untilT: 30 })
      return { r, ok: !r.died && r.hp > 560 }
    },
  },
  {
    name: "4. two enemies approaching from opposite directions",
    initial: "us at (41,-73); pursuers (expected 10% hit rate) start 140 m west and 140 m east",
    expected: "avoid being sandwiched: keep minimum distance > 40 m or take little damage",
    predicate: "alive after 30 s",
    go: async () => {
      const es = [enemy(10, -99, -73, "pursue", 0.1), enemy(11, 181, -73, "pursue", 0.1)]
      const r = await run(L, { root, kit, seed: 1, startPhase: 0, pos: open(41, -73), enemies: es, zoneOverride: bigZone(41, -73), untilT: 30 })
      return { r, ok: !r.died }
    },
  },
  {
    name: "5. three enemies forming a cluster",
    initial: "us at (41,-73); three orbiters (10% hit rate) at 100-120 m, 120 degrees apart",
    expected: "survive; ideally leave their combined line of sight",
    predicate: "alive after 30 s with > 50% HP",
    go: async () => {
      const es = [0, 120, 240].map((d, i) => enemy(10 + i, 41 + Math.cos((d * Math.PI) / 180) * 110, -73 + Math.sin((d * Math.PI) / 180) * 110, "orbit", 0.1, 8))
      const r = await run(L, { root, kit, seed: 1, startPhase: 0, pos: open(41, -73), enemies: es, zoneOverride: bigZone(41, -73), untilT: 30 })
      return { r, ok: !r.died && r.hp > 700 }
    },
  },
  {
    name: "6. approaching enemy in front while another shoots from behind",
    initial: "us at (41,-73); one pursuer 120 m east (10% hit), one static gunner 70 m west (15% hit)",
    expected: "not stand still; stay alive",
    predicate: "alive after 30 s",
    go: async () => {
      const es = [enemy(10, 161, -73, "pursue", 0.1), enemy(11, -29, -73, "static", 0.15)]
      const r = await run(L, { root, kit, seed: 1, startPhase: 0, pos: open(41, -73), enemies: es, zoneOverride: bigZone(41, -73), untilT: 30 })
      return { r, ok: !r.died }
    },
  },
  {
    name: "7. trapped between the zone boundary and enemies",
    initial: "phase 3 hold; we stand 15 m inside the current rim; two static gunners (15% hit) 60 m inward of us, between us and the next centre",
    expected: "taking some gun fire is acceptable; dying to the zone because of hesitation is not",
    predicate: "alive at the end of the shrink",
    go: async () => {
      const P = ph[3]
      const a = Math.atan2(P.c1[1] - P.c0[1], P.c1[0] - P.c0[0])
      const [x, y] = open(P.c0[0] - Math.cos(a) * (P.r0 - 15), P.c0[1] - Math.sin(a) * (P.r0 - 15))
      const es = [enemy(10, x + Math.cos(a) * 60 + 8, y + Math.sin(a) * 60, "static", 0.15), enemy(11, x + Math.cos(a) * 60 - 8, y + Math.sin(a) * 60, "static", 0.15)]
      const r = await run(L, { root, kit, seed: zoneSeed, startPhase: 3, pos: [x, y], enemies: es, untilT: P.shrinkEnd + 5 })
      return { r, ok: !r.died }
    },
  },
  {
    name: "8. favourable covered position with a safe escape route",
    initial: "no cover or escape-route reasoning exists in the bot (cover.ts experiments all regressed and were removed)",
    expected: "n/a: capability absent",
    predicate: "not testable",
    go: async () => ({ r: await run(L, { root, kit, seed: 1, startPhase: 0, pos: open(41, -73), zoneOverride: bigZone(41, -73), untilT: 1 }), ok: false, note: "CAPABILITY ABSENT (not a bot failure to execute: nothing implemented to test)" }),
  },
  {
    name: "9. final zone, two players left",
    initial: "phase 5 start (r=25, 260 dps, closing to 0); we start 12 m from the circle centre; 1 pursuer (10% hit) 80 m away",
    expected: "stay inside the shrinking circle as long as possible (placement is decided by who leaves it last)",
    predicate: "time inside the circle >= 25 s (of the 40 s hold + shrink)",
    go: async () => {
      const P = ph[5]
      const es = [enemy(10, P.c0[0] + 80, P.c0[1], "pursue", 0.1)]
      const r = await run(L, { root, kit, seed: zoneSeed, startPhase: 5, pos: open(P.c0[0] + 12, P.c0[1]), enemies: es, untilT: P.shrinkEnd })
      const inside = (r.endT - ph[5].t0) - r.timeOutside
      return { r, ok: inside >= 25, note: `inside the circle ${inside.toFixed(1)} s of ${(r.endT - ph[5].t0).toFixed(0)} s` }
    },
  },
  {
    name: "10. final zone, three players left",
    initial: "phase 5 start; same, but two pursuers from opposite sides (10% hit)",
    expected: "stay inside the circle as long as possible",
    predicate: "time inside the circle >= 25 s",
    go: async () => {
      const P = ph[5]
      const es = [enemy(10, P.c0[0] + 80, P.c0[1], "pursue", 0.1), enemy(11, P.c0[0] - 80, P.c0[1], "pursue", 0.1)]
      const r = await run(L, { root, kit, seed: zoneSeed, startPhase: 5, pos: open(P.c0[0] + 12, P.c0[1]), enemies: es, untilT: P.shrinkEnd })
      const inside = (r.endT - ph[5].t0) - r.timeOutside
      return { r, ok: inside >= 25, note: `inside the circle ${inside.toFixed(1)} s of ${(r.endT - ph[5].t0).toFixed(0)} s` }
    },
  },
]
void circleAt
let pass = 0
for (const s of scenarios) {
  const { r, ok, note } = await s.go()
  if (ok) pass++
  console.log(`\n${s.name}\n  initial : ${s.initial}\n  expected: ${s.expected}\n  predicate: ${s.predicate}\n  actual  : ${fmt(r)}${note ? `\n  note    : ${note}` : ""}\n  verdict : ${ok ? "SENSIBLE" : "FAIL"}`)
}
console.log(`\nroot=${root.split(/[\\/]/).pop()}  sensible ${pass}/${scenarios.length}`)
