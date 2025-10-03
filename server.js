import express from "express"
import helmet from "helmet"
import cors from "cors"
import morgan from "morgan"
import crypto from "crypto"
import { initializeApp, applicationDefault, cert } from "firebase-admin/app"
import { getFirestore, FieldValue } from "firebase-admin/firestore"

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

    res.status(200).json({ ok: true, count: sessions.length, sessions })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.get("/generate", async (req, res) => {
  const providedChatData = req.query.chatData,
    initialData = providedChatData || "Initial Data - tony",
    payload = generateSessionId()
  let persisted = false,
    error = null
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
  res.status(200).json({
    ok: true,
    ...payload,
    chatData: initialData,
    firestore: { enabled: !!db, persisted, error },
  })
})

// Check if a session exists
app.get("/check", async (req, res) => {
  try {
    const { session } = req.query
    if (!session) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing query param ?session=" })
    }
    const doc = await db.collection("sessions").doc(session).get()
    if (!doc.exists) {
      return res
        .status(404)
        .json({ ok: false, message: "Session does not exist" })
    }
    return res.status(200).json({
      ok: true,
      id: doc.id,
      data: doc.data(),
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// Update chatData for a session
app.post("/update", async (req, res) => {
  try {
    const { session, chatData } = req.query

    //validate
    if (!session || !chatData) {
      return res.status(400).json({
        ok: false,
        error: "Missing required query params: ?session={id}&chatData={string}",
      })
    }
    if (typeof chatData !== "string") {
      return res.status(400).json({
        ok: false,
        error: "chatData must be a string",
      })
    }

    const docRef = db.collection("sessions").doc(session)
    const docSnap = await docRef.get()

    if (!docSnap.exists) {
      return res.status(404).json({
        ok: false,
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

    return res.status(200).json({
      ok: true,
      message: "Chat Data updated successfully.",
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.get("/healthz", (_req, res) => res.json({ ok: true }))

app.listen(PORT, () => console.log(`Server http://localhost:${PORT}`))
