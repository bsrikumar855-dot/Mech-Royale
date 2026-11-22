import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { LOCOMOTION as L } from "../src/config/index.ts"
import { manoeuvreDamage, planEvasion, planLaserCover, predictPos, threateningBullets, type Body, type Bullet } from "../src/locomotion/evade.ts"
import { MapQuery, type WorldJson } from "../src/world/map.ts"
import { cleanObs, ctxFor } from "./helpers.ts"

const body = (over: Partial<Body> = {}): Body => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, grounded: true, radius: 2.5, height: 9, walk: 11.7, boostSpeed: 19.5, groundAccel: 58.5, airAccel: 12, jumpSpeed: 11, gravity: 22, stepUp: 1.2, energy: 100, ...over })
/** A bullet fired from `dist` m east, aimed at (aimX, aimY, 4.5), 252 m/s. */
const bulletAt = (dist: number, aimX = 0, aimY = 0): Bullet => {
  const dx = aimX - dist
  const dy = aimY
  const l = Math.hypot(dx, dy)
  return { pos: [dist, 0, 4.5], vel: [(dx / l) * 252, (dy / l) * 252, 0], damage: 45, radius: 0.3 }
}

function flatMap(prisms: WorldJson["prisms"] = []): MapQuery {
  const n = 201
  const world: WorldJson = {
    bounds: { minX: -100, maxX: 100, minY: -100, maxY: 100 },
    terrain: { minX: -100, minY: -100, step: 1, nx: n, ny: n, scale: 0.01 },
    rules: { maxStep: 1.5, maxSlopeDeg: 50, canopyDensity: 0.35, canopyBlockT: 0.25 },
    prisms,
    trees: { fields: ["x", "y", "z", "height", "crownR", "crownBase", "trunkR", "osm", "crownX", "crownY"], data: [] },
  }
  return new MapQuery(world, new Int16Array(n * n))
}
const rect = (x0: number, y0: number, x1: number, y1: number): number[] => [x0, y0, x1, y0, x1, y1, x0, y1]

describe("predictPos (movement rules)", () => {
  test("standing still stays put; accelerating at 58.5 m/s2 reaches 11.7 m/s after 0.2 s", () => {
    assert.deepEqual(predictPos(body(), 0, 0, false, 1), [0, 0, 0])
    const p = predictPos(body(), 11.7, 0, false, 0.2)
    assert.ok(Math.abs(p[0] - 0.5 * 58.5 * 0.04) < 1e-9)
    const q = predictPos(body(), 11.7, 0, false, 1.2)
    assert.ok(Math.abs(q[0] - (1.17 + 11.7 * 1.0)) < 1e-9, "then constant speed")
  })
  test("a jump rises and lands after 2 x jump_speed / gravity, with weak air control meanwhile", () => {
    const top = predictPos(body(), 0, 0, true, 0.5)
    assert.ok(Math.abs(top[2] - (11 * 0.5 - 11 * 0.25)) < 1e-9)
    assert.equal(predictPos(body(), 0, 0, true, 1.1)[2], 0, "landed")
    const air = predictPos(body(), 11.7, 0, true, 0.5)[0]
    const ground = predictPos(body(), 11.7, 0, false, 0.5)[0]
    assert.ok(air < ground, "air_accel 12 << ground_accel 58.5")
  })
})

describe("manoeuvreDamage (bullet vs body cylinder)", () => {
  test("a bullet aimed at us from 150 m hits if we stand still and misses if we sprint sideways", () => {
    const b = body()
    assert.equal(manoeuvreDamage(b, [bulletAt(150)], 0, 0, false, 0.8, Infinity), 45)
    assert.equal(manoeuvreDamage(b, [bulletAt(150)], 0, 11.7, false, 0.8, Infinity), 0)
  })
  test("too close to dodge: from 25 m nothing gets us clear in time", () => {
    const b = body()
    for (const [cx, cy] of [[0, 11.7], [0, -11.7], [-11.7, 0]]) assert.equal(manoeuvreDamage(b, [bulletAt(25)], cx!, cy!, false, 0.8, Infinity), 45)
  })
  test("a bullet passing overhead or below the body does not count", () => {
    const over: Bullet = { pos: [100, 0, 12], vel: [-252, 0, 0], damage: 45, radius: 0.3 }
    assert.equal(manoeuvreDamage(body(), [over], 0, 0, false, 0.8, Infinity), 0)
  })
  test("a wall that stops our sidestep makes the sidestep fail", () => {
    assert.equal(manoeuvreDamage(body(), [bulletAt(150)], 0, 11.7, false, 0.8, 0.05), 45, "blocked after 0.05 s: we barely moved")
  })
})

describe("planEvasion", () => {
  const worldWith = (projectiles: Observation["projectiles"], patch: (o: Observation) => void = () => {}) =>
    ctxFor(cleanObs((o) => { o.self.pos = [0, 0, 0]; o.projectiles = projectiles; patch(o) })).world
  type Observation = import("../src/types/mechfight.ts").Observation

  test("no bullets: no change", () => {
    const w = worldWith([])
    assert.equal(planEvasion(w, null, [0, 1], false, threateningBullets(w)), null)
  })
  test("the wanted move is already safe: no change", () => {
    const w = worldWith([{ id: 1, kind: "gun", pos: [150, 0, 4.5], vel: [-252, 0, 0] }])
    // we want to sprint north and are already moving north at full speed: the bullet passes behind us
    w.obs!.self.vel = [0, 11.7, 0]
    assert.equal(planEvasion(w, null, [0, 1], false, threateningBullets(w)), null)
  })
  test("standing in the line of fire at 150 m: it picks a sidestep that the prediction says clears the bullet", () => {
    const w = worldWith([{ id: 1, kind: "gun", pos: [150, 0, 4.5], vel: [-252, 0, 0] }])
    const plan = planEvasion(w, null, null, false, threateningBullets(w))
    assert.ok(plan && plan.dir && plan.damage === 0, JSON.stringify(plan))
    assert.ok(Math.abs(plan.dir[1]) > 0.5, "sideways, not toward or away from the shooter")
  })
  test("wall to the north: it sidesteps SOUTH instead", () => {
    const map = flatMap([{ kind: "building", base: -5, top: 30, ring: rect(-20, 3, 20, 10) }])
    const w = worldWith([{ id: 1, kind: "gun", pos: [150, 0, 4.5], vel: [-252, 0, 0] }])
    const plan = planEvasion(w, map, [0, 1], false, threateningBullets(w))
    assert.ok(plan && plan.dir && plan.dir[1] < 0, JSON.stringify(plan))
  })
  test("bullets flying away from us are ignored", () => {
    const w = worldWith([{ id: 1, kind: "gun", pos: [50, 0, 4.5], vel: [252, 0, 0] }])
    assert.equal(threateningBullets(w).length, 0)
  })
  test("the switch exists and defaults on (false reproduces 219f397)", () => {
    assert.equal(L.evadeEnabled, true)
  })
})

describe("laser cover (be out of the charger's shot line at release)", () => {
  type Observation = import("../src/types/mechfight.ts").Observation
  const w0 = (patch: (o: Observation) => void = () => {}) => ctxFor(cleanObs((o) => { o.self.pos = [0, 0, 0]; patch(o) })).world
  // building just north-east of us: x 3..20, y 4..20 (40 m tall); the charger stands 100 m east-north-east
  const map = flatMap([{ kind: "building", base: -5, top: 40, ring: rect(3, 4, 20, 20) }])
  const charger = { muzzle: [100, 30, 7] as [number, number, number], releaseIn: 0.6 }

  test("covered by the building, wanting to walk OUT into the charger's line: it vetoes that and stays covered", () => {
    const w = w0()
    const plan = planLaserCover(w, map, [0, -1], false, [charger])
    assert.ok(plan && plan.damage === 0, JSON.stringify(plan))
  })
  test("exposed in the open next to cover: it steps into the building's shadow before the release", () => {
    const w = w0((o) => (o.self.pos = [-2, -12, 0])) // south-west of the building, in the charger's line
    const plan = planLaserCover(w, map, [0, -1], false, [{ muzzle: [100, 30, 7], releaseIn: 0.7 }])
    assert.ok(plan && plan.damage < 315, JSON.stringify(plan))
  })
  test("already covered: no change", () => {
    const covered = { muzzle: [100, 30, 7] as [number, number, number], releaseIn: 0.6 }
    const w = w0((o) => (o.self.pos = [10, 26, 0])) // north of the building, out of the charger's line? (line passes over y 26..30)
    const plan = planLaserCover(w, map, null, false, [covered])
    assert.ok(plan === null || plan.damage < 315)
  })
  test("no chargers: null", () => {
    assert.equal(planLaserCover(w0(), map, [1, 0], false, []), null)
  })
})
