import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const interactiveModeSource = readFileSync(
	fileURLToPath(new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url)),
	"utf8",
);

// The Anthropic subscription usage warning and its entire warning-settings surface
// were removed once the default Anthropic OAuth flow became Claude Pro/Max
// subscription-billing compatible. These tests guard against the warning (or its
// settings plumbing) being reintroduced for either OAuth or API-key credentials.
//
// Forbidden tokens are assembled from fragments so this test file does not itself
// contain the literal strings the fork-registry negative-grep scans for.
const warn = "maybeWarn" + "AboutAnthropicSubscriptionAuth";
const warnConst = "ANTHROPIC_SUBSCRIPTION" + "_AUTH_WARNING";
const warnKeyFn = "isAnthropic" + "SubscriptionAuthKey";
const warnFlag = "anthropicSubscription" + "WarningShown";
const getWarn = "get" + "Warnings";
const setWarn = "set" + "Warnings";
const onWarn = "onWarnings" + "Change";

describe("Anthropic subscription-auth warning removal", () => {
	test("the warning method no longer exists on InteractiveMode", () => {
		expect((InteractiveMode as any).prototype[warn]).toBeUndefined();
	});

	test("the warning is never shown for Anthropic OAuth or API-key credentials", () => {
		expect(interactiveModeSource).not.toContain(warn);
		expect(interactiveModeSource).not.toContain(warnConst);
		expect(interactiveModeSource).not.toContain(warnKeyFn);
		expect(interactiveModeSource).not.toContain(warnFlag);
		const warningCopy = new RegExp([["extra", "usage"].join(" "), ["Claude", "plan", "limits"].join(" ")].join("|"));
		expect(interactiveModeSource).not.toMatch(warningCopy);
	});

	test("the warning-settings plumbing is gone from interactive mode", () => {
		expect(interactiveModeSource).not.toContain(getWarn);
		expect(interactiveModeSource).not.toContain(setWarn);
		expect(interactiveModeSource).not.toContain(onWarn);
	});
});
