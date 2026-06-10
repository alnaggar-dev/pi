import Anthropic from "@anthropic-ai/sdk";
import type {
	CacheControlEphemeral,
	ContentBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
	RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages.js";
import { calculateCost } from "../models.ts";
import type {
	AnthropicMessagesCompat,
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

import { resolveCloudflareBaseUrl } from "./cloudflare.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { adjustMaxTokensForThinking, buildBaseOptions } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

// `anthropic-claude-code.ts` statically imports `node:crypto`, so it must NEVER be
// reachable from a top-level *value* import here — that would pull node APIs into
// the `platform: browser` esbuild bundle and fail `check:browser-smoke`. This
// `import type` is fully erased at compile time (safe), and the runtime load goes
// through `loadClaudeCodeBilling()` below, which hides the specifier from the
// bundler the same way `importNodeOnlyProvider` does in `register-builtins.ts`.
type ClaudeCodeBillingModule = typeof import("./anthropic-claude-code.ts");

let claudeCodeBillingModulePromise: Promise<ClaudeCodeBillingModule> | undefined;

// Local copy of the `importNodeOnlyProvider` shim (do NOT import the one in
// register-builtins.ts — that would couple provider internals / risk an import
// cycle). The `.ts`→`.js` rewrite at runtime hides the specifier from esbuild so
// the browser bundle never follows it.
function loadClaudeCodeBilling(): Promise<ClaudeCodeBillingModule> {
	if (!claudeCodeBillingModulePromise) {
		const specifier = "./anthropic-claude-code.ts";
		const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
		claudeCodeBillingModulePromise = import(runtimeSpecifier) as Promise<ClaudeCodeBillingModule>;
	}
	return claudeCodeBillingModulePromise;
}

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
		return "long";
	}
	return "short";
}

function getCacheControl(
	model: Model<"anthropic-messages">,
	cacheRetention?: CacheRetention,
	isOAuthToken = false,
): { retention: CacheRetention; cacheControl?: CacheControlEphemeral } {
	// OAuth (Claude Code) requests default to "long" retention so the serialized
	// body carries the same `ttl: "1h"` cache breakpoints real Claude Code emits
	// (matches oh-my-pi). Non-OAuth keeps the existing short/env default.
	const retention = cacheRetention ?? (isOAuthToken ? "long" : resolveCacheRetention(undefined));
	if (retention === "none") {
		return { retention };
	}
	// For OAuth (Claude Code) the 1h TTL only validates against canonical
	// api.anthropic.com; third-party Anthropic-compatible proxies reject the unknown
	// ttl, so gate it on the base URL. The non-OAuth path keeps pi's original
	// behavior (ttl whenever long + supportsLongCacheRetention, regardless of host).
	const baseUrlAllowsTtl = !isOAuthToken || isAnthropicApiBaseUrl(model.baseUrl);
	const ttl =
		retention === "long" && baseUrlAllowsTtl && getAnthropicCompat(model).supportsLongCacheRetention
			? "1h"
			: undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

/** True for the canonical Anthropic API base URL (where the 1h cache ttl is valid). */
function isAnthropicApiBaseUrl(baseUrl?: string): boolean {
	if (!baseUrl) return true;
	try {
		const url = new URL(baseUrl);
		return url.protocol.toLowerCase() === "https:" && url.hostname.toLowerCase() === "api.anthropic.com";
	} catch {
		return false;
	}
}

// Stealth mode: Mimic Claude Code's tool naming exactly.
// (The OAuth request fingerprint \u2014 user-agent, version, beta headers \u2014 lives in
// the node-only `anthropic-claude-code.ts` billing module.)

// Claude Code 2.x tool names (canonical casing)
// Source: https://cchistory.mariozechner.at/data/prompts-2.1.11.md
// To update: https://github.com/badlogic/cchistory
const claudeCodeTools = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
];

const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));

// Convert tool name to CC canonical casing if it matches (case-insensitive)
const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;
const fromClaudeCodeName = (name: string, tools?: Tool[]) => {
	if (tools && tools.length > 0) {
		// Exact match wins: with collision-safe renaming a session can carry both
		// `read` (built-in) and `Read` (extension) on the wire verbatim.
		if (tools.some((tool) => tool.name === name)) return name;
		const lowerName = name.toLowerCase();
		const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
		if (matchedTool) return matchedTool.name;
	}
	return name;
};

/**
 * Per-request session-name → wire-name map for the Claude Code rename,
 * collision-safe: when two session tools would map to the same canonical name
 * (e.g. built-in `read` plus an extension tool literally named `Read`), all
 * claimants keep their original names verbatim — the Messages API rejects
 * duplicate tool names ("tools: Tool names must be unique"; the check is
 * case-sensitive, so the originals are valid).
 */
function buildClaudeCodeToolNameMap(tools: Tool[] | undefined): Map<string, string> | undefined {
	if (!tools || tools.length === 0) return undefined;
	const claimants = new Map<string, number>();
	for (const tool of tools) {
		const wireName = toClaudeCodeName(tool.name);
		claimants.set(wireName, (claimants.get(wireName) ?? 0) + 1);
	}
	const map = new Map<string, string>();
	for (const tool of tools) {
		const wireName = toClaudeCodeName(tool.name);
		map.set(tool.name, (claimants.get(wireName) ?? 0) > 1 ? tool.name : wireName);
	}
	return map;
}

/**
 * Convert content blocks to Anthropic API format
 */
function convertContentBlocks(content: (TextContent | ImageContent)[]):
	| string
	| Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	// If only text blocks, return as concatenated string for simplicity
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	// If we have images, convert to content block array
	const blocks = content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: sanitizeSurrogates(block.text),
			};
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
				data: block.data,
			},
		};
	});

	// If only images (no text), add placeholder text block
	const hasText = blocks.some((b) => b.type === "text");
	if (!hasText) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicThinkingDisplay = "summarized" | "omitted";

const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
// Required alongside `output_config.effort` on API-key requests (the OAuth
// Claude Code agent beta list already carries it).
const EFFORT_BETA = "effort-2025-11-24";

function getAnthropicCompat(
	model: Model<"anthropic-messages">,
): Required<Omit<AnthropicMessagesCompat, "forceAdaptiveThinking">> {
	// Auto-detect session affinity and cache control support from provider
	const isFireworks = model.provider === "fireworks";
	const isCloudflareAiGatewayAnthropic =
		model.provider === "cloudflare-ai-gateway" && model.baseUrl.includes("anthropic");
	return {
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? !isFireworks,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? !isFireworks,
		sendSessionAffinityHeaders:
			model.compat?.sendSessionAffinityHeaders ?? !!(isFireworks || isCloudflareAiGatewayAnthropic),
		supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? !isFireworks,
		supportsTemperature: model.compat?.supportsTemperature ?? true,
		// Claude Fable/Mythos 5 reject forced tool use ("tool_choice forces tool
		// use is not compatible with this model"); auto-detected from the model id.
		supportsForcedToolChoice: model.compat?.supportsForcedToolChoice ?? !isAnthropicFableOrMythosModel(model.id),
		allowEmptySignature: model.compat?.allowEmptySignature ?? false,
	};
}

export interface AnthropicOptions extends StreamOptions {
	/**
	 * Enable extended thinking.
	 * For adaptive thinking models: the model decides when/how much to think.
	 * For older models: uses budget-based thinking with thinkingBudgetTokens.
	 * Default: undefined (thinking is omitted unless `streamSimpleAnthropic()` maps
	 * a simple reasoning level to this option, or callers set it explicitly).
	 */
	thinkingEnabled?: boolean;
	/**
	 * Token budget for extended thinking (older models only).
	 * Ignored for adaptive thinking models.
	 * Default: 1024 when `thinkingEnabled` is true and no budget is provided.
	 */
	thinkingBudgetTokens?: number;
	/**
	 * Effort level for adaptive thinking models.
	 * Controls how much thinking Claude allocates:
	 * - "max": Always thinks with no constraints (Opus 4.6 only)
	 * - "xhigh": Highest reasoning level (Opus 4.7)
	 * - "high": Always thinks, deep reasoning
	 * - "medium": Moderate thinking, may skip for simple queries
	 * - "low": Minimal thinking, skips for simple tasks
	 * Ignored for older models.
	 * Default: omitted unless `streamSimpleAnthropic()` maps a simple reasoning
	 * level to this option.
	 */
	effort?: AnthropicEffort;
	/**
	 * Controls how thinking content is returned in API responses.
	 * - "summarized": Thinking blocks contain summarized thinking text.
	 * - "omitted": Thinking blocks return an empty thinking field; the encrypted
	 *   signature still travels back for multi-turn continuity. Use for faster
	 *   time-to-first-text-token when your UI does not surface thinking.
	 *
	 * Note: Anthropic's API default for Claude Opus 4.7 and Claude Mythos Preview
	 * is "omitted". We default to "summarized" here to keep behavior consistent
	 * with older Claude 4 models. Set this explicitly to "omitted" to opt in.
	 * Default: "summarized" when thinking is enabled.
	 */
	thinkingDisplay?: AnthropicThinkingDisplay;
	/**
	 * Whether to request the interleaved thinking beta header for non-adaptive
	 * thinking models. Adaptive thinking models have interleaved thinking built in,
	 * so the header is skipped for them regardless of this setting.
	 * Default: true.
	 */
	interleavedThinking?: boolean;
	/**
	 * Anthropic tool choice behavior. String values map to Anthropic's built-in
	 * choices; `{ type: "tool", name }` forces a specific tool.
	 * Default: omitted (Anthropic default behavior, currently equivalent to auto).
	 */
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/**
	 * Pre-built Anthropic client instance. When provided, skips internal client
	 * construction entirely. Use this to inject alternative SDK clients such as
	 * `AnthropicVertex` that shares the same messaging API.
	 */
	client?: Anthropic;
}

function mergeHeaders(...headerSources: (Record<string, string | null> | undefined)[]): Record<string, string | null> {
	const merged: Record<string, string | null> = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
}

interface SseDecoderState {
	event: string | null;
	data: string[];
	raw: string[];
}

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

function flushSseEvent(state: SseDecoderState): ServerSentEvent | null {
	if (!state.event && state.data.length === 0) {
		return null;
	}

	const event: ServerSentEvent = {
		event: state.event,
		data: state.data.join("\n"),
		raw: [...state.raw],
	};
	state.event = null;
	state.data = [];
	state.raw = [];
	return event;
}

function decodeSseLine(line: string, state: SseDecoderState): ServerSentEvent | null {
	if (line === "") {
		return flushSseEvent(state);
	}

	state.raw.push(line);
	if (line.startsWith(":")) {
		return null;
	}

	const delimiterIndex = line.indexOf(":");
	const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
	let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
	if (value.startsWith(" ")) {
		value = value.slice(1);
	}

	if (fieldName === "event") {
		state.event = value;
	} else if (fieldName === "data") {
		state.data.push(value);
	}

	return null;
}

function nextLineBreakIndex(text: string): number {
	const carriageReturnIndex = text.indexOf("\r");
	const newlineIndex = text.indexOf("\n");
	if (carriageReturnIndex === -1) {
		return newlineIndex;
	}
	if (newlineIndex === -1) {
		return carriageReturnIndex;
	}
	return Math.min(carriageReturnIndex, newlineIndex);
}

function consumeLine(text: string): { line: string; rest: string } | null {
	const lineBreakIndex = nextLineBreakIndex(text);
	if (lineBreakIndex === -1) {
		return null;
	}

	let nextIndex = lineBreakIndex + 1;
	if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
		nextIndex += 1;
	}

	return {
		line: text.slice(0, lineBreakIndex),
		rest: text.slice(nextIndex),
	};
}

async function* iterateSseMessages(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: SseDecoderState = { event: null, data: [], raw: [] };
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}

			const { value, done } = await reader.read();
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			let consumed = consumeLine(buffer);
			while (consumed) {
				buffer = consumed.rest;
				const event = decodeSseLine(consumed.line, state);
				if (event) {
					yield event;
				}
				consumed = consumeLine(buffer);
			}
		}

		buffer += decoder.decode();
		let consumed = consumeLine(buffer);
		while (consumed) {
			buffer = consumed.rest;
			const event = decodeSseLine(consumed.line, state);
			if (event) {
				yield event;
			}
			consumed = consumeLine(buffer);
		}

		if (buffer.length > 0) {
			const event = decodeSseLine(buffer, state);
			if (event) {
				yield event;
			}
		}

		const trailingEvent = flushSseEvent(state);
		if (trailingEvent) {
			yield trailingEvent;
		}
	} finally {
		reader.releaseLock();
	}
}

async function* iterateAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
): AsyncGenerator<RawMessageStreamEvent> {
	if (!response.body) {
		throw new Error("Attempted to iterate over an Anthropic response with no body");
	}

	let sawMessageStart = false;
	let sawMessageEnd = false;

	for await (const sse of iterateSseMessages(response.body, signal)) {
		if (sse.event === "error") {
			throw new Error(sse.data);
		}

		if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
			continue;
		}

		try {
			const event = parseJsonWithRepair<RawMessageStreamEvent>(sse.data);
			if (event.type === "message_start") {
				sawMessageStart = true;
			} else if (event.type === "message_stop") {
				sawMessageEnd = true;
			}
			yield event;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`,
			);
		}
	}

	if (sawMessageStart && !sawMessageEnd) {
		throw new Error("Anthropic stream ended before message_stop");
	}
}

export const streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			let client: Anthropic;
			let isOAuth: boolean;
			// Node-only billing/header helpers; only loaded on the OAuth path.
			let billing: ClaudeCodeBillingModule | undefined;

			if (options?.client) {
				client = options.client;
				isOAuth = false;
			} else {
				const apiKey = options?.apiKey;
				if (!apiKey) {
					throw new Error(`No API key for provider: ${model.provider}`);
				}

				let copilotDynamicHeaders: Record<string, string> | undefined;
				if (model.provider === "github-copilot") {
					const hasImages = hasCopilotVisionInput(context.messages);
					copilotDynamicHeaders = buildCopilotDynamicHeaders({
						messages: context.messages,
						hasImages,
					});
				}

				const cacheRetention = options?.cacheRetention ?? resolveCacheRetention();
				const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;

				// Resolve the Claude Code session id independently of cache retention
				// (do NOT reuse the gated cacheSessionId, which is undefined when caching
				// is off). Matches oh-my-pi: options.sessionId ?? session id parsed from
				// the metadata user_id.
				const wantsOAuth =
					model.provider !== "cloudflare-ai-gateway" &&
					model.provider !== "github-copilot" &&
					isOAuthToken(apiKey);
				// Load the node-only billing/header module via the runtime-specifier shim
				// (never a top-level static import) so the browser bundle never follows it.
				if (wantsOAuth) {
					billing = await loadClaudeCodeBilling();
				}
				const claudeCodeSessionId = billing
					? (options?.sessionId ?? billing.extractClaudeMetadataSessionId(options?.metadata?.user_id))
					: undefined;

				// `output_config.effort` ships on thinking-on adaptive requests AND on
				// the thinking-off adaptive pin (effort:"low"); API-key requests need
				// the effort beta alongside the field (oh-my-pi parity).
				const sendsAdaptiveEffortPin =
					options?.thinkingEnabled === false && model.compat?.forceAdaptiveThinking === true;
				const useEffortBeta = !!model.reasoning && (options?.thinkingEnabled === true || sendsAdaptiveEffortPin);
				const created = createClient(
					model,
					apiKey,
					options?.interleavedThinking ?? true,
					shouldUseFineGrainedToolStreamingBeta(model, context),
					useEffortBeta,
					options?.headers,
					copilotDynamicHeaders,
					cacheSessionId,
					billing,
					claudeCodeSessionId,
				);
				client = created.client;
				isOAuth = created.isOAuthToken;
			}
			let params = buildParams(model, context, isOAuth, options, billing);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as MessageCreateParamsStreaming;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: options?.maxRetries ?? 0,
			};
			const request =
				isOAuth && client.beta?.messages
					? client.beta.messages.create({ ...(params as any), stream: true }, requestOptions)
					: client.messages.create({ ...params, stream: true }, requestOptions);
			const response = await request.asResponse();
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

			type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };
			const blocks = output.content as Block[];

			for await (const event of iterateAnthropicEvents(response, options?.signal)) {
				if (event.type === "message_start") {
					output.responseId = event.message.id;
					// Capture initial token usage from message_start event
					// This ensures we have input token counts even if the stream is aborted early
					output.usage.input = event.message.usage.input_tokens || 0;
					output.usage.output = event.message.usage.output_tokens || 0;
					output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
					output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
					// Anthropic doesn't provide total_tokens, compute from components
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				} else if (event.type === "content_block_start") {
					if (event.content_block.type === "text") {
						const block: Block = {
							type: "text",
							text: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "thinking") {
						const block: Block = {
							type: "thinking",
							thinking: "",
							thinkingSignature: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "redacted_thinking") {
						const block: Block = {
							type: "thinking",
							thinking: "[Reasoning redacted]",
							thinkingSignature: event.content_block.data,
							redacted: true,
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "tool_use") {
						const block: Block = {
							type: "toolCall",
							id: event.content_block.id,
							name: isOAuth
								? fromClaudeCodeName(event.content_block.name, context.tools)
								: event.content_block.name,
							arguments: (event.content_block.input as Record<string, any>) ?? {},
							partialJson: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
					}
				} else if (event.type === "content_block_delta") {
					if (event.delta.type === "text_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "text") {
							block.text += event.delta.text;
							stream.push({
								type: "text_delta",
								contentIndex: index,
								delta: event.delta.text,
								partial: output,
							});
						}
					} else if (event.delta.type === "thinking_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "thinking") {
							block.thinking += event.delta.thinking;
							stream.push({
								type: "thinking_delta",
								contentIndex: index,
								delta: event.delta.thinking,
								partial: output,
							});
						}
					} else if (event.delta.type === "input_json_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "toolCall") {
							block.partialJson += event.delta.partial_json;
							block.arguments = parseStreamingJson(block.partialJson);
							stream.push({
								type: "toolcall_delta",
								contentIndex: index,
								delta: event.delta.partial_json,
								partial: output,
							});
						}
					} else if (event.delta.type === "signature_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "thinking") {
							block.thinkingSignature = block.thinkingSignature || "";
							block.thinkingSignature += event.delta.signature;
						}
					}
				} else if (event.type === "content_block_stop") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (block) {
						delete (block as any).index;
						if (block.type === "text") {
							stream.push({
								type: "text_end",
								contentIndex: index,
								content: block.text,
								partial: output,
							});
						} else if (block.type === "thinking") {
							stream.push({
								type: "thinking_end",
								contentIndex: index,
								content: block.thinking,
								partial: output,
							});
						} else if (block.type === "toolCall") {
							block.arguments = parseStreamingJson(block.partialJson);
							// Finalize in-place and strip the scratch buffer so replay only
							// carries parsed arguments.
							delete (block as { partialJson?: string }).partialJson;
							stream.push({
								type: "toolcall_end",
								contentIndex: index,
								toolCall: block,
								partial: output,
							});
						}
					}
				} else if (event.type === "message_delta") {
					if (event.delta.stop_reason) {
						output.stopReason = mapStopReason(event.delta.stop_reason);
					}
					// Only update usage fields if present (not null).
					// Preserves input_tokens from message_start when proxies omit it in message_delta.
					if (event.usage.input_tokens != null) {
						output.usage.input = event.usage.input_tokens;
					}
					if (event.usage.output_tokens != null) {
						output.usage.output = event.usage.output_tokens;
					}
					if (event.usage.cache_read_input_tokens != null) {
						output.usage.cacheRead = event.usage.cache_read_input_tokens;
					}
					if (event.usage.cache_creation_input_tokens != null) {
						output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
					}
					// Anthropic doesn't provide total_tokens, compute from components
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				// partialJson is only a streaming scratch buffer; never persist it.
				delete (block as { partialJson?: string }).partialJson;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * Map ThinkingLevel to Anthropic effort levels for adaptive thinking.
 * Note: effort "max" is only valid on Opus 4.6, while Opus 4.7 supports "xhigh".
 */
function mapThinkingLevelToEffort(
	model: Model<"anthropic-messages">,
	level: SimpleStreamOptions["reasoning"],
): AnthropicEffort {
	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	if (typeof mapped === "string") return mapped as AnthropicEffort;

	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			return supportsNativeXHighEffort(model.id) ? "xhigh" : "max";
		default:
			return "high";
	}
}

// Claude Fable/Mythos 5 family (matches first-party and Bedrock-style prefixed ids).
const CLAUDE_FABLE_MYTHOS_RE = /claude-(?:fable|mythos)-\d/;

/**
 * Claude Fable/Mythos 5 share Opus 4.7+ API behavior: full five-tier adaptive
 * effort scale, adaptive `display` support, sampling-parameter rejection, and
 * no forced tool choice.
 */
function isAnthropicFableOrMythosModel(modelId: string): boolean {
	return CLAUDE_FABLE_MYTHOS_RE.test(modelId);
}

/**
 * Adaptive thinking accepts a `display` field only on Opus 4.7+ (newer majors)
 * and Claude Fable/Mythos 5. Real Claude Code omits `display` on Opus 4.6 /
 * Sonnet 4.6, so gate it on model support to keep the OAuth request
 * byte-shape-faithful to the real client (oh-my-pi parity). The live API
 * currently accepts `display` on 4.6 too, so this is faithfulness, not a hard
 * requirement. Verbatim port of oh-my-pi.
 */
function supportsAdaptiveThinkingDisplay(modelId: string): boolean {
	if (isAnthropicFableOrMythosModel(modelId)) return true;
	// Bound the minor to non-date digits: bare dated ids like
	// `claude-opus-4-20250514` (Opus 4.0) must not parse as minor=20250514.
	const match = /claude-opus-(\d+)-(\d{1,2})(?!\d)/.exec(modelId);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 4 || (major === 4 && minor >= 7);
}

function supportsNativeXHighEffort(modelId: string): boolean {
	const id = modelId.toLowerCase();
	if (isAnthropicFableOrMythosModel(id)) return true;
	return id.includes("opus-4-7") || id.includes("opus-4.7") || id.includes("opus-4-8") || id.includes("opus-4.8");
}

function buildOutputConfig(effort: AnthropicEffort): MessageCreateParamsStreaming["output_config"] {
	// The Anthropic SDK types can lag newly supported effort values such as "xhigh"/"max".
	return { effort } as unknown as MessageCreateParamsStreaming["output_config"];
}

export const streamSimpleAnthropic: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	const isOAuth = isOAuthToken(apiKey);
	if (!options?.reasoning) {
		return streamAnthropic(model, context, {
			...base,
			...(isOAuth ? {} : { thinkingEnabled: false }),
		} satisfies AnthropicOptions);
	}
	if (model.compat?.forceAdaptiveThinking === true) {
		const effort = mapThinkingLevelToEffort(model, options.reasoning);
		return streamAnthropic(model, context, {
			...base,
			thinkingEnabled: true,
			effort,
		} satisfies AnthropicOptions);
	}

	// Undefined means the caller did not request an output cap; let the helper use the model cap.
	// Do not coerce to 0 here, or the thinking budget would become the entire max_tokens value.

	// Claude Code does not send fixed-budget `thinking` controls for older Claude
	// models on subscription requests; keeping them omitted matches OMP/real CC and
	// avoids routing large Sonnet 4.5 prompts into the extra-usage pool.
	if (isOAuth) {
		return streamAnthropic(model, context, { ...base } satisfies AnthropicOptions);
	}
	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);

	return streamAnthropic(model, context, {
		...base,
		maxTokens: adjusted.maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: adjusted.thinkingBudget,
	} satisfies AnthropicOptions);
};

function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

function createClient(
	model: Model<"anthropic-messages">,
	apiKey: string,
	interleavedThinking: boolean,
	useFineGrainedToolStreamingBeta: boolean,
	useEffortBeta: boolean,
	optionsHeaders?: Record<string, string>,
	dynamicHeaders?: Record<string, string>,
	sessionId?: string,
	billing?: ClaudeCodeBillingModule,
	claudeCodeSessionId?: string,
): { client: Anthropic; isOAuthToken: boolean } {
	// Adaptive thinking models have interleaved thinking built in, so skip the beta header.
	const needsInterleavedBeta = interleavedThinking && model.compat?.forceAdaptiveThinking !== true;
	const betaFeatures: string[] = [];
	if (useFineGrainedToolStreamingBeta) {
		betaFeatures.push(FINE_GRAINED_TOOL_STREAMING_BETA);
	}
	if (needsInterleavedBeta) {
		betaFeatures.push(INTERLEAVED_THINKING_BETA);
	}
	if (useEffortBeta && !isOAuthToken(apiKey)) {
		betaFeatures.push(EFFORT_BETA);
	}

	if (model.provider === "cloudflare-ai-gateway") {
		const client = new Anthropic({
			apiKey: null,
			authToken: null,
			baseURL: resolveCloudflareBaseUrl(model),
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"cf-aig-authorization": `Bearer ${apiKey}`,
					"x-api-key": null,
					Authorization: null,
					...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
				},
				model.headers,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: false };
	}

	// Copilot: Bearer auth, selective betas.
	if (model.provider === "github-copilot") {
		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
				},
				model.headers,
				dynamicHeaders,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: false };
	}

	// OAuth: Bearer auth, full Claude Code identity headers + on-the-wire `cch`.
	if (isOAuthToken(apiKey)) {
		if (!billing) {
			throw new Error("Claude Code billing module not loaded for Anthropic OAuth request");
		}
		const baseFetch = globalThis.fetch?.bind(globalThis);
		if (!baseFetch) {
			throw new Error("global fetch is unavailable for Anthropic OAuth cch patching");
		}
		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			fetch: billing.wrapFetchForCch(baseFetch),
			// The SDK applies defaultHeaders AFTER its own auth headers, so emitting
			// Authorization here is the load-bearing override; the enforced-key filter
			// inside the builder prevents callers from clobbering OAuth identity.
			defaultHeaders: billing.buildClaudeCodeOAuthHeaders({
				apiKey,
				modelHeaders: model.headers,
				optionsHeaders,
				extraBetas: betaFeatures,
				claudeCodeSessionId,
			}),
		});

		return { client, isOAuthToken: true };
	}

	// API key auth
	const sessionAffinityHeaders: Record<string, string | null> =
		sessionId && getAnthropicCompat(model).sendSessionAffinityHeaders ? { "x-session-affinity": sessionId } : {};
	const client = new Anthropic({
		apiKey,
		authToken: null,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders: mergeHeaders(
			{
				accept: "application/json",
				"anthropic-dangerous-direct-browser-access": "true",
				...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
			},
			sessionAffinityHeaders,
			model.headers,
			optionsHeaders,
		),
	});

	return { client, isOAuthToken: false };
}

// Claude Code clamps requested output to 64k tokens even when the model ceiling
// is higher (e.g. Opus 4.8 = 128k). OAuth requests must match this wire
// fingerprint: Anthropic routes shape-mismatched subscription requests to the
// pay-per-token extra-usage pool. Mirrors oh-my-pi's CLAUDE_CODE_MAX_OUTPUT_TOKENS.
const CLAUDE_CODE_MAX_OUTPUT_TOKENS = 64000;

// SDK 0.91.1's stable MessageCreateParams type has no `context_management` (only
// the beta namespace does), but real Claude Code sends it on adaptive-thinking
// requests. Widen the type locally for the OAuth assembly.
type ClaudeCodeMessageParams = MessageCreateParamsStreaming & {
	context_management?: { edits: Array<{ type: string; keep: string }> };
};

function buildParams(
	model: Model<"anthropic-messages">,
	context: Context,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
	billing?: ClaudeCodeBillingModule,
): MessageCreateParamsStreaming {
	const { cacheControl } = getCacheControl(model, options?.cacheRetention, isOAuthToken);
	const compat = getAnthropicCompat(model);
	// Collision-safe Claude Code wire names, shared by tools[] and history replay.
	const wireToolNames = isOAuthToken ? buildClaudeCodeToolNameMap(context.tools) : undefined;
	const messages = convertMessages(context.messages, model, cacheControl, compat.allowEmptySignature, wireToolNames);

	// --- system ---
	// For OAuth tokens, emit the fixed Claude Code system layout (billing header +
	// agent-SDK instruction + user system prompt). Haiku 3.5 skips the CC injection
	// (oh-my-pi parity) and gets the plain layout.
	let system: MessageCreateParamsStreaming["system"];
	if (isOAuthToken && billing) {
		const includeClaudeCodeInstruction = !model.id.startsWith("claude-3-5-haiku");
		const firstUserMessageText = includeClaudeCodeInstruction
			? billing.extractClaudeCodeFirstUserMessageText(context.messages)
			: "";
		const userSystemPrompt = context.systemPrompt ? sanitizeSurrogates(context.systemPrompt) : undefined;
		if (includeClaudeCodeInstruction && userSystemPrompt) {
			// Billing-gate fix: relocate the agent prompt out of `system` and into the
			// first user message so the subscription endpoint bills the request instead
			// of routing it to the empty extra-usage pool. `system` stays
			// [billing header, Claude Code instruction]; the model still receives every
			// instruction (see relocateSystemPromptIntoMessages).
			billing.relocateSystemPromptIntoMessages(messages, userSystemPrompt, cacheControl);
			system = billing.buildClaudeCodeSystemBlocks(undefined, true, firstUserMessageText, cacheControl);
		} else {
			system = billing.buildClaudeCodeSystemBlocks(
				userSystemPrompt,
				includeClaudeCodeInstruction,
				firstUserMessageText,
				cacheControl,
			);
		}
	} else if (context.systemPrompt) {
		// Add cache control to system prompt for non-OAuth tokens
		system = [
			{
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
	}

	// --- tools ---
	let tools: MessageCreateParamsStreaming["tools"];
	if (context.tools && context.tools.length > 0) {
		tools = convertTools(
			context.tools,
			wireToolNames,
			compat.supportsEagerToolInputStreaming,
			compat.supportsCacheControlOnTools ? cacheControl : undefined,
		);
	} else if (isOAuthToken) {
		// Real Claude Code always sends a `tools` array (empty when no tools).
		tools = [];
	}

	// --- metadata ---
	// Cloak metadata.user_id for OAuth ({device_id, session_id, account_uuid} JSON);
	// always present since resolveClaudeCodeUserId mints one when none is supplied.
	// The non-OAuth path stays byte-identical to before.
	let metadata: MessageCreateParamsStreaming["metadata"];
	if (isOAuthToken && billing) {
		const accountId = billing.readClaudeCodeMetadataAccountId(options?.metadata);
		const userId = billing.resolveClaudeCodeUserId(options?.metadata?.user_id, options?.sessionId, accountId);
		if (userId) {
			metadata = { user_id: userId };
		}
	} else if (options?.metadata) {
		const userId = options.metadata.user_id;
		if (typeof userId === "string") {
			metadata = { user_id: userId };
		}
	}

	// --- thinking + output_config ---
	// Configure thinking mode: adaptive, budget-based, or explicitly disabled.
	let thinking: MessageCreateParamsStreaming["thinking"];
	let outputConfig: MessageCreateParamsStreaming["output_config"];
	if (model.reasoning) {
		if (options?.thinkingEnabled) {
			// Default to "summarized" so Opus 4.7 and Mythos Preview behave like
			// older Claude 4 models (whose API default is also "summarized").
			const display: AnthropicThinkingDisplay = options.thinkingDisplay ?? "summarized";
			if (model.compat?.forceAdaptiveThinking === true) {
				// Adaptive thinking: Claude decides when and how much to think. The
				// `display` field is gated on model support (Opus 4.7+ / Fable/Mythos 5) —
				// older adaptive models (Opus 4.6 / Sonnet 4.6) reject it and real Claude
				// Code omits it.
				thinking = supportsAdaptiveThinkingDisplay(model.id) ? { type: "adaptive", display } : { type: "adaptive" };
				if (options.effort) {
					outputConfig = buildOutputConfig(options.effort);
				}
			} else {
				// Budget-based thinking for older models
				thinking = {
					type: "enabled",
					budget_tokens: options.thinkingBudgetTokens || 1024,
					display,
				};
			}
		} else if (options?.thinkingEnabled === false) {
			if (model.compat?.forceAdaptiveThinking === true) {
				// Adaptive-only Claude models (Opus 4.6+, Sonnet 4.6+, Fable/Mythos 5)
				// reject `thinking.type: "disabled"` with a 400 — adaptive thinking
				// cannot be switched off. Omit the thinking field (the API defaults to
				// adaptive) and pin the lowest effort so "thinking off" calls stay cheap
				// instead of failing the request (oh-my-pi parity).
				outputConfig = buildOutputConfig("low");
			} else if (!isOAuthToken) {
				thinking = { type: "disabled" };
			}
		}
	}

	// Temperature is incompatible with extended thinking and unsupported on Claude Opus 4.7+ / Fable/Mythos 5.
	const includeTemperature =
		options?.temperature !== undefined && !options?.thinkingEnabled && compat.supportsTemperature;

	// --- tool_choice ---
	let toolChoice: MessageCreateParamsStreaming["tool_choice"];
	if (options?.toolChoice) {
		toolChoice = typeof options.toolChoice === "string" ? { type: options.toolChoice } : options.toolChoice;
	}
	// Claude Fable/Mythos 5 reject forced tool use outright ("tool_choice forces
	// tool use is not compatible with this model"). Downgrade any/tool → auto so
	// the request succeeds; the tool stays available and the caller's prompt
	// steers the model toward it (oh-my-pi parity).
	if (toolChoice && (toolChoice.type === "any" || toolChoice.type === "tool") && !compat.supportsForcedToolChoice) {
		toolChoice = { type: "auto" };
	}

	if (isOAuthToken) {
		// Subscription billing is established by the Claude Code billing header + the
		// on-the-wire `cch` attestation (see buildClaudeCodeSystemBlocks + wrapFetchForCch),
		// NOT by this field order — the live API accepts looser shapes and still bills
		// the subscription. We still emit real Claude Code's canonical field order, the
		// clamped max_tokens, and the adaptive `context_management` edit to keep the
		// request byte-shape-faithful to the real client (oh-my-pi parity), defensive
		// against future server-side fingerprinting. Order: model -> messages -> system
		// -> tools -> metadata -> max_tokens -> thinking -> context_management ->
		// output_config -> stream (then temperature/tool_choice).
		const params: ClaudeCodeMessageParams = {
			model: model.id,
			messages,
			...(system && { system }),
			...(tools !== undefined && { tools }),
			...(metadata && { metadata }),
			max_tokens: Math.min(CLAUDE_CODE_MAX_OUTPUT_TOKENS, model.maxTokens, options?.maxTokens || model.maxTokens),
			...(thinking && { thinking }),
			...(thinking?.type === "adaptive" && {
				context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
			}),
			...(outputConfig && { output_config: outputConfig }),
			stream: true,
		};
		if (includeTemperature) {
			params.temperature = options?.temperature;
		}
		if (toolChoice) {
			params.tool_choice = toolChoice;
		}
		return params;
	}

	// Non-OAuth path: byte-identical field order to before
	// (model -> messages -> max_tokens -> stream -> system -> temperature -> tools
	//  -> thinking -> output_config -> metadata -> tool_choice).
	const params = {
		model: model.id,
		messages,
		max_tokens: options?.maxTokens ?? model.maxTokens,
		stream: true,
	} as MessageCreateParamsStreaming;
	if (system) {
		params.system = system;
	}
	if (includeTemperature) {
		params.temperature = options?.temperature;
	}
	if (tools !== undefined) {
		params.tools = tools;
	}
	if (thinking) {
		params.thinking = thinking;
	}
	if (outputConfig) {
		params.output_config = outputConfig;
	}
	if (metadata) {
		params.metadata = metadata;
	}
	if (toolChoice) {
		params.tool_choice = toolChoice;
	}
	return params;
}

// Normalize tool call IDs to match Anthropic's required pattern and length
function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertMessages(
	messages: Message[],
	model: Model<"anthropic-messages">,
	cacheControl?: CacheControlEphemeral,
	allowEmptySignature = false,
	wireToolNames?: Map<string, string>,
): MessageParam[] {
	const params: MessageParam[] = [];

	// Transform messages for cross-provider compatibility
	const transformedMessages = transformMessages(messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					params.push({
						role: "user",
						content: sanitizeSurrogates(msg.content),
					});
				}
			} else {
				const blocks: ContentBlockParam[] = msg.content.map((item) => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						};
					} else {
						return {
							type: "image",
							source: {
								type: "base64",
								media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
								data: item.data,
							},
						};
					}
				});
				const filteredBlocks = blocks.filter((b) => {
					if (b.type === "text") {
						return b.text.trim().length > 0;
					}
					return true;
				});
				if (filteredBlocks.length === 0) continue;
				params.push({
					role: "user",
					content: filteredBlocks,
				});
			}
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: sanitizeSurrogates(block.text),
					});
				} else if (block.type === "thinking") {
					// Redacted thinking: pass the opaque payload back as redacted_thinking
					if (block.redacted) {
						blocks.push({
							type: "redacted_thinking",
							data: block.thinkingSignature!,
						});
						continue;
					}
					if (block.thinking.trim().length === 0) continue;
					// If thinking signature is missing/empty (e.g., from aborted stream),
					// convert to plain text for Anthropic. Some compatible providers emit
					// and accept empty signatures, so let marked models preserve the block.
					if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
						blocks.push(
							allowEmptySignature
								? {
										type: "thinking",
										thinking: sanitizeSurrogates(block.thinking),
										signature: "",
									}
								: {
										type: "text",
										text: sanitizeSurrogates(block.thinking),
									},
						);
					} else {
						blocks.push({
							type: "thinking",
							thinking: sanitizeSurrogates(block.thinking),
							signature: block.thinkingSignature,
						});
					}
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: wireToolNames?.get(block.name) ?? block.name,
						input: block.arguments ?? {},
					});
				}
			}
			if (blocks.length === 0) continue;
			params.push({
				role: "assistant",
				content: blocks,
			});
		} else if (msg.role === "toolResult") {
			// Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint
			const toolResults: ContentBlockParam[] = [];

			// Add the current tool result
			toolResults.push({
				type: "tool_result",
				tool_use_id: msg.toolCallId,
				content: convertContentBlocks(msg.content),
				is_error: msg.isError,
			});

			// Look ahead for consecutive toolResult messages
			let j = i + 1;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const nextMsg = transformedMessages[j] as ToolResultMessage; // We know it's a toolResult
				toolResults.push({
					type: "tool_result",
					tool_use_id: nextMsg.toolCallId,
					content: convertContentBlocks(nextMsg.content),
					is_error: nextMsg.isError,
				});
				j++;
			}

			// Skip the messages we've already processed
			i = j - 1;

			// Add a single user message with all tool results
			params.push({
				role: "user",
				content: toolResults,
			});
		}
	}

	// Anthropic 400s on non-alternating `assistant` turns. Consecutive assistant
	// params appear when an empty user turn between two assistant turns was
	// dropped by the filters above (e.g. an empty "nudge" submission after a
	// length-truncated reply) — and the broken pair would replay on every
	// subsequent request. Insert a minimal user separator (oh-my-pi parity).
	for (let i = params.length - 1; i > 0; i--) {
		if (params[i].role === "assistant" && params[i - 1].role === "assistant") {
			params.splice(i, 0, { role: "user", content: "Continue." });
		}
	}

	// Add cache_control to the last user message to cache conversation history
	if (cacheControl && params.length > 0) {
		const lastMessage = params[params.length - 1];
		if (lastMessage.role === "user") {
			if (Array.isArray(lastMessage.content)) {
				const lastBlock = lastMessage.content[lastMessage.content.length - 1];
				if (
					lastBlock &&
					(lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")
				) {
					(lastBlock as any).cache_control = cacheControl;
				}
			} else if (typeof lastMessage.content === "string") {
				lastMessage.content = [
					{
						type: "text",
						text: lastMessage.content,
						cache_control: cacheControl,
					},
				] as any;
			}
		}
	}

	return params;
}

function shouldUseFineGrainedToolStreamingBeta(model: Model<"anthropic-messages">, context: Context): boolean {
	return !!context.tools?.length && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}

function convertTools(
	tools: Tool[],
	wireToolNames: Map<string, string> | undefined,
	supportsEagerToolInputStreaming: boolean,
	cacheControl?: CacheControlEphemeral,
): Anthropic.Messages.Tool[] {
	if (!tools) return [];

	return tools.map((tool, index) => {
		const schema = tool.parameters as { properties?: unknown; required?: string[] };

		return {
			name: wireToolNames?.get(tool.name) ?? tool.name,
			description: tool.description,
			...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
			input_schema: {
				type: "object",
				properties: schema.properties ?? {},
				required: schema.required ?? [],
			},
			...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
		};
	});
}

function mapStopReason(reason: Anthropic.Messages.StopReason | string): StopReason {
	switch (reason) {
		case "end_turn":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		case "refusal":
			return "error";
		case "pause_turn": // Stop is good enough -> resubmit
			return "stop";
		case "stop_sequence":
			return "stop"; // We don't supply stop sequences, so this should never happen
		case "sensitive": // Content flagged by safety filters (not yet in SDK types)
			return "error";
		case "model_context_window_exceeded":
			// Live default on Sonnet 4.5+: the context window auto-truncates the
			// turn. Equivalent to a token-cap stop (oh-my-pi parity).
			return "length";
		default:
			// The reason arrives on the trailing message_delta, so throwing here
			// would unretryably fail a fully-streamed response. Degrade unknown
			// values to a normal stop instead (oh-my-pi parity).
			console.warn(`pi-ai: unknown Anthropic stop reason "${reason}", treating as "stop"`);
			return "stop";
	}
}
