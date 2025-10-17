import express from "express"
import helmet from "helmet"
import cors from "cors"
import morgan from "morgan"
import crypto from "crypto"
import { initializeApp, applicationDefault, cert } from "firebase-admin/app"
import { getFirestore, FieldValue } from "firebase-admin/firestore"
import {
  BadRequest,
  InternalServerError,
  NotFound,
  Success,
} from "./constant/StatusCode.js"
import { NotEnd } from "./constant/EndReason.js"

const app = express()
const PORT = process.env.PORT || 3000

app.use(helmet())
app.use(cors())
app.use(express.json())
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"))

let firebaseApp
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const decoded = Buffer.from(
      process.env.FIREBASE_SERVICE_ACCOUNT,
      "base64"
    ).toString("utf8")
    const serviceAccount = JSON.parse(decoded)
    firebaseApp = initializeApp({ credential: cert(serviceAccount) })
    console.log("Firebase initialized via FIREBASE_SERVICE_ACCOUNT.")
  } else {
    firebaseApp = initializeApp({ credential: applicationDefault() })
    console.log("Firebase initialized via Application Default Credentials.")
  }
} catch (err) {
  console.warn("Firebase init skipped or failed:", err.message)
}
const db = firebaseApp ? getFirestore() : null
//private string key
const PRIVATE_KEY = "nudgytSCAI1"

function generateSessionId() {
  const timestamp = Date.now().toString()
  const nonce = crypto.randomBytes(8).toString("hex")
  const hmac = crypto
    .createHmac("sha256", PRIVATE_KEY)
    .update(`${timestamp}:${nonce}`)
    .digest("base64url") // base64 gives shorter length
    .slice(0, 12)
  return { session_id: hmac }
}

// List all sessions - for Dashboard
app.get("/api/session/", async (req, res) => {
  let statusCode
  try {
    // Optional: support ?limit=999 to avoid huge payloads
    const limit = Math.min(parseInt(req.query.limit || "999", 10), 200)

    const snap = await db
      .collection("sessions")
      .orderBy("start_time")
      .limit(limit)
      .get()

    const sessions = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))
    statusCode = Success
    res.status(statusCode).json({
      ok: true,
      status_code: statusCode,
      count: sessions.length,
      sessions,
    })
  } catch (e) {
    statusCode = InternalServerError
    res
      .status(statusCode)
      .json({ ok: false, statusCode: statusCode, error: e.message })
  }
})

app.post("/api/session/generate", async (req, res) => {
  const chatData = req.body?.chat_data || {}
  const payload = generateSessionId()
  let persisted = false
  let error = null

  try {
    if (!db) throw new Error("Firestore not initialized")

    await db.collection("sessions").doc(payload.session_id).set({
      moved_ai_guide: false,
      start_time: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
      chat_data: chatData,
      end_reason: NotEnd,
    })
    persisted = true
  } catch (e) {
    error = e.message
  }

  res.status(Success).json({
    ok: true,
    status_code: Success,
    ...payload,
    moved_ai_guide: false,
    chat_data: chatData,
    firestore: { enabled: !!db, persisted, error },
  })
})

// Check if a session exists
app.get("/api/session/access", async (req, res) => {
  let statusCode
  try {
    const { session } = req.query
    if (!session) {
      statusCode = BadRequest
      return res.status(statusCode).json({
        ok: false,
        status_code: statusCode,
        error: "Missing query param ?session=",
      })
    }
    const doc = await db.collection("sessions").doc(session).get()
    if (!doc.exists) {
      statusCode = NotFound
      return res.status(statusCode).json({
        ok: false,
        status_code: statusCode,
        message: "Session does not exist",
      })
    }
    // TODO: add checking whether session last updated is within 1 hour or not, if not then its invalidate the session
    statusCode = Success
    return res.status(statusCode).json({
      ok: true,
      status_code: statusCode,
      id: doc.id,
      data: doc.data(),
    })
  } catch (e) {
    statusCode = InternalServerError
    res
      .status(statusCode)
      .json({ ok: false, status_code: statusCode, error: e.message })
  }
})

// Update chatData for a session
app.post("/api/session/update", async (req, res) => {
  let statusCode
  try {
    const { session, chatData } = req.query

    //validate
    if (!session || !chatData) {
      statusCode = BadRequest
      return res.status(statusCode).json({
        ok: false,
        status_code: statusCode,
        error: "Missing required query params: ?session={id}&chatData={string}",
      })
    }
    if (typeof chatData !== "string") {
      statusCode = BadRequest
      return res.status(statusCode).json({
        ok: false,
        status_code: statusCode,
        error: "chatData must be a string",
      })
    }

    const docRef = db.collection("sessions").doc(session)
    const docSnap = await docRef.get()

    if (!docSnap.exists) {
      statusCode = NotFound
      return res.status(statusCode).json({
        ok: false,
        status_code: statusCode,
        error: "Session does not exist",
      })
    }

    // update the document
    await docRef.update({
      chat_data: chatData,
      updated_at: FieldValue.serverTimestamp(),
    })

    //Re-fetch updated doc
    const updated = await docRef.get()
    statusCode = Success
    return res.status(statusCode).json({
      ok: true,
      status_code: statusCode,
      message: "Chat Data updated successfully.",
    })
  } catch (e) {
    statusCode = InternalServerError
    res
      .status(statusCode)
      .json({ ok: false, status_code: statusCode, error: e.message })
  }
})

app.post("/api/chat", async (req, res) => {
  const { messages } = req.body
  if (!process.env.OPENAI_API_KEY) {
    return res
      .status(InternalServerError)
      .json({ error: "OPENAI_API_KEY not set" })
  }
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: messages,
      max_tokens: 150,
      temperature: 0.7,
      presence_penalty: 0.1,
      frequency_penalty: 0.1,
    }),
  })
  const data = await r.json()
  res.json(data)
})

app.get("/healthz", (_req, res) => res.json({ ok: true, statusCode: Success }))

app.listen(PORT, () => console.log(`Server http://localhost:${PORT}`))
