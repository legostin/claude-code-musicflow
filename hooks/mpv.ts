import type { EngineInterface } from 'claude-code'

import type { Player, Track } from '../types'
import { type Candidate, PRINT, parseHits, videoId } from './search'

type $ = EngineInterface

/** Where the binaries and the socket are, resolved once per load. */
export type Env = {
  home: string
  dir: string
  sock: string
  mpv: string | null
  ytdlp: string | null
}

const BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']

async function findBin($: $, name: string): Promise<string | null> {
  for (const dir of BIN_DIRS) {
    if (await $.fs.exists(`${dir}/${name}`)) return `${dir}/${name}`
  }
  const r = await $.process.run(['/bin/sh', '-lc', `command -v ${name}`]).catch(() => null)
  const path = r?.exitCode === 0 ? r.stdout.trim().split('\n')[0] : ''
  return path ? path : null
}

export async function resolveEnv($: $): Promise<Env> {
  const home = (await $.env.get('HOME')) ?? '/tmp'
  // Kept short: a Unix socket path on macOS holds at most 104 bytes.
  const dir = `${home}/.claude/musicflow`
  await $.process.run(['mkdir', '-p', dir]).catch(() => undefined)
  const [mpv, ytdlp] = await Promise.all([findBin($, 'mpv'), findBin($, 'yt-dlp')])
  return { home, dir, sock: `${dir}/mpv.sock`, mpv, ytdlp }
}

/**
 * Sends commands over mpv's JSON IPC in one `nc -U` call: mpv answers each
 * line and closes the connection at our end of input. Resolves the replies in
 * order (undefined for a failed one), or null when nothing listens.
 */
export async function ipc($: $, env: Env, commands: readonly unknown[][]): Promise<(unknown | undefined)[] | null> {
  const input = commands.map((command, i) => JSON.stringify({ command, request_id: i + 1 })).join('\n') + '\n'
  const r = await $.process.run(['nc', '-U', env.sock], { stdin: input, timeoutMs: 4000 }).catch(() => null)
  if (!r || r.exitCode !== 0 || r.stdout.trim() === '') return null
  const out: (unknown | undefined)[] = commands.map(() => undefined)
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line) as { request_id?: number; error?: string; data?: unknown }
      if (typeof msg.request_id === 'number' && msg.request_id >= 1 && msg.request_id <= commands.length) {
        out[msg.request_id - 1] = msg.error === 'success' ? (msg.data ?? null) : undefined
      }
    } catch {
      // an event line cut short: ignore
    }
  }
  return out
}

export async function isAlive($: $, env: Env): Promise<boolean> {
  const r = await ipc($, env, [['get_property', 'idle-active']])
  return r !== null && r[0] !== undefined
}

/** Starts the shared mpv daemon if none answers. Resolves whether one runs. */
export async function ensure($: $, env: Env): Promise<boolean> {
  if (await isAlive($, env)) return true
  if (!env.mpv || !env.ytdlp) return false
  await $.process.run(['rm', '-f', env.sock]).catch(() => undefined)
  const script =
    'nohup "$0" --idle=yes --no-video --no-terminal --force-window=no --keep-open=no ' +
    '--prefetch-playlist=yes --input-ipc-server="$1" --ytdl-format=bestaudio/best --script-opts=ytdl_hook-ytdl_path="$2" ' +
    '--volume=70 >/dev/null 2>&1 &'
  await $.process.run(['/bin/sh', '-c', script, env.mpv, env.sock, env.ytdlp])
  for (let i = 0; i < 30; i++) {
    await $.clock.sleep(100)
    if (await isAlive($, env)) return true
  }
  return false
}

type Entry = { filename?: string; title?: string; current?: boolean }

/** Polls the player; meta maps a video id to what the mod knows of it. */
export async function snapshot($: $, env: Env, meta: (id: string) => Track | undefined): Promise<Player> {
  const r = await ipc($, env, [
    ['get_property', 'idle-active'],
    ['get_property', 'pause'],
    ['get_property', 'path'],
    ['get_property', 'media-title'],
    ['get_property', 'time-pos'],
    ['get_property', 'duration'],
    ['get_property', 'volume'],
    ['get_property', 'playlist'],
  ])
  if (!r) return { isRunning: false, isPaused: false, isIdle: true, pos: 0, dur: 0, volume: 0, upcoming: [] }
  const [idle, pause, path, mediaTitle, pos, dur, volume, playlist] = r
  const list = (Array.isArray(playlist) ? playlist : []) as Entry[]
  const at = list.findIndex(e => e.current)
  const toTrack = (filename: string | undefined, title: string | undefined): Track | undefined => {
    const id = videoId(filename)
    if (!id) return filename ? { id: filename, title: title ?? filename, channel: '', duration: 0 } : undefined
    const known = meta(id)
    return known ?? { id, title: title ?? id, channel: '', duration: 0 }
  }
  const current = idle === true ? undefined : toTrack(path as string | undefined, mediaTitle as string | undefined)
  const upcoming = list
    .slice(at + 1)
    .map(e => toTrack(e.filename, e.title))
    .filter((t): t is Track => t !== undefined)
  return {
    isRunning: true,
    isPaused: pause === true,
    isIdle: idle === true,
    current,
    pos: typeof pos === 'number' ? pos : 0,
    dur: typeof dur === 'number' ? dur : current?.duration ?? 0,
    volume: typeof volume === 'number' ? Math.round(volume) : 0,
    upcoming,
  }
}

/** One yt-dlp search: the first `n` hits for `query`. */
export async function search($: $, env: Env, query: string, n = 3): Promise<Candidate[]> {
  if (!env.ytdlp) return []
  const r = await $.process
    .run(
      [env.ytdlp, '--no-update', '--no-warnings', '--flat-playlist', '--print', PRINT, `ytsearch${n}:${query}`],
      { timeoutMs: 60_000 },
    )
    .catch(() => null)
  return r ? parseHits(r.stdout) : []
}

/** The videos of a YouTube mix (`RD<id>`), skipping the seed itself. */
export async function mix($: $, env: Env, url: string, n = 15): Promise<Candidate[]> {
  if (!env.ytdlp) return []
  const r = await $.process
    .run([env.ytdlp, '--no-update', '--no-warnings', '--flat-playlist', '-I', `2:${n + 1}`, '--print', PRINT, url], {
      timeoutMs: 60_000,
    })
    .catch(() => null)
  return r ? parseHits(r.stdout) : []
}
