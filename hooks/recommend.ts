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

// ---------------------------------------------------------------- session soundtrack

export const SOUNDTRACK_SYSTEM = `You score coding sessions the way a composer scores a film scene.
You get a digest of what a developer is doing right now in their terminal with an AI agent.
Read the scene: the task, how it is going (failures, fixes, long hunts, fast progress), the hour.
Then describe the music for it. Answer with JSON only, no prose, no code fences:
{"scene":"<what this session is about and how it feels, under 12 words, in the language the developer writes in>",
 "name":"<a station name, 2-5 words>",
 "prompt":"<one sentence for a music curator: genres, energy, tempo, vocals or not, 2-4 reference artists>"}
Music must help focus: no comedy, no jarring genre jumps.`

/** One message of the session, as `$.session.messages()` gives it. */
export type DigestMessage = {
  role: 'user' | 'assistant'
  text: string
  toolUses?: readonly { tool: string; input?: Record<string, unknown>; isError?: boolean }[]
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
}

/** The key argument of a tool call: the file, the command, the pattern. */
function toolArg(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  for (const k of ['file_path', 'command', 'pattern', 'path', 'url', 'description', 'query']) {
    const v = input[k]
    if (typeof v === 'string' && v.trim()) return clip(v, 70)
  }
  return ''
}

/** A short, model-ready picture of the session's recent work. */
export function sessionDigest(
  messages: readonly DigestMessage[],
  extra: { project: string; hour: number; fails: number; edits: number },
  limit = 40,
): string {
  const lines: string[] = [
    `Project: ${extra.project}`,
    `Local hour: ${extra.hour}:00`,
    `Last 15 min: ${extra.edits} file edits, ${extra.fails} failed shell commands`,
    '',
    'Recent conversation (oldest first):',
  ]
  for (const m of messages.slice(-limit)) {
    if (m.text.trim()) lines.push(`${m.role === 'user' ? 'DEV' : 'AGENT'}: ${clip(m.text, m.role === 'user' ? 300 : 160)}`)
    for (const t of m.toolUses ?? []) {
      // The mod's own tool says nothing about the work.
      if (t.tool.startsWith('mcp__musicflow__')) continue
      const arg = toolArg(t.input)
      lines.push(`  [${t.tool}${arg ? `: ${arg}` : ''}]`)
    }
  }
  return lines.join('\n')
}

export type Soundtrack = { scene: string; name: string; prompt: string }

export function parseSoundtrack(text: string): Soundtrack | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const d = JSON.parse(text.slice(start, end + 1)) as Partial<Soundtrack>
    const prompt = typeof d.prompt === 'string' ? d.prompt.trim() : ''
    if (!prompt) return null
    return {
      scene: typeof d.scene === 'string' ? clip(d.scene, 120) : '',
      name: typeof d.name === 'string' && d.name.trim() ? clip(d.name, 40) : 'Session soundtrack',
      prompt: clip(prompt, 400),
    }
  } catch {
    return null
  }
}
