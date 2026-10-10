import { equal } from "node:assert/strict";
import {
	countAttempts,
	findLastSuccess,
	openDownloadsDb,
	recordAttempt,
} from "./db";
import { resolveTarget } from "./setup";
import { parseAccounts, patterns, stripAnsi } from "./steamcmd";

const cases: [keyof typeof patterns, string, boolean][] = [
	["ready", "Loading Steam API...OK\r\nSteam>", true],
	["ready", "\x1b[1mSteam>\x1b[0m ", true],
	["ready", "Steam>login bob\r\n", false],
	["password", "password: ", true],
	["password", "\x1b[0mpassword:", true],
	["password", "Enter the password:\r\nLogging in...", false],
	["steamGuard", "Steam Guard code: ", true],
	["steamGuard", "Two-factor code: ", true],
	["loggedIn", "Waiting for user info...OK\r\n", true],
	["loggedIn", "Logged in OK\r\nSteam>", true],
	["loggedIn", "Waiting for user info...", false],
	["loginFailed", "FAILED (Invalid Password)\r\n", true],
	["loginFailed", "Logged in OK", false],
];

for (const [key, raw, expected] of cases) {
	equal(
		patterns[key].test(stripAnsi(raw)),
		expected,
		`${key} <- ${JSON.stringify(raw)}`,
	);
}

equal(
	"FAILED (Invalid Password)\r\n".match(patterns.loginFailed)?.[1],
	"Invalid Password",
);

equal(resolveTarget("win32")?.archive, "steamcmd.zip");
equal(resolveTarget("linux")?.archive, "steamcmd_linux.tar.gz");
equal(resolveTarget("darwin")?.archive, "steamcmd_osx.tar.gz");
equal(resolveTarget("sunos"), undefined);

console.log(`${cases.length + 5} assertions passed`);

const vdf = `"InstallConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"Accounts"
				{
					"kseventy9"
					{
						"SteamID"		"76561198838835247"
					}
				}
				"CellIDServerOverride"		"0"
			}
		}
	}
}
`;

equal(parseAccounts(vdf).join(","), "kseventy9");
equal(parseAccounts(vdf.replace("kseventy9", "alice")).join(","), "alice");
equal(
	parseAccounts(
		vdf.replace(
			'"kseventy9"\n\t\t\t\t\t{',
			'"alice"\n\t\t\t\t\t{\n\t\t\t\t\t}\n\t\t\t\t\t"bob"\n\t\t\t\t\t{',
		),
	).join(","),
	"alice,bob",
);
equal(parseAccounts('"Accounts"\n{\n}\n').length, 0);
equal(parseAccounts("no accounts here").length, 0);
equal(parseAccounts('"Accounts"\n{\n"unterminated"\n{\n').length, 0);

console.log("6 account-parsing assertions passed");

const memdb = openDownloadsDb(":memory:");

equal(findLastSuccess(memdb, "1158310", "3814775890"), null);
equal(countAttempts(memdb), 0);

recordAttempt(memdb, {
	appId: "1158310",
	modId: "3814775890",
	title: "Council Autopilot",
	version: "1.20.x",
	path: "G:MODSCouncil_Autopilot\x01.20.x",
	status: "DONE",
	message: null,
});
recordAttempt(memdb, {
	appId: "1158310",
	modId: "999",
	title: "Broken",
	version: null,
	path: null,
	status: "ERROR",
	message: "File Not Found",
});

equal(countAttempts(memdb), 2);
equal(findLastSuccess(memdb, "1158310", "3814775890")?.version, "1.20.x");

// A failure must never count as "already downloaded".
equal(findLastSuccess(memdb, "1158310", "999"), null);

// The newest success wins, so a re-download updates what the warning reports.
recordAttempt(memdb, {
	appId: "1158310",
	modId: "3814775890",
	title: "Council Autopilot",
	version: "1.21.x",
	path: "G:MODSCouncil_Autopilot\x01.21.x",
	status: "DONE",
	message: null,
});
equal(findLastSuccess(memdb, "1158310", "3814775890")?.version, "1.21.x");
equal(countAttempts(memdb), 3);

console.log("7 download-history assertions passed");
