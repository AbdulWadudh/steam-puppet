// ==UserScript==
// @name         SteamPuppet
// @namespace    https://github.com/steampuppet
// @version      4.0.0
// @description  Download a Steam Workshop item through a local SteamCMD puppet
// @match        *://steamcommunity.com/sharedfiles/filedetails/?id=*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/toastr.js/2.1.4/toastr.min.js
// @resource     toastrCss https://cdnjs.cloudflare.com/ajax/libs/toastr.js/2.1.4/toastr.min.css
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

// Plain JavaScript, not TypeScript: Tampermonkey loads this file verbatim and
// cannot compile it, and a build step for one file is not worth the gain.

// Must match WS_PORT in .env.
const SERVER_PORT = 8090;

// Where toasts appear. One of: bottom-right, bottom-left, bottom-center,
// top-right, top-left, top-center, top-full-width, bottom-full-width.
const TOAST_POSITION = "bottom-right";

(() => {
	// Moves together with the server's PROTOCOL_VERSION.
	const PROTOCOL_VERSION = 1;
	const API = `http://localhost:${SERVER_PORT}/api/v1`;
	const POLL_INTERVAL_MS = 1000;

	// GM_xmlhttpRequest runs in the extension context, so it is exempt from the
	// mixed-content rule that blocks a plain ws:// or fetch() from this https page.
	function request(method, path, body) {
		return new Promise((resolve, reject) => {
			GM_xmlhttpRequest({
				method,
				url: API + path,
				headers: { "Content-Type": "application/json" },
				data: body
					? JSON.stringify({ v: PROTOCOL_VERSION, ...body })
					: undefined,
				timeout: 15000,
				onload: (res) => {
					try {
						resolve(JSON.parse(res.responseText));
					} catch {
						reject(
							new Error(`Bad response: ${res.responseText.slice(0, 120)}`),
						);
					}
				},
				onerror: () =>
					reject(new Error("Cannot reach SteamPuppet - is it running?")),
				ontimeout: () => reject(new Error("SteamPuppet timed out")),
			});
		});
	}

	// Scrapes the three things the server needs to run SteamCMD.
	function readWorkshopItem() {
		const modId = new URLSearchParams(location.search).get("id");
		const title = document
			.querySelector(".workshopItemTitle")
			?.textContent?.trim();

		// g_rgAppInfo lives on the page's own window, not the userscript sandbox.
		const page = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
		const fromGlobal = page.g_rgAppInfo && Object.keys(page.g_rgAppInfo)[0];

		// Breadcrumb fallback: ".../app/1158310" on the game link.
		const breadcrumb = document.querySelector('.breadcrumbs a[href*="/app/"]');
		const fromBreadcrumb = breadcrumb?.href.match(/\/app\/(\d+)/)?.[1];

		const appId = String(
			page.g_rgAppInfo?.appid || fromGlobal || fromBreadcrumb || "",
		);

		return { appId, modId, title };
	}

	const item = readWorkshopItem();

	if (!item.modId || !item.title || !item.appId) {
		console.warn("[SteamPuppet] could not scrape this page", item);
		return;
	}

	// --- toasts ----------------------------------------------------------------

	// toastr ships its own stylesheet; @resource keeps it cached alongside the
	// script instead of refetching it on every page load.
	GM_addStyle(GM_getResourceText("toastrCss"));

	// toastr ships a 300px card, which wraps a short sentence onto a second
	// line. Alignment is pinned too, because the host page's text-align is
	// otherwise inherited straight into the toast.
	GM_addStyle(`
		#toast-container > div {
			width: 420px;
			max-width: calc(100vw - 32px);
			opacity: 1;
		}
		#toast-container > div .toast-title,
		#toast-container > div .toast-message {
			text-align: left;
		}
		#toast-container > div .toast-message {
			overflow-wrap: anywhere;
		}
	`);

	// @require loads toastr into the userscript sandbox, so it never collides
	// with the much older jQuery that Steam's own pages ship.
	const toast =
		window.toastr ||
		(typeof unsafeWindow === "undefined" ? null : unsafeWindow.toastr);

	if (!toast) {
		console.error("[SteamPuppet] toastr failed to load - check @require");
		return;
	}

	// toastr silently ignores an unknown positionClass and the toasts end up in
	// the top-left corner, so a typo is caught here instead.
	const TOAST_POSITIONS = [
		"bottom-right",
		"bottom-left",
		"bottom-center",
		"bottom-full-width",
		"top-right",
		"top-left",
		"top-center",
		"top-full-width",
	];

	if (!TOAST_POSITIONS.includes(TOAST_POSITION)) {
		console.warn(
			`[SteamPuppet] unknown TOAST_POSITION "${TOAST_POSITION}", using bottom-right. Valid: ${TOAST_POSITIONS.join(", ")}`,
		);
	}

	const position = TOAST_POSITIONS.includes(TOAST_POSITION)
		? TOAST_POSITION
		: "bottom-right";

	toast.options = {
		positionClass: `toast-${position}`,
		progressBar: true,
		newestOnTop: true,
		closeButton: true,
		timeOut: 6000,
		extendedTimeOut: 2000,
	};

	// toastr fires and forgets, but a download is one job with several stages.
	// Keeping a sticky toast and rewriting its message node avoids stacking a
	// fresh card for every status change.
	let progress = null;

	function showProgress(message) {
		if (progress) {
			progress.find(".toast-message").text(message);
			return;
		}
		progress = toast.info(message, item.title, {
			timeOut: 0,
			extendedTimeOut: 0,
			progressBar: false,
			closeButton: false,
			tapToDismiss: false,
		});
	}

	function clearProgress() {
		if (!progress) return;
		toast.clear(progress, { force: true });
		progress = null;
	}

	// Terminal states swap the sticky card for a normal self-dismissing toast.
	function finish(kind, message) {
		clearProgress();
		toast[kind](message, item.title);
	}

	// --- button ----------------------------------------------------------------

	// Sits beside Subscribe; falls back to the action column on older layouts.
	const anchor =
		document.querySelector("#SubscribeItemBtn")?.parentElement ||
		document.querySelector(".game_area_purchase_game") ||
		document.querySelector("#SubscribeItemOptionAdd")?.parentElement;

	if (!anchor) {
		console.warn("[SteamPuppet] no Subscribe button to anchor to");
		return;
	}

	const subscribeButton = document.querySelector("#SubscribeItemBtn");

	const DOWNLOAD_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%23fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/></svg>`;

	const button = document.createElement("a");
	button.className =
		subscribeButton?.className ||
		"btn_green_white_innerfade btn_border_2px btn_medium";
	button.style.cssText = [
		"position:relative",
		"display:block",
		"box-sizing:border-box",
		"margin-top:8px",
		"cursor:pointer",
		`width:${subscribeButton?.offsetWidth || 142}px`,
	].join(";");

	// 16x30 in the gutter the label's 35px left padding leaves free, matching
	// Steam's own .subscribeIcon box.
	const icon = document.createElement("div");
	icon.style.cssText = [
		"position:absolute",
		"left:12px",
		"top:0",
		"width:16px",
		"height:30px",
		`background:center no-repeat url('data:image/svg+xml;utf8,${DOWNLOAD_ICON}')`,
		"background-size:16px 16px",
	].join(";");

	const label = document.createElement("span");
	label.style.cssText = "display:block;padding:0 15px 0 35px;line-height:30px";
	label.textContent = "Download";

	button.append(icon, label);
	anchor.appendChild(button);

	// The label never changes now - progress lives in the toast. The button only
	// reflects whether it can be clicked.
	function setEnabled(isEnabled) {
		button.style.opacity = isEnabled ? "1" : "0.6";
		button.style.pointerEvents = isEnabled ? "auto" : "none";
	}

	// --- job -------------------------------------------------------------------

	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	function describeWhen(iso) {
		const then = Date.parse(`${iso}Z`);
		if (Number.isNaN(then)) return iso;

		const minutes = Math.round((Date.now() - then) / 60000);
		if (minutes < 1) return "just now";
		if (minutes < 60) return `${minutes}m ago`;
		if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
		return `${Math.round(minutes / 1440)}d ago`;
	}

	let isBusy = false;

	// Runs only while a job is in flight, and returns on the first terminal state.
	async function pollUntilSettled() {
		let hasPromptedForCode = false;

		while (true) {
			await sleep(POLL_INTERVAL_MS);
			const state = await request("GET", "/jobs/current");

			switch (state.status) {
				case "AUTH_REQUIRED": {
					// The status stays AUTH_REQUIRED until the code lands, so ask once.
					if (hasPromptedForCode) break;
					hasPromptedForCode = true;

					showProgress("Waiting for your Steam Guard code");
					const code = prompt("Steam Guard Code:");
					if (!code) {
						finish("warning", "Cancelled");
						return;
					}
					showProgress("Authenticating...");
					await request("POST", "/jobs/current/auth", { code });
					break;
				}

				case "PACKAGING":
					showProgress("Packaging into your mods folder...");
					break;

				case "DONE":
					finish("success", `Downloaded to ${state.msg}`);
					console.log("[SteamPuppet] packed to", state.msg);
					return;

				case "ERROR":
					finish("error", state.msg || state.error || "Failed");
					console.error("[SteamPuppet]", state.msg || state.error);
					return;

				default:
					showProgress("Downloading from Steam...");
			}
		}
	}

	// The consent has to be a different target from the button that triggered the
	// warning - "click Download again" would be satisfied by an accidental
	// double-click, which is the exact mistake this is here to prevent.
	function askRedownload(previous) {
		const version = previous.version ? ` ${previous.version}` : "";
		const message = `Already downloaded${version} ${describeWhen(previous.downloadedAt)}.`;

		clearProgress();

		const card = toast.warning(message, item.title, {
			timeOut: 0,
			extendedTimeOut: 0,
			progressBar: false,
			closeButton: false,
			tapToDismiss: false,
		});

		// If toastr refused to render, fall back to a blocking confirm rather
		// than silently doing nothing.
		if (!card) return Promise.resolve(confirm(`${message} Re-download?`));

		return new Promise((resolve) => {
			const actions = document.createElement("div");
			actions.style.cssText =
				"display:flex;gap:8px;margin-top:10px;justify-content:flex-end";

			const makeAction = (text, isPrimary) => {
				const action = document.createElement("button");
				action.type = "button";
				action.textContent = text;
				action.style.cssText = [
					"padding:5px 12px",
					"border:0",
					"border-radius:3px",
					"cursor:pointer",
					"font:inherit",
					"font-weight:700",
					isPrimary
						? "background:#fff;color:#8a5a00"
						: "background:rgba(0,0,0,.25);color:#fff",
				].join(";");
				return action;
			};

			const confirmAction = makeAction("Re-download", true);
			const cancelAction = makeAction("Cancel", false);

			const choose = (didConsent) => {
				toast.clear(card, { force: true });
				resolve(didConsent);
			};

			confirmAction.addEventListener("click", () => choose(true));
			cancelAction.addEventListener("click", () => choose(false));

			actions.append(cancelAction, confirmAction);
			card[0].appendChild(actions);
		});
	}

	async function runJob(force) {
		showProgress(force ? "Re-downloading..." : "Starting...");

		const started = await request("POST", "/jobs", {
			appId: item.appId,
			modId: item.modId,
			title: item.title,
			force,
		});

		if (started.error) throw new Error(started.error);

		// A Workshop item can be updated after you downloaded it, so a repeat is
		// offered rather than blocked - but only through an explicit choice.
		if (started.status === "DUPLICATE") {
			if (!(await askRedownload(started))) return;
			await runJob(true);
			return;
		}

		showProgress("Downloading from Steam...");
		await pollUntilSettled();
	}

	button.addEventListener("click", async () => {
		if (isBusy) return;
		isBusy = true;
		setEnabled(false);

		try {
			await runJob(false);
		} catch (error) {
			finish("error", error.message);
			console.error("[SteamPuppet]", error);
		} finally {
			// The button only unlocks once the whole flow, consent included, is over.
			isBusy = false;
			setEnabled(true);
		}
	});
})();
