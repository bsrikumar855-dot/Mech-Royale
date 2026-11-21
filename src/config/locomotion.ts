/** OWNER: Person A. Runtime, world-model and map tunables. Zero magic numbers outside src/config/. */
export const RUNTIME = {
  botName: "mech-royale",
  /** COMPUTE_BUDGET_MS = tick_budget(50) - p99 overhead(~1) - safety(15) = 34. See the CLAUDE.md benchmark table. */
  computeBudgetMs: 34,
  /** Time held back for JSON parse + stdout flush + scheduler jitter on the 1-CPU container. */
  safetyMarginMs: 15,
  warmupTicks: 2,
  /** Hard cap on unparsed stdin bytes we keep (protects the 512 MB limit against a runaway stream). */
  maxInputBufferBytes: 4 * 1024 * 1024,
  /** stdout is a pipe; EAGAIN retries before giving up on a single write. */
  writeRetryLimit: 2000,
  /** stderr is bounded so an unread pipe can never block the bot: first N warnings, then every Nth. */
  warnFirst: 5,
  warnEvery: 100,
  warnMaxChars: 400,
} as const

export const WORLD = {
  historySamples: 8,
  /** Extra seconds a track is kept beyond vision.memory_s before being dropped. */
  trackGraceS: 1,
  maxTracks: 64,
  maxSounds: 64,
  maxDamageRecords: 32,
  soundMemoryS: 5,
  damageMemoryS: 5,
} as const

export const MAP = {
  gridCellM: 16,
  treeCellM: 16,
  /** Terrain-vs-ray sampling step (the heightfield itself has a 1 m grid). */
  terrainLosStepM: 1,
  slopeProbeM: 0.5,
  /** Vertical tolerance when comparing a ray/feet height to a surface. */
  zEps: 0.05,
  /** Parametric / geometric epsilon for segment-polygon tests. */
  geomEps: 1e-9,
} as const
