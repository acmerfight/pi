import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadExtensions } from "../../../src/core/extensions/loader.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

function checkRegisterFlagTypes(pi: ExtensionAPI): void {
	pi.registerFlag("enabled", { type: "boolean", default: true });
	pi.registerFlag("label", { type: "string", default: "value" });

	// @ts-expect-error Boolean flags require boolean defaults.
	pi.registerFlag("invalid-boolean", { type: "boolean", default: "false" });
	// @ts-expect-error String flags require string defaults.
	pi.registerFlag("invalid-string", { type: "string", default: false });
}
void checkRegisterFlagTypes;

describe("issue #8064 registerFlag default types", () => {
	it.each([
		{ type: "boolean", defaultSource: '"false"', received: "string" },
		{ type: "string", defaultSource: "false", received: "boolean" },
	])("rejects a $received default for a $type flag from JavaScript", async ({ type, defaultSource, received }) => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-8064-"));
		try {
			const extensionPath = join(tempDir, "invalid-default.js");
			writeFileSync(
				extensionPath,
				`export default function (pi) { pi.registerFlag("safe-mode", { type: "${type}", default: ${defaultSource} }); }`,
			);

			const result = await loadExtensions([extensionPath], tempDir);

			expect(result.extensions).toEqual([]);
			expect(result.errors).toEqual([
				{
					path: extensionPath,
					error: `Failed to load extension: Invalid default for extension flag "--safe-mode": expected ${type}, received ${received}`,
				},
			]);
			expect(result.runtime.flagValues.has("safe-mode")).toBe(false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
