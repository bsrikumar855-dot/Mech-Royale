import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ECONOMY } from "../src/config/index.ts"
import { bestUpgradeIndex, RuleEconomy } from "../src/economy/index.ts"
import type { Observation, PickupObs, WeaponKind } from "../src/types/mechfight.ts"
import { cleanObs, ctxFor, fixtureHello, lightningWeapon } from "./helpers.ts"

const choice = (id: string) => ({ id, name: id, desc: "" })
const pickup = (id: number, kind: WeaponKind, pos: [number, number, number]): PickupObs => ({ id, kind, pos })
const decide = (o: Observation) => new RuleEconomy().decide(ctxFor(o))

describe("upgrade ranking and offer picking", () => {
  test("ALL upgrade ids in hello.config are ranked, with no duplicates and no stale entries", () => {
    const ids = fixtureHello().config.upgrades.map((u) => u.id)
    assert.equal(ids.length, 22)
    for (const id of ids) assert.ok(ECONOMY.upgradePriority.includes(id), `${id} is unranked`)
    assert.equal(new Set(ECONOMY.upgradePriority).size, ECONOMY.upgradePriority.length, "duplicate in the priority list")
    assert.deepEqual([...ECONOMY.upgradePriority].sort(), [...ids].sort(), "priority list and hello.config.upgrades must match exactly")
  })

  test("submission 26: the whole weapon-damage snowball (gun + laser + lightning) now leads, then survivability, then regen/mobility: gun_rate > gun_damage > laser_damage > laser_charge > lightning_efficiency > armor > plating > nanites > servos", () => {
    const rank = (id: string): number => ECONOMY.upgradePriority.indexOf(id)
    for (const [a, b] of [["gun_rate", "gun_damage"], ["gun_damage", "laser_damage"], ["laser_damage", "laser_charge"], ["laser_charge", "lightning_efficiency"], ["lightning_efficiency", "lightning_range"], ["lightning_range", "lightning_chain"], ["lightning_chain", "armor"], ["armor", "plating"], ["plating", "nanites"], ["nanites", "servos"], ["servos", "gun_mag"], ["sensors", "mortar_reload"]] as const) {
      assert.ok(rank(a) < rank(b), `${a} should outrank ${b}`)
    }
  })

  test("picks the best-ranked choice by index; an offer always produces a pick", () => {
    assert.equal(bestUpgradeIndex([choice("gun_damage"), choice("armor"), choice("sensors")]), 0, "submission 24: gun_damage now outranks armor")
    assert.equal(bestUpgradeIndex([choice("lightning_chain"), choice("gun_rate"), choice("jets")]), 1)
    assert.equal(bestUpgradeIndex([choice("mortar_splash"), choice("sensors"), choice("jets")]), 1)
    const o = cleanObs((x) => (x.offer = { id: 1, expires: 99, choices: [choice("gun_velocity"), choice("plating"), choice("gun_mag")] }))
    assert.equal(decide(o).pick, 1)
  })

  test("an unranked id never beats a ranked one; all-unranked and ties fall back to the first choice", () => {
    assert.equal(bestUpgradeIndex([choice("mystery_new"), choice("mortar_velocity")]), 1)
    assert.equal(bestUpgradeIndex([choice("x1"), choice("x2"), choice("x3")]), 0)
    assert.equal(bestUpgradeIndex([]), undefined)
  })

  test("no pending offer -> no pick", () => {
    assert.equal(decide(cleanObs()).pick, undefined)
  })
})

describe("weapon take rule: lightning only, into an empty slot, within reach", () => {
  test("takes lightning when in reach and slot 1 is empty", () => {
    const o = cleanObs((x) => (x.pickups = [pickup(8001, "lightning", [2, 1, 0])]))
    assert.equal(decide(o).take, 8001)
  })

  test("NEVER takes a mortar, even right at our feet, and it is never a loot target", () => {
    const o = cleanObs((x) => (x.pickups = [pickup(8001, "mortar", [0.5, 0, 0])]))
    const out = decide(o)
    assert.equal(out.take, undefined)
    assert.equal(out.lootTargets.length, 0)
  })

  test("a mixed pile: the laser beats lightning even when farther; the nearest of several lightnings otherwise", () => {
    const pile = cleanObs((x) => (x.pickups = [pickup(8001, "mortar", [1, 0, 0]), pickup(8002, "lightning", [0.5, 0, 0]), pickup(8004, "laser", [3, 0, 0])]))
    assert.equal(decide(pile).take, 8004)
    const two = cleanObs((x) => (x.pickups = [pickup(8002, "lightning", [3, 0, 0]), pickup(8003, "lightning", [2, 0, 0])]))
    assert.equal(decide(two).take, 8003)
  })

  test("no take when slot 1 is occupied, or when we already hold lightning", () => {
    const full = cleanObs((x) => {
      x.self.weapons[1] = { kind: "laser", cooldown: 0, charge: 0, stats: {} }
      x.pickups = [pickup(8001, "lightning", [1, 0, 0])]
    })
    assert.equal(decide(full).take, undefined)
    const dup = cleanObs((x) => {
      x.self.weapons = [lightningWeapon(), null]
      x.pickups = [pickup(8001, "lightning", [1, 0, 0])]
    })
    assert.equal(decide(dup).take, undefined)
  })

  test("reach: loot.pickup_radius (4 m) horizontally and 4 m vertically, inclusive", () => {
    const at = (pos: [number, number, number]) => decide(cleanObs((x) => (x.pickups = [pickup(8001, "lightning", pos)]))).take
    assert.equal(at([4, 0, 0]), 8001)
    assert.equal(at([4.01, 0, 0]), undefined)
    assert.equal(at([0, 0, 4]), 8001)
    assert.equal(at([0, 0, 4.01]), undefined)
    assert.equal(at([0, 0, -4.5]), undefined)
    assert.equal(at([3, 3, 0]), undefined) // horizontal distance is 4.24: Euclidean, not per-axis
  })
})

describe("LootTargets", () => {
  test("cubes and wanted lightning pickups become targets; value falls with distance", () => {
    const o = cleanObs((x) => {
      x.cubes = [{ id: 5001, pos: [10, 0, 0] }, { id: 5002, pos: [40, 0, 0] }]
      x.pickups = [pickup(8001, "lightning", [10, 10, 0]), pickup(8002, "mortar", [5, 0, 0])]
    })
    const t = decide(o).lootTargets
    assert.equal(t.filter((l) => l.kind === "cube").length, 2)
    assert.equal(t.filter((l) => l.kind === "weapon").length, 1, "only the lightning")
    const [near, far] = t.filter((l) => l.kind === "cube") as [(typeof t)[number], (typeof t)[number]]
    assert.ok(near.value > far.value, "nearer cube is worth more")
    assert.ok(near.value > 0 && far.value > 0)
    assert.deepEqual([near.x, near.y, near.z], [10, 0, 0])
  })

  test("lightning pickups stop being targets once slot 1 is full; cubes remain", () => {
    const o = cleanObs((x) => {
      x.self.weapons[1] = { kind: "mortar", cooldown: 0, stats: {} }
      x.cubes = [{ id: 5001, pos: [5, 0, 0] }]
      x.pickups = [pickup(8001, "lightning", [3, 0, 0])]
    })
    const t = decide(o).lootTargets
    assert.deepEqual(t.map((l) => l.kind), ["cube"])
  })

  test("an empty world yields an empty, well-formed output", () => {
    const out = decide(cleanObs())
    assert.deepEqual(out.lootTargets, [])
    assert.equal(out.take, undefined)
    assert.equal(out.drop, undefined)
  })
})
