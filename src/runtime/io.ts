import { writeSync } from "node:fs"
import { RUNTIME } from "../config/index.ts"

const sleeper = new Int32Array(new SharedArrayBuffer(4))

/** Synchronous, fully-flushed write of one line to fd 1. Throws (EPIPE etc.) to the caller, who exits. */
export function writeLine(line: string): void {
  const buf = Buffer.from(line + "\n", "utf8")
  let off = 0
  let spins = 0
  while (off < buf.length) {
    try {
      off += writeSync(1, buf, off, buf.length - off)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === "EAGAIN" && spins++ < RUNTIME.writeRetryLimit) {
        Atomics.wait(sleeper, 0, 0, 1)
        continue
      }
      throw e
    }
  }
}

/** THE ONLY writer to stdout. Never call console.log anywhere. */
export function sendMessage(msg: object): void {
  writeLine(JSON.stringify(msg))
}

/** Splits a text stream into complete lines; the unterminated tail is kept (bounded). */
export class LineSplitter {
  private tail = ""
  private readonly maxChars: number

  constructor(maxChars: number) {
    this.maxChars = maxChars
  }

  feed(chunk: string): string[] {
    const parts = (this.tail + chunk).split("\n")
    this.tail = parts.pop() ?? ""
    if (this.tail.length > this.maxChars) this.tail = "" // runaway line: drop it rather than grow
    return parts.filter((l) => l.trim().length > 0)
  }

  /** At EOF: whatever is left is a final unterminated line. */
  flush(): string[] {
    const rest = this.tail
    this.tail = ""
    return rest.trim().length > 0 ? [rest] : []
  }
}
