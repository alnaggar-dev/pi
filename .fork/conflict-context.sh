#!/usr/bin/env bash
# .fork/conflict-context.sh — everything needed to resolve one conflict by hand
# (see Fork Maintenance in your CLAUDE.md/AGENTS.md).
#
#   ./.fork/conflict-context.sh <file>
#
# Shows the conflict hunks, why the file changed on BOTH sides, and the matching
# .fork/CHANGES.md entries + their Verify: commands. It adapts to how you are
# integrating upstream: during a PORT (the upstream-port skill, a paused
# `git cherry-pick`) it shows the upstream commit being ported; during a merge it
# shows `git log --merge -p`.
# It makes no decisions; it gathers context.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Shared parsing/matching helpers (split_field, symbol_path, glob_match, …) —
# one copy for all scripts, see .fork/lib.sh.
# shellcheck source=/dev/null
. .fork/lib.sh

# Usage: conflict-context.sh <file>            (recover the ported sha from git state)
#        conflict-context.sh <sha> <file>      (caller knows the sha — port.sh passes it)
# The explicit-sha form is preferred: it avoids depending on MERGE_MSG's exact shape.
explicit_sha=""
if [ "$#" -eq 2 ]; then
	explicit_sha="$1"
	file="$2"
elif [ "$#" -eq 1 ]; then
	file="$1"
else
	echo "usage: ./.fork/conflict-context.sh [<upstream-sha>] <file>" >&2
	exit 2
fi

# --- conflict hunks ----------------------------------------------------------
printf '== conflict hunks: %s ==\n' "$file"
if [ ! -f "$file" ]; then
	printf '(file does not exist in the working tree)\n'
elif grep -q '^<<<<<<<' -- "$file"; then
	awk '
    /^<<<<<<</ {inc=1}
    inc {printf "%6d  %s\n", NR, $0}
    /^>>>>>>>/ {inc=0}
  ' "$file"
else
	printf '(no conflict markers in this file)\n'
fi

# The upstream commit being ported. Preference order: (1) an explicit sha the caller
# passed (port.sh always does — the robust path); (2) CHERRY_PICK_HEAD (a plain
# cherry-pick); (3) recovered from the "(cherry picked from commit <sha>)" line that
# -x records in MERGE_MSG — needed because `cherry-pick -x --no-commit` writes NO
# CHERRY_PICK_HEAD on conflict. (3) is a last-resort fallback, not the contract.
ported_commit() {
	if [ -n "$explicit_sha" ] && git rev-parse --verify --quiet "${explicit_sha}^{commit}" >/dev/null 2>&1; then
		git rev-parse "$explicit_sha"
		return 0
	fi
	if git rev-parse --quiet --verify CHERRY_PICK_HEAD >/dev/null 2>&1; then
		git rev-parse CHERRY_PICK_HEAD
		return 0
	fi
	local mm sha
	mm="$(git rev-parse --git-path MERGE_MSG 2>/dev/null)"
	[ -n "$mm" ] && [ -f "$mm" ] || return 1
	sha="$(awk 'match($0,/cherry picked from commit [0-9a-f]+/){print substr($0,RSTART+26,RLENGTH-26); exit}' "$mm")"
	[ -n "$sha" ] || return 1
	git rev-parse --verify --quiet "${sha}^{commit}" >/dev/null 2>&1 || return 1
	printf '%s\n' "$sha"
}

# --- upstream intent ---------------------------------------------------------
printf '\n== why this file changed ==\n'
ported="$(ported_commit || true)"
if [ -n "$ported" ]; then
	# A port in progress: show exactly what the upstream commit does to this file, plus
	# your recent local history for the file, so you can re-apply the change while
	# preserving your fork's behavior.
	printf '%s\n' "-- upstream commit being ported ($(git rev-parse --short "$ported")) --"
	git show --stat --patch "$ported" -- "$file" || true
	printf '%s\n' "" "-- your recent local history for $file --"
	git log --max-count=5 --oneline HEAD -- "$file" || true
elif git rev-parse --quiet --verify MERGE_HEAD >/dev/null 2>&1; then
	git log --merge -p -- "$file" || true
else
	printf '(not in a port or merge; run this during a paused cherry-pick/merge to see upstream intent)\n'
fi

# --- matching CHANGES.md entries ---------------------------------------------
printf '\n== matching CHANGES.md entries ==\n'
changes=".fork/CHANGES.md"
heading=""
touches=""
symbols=""
verify=""
any=0
print_entry() {
	[ -z "$heading" ] && return 0
	hit=0
	# Glob-aware so a "src/icons/*.svg" anchor matches the file being resolved,
	# consistent with brief.sh/audit.sh/verify.sh.
	while IFS= read -r tok; do glob_match "$tok" "$file" && hit=1; done < <(split_field "$touches")
	while IFS= read -r tok; do
		sp="$(symbol_path "$tok")"
		[ -n "$sp" ] && glob_match "$sp" "$file" && hit=1
	done < <(split_field "$symbols")
	if [ "$hit" -eq 1 ]; then
		any=1
		printf '\n* %s\n' "$heading"
		[ -n "$touches" ] && printf '    touches:%s\n' "$touches"
		[ -n "$symbols" ] && printf '    symbols:%s\n' "$symbols"
		[ -n "$verify" ] && printf '    verify:%s\n' "$verify"
	fi
	heading=""
	touches=""
	symbols=""
	verify=""
}
if [ ! -f "$changes" ]; then
	printf '(no %s)\n' "$changes"
else
	while IFS= read -r line || [ -n "$line" ]; do
		case "$line" in
		"## "*)
			print_entry
			heading="${line#"## "}"
			;;
		# Only capture fields once a heading is open, so a stray field before the first
		# "## " heading is ignored rather than attached to the first entry.
		[Tt]ouches:*) [ -n "$heading" ] && touches="${line#*:}" ;;
		[Ss]ymbols:*) [ -n "$heading" ] && symbols="${line#*:}" ;;
		[Vv]erify:*) [ -n "$heading" ] && verify="${line#*:}" ;;
		esac
	done <"$changes"
	print_entry
	[ "$any" -eq 0 ] && printf '(no entries reference %s)\n' "$file"
fi

exit 0
