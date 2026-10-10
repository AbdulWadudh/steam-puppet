import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { IPty } from "node-pty";
import {
	appendToBuffer,
	binaryPath,
	binDir,
	isWindows,
	patterns,
	spawnSteamCmd,
} from "./steamcmd";

// Downloads SteamCMD into ./bin if absent, then drives one interactive login
// through a PTY so SteamCMD caches its token to ./bin/config/config.vdf.

const targets = {
	win32: {
		url: "https://client-update.steamstatic.com/installer/steamcmd.zip",
		archive: "steamcmd.zip",
	},
	linux: {
		url: "https://client-update.steamstatic.com/installer/steamcmd_linux.tar.gz",
		archive: "steamcmd_linux.tar.gz",
	},
	darwin: {
		url: "https://client-update.steamstatic.com/installer/steamcmd_osx.tar.gz",
		archive: "steamcmd_osx.tar.gz",
	},
} as const;

export function resolveTarget(
	platform: string,
): (typeof targets)[keyof typeof targets] | undefined {
	return targets[platform as keyof typeof targets];
}

async function run(cmd: string[]): Promise<boolean> {
	try {
		return (
			(await Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" })
				.exited) === 0
		);
	} catch (error) {
		console.error(`Could not execute ${cmd[0]}: ${error}`);
		return false;
	}
}

async function extract(archivePath: string): Promise<void> {
	if (await run(["tar", isWindows ? "-xf" : "-xzf", archivePath, "-C", binDir]))
		return;

	if (!isWindows) {
		console.error("tar failed to extract the SteamCMD archive.");
		process.exit(1);
	}

	// Fallback for a Windows box with no tar on PATH.
	const expanded = await run([
		"powershell",
		"-NoProfile",
		"-Command",
		`Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${binDir}' -Force`,
	]);

	if (!expanded) {
		console.error(
			"Both tar and PowerShell failed to extract the SteamCMD archive.",
		);
		process.exit(1);
	}
}

async function ensureSteamCmd(): Promise<void> {
	if (await Bun.file(binaryPath).exists()) {
		console.log(
			`SteamCMD already present at ${binaryPath}, skipping download.`,
		);
		return;
	}

	const target = resolveTarget(process.platform);
	if (!target) {
		console.error(`Unsupported platform: ${process.platform}`);
		process.exit(1);
	}

	await mkdir(binDir, { recursive: true });
	const archivePath = join(binDir, target.archive);

	console.log(`Downloading ${target.url}`);
	const response = await fetch(target.url);
	if (!response.ok) {
		console.error(`Download failed: ${response.status} ${response.statusText}`);
		process.exit(1);
	}
	await Bun.write(archivePath, response);

	console.log(`Extracting into ${binDir}`);
	await extract(archivePath);
	await rm(archivePath, { force: true });

	// Some extractors drop the mode bits on the launcher script.
	if (!isWindows) await chmod(binaryPath, 0o755);

	if (!(await Bun.file(binaryPath).exists())) {
		console.error(
			`Expected ${binaryPath} after extraction, but it is missing.`,
		);
		process.exit(1);
	}
}

let isPrompting = false;
const deferredOutput: string[] = [];

// PTY output is held back while a question is on screen, or the update spinner
// overwrites it mid-keystroke.
function forward(chunk: string): void {
	if (isPrompting) deferredOutput.push(chunk);
	else process.stdout.write(chunk);
}

function flushDeferredOutput(): void {
	for (const chunk of deferredOutput.splice(0)) process.stdout.write(chunk);
}

// A fresh interface per question, closed immediately, keeps stdin clean: a
// long-lived readline would sit on the fd the PTY output races against.
async function ask(query: string, isHidden = false): Promise<string> {
	isPrompting = true;

	const answer = await new Promise<string>((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: true,
		});

		// Written before muting, otherwise the prompt itself vanishes.
		process.stdout.write(`\r\n${query}`);
		if (isHidden) {
			(
				rl as unknown as { _writeToOutput: (text: string) => void }
			)._writeToOutput = () => {};
		}

		rl.question("", (value) => {
			rl.close();
			if (isHidden) process.stdout.write("\r\n");
			resolve(value.trim());
		});
	});

	// Hands the fd back so the parent stops competing with the PTY for input.
	process.stdin.pause();
	isPrompting = false;
	flushDeferredOutput();

	return answer;
}

async function runCachedLogin(username: string): Promise<number> {
	const pty: IPty = spawnSteamCmd([]);

	// Prompts can arrive split across chunks, so match an accumulated buffer and
	// clear it on every hit — that is also what lets a rejected password
	// re-prompt.
	let buffer = "";
	let hasSentLogin = false;
	let hasSentQuit = false;
	let isHandling = false;

	pty.onData(async (chunk) => {
		forward(chunk);

		buffer = appendToBuffer(buffer, chunk);

		// onData is re-entrant: an await here lets the next chunk land early.
		if (isHandling) return;
		isHandling = true;

		try {
			// First, so the trailing "Steam>" cannot resend the login.
			if (!hasSentQuit && patterns.loggedIn.test(buffer)) {
				hasSentQuit = true;
				buffer = "";
				console.log(
					"\r\nLogin succeeded. Sending 'quit' so SteamCMD flushes its token cache...",
				);
				pty.write("quit\r");
				return;
			}

			if (!hasSentLogin && patterns.ready.test(buffer)) {
				hasSentLogin = true;
				buffer = "";
				pty.write(`login ${username}\r`);
				return;
			}

			if (patterns.password.test(buffer)) {
				buffer = "";
				const password = await ask(`Password for ${username} (hidden): `, true);
				pty.write(`${password}\r`);
				return;
			}

			if (patterns.steamGuard.test(buffer)) {
				buffer = "";
				const code = await ask(
					"Steam Guard code (check your email or authenticator app): ",
				);
				pty.write(`${code}\r`);
				return;
			}

			// Without this a rejected login parks at Steam> forever.
			const failure = buffer.match(patterns.loginFailed);
			if (failure && !hasSentQuit) {
				hasSentQuit = true;
				buffer = "";
				console.error(
					`\r\nSteamCMD reported a login failure: ${failure[1]?.trim() || "unknown reason"}`,
				);
				pty.write("quit\r");
			}
		} finally {
			isHandling = false;
		}
	});

	return new Promise<number>((resolve) => {
		pty.onExit(({ exitCode }) => {
			process.stdin.pause();
			flushDeferredOutput();

			if (!hasSentQuit) {
				console.error(
					`\r\nSteamCMD exited (code ${exitCode}) before the login completed. No token was cached.`,
				);
				resolve(exitCode || 1);
				return;
			}

			if (exitCode !== 0) {
				console.error(
					`\r\nSteamCMD exited with code ${exitCode}. The cached token may not have been written.`,
				);
				resolve(exitCode);
				return;
			}

			console.log(
				`\r\nSetup complete. Token cached at ${join(binDir, "config", "config.vdf")}.`,
			);
			resolve(0);
		});
	});
}

// Guarded so test-prompts.ts can import the patterns without running the wizard.
if (import.meta.main) {
	await ensureSteamCmd();

	const username = await ask("Enter your Steam username: ");
	if (!username) {
		console.error("A Steam username is required.");
		process.exit(1);
	}

	console.log(`
Launching SteamCMD. It will self-update first, which can take a minute.
Answer the prompts as they appear — nothing is written to disk by this script.
`);

	process.exit(await runCachedLogin(username));
}
