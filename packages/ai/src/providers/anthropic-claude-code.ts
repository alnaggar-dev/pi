import * as nodeCrypto from "node:crypto";
import type {
	CacheControlEphemeral,
	ContentBlockParam,
	MessageParam,
	TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import type { Message } from "../types.ts";
import { getInstallId } from "../utils/install-id.ts";

// =============================================================================
// Anthropic Claude Code subscription billing (fork-owned, node-only)
// =============================================================================
//
// Port of the super-claude extension's billing half + oh-my-pi's faithful Claude
// Code emulation. This module statically imports `node:crypto`, so it must NEVER
// be reachable from a top-level static `import` in `anthropic.ts` — that would
// pull node APIs into the `platform: browser` esbuild bundle and fail
// `check:browser-smoke`. `anthropic.ts` loads it on the OAuth path through an
// `importNodeOnlyProvider`-style runtime-specifier shim instead.

// --- version / fingerprint constants -------------------------------------
// Stealth mode: mimic Claude Code's request fingerprint. Shared via the
// browser-safe claude-code-version module so the OAuth bootstrap UA cannot
// drift from the Messages API surface (oh-my-pi parity).
import { claudeAgentSdkVersion, claudeClientVersion, claudeCodeVersion } from "./claude-code-version.ts";

export { claudeAgentSdkVersion, claudeClientVersion, claudeCodeVersion };
export const claudeCodeSystemInstruction = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

// --- beta header ----------------------------------------------------------
// Build deduplicated beta header string (port of oh-my-pi buildBetaHeader).
export function buildBetaHeader(baseBetas: readonly string[], extraBetas: readonly string[]): string {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const beta of [...baseBetas, ...extraBetas]) {
		const trimmed = beta.trim();
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			result.push(trimmed);
		}
	}
	return result.join(",");
}

const claudeCodeUtilityBetaDefaults = [
	"oauth-2025-04-20",
	"interleaved-thinking-2025-05-14",
	"context-management-2025-06-27",
	"prompt-caching-scope-2026-01-05",
	"structured-outputs-2025-12-15",
] as const;
const claudeCodeAgentBetaDefaults = [
	"claude-code-20250219",
	"oauth-2025-04-20",
	"interleaved-thinking-2025-05-14",
	"context-management-2025-06-27",
	"prompt-caching-scope-2026-01-05",
	"mid-conversation-system-2026-04-07",
	"advanced-tool-use-2025-11-20",
] as const;
const claudeCodeAgentPostEffortBetas = ["extended-cache-ttl-2025-04-11"] as const;
const interleavedThinkingBeta = "interleaved-thinking-2025-05-14";
const redactThinkingBeta = "redact-thinking-2026-02-12";
const effortBeta = "effort-2025-11-24";

export function buildClaudeCodeBetas(
	agentRequest: boolean,
	thinkingRequest: boolean,
	redactThinking: boolean,
): readonly string[] {
	if (!agentRequest && !redactThinking) return claudeCodeUtilityBetaDefaults;
	const betas: string[] = [];
	for (const beta of agentRequest ? claudeCodeAgentBetaDefaults : claudeCodeUtilityBetaDefaults) {
		betas.push(beta);
		// Match CC's header order: redact-thinking immediately follows interleaved-thinking.
		if (redactThinking && beta === interleavedThinkingBeta) betas.push(redactThinkingBeta);
	}
	if (!agentRequest) return betas;
	if (thinkingRequest) betas.push(effortBeta);
	betas.push(...claudeCodeAgentPostEffortBetas);
	return betas;
}

// --- stainless header mapping ---------------------------------------------
export function mapStainlessOs(platform: string): "MacOS" | "Windows" | "Linux" | "FreeBSD" | `Other::${string}` {
	switch (platform.toLowerCase()) {
		case "darwin":
			return "MacOS";
		case "windows":
		case "win32":
			return "Windows";
		case "linux":
			return "Linux";
		case "freebsd":
			return "FreeBSD";
		default:
			return `Other::${platform.toLowerCase()}`;
	}
}

export function mapStainlessArch(arch: string): "x64" | "arm64" | "x86" | `other::${string}` {
	switch (arch.toLowerCase()) {
		case "amd64":
		case "x64":
			return "x64";
		case "arm64":
		case "aarch64":
			return "arm64";
		case "386":
		case "x86":
		case "ia32":
			return "x86";
		default:
			return `other::${arch.toLowerCase()}`;
	}
}

export const claudeCodeHeaders = {
	"X-Stainless-Retry-Count": "0",
	"X-Stainless-Runtime-Version": "v24.3.0",
	"X-Stainless-Package-Version": "0.94.0",
	"X-Stainless-Runtime": "node",
	"X-Stainless-Lang": "js",
	"X-Stainless-Arch": mapStainlessArch(process.arch),
	"X-Stainless-OS": mapStainlessOs(process.platform),
	"X-Stainless-Timeout": "900",
	"anthropic-client-platform": "desktop_app",
	"anthropic-client-version": claudeClientVersion,
};

const sharedHeaders = {
	"Accept-Encoding": "gzip, deflate, br, zstd",
	Connection: "keep-alive",
	"Content-Type": "application/json",
	"anthropic-version": "2023-06-01",
	"anthropic-dangerous-direct-browser-access": "true",
	"x-app": "cli",
};

export const enforcedHeaderKeys = new Set(
	[
		...Object.keys(claudeCodeHeaders),
		"Accept",
		"Accept-Encoding",
		"Connection",
		"Content-Type",
		"anthropic-version",
		"anthropic-dangerous-direct-browser-access",
		"anthropic-beta",
		"User-Agent",
		"x-app",
		"Authorization",
		"X-Api-Key",
		"X-Claude-Code-Session-Id",
		"x-client-request-id",
		"cf-aig-authorization",
	].map((key) => key.toLowerCase()),
);

function getHeaderCaseInsensitive(headers: Record<string, string> | undefined, headerName: string): string | undefined {
	if (!headers) return undefined;
	const normalizedName = headerName.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === normalizedName) return value;
	}
	return undefined;
}

export function isClaudeCodeClientUserAgent(userAgent: string | undefined): userAgent is string {
	if (!userAgent) return false;
	return userAgent.toLowerCase().startsWith("claude-cli");
}

// --- OAuth headers --------------------------------------------------------
// Port of oh-my-pi buildAnthropicHeaders' OAuth branch only (pi's createClient
// already constructs headers for the non-OAuth paths). Strips enforcedHeaderKeys
// (case-insensitive) from caller model/options headers so callers cannot override
// OAuth identity headers, then layers the enforced Claude Code defaults on top.
export type ClaudeCodeOAuthHeaderOptions = {
	apiKey: string;
	modelHeaders?: Record<string, string>;
	optionsHeaders?: Record<string, string>;
	extraBetas?: readonly string[];
	claudeCodeBetas?: readonly string[];
	claudeCodeSessionId?: string;
};

export function buildClaudeCodeOAuthHeaders(options: ClaudeCodeOAuthHeaderOptions): Record<string, string> {
	const extraBetas = options.extraBetas ?? [];
	const betaHeader = buildBetaHeader(options.claudeCodeBetas ?? buildClaudeCodeBetas(true, true, false), extraBetas);
	const callerHeaders = Object.fromEntries(
		Object.entries({ ...options.modelHeaders, ...options.optionsHeaders }).filter(
			([key]) => !enforcedHeaderKeys.has(key.toLowerCase()),
		),
	);
	// UA passthrough only when the caller already sent a Claude Code-shaped UA.
	const incomingUserAgent =
		getHeaderCaseInsensitive(options.modelHeaders, "User-Agent") ??
		getHeaderCaseInsensitive(options.optionsHeaders, "User-Agent");
	const userAgent = isClaudeCodeClientUserAgent(incomingUserAgent)
		? incomingUserAgent
		: `claude-cli/${claudeCodeVersion} (external, local-agent, agent-sdk/${claudeAgentSdkVersion})`;
	return {
		...callerHeaders,
		...claudeCodeHeaders,
		Accept: "application/json",
		Authorization: `Bearer ${options.apiKey}`,
		...sharedHeaders,
		"anthropic-beta": betaHeader,
		...(options.claudeCodeSessionId ? { "X-Claude-Code-Session-Id": options.claudeCodeSessionId } : {}),
		"x-client-request-id": nodeCrypto.randomUUID(),
		"User-Agent": userAgent,
	};
}

// --- billing header -------------------------------------------------------
const CLAUDE_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

export function createClaudeBillingHeader(firstUserMessageText: string): string {
	// Fingerprint: SHA256(salt + msg[4] + msg[7] + msg[20] + version)[:3]
	// Matches CC's computeFingerprint in utils/fingerprint.ts.
	// Uses chars from the first user message (not the system prompt).
	const k = [4, 7, 20].map((i) => firstUserMessageText[i] ?? "0").join("");
	const versionSuffix = nodeCrypto
		.createHash("sha256")
		.update(`59cf53e54c78${k}${claudeCodeVersion}`)
		.digest("hex")
		.slice(0, 3);
	// cch=00000: placeholder replaced with the real attestation hash by wrapFetchForCch
	// before the request hits the wire (see below).
	return `${CLAUDE_BILLING_HEADER_PREFIX} cc_version=${claudeCodeVersion}.${versionSuffix}; cc_entrypoint=local-agent; ${CCH_PLACEHOLDER_STR};`;
}

// --- system blocks --------------------------------------------------------
// Port of oh-my-pi buildAnthropicSystemBlocks (CC-instruction mode) +
// applyClaudeCodeSystemCache. Emits the billing header + instruction, then one
// block per non-empty system prompt. On the OAuth path the agent system prompt is
// first relocated into the first user message (relocateSystemPromptIntoMessages,
// the billing-gate fix), so this is normally called with `systemPrompt: undefined`
// and returns just [billing header, Claude Code instruction].
function applyClaudeCodeSystemCache(blocks: TextBlockParam[], cacheControl: CacheControlEphemeral | undefined): number {
	if (!cacheControl || blocks.length <= 2) return 0;
	blocks[2] = { ...blocks[2], cache_control: cacheControl };
	if (blocks.length === 3) return 1;
	const lastIndex = blocks.length - 1;
	blocks[lastIndex] = { ...blocks[lastIndex], cache_control: cacheControl };
	return 2;
}

export function buildClaudeCodeSystemBlocks(
	systemPrompt: string | undefined,
	includeClaudeCodeInstruction: boolean,
	firstUserMessageText: string,
	cacheControl: CacheControlEphemeral | undefined,
): TextBlockParam[] | undefined {
	const prompt = systemPrompt?.trim() ? systemPrompt : undefined;
	// Anchored with startsWith: a prompt that merely *mentions* the billing
	// header mid-text must not suppress the whole Claude Code system-block
	// injection (resumed-session guard, oh-my-pi parity). Only a prompt that IS
	// a previously injected header block counts.
	const hasBillingHeader = prompt?.startsWith(CLAUDE_BILLING_HEADER_PREFIX) === true;

	if (includeClaudeCodeInstruction && !hasBillingHeader) {
		const blocks: TextBlockParam[] = [
			{ type: "text", text: createClaudeBillingHeader(firstUserMessageText) },
			{ type: "text", text: claudeCodeSystemInstruction },
		];
		if (prompt !== undefined) {
			blocks.push({ type: "text", text: prompt });
		}
		applyClaudeCodeSystemCache(blocks, cacheControl);
		return blocks;
	}

	// Plain layout: user system text only (Haiku 3.5 guard or idempotence).
	if (prompt === undefined) return undefined;
	const blocks: TextBlockParam[] = [{ type: "text", text: prompt }];
	if (cacheControl) {
		blocks[0] = { ...blocks[0], cache_control: cacheControl };
	}
	return blocks;
}

// --- system relocation (subscription billing gate) ------------------------
// Anthropic routes an OAuth request whose `system` reads like a third-party agent
// prompt to the (empty) pay-per-token pool — the "You're out of extra usage" 400 —
// even with a valid Claude Code billing header + cch. Verified live against the
// subscription: the SAME prompt is accepted as leading USER content. So we keep
// `system` minimal ([billing header, Claude Code instruction]) and deliver the
// agent system prompt as a cache-controlled prefix on the first user message. The
// model still receives every instruction; only the wire placement changes.
// Mutates `messages` in place.
export function relocateSystemPromptIntoMessages(
	messages: MessageParam[],
	systemPrompt: string,
	cacheControl: CacheControlEphemeral | undefined,
): void {
	if (!systemPrompt.trim()) return;
	// cache_control keeps the large, static agent prompt cached as a prefix,
	// preserving prompt caching. Net cache-breakpoint count is unchanged: the
	// dropped system[2] breakpoint is re-added here.
	const block: TextBlockParam = cacheControl
		? { type: "text", text: systemPrompt, cache_control: cacheControl }
		: { type: "text", text: systemPrompt };

	const firstUser = messages.findIndex((message) => message.role === "user");
	if (firstUser === -1) {
		messages.unshift({ role: "user", content: [block] });
		return;
	}
	const { content } = messages[firstUser];
	const merged: ContentBlockParam[] =
		typeof content === "string" ? [block, { type: "text", text: content }] : [block, ...content];
	messages[firstUser] = { ...messages[firstUser], content: merged };
}

// --- cch attestation (on the wire) ---------------------------------------
const CCH_SEED = 0x4d659218e32a3268n;
const CCH_PLACEHOLDER_STR = "cch=00000";
const cchEncoder = new TextEncoder();
const CCH_PLACEHOLDER = cchEncoder.encode(CCH_PLACEHOLDER_STR);
// Combined anchor for the billing-header placeholder inside system[0].
// "messages" serializes before "system" in Anthropic SDK payloads, so user
// content in the messages array can never match this sequence; user system
// prompt text lives in system[2] and therefore also cannot match.
const BILLING_SYSTEM_MARKER = cchEncoder.encode(`"system":[{"type":"text","text":"${CLAUDE_BILLING_HEADER_PREFIX}`);
const CCH_BILLING_SEARCH_WINDOW = 150;

// Pure-BigInt XXH64 (Node has no Bun.hash.xxHash64).
const XXH_PRIME64_1 = 0x9e3779b185ebca87n;
const XXH_PRIME64_2 = 0xc2b2ae3d27d4eb4fn;
const XXH_PRIME64_3 = 0x165667b19e3779f9n;
const XXH_PRIME64_4 = 0x85ebca77c2b2ae63n;
const XXH_PRIME64_5 = 0x27d4eb2f165667c5n;
const MASK64 = 0xffffffffffffffffn;

function rotl64(value: bigint, shift: bigint): bigint {
	return ((value << shift) | (value >> (64n - shift))) & MASK64;
}

function round(acc: bigint, input: bigint): bigint {
	acc = (acc + input * XXH_PRIME64_2) & MASK64;
	acc = rotl64(acc, 31n);
	return (acc * XXH_PRIME64_1) & MASK64;
}

function mergeRound(acc: bigint, val: bigint): bigint {
	val = round(0n, val);
	acc = (acc ^ val) & MASK64;
	return (acc * XXH_PRIME64_1 + XXH_PRIME64_4) & MASK64;
}

function readU64LE(view: DataView, offset: number): bigint {
	return view.getBigUint64(offset, true);
}

function readU32LE(view: DataView, offset: number): bigint {
	return BigInt(view.getUint32(offset, true));
}

export function xxHash64(bytes: Uint8Array, seed: bigint): bigint {
	const len = bytes.length;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let h64: bigint;
	let offset = 0;

	if (len >= 32) {
		let v1 = (seed + XXH_PRIME64_1 + XXH_PRIME64_2) & MASK64;
		let v2 = (seed + XXH_PRIME64_2) & MASK64;
		let v3 = seed & MASK64;
		let v4 = (seed - XXH_PRIME64_1) & MASK64;
		const limit = len - 32;
		do {
			v1 = round(v1, readU64LE(view, offset));
			offset += 8;
			v2 = round(v2, readU64LE(view, offset));
			offset += 8;
			v3 = round(v3, readU64LE(view, offset));
			offset += 8;
			v4 = round(v4, readU64LE(view, offset));
			offset += 8;
		} while (offset <= limit);

		h64 = (rotl64(v1, 1n) + rotl64(v2, 7n) + rotl64(v3, 12n) + rotl64(v4, 18n)) & MASK64;
		h64 = mergeRound(h64, v1);
		h64 = mergeRound(h64, v2);
		h64 = mergeRound(h64, v3);
		h64 = mergeRound(h64, v4);
	} else {
		h64 = (seed + XXH_PRIME64_5) & MASK64;
	}

	h64 = (h64 + BigInt(len)) & MASK64;

	while (offset + 8 <= len) {
		const k1 = round(0n, readU64LE(view, offset));
		h64 = (h64 ^ k1) & MASK64;
		h64 = (rotl64(h64, 27n) * XXH_PRIME64_1 + XXH_PRIME64_4) & MASK64;
		offset += 8;
	}

	if (offset + 4 <= len) {
		h64 = (h64 ^ ((readU32LE(view, offset) * XXH_PRIME64_1) & MASK64)) & MASK64;
		h64 = (rotl64(h64, 23n) * XXH_PRIME64_2 + XXH_PRIME64_3) & MASK64;
		offset += 4;
	}

	while (offset < len) {
		h64 = (h64 ^ ((BigInt(bytes[offset]) * XXH_PRIME64_5) & MASK64)) & MASK64;
		h64 = (rotl64(h64, 11n) * XXH_PRIME64_1) & MASK64;
		offset += 1;
	}

	h64 = (h64 ^ (h64 >> 33n)) & MASK64;
	h64 = (h64 * XXH_PRIME64_2) & MASK64;
	h64 = (h64 ^ (h64 >> 29n)) & MASK64;
	h64 = (h64 * XXH_PRIME64_3) & MASK64;
	h64 = (h64 ^ (h64 >> 32n)) & MASK64;
	return h64;
}

export function patchCch(body: Uint8Array): Uint8Array {
	// Find the combined system[0] + billing-header prefix marker.
	let markerIdx = -1;
	outer: for (let i = 0; i <= body.length - BILLING_SYSTEM_MARKER.length; i++) {
		for (let j = 0; j < BILLING_SYSTEM_MARKER.length; j++) {
			if (body[i + j] !== BILLING_SYSTEM_MARKER[j]) continue outer;
		}
		markerIdx = i;
		break;
	}
	if (markerIdx === -1) return body; // no CC billing header injected

	// Scan at most CCH_BILLING_SEARCH_WINDOW bytes after the marker for the placeholder.
	const searchFrom = markerIdx + BILLING_SYSTEM_MARKER.length;
	const searchTo = Math.min(searchFrom + CCH_BILLING_SEARCH_WINDOW, body.length - CCH_PLACEHOLDER.length);
	let idx = -1;
	outer2: for (let i = searchFrom; i <= searchTo; i++) {
		for (let j = 0; j < CCH_PLACEHOLDER.length; j++) {
			if (body[i + j] !== CCH_PLACEHOLDER[j]) continue outer2;
		}
		idx = i;
		break;
	}
	if (idx === -1) return body; // placeholder not within the billing header value

	// Hash the body with the placeholder in place (matches CC's in-place behaviour).
	const h = xxHash64(body, CCH_SEED);
	const cch = (h & 0xfffffn).toString(16).padStart(5, "0");

	for (let i = 0; i < 5; i++) body[idx + 4 + i] = cch.charCodeAt(i);
	return body;
}

export function wrapFetchForCch(base: typeof fetch): typeof fetch {
	return ((input, init) => {
		if (init?.body && typeof init.body === "string" && init.body.includes(CCH_PLACEHOLDER_STR)) {
			const encoded = cchEncoder.encode(init.body);
			const patched = patchCch(encoded);
			return base(input, { ...init, body: patched as unknown as RequestInit["body"] });
		}
		return base(input, init);
	}) as typeof fetch;
}

// --- user_id cloak --------------------------------------------------------
const CLAUDE_CLOAKING_USER_ID_REGEX =
	/^user_[0-9a-fA-F]{64}_account_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isClaudeCloakingUserId(userId: string): boolean {
	return CLAUDE_CLOAKING_USER_ID_REGEX.test(userId);
}

/**
 * Real Claude Code sends `metadata.user_id` as a JSON-stringified object of the
 * shape `{ device_id, account_uuid, session_id, ...extra }`. Accept that shape so
 * callers that supply a stable `session_id` aren't silently overwritten with
 * fresh entropy on every request, which would inflate the backend session count.
 */
export function isClaudeJsonUserId(userId: string): boolean {
	if (userId.length === 0 || userId[0] !== "{") return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(userId);
	} catch {
		return false;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
	const obj = parsed as Record<string, unknown>;
	return typeof obj.session_id === "string" && obj.session_id.length > 0;
}

export function extractClaudeMetadataSessionId(userId: unknown): string | undefined {
	if (typeof userId !== "string") return undefined;
	if (isClaudeCloakingUserId(userId)) {
		return userId.slice(userId.lastIndexOf("_session_") + "_session_".length);
	}
	if (userId.length === 0 || userId[0] !== "{") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(userId);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const sessionId = (parsed as Record<string, unknown>).session_id;
	return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

const CLAUDE_DEVICE_ID_INSTALL_HASH_DOMAIN = "omp-claude-device-id-v1:";
const CLAUDE_DEVICE_ID_ACCOUNT_HASH_DOMAIN = "omp-claude-device-id-v2";

export function deriveClaudeDeviceId(installId: string, accountId?: string): string {
	const hash = nodeCrypto.createHash("sha256");
	if (accountId && accountId.length > 0) {
		return hash
			.update(CLAUDE_DEVICE_ID_ACCOUNT_HASH_DOMAIN)
			.update("\0")
			.update(installId)
			.update("\0")
			.update(accountId)
			.digest("hex");
	}
	return hash.update(CLAUDE_DEVICE_ID_INSTALL_HASH_DOMAIN).update(installId).digest("hex");
}

function readMetadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = metadata?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readClaudeCodeMetadataAccountId(metadata: Record<string, unknown> | undefined): string | undefined {
	return (
		readMetadataString(metadata, "account_uuid") ??
		readMetadataString(metadata, "accountId") ??
		readMetadataString(metadata, "account_id")
	);
}

function deriveClaudeDeviceIdFromInstallId(accountId?: string): string {
	return deriveClaudeDeviceId(getInstallId(), accountId);
}

function generateClaudeJsonUserId(sessionId?: string, accountId?: string): string {
	const userId: Record<string, string> = {
		device_id: deriveClaudeDeviceIdFromInstallId(accountId),
		session_id: sessionId ?? nodeCrypto.randomUUID().toLowerCase(),
	};
	if (accountId && accountId.length > 0) userId.account_uuid = accountId;
	return JSON.stringify(userId);
}

/**
 * Resolves `metadata.user_id` for OAuth requests. If the caller already supplied
 * a cloaking-format id or a JSON id with a non-empty `session_id`, pass it
 * through unchanged (preserves a caller-supplied stable session_id); otherwise
 * mint a fresh Claude Code-shaped `{device_id, session_id, account_uuid?}` JSON.
 */
export function resolveClaudeCodeUserId(userId: unknown, sessionId?: string, accountId?: string): string | undefined {
	if (typeof userId === "string") {
		if (isClaudeCloakingUserId(userId) || isClaudeJsonUserId(userId)) {
			return userId;
		}
	}
	return generateClaudeJsonUserId(sessionId, accountId);
}

// --- fingerprint seed -----------------------------------------------------
export function extractClaudeCodeFirstUserMessageText(messages: readonly Message[]): string {
	for (const message of messages) {
		if (message.role !== "user") continue;
		const { content } = message;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		for (const block of content) {
			if (block.type === "text") return block.text;
		}
		return "";
	}
	return "";
}

export const __testing = {
	createClaudeBillingHeader,
	buildClaudeCodeSystemBlocks,
	relocateSystemPromptIntoMessages,
	buildClaudeCodeOAuthHeaders,
	resolveClaudeCodeUserId,
	isClaudeCloakingUserId,
	isClaudeJsonUserId,
	extractClaudeMetadataSessionId,
	patchCch,
	wrapFetchForCch,
	xxHash64,
	extractClaudeCodeFirstUserMessageText,
};
