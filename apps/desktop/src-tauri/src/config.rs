//! Where the shell points: one resolution over four layers, first valid value wins per field.
//! HKLM policy > HKCU policy > `config.json` next to the exe > build-time default (`CONSOLE_URL`).
//! The file sits in the install dir (Program Files under `perMachine`, admin-write only), not in
//! %ProgramData%, where any user can create files and so point every other user's shell elsewhere.
//! No infra value lives in this file; the default comes from the build.
use serde::Deserialize;
use tauri::Url;

/// OWNER-CONFIRM (OD-DSK-5): permanent once shipped. Policy key `Software\Policies\<VENDOR>\<PRODUCT>`,
/// diagnostics log `%LOCALAPPDATA%\<VENDOR>\<PRODUCT>\shell.log`.
pub const VENDOR: &str = "CossKorea";
const PRODUCT: &str = "Console";
/// Update manifest path on the console origin (owner ask A7); `UpdateUrl` overrides it.
const UPDATE_PATH: &str = "/desktop/update/windows-x86_64.json";

/// One configuration layer. Registry values: `ConsoleUrl`, `UpdateUrl` (REG_SZ), `DisableAutoUpdate` (DWORD).
/// File keys: `consoleUrl`, `updateUrl`, `disableAutoUpdate`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    pub console_url: Option<String>,
    pub update_url: Option<String>,
    pub disable_auto_update: Option<bool>,
}

#[derive(Debug, PartialEq)]
pub struct Settings {
    /// Origin only (`https://host[:port]`); the window loads it and navigation stays on it.
    pub console: Url,
    /// `None` when `DisableAutoUpdate` is set (IT pushes installers instead).
    pub update: Option<Url>,
}

/// An `https` URL without credentials, or `None`.
fn https(raw: &str) -> Option<Url> {
    let url = Url::parse(raw.trim()).ok()?;
    let ok = url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none();
    ok.then_some(url)
}

/// The origin of an `https` URL (path, query and fragment stripped).
pub fn origin(raw: &str) -> Option<Url> {
    Url::parse(&https(raw)?.origin().ascii_serialization()).ok()
}

/// First layer whose value passes `valid`; invalid values are reported and skipped.
fn pick<T>(
    layers: &[Layer],
    field: &str,
    get: impl Fn(&Layer) -> Option<&String>,
    valid: impl Fn(&str) -> Option<T>,
) -> Option<T> {
    layers.iter().filter_map(&get).find_map(|raw| {
        let v = valid(raw);
        if v.is_none() {
            diag(&format!("config: ignoring invalid {field} {raw:?}"));
        }
        v
    })
}

pub fn resolve(layers: &[Layer], default: &Url) -> Settings {
    let console = pick(layers, "consoleUrl", |l| l.console_url.as_ref(), origin)
        .unwrap_or_else(|| default.clone());
    let disabled = layers
        .iter()
        .find_map(|l| l.disable_auto_update)
        .unwrap_or(false);
    let update = (!disabled).then(|| {
        pick(layers, "updateUrl", |l| l.update_url.as_ref(), https)
            .unwrap_or_else(|| console.join(UPDATE_PATH).expect("static path joins"))
    });
    Settings { console, update }
}

pub fn same_origin(console: &Url, url: &Url) -> bool {
    url.origin() == console.origin()
}

/// Links the shell hands to the default browser. Only https: URLs without credentials are allowed.
/// Anything else (http:, mailto:, file:, data:, javascript:, userinfo) is dropped.
pub fn external(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

/// `<scheme>://people/123?tab=x` -> `<console>/people/123?tab=x`. Deep links are untrusted input:
/// only a path on the console origin comes out, never another host.
pub fn deep_link_target(console: &Url, link: &Url) -> Option<Url> {
    let rest = link.as_str().split_once(':')?.1.trim_start_matches('/');
    let target = console.join(&format!("/{rest}")).ok()?;
    same_origin(console, &target).then_some(target)
}

/// The machine's layers, highest precedence first.
pub fn layers() -> Vec<Layer> {
    #[cfg(windows)]
    return vec![
        registry(windows_registry::LOCAL_MACHINE),
        registry(windows_registry::CURRENT_USER),
        file(),
    ];
    #[cfg(not(windows))]
    vec![file()]
}

#[cfg(windows)]
fn registry(root: &windows_registry::Key) -> Layer {
    let Ok(key) = root.open(format!(r"Software\Policies\{VENDOR}\{PRODUCT}")) else {
        return Layer::default();
    };
    Layer {
        console_url: key.get_string("ConsoleUrl").ok(),
        update_url: key.get_string("UpdateUrl").ok(),
        disable_auto_update: key.get_u32("DisableAutoUpdate").ok().map(|v| v != 0),
    }
}

fn file() -> Layer {
    let Some(path) = std::env::current_exe()
        .ok()
        .and_then(|exe| Some(exe.parent()?.join("config.json")))
    else {
        return Layer::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            diag(&format!("config: ignoring {}: {e}", path.display()));
            Layer::default()
        }),
        Err(_) => Layer::default(),
    }
}

/// Release builds have no console (`windows_subsystem`), so stderr is lost. Appends one line to
/// `%LOCALAPPDATA%\<VENDOR>\<PRODUCT>\shell.log` for IT; also prints it for dev runs.
/// no rotation, the file restarts past 1 MiB; switch to tauri-plugin-log if more is logged.
pub fn diag(msg: &str) {
    use std::io::Write;
    eprintln!("{msg}");
    let Some(base) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let dir = std::path::Path::new(&base).join(VENDOR).join(PRODUCT);
    let path = dir.join("shell.log");
    let full = std::fs::metadata(&path).is_ok_and(|m| m.len() > 1 << 20);
    let file = std::fs::create_dir_all(&dir).and_then(|_| {
        std::fs::OpenOptions::new()
            .create(true)
            .append(!full)
            .write(true)
            .truncate(full)
            .open(&path)
    });
    if let Ok(mut f) = file {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let _ = writeln!(f, "{secs} {} {msg}", env!("CARGO_PKG_VERSION"));
    }
}

#[cfg(test)]
mod external_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }
    fn layer(console: Option<&str>, update: Option<&str>, disable: Option<bool>) -> Layer {
        Layer {
            console_url: console.map(Into::into),
            update_url: update.map(Into::into),
            disable_auto_update: disable,
        }
    }
    const DEFAULT: &str = "https://default.test";

    #[test]
    fn default_applies_when_no_layer_sets_a_value() {
        let s = resolve(&[Layer::default(), layer(None, None, None)], &url(DEFAULT));
        assert_eq!(s.console, url(DEFAULT));
        assert_eq!(
            s.update,
            Some(url(
                "https://default.test/desktop/update/windows-x86_64.json"
            ))
        );
    }

    #[test]
    fn higher_layer_wins_per_field() {
        let hklm = layer(Some("https://hklm.test"), None, None);
        let hkcu = layer(
            Some("https://hkcu.test"),
            Some("https://updates.test/m.json"),
            None,
        );
        let s = resolve(&[hklm, hkcu], &url(DEFAULT));
        assert_eq!(s.console, url("https://hklm.test"));
        assert_eq!(s.update, Some(url("https://updates.test/m.json")));
    }

    #[test]
    fn invalid_values_fall_through_to_the_next_layer() {
        let bad = [
            "http://plain.test",
            "not a url",
            "https://user:pw@creds.test",
            "file:///C:/x",
            "  ",
        ];
        for raw in bad {
            let s = resolve(
                &[
                    layer(Some(raw), Some(raw), None),
                    layer(Some("https://next.test"), None, None),
                ],
                &url(DEFAULT),
            );
            assert_eq!(s.console, url("https://next.test"), "{raw}");
            assert_eq!(
                s.update,
                Some(url("https://next.test/desktop/update/windows-x86_64.json")),
                "{raw}"
            );
        }
    }

    #[test]
    fn console_url_is_reduced_to_its_origin() {
        let s = resolve(
            &[layer(
                Some(" https://host.test:8443/app/x?y=1#z "),
                None,
                None,
            )],
            &url(DEFAULT),
        );
        assert_eq!(s.console.as_str(), "https://host.test:8443/");
    }

    #[test]
    fn disable_auto_update_wins_from_any_layer_in_order() {
        assert_eq!(
            resolve(&[layer(None, None, Some(true))], &url(DEFAULT)).update,
            None
        );
        let s = resolve(
            &[
                layer(None, None, Some(false)),
                layer(None, None, Some(true)),
            ],
            &url(DEFAULT),
        );
        assert!(s.update.is_some(), "HKLM false beats a lower true");
    }

    #[test]
    fn file_layer_parses_camel_case_json() {
        let l: Layer =
            serde_json::from_str(r#"{"consoleUrl":"https://f.test","disableAutoUpdate":true}"#)
                .unwrap();
        assert_eq!(
            resolve(&[l], &url(DEFAULT)),
            Settings {
                console: url("https://f.test"),
                update: None
            }
        );
    }

    #[test]
    fn navigation_stays_on_the_console_origin() {
        let c = url("https://c.test");
        assert!(same_origin(&c, &url("https://c.test/people?x=1")));
        assert!(!same_origin(&c, &url("https://c.test:444/")));
        assert!(!same_origin(&c, &url("http://c.test/")));
        assert!(!same_origin(&c, &url("https://evil.test/")));
        assert!(!same_origin(&c, &url("data:text/html,x")));
        assert!(external(&url("https://evil.test/")));
        assert!(!external(&url("mailto:a@b.test")));
        assert!(!external(&url("file:///C:/Windows")) && !external(&url("javascript:alert(1)")));
    }

    #[test]
    fn deep_links_map_to_paths_on_the_console_origin_only() {
        let c = url("https://c.test");
        let map = |s: &str| deep_link_target(&c, &url(s)).map(|u| u.to_string());
        assert_eq!(
            map("app-scheme://people/123?tab=a").as_deref(),
            Some("https://c.test/people/123?tab=a")
        );
        assert_eq!(
            map("app-scheme:people").as_deref(),
            Some("https://c.test/people")
        );
        assert_eq!(
            map("app-scheme:////evil.test/x").as_deref(),
            Some("https://c.test/evil.test/x")
        );
        assert_eq!(
            map("app-scheme://user:pw@evil.test/").as_deref(),
            Some("https://c.test/user:pw@evil.test/")
        );
        assert_eq!(map(r"app-scheme:\\evil.test/x"), None);
        assert_eq!(
            map("app-scheme:///%5C%5Cevil.test").as_deref(),
            Some("https://c.test/%5C%5Cevil.test")
        );
    }
}

#[cfg(test)]
mod conf_tests {
    /// The updater block is only parsed at app start on Windows; parse it here so a typo fails the build.
    #[test]
    fn updater_config_parses_and_requires_signed_versions() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater: tauri_plugin_updater::Config =
            serde_json::from_value(conf["plugins"]["updater"].clone()).unwrap();
        assert!(
            updater.require_signed_version
                && updater.endpoints.is_empty()
                && !updater.pubkey.is_empty()
        );
    }
}
