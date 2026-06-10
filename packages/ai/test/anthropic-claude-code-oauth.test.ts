import { afterEach, describe, expect, it, vi } from "vitest";
import { loginAnthropicClaudeCode, refreshAnthropicClaudeCode } from "../src/utils/oauth/anthropic-claude-code.ts";
import { getOAuthProvider } from "../src/utils/oauth/index.ts";
import type { OAuthLoginCallbacks } from "../src/utils/oauth/types.ts";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function getJsonBody(init?: RequestInit): Record<string, string> {
	if (typeof init?.body !== "string") {
		throw new Error(`Expected string request body, got ${typeof init?.body}`);
	}
	return JSON.parse(init.body) as Record<string, string>;
}

// The login flow's OAuthLoginCallbacks now require onDeviceCode and onSelect even
// though this flow does not use them.
function makeCallbacks(overrides: Partial<OAuthLoginCallbacks>): OAuthLoginCallbacks {
	return {
		onAuth: () => {},
		onDeviceCode: () => {},
		onPrompt: async () => "",
		onSelect: async () => undefined,
		...overrides,
	};
}

describe.sequential("Anthropic Claude Code OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("exchanges manual code against api.anthropic.com and resolves identity", async () => {
		let authUrl = "";
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url === "https://api.anthropic.com/v1/oauth/token") {
				expect(init?.method).toBe("POST");
				const body = getJsonBody(init);
				expect(body.grant_type).toBe("authorization_code");
				expect(body.code).toBe("manual-code");
				const authParsed = new URL(authUrl);
				expect(body.redirect_uri).toBe(authParsed.searchParams.get("redirect_uri"));
				return jsonResponse({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
					account: { uuid: "acct-uuid", email_address: "user@example.com" },
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await loginAnthropicClaudeCode(
			makeCallbacks({
				onAuth: (info) => {
					authUrl = info.url;
				},
				onManualCodeInput: async () => {
					const url = new URL(authUrl);
					const state = url.searchParams.get("state");
					const redirectUri = url.searchParams.get("redirect_uri");
					if (!state || !redirectUri) throw new Error("Missing state or redirect_uri");
					return `${redirectUri}?code=manual-code&state=${state}`;
				},
			}),
		);

		expect(credentials.access).toBe("access-token");
		expect(credentials.refresh).toBe("refresh-token");
		expect(credentials.accountId).toBe("acct-uuid");
		expect(credentials.email).toBe("user@example.com");
		// Token response carried identity, so bootstrap GET was not needed.
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("uses the actual server.redirectUri across auth URL and token exchange", async () => {
		let authUrl = "";
		let promptPlaceholder = "";
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url === "https://api.anthropic.com/v1/oauth/token") {
				const body = getJsonBody(init);
				const authRedirect = new URL(authUrl).searchParams.get("redirect_uri");
				expect(body.redirect_uri).toBe(authRedirect);
				expect(promptPlaceholder).toBe(authRedirect);
				return jsonResponse({
					access_token: "a",
					refresh_token: "r",
					expires_in: 3600,
					account: { uuid: "u", email_address: "e@e.com" },
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		await loginAnthropicClaudeCode(
			makeCallbacks({
				onAuth: (info) => {
					authUrl = info.url;
				},
				// Empty manual input forces the onPrompt fallback path.
				onManualCodeInput: async () => "",
				onPrompt: async (prompt) => {
					promptPlaceholder = prompt.placeholder ?? "";
					const url = new URL(authUrl);
					const state = url.searchParams.get("state");
					return `${url.searchParams.get("redirect_uri")}?code=c&state=${state}`;
				},
			}),
		);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("refreshes with oauth beta + CC user-agent and resolves identity", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			expect(url).toBe("https://api.anthropic.com/v1/oauth/token");
			expect(init?.method).toBe("POST");
			const headers = init?.headers as Record<string, string>;
			expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
			expect(headers["User-Agent"]).toContain("userOAuthProvider");
			const body = getJsonBody(init);
			expect(body.grant_type).toBe("refresh_token");
			expect(body.refresh_token).toBe("old-refresh");
			return jsonResponse({
				access_token: "new-access",
				refresh_token: "new-refresh",
				expires_in: 3600,
				account: { uuid: "acct", email_address: "x@y.com" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await refreshAnthropicClaudeCode("old-refresh");
		expect(credentials.access).toBe("new-access");
		expect(credentials.refresh).toBe("new-refresh");
		expect(credentials.accountId).toBe("acct");
		expect(credentials.email).toBe("x@y.com");
	});

	it("falls back to bootstrap identity when the token response omits it", async () => {
		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);
			if (url === "https://api.anthropic.com/v1/oauth/token") {
				return jsonResponse({ access_token: "a", refresh_token: "r", expires_in: 3600 });
			}
			if (url.startsWith("https://api.anthropic.com/api/claude_cli/bootstrap")) {
				return jsonResponse({
					oauth_account: { account_uuid: "boot-uuid", account_email: "boot@example.com" },
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await refreshAnthropicClaudeCode("r");
		expect(credentials.accountId).toBe("boot-uuid");
		expect(credentials.email).toBe("boot@example.com");
	});

	it("treats a failing bootstrap lookup as non-fatal", async () => {
		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);
			if (url === "https://api.anthropic.com/v1/oauth/token") {
				return jsonResponse({ access_token: "a", refresh_token: "r", expires_in: 3600 });
			}
			if (url.startsWith("https://api.anthropic.com/api/claude_cli/bootstrap")) {
				return jsonResponse({ error: "nope" }, 500);
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await refreshAnthropicClaudeCode("r");
		expect(credentials.access).toBe("a");
		expect(credentials.accountId).toBeUndefined();
		expect(credentials.email).toBeUndefined();
	});

	it("preserves the old refresh token when the response omits it", async () => {
		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);
			if (url === "https://api.anthropic.com/v1/oauth/token") {
				return jsonResponse({
					access_token: "a",
					refresh_token: "",
					expires_in: 3600,
					account: { uuid: "u", email_address: "e@e.com" },
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await refreshAnthropicClaudeCode("kept-refresh");
		expect(credentials.refresh).toBe("kept-refresh");
	});

	it("is the default anthropic OAuth provider", () => {
		expect(getOAuthProvider("anthropic")?.name).toBe("Anthropic (Claude Code subscription)");
	});

	it("hides Claude Code-unavailable Haiku 3.5 models for OAuth accounts", () => {
		const provider = getOAuthProvider("anthropic");
		const models = provider?.modifyModels?.(
			[
				{ provider: "anthropic", id: "claude-3-5-haiku-latest" },
				{ provider: "anthropic", id: "claude-3-5-haiku-20241022" },
				{ provider: "anthropic", id: "claude-haiku-4-5" },
				{ provider: "openrouter", id: "claude-3-5-haiku-latest" },
			] as any,
			{ access: "sk-ant-oat-test", refresh: "r", expires: Date.now() + 1000 },
		);
		expect(models?.map((model) => `${model.provider}/${model.id}`)).toEqual([
			"anthropic/claude-haiku-4-5",
			"openrouter/claude-3-5-haiku-latest",
		]);
	});
});
