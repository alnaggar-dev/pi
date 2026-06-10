import * as fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AnthropicOptions } from "../src/providers/anthropic.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context, Model } from "../src/types.ts";
import { __testing as installIdTesting } from "../src/utils/install-id.ts";

const OAUTH_KEY = "sk-ant-oat-test-token";
const API_KEY = "sk-ant-api03-test";

interface CapturedRequest {
	headers: IncomingMessage["headers"];
	rawBody: string;
	url: string | undefined;
	body: Record<string, unknown>;
}

let tmpDir: string;
let prevAgentDir: string | undefined;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-stream-"));
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

function createModel(baseUrl: string, id = "claude-opus-4-8"): Model<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat: { forceAdaptiveThinking: true },
	};
}

function createContext(): Context {
	return {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Hello there, friend!", timestamp: Date.now() }],
	};
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function capture(model: Model<"anthropic-messages">, options: AnthropicOptions): Promise<CapturedRequest> {
	let captured: CapturedRequest | undefined;
	const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
		const rawBody = await readRequestBody(request);
		captured = { headers: request.headers, url: request.url, rawBody, body: JSON.parse(rawBody) };
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	try {
		const stream = streamAnthropic(
			{ ...model, baseUrl: `http://127.0.0.1:${address.port}` },
			createContext(),
			options,
		);
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}
	} finally {
		await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
	}
	if (!captured) throw new Error("request not captured");
	return captured;
}

function systemBlocks(body: Record<string, unknown>): Array<{ text: string; cache_control?: unknown }> {
	return (body.system ?? []) as Array<{ text: string; cache_control?: unknown }>;
}

describe.sequential("Anthropic Claude Code stream integration", () => {
	it("relocates the agent prompt into the first user message (2-block CC system), cloaks user_id, sets UA, finalizes cch", async () => {
		const accountUuid = "3f3a072d-1111-4222-8333-123456789abc";
		const req = await capture(createModel("x"), {
			apiKey: OAUTH_KEY,
			cacheRetention: "none",
			metadata: { account_uuid: accountUuid },
			// Additive onPayload mutation: must not strip system/metadata.
			onPayload: (params) => ({ ...(params as Record<string, unknown>), top_k: 7 }),
		});

		// Headers.
		expect(req.headers["user-agent"]).toBe("claude-cli/2.1.165 (external, local-agent, agent-sdk/0.3.165)");
		expect(req.headers["x-client-request-id"]).toBeTruthy();
		expect(req.headers["anthropic-client-version"]).toBeTruthy();
		expect(req.headers["x-stainless-lang"]).toBe("js");
		expect(req.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
		expect(req.url).toBe("/v1/messages?beta=true");

		// Body: system reduced to [billing header, Claude Code instruction]; the agent
		// system prompt is relocated into the first user message (the billing-gate fix).
		const blocks = systemBlocks(req.body);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].text).toContain("x-anthropic-billing-header:");
		expect(blocks[1].text).toBe("You are a Claude agent, built on Anthropic's Claude Agent SDK.");

		// Relocated agent prompt is the leading block of the first user message,
		// followed by the original user content.
		const messages = req.body.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
		const firstUser = messages.find((message) => message.role === "user");
		expect(firstUser?.content[0]).toMatchObject({ type: "text", text: "You are a helpful assistant." });
		expect(firstUser?.content.some((b) => b.text === "Hello there, friend!")).toBe(true);

		// Additive onPayload mutation survived.
		expect(req.body.top_k).toBe(7);

		// Cloaked metadata.user_id.
		const metadata = req.body.metadata as { user_id?: string };
		const userId = JSON.parse(metadata.user_id ?? "{}");
		expect(typeof userId.device_id).toBe("string");
		expect(typeof userId.session_id).toBe("string");
		expect(userId.account_uuid).toBe(accountUuid);

		// cch finalized on the wire (5 hex, not the 00000 placeholder).
		expect(req.rawBody).not.toContain("cch=00000");
		expect(req.rawBody).toMatch(/cch=[0-9a-f]{5};/);
	});

	it("serializes OAuth bodies in real Claude Code's canonical field order with tools:[]", async () => {
		const req = await capture(createModel("x"), { apiKey: OAUTH_KEY, cacheRetention: "none" });
		// Field order must match real Claude Code: model → messages → system → tools →
		// metadata → max_tokens → stream. Anthropic validates request shape (not just
		// the billing-header fingerprint) before billing against the subscription.
		const keys = Object.keys(req.body);
		expect(keys).toEqual(["model", "messages", "system", "tools", "metadata", "max_tokens", "stream"]);
		// Real Claude Code always sends a tools array (empty when no tools).
		expect(req.body.tools).toEqual([]);
	});

	it("adds the effort beta on API-key adaptive requests that carry output_config", async () => {
		// Thinking on: adaptive effort field needs effort-2025-11-24 on API keys
		// (the OAuth Claude Code agent beta list already carries it).
		const on = await capture(createModel("x"), {
			apiKey: "sk-ant-api-test-key",
			cacheRetention: "none",
			thinkingEnabled: true,
			effort: "high",
		});
		expect(on.headers["anthropic-beta"]).toContain("effort-2025-11-24");

		// Thinking off on an adaptive-only model: the effort:"low" pin replaces
		// thinking.type "disabled" (which these models 400 on) and also needs the beta.
		const off = await capture(createModel("x"), {
			apiKey: "sk-ant-api-test-key",
			cacheRetention: "none",
			thinkingEnabled: false,
		});
		expect(off.headers["anthropic-beta"]).toContain("effort-2025-11-24");
		expect(off.body.output_config).toEqual({ effort: "low" });
		expect(off.body.thinking).toBeUndefined();
	});

	it("keeps thinking/context_management after max_tokens and clamps max_tokens with thinking on", async () => {
		// Real Claude Code emits `thinking`/`output_config` AFTER `max_tokens` (not after
		// `tools`) and clamps `max_tokens` to 64k. Lock pi's OAuth body to that canonical
		// wire order for oh-my-pi parity. (Subscription billing is driven by the billing
		// header + cch, not this order; the live API accepts looser shapes — parity is
		// defensive faithfulness to the real client.)
		const req = await capture(
			{ ...createModel("x"), maxTokens: 128000 },
			{ apiKey: OAUTH_KEY, cacheRetention: "none", thinkingEnabled: true, effort: "high" },
		);
		expect(Object.keys(req.body)).toEqual([
			"model",
			"messages",
			"system",
			"tools",
			"metadata",
			"max_tokens",
			"thinking",
			"context_management",
			"output_config",
			"stream",
		]);
		// Clamped to Claude Code's 64k output ceiling (model.maxTokens is 128k).
		expect(req.body.max_tokens).toBe(64000);
		// Adaptive thinking carries the clear-thinking context_management edit.
		expect(req.body.thinking).toMatchObject({ type: "adaptive" });
		expect(req.body.context_management).toEqual({
			edits: [{ type: "clear_thinking_20251015", keep: "all" }],
		});
		expect(req.body.output_config).toEqual({ effort: "high" });
	});

	it("omits adaptive thinking `display` on Opus 4.6 but keeps it on Opus 4.7+", async () => {
		// Real Claude Code omits the adaptive `display` field on Opus 4.6 / Sonnet 4.6
		// and includes it on 4.7+. Lock that oh-my-pi parity. (The live API accepts
		// `display` on 4.6 too, so this is faithfulness, not a hard requirement.)
		const opts = {
			apiKey: OAUTH_KEY,
			cacheRetention: "none" as const,
			thinkingEnabled: true,
			effort: "high" as const,
		};
		const v46 = await capture(createModel("x", "claude-opus-4-6"), opts);
		expect(v46.body.thinking).toEqual({ type: "adaptive" });
		const v48 = await capture(createModel("x", "claude-opus-4-8"), opts);
		expect(v48.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
	});

	it("applies the 1h cache ttl only against the canonical Anthropic API base URL", async () => {
		// capture() routes to a local 127.0.0.1 server, so it can't exercise the
		// api.anthropic.com ttl gate. Stub global fetch instead (wrapFetchForCch wraps
		// it) so the OAuth request can target a real api.anthropic.com base URL.
		async function captureBody(baseUrl: string): Promise<Record<string, unknown>> {
			let body: Record<string, unknown> | undefined;
			const stub = vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
				// wrapFetchForCch rewrites the body to a Uint8Array; decode either form.
				const raw = init?.body;
				const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array);
				body = JSON.parse(text || "{}");
				return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
			});
			vi.stubGlobal("fetch", stub);
			try {
				const stream = streamAnthropic(createModel(baseUrl), createContext(), { apiKey: OAUTH_KEY });
				for await (const event of stream) {
					if (event.type === "done" || event.type === "error") break;
				}
			} finally {
				vi.unstubAllGlobals();
			}
			if (!body) throw new Error("request not captured");
			return body;
		}

		// The relocated agent prompt (first block of the first user message) carries the
		// cache_control breakpoint; the trimmed system blocks (billing header + CC
		// instruction) do not. Same cacheControl value as the old system[2] breakpoint.
		function relocatedBlock(body: Record<string, unknown>): { cache_control?: { ttl?: string } } {
			const messages = body.messages as Array<{
				role: string;
				content: Array<{ cache_control?: { ttl?: string } }>;
			}>;
			const firstUser = messages.find((message) => message.role === "user");
			if (!firstUser) throw new Error("no user message");
			return firstUser.content[0];
		}
		// Default retention + api.anthropic.com base URL → ttl: "1h" like real CC.
		expect(relocatedBlock(await captureBody("https://api.anthropic.com")).cache_control).toEqual({
			type: "ephemeral",
			ttl: "1h",
		});
		// A non-canonical base URL (third-party proxy) must NOT carry the 1h ttl.
		expect(relocatedBlock(await captureBody("https://proxy.example.com")).cache_control).toEqual({
			type: "ephemeral",
		});
	});

	it("leaves API-key requests untouched (no billing header, no cloak, no cch)", async () => {
		const req = await capture(createModel("x"), { apiKey: API_KEY, cacheRetention: "none" });
		const blocks = systemBlocks(req.body);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].text).toBe("You are a helpful assistant.");
		expect(req.rawBody).not.toContain("x-anthropic-billing-header:");
		expect(req.rawBody).not.toContain("cch=");
		expect(req.body.metadata).toBeUndefined();
		expect(req.headers["user-agent"]).not.toContain("local-agent");
		expect(req.url).toBe("/v1/messages");
	});

	it("Haiku 3.5 OAuth requests get a plain system and no cch", async () => {
		const req = await capture(createModel("x", "claude-3-5-haiku-20241022"), {
			apiKey: OAUTH_KEY,
			cacheRetention: "none",
		});
		const blocks = systemBlocks(req.body);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].text).toBe("You are a helpful assistant.");
		expect(req.rawBody).not.toContain("x-anthropic-billing-header:");
		expect(req.rawBody).not.toContain("cch=");
	});

	it("overrides caller-supplied enforced headers on the wire", async () => {
		const req = await capture(createModel("x"), {
			apiKey: OAUTH_KEY,
			cacheRetention: "none",
			headers: {
				"User-Agent": "curl/8.4",
				"anthropic-beta": "evil-beta",
				"x-client-request-id": "caller-controlled",
			},
		});
		expect(req.headers["user-agent"]).toBe("claude-cli/2.1.165 (external, local-agent, agent-sdk/0.3.165)");
		expect(req.headers["anthropic-beta"]).not.toBe("evil-beta");
		expect(req.headers["x-client-request-id"]).not.toBe("caller-controlled");
	});

	it("emits X-Claude-Code-Session-Id even when cache retention is off", async () => {
		const req = await capture(createModel("x"), {
			apiKey: OAUTH_KEY,
			cacheRetention: "none",
			sessionId: "my-session-id",
		});
		expect(req.headers["x-claude-code-session-id"]).toBe("my-session-id");
	});
});
