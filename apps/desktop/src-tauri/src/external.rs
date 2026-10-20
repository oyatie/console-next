// SPDX-License-Identifier: LicenseRef-Proprietary
//! Browser handoff belongs only to the immutable local interstitial's confirmation action.
use crate::config;
use std::sync::Mutex;
use tauri::{
    AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, webview::NewWindowResponse,
};

const LABEL: &str = "external-confirmation";
const CONFIRM: &str = "about:blank?external-confirm";
const CANCEL: &str = "about:blank?external-cancel";
const HTML: &str = include_str!("external.html");

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
                    if let Err(e) = tauri_plugin_opener::open_url(target.as_str(), None::<&str>) {
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
