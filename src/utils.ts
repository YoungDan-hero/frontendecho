export function parseJsonSafe(text: string | null | undefined): unknown | null {
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
