// SPDX-License-Identifier: LicenseRef-Proprietary
// Filled with current production bodies by main.test.mjs; no copied callback implementation.

use std::{cell::RefCell, collections::HashMap, rc::Rc};
use tauri::{AppHandle, Url, WebviewUrl, WebviewWindowBuilder, webview::NewWindowResponse};

mod config {
    use super::Url;
    // PRODUCTION_POLICY
    pub fn diag(_: &str) {}
}

mod threads {
    pub use std::sync;
    pub mod thread {
        pub fn spawn(f: impl FnOnce()) {
            f();
        }
    }
}

type Navigation = Box<dyn Fn(&Url) -> bool>;
type Popup = Box<dyn Fn(Url, ()) -> NewWindowResponse>;

#[derive(Default)]
struct State {
    windows: HashMap<String, Rc<tauri::WebviewWindow>>,
    opened: Vec<String>,
    built: Vec<String>,
    focused: Vec<String>,
    restored: Vec<String>,
    closed: Vec<String>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

mod tauri {
    use super::*;
    pub use ::tauri::Url;
    pub type Result<T> = std::result::Result<T, String>;

    #[derive(Clone)]
    pub struct AppHandle;
    pub struct Info {
        pub name: String,
    }
    impl AppHandle {
        pub fn package_info(&self) -> Info {
            Info {
                name: "Test".into(),
            }
        }
    }
    pub trait Manager {
        fn get_webview_window(&self, label: &str) -> Option<Rc<WebviewWindow>>;
    }
    impl Manager for AppHandle {
        fn get_webview_window(&self, label: &str) -> Option<Rc<WebviewWindow>> {
            STATE.with(|s| s.borrow().windows.get(label).cloned())
        }
    }
    pub mod webview {
        #[derive(Debug, PartialEq)]
        pub enum NewWindowResponse {
            Deny,
        }
    }
    pub enum WebviewUrl {
        External(Url),
    }
    pub struct WebviewWindow {
        label: String,
        pub(super) initial: Url,
        pub(super) navigation: Navigation,
        pub(super) popup: Popup,
    }
    impl WebviewWindow {
        pub fn set_title(&self, _: &str) -> Result<()> {
            Ok(())
        }
        pub fn unminimize(&self) -> Result<()> {
            STATE.with(|s| s.borrow_mut().restored.push(self.label.clone()));
            Ok(())
        }
        pub fn set_focus(&self) -> Result<()> {
            STATE.with(|s| s.borrow_mut().focused.push(self.label.clone()));
            Ok(())
        }
        pub fn close(&self) -> Result<()> {
            STATE.with(|s| {
                let mut state = s.borrow_mut();
                state.windows.remove(&self.label);
                state.closed.push(self.label.clone());
            });
            Ok(())
        }
    }
    pub struct WebviewWindowBuilder {
        label: String,
        initial: Url,
        navigation: Option<Navigation>,
        popup: Option<Popup>,
    }
    impl WebviewWindowBuilder {
        pub fn new(_: &AppHandle, label: &str, WebviewUrl::External(initial): WebviewUrl) -> Self {
            Self {
                label: label.into(),
                initial,
                navigation: None,
                popup: None,
            }
        }
        pub fn title(self, _: impl AsRef<str>) -> Self {
            self
        }
        pub fn inner_size(self, _: f64, _: f64) -> Self {
            self
        }
        pub fn on_document_title_changed(self, _: impl Fn(&WebviewWindow, String)) -> Self {
            self
        }
        pub fn on_navigation(mut self, f: impl Fn(&Url) -> bool + 'static) -> Self {
            self.navigation = Some(Box::new(f));
            self
        }
        pub fn on_new_window(mut self, f: impl Fn(Url, ()) -> NewWindowResponse + 'static) -> Self {
            self.popup = Some(Box::new(f));
            self
        }
        pub fn on_permission_request(self, _: fn()) -> Self {
            self
        }
        pub fn disable_drag_drop_handler(self) -> Self {
            self
        }
        pub fn build(self) -> Result<()> {
            STATE.with(|s| {
                let mut state = s.borrow_mut();
                state.built.push(self.label.clone());
                state.windows.insert(
                    self.label.clone(),
                    Rc::new(WebviewWindow {
                        label: self.label,
                        initial: self.initial,
                        navigation: self.navigation.unwrap(),
                        popup: self.popup.unwrap(),
                    }),
                );
            });
            Ok(())
        }
    }
}

mod tauri_plugin_opener {
    pub fn open_url(raw: &str, _: Option<&str>) -> Result<(), String> {
        super::STATE.with(|s| s.borrow_mut().opened.push(raw.into()));
        Ok(())
    }
}

const MAIN: &str = "main";
const DIALOG: &str = "external-confirmation";
fn permission() {}

// PRODUCTION_WINDOW
// PRODUCTION_EXTERNAL

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tauri::Manager;

    fn url(raw: &str) -> Url {
        Url::parse(raw).unwrap()
    }
    fn get(label: &str) -> Rc<tauri::WebviewWindow> {
        AppHandle.get_webview_window(label).unwrap()
    }
    fn main_window() -> Rc<tauri::WebviewWindow> {
        let console = url("https://console.test/");
        window(&AppHandle, console.clone(), console).unwrap();
        get(MAIN)
    }
    fn assert_no_open() {
        STATE.with(|s| {
            assert!(
                s.borrow().opened.is_empty(),
                "browser opened before confirmation"
            )
        });
    }
    fn assert_displayed(dialog: &tauri::WebviewWindow, target: &Url) {
        let encoded: String = target
            .as_str()
            .bytes()
            .map(|b| format!("%{b:02X}"))
            .collect();
        assert_eq!(dialog.initial.scheme(), "data");
        assert_eq!(dialog.initial.fragment(), Some(encoded.as_str()));
    }

    #[test]
    fn navigation_callback_requires_confirmation() {
        let main = main_window();
        assert!((main.navigation)(&url("https://console.test/people/123")));
        assert!(AppHandle.get_webview_window(DIALOG).is_none());
        for raw in [
            "https://external.test/path?q=private#fragment",
            "https://console.test:444/",
            "https://console.test.evil.test/",
        ] {
            let target = url(raw);
            assert!(!(main.navigation)(&target));
            assert_no_open();
            let dialog = get(DIALOG);
            assert_displayed(&dialog, &target);
            assert!(!(dialog.navigation)(&url("about:blank?external-cancel")));
        }
        assert_no_open();
    }

    #[test]
    fn new_window_callback_requires_confirmation() {
        let main = main_window();
        let target = url("https://external.test/path?q=private#fragment");
        assert_eq!((main.popup)(target.clone(), ()), NewWindowResponse::Deny);
        assert_no_open();
        assert_displayed(&get(DIALOG), &target);
    }

    #[test]
    fn invalid_requests_never_create_a_dialog_or_open() {
        let main = main_window();
        for raw in [
            "http://external.test/",
            "mailto:a@b.test",
            "file:///tmp/example",
            "javascript:alert(1)",
            "data:text/html,example",
            "https://user@external.test/",
            "https://:password@external.test/",
            "https://user:password@external.test/",
        ] {
            let target = url(raw);
            external::request(&AppHandle, &target);
            assert!(!(main.navigation)(&target));
            assert_eq!((main.popup)(target, ()), NewWindowResponse::Deny);
            assert!(
                AppHandle.get_webview_window(DIALOG).is_none(),
                "dialog for {raw}"
            );
            assert_no_open();
        }
        STATE.with(|s| assert_eq!(s.borrow().built, [MAIN]));
    }

    #[test]
    fn dialog_allows_only_its_initial_page_and_closes_on_a_decision() {
        for action in [
            "about:blank?external-confirm",
            "about:blank?external-cancel",
        ] {
            STATE.with(|s| *s.borrow_mut() = State::default());
            let target = url("https://external.test/path?q=private#fragment");
            external::request(&AppHandle, &target);
            let dialog = get(DIALOG);
            assert!((dialog.navigation)(&dialog.initial));
            for raw in [
                target.as_str(),
                "https://other.test/",
                "about:blank?external-confirm#forged",
            ] {
                assert!(!(dialog.navigation)(&url(raw)));
                assert_no_open();
                STATE.with(|s| assert!(s.borrow().closed.is_empty()));
            }
            assert!(!(dialog.navigation)(&url(action)));
            STATE.with(|s| {
                let state = s.borrow();
                assert_eq!(state.closed, [DIALOG]);
                let expected = if action.ends_with("confirm") {
                    vec![target.to_string()]
                } else {
                    vec![]
                };
                assert_eq!(state.opened, expected);
            });
            assert!(AppHandle.get_webview_window(DIALOG).is_none());
            assert!(!(dialog.navigation)(&url(action)));
            STATE.with(|s| assert!(s.borrow().opened.len() <= 1));
        }
    }

    #[test]
    fn repeated_requests_focus_the_existing_dialog_and_keep_its_destination() {
        let target = url("https://first.test/path");
        external::request(&AppHandle, &target);
        let dialog = get(DIALOG);
        external::request(&AppHandle, &url("https://second.test/"));
        assert_no_open();
        assert!(Rc::ptr_eq(&dialog, &get(DIALOG)));
        assert_displayed(&dialog, &target);
        STATE.with(|s| {
            let state = s.borrow();
            assert_eq!(state.built, [DIALOG]);
            assert_eq!(state.restored, [DIALOG]);
            assert_eq!(state.focused, [DIALOG]);
        });
        assert!(!(dialog.navigation)(&url("about:blank?external-confirm")));
        STATE.with(|s| assert_eq!(s.borrow().opened, [target.as_str()]));
    }

    #[test]
    fn dialog_popups_never_open_the_browser() {
        external::request(&AppHandle, &url("https://external.test/"));
        let dialog = get(DIALOG);
        for raw in ["https://other.test/", "about:blank?external-confirm"] {
            assert_eq!((dialog.popup)(url(raw), ()), NewWindowResponse::Deny);
            assert_no_open();
        }
        STATE.with(|s| assert!(s.borrow().closed.is_empty()));
    }
}
