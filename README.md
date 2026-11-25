English | [ภาษาไทย](README.th.md)

# Claude Control Room

A local web UI, running on your own PC, to watch and control every Claude Code session on that machine from one place. It shows the session network as a graph, a question and permission queue across all sessions, a worklog summarised by Haiku, and Clip Studio for turning a brief into a video that is ready to render. Windows 10 and 11 are the first supported platforms.

The server listens on `127.0.0.1` only. Nothing is exposed to the network.

## Requirements

- Windows 10 or 11.
- Claude Code installed and signed in (`claude` on PATH; run `claude` once to log in).
- Node.js 22.18 or newer. The installer can fetch Node.js, Git and ffmpeg with winget if they are missing.

## Install

Open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/OAKHEN1412/claude-control-room/main/install.ps1 | iex
```

Or run the installer from a local copy of the repository:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [-Yes] [-DryRun] [-InstallDir <dir>] [-Ref <tag>] [-RepoUrl <url>] [-Port 8790] [-NoVideoToolchain]
```

- `-Yes` answers yes to every question.
- `-DryRun` prints every action and changes nothing. Read-only checks still run.
- `-InstallDir` defaults to `%LOCALAPPDATA%\ClaudeControlRoom\app`.
- `-Ref` installs a specific release tag. Without it, the latest release is used.
- `-Port` defaults to 8790.
- `-NoVideoToolchain` skips step 9 (HyperFrames skills, Lemo-Opuscar plugin, Lemo styles).

Through `iex` parameters cannot be passed, so set environment variables instead: `CR_INSTALL_YES=1`, `CR_INSTALL_DRYRUN=1`, `CR_INSTALL_REF` and `CR_INSTALL_DIR`.

The installer needs no administrator rights. Each step is idempotent and asks y/n unless `-Yes` is given. The steps are:

1. **Node.js 22.18+**: installed with winget (`OpenJS.NodeJS.LTS`) if missing.
2. **Git**: installed with winget (`Git.Git`) if missing.
3. **Claude Code CLI**: if `claude` is not on PATH, the installer offers the official installer and asks you to run `claude` once to sign in.
4. **ffmpeg**: installed with winget (`Gyan.FFmpeg`) if missing.
5. **App checkout**: clones the repository into the install folder at the release tag.
6. **Dependencies and build**: `npm ci`, then the build.
7. **Config and install marker**: writes a default `config.json` in the data dir (an existing file is kept) and the `.cr-install` marker that marks the folder as a managed install (see Updates).
8. **Startup shortcut and `cr` command**: a shortcut in your Startup folder, and `cr` shims in `~/.local/bin` or `~/bin`. No PATH or registry changes.
9. **Video toolchain**: installs the HyperFrames skills (`npx skills add heygen-com/hyperframes`), the Lemo-Opuscar plugin (`lemo-opuscar@lemolab`), and generates the Lemo styles file. Failures here are warnings, not errors.
10. **Start server**: starts the server hidden on the chosen port, waits until it answers, and opens it in your browser.

A summary table at the end lists which steps were done, skipped or failed.

## First run

The browser opens at `http://127.0.0.1:8790`. On first run, the **Setup / ตรวจเครื่อง** panel checks the machine and shows a fix command for every failing row:

- Node.js version; `claude` on PATH and signed in.
- Claude in Chrome reachable (best effort).
- ffmpeg and ffprobe.
- HyperFrames skills, the Lemo plugin and the Lemo styles file.
- ElevenLabs key set.
- Data dir writable.

The same checks run from the terminal with `npm run doctor`, and over HTTP at `GET /api/doctor`.

The **Settings** page edits the same `config.json` described under Settings and environment variables below.

## Clip Studio setup

Clip Studio turns a brief into a video project. Voice-over needs an ElevenLabs API key.

- Set the key in **Settings**, or set the environment variable `ELEVENLABS_API_KEY` before the server starts.
- A key set in Settings is stored encrypted with Windows DPAPI for your Windows user, in `<dataDir>/secrets.dpapi.json`. It is never stored as plain text or written to a log. The UI only shows "set" or "not set".
- Clip jobs receive the key only through the environment of their own child process (`ELEVENLABS_API_KEY`). It is never written into the brief or into a file.
- **No render without an order.** A clip job stops at "ready to render". It renders only when you start the render yourself.

## Updates

The server checks GitHub for the latest release (`releases/latest` on the repository) when it starts and then every 6 hours, if `update.check` is on (the default). A failed check is silent; the last good result is kept.

Update a managed install from the terminal:

```powershell
cr update --latest                 # newest release tag
cr update --tag v0.2.0             # a specific tag
cr update --latest --skills        # also update the HyperFrames skills and the Lemo plugin
cr update --latest --dry-run       # print the plan, change nothing
```

`cr update` does not need the server to be running. The updater (`scripts/update.mjs`) does the following:

1. Refuses unless the folder carries the `.cr-install` marker and is a clean git checkout. A git checkout that you cloned yourself is never touched.
2. Fetches the tags, checks out the release tag, runs `npm ci` and the build, and regenerates the Lemo styles file.
3. Stops the server by its exact process ID, starts it hidden again, and checks that `/` answers.
4. If the new version fails the health check, rolls back to the previous commit (dependencies, build, restart) and reports it.

Exit codes: `0` updated, `2` refused or bad arguments, `3` failed (rolled back, or nothing changed), `4` rollback failed (recover by hand, using the log). Progress goes to `<dataDir>/update.log`. Jobs that were running come back after the restart through auto-resume.

The UI banner ("new version available", with Update now or Update when idle) belongs to the same update feature. An update waits while a job is busy, waiting for an answer, or a clip is generating.

## Settings and environment variables

Settings live in `<dataDir>/config.json`. A missing file means defaults. A file that cannot be read or parsed means defaults plus a warning in the log; the server never crashes on a bad config.

```json
{
  "language": "auto",
  "port": null,
  "galleryRoots": [],
  "videosDir": null,
  "extraCwds": [],
  "voices": [],
  "update": { "check": true, "channel": "stable" }
}
```

| Config field | Meaning | Default |
|---|---|---|
| `language` | `th`, `en` or `auto` (follow the browser) | `auto` |
| `port` | Server port, 1-65535 | `8790` |
| `galleryRoots` | Folders scanned by the gallery | `~/videos` |
| `videosDir` | Folder for clip projects | `~/videos` |
| `extraCwds` | Extra folders a session may start in | none |
| `voices` | Extra ElevenLabs voices `{id, name}` offered in Clip Studio | a few ElevenLabs premade voices |
| `update.check` | Check GitHub for new releases | `true` |
| `update.channel` | Release channel | `stable` |

Environment variables always win over the file, so a launcher can pin a value without editing it.

| Environment variable | Overrides | Purpose |
|---|---|---|
| `CR_PORT` (or `PORT`) | `port` | Server port |
| `CR_DATA_DIR` | | Data folder (default `~/.claude-control-room`) |
| `CR_GALLERY_ROOTS` | `galleryRoots` | Gallery folders, separated by the OS path separator |
| `CR_VIDEOS_DIR` | `videosDir` | Clip projects folder |
| `CR_EXTRA_CWDS` | `extraCwds` | Extra allowed start folders |
| `ELEVENLABS_API_KEY` | Settings key | ElevenLabs key (first in the secret order) |
| `CR_NO_AUTORESUME` | | `1` = do not bring back Runner jobs on start |
| `CR_NO_SUMMARY` | | `1` = turn off the Haiku worklog summariser |
| `CR_CLAUDE_BIN` | | Path to the `claude` executable |
| `CR_NO_CHROME` | | `1` = do not pass `--chrome` to sessions |
| `CR_LEMO_DIR` | | Lemo-Opuscar library folder for the styles generator (default `~/lemo-opuscar`) |
| `CR_LEMO_FILE` | | Read the Lemo styles from this file |
| `CR_UPDATE_URL` | | Replace the release-check URL (for testing) |

Secrets are looked up in this order: environment variable, then the DPAPI store (`secrets.dpapi.json`), then the `secrets` command-line tool if it is on PATH. Values are never written to logs, prompts, URLs, or any file other than the DPAPI store.

Your own Clip Studio styles go in `<dataDir>/our-styles.json`: a JSON array of entries with `id`, `name`, `note`, `sourceDir`, `workflowFiles`, `extraRules`, `renders` and `alt`. Malformed entries are skipped.

## Using the web UI and the `cr` command

- Sessions started from the web UI ask for permission on every action. There is no "skip permissions" mode in the web UI.
- A session run by the Control Room can be answered from the web or from the terminal. Whoever answers first wins.
- A session you started in your own terminal is shown read-only. To take it over, use `cr takeover <id>` or the takeover button. That closes the one `claude` process, but only when the session is idle, and resumes the session under the Control Room.

```
cr                          list sessions (--all includes finished ones)
cr new "prompt"             start a session in the current folder and attach  [--cwd DIR] [--model M] [--effort E] [--no-attach]
cr attach <id>              attach to a session; typed text is sent to it
cr resume <sessionId>       bring an old session under the Control Room, then attach
cr takeover <id> [-y]       take over an idle session from your terminal (-y skips the question)
cr update ...               see Updates
```

Inside `cr attach`: a number answers a question or permission request (the last number is "other", typed in full). `/stop`, `/close`, `/detach` (or Ctrl+C), `/skip` and `/help` do what they say. Session ids need at least 4 characters.

Sessions started by the Runner are remembered in SQLite. On start the server resumes up to 8 of them, most recent first, unless `CR_NO_AUTORESUME=1`.

## Development

```
npm ci
npm run dev        # server on 8790 and Vite on 5173 with hot reload; open http://127.0.0.1:5173
npm run build      # build the server (tsc), the web app and the cli
npm run start      # production mode: one Node server serving web/dist on http://127.0.0.1:8790
npm test           # tests for the server, web and cli
npm run doctor     # the environment checks, printed to the terminal
```

`npm run start` needs `npm run build` first. `npm run dev` runs the server under `tsx watch`: when a file in `server/src` changes, the server restarts, and any session work running at that moment is cut off.

A git checkout run from source is a development install. `cr update` refuses to touch it.

## Remote agents (optional)

A second machine can run the Control Room in agent mode (`npm run start:agent`, or `CR_MODE=agent`). It runs only the watcher, the runner and the saved sessions, listens on `127.0.0.1:8791` (`CR_AGENT_PORT`), and requires a token header on its WebSocket. The agent stores only a SHA-256 hash of the token. The main machine reaches it through an SSH tunnel and reads the token from the `CR_AGENT_TOKEN_<MACHINEID>` environment variable. Sessions on a remote machine appear under that machine's node in the graph. `scripts/install-remote.mjs` installs an agent (`--dry-run` shows the plan). Sub-agent history, links between machines and Clip Studio do not work on remote machines yet.

## Data and privacy

Everything is stored under the data dir: `~/.claude-control-room`, unless `CR_DATA_DIR` is set.

| File or folder | Contents |
|---|---|
| `control-room.db` | Worklog, voice settings, clip jobs, saved sessions and Runner jobs (SQLite) |
| `config.json` | Non-secret settings |
| `secrets.dpapi.json` | Secrets encrypted with DPAPI for your Windows user (only if you set one in Settings) |
| `commands.log` | Who sent which command and when. Prompt text is not recorded. |
| `server.log` | Server start messages. Above 5 MB a new file is started. |
| `update.log` | Updater progress |
| `stills/`, `voice-cache/`, `summarizer/` | Clip stills, cached voice previews, and the scratch folder of the Haiku summariser |
| `our-styles.json`, `lemo-styles.json` | Clip style definitions |
| `agent-token.sha256` | Remote agent only: the hash of its token |

Outbound network traffic from this app is limited to:

- **Claude Code itself**: sessions talk to Anthropic exactly as they do when you run Claude Code by hand.
- **Update check**: a request to `api.github.com` for the latest release. It sends no account or personal data. Turn it off with `update.check: false`.
- **ElevenLabs**: only when you preview a voice or generate voice-over in Clip Studio, using your key.
- **Install and update**: winget, GitHub and npm, plus the HyperFrames and Lemo plugin installs.

There is no telemetry and no analytics.

## Uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1 [-InstallDir <dir>] [-Purge] [-Yes] [-DryRun]
```

It stops the server (the process that owns the port), removes the Startup shortcut and the `cr` shims, and deletes the app folder. It is refused unless the folder carries the `.cr-install` marker, so a development checkout is never deleted. The data dir is kept unless you pass `-Purge`, which deletes it as well.

## License

MIT. See [LICENSE](LICENSE).

## Contributing and maintainers

Issues and pull requests are welcome.

Maintainers: `scripts/release.mjs <X.Y.Z>` builds the scrubbed public snapshot. It is a dry run by default. With `--apply` it bumps the versions, adds a changelog entry, and commits and tags the snapshot in the public repository. It never pushes and never creates the GitHub release; it prints those commands for you to run.
