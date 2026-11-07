# Records assets/demo.gif with VHS (https://github.com/charmbracelet/vhs):
#   vhs assets/demo.tape
# Needs musicflow installed, mpv + yt-dlp, and a Claude Code login.
# Waits for the network (search, Claude's picks) are hidden from the recording.

Output assets/demo.gif

Set Shell zsh
Set FontSize 16
Set Width 1440
Set Height 860
Set Padding 18
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set Framerate 24
Set WindowBar Colorful

Hide
# A clean environment: nothing inherited from a Claude Code session that runs this.
Type "unset CLAUDECODE CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ID CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_CODE_BRIDGE_SESSION_ID CLAUDE_CODE_SESSION_ATTENDED CLAUDE_CODE_EXECPATH CLAUDE_PID CLAUDE_EFFORT CLAUDE_PLUGIN_DATA" Enter
# Runs in the folder vhs was started from: use one Claude Code already trusts,
# or the trust question takes the keys.
Type "clear" Enter
Show

Type `claude --allowedTools mcp__musicflow__Music --settings '{"statusLine":{"type":"command","command":"true"}}'`
Sleep 300ms
Enter
Sleep 1s
Hide
Sleep 13s
Show
Sleep 1s

# 1. Play something by name: it starts, and a station of similar music follows.
Type "/music play Tycho Awake"
Sleep 600ms
Enter
Hide
Sleep 16s
Show
Sleep 4s

# 2. Open the panel at the side.
Type "/music"
Sleep 600ms
Enter
Sleep 6s

# 3. Ask Claude in plain words: it starts a station with the Music tool.
Type "put on something like Boards of Canada, but more upbeat"
Sleep 600ms
Enter
Sleep 8s
Hide
Sleep 30s
Show
Sleep 8s

Hide
Ctrl+C
Ctrl+C
