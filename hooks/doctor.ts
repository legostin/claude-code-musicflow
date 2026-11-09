/**
 * What the machine has, what is missing, and the steps that get it there.
 * Pure: the probing is in platform.ts, so this can be tested on any OS.
 */

export type OS = 'macos' | 'linux' | 'windows'
export type Arch = 'x64' | 'arm64' | 'other'
export type IpcTool = 'nc' | 'socat' | 'python3' | 'powershell'

export type Tool = { path: string; version: string }

export type Probe = {
  os: OS
  arch: Arch
  home: string
  mpv: Tool | null
  ytdlp: Tool | null
  deno: Tool | null
  node: Tool | null
  ipc: IpcTool | null
  /** Package managers found on PATH. */
  managers: {
    brew?: boolean
    apt?: boolean
    dnf?: boolean
    pacman?: boolean
    zypper?: boolean
    apk?: boolean
    winget?: boolean
    scoop?: boolean
  }
  /** Today, YYYY-MM-DD, to tell an old yt-dlp. */
  today: string
}

export type CheckKey = 'mpv' | 'yt-dlp' | 'js' | 'ipc'
export type Check = { key: CheckKey; level: 'ok' | 'warn' | 'missing'; label: string; detail: string }

/**
 * One step of the setup. `argv` runs from the mod with no prompt (no sudo);
 * `paste` is a shell line the person runs themselves (it needs sudo or a
 * terminal); `manual` is an instruction with a link.
 */
export type Step = { id: string; title: string; argv?: string[]; paste?: string; manual?: string }

export const YTDLP_MAX_AGE_DAYS = 60
const NODE_MIN_MAJOR = 20

/** Days since a yt-dlp release, from its date version (2026.10.26), or null. */
export function ytdlpAgeDays(version: string, today: string): number | null {
  const v = /^(\d{4})\.(\d{1,2})\.(\d{1,2})/.exec(version.trim())
  const t = /^(\d{4})-(\d{2})-(\d{2})/.exec(today)
  if (!v || !t) return null
  const released = Date.UTC(Number(v[1]), Number(v[2]) - 1, Number(v[3]))
  const now = Date.UTC(Number(t[1]), Number(t[2]) - 1, Number(t[3]))
  return Math.floor((now - released) / 86_400_000)
}

export function nodeMajor(version: string): number | null {
  const m = /^v?(\d+)\./.exec(version.trim())
  return m ? Number(m[1]) : null
}

/** The JS runtime yt-dlp should use for YouTube, as its `--js-runtimes` value. */
export function jsRuntime(p: Pick<Probe, 'deno' | 'node'>): string | null {
  if (p.deno) return `deno:${p.deno.path}`
  const major = p.node ? nodeMajor(p.node.version) : null
  if (p.node && major !== null && major >= NODE_MIN_MAJOR) return `node:${p.node.path}`
  return null
}

export function checks(p: Probe): Check[] {
  const out: Check[] = []
  out.push(
    p.mpv
      ? { key: 'mpv', level: 'ok', label: 'mpv', detail: `${p.mpv.version} · ${p.mpv.path}` }
      : { key: 'mpv', level: 'missing', label: 'mpv', detail: 'not found: it plays the audio' },
  )
  if (!p.ytdlp) {
    out.push({ key: 'yt-dlp', level: 'missing', label: 'yt-dlp', detail: 'not found: it finds and streams the tracks' })
  } else {
    const age = ytdlpAgeDays(p.ytdlp.version, p.today)
    out.push(
      age !== null && age > YTDLP_MAX_AGE_DAYS
        ? { key: 'yt-dlp', level: 'warn', label: 'yt-dlp', detail: `${p.ytdlp.version} is ${age} days old: YouTube breaks old versions` }
        : { key: 'yt-dlp', level: 'ok', label: 'yt-dlp', detail: `${p.ytdlp.version} · ${p.ytdlp.path}` },
    )
  }
  const rt = jsRuntime(p)
  out.push(
    rt
      ? { key: 'js', level: 'ok', label: 'JS runtime', detail: p.deno ? `deno ${p.deno.version}` : `node ${p.node!.version}` }
      : {
          key: 'js',
          level: 'warn',
          label: 'JS runtime',
          detail: p.node
            ? `node ${p.node.version} is too old (needs ${NODE_MIN_MAJOR}+); install deno`
            : 'no deno or node 20+: yt-dlp needs one for YouTube',
        },
  )
  out.push(
    p.ipc
      ? { key: 'ipc', level: 'ok', label: 'player link', detail: p.ipc }
      : {
          key: 'ipc',
          level: 'missing',
          label: 'player link',
          detail: p.os === 'windows' ? 'PowerShell not found' : 'no nc with -U, socat or python3 to talk to mpv',
        },
  )
  return out
}

export const isReady = (cs: readonly Check[]) => cs.every(c => c.level !== 'missing')
export const isClean = (cs: readonly Check[]) => cs.every(c => c.level === 'ok')

const sh = (script: string) => ['/bin/sh', '-c', script]

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/'

/** The official standalone yt-dlp for this machine, into ~/.local/bin (no sudo). */
function ytdlpBinary(p: Probe): Step {
  const asset =
    p.os === 'macos' ? 'yt-dlp_macos' : p.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
  const target = '"$HOME/.local/bin/yt-dlp"'
  return {
    id: 'yt-dlp',
    title: 'Download the official yt-dlp into ~/.local/bin',
    argv: sh(
      `mkdir -p "$HOME/.local/bin" && rm -f ${target} && ` +
        `(curl -fsSL --retry 2 -o ${target} ${YTDLP_URL}${asset} || wget -qO ${target} ${YTDLP_URL}${asset}) && ` +
        `chmod +x ${target}`,
    ),
  }
}

const denoScript: Step = {
  id: 'deno',
  title: 'Install deno (the JS runtime yt-dlp uses for YouTube) into ~/.deno',
  argv: sh('curl -fsSL https://deno.land/install.sh | sh -s -- -y --no-modify-path'),
}

function linuxInstall(p: Probe, pkgs: string[]): Step | null {
  const m = p.managers
  const list = pkgs.join(' ')
  const line = m.apt
    ? `sudo apt-get install -y ${list}`
    : m.dnf
      ? `sudo dnf install -y ${list}`
      : m.pacman
        ? `sudo pacman -S --needed --noconfirm ${list}`
        : m.zypper
          ? `sudo zypper install -y ${list}`
          : m.apk
            ? `sudo apk add ${list}`
            : null
  return line ? { id: `pkg-${pkgs.join('-')}`, title: `Install ${list} with your package manager (needs sudo)`, paste: line } : null
}

const winget = (id: string, name: string): Step => ({
  id: name,
  title: `Install ${name} with winget`,
  argv: ['winget', 'install', '--id', id, '-e', '--accept-source-agreements', '--accept-package-agreements'],
})

const wingetUpgrade = (id: string, name: string): Step => ({
  id: name,
  title: `Update ${name} with winget`,
  argv: ['winget', 'upgrade', '--id', id, '-e', '--accept-source-agreements', '--accept-package-agreements'],
})

/** The steps that fix what `checks` found, best first, for this OS. */
export function plan(p: Probe): Step[] {
  const cs = checks(p)
  const need = (k: CheckKey) => cs.find(c => c.key === k)!.level !== 'ok'
  const steps: Step[] = []

  if (p.os === 'macos') {
    if (p.managers.brew) {
      const install = [need('mpv') && 'mpv', !p.ytdlp && 'yt-dlp', need('js') && 'deno'].filter(Boolean) as string[]
      if (install.length) steps.push({ id: 'brew', title: `brew install ${install.join(' ')}`, argv: ['brew', 'install', ...install] })
      if (p.ytdlp && need('yt-dlp')) {
        steps.push(
          p.ytdlp.path.includes('/homebrew/') || p.ytdlp.path.startsWith('/usr/local/')
            ? { id: 'yt-dlp', title: 'brew upgrade yt-dlp', argv: ['brew', 'upgrade', 'yt-dlp'] }
            : ytdlpBinary(p),
        )
      }
    } else {
      if (need('mpv')) {
        steps.push({
          id: 'mpv',
          title: 'Install mpv',
          manual: 'Install Homebrew from https://brew.sh, then run /music setup again; or put mpv.app from https://mpv.io/installation/ into /Applications.',
        })
      }
      if (need('yt-dlp')) steps.push(ytdlpBinary(p))
      if (need('js')) steps.push(denoScript)
    }
  }

  if (p.os === 'linux') {
    const pkgs = [
      need('mpv') && 'mpv',
      need('ipc') && (p.managers.apt ? 'netcat-openbsd' : 'socat'),
      // deno's installer unpacks a zip.
      need('js') && 'unzip',
    ].filter(Boolean) as string[]
    if (pkgs.length) {
      steps.push(
        linuxInstall(p, pkgs) ?? {
          id: 'pkg',
          title: `Install ${pkgs.join(' ')}`,
          manual: `Install ${pkgs.join(' and ')} with your distribution's package manager.`,
        },
      )
    }
    // Distribution packages of yt-dlp lag behind YouTube: the official binary keeps up.
    if (need('yt-dlp')) steps.push(ytdlpBinary(p))
    if (need('js')) steps.push(denoScript)
  }

  if (p.os === 'windows') {
    if (p.managers.winget) {
      if (need('mpv')) steps.push(winget('shinchiro.mpv', 'mpv'))
      if (!p.ytdlp) steps.push(winget('yt-dlp.yt-dlp', 'yt-dlp'))
      else if (need('yt-dlp')) steps.push(wingetUpgrade('yt-dlp.yt-dlp', 'yt-dlp'))
      if (need('js')) steps.push(winget('DenoLand.Deno', 'deno'))
    } else if (p.managers.scoop) {
      if (need('mpv')) steps.push({ id: 'mpv', title: 'scoop install extras/mpv', argv: ['powershell', '-NoProfile', '-Command', 'scoop bucket add extras; scoop install extras/mpv'] })
      if (!p.ytdlp) steps.push({ id: 'yt-dlp', title: 'scoop install yt-dlp', argv: ['powershell', '-NoProfile', '-Command', 'scoop install yt-dlp'] })
      else if (need('yt-dlp')) steps.push({ id: 'yt-dlp', title: 'scoop update yt-dlp', argv: ['powershell', '-NoProfile', '-Command', 'scoop update yt-dlp'] })
      if (need('js')) steps.push({ id: 'deno', title: 'scoop install deno', argv: ['powershell', '-NoProfile', '-Command', 'scoop install deno'] })
    } else if (need('mpv') || need('yt-dlp') || need('js')) {
      steps.push({
        id: 'winget',
        title: 'Get a package manager',
        manual: 'Install "App Installer" (winget) from the Microsoft Store, or scoop from https://scoop.sh, then run /music setup again.',
      })
    }
  }

  return steps
}

const MARK = { ok: '✓', warn: '!', missing: '✗' } as const

/** The report `/music setup` prints. */
export function report(p: Probe, cs: readonly Check[], steps: readonly Step[]): string {
  const lines = [`musicflow setup · ${p.os} ${p.arch}`, '']
  for (const c of cs) lines.push(`  ${MARK[c.level]} ${c.label.padEnd(12)} ${c.detail}`)
  lines.push('')
  if (!steps.length) {
    lines.push(isReady(cs) ? 'All set. /music play to start.' : 'Nothing this mod can install here; see above.')
    return lines.join('\n')
  }
  lines.push('To fix:')
  for (const s of steps) {
    if (s.argv) lines.push(`  • ${s.title}  (the mod runs it: /music setup install)`)
    else if (s.paste) lines.push(`  • ${s.title}:\n      ${s.paste}`)
    else lines.push(`  • ${s.title}: ${s.manual}`)
  }
  lines.push('', 'Or ask Claude: "set up musicflow".')
  return lines.join('\n')
}
