# Changelog

## [Unreleased]

## [0.3.0] - 2026-11-26

- Account profiles: run each job on a named Claude account (one long-lived `claude setup-token` token per profile), Google-style switcher in the header, per-job account chip, switch a running job and keep the conversation
- Tokens stored with Windows DPAPI, injected only into that job's process; per-profile usage rings and limit badges
- Main account: sign in to Claude Code from the web UI on first use (`claude auth login` in a pty), with email, plan and expiry on the manage page
- Optional profile passwords (AES-256-GCM, scrypt key); a locked profile asks for its password before use
- Optional 6-digit app PIN for the web UI and API (HttpOnly session cookie, escalating lockout); `cr --pin-stdin` for the CLI
- Manage page `/accounts`: add, rename, recolour, replace token, check, hide, delete, default profile
- `cr new --account <id|name>`

## [0.2.0] - 2026-11-25

- cli test: default effort is medium
- Default effort medium for jobs, high for clip (video) jobs
- Updater: stop the server before checkout/npm ci; launch it outside the server's process tree
- Scrub private names from tests and demo data; English brief uses noSubagents
- Merge: config, secret chain, doctor, installer, updater, release script, READMEs
- Setup UI strings move into i18n parts
- Merge master (i18n) into distribution branch
- Wire config/secrets/doctor/update into server; setup UI; READMEs; scrub fixtures
- Merge: Thai/English i18n (web strings, server codes, English clip brief)
- i18n: wire server codes into web display sites, i18n tests
- i18n: convert web UI strings, server codes, English clip brief
- Distribution A-C, E.3: config, secret chain, doctor, update check + updater, installer, lemo styles, release script
- i18n core: t/useT/setLanguage, part dictionaries, test setup pinned to th
- docs: distribution plan (installer, settings, updates, i18n)
- Slash menu: exact name ranks first, wider menu, full-width composer in panes
- Merge: multiline composer and / command menu
- Composer: auto-growing multiline prompt box with slash command/skill menu
- Merge: move personal data out of tracked files (our-styles.json, no seed machines)
- Remove personal data from tracked files for open-source release
- Web jobs: launch claude -p with --chrome so Claude in Chrome works
- Merge: Clip Studio ratio picker only, saved outros
- Clip Studio: keep only the ratio picker; add clip ending (outro) with saved phrases
- Queue strip: use existing tokens (waiting / error) instead of fallback colours
- Merge: queued-messages strip and send_now
- Show queued messages and add send_now (stop and send now)
- Merge: two-monitor wide window launcher and seam-aware canvas
- Wide window: open Control Room across all monitors, seam-aware v2 canvas
- Merge: usage rings (5h, weekly, context) in the header
- Top bar: 5 h / weekly quota and context rings with hover details, fed by the status line trigger files and the Runner stream
- Merge: Clip Studio presets, Enter-to-queue, generation queue, ratio frames, cropped preview
- Clip Studio: saved presets, quick queue with generation concurrency limit, true-proportion ratio frames, cropped style preview
- Question popup: the recommended option is outlined, not filled, and loses its highlight once another option is picked
- Web: 60 s timeout for takeover commands
- Merge: take over a terminal session (close its claude, adopt in bypass)
- Merge: canvas boxes keep their place (persist auto placement, no refit on change)
- Canvas: nodes keep their position; auto placement is remembered, viewport no longer refits on change
- Add takeover: one-click close of a terminal claude session and adopt it under the Runner
- Auto-resume keeps the job's own permission mode, bypassPermissions included (user decision)
- Fix step-count comment in install-remote.mjs
- Agent install: stop the recorded agent before npm ci (running agent locks esbuild.exe)
- Merge: red highlight for sessions that hit a usage limit
- Show usage/rate limit in red: timeline line, session.limit, red frame + label on cards, panes and drawer
- Remote agent token: fall back to the vault (tools/cr-agent-<id>.enc), read once, memory only
- Merge: remote agent mode, SSH-tunnelled RemoteHub, remote sessions on the canvas
- Merge: cr terminal client, open-in-terminal button, auto-resume of web jobs
- Remote agent: clearer errors, README section
- Merge: chat attachments (drop files, paste images, paperclip)
- Chat attachments, web side: drop files, paste screenshots, paperclip, chips in every send box and new-job form
- Remote agent: see and command Claude sessions on other PCs
- Terminal client cr, open-in-terminal button, auto-resume of Runner jobs after restart
- Chat attachments, server side: POST /api/upload, upload ids on send/start, image blocks in the runner, parser shows attachment names
- Merge: collision-free canvas placement, rearrange button, always ignore summarizer
- Canvas: collision-aware placement, re-arrange button, fit bounds, summarizer ignore
- Track the impeccable hook config (arrowhead false positive) so worktrees inherit it
- Derive round-3 web protocol types from shared/protocol.ts
- Merge: v2 round 3 - + AI, AI links, saved sessions widget, machines
- UI v2 round 3: + AI popover, relay link wires, saved sessions widget, remote machines on the canvas
- Merge: saved sessions + machines registry (server)
- Add saved sessions and SSH machines to the server
- Merge: v2 round 2 - pane nodes on canvas, wires, drawer, subagent view, semantic zoom
- UI v2 round 2: pane nodes on the canvas, wires, slide-out drawer, semantic zoom, shared scrollbars
- Merge: session-to-session relay (server)
- Relay: links between sessions (final answer of A forwarded to live Runner job B)
- Merge: subagent timeline endpoint
- Add subagent timeline API: GET /api/agents/<session>/<agent>/timeline
- Merge: UI v2 n8n-style canvas (v1 kept, switchable)
- UI v2: n8n-style work canvas with floating widgets, switchable with v1; terminal-style work pane
- Show Claude's whole answer and prompt in the pane, not just the first line
- Merge: close-job button
- Add close job (ปิดงาน): end a Runner job and drop it from the graph at once

## [0.1.0] - 2026-11-25

- First public-ready snapshot.
