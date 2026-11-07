<p align="center">
  <img src="assets/banner.svg" alt="musicflow — YouTube music in Claude Code, picked by Claude for your mood" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-c084fc"></a>
  <img alt="Claude Code mod" src="https://img.shields.io/badge/Claude%20Code-mod-d97757">
  <img alt="macOS · Linux" src="https://img.shields.io/badge/macOS%20%C2%B7%20Linux-supported-8b84a3">
  <img alt="mpv + yt-dlp" src="https://img.shields.io/badge/mpv%20%2B%20yt--dlp-powered-f0abfc">
</p>

<p align="center">
  <b>Background music for coding that picks itself.</b><br>
  Claude reads your taste and the vibe of the session, finds tracks on YouTube and keeps the queue going.<br>
  No browser tab, no ads, no video — just audio, right in the terminal.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#use">Use</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#faq">FAQ</a> ·
  <a href="README.ru.md">Русский</a>
</p>

<p align="center">
  <img src="assets/demo.gif" alt="musicflow demo: /music play, the side panel, and asking Claude for a station in plain words" width="100%">
</p>

## Why

You open YouTube for "music to code to", lose ten minutes picking, and an ad breaks your focus halfway through a function. musicflow plays the music in Claude Code itself, and Claude does the picking. It already knows what you're doing: a long debugging session gets calmer music, a fast run of edits gets a beat.

## What you get

| | |
| --- | --- |
| 🎛 **Claude is the DJ** | Haiku reads the station description, your mood, and what you liked, skipped and finished, then picks the next tracks. Every pick shows *why* it was chosen. |
| 📻 **Stations from a sentence** | `/music station like Boards of Canada, but more upbeat` gives an endless stream. `/music play Moby` plays the best match now and keeps going with similar music. |
| 🧠 **Mood that follows your session** | `auto` reads the session: failing commands make it calmer, a burst of edits makes it more energetic, late at night it gets quiet. Or set it in your own words: `rainy evening, no vocals`. |
| 💬 **Talk to it** | Claude gets a `Music` tool, so "put on something epic" or "stop the music" in the chat just works. |
| ♥ **Learns as you listen** | ♥ and ✕ are strong signals. Skipping early is a weak minus, and listening to the end is a weak plus. Likes collect in a *Liked* playlist. |
| 🪟 **Out of the way** | One dim line under the prompt shows what's playing. `/music` opens the full panel at the side: controls, a play-anything field, mood, the queue with reasons, stations and playlists. |
| 🔁 **Picks up where you left off** | Quit Claude Code and come back later: `/music play` resumes the same track at the same second. |
| 🖥 **One player for every window** | All Claude Code sessions share one `mpv`, so the music never doubles, and a mod reload doesn't interrupt it. |

## Install

You need `mpv` and a **recent** `yt-dlp`:

```sh
brew install mpv yt-dlp        # macOS; on Linux use your package manager
```

Then, at the prompt of a Claude Code terminal session:

```
/plugin install musicflow --marketplace legostin/claude-code-musicflow
```

Answer `y` to add the marketplace, then pick a scope (user is first). Or from a shell:

```sh
claude plugin install musicflow --marketplace legostin/claude-code-musicflow
```

In the desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `legostin/claude-code-musicflow`, then **Add plugin**.

## Use

Just ask Claude: *"play something like Tycho"*, *"more energetic"*, *"skip this"*, *"what's playing?"*. Or use the command:

| Command | What it does |
| --- | --- |
| `/music` | open the panel |
| `/music play [query]` | play now and keep going with similar music; with no query, resume or start *My wave* |
| `/music station <description>` | an endless station from a description |
| `/music next` · `like` · `dislike` | skip, ♥, ✕ (✕ also skips, and the track never comes back) |
| `/music pause` · `resume` · `stop` · `now` | control and status |
| `/music mood <text\|auto>` | set the mood, or follow the session |
| `/music vol <0-100>` | volume |
| `/music playlist save <name>` · `playlist play <name>` | playlists |
| `/music layout below\|above` | now-playing under the prompt (text, default) or in a band above it, with buttons |

With `layout above`, the band has hotkeys once it has focus (`ctrl+x tab` or a click): `p` pause, `n` next, `l` like, `d` dislike, `m` panel.

## How it works

```mermaid
flowchart LR
  subgraph CC["Claude Code sessions"]
    A["session A"]
    B["session B (leader)"]
  end
  A -- "JSON IPC (nc -U)" --> M
  B -- "JSON IPC (nc -U)" --> M
  M["mpv --idle --no-video<br/>one per machine"] -- "ytdl_hook" --> Y["yt-dlp → YouTube audio"]
  B -- "queue < 3" --> H["Haiku: 8 picks<br/>artist – title + why"]
  H --> S["yt-dlp ytsearch<br/>filter: played, disliked,<br/>length, junk"]
  S -- "loadfile append" --> M
```

- **Player.** A detached `mpv` driven over its JSON IPC socket (`~/.claude/musicflow/mpv.sock`). The mod polls it once a second. Because the player lives outside the session, reloads don't cut the music.
- **Recommendations.** When fewer than three tracks are queued, the *leader* session (one per machine, elected through a heartbeat file) asks Haiku for eight picks. Each pick goes through a YouTube search. Hits that were played recently, disliked, too short or too long, or that are reactions, tutorials or cutscenes get dropped. Tracks are queued as soon as they are found. If the model has nothing usable, YouTube's own mix of the current track fills in.
- **Mood.** Each session writes its recent signals (Bash failures, edits) to its own file, and the auto mood reads all of them together with the hour.
- **Memory.** Taste, stations, playlists and mood live in the plugin store. The queue and the position are saved every few seconds for resuming.

## FAQ

<details>
<summary><b>Tracks stopped playing / "found nothing to play"</b></summary>

YouTube changes its player often, and an old `yt-dlp` stops getting audio. Update it: `brew upgrade yt-dlp` (or `pipx upgrade yt-dlp`).
</details>

<details>
<summary><b>Does it cost tokens?</b></summary>

A little. Each refill of the queue is one short Haiku request for about eight tracks. Playback itself uses no tokens.
</details>

<details>
<summary><b>What happens with several Claude Code windows open?</b></summary>

They share one player. Pause in any window pauses the music. Only one window (the leader) refills the queue and records what you listened to, so nothing is doubled. The music stops when the last window closes, and `/music play` picks it up from the same spot next time.
</details>

<details>
<summary><b>Windows?</b></summary>

Not yet: the player talks to `mpv` over a Unix socket with `nc -U`. PRs welcome.
</details>

<details>
<summary><b>Where is my data?</b></summary>

On your machine: the plugin store of Claude Code and `~/.claude/musicflow/` (socket, session heartbeats, signals, resume point). Nothing is sent anywhere except YouTube searches and the Haiku requests through your own Claude Code session.
</details>

## Develop

```sh
git clone https://github.com/legostin/claude-code-musicflow && cd claude-code-musicflow
claude plugin validate .   # what the engine will load
claude plugin test .       # unit + render tests
claude --plugin-dir .      # run it from the folder
vhs assets/demo.tape       # re-record the demo GIF
```

## License

[MIT](LICENSE) © Legostin Vyacheslav
