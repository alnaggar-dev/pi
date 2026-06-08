#!/usr/bin/env bash
# .fork/verify.sh — the one real gate that proves the fork still works.
#
#   ./.fork/verify.sh --fast       quick feedback while resolving (typecheck-only)
#   ./.fork/verify.sh --registry   only the per-customization Verifies + the
#                                  merge=ours backstop (no build/install), so you
#                                  can confirm your customizations survived even
#                                  while the merged build is still red
#   ./.fork/verify.sh              full gate before committing a merge
#
# The Fork Maintenance notes (CLAUDE.md/AGENTS.md) sketch a pnpm example; this generalizes it so
# the gate is correct whether the fork is Node (incl. Next.js/Vue/React),
# Rust, Python, PHP/Laravel, Ruby/Rails, Swift, or not yet wired to a stack.
# Two things always hold:
#   1. the merge=ours backstop (full runs) fails if .gitattributes names a
#      merge=ours path that no longer exists;
#   2. a full run proves the fork builds and its tests pass.
# Adjust the per-stack commands for your project as it grows.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Shared helpers (merge_ours_paths, …) — one copy for all scripts, see .fork/lib.sh.
# shellcheck source=/dev/null
. .fork/lib.sh

# modes: full (default) | fast (typecheck-only) | registry (Verifies + backstop only)
mode=full
case "${1:-}" in
--fast) mode=fast ;;
--registry) mode=registry ;;
"") mode=full ;;
*)
	echo "usage: ./.fork/verify.sh [--fast|--registry]" >&2
	exit 2
	;;
esac
fast=0
[ "$mode" = fast ] && fast=1

have() { command -v "$1" >/dev/null 2>&1; }
run() {
	checked=1
	printf '+ %s\n' "$*" >&2
	"$@"
}
ran_something=0
checked=0 # set by run(); lets --fast warn when it actually verified nothing

# --- merge=ours backstop (full runs only) -----------------------------------
guard_merge_ours() {
	[ -f .gitattributes ] || return 0
	failed=0
	while IFS= read -r path; do
		[ -z "$path" ] && continue
		# git ls-files honors pathspec/globs (e.g. "*.svg", "assets/**"), so a glob
		# override is satisfied as long as it still matches at least one tracked file.
		# (Matches brief.sh, which reads .gitattributes paths through git too.)
		if ! git ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
			printf 'ERROR: .gitattributes lists %s as merge=ours but it matches no tracked file\n' "$path" >&2
			failed=1
		fi
	done < <(merge_ours_paths)
	return "$failed"
}

# --- per-customization checks (full + --registry runs) -----------------------
# Run the Verify of EVERY registry entry, not just ones with a Drift-if: a
# silently dropped customization usually has no Drift-if, and skipping its Verify
# is exactly how that drop slips through the gate. The KIND of Verify is decided by
# its first token, never guessed from the command name:
#   * "manual:" prefix  -> a human check; listed for you, never executed
#   * empty             -> no Verify; reported as not gated
#   * anything else      -> a runnable command; executed via bash -c, non-zero fails
# Treating everything unmarked as runnable means env-prefixed ("NODE_ENV=test npm
# test") and variable ("$PM run test") commands run correctly; a human check must
# mark itself "manual:". An unmarked prose Verify runs, fails, and is flagged with a
# hint — never silently skipped. A Drift-if names a SILENT-breakage risk that a
# manual or missing Verify cannot catch, so either combination is a hard error.
# This is what proves YOUR customizations survived an upstream merge — upstream's
# own tests usually do not exercise them, and the worst changes produce NO conflict.
verify_registry() {
	local changes=".fork/CHANGES.md"
	[ -f "$changes" ] || return 0
	# Fail loudly on a malformed registry heading (a "## " typo'd to "##slug", or an
	# empty "## ") instead of silently dropping or mis-attributing a Verify. A field
	# before the first heading only warns (the parser already ignores it).
	registry_lint "$changes" || return 1
	rheading=""
	rdrift=""
	rverify=""
	rfailed=0
	manual=""
	unprot=""
	check_entry() {
		[ -z "$rheading" ] && return 0
		local v rc
		v="${rverify#"${rverify%%[![:space:]]*}"}" # Verify value, leading whitespace trimmed
		case "$v" in
		[Mm]anual:*)
			if [ -n "$rdrift" ]; then
				printf 'ERROR: customization "%s" has a Drift-if but its Verify is marked manual — it must be a runnable command\n' "$rheading" >&2
				rfailed=1
			else
				manual="${manual:+$manual
}$rheading"
			fi
			;;
		"")
			if [ -n "$rdrift" ]; then
				printf 'ERROR: customization "%s" declares a Drift-if but has no Verify command\n' "$rheading" >&2
				rfailed=1
			else
				unprot="${unprot:+$unprot
}$rheading"
			fi
			;;
		*)
			ran_something=1
			printf '+ verify[%s]:%s\n' "$rheading" "$rverify" >&2
			# Redirect stdin from /dev/null: a Verify that reads stdin (cat, grep PAT,
			# sort, a read-based script, ssh/docker run without -t) would otherwise
			# inherit this loop's stdin (CHANGES.md, via `done < "$changes"`) and swallow
			# every following entry, so the gate would skip those checks and exit OK.
			rc=0
			bash -c "$rverify" </dev/null || rc=$?
			if [ "$rc" -ne 0 ]; then
				printf 'ERROR: customization "%s" failed its Verify (exit %s)\n' "$rheading" "$rc" >&2
				if [ "$rc" -eq 127 ]; then
					printf '       (if this is a human check, prefix the Verify with "manual:" so the gate lists it instead of running it)\n' >&2
				fi
				rfailed=1
			fi
			;;
		esac
		rheading=""
		rdrift=""
		rverify=""
	}
	while IFS= read -r line || [ -n "$line" ]; do
		case "$line" in
		"## "*)
			check_entry
			rheading="${line#"## "}"
			;;
		# Only capture fields once a heading is open, so a stray field BEFORE the first
		# "## " (which registry_lint warns about) is truly ignored, not carried into the
		# first entry. Matches registry_paths_stream's entry-aware parsing.
		[Dd]rift-if:*) [ -n "$rheading" ] && rdrift="${line#*:}" ;;
		[Vv]erify:*) [ -n "$rheading" ] && rverify="${line#*:}" ;;
		esac
	done <"$changes"
	check_entry
	if [ -n "$manual" ]; then
		printf 'verify by hand (Verify marked manual:) — confirm these survived:\n' >&2
		printf '%s\n' "$manual" | while IFS= read -r m; do [ -n "$m" ] && printf '  - %s\n' "$m" >&2; done
	fi
	if [ -n "$unprot" ]; then
		printf 'note: customizations with NO Verify (the gate cannot prove these survived):\n' >&2
		printf '%s\n' "$unprot" | while IFS= read -r u; do [ -n "$u" ] && printf '  - %s\n' "$u" >&2; done
	fi
	return "$rfailed"
}

# --- Node --------------------------------------------------------------------
node_pm() {
	if have bun && { [ -f bun.lock ] || [ -f bun.lockb ] || grep -q '"packageManager"[[:space:]]*:[[:space:]]*"bun' package.json 2>/dev/null; }; then
		echo bun
	elif have pnpm && { [ -f pnpm-lock.yaml ] || grep -q '"packageManager"[[:space:]]*:[[:space:]]*"pnpm' package.json 2>/dev/null; }; then
		echo pnpm
	elif have yarn && [ -f yarn.lock ]; then
		echo yarn
	elif have npm; then
		echo npm
	fi
}
node_has_script() { # <script-name>
	have node || return 1
	node -e 'const s=(require("./package.json").scripts)||{};process.exit(s[process.argv[1]]?0:1)' "$1" 2>/dev/null
}
verify_node() {
	[ -f package.json ] || return 0
	pm="$(node_pm)"
	[ -z "$pm" ] && {
		printf 'note: package.json present but no node package manager found\n' >&2
		return 0
	}
	ran_something=1
	if [ "$fast" = 1 ]; then
		node_has_script typecheck && run "$pm" run typecheck
		return 0
	fi
	# Prefer a frozen install for reproducibility, but fall back to a normal install
	# when no lockfile is committed yet — otherwise a fresh fork fails before it ever
	# reaches the registry Verifies (npm ci hard-requires a lockfile).
	case "$pm" in
	bun) if [ -f bun.lock ] || [ -f bun.lockb ]; then
		run bun install --frozen-lockfile
	else
		printf 'note: no bun lockfile — installing without --frozen-lockfile\n' >&2
		run bun install
	fi ;;
	pnpm) if [ -f pnpm-lock.yaml ]; then
		run pnpm install --frozen-lockfile
	else
		printf 'note: no pnpm-lock.yaml — installing without --frozen-lockfile\n' >&2
		run pnpm install
	fi ;;
	yarn) if [ -f yarn.lock ]; then
		run yarn install --frozen-lockfile
	else
		printf 'note: no yarn.lock — installing without --frozen-lockfile\n' >&2
		run yarn install
	fi ;;
	npm) if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
		run npm ci
	else
		printf 'note: no package-lock.json — using npm install (npm ci requires a lockfile)\n' >&2
		run npm install
	fi ;;
	esac
	for s in typecheck lint test build; do
		node_has_script "$s" && run "$pm" run "$s"
	done
	return 0
}

# --- Rust --------------------------------------------------------------------
verify_rust() {
	[ -f Cargo.toml ] || return 0
	have cargo || {
		printf 'note: Cargo.toml present but cargo not found\n' >&2
		return 0
	}
	ran_something=1
	if [ "$fast" = 1 ]; then
		run cargo check --all-targets
		return 0
	fi
	run cargo build --all-targets --locked
	have cargo-clippy && run cargo clippy --all-targets -- -D warnings
	run cargo test --locked
	return 0
}

# --- Python ------------------------------------------------------------------
verify_python() {
	{ [ -f pyproject.toml ] || [ -f requirements.txt ]; } || return 0
	ran_something=1
	runner=""
	if have uv; then
		runner="uv run"
	elif have poetry && [ -f poetry.lock ]; then
		runner="poetry run"
	fi
	if [ "$fast" = 1 ]; then
		if have pyright; then
			run pyright
		elif [ -n "$runner" ] && $runner python -c 'import mypy' >/dev/null 2>&1; then
			run $runner mypy .
		fi
		return 0
	fi
	if [ -n "$runner" ]; then
		run $runner pytest -q
	elif have pytest; then
		run pytest -q
	else
		printf 'note: python project but no pytest/uv/poetry runner found\n' >&2
	fi
	return 0
}

# --- PHP / Laravel -----------------------------------------------------------
# Laravel/Symfony/plain-Composer all share composer.json. We detect Laravel by its
# `artisan` console so `php artisan test` is preferred there; otherwise fall back to
# a composer "test" script, then pest/phpunit directly.
php_composer_script() { # <script-name>
	have php || return 1
	[ -f composer.json ] || return 1
	# shellcheck disable=SC2016  # $j/$argv are PHP vars, single-quoted on purpose
	php -r '$j=json_decode(file_get_contents("composer.json"),true);exit(isset($j["scripts"][$argv[1]])?0:1);' "$1" 2>/dev/null
}
verify_php() {
	[ -f composer.json ] || return 0
	have composer || {
		printf 'note: composer.json present but composer not found\n' >&2
		return 0
	}
	ran_something=1
	if [ "$fast" = 1 ]; then
		# No native typecheck in PHP; use a static analyzer if the fork wired one in.
		if [ -x vendor/bin/phpstan ]; then
			run vendor/bin/phpstan analyse --no-progress
		elif [ -x vendor/bin/psalm ]; then
			run vendor/bin/psalm --no-progress
		fi
		return 0
	fi
	# Prefer a reproducible install when composer.lock is committed.
	if [ -f composer.lock ]; then
		run composer install --no-interaction --no-progress --prefer-dist
	else
		printf 'note: no composer.lock — installing without a locked set\n' >&2
		run composer install --no-interaction --no-progress
	fi
	[ -x vendor/bin/pint ] && run vendor/bin/pint --test
	[ -x vendor/bin/phpstan ] && run vendor/bin/phpstan analyse --no-progress
	if php_composer_script test; then
		run composer run-script test
	elif [ -f artisan ]; then
		run php artisan test
	elif [ -x vendor/bin/pest ]; then
		run vendor/bin/pest
	elif [ -x vendor/bin/phpunit ]; then
		run vendor/bin/phpunit
	else
		printf 'note: composer project but no test script/pest/phpunit found\n' >&2
	fi
	return 0
}

# --- Ruby / Rails ------------------------------------------------------------
# Rails is just a Gemfile + bin/rails; we run rspec when there's a spec/ dir,
# otherwise the rake/rails test task. Sorbet's `srb tc` is the closest thing to a
# typecheck for --fast, used only if the fork adopted it.
verify_ruby() {
	[ -f Gemfile ] || return 0
	have bundle || {
		printf 'note: Gemfile present but bundler not found\n' >&2
		return 0
	}
	ran_something=1
	if [ "$fast" = 1 ]; then
		if bundle show sorbet >/dev/null 2>&1; then run bundle exec srb tc; fi
		return 0
	fi
	# bundle check avoids a slow reinstall when the gems are already satisfied.
	bundle check >/dev/null 2>&1 || run bundle install
	bundle show rubocop >/dev/null 2>&1 && run bundle exec rubocop
	if [ -d spec ] && bundle show rspec-core >/dev/null 2>&1; then
		run bundle exec rspec
	elif [ -f bin/rails ]; then
		run bin/rails test
	elif bundle show rake >/dev/null 2>&1; then
		run bundle exec rake test
	else
		printf 'note: Ruby project but no rspec/rails/rake test runner found\n' >&2
	fi
	return 0
}

# --- Swift -------------------------------------------------------------------
# SwiftPM only (Package.swift). Apps that are .xcodeproj/.xcworkspace-only need a
# scheme + xcodebuild invocation that varies per project, so wire those into a
# registry Verify instead of guessing a scheme here.
verify_swift() {
	[ -f Package.swift ] || return 0
	have swift || {
		printf 'note: Package.swift present but swift toolchain not found\n' >&2
		return 0
	}
	ran_something=1
	# `swift build` IS the typecheck/compile for SwiftPM, so it covers --fast too.
	run swift build
	[ "$fast" = 1 ] && return 0
	run swift test
	return 0
}

# --registry: just the checks that prove YOUR customizations survived — the
# merge=ours backstop and every entry's Verify — with no install/build, so it
# answers "did my changes survive?" even when the merged build is still red.
if [ "$mode" = registry ]; then
	guard_merge_ours || exit 1
	verify_registry || exit 1
	[ "$ran_something" = 0 ] && printf 'note: no runnable Verifies ran.\n' >&2
	printf 'verify.sh: OK (registry)\n' >&2
	exit 0
fi

if [ "$fast" = 0 ]; then
	guard_merge_ours || exit 1
fi
verify_node
verify_rust
verify_python
verify_php
verify_ruby
verify_swift
if [ "$fast" = 0 ]; then
	verify_registry || exit 1
fi

if [ "$ran_something" = 0 ]; then
	printf 'note: no recognized stack to verify (no package.json/Cargo.toml/pyproject.toml/composer.json/Gemfile/Package.swift).\n' >&2
	if [ "$fast" = 0 ]; then
		printf '      merge=ours backstop checked; wire stack commands into .fork/verify.sh once a stack exists.\n' >&2
	else
		printf '      wire stack commands into .fork/verify.sh once a stack exists.\n' >&2
	fi
elif [ "$fast" = 1 ] && [ "$checked" = 0 ]; then
	printf 'note: --fast found a stack but ran no check (e.g. no "typecheck" script) — NOTHING was verified.\n' >&2
fi
printf 'verify.sh: OK%s\n' "$([ "$fast" = 1 ] && echo ' (fast)')" >&2
