import test from "node:test";
import assert from "node:assert/strict";

test("index.ts can be imported in ESM without __dirname failures", async () => {
	const mod = await import(new URL("./index.ts", import.meta.url).href);
	assert.equal(typeof mod.default, "function");
});
