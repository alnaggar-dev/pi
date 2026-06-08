---
name: propose-upstream
description: Send a fork customization to the original author as a clean PR branch — cherry-pick it onto upstream's code without dragging in your other fork changes.
---

You are working on a personal fork. Follow the Fork Maintenance section of your agent memory (CLAUDE.md or AGENTS.md), Proposing a change upstream. This skill promotes a change that already lives on custom/main into a clean pull-request branch off the upstream mirror, so the author sees only that one change on top of their own code — never the rest of your fork.

Refuse to start if the working tree is dirty.

Hard rule: NEVER merge custom/main (or a branch built on it) into a PR branch. That would carry every fork customization into the author's history. Promotion is always a cherry-pick of only the relevant commits onto the clean upstream mirror (upstream/main) — there is no local clean `main` in this workflow.

Verify the change isn't already upstream before starting: `git fetch upstream`, then refuse only if the entry's `Status` is `superseded`, `upstreamed`, or `applied-upstream` (upstream already has it — nothing to propose). `Status: proposed-upstream` is expected and allowed: it intentionally makes `./.fork/audit.sh` list the entry as a DROP CANDIDATE, so that listing is NOT a reason to stop.

Pick the change:
- If the user names a slug, use that entry in .fork/CHANGES.md.
- Otherwise read .fork/CHANGES.md and take entries with `Status: proposed-upstream`; if there are several, list them and ask which one (one PR branch per customization).
- Refuse with a clear message if no candidate is found — tell the user to mark the entry `Status: proposed-upstream` first, or name a slug.

Find the commits:
- From the chosen entry's `Touches`/`Symbols` paths, find the fork commit(s) that implemented it — scope to your own commits only: `git log --no-merges --reverse upstream/main..custom/main -- <paths>` (`--reverse` gives cherry-pick order; `upstream/main..custom/main` excludes upstream's own history). This range also contains upstream PORT commits (the upstream-port skill / port.sh applies upstream commits onto custom/main) and `port.sh revert` (unport) commits — exclude any whose message carries a `Fork-Flow-Port:` / `Fork-Flow-Port-Init:` trailer (a port) or a `Fork-Flow-Unport:` trailer (an undone port); those are upstream's changes or port-undos, not your customization. (Those trailers are the single, reliable markers — don't rely on a stray `.fork/UPSTREAM` edit.) A pathspec does not follow renames (`--follow` can't take multiple paths), so if a file was renamed since the customization landed, widen the paths or inspect history by hand. Confirm the set with the user before copying — one customization can span more than one commit.
- These commits must be the customization ONLY. If a commit also contains unrelated fork changes, do not cherry-pick it whole — stop and tell the user it needs splitting first (the change wasn't kept to "the smallest reasonable change").

Build the PR branch:
- Branch off clean upstream: `git checkout -b pr/<slug> upstream/main` (default upstream ref is upstream/main; ask if the fork tracks a different branch). If `pr/<slug>` already exists, you are iterating on an in-flight PR after review feedback — reset it onto fresh upstream instead (`git checkout -B pr/<slug> upstream/main`) and plan to re-push with `--force-with-lease` (below).
- Cherry-pick the commit(s) in order with `git cherry-pick --no-commit <sha>` (run it once per SHA, in order) so you can clean the tree BEFORE committing (avoids a messy amend later) and land one clean upstream-appropriate PR commit — unless the user explicitly wants the individual commits preserved. On conflict, resolve toward upstream's current code (the author wants the change re-expressed on THEIR latest code, not your fork's surroundings); never resolve by pulling in other fork files.
- Before committing, exclude ALL fork-flow bookkeeping from the staged tree — it is fork-only, not the author's concern: `.fork/`, `.fork-flow/`, `.claude/skills/`, `.pi/skills/`, the Fork Maintenance section of the memory file (CLAUDE.md/AGENTS.md), and kit `.gitattributes` changes. For net-new paths that don't exist upstream (`.fork/`, `.fork-flow/`, `.claude/skills/`, `.pi/skills/`), either `git rm --cached <path>` or `git restore --staged --worktree --source upstream/main -- <path>` works. For paths that DO exist upstream (the memory file, `.gitattributes`), use `git restore --staged --worktree --source upstream/main -- <path>` to reset them to upstream's content — never `git rm`, which would delete the whole file from the PR. You cannot surgically drop just the appended memory section; reset the file to upstream's version. Then commit the cleaned change with an upstream-appropriate message: do NOT reuse the `custom:` prefix, and do NOT mention `.fork/CHANGES.md`, the registry, or fork bookkeeping — that wording is meaningless to the author. Describe the change as the author's project would.

Verify, push, and open the PR:
- Build/test the change in isolation on the PR branch so the author gets something that stands on its own.
- `git push -u origin pr/<slug>` (first push). If you are updating an in-flight PR branch that already exists on the remote, use `git push --force-with-lease origin pr/<slug>` instead — the open PR updates in place, no new PR needed.
- Draft the PR title and body for the AUTHOR's project (not your fork): a clear title and a body covering what changed, why, and how it was verified. Use upstream-appropriate wording — no `custom:` prefix, no `.fork/CHANGES.md`/registry mentions. Show the draft to the user before opening.
- Open the PR against upstream with the GitHub CLI. Write the body to a temp file (multiline-safe), then: `gh pr create --repo <upstream-owner>/<repo> --base <base-branch> --head <origin-owner>:pr/<slug> --title "<title>" --body-file <body-file>`. Derive `<upstream-owner>/<repo>` and `<base-branch>` from the `upstream` remote, and `<origin-owner>` from the `origin` remote — the `<origin-owner>:` head prefix is required because the branch lives in your fork, not upstream. Print the PR URL that `gh` returns.

Close the loop on custom/main:
- Switch back: `git switch custom/main` (you are on `pr/<slug>` after the push). The skill must end on `custom/main`, never leave the user on the PR branch.
- Make sure the entry in .fork/CHANGES.md is marked `Status: proposed-upstream` (set it if missing) so ./.fork/audit.sh keeps reminding you to retire the customization once the author accepts it. Commit this on custom/main, not on the PR branch.
- Remind the user: when the PR is merged upstream, drop the local customization during the next `upstream-port` (audit.sh lists it as a DROP CANDIDATE, and the upstream commit that merged your PR will come through the normal port flow) — the change then flows back in through upstream.

Report: which customization, the commits cherry-picked, the PR branch name and push result, any conflicts resolved during cherry-pick, bookkeeping paths excluded, isolated verification result, the opened PR's URL, and the Status/CHANGES.md update on custom/main.
