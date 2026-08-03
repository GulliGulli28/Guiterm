#!/bin/sh
# Guiterm — macOS installer.
#
#   curl -fsSL https://raw.githubusercontent.com/GulliGulli28/Guiterm/master/scripts/install-macos.sh | sh
#
# Why this script exists, in one paragraph: Guiterm is not signed with an
# Apple Developer ID yet (see RELEASING.md for what that would take). macOS
# attaches a `com.apple.quarantine` attribute to everything a *browser*
# downloads, then refuses to open a quarantined app it can't verify — with
# the alarming "is damaged and can't be opened, move it to the Trash"
# wording, since the app carries only the ad-hoc signature the linker puts on
# every arm64 binary. `curl` does not set that attribute, so an app fetched
# this way opens normally on first double-click.
#
# Be clear-eyed about what that means: this works around a macOS security
# check rather than satisfying it. You are trusting GitHub's TLS and this
# repository, and nothing here proves the app is safe — read the script
# before piping it into a shell, which is advice that applies to every
# `curl | sh` installer, this one included.
set -eu

REPO="GulliGulli28/Guiterm"
APP_NAME="Guiterm.app"
DEST="${GUITERM_INSTALL_DIR:-/Applications}"

info() { printf '==> %s\n' "$1"; }
die() { printf 'error: %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this installer is for macOS only."

case "$(uname -m)" in
  arm64)  arch_re='aarch64'    ; arch_label='Apple Silicon' ;;
  x86_64) arch_re='x64|x86_64' ; arch_label='Intel' ;;
  *)      die "unsupported architecture: $(uname -m)." ;;
esac

info "Looking up the latest release ($arch_label)..."
release=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest") ||
  die "could not reach the GitHub API."

# The updater artifact (.app.tar.gz) rather than the .dmg: it holds the same
# bundle, needs no disk image to mount, and the trailing `$` keeps the
# matching `.sig` file out of the way.
url=$(printf '%s' "$release" |
  grep -o '"browser_download_url": *"[^"]*"' |
  sed 's/.*"\(https[^"]*\)"$/\1/' |
  grep -E '\.app\.tar\.gz$' |
  grep -E "$arch_re" |
  head -n 1)

if [ -z "$url" ]; then
  die "the latest release has no $arch_label build.
  Releases before this message was written shipped Apple Silicon only.
  See https://github.com/$REPO/releases to check, and please open an issue."
fi

if pgrep -x guiterm >/dev/null 2>&1; then
  die "Guiterm is currently running — quit it first, then run this again."
fi

[ -d "$DEST" ] || die "$DEST does not exist."
[ -w "$DEST" ] || die "$DEST is not writable by $(id -un).
  Either re-run this script with sudo, or install somewhere you own:
  GUITERM_INSTALL_DIR=\"\$HOME/Applications\" sh install-macos.sh"

tmp=$(mktemp -d)
# shellcheck disable=SC2064  # $tmp must expand now, not when the trap fires.
trap "rm -rf '$tmp'" EXIT INT TERM

info "Downloading $(basename "$url")..."
curl -fL --progress-bar -o "$tmp/guiterm.tar.gz" "$url" || die "download failed."

info "Unpacking..."
tar xzf "$tmp/guiterm.tar.gz" -C "$tmp" || die "the archive could not be unpacked."
[ -d "$tmp/$APP_NAME" ] || die "unexpected archive layout: no $APP_NAME inside."

if [ -e "$DEST/$APP_NAME" ]; then
  info "Replacing the existing copy in $DEST..."
  rm -rf "$DEST/$APP_NAME"
fi

mv "$tmp/$APP_NAME" "$DEST/$APP_NAME"

# Defensive, and normally a no-op: curl leaves no quarantine attribute. It
# matters if someone downloads this script's tarball through a browser first
# and only then runs the script over it.
xattr -dr com.apple.quarantine "$DEST/$APP_NAME" 2>/dev/null || true

info "Installed to $DEST/$APP_NAME"
info "Launch it with:  open -a Guiterm"
info ""
info "Updates from inside the app work the same way — they are downloaded by"
info "the app itself, not by a browser, so they are never quarantined."
