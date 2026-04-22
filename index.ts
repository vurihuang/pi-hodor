import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	extractUserText,
	getAutoContinueReason,
	type AutoContinueConfig,
} from "./auto-continue.ts";

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

const EXTENSION_NAME = "pi-hodor";
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLED_CONFIG_PATH = join(MODULE_DIR, "config.json");
const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", "extensions", EXTENSION_NAME, "config.json");
const PROJECT_CONFIG_CANDIDATES = [
	".pi-hodor.json",
	join(".pi", "pi-hodor.json"),
] as const;
const DEFAULT_CONFIG: AutoContinueConfig = {
	enabled: true,
	retryMessage: "continue",
	maxConsecutiveAutoRetries: 99,
	notifyOnAutoContinue: true,
	autoContinueOnLength: true,
	autoContinueOnThinkingOnlyStop: true,
	autoContinueOnSilentStopAfterTool: true,
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
		autoContinueOnLength:
			typeof config.autoContinueOnLength === "boolean"
				? config.autoContinueOnLength
				: DEFAULT_CONFIG.autoContinueOnLength,
		autoContinueOnThinkingOnlyStop:
			typeof config.autoContinueOnThinkingOnlyStop === "boolean"
				? config.autoContinueOnThinkingOnlyStop
				: DEFAULT_CONFIG.autoContinueOnThinkingOnlyStop,
		autoContinueOnSilentStopAfterTool:
			typeof config.autoContinueOnSilentStopAfterTool === "boolean"
				? config.autoContinueOnSilentStopAfterTool
				: DEFAULT_CONFIG.autoContinueOnSilentStopAfterTool,
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

async function pathExists(path: string) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function resolveConfigPath(cwd: string) {
	for (const relativePath of PROJECT_CONFIG_CANDIDATES) {
		const candidatePath = join(cwd, relativePath);
		if (await pathExists(candidatePath)) {
			return candidatePath;
		}
	}

	if (await pathExists(GLOBAL_CONFIG_PATH)) {
		return GLOBAL_CONFIG_PATH;
	}

	return BUNDLED_CONFIG_PATH;
}

async function copyBundledConfig(destinationPath: string) {
	await ensureBundledConfigFile();
	await mkdir(dirname(destinationPath), { recursive: true });
	await copyFile(BUNDLED_CONFIG_PATH, destinationPath);
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

export default function (pi: ExtensionAPI) {
	let consecutiveAutoRetries = 0;
	let pendingAutoRetryMessage: string | undefined;
	let previousMessageRole: string | undefined;
	let lastUserMessageWasAutoRetry = false;
	const lastConfigError: { value?: string } = {};

	pi.registerCommand("pi-hodor:setup", {
		description: `Copy the default ${EXTENSION_NAME} config to ${GLOBAL_CONFIG_PATH}`,
		handler: async (_args, ctx) => {
			if (await pathExists(GLOBAL_CONFIG_PATH)) {
				ctx.ui.notify(`[${EXTENSION_NAME}] Config already exists at ${GLOBAL_CONFIG_PATH}`, "warning");
				return;
			}

			await copyBundledConfig(GLOBAL_CONFIG_PATH);
			ctx.ui.notify(`[${EXTENSION_NAME}] Config copied to ${GLOBAL_CONFIG_PATH}`, "info");
		},
	});

	pi.on("session_start", async () => {
		await ensureBundledConfigFile();
	});

	pi.on("message_end", async (event, ctx) => {
		const messageRole = event.message.role;
		const previousRole = previousMessageRole;
		const previousMessageWasAutoRetry = previousRole === "user" && lastUserMessageWasAutoRetry;
		previousMessageRole = messageRole;
		lastUserMessageWasAutoRetry = false;

		if (messageRole === "user") {
			const userText = extractUserText(event.message.content);
			if (pendingAutoRetryMessage && userText === pendingAutoRetryMessage) {
				lastUserMessageWasAutoRetry = true;
				pendingAutoRetryMessage = undefined;
				return;
			}
			consecutiveAutoRetries = 0;
			pendingAutoRetryMessage = undefined;
			return;
		}

		if (messageRole !== "assistant") return;

		const retryableStopReasons = new Set(["error", "length", "stop"]);
		if (!retryableStopReasons.has(event.message.stopReason)) {
			consecutiveAutoRetries = 0;
			pendingAutoRetryMessage = undefined;
			return;
		}

		const config = await loadConfig(ctx as QueueAwareContext, lastConfigError);
		if (!config.enabled) {
			consecutiveAutoRetries = 0;
			pendingAutoRetryMessage = undefined;
			return;
		}

		const autoContinueReason = getAutoContinueReason(event.message, config, {
			previousMessageRole: previousRole,
			previousMessageWasAutoRetry,
		});
		if (!autoContinueReason) {
			consecutiveAutoRetries = 0;
			pendingAutoRetryMessage = undefined;
			return;
		}

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

		consecutiveAutoRetries += 1;
		pendingAutoRetryMessage = config.retryMessage;
		if (config.notifyOnAutoContinue) {
			safeNotify(
				ctx as QueueAwareContext,
				`[${EXTENSION_NAME}] ${autoContinueReason.notification}. Sending \"${config.retryMessage}\" automatically (${consecutiveAutoRetries}/${config.maxConsecutiveAutoRetries}).`,
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
