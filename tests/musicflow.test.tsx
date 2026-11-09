import { describe, expect, test } from 'claude-code/testing'

import type { Player } from '../types'
import { parseCommand, parseToolInput } from '../hooks/commands'
import { type Probe, checks, isClean, isReady, jsRuntime, plan, report, ytdlpAgeDays } from '../hooks/doctor'
import { mpvArgs } from '../hooks/mpv'
import { autoLabel, manualMood, mergeSignals, parseSignals } from '../hooks/mood'
import { buildPrompt, parsePicks, parseSoundtrack, sessionDigest, stationName } from '../hooks/recommend'
import { isGood, parseHits, pick, videoId } from '../hooks/search'
import { EMPTY_TASTE, blockedIds, describeTaste, dislike, like, recordPlay } from '../hooks/taste'

const T = (id: string, title = `Song ${id}`) => ({ id, title, channel: 'Artist', duration: 200 })

describe('commands', () => {
  test('parses /music arguments', () => {
    expect(parseCommand('')).toEqual({ do: 'panel' })
    expect(parseCommand('play daft punk')).toEqual({ do: 'play', query: 'daft punk' })
    expect(parseCommand('play')).toEqual({ do: 'play', query: '' })
    expect(parseCommand('station like BoC but upbeat')).toEqual({ do: 'station', prompt: 'like BoC but upbeat' })
    expect(parseCommand('skip')).toEqual({ do: 'next' })
    expect(parseCommand('vol 40')).toEqual({ do: 'volume', value: 40 })
    expect('error' in parseCommand('vol loud')).toBe(true)
    expect(parseCommand('mood rainy evening')).toEqual({ do: 'mood', text: 'rainy evening' })
    expect(parseCommand('playlist save Night drive')).toEqual({ do: 'playlist-save', name: 'Night drive' })
    expect(parseCommand('aphex twin')).toEqual({ do: 'play', query: 'aphex twin' })
    expect(parseCommand('layout above')).toEqual({ do: 'layout', where: 'above' })
    expect('error' in parseCommand('layout left')).toBe(true)
  })

  test('parses the tool input', () => {
    expect(parseToolInput({ action: 'station', value: 'lofi' })).toEqual({ do: 'station', prompt: 'lofi' })
    expect(parseToolInput({ action: 'next' })).toEqual({ do: 'next' })
    expect('error' in parseToolInput({})).toBe(true)
  })
})

const BASE: Probe = {
  os: 'macos',
  arch: 'arm64',
  home: '/Users/me',
  mpv: { path: '/opt/homebrew/bin/mpv', version: '0.41.0' },
  ytdlp: { path: '/opt/homebrew/bin/yt-dlp', version: '2026.10.26' },
  deno: { path: '/opt/homebrew/bin/deno', version: '2.9.8' },
  node: null,
  ipc: 'nc',
  managers: { brew: true },
  today: '2026-11-09',
}

describe('setup doctor', () => {
  test('a complete machine is all set', () => {
    const cs = checks(BASE)
    expect(cs.every(c => c.level === 'ok')).toBe(true)
    expect(plan(BASE)).toEqual([])
    expect(report(BASE, cs, [])).toContain('All set')
  })

  test('yt-dlp age comes from its date version', () => {
    expect(ytdlpAgeDays('2026.10.26', '2026-11-09')).toBe(14)
    expect(ytdlpAgeDays('2026.02.04', '2026-11-09')).toBe(278)
    expect(ytdlpAgeDays('nightly', '2026-11-09')).toBe(null)
  })

  test('the JS runtime: deno first, node 20+ next, else none', () => {
    expect(jsRuntime(BASE)).toBe('deno:/opt/homebrew/bin/deno')
    expect(jsRuntime({ deno: null, node: { path: '/usr/bin/node', version: 'v22.3.0' } })).toBe('node:/usr/bin/node')
    expect(jsRuntime({ deno: null, node: { path: '/usr/bin/node', version: 'v18.19.0' } })).toBe(null)
  })

  test('macOS with brew: one brew install, and an upgrade for an old yt-dlp', () => {
    const p: Probe = { ...BASE, mpv: null, deno: null, ytdlp: { path: '/opt/homebrew/bin/yt-dlp', version: '2026.02.04' } }
    const steps = plan(p)
    expect(steps.map(s => s.argv?.join(' '))).toEqual(['brew install mpv deno', 'brew upgrade yt-dlp'])
    expect(isReady(checks(p))).toBe(false)
  })

  test('Linux: sudo steps are pasted, yt-dlp and deno install without sudo', () => {
    const p: Probe = { ...BASE, os: 'linux', arch: 'x64', mpv: null, ytdlp: null, deno: null, ipc: null, managers: { apt: true } }
    const steps = plan(p)
    expect(steps[0]?.paste).toBe('sudo apt-get install -y mpv netcat-openbsd unzip mpv-mpris')
    expect(steps[1]?.argv?.[2]).toContain('releases/latest/download/yt-dlp_linux')
    expect(steps[2]?.argv?.[2]).toContain('deno.land/install.sh')
    const arm = plan({ ...p, arch: 'arm64' })
    expect(arm[1]?.argv?.[2]).toContain('yt-dlp_linux_aarch64')
  })

  test('Linux media keys are optional: they never block, and they never alone show the setup block', () => {
    const p: Probe = { ...BASE, os: 'linux', arch: 'x64', managers: { pacman: true }, mediaKeys: false }
    const cs = checks(p)
    expect(cs.find(c => c.key === 'keys')?.level).toBe('warn')
    expect(isReady(cs)).toBe(true)
    expect(isClean(cs)).toBe(true)
    expect(plan(p)[0]?.paste).toBe('sudo pacman -S --needed --noconfirm mpv-mpris')
    expect(checks({ ...p, mediaKeys: true }).find(c => c.key === 'keys')?.level).toBe('ok')
    expect(checks(BASE).some(c => c.key === 'keys')).toBe(false)
  })

  test('/music prev parses', () => {
    expect(parseCommand('prev')).toEqual({ do: 'prev' })
    expect(parseCommand('back')).toEqual({ do: 'prev' })
    expect(parseToolInput({ action: 'prev' })).toEqual({ do: 'prev' })
  })

  test('Windows: winget ids', () => {
    const p: Probe = { ...BASE, os: 'windows', arch: 'x64', mpv: null, ytdlp: null, deno: null, ipc: 'powershell', managers: { winget: true } }
    expect(plan(p).map(s => s.argv?.[3])).toEqual(['shinchiro.mpv', 'yt-dlp.yt-dlp', 'DenoLand.Deno'])
    const none = plan({ ...p, managers: {} })
    expect(none[0]?.manual).toContain('winget')
  })

  test('mpv is told which JS runtime yt-dlp should use', () => {
    const args = mpvArgs({ sock: '/s', ytdlp: '/y', js: 'deno:/d' })
    expect(args).toContain('--ytdl-raw-options-append=js-runtimes=deno:/d')
    expect(args).toContain('--input-ipc-server=/s')
    expect(mpvArgs({ sock: '/s', ytdlp: '/y', js: null }).some(a => a.includes('js-runtimes'))).toBe(false)
  })

  test('/music setup parses', () => {
    expect(parseCommand('setup')).toEqual({ do: 'setup', install: false })
    expect(parseCommand('setup install')).toEqual({ do: 'setup', install: true })
    expect(parseCommand('doctor')).toEqual({ do: 'setup', install: false })
  })
})

describe('search', () => {
  test('parses yt-dlp lines and skips junk', () => {
    const hits = parseHits('SM4tQcUt_mQ\tRoygbiv\t150.0\tBoards of Canada\nbad line\nyT0gRc2c2wQ\tx\tNA\tNA\n')
    expect(hits).toEqual([
      { id: 'SM4tQcUt_mQ', title: 'Roygbiv', channel: 'Boards of Canada', duration: 150 },
      { id: 'yT0gRc2c2wQ', title: 'x', channel: '', duration: 0 },
    ])
  })

  test('filters by block list, junk and length', () => {
    const rules = { blocked: new Set(['aaaaaaaaaaa']) }
    expect(isGood({ id: 'aaaaaaaaaaa', title: 'ok', channel: '', duration: 200 }, rules)).toBe(false)
    expect(isGood({ id: 'bbbbbbbbbbb', title: 'Song (Reaction)', channel: '', duration: 200 }, rules)).toBe(false)
    expect(isGood({ id: 'bbbbbbbbbbb', title: 'Mix', channel: '', duration: 3600 }, rules)).toBe(false)
    expect(isGood({ id: 'bbbbbbbbbbb', title: 'Mix', channel: '', duration: 3600 }, { ...rules, allowLong: true })).toBe(true)
    expect(isGood({ id: 'bbbbbbbbbbb', title: 'Intro', channel: '', duration: 30 }, rules)).toBe(false)
    expect(isGood({ id: 'bbbbbbbbbbb', title: 'Unknown length', channel: '', duration: 0 }, rules)).toBe(false)
    expect(isGood({ id: 'bbbbbbbbbbb', title: 'Splinter Cell – All Cutscenes (Game Film)', channel: '', duration: 300 }, rules)).toBe(false)
    expect(pick([{ id: 'aaaaaaaaaaa', title: 'a', channel: '', duration: 200 }, { id: 'ccccccccccc', title: 'c', channel: '', duration: 200 }], rules)?.id).toBe('ccccccccccc')
  })

  test('reads video ids from urls', () => {
    expect(videoId('https://www.youtube.com/watch?v=SM4tQcUt_mQ')).toBe('SM4tQcUt_mQ')
    expect(videoId('https://youtu.be/SM4tQcUt_mQ')).toBe('SM4tQcUt_mQ')
    expect(videoId('/tmp/song.mp3')).toBe(undefined)
  })
})

describe('recommend', () => {
  test('reads picks out of a fenced reply and drops duplicates', () => {
    const reply = '```json\n{"picks":[{"query":"Tycho - Awake","why":"warm synths"},{"query":"tycho - awake","why":"dup"},{"query":"","why":"x"}]}\n```'
    expect(parsePicks(reply)).toEqual([{ query: 'Tycho - Awake', why: 'warm synths' }])
    expect(parsePicks('no json here')).toEqual([])
  })

  test('the prompt carries station, mood and taste', () => {
    const prompt = buildPrompt({
      station: { name: 'Night', prompt: 'dark ambient' },
      mood: manualMood('calm debugging'),
      taste: 'Liked: x',
      count: 8,
    })
    expect(prompt).toContain('dark ambient')
    expect(prompt).toContain('calm debugging')
    expect(prompt).toContain('Give 8 picks.')
  })

  test('the session digest keeps the work and drops the music tool', () => {
    const digest = sessionDigest(
      [
        { role: 'user', text: 'fix the flaky auth test' },
        {
          role: 'assistant',
          text: 'Looking at it.',
          toolUses: [
            { tool: 'Bash', input: { command: 'npm test -- auth' } },
            { tool: 'Edit', input: { file_path: 'src/auth/session.ts' } },
            { tool: 'mcp__musicflow__Music', input: { action: 'now' } },
          ],
        },
      ],
      { project: 'app', hour: 2, fails: 3, edits: 1 },
    )
    expect(digest).toContain('DEV: fix the flaky auth test')
    expect(digest).toContain('[Bash: npm test -- auth]')
    expect(digest).toContain('[Edit: src/auth/session.ts]')
    expect(digest).toContain('Local hour: 2:00')
    expect(digest).not.toContain('musicflow')
  })

  test('a soundtrack reply is read, fences and all', () => {
    const r = parseSoundtrack('```json\n{"scene":"ночной дебаг авторизации","name":"Night Shift","prompt":"tense dark synthwave, slow build, no vocals — Perturbator, Carpenter Brut"}\n```')
    expect(r).toEqual({ scene: 'ночной дебаг авторизации', name: 'Night Shift', prompt: 'tense dark synthwave, slow build, no vocals — Perturbator, Carpenter Brut' })
    expect(parseSoundtrack('{"name":"x"}')).toBe(null)
    expect(parseCommand('soundtrack')).toEqual({ do: 'soundtrack' })
    expect(parseToolInput({ action: 'soundtrack' })).toEqual({ do: 'soundtrack' })
  })

  test('station names are short', () => {
    expect(stationName('lofi')).toBe('lofi')
    expect(stationName('a'.repeat(50)).length).toBe(32)
  })
})

describe('taste', () => {
  test('like and dislike move a track between lists', () => {
    let t = like(EMPTY_TASTE, T('aaaaaaaaaaa'))
    expect(t.likes.map(x => x.id)).toEqual(['aaaaaaaaaaa'])
    t = dislike(t, T('aaaaaaaaaaa'))
    expect(t.likes).toEqual([])
    expect(t.dislikes.map(x => x.id)).toEqual(['aaaaaaaaaaa'])
  })

  test('plays are blocked from requeue and described', () => {
    const t = recordPlay(recordPlay(EMPTY_TASTE, T('aaaaaaaaaaa'), 0.1, 1), T('bbbbbbbbbbb'), 0.95, 2)
    expect(blockedIds(t).has('aaaaaaaaaaa')).toBe(true)
    const text = describeTaste(t)
    expect(text).toContain('[skipped]')
    expect(text).toContain('[finished]')
  })
})

describe('mood', () => {
  const now = 1_000_000_000
  test('follows the session', () => {
    expect(autoLabel([], now, 2)).toBe('late night')
    const fails = Array.from({ length: 4 }, () => ({ at: now, kind: 'bash-fail' as const }))
    expect(autoLabel(fails, now, 15)).toBe('calm debugging')
    const edits = Array.from({ length: 16 }, () => ({ at: now, kind: 'edit' as const }))
    expect(autoLabel(edits, now, 15)).toBe('upbeat flow')
    expect(autoLabel(edits.slice(0, 6), now, 15)).toBe('deep focus')
    expect(autoLabel([], now, 8)).toBe('morning warmup')
    expect(autoLabel([], now, 15)).toBe('focused work')
    // Old signals fall out of the window.
    expect(autoLabel(edits.map(s => ({ ...s, at: 0 })), now, 15)).toBe('focused work')
  })

  test('signals from every session add up; junk and old ones drop out', () => {
    const a = parseSignals(JSON.stringify([{ at: now, kind: 'edit' }, { at: now, kind: 'nope' }, { x: 1 }]))
    expect(a).toEqual([{ at: now, kind: 'edit' }])
    expect(parseSignals('not json')).toEqual([])
    const busy = Array.from({ length: 4 }, () => ({ at: now, kind: 'edit' as const }))
    const other = Array.from({ length: 3 }, () => ({ at: now, kind: 'edit' as const }))
    const merged = mergeSignals([busy, other, [{ at: 0, kind: 'edit' }]], now)
    expect(merged.length).toBe(7)
    // Neither session alone reaches 5 edits; together they do.
    expect(autoLabel(busy, now, 15)).toBe('focused work')
    expect(autoLabel(merged, now, 15)).toBe('deep focus')
  })

  test('a preset name keeps its description', () => {
    expect(manualMood('late night').hint).toContain('quiet')
    expect(manualMood('rainy evening').hint).toBe('rainy evening')
  })
})

const PLAYING: Player = {
  isRunning: true,
  isPaused: false,
  isIdle: false,
  current: { id: 'SM4tQcUt_mQ', title: 'Roygbiv', channel: 'Boards of Canada', duration: 150, why: 'warm and hazy' },
  pos: 30,
  dur: 150,
  volume: 70,
  upcoming: [{ id: 'yT0gRc2c2wQ', title: 'Awake', channel: 'Tycho', duration: 280, why: 'same haze' }],
}

const BAND = {
  plugin: 'musicflow',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const PANE = {
  plugin: 'musicflow',
  component: 'Pane',
  requestId: 'musicflow',
  props: { title: '♪ musicflow', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const LIBRARY = (layout: 'below' | 'above') => ({
  source: { kind: 'none' },
  stations: [],
  playlists: [],
  mood: { mode: 'auto', label: 'focused work', hint: '' },
  likedIds: [],
  layout,
})

const seed = (layout: 'below' | 'above') => (_: unknown, e: unknown) => {
  const key = (e as { key?: string }).key
  if (key === 'player') return { value: { value: PLAYING, version: 1 } }
  if (key === 'library') return { value: { value: LIBRARY(layout), version: 1 } }
  return { value: { value: undefined, version: 0 } }
}

const HINT = {
  plugin: 'musicflow',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

describe('drawing', () => {
  test('under the prompt by default: a line after the hint', async ($, on) => {
    on('state.get', seed('below'))
    let tail: string | undefined
    on('ui.render', ($, e) => {
      tail = (e.props as { tail?: string }).tail
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
    expect(tail?.startsWith('♪ Roygbiv — Boards of Canada')).toBe(true)
    expect(tail).toContain('0:30')
    await ui.unmount()
  })

  test('the band shows the track and controls when placed above', async ($, on) => {
    on('state.get', seed('above'))
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect((await ui.find({ type: 'Text', text: /Roygbiv/ }))?.text).toBe('Roygbiv — Boards of Canada')
      expect(await ui.find({ key: 'next' })).toBeDefined()
      expect(await ui.find({ key: 'like' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the band stays out of the way when nothing plays', async ($, on) => {
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    await ui.unmount()
  })

  test('the panel lists what is next, on every surface', async ($, on) => {
    on('state.get', seed('below'))
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: /Awake/ })).toBeDefined()
      expect(await ui.find({ key: 'p-next' })).toBeDefined()
      if (surface !== 'mobile') expect(await ui.find({ key: 'play-query' })).toBeDefined()
      await ui.unmount()
    }
  })
})
