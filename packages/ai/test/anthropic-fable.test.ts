import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import type { AnthropicOptions } from "../src/providers/anthropic.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context, Model } from "../src/types.ts";

interface CapturedParams {
	tool_choice?: { type: string; name?: string };
	thinking?: { type: string };
	temperature?: number;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
	}
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		tools: [
			{
				name: "lookup",
				description: "Look something up",
				parameters: { type: "object", properties: {} },
			},
		],
	};
}

async function captureParams(model: Model<"anthropic-messages">, options: AnthropicOptions): Promise<CapturedParams> {
	let captured: CapturedParams | undefined;
	const stream = streamAnthropic({ ...model, baseUrl: "http://127.0.0.1:9" }, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			captured = payload as CapturedParams;
			throw new PayloadCaptured();
		},
	});
	await stream.result();
	if (!captured) throw new Error("Expected payload to be captured before request failure");
	return captured;
}

describe("Claude Fable/Mythos 5 request shaping", () => {
	const fable = () => getModel("anthropic", "claude-fable-5");

	it("downgrades forced tool_choice any → auto", async () => {
		const params = await captureParams(fable(), { toolChoice: "any" });
		expect(params.tool_choice).toEqual({ type: "auto" });
	});

	it("downgrades forced tool_choice tool → auto", async () => {
		const params = await captureParams(fable(), { toolChoice: { type: "tool", name: "lookup" } });
		expect(params.tool_choice).toEqual({ type: "auto" });
	});

	it("keeps tool_choice none untouched", async () => {
		const params = await captureParams(fable(), { toolChoice: "none" });
		expect(params.tool_choice).toEqual({ type: "none" });
	});

	it("keeps forced tool_choice on models that support it", async () => {
		const params = await captureParams(getModel("anthropic", "claude-opus-4-8"), { toolChoice: "any" });
		expect(params.tool_choice).toEqual({ type: "any" });
	});

	it("honors a compat.supportsForcedToolChoice override", async () => {
		const model: Model<"anthropic-messages"> = {
			...fable(),
			compat: { ...fable().compat, supportsForcedToolChoice: true },
		};
		const params = await captureParams(model, { toolChoice: "any" });
		expect(params.tool_choice).toEqual({ type: "any" });
	});

	it("drops temperature on Fable (catalog marks it unsupported)", async () => {
		const params = await captureParams(fable(), { temperature: 0.7 });
		expect(params.temperature).toBeUndefined();
	});
});
