#!/usr/bin/env bash
# .fork/lib.sh — shared helpers for the fork-flow scripts (see Fork Maintenance in your CLAUDE.md/AGENTS.md).
#
# This file is SOURCED, never executed. brief.sh, conflict-context.sh, audit.sh
# and verify.sh each `. .fork/lib.sh` (after they cd to the repo root) so the
# registry/merge=ours parsing and path-matching live in ONE place instead of
# being copy-pasted. Change the grammar here and every script follows.
#
# Depends only on git/awk/grep. Must stay bash 3.2 (macOS /bin/bash) safe:
#   - no associative arrays (bash 4+);
#   - keep every `case` INSIDE a function defined here. A `case` literally
#     written inside a $(...) mis-parses on 3.2 (it eats the pattern's ')'),
#     but a function that merely CONTAINS a `case` is safe to CALL inside $(...).
#     That is the whole reason matching is centralized as functions.

# Split a Touches/Symbols field on ';' and ',' ONLY (never whitespace, so a path
# may contain spaces) with globbing disabled (so '*'/'**' reach the caller
# verbatim). Emits one trimmed, non-empty token per line.
split_field() {
	local s="$1" tok glob_off=0
	case "$-" in *f*) glob_off=1 ;; *) set -f ;; esac
	local IFS=';,'
	for tok in $s; do
		tok="${tok#"${tok%%[![:space:]]*}"}" # trim leading whitespace
		tok="${tok%"${tok##*[![:space:]]}"}" # trim trailing whitespace
		[ -n "$tok" ] && printf '%s\n' "$tok"
	done
	[ "$glob_off" -eq 0 ] && set +f
}

# name@path -> path (text after the LAST '@'); prints nothing when there is no
# '@'. Uses parameter expansion, not `case`, so it is safe even inline. Always
# returns 0 so `x="$(symbol_path …)"` never trips `set -e` on a token with no '@'.
symbol_path() {
	local s="$1"
	if [ "${s#*@}" != "$s" ]; then printf '%s\n' "${s##*@}"; fi
	return 0
}

# Does anchor PATTERN ($1) match the single FILE ($2)? Literal equality first, so a
# real path that itself contains glob metacharacters (e.g. "app/[id].tsx") still
# matches; otherwise treat PATTERN as a shell glob ("src/icons/*.svg").
glob_match() {
	[ "$2" = "$1" ] && return 0
	# shellcheck disable=SC2254  # $1 is intentionally an unquoted glob pattern
	case "$2" in $1) return 0 ;; esac
	return 1
}

# Does glob PATTERN ($1) match ANY path in the newline-separated LIST ($2)?
glob_match_any() {
	local pattern="$1" f
	while IFS= read -r f; do
		[ -z "$f" ] && continue
		# shellcheck disable=SC2254  # $pattern is intentionally an unquoted glob
		case "$f" in $pattern) return 0 ;; esac
	done <<EOF
$2
EOF
	return 1
}

# Is FILE ($1) covered by ANY registry anchor in the newline-separated LIST ($2)?
# The inverse of glob_match_any: here the LIST holds glob PATTERNS (the registry's
# Touches/Symbols anchors) and FILE is one literal path. Glob matching is not
# symmetric — the pattern carries the '*' — so we test each anchor against the one
# file. A file counts as registered if it equals OR is glob-matched by an anchor,
# so a glob anchor like src/icons/*.svg covers src/icons/a.svg. Shared by audit.sh's
# unregistered scan and the commit-msg reminder so the two can never disagree.
path_registered() {
	local f="$1" reg="$2" p
	while IFS= read -r p; do
		[ -z "$p" ] && continue
		glob_match "$p" "$f" && return 0
	done <<EOF
$reg
EOF
	return 1
}

# Is PATH ($1) part of the fork-flow toolkit itself rather than the project's own
# code? These are excluded from the "unregistered customization" checks (audit.sh's
# scan and the commit-msg reminder). One list, shared by both, so what counts as a
# customization is defined in exactly one place.
toolkit_path() {
	case "$1" in
	.fork/* | .fork-flow/* | .claude/* | .pi/* | .gitattributes | AGENTS.md | CLAUDE.md) return 0 ;;
	# (.fork/* already covers .fork/UPSTREAM, .fork/CHANGES.md, etc.)
	esac
	return 1
}

# The last upstream commit ported into this fork: the first non-comment, non-empty
# token of .fork/UPSTREAM (see that file). Prints nothing when the file is absent or
# holds only comments (a brand-new fork that has not ported yet). One SHA, trimmed.
upstream_pointer() {
	[ -f .fork/UPSTREAM ] || return 0
	awk 'NF && $1 !~ /^#/ { print $1; exit }' .fork/UPSTREAM
}

# The upstream REF the pointer was ported from (optional second token on the pointer
# line, e.g. "<sha> upstream/main"). Lets audit.sh warn when you pass a different
# --upstream than what was actually tracked (a retarget). Prints nothing if absent.
upstream_pointer_ref() {
	[ -f .fork/UPSTREAM ] || return 0
	awk 'NF && $1 !~ /^#/ { print $2; exit }' .fork/UPSTREAM
}

# The strict port trailer. EVERY port commit (and the one-time pointer-init commit)
# carries exactly one of these, naming the full upstream SHA it advances the pointer
# to. This is the SOLE signal that a commit is a port — NOT "it touches .fork/UPSTREAM"
# (an accidental `git add -A` could stage the pointer into an ordinary commit and, on
# the old OR-heuristic, make audit skip that commit's files and the commit-msg nag go
# quiet). A trailer cannot be injected by a stray add, so it has no such false
# positive. PORT_TRAILER is for a real ported commit; INIT_TRAILER for the first
# pointer bump on a fork that has never ported (nothing was cherry-picked).
PORT_TRAILER='Fork-Flow-Port'
# shellcheck disable=SC2034  # used by port.sh (which sources this file), not within lib.sh
INIT_TRAILER='Fork-Flow-Port-Init'

# Extract the SHA from a Fork-Flow-Port[-Init] trailer in commit-message TEXT on
# STDIN (the LAST such trailer wins, matching git-trailer semantics). Prints the SHA
# (a FULL 40- or 64-hex id only; an abbreviated/edited value is ignored so it can't
# masquerade as a port) or nothing. The stdin form lets the commit-msg hook parse the
# message FILE before a commit exists; port_trailer_sha wraps it for an existing commit.
port_trailer_sha_stream() {
	awk -v p="$PORT_TRAILER" '
		{ line=$0; sub(/^[[:space:]]+/,"",line)
		  if (line ~ "^" p "(-Init)?:") {
		    s=line; sub(/^[^:]*:[[:space:]]*/,"",s); sub(/[[:space:]]+$/,"",s)
		    if (s ~ /^[0-9a-fA-F]+$/ && (length(s)==40 || length(s)==64)) last=s
		    else last="" } }
		END { if (last!="") print last }'
}

# Extract the Fork-Flow-Port[-Init] SHA from commit $1's message. Always returns 0 so
# `x="$(port_trailer_sha …)"` never trips set -e.
port_trailer_sha() {
	git log -1 --format='%B' "$1" 2>/dev/null | port_trailer_sha_stream
	return 0
}

# The base commit for "what is mine vs upstream" in a commit-by-commit fork. Uses the
# .fork/UPSTREAM pointer (the last ported upstream commit). On a fork that has NOT
# ported yet (empty pointer) it falls back to merge-base(HEAD, $1) with a note. But a
# NON-EMPTY pointer that does NOT resolve to a commit is a HARD ERROR (exit 3): that
# means corruption — a bad SHA, a dropped object, or an upstream force-push that
# orphaned it — and silently falling back to merge-base would HIDE it (the old
# behavior). $1 is the upstream ref (default upstream/main).
upstream_base() {
	local upstream="${1:-upstream/main}" ptr
	ptr="$(upstream_pointer)"
	if [ -n "$ptr" ]; then
		if git rev-parse --verify --quiet "${ptr}^{commit}" >/dev/null 2>&1; then
			git rev-parse "$ptr"
			return 0
		fi
		printf 'error: .fork/UPSTREAM pointer %s does not resolve to a commit\n' "$ptr" >&2
		printf '       (bad SHA, missing object, or an upstream force-push orphaned it).\n' >&2
		printf '       fetch upstream, or fix .fork/UPSTREAM, before trusting audit/port output.\n' >&2
		return 3
	fi
	printf 'note: .fork/UPSTREAM not set yet — using merge-base(HEAD, %s) as base\n' "$upstream" >&2
	git merge-base HEAD "$upstream"
}

# Is commit $1 an upstream PORT commit (it integrates one upstream commit, or is the
# one-time pointer-init) rather than your own customization work? TRUE iff its message
# carries a strict Fork-Flow-Port[-Init] trailer — trailer-only, no "touches
# .fork/UPSTREAM" fallback (see PORT_TRAILER). Used by audit.sh's unregistered scan
# and propose-upstream so a ported upstream commit is never mistaken for a
# customization, and a stray pointer in an ordinary commit is never mistaken for a port.
is_upstream_port_commit() {
	[ -n "$(port_trailer_sha "$1")" ]
}

# The strict UNPORT trailer. A `port.sh revert` commit carries exactly one, naming the
# full upstream SHA whose port it undoes. `git revert` of the port commit already
# rewinds .fork/UPSTREAM (the port advanced it in that same commit), so this trailer is
# how audit.sh tells a legit pointer-rewind from a tamper, how it excludes a reverted
# port from the newest-trailer check, and how the commit-msg hook accepts a staged
# pointer that moved BACKWARD. Symmetric to PORT_TRAILER; there is no init variant.
UNPORT_TRAILER='Fork-Flow-Unport'

# Extract the SHA from a Fork-Flow-Unport trailer in commit-message TEXT on STDIN (the
# LAST such trailer wins; a FULL 40-/64-hex id only, like the port parser). Mirror of
# port_trailer_sha_stream; the stdin form lets the commit-msg hook parse the message
# FILE before a commit exists. The two trailers are disjoint (Fork-Flow-Port vs
# Fork-Flow-Unport), so neither parser matches the other.
unport_trailer_sha_stream() {
	awk -v p="$UNPORT_TRAILER" '
		{ line=$0; sub(/^[[:space:]]+/,"",line)
		  if (line ~ "^" p ":") {
		    s=line; sub(/^[^:]*:[[:space:]]*/,"",s); sub(/[[:space:]]+$/,"",s)
		    if (s ~ /^[0-9a-fA-F]+$/ && (length(s)==40 || length(s)==64)) last=s
		    else last="" } }
		END { if (last!="") print last }'
}

# Extract the Fork-Flow-Unport SHA from commit $1's message. Always returns 0 so
# `x="$(unport_trailer_sha …)"` never trips set -e.
unport_trailer_sha() {
	git log -1 --format='%B' "$1" 2>/dev/null | unport_trailer_sha_stream
	return 0
}

# Is commit $1 an UNPORT (a `port.sh revert`)? TRUE iff it carries a Fork-Flow-Unport
# trailer. audit.sh treats these as legit pointer movers (they rewind the pointer) and
# skips them in the unregistered scan, exactly like ports — an unport's diff is upstream
# churn it reverses, never your customization.
is_upstream_unport_commit() {
	[ -n "$(unport_trailer_sha "$1")" ]
}

# Parse registry text from STDIN → every anchor path (each Touches token + the path
# part of each Symbols name@path), one per line, de-duplicated. The stdin form lets
# a caller match against the registry as a COMMIT will ship it — e.g. pipe in
# `git show :.fork/CHANGES.md` (the index copy) instead of the working tree, so an
# edited-but-unstaged CHANGES.md can't mask a missing entry (see the commit-msg hook).
#
# ENTRY-AWARE: a Touches/Symbols line counts only INSIDE a "## " entry, exactly like
# verify.sh/brief.sh/conflict-context.sh. Otherwise this stream parser would treat a
# stray field (e.g. one left above the first heading by a bad edit) as registered
# while the gate sees it as belonging to no entry — the two would disagree.
registry_paths_stream() {
	local line tok in_entry=0
	while IFS= read -r line || [ -n "$line" ]; do
		case "$line" in
		"## "*) in_entry=1 ;;
		[Tt]ouches:*) if [ "$in_entry" = 1 ]; then split_field "${line#*:}"; fi ;;
		[Ss]ymbols:*) if [ "$in_entry" = 1 ]; then split_field "${line#*:}" | while IFS= read -r tok; do symbol_path "$tok"; done; fi ;;
		esac
	done | awk 'NF && !seen[$0]++'
}

# Validate registry grammar (file $1, default .fork/CHANGES.md). Prints each problem
# to stderr; returns 1 on any HARD error (gate must fail), else 0. It guards ONLY the
# silent-drop traps, deliberately tolerating the rest of the Markdown so a legitimate
# human-written registry is never rejected:
#   HARD ERROR (would silently drop/mis-attribute a Verify):
#     - a malformed level-2 heading "##" with no following space ("##custom: x") —
#       its Verify: would otherwise overwrite the PREVIOUS entry's, dropping it; and
#     - an EMPTY "## " heading (no slug after trimming): check_entry() early-returns
#       on an empty heading, so that entry's Verify would never run.
#   IGNORED (valid Markdown): the "# " title, level-3+ subheadings ("### Notes"),
#   prose, and anything inside a ``` / ~~~ fenced code block (so a documented
#   "Verify: <cmd>" example does not trip the lint).
#   WARNING ONLY (not a gate failure): a Touches/Verify/etc field before the first
#   "## " heading — the entry-aware parser already ignores it, so it cannot drop a
#   check; it is surfaced as a likely-misplaced line, nothing more.
registry_lint() {
	local changes="${1:-.fork/CHANGES.md}" line lineno=0 in_entry=0 in_fence=0 rc=0 slug
	[ -f "$changes" ] || return 0
	while IFS= read -r line || [ -n "$line" ]; do
		lineno=$((lineno + 1))
		case "$line" in
		'```'* | '~~~'*)
			[ "$in_fence" = 0 ] && in_fence=1 || in_fence=0
			continue
			;;
		esac
		[ "$in_fence" = 1 ] && continue
		case "$line" in
		"## "*)
			slug="${line#\#\# }"
			slug="${slug#"${slug%%[![:space:]]*}"}" # trim leading whitespace
			slug="${slug%"${slug##*[![:space:]]}"}" # trim trailing whitespace
			if [ -z "$slug" ]; then
				printf 'ERROR: %s:%d: empty entry heading (need "## <slug>")\n' "$changes" "$lineno" >&2
				rc=1
			else in_entry=1; fi
			;;
		"###"* | "# "* | "#") : ;; # level-1 title / level-3+ subheading — valid Markdown
		"##"*)
			printf 'ERROR: %s:%d: malformed entry heading (need "## <slug>"): %s\n' "$changes" "$lineno" "$line" >&2
			rc=1
			;;
		[Tt]ouches:* | [Ss]ymbols:* | [Vv]erify:* | [Dd]rift-if:* | [Ss]tatus:*)
			[ "$in_entry" = 0 ] && printf 'warning: %s:%d: "%s" field before any "## " heading — ignored\n' "$changes" "$lineno" "${line%%:*}" >&2
			;;
		esac
	done <"$changes"
	return "$rc"
}

# Every registry anchor path from the file $1 (default .fork/CHANGES.md, the working
# tree). Thin wrapper over registry_paths_stream so file and stdin callers share one
# parser. Prints nothing when the file is absent.
registry_paths() {
	local changes="${1:-.fork/CHANGES.md}"
	[ -f "$changes" ] || return 0
	registry_paths_stream <"$changes"
}

# merge=ours PATTERNS declared in .gitattributes (the path/pattern field of every
# non-comment line that sets merge=ours). We parse the DECLARED pattern — not the
# files that currently resolve to merge=ours — on purpose: the backstop
# (guard_merge_ours) must still flag a pattern whose file was deleted/renamed, which
# a `git check-attr` over tracked files could never report. The path is field 1,
# EXCEPT that git lets a path with spaces be double-quoted ("space name.txt"
# merge=ours); awk's whitespace split would truncate that to `"space`, so unquote it.
# An unclosed quote is malformed: emit the remainder verbatim so guard_merge_ours
# fails loudly on it instead of it silently vanishing. Globs pass through verbatim.
# Prints nothing when there is no .gitattributes.
merge_ours_paths() {
	[ -f .gitattributes ] || return 0
	awk '
    $0 ~ /^[[:space:]]*#/ { next }
    /merge=ours/ {
      line=$0; sub(/^[[:space:]]+/,"",line)
      if (substr(line,1,1)=="\"") {
        rest=substr(line,2); q=index(rest,"\"")
        if (q>0) print substr(rest,1,q-1); else print rest
      } else {
        n=index(line," "); t=index(line,"\t")
        if (t>0 && (t<n || n==0)) n=t
        if (n>0) print substr(line,1,n-1); else print line
      }
    }' .gitattributes
}

# The fork-flow kit version installed in this fork: the integer in .fork/VERSION
# (comment lines ignored). Prints nothing on a pre-VERSION install. install.sh writes
# this file; audit.sh surfaces it so the operator can tell when a fork is on an old
# kit. Decides nothing — comparison to the shipped version is install.sh --check's job.
kit_version() {
	[ -f .fork/VERSION ] || return 0
	awk '/^[[:space:]]*#/ {next} NF {print $1; exit}' .fork/VERSION
}
