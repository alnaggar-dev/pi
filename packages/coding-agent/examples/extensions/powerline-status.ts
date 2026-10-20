/**
 * Powerline Status Line Extension
 *
 * Recreates the oh-my-pi (omp) powerline status bar:
 *
 *   <git> <model> <context> <cache> ───────────── <session> <time>
 *
 * Segments are drawn on one background band and joined with Nerd Font
 * powerline separators. The middle gap is a context gauge: the filled head
 * tracks context-window usage, the remainder is drawn with the border color.
 *
 * Two layouts:
 *   - border (default): the bar becomes the editor's top border, and the input
 *     is wrapped in a rounded box.
 *   - footer: the bar replaces the built-in footer below the editor.
 *
 * Usage:
 *   pi --extension examples/extensions/powerline-status.ts
 *
 * Commands:
 *   /powerline              Toggle the powerline UI
 *   /powerline border       Boxed editor with the bar as its top border (default)
 *   /powerline footer       Bar as the footer instead
 *   /powerline ascii        Use ASCII separators/icons (no Nerd Font needed)
 *   /powerline nerd         Use Nerd Font separators/icons
 */

import type { Usage } from "@earendil-works/pi-ai";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type ReadonlyFooterDataProvider,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type EditorTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

// Nerd Font powerline separators (U+E0B1 points right, U+E0B3 points left).
const SEP_RIGHT = "\ue0b1";
const SEP_LEFT = "\ue0b3";
const GAUGE = "─";
const ASCII_SEPARATOR = "-";
const ASCII_GAUGE = "-";

const NERD_ICONS = {
	branch: "\uf126", // nf-fa-code_fork
	model: "\uec19", // nf-md-... (compact chip)
	context: "\uf108", // nf-fa-desktop
	cache: "\uf1c0", // nf-fa-database
	time: "\uf017", // nf-fa-clock_o
};

const ASCII_ICONS = {
	branch: "git",
	model: "ai",
	context: "ctx",
	cache: "cache",
	time: "t",
};

const THINKING_GLYPHS: Record<string, string> = {
	minimal: "\u{F0A9E}",
	low: "\u{F0A9F}",
	medium: "\u{F0AA1}",
	high: "\u{F0AA3}",
	xhigh: "\u{F0AA5}",
	max: "\uf06d", // nf-fa-fire
};

const THINKING_COLORS: Record<string, ThemeColor> = {
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

// Rounded box used by border mode.
const BOX_TOP_LEFT = "╭";
const BOX_TOP_RIGHT = "╮";
const BOX_BOTTOM_LEFT = "╰";
const BOX_BOTTOM_RIGHT = "╯";
const BOX_VERTICAL = "│";

// Zero-width sentinels used to locate the editor's top/bottom border rows
// while wrapping them in side borders.
const TOP_MARK = "\u0001pwt\u0001";
const BOTTOM_MARK = "\u0001pwb\u0001";

const EMPTY_ACTIVE_TIME_MS = 1000;

/** Centered scroll label used by the editor's bottom border. Mirrors the built-in editor. */
function scrollBorder(direction: "↑" | "↓", hiddenLineCount: number, width: number): string {
	const availableWidth = Math.max(0, width);
	const label = ` ${direction} ${hiddenLineCount} more `;
	const labelWidth = visibleWidth(label);
	if (labelWidth + 2 <= availableWidth) {
		const leftWidth = Math.floor((availableWidth - labelWidth) / 2);
		return "─".repeat(leftWidth) + label + "─".repeat(availableWidth - leftWidth - labelWidth);
	}
	const indicator = `─── ${direction} ${hiddenLineCount} more `;
	const remaining = availableWidth - visibleWidth(indicator);
	if (remaining >= 0) return indicator + "─".repeat(remaining);
	return truncateToWidth(indicator, availableWidth, "");
}

type Layout = "footer" | "border";

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function createUsageTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsage(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

function collectUsage(ctx: ExtensionContext): { totals: UsageTotals; cacheHit: number | undefined } {
	const totals = createUsageTotals();
	let cacheHit: number | undefined;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "usage") {
			addUsage(totals, entry.usage);
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			addUsage(totals, entry.message.usage);
			const prompt = entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
			if (prompt > 0) cacheHit = (entry.message.usage.cacheRead / prompt) * 100;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			addUsage(totals, entry.message.usage);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			addUsage(totals, entry.usage);
		}
	}

	return { totals, cacheHit };
}

function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

/** Turn a background SGR code into the equivalent foreground code for powerline caps. */
function bgToFg(bgAnsi: string): string {
	return bgAnsi.replace("\x1b[48;", "\x1b[38;");
}

interface RenderOptions {
	width: number;
	theme: Theme;
	footerData: ReadonlyFooterDataProvider;
	ctx: ExtensionContext;
	activeMs: number;
	ascii: boolean;
	/** Color for the unfilled part of the context gauge. */
	gaugeRestColor: ThemeColor;
}

/** Render exactly `width` columns of powerline bar, or "" when there is nothing to show. */
function renderStatusLine(options: RenderOptions): string {
	const { width, theme, footerData, ctx, activeMs, ascii, gaugeRestColor } = options;
	if (width <= 0) return "";

	const separatorRight = ascii ? ASCII_SEPARATOR : SEP_RIGHT;
	const separatorLeft = ascii ? ASCII_SEPARATOR : SEP_LEFT;
	const gaugeChar = ascii ? ASCII_GAUGE : GAUGE;
	const icons = ascii ? ASCII_ICONS : NERD_ICONS;

	const bgAnsi = theme.getBgAnsi("toolPendingBg");
	const bgAsFg = bgToFg(bgAnsi);
	const textAnsi = theme.getFgAnsi("text");
	const separatorAnsi = theme.getFgAnsi("borderMuted");

	const buildLeft = (parts: string[]): string => {
		if (parts.length === 0) return "";
		const inner = parts.join(` ${separatorAnsi}${separatorRight}${textAnsi} `);
		return `${bgAnsi}${textAnsi} ${inner} \x1b[0m${bgAsFg}${separatorRight}\x1b[0m`;
	};

	const buildRight = (parts: string[]): string => {
		if (parts.length === 0) return "";
		const inner = parts.join(` ${separatorAnsi}${separatorLeft}${textAnsi} `);
		return `${bgAsFg}${separatorLeft}\x1b[0m${bgAnsi}${textAnsi} ${inner} \x1b[0m`;
	};

	// ── Left segments ────────────────────────────────────────────────────────
	const left: string[] = [];

	const branch = footerData.getGitBranch();
	if (branch) {
		left.push(theme.fg("success", `${icons.branch} ${branch}`));
	}

	const model = ctx.model;
	if (model) {
		const modelName = model.name ?? model.id;
		let text = `${icons.model} ${modelName}`;
		const level = ctx.thinkingLevel;
		const glyph = level ? THINKING_GLYPHS[level] : undefined;
		if (level && glyph) {
			text += ` ${theme.fg(THINKING_COLORS[level], glyph)}`;
		}
		left.push(theme.fg("accent", text));
	}

	const contextUsage = ctx.getContextUsage();
	if (contextUsage) {
		const percent = contextUsage.percent;
		const percentText = percent === null ? "?" : `${percent.toFixed(1)}%`;
		const windowText = formatTokens(contextUsage.contextWindow);
		const color: ThemeColor =
			percent !== null && percent > 90 ? "error" : percent !== null && percent > 70 ? "warning" : "text";
		left.push(theme.fg(color, `${icons.context} ${percentText}/${windowText}`));
	}

	const { cacheHit } = collectUsage(ctx);
	if (cacheHit !== undefined) {
		left.push(theme.fg("text", `${icons.cache} ${cacheHit.toFixed(2)}%`));
	}

	// ── Right segments ───────────────────────────────────────────────────────
	const right: string[] = [];

	const sessionName = ctx.sessionManager.getSessionName();
	if (sessionName) {
		right.push(theme.fg("accent", sessionName));
	}
	if (activeMs >= EMPTY_ACTIVE_TIME_MS) {
		right.push(theme.fg("text", `${icons.time} ${formatDuration(activeMs)}`));
	}

	// ── Compose, dropping segments that no longer fit ────────────────────────
	let leftGroup = buildLeft(left);
	let rightGroup = buildRight(right);

	while (right.length > 0 && visibleWidth(leftGroup) + visibleWidth(rightGroup) + 1 > width) {
		right.pop();
		rightGroup = buildRight(right);
	}
	while (left.length > 1 && visibleWidth(leftGroup) + visibleWidth(rightGroup) + 1 > width) {
		left.pop();
		leftGroup = buildLeft(left);
	}

	if (leftGroup === "" && rightGroup === "") return "";

	// ── Context gauge fills the gap between the two groups ───────────────────
	const leftWidth = visibleWidth(leftGroup);
	const rightWidth = visibleWidth(rightGroup);
	const gap = Math.max(0, width - leftWidth - rightWidth);
	let gauge = "";
	if (gap > 0) {
		const percent = Math.max(0, Math.min(100, contextUsage?.percent ?? 0));
		const used = Math.round((gap * percent) / 100);
		const usedAnsi = theme.getFgAnsi("borderAccent");
		const restAnsi = theme.getFgAnsi(gaugeRestColor);
		gauge = `${usedAnsi}${gaugeChar.repeat(used)}${restAnsi}${gaugeChar.repeat(gap - used)}\x1b[0m`;
	}

	return truncateToWidth(leftGroup + gauge + rightGroup, width);
}

interface PowerlineViewModel {
	ctx: ExtensionContext | undefined;
	footerData: ReadonlyFooterDataProvider | undefined;
	activeMs: number;
	ascii: boolean;
}

/**
 * Editor that renders the powerline bar as its top border and wraps the input
 * in a rounded box. Content lines are rendered two columns narrower and gain
 * `│` side borders, so the box edges line up with the bar's end caps.
 *
 * The working indicator is not embedded (border mode clears the footer), so the
 * app renders it through its normal status container.
 */
class PowerlineEditor extends CustomEditor {
	private readonly getTheme: () => Theme;
	private readonly getViewModel: () => PowerlineViewModel;
	private outerWidth = 0;

	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		getTheme: () => Theme,
		getViewModel: () => PowerlineViewModel,
	) {
		super(tui, editorTheme, keybindings, { embedWorkingStatus: false });
		this.getTheme = getTheme;
		this.getViewModel = getViewModel;
	}

	/** Full outer width minus the two side borders. */
	private borderWidth(): number {
		return Math.max(0, this.outerWidth - 2);
	}

	protected override renderTopBorder(_width: number, _hiddenLineCount: number): string {
		const width = this.borderWidth();
		const view = this.getViewModel();
		const theme = this.getTheme();
		if (!view.ctx || !view.footerData) return TOP_MARK + theme.fg("border", "─".repeat(width));
		const bar = renderStatusLine({
			width,
			theme,
			footerData: view.footerData,
			ctx: view.ctx,
			activeMs: view.activeMs,
			ascii: view.ascii,
			gaugeRestColor: "border",
		});
		const fill = theme.fg("border", "─".repeat(Math.max(0, width - visibleWidth(bar))));
		return TOP_MARK + (bar === "" ? fill : bar + fill);
	}

	protected override renderBottomBorder(_width: number, hiddenLineCount: number): string {
		const width = this.borderWidth();
		const border = hiddenLineCount > 0 ? scrollBorder("↓", hiddenLineCount, width) : "─".repeat(width);
		return BOTTOM_MARK + this.getTheme().fg("border", border);
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// Content is indented by the left border plus one space.
		return super.handleMouse({ ...event, x: event.x - 2, width: Math.max(1, event.width - 3) });
	}

	override render(width: number): string[] {
		this.outerWidth = width;
		if (width < 6) {
			return super.render(width).map((line) => line.replace(TOP_MARK, "").replace(BOTTOM_MARK, ""));
		}

		// Content is one column narrower than the border so it gains a leading
		// space inside the left edge; both render to the same total width.
		const contentWidth = width - 3;
		const lines = super.render(contentWidth);
		const topIndex = lines.findIndex((line) => line.startsWith(TOP_MARK));
		const bottomIndex = lines.findIndex((line) => line.startsWith(BOTTOM_MARK));
		if (topIndex < 0 || bottomIndex <= topIndex) {
			return lines.map((line) => line.replace(TOP_MARK, "").replace(BOTTOM_MARK, ""));
		}

		const theme = this.getTheme();
		const edge = (text: string): string => `${theme.fg("border", text)}\x1b[0m`;

		const result: string[] = [];
		result.push(`${edge(BOX_TOP_LEFT)}${lines[topIndex].slice(TOP_MARK.length)}${edge(BOX_TOP_RIGHT)}`);
		for (let i = topIndex + 1; i < bottomIndex; i++) {
			result.push(`${edge(BOX_VERTICAL)} ${lines[i]}\x1b[0m${edge(BOX_VERTICAL)}`);
		}
		result.push(`${edge(BOX_BOTTOM_LEFT)}${lines[bottomIndex].slice(BOTTOM_MARK.length)}${edge(BOX_BOTTOM_RIGHT)}`);
		// Autocomplete rows sit below the box; pad them to the full width.
		for (let i = bottomIndex + 1; i < lines.length; i++) {
			const line = lines[i];
			result.push(line + " ".repeat(Math.max(0, width - visibleWidth(line))));
		}
		return result;
	}
}

export default function (pi: ExtensionAPI) {
	let latestContext: ExtensionContext | undefined;
	let capturedFooterData: ReadonlyFooterDataProvider | undefined;
	let activeTui: TUI | undefined;
	let enabled = true;
	let ascii = false;
	let layout: Layout = "border";
	let activeMs = 0;
	let activeStartedAt: number | null = null;

	const currentActiveMs = (): number => activeMs + (activeStartedAt === null ? 0 : Date.now() - activeStartedAt);

	const viewModel = (): PowerlineViewModel => ({
		ctx: latestContext,
		footerData: capturedFooterData,
		activeMs: currentActiveMs(),
		ascii,
	});

	const installFooter = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme, footerData): Component & { dispose?(): void } => {
			activeTui = tui;
			capturedFooterData = footerData;
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose(): void {
					unsubscribeBranch();
				},
				invalidate(): void {},
				render(width: number): string[] {
					const current = latestContext;
					if (!current) return [];
					return [
						renderStatusLine({
							width,
							theme,
							footerData,
							ctx: current,
							activeMs: currentActiveMs(),
							ascii,
							gaugeRestColor: "borderMuted",
						}),
					];
				},
			};
		});
	};

	const installBorder = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		// Capture the footer data provider (git branch, branch-change events)
		// while rendering nothing below the editor.
		ctx.ui.setFooter((tui, _theme, footerData): Component & { dispose?(): void } => {
			activeTui = tui;
			capturedFooterData = footerData;
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose(): void {
					unsubscribeBranch();
				},
				invalidate(): void {},
				render(): string[] {
					return [];
				},
			};
		});
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			activeTui = tui;
			return new PowerlineEditor(tui, editorTheme, keybindings, () => ctx.ui.theme, viewModel);
		});
	};

	const install = (ctx: ExtensionContext): void => {
		if (layout === "border") {
			installBorder(ctx);
		} else {
			// Leaving border mode must restore the default editor as well.
			if (ctx.mode === "tui") ctx.ui.setEditorComponent(undefined);
			installFooter(ctx);
		}
	};

	const uninstall = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter(undefined);
		ctx.ui.setEditorComponent(undefined);
	};

	pi.on("session_start", async (_event, ctx) => {
		latestContext = ctx;
		activeMs = 0;
		activeStartedAt = null;
		if (enabled) install(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		uninstall(ctx);
		latestContext = undefined;
		capturedFooterData = undefined;
		activeTui = undefined;
	});

	pi.on("agent_start", async (_event, ctx) => {
		latestContext = ctx;
		activeStartedAt = Date.now();
	});

	pi.on("agent_end", async (_event, ctx) => {
		latestContext = ctx;
		if (activeStartedAt !== null) {
			activeMs += Date.now() - activeStartedAt;
			activeStartedAt = null;
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		latestContext = ctx;
	});

	pi.registerCommand("powerline", {
		description: "Toggle the powerline UI ('footer'/'border' layout, 'ascii'/'nerd' separators)",
		handler: async (args, ctx) => {
			latestContext = ctx;
			const arg = args.trim().toLowerCase();

			if (arg === "ascii" || arg === "nerd") {
				ascii = arg === "ascii";
				ctx.ui.notify(`Powerline separators: ${ascii ? "ASCII" : "Nerd Font"}`, "info");
				activeTui?.requestRender();
				return;
			}
			if (arg === "footer" || arg === "border") {
				layout = arg;
				if (enabled) install(ctx);
				ctx.ui.notify(`Powerline layout: ${layout}`, "info");
				activeTui?.requestRender();
				return;
			}

			enabled = !enabled;
			if (enabled) install(ctx);
			else uninstall(ctx);
			ctx.ui.notify(enabled ? "Powerline UI enabled" : "Built-in UI restored", "info");
		},
	});
}
