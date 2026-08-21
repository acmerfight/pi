import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import { loadExtensions } from "../../../src/core/extensions/loader.ts";
import type { ExtensionAPI, ProviderConfig } from "../../../src/core/extensions/types.ts";

interface FailureState {
	eventCalls: number;
	flagDuringLoad?: boolean | string;
	capturedApi?: ExtensionAPI;
}

function failureState(): FailureState {
	const global = globalThis as typeof globalThis & { __extensionFactoryFailureState?: FailureState };
	global.__extensionFactoryFailureState ??= { eventCalls: 0 };
	return global.__extensionFactoryFailureState;
}

function providerConfig(modelId: string): ProviderConfig {
	return {
		baseUrl: "https://provider.test/v1",
		apiKey: "provider-test-key",
		api: "openai-completions",
		models: [
			{
				id: modelId,
				name: modelId,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 1024,
			},
		],
	};
}

describe("issue #11 extension factory failure", () => {
	const roots: string[] = [];

	function fixture(): { cwd: string; extensionPath: (name: string) => string } {
		const root = mkdtempSync(join(tmpdir(), "pi-extension-factory-failure-"));
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		roots.push(root);
		return { cwd, extensionPath: (name) => join(root, name) };
	}

	afterEach(() => {
		while (roots.length > 0) {
			const root = roots.pop();
			if (root) rmSync(root, { recursive: true, force: true });
		}
		delete (globalThis as typeof globalThis & { __extensionFactoryFailureState?: FailureState })
			.__extensionFactoryFailureState;
	});

	it("does not let a failed factory alter earlier provider registrations", async () => {
		const { cwd, extensionPath } = fixture();
		const workingPath = extensionPath("working.ts");
		const failingPath = extensionPath("failing.ts");
		writeFileSync(
			workingPath,
			`export default function (pi) {
	pi.registerProvider("working-provider", ${JSON.stringify(providerConfig("working-model"))});
}
`,
		);
		writeFileSync(
			failingPath,
			`export default function (pi) {
	pi.unregisterProvider("working-provider");
	pi.registerProvider("failed-provider", ${JSON.stringify(providerConfig("failed-model"))});
	throw new Error("factory failed");
}
`,
		);

		const result = await loadExtensions([workingPath, failingPath], cwd);

		expect(result.extensions).toHaveLength(1);
		expect(result.errors).toEqual([{ path: failingPath, error: "Failed to load extension: factory failed" }]);
		expect(result.runtime.pendingProviderRegistrations.map(({ name }) => name)).toEqual(["working-provider"]);
	});

	it("discards shared runtime state from a failed factory", async () => {
		const { cwd, extensionPath } = fixture();
		const failingPath = extensionPath("failing.ts");
		const eventBus = createEventBus();
		failureState();
		writeFileSync(
			failingPath,
			`export default function (pi) {
	globalThis.__extensionFactoryFailureState.capturedApi = pi;
	pi.events.on("factory-failure", () => globalThis.__extensionFactoryFailureState.eventCalls++);
	pi.registerFlag("failed-flag", { type: "boolean", default: true });
	globalThis.__extensionFactoryFailureState.flagDuringLoad = pi.getFlag("failed-flag");
	pi.registerProvider("failed-provider", ${JSON.stringify(providerConfig("failed-model"))});
	throw new Error("factory failed");
}
`,
		);

		const result = await loadExtensions([failingPath], cwd, eventBus);
		eventBus.emit("factory-failure", undefined);
		await new Promise((resolve) => setImmediate(resolve));

		expect(result.extensions).toHaveLength(0);
		expect(result.errors).toEqual([{ path: failingPath, error: "Failed to load extension: factory failed" }]);
		expect(failureState().flagDuringLoad).toBe(true);
		expect(result.runtime.flagValues.has("failed-flag")).toBe(false);
		expect(result.runtime.pendingProviderRegistrations).toHaveLength(0);
		expect(failureState().eventCalls).toBe(0);
		expect(failureState().capturedApi).toBeDefined();
		expect(() => failureState().capturedApi?.registerFlag("late-flag", { type: "boolean", default: true })).toThrow(
			`Extension "${failingPath}" failed to load and its API is no longer active.`,
		);
		expect(result.runtime.flagValues.has("late-flag")).toBe(false);
	});
});
