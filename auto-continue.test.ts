import test from "node:test";
import assert from "node:assert/strict";
import { getAutoContinueDecision, type AutoContinueConfig } from "./auto-continue.ts";

const config: AutoContinueConfig = {
	enabled: true,
	retryMessage: "continue",
	maxConsecutiveAutoRetries: 99,
	notifyOnAutoContinue: true,
	autoContinueOnLength: true,
	minRemainingTokensForLengthAutoContinue: 16_384,
	autoContinueOnThinkingOnlyStop: true,
	autoContinueOnSilentStopAfterTool: true,
	deferredErrorPatterns: ["WebSocket error"],
	errorPatterns: ["ECONNRESET"],
};

test("getAutoContinueDecision retries a silent stop after an automatic continue message", () => {
	const decision = getAutoContinueDecision(
		{ stopReason: "stop", content: [] },
		config,
		{
			previousMessageRole: "user",
			previousMessageWasAutoRetry: true,
		},
	);

	assert.deepEqual(decision, {
		action: "continue",
		reason: {
			kind: "silentStopAfterAutoRetry",
			notification: "Assistant stopped after an automatic retry without emitting visible output",
		},
	});
});

test("getAutoContinueDecision retries a silent stop after a normal user message", () => {
	const decision = getAutoContinueDecision(
		{ stopReason: "stop", content: [] },
		config,
		{
			previousMessageRole: "user",
			previousMessageWasAutoRetry: false,
		},
	);

	assert.deepEqual(decision, {
		action: "continue",
		reason: {
			kind: "silentStopAfterUser",
			notification: "Assistant stopped after a user message without emitting visible output",
		},
	});
});

test("getAutoContinueDecision retries length stops when context has enough room", () => {
	const decision = getAutoContinueDecision(
		{ stopReason: "length", content: [] },
		config,
		{
			contextUsage: {
				tokens: 100_000,
				contextWindow: 200_000,
				percent: 50,
			},
		},
	);

	assert.deepEqual(decision, {
		action: "continue",
		reason: {
			kind: "length",
			notification: "Assistant stopped with stopReason \"length\"",
		},
	});
});

test("getAutoContinueDecision defers length stops when remaining context is low", () => {
	const decision = getAutoContinueDecision(
		{ stopReason: "length", content: [] },
		config,
		{
			contextUsage: {
				tokens: 185_000,
				contextWindow: 200_000,
				percent: 92.5,
			},
		},
	);

	assert.deepEqual(decision, {
		action: "defer",
		kind: "lengthContextTooFull",
	});
});

test("getAutoContinueDecision retries length stops when context usage is unknown", () => {
	const decision = getAutoContinueDecision(
		{ stopReason: "length", content: [] },
		config,
		{},
	);

	assert.deepEqual(decision, {
		action: "continue",
		reason: {
			kind: "length",
			notification: "Assistant stopped with stopReason \"length\"",
		},
	});
});

test("getAutoContinueDecision ignores configured errors that match deferred patterns", () => {
	const decision = getAutoContinueDecision(
		{ stopReason: "error", errorMessage: "Error: WebSocket error" },
		{ ...config, errorPatterns: ["WebSocket error"] },
		{},
	);

	assert.deepEqual(decision, { action: "ignore" });
});

test("getAutoContinueDecision retries configured errors when deferred patterns are empty", () => {
	const decision = getAutoContinueDecision(
		{ stopReason: "error", errorMessage: "Error: WebSocket error" },
		{ ...config, deferredErrorPatterns: [], errorPatterns: ["WebSocket error"] },
		{},
	);

	assert.deepEqual(decision, {
		action: "continue",
		reason: {
			kind: "error",
			notification: "Matched a configured error",
		},
	});
});
