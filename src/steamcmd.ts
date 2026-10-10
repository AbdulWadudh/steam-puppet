import { join } from "node:path";
import { type IPty, spawn as spawnPty } from "node-pty";

// Everything about talking to the SteamCMD binary, shared by setup and server.

export const isWindows = process.platform === "win32";
export const binDir = join(process.cwd(), "bin");
export const binaryPath = join(
	binDir,
	isWindows ? "steamcmd.exe" : "steamcmd.sh",
);

const ESC = "\u001b";
const BEL = "\u0007";

// Constructor rather than a literal so the control bytes stay named.
const ansiSequence = new RegExp(
	`${ESC}\\[[0-9;?]*[a-zA-Z]|${ESC}\\].*?${BEL}`,
	"g",
);

export function stripAnsi(text: string): string {
	return text.replace(ansiSequence, "");
}

// SteamCMD's output vocabulary. Test against stripAnsi'd text, never raw.
export const patterns = {
	ready: /Steam>\s*$/,
	password: /password\s*:\s*$/i,
	steamGuard: /(Steam Guard code|Two-factor code)\s*:\s*$/i,
	loggedIn: /(Waiting for user info\.\.\.\s*OK|Logged in OK)/i,
	loginFailed: /FAILED\s*\(?([^)\r\n]*)\)?/i,
	badPassword: /FAILED\s*\(Invalid Password\)/i,
	downloaded: /Success\.\s*Downloaded item/i,
	downloadFailed: /ERROR!\s*Download item[^\r\n]*failed\s*\(([^)]*)\)/i,
};

// SteamCMD's reasons are one word and say nothing about what to do next.
const DOWNLOAD_FAILURES: Record<string, string> = {
	failure:
		"Steam could not complete the download - see bin/logs/workshop_log.txt for the reason",
	"file not found": "No such Workshop item for this game",
	timeout: "Steam timed out - try again",
	"disk full": "Not enough disk space",
	"access denied": "Steam denied access - the account may not own this game",
};

export function explainDownloadFailure(reason: string): string {
	const known = DOWNLOAD_FAILURES[reason.trim().toLowerCase()];
	return known ? `${known} (${reason.trim()})` : reason.trim();
}

// Prompts arrive split across chunks, so matching needs an accumulated tail.
export const BUFFER_LIMIT = 4000;

export function appendToBuffer(buffer: string, chunk: string): string {
	return stripAnsi(buffer + chunk).slice(-BUFFER_LIMIT);
}

// config.vdf keys each cached token by account name, so the name setup.ts
// logged in with is recoverable instead of being repeated in .env.
export function parseAccounts(raw: string): string[] {
	const start = raw.indexOf('"Accounts"');
	if (start === -1) return [];

	const open = raw.indexOf("{", start);
	if (open === -1) return [];

	// Walk to the matching brace; each account is its own nested block.
	let depth = 0;
	let close = -1;
	for (let i = open; i < raw.length; i++) {
		if (raw[i] === "{") depth++;
		else if (raw[i] === "}" && --depth === 0) {
			close = i;
			break;
		}
	}
	if (close === -1) return [];

	// A name is a key followed by a block; "SteamID" "7656..." pairs are not.
	const names = raw.slice(open + 1, close).matchAll(/"([^"]+)"\s*\{/g);
	return [...names].map((match) => match[1] as string);
}

export async function readCachedAccounts(): Promise<string[]> {
	const file = Bun.file(join(binDir, "config", "config.vdf"));
	if (!(await file.exists())) return [];
	return parseAccounts(await file.text());
}

export function spawnSteamCmd(args: string[]): IPty {
	return spawnPty(binaryPath, args, {
		name: "xterm-color",
		cols: 120,
		rows: 30,
		cwd: binDir,
		env: process.env as Record<string, string>,
		// ConPTY children die at launch under Bun on Windows; winpty works.
		useConpty: false,
	});
}
