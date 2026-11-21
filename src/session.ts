/**
 * Session: the protocol state machine (hello -> ready -> obs/action -> end). OWNER: Person A.
 * Pure of process globals (I/O, clock, exit and map loading are injected) so it is unit-testable.
 *
 * Mirrors the kit wrapper's behaviour: a batch of queued lines is read in full; only the NEWEST obs is answered;
 * `end` exits. Hardened: malformed lines are skipped, `ready` is ALWAYS sent (even if map load or warm-up fail),
 * and any failure inside a tick still produces a valid {"tick": N}.
 */
import { fitToLine } from "./arbiter.ts"
import { Bot, type Modules } from "./bot.ts"
import { RUNTIME } from "./config/index.ts"
import { Deadline } from "./runtime/deadline.ts"
import { isFiniteNum } from "./world/geom.ts"
import { debug, warn } from "./runtime/log.ts"
import type { Action, Hello, Observation, Vec2 } from "./types/mechfight.ts"
import { syntheticObservation } from "./warmup.ts"
import type { MapQuery } from "./world/map.ts"
import { loadMapQuery } from "./world/mapLoader.ts"
import { WorldModel } from "./world/world.ts"

export interface SessionDeps {
  send(msg: object): void
  now(): number
  exit(code: number): void
  loadMap?(dir: string, files?: readonly string[]): MapQuery
  /** Test seam: supply the decision modules. Defaults to the real ones. */
  createModules?(): Modules
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

export class Session {
  private bot: Bot | null = null
  /** Last validated, finite, deep-copied continuous parts of an action we sent (the crash fallback's memory). */
  private lastMove: Vec2 | null = null
  private lastAim: Vec2 | null = null
  private budgetMs: number = RUNTIME.computeBudgetMs
  private maxLineBytes = 65536
  /** Init timings, exposed for benchmarks / tests. */
  initStats = { mapLoadMs: 0, warmupMs: 0, totalMs: 0 }
  private readonly deps: SessionDeps

  constructor(deps: SessionDeps) {
    this.deps = deps
  }

  handleLines(lines: readonly string[]): void {
    let latest: Observation | null = null
    for (const line of lines) {
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch {
        continue // bad line: ignored
      }
      if (!isRecord(msg)) continue
      if (msg["type"] === "hello") this.onHello(msg as unknown as Hello)
      else if (msg["type"] === "obs") latest = msg as unknown as Observation
      else if (msg["type"] === "end") {
        this.deps.exit(0)
        return
      }
    }
    if (latest) this.onObs(latest)
  }

  private onHello(hello: Hello): void {
    const t0 = this.deps.now()
    this.lastMove = null
    this.lastAim = null
    try {
      const world = new WorldModel(hello)
      this.maxLineBytes = world.rules.maxLineBytes
      // Modules get COMPUTE_BUDGET_MS, never more than the server budget minus the safety margin.
      this.budgetMs = Math.max(1, Math.min(RUNTIME.computeBudgetMs, world.rules.tickBudgetMs - RUNTIME.safetyMarginMs))

      let map: MapQuery | null = null
      const tMap = this.deps.now()
      try {
        map = (this.deps.loadMap ?? loadMapQuery)(hello.map.dir, hello.map.files)
      } catch (e) {
        warn("map load failed; running without MapQuery", e)
      }
      this.initStats.mapLoadMs = this.deps.now() - tMap

      const bot = new Bot(world, map, this.deps.createModules?.())
      const tWarm = this.deps.now()
      try {
        for (let i = 0; i < RUNTIME.warmupTicks; i++) {
          bot.decide(syntheticObservation(hello, map, i * world.rules.decideEvery), new Deadline(this.deps.now, this.deps.now(), Infinity))
        }
      } catch (e) {
        warn("warm-up failed (ignored)", e)
      }
      world.reset() // warm-up must leave no state behind
      this.initStats.warmupMs = this.deps.now() - tWarm
      this.bot = bot
    } catch (e) {
      warn("hello handling failed; continuing in fallback mode", e)
      this.bot = null
    }
    this.initStats.totalMs = this.deps.now() - t0
    debug(`init: map ${this.initStats.mapLoadMs.toFixed(1)} ms, warm-up ${this.initStats.warmupMs.toFixed(1)} ms, total ${this.initStats.totalMs.toFixed(1)} ms`)
    this.emit({ type: "ready", name: RUNTIME.botName.slice(0, 32) })
  }

  private onObs(obs: Observation): void {
    if (typeof obs.tick !== "number" || !Number.isFinite(obs.tick)) return // cannot echo a tick we cannot read
    let action: Action = this.fallbackAction(obs.tick)
    if (this.bot) {
      try {
        const start = this.deps.now()
        action = fitToLine(this.bot.decide(obs, new Deadline(this.deps.now, start, this.budgetMs)), this.maxLineBytes)
        this.remember(action)
      } catch (e) {
        warn(`tick ${obs.tick} failed; sending crash fallback`, e)
        action = this.fallbackAction(obs.tick)
      }
    }
    this.emit(action)
  }

  /** Cache the continuous parts of a good action, validated and deep-copied so a NaN can never poison the fallback. */
  private remember(a: Action): void {
    const m = a.move
    if (Array.isArray(m) && m.length === 2 && isFiniteNum(m[0]) && isFiniteNum(m[1])) this.lastMove = [m[0], m[1]]
    const aim = a.aim
    if (Array.isArray(aim) && aim.length === 2 && isFiniteNum(aim[0]) && isFiniteNum(aim[1])) this.lastAim = [aim[0], aim[1]]
  }

  /**
   * Crash/oversize fallback: keep the last validated move and aim (the mech coasts like the server's own no-answer
   * path), but never burn energy on boost and never repeat one-shots (fire, jump, reload, pick, take, drop).
   * Only when no valid action exists yet (e.g. a crash on the first tick) is it the bare {"tick": N}.
   */
  private fallbackAction(tick: number): Action {
    if (!this.lastMove && !this.lastAim) return { tick }
    const a: Action = { tick, boost: false }
    if (this.lastMove) a.move = [this.lastMove[0], this.lastMove[1]]
    if (this.lastAim) a.aim = [this.lastAim[0], this.lastAim[1]]
    return a
  }

  private emit(msg: object): void {
    try {
      this.deps.send(msg)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") this.deps.exit(0)
      else warn("send failed", e)
    }
  }
}
