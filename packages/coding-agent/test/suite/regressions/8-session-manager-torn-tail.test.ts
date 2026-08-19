import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function assistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

describe("regression #8: unterminated session tail", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-tail-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createPersistedSession(): { manager: SessionManager; file: string } {
		const manager = SessionManager.create(tempDir, tempDir);
		manager.appendMessage(userMessage("你好"));
		manager.appendMessage(assistantMessage("hello"));
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected a persisted session file");
		return { manager, file };
	}

	function expectValidJsonl(file: string): void {
		const content = readFileSync(file, "utf8");
		expect(content.endsWith("\n")).toBe(true);
		for (const line of content.split("\n").filter(Boolean)) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	}

	it("removes an invalid final fragment before the next append", () => {
		const { file } = createPersistedSession();
		const intactContent = readFileSync(file);
		appendFileSync(file, '{"type":"message","content":"残');

		const recovered = SessionManager.open(file, tempDir);
		expect(readFileSync(file)).toEqual(intactContent);

		recovered.appendMessage(userMessage("u2"));
		recovered.appendMessage(assistantMessage("a2"));
		recovered.appendMessage(userMessage("u3"));
		expect(recovered.getBranch()).toHaveLength(5);

		const restored = SessionManager.open(file, tempDir);
		expect(restored.getBranch()).toHaveLength(5);
		expect(restored.getBranch().map((entry) => (entry.type === "message" ? entry.message.role : entry.type))).toEqual(
			["user", "assistant", "user", "assistant", "user"],
		);
		expectValidJsonl(file);
	});

	it("terminates a valid final record before the next append", () => {
		const { file } = createPersistedSession();
		const content = readFileSync(file);
		expect(content.at(-1)).toBe(0x0a);
		writeFileSync(file, content.subarray(0, content.length - 1));

		const recovered = SessionManager.open(file, tempDir);
		expect(readFileSync(file).at(-1)).toBe(0x0a);
		recovered.appendMessage(userMessage("u2"));

		const restored = SessionManager.open(file, tempDir);
		expect(restored.getBranch()).toHaveLength(3);
		expect(restored.getBranch().map((entry) => (entry.type === "message" ? entry.message.role : entry.type))).toEqual(
			["user", "assistant", "user"],
		);
		expectValidJsonl(file);
	});
});
