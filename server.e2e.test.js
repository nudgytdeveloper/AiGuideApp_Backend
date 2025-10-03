// server.e2e.test.js
import { describe, it, beforeAll, afterAll, expect } from "vitest"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as wait } from "node:timers/promises"
import fs from "node:fs"

import { initializeApp, cert } from "firebase-admin/app"
import { getFirestore, Timestamp } from "firebase-admin/firestore"

// ---------- config ----------
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const TEST_PORT = Number(process.env.TEST_PORT || 3456)
const BASE_URL = `http://localhost:${TEST_PORT}`

// defaults you asked for
const DEFAULT_PROJECT_ID = "scaiguide"
const DEFAULT_SESSION_IDLE_MS = 3_600_000 // 1 hour

const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS || ""
const GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT_ID

// test runner’s own idea of “what is idle”; used for metadata only
const TEST_SESSION_IDLE_MS = Number(process.env.SESSION_IDLE_MS ?? DEFAULT_SESSION_IDLE_MS)

// but when we spawn the server for e2e, we usually want it SHORT (3s) so the expiry test is fast
const SERVER_SESSION_IDLE_MS = Number(process.env.TEST_SESSION_IDLE_MS ?? 3000)

// where to store the final JSON report
const REPORT_DIR = path.resolve(__dirname, "reports")
const REPORT_PATH = path.join(REPORT_DIR, "e2e-report.json")

// ---------- simple in-test reporter ----------
const report = {
  meta: {
    startedAt: new Date().toISOString(),
    projectId: GOOGLE_CLOUD_PROJECT || "(unset)",
    hasCredsFile: !!GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(GOOGLE_APPLICATION_CREDENTIALS),
    testPort: TEST_PORT,
    // show both: what tests think is default + what server is actually using
    testSessionIdleMs: TEST_SESSION_IDLE_MS,
    serverSessionIdleMs: SERVER_SESSION_IDLE_MS,
    node: process.version,
    env: {
      GOOGLE_APPLICATION_CREDENTIALS,
      GOOGLE_CLOUD_PROJECT,
      SESSION_IDLE_MS: TEST_SESSION_IDLE_MS,
      TEST_SESSION_IDLE_MS: SERVER_SESSION_IDLE_MS,
    },
  },
  serverLogs: { stdout: "", stderr: "" },
  tests: [],
}

function startTest(name) {
  const t = {
    name,
    status: "running",
    started: Date.now(),
    durationMs: 0,
    notes: "",
    http: [],
    createdSessionIds: []
  }
  report.tests.push(t)
  return t
}
function finishTest(t, status = "passed", notes = "") {
  t.status = status
  t.durationMs = Date.now() - t.started
  if (notes) t.notes = notes
}
async function http(method, url, body, t) {
  const opts = { method, headers: {} }
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json"
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(url, opts)
  const json = await res.json().catch(() => ({}))
  if (t) t.http.push({ method, url, status: res.status, json })
  return { status: res.status, json }
}

async function waitForHealthy(timeoutMs = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const { status, json } = await http("GET", `${BASE_URL}/healthz`)
      if (status === 200 && json?.ok) return
    } catch {}
    await wait(200)
  }
  throw new Error("Server did not become healthy in time")
}

function haveRealCreds() {
  return GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(GOOGLE_APPLICATION_CREDENTIALS)
}

function initTestAdmin() {
  if (!haveRealCreds()) return null
  const raw = fs.readFileSync(GOOGLE_APPLICATION_CREDENTIALS, "utf8")
  const svc = JSON.parse(raw)
  const app = initializeApp(
    { credential: cert(svc), projectId: svc.project_id || GOOGLE_CLOUD_PROJECT || undefined },
    "vitest-admin"
  )
  return getFirestore(app)
}

// ---------- lifecycle ----------
let child
let testDb = null
let createdSessionIds = []

beforeAll(async () => {
  const t = startTest("beforeAll: boot server")
  try {
    if (!haveRealCreds()) {
      report.meta.skipReason = "GOOGLE_APPLICATION_CREDENTIALS not set or file missing."
      finishTest(t, "skipped", report.meta.skipReason)
      return
    }

    // spawn server with a SHORT idle window (fast expiry test)
    child = spawn("node", ["server.js"], {
      cwd: __dirname,
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        SESSION_IDLE_MS: String(SERVER_SESSION_IDLE_MS),
        DEBUG_FIREBASE: "true",
        NODE_ENV: "development",
        GOOGLE_CLOUD_PROJECT: GOOGLE_CLOUD_PROJECT, // default "scaiguide"
      },
      stdio: ["ignore", "pipe", "pipe"],
    })

    child.stdout.on("data", (d) => {
      const s = d.toString()
      report.serverLogs.stdout += s
      process.stdout.write(`[srv] ${s}`)
    })
    child.stderr.on("data", (d) => {
      const s = d.toString()
      report.serverLogs.stderr += s
      process.stderr.write(`[srv-err] ${s}`)
    })

    await waitForHealthy()
    testDb = initTestAdmin()
    finishTest(t, "passed")
  } catch (e) {
    finishTest(t, "failed", String(e?.message || e))
    throw e
  }
})

afterAll(async () => {
  const t = startTest("afterAll: cleanup + write report")
  try {
    try {
      if (testDb && createdSessionIds.length) {
        const batch = testDb.batch()
        for (const id of createdSessionIds) {
          batch.delete(testDb.collection("sessions").doc(id))
        }
        await batch.commit()
      }
    } catch (e) {
      t.notes += `Cleanup error: ${String(e?.message || e)}`
    }

    if (child && !child.killed) {
      child.kill("SIGTERM")
      await wait(200)
    }

    report.meta.finishedAt = new Date().toISOString()
    report.meta.durationMs =
      new Date(report.meta.finishedAt).getTime() - new Date(report.meta.startedAt).getTime()

    fs.mkdirSync(REPORT_DIR, { recursive: true })
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2))
    finishTest(t, "passed", `Report written to ${REPORT_PATH}`)
  } catch (e) {
    finishTest(t, "failed", String(e?.message || e))
    try {
      fs.mkdirSync(REPORT_DIR, { recursive: true })
      fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2))
    } catch {}
    throw e
  }
})

// ---------- tests ----------
describe("server.js e2e (JS)", () => {
  it("GET /healthz returns ok", async () => {
    const t = startTest("GET /healthz")
    try {
      if (!haveRealCreds()) { finishTest(t, "skipped"); return }
      const { status, json } = await http("GET", `${BASE_URL}/healthz`, undefined, t)
      expect(status).toBe(200)
      expect(json.ok).toBe(true)
      finishTest(t, "passed")
    } catch (e) {
      finishTest(t, "failed", String(e?.message || e))
      throw e
    }
  })

  it("POST /generate stores JSON chatData (no [object Object])", async () => {
    const t = startTest("POST /generate → GET / list")
    try {
      if (!haveRealCreds()) { finishTest(t, "skipped"); return }
      const gen = await http("POST", `${BASE_URL}/generate`, {
        chatData: { messages: [{ role: "user", text: "hi" }] },
      }, t)
      expect(gen.status).toBe(200)
      const sessionId = gen.json.sessionId
      t.createdSessionIds.push(sessionId)
      createdSessionIds.push(sessionId)

      const list = await http("GET", `${BASE_URL}/?limit=10`, undefined, t)
      expect(list.status).toBe(200)
      const found = list.json.sessions.find((s) => s.id === sessionId)
      expect(found).toBeTruthy()
      expect(typeof found.chatData).toBe("object")
      expect(found.chatData.messages?.length).toBe(1)
      finishTest(t, "passed")
    } catch (e) {
      finishTest(t, "failed", String(e?.message || e))
      throw e
    }
  })

  it("GET /generate still works as legacy proxy to POST", async () => {
    const t = startTest("GET /generate (legacy proxy)")
    try {
      if (!haveRealCreds()) { finishTest(t, "skipped"); return }
      const gen = await http("GET", `${BASE_URL}/generate`, undefined, t)
      expect(gen.status).toBe(200)
      expect(gen.json.ok).toBe(true)
      expect(gen.json.sessionId).toBeTruthy()
      t.createdSessionIds.push(gen.json.sessionId)
      createdSessionIds.push(gen.json.sessionId)
      finishTest(t, "passed")
    } catch (e) {
      finishTest(t, "failed", String(e?.message || e))
      throw e
    }
  })

  it("POST /update modifies chatData and GET /access returns it", async () => {
    const t = startTest("POST /update + GET /access")
    try {
      if (!haveRealCreds()) { finishTest(t, "skipped"); return }
      const g = await http("POST", `${BASE_URL}/generate`, { chatData: { a: 1 } }, t)
      const sid = g.json.sessionId
      t.createdSessionIds.push(sid)
      createdSessionIds.push(sid)

      const u = await http("POST", `${BASE_URL}/update`, {
        session: sid,
        chatData: { a: 1, b: 2, note: "updated" },
      }, t)
      expect(u.status).toBe(200)

      const a = await http("GET", `${BASE_URL}/access?session=${sid}`, undefined, t)
      expect(a.status).toBe(200)
      expect(a.json.data.chatData.b).toBe(2)
      finishTest(t, "passed")
    } catch (e) {
      finishTest(t, "failed", String(e?.message || e))
      throw e
    }
  })

  it("POST /update fails with missing params", async () => {
    const t = startTest("POST /update validation failures")
    try {
      if (!haveRealCreds()) { finishTest(t, "skipped"); return }
      const bad1 = await http("POST", `${BASE_URL}/update`, { session: "someid" }, t)
      expect(bad1.status).toBe(400)
      const bad2 = await http("POST", `${BASE_URL}/update`, { chatData: "hello" }, t)
      expect(bad2.status).toBe(400)
      finishTest(t, "passed")
    } catch (e) {
      finishTest(t, "failed", String(e?.message || e))
      throw e
    }
  })

  it("GET /access keeps active sessions alive", async () => {
    const t = startTest("GET /access keeps session active")
    try {
      if (!haveRealCreds()) { finishTest(t, "skipped"); return }
      const g = await http("POST", `${BASE_URL}/generate`, { chatData: { foo: "bar" } }, t)
      const sid = g.json.sessionId
      t.createdSessionIds.push(sid)
      createdSessionIds.push(sid)

      const first = await http("GET", `${BASE_URL}/access?session=${sid}`, undefined, t)
      expect(first.status).toBe(200)
      const second = await http("GET", `${BASE_URL}/access?session=${sid}`, undefined, t)
      expect(second.status).toBe(200)
      finishTest(t, "passed")
    } catch (e) {
      finishTest(t, "failed", String(e?.message || e))
      throw e
    }
  })

  it("GET /access invalidates a session idle longer than SERVER_SESSION_IDLE_MS", async () => {
    const t = startTest("GET /access idle invalidation")
    try {
      if (!haveRealCreds()) { finishTest(t, "skipped"); return }
      if (!testDb) throw new Error("testDb not ready")

      const sid = "idle_" + Math.random().toString(36).slice(2, 10)
      const col = testDb.collection("sessions")
      const oldMs = Date.now() - Number(SERVER_SESSION_IDLE_MS) - 1500

      await col.doc(sid).set({
        chatData: { idle: true },
        createdAt: Timestamp.fromMillis(oldMs),
        updatedAt: Timestamp.fromMillis(oldMs),
        lastAccessedAt: Timestamp.fromMillis(oldMs),
      })
      t.createdSessionIds.push(sid)
      createdSessionIds.push(sid)

      const res = await http("GET", `${BASE_URL}/access?session=${sid}`, undefined, t)
      expect([404, 410]).toContain(res.status)
      expect(res.json.expired).toBe(true)

      const res2 = await http("GET", `${BASE_URL}/access?session=${sid}`, undefined, t)
      expect(res2.status).toBe(404)
      finishTest(t, "passed")
    } catch (e) {
      finishTest(t, "failed", String(e?.message || e))
      throw e
    }
  })
})
