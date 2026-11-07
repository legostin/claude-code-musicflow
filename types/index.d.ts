/** One YouTube track the mod knows about. */
export type Track = {
  /** YouTube video id (11 chars). */
  id: string
  title: string
  channel: string
  /** Seconds; 0 when unknown. */
  duration: number
  /** Why Claude picked it, shown in the queue. */
  why?: string
  /** The station that queued it. */
  station?: string
}

/** An endless stream generated from a description. */
export type Station = {
  name: string
  prompt: string
  /** Allow long mixes (> 10 min). */
  allowLong?: boolean
}

/** A fixed list of tracks. */
export type Playlist = { name: string; tracks: Track[] }

/** What feeds the queue now. */
export type Source =
  | { kind: 'station'; station: Station }
  | { kind: 'playlist'; name: string }
  | { kind: 'none' }

export type Mood = {
  mode: 'auto' | 'manual'
  /** The manual text, or the auto label. */
  label: string
  /** The longer description the recommender reads. */
  hint: string
}

/** What the player reports on a poll. */
export type Player = {
  isRunning: boolean
  isPaused: boolean
  isIdle: boolean
  current?: Track
  pos: number
  dur: number
  volume: number
  upcoming: Track[]
}

/** What the panel shows from the store. */
export type Library = {
  source: Source
  stations: Station[]
  playlists: Playlist[]
  mood: Mood
  likedIds: string[]
  /** Where the now-playing line sits: under the prompt (text) or above it (band with buttons). */
  layout: Layout
}

export type Layout = 'below' | 'above'

declare module 'claude-code' {
  interface PluginState {
    musicflow: {
      player: Player
      library: Library
      activity: string | null
    }
  }
}
