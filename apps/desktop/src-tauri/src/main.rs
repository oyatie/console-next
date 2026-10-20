// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Windows shell for the hosted console (ADR-014). The window loads the configured origin and
//! inherits its cookie session and CSP. No IPC is granted to the remote page (no capabilities).
mod config;
mod external;

use std::sync::Mutex;
use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_updater::{Update, UpdaterExt};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

const MAIN: &str = "main";

/// An update downloaded this session, installed when the app quits (never mid-session, ADR-014 §5.3).
#[derive(Default)]
struct Pending(Mutex<Option<(Update, Vec<u8>)>>);

fn main() {
    // Build-time default, validated as an https origin by build.rs.
    let default = Url::parse(env!("CONSOLE_DEFAULT_URL")).expect("build.rs validated CONSOLE_URL");
    let settings = config::resolve(&config::layers(), &default);

    tauri::Builder::default()
        // Must be first; with the `deep-link` feature it forwards a second launch's URL to on_open_url.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus(app)
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Pending::default())
        .setup(move |app| {
            let console = settings.console.clone();
            let start = app
                .deep_link()
                .get_current()?
                .and_then(|links| {
                    links
                        .first()
                        .and_then(|l| config::deep_link_target(&console, l))
                })
                .unwrap_or_else(|| console.clone());
            window(app.handle(), console.clone(), start)?;

            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let target = event
                    .urls()
                    .first()
                    .and_then(|l| config::deep_link_target(&console, l));
                if let (Some(target), Some(w)) = (target, handle.get_webview_window(MAIN)) {
                    let _ = w.navigate(target);
                }
            });

            if let Some(url) = settings.update.clone() {
                check_update(app.handle().clone(), url);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the shell")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event
                && let Some((update, bytes)) = app.state::<Pending>().0.lock().unwrap().take()
            {
                // install() exits the process on success, before the plugin's own save on RunEvent::Exit.
                let _ = app.save_window_state(StateFlags::all());
                // Windows: starts the installer (passive, may ask for elevation) and exits.
                if let Err(e) = update.install(bytes) {
                    config::diag(&format!("update install failed: {e}"));
                }
            }
        });
}

fn window(app: &AppHandle, console: Url, start: Url) -> tauri::Result<()> {
    let nav_console = console.clone();
    let nav_app = app.clone();
    let new_window_app = app.clone();
    WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(start))
        .title(app.package_info().name.clone())
        .inner_size(1280.0, 800.0)
        .on_document_title_changed(|w, title| {
            let _ = w.set_title(&title);
        })
        // Off-origin requests require confirmation in a local interstitial, never in the hosted page.
        .on_navigation(move |url| {
            if config::same_origin(&nav_console, url) {
                return true;
            }
            external::request(&nav_app, url);
            false
        })
        .on_new_window(move |url, _| {
            external::request(&new_window_app, &url);
            NewWindowResponse::Deny
        })
        .on_permission_request(permission)
        // WebView2 replaces the drag-drop handler, so HTML5 drop (certificate upload) never reaches the page
        // unless Tauri's own handler is off. The page does not use Tauri's file-drop events.
        .disable_drag_drop_handler()
        .build()?;
    Ok(())
}

/// The console needs none of these device permissions. `Other` (and anything unlisted) keeps
/// WebView2's default so a WebAuthn ceremony is never blocked here (verify.md §5.4).
fn permission(_: tauri::Webview, kind: PermissionKind) -> PermissionResponse {
    use PermissionKind::*;
    match kind {
        Microphone | Camera | Geolocation | Notifications | ClipboardRead | DisplayCapture
        | Midi | Sensors | LocalFonts | WindowManagement | AutomaticDownloads
        | FileSystemAccess => PermissionResponse::Deny,
        _ => PermissionResponse::Default,
    }
}

fn focus(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Checks once at launch and downloads in the background; installs on quit.
fn check_update(app: AppHandle, url: Url) {
    tauri::async_runtime::spawn(async move {
        let run = async {
            let updater = app
                .updater_builder()
                .endpoints(vec![url])?
                .restart_after_install(false)
                .build()?;
            if let Some(update) = updater.check().await? {
                let bytes = update.download(|_, _| {}, || {}).await?;
                app.state::<Pending>()
                    .0
                    .lock()
                    .unwrap()
                    .replace((update, bytes));
            }
            Ok::<_, tauri_plugin_updater::Error>(())
        };
        if let Err(e) = run.await {
            config::diag(&format!("update check failed: {e}"));
        }
    });
}
