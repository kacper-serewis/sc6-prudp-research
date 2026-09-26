#!/usr/bin/env bash
# Sets up Splinter Cell: Blacklist on an Apple Silicon Mac. See mac/README.md for the why.
#
# Usage: mac/setup.sh [steam_username]
#
# Every step is idempotent: re-running skips whatever is already done. The Steam username
# is only needed if the game hasn't been downloaded yet.
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
source "$script_dir/env.sh"

steam_user="${1:-}"

# Pinned artifacts. Sikarugir sometimes re-uploads assets under the same name; if a checksum
# fails, check the release page and update the hash (or set SC6_SKIP_CHECKSUMS=1).
TEMPLATE_URL=https://github.com/Sikarugir-App/Template/releases/download/v1.0/Template-1.0.19.tar.xz
TEMPLATE_SHA256=ce9e4150fd2f0f3e8694814d82133eaaae1b1aabe5b8f2479155b88271cf5f9f
ENGINE_URL=https://github.com/Sikarugir-App/Engines/releases/download/v1.0/WS12WineSikarugir11.0.tar.xz
ENGINE_SHA256=dcb3de3acab2eaf37591768dc7f6f6c20fa8e6b69c88ddd61e63798c02befcf9
ECHELON_URL=https://github.com/unixoide/5th-echelon/releases/download/v0.2.5/5th-echelon.zip
ECHELON_SHA256=8bf98208985f647fde57f40387307a239dcf164210ad360f2638e8f4d85c8ccb

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
skip() { printf '    skip: %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

fetch() { # fetch <url> <sha256> -> prints local path
  local url=$1 sha=$2 out
  out="$SC6_CACHE/$(basename "$url")"
  if [ ! -f "$out" ]; then
    echo "    downloading $(basename "$out")" >&2
    curl -fL --progress-bar -o "$out.part" "$url"
    mv "$out.part" "$out"
  fi
  if [ -z "${SC6_SKIP_CHECKSUMS:-}" ]; then
    echo "$sha  $out" | shasum -a 256 -c --status || die "checksum mismatch for $out"
  fi
  echo "$out"
}

[ "$(uname -s)" = Darwin ] || die "macOS only"
mkdir -p "$SC6_CACHE" "$(dirname "$SC6_APP")"

step "Rosetta 2"
if arch -x86_64 /usr/bin/true 2>/dev/null; then
  skip "already installed"
else
  softwareupdate --install-rosetta --agree-to-license
fi

step "Wrapper app ($SC6_APP)"
if [ -x "$WINE_ROOT/bin/wine" ]; then
  skip "already built"
else
  [ -e "$SC6_APP" ] && die "$SC6_APP exists but has no Wine engine; move it away first"
  template=$(fetch "$TEMPLATE_URL" "$TEMPLATE_SHA256")
  engine=$(fetch "$ENGINE_URL" "$ENGINE_SHA256")
  tmp=$(mktemp -d "$SC6_CACHE/build.XXXXXX")
  tar -xf "$template" -C "$tmp"
  tar -xf "$engine" -C "$tmp"
  mv "$tmp"/Template-*.app "$SC6_APP"
  mv "$tmp/wswine.bundle" "$WINE_ROOT"
  rm -rf "$tmp"
  xattr -dr com.apple.quarantine "$SC6_APP" 2>/dev/null || true
  plist="$SC6_APP/Contents/Info.plist"
  plutil -replace CFBundleName -string "Splinter Cell Blacklist" "$plist"
  # Path is relative to drive_c; used when the .app is opened from Finder.
  plutil -replace "Program Name and Path" -string "/Games/Blacklist/src/SYSTEM/Blacklist_DX11_game.exe" "$plist"
fi

step "Wine prefix"
if [ -f "$WINEPREFIX/system.reg" ]; then
  skip "already created"
else
  "$SC6_APP/Contents/MacOS/wineskinlauncher" WSS-wineprefixcreate
fi

step "Game files (Steam app 235600)"
if [ -f "$GAME_SYSTEM_DIR/Blacklist_DX11_game.exe" ]; then
  skip "already downloaded"
else
  [ -n "$steam_user" ] || die "game not downloaded yet; re-run as: $0 <steam_username>"
  "$script_dir/download.sh" "$steam_user"
fi

step "VC++ 2010 and DirectX June 2010 redistributables"
marker="$WINEPREFIX/.sc6-redists-installed"
if [ -f "$marker" ]; then
  skip "already installed"
else
  # The exe imports d3dx11_43, d3dx10_43, d3dcompiler_43 and xinput1_3; Wine's builtin
  # d3dx versions are incomplete, so install Microsoft's from the redist Steam ships.
  (cd "$GAME_DIR/_CommonRedist" &&
    wine vcredist/2010/vcredist_x86.exe /q /norestart &&
    wine DirectX/Jun2010/DXSETUP.exe /silent)
  for dll in d3dx9_43 d3dx10_43 d3dx11_43 d3dcompiler_43; do
    wine reg add 'HKCU\Software\Wine\DllOverrides' /v "$dll" /t REG_SZ /d native,builtin /f >/dev/null
  done
  touch "$marker"
fi

step "Registry keys from Steam's install script"
# shellcheck disable=SC1003 # trailing backslash is literal
wine reg add 'HKLM\SOFTWARE\Ubisoft\Splinter Cell Blacklist' /v installdir /t REG_SZ /d 'C:\Games\Blacklist\' /f /reg:32 >/dev/null
wine reg add 'HKLM\SOFTWARE\Ubisoft\Splinter Cell Blacklist' /v ExecPath /t REG_SZ /d 'C:\Games\Blacklist\Blacklist_Launcher.exe' /f /reg:32 >/dev/null
echo "    done"

step "5th-echelon uplay_r1_loader shim (replaces Ubisoft Connect)"
if [ -f "$GAME_SYSTEM_DIR/uplay_r1_loader.orig.dll" ]; then
  skip "already installed"
else
  zip=$(fetch "$ECHELON_URL" "$ECHELON_SHA256")
  # The shim loads the original as uplay_r1_loader.orig.dll and refuses to start without it.
  mv "$GAME_SYSTEM_DIR/uplay_r1_loader.dll" "$GAME_SYSTEM_DIR/uplay_r1_loader.orig.dll"
  unzip -o -j -q "$zip" uplay_r1_loader.dll -d "$GAME_SYSTEM_DIR"
fi
if [ -f "$GAME_SYSTEM_DIR/uplay.toml" ]; then
  skip "uplay.toml exists, leaving it alone"
else
  cp "$script_dir/uplay.toml" "$GAME_SYSTEM_DIR/uplay.toml"
fi

wineserver -w
step "Done. Start the game with: $script_dir/launch.sh"
