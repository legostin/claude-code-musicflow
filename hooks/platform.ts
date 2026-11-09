import type { EngineInterface } from 'claude-code'

import type { Arch, IpcTool, OS, Probe, Tool } from './doctor'

type $ = EngineInterface

/** The OS and where things live, resolved once per load. */
export type Host = {
  os: OS
  arch: Arch
  home: string
  sep: '/' | '\\'
  /** Folders searched for binaries, before PATH. */
  binDirs: string[]
}

async function run($: $, argv: string[], timeoutMs = 10_000) {
  return $.process.run(argv, { timeoutMs }).catch(() => null)
}

export async function detectHost($: $): Promise<Host> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  if (isWindows) {
    const home = (await $.env.get('USERPROFILE')) ?? 'C:\\'
    const local = (await $.env.get('LOCALAPPDATA')) ?? `${home}\\AppData\\Local`
    const pf = (await $.env.get('ProgramFiles')) ?? 'C:\\Program Files'
    const cpu = ((await $.env.get('PROCESSOR_ARCHITECTURE')) ?? '').toUpperCase()
    return {
      os: 'windows',
      arch: cpu === 'ARM64' ? 'arm64' : cpu === 'AMD64' ? 'x64' : 'other',
      home,
      sep: '\\',
      binDirs: [
        `${local}\\Microsoft\\WinGet\\Links`,
        `${home}\\scoop\\shims`,
        `${home}\\.deno\\bin`,
        `${pf}\\mpv`,
        `${pf}\\nodejs`,
      ],
    }
  }
  const home = (await $.env.get('HOME')) ?? '/tmp'
  const uname = await run($, ['uname', '-sm'])
  const [sys = '', machine = ''] = (uname?.stdout ?? '').trim().split(/\s+/)
  return {
    os: sys === 'Darwin' ? 'macos' : 'linux',
    arch: /arm64|aarch64/i.test(machine) ? 'arm64' : /x86_64|amd64/i.test(machine) ? 'x64' : 'other',
    home,
    sep: '/',
    binDirs: [
      // What the mod itself installs comes first: it is the fresh one.
      `${home}/.local/bin`,
      `${home}/.deno/bin`,
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/snap/bin',
      '/Applications/mpv.app/Contents/MacOS',
    ],
  }
}

export const join = (h: Host, ...parts: string[]) => parts.join(h.sep)

/** A binary by name: the known folders first, then PATH. */
export async function findBin($: $, h: Host, name: string): Promise<string | null> {
  const file = h.os === 'windows' ? `${name}.exe` : name
  for (const dir of h.binDirs) {
    const path = `${dir}${h.sep}${file}`
    if (await $.fs.exists(path).catch(() => false)) return path
  }
  const r =
    h.os === 'windows' ? await run($, ['where.exe', name]) : await run($, ['/bin/sh', '-lc', `command -v ${name}`])
  const path = r?.exitCode === 0 ? (r.stdout.trim().split(/\r?\n/)[0] ?? '') : ''
  return path ? path : null
}

export async function mkdirp($: $, h: Host, path: string) {
  if (h.os === 'windows') {
    await run($, ['powershell', '-NoProfile', '-Command', `New-Item -ItemType Directory -Force -Path '${path.replace(/'/g, "''")}' | Out-Null`])
  } else {
    await run($, ['mkdir', '-p', path])
  }
}

export async function rmf($: $, h: Host, path: string) {
  if (h.os === 'windows') {
    await run($, ['powershell', '-NoProfile', '-Command', `Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath '${path.replace(/'/g, "''")}'`])
  } else {
    await run($, ['rm', '-f', path])
  }
}

/** The local hour, for the auto mood. */
export async function hour($: $, h: Host): Promise<number> {
  if (h.os !== 'windows') {
    const r = await run($, ['date', '+%H'])
    const n = Number(r?.stdout.trim())
    if (Number.isFinite(n)) return n
  }
  return new Date().getHours()
}

async function version($: $, path: string | null, args: string[], pick: (out: string) => string): Promise<Tool | null> {
  if (!path) return null
  const r = await run($, [path, ...args], 20_000)
  if (!r || r.exitCode !== 0) return null
  return { path, version: pick(`${r.stdout}\n${r.stderr}`) || '?' }
}

const firstLine = (s: string) => s.trim().split(/\r?\n/)[0] ?? ''

/** Which tool can talk to mpv's socket here. */
async function ipcTool($: $, h: Host): Promise<IpcTool | null> {
  if (h.os === 'windows') return (await findBin($, h, 'powershell')) ? 'powershell' : null
  const nc = await run($, ['/bin/sh', '-c', 'nc -h 2>&1 | grep -q -- "-U" && echo yes'])
  if (nc?.stdout.trim() === 'yes') return 'nc'
  if (await findBin($, h, 'socat')) return 'socat'
  if (await findBin($, h, 'python3')) return 'python3'
  return null
}

async function hasCmd($: $, h: Host, name: string) {
  return (await findBin($, h, name)) !== null
}

/** Looks at the machine: what is there, in which version. */
export async function probe($: $, h: Host): Promise<Probe> {
  const [mpvPath, ytdlpPath, denoPath, nodePath] = await Promise.all([
    findBin($, h, 'mpv'),
    findBin($, h, 'yt-dlp'),
    findBin($, h, 'deno'),
    findBin($, h, 'node'),
  ])
  const [mpv, ytdlp, deno, node, ipc] = await Promise.all([
    version($, mpvPath, ['--version'], out => /mpv\s+v?([\w.-]+)/.exec(out)?.[1] ?? firstLine(out)),
    version($, ytdlpPath, ['--version'], firstLine),
    version($, denoPath, ['--version'], out => /deno\s+([\d.]+)/.exec(out)?.[1] ?? firstLine(out)),
    version($, nodePath, ['--version'], firstLine),
    ipcTool($, h),
  ])
  const managers: Probe['managers'] =
    h.os === 'windows'
      ? { winget: await hasCmd($, h, 'winget'), scoop: await hasCmd($, h, 'scoop') }
      : h.os === 'macos'
        ? { brew: await hasCmd($, h, 'brew') }
        : {
            apt: await hasCmd($, h, 'apt-get'),
            dnf: await hasCmd($, h, 'dnf'),
            pacman: await hasCmd($, h, 'pacman'),
            zypper: await hasCmd($, h, 'zypper'),
            apk: await hasCmd($, h, 'apk'),
          }
  const now = new Date(await $.clock.now())
  const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`
  return { os: h.os, arch: h.arch, home: h.home, mpv, ytdlp, deno, node, ipc, managers, today }
}
