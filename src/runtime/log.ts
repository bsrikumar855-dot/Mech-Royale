import { RUNTIME } from "../config/index.ts"

const DEBUG = process.env.MECH_DEBUG === "1"
let warnCount = 0

/** stderr only, gated behind MECH_DEBUG=1. Never stdout: stdout is the protocol. */
export function debug(...parts: unknown[]): void {
  if (!DEBUG) return
  try {
    process.stderr.write(parts.map(String).join(" ").slice(0, RUNTIME.warnMaxChars * 4) + "\n")
  } catch {
    /* logging must never throw */
  }
}

/** Always-on but bounded: a blocked stderr pipe must never stall a 50 ms decision. */
export function warn(message: string, err?: unknown): void {
  warnCount++
  if (warnCount > RUNTIME.warnFirst && warnCount % RUNTIME.warnEvery !== 0) return
  try {
    const detail = err instanceof Error ? (err.stack ?? err.message) : err === undefined ? "" : String(err)
    process.stderr.write(`[warn #${warnCount}] ${message} ${detail}`.slice(0, RUNTIME.warnMaxChars) + "\n")
  } catch {
    /* ignore */
  }
}
