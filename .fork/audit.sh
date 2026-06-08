#!/usr/bin/env bash
# .fork/audit.sh — periodic fork-health check (see Fork Maintenance in your CLAUDE.md/AGENTS.md).
#
#   ./.fork/audit.sh [upstream-ref]      (default: upstream/main)
#
# A commit-by-commit fork never replays your patches, so nothing naturally tells you
# a customization has gone stale. This surfaces five things and decides nothing:
#   0. fork delta: how many existing upstream files you edit -> conflict surface
#   1. registry anchors (Touches/Symbols paths) that no longer exist -> orphaned
#   2. files your fork's own commits changed that no entry registers  -> unregistered
#   3. each entry's Status: + a DROP CANDIDATES list             -> retirement view
#   4. upstream commits since .fork/UPSTREAM you have NOT ported    -> your backlog
# Scope: the base is the .fork/UPSTREAM pointer (the last ported upstream commit),
# falling back to merge-base(HEAD, upstream) on a fork that hasn't ported yet. 0
# looks at edits since that base; 2 looks at your own (non-port) commits in
# base..HEAD; 4 looks at upstream commits after the pointer.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Shared parsing/matching helpers (split_field, symbol_path, glob_match,
# registry_paths, …) — one copy for all scripts, see .fork/lib.sh.
# shellcheck source=/dev/null
. .fork/lib.sh

upstream="${1:-upstream/main}"
git rev-parse --verify --quiet "${upstream}^{commit}" >/dev/null ||
	{
		echo "error: not a commit: $upstream (add the upstream remote and fetch?)" >&2
		exit 2
	}
# Base = the last ported upstream commit (.fork/UPSTREAM), or merge-base as a fallback
# on a not-yet-ported fork. A NON-EMPTY pointer that does not resolve is a HARD ERROR
# (upstream_base exits 3) — we propagate it rather than audit against a lie.
base="$(upstream_base "$upstream")" || exit $?

# --- pointer consistency (is the pointer telling the truth?) -----------------
# The pointer REPLACES merge ancestry, so its honesty is load-bearing. Surface (decide
# nothing) when it looks wrong: not an ancestor of the target upstream (a force-push or
# the wrong line), a retarget (you passed a different --upstream than was recorded),
# the NEWEST reachable port trailer disagreeing with the pointer file, a NON-port commit
# that changed the pointer SHA, or an out-of-line port history (a later port UNRELATED to
# an earlier one; a strictly-backward move is already refused at port time, so only an
# unrelated port surfaces here).
changes=".fork/CHANGES.md"
printf '== fork audit vs %s (base %s) ==\n' "$upstream" "$(git rev-parse --short "$base")"
kv="$(kit_version)"
if [ -n "$kv" ]; then
	printf 'kit: fork-flow v%s  (run the kit installer --check to compare, --update to refresh)\n' "$kv"
else
	printf 'kit: fork-flow unversioned  (re-run the kit installer to stamp .fork/VERSION + adopt managed blocks)\n'
fi

ptr="$(upstream_pointer)"
ptr_ref="$(upstream_pointer_ref)"
printf '\n== pointer consistency (.fork/UPSTREAM honesty) ==\n'
if [ -z "$ptr" ]; then
	printf '  (no pointer set yet — base is merge-base(HEAD, %s))\n' "$upstream"
else
	printf '  pointer: %s (recorded ref: %s)\n' "$(git rev-parse --short "$ptr")" "${ptr_ref:-none}"
	if [ -n "$ptr_ref" ] && [ "$ptr_ref" != "$upstream" ]; then
		printf '  RETARGET: recorded ref %s != audited ref %s (backlog/below may mislead)\n' "$ptr_ref" "$upstream"
	fi
	if git merge-base --is-ancestor "$ptr" "$upstream" 2>/dev/null; then
		printf '  OK: pointer is an ancestor of %s\n' "$upstream"
	else
		printf '  WARNING: pointer is NOT an ancestor of %s — force-push or wrong branch?\n' "$upstream"
	fi
	# Newest IN-EFFECT port trailer (anywhere reachable from HEAD, not just HEAD) vs the
	# pointer file. After a port you usually add custom commits, so HEAD is typically NOT a
	# port; checking only HEAD would let an ordinary commit advance .fork/UPSTREAM to a
	# bogus SHA unseen. A `port.sh revert` (Fork-Flow-Unport) rewinds the pointer, so the
	# reverted port's trailer is STALE and must be skipped. Walk newest-first: an Unport(X)
	# cancels the next OLDER Port(X) we meet (re-port, being newer, is seen first and wins);
	# the first port/init trailer NOT so cancelled is in effect and must name the pointer.
	newest_port=""
	newest_tr=""
	pending="" # SHAs of unports awaiting their (older) matching port, newline-separated
	while IFS= read -r sha; do
		[ -z "$sha" ] && continue
		ut="$(unport_trailer_sha "$sha")"
		if [ -n "$ut" ]; then
			ut="$(git rev-parse "$ut" 2>/dev/null || printf '%s' "$ut")"
			pending="${pending:+$pending
}$ut"
			continue
		fi
		pt="$(port_trailer_sha "$sha")"
		[ -z "$pt" ] && continue
		pt="$(git rev-parse "$pt" 2>/dev/null || printf '%s' "$pt")"
		if printf '%s\n' "$pending" | grep -Fxq "$pt"; then
			# this port was reverted by a (newer) unport — drop one pending and skip it
			pending="$(printf '%s\n' "$pending" | grep -vFx "$pt" || true)"
			continue
		fi
		newest_port="$sha"
		newest_tr="$pt"
		break
	done < <(git log --format='%H' HEAD 2>/dev/null || true)
	if [ -z "$newest_port" ]; then
		printf '  WARNING: pointer is set but NO reachable IN-EFFECT %s trailer — hand-edited?\n' "$PORT_TRAILER"
	elif [ "$(git rev-parse "$newest_tr" 2>/dev/null)" != "$(git rev-parse "$ptr" 2>/dev/null)" ]; then
		printf '  WARNING: newest port trailer (%s in %s) != pointer file (%s) — .fork/UPSTREAM edited after the last port?\n' "$(git rev-parse --short "$newest_tr")" "$(git rev-parse --short "$newest_port")" "$(git rev-parse --short "$ptr")"
	fi
	# Consecutive ports should stay on the same upstream line. A strictly-backward move
	# is already refused at port time (port.sh assert_forward), so here we flag only a
	# port UNRELATED to the previous one (neither is an ancestor of the other) — e.g.
	# hand-edited history or a cross-branch port. Report the first such inversion only.
	prev=""
	while IFS= read -r sha; do
		[ -z "$sha" ] && continue
		tr="$(port_trailer_sha "$sha")"
		[ -z "$tr" ] && continue
		if [ -n "$prev" ] && ! git merge-base --is-ancestor "$tr" "$prev" 2>/dev/null &&
			! git merge-base --is-ancestor "$prev" "$tr" 2>/dev/null; then
			printf '  WARNING: port order looks inconsistent near %s (unrelated to previous port)\n' "$(git rev-parse --short "$tr")"
			break
		fi
		prev="$tr"
	done < <(git log --no-merges --reverse --format='%H' "$ptr..HEAD" 2>/dev/null || true)
	# Tampering: a NON-port, NON-unport commit that actually CHANGED the pointer SHA. The
	# pointer may only move inside a Fork-Flow-Port[-Init] commit (forward) or a
	# Fork-Flow-Unport commit (a `port.sh revert`, backward); compare each pointer-touching
	# commit's SHA before/after so the kit-install commit (adds a comments-only pointer) and
	# comment-only header edits are NOT flagged — only a real SHA change carried by no trailer.
	edited=""
	while IFS= read -r sha; do
		[ -z "$sha" ] && continue
		{ is_upstream_port_commit "$sha" || is_upstream_unport_commit "$sha"; } && continue
		bsha="$(git show "$sha^:.fork/UPSTREAM" 2>/dev/null | awk 'NF && $1!~/^#/{print $1; exit}')" || true
		asha="$(git show "$sha:.fork/UPSTREAM" 2>/dev/null | awk 'NF && $1!~/^#/{print $1; exit}')" || true
		[ "$bsha" = "$asha" ] && continue
		edited="${edited:+$edited
}$sha"
	done < <(git log --format='%H' -- .fork/UPSTREAM 2>/dev/null || true)
	if [ -n "$edited" ]; then
		printf '  WARNING: .fork/UPSTREAM SHA changed by NON-port commit(s) (no %s trailer):\n' "$PORT_TRAILER"
		printf '%s\n' "$edited" | while IFS= read -r e; do
			[ -z "$e" ] && continue
			printf '    %s  %s\n' "$(git rev-parse --short "$e")" "$(git log -1 --format=%s "$e")"
		done
	fi
fi

# registry_paths (every Touches token + each Symbols name@path, de-duplicated)
# now lives in .fork/lib.sh; pass it "$changes" so this script has one source of
# truth for the registry path (also consumed by the Status section below).

# 0. fork delta (your conflict surface) ---------------------------------------
# Edits to files that already existed at the merge-base are what CAUSE future
# conflicts; brand-new files you own are nearly free. Watch this number shrink.
printf '\n== fork delta (edits to existing upstream files = your conflict surface) ==\n'
delta="$(git diff --diff-filter=M --shortstat "$base..HEAD" 2>/dev/null || true)"
if [ -n "$delta" ]; then
	printf '  %s\n' "${delta#"${delta%%[![:space:]]*}"}"
else
	printf '  (no modified upstream files — all your changes are additions; lowest-conflict footprint)\n'
fi

# 1. orphaned anchors ---------------------------------------------------------
printf '\n== orphaned anchors (registry path no longer tracked) ==\n'
orphan=0
while IFS= read -r p; do
	[ -z "$p" ] && continue
	git ls-files --error-unmatch -- "$p" >/dev/null 2>&1 ||
		{
			printf '  MISSING: %s\n' "$p"
			orphan=1
		}
done < <(registry_paths "$changes")
[ "$orphan" -eq 0 ] && printf '  (all anchors still present)\n'

# 2. unregistered changes -----------------------------------------------------
# Files changed by YOUR commits in "$base..HEAD" that no registry anchor covers.
# We must exclude PORT commits (a port carries upstream's files, not your
# customizations) AND UNPORT commits (a `port.sh revert` carries the upstream churn it
# reverses, not your work) — so we walk each non-merge commit and skip the ones
# is_upstream_port_commit / is_upstream_unport_commit recognize (strict Fork-Flow-Port
# [-Init] / Fork-Flow-Unport trailers — trailer-only, so a stray staged pointer is NOT
# taken for a port), then collect the files the rest changed.
# This replaces the old `upstream..HEAD` reachability trick, which assumed merge
# ancestry the commit-by-commit flow no longer has. No reliance on the `custom:`
# prefix; the commit-msg hook stays a reminder.
printf '\n== files your fork changed but NOT in any Touches/Symbols (registry gaps) ==\n'
reg="$(registry_paths "$changes")"
mine="$(
	git log --no-merges --format='%H' "$base..HEAD" | while IFS= read -r sha; do
		[ -z "$sha" ] && continue
		if is_upstream_port_commit "$sha" || is_upstream_unport_commit "$sha"; then continue; fi
		git diff-tree --no-commit-id --name-only -r "$sha"
	done | awk 'NF && !seen[$0]++'
)"
unreg=0
while IFS= read -r f; do
	[ -z "$f" ] && continue
	toolkit_path "$f" && continue
	path_registered "$f" "$reg" && continue
	printf '  UNREGISTERED: %s\n' "$f"
	unreg=1
done <<EOF
$mine
EOF
[ "$unreg" -eq 0 ] && printf '  (every changed file is registered)\n'
[ "$unreg" -ne 0 ] && printf '  -> register these with the fork-change skill, or delete them\n'

# 3. status + drop candidates -------------------------------------------------
printf '\n== customization status (retire superseded / upstreamed ones) ==\n'
drops=""
emit_status() { # reads $sheading/$sstatus; prints status line; appends to $drops
	local norm
	[ -z "$sheading" ] && return 0
	printf '  [%s] %s\n' "${sstatus:-carry?}" "$sheading"
	sany=1
	# Match WHOLE status tokens, not substrings: a glob like *upstreamed* wrongly
	# caught "not-upstreamed" / "to-be-upstreamed" (the OPPOSITE of a drop). Normalize
	# in awk (no `tr` — keeps the git/awk/grep-only invariant): lower-case, collapse
	# every run of non-alphanumeric/non-hyphen to one space (so "upstreamed." and
	# "superseded, see #123" still tokenize), keep hyphens so "proposed-upstream" stays
	# one token, and pad with spaces so each pattern matches a complete token.
	norm="$(printf '%s' "$sstatus" | awk '{s=tolower($0); gsub(/[^a-z0-9-]+/," ",s); print " " s " "}')"
	case "$norm" in
	*" superseded "* | *" upstreamed "* | *" proposed-upstream "* | *" applied-upstream "*)
		drops="${drops:+$drops
}$sheading"
		;;
	esac
}
if [ ! -f "$changes" ]; then
	printf '  (no %s)\n' "$changes"
else
	sheading=""
	sstatus=""
	sany=0
	while IFS= read -r line || [ -n "$line" ]; do
		case "$line" in
		"## "*)
			emit_status
			sheading="${line#"## "}"
			sstatus=""
			;;
		[Ss]tatus:*)
			sstatus="${line#*:}"
			sstatus="${sstatus# }"
			;;
		esac
	done <"$changes"
	emit_status
	[ "$sany" -eq 0 ] && printf '  (no entries)\n'
fi
if [ -n "$drops" ]; then
	printf '\n== DROP CANDIDATES (Status says on the way out — delete to shrink the fork) ==\n'
	printf '%s\n' "$drops" | while IFS= read -r d; do [ -n "$d" ] && printf '  DROP: %s\n' "$d"; done
fi

# 4. unported upstream backlog ------------------------------------------------
# Upstream commits AFTER the .fork/UPSTREAM pointer that you have not ported yet —
# your integration backlog, in oldest-first order (the order upstream-port applies
# them). With no pointer set, base is the merge-base, so this still lists upstream's
# commits since you diverged. A range-diff of your commits vs upstream is meaningless
# without merge ancestry, so it is replaced by this concrete to-port list.
printf '\n== unported upstream commits (base..%s — your port backlog, oldest first) ==\n' "$upstream"
backlog="$(git log --no-merges --reverse --format='  %h  %s' "$base..$upstream" 2>/dev/null || true)"
if [ -n "$backlog" ]; then
	printf '%s\n' "$backlog"
	n="$(printf '%s\n' "$backlog" | grep -c .)"
	printf '  -> %s commit(s) to port via the upstream-port skill\n' "$n"
else
	printf '  (up to date — nothing upstream past the pointer)\n'
fi
merges="$(git log --merges --format='  %h  %s' "$base..$upstream" 2>/dev/null || true)"
[ -n "$merges" ] && {
	printf '\n  note: upstream merge commits in range (port their content, not the merge):\n'
	printf '%s\n' "$merges"
}

# 5. maybe reimplemented upstream (patch-id) ----------------------------------
# The old merge flow had a range-diff hint for "did upstream re-implement my change?"
# A commit-by-commit fork has no merge ancestry for range-diff, but git patch-id still
# matches an equivalent diff regardless of SHA/parentage. We compute the patch-id of
# every UPSTREAM commit in base..upstream, then flag any of YOUR non-port commits whose
# patch-id collides — a strong "upstream now ships this; consider retiring it" signal.
# CAVEAT: patch-id matches only a near-identical diff; a re-expressed customization
# will NOT match, so a clean result here does NOT prove upstream lacks your feature.
printf '\n== possibly reimplemented upstream (patch-id matches; caveated) ==\n'
# Map of upstream patch-id -> short sha+subject, built once.
up_ids="$(
	git log --no-merges --format='%H' "$base..$upstream" 2>/dev/null | while IFS= read -r sha; do
		[ -z "$sha" ] && continue
		pid="$(git show "$sha" 2>/dev/null | git patch-id --stable 2>/dev/null | awk '{print $1}')"
		if [ -n "$pid" ]; then printf '%s %s %s\n' "$pid" "$(git rev-parse --short "$sha")" "$(git log -1 --format=%s "$sha")"; fi
	done
)"
hits=0
if [ -n "$up_ids" ]; then
	while IFS= read -r sha; do
		[ -z "$sha" ] && continue
		is_upstream_port_commit "$sha" && continue # skip ports: those ARE upstream's commits
		mypid="$(git show "$sha" 2>/dev/null | git patch-id --stable 2>/dev/null | awk '{print $1}')"
		[ -z "$mypid" ] && continue
		match="$(printf '%s\n' "$up_ids" | awk -v id="$mypid" '$1==id {sub(/^[^ ]+ /,""); print; exit}')"
		if [ -n "$match" ]; then
			printf '  %s "%s"  ==  upstream %s\n' "$(git rev-parse --short "$sha")" "$(git log -1 --format=%s "$sha")" "$match"
			hits=1
		fi
	done < <(git log --no-merges --format='%H' "$base..HEAD" 2>/dev/null || true)
fi
[ "$hits" -eq 0 ] && printf '  (no exact patch-id matches — NOTE: a re-expressed change will not match)\n'

exit 0
