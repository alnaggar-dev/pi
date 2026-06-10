import * as nodeCrypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __testing } from "../src/providers/anthropic-claude-code.ts";
import { getInstallId, __testing as installIdTesting } from "../src/utils/install-id.ts";
import { generatePKCE } from "../src/utils/oauth/pkce.ts";

const {
	createClaudeBillingHeader,
	buildClaudeCodeSystemBlocks,
	relocateSystemPromptIntoMessages,
	buildClaudeCodeOAuthHeaders,
	resolveClaudeCodeUserId,
	isClaudeCloakingUserId,
	isClaudeJsonUserId,
	patchCch,
	xxHash64,
	extractClaudeCodeFirstUserMessageText,
} = __testing;

const CLAUDE_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

let tmpDir: string;
let prevAgentDir: string | undefined;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-install-id-"));
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmpDir;
	installIdTesting.resetInstallIdCache();
});

afterAll(() => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	installIdTesting.resetInstallIdCache();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildClaudeCodeSystemBlocks", () => {
	const cacheControl = { type: "ephemeral" } as const;

	it("emits 3 blocks with a system prompt, only block[2] cached", () => {
		const blocks = buildClaudeCodeSystemBlocks("big", true, "hi", cacheControl) ?? [];
		expect(blocks).toHaveLength(3);
		expect(blocks[0].text).toContain(CLAUDE_BILLING_HEADER_PREFIX);
		expect(blocks[2].text).toBe("big");
		expect(blocks[0].cache_control).toBeUndefined();
		expect(blocks[1].cache_control).toBeUndefined();
		expect(blocks[2].cache_control).toEqual(cacheControl);
	});

	it("emits 2 blocks with no system prompt and no cache", () => {
		const blocks = buildClaudeCodeSystemBlocks(undefined, true, "hi", cacheControl) ?? [];
		expect(blocks).toHaveLength(2);
		expect(blocks[0].text).toContain(CLAUDE_BILLING_HEADER_PREFIX);
		expect(blocks[0].cache_control).toBeUndefined();
		expect(blocks[1].cache_control).toBeUndefined();
	});

	it("Haiku guard: includeClaudeCodeInstruction=false emits plain layout", () => {
		const blocks = buildClaudeCodeSystemBlocks("sys", false, "hi", cacheControl) ?? [];
		expect(blocks).toHaveLength(1);
		expect(blocks[0].text).toBe("sys");
		expect(blocks[0].cache_control).toEqual(cacheControl);
	});

	it("is idempotent when the prompt already carries the billing header", () => {
		const prompt = `${CLAUDE_BILLING_HEADER_PREFIX} cc_version=x; existing`;
		const blocks = buildClaudeCodeSystemBlocks(prompt, true, "hi", undefined) ?? [];
		expect(blocks).toHaveLength(1);
		expect(blocks[0].text).toBe(prompt);
	});

	it("still injects when the prompt merely mentions the billing header mid-text", () => {
		// The resumed-session guard is anchored with startsWith: a prompt that
		// only *mentions* the header text must not suppress the whole injection.
		const prompt = `Documentation note: requests carry "${CLAUDE_BILLING_HEADER_PREFIX}" markers.`;
		const blocks = buildClaudeCodeSystemBlocks(prompt, true, "hi", undefined) ?? [];
		expect(blocks).toHaveLength(3);
		expect(blocks[0].text).toContain(CLAUDE_BILLING_HEADER_PREFIX);
		expect(blocks[2].text).toBe(prompt);
	});
});

describe("relocateSystemPromptIntoMessages", () => {
	const cacheControl = { type: "ephemeral" } as const;

	it("prepends the prompt as the first user message's leading block, cached", () => {
		const messages = [{ role: "user", content: [{ type: "text", text: "hi" }] }] as never[];
		relocateSystemPromptIntoMessages(messages, "AGENT PROMPT", cacheControl);
		const content = (messages[0] as { content: Array<Record<string, unknown>> }).content;
		expect(content).toHaveLength(2);
		expect(content[0]).toEqual({ type: "text", text: "AGENT PROMPT", cache_control: cacheControl });
		expect(content[1]).toEqual({ type: "text", text: "hi" });
	});

	it("converts string content to blocks with the prompt first (no cache when omitted)", () => {
		const messages = [{ role: "user", content: "hi" }] as never[];
		relocateSystemPromptIntoMessages(messages, "AGENT PROMPT", undefined);
		expect((messages[0] as { content: unknown }).content).toEqual([
			{ type: "text", text: "AGENT PROMPT" },
			{ type: "text", text: "hi" },
		]);
	});

	it("targets the first user message, leaving a leading assistant turn untouched", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "a" }] },
			{ role: "user", content: [{ type: "text", text: "u" }] },
		] as never[];
		relocateSystemPromptIntoMessages(messages, "P", undefined);
		expect((messages[0] as { content: unknown }).content).toEqual([{ type: "text", text: "a" }]);
		expect((messages[1] as { content: unknown }).content).toEqual([
			{ type: "text", text: "P" },
			{ type: "text", text: "u" },
		]);
	});

	it("inserts a new user message when none exists", () => {
		const messages = [] as never[];
		relocateSystemPromptIntoMessages(messages, "P", undefined);
		expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: "P" }] }]);
	});

	it("is a no-op for a blank prompt", () => {
		const messages = [{ role: "user", content: "hi" }] as never[];
		relocateSystemPromptIntoMessages(messages, "   ", cacheControl);
		expect(messages).toEqual([{ role: "user", content: "hi" }]);
	});
});

describe("createClaudeBillingHeader", () => {
	it("emits the expected shape with cc_entrypoint=local-agent and cch placeholder", () => {
		const header = createClaudeBillingHeader("hello world example");
		expect(header).toMatch(
			/^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+\.[0-9a-f]{3}; cc_entrypoint=local-agent; cch=00000;$/,
		);
	});
});

describe("patchCch", () => {
	it("rewrites cch=00000 to 5 lowercase hex chars", () => {
		const billingHeader = createClaudeBillingHeader("x");
		const body = JSON.stringify({
			messages: [{ role: "user", content: "hi" }],
			system: [{ type: "text", text: billingHeader }],
		});
		const bytes = new TextEncoder().encode(body);
		const patched = patchCch(bytes);
		const out = new TextDecoder().decode(patched);
		expect(out).not.toContain("cch=00000");
		expect(out).toMatch(/cch=[0-9a-f]{5};/);
	});

	it("passes bodies without the marker through unchanged", () => {
		const body = new TextEncoder().encode(JSON.stringify({ messages: [], system: [] }));
		const copy = body.slice();
		const out = patchCch(body);
		expect(out).toEqual(copy);
	});
});

describe("xxHash64", () => {
	it("matches canonical reference vectors", () => {
		// Reference vectors generated from the canonical xxhash algorithm (Python
		// `xxhash` library), NOT self-derived from this BigInt port.
		expect(xxHash64(new TextEncoder().encode(""), 0n)).toBe(0xef46db3751d8e999n);
		expect(xxHash64(new TextEncoder().encode("Hello, World!"), 0n)).toBe(0xc49aacf8080fe47fn);
		expect(xxHash64(new TextEncoder().encode("Hello, World!"), 0x4d659218e32a3268n)).toBe(0x2dcee8859a6f449cn);
		expect(xxHash64(new TextEncoder().encode("The quick brown fox jumps over the lazy dog"), 0n)).toBe(
			0xb242d361fda71bcn,
		);
	});
});

describe("resolveClaudeCodeUserId", () => {
	it("mints a stable {device_id, session_id} JSON for absent input", () => {
		const a = resolveClaudeCodeUserId(undefined);
		const b = resolveClaudeCodeUserId(undefined);
		const pa = JSON.parse(a ?? "{}");
		const pb = JSON.parse(b ?? "{}");
		const expectedDevice = nodeCrypto
			.createHash("sha256")
			.update(`omp-claude-device-id-v1:${getInstallId()}`)
			.digest("hex");
		expect(pa.device_id).toBe(expectedDevice);
		expect(pb.device_id).toBe(expectedDevice);
		expect(typeof pa.session_id).toBe("string");
		expect(pa.session_id).not.toBe(pb.session_id);
	});

	it("mints account-scoped Claude Code metadata when account id is present", () => {
		const accountId = "3f3a072d-1111-4222-8333-123456789abc";
		const sessionId = "session-123";
		const parsed = JSON.parse(resolveClaudeCodeUserId(undefined, sessionId, accountId) ?? "{}");
		const expectedDevice = nodeCrypto
			.createHash("sha256")
			.update("omp-claude-device-id-v2")
			.update("\0")
			.update(getInstallId())
			.update("\0")
			.update(accountId)
			.digest("hex");
		expect(parsed).toEqual({
			device_id: expectedDevice,
			session_id: sessionId,
			account_uuid: accountId,
		});
	});

	it("passes through a valid CC JSON user id untouched", () => {
		const json = JSON.stringify({ device_id: "d", session_id: "stable-session" });
		expect(isClaudeJsonUserId(json)).toBe(true);
		expect(resolveClaudeCodeUserId(json)).toBe(json);
	});

	it("passes through a cloaking-format id untouched", () => {
		const cloak = `user_${"a".repeat(64)}_account_${nodeCrypto.randomUUID()}_session_${nodeCrypto.randomUUID()}`;
		expect(isClaudeCloakingUserId(cloak)).toBe(true);
		expect(resolveClaudeCodeUserId(cloak)).toBe(cloak);
	});
});

describe("getInstallId", () => {
	it("mints, persists, and returns a stable UUID", () => {
		const id = getInstallId();
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
		expect(getInstallId()).toBe(id);
		const stored = fs.readFileSync(path.join(tmpDir, "install-id"), "utf8").trim();
		expect(stored).toBe(id);
	});
});

describe("buildClaudeCodeOAuthHeaders", () => {
	const base = { apiKey: "sk-ant-oat-test" };

	it("overrides caller attempts at enforced headers", () => {
		const headers = buildClaudeCodeOAuthHeaders({
			...base,
			modelHeaders: {
				"User-Agent": "curl/8.4",
				"anthropic-beta": "evil",
				"x-client-request-id": "caller-id",
				Authorization: "Bearer caller",
				"X-Api-Key": "leaked",
				"X-Stainless-Lang": "python",
			},
		});
		expect(headers["User-Agent"]).toMatch(/^claude-cli\//);
		expect(headers["anthropic-beta"]).not.toBe("evil");
		expect(headers["x-client-request-id"]).not.toBe("caller-id");
		expect(headers.Authorization).toBe("Bearer sk-ant-oat-test");
		expect(headers["X-Api-Key"]).toBeUndefined();
		expect(headers["X-Stainless-Lang"]).toBe("js");
	});

	it("passes through a Claude Code-shaped caller UA", () => {
		const headers = buildClaudeCodeOAuthHeaders({
			...base,
			optionsHeaders: { "User-Agent": "claude-cli/9.9.9 (external)" },
		});
		expect(headers["User-Agent"]).toBe("claude-cli/9.9.9 (external)");
	});

	it("emits X-Claude-Code-Session-Id only when a session id is supplied", () => {
		const withId = buildClaudeCodeOAuthHeaders({ ...base, claudeCodeSessionId: "sess-1" });
		expect(withId["X-Claude-Code-Session-Id"]).toBe("sess-1");
		const without = buildClaudeCodeOAuthHeaders(base);
		expect(without["X-Claude-Code-Session-Id"]).toBeUndefined();
	});
});

describe("extractClaudeCodeFirstUserMessageText", () => {
	it("returns the first user text block", () => {
		expect(
			extractClaudeCodeFirstUserMessageText([
				{ role: "assistant", content: "ignored" },
				{ role: "user", content: [{ type: "text", text: "first" }] },
			] as never),
		).toBe("first");
	});
});

describe("generatePKCE (96-byte verifier)", () => {
	it("produces a 128-char verifier and matching challenge", async () => {
		const { verifier, challenge } = await generatePKCE();
		expect(verifier).toHaveLength(128);
		const expected = nodeCrypto.createHash("sha256").update(verifier).digest("base64url");
		expect(challenge).toBe(expected);
	});
});
