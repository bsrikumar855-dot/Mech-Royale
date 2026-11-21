import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { LOCOMOTION } from "../src/config/index.ts"
import { blockedAhead, RuleLocomotion, steerAround } from "../src/locomotion/index.ts"
import type { LootTarget } from "../src/types/contracts.ts"
import type { Observation } from "../src/types/mechfight.ts"
import { pointInRing } from "../src/world/polygon.ts"
import { WorldModel } from "../src/world/world.ts"
import { cleanObs, ctxFor, enemy, fixtureHello, HAS_ARENA, realMap, syntheticMap } from "./helpers.ts"

const smap = syntheticMap()
const decide = (patch: (o: Observation) => void, loot: LootTarget[] = [], map = null as ReturnType<typeof syntheticMap> | null) =>
  new RuleLocomotion().decide(ctxFor(cleanObs(patch), map), loot)
const len = (m: readonly number[]): number => Math.hypot(m[0]!, m[1]!)
const zone = (o: Observation, cx: number, cy: number, r: number): void => {
  o.zone = { center: [cx, cy], radius: r, next_center: [cx, cy], next_radius: r, shrink_start: 1e6, shrink_end: 1e6 + 1, dps: 20 }
}
const loot = (x: number, y: number, value = 5): LootTarget => ({ x, y, z: 0, value, kind: "cube" })

describe("zone safety", () => {
  test("outside the zone: head for the centre and BOOST (energy above the minimum)", () => {
    const out = decide((o) => { zone(o, 0, 0, 100); o.self.pos = [200, 0, 0]; o.self.in_zone = false; o.self.energy = 50 })
    assert.ok(out.move[0] < -0.99 && Math.abs(out.move[1]) < 0.01, `move ${out.move}`)
    assert.equal(out.boost, true)
    assert.equal(out.jump, false)
  })

  test("outside the zone but low on energy: still runs in, does not boost", () => {
    const out = decide((o) => { zone(o, 0, 0, 100); o.self.pos = [200, 0, 0]; o.self.in_zone = false; o.self.energy = LOCOMOTION.boostMinEnergy })
    assert.ok(out.move[0] < -0.99)
    assert.equal(out.boost, false)
  })

  test("inside the zone but past 85% of the radius: move inward WITHOUT boosting", () => {
    const out = decide((o) => { zone(o, 0, 0, 100); o.self.pos = [92, 0, 0] })
    assert.ok(out.move[0] < -0.99)
    assert.equal(out.boost, false)
  })

  test("comfortably inside with nothing to do: stand still (silent, hard to find)", () => {
    const out = decide((o) => { zone(o, 0, 0, 100); o.self.pos = [10, 0, 0] })
    assert.deepEqual(out.move, [0, 0])
    assert.equal(out.boost, false)
  })

  test("plans for the NEXT circle: a shrink 10 s away already pulls us in, using zoneAt(t + 10)", () => {
    const out = decide((o) => {
      o.t = 10
      o.zone = { center: [0, 0], radius: 500, next_center: [0, 0], next_radius: 100, shrink_start: 12, shrink_end: 14, dps: 20 }
      o.self.pos = [200, 0, 0] // inside the CURRENT circle, far outside the one it becomes
    })
    assert.ok(out.move[0] < -0.99)
    assert.equal(out.boost, false, "still in the zone, so no boost")
  })

  test("a moving centre: heads for where the zone WILL be", () => {
    const out = decide((o) => {
      o.t = 10
      o.zone = { center: [0, 0], radius: 500, next_center: [0, 300], next_radius: 100, shrink_start: 12, shrink_end: 14, dps: 20 }
      o.self.pos = [0, 0, 0]
    })
    assert.ok(out.move[1] > 0.99, `move ${out.move}`)
  })
})

describe("kiting", () => {
  test("enemy within 40 m while safely inside: back away, with a sideways component, unit speed, no boost", () => {
    const out = decide((o) => { zone(o, 0, 0, 500); o.mechs = [enemy(5, [30, 0, 0])] })
    assert.ok(out.move[0] < -0.8, `moves away: ${out.move}`)
    assert.ok(Math.abs(out.move[1]) > 0.1, "mild strafe")
    assert.ok(Math.abs(len(out.move) - 1) < 1e-9)
    assert.equal(out.boost, false)
  })

  test("strafes toward the safe side of the zone", () => {
    const north = decide((o) => { zone(o, 0, 100, 500); o.mechs = [enemy(5, [30, 0, 0])] })
    const south = decide((o) => { zone(o, 0, -100, 500); o.mechs = [enemy(5, [30, 0, 0])] })
    assert.ok(north.move[1] > 0 && south.move[1] < 0)
  })

  test("never kites out of the safe zone: near the rim it bends inward", () => {
    const out = decide((o) => { zone(o, 0, 0, 100); o.self.pos = [84, 0, 0]; o.mechs = [enemy(5, [60, 0, 0])] })
    const q = [84 + out.move[0] * LOCOMOTION.kiteLookaheadM, out.move[1] * LOCOMOTION.kiteLookaheadM]
    assert.ok(Math.hypot(q[0]!, q[1]!) <= 100 * LOCOMOTION.safeRadiusFrac + 1e-9, `stays inside: ${q}`)
  })

  test("an enemy beyond 40 m does not trigger kiting", () => {
    assert.deepEqual(decide((o) => { zone(o, 0, 0, 500); o.mechs = [enemy(5, [50, 0, 0])] }).move, [0, 0])
  })

  test("drones are not kited (only enemy mechs)", () => {
    const out = decide((o) => { zone(o, 0, 0, 500); o.mechs = [{ id: 101, kind: "npc", pos: [10, 0, 0], vel: [0, 0, 0], aim: [0, 0] }] })
    assert.deepEqual(out.move, [0, 0])
  })

  test("the zone still wins over kiting", () => {
    const out = decide((o) => { zone(o, 0, 0, 100); o.self.pos = [200, 0, 0]; o.self.in_zone = false; o.mechs = [enemy(5, [180, 0, 0])] })
    assert.ok(out.move[0] < -0.99, "runs in, toward the enemy side if it must")
  })
})

describe("short safe loot detour", () => {
  test("walks to a visible cube within 25 m when no enemy is near", () => {
    const out = decide((o) => zone(o, 0, 0, 500), [loot(20, 0)])
    assert.ok(out.move[0] > 0.99)
  })
  test("ignores loot beyond 25 m", () => {
    assert.deepEqual(decide((o) => zone(o, 0, 0, 500), [loot(26, 0)]).move, [0, 0])
  })
  test("ignores loot outside the safe zone", () => {
    assert.deepEqual(decide((o) => { zone(o, 0, 0, 100); o.self.pos = [70, 0, 0] }, [loot(90, 0)]).move, [0, 0])
  })
  test("takes the highest-value target, not just the nearest", () => {
    const out = decide((o) => zone(o, 0, 0, 500), [loot(5, 0, 2), loot(0, 20, 9)])
    assert.ok(out.move[1] > 0.99)
  })
  test("no detour with an enemy mech within 35 m (kites instead); allowed again beyond 40 m", () => {
    const near = decide((o) => { zone(o, 0, 0, 500); o.mechs = [enemy(5, [-30, 0, 0])] }, [loot(20, 0)])
    assert.ok(near.move[0] > 0.5, "kiting AWAY from the enemy happens to be toward +x here")
    const nearOther = decide((o) => { zone(o, 0, 0, 500); o.mechs = [enemy(5, [30, 0, 0])] }, [loot(20, 0)])
    assert.ok(nearOther.move[0] < -0.5, "enemy at 30 m: kite away, NOT toward the cube")
    const far = decide((o) => { zone(o, 0, 0, 500); o.mechs = [enemy(5, [45, 0, 0])] }, [loot(0, 20)])
    assert.ok(far.move[1] > 0.99, "enemy 45 m away: the detour is on")
  })
  test("stops at the cube instead of orbiting it", () => {
    assert.deepEqual(decide((o) => zone(o, 0, 0, 500), [loot(1, 0)]).move, [0, 0])
  })
  test("never jumps in v1", () => {
    assert.equal(decide((o) => zone(o, 0, 0, 500), [loot(20, 0)]).jump, false)
  })
})

describe("wall feeler (no pathfinder)", () => {
  // Synthetic building A occupies x 0..10, y 0..10 (top 20). We stand west of it at (-6, 5).
  const world = (): WorldModel => {
    const w = new WorldModel(fixtureHello())
    w.update(cleanObs((o) => { o.self.pos = [-6, 5, smap.heightAt(-6, 5)]; zone(o, 0, 0, 500) }))
    return w
  }

  test("blockedAhead: the wall is felt 4 m out, open ground and map edges are classified", () => {
    const w = world()
    assert.equal(blockedAhead(smap, w, [1, 0]), true)
    assert.equal(blockedAhead(smap, w, [-1, 0]), false)
    assert.equal(blockedAhead(smap, w, [0, 1]), false)
    w.update(cleanObs((o) => { o.tick = 202; o.self.pos = [48.5, 0, smap.heightAt(48.5, 0)]; zone(o, 0, 0, 500) }))
    assert.equal(blockedAhead(smap, w, [1, 0]), true, "the map edge is a wall")
  })

  test("steerAround: open heading is kept; a blocked one is rotated to the first open candidate; no map = passthrough", () => {
    const w = world()
    assert.deepEqual(steerAround(smap, w, [0, 1]), [0, 1])
    const r = steerAround(smap, w, [1, 0])!
    assert.ok(r && Math.abs(len(r) - 1) < 1e-9 && blockedAhead(smap, w, r) === false)
    const deg = (Math.atan2(r[1], r[0]) * 180) / Math.PI
    assert.ok(LOCOMOTION.steerAnglesDeg.includes(Math.round(deg)), `deviation ${deg} must be one of the configured angles`)
    assert.deepEqual(steerAround(null, w, [1, 0]), [1, 0])
  })

  test("a loot target behind the building: the walker is steered around it instead of into it", () => {
    const out = decide((o) => { o.self.pos = [-6, 5, smap.heightAt(-6, 5)]; zone(o, 0, 0, 500) }, [loot(14, 5)], smap)
    assert.ok(Math.abs(len(out.move) - 1) < 1e-9)
    assert.notDeepEqual(out.move, [1, 0])
    const w = world()
    assert.equal(blockedAhead(smap, w, out.move as [number, number]), false)
  })

  test("boxed in on every heading: stands still rather than walking into a wall", () => {
    // A map where every probe is blocked (walls all round): steerAround finds nothing and the walker stays put.
    const walled = { bounds: smap.bounds, slopeDegAt: () => 0, heightAt: () => 0, isBlockedAt: () => true } as unknown as typeof smap
    const w = world()
    assert.equal(steerAround(walled, w, [1, 0]), null)
    const out = new RuleLocomotion().decide(
      ctxFor(cleanObs((o) => { o.self.pos = [-6, 5, 0]; zone(o, 0, 0, 500) }), walled),
      [loot(14, 5)],
    )
    assert.deepEqual(out.move, [0, 0])
    assert.equal(out.boost, false)
  })
})

describe("wall feeler against a REAL building", { skip: !HAS_ARENA && "arena not found" }, () => {
  test("walking straight at a real wall from 3.2 m away is steered to an open heading", () => {
    const { map } = realMap()
    let tested = 0
    for (const p of map.prisms) {
      if (p.kind !== "building" || p.holes.length > 0 || p.top - p.base < 12) continue
      const n = p.ring.length / 2
      for (let i = 0; i < n && tested < 25; i++) {
        const j = (i + 1) % n
        const ax = p.ring[2 * i]!, ay = p.ring[2 * i + 1]!, bx = p.ring[2 * j]!, by = p.ring[2 * j + 1]!
        const l = Math.hypot(bx - ax, by - ay)
        if (l < 10) continue
        const mx = (ax + bx) / 2, my = (ay + by) / 2
        let nx = -(by - ay) / l, ny = (bx - ax) / l
        if (pointInRing(mx + nx * 0.5, my + ny * 0.5, p.ring)) { nx = -nx; ny = -ny }
        const x = mx + nx * 3.2, y = my + ny * 3.2
        const z = map.heightAt(x, y)
        const w = new WorldModel(fixtureHello())
        w.update(cleanObs((o) => { o.self.pos = [x, y, z]; zone(o, x, y, 5000) }))
        const into: [number, number] = [-nx, -ny]
        if (!blockedAhead(map, w, into)) continue // not a wall probe (a gap, a ledge, a neighbour): skip
        const r = steerAround(map, w, into)
        if (r === null) continue // genuinely boxed in: standing still is the correct answer
        assert.equal(blockedAhead(map, w, r), false, "steered heading must be open")
        assert.ok(r[0] * into[0] + r[1] * into[1] < 0.999, "must differ from the blocked heading")
        tested++
      }
    }
    assert.ok(tested >= 8, `only ${tested} real wall probes were usable`)
  })
})

describe("integration", () => {
  test("every recorded observation yields a finite, in-range, schema-shaped action", async () => {
    const { Bot } = await import("../src/bot.ts")
    const { NO_DEADLINE } = await import("../src/runtime/deadline.ts")
    const { fixtureObs } = await import("./helpers.ts")
    const bot = new Bot(new WorldModel(fixtureHello()), HAS_ARENA ? realMap().map : null)
    for (const o of fixtureObs()) {
      const a = bot.decide(o, NO_DEADLINE)
      assert.equal(a.tick, o.tick)
      assert.ok(a.move && Math.hypot(a.move[0], a.move[1]) <= 1 + 1e-9)
      assert.ok(a.aim && Number.isFinite(a.aim[0]) && a.aim[1] >= -0.7 && a.aim[1] <= 1.3)
      assert.ok(a.fire && a.fire.length === 2)
      assert.equal(a.jump, false)
      assert.equal(a.drop, undefined)
      assert.doesNotThrow(() => JSON.stringify(a))
    }
  })
})
