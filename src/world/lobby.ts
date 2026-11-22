/**
 * OWNER: Person A. Lobby detector (2a): practice squad hunt vs free-for-all.
 *
 * Practice: 15 house bots that never fight each other hunt us. A house bot dies only to us (our `kill` event), to an
 * NPC drone or to the zone. FFA: other mechs kill each other, so the alive count drops without a kill of ours, and
 * we see beams fired between other mechs far from us. Pure step function: (state, observation) -> state.
 * Once FFA, never back to squad.
 */
import { LOBBY } from "../config/index.ts"
import type { Observation } from "../types/mechfight.ts"

export type LobbyKind = "squad" | "ffa"

export interface LobbyState {
  kind: LobbyKind
  /** alive-count drops not explained by our own kill events */
  foreignDeaths: number
  /** observations containing a beam by another mech that never came near us */
  farBeams: number
  prevAlive: number | null
  /** match time we switched to FFA (null while squad) */
  switchedT: number | null
}

export const newLobby = (): LobbyState => ({ kind: "squad", foreignDeaths: 0, farBeams: 0, prevAlive: null, switchedT: null })

/** Horizontal distance from point (px, py) to the segment a-b. */
function segDist2d(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  const u = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2))
  return Math.hypot(ax + dx * u - px, ay + dy * u - py)
}

/** A beam by another mech whose whole path stays farther than LOBBY.farBeamClearM and does not end near us. */
export function isFarBeam(obs: Observation, beam: { by: number; path: readonly (readonly number[])[] }): boolean {
  const [px, py] = obs.self.pos
  if (beam.by === obs.self.id || beam.by < LOBBY.mechIdMin || beam.by > LOBBY.mechIdMax) return false
  const path = beam.path
  if (path.length < 2) return false
  const end = path[path.length - 1]!
  if (Math.hypot(end[0]! - px, end[1]! - py) <= LOBBY.farBeamEndM) return false
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!
    const b = path[i + 1]!
    if (segDist2d(px, py, a[0]!, a[1]!, b[0]!, b[1]!) <= LOBBY.farBeamClearM) return false
  }
  return true
}

export function stepLobby(prev: LobbyState, obs: Observation): LobbyState {
  const s: LobbyState = { ...prev }
  const alive = typeof obs.alive === "number" && Number.isFinite(obs.alive) ? obs.alive : null
  if (alive !== null) {
    if (s.prevAlive !== null && alive < s.prevAlive) {
      const ourKills = (obs.events ?? []).filter((e) => e.type === "kill").length
      s.foreignDeaths += Math.max(0, s.prevAlive - alive - ourKills)
    }
    s.prevAlive = alive
  }
  if ((obs.beams ?? []).some((b) => isFarBeam(obs, b))) s.farBeams++
  if (s.kind === "squad") {
    const early = s.foreignDeaths >= LOBBY.earlyForeignDeaths && obs.t < LOBBY.earlyBeforeS
    const witnessed = s.foreignDeaths >= LOBBY.witnessedForeignDeaths && s.farBeams >= LOBBY.witnessedFarBeams
    if (early || witnessed) {
      s.kind = "ffa"
      s.switchedT = obs.t
    }
  }
  return s
}
