/** 2a lobby detector (squad vs FFA) and the 2b FFA gates. */
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ffaEngageable, RuleCombat, type Cand } from "../src/combat/index.ts"
import { COMBAT, ECONOMY, LOBBY } from "../src/config/index.ts"
import { bestUpgradeIndex } from "../src/economy/index.ts"
import { EvasiveLocomotion } from "../src/locomotion/index.ts"
import { NO_DEADLINE } from "../src/runtime/deadline.ts"
import type { Observation } from "../src/types/mechfight.ts"
import { isFarBeam, newLobby, stepLobby } from "../src/world/lobby.ts"
import { WorldModel } from "../src/world/world.ts"
import { cleanObs, enemy, fixtureHello } from "./helpers.ts"

const hello = fixtureHello()
const at = (t: number, alive: number, patch: (o: Observation) => void = () => {}): Observation =>
  cleanObs((o) => {
    o.t = t
    o.tick = Math.round(t * 20)
    o.alive = alive
    patch(o)
  })
const farBeam = { by: 7, kind: "laser" as const, path: [[200, 0, 7], [200, 150, 7]] as [number, number, number][], age: 0 }

describe("lobby detector (2a)", () => {
  test("our own kills never count as foreign deaths", () => {
    let s = stepLobby(newLobby(), at(10, 16))
    s = stepLobby(s, at(20, 15, (o) => (o.events = [{ type: "kill", target: 3 }])))
    s = stepLobby(s, at(30, 13, (o) => (o.events = [{ type: "kill", target: 4 }, { type: "kill", target: 5 }])))
    assert.equal(s.foreignDeaths, 0)
    assert.equal(s.kind, "squad")
  })
  test(`${LOBBY.earlyForeignDeaths} unexplained deaths before ${LOBBY.earlyBeforeS} s -> ffa, and it never switches back`, () => {
    let s = stepLobby(newLobby(), at(5, 16))
    let alive = 16
    for (let i = 0; i < LOBBY.earlyForeignDeaths; i++) s = stepLobby(s, at(10 + i, --alive))
    assert.equal(s.kind, "ffa")
    assert.equal(s.switchedT, 10 + LOBBY.earlyForeignDeaths - 1)
    s = stepLobby(s, at(200, alive))
    assert.equal(s.kind, "ffa")
  })
  test("the same deaths after the early window need far beams too", () => {
    let s = stepLobby(newLobby(), at(LOBBY.earlyBeforeS + 1, 16))
    s = stepLobby(s, at(LOBBY.earlyBeforeS + 2, 16 - LOBBY.earlyForeignDeaths))
    assert.equal(s.kind, "squad")
    for (let i = 0; i < LOBBY.witnessedFarBeams; i++) s = stepLobby(s, at(LOBBY.earlyBeforeS + 3 + i, 16 - LOBBY.earlyForeignDeaths, (o) => (o.beams = [farBeam])))
    assert.equal(s.kind, "ffa")
  })
  test("a far beam: by another mech, path beyond 22 m, not ending within 25 m; beams at us do not count", () => {
    const o = at(10, 16)
    assert.equal(isFarBeam(o, farBeam), true)
    assert.equal(isFarBeam(o, { ...farBeam, path: [[200, 0, 7], [10, 0, 4]] }), false, "ends near us")
    assert.equal(isFarBeam(o, { ...farBeam, path: [[100, 15, 7], [-100, 15, 4]] }), false, "passes within 22 m")
    assert.equal(isFarBeam(o, { ...farBeam, by: 105 }), false, "an NPC id")
    assert.equal(isFarBeam(o, { ...farBeam, by: o.self.id }), false, "our own")
  })
  test("WorldModel exposes the lobby and resets it per match", () => {
    const w = new WorldModel(hello)
    w.update(at(5, 16))
    let alive = 16
    for (let i = 0; i < LOBBY.earlyForeignDeaths; i++) w.update(at(10 + i, --alive))
    assert.equal(w.lobby, "ffa")
    w.reset()
    w.update(at(5, 16))
    assert.equal(w.lobby, "squad")
  })
})

describe("FFA policy gates (2b)", () => {
  const ffaWorld = (patch: (o: Observation) => void): WorldModel => {
    const w = new WorldModel(hello)
    w.update(at(5, 16))
    let alive = 16
    for (let i = 0; i < LOBBY.earlyForeignDeaths; i++) w.update(at(6 + i, --alive))
    w.update(at(20, alive, patch))
    assert.equal(w.lobby, "ffa")
    return w
  }
  const cand = (w: WorldModel, id: number): Cand => {
    const a = w.obs!.mechs.find((m) => m.id === id)!
    return { kind: "mech", id, a, com: [a.pos[0], a.pos[1], 4.5], dist: Math.hypot(a.pos[0], a.pos[1]), los: true, radius: 2.5, hp: a.hp }
  }
  test("a healthy mech aiming at us from 120 m is not engaged; low, attacking, close or busy ones are", () => {
    const facingUs = enemy(5, [120, 0, 0], { aim: [Math.PI, 0] })
    let w = ffaWorld((o) => (o.mechs = [facingUs]))
    assert.equal(ffaEngageable(w, cand(w, 5)), false, "healthy, unengaged")
    w = ffaWorld((o) => (o.mechs = [{ ...facingUs, hp: 300 }]))
    assert.equal(ffaEngageable(w, cand(w, 5)), true, "finishable")
    w = ffaWorld((o) => {
      o.mechs = [facingUs]
      o.events = [{ type: "damaged", amount: 45, weapon: "gun", bearing: 0, by: 5 }]
    })
    assert.equal(ffaEngageable(w, cand(w, 5)), true, "attacked us")
    w = ffaWorld((o) => (o.mechs = [{ ...facingUs, pos: [COMBAT.ffaSelfDefenseM - 5, 0, 0] }]))
    assert.equal(ffaEngageable(w, cand(w, 5)), true, "too close")
    w = ffaWorld((o) => (o.mechs = [{ ...facingUs, aim: [Math.PI / 2, 0] }, enemy(6, [120, 80, 0])]))
    assert.equal(ffaEngageable(w, cand(w, 5)), true, "busy with mech 6")
  })
  test("Combat holds fire on the healthy unengaged mech in FFA but fires in squad mode", () => {
    const mech = enemy(5, [120, 0, 0], { aim: [Math.PI, 0] })
    const w = ffaWorld((o) => (o.mechs = [mech]))
    const ffaOut = new RuleCombat().decide({ world: w, map: null, deadline: NO_DEADLINE })
    assert.equal(ffaOut.hasTarget, false)
    const sq = new WorldModel(hello)
    sq.update(at(20, 16, (o) => (o.mechs = [mech])))
    const sqOut = new RuleCombat().decide({ world: sq, map: null, deadline: NO_DEADLINE })
    assert.equal(sqOut.hasTarget, true)
  })
  test("FFA upgrade order puts plating, armor, nanites first; squad keeps the DPS order", () => {
    const choices = [{ id: "gun_rate", name: "", desc: "" }, { id: "armor", name: "", desc: "" }, { id: "plating", name: "", desc: "" }]
    assert.equal(bestUpgradeIndex(choices as never, true), 2)
    assert.equal(bestUpgradeIndex(choices as never, false), 0)
    assert.equal(ECONOMY.ffaUpgradeFirst[0], "plating")
  })
  test("FFA: no approach on a far healthy mech; idle patrol walks silently below step speed", () => {
    const loco = new EvasiveLocomotion()
    const w = ffaWorld((o) => (o.mechs = [enemy(5, [150, 0, 0])]))
    loco.decide({ world: w, map: null, deadline: NO_DEADLINE }, [])
    assert.notEqual(loco.lastMode, "approach")
    const quiet = ffaWorld((o) => (o.self.grounded = true))
    const ql = new EvasiveLocomotion()
    const out = ql.decide({ world: quiet, map: null, deadline: NO_DEADLINE }, [])
    assert.equal(ql.lastMode, "patrol")
    const step = hello.config.sound.step_speed
    const walk = (hello.config.mech as Record<string, number>).walk_speed!
    assert.ok(Math.hypot(out.move[0], out.move[1]) * walk <= step + 1e-9, `move ${out.move}`)
    assert.ok(Math.hypot(out.move[0], out.move[1]) > 0)
  })
})
