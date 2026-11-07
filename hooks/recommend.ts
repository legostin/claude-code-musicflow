import type { Mood, Station, Track } from '../types'

export type Pick = { query: string; why: string }

export const SYSTEM = `You are the DJ inside a developer's terminal. You pick music to play from YouTube while they code.
Answer with JSON only, no prose, no code fences:
{"picks":[{"query":"<artist> - <track title>","why":"<under 10 words, in the listener's language if obvious, else English>"}]}
Rules:
- Real, existing tracks only, written as "artist - title" so a YouTube search finds the original upload.
- Follow the station description first, the mood second, the taste history third.
- Mix familiar artists from the liked list with new discoveries in the same spirit (about 1 in 3 familiar).
- Never repeat a recently played or disliked track. Avoid artists the listener keeps skipping.
- Vary artists: at most one track per artist in one answer.`

export type RecommendContext = {
  station: Station
  mood: Mood
  taste: string
  count: number
  /** The track playing now, if any. */
  current?: Track
}

export function buildPrompt(ctx: RecommendContext): string {
  return [
    `Station: ${ctx.station.name}\n${ctx.station.prompt}`,
    `Mood (${ctx.mood.mode}): ${ctx.mood.label} — ${ctx.mood.hint}`,
    ctx.current ? `Playing now: ${ctx.current.title} — ${ctx.current.channel}` : '',
    `Listener taste:\n${ctx.taste}`,
    `Give ${ctx.count} picks.`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Reads the picks out of the model's reply, tolerating fences and stray text. */
export function parsePicks(text: string): Pick[] {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let data: unknown
  try {
    data = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  const picks = (data as { picks?: unknown })?.picks
  if (!Array.isArray(picks)) return []
  const out: Pick[] = []
  const seen = new Set<string>()
  for (const p of picks) {
    const query = typeof p?.query === 'string' ? p.query.trim() : ''
    if (!query || query.length > 200 || seen.has(query.toLowerCase())) continue
    seen.add(query.toLowerCase())
    out.push({ query, why: typeof p?.why === 'string' ? p.why.trim().slice(0, 120) : '' })
  }
  return out
}

/** A short station name from its description. */
export function stationName(prompt: string): string {
  const words = prompt.replace(/\s+/g, ' ').trim()
  return words.length <= 32 ? words : `${words.slice(0, 31).trimEnd()}…`
}
