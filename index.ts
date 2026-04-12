import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type NotifyLevel = "info" | "success" | "warning" | "error";

type NotifierContext = {
	hasUI: boolean;
	ui: {
		notify(message: string, level: NotifyLevel): void;
	};
};

type QueueAwareContext = NotifierContext & {
	cwd: string;
	isIdle(): boolean;
	hasPendingMessages(): boolean;
};

interface AutoContinueConfig {
	enabled: boolean;
	retryMessage: string;
	maxConsecutiveAutoRetries: number;
	notifyOnAutoContinue: boolean;
	errorPatterns: string[];
}

const EXTENSION_NAME = "pi-hodor";
const BUNDLED_CONFIG_PATH = join(__dirname, "config.json");
const PROJECT_CONFIG_CANDIDATES = [
	".pi-hodor.json",
	join(".pi", "pi-hodor.json"),
] as const;
const DEFAULT_CONFIG: AutoContinueConfig = {
	enabled: true,
	retryMessage: "continue",
	maxConsecutiveAutoRetries: 99,
	notifyOnAutoContinue: true,
	errorPatterns: [
		"上游流式响应中断",
		"error decoding response body",
		"stream disconnected before completion",
		"stream closed before",
		"stream closed unexpectedly",
		"stream interrupted",
		"stream ended unexpectedly",
		"premature close",
		"socket hang up",
		"connection reset by peer",
		"connection reset",
		"read ECONNRESET",
		"ECONNRESET",
		"ETIMEDOUT",
		"fetch failed",
		"unexpected end of JSON input",
		"unexpected end of input",
	],
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizeConfig(raw: unknown): AutoContinueConfig {
	const config = isRecord(raw) ? raw : {};
	const errorPatterns = Array.isArray(config.errorPatterns)
		? config.errorPatterns
				.filter((pattern): pattern is string => typeof pattern === "string")
				.map((pattern) => pattern.trim())
				.filter(Boolean)
		: DEFAULT_CONFIG.errorPatterns;
	const retryMessage =
		typeof config.retryMessage === "string" && config.retryMessage.trim().length > 0
			? config.retryMessage.trim()
			: DEFAULT_CONFIG.retryMessage;
	const maxConsecutiveAutoRetries =
		typeof config.maxConsecutiveAutoRetries === "number" && Number.isFinite(config.maxConsecutiveAutoRetries)
			? Math.max(0, Math.floor(config.maxConsecutiveAutoRetries))
			: DEFAULT_CONFIG.maxConsecutiveAutoRetries;

	return {
		enabled: typeof config.enabled === "boolean" ? config.enabled : DEFAULT_CONFIG.enabled,
		retryMessage,
		maxConsecutiveAutoRetries,
		notifyOnAutoContinue:
			typeof config.notifyOnAutoContinue === "boolean"
				? config.notifyOnAutoContinue
				: DEFAULT_CONFIG.notifyOnAutoContinue,
		errorPatterns: errorPatterns.length > 0 ? errorPatterns : DEFAULT_CONFIG.errorPatterns,
	};
}

function safeNotify(ctx: NotifierContext, message: string, level: NotifyLevel) {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, level);
}

async function ensureBundledConfigFile() {
	try {
		await access(BUNDLED_CONFIG_PATH);
	} catch {
		await writeFile(BUNDLED_CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
	}
}

async function resolveConfigPath(cwd: string) {
	for (const relativePath of PROJECT_CONFIG_CANDIDATES) {
		const candidatePath = join(cwd, relativePath);
		try {
			await access(candidatePath);
			return candidatePath;
		} catch {
			// Keep searching.
		}
	}

	return BUNDLED_CONFIG_PATH;
}

async function loadConfig(ctx: QueueAwareContext, lastConfigError: { value?: string }) {
	await ensureBundledConfigFile();
	const configPath = await resolveConfigPath(ctx.cwd);

	try {
		const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
		lastConfigError.value = undefined;
		return config;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const errorKey = `${configPath}:${message}`;
		if (lastConfigError.value !== errorKey) {
			lastConfigError.value = errorKey;
			safeNotify(
				ctx,
				`[${EXTENSION_NAME}] Failed to read config from ${configPath}. Falling back to defaults: ${message}`,
				"warning",
			);
		}
		return DEFAULT_CONFIG;
	}
}

function extractTextBlocks(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) => {
			if (!isRecord(block)) return [];
			if (block.type !== "text") return [];
			return typeof block.text === "string" ? [block.text] : [];
		})
		.join("\n")
		.trim();
}

function extractUserText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	return extractTextBlocks(content);
}

function matchesConfiguredError(errorText: string, patterns: string[]) {
	const normalizedError = errorText.toLowerCase();
	return patterns.some((pattern) => normalizedError.includes(pattern.toLowerCase()));
}

export default function (pi: ExtensionAPI) {
	let consecutiveAutoRetries = 0;
	let pendingAutoRetryMessage: string | undefined;
	const lastConfigError: { value?: string } = {};

	pi.on("session_start", async () => {
		await ensureBundledConfigFile();
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role === "user") {
			const userText = extractUserText(event.message.content);
			if (pendingAutoRetryMessage && userText === pendingAutoRetryMessage) {
				pendingAutoRetryMessage = undefined;
				return;
			}
			consecutiveAutoRetries = 0;
			pendingAutoRetryMessage = undefined;
			return;
		}

		if (event.message.role !== "assistant") return;

		if (event.message.stopReason !== "error") {
			consecutiveAutoRetries = 0;
			pendingAutoRetryMessage = undefined;
			return;
		}

		const config = await loadConfig(ctx as QueueAwareContext, lastConfigError);
		if (!config.enabled) return;
		if (ctx.hasPendingMessages()) return;
		if (consecutiveAutoRetries >= config.maxConsecutiveAutoRetries) {
			if (config.notifyOnAutoContinue) {
				safeNotify(
					ctx as QueueAwareContext,
					`[${EXTENSION_NAME}] Reached the consecutive auto-retry limit (${config.maxConsecutiveAutoRetries}). Skipping automatic \"${config.retryMessage}\".`,
					"warning",
				);
			}
			return;
		}

		const errorText = [event.message.errorMessage, extractTextBlocks(event.message.content)]
			.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
			.join("\n");
		if (!errorText || !matchesConfiguredError(errorText, config.errorPatterns)) return;

		consecutiveAutoRetries += 1;
		pendingAutoRetryMessage = config.retryMessage;
		if (config.notifyOnAutoContinue) {
			safeNotify(
				ctx as QueueAwareContext,
				`[${EXTENSION_NAME}] Matched a configured error. Sending \"${config.retryMessage}\" automatically (${consecutiveAutoRetries}/${config.maxConsecutiveAutoRetries}).`,
				"info",
			);
		}

		if (ctx.isIdle()) {
			await pi.sendUserMessage(config.retryMessage);
		} else {
			await pi.sendUserMessage(config.retryMessage, { deliverAs: "followUp" });
		}
	});
}
