# musicflow: YouTube music in Claude Code, picked by Claude

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**musicflow** is a [Claude Code](https://claude.com/claude-code) mod (a plugin of function hooks) that plays background music from YouTube while you code. Claude picks the tracks for your taste and your mood, in the background, and keeps the queue full. `yt-dlp` finds the tracks and `mpv` plays the audio, with no browser and no video.

[Русская версия](README.ru.md)

```
? for shortcuts  ·  ♪ Roygbiv — Boards of Canada  0:42 ━━────── 2:30
```

What's playing shows as one dim line under the prompt, after the shortcut hint. Run `/music` to open the full panel at the side. Prefer buttons? `/music layout above` moves it into a band above the prompt with ⏸ ⏭ ♡ ✕ ≡.

## What it does

- **Claude is the DJ.** Haiku reads the station description, the mood, what you liked, disliked, skipped and finished, and suggests tracks. Each one shows why it was picked.
- **Stations.** `/music station like Boards of Canada, but more upbeat` gives an endless stream in that spirit. `/music play <anything>` plays the best match now and continues with similar music.
- **Mood.** Set it in your own words (`/music mood rainy evening, no vocals`) or leave it on `auto`. Auto follows the session: long debugging with failing commands turns it calmer, a fast stream of edits turns it more energetic, and late at night it gets quiet.
- **Learns as you listen.** ♥ and ✕ are strong signals. Skipping a track in its first quarter is a weak minus, and listening to the end is a weak plus.
- **Playlists.** Liked tracks gather in *Liked*. Save the current queue under any name and play it later.
- **Claude can drive it.** The mod gives Claude a `Music` tool, so "put on something like Tycho" or "stop the music" in the chat just works.
- **One player for every window.** All Claude Code sessions share one `mpv` daemon, so music doesn't double and survives a mod reload. The last session to close turns it off.

## Requirements

- macOS or Linux with `mpv` and a **recent** `yt-dlp`:

  ```sh
  brew install mpv yt-dlp     # or: brew upgrade yt-dlp
  ```

  YouTube changes often. If tracks stop playing, update `yt-dlp` first.
- `nc` (netcat with `-U`, present on macOS and most Linux distributions).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install musicflow --marketplace legostin/claude-code-musicflow
```

Answer `y` to add the marketplace, then pick a scope (user is first). From a shell:

```sh
claude plugin install musicflow --marketplace legostin/claude-code-musicflow
```

In the desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `legostin/claude-code-musicflow`, then **Add plugin**.

## Use

| Command | What it does |
| --- | --- |
| `/music` | open the panel |
| `/music play [query]` | play a track now and keep going with similar music; with no query, start *My wave* (your taste) |
| `/music station <description>` | endless station from a description |
| `/music next` · `like` · `dislike` | skip, ♥, ✕ (✕ also skips and never plays the track again) |
| `/music pause` · `resume` · `stop` · `now` | control and status |
| `/music mood <text\|auto>` | set the mood or follow the session |
| `/music vol <0-100>` | volume |
| `/music playlist save <name>` · `playlist play <name>` | playlists |
| `/music layout below\|above` | now-playing under the prompt (text, default) or above it (band with buttons) |

With `layout above`, band hotkeys, once the band has focus (`ctrl+x tab` or a click): `p` pause, `n` next, `l` like, `d` dislike, `m` panel.

The panel shows now-playing with progress and the reason for the pick, the controls, a field to play anything by query, the mood picker and a free-text mood field, the next six tracks with the reason for each, your stations with a field for a new one, and your playlists.

## How it works

```
 Claude Code sessions ── nc -U ──▶ mpv --idle (one per machine, ~/.claude/musicflow/mpv.sock)
        │                                └─ ytdl_hook → yt-dlp → YouTube audio
        └─ leader session: queue < 3 → Haiku → "artist - title" picks
                                       → yt-dlp ytsearch → filter → loadfile append
```

- The player is a detached `mpv` process driven over its JSON IPC socket. The mod polls it once a second.
- When fewer than three tracks are queued, one session (the leader) asks Haiku for eight picks. Each pick is searched on YouTube, and hits that were played recently, disliked, are too short or too long, or are reactions or tutorials get dropped. Tracks are queued as soon as they are found. If the model has nothing usable, YouTube's own mix of the current track fills in.
- Taste, stations, playlists and mood are kept in the plugin store (`$.store`), shared by all sessions.

## Develop

```sh
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT
