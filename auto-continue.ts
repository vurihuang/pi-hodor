export interface AutoContinueConfig {
	enabled: boolean;
	retryMessage: string;
	maxConsecutiveAutoRetries: number;
	notifyOnAutoContinue: boolean;
	autoContinueOnLength: boolean;
	autoContinueOnThinkingOnlyStop: boolean;
	autoContinueOnSilentStopAfterTool: boolean;
	errorPatterns: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
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

export function extractUserText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	return extractTextBlocks(content);
}

function matchesConfiguredError(errorText: string, patterns: string[]) {
	const normalizedError = errorText.toLowerCase();
	return patterns.some((pattern) => normalizedError.includes(pattern.toLowerCase()));
}

function hasContentBlockType(content: unknown, type: string) {
	return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === type);
}

function hasVisibleAssistantOutput(content: unknown) {
	return extractTextBlocks(content).length > 0 || hasContentBlockType(content, "toolCall");
}

function isThinkingOnlyStop(content: unknown) {
	return hasContentBlockType(content, "thinking") && !hasVisibleAssistantOutput(content);
}

export function getAutoContinueReason(
	message: {
		stopReason?: string;
		content?: unknown;
		errorMessage?: string;
	},
	config: AutoContinueConfig,
	context: {
		previousMessageRole?: string;
		previousMessageWasAutoRetry?: boolean;
	},
) {
	if (message.stopReason === "error") {
		const errorText = [message.errorMessage, extractTextBlocks(message.content)]
			.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
			.join("\n");
		if (!errorText || !matchesConfiguredError(errorText, config.errorPatterns)) return undefined;
		return {
			kind: "error",
			notification: "Matched a configured error",
		};
	}

	if (message.stopReason === "length" && config.autoContinueOnLength) {
		return {
			kind: "length",
			notification: "Assistant stopped with stopReason \"length\"",
		};
	}

	if (message.stopReason !== "stop") return undefined;

	if (config.autoContinueOnThinkingOnlyStop && isThinkingOnlyStop(message.content)) {
		return {
			kind: "thinkingOnlyStop",
			notification: "Assistant stopped after emitting only thinking content",
		};
	}

	if (!config.autoContinueOnSilentStopAfterTool || hasVisibleAssistantOutput(message.content)) {
		return undefined;
	}

	if (context.previousMessageRole === "toolResult") {
		return {
			kind: "silentStopAfterTool",
			notification: "Assistant stopped after a tool result without emitting visible output",
		};
	}

	if (context.previousMessageRole === "user" && context.previousMessageWasAutoRetry) {
		return {
			kind: "silentStopAfterAutoRetry",
			notification: "Assistant stopped after an automatic retry without emitting visible output",
		};
	}

	if (context.previousMessageRole === "user") {
		return {
			kind: "silentStopAfterUser",
			notification: "Assistant stopped after a user message without emitting visible output",
		};
	}

	return undefined;
}
