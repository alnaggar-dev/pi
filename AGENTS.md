# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root: `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` named `<issue-number>-<short-slug>.test.ts`.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing pi Interactive Mode with tmux

Run the TUI in a controlled terminal (from the repo root):

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p     # capture after startup
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t pi-test
```

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi-mono/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/earendil-works/pi-mono/pull/456) by [@username](https://github.com/username))`

## Releasing

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

1. **Update CHANGELOGs**: ask the user whether they ran the `/cl` prompt on the latest commit on `main`. If not, they must run `/cl` first to audit and update each package's `[Unreleased]` section before releasing.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/pi-local-release/node/pi --help
   /tmp/pi-local-release/node/pi --version
   /tmp/pi-local-release/node/pi --list-models
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"
   /tmp/pi-local-release/node/pi

   # Bun binary smoke tests
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   Verify both Node and Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. The bare commands `/tmp/pi-local-release/node/pi` and `/tmp/pi-local-release/bun/pi` start interactive mode; run each in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.

3. **Run the release script**:
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
   ```
   Use `npm_config_min_release_age=0` only for the release command. The repo's normal npm age gate can otherwise block the release lockfile refresh when the current workspace package version was published recently. Review any lockfile or shrinkwrap diffs the release creates before push.

   The release script bumps all package versions, updates changelogs, regenerates release artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `## [Unreleased]` changelog sections, commits `Add [Unreleased] section for next cycle`, then pushes `main` and the tag. Do not rerun the release script after a tag was pushed.

4. **CI publishes npm packages**: pushing the `vX.Y.Z` tag triggers `.github/workflows/build-binaries.yml`. The `publish-npm` job uses npm trusted publishing through GitHub Actions OIDC with environment `npm-publish`; no local `npm publish`, `npm whoami`, OTP, or WebAuthn flow is required.

5. **If CI publish fails**: inspect the failed `publish-npm` job. The publish helper is idempotent and skips package versions already present on npm, so rerun the tag workflow after fixing CI or transient npm issues. Do not rerun `npm run release:patch` or `npm run release:minor` for the same version.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.

<!-- BEGIN fork-flow:memory — managed block; re-run the kit installer to update. Keep your own notes OUTSIDE these markers (they are overwritten on update). -->
# Fork Maintenance

This repo is a **personal fork**. Your customizations live on `custom/main` and must survive upstream changes. You never merge upstream — you integrate it **one commit at a time**, porting each upstream commit onto your fork, tracked by `.fork/UPSTREAM` (the SHA of the last upstream commit you ported). Three skills drive the work: **`fork-change`** (register a customization), **`upstream-port`** (port upstream), **`propose-upstream`** (send a change to the author). Read `.fork/CHANGES.md` before changing code or porting.

## Hard rules

- **Never `git pull upstream` or `git merge upstream`.** Fetch, inspect each commit, then **port** it with `./.fork/port.sh` — it cherry-picks `-x --no-commit`, advances `.fork/UPSTREAM` in the *same* commit, and writes a `Fork-Flow-Port: <sha>` trailer (that trailer, not the staged pointer, is what the gate and `audit.sh` trust). Don't hand-roll the cherry-pick.
- **Lowest-risk integration point wins:** upstream extension point > net-new file you own > small in-place edit > `merge=ours` whole-file override (last resort — it hides upstream changes, including security fixes). This is the one choice you make *while* coding.
- **Register every customization** in `.fork/CHANGES.md`, in the *same* `custom:` commit (the `commit-msg` hook warns, never blocks, if you forget).
- **`./.fork/verify.sh` is the gate.** It builds/tests and runs every registry entry's `Verify`, proving your customizations survived; the `pre-commit` hook runs it (`--registry`) on any commit that integrates upstream (bypass: `--no-verify`).
- **Port small and often** (stop at release tags), and **prune** with `./.fork/audit.sh` — the cheapest customization is one you can delete.

## Adding a customization → run the `fork-change` skill

Code the change first, at the lowest-risk integration point (above). Then run `fork-change` before committing: it reads your diff, drafts the `.fork/CHANGES.md` entry, and runs the gate. Commit code and entry together in one `custom:` commit.

## Porting from upstream → run the `upstream-port` skill

Run `upstream-port` (driven by `./.fork/port.sh`). Once on a fresh fork: `./.fork/port.sh init <sha> [ref]`. Then `./.fork/port.sh next` ports the oldest unported commit; on conflict it stops — inspect with `./.fork/conflict-context.sh <sha> <file>`, re-apply your customization onto upstream's new code, `git add`, then `./.fork/port.sh continue` (or `abort`). Never silently take upstream and drop a custom behavior. Undo the newest port with `./.fork/port.sh revert` — it rewinds `.fork/UPSTREAM` and re-runs the gate, and `next` can re-port later. `./.fork/audit.sh` shows the unported backlog and pointer health.

## Proposing a change upstream → run the `propose-upstream` skill

When a customization is worth contributing, mark its entry `Status: proposed-upstream` and run `propose-upstream`. It cherry-picks only that customization's commit(s) onto `upstream/main` — **never merge `custom/main` into a PR**, which drags every other customization into the author's history — strips fork-flow bookkeeping, verifies in isolation, and opens the PR. Keep the entry `proposed-upstream` until upstream merges it; then retire it at the next port.

## Registry — `.fork/CHANGES.md` (one entry per customization)

Each entry starts with `## custom: <slug>` (exactly two `#`, a space, a non-empty slug — `verify.sh` fails the gate on a malformed heading so a typo can't drop the next entry's `Verify`). Fields:

- **Reason** — one sentence: why it exists.
- **Touches** — tracked file paths it depends on; `;`-separated (the field also splits on `,`, so keep prose/parenthetical notes out of it), grep-friendly.
- **Verify** — a command, or `manual: <what to look at>` (`verify.sh` runs the non-`manual:` ones; unmarked prose runs and fails).
- **Symbols** — `name@path`; add only when a same-signature upstream change could break you *silently* (derive with `lsp references`, or `search` if no language server). Symbols without a `Drift-if` is valid when no honest runtime tripwire exists.
- **Drift-if** — the condition that would silently break it; when present, `Verify` MUST be a runnable tripwire.
- **Status** — optional (`proposed-upstream` / `superseded`) so `audit.sh` reminds you to retire it.

## Layout

```
custom/main         your daily branch          custom/<slug>      larger change, squash-merged
upstream/main       read-only upstream mirror   pr/<slug>          clean PR branch off upstream/main

.fork/UPSTREAM             pointer: "<sha> <ref>" of the last upstream commit you ported
.fork/port.sh              the PORT driver: init | list | next | one | revert | continue | abort | status
.fork/CHANGES.md           registry (Reason, Touches, Verify, Symbols, Drift-if, Status)
.fork/PORTS.md             per-port journal
.fork/verify.sh            the gate — --fast | --registry | full (runs every Verify)
.fork/brief.sh             per-commit risk briefing (rename/delete/glob-aware)
.fork/conflict-context.sh  per-file conflict hunks + the upstream commit being ported
.fork/audit.sh             health: fork delta, orphans, unregistered, drop candidates, unported backlog, pointer consistency
.fork/hooks/               commit-msg reminder + integration gate (pre-commit, pre-merge-commit)
.gitattributes             merge=ours overrides (last resort) + mergiraf syntax-aware merge (ON by default)
```

Per-clone setup is one-time and not carried by copied files: run `install.sh --setup` (git config — including the `mergiraf` merge driver — + `gh` fork/remotes + `custom/main`), then set the pointer once with `./.fork/port.sh init <upstream-sha> upstream/<default-branch>`. The `merge=mergiraf` lines in `.gitattributes` are active. When the binary is missing, setup configures Git's normal text merge as a safe fallback; install it (`cargo install mergiraf` / `brew install mergiraf`) and re-run setup to activate syntax-aware merges.
<!-- END fork-flow:memory -->
