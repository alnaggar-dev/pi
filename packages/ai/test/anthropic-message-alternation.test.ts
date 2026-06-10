import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { AssistantMessage, Context, Message } from "../src/types.ts";

interface CapturedParams {
	messages?: Array<{ role: string; content: unknown }>;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
	}
}

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		content: [{ type: "text", text }],
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
}

async function captureParams(messages: Message[]): Promise<CapturedParams> {
	const model = { ...getModel("anthropic", "claude-sonnet-4-5"), baseUrl: "http://127.0.0.1:9" };
	let captured: CapturedParams | undefined;
	const stream = streamAnthropic(model, { messages } satisfies Context, {
		apiKey: "sk-ant-api-test-key",
		onPayload: (payload) => {
			captured = payload as CapturedParams;
			throw new PayloadCaptured();
		},
	});
	await stream.result();
	if (!captured) throw new Error("Expected payload to be captured before request failure");
	return captured;
}

describe("Anthropic message alternation", () => {
	it("inserts a user separator when an empty user turn between assistant turns is dropped", async () => {
		// An empty "nudge" submission after a length-truncated reply: the converter
		// drops the blank user turn, which would leave consecutive assistant params —
		// Anthropic 400s on non-alternating assistant turns, and the broken pair
		// would replay on every subsequent request.
		const params = await captureParams([
			{ role: "user", content: "go", timestamp: Date.now() },
			assistantText("first half"),
			{ role: "user", content: "   ", timestamp: Date.now() },
			assistantText("second half"),
		]);

		const roles = params.messages?.map((message) => message.role);
		expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
		expect(params.messages?.[2].content).toBe("Continue.");
	});

	it("leaves normally alternating conversations untouched", async () => {
		const params = await captureParams([
			{ role: "user", content: "go", timestamp: Date.now() },
			assistantText("reply"),
			{ role: "user", content: "more", timestamp: Date.now() },
		]);

		const roles = params.messages?.map((message) => message.role);
		expect(roles).toEqual(["user", "assistant", "user"]);
		expect(params.messages?.every((message) => message.content !== "Continue.")).toBe(true);
	});
});
