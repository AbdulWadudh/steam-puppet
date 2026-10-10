# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-10

First working version: a Download button on any Steam Workshop item page that
drives a local SteamCMD and files the result into a versioned mod vault.

### Added

- **One-time setup** (`src/setup.ts`) — downloads SteamCMD for the host platform,
  extracts it into `./bin`, and runs the first login through a pseudo-terminal so
  SteamCMD caches a token. No password is ever written to disk, argv or config.
- **HTTP API** (`src/server.ts`) — versioned at `/api/v1`, one download at a time.
  `POST /jobs` starts a job, `GET /jobs/current` is the poll, and
  `POST /jobs/current/auth` passes a Steam Guard code through to the PTY.
- **Mod vault** — downloads are packed into
  `MOD_TARGET_DIR/<Title>/<Version>/<Title>` with a generated `<Title>.mod`
  beside them. `supported_version` becomes the version folder (`1.14.*` →
  `1.14.x`), and any `archive=` or `path=` line in the descriptor is replaced
  with `path="mod/<Title>"`, appended when neither is present.
- **Account auto-detection** — the logged-in account is read from SteamCMD's own
  `config.vdf`, so `STEAM_USERNAME` is only needed to disambiguate when several
  accounts are cached.
- **Download history** (`src/db.ts`) — every finished attempt, success or
  failure, is recorded in SQLite at `db/steampuppet.db` via Bun's built-in
  driver.
- **Duplicate consent** — downloading a mod that has a previous success returns
  `DUPLICATE` instead of starting. The userscript asks with explicit
  **Re-download** / **Cancel** actions and keeps the button locked until you
  choose, so an accidental double-click cannot start a repeat. Repeats are
  offered rather than blocked, because a Workshop item can be updated.
- **Userscript** (`src/client.js`) — a Download button matching Steam's own
  Subscribe button in class, width and layout, with toastr notifications whose
  position is configurable via `TOAST_POSITION`.
- **Windows launcher** (`start.bat`) — checks Bun, installs dependencies,
  creates `.env`, runs setup if SteamCMD is missing, then starts the server.
- **Assertion suite** (`src/test-prompts.ts`) — covers the SteamCMD output
  patterns, `config.vdf` account parsing, and the download history queries.

### Notes on implementation

Choices below were forced by things that only showed up when run against a real
browser and a real SteamCMD, and are recorded so they are not "simplified" away
later.

- **PTY transport uses winpty on Windows.** `node-pty`'s ConPTY backend starts
  and immediately kills its child under Bun on Windows
  (`STATUS_CONTROL_C_EXIT`, no output). `useConpty: false` is required there and
  is ignored elsewhere.
- **The browser talks to the server over `GM_xmlhttpRequest`, not `fetch` or a
  WebSocket.** Steam pages are HTTPS, so a `ws://` or `http://` connection is
  blocked as mixed content, and Steam's CSP `connect-src` does not list this
  server either. `GM_xmlhttpRequest` runs in the extension context and is exempt
  from both, as is `@require`, which is how toastr loads despite Steam's
  `script-src`.
- **A missing cached token is a fast failure.** With no token SteamCMD prints
  `password:` and waits forever; since no password is ever sent, that prompt
  ends the job with a readable error instead of hanging.
- **Toast width and alignment are pinned.** toastr's 300px card wraps short
  sentences, and the host page's `text-align` is otherwise inherited into the
  toast.

[Unreleased]: https://github.com/steampuppet/steam-puppet/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/steampuppet/steam-puppet/releases/tag/v0.1.0
