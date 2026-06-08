# Fork Customization Registry

A short map of your customizations. One entry per customization, not per commit.

Each entry is a `## custom: <slug>` heading followed by fields:

- **Reason** — why it exists (one sentence).
- **Touches** — tracked file paths this customization depends on, `;`-separated and grep-friendly (the field also splits on `,`, so keep prose out of it).
- **Symbols** — exact upstream symbols in `name@path` form. Add only when a same-signature behavior change could silently break you.
- **Drift-if** — the concrete condition that would silently break the customization.
- **Verify** — a command, or a human check written as `manual: <what to look at>`. `./.fork/verify.sh` runs the `Verify` of **every** entry: anything not marked `manual:` is run as a command (non-zero fails the gate); a `manual:` check is listed for you to confirm by hand. If the entry has a `Drift-if`, the `Verify` MUST be a runnable command (manual/missing is a hard error). Prove it: make the `Drift-if` true once and confirm the command fails, and assert the value the `Drift-if` names (not a surface string that survives the break).
- **Status** — optional; defaults to `carry`. Set to `proposed-upstream` or `superseded` when a customization is on its way out, so `./.fork/audit.sh` reminds you to retire it.

Keep simple entries simple; add `Symbols`/`Drift-if` only when upstream behavior can silently change. See your agent memory (`CLAUDE.md` or `AGENTS.md`), Fork Maintenance section, for templates and the full workflow. The toolkit reads this file: `./.fork/brief.sh` flags entries whose `Touches`/`Symbols` paths are in an incoming upstream commit; `./.fork/verify.sh` runs the `Verify` of every entry (the integration gate runs it on every port); `./.fork/audit.sh` flags orphaned, unregistered, or retired customizations and checks the `.fork/UPSTREAM` pointer; `./.fork/port.sh` integrates upstream commit-by-commit.

---

_No customizations registered yet._
