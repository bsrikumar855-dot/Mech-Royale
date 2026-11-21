import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { LineSplitter } from "../src/runtime/io.ts"
import { Session } from "../src/session.ts"
import { Bot, type Modules } from "../src/bot.ts"
import { NO_DEADLINE } from "../src/runtime/deadline.ts"
import { WorldModel } from "../src/world/world.ts"
import type { Observation } from "../src/types/mechfight.ts"
import { fixtureHello, fixtureObs, syntheticMap } from "./helpers.ts"

function makeSession(over: { loadMap?: () => never; send?: (m: object) => void; createModules?: () => Modules } = {}) {
  const sent: Record<string, unknown>[] = []
  let exitCode: number | null = null
  let clock = 0
  const session = new Session({
    send: over.send ?? ((m) => void sent.push(JSON.parse(JSON.stringify(m)) as Record<string, unknown>)),
    now: () => (clock += 0.1),
    exit: (c) => void (exitCode = c),
    loadMap: over.loadMap ?? (() => syntheticMap()),
    ...(over.createModules ? { createModules: over.createModules } : {}),
  })
  return { session, sent, exitCode: () => exitCode }
}
const line = (o: object): string => JSON.stringify(o)
const obs = (): Observation[] => fixtureObs()

describe("LineSplitter framing", () => {
  test("reassembles lines across arbitrary chunk boundaries and drops blank lines", () => {
    const s = new LineSplitter(1 << 20)
    assert.deepEqual(s.feed('{"a":1}\n{"b"'), ['{"a":1}'])
    assert.deepEqual(s.feed(':2}\n\n  \n{"c":3}'), ['{"b":2}'])
    assert.deepEqual(s.flush(), ['{"c":3}'])
    assert.deepEqual(s.flush(), [])
  })
  test("a runaway unterminated line is discarded rather than growing without bound", () => {
    const s = new LineSplitter(100)
    assert.deepEqual(s.feed("x".repeat(500)), [])
    assert.deepEqual(s.feed('{"ok":1}\n'), ['{"ok":1}'])
  })
})

describe("Session protocol", () => {
  test("hello -> exactly one ready (named, <= 32 chars), state reset after warm-up", () => {
    const { session, sent } = makeSession()
    session.handleLines([line(fixtureHello())])
    assert.equal(sent.length, 1)
    assert.equal(sent[0]!["type"], "ready")
    assert.ok(String(sent[0]!["name"]).length <= 32)
  })

  test("ready is still sent when the map fails to load (degraded, never crash)", () => {
    const { session, sent } = makeSession({ loadMap: () => { throw new Error("no such dir") } })
    session.handleLines([line(fixtureHello("/nonexistent"))])
    assert.equal(sent[0]!["type"], "ready")
    session.handleLines([line(obs()[0]!)])
    assert.equal(sent[1]!["tick"], obs()[0]!.tick)
  })

  test("one action per observation, echoing its tick", () => {
    const { session, sent } = makeSession()
    session.handleLines([line(fixtureHello())])
    for (const o of obs().slice(0, 5)) session.handleLines([line(o)])
    const actions = sent.slice(1)
    assert.deepEqual(actions.map((a) => a["tick"]), obs().slice(0, 5).map((o) => o.tick))
  })

  test("queue skipping: a backlog of observations is answered ONCE, for the newest", () => {
    const { session, sent } = makeSession()
    session.handleLines([line(fixtureHello())])
    const batch = obs().slice(0, 3)
    session.handleLines(batch.map((o) => line(o)))
    assert.equal(sent.length, 2)
    assert.equal(sent[1]!["tick"], batch[2]!.tick)
  })

  test("malformed JSON, non-objects and unknown message types are ignored; the next obs still gets an answer", () => {
    const { session, sent } = makeSession()
    session.handleLines([line(fixtureHello())])
    session.handleLines(["{not json", "[1,2,3]", "42", "null", line({ type: "mystery" }), line(obs()[0]!)])
    assert.equal(sent.length, 2)
    assert.equal(sent[1]!["tick"], obs()[0]!.tick)
  })

  test("crash fallback: a tick that throws still yields a valid {tick: N}", () => {
    const { session, sent } = makeSession()
    session.handleLines([line(fixtureHello())])
    const broken = { ...obs()[0]!, self: undefined } as unknown as Observation
    session.handleLines([line(broken)])
    assert.deepEqual(sent[1], { tick: broken.tick })
  })

  /** Modules that emit an aggressive action: every one-shot set, boost on. */
  const loudModules = (): Modules => ({
    economy: { decide: () => ({ take: 8001, drop: 1, lootTargets: [] }) },
    combat: { decide: () => ({ aim: [1.0, 0.2], fire: [true, true], reload: true, moveConstraint: "NONE", hasTarget: true }) },
    locomotion: { decide: () => ({ move: [0.6, 0.8], boost: true, jump: true }) },
  })
  const broken = (tick: number): string => line({ ...obs()[0]!, tick, self: undefined })

  test("crash AFTER a good tick: keeps last move+aim, boost off, NO one-shots (fire/jump/reload/pick/take/drop)", () => {
    const { session, sent } = makeSession({ createModules: loudModules })
    session.handleLines([line(fixtureHello())])
    session.handleLines([line(obs()[0]!)])
    const good = sent[1]!
    assert.equal(good["boost"], true) // sanity: the good action really was loud
    assert.deepEqual(good["fire"], [true, true])
    session.handleLines([broken(900)])
    assert.deepEqual(sent[2], { tick: 900, boost: false, move: [0.6, 0.8], aim: [1.0, 0.2] })
    for (const k of ["fire", "jump", "reload", "pick", "take", "drop", "debug"]) assert.equal(k in sent[2]!, false, `${k} must be omitted`)
  })

  test("the fallback is deep-copied and stable: repeated crashes replay the same values, never NaN", () => {
    const { session, sent } = makeSession({ createModules: loudModules })
    session.handleLines([line(fixtureHello())])
    session.handleLines([line(obs()[0]!)])
    session.handleLines([broken(901)])
    session.handleLines([broken(902)])
    session.handleLines([broken(903)])
    const [a, b, c] = [sent[2]!, sent[3]!, sent[4]!]
    assert.deepEqual({ ...b, tick: 0 }, { ...a, tick: 0 })
    assert.deepEqual({ ...c, tick: 0 }, { ...a, tick: 0 })
    for (const m of [a, b, c]) for (const v of [...(m["move"] as number[]), ...(m["aim"] as number[])]) assert.ok(Number.isFinite(v))
  })

  test("a garbage move from a module never reaches the cache: the arbiter sanitises it first, and the fallback stays finite", () => {
    const mods = (): Modules => ({ ...loudModules(), locomotion: { decide: () => ({ move: [Number.NaN, Infinity], boost: true, jump: false }) } })
    const { session, sent } = makeSession({ createModules: mods })
    session.handleLines([line(fixtureHello())])
    session.handleLines([line(obs()[0]!)])
    assert.deepEqual(sent[1]!["move"], [0, 0])
    session.handleLines([broken(950)])
    for (const v of sent[2]!["move"] as number[]) assert.ok(Number.isFinite(v))
  })

  test("a new match (second hello) forgets the cache: a first-tick crash is the bare {tick}", () => {
    const { session, sent } = makeSession({ createModules: loudModules })
    session.handleLines([line(fixtureHello())])
    session.handleLines([line(obs()[0]!)])
    session.handleLines([line(fixtureHello())])
    session.handleLines([broken(7)])
    assert.deepEqual(sent[sent.length - 1], { tick: 7 })
  })

  test("obs before hello gets {tick} (no bot yet), never a crash", () => {
    const { session, sent } = makeSession()
    session.handleLines([line(obs()[0]!)])
    assert.deepEqual(sent[0], { tick: obs()[0]!.tick })
  })

  test("an obs without a numeric tick is skipped (cannot echo it)", () => {
    const { session, sent } = makeSession()
    session.handleLines([line(fixtureHello())])
    session.handleLines([line({ type: "obs" })])
    assert.equal(sent.length, 1)
  })

  test("end -> exit(0), and nothing is sent after it", () => {
    const { session, sent, exitCode } = makeSession()
    session.handleLines([line(fixtureHello())])
    session.handleLines([line({ type: "end", place: 3, kills: 0 }), line(obs()[0]!)])
    assert.equal(exitCode(), 0)
    assert.equal(sent.length, 1)
  })

  test("EPIPE on stdout exits cleanly instead of throwing", () => {
    let calls = 0
    const { session, exitCode } = makeSession({
      send: () => {
        calls++
        throw Object.assign(new Error("broken pipe"), { code: "EPIPE" })
      },
    })
    assert.doesNotThrow(() => session.handleLines([line(fixtureHello())]))
    assert.equal(exitCode(), 0)
    assert.ok(calls >= 1)
  })

  test("a second hello (new match in the same process) resets world state", () => {
    const { session, sent } = makeSession()
    session.handleLines([line(fixtureHello())])
    session.handleLines([line(obs()[10]!)])
    session.handleLines([line(fixtureHello())])
    assert.equal(sent.filter((m) => m["type"] === "ready").length, 2)
    session.handleLines([line(obs()[0]!)]) // an earlier tick than before: still answered
    assert.equal(sent[sent.length - 1]!["tick"], obs()[0]!.tick)
  })
})

describe("Bot module isolation", () => {
  test("a throwing module falls back to a neutral output; the others still act", () => {
    const world = new WorldModel(fixtureHello())
    const boom = { decide: () => { throw new Error("boom") } }
    const bot = new Bot(world, null, {
      economy: boom,
      combat: boom,
      locomotion: { decide: () => ({ move: [1, 0], boost: true, jump: false }) },
    })
    const a = bot.decide(obs()[0]!, NO_DEADLINE)
    assert.equal(a.tick, obs()[0]!.tick)
    assert.deepEqual(a.move, [1, 0])
    assert.equal(a.boost, true)
    assert.deepEqual(a.fire, [false, false])
  })
})
