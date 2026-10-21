# Console desktop shell (Windows MVP)

A Tauri 2.12.1 window on the hosted console. It loads the configured origin, so it inherits the page's cookie session, CSP and every web deploy. Decision: OD-DSK-9 (`docs/adr/ADR-014-desktop-shell.md` §8a).

- **In the MVP:** Windows x64, NSIS installer, `perMachine`, unsigned.
- **Not in the MVP:** macOS/Linux shells, MSI, code signing, telemetry, realtime/notifications, IPC to the page.

## What the shell does

| Behaviour | Where |
|---|---|
| The window loads the resolved console origin. The page title becomes the window title | `src-tauri/src/main.rs` `window` |
| Navigation stays on that origin. `http(s)`/`mailto` links elsewhere open in the default browser, other schemes are dropped, and `window.open` never opens a shell window | `on_navigation`, `on_new_window`, `config::external` |
| Device permissions (camera, mic, location, notifications, clipboard read …) are denied. `Other` keeps WebView2's default, so WebAuthn is never blocked here | `permission` |
| No capabilities file exists, so the remote page gets **no IPC**: no fs, no shell, no plugin commands | `src-tauri/capabilities/` (absent on purpose) |
| A second launch focuses the first window (`tauri-plugin-single-instance`, registered first) | `main` |
| Window size and position persist (`tauri-plugin-window-state`) | `main` |
| `cosskorea-console://<path>?<query>` opens `<console origin>/<path>?<query>`. Only a path on the console origin comes out. The NSIS installer registers the scheme | `config::deep_link_target`, `tauri.conf.json` |
| Updater: checks once at launch, downloads in the background, installs **on quit** (passive NSIS, may ask for elevation, no relaunch). Never mid-session. Window state is saved first, because the install exits the process | `check_update`, `RunEvent::ExitRequested` |

## Configuration (no URL in source)

One resolution in `src-tauri/src/config.rs`. For each field, the first valid value wins:

1. `HKLM\Software\Policies\CossKorea\Console`
2. `HKCU\Software\Policies\CossKorea\Console`
3. `config.json` next to `console-desktop.exe` (the install dir: Program Files under `perMachine`, so only admins can write it). Not `%ProgramData%`: any user can create files there, which would let one user redirect every other user's shell
4. The build-time default: the `CONSOLE_URL` env var, read by `build.rs`. The build fails if it is unset or not an https origin.

| Registry value | File key | Meaning |
|---|---|---|
| `ConsoleUrl` (REG_SZ) | `consoleUrl` | https origin. Path, query and fragment are stripped. `http:`, credentials and non-URLs are ignored, and the next layer is used |
| `UpdateUrl` (REG_SZ) | `updateUrl` | https URL of the update manifest. The default is `<console origin>/desktop/update/windows-x86_64.json` (owner ask A7) |
| `DisableAutoUpdate` (DWORD, non-zero = on) | `disableAutoUpdate` (bool) | No update check. Use this when IT pushes installers |

Example `config.json`: `{ "consoleUrl": "https://console.example.test" }`. It survives updates (update mode does not uninstall) and uninstall (the uninstaller removes only its own files).

Invalid values are skipped silently in the UI. Every skipped value, update failure and failed browser hand-off is appended to `%LOCALAPPDATA%\CossKorea\Console\shell.log` (restarts past 1 MiB), because release builds have no console.

WebAuthn checks the exact origin, so an override only works for hosts the backend already accepts (`extra_allowed_origins` is empty today).

## Build

The cargo CLI is used, and `apps/desktop` has no `package.json`, so the npm workspace and `package-lock.json` are untouched. The toolchain is pinned in `rust-toolchain.toml`.

```sh
cargo install tauri-cli --version 2.12.1 --locked   # once
npm run desktop:test                                # config/navigation/deep-link unit tests (any OS)
```

Every installer build needs:

| Env var | Value |
|---|---|
| `CONSOLE_URL` | The default console origin baked into the build |
| `TAURI_SIGNING_PRIVATE_KEY` | Updater minisign private key (content or path). The build fails without it because `createUpdaterArtifacts` is on |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Updater signing password, provided to the build environment at build time |

- **On macOS (cross-build, NSIS only):** `brew install makensis llvm`, `cargo install --locked cargo-xwin`, then `npm run desktop:build:cross`. `llvm-rc` must be on `PATH` (Homebrew llvm is keg-only: `export PATH=/opt/homebrew/opt/llvm/bin:$PATH`). The first run downloads the MSVC CRT and Windows SDK. cargo-xwin accepts Microsoft's licence for them (fwlink 2086102, owner ask A5). The bundler downloads `nsis_tauri_utils.dll` from github.com.
- **On Windows:** Visual Studio Build Tools (C++), Rust, then `npm run desktop:build` from Git Bash or PowerShell. The `desktop:test` script uses POSIX env syntax, so on Windows set `CONSOLE_URL` first and run `cargo test` in `src-tauri`.
- **Output:** `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Console_<ver>_x64-setup.exe` plus `.sig`. Publish the installer with its SHA-256.

Known build warnings: "cross-platform compilation is experimental", "skipping signing" (expected while unsigned), `lld-link` LNK4099 (missing CRT debug info), and "identifier ends with `.app`" (owner's choice, `com.console.app`; it only matters for a future macOS bundle).

The icons are Tauri's placeholders. Replace them with `cargo tauri icon <1024px png>` when the brand icon exists.

## Updater key custody

- The public key is in `tauri.conf.json` (`plugins.updater.pubkey`). `requireSignedVersion` is on from the first release.
- The release key is held by the release owner.
  - "If you lose this key you will NOT be able to publish new updates" to installed apps (Tauri docs).
  - Never commit either file.
- To rotate: generate a new key (`cargo tauri signer generate -w <path>`), then ship one release signed with the **old** key that carries the **new** public key.

## IT install note (unsigned MVP)

- **Smart App Control must be Off.** Unsigned apps are blocked when it is On, with no per-app exception. Check under Settings → Windows Security → App & browser control → Smart App Control. It is off automatically on enterprise-managed devices.
- **SmartScreen:** the user sees "Windows protected your PC" and must choose More info → Run anyway, once per version. Distributing from a Local Intranet zone share avoids the prompt. Publish the SHA-256 next to the file.
- **Admin rights:** the installer is per-machine (Program Files), so it needs admin. On default AppLocker rules, per-user installs would be blocked.
- **WebView2:** Windows 11 includes it. The installer downloads the bootstrapper if it is missing, which needs internet access. Offline sites are post-MVP.
- **Policy:** to point the app at another host or turn off updates, set the registry values above under `HKLM\Software\Policies\CossKorea\Console` (GPO/Intune).

## Not built or tested on this Mac

- Running the `.exe`. That needs a Windows x64 PC (route D) or `windows-latest` CI once the repo exists.
- A Windows Hello passkey ceremony, cookie persistence across restarts (DSK-P2), and the Playwright `connectOverCDP` smoke run.
- MSI (WiX runs only on Windows).
- Smart App Control and SmartScreen behaviour.

## OWNER-CONFIRM (OD-DSK-5, permanent once shipped)

- Policy vendor path `CossKorea` (`config::VENDOR`): `HKLM\Software\Policies\CossKorea\Console` and the log folder `%LOCALAPPDATA%\CossKorea\Console`.
- Deep-link scheme `cosskorea-console` (`tauri.conf.json` `plugins.deep-link`).
- Bundle identifier `com.console.app` (owner choice).
- Update manifest path `/desktop/update/windows-x86_64.json` on the console origin (A7: who serves `/desktop/*`).
