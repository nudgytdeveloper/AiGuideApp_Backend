export function nextFeedbackId() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  const seq = String(counter++).padStart(4, "0")
  return `fb-${y}${m}${day}-${seq}`
}
// -- normalize & format to +08:00 (no extra deps) ----
function toDate(val) {
  if (!val) return null
  // Firestore Timestamp
  if (typeof val.toDate === "function") return val.toDate()
  // Millis
  if (typeof val === "number") {
    // treat >= 10^12 as ms, <= 10^10 as seconds
    return new Date(val < 1e11 ? val * 1000 : val)
  }
  // ISO string
  if (typeof val === "string") return new Date(val)
  return null
}

function formatISOWithOffset(date, offsetMinutes = 8 * 60) {
  if (!(date instanceof Date) || isNaN(date)) return null

  // Convert UTC date -> local time in target offset
  const utcMs = date.getTime()
  const shiftedMs = utcMs + offsetMinutes * 60 * 1000
  const d = new Date(shiftedMs)

  const pad = (n) => String(n).padStart(2, "0")
  const yyyy = d.getUTCFullYear()
  const mm = pad(d.getUTCMonth() + 1)
  const dd = pad(d.getUTCDate())
  const HH = pad(d.getUTCHours())
  const MM = pad(d.getUTCMinutes())
  const SS = pad(d.getUTCSeconds())

  const sign = offsetMinutes >= 0 ? "+" : "-"
  const oh = pad(Math.floor(Math.abs(offsetMinutes) / 60))
  const om = pad(Math.abs(offsetMinutes) % 60)

  return `${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}${sign}${oh}:${om}`
}

export function withSessionTimes(raw, opts = { offsetMinutes: 8 * 60 }) {
  const start = toDate(raw.start_time)
  const end = start ? new Date(start.getTime() + 24 * 60 * 60 * 1000) : null
  const updated = toDate(raw.updated_at)

  return {
    ...raw,
    start_time: formatISOWithOffset(start, opts.offsetMinutes),
    end_time: formatISOWithOffset(end, opts.offsetMinutes),
    updated_at: formatISOWithOffset(updated, opts.offsetMinutes),
  }
}
export const getStartTimeMillis = (doc) => {
  const v = doc.get("start_time")
  if (!v) return null
  if (typeof v?.toMillis === "function") return v.toMillis() // Firestore Timestamp
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
export const startAfterFromMillis = (millis, admin) => {
  // Works for numeric start_time fields; if you're storing Timestamp, create one.
  return admin?.firestore?.Timestamp
    ? admin.firestore.Timestamp.fromMillis(millis)
    : millis
}
//return chat_data with all "system" messages removed.
// Works for both Array and { "0": {...}, "1": {...} } map shapes.
export function stripSystemMessages(chatData) {
  if (!chatData) return chatData

  const isSystem = (m) => String(m?.role || "").toLowerCase() === "system"

  if (Array.isArray(chatData)) {
    return chatData.filter((m) => !isSystem(m))
  }

  if (typeof chatData === "object") {
    // Preserve ordering if keys are "0","1","2",...
    const sorted = Object.entries(chatData)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, v]) => v)
    return sorted.filter((m) => !isSystem(m))
  }

  return chatData // unknown shape, leave as is
}
