# SteamPuppet

Download Steam Workshop mods straight from the Workshop page, without the Steam
client, and have them filed into a tidy versioned folder ready for the game.

A **Download** button appears next to Subscribe. Click it, and a local server
drives [SteamCMD](https://developer.valvesoftware.com/wiki/SteamCMD) through a
pseudo-terminal, downloads the item, and packs it into a mod folder with a
generated `.mod` descriptor.

---

## Features

- **One-click downloads** — a native-looking Download button on every Workshop item page.
- **No password stored anywhere** — you log in once, interactively; SteamCMD caches a token and the password is never written to disk, argv, or config.
- **Account auto-detected** — the server reads the logged-in account from SteamCMD's own `config.vdf`, so there is nothing to configure.
- **Steam Guard handled** — if Steam asks for a code, the page prompts you and passes it through.
- **Versioned mod vault** — mods are filed as `<Title>/<Version>/<Title>` with a matching `.mod` beside them.
- **Descriptor rewriting** — the generated `.mod` gets a correct `path="mod/<Title>"` line, replacing any `archive=` or `path=` the author shipped.
- **Toast notifications** — [toastr](https://codeseven.github.io/toastr/) cards in the corner, updating in place rather than on the button.
- **Download history** — every attempt is logged to a local SQLite database, successes and failures alike.
- **Duplicate consent** — downloading a mod you already have asks first, with explicit **Re-download** / **Cancel** actions in the toast. The button stays locked until you choose, so a stray double-click cannot start one.
- **Zero idle cost** — nothing connects or polls until you actually click Download.
- **One job at a time** — concurrent downloads are refused, so two SteamCMD processes never fight over the same files.
- **Fails fast and loudly** — a missing token, a bad Steam Guard code, or a dead download ends the job with a readable reason instead of hanging.

---

## How it works

```
Workshop page  ──(GM_xmlhttpRequest)──>  localhost:8090  ──(PTY)──>  SteamCMD
  Tampermonkey                              Bun server                  |
       ^                                        |                       v
       └──────────── poll job status ───────────┘              bin/steamapps/...
                                                                        |
                                                  pack + rewrite descriptor
                                                                        v
                                               MOD_TARGET_DIR/<Title>/<Version>/
```

The userscript talks to the server with Tampermonkey's `GM_xmlhttpRequest`
rather than `fetch` or a WebSocket. Two separate browser rules block the direct
route from a Steam page:

- **Mixed content** — an HTTPS page may not open `http://` or `ws://` connections.
- **Steam's CSP** — `connect-src` does not list this server, so even same-scheme
  requests would be refused.

`GM_xmlhttpRequest` runs in the extension context and is exempt from both, as is
`@require`, which is why toastr loads despite Steam's `script-src`.

---

## Requirements

| What | Why | Link |
|---|---|---|
| [Bun](https://bun.com) 1.4+ | Runs the server and setup script | <https://bun.com> |
| [Tampermonkey](https://www.tampermonkey.net/) | Hosts the userscript | <https://www.tampermonkey.net/> |
| jQuery + [toastr](https://codeseven.github.io/toastr/) | Toast notifications | pulled automatically via `@require` |
| A Steam account that owns the game | Workshop items need an owning account | — |

SteamCMD itself is downloaded automatically — you do not need to install it.

jQuery and toastr are pulled from cdnjs by Tampermonkey's `@require` the first
time the script runs, then cached. They load into the userscript sandbox, so
they never clash with the older jQuery that Steam's own pages ship.

---

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Run the one-time Steam login

```bash
bun run setup
```

This downloads SteamCMD into `./bin`, then logs you in **interactively**:

1. Enter your Steam username.
2. Enter your password when SteamCMD asks (input is hidden).
3. Enter the Steam Guard code from your email or the Steam mobile app.

On success it prints `Setup complete` and SteamCMD writes a cached token to
`bin/config/config.vdf`. **You will not be asked for a password again** — not by
setup, not by the server.

> Re-running `bun run setup` is safe. It skips the download if SteamCMD is
> already present.

### 3. Configure

Copy the example file and set your mods folder:

```bash
cp .env.example .env
```

```ini
# Optional - only needed if several accounts are cached
# STEAM_USERNAME=your_steam_username

# Where packed mods land
MOD_TARGET_DIR=G:\GAMES\CK3_MODS

# Port the local server listens on
WS_PORT=8090
```

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MOD_TARGET_DIR` | yes | — | Created automatically if missing |
| `WS_PORT` | no | `8090` | Must match `SERVER_PORT` in the userscript |
| `STEAM_USERNAME` | no | auto | Read from `config.vdf`; only set it if more than one account is cached |

### 4. Start the server

**Windows** — double-click `start.bat`. It checks Bun, installs dependencies,
creates `.env`, runs setup if needed, then starts the server.

**Any platform:**

```bash
bun run start
```

You should see:

```
SteamPuppet listening on http://localhost:8090/api/v1
Account: your_account
Mods land in: G:\GAMES\CK3_MODS
```

Leave this window open while downloading.

### 5. Install the userscript

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Open the Tampermonkey **Dashboard** (click the extension icon → *Dashboard*).
3. Go to the **+** tab to create a new script.
4. Delete the template, paste the entire contents of [`src/client.js`](src/client.js), and press **Ctrl+S**.
5. If `WS_PORT` is not `8090`, change `SERVER_PORT` at the top of the script to match.
6. Optionally set `TOAST_POSITION` just below it — `bottom-right` (default),
   `bottom-left`, `bottom-center`, `top-right`, `top-left`, `top-center`,
   `top-full-width` or `bottom-full-width`.

Tampermonkey will ask to allow the `localhost` connection the first time — accept it.

> **Updating the script later:** if the `// ==UserScript==` header changed,
> delete the old script and paste it fresh. Tampermonkey does not grant new
> `@connect` or `@grant` permissions to an existing install.

### 6. Download a mod

1. Open any Workshop item, e.g.
   `https://steamcommunity.com/sharedfiles/filedetails/?id=3814775890`
2. Click **Download** under Subscribe.
3. Watch the button: `Starting… → Downloading… → Packaging… → Done!`

If Steam Guard is required, a prompt appears — paste the code and it continues.

---

## Where mods land

For a mod titled *Council Autopilot* with `supported_version="1.20.*"`:

```
G:\GAMES\CK3_MODS\
└── Council_Autopilot\
    └── 1.20.x\
        ├── Council_Autopilot\      <- the mod files
        │   ├── descriptor.mod
        │   ├── common\
        │   └── ...
        └── Council_Autopilot.mod   <- generated, points at the folder
```

- **Title** is stripped of anything but letters, numbers, spaces, `-` and `_`, then spaces become underscores.
- **Version** comes from `supported_version`; `*` becomes `x`, and characters Windows forbids in a folder name are removed. Missing version becomes `unknown_version`.
- The generated `.mod` is the original descriptor with any `archive=` or `path=` line replaced by `path="mod/<Title>"`, appended if neither was present.

To use a mod, copy or link the inner `<Title>` folder and its `.mod` file into
the game's own `mod` directory.

---

## Scripts

| Command | What it does |
|---|---|
| `bun run setup` | Download SteamCMD and do the one-time interactive login |
| `bun run start` | Start the server |
| `bun run dev` | Same, restarting on file changes |
| `bun run test` | Run the assertion suite |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | Biome check |
| `bun run format` | Biome check and write |
| `bun run check` | typecheck + lint + test |

---

## API

All responses carry `v: 1`.

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/health` | — | `ok` |
| `POST` | `/api/v1/jobs` | `{ appId, modId, title, force? }` | `{ id, status: "ACCEPTED" }` or `{ status: "DUPLICATE", … }` |
| `GET` | `/api/v1/jobs/current` | — | `{ id, status, msg }` |
| `POST` | `/api/v1/jobs/current/auth` | `{ code }` | `{ id, status }` |

Statuses: `IDLE`, `ACCEPTED`, `DOWNLOADING`, `AUTH_REQUIRED`, `PACKAGING`, `DONE`, `ERROR`.

`POST /jobs` returns `DUPLICATE` with `{ title, version, path, downloadedAt }`
when that item has a previous successful download. Re-send with `force: true` to
download it anyway.

The last job's state stays readable after it finishes, so a poll arriving after
`DONE` still sees the outcome.

---

## Download history

Every finished attempt is written to `db/steampuppet.db` (SQLite) — gitignored,
local to your machine, and safe to delete at any time.
Deleting it just means the next download of each mod will not warn you.

```sql
-- what did I download, newest first
SELECT title, version, path, status, created_at
FROM downloads
ORDER BY id DESC;

-- everything that failed
SELECT title, message, created_at FROM downloads WHERE status = 'ERROR';
```

Inspect it with any SQLite client, or:

```bash
bun -e 'console.table(new (require("bun:sqlite").Database)("db/steampuppet.db").query("SELECT title,version,status,created_at FROM downloads ORDER BY id DESC").all())'
```

---

## Troubleshooting

**Button says `Failed: Cannot reach SteamPuppet`**
The server is not running, or the port does not match. Check the terminal, and
confirm `SERVER_PORT` in the userscript equals `WS_PORT` in `.env`.

**No toasts appear, console says `toastr failed to load`**
Tampermonkey could not fetch the `@require` scripts. Check your connection, then
force a refetch with *Dashboard → Settings → Externals → Update*.

**Button does nothing / never appears**
Open the browser console and look for `[SteamPuppet]`. The script needs
`.workshopItemTitle` and an app id on the page; it logs what it could not find.

**`No cached credentials - run: bun run setup`**
The token expired or was never created. Re-run `bun run setup`.

**`Several accounts are cached`**
Set `STEAM_USERNAME` in `.env` to the one you want.

**`A download is already running`**
Only one job runs at a time. Wait for it to finish, or restart the server.

**The server will not start: `EADDRINUSE`**
An older instance is still holding the port. Close the other terminal, or on
Windows: `Get-Process bun | Stop-Process -Force`.

**Toast says "Already downloaded …" but the folder is gone**
The history and the folder are tracked separately. Click Download again to
confirm, and it will refetch.

**`ERROR! Download item … failed (File Not Found)`**
SteamCMD could not find that item — usually a wrong app id, or an item that is
not public.

**Steam Guard prompt appears every time**
The cached token is not being reused. Confirm `bin/config/config.vdf` exists and
that the account in it matches the one being used.

---

## Project layout

```
src/
  setup.ts          one-time SteamCMD install + interactive login
  server.ts         HTTP API, job state, download + packing
  db.ts             SQLite download history and duplicate lookup
  steamcmd.ts       shared: paths, PTY spawn, ANSI stripping, output patterns
  client.js         the Tampermonkey userscript
  test-prompts.ts   assertions for the output patterns and account parsing
db/                 SQLite download history (created on first run)
start.bat           Windows launcher
```

---

## Notes and limits

- `bin/`, `.env` and `db/` are gitignored — the cached token and your history never leave your machine.
- SteamCMD self-updates on every launch, so the first download after an idle period takes longer.
- `WS_PORT` is named after an earlier WebSocket transport; it is now simply the HTTP port.
- The server binds all interfaces. On an untrusted network, firewall the port or bind it to localhost.
