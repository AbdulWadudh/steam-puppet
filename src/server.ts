import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IPty } from "node-pty";
import { findLastSuccess, openDownloadsDb, recordAttempt } from "./db";
import {
	appendToBuffer,
	binDir,
	explainDownloadFailure,
	patterns,
	readCachedAccounts,
	spawnSteamCmd,
} from "./steamcmd";

// SteamPuppet backend: one HTTP job at a time, driven by a SteamCMD PTY.
//
// Plain HTTP rather than a WebSocket because Tampermonkey runs on Steam's https
// pages, and a browser blocks ws:// from https as mixed content. The userscript
// reaches this through GM_xmlhttpRequest, which is exempt from that and from
// CORS, so the client polls instead of being pushed to.

// Protocol version. Moves together with the /api/v1 path prefix.
const PROTOCOL_VERSION = 1;
const API_PREFIX = "/api/v1";

// Fail loud at startup rather than halfway through a download.
const modTargetDir = process.env.MOD_TARGET_DIR;
const port = Number(process.env.WS_PORT ?? 8090);

// setup.ts already cached a token under an account name, so STEAM_USERNAME is
// only needed to pick a side when more than one account is cached.
const cachedAccounts = await readCachedAccounts();
const resolvedUsername = process.env.STEAM_USERNAME ?? cachedAccounts[0];

if (!resolvedUsername) {
	console.error(
		"No cached Steam account found in bin/config/config.vdf. Run: bun run setup",
	);
	process.exit(1);
}
if (!process.env.STEAM_USERNAME && cachedAccounts.length > 1) {
	console.error(
		`Several accounts are cached (${cachedAccounts.join(", ")}). Set STEAM_USERNAME to choose one.`,
	);
	process.exit(1);
}
if (
	process.env.STEAM_USERNAME &&
	cachedAccounts.length > 0 &&
	!cachedAccounts.includes(resolvedUsername)
) {
	console.error(
		`No cached token for "${resolvedUsername}". Cached: ${cachedAccounts.join(", ")}. Run: bun run setup`,
	);
	process.exit(1);
}
if (!modTargetDir) {
	console.error("MOD_TARGET_DIR is not set. Copy .env.example to .env.");
	process.exit(1);
}
// Narrowing above does not survive into the closures that use it.
const username: string = resolvedUsername;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
	console.error(`WS_PORT must be a port number, got "${process.env.WS_PORT}".`);
	process.exit(1);
}

type Status =
	| "ACCEPTED"
	| "DOWNLOADING"
	| "AUTH_REQUIRED"
	| "PACKAGING"
	| "DONE"
	| "ERROR";

// Only one job ever exists: two SteamCMD processes fight over the same files.
type Job = {
	id: string;
	pty: IPty;
	appId: string;
	modId: string;
	title: string;
	version: string | null;
	buffer: string;
	isSettled: boolean;
};

const db = openDownloadsDb();

let activeJob: Job | null = null;

// The last state stays readable after the job ends so a poll that arrives after
// DONE still sees the outcome instead of "no job".
let jobState: { id: string; status: Status; msg?: string } | null = null;

function send(job: Job, status: Status, msg?: string): void {
	jobState = { id: job.id, status, msg };
}

// Fail-fast: every exit path goes through here, so the PTY is never orphaned.
function settle(job: Job, status: Status, msg?: string): void {
	if (job.isSettled) return;
	job.isSettled = true;
	send(job, status, msg);

	if (status === "DONE" || status === "ERROR") {
		// settle() is already the catch handler for packModFiles, so a throw here
		// would re-enter it, hit the isSettled guard and vanish. History is not
		// worth losing a finished download over - report it and carry on.
		try {
			recordAttempt(db, {
				appId: job.appId,
				modId: job.modId,
				title: job.title,
				version: job.version,
				path: status === "DONE" ? (msg ?? null) : null,
				status,
				message: status === "ERROR" ? (msg ?? null) : null,
			});
		} catch (error) {
			console.error(`Could not record download history: ${error}`);
		}
	}

	try {
		job.pty.kill();
	} catch {
		// Already dead after +quit; nothing to clean up.
	}

	if (activeJob === job) activeJob = null;
}

// Keeps a folder name safe for the filesystem and for a .mod path= line.
function sanitizeTitle(title: string): string {
	return title
		.replace(/[^a-zA-Z0-9 _-]/g, "")
		.trim()
		.replace(/\s+/g, "_");
}

// supported_version doubles as the vault's version folder, so it has to survive
// being a Windows path segment: 1.14.* becomes 1.14.x.
function sanitizeVersion(raw: string): string {
	const declared = raw.match(
		/^[ \t]*supported_version[ \t]*=[ \t]*"([^"]*)"/m,
	)?.[1];

	const cleaned = (declared ?? "")
		.replace(/\*/g, "x")
		.replace(/[\\/:?"<>|]/g, "")
		.replace(/[\s.]+$/, "")
		.trim();

	return cleaned || "unknown_version";
}

// Rewrites the first archive=/path= line in place and drops any duplicates.
function rewriteDescriptor(raw: string, sanitizedTitle: string): string {
	const pathLine = `path="mod/${sanitizedTitle}"`;
	const isLocationLine = (line: string) =>
		/^[ \t]*(?:archive|path)[ \t]*=/.test(line);

	let hasLocation = false;
	const lines: string[] = [];

	for (const line of raw.split(/\r?\n/)) {
		if (!isLocationLine(line)) {
			lines.push(line);
			continue;
		}
		if (hasLocation) continue;
		hasLocation = true;
		lines.push(pathLine);
	}

	if (!hasLocation) {
		while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
			lines.pop();
		}
		lines.push(pathLine);
	}

	return `${lines.join("\n")}\n`;
}

// Cross-device rename fails with EXDEV, so fall back to copy-then-delete.
async function movePath(source: string, destination: string): Promise<void> {
	try {
		await rename(source, destination);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		await cp(source, destination, { recursive: true });
		await rm(source, { recursive: true, force: true });
	}
}

async function packModFiles(job: Job): Promise<void> {
	send(job, "PACKAGING");

	const sanitizedTitle = sanitizeTitle(job.title);
	if (!sanitizedTitle)
		throw new Error(`Title "${job.title}" sanitized to empty`);

	const source = join(
		binDir,
		"steamapps",
		"workshop",
		"content",
		job.appId,
		job.modId,
	);

	// Read before moving: the version decides where the move is going.
	const descriptorPath = join(source, "descriptor.mod");
	if (!(await Bun.file(descriptorPath).exists())) {
		throw new Error(`No descriptor.mod under ${source}`);
	}
	const raw = await readFile(descriptorPath, "utf8");

	// <target>/<Title>/<Version>/<Title>, with <Title>.mod beside the folder.
	const sanitizedVersion = sanitizeVersion(raw);
	job.version = sanitizedVersion;
	const vaultPath = join(
		modTargetDir as string,
		sanitizedTitle,
		sanitizedVersion,
	);
	const modPath = join(vaultPath, sanitizedTitle);

	await mkdir(vaultPath, { recursive: true });

	// A previous pack of the same title and version would fail the rename.
	await rm(modPath, { recursive: true, force: true });
	await movePath(source, modPath);

	await writeFile(
		join(vaultPath, `${sanitizedTitle}.mod`),
		rewriteDescriptor(raw, sanitizedTitle),
		"utf8",
	);

	// The content just moved to the vault, but SteamCMD still records it as
	// installed here. Steam reuses chunks between Workshop items of the same
	// game, so the next download of a mod that shares files tries to read from
	// the files we took away and dies with "Missing game files". Nothing stays
	// installed under ./bin, so the record never describes anything real.
	await rm(
		join(binDir, "steamapps", "workshop", `appworkshop_${job.appId}.acf`),
		{
			force: true,
		},
	);

	settle(job, "DONE", vaultPath);
}

function downloadMod(
	id: string,
	appId: string,
	modId: string,
	title: string,
): void {
	const pty: IPty = spawnSteamCmd([
		"+login",
		username,
		"+workshop_download_item",
		appId,
		modId,
		"+quit",
	]);

	const job: Job = {
		id,
		version: null,
		pty,
		appId,
		modId,
		title,
		buffer: "",
		isSettled: false,
	};
	activeJob = job;

	send(job, "DOWNLOADING");

	pty.onData((chunk) => {
		process.stdout.write(chunk);
		// Prompts arrive split across chunks, so match an accumulated buffer.
		job.buffer = appendToBuffer(job.buffer, chunk);

		if (/Steam Guard code\s*:\s*$/i.test(job.buffer)) {
			job.buffer = "";
			send(job, "AUTH_REQUIRED");
			return;
		}

		if (patterns.badPassword.test(job.buffer)) {
			settle(job, "ERROR", "Auth failed");
			return;
		}

		// No cached token means SteamCMD sits at "password:" forever: no password
		// is ever sent here by design, so fail instead of hanging.
		if (patterns.password.test(job.buffer)) {
			settle(job, "ERROR", "No cached credentials - run: bun run setup");
			return;
		}

		if (patterns.downloaded.test(job.buffer)) {
			job.buffer = "";
			packModFiles(job).catch((error) =>
				settle(job, "ERROR", `Packaging failed: ${error}`),
			);
			return;
		}

		// Catches download refusals that never reach the success line.
		const failure = job.buffer.match(patterns.downloadFailed);
		if (failure) {
			settle(
				job,
				"ERROR",
				failure[1] ? explainDownloadFailure(failure[1]) : "Download failed",
			);
		}
	});

	pty.onExit(({ exitCode }) => {
		// A clean +quit before DONE means the mod never landed.
		if (!job.isSettled) {
			settle(job, "ERROR", `SteamCMD exited with code ${exitCode}`);
		}
	});
}

function json(body: unknown, status = 200): Response {
	return Response.json(
		{ v: PROTOCOL_VERSION, ...(body as object) },
		{ status },
	);
}

async function startJob(request: Request): Promise<Response> {
	let payload: Record<string, unknown>;
	try {
		payload = (await request.json()) as Record<string, unknown>;
	} catch {
		return json({ error: "Malformed JSON" }, 400);
	}

	if (payload.v !== undefined && payload.v !== PROTOCOL_VERSION) {
		return json({ error: `Unsupported protocol version ${payload.v}` }, 400);
	}

	if (activeJob) return json({ error: "A download is already running" }, 409);

	const appId = String(payload.appId ?? "").trim();
	const modId = String(payload.modId ?? "").trim();
	const title = String(payload.title ?? "").trim();

	// Both ids go straight into a SteamCMD argv and a filesystem path.
	if (!/^\d+$/.test(appId) || !/^\d+$/.test(modId)) {
		return json({ error: "appId and modId must be numeric" }, 400);
	}
	if (!title) return json({ error: "title is required" }, 400);

	// A Workshop item can be updated after you downloaded it, so a repeat is
	// never blocked outright - the client re-sends with force to confirm.
	if (payload.force !== true) {
		const previous = findLastSuccess(db, appId, modId);
		if (previous) {
			return json({
				status: "DUPLICATE",
				title: previous.title,
				version: previous.version,
				path: previous.path,
				downloadedAt: previous.createdAt,
			});
		}
	}

	const id = crypto.randomUUID();
	downloadMod(id, appId, modId, title);
	return json({ id, status: "ACCEPTED", msg: title });
}

async function submitAuthCode(request: Request): Promise<Response> {
	let payload: Record<string, unknown>;
	try {
		payload = (await request.json()) as Record<string, unknown>;
	} catch {
		return json({ error: "Malformed JSON" }, 400);
	}

	if (!activeJob) return json({ error: "No download is running" }, 409);

	const code = String(payload.code ?? "").trim();
	if (!code) {
		settle(activeJob, "ERROR", "Empty Steam Guard code");
		return json({ error: "Empty Steam Guard code" }, 400);
	}

	activeJob.pty.write(
		`${code}
`,
	);
	return json({ id: activeJob.id, status: "DOWNLOADING" });
}

const server = Bun.serve({
	port,
	async fetch(request) {
		const { pathname } = new URL(request.url);

		if (pathname === "/health") return new Response("ok");

		if (pathname === `${API_PREFIX}/jobs` && request.method === "POST") {
			return startJob(request);
		}
		if (pathname === `${API_PREFIX}/jobs/current` && request.method === "GET") {
			return jobState ? json(jobState) : json({ status: "IDLE" });
		}
		if (
			pathname === `${API_PREFIX}/jobs/current/auth` &&
			request.method === "POST"
		) {
			return submitAuthCode(request);
		}

		return json({ error: `No route for ${request.method} ${pathname}` }, 404);
	},
});

console.log(
	`SteamPuppet listening on http://localhost:${server.port}${API_PREFIX}`,
);
console.log(`Account: ${username}`);
console.log(`Mods land in: ${modTargetDir}`);
