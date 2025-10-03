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
} from "./constant/StatusCode"

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
  const nonce = crypto.randomBytes(16).toString("hex")
  const hmac = crypto
    .createHmac("sha256", PRIVATE_KEY)
    .update(`${timestamp}:${nonce}`)
    .digest("hex")
  return { sessionId: hmac, issuedAt: Number(timestamp) }
}

// List all sessions
app.get("/", async (req, res) => {
  let statusCode
  try {
    // Optional: support ?limit=20 to avoid huge payloads
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200)

    const snap = await db
      .collection("sessions")
      .orderBy("issuedAt", "desc")
      .limit(limit)
      .get()

    const sessions = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))
    statusCode = Success
    res.status(statusCode).json({
      ok: true,
      statusCode: statusCode,
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

app.get("/generate", async (req, res) => {
  const providedChatData = req.query.chatData,
    initialData = providedChatData || "Initial Data - tony",
    payload = generateSessionId()
  let persisted = false,
    error = null,
    statusCode
  if (db) {
    try {
      await db.collection("sessions").doc(payload.sessionId).set({
        issuedAt: payload.issuedAt,
        createdAt: FieldValue.serverTimestamp(),
        chatData: initialData,
      })
      persisted = true
    } catch (e) {
      error = e.message
    }
  }
  statusCode = Success
  res.status(statusCode).json({
    ok: true,
    statusCode: statusCode,
    ...payload,
    chatData: initialData,
    firestore: { enabled: !!db, persisted, error },
  })
})

// Check if a session exists
app.get("/check", async (req, res) => {
  let statusCode
  try {
    const { session } = req.query
    if (!session) {
      statusCode = BadRequest
      return res.status(statusCode).json({
        ok: false,
        statusCode: statusCode,
        error: "Missing query param ?session=",
      })
    }
    const doc = await db.collection("sessions").doc(session).get()
    if (!doc.exists) {
      statusCode = NotFound
      return res.status(statusCode).json({
        ok: false,
        statusCode: statusCode,
        message: "Session does not exist",
      })
    }
    statusCode = Success
    return res.status(statusCode).json({
      ok: true,
      statusCode: statusCode,
      id: doc.id,
      data: doc.data(),
    })
  } catch (e) {
    statusCode = InternalServerError
    res
      .status(statusCode)
      .json({ ok: false, statusCode: statusCode, error: e.message })
  }
})

// Update chatData for a session
app.post("/update", async (req, res) => {
  let statusCode
  try {
    const { session, chatData } = req.query

    //validate
    if (!session || !chatData) {
      statusCode = BadRequest
      return res.status(statusCode).json({
        ok: false,
        statusCode: statusCode,
        error: "Missing required query params: ?session={id}&chatData={string}",
      })
    }
    if (typeof chatData !== "string") {
      statusCode = BadRequest
      return res.status(statusCode).json({
        ok: false,
        statusCode: statusCode,
        error: "chatData must be a string",
      })
    }

    const docRef = db.collection("sessions").doc(session)
    const docSnap = await docRef.get()

    if (!docSnap.exists) {
      statusCode = NotFound
      return res.status(statusCode).json({
        ok: false,
        statusCode: statusCode,
        error: "Session does not exist",
      })
    }

    // update the document
    await docRef.update({
      chatData,
      updatedAt: FieldValue.serverTimestamp(),
    })

    //Re-fetch updated doc
    const updated = await docRef.get()
    statusCode = Success
    return res.status(statusCode).json({
      ok: true,
      statusCode: statusCode,
      message: "Chat Data updated successfully.",
    })
  } catch (e) {
    statusCode = InternalServerError
    res
      .status(statusCode)
      .json({ ok: false, statusCode: statusCode, error: e.message })
  }
})

app.get("/healthz", (_req, res) => res.json({ ok: true, statusCode: Success }))

app.listen(PORT, () => console.log(`Server http://localhost:${PORT}`))
