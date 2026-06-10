/**
 * Anthropic Claude Code subscription OAuth flow (billable)
 *
 * Port of the super-claude extension's OAuth half (`index.ts:43-696`), adapted to
 * core conventions. Unlike the legacy `anthropic.ts` flow (platform.claude.com,
 * which does NOT bill inference), this flow exchanges tokens against
 * `api.anthropic.com`, which issues `user:inference` tokens that bill against the
 * Claude Pro/Max subscription. It also resolves account identity (accountId/email)
 * and uses a separate random CSRF `state` (not the PKCE verifier).
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback server.
 * It is only intended for CLI use, not browser environments. It is NOT in the
 * browser-smoke graph (the browser entry does not import the Node OAuth flow), so
 * it follows the existing lazy-`node:http` convention rather than the static
 * node-import style used by the billing module reachable from `anthropic.ts`.
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { claudeCodeVersion } from "../../providers/claude-code-version.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

type CallbackResult = { code: string; state: string };

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
};

// Local Promise.withResolvers shim (the repo targets ES2022 lib; withResolvers is ES2024).
function deferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

type CallbackServerInfo = {
	server: Server;
	redirectUri: string;
	cancelWait: () => void;
	waitForCode: () => Promise<CallbackResult | null>;
	close: () => void;
};

type NodeApis = {
	createServer: typeof import("node:http").createServer;
};

let nodeApis: NodeApis | null = null;
let nodeApisPromise: Promise<NodeApis> | null = null;

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
// claude.ai issues user:inference tokens; platform.claude.com does not bill
// inference. The billable flow must exchange against api.anthropic.com.
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const BOOTSTRAP_URL = "https://api.anthropic.com/api/claude_cli/bootstrap";
const CLAUDE_CODE_BOOTSTRAP_MODEL = "claude-opus-4-8";
const CLAUDE_CODE_BOOTSTRAP_USER_AGENT = `claude-code/${claudeCodeVersion}`;
const CALLBACK_PORT = 54545;
const CALLBACK_PATH = "/callback";
const CLAUDE_CODE_UNAVAILABLE_MODEL_IDS = new Set(["claude-3-5-haiku-20241022", "claude-3-5-haiku-latest"]);
// Bind loopback IPv4 explicitly to avoid dual-stack "localhost" ambiguity, but
// advertise "localhost" in the redirect URI so it matches the OAuth client's
// allowed redirect (http://localhost:<port>/callback).
const CALLBACK_BIND_HOST = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
const CALLBACK_REDIRECT_HOST = "localhost";
// Scopes required for direct OAuth-token inference (user:inference) plus
// account/session management. Identical to core's legacy Anthropic flow.
const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

async function getNodeApis(): Promise<NodeApis> {
	if (nodeApis) return nodeApis;
	if (!nodeApisPromise) {
		if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
			throw new Error("Anthropic OAuth is only available in Node.js environments");
		}
		nodeApisPromise = import("node:http").then((httpModule) => ({
			createServer: httpModule.createServer,
		}));
	}
	nodeApis = await nodeApisPromise;
	return nodeApis;
}

// =============================================================================
// PKCE state / input parsing
// =============================================================================

function randomState(): string {
	// Random 16-byte hex CSRF state, independent of the PKCE verifier. (Legacy
	// platform OAuth in `anthropic.ts` reuses the verifier as state; the billable
	// flow uses a separate state to match the extension / Claude Code.)
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function buildAuthorizeUrl(redirectUri: string, challenge: string, state: string): string {
	const authParams = new URLSearchParams({
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: redirectUri,
		scope: SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
	});
	return `${AUTHORIZE_URL}?${authParams.toString()}`;
}

/** Parse a manual paste: full redirect URL, `code=...&state=...` query, or raw `code#state`. */
function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value.replace(/^[?#]/, ""));
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	const [code, state] = value.split("#", 2);
	return { code, state };
}

function formatErrorDetails(error: unknown): string {
	if (error instanceof Error) {
		const details: string[] = [`${error.name}: ${error.message}`];
		const errorWithCode = error as Error & { code?: string; errno?: number | string; cause?: unknown };
		if (errorWithCode.code) details.push(`code=${errorWithCode.code}`);
		if (typeof errorWithCode.errno !== "undefined") details.push(`errno=${String(errorWithCode.errno)}`);
		if (typeof error.cause !== "undefined") details.push(`cause=${formatErrorDetails(error.cause)}`);
		if (error.stack) details.push(`stack=${error.stack}`);
		return details.join("; ");
	}
	return String(error);
}

// =============================================================================
// HTTP helpers + token-response identity resolution
// =============================================================================

async function postJson(
	url: string,
	body: Record<string, string | number>,
	extraHeaders?: Record<string, string>,
): Promise<string> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			// No Accept header: Claude Code omits it on OAuth token requests.
			...extraHeaders,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});

	const responseBody = await response.text();
	if (!response.ok) {
		throw new Error(`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`);
	}
	return responseBody;
}

interface AnthropicTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	account?: { uuid?: string; email_address?: string };
}

interface AnthropicBootstrapResponse {
	oauth_account?: { account_uuid?: string; account_email?: string };
}

function parseOAuthTokenResponse(responseBody: string, operation: string): AnthropicTokenResponse {
	try {
		return JSON.parse(responseBody) as AnthropicTokenResponse;
	} catch (error) {
		throw new Error(
			`Anthropic ${operation} returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
		);
	}
}

function extractAccountFromTokenResponse(data: AnthropicTokenResponse): { accountId?: string; email?: string } {
	const accountUuid = data.account?.uuid;
	const emailAddress = data.account?.email_address;
	return {
		accountId: typeof accountUuid === "string" && accountUuid.length > 0 ? accountUuid : undefined,
		email: typeof emailAddress === "string" && emailAddress.length > 0 ? emailAddress : undefined,
	};
}

async function fetchBootstrapIdentity(accessToken: string): Promise<{ accountId?: string; email?: string }> {
	const url = `${BOOTSTRAP_URL}?entrypoint=cli&model=${encodeURIComponent(CLAUDE_CODE_BOOTSTRAP_MODEL)}`;
	const response = await fetch(url, {
		method: "GET",
		headers: {
			Accept: "application/json, text/plain, */*",
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			"User-Agent": CLAUDE_CODE_BOOTSTRAP_USER_AGENT,
			"anthropic-beta": "oauth-2025-04-20",
		},
		signal: AbortSignal.timeout(30_000),
	});
	const responseBody = await response.text();
	if (!response.ok) {
		throw new Error(`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`);
	}
	let data: AnthropicBootstrapResponse;
	try {
		data = JSON.parse(responseBody) as AnthropicBootstrapResponse;
	} catch (error) {
		throw new Error(
			`Anthropic bootstrap returned invalid JSON. url=${url}; body=${responseBody}; details=${formatErrorDetails(error)}`,
		);
	}
	const accountUuid = data.oauth_account?.account_uuid;
	const accountEmail = data.oauth_account?.account_email;
	return {
		accountId: typeof accountUuid === "string" && accountUuid.length > 0 ? accountUuid : undefined,
		email: typeof accountEmail === "string" && accountEmail.length > 0 ? accountEmail : undefined,
	};
}

async function resolveAccountIdentity(data: AnthropicTokenResponse): Promise<{ accountId?: string; email?: string }> {
	const identity = extractAccountFromTokenResponse(data);
	// Identity already complete on the token response: no bootstrap lookup needed.
	if (identity.accountId && identity.email) return identity;
	try {
		const bootstrap = await fetchBootstrapIdentity(data.access_token);
		return {
			accountId: identity.accountId ?? bootstrap.accountId,
			email: identity.email ?? bootstrap.email,
		};
	} catch {
		// Bootstrap lookup is non-fatal: login/refresh must still succeed even
		// without accountId/email.
		return identity;
	}
}

async function exchangeToken(
	code: string,
	state: string,
	redirectUri: string,
	verifier: string,
): Promise<OAuthCredentials> {
	let exchangeCode = code;
	let exchangeState = state;
	const codeFragmentIndex = code.indexOf("#");
	if (codeFragmentIndex >= 0) {
		exchangeCode = code.slice(0, codeFragmentIndex);
		const codeFragmentState = code.slice(codeFragmentIndex + 1);
		if (codeFragmentState.length > 0) exchangeState = codeFragmentState;
	}

	let responseBody: string;
	try {
		responseBody = await postJson(TOKEN_URL, {
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code: exchangeCode,
			state: exchangeState,
			redirect_uri: redirectUri,
			code_verifier: verifier,
		});
	} catch (error) {
		throw new Error(
			`Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${redirectUri}; response_type=authorization_code; details=${formatErrorDetails(error)}`,
		);
	}

	const tokenData = parseOAuthTokenResponse(responseBody, "token exchange");
	const { accountId, email } = await resolveAccountIdentity(tokenData);
	return {
		refresh: tokenData.refresh_token,
		access: tokenData.access_token,
		expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
		accountId,
		email,
	};
}

// =============================================================================
// Local callback server (node:http) — port 54545 with random-port fallback
// =============================================================================

async function startCallbackServer(expectedState: string): Promise<CallbackServerInfo> {
	const { createServer } = await getNodeApis();
	const { promise: waitForCodePromise, resolve: settleWait } = deferred<CallbackResult | null>();

	const handler = (req: IncomingMessage, res: ServerResponse): void => {
		try {
			const url = new URL(req.url || "", "http://localhost");
			if (url.pathname !== CALLBACK_PATH) {
				res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("Callback route not found."));
				return;
			}

			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state") || "";
			const error = url.searchParams.get("error") || "";
			const errorDescription = url.searchParams.get("error_description") || error;

			if (error) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("Anthropic authentication did not complete.", `Error: ${errorDescription}`));
				return;
			}
			if (!code) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("Missing authorization code."));
				return;
			}
			if (expectedState && state !== expectedState) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("State mismatch - possible CSRF attack."));
				return;
			}

			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(oauthSuccessHtml("Anthropic authentication completed. You can close this window."));
			settleWait({ code, state });
		} catch {
			res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Internal error");
		}
	};

	const listenOn = (port: number): Promise<Server> => {
		const { promise, resolve, reject } = deferred<Server>();
		const server = createServer(handler);
		const onError = (err: Error) => reject(err);
		server.once("error", onError);
		server.listen(port, CALLBACK_BIND_HOST, () => {
			server.removeListener("error", onError);
			resolve(server);
		});
		return promise;
	};

	let server: Server;
	try {
		server = await listenOn(CALLBACK_PORT);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
		// Port busy: fall back to a random free port. The actual redirect URI is
		// derived from the bound port below so the auth URL / token exchange all
		// agree.
		server = await listenOn(0);
	}

	const address = server.address();
	const actualPort = address && typeof address === "object" ? address.port : CALLBACK_PORT;
	const redirectUri = `http://${CALLBACK_REDIRECT_HOST}:${actualPort}${CALLBACK_PATH}`;

	return {
		server,
		redirectUri,
		cancelWait: () => settleWait(null),
		waitForCode: () => waitForCodePromise,
		close: () => server.close(),
	};
}

// =============================================================================
// Login + refresh
// =============================================================================

export async function loginAnthropicClaudeCode(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();
	const state = randomState();
	const server = await startCallbackServer(state);

	let code: string | undefined;
	let codeState: string | undefined;

	try {
		callbacks.onAuth({
			url: buildAuthorizeUrl(server.redirectUri, challenge, state),
			instructions:
				"Complete login in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.",
		});
		callbacks.onProgress?.("Waiting for browser authentication...");

		if (callbacks.onManualCodeInput) {
			// Race the browser callback against a single manual-paste attempt.
			let manualInput: string | undefined;
			let manualError: Error | undefined;
			const manualPromise = callbacks
				.onManualCodeInput()
				.then((input) => {
					manualInput = input;
					server.cancelWait();
				})
				.catch((err) => {
					manualError = err instanceof Error ? err : new Error(String(err));
					server.cancelWait();
				});

			const result = await server.waitForCode();
			if (manualError) throw manualError;
			if (result?.code) {
				code = result.code;
				codeState = result.state;
			} else if (manualInput) {
				const parsed = parseAuthorizationInput(manualInput);
				if (parsed.state && parsed.state !== state) throw new Error("OAuth state mismatch");
				code = parsed.code;
				codeState = parsed.state ?? state;
			}

			if (!code) {
				await manualPromise;
				if (manualError) throw manualError;
				if (manualInput) {
					const parsed = parseAuthorizationInput(manualInput);
					if (parsed.state && parsed.state !== state) throw new Error("OAuth state mismatch");
					code = parsed.code;
					codeState = parsed.state ?? state;
				}
			}
		} else {
			const result = await server.waitForCode();
			if (result?.code) {
				code = result.code;
				codeState = result.state;
			}
		}

		if (!code) {
			// Final fallback: prompt for a pasted code / redirect URL.
			const input = await callbacks.onPrompt({
				message: "Paste the authorization code or full redirect URL:",
				placeholder: server.redirectUri,
			});
			const parsed = parseAuthorizationInput(input);
			if (parsed.state && parsed.state !== state) throw new Error("OAuth state mismatch");
			code = parsed.code;
			codeState = parsed.state ?? state;
		}

		if (!code) throw new Error("Missing authorization code");
		if (!codeState) throw new Error("Missing OAuth state");

		callbacks.onProgress?.("Exchanging authorization code for tokens...");
		return await exchangeToken(code, codeState, server.redirectUri, verifier);
	} finally {
		server.close();
	}
}

export async function refreshAnthropicClaudeCode(refreshToken: string): Promise<OAuthCredentials> {
	let responseBody: string;
	try {
		responseBody = await postJson(
			TOKEN_URL,
			{
				grant_type: "refresh_token",
				client_id: CLIENT_ID,
				refresh_token: refreshToken,
			},
			{
				// Claude Code sends these on refresh but not on the initial code exchange.
				"anthropic-beta": "oauth-2025-04-20",
				"User-Agent": "anthropic-sdk-typescript/0.94.0 userOAuthProvider",
			},
		);
	} catch (error) {
		throw new Error(`Anthropic token refresh request failed. url=${TOKEN_URL}; details=${formatErrorDetails(error)}`);
	}

	const data = parseOAuthTokenResponse(responseBody, "token refresh");
	const { accountId, email } = await resolveAccountIdentity(data);
	return {
		// Preserve the old refresh token when the response omits/empties it.
		refresh: data.refresh_token || refreshToken,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
		accountId,
		email,
	};
}

export const anthropicClaudeCodeOAuthProvider: OAuthProviderInterface = {
	id: "anthropic",
	name: "Anthropic (Claude Code subscription)",
	usesCallbackServer: true,

	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginAnthropicClaudeCode(callbacks);
	},

	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshAnthropicClaudeCode(credentials.refresh);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},

	modifyModels(models) {
		return models.filter(
			(model) => model.provider !== "anthropic" || !CLAUDE_CODE_UNAVAILABLE_MODEL_IDS.has(model.id),
		);
	},
};
