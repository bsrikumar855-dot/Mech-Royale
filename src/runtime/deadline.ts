/** Cooperative per-tick deadline. Check `hasTimeRemaining()` inside any loop that can grow. */
export class Deadline {
  private readonly endMs: number
  private readonly now: () => number

  constructor(now: () => number, startMs: number, budgetMs: number) {
    this.now = now
    this.endMs = startMs + budgetMs
  }
  remainingMs(): number {
    return this.endMs - this.now()
  }
  hasTimeRemaining(reserveMs = 0): boolean {
    return this.remainingMs() > reserveMs
  }
}

/** A deadline that never expires (tests, warm-up). */
export const NO_DEADLINE = new Deadline(() => 0, 0, Number.POSITIVE_INFINITY)
