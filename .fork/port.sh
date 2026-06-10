#!/usr/bin/env bash
# .fork/port.sh — the upstream PORT driver (see Fork Maintenance in your CLAUDE.md/AGENTS.md).
#
#   ./.fork/port.sh init <upstream-sha> [upstream-ref]   set the FIRST pointer (no cherry-pick)
#   ./.fork/port.sh list [upstream-ref]                  the unported backlog, oldest first
#   ./.fork/port.sh next [upstream-ref]                  port the OLDEST unported commit
#   ./.fork/port.sh one <sha> [upstream-ref]             port a specific upstream commit (must be the next unported one)
#   ./.fork/port.sh revert [<sha>]                       un-port the NEWEST port (rewinds the pointer, gated)
#   ./.fork/port.sh continue                             finalize a paused port/unport after resolving conflicts
#   ./.fork/port.sh abort                                throw away an in-progress port/unport
#   ./.fork/port.sh status                               show in-progress state
#
# This is the one place the porting INVARIANTS are enforced as code, not skill prose:
#   - every port is `git cherry-pick -x --no-commit` (a clean port stays a real commit
#     that the integration gate can see — a bare cherry-pick of a clean commit runs NO
#     hook);
#   - the pointer advances in the SAME commit, recorded as `<sha> <ref>` in .fork/UPSTREAM;
#   - the commit carries a strict `Fork-Flow-Port: <full-sha>` trailer (the SOLE signal
#     audit/propose-upstream use to tell a port from your own work — a stray pointer in
#     an ordinary commit is NOT a port);
#   - the pointer only ever moves FORWARD (the new sha must have the old pointer as an
#     ancestor on the upstream line), so it can't silently rewind;
#   - ports are CONTIGUOUS: only the OLDEST unported commit may be ported (`one <sha>`
#     refuses a later one), so the pointer can't jump PAST unported ancestors and bury
#     them from the backlog/audit;
#   - the backlog walks upstream's FIRST-PARENT line; a MERGE commit on it is ported as
#     its first-parent net effect (cherry-pick -m 1 — exactly what landed on the upstream
#     mainline, conflict resolutions included). Side-branch commits are never ported
#     directly: their branch points may predate the pointer, which forward-only refuses;
#   - on conflict it STOPS and points you at conflict-context.sh, then `continue`.
# The actual gate (verify.sh --registry) still runs in the pre-commit hook on the final
# commit; this driver just makes the mechanics correct and hard to get wrong.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# shellcheck source=/dev/null
. .fork/lib.sh

state="$(git rev-parse --git-path fork-flow-port 2>/dev/null)"
unport_state="$(git rev-parse --git-path fork-flow-unport 2>/dev/null)"
changes_file=".fork/UPSTREAM"

die() {
	printf 'port.sh: %s\n' "$*" >&2
	exit 1
}
note() { printf 'port.sh: %s\n' "$*" >&2; }

ptr_ref_default() { upstream_pointer_ref; }

require_clean_tree() {
	if ! git diff --quiet || ! git diff --cached --quiet; then
		die "working tree is dirty — commit or stash first (a port must start clean)"
	fi
}

# Write "<sha> <ref>" to .fork/UPSTREAM, preserving the file's comment header.
write_pointer() { # <full-sha> <ref>
	local sha="$1" ref="$2" tmp
	tmp="$(mktemp)"
	# keep every comment/blank line from the existing header; drop the old SHA line
	if [ -f "$changes_file" ]; then
		awk 'NF==0 || $1 ~ /^#/ {print}' "$changes_file" >"$tmp"
	fi
	printf '%s %s\n' "$sha" "$ref" >>"$tmp"
	mv "$tmp" "$changes_file" || { rm -f "$tmp"; return 1; }
}

# Refuse to move the pointer backwards or sideways: the new commit must be a
# descendant of the current pointer (forward-only on the upstream line).
assert_forward() { # <new-sha>
	local newsha="$1" cur
	cur="$(upstream_pointer)"
	[ -z "$cur" ] && return 0
	[ "$cur" = "$newsha" ] && return 0
	if ! git merge-base --is-ancestor "$cur" "$newsha" 2>/dev/null; then
		die "refusing to move pointer to $newsha: current pointer $cur is not its ancestor
       (that would rewind or sidestep the pointer — port in order, or fix .fork/UPSTREAM)"
	fi
}

resolve_upstream_ref() { # [arg]
	local ref="${1:-}"
	if [ -z "$ref" ]; then ref="$(ptr_ref_default)"; fi
	if [ -z "$ref" ]; then ref="upstream/main"; fi
	git rev-parse --verify --quiet "${ref}^{commit}" >/dev/null 2>&1 ||
		die "not a commit: $ref (fetch upstream, or pass the right ref)"
	printf '%s' "$ref"
}

backlog() { # <upstream-ref>
	local ref="$1" base
	base="$(upstream_base "$ref")" || exit $? # hard-fails (3) on a broken pointer
	# FIRST-PARENT, merges included: the pointer can only ride upstream's mainline.
	# A side-branch commit may branch from BEFORE the pointer (a true-merge PR cut from
	# an older main), so porting it directly would sidestep assert_forward — instead its
	# content arrives when the MERGE that brought it in is ported as -m 1 (start_port).
	git log --first-parent --reverse --format='%H' "$base..$ref"
}

cmd_status() {
	if [ -f "$state" ]; then
		printf 'A port is IN PROGRESS:\n'
		sed 's/^/  /' "$state"
		printf 'Resolve conflicts, then: ./.fork/port.sh continue   (or: ./.fork/port.sh abort)\n'
	elif [ -f "$unport_state" ]; then
		printf 'An UNPORT (revert) is IN PROGRESS:\n'
		sed 's/^/  /' "$unport_state"
		printf 'Resolve conflicts, then: ./.fork/port.sh continue   (or: ./.fork/port.sh abort)\n'
	else
		printf 'No port in progress. Pointer: %s (ref %s)\n' \
			"$(upstream_pointer || echo '(unset)')" "$(upstream_pointer_ref || echo '?')"
	fi
}

cmd_list() {
	local ref list n=0 sha
	ref="$(resolve_upstream_ref "${1:-}")"
	# Capture via command substitution (NOT process substitution): backlog's
	# upstream_base hard-fails (exit 3) on a corrupt pointer, and that must propagate
	# under set -e. A `done < <(backlog …)` would run backlog in a subshell whose exit
	# the parent never sees, so a broken pointer would print "(up to date)" — the exact
	# silent lie the pointer contract forbids (cmd_next already captures this way).
	list="$(backlog "$ref")"
	printf '== unported backlog (%s), first-parent, oldest first ==\n' "$ref"
	while IFS= read -r sha; do
		[ -z "$sha" ] && continue
		local mark=""
		if [ "$(git rev-list --parents -n1 "$sha" | awk '{print NF-1}')" -gt 1 ]; then
			mark=" [merge: $(git rev-list --count --no-merges "$sha^1..$sha") commit(s), ports as -m 1]"
		fi
		printf '  %s  %s%s\n' "$(git rev-parse --short "$sha")" "$(git log -1 --format=%s "$sha")" "$mark"
		n=$((n + 1))
	done <<EOF
$list
EOF
	[ "$n" -eq 0 ] && printf '  (up to date)\n'
	[ "$n" -gt 0 ] && printf '  -> %d to port; run ./.fork/port.sh next\n' "$n"
	return 0 # success regardless of backlog size (corrupt pointer already exited 3 above)
}

cmd_init() {
	local sha="${1:-}" ref="${2:-upstream/main}"
	[ -n "$sha" ] || die "usage: ./.fork/port.sh init <upstream-sha> [upstream-ref]"
	[ -f "$state" ] && die "a port is in progress — finish it (continue/abort) first"
	[ -n "$(upstream_pointer)" ] && die "pointer already set ($(upstream_pointer)); init is one-time only"
	require_clean_tree
	git rev-parse --verify --quiet "${sha}^{commit}" >/dev/null 2>&1 || die "not a commit: $sha"
	sha="$(git rev-parse "$sha")"
	git rev-parse --verify --quiet "${ref}^{commit}" >/dev/null 2>&1 || die "not a commit: $ref"
	# init ports NO code, so it is NOT an integration — commit with --no-verify.
	# Staging .fork/UPSTREAM otherwise trips the pre-commit integration gate, which
	# would block init on an unrelated red/prose Verify even though nothing was ported.
	# Snapshot the pointer file first so a commit that still fails for another reason
	# (e.g. signing) rolls back cleanly, instead of leaving a staged-but-uncommitted
	# pointer that makes the retry die with "pointer already set".
	local snap had=0
	snap="$(mktemp)"
	if [ -f "$changes_file" ]; then
		cp "$changes_file" "$snap"
		had=1
	fi
	# Until the commit lands, restore the snapshot on ANY failure — not just a failed
	# `git commit`. write_pointer or `git add` failing (e.g. a stale .git/index.lock)
	# would otherwise abort under set -e with the pointer already staged/written, so the
	# retry dies with "pointer already set". Track rc explicitly so set -e never
	# short-circuits past the rollback.
	local rc=0
	write_pointer "$sha" "$ref" || rc=$?
	[ "$rc" = 0 ] && { git add "$changes_file" || rc=$?; }
	[ "$rc" = 0 ] && { git commit --no-verify -m "fork-flow: initialize upstream pointer

Records the upstream commit this fork last corresponded to. No code is ported by
this commit; subsequent ports advance the pointer one upstream commit at a time.

$INIT_TRAILER: $sha" || rc=$?; }
	if [ "$rc" != 0 ]; then
		git reset -q -- "$changes_file" >/dev/null 2>&1 || true
		if [ "$had" -eq 1 ]; then cp "$snap" "$changes_file"; else rm -f "$changes_file"; fi
		rm -f "$snap"
		die "init failed (rc $rc) — pointer change rolled back; nothing committed"
	fi
	rm -f "$snap"
	note "pointer initialized at $sha (ref $ref)"
}

# Stage the pointer + the cherry-picked tree and make the final port commit. Shared by
# a clean port and by `continue` after a manual resolve.
finalize() { # <full-sha> <ref>
	local sha="$1" ref="$2" msg subject
	# No unmerged paths may remain.
	if git ls-files --unmerged --error-unmatch -- . >/dev/null 2>&1; then
		git diff --name-only --diff-filter=U | sed 's/^/  /' >&2
		die "unresolved conflicts remain (above) — resolve + 'git add', then ./.fork/port.sh continue"
	fi
	assert_forward "$sha"
	write_pointer "$sha" "$ref"
	git add "$changes_file"
	subject="$(git log -1 --format=%s "$sha")"
	msg="$(printf '%s\n\n%s\n\n(cherry picked from commit %s)\n%s: %s\n' \
		"$subject" "$(git log -1 --format=%b "$sha")" "$sha" "$PORT_TRAILER" "$sha")"
	# The pre-commit integration gate runs verify.sh --registry here (pointer is staged).
	printf '%s' "$msg" | git commit -F -
	rm -f "$state"
	note "ported $sha; pointer now $sha"
}

start_port() { # <full-sha> <ref>
	local sha="$1" ref="$2" parents rc oldest
	[ -f "$state" ] && die "a port is already in progress — continue/abort it first"
	[ "$sha" = "$(upstream_pointer)" ] && die "$sha is already the pointer — nothing to port"
	require_clean_tree
	assert_forward "$sha"
	# A merge commit on the first-parent line is ported as its -m 1 net effect: the
	# exact diff the merge landed on the upstream mainline, conflict resolutions and
	# all. Porting its side-branch commits individually is NOT generally possible —
	# their branch points may predate the pointer, which assert_forward rightly refuses
	# as a sidestep. The pointer lands ON the merge, so everything it brought in leaves
	# the backlog with it.
	parents="$(git rev-list --parents -n1 "$sha" | awk '{print NF-1}')"
	[ "$parents" -gt 1 ] &&
		note "$(git rev-parse --short "$sha") is a merge — porting its first-parent net effect (-m 1, $(git rev-list --count --no-merges "$sha^1..$sha") commit(s))"
	# Contiguity: the pointer means "everything up to here is ported", so a port may not
	# SKIP commits — start_port applies only the OLDEST unported commit on the ref. This is
	# what stops `one <later-sha>` from advancing the pointer PAST unported ancestors (they
	# would vanish from the backlog though never applied). `next` always passes the oldest,
	# so this only ever bites an out-of-order `one`. (Backward/merge SHAs already died above.)
	oldest="$(backlog "$ref" | head -1)"
	if [ "$sha" != "$oldest" ]; then
		[ -z "$oldest" ] && die "$sha is not the next unported commit on $ref (nothing unported there — off-target?)"
		die "refusing to port $sha out of order: the next unported commit on $ref is
       $(git rev-parse --short "$oldest")  $(git log -1 --format=%s "$oldest")
       The pointer is contiguous — port in order with ./.fork/port.sh next (it picks this
       commit), or pass that SHA. To take a single upstream commit early WITHOUT advancing
       the pointer, cherry-pick it as a custom: change instead of porting it."
	fi
	# Record state BEFORE touching the tree so abort/continue always have it.
	printf 'SHA=%s\nREF=%s\n' "$sha" "$ref" >"$state"
	rc=0
	if [ "$parents" -gt 1 ]; then
		git cherry-pick -x -m 1 --no-commit "$sha" || rc=$?
	else
		git cherry-pick -x --no-commit "$sha" || rc=$?
	fi
	if [ "$rc" -ne 0 ]; then
		if git diff --name-only --diff-filter=U | grep -q .; then
			printf '\nport.sh: CONFLICT porting %s. Files:\n' "$(git rev-parse --short "$sha")" >&2
			git diff --name-only --diff-filter=U | sed 's/^/  /' >&2
			printf 'Inspect:  ./.fork/conflict-context.sh %s <file>\n' "$sha" >&2
			printf 'Resolve + git add, then: ./.fork/port.sh continue   (or abort)\n' >&2
			exit 1
		fi
		rm -f "$state"
		die "cherry-pick failed (rc=$rc) with no conflicts to resolve — see output above"
	fi
	# Clean apply: finalize now. If the cherry-pick was EMPTY (upstream change already
	# present in the fork), the tree is unchanged but the pointer file still advances, so
	# finalize commits a pointer-only "already present" port — the backlog still shrinks.
	finalize "$sha" "$ref"
}

# Stage the (already rewound) pointer and make the gated unport commit. Shared by a
# clean revert and by `continue` after a manual resolve. `git revert --no-commit` of the
# port commit ALREADY rewound + staged .fork/UPSTREAM (the port advanced it in that same
# commit), so unlike finalize() we do NOT write_pointer — we only record the Unport
# trailer so audit/commit-msg recognize the backward pointer move as legitimate.
finalize_unport() { # <un-ported-full-sha> <expected-previous-pointer>
	local sha="$1" expected="$2" expected_ref="$3" actual actual_ref staged staged_ref msg
	if git ls-files --unmerged --error-unmatch -- . >/dev/null 2>&1; then
		git diff --name-only --diff-filter=U | sed 's/^/  /' >&2
		die "unresolved conflicts remain (above) — resolve + 'git add', then ./.fork/port.sh continue"
	fi
	actual="$(upstream_pointer)"
	actual_ref="$(upstream_pointer_ref)"
	[ "$actual" = "$expected" ] && [ "$actual_ref" = "$expected_ref" ] || die "unport did not rewind .fork/UPSTREAM to $expected ${expected_ref:-<no-ref>} (found ${actual:-unset} ${actual_ref:-<no-ref>})
       restore the revert's pointer change, stage it, then run ./.fork/port.sh continue"
	git add "$changes_file"
	staged="$(git show ":$changes_file" 2>/dev/null | awk 'NF && $1 !~ /^#/ {print $1; exit}')"
	staged_ref="$(git show ":$changes_file" 2>/dev/null | awk 'NF && $1 !~ /^#/ {print $2; exit}')"
	[ "$staged" = "$expected" ] && [ "$staged_ref" = "$expected_ref" ] || die "staged .fork/UPSTREAM is $staged ${staged_ref:-<no-ref>}, expected $expected ${expected_ref:-<no-ref>}"
	msg="$(printf 'fork-flow: revert port of %s\n\nUndoes the port of upstream commit %s, rewinding .fork/UPSTREAM to the\nprevious pointer. Re-port it later with ./.fork/port.sh next.\n\n%s: %s\n' \
		"$(git rev-parse --short "$sha")" "$sha" "$UNPORT_TRAILER" "$sha")"
	# The pre-commit integration gate runs verify.sh --registry here (pointer is staged):
	# undoing a port must not silently break a customization either.
	printf '%s' "$msg" | git commit -F -
	rm -f "$unport_state"
	note "reverted port of $sha; pointer now $(upstream_pointer || echo '(unset)')"
}

# Un-port the NEWEST port: `git revert` the fork commit that advanced the pointer to its
# current value (which rewinds .fork/UPSTREAM automatically), then commit it gated with a
# Fork-Flow-Unport trailer. Reverts go newest-first — the mirror of port-oldest-first
# contiguity — so an explicit SHA must name the current pointer.
cmd_revert() { # [<upstream-sha>]
	local want="${1:-}" cur target tr sha prev prev_ref rc
	[ -f "$state" ] && die "a port is in progress — finish it (continue/abort) first"
	[ -f "$unport_state" ] && die "an unport is already in progress — continue/abort it first"
	require_clean_tree
	cur="$(upstream_pointer)"
	[ -z "$cur" ] && die "no pointer set — nothing to revert"
	git rev-parse --verify --quiet "${cur}^{commit}" >/dev/null 2>&1 ||
		die "pointer $cur does not resolve — fix .fork/UPSTREAM before reverting"
	cur="$(git rev-parse "$cur")"
	# An explicit SHA is a safety assertion: you may only revert the NEWEST port, i.e. the
	# one the pointer names. Reverting an older port out of order would leave the pointer
	# ahead of the tree (audit's consistency check would then flag it).
	if [ -n "$want" ]; then
		git rev-parse --verify --quiet "${want}^{commit}" >/dev/null 2>&1 || die "not a commit: $want"
		want="$(git rev-parse "$want")"
		[ "$want" = "$cur" ] || die "can only revert the NEWEST port: the pointer is $(git rev-parse --short "$cur"), not $(git rev-parse --short "$want")
       (revert in reverse port order — newest first)"
	fi
	# Find the fork commit whose port trailer names the current pointer — the in-effect
	# newest port. Matching the TRAILER to the pointer (not merely "the newest port
	# commit") means a re-port wins over its reverted original, and a corrupt pointer that
	# names no reachable port is refused rather than reverting the wrong commit.
	target=""
	while IFS= read -r sha; do
		[ -z "$sha" ] && continue
		tr="$(port_trailer_sha "$sha")"
		[ -z "$tr" ] && continue
		if [ "$(git rev-parse "$tr" 2>/dev/null)" = "$cur" ]; then
			target="$sha"
			break
		fi
	done < <(git log --format='%H' HEAD 2>/dev/null || true)
	[ -z "$target" ] &&
		die "no reachable commit ports $(git rev-parse --short "$cur") — .fork/UPSTREAM may be hand-edited (expected a $PORT_TRAILER trailer)"
	# The pointer being the INIT pointer means nothing has been ported — there is no port
	# to revert (reverting init would just un-initialize the fork).
	if git log -1 --format='%B' "$target" 2>/dev/null | grep -q "^$INIT_TRAILER:"; then
		die "pointer is at the init commit (nothing ported) — port forward first, or undo init by hand"
	fi
	prev="$(git show "$target^:$changes_file" 2>/dev/null | awk 'NF && $1 !~ /^#/ {print $1; exit}')"
	prev_ref="$(git show "$target^:$changes_file" 2>/dev/null | awk 'NF && $1 !~ /^#/ {print $2; exit}')"
	[ -n "$prev" ] || die "port commit $(git rev-parse --short "$target") has no previous pointer to restore"
	note "reverting port $(git rev-parse --short "$target") (un-ports $(git rev-parse --short "$cur"))"
	# Record state BEFORE touching the tree so abort/continue always have it.
	printf 'UNPORT=%s\nPREV=%s\nPREV_REF=%s\n' "$cur" "$prev" "$prev_ref" >"$unport_state"
	rc=0
	git revert --no-commit "$target" || rc=$?
	if [ "$rc" -ne 0 ]; then
		if git diff --name-only --diff-filter=U | grep -q .; then
			printf '\nport.sh: CONFLICT reverting %s. Files:\n' "$(git rev-parse --short "$target")" >&2
			git diff --name-only --diff-filter=U | sed 's/^/  /' >&2
			printf 'Resolve + git add, then: ./.fork/port.sh continue   (or abort)\n' >&2
			exit 1
		fi
		git revert --abort >/dev/null 2>&1 || git reset -q --hard HEAD
		rm -f "$unport_state"
		die "revert failed (rc=$rc) with no conflicts to resolve — see output above"
	fi
	# Clean revert: .fork/UPSTREAM is already rewound + staged; finalize now (gated).
	finalize_unport "$cur" "$prev" "$prev_ref"
}

cmd_one() {
	local sha="${1:-}" ref
	[ -n "$sha" ] || die "usage: ./.fork/port.sh one <sha> [upstream-ref]"
	ref="$(resolve_upstream_ref "${2:-}")"
	git rev-parse --verify --quiet "${sha}^{commit}" >/dev/null 2>&1 || die "not a commit: $sha"
	sha="$(git rev-parse "$sha")"
	start_port "$sha" "$ref"
}

cmd_next() {
	local ref sha
	ref="$(resolve_upstream_ref "${1:-}")"
	[ -z "$(upstream_pointer)" ] && die "no pointer yet — run ./.fork/port.sh init <sha> [ref] first"
	sha="$(backlog "$ref" | head -1)"
	[ -z "$sha" ] && {
		note "nothing to port — up to date with $ref"
		return 0
	}
	note "porting $(git rev-parse --short "$sha"): $(git log -1 --format=%s "$sha")"
	start_port "$sha" "$ref"
}

cmd_continue() {
	# An unport (revert) in progress takes precedence — `git revert` already rewound the
	# pointer, so we only need to finalize the gated commit.
	if [ -f "$unport_state" ]; then
		local usha prev prev_ref
		usha="$(awk -F= '/^UNPORT=/{print $2}' "$unport_state")"
		prev="$(awk -F= '/^PREV=/{print $2}' "$unport_state")"
		prev_ref="$(awk -F= '/^PREV_REF=/{print $2}' "$unport_state")"
		[ -n "$usha" ] || die "unport state file is corrupt (no SHA) — ./.fork/port.sh abort and retry"
		[ -n "$prev" ] || die "unport state file is corrupt (no previous pointer) — ./.fork/port.sh abort and retry"
		finalize_unport "$usha" "$prev" "$prev_ref"
		return
	fi
	[ -f "$state" ] || die "no port in progress"
	local sha ref
	sha="$(awk -F= '/^SHA=/{print $2}' "$state")"
	ref="$(awk -F= '/^REF=/{print $2}' "$state")"
	[ -n "$sha" ] || die "state file is corrupt (no SHA) — ./.fork/port.sh abort and retry"
	finalize "$sha" "$ref"
}

cmd_abort() {
	# An unport uses `git revert`, which DOES leave a sequencer/REVERT_HEAD (unlike a
	# --no-commit cherry-pick), so `git revert --abort` is the clean undo here.
	if [ -f "$unport_state" ]; then
		git revert --abort >/dev/null 2>&1 || git reset -q --hard HEAD
		git reset -q --merge >/dev/null 2>&1 || true
		rm -f "$unport_state"
		note "unport aborted; tree restored to HEAD"
		return
	fi
	[ -f "$state" ] || die "no port in progress"
	# `cherry-pick --no-commit` leaves no sequencer, so --abort won't work; hard-reset
	# the worktree/index back to HEAD and drop the state.
	git reset -q --hard HEAD
	git reset -q --merge >/dev/null 2>&1 || true
	rm -f "$state"
	note "port aborted; tree restored to HEAD"
}

case "${1:-}" in
init)
	shift
	cmd_init "$@"
	;;
list)
	shift
	cmd_list "$@"
	;;
next)
	shift
	cmd_next "$@"
	;;
one)
	shift
	cmd_one "$@"
	;;
revert)
	shift
	cmd_revert "$@"
	;;
continue) cmd_continue ;;
abort) cmd_abort ;;
status) cmd_status ;;
"" | -h | --help)
	sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
	;;
*) die "unknown subcommand: $1 (try ./.fork/port.sh --help)" ;;
esac
