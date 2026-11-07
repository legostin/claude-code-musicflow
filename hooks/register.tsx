import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Layout, Library, Mood, Player, Playlist, Source, Station, Track } from '../types'
import { type Action, HELP, parseCommand, parseToolInput, type ToolInput } from './commands'
import { DEFAULT_MOOD, PRESETS, type Signal, autoMood, manualMood, normalizeMood } from './mood'
import { type Env, ensure, ipc, mix, resolveEnv, search, snapshot } from './mpv'
import { SYSTEM, buildPrompt, parsePicks, stationName } from './recommend'
import { isGood, pick, radioUrl, toTrack, watchUrl } from './search'
import { blockedIds, describeTaste, dislike, like, normalizeTaste, recordPlay, type Taste } from './taste'

type $ = EngineInterface

const PANE = 'musicflow'
const TOOL = 'mcp__musicflow__Music'
const LOW_WATER = 3
const FRESH_MS = 20_000
const GEN_LOCK_MS = 90_000
const RETRY_MS = 60_000
const MY_WAVE: Station = {
  name: 'My wave',
  prompt: 'Music that fits my taste profile; if there is no history yet, good music to code to.',
}

const IDLE_PLAYER: Player = { isRunning: false, isPaused: false, isIdle: true, pos: 0, dur: 0, volume: 0, upcoming: [] }
const EMPTY_LIBRARY: Library = { source: { kind: 'none' }, stations: [], playlists: [], mood: DEFAULT_MOOD, likedIds: [], layout: 'below' }

const player = atom({ plugin: 'musicflow', key: 'player' } as const, IDLE_PLAYER)
const library = atom({ plugin: 'musicflow', key: 'library' } as const, EMPTY_LIBRARY)
const activity = atom({ plugin: 'musicflow', key: 'activity' } as const, null as string | null)

// ---------------------------------------------------------------- formatting

const clock = (s: number) => {
  const t = Math.max(0, Math.floor(s))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const ss = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const bar = (pos: number, dur: number, width: number) => {
  if (!dur) return '─'.repeat(width)
  const filled = Math.max(0, Math.min(width, Math.round((pos / dur) * width)))
  return '━'.repeat(filled) + '─'.repeat(width - filled)
}

const name = (t: Track) => (t.channel ? `${t.title} — ${t.channel}` : t.title)

const sourceText = (s: Source) =>
  s.kind === 'station' ? `station: ${s.station.name}` : s.kind === 'playlist' ? `playlist: ${s.name}` : 'no station'


/** What this load of the module keeps; a reload starts it over. */
const S = {
  env: null as Env | null,
  me: '',
  isLeader: false,
  isGenerating: false,
  lastFailAt: 0,
  tick: 0,
  prev: null as { track: Track; pos: number; dur: number } | null,
}
const signals: Signal[] = []
const meta = new Map<string, Track>()

// ------------------------------------------------------------ store access

async function getTaste($: $): Promise<Taste> {
  return normalizeTaste(await $.store.get('taste'))
}
function setTaste($: $, t: Taste) {
  return $.store.set('taste', t)
}
async function getSource($: $): Promise<Source> {
  const s = (await $.store.get('source')) as Source | undefined
  return s && (s.kind === 'station' || s.kind === 'playlist') ? s : { kind: 'none' }
}
async function getStations($: $) {
  return ((await $.store.get('stations')) as Station[] | undefined) ?? []
}
async function getLayout($: $): Promise<Layout> {
  return (await $.store.get('layout')) === 'above' ? 'above' : 'below'
}
async function getPlaylists($: $) {
  return ((await $.store.get('playlists')) as Playlist[] | undefined) ?? []
}

async function getMood($: $): Promise<Mood> {
  const mood = normalizeMood(await $.store.get('mood'))
  if (mood.mode === 'manual') return mood
  const auto = normalizeMood(await $.store.get('moodAuto'))
  return auto.mode === 'auto' ? auto : DEFAULT_MOOD
}

async function hour($: $) {
  const r = await $.process.run(['date', '+%H']).catch(() => null)
  const h = Number(r?.stdout.trim())
  return Number.isFinite(h) ? h : 12
}

/** Recomputes the auto mood from this session's signals. */
async function refreshAutoMood($: $) {
  const now = await $.clock.now()
  const mood = autoMood(signals, now, await hour($))
  await $.store.set('moodAuto', mood)
}

async function loadMeta($: $) {
  const stored = ((await $.store.get('meta')) as Record<string, Track> | undefined) ?? {}
  for (const [id, t] of Object.entries(stored)) meta.set(id, t)
}

async function saveMeta($: $, tracks: readonly Track[]) {
  for (const t of tracks) meta.set(t.id, t)
  const stored = ((await $.store.get('meta')) as Record<string, Track> | undefined) ?? {}
  for (const t of tracks) stored[t.id] = t
  const ids = Object.keys(stored)
  for (const id of ids.slice(0, Math.max(0, ids.length - 600))) delete stored[id]
  await $.store.set('meta', stored)
}

async function refreshLibrary($: $) {
  const [source, stations, playlists, mood, taste, layout] = await Promise.all([
    getSource($),
    getStations($),
    getPlaylists($),
    getMood($),
    getTaste($),
    getLayout($),
  ])
  const liked: Playlist = { name: 'Liked', tracks: taste.likes }
  const next: Library = {
    source,
    stations,
    playlists: taste.likes.length ? [liked, ...playlists] : playlists,
    mood,
    likedIds: taste.likes.map(t => t.id),
    layout,
  }
  const held = await read($, library)
  if (JSON.stringify(held) !== JSON.stringify(next)) await update($, library, () => next)
}

function setActivity($: $, text: string | null) {
  return update($, activity, () => text)
}

// ------------------------------------------------------------ sessions

function sessionsPath() {
  return `${S.env!.dir}/sessions.json`
}

async function readSessions($: $): Promise<Record<string, number>> {
  try {
    const text = (await $.fs.read(sessionsPath())) as unknown as string
    const data = JSON.parse(text) as Record<string, number>
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

/** Marks this session alive and elects the leader: the smallest live id. */
async function heartbeat($: $) {
  if (!S.env || !S.me) return
  const now = await $.clock.now()
  const all = await readSessions($)
  const live: Record<string, number> = {}
  for (const [id, at] of Object.entries(all)) if (now - at < FRESH_MS) live[id] = at
  live[S.me] = now
  await $.fs.write(sessionsPath(), JSON.stringify(live)).catch(() => undefined)
  S.isLeader = Object.keys(live).sort()[0] === S.me
}

async function othersAlive($: $) {
  const now = await $.clock.now()
  const all = await readSessions($)
  return Object.entries(all).some(([id, at]) => id !== S.me && now - at < FRESH_MS)
}

/** A lock so two sessions do not fill the queue at once. */
async function takeGenLock($: $) {
  const path = `${S.env!.dir}/gen.lock`
  const now = await $.clock.now()
  try {
    const held = JSON.parse((await $.fs.read(path)) as unknown as string) as { id: string; at: number }
    if (held.id !== S.me && now - held.at < GEN_LOCK_MS) return false
  } catch {
    // no lock yet
  }
  await $.fs.write(path, JSON.stringify({ id: S.me, at: now })).catch(() => undefined)
  return true
}

function releaseGenLock($: $) {
  return $.fs.write(`${S.env!.dir}/gen.lock`, JSON.stringify({ id: S.me, at: 0 })).catch(() => undefined)
}

// ------------------------------------------------------------ player

function missing() {
  return !S.env?.mpv || !S.env?.ytdlp
    ? `musicflow needs ${[!S.env?.mpv && 'mpv', !S.env?.ytdlp && 'yt-dlp'].filter(Boolean).join(' and ')}: brew install mpv yt-dlp`
    : null
}

async function start($: $): Promise<string | null> {
  if (!S.env) S.env = await resolveEnv($)
  const why = missing()
  if (why) return why
  return (await ensure($, S.env)) ? null : 'mpv did not start; try `mpv --version` in a terminal.'
}

async function poll($: $) {
  if (!S.env) return
  const now = await $.clock.now()
  const p = await snapshot($, S.env, id => meta.get(id))

  // A track changed: what share of the last one was heard is a taste signal.
  if (S.prev && S.prev.track.id !== p.current?.id) {
    const ratio = S.prev.dur ? S.prev.pos / S.prev.dur : 0
    if (S.isLeader && S.prev.dur > 0) await setTaste($, recordPlay(await getTaste($), S.prev.track, ratio, now))
  }
  S.prev = p.current ? { track: p.current, pos: p.pos, dur: p.dur } : null

  const held = await read($, player)
  if (JSON.stringify(held) !== JSON.stringify(p)) await update($, player, () => p)
  return p
}

async function queue($: $, tracks: readonly Track[], mode: 'append-play' | 'replace' = 'append-play') {
  if (!S.env || tracks.length === 0) return
  await saveMeta($, tracks)
  const [first, ...rest] = tracks
  await ipc($, S.env, [
    ['loadfile', watchUrl(first!.id), mode],
    ...rest.map(t => ['loadfile', watchUrl(t.id), 'append-play']),
  ])
}

// ------------------------------------------------------------ recommendations

/** Fills the queue for the active station. Tracks start as they are found. */
async function generate($: $, reason: 'low' | 'start' = 'low') {
  if (!S.env || S.isGenerating) return
  const source = await getSource($)
  if (source.kind !== 'station') return
  if (!(await takeGenLock($))) return
  S.isGenerating = true
  await setActivity($, reason === 'start' ? `tuning in: ${source.station.name}…` : 'picking the next tracks…')
  try {
    const [taste, mood, p] = await Promise.all([getTaste($), getMood($), read($, player)])
    const blocked = blockedIds(taste)
    for (const t of p.upcoming) blocked.add(t.id)
    if (p.current) blocked.add(p.current.id)
    const rules = { blocked, allowLong: source.station.allowLong }
    let added = 0

    const reply = await $.model.complete({
      model: 'haiku',
      system: SYSTEM,
      prompt: buildPrompt({ station: source.station, mood, taste: describeTaste(taste), count: 8, current: p.current }),
      maxTokens: 1200,
      effort: 'low',
      timeoutMs: 60_000,
    })
    const picks = reply.isAnswered ? parsePicks(reply.text) : []

    await Promise.all(
      picks.map(async pk => {
        const hits = await search($, S.env!, pk.query, 3)
        const c = pick(hits, rules)
        if (!c || blocked.has(c.id)) return
        blocked.add(c.id)
        added++
        await queue($, [toTrack(c, { why: pk.why, station: source.station.name })])
      }),
    )

    // The model said nothing usable: fall back to a YouTube mix.
    if (added < 2) {
      const seed = p.current?.id ?? taste.likes[0]?.id ?? taste.history[0]?.id
      if (seed && /^[\w-]{11}$/.test(seed)) {
        const hits = (await mix($, S.env, radioUrl(seed), 20)).filter(c => isGood(c, rules)).slice(0, 5)
        for (const c of hits) blocked.add(c.id)
        added += hits.length
        await queue($, hits.map(c => toTrack(c, { why: 'YouTube mix', station: source.station.name })))
      }
    }

    if (added === 0) {
      S.lastFailAt = await $.clock.now()
      $.ui.toast('musicflow: found nothing to play. If YouTube playback fails too, update yt-dlp: brew upgrade yt-dlp')
    }
  } finally {
    S.isGenerating = false
    await releaseGenLock($)
    await setActivity($, null)
  }
}

// ------------------------------------------------------------ actions

async function setSource($: $, source: Source) {
  await $.store.set('source', source)
  await refreshLibrary($)
}

async function rememberStation($: $, station: Station) {
  const stations = (await getStations($)).filter(s => s.prompt !== station.prompt)
  await $.store.set('stations', [station, ...stations].slice(0, 20))
}

async function startStation($: $, station: Station): Promise<string> {
  await setSource($, { kind: 'station', station })
  if (station.name !== MY_WAVE.name) await rememberStation($, station)
  await ipc($, S.env!, [['playlist-clear']])
  void generate($, 'start')
  return `Station "${station.name}" is on; first tracks in a few seconds.`
}

async function act($: $, a: Action): Promise<string> {
  if (a.do === 'help') return HELP
  if (a.do === 'panel') {
    const opened = await $.ui.open({ id: PANE, title: '♪ musicflow' })
    return opened.isPlaced ? 'musicflow panel opened.' : 'musicflow panel will show when the terminal is wider.'
  }
  if (a.do === 'now') {
    const p = (await poll($)) ?? (await read($, player))
    const lib = await read($, library)
    if (!p.isRunning || !p.current) return `Nothing is playing (${sourceText(lib.source)}).`
    return `${p.isPaused ? 'Paused' : 'Playing'}: ${name(p.current)} ${clock(p.pos)}/${clock(p.dur)} · ${sourceText(lib.source)} · mood: ${lib.mood.label}${p.upcoming.length ? `\nNext: ${p.upcoming.slice(0, 3).map(name).join(' | ')}` : ''}`
  }
  if (a.do === 'mood') {
    const mood = a.text.toLowerCase() === 'auto' ? { ...DEFAULT_MOOD } : manualMood(a.text)
    await $.store.set('mood', mood)
    if (mood.mode === 'auto') await refreshAutoMood($)
    await refreshLibrary($)
    const now = await getMood($)
    return `Mood: ${now.label}${now.mode === 'auto' ? ' (auto)' : ''}. Next picks will follow it.`
  }
  if (a.do === 'layout') {
    await $.store.set('layout', a.where)
    await refreshLibrary($)
    return a.where === 'below'
      ? 'Now playing shows under the prompt. Controls: /music, the panel (/music), or ask Claude.'
      : 'Now playing shows above the prompt, with buttons (ctrl+x tab, then p/n/l/d/m).'
  }
  if (a.do === 'playlist-save') {
    const p = await read($, player)
    const tracks = [...(p.current ? [p.current] : []), ...p.upcoming]
    if (!tracks.length) return 'Nothing in the queue to save.'
    const lists = (await getPlaylists($)).filter(l => l.name.toLowerCase() !== a.name.toLowerCase())
    await $.store.set('playlists', [{ name: a.name, tracks }, ...lists])
    await refreshLibrary($)
    return `Saved ${tracks.length} tracks as "${a.name}".`
  }

  // Everything below needs the player.
  if (a.do === 'stop') {
    if (S.env) await ipc($, S.env, [['quit']])
    await setSource($, { kind: 'none' })
    await poll($)
    return 'Music stopped.'
  }
  const failed = await start($)
  if (failed) return failed
  const e = S.env!

  switch (a.do) {
    case 'pause':
      await ipc($, e, [['set_property', 'pause', true]])
      await poll($)
      return 'Paused.'
    case 'resume':
      await ipc($, e, [['set_property', 'pause', false]])
      await poll($)
      return 'Playing.'
    case 'toggle':
      await ipc($, e, [['cycle', 'pause']])
      await poll($)
      return 'Toggled.'
    case 'volume':
      await ipc($, e, [['set_property', 'volume', a.value]])
      await poll($)
      return `Volume ${a.value}.`
    case 'next': {
      const p = await read($, player)
      await ipc($, e, [['playlist-next', 'force']])
      if (p.upcoming.length < LOW_WATER) void generate($)
      await poll($)
      return p.upcoming.length ? `Next: ${name(p.upcoming[0]!)}` : 'Queue was empty; picking more.'
    }
    case 'like':
    case 'dislike': {
      const p = await read($, player)
      if (!p.current) return 'Nothing is playing.'
      const taste = await getTaste($)
      await setTaste($, a.do === 'like' ? like(taste, p.current) : dislike(taste, p.current))
      await refreshLibrary($)
      if (a.do === 'dislike') {
        await ipc($, e, [['playlist-next', 'force']])
        if (p.upcoming.length < LOW_WATER) void generate($)
        await poll($)
        return `Won't play "${p.current.title}" again.`
      }
      return `Liked "${p.current.title}".`
    }
    case 'playlist-play': {
      const lib = await read($, library)
      await refreshLibrary($)
      const list = (await read($, library)).playlists.find(l => l.name.toLowerCase() === a.name.toLowerCase())
      if (!list || !list.tracks.length) return `No playlist "${a.name}". Have: ${lib.playlists.map(l => l.name).join(', ') || 'none'}.`
      await setSource($, { kind: 'playlist', name: list.name })
      await queue($, list.tracks, 'replace')
      await poll($)
      return `Playing "${list.name}" (${list.tracks.length} tracks).`
    }
    case 'station':
      return startStation($, { name: stationName(a.prompt), prompt: a.prompt })
    case 'play': {
      if (!a.query) {
        const p = await read($, player)
        if (p.current && p.isPaused) {
          await ipc($, e, [['set_property', 'pause', false]])
          return 'Playing.'
        }
        if (p.current) return `Playing: ${name(p.current)}`
        const source = await getSource($)
        if (source.kind === 'station') return startStation($, source.station)
        return startStation($, MY_WAVE)
      }
      await setActivity($, `searching: ${a.query}…`)
      const taste = await getTaste($)
      const hits = await search($, e, a.query, 5)
      await setActivity($, null)
      const c = pick(hits, { blocked: new Set(taste.dislikes.map(t => t.id)), allowLong: true }) ?? hits[0]
      if (!c) return `Found nothing for "${a.query}".`
      const station: Station = {
        name: stationName(`like ${a.query}`),
        prompt: `Music in the spirit of "${a.query}": the same artist, related artists, era and sound.`,
      }
      await setSource($, { kind: 'station', station })
      await queue($, [toTrack(c, { why: 'you asked', station: station.name })], 'replace')
      await poll($)
      void generate($)
      return `Playing: ${c.title}${c.channel ? ` — ${c.channel}` : ''}. Similar music follows.`
    }
  }
  return HELP
}

/** Runs an action from a press: never throws, says the outcome in a toast. */
function press($: $, a: Action) {
  void act($, a)
    .then(text => {
      if (a.do !== 'toggle' && a.do !== 'pause' && a.do !== 'resume' && a.do !== 'panel') $.ui.toast(text)
    })
    .catch(err => $.ui.toast(`musicflow: ${String(err)}`))
}


export const register: Register = on => {
  // ------------------------------------------------------------ events

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    S.env = await resolveEnv($)
    S.me = await $.session.id()
    await $.command.register({
      name: 'music',
      description: 'musicflow: YouTube music picked by Claude for your mood (panel, play, station, mood…)',
      argumentHint: '[play <query> | station <description> | next | like | mood <text|auto> | help]',
    })
    await $.tool.register({
      name: 'Music',
      description:
        'Controls the background music player (YouTube via mpv). Use when the user asks to play, stop, skip, like music, ' +
        'start a station ("play something like Boards of Canada"), or change the mood. ' +
        'Actions: play (value: search query; empty resumes or starts "My wave"), station (value: description), ' +
        'pause, resume, next, like, dislike, mood (value: text or "auto"), volume (value: 0-100), ' +
        'playlist (value: "save <name>" or "play <name>"), stop, now (what is playing), panel.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['play', 'station', 'pause', 'resume', 'next', 'like', 'dislike', 'mood', 'volume', 'playlist', 'stop', 'now', 'panel'],
          },
          value: { type: 'string', description: 'The argument of the action, when it takes one.' },
        },
        required: ['action'],
      },
      isDeferred: false,
    })
    await loadMeta($)
    await heartbeat($)
    await refreshLibrary($)
    await poll($)

    $.clock.every(1000, () => {
      S.tick++
      void (async () => {
        const held = await read($, player)
        // While nothing runs, look every 5 s instead of every second.
        if (!held.isRunning && S.tick % 5 !== 0) return
        const p = await poll($)
        if (S.tick % 5 === 0) {
          await heartbeat($)
          await refreshLibrary($)
          await loadMeta($)
        }
        if (S.tick % 600 === 0) await refreshAutoMood($)
        if (!p || !p.isRunning || !S.isLeader || S.isGenerating) return
        const source = await getSource($)
        const now = await $.clock.now()
        if (source.kind === 'station' && p.upcoming.length < LOW_WATER && now - S.lastFailAt > RETRY_MS) await generate($)
      })().catch(() => undefined)
    })
    return started
  })

  on('session.end', async ($, e, next) => {
    // The last session to leave turns the music off.
    if (S.env && e.reason !== 'clear' && !(await othersAlive($))) {
      await ipc($, S.env, [['quit']]).catch(() => undefined)
    }
    return next(e)
  })

  // Session signals for the auto mood.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const tool = String(e.tool)
    const at = await $.clock.now()
    if (tool === 'Bash') signals.push({ at, kind: ran.isError ? 'bash-fail' : 'bash-ok' })
    else if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') signals.push({ at, kind: 'edit' })
    if (signals.length > 500) signals.splice(0, signals.length - 500)
    return ran
  })

  on('command.run', { command: 'music' }, async ($, e) => {
    const a = parseCommand(e.args)
    if ('error' in a) return { text: a.error }
    return { text: await act($, a) }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const a = parseToolInput(e as unknown as ToolInput)
    if ('error' in a) return { result: `Error: ${a.error}` }
    return { result: await act($, a) }
  })

  // ------------------------------------------------------------ drawing

  // Under the prompt: one dim line after the engine's own hint, which stays live.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const lib = await read($, library)
    if (lib.layout !== 'below') return next(e)
    const p = await read($, player)
    const busy = await read($, activity)
    if (!p.current && !busy) return next(e)
    const line = p.current
      ? `♪ ${p.isPaused ? '⏸ ' : ''}${name(p.current)}  ${clock(p.pos)} ${bar(p.pos, p.dur, 8)} ${clock(p.dur)}`
      : `♪ ${busy}`
    const tail = e.props.tail ? `${e.props.tail} · ${line}` : `  ·  ${line}`
    return next({ ...e, props: { ...e.props, tail } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, player)
    const busy = await read($, activity)
    const lib = await read($, library)
    if (lib.layout !== 'above' || e.props.hasSurvey || (!p.current && !busy)) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const isLiked = p.current ? lib.likedIds.includes(p.current.id) : false

    return (
      <Box flexDirection="row" gap={1}>
        <Text color="magenta">♪</Text>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">{p.current ? name(p.current) : busy}</Text>
        </Box>
        {p.current && (
          <Text dimColor>
            {clock(p.pos)} {bar(p.pos, p.dur, 10)} {clock(p.dur)}
          </Text>
        )}
        {p.current && (
          <Button key="toggle" plain hotkey="p" label={p.isPaused ? '▶' : '⏸'} onPress={() => press($, { do: 'toggle' })} />
        )}
        <Button key="next" plain hotkey="n" label="⏭" onPress={() => press($, { do: 'next' })} />
        {p.current && (
          <Button key="like" plain hotkey="l" label={isLiked ? '♥' : '♡'} onPress={() => press($, { do: 'like' })} />
        )}
        {p.current && <Button key="dislike" plain hotkey="d" label="✕" onPress={() => press($, { do: 'dislike' })} />}
        <Button key="panel" plain hotkey="m" label="≡" onPress={() => press($, { do: 'panel' })} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    // Mobile draws no fields or pickers: buttons stand in where it matters.
    const Input = 'Input' in els ? els.Input : null
    const Select = 'Select' in els ? els.Select : null
    const p = await read($, player)
    const lib = await read($, library)
    const busy = await read($, activity)
    const width = Math.max(10, Math.min(40, (e.props.bodyColumns ?? 40) - 14))
    const isLiked = p.current ? lib.likedIds.includes(p.current.id) : false
    const moodValue = lib.mood.mode === 'auto' ? 'auto' : PRESETS[lib.mood.label] ? lib.mood.label : 'custom'

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {p.current ? (
            <>
              <Text bold wrap="truncate-end">{p.current.title}</Text>
              <Text dimColor wrap="truncate-end">{p.current.channel || ' '}</Text>
              <Text>
                {clock(p.pos)} {bar(p.pos, p.dur, width)} {clock(p.dur)}
              </Text>
              {p.current.why && <Text dimColor italic wrap="truncate-end">{p.current.why}</Text>}
            </>
          ) : (
            <Text dimColor>{p.isRunning ? 'Nothing playing.' : 'Player is off.'}</Text>
          )}
          {busy && <Text color="magenta">{busy}</Text>}
        </Box>

        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="p-play" variant="primary" label={p.current && !p.isPaused ? 'Pause' : 'Play'} onPress={() => press($, p.current ? { do: 'toggle' } : { do: 'play', query: '' })} />
          <Button key="p-next" label="Next" onPress={() => press($, { do: 'next' })} />
          <Button key="p-like" label={isLiked ? '♥ Liked' : '♡ Like'} onPress={() => press($, { do: 'like' })} />
          <Button key="p-dislike" label="✕ Dislike" onPress={() => press($, { do: 'dislike' })} />
          <Button key="p-voldown" label="−" onPress={() => press($, { do: 'volume', value: Math.max(0, p.volume - 10) })} />
          <Text dimColor>{p.isRunning ? `vol ${p.volume}` : ''}</Text>
          <Button key="p-volup" label="+" onPress={() => press($, { do: 'volume', value: Math.min(130, p.volume + 10) })} />
          <Button key="p-stop" dimColor label="Stop" onPress={() => press($, { do: 'stop' })} />
          <Button
            key="p-layout"
            dimColor
            label={lib.layout === 'below' ? 'Band above ↑' : 'Line below ↓'}
            onPress={() => press($, { do: 'layout', where: lib.layout === 'below' ? 'above' : 'below' })}
          />
        </Box>

        {Input && (
          <Input
            key="play-query"
            label="♪ "
            placeholder="play: artist, track or vibe — e.g. Moby, Tycho Awake, rainy synthwave"
            submitLabel="play"
            onSubmit={(v: string) => v.trim() && press($, { do: 'play', query: v.trim() })}
          />
        )}

        <Box flexDirection="column">
          <Text bold>Now feeding</Text>
          <Text dimColor wrap="truncate-end">
            {lib.source.kind === 'station' ? `${lib.source.station.name}: ${lib.source.station.prompt}` : sourceText(lib.source)}
          </Text>
        </Box>

        <Box flexDirection="column">
          <Text bold>Mood {lib.mood.mode === 'auto' ? `· auto: ${lib.mood.label}` : ''}</Text>
          {Select ? (
            <Select
              key="mood"
              options={[
                { value: 'auto', label: 'auto (follow the session)' },
                ...Object.keys(PRESETS).map(k => ({ value: k, label: k })),
                ...(moodValue === 'custom' ? [{ value: 'custom', label: lib.mood.label }] : []),
              ]}
              value={moodValue}
              onSelect={(v: string) => v !== 'custom' && press($, { do: 'mood', text: v })}
            />
          ) : (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {['auto', ...Object.keys(PRESETS)].map(k => (
                <Button key={`mood-${k}`} dimColor={k !== moodValue} label={k} onPress={() => press($, { do: 'mood', text: k })} />
              ))}
            </Box>
          )}
          {Input && <Input key="mood-text" placeholder="or say it: rainy evening, no vocals" onSubmit={(v: string) => v.trim() && press($, { do: 'mood', text: v })} />}
        </Box>

        <Box flexDirection="column">
          <Text bold>Up next</Text>
          {p.upcoming.length === 0 && <Text dimColor>empty</Text>}
          {p.upcoming.slice(0, 6).map((t, i) => (
            <Text wrap="truncate-end">
              {i + 1}. {name(t)}
              {t.why ? <Text dimColor> · {t.why}</Text> : ''}
            </Text>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold>Stations</Text>
          {Input && <Input key="station-new" placeholder="new station: like Boards of Canada, but upbeat" submitLabel="tune in" onSubmit={(v: string) => v.trim() && press($, { do: 'station', prompt: v.trim() })} />}
          <Button key="st-mywave" dimColor label="▶ My wave" onPress={() => press($, { do: 'play', query: '' })} />
          {lib.stations.slice(0, 8).map((s, i) => (
            <Button key={`st-${i}`} dimColor label={`▶ ${s.name}`} onPress={() => press($, { do: 'station', prompt: s.prompt })} />
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold>Playlists</Text>
          {lib.playlists.length === 0 && <Text dimColor>Like tracks (♥) and they gather in "Liked".</Text>}
          {lib.playlists.slice(0, 8).map((l, i) => (
            <Button key={`pl-${i}`} dimColor label={`▶ ${l.name} (${l.tracks.length})`} onPress={() => press($, { do: 'playlist-play', name: l.name })} />
          ))}
          {Input && <Input key="pl-save" placeholder="save the queue as…" submitLabel="save" onSubmit={(v: string) => v.trim() && press($, { do: 'playlist-save', name: v.trim() })} />}
        </Box>
      </Box>
    )
  })
}
