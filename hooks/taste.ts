import type { Track } from '../types'

/** One finished (or skipped) play. */
export type Play = {
  id: string
  title: string
  channel: string
  /** Share of the track heard, 0..1. */
  ratio: number
  at: number
}

/** The listener's taste, kept across sessions. */
export type Taste = {
  likes: Track[]
  dislikes: Track[]
  history: Play[]
}

export const EMPTY_TASTE: Taste = { likes: [], dislikes: [], history: [] }

const MAX_HISTORY = 300
const MAX_LIST = 500

/** Accepts whatever the store held and returns a well-formed taste. */
export function normalizeTaste(raw: unknown): Taste {
  const t = (raw ?? {}) as Partial<Taste>
  return {
    likes: Array.isArray(t.likes) ? t.likes : [],
    dislikes: Array.isArray(t.dislikes) ? t.dislikes : [],
    history: Array.isArray(t.history) ? t.history : [],
  }
}

export function like(taste: Taste, track: Track): Taste {
  return {
    ...taste,
    likes: [track, ...taste.likes.filter(t => t.id !== track.id)].slice(0, MAX_LIST),
    dislikes: taste.dislikes.filter(t => t.id !== track.id),
  }
}

export function dislike(taste: Taste, track: Track): Taste {
  return {
    ...taste,
    dislikes: [track, ...taste.dislikes.filter(t => t.id !== track.id)].slice(0, MAX_LIST),
    likes: taste.likes.filter(t => t.id !== track.id),
  }
}

export function recordPlay(taste: Taste, track: Track, ratio: number, at: number): Taste {
  const play: Play = {
    id: track.id,
    title: track.title,
    channel: track.channel,
    ratio: Math.max(0, Math.min(1, ratio)),
    at,
  }
  return { ...taste, history: [play, ...taste.history].slice(0, MAX_HISTORY) }
}

/** Skipped early: under a quarter heard. */
export const isSkip = (p: Play) => p.ratio < 0.25

/** Ids that must not be queued again: recent plays and dislikes. */
export function blockedIds(taste: Taste, recent = 200): Set<string> {
  return new Set([
    ...taste.history.slice(0, recent).map(p => p.id),
    ...taste.dislikes.map(t => t.id),
  ])
}

const line = (t: { title: string; channel: string }) => `${t.title} — ${t.channel}`

/** The taste as text for the recommender prompt. */
export function describeTaste(taste: Taste): string {
  const parts: string[] = []
  const likes = taste.likes.slice(0, 15)
  if (likes.length) parts.push(`Liked:\n${likes.map(t => `- ${line(t)}`).join('\n')}`)
  const dislikes = taste.dislikes.slice(0, 10)
  if (dislikes.length) parts.push(`Disliked:\n${dislikes.map(t => `- ${line(t)}`).join('\n')}`)
  const recent = taste.history.slice(0, 30)
  if (recent.length) {
    parts.push(
      `Recently played (newest first; "skipped" = turned off early, "finished" = heard to the end):\n` +
        recent
          .map(p => `- ${line(p)}${isSkip(p) ? ' [skipped]' : p.ratio > 0.8 ? ' [finished]' : ''}`)
          .join('\n'),
    )
  }
  return parts.length ? parts.join('\n\n') : 'No listening history yet.'
}
