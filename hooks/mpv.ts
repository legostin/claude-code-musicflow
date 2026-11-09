import type { EngineInterface } from 'claude-code'

import type { Player, Track } from '../types'
import { type IpcTool, type Probe, jsRuntime } from './doctor'
import { type Host, detectHost, join, mkdirp, probe, rmf } from './platform'
import { type Candidate, PRINT, parseHits, videoId } from './search'

type $ = EngineInterface

/** Where the binaries and the player's socket are, resolved once per load. */
export type Env = {
  host: Host
  dir: string
  /** A Unix socket path, or a Windows named pipe (\\.\pipe\musicflow-mpv). */
  sock: string
  mpv: string | null
  ytdlp: string | null
  ipcTool: IpcTool | null
  /** yt-dlp's --js-runtimes value for YouTube, when one is found. */
  js: string | null
  probe: Probe
}

const PIPE = 'musicflow-mpv'

export async function resolveEnv($: $): Promise<Env> {
  const host = await detectHost($)
  // Kept short: a Unix socket path on macOS holds at most 104 bytes.
  const dir = join(host, host.home, '.claude', 'musicflow')
  await mkdirp($, host, join(host, dir, 'signals'))
  const found = await probe($, host)
  return {
    host,
    dir,
    sock: host.os === 'windows' ? `\\\\.\\pipe\\${PIPE}` : `${dir}/mpv.sock`,
    mpv: found.mpv?.path ?? null,
    ytdlp: found.ytdlp?.path ?? null,
    ipcTool: found.ipc,
    js: jsRuntime(found),
    probe: found,
  }
}

/** Sends JSON lines to a Unix socket and prints the replies (no nc -U, no socat). */
const PY_CLIENT = [
  'import sys, socket',
  's = socket.socket(socket.AF_UNIX); s.settimeout(3); s.connect(sys.argv[1])',
  'lines = [l for l in sys.stdin.read().splitlines() if l.strip()]',
  "s.sendall(('\\n'.join(lines) + '\\n').encode())",
  "f = s.makefile('r'); n = 0",
  'while n < len(lines):',
  '    l = f.readline()',
  '    if not l: break',
  '    sys.stdout.write(l)',
  "    if '\"event\"' not in l: n += 1",
].join('\n')

/** The same over a Windows named pipe, in the PowerShell every Windows has. */
const PS_CLIENT = [
  "$ErrorActionPreference = 'Stop'",
  `$p = New-Object System.IO.Pipes.NamedPipeClientStream('.', '${PIPE}', [System.IO.Pipes.PipeDirection]::InOut)`,
  '$p.Connect(2000)',
  '$w = New-Object System.IO.StreamWriter($p); $w.AutoFlush = $true',
  '$r = New-Object System.IO.StreamReader($p)',
  '$lines = @([Console]::In.ReadToEnd() -split "`r?`n" | Where-Object { $_.Trim() })',
  'foreach ($l in $lines) { $w.WriteLine($l) }',
  '$n = 0',
  'while ($n -lt $lines.Count) { $l = $r.ReadLine(); if ($l -eq $null) { break }; [Console]::Out.WriteLine($l); if ($l -notmatch \'"event"\') { $n++ } }',
  '$p.Dispose()',
].join('; ')

function ipcArgv(env: Env): string[] | null {
  switch (env.ipcTool) {
    case 'nc':
      return ['nc', '-U', env.sock]
    case 'socat':
      return ['socat', '-', `UNIX-CONNECT:${env.sock}`]
    case 'python3':
      return ['python3', '-c', PY_CLIENT, env.sock]
    case 'powershell':
      return ['powershell', '-NoProfile', '-NonInteractive', '-Command', PS_CLIENT]
    default:
      return null
  }
}

/**
 * Sends commands over mpv's JSON IPC in one call: mpv answers each line.
 * Resolves the replies in order (undefined for a failed one), or null when
 * nothing listens.
 */
export async function ipc($: $, env: Env, commands: readonly unknown[][]): Promise<(unknown | undefined)[] | null> {
  const argv = ipcArgv(env)
  if (!argv) return null
  const input = commands.map((command, i) => JSON.stringify({ command, request_id: i + 1 })).join('\n') + '\n'
  const r = await $.process.run(argv, { stdin: input, timeoutMs: env.host.os === 'windows' ? 8000 : 4000 }).catch(() => null)
  if (!r || r.exitCode !== 0 || r.stdout.trim() === '') return null
  const out: (unknown | undefined)[] = commands.map(() => undefined)
  for (const line of r.stdout.split(/\r?\n/)) {
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

/** mpv's command line: audio only, idle, driven over IPC, YouTube through yt-dlp. */
export function mpvArgs(env: Pick<Env, 'sock' | 'ytdlp' | 'js'>): string[] {
  return [
    '--idle=yes',
    '--no-video',
    '--no-terminal',
    '--force-window=no',
    '--keep-open=no',
    '--prefetch-playlist=yes',
    `--input-ipc-server=${env.sock}`,
    '--ytdl-format=bestaudio/best',
    `--script-opts=ytdl_hook-ytdl_path=${env.ytdlp}`,
    '--volume=70',
    ...(env.js ? [`--ytdl-raw-options-append=js-runtimes=${env.js}`] : []),
  ]
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`

/** Starts the shared mpv daemon if none answers. Resolves whether one runs. */
export async function ensure($: $, env: Env): Promise<boolean> {
  if (await isAlive($, env)) return true
  if (!env.mpv || !env.ytdlp || !env.ipcTool) return false
  const args = mpvArgs(env)
  if (env.host.os === 'windows') {
    // Each argument in double quotes, so a path with spaces stays one argument.
    const list = args.map(a => psQuote(`"${a}"`)).join(',')
    await $.process.run(
      ['powershell', '-NoProfile', '-NonInteractive', '-Command', `Start-Process -WindowStyle Hidden -FilePath ${psQuote(env.mpv)} -ArgumentList @(${list})`],
      { timeoutMs: 15_000 },
    )
  } else {
    await rmf($, env.host, env.sock)
    // Detached: the player outlives a reload of the mod.
    await $.process.run(['/bin/sh', '-c', 'nohup "$0" "$@" >/dev/null 2>&1 &', env.mpv, ...args])
  }
  for (let i = 0; i < 40; i++) {
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
