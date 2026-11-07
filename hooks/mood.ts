import type { Mood } from '../types'

/** One thing that happened in the session. */
export type Signal = { at: number; kind: 'bash-ok' | 'bash-fail' | 'edit' }

export const WINDOW_MS = 15 * 60 * 1000

export const PRESETS: Record<string, string> = {
  'deep focus': 'instrumental, steady groove, minimal vocals, nothing jarring',
  'calm debugging': 'calm, unobtrusive, warm, low tempo, soft or no vocals',
  'upbeat flow': 'driving, upbeat, energetic but not distracting',
  'late night': 'quiet, warm, dreamy, low tempo',
  'morning warmup': 'bright, gentle, optimistic',
  'focused work': 'mellow, instrumental-leaning, steady',
}

export const DEFAULT_MOOD: Mood = { mode: 'auto', label: 'focused work', hint: PRESETS['focused work']! }

export function normalizeMood(raw: unknown): Mood {
  const m = raw as Partial<Mood> | undefined
  if (!m || (m.mode !== 'auto' && m.mode !== 'manual') || typeof m.label !== 'string') return DEFAULT_MOOD
  return { mode: m.mode, label: m.label, hint: typeof m.hint === 'string' ? m.hint : m.label }
}

/** A mood the person typed: a preset name, or their own words. */
export function manualMood(text: string): Mood {
  const label = text.trim()
  return { mode: 'manual', label, hint: PRESETS[label.toLowerCase()] ?? label }
}

/** Reads the session's recent signals and the hour into a mood label. */
export function autoLabel(signals: readonly Signal[], now: number, hour: number): string {
  const recent = signals.filter(s => now - s.at <= WINDOW_MS)
  const fails = recent.filter(s => s.kind === 'bash-fail').length
  const bash = fails + recent.filter(s => s.kind === 'bash-ok').length
  const edits = recent.filter(s => s.kind === 'edit').length

  if (hour >= 23 || hour < 6) return 'late night'
  if (fails >= 3 && fails / Math.max(1, bash) >= 0.4) return 'calm debugging'
  if (edits >= 15) return 'upbeat flow'
  if (edits >= 5) return 'deep focus'
  if (hour < 10) return 'morning warmup'
  return 'focused work'
}

export function autoMood(signals: readonly Signal[], now: number, hour: number): Mood {
  const label = autoLabel(signals, now, hour)
  return { mode: 'auto', label, hint: PRESETS[label]! }
}
