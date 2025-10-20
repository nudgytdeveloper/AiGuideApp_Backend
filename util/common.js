export const nextFeedbackId() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  const seq = String(counter++).padStart(4, "0")
  return `fb-${y}${m}${day}-${seq}`
}