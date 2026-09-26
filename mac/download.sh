#!/usr/bin/env bash
# Downloads the Windows build of Splinter Cell: Blacklist (Steam app 235600) into the wrapper's
# Wine prefix, using the native macOS steamcmd with the platform forced to Windows.
#
# Usage: mac/download.sh <steam_username>
#
# steamcmd asks for your password and Steam Guard code interactively. The login is cached
# afterwards, so re-running (e.g. to verify files) usually only needs the username.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/env.sh"

if [ $# -lt 1 ]; then
  echo "usage: $0 <steam_username>" >&2
  exit 1
fi

steamcmd_dir="$SC6_CACHE/steamcmd"
if [ ! -x "$steamcmd_dir/steamcmd.sh" ]; then
  echo "==> Installing steamcmd into $steamcmd_dir"
  mkdir -p "$steamcmd_dir"
  curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_osx.tar.gz | tar -xz -C "$steamcmd_dir"
fi

mkdir -p "$GAME_DIR"
"$steamcmd_dir/steamcmd.sh" \
  +@sSteamCmdForcePlatformType windows \
  +force_install_dir "$GAME_DIR" \
  +login "$1" \
  +app_update 235600 validate \
  +quit
