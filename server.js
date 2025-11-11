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
import admin from "firebase-admin"
import { NotEnd } from "./constant/EndReason.js"
import {
  getStartTimeMillis,
  startAfterFromMillis,
  stripSystemMessages,
  withSessionTimes,
} from "./util/common.js"
import { Started } from "./constant/SessionStatus.js"


const fs = require("fs").promises; // Use the 'promises' version for async/await
const path = require("path");
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
// Session apis
// List out all sesions or specific session - for Dashboard (single session require ?session={id})
app.get("/api/session", async (req, res) => {
  let statusCode
  try {
    const sessionId = (req.query.session || "").trim()
    const filterSystem = req.query.filter === "1" // only filter when ?filter=1

    if (sessionId) {
      const docSnap = await db.collection("sessions").doc(sessionId).get()

      if (docSnap.exists) {
        const data = docSnap.data() || {}
        let shaped = withSessionTimes(
          { session_id: sessionId, ...data },
          { offsetMinutes: 8 * 60 }
        )
        if (filterSystem && shaped.chat_data) {
          shaped.chat_data = stripSystemMessages(shaped.chat_data)
        }
        statusCode = Success
        return res.status(statusCode).json({ ...shaped })
      } else {
        statusCode = NotFound
        return res.status(statusCode).json({ message: "Session not found" })
      }
    }

    const rawLimit = parseInt(req.query.limit || "200", 10)
    const limit = Number.isFinite(rawLimit) ? rawLimit : 200

    const pageTokenRaw = (req.query.page_token || "").trim()
    let query = db.collection("sessions").orderBy("start_time", "asc")

    if (pageTokenRaw) {
      const tokenMillis = Number(pageTokenRaw)
      if (!Number.isFinite(tokenMillis)) {
        return res
          .status(BadRequest)
          .json({ error: "Invalid page_token. Expected millis number/string." })
      }
      query = query.startAfter(startAfterFromMillis(tokenMillis, admin))
    }

    const snap = await query.limit(limit + 1).get()
    const docs = snap.docs.filter((d) => Number.isFinite(getStartTimeMillis(d)))

    const hasMore = docs.length > limit
    const pageDocs = hasMore ? docs.slice(0, limit) : docs

    const sessions = pageDocs.map((doc) => {
      let shaped = withSessionTimes(
        { session_id: doc.id, ...(doc.data() || {}) },
        { offsetMinutes: 8 * 60 }
      )
      if (filterSystem && shaped.chat_data) {
        shaped.chat_data = stripSystemMessages(shaped.chat_data)
      }
      return shaped
    })

    let nextPageToken = null
    if (hasMore) {
      const lastDoc = pageDocs[pageDocs.length - 1]
      const lastMillis = getStartTimeMillis(lastDoc)
      nextPageToken = Number.isFinite(lastMillis) ? String(lastMillis) : null
    }

    statusCode = Success
    return res.status(statusCode).json({
      count: sessions.length,
      next_page_token: nextPageToken, // pass this into ?page_token= on the next call
      sessions,
    })
  } catch (e) {
    statusCode = InternalServerError
    return res.status(statusCode).json({ error: e.message })
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
      status: Started,
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
    status: Started,
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
// Chat apis
app.post("/api/chat", async (req, res) => {
  const { messages } = req.body;

  if (!process.env.OPENAI_API_KEY) {
    return res
      .status(InternalServerError)
      .json({ error: "OPENAI_API_KEY not set" });
  }

  let knowledgeContext = "";
  try {
    const filePath = path.join(__dirname, "sciencecenter.txt");
    knowledgeContext = await fs.readFile(filePath, "utf8");
  } catch (readError) {
    console.error("Error reading sciencecenter.txt:", readError);

    return res
      .status(500)
      .json({ error: "Could not read the knowledge file." });
  }

  const lastUserMessage = messages.pop(); 
  const augmentedUserMessage = {
    role: "user",
    content: `
Here is some context from the Science Center website (sciencecenter.txt). Use this information to answer my question.
---
CONTEXT:
${knowledgeContext}
---
MY QUESTION:
${lastUserMessage.content}
`,
  };

  const messagesForAPI = [
    ...messages, 
    augmentedUserMessage, 
  ];

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: messagesForAPI, 
      max_tokens: 150,
      temperature: 0.7,
      presence_penalty: 0.1,
      frequency_penalty: 0.1,
    }),
  });

  const data = await r.json();
  res.json(data);
});
// Rating apis
/**
 * GET /api/ratings
 *
 * Query params (all optional):
 *  - type: "app" | "hologram"
 *  - session_id: string
 *  - start: ISO date (e.g., 2025-10-18T08:51:38+08:00)  -> created_at >= start
 *  - end:   ISO date (e.g., 2025-10-18T08:51:38+08:00)  -> created_at <= end
 *  - order: "asc" | "desc" (default "desc")
 *  - limit: number (default 20, max 100)
 *  - page_token: cursor string (created_at millis from last page)
 *
 * Response:
 * {
 *   "ratings": [ ...docs ],
 *   "next_page_token": "1737465600000" | null
 * }
 */
app.get("/api/rating", async (req, res) => {
  try {
    const {
      type,
      session_id,
      start,
      end,
      order = "desc",
      limit = "20",
      page_token,
    } = req.query

    const pageSize = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100)
    let q = db.collection("ratings")

    if (type) q = q.where("type", "==", type)
    if (session_id) q = q.where("session_id", "==", session_id)

    if (start) q = q.where("created_at", ">=", new Date(start))
    if (end) q = q.where("created_at", "<=", new Date(end))

    q = q.orderBy("created_at", order === "asc" ? "asc" : "desc")

    if (page_token) {
      const millis = Number(page_token)
      if (!Number.isNaN(millis)) {
        q = q.startAfter(admin.firestore.Timestamp.fromMillis(millis))
      }
    }

    const snap = await q.limit(pageSize).get()

    const ratings = snap.docs.map((d) => {
      const data = d.data()
      const createdAt = data.created_at?.toDate
        ? data.created_at.toDate()
        : new Date(data.created_at)

      // Convert to ISO string with +08:00 offset
      const offsetMinutes = 8 * 60
      const isoCreatedAt = new Date(
        createdAt.getTime() + offsetMinutes * 60 * 1000
      )
        .toISOString()
        .replace("Z", "+08:00")

      return {
        id: d.id,
        ...data,
        created_at: isoCreatedAt,
      }
    })

    let next_page_token = null
    if (ratings.length === pageSize) {
      const last = ratings[ratings.length - 1]
      const lastCreated = last.created_at
      const millis = new Date(lastCreated).getTime()
      if (millis) next_page_token = String(millis)
    }

    return res.status(200).json({ ratings, next_page_token })
  } catch (err) {
    console.error("GET /api/ratings error:", err)
    return res
      .status(500)
      .json({ error: "Internal error", details: String(err) })
  }
})
// Seed helpers (unable to move to other file for now due to firebase)
let feedbackSeq = 1
export function makeFeedbackId(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  const seq = String(feedbackSeq++).padStart(4, "0")
  return `fb-${y}${m}${d}-${seq}`
}

export function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

export const SAMPLE_MESSAGES = [
  "The hologram guide was very engaging and helped me understand the exhibits better. Would love more interactive content!",
  "Great experience overall—clear directions and helpful tips.",
  "Kids loved it! Could add more hands-on demos.",
  "Audio was a bit soft in the hall, but the guide was informative.",
  "Impressive tech and easy to use. Will visit again!",
]

export function randomSessionId(prefix = "sess") {
  // 18-char hex-ish, similar length to your sample
  return `${prefix}-${Math.random().toString(16).slice(2, 11)}${Math.random()
    .toString(16)
    .slice(2, 9)}`
}

/**
 * Generate seeded docs
 * options:
 *  - count_app: number of "app" docs
 *  - count_hologram: number of "hologram" docs
 *  - session_prefix: string for generated session_id
 *  - days_back: spread random created_at in last N days (default 30)
 *  - fixed_session_id: if provided, use this for all docs
 */
function buildSeedDocs({
  count_app = 2,
  count_hologram = 2,
  session_prefix = "sess",
  days_back = 30,
  fixed_session_id,
}) {
  const docs = []
  const total = count_app + count_hologram

  for (let i = 0; i < total; i++) {
    const isApp = i < count_app
    const dayOffset = randInt(0, Math.max(0, days_back))
    const createdDate = new Date()
    createdDate.setDate(createdDate.getDate() - dayOffset)
    createdDate.setHours(randInt(9, 18), randInt(0, 59), randInt(0, 59), 0)

    const feedback_id = makeFeedbackId(createdDate)
    const session_id =
      fixed_session_id ?? randomSessionId(session_prefix || "sess")
    const created_at = admin.firestore.Timestamp.fromDate(createdDate)

    if (isApp) {
      docs.push({
        feedback_id,
        session_id,
        type: "app",
        q1_score: randInt(1, 5),
        q2_score: randInt(1, 5),
        q3_score: randInt(1, 5),
        feedback_msg: SAMPLE_MESSAGES[randInt(0, SAMPLE_MESSAGES.length - 1)],
        created_at,
      })
    } else {
      docs.push({
        feedback_id,
        session_id,
        type: "hologram",
        score: randInt(1, 5),
        created_at,
      })
    }
  }
  return docs
}

async function writeInBatches(collectionPath, docs, idField = "feedback_id") {
  const CHUNK = 450 // ≤ 500 writes per commit
  for (let i = 0; i < docs.length; i += CHUNK) {
    const batch = db.batch()
    const slice = docs.slice(i, i + CHUNK)
    slice.forEach((doc) => {
      const id = doc[idField] || db.collection(collectionPath).doc().id
      const ref = db.collection(collectionPath).doc(id)
      batch.set(ref, doc, { merge: false })
    })
    await batch.commit()
  }
}

// ===== Seed Endpoint =====
/**
 * POST /api/ratings/seed
 * Body or query (all optional):
 *  - count_app: number (default 20)
 *  - count_hologram: number (default 20)
 *  - session_prefix: string (default "sess")
 *  - days_back: number (default 30) — randomizes created_at within last N days
 *  - fixed_session_id: string — if set, all docs use this session_id
 *
 * Response: { inserted: number, counts: { app, hologram }, sample_ids: string[] }
 */
app.post("/api/rating/seed", async (req, res) => {
  try {
    // if (!SEED_ENABLED) {
    //   return res
    //     .status(403)
    //     .json({ error: "Seeding disabled. Set SEED_ENABLED=true to allow." });
    // }

    const {
      count_app,
      count_hologram,
      session_prefix,
      days_back,
      fixed_session_id,
    } = { ...req.query, ...req.body }

    const counts = {
      app: Math.max(0, parseInt(count_app ?? 2, 10) || 0),
      hologram: Math.max(0, parseInt(count_hologram ?? 2, 10) || 0),
    }

    const docs = buildSeedDocs({
      count_app: counts.app,
      count_hologram: counts.hologram,
      session_prefix,
      days_back: parseInt(days_back ?? 30, 10) || 30,
      fixed_session_id:
        typeof fixed_session_id === "string" && fixed_session_id.trim()
          ? fixed_session_id.trim()
          : undefined,
    })

    await writeInBatches("ratings", docs)

    return res.status(Success).json({
      inserted: docs.length,
      counts,
      sample_ids: docs.slice(0, 5).map((d) => d.feedback_id),
    })
  } catch (err) {
    console.error("POST /api/ratings/seed error:", err)
    return res
      .status(InternalServerError)
      .json({ error: "Internal error", details: String(err) })
  }
})
// Notification apis
/** Helper: normalize Firestore Timestamp/string/Date to ISO8601 */
function toISO(value) {
  if (!value) return undefined
  if (typeof value?.toDate === "function") return value.toDate().toISOString()
  if (typeof value === "string") return value
  try {
    return new Date(value).toISOString()
  } catch {
    return undefined
  }
}

/**
 * GET /api/notifications
 *
 * Query params:
 * - type (optional)
 * - priority (optional)
 * - is_read (optional)
 * - limit (default 50)
 * - order (default "desc")
 * - page_token (optional): cursor (created_at in milliseconds)
 */
app.get("/api/notification", async (req, res) => {
  try {
    const {
      type,
      priority,
      is_read,
      limit = "20",
      order = "desc",
      page_token,
    } = req.query

    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200)
    const orderDir = order === "asc" ? "asc" : "desc"

    let q = db.collection("notifications")

    if (type) q = q.where("type", "==", type)
    if (priority) q = q.where("priority", "==", priority)

    if (typeof is_read === "string") {
      const flag = is_read.toLowerCase() === "true"
      if (["true", "false"].includes(is_read.toLowerCase())) {
        q = q.where("is_read", "==", flag)
      }
    }

    q = q.orderBy("created_at", orderDir)

    if (page_token) {
      const cursorDate = new Date(parseInt(page_token, 10))
      if (!isNaN(cursorDate.valueOf())) {
        q = q.startAfter(cursorDate)
      }
    }

    q = q.limit(limitNum)

    const snap = await q.get()

    const notifications = snap.docs.map((doc) => {
      const d = doc.data() || {}

      return {
        id: d.id || doc.id,
        title: d.title || "",
        body: d.body || "",
        date_time: toISO(d.date_time),
        created_at: toISO(d.created_at),
        ...(d.type ? { type: d.type } : {}),
        ...(d.priority ? { priority: d.priority } : {}),
        is_read: Boolean(d.is_read),
        ...(d.location ? { location: d.location } : {}),
        ...(d.deep_link ? { deep_link: d.deep_link } : {}),
      }
    })

    // New page_token: created_at in milliseconds
    const lastItem = notifications[notifications.length - 1]
    const next_page_token = lastItem
      ? new Date(lastItem.created_at).getTime().toString()
      : null

    res.status(200).json({
      notifications,
      page_info: {
        limit: limitNum,
        order: orderDir,
        next_page_token,
        has_more: notifications.length === limitNum,
      },
    })
  } catch (err) {
    console.error("GET /api/notifications error:", err)
    res.status(500).json({
      error: {
        code: "notifications_fetch_failed",
        message: "Failed to fetch notifications.",
        details:
          process.env.NODE_ENV === "production" ? undefined : String(err),
      },
    })
  }
})
// Notification Seed end points..
/**
 * POST /api/notifications/seed
 *
 * Seeds 5 mock notifications into Firestore.
 * Each notification includes id, title, body, date_time, created_at, type, priority, is_read, location, deep_link.
 */
app.post("/api/notification/seed", async (req, res) => {
  try {
    const now = new Date()
    const baseTime = now.getTime()

    const mockNotifications = [
      {
        id: "notif_20251020_001",
        title: "New Exhibit Alert!",
        body: "Come explore our latest AI & Robotics exhibit in Hall D. Limited-time guided tours available.",
        date_time: new Date(baseTime - 3600 * 1000).toISOString(),
        created_at: new Date(baseTime - 7200 * 1000).toISOString(),
        type: "exhibit_update",
        priority: "high",
        is_read: false,
        location: "Hall D",
        deep_link: "/exhibits/ai-robotics",
      },
      {
        id: "notif_20251020_002",
        title: "Maintenance Notice",
        body: "The Hologram Theatre will be temporarily closed for maintenance until 3 PM today.",
        date_time: new Date(baseTime - 1800 * 1000).toISOString(),
        created_at: new Date(baseTime - 3600 * 1000).toISOString(),
        type: "facility_notice",
        priority: "normal",
        is_read: false,
        location: "Hall B",
        deep_link: "/facilities/hologram-theatre",
      },
      {
        id: "notif_20251020_003",
        title: "Exclusive Workshop",
        body: "Join our hands-on AI coding workshop this weekend! Limited seats available.",
        date_time: new Date(baseTime + 86400 * 1000).toISOString(),
        created_at: new Date(baseTime - 3000 * 1000).toISOString(),
        type: "event_invite",
        priority: "high",
        is_read: false,
        location: "Innovation Lab",
        deep_link: "/events/ai-workshop",
      },
      {
        id: "notif_20251020_004",
        title: "General Announcement",
        body: "Welcome to Science Centre Singapore! Don’t miss the daily guided tour at 10 AM.",
        date_time: new Date(baseTime - 600 * 1000).toISOString(),
        created_at: new Date(baseTime - 1200 * 1000).toISOString(),
        type: "general",
        priority: "low",
        is_read: true,
        location: "Lobby",
        deep_link: "/tours/daily",
      },
      {
        id: "notif_20251020_005",
        title: "App Update Available",
        body: "A new version of the AI Guide App is available. Update now for improved performance!",
        date_time: new Date(baseTime).toISOString(),
        created_at: new Date(baseTime - 500 * 1000).toISOString(),
        type: "app_update",
        priority: "normal",
        is_read: false,
        location: "Mobile App",
        deep_link: "/app/update",
      },
    ]

    const batch = db.batch()
    const collectionRef = db.collection("notifications")

    mockNotifications.forEach((notif) => {
      const docRef = collectionRef.doc(notif.id)
      batch.set(docRef, notif)
    })

    await batch.commit()

    res.status(201).json({
      message: "✅ Seeded 5 mock notifications successfully.",
      count: mockNotifications.length,
      ids: mockNotifications.map((n) => n.id),
    })
  } catch (err) {
    console.error("POST /api/notifications/seed error:", err)
    res.status(InternalServerError).json({
      error: {
        code: "notifications_seed_failed",
        message: "Failed to seed notifications.",
        details:
          process.env.NODE_ENV === "production" ? undefined : String(err),
      },
    })
  }
})

// Routes taken api
// GET /api/route?session_id=...
// session_id is required..
app.get("/api/route", async (req, res) => {
  try {
    const { session_id } = req.query

    if (!session_id || typeof session_id !== "string" || !session_id.trim()) {
      return res.status(400).json({
        error: "Missing required query param: session_id",
      })
    }

    const db = admin.firestore()

    const colRef = db.collection("user_route")

    // If you have an index, you can add .orderBy("started_at", "asc")
    const snap = await colRef.where("session_id", "==", session_id).get()

    const routes = snap.docs.map((doc) => {
      // Keep Firestore doc id as route_id if your data doesn't already include it
      const data = doc.data()
      return {
        // prefer explicit route_id if present; otherwise fall back to doc.id
        route_id: data.route_id || doc.id,
        session_id: data.session_id,
        date: data.date,
        started_at: data.started_at,
        ended_at: data.ended_at,
        total_duration_minutes: data.total_duration_minutes,
        stops: Array.isArray(data.stops) ? data.stops : [],
      }
    })

    // uses "user_route" as the key and returns an array of routes.
    return res.status(200).json({
      user_route: routes,
    })
  } catch (err) {
    console.error("GET /api/route error:", err)
    return res.status(500).json({
      error: "Internal server error",
      details: err?.message || String(err),
    })
  }
})
// Routes Seed api
// POST /api/route/seed?session_id=7v7muZTl01PK
// Seeds 2 mock user_route docs if the session_id exists in Firestore
app.post("/api/route/seed", async (req, res) => {
  try {
    const session_id = req.query.session_id || req.body.session_id

    if (!session_id || typeof session_id !== "string" || !session_id.trim()) {
      return res
        .status(400)
        .json({ error: "Missing required parameter: session_id" })
    }

    const db = admin.firestore()

    // 🔍 Check if this session_id exists under 'sessions' collection
    const sessionRef = db.collection("sessions").doc(session_id)
    const sessionDoc = await sessionRef.get()

    if (!sessionDoc.exists) {
      return res
        .status(404)
        .json({ error: `Session ID ${session_id} not found in Firestore.` })
    }

    // 🧠 Mock data for 2 route documents
    const routes = [
      {
        route_id: `route_${Date.now()}_001`,
        session_id,
        date: "2025-09-23",
        started_at: "2025-09-23T10:15:00+08:00",
        ended_at: "2025-09-23T13:40:00+08:00",
        total_duration_minutes: 205,
        stops: [
          {
            stop_id: "stop_001",
            exhibit_id: "exhibit_AI_001",
            exhibit_name: "AI Hologram Experience",
            entered_at: "2025-09-23T10:20:00+08:00",
            exited_at: "2025-09-23T10:45:00+08:00",
            duration_mins: 25,
            lat: 1.334567,
            lng: 103.742345,
            name: "Hall A",
          },
          {
            stop_id: "stop_002",
            exhibit_id: "exhibit_ROBOTICS_003",
            exhibit_name: "Robotics Showcase",
            entered_at: "2025-09-23T11:00:00+08:00",
            exited_at: "2025-09-23T11:40:00+08:00",
            duration_mins: 40,
            lat: 1.335678,
            lng: 103.741234,
            name: "Hall C",
          },
        ],
      },
      {
        route_id: `route_${Date.now()}_002`,
        session_id,
        date: "2025-09-23",
        started_at: "2025-09-23T14:00:00+08:00",
        ended_at: "2025-09-23T16:00:00+08:00",
        total_duration_minutes: 120,
        stops: [
          {
            stop_id: "stop_003",
            exhibit_id: "exhibit_AI_002",
            exhibit_name: "AI in Daily Life",
            entered_at: "2025-09-23T14:10:00+08:00",
            exited_at: "2025-09-23T14:50:00+08:00",
            duration_mins: 40,
            lat: 1.336789,
            lng: 103.743456,
            name: "Hall D",
          },
          {
            stop_id: "stop_004",
            exhibit_id: "exhibit_SPACE_001",
            exhibit_name: "Space Tech Wonders",
            entered_at: "2025-09-23T15:00:00+08:00",
            exited_at: "2025-09-23T15:55:00+08:00",
            duration_mins: 55,
            lat: 1.337123,
            lng: 103.744567,
            name: "Hall E",
          },
        ],
      },
    ]

    // 🧾 Save both routes to Firestore
    const batch = db.batch()
    routes.forEach((route) => {
      const ref = db.collection("user_route").doc(route.route_id)
      batch.set(ref, route)
    })
    await batch.commit()

    return res.status(200).json({
      message: `2 mock routes created successfully for session_id: ${session_id}`,
      user_route: routes,
    })
  } catch (err) {
    console.error("POST /api/route/seed error:", err)
    return res.status(500).json({
      error: "Internal server error",
      details: err?.message || String(err),
    })
  }
})
// indoor navigation api
app.get("/api/mappedin-token", async (_req, res) => {
  try {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.MAPPEDIN_CLIENT_ID,
      client_secret: process.env.MAPPEDIN_CLIENT_SECRET,
    })

    const r = await fetch("https://api-gateway.mappedin.com/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    })

    const json = await r.json() // { access_token, token_type, expires_in, ... }
    res.json({ accessToken: json.access_token })
  } catch (e) {
    res.status(InternalServerError).json({ error: "Failed to fetch token" })
  }
})

app.get("/healthz", (_req, res) => res.json({ ok: true, statusCode: Success }))

app.listen(PORT, () => console.log(`Server http://localhost:${PORT}`))
