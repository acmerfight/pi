import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai/compat";
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../../model-runtime-test-utils.ts";
import { createTestResourceLoader } from "../../utilities.ts";

type Scenario = {
	name: string;
	stopReason: "error" | "length";
	errorMessage?: string;
	contextWindow: number;
	seed: boolean;
};

function captureResponse(
	requests: Message[][],
	content: string,
	options: { stopReason?: AssistantMessage["stopReason"]; errorMessage?: string } = {},
) {
	return (context: Context) => {
		requests.push(structuredClone(context.messages));
		return fauxAssistantMessage(content, options);
	};
}

function isOverflowAssistant(message: Message, scenario: Scenario): boolean {
	return (
		message.role === "assistant" &&
		message.stopReason === scenario.stopReason &&
		message.content.some((part) => part.type === "text" && part.text === `${scenario.name} overflow response`)
	);
}

describe("#7724 cold restore after overflow recovery", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	it("applies chained supersessions only on branches containing their replacements", () => {
		const manager = SessionManager.inMemory();
		const userEntryId = manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		const firstAttemptId = manager.appendMessage(
			fauxAssistantMessage("first attempt", { stopReason: "error", errorMessage: "overloaded" }),
		);
		const secondAttemptId = manager.appendMessage(
			fauxAssistantMessage("second attempt", { stopReason: "error", errorMessage: "overloaded" }),
			[firstAttemptId],
		);
		const recoveredEntryId = manager.appendMessage(fauxAssistantMessage("recovered"), [secondAttemptId]);

		expect(manager.buildContextEntries().map((entry) => entry.id)).toEqual([
			userEntryId,
			firstAttemptId,
			secondAttemptId,
			recoveredEntryId,
		]);

		expect(
			manager
				.buildSessionContext()
				.messages.filter((message) => message.role === "assistant")
				.map((message) => (message.content[0]?.type === "text" ? message.content[0].text : "")),
		).toEqual(["recovered"]);

		manager.branch(firstAttemptId);
		expect(
			manager
				.buildSessionContext()
				.messages.filter((message) => message.role === "assistant")
				.map((message) => (message.content[0]?.type === "text" ? message.content[0].text : "")),
		).toEqual(["first attempt"]);
	});

	it.each<Scenario>([
		{
			name: "length",
			stopReason: "length",
			contextWindow: 1000,
			seed: false,
		},
		{
			name: "error",
			stopReason: "error",
			errorMessage: "prompt is too long",
			contextWindow: 100_000,
			seed: true,
		},
	])("does not replay the superseded $name response", async (scenario) => {
		const tempDir = join(tmpdir(), `pi-7724-${scenario.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanups.push(() => {
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		});

		const faux: FauxProviderRegistration = registerFauxProvider({
			models: [{ id: "faux-1", contextWindow: scenario.contextWindow, maxTokens: 100 }],
		});
		cleanups.push(() => faux.unregister());
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRegistry = await createInMemoryModelRegistry(authStorage);
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models,
		});
		const modelRuntime = getModelRuntime(modelRegistry);
		const settings = { compaction: { keepRecentTokens: 1, reserveTokens: 0 } };
		const requests: Message[][] = [];
		const responses = [
			captureResponse(requests, `${scenario.name} overflow response`, {
				stopReason: scenario.stopReason,
				errorMessage: scenario.errorMessage,
			}),
			captureResponse(requests, `${scenario.name} compaction summary`),
			captureResponse(requests, `${scenario.name} recovered response`),
			captureResponse(requests, `${scenario.name} cold response`),
		];
		if (scenario.seed) {
			responses.unshift(captureResponse(requests, `${scenario.name} seed response`));
			responses.splice(3, 0, captureResponse(requests, `${scenario.name} split-turn summary`));
		}
		faux.setResponses(responses);

		const liveManager = SessionManager.create(tempDir, tempDir);
		const { session: liveSession } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			model,
			modelRuntime,
			noTools: "all",
			resourceLoader: createTestResourceLoader(),
			sessionManager: liveManager,
			settingsManager: SettingsManager.inMemory(settings),
		});
		cleanups.push(() => liveSession.dispose());

		if (scenario.seed) {
			await liveSession.prompt("seed turn");
		}
		await liveSession.prompt("x".repeat(5000));

		const liveHistory = structuredClone(convertToLlm(liveSession.messages));
		expect(liveHistory.some((message) => isOverflowAssistant(message, scenario))).toBe(false);
		const overflowEntry = liveManager
			.getEntries()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					isOverflowAssistant(entry.message, scenario),
			);
		expect(overflowEntry?.type).toBe("message");
		expect(
			liveManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.supersedesEntryIds?.includes(overflowEntry!.id),
				),
		).toBe(true);

		const sessionFile = liveManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		liveSession.dispose();

		const coldManager = SessionManager.open(sessionFile!, tempDir);
		const { session: coldSession } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			model,
			modelRuntime,
			noTools: "all",
			resourceLoader: createTestResourceLoader(),
			sessionManager: coldManager,
			settingsManager: SettingsManager.inMemory(settings),
		});
		cleanups.push(() => coldSession.dispose());
		expect(convertToLlm(coldSession.messages)).toEqual(liveHistory);

		await coldSession.prompt("after cold restore");

		const coldRequest = requests.at(-1);
		expect(coldRequest).toBeDefined();
		const coldHistory = coldRequest!.slice(0, -1);
		expect(coldHistory.some((message) => isOverflowAssistant(message, scenario))).toBe(false);
		expect(coldHistory).toEqual(liveHistory);
	});
});
