/**
 * HTML Editor Comments Bridge
 *
 * Watches a per-pi-session JSONL trigger file the html-collab-editor server
 * writes to. Each line is one comment; the extension delivers it into this
 * conversation as a real user message via pi.sendUserMessage().
 *
 * Important routing invariant: this extension must NOT watch a shared global
 * trigger file. Each live pi process gets its own bridge path. On session
 * start, the extension exports that path as HTML_EDITOR_COMMENTS_BRIDGE, so
 * any editor server launched by this pi session routes comments back here by
 * default:
 *
 *   python3 serve.py page.html
 *
 * Toggle off at runtime with /html-comments off.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BRIDGE_DIR = "/tmp/html-editor-comments";
const LEGACY_SHARED_TRIGGER = "/tmp/html-editor-comments.jsonl";
const ENV_BRIDGE = "HTML_EDITOR_COMMENTS_BRIDGE";
const POLL_MS = 1000;

interface Entry {
	id?: string;
	tag?: string;
	comment?: string;
	excerpt?: string;
	timestamp?: string;
	file?: string;
}

function safeLabel(input: string): string {
	return input.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 42) || "session";
}

function sessionTriggerPath(ctx: any): string {
	let sessionFile = "";
	try {
		sessionFile = ctx.sessionManager?.getSessionFile?.() || "";
	} catch {
		// fall through to cwd/pid seed
	}
	const seed = `${sessionFile || ctx.cwd || "pi"}:${process.pid}`;
	const hash = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
	const label = sessionFile ? safeLabel(path.basename(sessionFile)) : `pid-${process.pid}`;
	return path.join(BRIDGE_DIR, `${label}-${hash}.jsonl`);
}

export default function (pi: ExtensionAPI) {
	let trigger = "";
	let offset = 0;
	let timer: NodeJS.Timeout | null = null;
	let enabled = true;

	function ensureFile(file = trigger) {
		if (!file) return;
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			if (!fs.existsSync(file)) fs.writeFileSync(file, "");
		} catch {
			/* ignore */
		}
	}

	function statSize(file = trigger): number {
		try {
			return fs.statSync(file).size;
		} catch {
			return 0;
		}
	}

	function resetOffsetToEnd() {
		offset = statSize(trigger);
	}

	function readNew(): Entry[] {
		if (!trigger) return [];
		let size: number;
		try {
			size = fs.statSync(trigger).size;
		} catch {
			return [];
		}
		if (size < offset) offset = 0; // truncated/recreated
		if (size === offset) return [];

		const fd = fs.openSync(trigger, "r");
		const buf = Buffer.alloc(size - offset);
		try {
			fs.readSync(fd, buf, 0, buf.length, offset);
		} finally {
			fs.closeSync(fd);
		}
		offset = size;

		const out: Entry[] = [];
		for (const raw of buf.toString("utf-8").split("\n")) {
			const line = raw.trim();
			if (!line) continue;
			try {
				out.push(JSON.parse(line) as Entry);
			} catch {
				/* skip malformed */
			}
		}
		return out;
	}

	function formatEntry(c: Entry): string {
		const fileBit = c.file ? ` in ${c.file}` : "";
		const tagBit = c.tag ? ` <${c.tag}>` : "";
		const excerpt = (c.excerpt || "").trim();
		const head = `HTML editor comment on element ${c.id || "?"}${tagBit}${fileBit}:`;
		const body = `> ${c.comment || ""}`;
		const ctx = excerpt ? `\n(on text: "${excerpt.slice(0, 200)}")` : "";
		return `${head}\n${body}${ctx}`;
	}

	function tick() {
		if (!enabled) return;
		const entries = readNew();
		if (!entries.length) return;
		for (const c of entries) {
			if (!c.comment) continue;
			const text = formatEntry(c);
			// sendUserMessage with no options triggers a turn when the agent is idle
			// and throws when the agent is streaming. Fall back to a queued followUp
			// delivery in the streaming case so the comment still reaches this agent.
			try {
				pi.sendUserMessage(text);
			} catch {
				try {
					pi.sendUserMessage(text, { deliverAs: "followUp" });
				} catch {
					// unrecoverable for this entry; next tick won't retry it.
				}
			}
		}
	}

	function startTimer() {
		if (timer) clearInterval(timer);
		timer = setInterval(tick, POLL_MS);
	}

	function setTrigger(next: string, reset = true) {
		trigger = next;
		ensureFile(trigger);
		// Child processes/tools launched by this pi session inherit process.env,
		// so serve.py can route comments to this session by default without a
		// manual --comments-bridge flag. This is session-local because each pi
		// process has its own environment and its own trigger path.
		process.env[ENV_BRIDGE] = trigger;
		if (reset) resetOffsetToEnd();
		startTimer();
	}

	pi.on("session_start", (_event, ctx) => {
		setTrigger(sessionTriggerPath(ctx), true);
		if (ctx.hasUI) {
			ctx.ui.notify(
				`html-editor comments bridge: session-scoped ${trigger}`,
				"info",
			);
		}
	});

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = null;
		if (process.env[ENV_BRIDGE] === trigger) {
			delete process.env[ENV_BRIDGE];
		}
	});

	pi.registerCommand("html-comments", {
		description:
			"Control the html-editor comments bridge. Usage: /html-comments on|off|status|path|drain|watch <jsonl>|legacy-drain",
		handler: async (args, ctx) => {
			const raw = (args || "").trim();
			const arg = raw.toLowerCase();
			if (arg === "off") {
				enabled = false;
				ctx.ui.notify("html-editor comments bridge paused for this session", "info");
				return;
			}
			if (arg === "on") {
				enabled = true;
				ctx.ui.notify("html-editor comments bridge resumed for this session", "info");
				return;
			}
			if (arg === "drain") {
				try {
					fs.writeFileSync(trigger, "");
					offset = 0;
				} catch {
					/* ignore */
				}
				ctx.ui.notify("html-editor session bridge file cleared", "info");
				return;
			}
			if (arg === "legacy-drain") {
				try {
					fs.writeFileSync(LEGACY_SHARED_TRIGGER, "");
				} catch {
					/* ignore */
				}
				ctx.ui.notify("legacy shared html-editor trigger file cleared", "info");
				return;
			}
			if (arg.startsWith("watch ")) {
				const requested = raw.slice(6).trim();
				if (!requested) {
					ctx.ui.notify("usage: /html-comments watch /path/to/bridge.jsonl", "error");
					return;
				}
				setTrigger(path.resolve(requested), true);
				enabled = true;
				ctx.ui.notify(`html-editor now watching ${trigger}`, "info");
				return;
			}

			const size = statSize(trigger);
			const command = trigger
				? "python3 serve.py page.html"
				: "bridge path unavailable";
			const manualCommand = trigger
				? `python3 serve.py page.html --comments-bridge ${JSON.stringify(trigger)}`
				: "bridge path unavailable";
			const status =
				`bridge ${enabled ? "ON" : "OFF"} for this session\n` +
				`path: ${trigger || "(none)"}\n` +
				`env ${ENV_BRIDGE}: ${process.env[ENV_BRIDGE] || "(unset)"}\n` +
				`offset: ${offset}/${size}\n` +
				`start editor from this session with: ${command}\n` +
				`manual equivalent: ${manualCommand}\n` +
				`legacy shared file is not watched: ${LEGACY_SHARED_TRIGGER}`;

			if (arg === "path") {
				ctx.ui.notify(trigger || "(none)", "info");
				return;
			}
			ctx.ui.notify(status, "info");
		},
	});
}
