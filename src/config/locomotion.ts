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

/** Phase 1 movement rules (simple rules only; utility scoring + hysteresis are deferred until v1 is scored). */
export const LOCOMOTION = {
  /** Plan against the zone this many seconds ahead (zoneAt(t + zoneLeadS)). */
  zoneLeadS: 10,
  /** Stay inside this fraction of the current AND upcoming radius; the rim is where the damage and the crowd are. */
  safeRadiusFrac: 0.85,
  /** Boost only above this energy, and only when actually outside the zone. */
  boostMinEnergy: 20,

  /** An enemy mech this close (horizontal, m) makes us back away while safely inside the zone. */
  kiteRangeM: 40,
  /** Weight of the sideways strafe blended into the backpedal. */
  kiteStrafeBlend: 0.35,
  /** If the kite step would leave the safe zone, we look this far ahead and bend inward. */
  kiteLookaheadM: 4,

  /** Loot detour: only targets this close, only when no enemy mech is nearer than lootEnemyClearM. */
  lootDetourM: 25,
  lootEnemyClearM: 35,
  /** Stop walking once this close to a loot target (pickup radii are 3.5 and 4 m). */
  lootArriveM: 1.5,

  /** Wall feeler: probe this far along the desired heading (at half and full distance). */
  feelerStepM: 4,
  /** Rotated headings tried, in order, when the straight probe is blocked. */
  steerAnglesDeg: [30, -30, 60, -60, 90, -90, 120, -120] as readonly number[],
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
