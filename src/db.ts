import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// One row per finished attempt, successes and failures alike, so the history
// answers "what did I download, when, and what went wrong" rather than only
// holding the latest state.

export type Attempt = {
	appId: string;
	modId: string;
	title: string;
	version: string | null;
	path: string | null;
	status: "DONE" | "ERROR";
	message: string | null;
};

export type StoredAttempt = Attempt & { id: number; createdAt: string };

export function openDownloadsDb(
	path = join(process.cwd(), "db", "steampuppet.db"),
): Database {
	// SQLite creates the file but not its folder, and ":memory:" has neither.
	if (!path.startsWith(":")) mkdirSync(dirname(path), { recursive: true });

	const db = new Database(path, { create: true });

	// WAL keeps a reader from blocking the write that ends a download.
	db.run("PRAGMA journal_mode = WAL");
	db.run(`
		CREATE TABLE IF NOT EXISTS downloads (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			app_id TEXT NOT NULL,
			mod_id TEXT NOT NULL,
			title TEXT NOT NULL,
			version TEXT,
			path TEXT,
			status TEXT NOT NULL,
			message TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);
	db.run(
		"CREATE INDEX IF NOT EXISTS downloads_item ON downloads (app_id, mod_id)",
	);

	return db;
}

export function recordAttempt(db: Database, attempt: Attempt): void {
	db.query(
		`INSERT INTO downloads (app_id, mod_id, title, version, path, status, message)
		 VALUES ($appId, $modId, $title, $version, $path, $status, $message)`,
	).run({
		$appId: attempt.appId,
		$modId: attempt.modId,
		$title: attempt.title,
		$version: attempt.version,
		$path: attempt.path,
		$status: attempt.status,
		$message: attempt.message,
	});
}

export function findLastSuccess(
	db: Database,
	appId: string,
	modId: string,
): StoredAttempt | null {
	return db
		.query(
			`SELECT id, app_id AS appId, mod_id AS modId, title, version, path,
			        status, message, created_at AS createdAt
			 FROM downloads
			 WHERE app_id = $appId AND mod_id = $modId AND status = 'DONE'
			 ORDER BY id DESC
			 LIMIT 1`,
		)
		.get({ $appId: appId, $modId: modId }) as StoredAttempt | null;
}

export function countAttempts(db: Database): number {
	const row = db.query("SELECT COUNT(*) AS n FROM downloads").get() as {
		n: number;
	};
	return row.n;
}
