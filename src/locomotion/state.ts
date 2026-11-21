/**
 * Locomotion's own memory between decisions: hysteresis (last heading and target), the boost latch, and the
 * anti-stuck detector. Reset on a new match: the WorldModel was reset (resetCount changed, which also covers the
 * warm-up ticks run before `ready`), the tick went backwards, or we jumped teleportResetM between decisions.
 */
import { LOCOMOTION as L } from "../config/index.ts"
import type { WorldModel } from "../world/world.ts"
import type { Vec2 } from "./types.ts"

interface Sample {
  t: number
  x: number
  y: number
  /** magnitude of the move we commanded on the PREVIOUS decision (what produced this displacement) */
  cmd: number
}

export class LocomotionState {
  epoch = -1
  lastTick: number | null = null
  lastPos: Vec2 | null = null
  lastMoveDir: Vec2 | null = null
  lastTargetPos: Vec2 | null = null
  lastCommand = 0
  isBoosting = false
  history: Sample[] = []
  stuckUntil = Number.NEGATIVE_INFINITY
  stuckTangent: Vec2 | null = null
  nextSide = 1
  escapeSide: number | null = null
  escapeUntil = Number.NEGATIVE_INFINITY

  reset(): void {
    this.lastTick = null
    this.lastPos = null
    this.lastMoveDir = null
    this.lastTargetPos = null
    this.lastCommand = 0
    this.isBoosting = false
    this.history = []
    this.stuckUntil = Number.NEGATIVE_INFINITY
    this.stuckTangent = null
    this.nextSide = 1
    this.escapeSide = null
    this.escapeUntil = Number.NEGATIVE_INFINITY
  }

  /** Reset if this observation starts a new match; then record where we are for the stuck detector. */
  sync(world: WorldModel): void {
    const [x, y] = world.self.pos
    const teleported = this.lastPos !== null && Math.hypot(x - this.lastPos[0], y - this.lastPos[1]) > L.teleportResetM
    if (world.resetCount !== this.epoch || (this.lastTick !== null && world.tick <= this.lastTick) || teleported) {
      this.reset()
      this.epoch = world.resetCount
    }
    this.observe(world.t, x, y)
  }

  private observe(t: number, x: number, y: number): void {
    this.history.push({ t, x, y, cmd: this.lastCommand })
    while (this.history.length > 1 && (this.history[0] as Sample).t < t - L.stuckWindowS) this.history.shift()
    const first = this.history[0] as Sample
    const spansWindow = t - first.t >= L.stuckWindowS * 0.9
    const allMoving = this.history.slice(1).every((s) => s.cmd >= L.stuckMinCommand)
    if (spansWindow && allMoving && this.lastMoveDir && Math.hypot(x - first.x, y - first.y) < L.stuckMinDisplacementM) {
      const [dx, dy] = this.lastMoveDir
      this.stuckTangent = this.nextSide > 0 ? [-dy, dx] : [dy, -dx]
      this.nextSide = -this.nextSide
      this.stuckUntil = t + L.stuckEscapeS
      this.history = [{ t, x, y, cmd: 0 }]
    }
  }

  committedSide(t: number): number | null {
    return t < this.escapeUntil ? this.escapeSide : null
  }

  /** Chose a wall slide: commit to its side for escapeCommitS (refreshed while we keep sliding). */
  commitEscape(t: number, side: number | undefined): void {
    if (side === undefined || side === 0) return
    this.escapeSide = side
    this.escapeUntil = t + L.escapeCommitS
  }

  stuckBias(t: number): Vec2 | null {
    return t < this.stuckUntil ? this.stuckTangent : null
  }

  remember(world: WorldModel, move: Vec2, target: Vec2 | null): void {
    const m = Math.hypot(move[0], move[1])
    this.lastMoveDir = m > 1e-9 ? [move[0] / m, move[1] / m] : null
    this.lastTargetPos = m > 1e-9 ? target : null
    this.lastCommand = m
    this.lastTick = world.tick
    this.lastPos = [world.self.pos[0], world.self.pos[1]]
  }
}
