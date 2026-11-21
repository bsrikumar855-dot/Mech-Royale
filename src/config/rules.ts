/**
 * OWNER: Person A. Fallback values taken from protocol.md defaults.
 * Used ONLY when a key is missing from hello.config / self.stats (the server's numbers always win:
 * balance changes between matches). Do not read these anywhere except world/rules.ts.
 */
export const RULE_FALLBACKS = {
  mech: {
    radius: 2.5,
    height: 9,
    eye_height: 8,
    muzzle_height: 7,
    step_up: 1.2,
    max_slope_deg: 50,
    min_pitch: -0.7,
    max_pitch: 1.3,
    rear_mult: 1.5,
    front_arc_deg: 180,
  },
  vision: { range: 200, fov_deg: 120, near_range: 45, memory_s: 5 },
  bot: { tick_budget_ms: 50, max_line_bytes: 65536 },
  match: { tick_hz: 20, decide_every: 2 },
} as const
