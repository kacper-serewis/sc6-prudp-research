#!/usr/bin/env bash
# Launches Splinter Cell: Blacklist under Wine with DXMT.
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
source "$(cd "$(dirname "$0")" && pwd)/env.sh"

exe=Blacklist_DX11_game.exe
case "${1:-}" in
  dx11) shift ;;
  dx9) exe=Blacklist_game.exe; shift ;;
esac

cd "$GAME_SYSTEM_DIR"
exec wine "$exe" "$@"
