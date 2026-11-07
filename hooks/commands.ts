/** Everything the mod can be asked to do, from `/music`, a button or the tool. */
export type Action =
  | { do: 'panel' }
  | { do: 'play'; query: string }
  | { do: 'station'; prompt: string }
  | { do: 'pause' }
  | { do: 'resume' }
  | { do: 'toggle' }
  | { do: 'next' }
  | { do: 'like' }
  | { do: 'dislike' }
  | { do: 'mood'; text: string }
  | { do: 'volume'; value: number }
  | { do: 'playlist-save'; name: string }
  | { do: 'playlist-play'; name: string }
  | { do: 'stop' }
  | { do: 'now' }
  | { do: 'help' }

export const HELP = [
  '/music — open the panel',
  '/music play [query] — play a track now and keep going with similar music (no query: your own station)',
  '/music station <description> — endless station, e.g. "like Boards of Canada but more upbeat"',
  '/music pause | resume | next | like | dislike | stop | now',
  '/music mood <text|auto> — e.g. "calm focus", or auto to follow the session',
  '/music vol <0-100>',
  '/music playlist save <name> | playlist play <name>',
].join('\n')

/** Parses the text after `/music` into an action, or an error message. */
export function parseCommand(args: string): Action | { error: string } {
  const text = args.trim()
  if (text === '') return { do: 'panel' }
  const [head = '', ...rest] = text.split(/\s+/)
  const tail = text.slice(head.length).trim()
  switch (head.toLowerCase()) {
    case 'panel':
      return { do: 'panel' }
    case 'play':
      return { do: 'play', query: tail }
    case 'station':
    case 'radio':
      return tail ? { do: 'station', prompt: tail } : { error: 'Describe the station: /music station <description>' }
    case 'pause':
      return { do: 'pause' }
    case 'resume':
      return { do: 'resume' }
    case 'toggle':
      return { do: 'toggle' }
    case 'next':
    case 'skip':
      return { do: 'next' }
    case 'like':
      return { do: 'like' }
    case 'dislike':
      return { do: 'dislike' }
    case 'mood':
      return tail ? { do: 'mood', text: tail } : { error: 'Usage: /music mood <text|auto>' }
    case 'vol':
    case 'volume': {
      const value = Number(rest[0])
      return Number.isFinite(value) && value >= 0 && value <= 130
        ? { do: 'volume', value: Math.round(value) }
        : { error: 'Usage: /music vol <0-100>' }
    }
    case 'playlist': {
      const [sub = '', ...name] = rest
      const n = name.join(' ').trim()
      if (sub === 'save' && n) return { do: 'playlist-save', name: n }
      if (sub === 'play' && n) return { do: 'playlist-play', name: n }
      return { error: 'Usage: /music playlist save <name> | playlist play <name>' }
    }
    case 'stop':
      return { do: 'stop' }
    case 'now':
      return { do: 'now' }
    case 'help':
      return { do: 'help' }
    default:
      // A bare query plays it: `/music daft punk`.
      return { do: 'play', query: text }
  }
}

/** The tool's input, as the model sends it. */
export type ToolInput = { action?: string; value?: string }

export function parseToolInput(input: ToolInput): Action | { error: string } {
  const action = String(input.action ?? '').trim()
  const value = String(input.value ?? '').trim()
  if (!action) return { error: 'action is required' }
  if (action === 'panel') return { error: 'The panel is for the person; use /music.' }
  return parseCommand(value ? `${action} ${value}` : action)
}
