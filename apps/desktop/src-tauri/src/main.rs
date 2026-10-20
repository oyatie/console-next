// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Windows shell for the hosted console (ADR-014). The window loads the configured origin and
//! inherits its cookie session and CSP. No IPC is granted to the remote page (no capabilities).
mod config;

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

// The local confirmation page is the only browser handoff gate.
mod external {
    use crate::config;
    use std::sync::Mutex;
    use tauri::{
        AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, webview::NewWindowResponse,
    };

    const LABEL: &str = "external-confirmation";
    const CONFIRM: &str = "about:blank?external-confirm";
    const CANCEL: &str = "about:blank?external-cancel";
    const HTML: &str = r#"<!doctype html>
    <!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
    <html lang="ko">
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <title>외부 사이트로 이동</title>
    <style>
      body { font: 16px/1.6 system-ui, sans-serif; margin: 2rem; }
      #destination { overflow-wrap: anywhere; }
      button { font: inherit; padding: .5rem 1rem; margin-inline-end: .5rem; }
    </style>
    <h1>외부 사이트로 이동</h1>
    <p>다음 주소를 기본 브라우저에서 열까요?</p>
    <p id="destination"></p>
    <button id="cancel" type="button" autofocus>취소</button>
    <button id="confirm" type="button">이동</button>
    <script>
      document.getElementById("destination").textContent = decodeURIComponent(location.hash.slice(1));
      for (const action of ["cancel", "confirm"]) {
        document.getElementById(action).addEventListener("click", (event) => {
          if (event.isTrusted) location.href = `about:blank?external-${action}`;
        });
      }
    </script>
    </html>"#;

    fn encode(value: &str) -> String {
        value.bytes().map(|b| format!("%{b:02X}")).collect()
    }

    fn page(target: &Url) -> Url {
        Url::parse(&format!(
            "data:text/html,{}#{}",
            encode(HTML),
            encode(target.as_str())
        ))
        .expect("percent-encoded interstitial")
    }

    /// Consumes a decision once; arbitrary navigation cannot open or replace the displayed destination.
    fn answer(target: &mut Option<Url>, action: &Url, open: impl FnOnce(&Url)) -> bool {
        if action.as_str() != CONFIRM && action.as_str() != CANCEL {
            return false;
        }
        if let Some(url) = target.take()
            && action.as_str() == CONFIRM
            && config::external(&url)
        {
            open(&url);
        }
        true
    }

    pub fn request(app: &AppHandle, target: &Url) {
        if !config::external(target) {
            return;
        }
        let app = app.clone();
        let target = target.clone();
        // WebView2 window creation must run outside synchronous navigation callbacks.
        std::thread::spawn(move || {
            if let Some(w) = app.get_webview_window(LABEL) {
                let _ = w.unminimize();
                let _ = w.set_focus();
                return;
            }
            let page = page(&target);
            let initial = page.clone();
            let pending = Mutex::new(Some(target));
            let handle = app.clone();
            let result = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(page))
                .title("외부 사이트로 이동")
                .inner_size(640.0, 360.0)
                .on_navigation(move |url| {
                    if url == &initial {
                        return true;
                    }
                    let close = answer(&mut pending.lock().unwrap(), url, |target| {
                        if let Err(e) = tauri_plugin_opener::open_url(target.as_str(), None::<&str>)
                        {
                            config::diag(&format!("open {target}: {e}"));
                        }
                    });
                    if close && let Some(w) = handle.get_webview_window(LABEL) {
                        let _ = w.close();
                    }
                    false
                })
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .on_permission_request(super::permission)
                .build();
            if let Err(e) = result {
                config::diag(&format!("external confirmation: {e}"));
            }
        });
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn only_confirmation_opens_the_displayed_url_once() {
            let destination = Url::parse("https://external.test/path?q=%22#section").unwrap();
            let mut target = Some(destination.clone());
            let mut opened = Vec::new();
            for action in [
                destination.as_str(),
                "https://other.test/",
                "http://external.test/",
                "mailto:a@b.test",
                "about:blank?external-confirm#forged",
            ] {
                assert!(!answer(&mut target, &Url::parse(action).unwrap(), |url| {
                    opened.push(url.clone());
                }));
            }
            assert!(opened.is_empty());
            assert_eq!(target, Some(destination.clone()));
            for _ in 0..2 {
                assert!(answer(
                    &mut target,
                    &Url::parse("about:blank?external-confirm").unwrap(),
                    |url| opened.push(url.clone())
                ));
            }
            assert_eq!(opened, [destination]);
        }

        #[test]
        fn cancel_and_invalid_destinations_never_launch() {
            for raw in [
                "https://external.test/",
                "http://external.test/",
                "mailto:a@b.test",
                "file:///tmp/example",
                "javascript:alert(1)",
                "https://user@external.test/",
                "https://:password@external.test/",
                "https://user:password@external.test/",
            ] {
                let mut target = Some(Url::parse(raw).unwrap());
                if config::external(target.as_ref().unwrap()) {
                    assert!(answer(
                        &mut target,
                        &Url::parse("about:blank?external-cancel").unwrap(),
                        |_| panic!("cancel launched {raw}")
                    ));
                }
                assert!(answer(
                    &mut target,
                    &Url::parse("about:blank?external-confirm").unwrap(),
                    |_| panic!("unexpected launch of {raw}")
                ));
                assert!(target.is_none());
            }
        }

        #[test]
        fn interstitial_encodes_html_and_destination_separately() {
            let target = Url::parse("https://external.test/?q=%22%3Cscript%3E#fragment").unwrap();
            assert_eq!(
                page(&target).fragment(),
                Some(encode(target.as_str()).as_str())
            );
            assert_eq!(page(&target).scheme(), "data");
            assert!(!page(&target).as_str().contains("<script>"));
        }
    }
}
