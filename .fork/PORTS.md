# Upstream Port Journal

Short memory for the next port — not a diary. One entry per upstream commit ported onto custom/main (batch a run of trivial clean ports into one entry), newest first. See your agent memory (`CLAUDE.md` or `AGENTS.md`), Fork Maintenance section, for the format.

Each entry records: the upstream SHA(s) and subject ported, conflicts and how they were resolved, `rerere` replays checked, drift-check verdicts (`Symbols`/`Drift-if`), `merge=ours` decisions, the `verify.sh` result, and any `audit.sh` follow-ups (customizations retired or flagged). The `.fork/UPSTREAM` pointer is the authoritative record of how far you have ported; this journal is the *why*.

<!-- Example:
## 2026-05-29 — ported upstream def5678 "Rework input layout"

Applied: git cherry-pick -x --no-commit def5678; .fork/UPSTREAM -> def5678
Conflicts: RichInput.tsx (useLayout -> useDisplayMode), re-applied horizontal layout
rerere: package.json replay checked, still correct
Drift-check: useDisplayMode orientation kept -> safe
merge=ours: none in this commit
Audit: input-mode customization superseded by an upstream setting -> removed
Verify: ./.fork/verify.sh --registry passed; full verify.sh passed at end of run
-->

---

## 2026-06-10 — catch-up port 2edd6b43 → 9ccfcd7c (34 upstream commits, v0.79.0 → past v0.79.1)

Pointer: `2edd6b43` (init at the fork point) → `9ccfcd7c` (upstream/main HEAD). Backlog now empty.

### Toolkit fixes made first (not upstream ports)
- **port.sh first-parent traversal** (`13e583b4`): upstream merges true-merge PRs whose branches were cut *before* our pointer, so the old `--no-merges` backlog deadlocked (its oldest entry was a side-branch commit that could never satisfy `assert_forward`, and contiguity blocked everything behind it). Rewrote `backlog()` to walk `--first-parent` (merges included) and `start_port` to cherry-pick a merge as its `-m 1` net effect; `conflict-context.sh` shows the first-parent diff for a merge. Linear ports behave exactly as before.
- **husky hook chaining** (`13e..`, registered `2207c61f`): this repo uses husky (`core.hooksPath=.husky/_`), so `.fork/hooks/*` never fired and ports weren't gated. Chained the fork-flow pre-commit/commit-msg/pre-merge gates into the husky hooks. Registered as `custom: fork-flow-husky-gate`.

### Clean / trivial ports (batched)
20b78eaf, 44e33798(merge #5527 bedrock ARN), 4c486365(merge #5505 generate-models), c6bdfa19, 2326d5cb(Moonshot), 22e45492(merge #5283 TUI cursor), def99d39, 8da077bc(CJK wrap), 84cdd024(Azure no-store), 081a0a2b, db3f9953(project-trust ext), e4907b3b, 19060743, 28c83e83, 66335d3a(experimental guard), 64b51efb(z.ai), 9632bddd, 3d02d1da(OpenCode maxTokens), d041b5cc(merge #5549 approval settings), 69ea1a63, b7e721cb(autocomplete triggers), ae7a885d, c5582102(merge #5553 prompt-template defaults), 4d9f9f45(image-models Riverflow rename), 28df940f(Release v0.79.1), 82f2b1e9([Unreleased] section). Conflicts were all CHANGELOG `[Unreleased]` unions (kept fork's billing/fable entries + upstream's new bullets) and the d041b5cc `WarningSettings`-removal interplay in settings-manager/settings-selector (kept the fork's removal, took upstream's `DefaultProjectTrust`). Drift: none of these touch the customizations' runtime behavior.

### Fable 5 ports (overlap anthropic-fable-mythos) — drift verdicts
- **5a9d72ea** (Fable 5 metadata): conflicts in generate-models.ts — fork's `isAnthropicFableOrMythosModel(...)` predicate + thinkingLevelMap block already subsume upstream's narrower `fable-5` additions. Kept fork (superset). Verdict: safe.
- **66f432ca** (regenerate models.generated.ts): the dangerous one. Generated file; git's 3-way auto-merge produced a *hybrid* (it stacked a duplicate `~anthropic/claude-fable-latest` and dragged incidental live-models.dev drift). **Discarded the auto-merge**, reset models.generated.ts to fork HEAD, and surgically applied ONLY the intentional materialization of `6b5923f1`'s generator change: azure gpt-5.4/5.5 contextWindow→1050000, gpt-5-pro maxTokens→128000 (openai + azure clone). Result diffs fork HEAD by exactly 4 lines; preserved all 6 Fable/Mythos entries incl. `supportsTemperature:false` pins and openrouter `xhigh` thinkingLevelMap. Verdict: safe, drift avoided.
- **dacb367e** (adaptive-thinking test): kept fork's superset regex `(...|(fable|mythos)[-.]5)`, took upstream's fable-5 EXPECTED additions, and added `anthropic/claude-mythos-5` for an honest fork guard.
- **9ccfcd7c** (omit disabled thinking for Fable 5): **behavioral divergence, customization supersedes upstream.** Upstream marks Fable "thinking off" unsupported (`thinkingLevelMap off:null` + a `buildParams` payload guard, per PR #5567). This fork instead keeps "off" available and maps it to cheapest adaptive (omit thinking, pin `output_config.effort:"low"` — oh-my-pi parity). Fork's `forceAdaptiveThinking` branch already prevents the 400 (upstream's core goal) and pins the cheap effort upstream omits. Kept fork's anthropic.ts + generate-models.ts; **reverted** upstream's auto-applied contradictory test assertions (`output_config` toBeUndefined in anthropic-thinking-disable, `not.toContain("off")` ×2 in supports-xhigh); took the CHANGELOG entry. Recorded the off:null divergence as a new Drift-if tripwire and added supports-xhigh.test.ts to the entry's Touches+Verify (`98f2e312`).

### merge=ours
None — this fork has no `merge=ours` overrides (backstop trivially satisfied).

### Verify / audit
- `verify.sh --registry`: green throughout (ran on every port commit via the now-wired husky gate; the rg-guarded billing "warning surface removed" assertions genuinely run when `rg` is on PATH — they pass).
- Full `verify.sh`: typecheck + lint pass; test phase has 108 failures, ALL environmental and confirmed unrelated to the ports — 105 are live OpenAI-Codex E2E hitting `usage_limit_reached` (429), and 3 are retries of one pre-existing `session-id-readonly` test ("No API key found…") that fails identically on the pre-port baseline (caused by the billing customization's model-resolution order in a no-credentials shell, not these ports). All anthropic-fable + billing registry tests pass.
- `audit.sh`: pointer consistency OK (9ccfcd7c is an ancestor of upstream/main; newest port trailer matches the pointer); backlog empty; no orphaned anchors; registry gaps closed (registered fork-flow-husky-gate); no patch-id reimplementation (9ccfcd7c's supersession is re-expressed, so it won't patch-id match — documented in the Drift-if instead).

### CHANGES.md updates
- `anthropic-fable-mythos`: added `supports-xhigh.test.ts` to Touches + Verify; added the off:null divergence tripwire to Drift-if.
- New `fork-flow-husky-gate` entry.

### Note for the user (cosmetic, not breaking)
The Release v0.79.1 port renamed `## [Unreleased]` → `## [0.79.1]`, so the fork's billing/Fable changelog entries now sit under `[0.79.1]` rather than `[Unreleased]`. Left as-is (a reasonable record of the sync point; splitting interleaved fork/upstream entries would be riskier than leaving it). No functional impact.
