import type { Track } from '../types'

/** A search hit before it is queued. */
export type Candidate = { id: string; title: string; channel: string; duration: number }

/** The fields yt-dlp prints per hit, tab-separated. */
export const PRINT = '%(id)s\t%(title)s\t%(duration)s\t%(channel)s'

/** Parses yt-dlp `--print PRINT` output. */
export function parseHits(stdout: string): Candidate[] {
  const out: Candidate[] = []
  for (const raw of stdout.split('\n')) {
    const [id = '', title = '', duration = '', channel = ''] = raw.split('\t')
    if (!/^[\w-]{11}$/.test(id)) continue
    const secs = Number(duration)
    out.push({
      id,
      title: title.trim(),
      channel: channel === 'NA' ? '' : channel.trim(),
      duration: Number.isFinite(secs) ? Math.round(secs) : 0,
    })
  }
  return out
}

const JUNK =
  /\b(reaction|reacts?|tutorial|lesson|how to|review|interview|podcast|unboxing|teaser|trailer|shorts?|cutscenes?|gameplay|walkthrough|playthrough|game ?film|full movie|movie|episode|endings?|let'?s play|speedrun)\b/i
const LONG = /\b(full album|\d+\s*hours?|hour mix|\d+h mix|live ?stream|24\/7)\b/i

export type PickRules = { blocked: Set<string>; allowLong?: boolean }

/** Whether a hit is worth queueing. */
export function isGood(c: Candidate, rules: PickRules): boolean {
  if (rules.blocked.has(c.id)) return false
  if (JUNK.test(c.title)) return false
  // No duration: a live stream, a premiere or an odd upload. Not worth the risk.
  if (!c.duration) return false
  const max = rules.allowLong ? 3 * 3600 : 600
  if (c.duration < 90 || c.duration > max) return false
  if (!rules.allowLong && LONG.test(c.title)) return false
  return true
}

export function pick(cands: readonly Candidate[], rules: PickRules): Candidate | undefined {
  return cands.find(c => isGood(c, rules))
}

export const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`

/** A YouTube "mix" seeded by one video: endless related music. */
export const radioUrl = (id: string) => `https://www.youtube.com/watch?v=${id}&list=RD${id}`

/** The video id in a YouTube URL, if any. */
export function videoId(url: string | undefined): string | undefined {
  if (!url) return undefined
  const m = /(?:[?&]v=|youtu\.be\/|\/shorts\/)([\w-]{11})/.exec(url)
  return m?.[1]
}

export const toTrack = (c: Candidate, extra: Partial<Track> = {}): Track => ({ ...c, ...extra })
