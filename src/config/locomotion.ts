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

/**
 * Locomotion v3: evasive anti-lead movement. Every weight, radius and threshold lives here; game physics (speeds,
 * gravity, splash, vision memory) are read live from hello.config / self.stats.
 */
export const LOCOMOTION = {
  // ---- zone
  /** Stay inside this fraction of the current radius (the rim is where the damage and the crowd are). */
  safeRadiusFrac: 0.85,
  /** We aim to be inside this fraction of the NEXT circle's radius before its shrink ends. */
  nextSafeFrac: 0.9,
  /** Start moving in when distToNextSafe / walk_speed >= max(1, shrink_end - t) - this. */
  shrinkBufferS: 8,
  outsideBoostMinEnergy: 10,
  /** Perpendicular weave mixed into a zone run while under fire (fraction of the inward vector). */
  outsideWeave: 0.35,
  shrinkWeave: 0.5,

  // ---- threat trigger (any of these -> evasive movement, at ANY range)
  damageMemoryS: 3,
  soundMemoryS: 2,
  threatSoundKinds: ["gun", "laser", "laser_charge", "lightning", "mortar", "explosion"] as readonly string[],
  projectileAlertM: 140,
  /** Line-of-sight checks per decision (nearest listed enemies first, charging lasers before everything). */
  maxLosChecks: 4,

  // ---- A-D strafing
  /** Strafe direction flips after a deterministic, varying period in [flipMinS, flipMaxS]. */
  flipMinS: 0.75,
  flipMaxS: 1.15,
  /** Flip at once if the current strafe side is blocked within this distance. */
  strafeBlockProbeM: 5,
  /** Range control: radial blend added to the perpendicular strafe (negative = away from the threat). */
  retreatBlend: -0.55,
  backpedalBlend: -0.5,
  approachBlend: 0.3,
  woundedHpFrac: 0.42,
  closeM: 42,
  closeLightningM: 52,
  farM: 95,
  approachMinHpFrac: 0.65,
  /** Any move whose 4 m lookahead leaves the safe rim is bent back inward. */
  rimLookaheadM: 4,

  // ---- hops
  jumpMinS: 1.8,
  jumpMaxS: 2.4,
  jumpDamageWindowS: 2,

  // ---- boost
  tacticalBoostStartEnergy: 30,
  tacticalBoostHoldEnergy: 15,
  mortarBoostMinEnergy: 8,
  laserDodgeBoostMinEnergy: 12,

  // ---- projectiles
  mortarHorizonS: 4,
  mortarStepS: 0.1,
  /** Mortar danger radius = splash_radius + our radius + this. */
  mortarMarginM: 3,
  bulletHorizonS: 0.45,
  /** A bullet ray passing within our radius + this triggers a perpendicular snap away from it. */
  bulletClearanceExtraM: 2.5,
  /** Charging-laser dodge: test this far to each side for a spot the charger cannot see (max 2 raycasts). */
  laserDodgeStepM: 7,

  // ---- loot (read straight from the observation: Economy decides what to take, Locomotion how far to walk)
  closeLootM: 18,
  closeLootMinHpFrac: 0.55,
  lootWeave: 0.4,
  /** Submission 20: widened again (95/20 -> 130/25, submission 19 was 70/12 and scored +0.02). dropMaxLandsInS is
   * now the full fall_s (25 s): react from the moment a drop is called, not partway through its fall. Its landing
   * point must still be inSafe(), so this never sends us chasing one that's about to fall outside the (shrinking)
   * zone, and lootHalfValueM's distance decay still lets nearer loot outrank a far one in the same tick. */
  dropRangeM: 130,
  dropMaxLandsInS: 25,
  /** Once this far inside a supply-drop ring, micro-strafe inside it instead of walking to its centre. */
  dropRingInsetM: 1.5,
  dropMicroStrafe: 0.4,
  laserPickupRangeM: 80,
  lightningPickupRangeM: 55,
  cubeRangeM: 55,
  lootArriveM: 1.5,
  lootBase: { supply_drop: 30, laser: 20, lightning: 14, cube: 10 } as Readonly<Record<string, number>>,
  lootHalfValueM: 20,

  // ---- v5: early snowball rush (crate / drone hunting). Gate: no enemy mech with a shot line, none tracked within
  // huntEnemyClearM, we stand inside the safe rim, and (cubes < huntCubeCap or no laser held yet).
  huntEnemyClearM: 50,
  huntCubeCap: 10,
  /** While the gate is open the free-loot reach grows to these ranges. */
  huntLaserRangeM: 90,
  huntDropRangeM: 140, // submission 20: widened again from 105 (submission 19 was 75), same reasoning as dropRangeM above
  huntCubeRangeM: 65,
  /** Drones (2 cubes) and crates (1 cube + weapon chance) are hunted up to this far... */
  huntTargetRangeM: 75,
  /** ...only this healthy. v14: 0.85 for both (was 0.55 / 0.65): shooting a drone or crate resets the 5 s regen
   * timer (regen needs 5 s without dealing OR taking damage, then 45 HP/s), so heal first, farm after... */
  huntNpcMinHpFrac: 0.85,
  huntCrateMinHpFrac: 0.85,
  /** ...and we walk in until the muzzle-to-centre distance is within this AND there is a shot line, then hold so the
   * combat module (npc gate 40 m, crate gate 45 m) melts it. */
  huntNpcStandoffM: 35,
  huntCrateStandoffM: 38,
  /** Loot value bases for hunt targets (value = base / (1 + dist / lootHalfValueM); a laser at 80 m beats a crate at 40 m). */
  huntBase: { npc: 12, crate: 8 } as Readonly<Record<string, number>>,

  // ---- v5: post-kill cube scoop while under fire
  /** Nobody has a shot line on us (unseen shooter, stray projectile): scoop cubes up to this far. */
  scoopNoLosM: 25,
  /** One shooter has a line: still scoop a cube this close if we are above scoopOneLosMinHpFrac. */
  scoopOneLosM: 14,
  scoopOneLosMinHpFrac: 0.45,

  // ---- idle
  /** Below this HP, safe and unthreatened: stand still (silent) so the out-of-combat regen runs. */
  regenHoldHpFrac: 0.85,
  /** Healthy and idle: patrol along a band of the next circle (fraction of its radius). */
  patrolInnerFrac: 0.4,
  patrolOuterFrac: 0.75,
  /** Smaller next circles than this: patrol around the current one instead. */
  patrolMinRadiusM: 20,

  // ---- wall feeler
  feelerStepM: 4,
  /** The feeler walks its probe in steps of this length, following the ground (ledge / slope detection). */
  feelerSampleM: 0.5,
  steerAnglesDeg: [30, 60, 90, 120] as readonly number[],
  /** Once we steer around a wall to one side, prefer that side for this long (no oscillation). */
  wallCommitS: 1.5,
  /**
   * Unstick: the local wall feeler (steer.ts) only probes +-120 deg of the intended heading within feelerStepM and
   * returns null ("boxed in") when every probe is blocked -- the exact bug class that gave locomotion v3 its +2.10
   * (a concave pocket stalls the feeler, standing still is a free target), except steer() can hit it in ANY mode
   * (retreat, approach, loot, patrol...), not just the zone runs that zone-nav-v2 already fixed. When steer() returns
   * null, consult the same validated Dijkstra grid for a point `unstickLookaheadM` along the original intended
   * heading, accepting any walkable cell within `unstickRadiusM` of it: a real route out of the pocket toward where
   * we were already trying to go, instead of standing still until the pocket resolves itself.
   */
  unstickLookaheadM: 30,
  unstickRadiusM: 6,
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
