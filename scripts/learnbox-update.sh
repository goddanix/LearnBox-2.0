#!/bin/bash
# Learnbox 2.0 update — build, archive, install, restart (macOS, Intel, local use).
#
#   npm run learnbox:update                 build + archive + replace /Applications/Learnbox 2.0.app + restart
#   npm run learnbox:update -- --list       the archived releases, newest first
#   npm run learnbox:update -- --rollback   install the release before the newest one
#   npm run learnbox:update -- --install <file.dmg>   install a specific archived release
#   npm run learnbox:update -- --widget     build + install only the macOS widget (Learnbox 2.0 Widget.app)
#   npm run learnbox:update -- --widget-remove   move the widget app to the Trash
#   add --reset-mic to any install to clear the microphone permission first
#
# Every build is archived as ~/Learnbox-Build/releases/Learnbox 2.0-<version>+<date-time>.dmg; the
# newest KEEP stay, older ones are deleted. Nothing touches the installed app until the new
# one exists and its signature verifies, so a failed build leaves the working app alone.
# The previous app goes to the Trash (restorable) — that includes the app of the time before the
# rename, /Applications/Learnbox.app, which "Learnbox 2.0" replaces. Your data lives outside the
# app, in ~/Library/Application Support/Learnbox (the folder keeps its name), and is never touched.
#
# The macOS widget (Learnbox 2.0 Widget.app: widget + companion + helper, scripts/build-widget.mjs) is built and
# installed after a full update; a failed widget build never undoes the app update. It starts at login (its first
# launch registers it as a login item) and reads your study data read-only. Add it on the desktop or in the
# Notification Center: right-click → Edit Widgets → Learnbox 2.0.
#
# Why not auto-update: macOS only lets an app replace itself with a package whose signature it can
# verify against a developer certificate. This build is ad-hoc signed, so the update is a command.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_ROOT="$HOME/Learnbox-Build"
WORK="$BUILD_ROOT/_work"
RELEASES="$BUILD_ROOT/releases"
APP_NAME="Learnbox 2.0"
APP="/Applications/$APP_NAME.app"
# the app of the time before the rename (same bundle id, same data folder): replaced by the new one
LEGACY_APP="/Applications/Learnbox.app"
BUNDLE_ID="com.learnbox.Learnbox"
KEEP=3
WIDGET_NAME="Learnbox 2.0 Widget"
WIDGET_APP="/Applications/$WIDGET_NAME.app"
WIDGET_PROCESS="LearnboxWidgetCompanion"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }

list_releases() { ls -1t "$RELEASES"/Learnbox*.dmg 2>/dev/null || true; }

prune_releases() {
	list_releases | tail -n +$((KEEP + 1)) | while IFS= read -r old; do
		rm -f "$old" && echo "removed old release: $(basename "$old")"
	done
}

verify_signature() {
	codesign --verify --deep --strict "$1" 2>/dev/null || die "the signature of $1 is not valid; nothing was changed."
}

# The running app's process name is its executable's name: "Learnbox 2.0", or "Learnbox" for a build
# from before the rename (an old archived release, or the app that is running right now).
running() { pgrep -x "$APP_NAME" >/dev/null || pgrep -x "Learnbox" >/dev/null; }

quit_app() {
	running || return 0
	say "Quitting Learnbox"
	pkill -TERM -x "$APP_NAME" || true
	pkill -TERM -x "Learnbox" || true
	for _ in $(seq 1 30); do
		running || return 0
		sleep 0.5
	done
	echo "Learnbox did not quit in 15 s; forcing it."
	pkill -KILL -x "$APP_NAME" || true
	pkill -KILL -x "Learnbox" || true
	sleep 1
}

# $1 = path of a verified Learnbox app. Moves the installed one(s) to the Trash, copies this one in.
install_app() {
	local src="$1" stamp trashed="" trashed_legacy=""
	verify_signature "$src"
	quit_app
	stamp="$(date +%Y%m%d-%H%M%S)"
	if [ -d "$APP" ]; then
		trashed="$HOME/.Trash/$APP_NAME (alt $stamp).app"
		say "Moving the installed app to the Trash"
		mv "$APP" "$trashed"
	fi
	if [ -d "$LEGACY_APP" ]; then
		trashed_legacy="$HOME/.Trash/Learnbox (alt $stamp).app"
		say "Moving the app from before the rename (Learnbox.app) to the Trash"
		mv "$LEGACY_APP" "$trashed_legacy"
	fi
	say "Installing $src"
	if ! ditto "$src" "$APP" || ! codesign --verify --deep --strict "$APP" 2>/dev/null; then
		rm -rf "$APP"
		[ -n "$trashed" ] && mv "$trashed" "$APP" && echo "Install failed; the previous app is back in place." >&2
		[ -n "$trashed_legacy" ] && mv "$trashed_legacy" "$LEGACY_APP" && echo "Install failed; the previous app is back in place." >&2
		die "installing the new app failed."
	fi
	[ "$RESET_MIC" = "1" ] && { say "Resetting the microphone permission"; tccutil reset Microphone "$BUNDLE_ID" || true; }
	say "Starting $APP_NAME"
	open "$APP"
}

install_dmg() {
	local dmg="$1" mount
	[ -f "$dmg" ] || die "no such file: $dmg"
	mount="$(mktemp -d /tmp/learnbox-mount.XXXXXX)"
	hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount" -quiet || die "could not open $dmg"
	# Detach on any exit path from here, including a failed install.
	# (double quotes: `mount` is local to this function and gone when the EXIT trap fires)
	trap "hdiutil detach '$mount' -quiet >/dev/null 2>&1 || true; rmdir '$mount' 2>/dev/null || true" EXIT
	# the app inside carries the name of its time: "Learnbox 2.0.app", or "Learnbox.app" in an old release
	local inside
	inside="$(ls -d "$mount"/Learnbox*.app 2>/dev/null | head -1)"
	[ -n "$inside" ] && [ -d "$inside" ] || die "$dmg contains no Learnbox app"
	install_app "$inside"
}

build_and_archive() {
	say "Building $APP_NAME (a few minutes)"
	( cd "$ROOT" && npm run desktop:dist:intel )
	local built_app="$WORK/mac/$APP_NAME.app" built_dmg
	built_dmg="$(ls -1t "$WORK"/Learnbox*.dmg 2>/dev/null | head -1)"
	[ -d "$built_app" ] && [ -n "$built_dmg" ] || die "the build produced no app or no DMG."
	verify_signature "$built_app"

	local version stamp archive
	version="$(cd "$ROOT" && node -p "require('./package.json').version")"
	stamp="$(date +%Y%m%d-%H%M)"
	archive="$RELEASES/$APP_NAME-${version}+${stamp}.dmg"
	mkdir -p "$RELEASES"
	cp "$built_dmg" "$archive"
	say "Archived $(basename "$archive")"
	prune_releases
	install_app "$built_app"
	# the widget never blocks the app update: the app is installed already
	if ( build_widget && install_widget ); then :; else echo "Warning: the widget was not updated (see above); the app update is done." >&2; fi
}

# The companion's process name is its executable's name.
quit_widget() {
	pgrep -x "$WIDGET_PROCESS" >/dev/null || return 0
	say "Quitting the widget companion"
	pkill -TERM -x "$WIDGET_PROCESS" || true
	for _ in $(seq 1 10); do
		pgrep -x "$WIDGET_PROCESS" >/dev/null || return 0
		sleep 0.5
	done
	pkill -KILL -x "$WIDGET_PROCESS" || true
}

# Moves the installed widget app to the Trash (restorable) and drops its registration, so macOS does not
# see two widgets with one id.
trash_widget() {
	[ -d "$WIDGET_APP" ] || return 0
	local trashed="$HOME/.Trash/$WIDGET_NAME (alt $(date +%Y%m%d-%H%M%S)).app"
	mv "$WIDGET_APP" "$trashed"
	"$LSREGISTER" -u "$trashed" >/dev/null 2>&1 || true
	echo "$trashed"
}

build_widget() {
	say "Building $WIDGET_NAME"
	( cd "$ROOT" && node scripts/build-widget.mjs )
	[ -d "$BUILD_ROOT/widget/$WIDGET_NAME.app" ] || die "the widget build produced no app."
}

install_widget() {
	local src="$BUILD_ROOT/widget/$WIDGET_NAME.app" trashed
	verify_signature "$src"
	quit_widget
	say "Installing $WIDGET_NAME"
	trashed="$(trash_widget)"
	if ! ditto "$src" "$WIDGET_APP" || ! codesign --verify --deep --strict "$WIDGET_APP" 2>/dev/null; then
		rm -rf "$WIDGET_APP"
		[ -n "$trashed" ] && mv "$trashed" "$WIDGET_APP" && echo "Install failed; the previous widget app is back in place." >&2
		die "installing the widget app failed."
	fi
	"$LSREGISTER" -f -R -trusted "$WIDGET_APP" >/dev/null 2>&1 || true
	pluginkit -a "$WIDGET_APP/Contents/PlugIns/LearnboxWidget.appex" >/dev/null 2>&1 || true
	open -g "$WIDGET_APP"
	echo "Widget installed. Add it: right-click the desktop → Edit Widgets → Learnbox 2.0."
	echo "The companion starts at login (System Settings → General → Login Items & Extensions)."
}

MODE="update"
DMG=""
RESET_MIC=0
while [ $# -gt 0 ]; do
	case "$1" in
		--list) MODE="list" ;;
		--rollback) MODE="rollback" ;;
		--install) MODE="install"; shift; DMG="${1:-}"; [ -n "$DMG" ] || die "--install needs a DMG file." ;;
		--widget) MODE="widget" ;;
		--widget-remove) MODE="widget-remove" ;;
		--reset-mic) RESET_MIC=1 ;;
		-h|--help) sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) die "unknown option: $1 (see --help)" ;;
	esac
	shift
done

case "$MODE" in
	list)
		releases="$(list_releases)"
		[ -n "$releases" ] || { echo "No archived releases yet."; exit 0; }
		echo "$releases" | while IFS= read -r f; do printf '%s  %s\n' "$(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$f")" "$f"; done
		;;
	rollback)
		previous="$(list_releases | sed -n 2p)"
		[ -n "$previous" ] || die "there is no older release to go back to."
		say "Rolling back to $(basename "$previous")"
		install_dmg "$previous"
		;;
	install) install_dmg "$DMG" ;;
	widget) build_widget && install_widget ;;
	widget-remove)
		quit_widget
		if [ -d "$WIDGET_APP" ]; then say "Moved to the Trash: $(trash_widget)"; else echo "$WIDGET_NAME is not installed."; fi
		;;
	update) build_and_archive ;;
esac

say "Done"
echo "Microphone: macOS asks again after every new build (ad-hoc signature). If dictation stays silent, run with --reset-mic."
