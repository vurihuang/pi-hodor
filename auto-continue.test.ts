import test from "node:test";
import assert from "node:assert/strict";
import { getAutoContinueReason, type AutoContinueConfig } from "./auto-continue.ts";

const config: AutoContinueConfig = {
	enabled: true,
	retryMessage: "continue",
	maxConsecutiveAutoRetries: 99,
	notifyOnAutoContinue: true,
	autoContinueOnLength: true,
	autoContinueOnThinkingOnlyStop: true,
	autoContinueOnSilentStopAfterTool: true,
	errorPatterns: ["ECONNRESET"],
};

test("getAutoContinueReason retries a silent stop after an automatic continue message", () => {
	const reason = getAutoContinueReason(
		{ stopReason: "stop", content: [] },
		config,
		{
			previousMessageRole: "user",
			previousMessageWasAutoRetry: true,
		},
	);

	assert.deepEqual(reason, {
		kind: "silentStopAfterAutoRetry",
		notification: "Assistant stopped after an automatic retry without emitting visible output",
	});
});

test("getAutoContinueReason retries a silent stop after a normal user message", () => {
	const reason = getAutoContinueReason(
		{ stopReason: "stop", content: [] },
		config,
		{
			previousMessageRole: "user",
			previousMessageWasAutoRetry: false,
		},
	);

	assert.deepEqual(reason, {
		kind: "silentStopAfterUser",
		notification: "Assistant stopped after a user message without emitting visible output",
	});
});
