# Customizations on `mine`

What this fork changes, why, and what must still be true after an upstream sync.

**Structure.** One `##` per area, one `###` per feature under it, seven fields per
feature: **What it does**, **Why**, **Files** (the files the feature *owns*; every changed
file is in exactly one entry's **Files**), **Depends on upstream**, **Tripwire paths**
(upstream files the sync probe reads), **Must still be true**, **Check**.
Paths are always full repo-relative paths. No line numbers anywhere; they rot on every rebase.

**Keeping it current.** After a change, run `fork-commit`: it places the change in the
right entry (or writes a new one) and commits code and ledger together. When upstream
moves, `sync-upstream` rebases, re-checks that every changed file is owned by exactly one
entry, and probes each entry's tripwire paths. A hit sends that entry's **Must still be
true** list to a subagent to verify against the rebased code.

---

## Status line and TUI

### Powerline status line extension

- **What it does:** An example extension that draws an oh-my-pi style powerline bar:
  git branch, model name with a thinking-level glyph, context use, prompt cache hit rate,
  a context gauge that fills the gap, then session name and active agent time. In
  `border` layout (the default) the bar is the editor's top border and the input sits in
  a rounded box; the built-in footer is replaced by an empty one. In `footer` layout the
  bar replaces the footer and the default editor is restored. `/powerline` toggles it;
  `/powerline border|footer|ascii|nerd` picks the layout and the glyph set. It also adds
  one row for it to the extension table in the examples README.
- **Why:** To get the oh-my-pi status line in pi without changing pi's core UI code.
- **Files:** `packages/coding-agent/examples/extensions/powerline-status.ts`,
  `packages/coding-agent/examples/extensions/README.md` (the `powerline-status.ts` row
  in the extension table only)
- **Depends on upstream:** `CustomEditor` must accept `{ embedWorkingStatus: false }`
  and let a subclass override `renderTopBorder`, `renderBottomBorder`, `render` and
  `handleMouse`. The tui `Editor.render` must emit the top border as the first row, the
  content rows next, the bottom border after them, and autocomplete rows last; the box
  wrapper finds the borders by marker strings and wraps only the rows between them.
  Interactive mode must show the working indicator in its own status container when the
  editor does not embed it. The extension API must keep `ctx.ui.setFooter`,
  `ctx.ui.setEditorComponent` (with `undefined` restoring the default),
  `ctx.getContextUsage()`, `ctx.thinkingLevel`, `ctx.sessionManager.getEntries()` and
  `getSessionName()`, and the footer data provider's `getGitBranch()` and
  `onBranchChange()`. The theme must keep the `toolPendingBg`, `borderMuted`,
  `borderAccent` and `border` colors and `getBgAnsi`/`getFgAnsi`.
- **Tripwire paths:** `packages/coding-agent/src/modes/interactive/components/custom-editor.ts`,
  `packages/tui/src/components/editor.ts`,
  `packages/coding-agent/src/modes/interactive/interactive-mode.ts`,
  `packages/coding-agent/src/core/footer-data-provider.ts`,
  `packages/coding-agent/src/core/extensions/types.ts`,
  `packages/coding-agent/src/modes/interactive/theme/theme.ts`
- **Must still be true:**
  - In `border` layout at width 80, every rendered editor row is exactly 80 columns: a
    `╭…╮` row holding the bar, `│ … │` content rows, and a `╰…╯` row.
  - In `border` layout the footer renders no rows.
  - Switching to `footer` layout restores the default editor and the footer renders one
    bar row; `/powerline` toggled off restores both the built-in footer and editor.
  - A `CustomEditor` built without `embedWorkingStatus: true` keeps its top border free of
    the working indicator, so the bar is never overwritten by the spinner.
  - Segments drop from the right group first when the bar does not fit.
  - `npx tsgo --noEmit` reports no errors in the extension file.
- **Check:** from `packages/coding-agent`:
  `node ../../node_modules/vitest/dist/cli.js --run test/powerline-status-extension.test.ts test/status-indicator.test.ts`
