#!/usr/bin/env bash
# Launches Blacklist under Wine with DXMT and the CPUID/NLA compatibility fixes.
#
# Usage: mac/launch.sh [dx11|dx9] [game args...]
#
# Useful env vars:
#   WINEDEBUG=err+all        show Wine errors (default: silent)
#   DXMT_LOG_LEVEL=info      DXMT logging (writes <exe>_d3d11.log / _dxgi.log to DXMT_LOG_PATH)
#   DXMT_LOG_PATH=/some/dir
#   MTL_HUD_ENABLED=1        Apple's Metal performance HUD
#   SC6_NLA_WORKAROUND=0     disable the Wine network-availability workaround
#   SC6_WINDOW_LAYOUT=off   leave window placement to Wine (default: side by side)
#
# The 5th-echelon shim logs to $GAME_SYSTEM_DIR/bl-tracing.log.
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
source "$script_dir/env.sh"

exe=Blacklist_DX11_game.exe
case "${1:-}" in
  dx11) shift ;;
  dx9) exe=Blacklist_game.exe; shift ;;
esac

cd "$GAME_SYSTEM_DIR"
# Start the game under winedbg, which applies compatibility fixes in memory at the initial
# breakpoint and detaches (see patch-cpuid.py). Then wait for the game to exit.
patch_args=("$exe")
if [[ "${SC6_NLA_WORKAROUND:-1}" != 0 ]]; then
  patch_args+=(--nla)
fi
# Generate first: if binary validation fails, do not start the game.
patch_commands="$(python3 "$script_dir/patch-cpuid.py" "${patch_args[@]}")"
printf '%s\n' "$patch_commands" | wine winedbg "C:\\Games\\Blacklist\\src\\SYSTEM\\$exe" "$@" >/dev/null
if [[ "${SC6_WINDOW_LAYOUT:-side-by-side}" != off ]]; then
  swift "$script_dir/arrange-windows.swift" "$SC6_APP" &
fi
wineserver -w
