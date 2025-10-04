// server.js
import dotenv from "dotenv"
dotenv.config()

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import express from "express"
import helmet from "helmet"
import cors from "cors"
import morgan from "morgan"
import crypto from "crypto"
import { initializeApp, applicationDefault, cert } from "firebase-admin/app"
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore"
import {
  BadRequest,
  InternalServerError,
  NotFound,
  Success,
} from "./constant/StatusCode.js"

// ----------------- constants / config -----------------
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DEFAULT_PROJECT_ID = "scaiguide"
const DEFAULT_SESSION_IDLE_MS = 3_600_000 // 1 hour

const DEBUG = String(process.env.DEBUG_FIREBASE || "").toLowerCase() === "true"
const SESSION_IDLE_MS = Number(
  process.env.SESSION_IDLE_MS ?? DEFAULT_SESSION_IDLE_MS
)
const PRIVATE_KEY = process.env.PRIVATE_KEY || "nudgytSCAI1" // don't ship real secrets in code

// ----------------- logging helpers (no secrets) -----------------
const log  = (...a) => console.log("[server]", ...a)
const warn = (...a) => console.warn("[server:warn]", ...a)
const err  = (...a) => console.error("[server:error]", ...a)
const dbg  = (...a) => DEBUG && console.log("[server:debug]", ...a)

// ----------------- Express setup -----------------
const app = express()
const PORT = process.env.PORT || 3000

app.use(helmet())
app.use(cors())
app.use(express.json({ limit: "1mb" }))
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"))

log("Starting HTTP server...")
dbg("ENV summary:", {
  NODE_ENV: process.env.NODE_ENV,
  PORT,
  HAS_FIREBASE_SERVICE_ACCOUNT: !!process.env.FIREBASE_SERVICE_ACCOUNT,
  GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT_ID,
  SESSION_IDLE_MS,
})

// ----------------- Firebase init (b64 -> file -> ADC) -----------------
let firebaseApp
let projectIdUsed = null
let initMode = "unknown"

try {
  const hasB64 =
    !!(process.env.FIREBASE_SERVICE_ACCOUNT && process.env.FIREBASE_SERVICE_ACCOUNT.trim())
  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS

  if (hasB64) {
    initMode = "FIREBASE_SERVICE_ACCOUNT (base64)"
    dbg("Initializing Firebase via base64 JSON...")
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, "base64").toString("utf8")
    const serviceAccount = JSON.parse(decoded)
    projectIdUsed = serviceAccount.project_id || process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT_ID

    firebaseApp = initializeApp({
      credential: cert(serviceAccount),
      projectId: projectIdUsed || undefined,
    })
    log(`Firebase initialized via FIREBASE_SERVICE_ACCOUNT. projectId=${projectIdUsed || "(unset)"}`)
  } else if (credsPath) {
    initMode = "GOOGLE_APPLICATION_CREDENTIALS (file)"
    const absPath = path.isAbsolute(credsPath) ? credsPath : path.resolve(__dirname, credsPath)
    dbg("Initializing Firebase via JSON file path:", absPath)

    if (!fs.existsSync(absPath)) {
      throw new Error(`Credentials file not found at ${absPath}`)
    }
    const raw = fs.readFileSync(absPath, "utf8")
    const serviceAccount = JSON.parse(raw)
    projectIdUsed = serviceAccount.project_id || process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT_ID

    firebaseApp = initializeApp({
      credential: cert(serviceAccount),
      projectId: projectIdUsed || undefined,
    })
    log(
      `Firebase initialized via GOOGLE_APPLICATION_CREDENTIALS file. projectId=${projectIdUsed || "(unset)"} path=${absPath}`
    )
  } else {
    initMode = "Application Default Credentials (ADC)"
    dbg("Initializing Firebase via applicationDefault()...")
    projectIdUsed = process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT_ID

    firebaseApp = initializeApp({
      credential: applicationDefault(),
      projectId: projectIdUsed || undefined,
    })
    log(`Firebase initialized via Application Default Credentials. projectId=${projectIdUsed || "(unset)"}`)
  }
} catch (e) {
  err("Firebase init failed:", e.message)
}

const db = firebaseApp ? getFirestore() : null

// quick ping
;(async () => {
  if (!db) {
    warn("Firestore unavailable: getFirestore() returned null. Check credentials.")
    return
  }
  try {
    dbg("Attempting Firestore ping (read a non-existing doc)...")
    await db.collection("_ping").doc("_noop").get()
    log("Firestore client is ready.")
  } catch (e) {
    err("Firestore ping failed:", e.message)
  }
})()

// ----------------- helpers -----------------
function generateSessionId() {
  const timestamp = Date.now().toString()
  const nonce = crypto.randomBytes(8).toString("hex")
  const hmac = crypto
    .createHmac("sha256", PRIVATE_KEY)
    .update(`${timestamp}:${nonce}`)
    .digest("base64url")
    .slice(0, 12)
  return { sessionId: hmac }
}

function looksLikeJsonString(s) {
  return typeof s === "string" && /^[\[{"]/.test(s.trim())
}

function toMillis(ts) {
  if (!ts) return 0
  if (ts instanceof Timestamp) return ts.toMillis()
  if (typeof ts._seconds === "number") return ts._seconds * 1000 + Math.floor((ts._nanoseconds || 0) / 1e6)
  if (ts instanceof Date) return ts.getTime()
  return Number(ts) || 0
}

function nowMillis() {
  return Timestamp.now().toMillis()
}

function human(ms) {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h) return `${h}h ${m % 60}m`
  if (m) return `${m}m ${s % 60}s`
  return `${s}s`
}

// request debug
app.use((req, _res, next) => {
  dbg("→", req.method, req.originalUrl, { query: req.query })
  next()
})

// ----------------- Routes -----------------

// List all sessions
app.get("/", async (req, res) => {
  let statusCode
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200)
    dbg("List sessions with limit:", limit)
    if (!db) throw new Error("Firestore is not initialized.")

    const snap = await db.collection("sessions").orderBy("createdAt").limit(limit).get()
    const sessions = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))

    statusCode = Success
    res.status(statusCode).json({
      ok: true,
      statusCode,
      count: sessions.length,
      sessions,
      diagnostics: DEBUG ? { initMode, projectIdUsed } : undefined,
    })
  } catch (e) {
    err("GET / error:", e.message)
    statusCode = InternalServerError
    res.status(statusCode).json({ ok: false, statusCode, error: e.message })
  }
})

// Create a session (POST preferred)
app.post("/generate", async (req, res) => {
  let chatData = req.body?.chatData ?? req.query.chatData
  if (looksLikeJsonString(chatData)) {
    try { chatData = JSON.parse(chatData) } catch {}
  }
  const initialData = chatData ?? "Initial Data - tony"
  const payload = generateSessionId()
  dbg("Generate session:", { sessionId: payload.sessionId, hasBody: !!req.body, type: typeof initialData })

  let statusCode = Success
  let persisted = false
  let error = null

  try {
    if (!db) throw new Error("Firestore is not initialized.")
    await db.collection("sessions").doc(payload.sessionId).set({
      chatData: initialData,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      lastAccessedAt: FieldValue.serverTimestamp(),
    })
    persisted = true
  } catch (e) {
    error = e.message
    err("Firestore write (/generate) failed:", e.message)
  }

  res.status(statusCode).json({
    ok: true,
    statusCode,
    ...payload,
    chatData: initialData,
    firestore: { enabled: !!db, persisted, error },
    diagnostics: DEBUG ? { initMode, projectIdUsed } : undefined,
  })
})

// Legacy GET /generate (proxy to POST handler for manual testing)
app.get("/generate", async (req, res) => {
  req.body = {}
  return app._router.handle({ ...req, method: "POST" }, res, () => {})
})

// Check if a session exists + idle invalidation
app.get("/access", async (req, res) => {
  let statusCode
  try {
    if (!db) throw new Error("Firestore is not initialized.")
    const { session } = req.query
    if (!session) {
      statusCode = BadRequest
      return res.status(statusCode).json({
        ok: false,
        statusCode,
        error: "Missing query param ?session=",
      })
    }
    dbg("Access session:", session)

    const docRef = db.collection("sessions").doc(session)
    const doc = await docRef.get()
    if (!doc.exists) {
      statusCode = NotFound
      return res.status(statusCode).json({
        ok: false,
        statusCode,
        message: "Session does not exist",
      })
    }

    const data = doc.data() || {}
    const updatedAtMs     = toMillis(data.updatedAt)
    const lastAccessedMs  = toMillis(data.lastAccessedAt)
    const lastActiveMs    = Math.max(updatedAtMs, lastAccessedMs || 0)
    const nowMs           = nowMillis()
    const idleMs          = Math.max(0, nowMs - (lastActiveMs || 0))

    dbg("Session timing:", {
      updatedAtMs, lastAccessedMs, lastActiveMs, nowMs,
      idleMs, idleHuman: human(idleMs),
      idleLimitMs: SESSION_IDLE_MS, idleLimitHuman: human(SESSION_IDLE_MS),
    })

    if (lastActiveMs && idleMs >= SESSION_IDLE_MS) {
      await docRef.delete()
      statusCode = NotFound
      return res.status(statusCode).json({
        ok: false,
        statusCode,
        message: `Session expired due to inactivity (${human(idleMs)} ≥ ${human(SESSION_IDLE_MS)}).`,
        expired: true,
      })
    }

    await docRef.update({ lastAccessedAt: FieldValue.serverTimestamp() })
    statusCode = Success
    return res.status(statusCode).json({
      ok: true,
      statusCode,
      id: doc.id,
      data,
      diagnostics: DEBUG ? { idleMs, idleHuman: human(idleMs), idleLimitMs: SESSION_IDLE_MS } : undefined,
    })
  } catch (e) {
    err("GET /access error:", e.message)
    statusCode = InternalServerError
    res.status(statusCode).json({ ok: false, statusCode, error: e.message })
  }
})

// Update chatData
app.post("/update", async (req, res) => {
  let statusCode
  try {
    if (!db) throw new Error("Firestore is not initialized.")
    const session  = req.body?.session ?? req.query.session
    let chatData   = req.body?.chatData ?? req.query.chatData

    dbg("Update session:", { session, hasBody: !!req.body, type: typeof chatData })

    if (!session || chatData === undefined) {
      statusCode = BadRequest
      return res.status(statusCode).json({
        ok: false,
        statusCode,
        error: "Missing required params: { session, chatData } (prefer JSON body).",
      })
    }

    if (looksLikeJsonString(chatData)) {
      try { chatData = JSON.parse(chatData) } catch {}
    }

    const docRef = db.collection("sessions").doc(session)
    const docSnap = await docRef.get()
    if (!docSnap.exists) {
      statusCode = NotFound
      return res.status(statusCode).json({
        ok: false,
        statusCode,
        error: "Session does not exist",
      })
    }

    await docRef.update({
      chatData,
      updatedAt: FieldValue.serverTimestamp(),
    })

    statusCode = Success
    return res.status(statusCode).json({
      ok: true,
      statusCode,
      message: "Chat Data updated successfully.",
    })
  } catch (e) {
    err("POST /update error:", e.message)
    statusCode = InternalServerError
    res.status(statusCode).json({ ok: false, statusCode, error: e.message })
  }
})

// Health
app.get("/healthz", (_req, res) =>
  res.json({
    ok: true,
    statusCode: Success,
    diagnostics: DEBUG
      ? {
          initMode,
          projectIdUsed,
          hasDb: !!db,
          idleLimitMs: SESSION_IDLE_MS,
        }
      : undefined,
  })
)

// Start server (don’t auto-listen in unit tests)
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () =>
    log(
      `Server http://localhost:${PORT} | initMode=${initMode} | projectId=${projectIdUsed || "(unset)"}`
    )
  )
}

export { app, db }
