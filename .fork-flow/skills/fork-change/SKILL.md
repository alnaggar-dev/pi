---
name: fork-change
description: Register a personal-fork customization in .fork/CHANGES.md from your actual diff — run it right before you commit the change (or after, for work you already committed). It reads the diff, drafts the entry, asks only when intent isn't clear, then runs the gate.
---

You are on a personal fork. This is the COMMIT-TIME step: code your customization FIRST, then run this before you commit it (or after, to register something you already committed). It reads what you actually changed, writes the `.fork/CHANGES.md` entry from the diff, and runs the gate. The standing rules live in the Fork Maintenance section of your agent memory (CLAUDE.md or AGENTS.md); this skill is the register-and-verify half. Never code on upstream/main.

You do NOT run this before coding. The one decision made *while* coding — the lowest-risk integration point (extension point > net-new file you own > small in-place edit > merge=ours last resort) — is already in your always-loaded memory's Hard rules, so you have it without invoking anything.

1. See what you changed.
   - Not yet committed (the normal case): `git diff`, `git diff --staged`, `git status`. Do NOT run `./.fork/audit.sh` yet — it reads only COMMITTED history (`base..HEAD`, where base is the `.fork/UPSTREAM` pointer, or the merge-base on a not-yet-ported fork), so on uncommitted work it shows nothing of yours, and on a fresh fork its only "delta" is the kit-install commit. That is expected, not a finding.
   - Already committed (you forgot at the time): `./.fork/audit.sh` and take its UNREGISTERED list — files your own commits changed that no entry covers. It already excludes upstream port and `port.sh revert` (unport) commits (they carry a `Fork-Flow-Port` / `Fork-Flow-Unport` trailer), so what it lists is genuinely yours.

2. READ each diff before writing anything — do NOT hand-write blind and do NOT mechanically scrape file names into entries.
   - For an already-committed file, diff it against the porting base — the last-ported upstream commit in .fork/UPSTREAM, whose first token is the SHA: `git diff "$(awk 'NF && $1!~/^#/{print $1; exit}' .fork/UPSTREAM)"..HEAD -- <file>`, falling back to `git diff "$(git merge-base HEAD <upstream-ref>)"..HEAD -- <file>` if the pointer is unset. For uncommitted: `git diff -- <file>`.
   - Group related files into ONE customization — one entry per feature, never per file.

3. Check the integration point you actually used. If the diff edits an upstream file in place where an extension point or a net-new file you own would have been lower-risk, say so and prefer redoing it that way — a risky edit you only *document* still breaks on the next port. merge=ours is the last resort: it hides upstream changes, including security fixes. Stay in scope: register the customization as you built it and flag risks — fix defects only WITHIN your own diff; do not chase unrelated cleanups in upstream code.

4. Draft the entry. Start it with a `## custom: <slug>` heading (exactly two `#`, a space, a non-empty slug). The `custom:` here is the registry convention — distinct from, though it mirrors, the `custom:` commit-message prefix in step 6. verify.sh lints the registry and FAILS the gate on a malformed/empty heading so a typo can't silently drop the next entry's Verify. Fields:
   - Reason — one sentence: why it exists. Derive it from the diff. If the diff does not tell you *why* the change exists, say so and ASK — describe what you actually built; never invent intent.
   - Touches — the tracked file paths it depends on, `;`-separated, grep-friendly. Each token must be a tracked path (a glob like `src/icons/*.svg` is fine as long as it matches a tracked file). NO prose and NO parenthetical notes: the field splits on BOTH `;` and `,`, so `file.ts (foo, bar)` fragments into three bogus anchors — put commentary in Reason.
   - Verify — a command, or `manual: <what to look at>`. verify.sh runs the Verify of EVERY entry with stdin closed (</dev/null, so a cat/grep/read-style Verify can't swallow the rest of the registry): anything not marked "manual:" is run as a command (non-zero fails the gate); a human check must be written as "manual: <what to look at>" or it runs as a command and fails. Prefer a runnable Verify even for visible changes so the gate can prove the customization survived without a human looking; a manual check is fine for visible UI or asset changes.
   - Symbols / Drift-if — two SEPARATE fields; add ONLY when upstream could break you SILENTLY with the same API shape (visible breakage you'd notice needs neither).
     - Symbols (`name@path`, `;`-separated): the upstream symbols your code depends on. Derive them from what the code actually uses with `lsp references`; if no language server is available, fall back to `search` for the usages or read the diff. brief.sh matches the PATH part (after `@`) against incoming upstream commits, so anchoring a hot file (e.g. a central `types.ts`) re-flags this entry on every commit that touches it — accept that noise only when the silent-break risk earns it.
     - Drift-if: the concrete condition that would silently break you. When present, the Verify MUST be a runnable command (an automated tripwire) — a manual or missing Verify there is a hard error.
     - Symbols WITHOUT a Drift-if is a valid, common entry — do NOT spiral trying to force one. If the break is silent but an HONEST runtime tripwire is impossible (e.g. it hinges on an inline string-literal discriminant you can't import as a symbol, so any test would hardcode the same literal on both sides and drift with it), use Symbols only, record WHY in a `Note:` line, and move on. Never invent a Drift-if you cannot prove.

5. PROVE THE TRIPWIRE — for every Drift-if entry only (skip this for Symbols-only entries). A Verify you have never watched FAIL is not protection. After writing it, make the Drift-if condition true once (stub the upstream symbol to its broken shape, e.g. have it return the renamed field), run the Verify, confirm it FAILS, then revert. Assert the actual value/shape the Drift-if names — not a surface string that survives the break. Example: assert the orientation equals "vertical"/"horizontal", not merely that the label startsWith "Layout: " (that passes even when the value becomes undefined).

6. Gate and commit.
   - Run `./.fork/verify.sh`. Full (no flag) installs + builds + tests the whole repo AND runs every entry's Verify — the default. Use `--registry` (merge=ours backstop + every entry's Verify, no install/build) when the full toolchain can't run cleanly in your environment — e.g. the kit's generic stack detection in verify.sh doesn't fit your package manager or script names. `--registry` is the part that proves YOUR customizations survived; when you fall back to it, also run the repo's OWN checks directly (its package.json scripts, etc.) so the build is still covered.
   - This skill's final step IS the commit: invoking the skill authorizes it. Commit your code and the entry TOGETHER in one commit with the `custom:` prefix (same commit, so `git revert <sha>` removes the customization cleanly and the set can be replayed onto fresh upstream). The commit-msg hook warns (never blocks) when a commit changes a registrable file without updating .fork/CHANGES.md.

Re-run ./.fork/audit.sh and ./.fork/verify.sh AFTER committing (audit reads committed history). The registry is now accurate and every entry passes. Audit flags any committed non-toolkit file no anchor covers, so every file your fork added needs an anchor — code, data, AND generated output (a committed `models.json`), AND the changelog you touched — or it is reported UNREGISTERED. For a generated file, anchor BOTH its source (the curated list it is built from) and the generated file itself. A clean audit is the side effect of a truthful entry, never the goal — a rubber-stamped Verify (prose, or manual: slapped on silent breakage) weakens the gate for every future port.

Report what changed, why, files touched, checks run, and any risks.

## Quick reference — format & gotchas (so you never need to read the scripts)

- Heading: `## custom: <slug>` (non-empty slug). The `custom:` here is the registry convention; the `custom:` in step 6 is the commit-message prefix — same token, different place.
- Touches/Symbols split on `;` AND `,`. Anchors are tracked paths (globs that match a tracked file are OK) — never prose or parenthetical notes; a comma inside one fragments it. Symbols use `name@path`.
- Symbols WITHOUT Drift-if is valid. A Drift-if REQUIRES a runnable, proven tripwire (step 5).
- brief.sh flags an entry by the PATH of its Touches/Symbols anchors, so hot files (e.g. `types.ts`) are noisy.
- audit.sh reads COMMITTED state (`base..HEAD`) — run it AFTER you commit. Every committed non-toolkit file needs an anchor.
- Gate modes: full (install+build+test+Verifies) | `--registry` (Verifies + backstop only, no build) | `--fast` (typecheck only).
