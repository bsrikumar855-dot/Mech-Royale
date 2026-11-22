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

  // ---- predictive bullet evasion (src/locomotion/evade.ts, experiment "evade-v2": evade on top of hops off)
  /** Master switch (false = the 286d48c behaviour exactly). */
  evadeEnabled: true,
  /** Candidate headings (plus stop and the wanted heading). */
  evadeHeadings: 16,
  /** Prediction step and the longest look-ahead (a bullet farther than this in time is ignored this tick). */
  evadeStepS: 0.05,
  evadeHorizonS: 0.8,
  /** Extra clearance added to body radius + projectile radius (aim / prediction error). */
  evadeMarginM: 0.4,
  /** Bullets farther than this are ignored (0.8 s at 252 m/s is ~200 m). */
  evadeMaxBulletDistM: 210,
  /** Times at which a candidate path is checked against walls (blocked = we stop there). */
  evadeWallChecksS: [0.15, 0.35, 0.6] as readonly number[],
  /** Cost of deviating from the wanted heading, in damage points at 180 degrees. */
  evadeDeviationWeight: 30,
  evadeBoostCost: 4,
  evadeJumpCost: 6,
  evadeBoostMinEnergy: 20,
  /** No jump candidates: airborne accel is 12 vs 58.5 on the ground (the 286d48c hops-off finding). */
  evadeAllowJump: false,

  // ---- hops
  /** 1f: anti-lead hops under fire. Airborne we accelerate at air_accel (12) not ground_accel (58.5): no strafe/dodge. */
  antiLeadHops: false as boolean,
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

  /**
   * P5 physical stuck escape. The feeler models the body footprint against buildings but terrain only under the
   * centre line, so along a steep bank (the stadium bowl) it can call a heading open while the body is wedged:
   * forensics found runs of up to 87 s pushing into a bank (3 of 4 such matches ended in a zone death). Truth is the
   * server's own velocity: the commanded speed (|move| x walk or boost speed, x charge_move_mult while our laser charges)
   * is above stuckCmdMinWalkFrac x walk_speed and the server reports less than stuckSpeedRatio x that commanded speed,
   * grounded, for stuckDecisions decisions in a row (deliberately slow moves such as the drop-ring micro-strafe or the
   * half speed while our laser charges never qualify) -> for stuckEscapeS, jump and jet (boost in the air, protocol: jump and jet to clear
   * a ledge) along the last heading rotated by the next stuckEscapeDeg entry; flip the patrol side and ban the loot
   * target we were walking to for stuckLootBanS.
   */
  stuckEscape: true as boolean,
  // (P5 constants follow)
  stuckCmdMinWalkFrac: 0.5,
  stuckSpeedRatio: 0.25,
  stuckDecisions: 8,
  stuckEscapeS: 1,
  stuckEscapeDeg: [90, -90, 180, 45, -45] as readonly number[],
  stuckJetMinEnergy: 20,
  stuckLootBanS: 20,
  stuckLootBanM: 4,

  /**
   * P6 arm early: only 37/96 sim matches ever held a laser or lightning (slot empty 29% of the time after 60 s).
   * Opening: for openingSweepS, with no target and no threat, keep the torso turning (commanded yaw sweepLeadRad
   * ahead of the actual yaw) so the 120 deg vision wedge sees all around. Every laser / lightning pickup seen is
   * remembered until its spot is visible again without it. Until we hold a laser or lightning, and while not under
   * fire, walk (zone-nav path once the zone field is built) to the best remembered one within armRangeM inside the
   * safe zone, looking along the way. Under fire: the usual evasion.
   */
  armEarly: true as boolean,
  openingSweepS: 2,
  sweepLeadRad: 0.8,
  armRangeM: 160,
  armBase: { laser: 20, lightning: 18 } as Readonly<Record<string, number>>,
  armHalfValueM: 60,
  /** walk straight when this close; else follow a nav field toward the pickup (destination circle radius) */
  armStraightM: 12,
  /** follow a zone-nav field to the pickup (else straight line + wall feeler + stuck escape) */
  armUseNav: false as boolean,
  armFieldRadiusM: 6,
  /** forget a remembered pickup not seen for this long */
  armMemoryS: 120,
  /** a remembered pickup counts as checked (gone) when it is not listed while within this fraction of vision ranges */
  armRecheckFrac: 0.9,

  /**
   * B1 late-game caution: from lateCautionT (every house bot hunts us) the under-fire branch retreats to break line of
   * sight instead of approach / strafe / loot unless the primary threat is finishable (HP <= what we deal in
   * COMBAT.lateFinishWindowS); no loot / farm / arming detours except uncontested supply drops (no tracked enemy within
   * lateDropClearM); the shrink trigger keeps lateNextMarginM more margin inside the next circle.
   */
  lateCautionT: 240,
  lateNextMarginM: 15,
  lateDropClearM: 60,
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
