#!/bin/sh
# burrow-cli installer (the burrow CLI). POSIX sh only: this runs via
#   curl -fsSL https://raw.githubusercontent.com/<owner>/burrow-cli/main/install.sh | sh
# where <owner> is the GitHub org (see BURROW_GITHUB_OWNER below; the README
# has the current command).
# before anything is installed on the machine, including bun. No bashisms,
# no arrays, no [[ ]], and no sudo anywhere.
set -eu

# Every input is read under its BURROW_* name first, then its legacy SUITE_*
# name, then the default: ${BURROW_X:-${SUITE_X:-default}}. So BURROW wins when
# both are set, and an EMPTY BURROW_X falls back, the rule src/env_names.ts
# applies in the CLI. SUITE_CLI_REF stays a supported input: core's agent-host
# image build passes it.
#
# The GitHub org the tarball comes from. The ONE place this script names it;
# src/repo_source.ts is the same rule for the CLI. Unset or empty means the
# default. `burrow update` exports the value it built the installer URL from
# (under both names), so the installer and the tarball cannot come from two
# orgs. Validated below, before anything is fetched, and the error names the
# variable that actually supplied the value.
if [ -n "${BURROW_GITHUB_OWNER:-}" ]; then
	OWNER_VAR="BURROW_GITHUB_OWNER"
	OWNER="$BURROW_GITHUB_OWNER"
elif [ -n "${SUITE_GITHUB_OWNER:-}" ]; then
	OWNER_VAR="SUITE_GITHUB_OWNER"
	OWNER="$SUITE_GITHUB_OWNER"
else
	OWNER_VAR="BURROW_GITHUB_OWNER"
	OWNER="Startup-Suite"
fi
REF="${BURROW_CLI_REF:-${SUITE_CLI_REF:-main}}"
# An explicit archive URL (tests, offline installs); empty means "build it".
TARBALL_OVERRIDE="${BURROW_CLI_TARBALL_URL:-${SUITE_CLI_TARBALL_URL:-}}"

TMPDIR_SUITE=""

# ---------------------------------------------------------------- output ----
# ASCII only, colour optional: nothing is known about this terminal yet.
# Two-column label/value grid, two-space indent.
LABEL_WIDTH=18

row() {
	# row <label> <value>
	printf '  %-*s%s\n' "$LABEL_WIDTH" "$1" "$2"
}

note() {
	printf '  %s\n' "$1"
}

# Every failure exits non-zero naming the step that failed.
die() {
	printf '\n  install failed: %s\n' "$1" >&2
	exit 1
}

cleanup() {
	if [ -n "$TMPDIR_SUITE" ] && [ -d "$TMPDIR_SUITE" ]; then
		rm -rf "$TMPDIR_SUITE"
	fi
}
trap cleanup EXIT INT HUP TERM

# ------------------------------------------------------------------ source ----
# A GitHub owner is 1-39 letters, digits or hyphens, not starting with a
# hyphen. Anything else is refused by name before it reaches a URL. The
# letters are spelled out rather than written as ranges or [:alnum:], both of
# which can admit non-ASCII characters under some locales.
_owner_chars='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
case "$OWNER" in
-* | *[!"$_owner_chars"-]*)
	die "$OWNER_VAR=\"$OWNER\" is not a GitHub owner name (letters, digits and hyphens, not starting with a hyphen)"
	;;
esac
[ "${#OWNER}" -le 39 ] ||
	die "$OWNER_VAR=\"$OWNER\" is longer than a GitHub owner name can be (39 characters)"

# The repo the tarball comes from. burrow-cli first, then its name before
# 0.9.0, tried ONLY when burrow-cli answers 404. That is right before
# `gh repo rename` (burrow-cli 404s) and after it (burrow-cli answers, and the
# old name is never asked), without relying on GitHub's rename redirect.
# BURROW_CLI_REPO names one repo instead, with no fallback; it is new in 0.9.0,
# so it has no SUITE_* twin. Validated like the owner, before any fetch.
_repo_chars="${_owner_chars}._"
if [ -n "${BURROW_CLI_REPO:-}" ]; then
	case "$BURROW_CLI_REPO" in
	-* | .* | *..* | *[!"$_repo_chars"-]*)
		die "BURROW_CLI_REPO=\"$BURROW_CLI_REPO\" is not a GitHub repository name (letters, digits, '-', '_' or '.', not starting with '-' or '.')"
		;;
	esac
	[ "${#BURROW_CLI_REPO}" -le 100 ] ||
		die "BURROW_CLI_REPO=\"$BURROW_CLI_REPO\" is longer than a GitHub repository name can be (100 characters)"
	REPO_NAMES="$BURROW_CLI_REPO"
else
	REPO_NAMES="burrow-cli suite-cli"
fi

# The ref reaches URLs and is word-split below, so it is refused by name unless
# it is a plain branch, tag, refs/... or SHA: the same set `burrow update`
# accepts (src/commands/update.ts SAFE_REF).
case "$REF" in
"" | [!"$_repo_chars"]* | *[!"$_repo_chars"/-]* | *..*)
	die "the ref \"$REF\" (BURROW_CLI_REF or SUITE_CLI_REF) is not a plain branch, tag or commit"
	;;
esac

# The codeload paths to try, in order (src/repo_source.ts codeloadRefPaths is
# the same rule). MEASURED 2026-10-18: /tar.gz/refs/tags/v0.8.0 200,
# /tar.gz/refs/heads/v0.8.0 404, so a bare name read as a branch can never
# install a tag.
#   40-hex SHA, refs/heads/*, refs/tags/*  verbatim, one path
#   anything else                          refs/heads/<name>, then
#                                          refs/tags/<name> on a 404
# A branch still wins over a tag of the same name.
case "$REF" in
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f] | refs/heads/* | refs/tags/*)
	REF_PATHS="$REF"
	;;
*)
	REF_PATHS="refs/heads/$REF refs/tags/$REF"
	;;
esac

# -------------------------------------------------------------- platform ----
detect_platform() {
	uname_s="$(uname -s 2>/dev/null || echo unknown)"
	case "$uname_s" in
	Darwin) echo "macOS" ;;
	Linux) echo "Linux" ;;
	MINGW* | MSYS* | CYGWIN* | Windows_NT)
		die "Windows is not supported. burrow supports macOS and Linux only."
		;;
	*)
		die "unsupported platform \"$uname_s\". burrow supports macOS and Linux only."
		;;
	esac
}

# ------------------------------------------------------------ install dir ----
resolve_bin_dir() {
	if [ -n "${XDG_BIN_HOME:-}" ]; then
		echo "$XDG_BIN_HOME"
	else
		echo "$HOME/.local/bin"
	fi
}

# The library lives at <data>/burrow/cli from 0.9.0. The pre-0.9.0
# <data>/suite/cli is never moved or deleted here: a running watch daemon may
# still be executing from it. It is retired, and burrow doctor lists it.
resolve_lib_dir() {
	if [ -n "${XDG_DATA_HOME:-}" ]; then
		echo "$XDG_DATA_HOME/burrow/cli"
	else
		echo "$HOME/.local/share/burrow/cli"
	fi
}

# Print a path with $HOME collapsed to ~, for display only.
pretty_path() {
	case "$1" in
	"$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
	*) printf '%s' "$1" ;;
	esac
}

on_path() {
	# on_path <dir> -- true when dir is an element of $PATH
	_needle="$1"
	_ifs="$IFS"
	IFS=:
	for _entry in ${PATH:-}; do
		if [ "$_entry" = "$_needle" ]; then
			IFS="$_ifs"
			return 0
		fi
	done
	IFS="$_ifs"
	return 1
}

# ------------------------------------------------------------------ fetch ----
# The repo may be private, in which case unauthenticated fetches against
# codeload.github.com return 404. A GH_TOKEN may already be exported by
# `suite update`; if not, resolve one from `gh` when available. When no
# token is found the fetch falls back to unauthenticated, which still works
# if the repo is ever made public.
resolve_gh_token() {
	if [ -n "${GH_TOKEN:-}" ]; then
		return 0
	fi
	if command -v gh >/dev/null 2>&1; then
		GH_TOKEN="$(gh auth token 2>/dev/null || true)"
		export GH_TOKEN
	fi
}

# FETCH_CODE: the HTTP status of the last fetch when it is known ("404"), else
# empty. Only a 404 moves on to the next candidate URL.
FETCH_CODE=""

fetch() {
	# fetch <url> <dest-file>. Downloads to the caller's temp path only; the
	# caller moves it into place. A partial file must never reach the
	# destination.
	resolve_gh_token
	FETCH_CODE=""
	if command -v curl >/dev/null 2>&1; then
		# --fail turns an HTTP error into a non-zero exit rather than a body;
		# -w still prints the status, which is how a 404 is told apart.
		#
		# "${GH_TOKEN:-}", not "$GH_TOKEN": under `set -u` an unset parameter
		# kills the whole script. When gh is not on PATH (the shape of the CI
		# container, and of a bare curl|sh install), resolve_gh_token never
		# assigns the variable, and the bare form dies instantly with
		# "GH_TOKEN: parameter not set" and exit 2.
		if [ -n "${GH_TOKEN:-}" ]; then
			FETCH_CODE="$(curl -fsSL -w '%{http_code}' -H "Authorization: token ${GH_TOKEN}" "$1" -o "$2")" && return 0
		else
			FETCH_CODE="$(curl -fsSL -w '%{http_code}' "$1" -o "$2")" && return 0
		fi
		return 1
	elif command -v wget >/dev/null 2>&1; then
		# wget has no status report; -S prints the response headers on stderr,
		# and the last status line is the one that counted.
		_hdrs="$TMPDIR_SUITE/wget-headers"
		if [ -n "${GH_TOKEN:-}" ]; then
			wget -q -S --header="Authorization: token ${GH_TOKEN}" -O "$2" "$1" 2>"$_hdrs" && return 0
		else
			wget -q -S -O "$2" "$1" 2>"$_hdrs" && return 0
		fi
		FETCH_CODE="$(sed -n 's/^ *HTTP\/[0-9.]* \([0-9][0-9][0-9]\).*/\1/p' "$_hdrs" | sed -n '$p')"
		return 1
	else
		die "neither curl nor wget is available to download burrow-cli"
	fi
}

# ----------------------------------------------------------------- prompt ----
# Reads a single line. When piped through sh the script itself owns stdin, so
# prefer the controlling terminal and fall back to stdin (which is what the
# tests drive).
ask() {
	# The prompt is printed by the caller so that it lands on stdout rather
	# than being swallowed by the command substitution reading this reply.
	_reply=""
	if [ -r /dev/tty ] && [ -t 0 ]; then
		IFS= read -r _reply </dev/tty || _reply=""
	else
		IFS= read -r _reply || _reply=""
	fi
	printf '%s' "$_reply"
}

# ------------------------------------------------------------------- main ----
platform="$(detect_platform)"
bin_dir="$(resolve_bin_dir)"
lib_dir="$(resolve_lib_dir)"
# Two launchers, both RENDERED from one template (never a symlink): `burrow`,
# and `suite`, the old name kept as an alias. A `suite` left by an earlier
# install is overwritten by the alias, never left behind as the old launcher.
dest="$bin_dir/burrow"
alias_dest="$bin_dir/suite"

TMPDIR_SUITE="$(mktemp -d "${TMPDIR:-/tmp}/suite-install.XXXXXX")" ||
	die "could not create a temporary directory"

tarball="$TMPDIR_SUITE/burrow-cli.tar.gz"
# Every URL tried, with what it answered, so a failure names all of them.
tried=""
TARBALL_URL=""
if [ -n "$TARBALL_OVERRIDE" ]; then
	fetch "$TARBALL_OVERRIDE" "$tarball" ||
		die "could not download burrow-cli from $TARBALL_OVERRIDE"
	TARBALL_URL="$TARBALL_OVERRIDE"
else
	for _repo in $REPO_NAMES; do
		for _path in $REF_PATHS; do
			_url="https://codeload.github.com/${OWNER}/${_repo}/tar.gz/${_path}"
			if fetch "$_url" "$tarball"; then
				TARBALL_URL="$_url"
				break 2
			fi
			tried="${tried}${tried:+, }$_url (${FETCH_CODE:-failed})"
			# Only a 404 means "not here, try the next name". Anything else
			# (a 5xx, no network, a refused token) stops now, rather than
			# installing from a place the operator did not ask for.
			[ "$FETCH_CODE" = "404" ] || die "could not download burrow-cli from $tried"
		done
	done
	[ -n "$TARBALL_URL" ] || die "could not download burrow-cli from $tried"
fi
[ -s "$tarball" ] || die "downloaded an empty archive from $TARBALL_URL"

extract_dir="$TMPDIR_SUITE/extract"
mkdir -p "$extract_dir"
tar -xzf "$tarball" -C "$extract_dir" ||
	die "could not extract the downloaded archive"

# The archive has a single top-level directory, `<repo>-<ref>`, from
# whichever repo name answered. Its name is not checked; package.json is.
src_root=""
for candidate in "$extract_dir"/*; do
	if [ -d "$candidate" ] && [ -f "$candidate/package.json" ]; then
		src_root="$candidate"
		break
	fi
done
[ -n "$src_root" ] || die "the downloaded archive does not look like burrow-cli"
[ -f "$src_root/bin/burrow.template" ] ||
	die "the downloaded archive is missing bin/burrow.template"

version="$(
	sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
		"$src_root/package.json" | head -n 1
)"
[ -n "$version" ] || die "could not read the version from the downloaded package.json"

# --- an existing install is named and announced, never clobbered silently ---
# `burrow` first, then `suite`: a host installed before the rename has only
# `suite`, and is announced under that name. stderr is discarded because the
# `suite` alias prints its notice there; stdout is the version alone.
existing_name=""
existing_path=""
if [ -e "$dest" ]; then
	existing_name="burrow"
	existing_path="$dest"
elif [ -e "$alias_dest" ]; then
	existing_name="suite"
	existing_path="$alias_dest"
fi
if [ -n "$existing_path" ]; then
	existing="$("$existing_path" --version 2>/dev/null || echo "unknown version")"
	if [ "$existing" = "$version" ]; then
		note "$existing_name $version is already installed at $(pretty_path "$existing_path")"
		note "reinstalling the same version."
	else
		note "$existing_name $existing is already installed at $(pretty_path "$existing_path")"
		note "replace it with $version? [y/N]"
		reply="$(ask)"
		case "$reply" in
		y | Y | yes | YES | Yes) : ;;
		*)
			printf '\n'
			note "keeping $existing_name $existing. nothing changed."
			exit 0
			;;
		esac
	fi
	printf '\n'
fi

# --- stage everything, then move into place ---------------------------------
staged_lib="$TMPDIR_SUITE/lib"
mkdir -p "$staged_lib"
cp -R "$src_root/src" "$staged_lib/src" || die "could not stage the burrow-cli sources"
cp "$src_root/package.json" "$staged_lib/package.json" ||
	die "could not stage package.json"
if [ -f "$src_root/bun.lock" ]; then
	cp "$src_root/bun.lock" "$staged_lib/bun.lock" || die "could not stage bun.lock"
fi

# Runtime dependencies are not in the tarball. Install them now when bun is
# available so a missing dependency fails the install, not the first verb.
# Without bun yet, the launcher installs them on its first run.
if command -v bun >/dev/null 2>&1 || [ -x "${BUN_INSTALL:-$HOME/.bun}/bin/bun" ]; then
	_bun="$(command -v bun 2>/dev/null || printf '%s' "${BUN_INSTALL:-$HOME/.bun}/bin/bun")"
	(cd "$staged_lib" && "$_bun" install --production >/dev/null 2>&1) ||
		die "could not install runtime dependencies (bun install --production)"
fi

# assets/ ships too, and its absence is FATAL rather than a warning.
#
# `suite deepseek` materialises the federation plugin out of
# assets/dsh-plugins/ on every run — that is how upgrading the CLI upgrades
# the plugin without a second publish step. An install that omits it produces
# a CLI whose deepseek verb fails at the last moment with "the bundled
# federation plugin was not found", pointing at a directory the installer
# never created. Every `suite update` reintroduced that until this line
# existed.
cp -R "$src_root/assets" "$staged_lib/assets" ||
	die "could not stage assets/ — suite deepseek needs the bundled plugin"

# render_launcher <name> <output>: one template, rendered per name.
render_launcher() {
	sed -e "s|@BURROW_LIB_DIR@|$lib_dir|g" -e "s|@BURROW_VERSION@|$version|g" \
		-e "s|@BURROW_INVOKED_AS@|$1|g" \
		"$src_root/bin/burrow.template" >"$2" ||
		die "could not render the $1 entrypoint"
	chmod 0755 "$2" || die "could not make the $1 entrypoint executable"
}
staged_bin="$TMPDIR_SUITE/burrow"
staged_alias="$TMPDIR_SUITE/suite"
render_launcher burrow "$staged_bin"
render_launcher suite "$staged_alias"

mkdir -p "$bin_dir" || die "could not create the install directory $bin_dir"
[ -w "$bin_dir" ] || die "$bin_dir is not writable. burrow never uses sudo; set XDG_BIN_HOME to a directory you own."
mkdir -p "$(dirname "$lib_dir")" || die "could not create $(dirname "$lib_dir")"

rm -rf "$lib_dir.incoming"
mv "$staged_lib" "$lib_dir.incoming" || die "could not stage the library directory"
rm -rf "$lib_dir.previous"
if [ -d "$lib_dir" ]; then
	mv "$lib_dir" "$lib_dir.previous" || die "could not move the previous install aside"
fi
mv "$lib_dir.incoming" "$lib_dir" || die "could not install the burrow-cli library"
rm -rf "$lib_dir.previous"

mv "$staged_bin" "$dest" || die "could not install the burrow entrypoint to $dest"
mv "$staged_alias" "$alias_dest" || die "could not install the suite alias to $alias_dest"

# ---------------------------------------------------------------- report ----
printf '\n'
row "burrow $version" "$(pretty_path "$dest")"
row "suite (alias)" "$(pretty_path "$alias_dest")"
row "platform" "$platform"
if on_path "$bin_dir"; then
	row "PATH" "$(pretty_path "$bin_dir") is already on PATH"
	printf '\n'
else
	row "PATH" "$(pretty_path "$bin_dir") is not on PATH"
	note "add this line to your shell profile, then reopen your shell:"
	printf '\n'
	# shellcheck disable=SC2016  # $PATH is meant to stay literal: the user
	# pastes this line into a shell profile, where it expands at that point.
	printf 'export PATH="%s:$PATH"\n' "$bin_dir"
	printf '\n'
fi
# Last line: the next command, at zero indent, alone, so it can be
# double-clicked and pasted without dragging leading whitespace.
printf 'burrow init\n'
