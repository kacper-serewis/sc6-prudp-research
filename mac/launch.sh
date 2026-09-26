#!/usr/bin/env bash
# Launches Splinter Cell: Blacklist under Wine with DXMT, with the Rosetta CPUID fix (see patch-cpuid.py).
#
# Usage: mac/launch.sh [dx11|dx9] [game args...]
#
# Useful env vars:
#   WINEDEBUG=err+all        show Wine errors (default: silent)
#   DXMT_LOG_LEVEL=info      DXMT logging (writes <exe>_d3d11.log / _dxgi.log to DXMT_LOG_PATH)
#   DXMT_LOG_PATH=/some/dir
#   MTL_HUD_ENABLED=1        Apple's Metal performance HUD
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
# Start the game under winedbg, which fixes the CMPXCHG8B check in memory at the initial
# breakpoint and detaches (see patch-cpuid.py). Then wait for the game to exit.
python3 "$script_dir/patch-cpuid.py" "$exe" | wine winedbg "C:\\Games\\Blacklist\\src\\SYSTEM\\$exe" "$@" >/dev/null
wineserver -w
