/**
 * Locomotion memory between decisions: strafe side and its flip schedule, the hop timer, the wall-steer side
 * commitment, and the tactical boost latch. Reset on a new match: the WorldModel was reset (resetCount, which also
 * covers the warm-up ticks run before `ready`) or the tick went backwards. A gap between observations is NOT a new
 * match (the recorded stream has a 6.4 s gap; resetting there erased the strafe/hop memory).
 */
import { LOCOMOTION as L } from "../config/index.ts"
import type { Vec2 } from "../types/mechfight.ts"
import type { WorldModel } from "../world/world.ts"

/** Deterministic hash -> [0, 1). Timings vary per slot and per event, but replays are reproducible. */
export function hash01(n: number): number {
  let x = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b)
  x ^= x >>> 13
  x = Math.imul(x, 0xc2b2ae35)
  x ^= x >>> 16
  return (x >>> 0) / 4294967296
}

export class LocoState {
  epoch = -1
  lastTick: number | null = null
  lastPos: Vec2 | null = null
  slot = 0

  strafeSign: 1 | -1 = 1
  nextFlipT = Number.NEGATIVE_INFINITY
  flips = 0

  lastJumpT = Number.NEGATIVE_INFINITY
  jumpIntervalS = 0
  jumps = 0

  wallCommitSide: 1 | -1 | 0 = 0
  wallCommitUntilT = Number.NEGATIVE_INFINITY

  isBoosting = false
  patrolSign: 1 | -1 = 1

  /** P5 stuck escape: last commanded move, consecutive stuck decisions, the active escape and loot bans. */
  lastCmdMag = 0
  /** commanded horizontal speed (m/s) of the last move */
  lastCmdSpeed = 0
  lastCmdDir: Vec2 | null = null
  stuckN = 0
  escapes = 0
  escapeDir: Vec2 | null = null
  escapeUntilT = Number.NEGATIVE_INFINITY
  lootBans: { x: number; y: number; until: number }[] = []

  reset(): void {
    this.lastTick = null
    this.lastPos = null
    this.strafeSign = 1
    this.nextFlipT = Number.NEGATIVE_INFINITY
    this.flips = 0
    this.lastJumpT = Number.NEGATIVE_INFINITY
    this.jumpIntervalS = 0
    this.jumps = 0
    this.wallCommitSide = 0
    this.wallCommitUntilT = Number.NEGATIVE_INFINITY
    this.isBoosting = false
    this.patrolSign = 1
    this.lastCmdMag = 0
    this.lastCmdSpeed = 0
    this.lastCmdDir = null
    this.stuckN = 0
    this.escapes = 0
    this.escapeDir = null
    this.escapeUntilT = Number.NEGATIVE_INFINITY
    this.lootBans = []
  }

  sync(world: WorldModel): void {
    const [x, y] = world.self.pos
    if (world.resetCount !== this.epoch || (this.lastTick !== null && world.tick <= this.lastTick)) {
      this.reset()
      this.epoch = world.resetCount
    }
    this.slot = world.slot
    this.lastTick = world.tick
    this.lastPos = [x, y]
  }

  private flipPeriod(): number {
    return L.flipMinS + (L.flipMaxS - L.flipMinS) * hash01(this.slot * 1000003 + this.flips * 7919 + 1)
  }

  /** Advance the strafe schedule while under threat: first activation just schedules, later ones flip on time. */
  tickStrafe(t: number): void {
    if (this.nextFlipT === Number.NEGATIVE_INFINITY) {
      this.nextFlipT = t + this.flipPeriod()
    } else if (t >= this.nextFlipT) {
      this.flipStrafe(t)
    }
  }

  /** Reverse now (timer, blocked side) and start a fresh period. */
  flipStrafe(t: number): void {
    this.strafeSign = this.strafeSign === 1 ? -1 : 1
    this.flips++
    this.nextFlipT = t + this.flipPeriod()
  }

  /** Force a side (bullet / laser dodge); a change restarts the period so we do not flip straight back. */
  setStrafe(t: number, sign: 1 | -1): void {
    if (sign !== this.strafeSign) this.flipStrafe(t)
  }

  canJump(t: number): boolean {
    return t - this.lastJumpT >= this.jumpIntervalS
  }

  didJump(t: number): void {
    this.lastJumpT = t
    this.jumps++
    this.jumpIntervalS = L.jumpMinS + (L.jumpMaxS - L.jumpMinS) * hash01(this.slot * 2654435 + this.jumps * 97 + 3)
  }

  committedSide(t: number): 1 | -1 | 0 {
    return t < this.wallCommitUntilT ? this.wallCommitSide : 0
  }

  commitWall(t: number, side: 1 | -1): void {
    this.wallCommitSide = side
    this.wallCommitUntilT = t + L.wallCommitS
  }
}
