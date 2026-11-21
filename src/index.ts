/**
 * Entrypoint. OWNER: Person A. stdin = server->bot JSON lines, stdout = bot->server JSON lines (ONLY via sendMessage).
 * Queue skipping: chunks arriving while a tick runs are all read before the next handler turn, so a backlog collapses
 * to the newest observation (same trick as the kit's wrapper).
 */
import { performance } from "node:perf_hooks"
import { RUNTIME } from "./config/index.ts"
import { LineSplitter, sendMessage } from "./runtime/io.ts"
import { warn } from "./runtime/log.ts"
import { Session } from "./session.ts"

const session = new Session({
  send: sendMessage,
  now: () => performance.now(),
  exit: (code) => process.exit(code),
})
const splitter = new LineSplitter(RUNTIME.maxInputBufferBytes)
let pending: string[] = []
let scheduled = false

const flush = (): void => {
  scheduled = false
  const lines = pending
  pending = []
  try {
    session.handleLines(lines)
  } catch (e) {
    warn("unexpected error in handleLines", e)
  }
}

process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  pending.push(...splitter.feed(chunk))
  if (!scheduled && pending.length > 0) {
    scheduled = true
    setImmediate(flush)
  }
})
process.stdin.on("end", () => {
  pending.push(...splitter.flush())
  flush()
  process.exit(0) // EOF: the server closed stdin; nothing more will come
})
process.stdin.on("error", () => process.exit(0))
process.stdout.on("error", () => process.exit(0)) // EPIPE: the server is gone
process.on("uncaughtException", (e) => warn("uncaughtException", e))
process.on("unhandledRejection", (e) => warn("unhandledRejection", e))
