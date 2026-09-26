# shellcheck shell=bash
# Source this file to get a shell that can run Wine commands against the game's prefix:
#
#   source mac/env.sh
#   wine regedit
#
# It mirrors the environment the Sikarugir wrapper launcher (wineskinlauncher) sets up,
# so Wine works from the command line without going through the .app.

# Where the wrapper app lives. Override before sourcing if you want it elsewhere.
: "${SC6_APP:=$HOME/Applications/Splinter Cell Blacklist.app}"
# Download cache (release tarballs, steamcmd, ...).
: "${SC6_CACHE:=$HOME/Games/sc6}"
export SC6_APP SC6_CACHE

_contents="$SC6_APP/Contents"
export WINE_ROOT="$_contents/SharedSupport/wine"
export WINEPREFIX="$_contents/SharedSupport/prefix"
export GAME_DIR="$WINEPREFIX/drive_c/Games/Blacklist"
export GAME_SYSTEM_DIR="$GAME_DIR/src/SYSTEM"

export PATH="$WINE_ROOT/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# The Sikarugir engine has no rpaths; its dylibs (libinotify, freetype, gnutls, MoltenVK, ...)
# come from the wrapper's Frameworks folder. Without this, Wine can't spawn processes.
export DYLD_FALLBACK_LIBRARY_PATH="$WINE_ROOT/lib:$WINE_ROOT/lib64:$_contents/Frameworks:$_contents/Frameworks/GStreamer.framework/Libraries:/usr/lib:/usr/libexec:/usr/lib/system"
export WINEDLLPATH="$WINE_ROOT/lib/x86_64-windows:$WINE_ROOT/lib/i386-windows:$WINE_ROOT/lib/x86_64-unix"

# DXMT: Metal implementation of D3D10/11. The Sikarugir Wine fork loads DLLs from
# WINEDLLPATH_PREPEND before its own builtins, which is how d3d11/dxgi get replaced.
export WINEDLLPATH_PREPEND="$_contents/Frameworks/renderer/dxmt/wine"
export WINEDLLPATH_DXMT="$_contents/Frameworks/renderer/dxmt/wine"
export DXMT_ALLOW_CROSS_PROCESS_SWAPCHAIN=1

export GST_PLUGIN_PATH="$_contents/Frameworks/GStreamer.framework/Libraries/gstreamer-1.0"
export VK_DRIVER_FILES="$_contents/Resources/vulkan/icd.d/kosmickrisp_mesa_icd.json"
export CX_ROOT="$WINE_ROOT" CX_FWD_COMPAT_GL_CTX=1 SikarugirAppWine11=1
export WINEESYNC=1 WINEMSYNC=1 WINEBOOT_HIDE_DIALOG=1 ROSETTA_ADVERTISE_AVX=1 MTL_HUD_ENABLED=0
export MVK_CONFIG_FAST_MATH_ENABLED=0 MVK_CONFIG_RESUME_LOST_DEVICE=1 MVK_CONFIG_LOG_LEVEL=0
export DOTNET_EnableWriteXorExecute=0 LANG=C.UTF-8
export WINEDEBUG="${WINEDEBUG:--all}"

unset _contents
