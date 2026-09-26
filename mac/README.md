# Running Splinter Cell: Blacklist on an Apple Silicon Mac

These scripts install the Steam (Windows) version of SC:BL on macOS, so the game client can be
pointed at the server in `bun-impl/`. They were tested on an M5 Pro running macOS 27.2 in September 2026.

Everything runs on a free stack:

| Piece | What it does |
| --- | --- |
| [Sikarugir](https://github.com/Sikarugir-App) wrapper template + `WS12WineSikarugir11.0` engine | Wine 11 fork packaged as a `.app`. It supports 32-bit games through WoW64, and the game exe is 32-bit. |
| [DXMT](https://github.com/3Shain/dxmt) (bundled in the template) | Implements D3D10/11 on Metal. |
| Microsoft VC++ 2010 and DirectX June 2010 redistributables (shipped with the game) | Real `d3dx11_43`, `d3dcompiler_43`, `msvcr100`, and so on. |
| [5th-echelon](https://github.com/unixoide/5th-echelon) `uplay_r1_loader.dll` | Stands in for Uplay. The game starts without Ubisoft Connect, and the shim redirects the online config server. |
| macOS `steamcmd` | Downloads the Windows depot without running Steam under Wine. |

## Quick start

```sh
mac/setup.sh <steam_username>   # one-time; asks for your Steam password and Steam Guard code
mac/launch.sh                   # DX11 exe (use `mac/launch.sh dx9` for the DX9 exe)
```

You can also open `~/Applications/Splinter Cell Blacklist.app` from Finder.

You need about 25 GB free: the game is about 20 GB, and the wrapper plus downloads take a few more.

Paths can be overridden with `SC6_APP` (the wrapper app, default
`~/Applications/Splinter Cell Blacklist.app`) and `SC6_CACHE` (downloads and steamcmd, default
`~/Games/sc6`).

## Files

| File | Purpose |
| --- | --- |
| `setup.sh` | Idempotent installer. Re-run it any time; finished steps are skipped. |
| `download.sh` | Downloads or verifies the game with steamcmd (`+@sSteamCmdForcePlatformType windows`). |
| `launch.sh` | Starts the game. |
| `env.sh` | `source` it to run Wine commands against the game's prefix (`wine regedit`, `wine winecfg`, ...). |
| `uplay.toml` | Config template for the 5th-echelon shim. It's copied next to the exe. |

## What `setup.sh` does

1. Installs Rosetta 2. The Wine engine is x86_64.
2. Builds the wrapper app. It extracts the Sikarugir template, puts the engine in
   `Contents/SharedSupport/wine`, and sets the program path in `Info.plist`.
3. Creates the prefix with `wineskinlauncher WSS-wineprefixcreate`. The prefix lives in
   `Contents/SharedSupport/prefix`.
4. Downloads the game into `drive_c/Games/Blacklist` (see `download.sh`).
5. Installs the VC++ 2010 and DirectX June 2010 redistributables from `_CommonRedist`. It sets
   `d3dx9_43`, `d3dx10_43`, `d3dx11_43` and `d3dcompiler_43` to `native,builtin`.
6. Adds the `HKLM\SOFTWARE\Ubisoft\Splinter Cell Blacklist` registry keys that Steam's
   `blacklistinstallscript.vdf` would normally create.
7. Installs the shim. It renames the original `uplay_r1_loader.dll` to
   `uplay_r1_loader.orig.dll`, drops in 5th-echelon's DLL, and copies `uplay.toml`.

## Testing against the server

`bun-impl` serves everything the shim's default `uplay.toml` points at, so no extra config is needed:

```sh
cd bun-impl && bun install && bun run start   # onlineconfig :80, auth :21126, secure :21127, API :50051
mac/launch.sh                                  # in another terminal, then pick online mode in the game
```

The game logs in as `sam_the_fisher` / `password1234` (from `[User]` in `uplay.toml`). The server's
database seeds that account.

## How the game reaches the server

1. The shim handles `UPLAY_Startup`. `CdKeys` in `uplay.toml` must be non-empty, or the call is
   forwarded to the real loader. That loader shows "Ubisoft Game Launcher was not found".
2. The shim overwrites the `onlineconfigservice.ubi.com` hostname in the exe with `ConfigServer`,
   which defaults to `127.0.0.1`.
3. The game sends
   `GET /OnlineConfigService.svc/GetOnlineConfig?onlineConfigID=967fad701a3648d8bf099f07207f4a73&target=client`
   over HTTP on port 80. The response is a JSON list of `{Name, Values}`. The entry that matters is
   `SandboxUrl`, which the retail service set to
   `prudp:/address=lb-rdv-as-prod01.ubisoft.com;port=21126`. `bun-impl` answers with
   `prudp:/address=127.0.0.1;port=21126`, or with the `--public-ip` address.
4. The game connects there over PRUDP: SYN, then CONNECT, then `TicketGranting.LoginEx`. The
   `LoginEx` response names the secure server, and the game connects to it next.
5. The shim also logs in to the gRPC API (`ApiServer`) for friends and invites. If that fails,
   it's ignored.

A full recorded retail response is in 5th-echelon's
[research notes](https://github.com/unixoide/5th-echelon/blob/main/docs/research/splinter_cell_blacklist.md).

## Logs and debugging

- `<game>/src/SYSTEM/bl-tracing.log` is written by the shim. It records UPLAY calls, hooked
  addresses, and RMC messages when the `RMCMessages` hook is enabled.
- `WINEDEBUG=err+all mac/launch.sh` shows Wine errors.
- `DXMT_LOG_LEVEL=info DXMT_LOG_PATH=/tmp mac/launch.sh` turns on renderer logs.
- `source mac/env.sh; wineserver -k` kills a hung game.

## Dead ends (don't retry these)

- **Homebrew `wine-stable`, `wine@staging` and `wine@devel` casks** were disabled on 2026-09-01 because
  they fail Gatekeeper.
- **Stock WineHQ/Gcenx builds + DXMT** make DXMT abort with "Failed to create metal view, it
  seems like your Wine has no exported symbols needed by DXMT". DXMT needs `winemac.so` to export
  `macdrv_functions`, and only CrossOver-derived forks such as Sikarugir do.
- **DXVK-macOS (MoltenVK)** fails with `D3D11CoreCreateDevice: Failed to create D3D11 device`.
  The game then falls back to a path that crashes.
- **The Sikarugir engine without its wrapper** fails with `failed to start wineboot`. The engine has no
  rpaths, so it needs the wrapper's `Frameworks` dylibs on `DYLD_FALLBACK_LIBRARY_PATH` (see `env.sh`).
- **The stock `uplay_r1_loader.dll`** needs Ubisoft Connect. It installs under Wine
  (`UbisoftConnectInstaller.exe /S`), but it also needs an account and the online service, which
  the shim makes unnecessary.
- **CrossOver** would probably work too (CodeWeavers lists the game), but it's paid.

## Going back to the stock loader

```sh
source mac/env.sh
cd "$GAME_SYSTEM_DIR"
mv uplay_r1_loader.orig.dll uplay_r1_loader.dll   # overwrites the shim
```

Re-running `setup.sh` installs the shim again.

## Uninstall

Delete `~/Applications/Splinter Cell Blacklist.app`, which includes the prefix and the game, and
`~/Games/sc6`.
