import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import powerlineExtension from "../examples/extensions/powerline-status.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { getEditorTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void>;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;

function setup() {
	initTheme("dark");
	const handlers = new Map<string, Handler>();
	let command: CommandHandler | undefined;
	// Fake API: the extension only subscribes to events and registers one command.
	const api = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand(_name: string, options: { handler: CommandHandler }) {
			command = options.handler;
		},
	} as unknown as ExtensionAPI;
	powerlineExtension(api);

	const setFooter = vi.fn<ExtensionContext["ui"]["setFooter"]>();
	const setEditorComponent = vi.fn<ExtensionContext["ui"]["setEditorComponent"]>();
	const usage = {
		input: 100,
		output: 50,
		cacheRead: 900,
		cacheWrite: 0,
		totalTokens: 1050,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	// Fake context: only the fields the extension reads.
	const ctx = {
		mode: "tui",
		model: { id: "m", name: "Claude" },
		thinkingLevel: "high",
		getContextUsage: () => ({ percent: 42, contextWindow: 200000, tokens: 84000 }),
		sessionManager: {
			getEntries: () => [{ type: "message", message: { role: "assistant", usage } }],
			getSessionName: () => "demo-session",
		},
		ui: { theme, setFooter, setEditorComponent, notify: vi.fn() },
	} as unknown as ExtensionContext;
	// Fake TUI and footer data: rendering needs only these members.
	const tui = { requestRender: vi.fn(), terminal: { rows: 40, columns: 80 } } as unknown as TUI;
	const footerData = {
		getGitBranch: () => "mine",
		onBranchChange: () => () => {},
	} as unknown as ReadonlyFooterDataProvider;

	const renderFooter = (width: number): string[] => {
		const factory = setFooter.mock.lastCall?.[0];
		if (!factory) throw new Error("no footer installed");
		return factory(tui, theme, footerData).render(width).map(stripAnsi);
	};
	const renderEditor = (width: number): string[] => {
		const factory = setEditorComponent.mock.lastCall?.[0];
		if (!factory) throw new Error("no editor installed");
		const editor = factory(tui, getEditorTheme(), KeybindingsManager.create());
		editor.setText("hello");
		return editor.render(width).map(stripAnsi);
	};
	const runCommand = (args: string) => {
		if (!command) throw new Error("command not registered");
		return command(args, ctx);
	};

	return { handlers, ctx, setFooter, setEditorComponent, renderFooter, renderEditor, runCommand };
}

describe("powerline-status example extension", () => {
	it("draws the bar as the top border of a full-width rounded box by default", async () => {
		const { handlers, ctx, renderFooter, renderEditor } = setup();
		await handlers.get("session_start")?.({}, ctx);

		// The footer factory also captures the footer data the editor bar reads.
		expect(renderFooter(80)).toEqual([]);
		const lines = renderEditor(80);
		expect(lines).toHaveLength(3);
		for (const line of lines) expect(visibleWidth(line)).toBe(80);
		expect(lines[0]).toMatch(/^╭.*mine.*Claude.*42\.0%\/200k.*90\.00%.*demo-session.*╮$/);
		expect(lines[1]).toMatch(/^│ hello\s+│$/);
		expect(lines[2]).toMatch(/^╰─+╯$/);
	});

	it("moves the bar to the footer and restores the default editor", async () => {
		const { handlers, ctx, setEditorComponent, renderFooter, runCommand } = setup();
		await handlers.get("session_start")?.({}, ctx);
		await runCommand("footer");

		expect(setEditorComponent).toHaveBeenLastCalledWith(undefined);
		const lines = renderFooter(80);
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0]!)).toBe(80);
		expect(lines[0]).toContain("demo-session");
	});

	it("drops right-hand segments before left-hand ones when the bar is too narrow", async () => {
		const { handlers, ctx, renderFooter, runCommand } = setup();
		await handlers.get("session_start")?.({}, ctx);
		await runCommand("footer");
		await runCommand("ascii");

		const [narrow] = renderFooter(64);
		expect(narrow).not.toContain("demo-session");
		expect(narrow).toContain("cache 90.00%");
	});

	it("restores the built-in footer and editor when toggled off", async () => {
		const { handlers, ctx, setFooter, setEditorComponent, runCommand } = setup();
		await handlers.get("session_start")?.({}, ctx);
		await runCommand("");

		expect(setFooter).toHaveBeenLastCalledWith(undefined);
		expect(setEditorComponent).toHaveBeenLastCalledWith(undefined);
	});
});
