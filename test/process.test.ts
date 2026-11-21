/** End-to-end against the REAL bundle (node dist/index.js): stdout purity, framing, crash fallback, exit. */
import assert from "node:assert/strict"
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { before, describe, test } from "node:test"
import { ROOT, fixtureHello, fixtureObs, HAS_ARENA } from "./helpers.ts"

before(() => {
  execFileSync(process.execPath, [join(ROOT, "scripts", "build.mjs")], { stdio: "ignore" })
})

class Child {
  readonly p: ChildProcessWithoutNullStreams
  readonly lines: string[] = []
  stderr = ""
  exit: Promise<number | null>
  private buf = ""
  constructor(env: Record<string, string> = {}) {
    this.p = spawn(process.execPath, [join(ROOT, "dist", "index.js")], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] })
    this.p.stdout.setEncoding("utf8")
    this.p.stdout.on("data", (d: string) => {
      this.buf += d
      const parts = this.buf.split("\n")
      this.buf = parts.pop() ?? ""
      this.lines.push(...parts)
    })
    this.p.stderr.on("data", (d: Buffer) => (this.stderr += d.toString()))
    this.exit = new Promise((res) => this.p.on("close", (c) => res(c)))
  }
  send(o: object | string): void {
    this.p.stdin.write((typeof o === "string" ? o : JSON.stringify(o)) + "\n")
  }
  async waitFor(n: number, ms = 8000): Promise<void> {
    const t0 = Date.now()
    while (this.lines.length < n) {
      if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${n} lines, have ${this.lines.length}; stderr: ${this.stderr}`)
      await new Promise((r) => setTimeout(r, 5))
    }
  }
}

describe("real process (node dist/index.js)", () => {
  test("stdout carries ONLY protocol JSON lines; one action per obs; clean exit 0 after end", async () => {
    const c = new Child()
    c.send(fixtureHello())
    await c.waitFor(1)
    assert.equal(JSON.parse(c.lines[0]!).type, "ready")
    const obs = fixtureObs().slice(0, 12)
    for (const [i, o] of obs.entries()) {
      c.send(o)
      await c.waitFor(2 + i)
    }
    c.send({ type: "end", place: 5, kills: 0 })
    assert.equal(await c.exit, 0)
    assert.equal(c.lines.length, 1 + obs.length)
    for (const l of c.lines) assert.doesNotThrow(() => JSON.parse(l), `non-JSON on stdout: ${l.slice(0, 80)}`)
    assert.deepEqual(c.lines.slice(1).map((l) => JSON.parse(l).tick), obs.map((o) => o.tick))
    assert.equal(c.stderr, "", "no stderr noise without MECH_DEBUG")
  })

  test("garbage on stdin and a crashing tick never corrupt stdout; a fallback {tick} is emitted", async () => {
    const c = new Child()
    c.send(fixtureHello())
    await c.waitFor(1)
    c.send("}{ not json at all")
    c.send({ type: "obs", tick: 4242, t: 1 }) // missing self/zone/...: the tick handler throws internally
    await c.waitFor(2)
    assert.deepEqual(JSON.parse(c.lines[1]!), { tick: 4242 })
    c.send(fixtureObs()[3]!)
    await c.waitFor(3)
    assert.equal(JSON.parse(c.lines[2]!).tick, fixtureObs()[3]!.tick)
    c.p.stdin.end() // EOF without `end`
    assert.equal(await c.exit, 0)
  })

  test("a nonexistent map dir degrades gracefully: ready is still sent and ticks are answered", async () => {
    const c = new Child()
    c.send(fixtureHello("/definitely/not/here"))
    await c.waitFor(1)
    assert.equal(JSON.parse(c.lines[0]!).type, "ready")
    c.send(fixtureObs()[1]!)
    await c.waitFor(2)
    assert.equal(JSON.parse(c.lines[1]!).tick, fixtureObs()[1]!.tick)
    c.p.stdin.end()
    await c.exit
  })

  test("MECH_DEBUG=1 sends diagnostics to stderr only", { skip: !HAS_ARENA && "arena not found" }, async () => {
    const c = new Child({ MECH_DEBUG: "1" })
    c.send(fixtureHello())
    await c.waitFor(1)
    assert.match(c.stderr, /init: map/)
    assert.equal(JSON.parse(c.lines[0]!).type, "ready")
    c.p.stdin.end()
    await c.exit
  })

  test("a backlog written in one chunk is answered once, for the newest obs", async () => {
    const c = new Child()
    c.send(fixtureHello())
    await c.waitFor(1)
    const [a, b, d] = fixtureObs().slice(0, 3)
    c.p.stdin.write([a, b, d].map((o) => JSON.stringify(o)).join("\n") + "\n")
    await c.waitFor(2)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(c.lines.length, 2)
    assert.equal(JSON.parse(c.lines[1]!).tick, d!.tick)
    c.p.stdin.end()
    await c.exit
  })
})

describe("source hygiene", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f)
      return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : []
    })

  test("no console.log / console.info / process.stdout anywhere in src/ except the single writer in runtime/io.ts", () => {
    for (const f of files(join(ROOT, "src"))) {
      if (f.endsWith(join("runtime", "io.ts")) || f.endsWith(join("types", "mechfight.ts"))) continue
      const text = readFileSync(f, "utf8")
      assert.ok(!/console\.(log|info|debug)\b/.test(text), `${f} calls console.log/info/debug`)
      assert.ok(!/process\.stdout\.write/.test(text), `${f} writes to stdout directly`)
    }
  })

  test("no filesystem writes anywhere in src/ (read-only rootfs, uid 65534)", () => {
    for (const f of files(join(ROOT, "src"))) {
      const text = readFileSync(f, "utf8")
      assert.ok(!/(writeFileSync|appendFileSync|createWriteStream|mkdirSync|writeFile\b)/.test(text), `${f} writes to the filesystem`)
    }
  })

  test("no runtime transpilation tooling in the dist entry", () => {
    const text = readFileSync(join(ROOT, "dist", "index.js"), "utf8")
    assert.ok(!/ts-node|tsx\b/.test(text))
  })
})
