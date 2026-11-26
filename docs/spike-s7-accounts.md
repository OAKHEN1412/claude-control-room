# Spike S7 — per-job Claude accounts (2026-11-26)

Scripts: `spikes/s7/`. Claude Code 2.1.332, Windows 11. Token values were never printed; captured tokens were DPAPI-encrypted to a scratch folder and only fingerprints were shown.

| # | Question | Result |
|---|---|---|
| S7c | Can the server run `claude setup-token` and capture the token itself? | **YES, only inside a pseudo-console.** With piped stdio (no TTY) it prints nothing, opens no browser and never finishes. Inside ConPTY (`@lydell/node-pty`) it opens the browser, and once the user approves it prints the token. If claude.ai is already signed in, the browser approves at once. |
| S7c-capture | How to read the token off the screen | Rendering the raw PTY stream by hand is wrong: Ink moves the cursor instead of printing spaces, and gluing lines produced a 130-char string that gave 401. Rendering through `@xterm/headless` and reading the screen buffer gives the correct 108-char token (ends `AA`). |
| S7a | Does `CLAUDE_CODE_OAUTH_TOKEN` in the child env override the stored login? | **YES.** A wrong token gives `401 OAuth access token is invalid` instead of falling back to `~/.claude/.credentials.json`. `claude auth status --json` reports `authMethod: oauth_token`. |
| S7b | Does the Bash tool (subprocesses) see the token? | **NO, without extra settings.** A probe run by the Bash tool found no `CLAUDE_CODE_OAUTH_TOKEN` and no value containing `sk-ant-` (Claude Code strips its own credential vars from child envs, list `Z5e` in the binary). |
| — | `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` | Not needed. It also forces permission mode to `default` (no bypass), which conflicts with our bypass decision. Do not use it. |
| — | `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` | **Rejected.** On Windows, a run with nothing written to fd 3 still succeeded: it silently falls back to the stored login, so you cannot tell which account ran. (It would only write the token to disk under `CLAUDE_CODE_REMOTE`.) |
| — | Which account does a token belong to? | **Cannot be read.** `GET /api/oauth/profile` → 403 (the setup-token token has the inference scope only); `auth status` shows no email/org; a token session writes no `session-owner` line in its transcript (a login session does). |
| — | Usage per token | `rate_limit_event` arrives in the stream-json of a token-run job (`utilization`, `resetsAt`, `rateLimitType`) — per-profile usage works. |

## Consequences for the build
- Pass the token as `CLAUDE_CODE_OAUTH_TOKEN` in that child's env only (after `childEnv()` strips `CLAUDE*`; also drop `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`).
- "Connect account" = server-side ConPTY + `@xterm/headless` running `claude setup-token`; paste field as fallback when the PTY cannot start.
- The profile cannot show email or plan automatically. The user names the profile and may type a note; we show fingerprint, the check result (a no-tool haiku call) and the latest `rate_limit_event`.
- Duplicate account detection is impossible (different tokens of one account look unrelated).
- node-pty prints `AttachConsole failed` from `conpty_console_list_agent.js` when the PTY is killed — harmless, but run it so that the stderr does not reach the UI.

## S8 - `claude auth login` in a pty (2026-11-26)

Result of a live check on Windows (ConPTY), used to build `server/src/mainAccount.ts`.

| Fact | Observed |
|---|---|
| Login command | `claude auth login --claudeai` works inside ConPTY, read with the same node-pty + xterm screen model as the setup-token capture |
| Screen, step 1 | `Opening browser to sign in…` |
| Screen, step 2 | `If the browser didn't open, visit:` followed by an `https://claude.ai/oauth/authorize?…` URL |
| Screen, step 3 | `Paste code here if prompted >` (input typed into the pty goes to the prompt) |
| End | `Login successful.` and exit code 0 |
| Token storage | The CLI writes `.credentials.json` and `.claude.json` in the config dir itself. We never see or store a token for the main account |
| Status | `claude auth status --json` gives `loggedIn`, `authMethod` (`claude.ai`), `email`, `orgName`, `subscriptionType` (e.g. `max`), `loginExpiresAt`. Logged out: `loggedIn` false, `authMethod` `none` |
| Env | `childEnv()` strips `CLAUDE*` variables, so the pty writes the real default config dir. Tests use fakes only |

Consequences:

- The main account is the machine login shared with a terminal `claude`. Its optional password gates only the app, because the credentials file is plaintext on disk.
- Token-profile passwords use scrypt + AES-256-GCM envelopes (`server/src/accountCrypto.ts`), stored in the DPAPI store under `account:<id>`.
- Forgot app lock: stop the server and delete the `appLock` key from `config.json` in the data dir. The app then opens without a password.
