import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { AssistantMessage, Context, Model, Tool, ToolResultMessage } from "../src/types.ts";

const OAUTH_KEY = "sk-ant-oat-test-token";
const API_KEY = "sk-ant-api-test-key";

function makeTool(name: string): Tool {
	return { name, description: `${name} tool`, parameters: { type: "object", properties: {} } };
}

interface CapturedParams {
	tools?: Array<{ name: string }>;
	messages?: Array<{ role: string; content: Array<{ type: string; name?: string }> }>;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
	}
}

async function captureParams(context: Context, apiKey: string): Promise<CapturedParams> {
	const model: Model<"anthropic-messages"> = {
		...getModel("anthropic", "claude-opus-4-8"),
		baseUrl: "http://127.0.0.1:9",
	};
	let captured: CapturedParams | undefined;
	const stream = streamAnthropic(model, context, {
		apiKey,
		onPayload: (payload) => {
			captured = payload as CapturedParams;
			throw new PayloadCaptured();
		},
	});
	await stream.result();
	if (!captured) throw new Error("Expected payload to be captured before request failure");
	return captured;
}

function makeToolCallHistory(toolName: string): Context["messages"] {
	const assistant: AssistantMessage = {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-8",
		content: [{ type: "toolCall", id: "toolu_01", name: toolName, arguments: {} }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "toolu_01",
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: Date.now(),
	};
	return [{ role: "user", content: "go", timestamp: Date.now() }, assistant, toolResult];
}

describe("Claude Code wire tool names (collision-safe rename)", () => {
	it("renames built-in tools to Claude Code canonical casing on OAuth", async () => {
		const params = await captureParams(
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				tools: [makeTool("read"), makeTool("grep")],
			},
			OAUTH_KEY,
		);
		expect(params.tools?.map((t) => t.name)).toEqual(["Read", "Grep"]);
	});

	it("keeps original names verbatim when the rename would collide", async () => {
		// Built-in `read` plus an extension tool literally named `Read`: renaming
		// would duplicate `Read` and the API 400s ("tools: Tool names must be
		// unique"). Uniqueness is case-sensitive, so the originals are valid.
		const params = await captureParams(
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				tools: [makeTool("read"), makeTool("Read"), makeTool("edit")],
			},
			OAUTH_KEY,
		);
		const names = params.tools?.map((t) => t.name);
		expect(names).toEqual(["read", "Read", "Edit"]);
		expect(new Set(names).size).toBe(names?.length);
	});

	it("replays assistant tool calls with the same collision-safe names", async () => {
		// Collision: history name stays verbatim.
		const collided = await captureParams(
			{ messages: makeToolCallHistory("read"), tools: [makeTool("read"), makeTool("Read")] },
			OAUTH_KEY,
		);
		const collidedAssistant = collided.messages?.find((m) => m.role === "assistant");
		expect(collidedAssistant?.content.find((b) => b.type === "tool_use")?.name).toBe("read");

		// No collision: history name follows the canonical rename like tools[].
		const renamed = await captureParams(
			{ messages: makeToolCallHistory("read"), tools: [makeTool("read")] },
			OAUTH_KEY,
		);
		const renamedAssistant = renamed.messages?.find((m) => m.role === "assistant");
		expect(renamedAssistant?.content.find((b) => b.type === "tool_use")?.name).toBe("Read");
	});

	it("does not rename tools for plain API keys", async () => {
		const params = await captureParams(
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [makeTool("read")] },
			API_KEY,
		);
		expect(params.tools?.map((t) => t.name)).toEqual(["read"]);
	});
});
