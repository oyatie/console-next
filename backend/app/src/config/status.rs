// SPDX-License-Identifier: LicenseRef-Proprietary
//! External status-page origin configuration (`CONSOLE_STATUS_ORIGIN`) for `SPA_CSP`.

use crate::config::parse::non_empty;
use crate::error::AppError;
use std::collections::HashMap;
use url::{Host, Origin, Url};

pub(crate) const DEFAULT_STATUS_ORIGIN: &str = "https://status.cosskorea.com";

fn is_loopback_host(host: Option<Host<&str>>) -> bool {
    match host {
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

fn has_unsafe_csp_bytes(raw: &str) -> bool {
    raw.bytes().any(|b| {
        b.is_ascii_control()
            || b.is_ascii_whitespace()
            || matches!(b, b';' | b',' | b'*' | b'\'' | b'"' | b'\\')
    })
}

fn invalid_origin_err() -> AppError {
    AppError::Config(
        "CONSOLE_STATUS_ORIGIN must be a valid https:// origin (or 'none') without path, query, fragment, userinfo, or wildcard"
            .to_owned(),
    )
}

pub(crate) fn status_origin_from_vars(
    vars: &HashMap<String, String>,
    cookie_secure: bool,
) -> Result<Option<String>, AppError> {
    if vars
        .get("CONSOLE_STATUS_ORIGIN")
        .is_some_and(|raw| raw.bytes().any(|b| b.is_ascii_control()))
    {
        return Err(invalid_origin_err());
    }
    let Some(raw) = non_empty(vars.get("CONSOLE_STATUS_ORIGIN")) else {
        return Ok(Some(DEFAULT_STATUS_ORIGIN.to_owned()));
    };
    if raw.eq_ignore_ascii_case("none") {
        return Ok(None);
    }
    if has_unsafe_csp_bytes(&raw)
        || raw.contains('@')
        || raw.ends_with("/.")
        || raw.ends_with("/..")
    {
        return Err(invalid_origin_err());
    }
    let url = Url::parse(&raw).map_err(|_| invalid_origin_err())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || raw.ends_with('/')
        || url.port() == Some(0)
    {
        return Err(invalid_origin_err());
    }
    if !matches!(url.origin(), Origin::Tuple(..))
        || url
            .host_str()
            .is_none_or(|h| h.is_empty() || h.contains('*'))
    {
        return Err(invalid_origin_err());
    }
    let scheme_ok = match url.scheme() {
        "https" => true,
        "http" => !cookie_secure && is_loopback_host(url.host()),
        _ => false,
    };
    if !scheme_ok {
        return Err(invalid_origin_err());
    }
    let origin = url.origin().ascii_serialization();
    if has_unsafe_csp_bytes(&origin) {
        return Err(invalid_origin_err());
    }
    Ok(Some(origin))
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_STATUS_ORIGIN, status_origin_from_vars};
    use std::collections::HashMap;

    #[test]
    fn unset_or_blank_defaults_to_public_status_origin() {
        assert_eq!(
            status_origin_from_vars(&HashMap::new(), true).unwrap(),
            Some(DEFAULT_STATUS_ORIGIN.to_owned())
        );
        let blank = HashMap::from([("CONSOLE_STATUS_ORIGIN".to_owned(), "   ".to_owned())]);
        assert_eq!(
            status_origin_from_vars(&blank, true).unwrap(),
            Some(DEFAULT_STATUS_ORIGIN.to_owned())
        );
    }

    #[test]
    fn none_disables_external_status_origin() {
        for value in ["none", "NONE", "None"] {
            let vars = HashMap::from([("CONSOLE_STATUS_ORIGIN".to_owned(), value.to_owned())]);
            assert_eq!(status_origin_from_vars(&vars, true).unwrap(), None);
        }
    }

    #[test]
    fn canonicalizes_https_origins_and_custom_ports() {
        let vars = HashMap::from([(
            "CONSOLE_STATUS_ORIGIN".to_owned(),
            "https://STATUS.Example.Test:443".to_owned(),
        )]);
        assert_eq!(
            status_origin_from_vars(&vars, true).unwrap(),
            Some("https://status.example.test".to_owned())
        );
        let port = HashMap::from([(
            "CONSOLE_STATUS_ORIGIN".to_owned(),
            "https://status.example.test:8443".to_owned(),
        )]);
        assert_eq!(
            status_origin_from_vars(&port, true).unwrap(),
            Some("https://status.example.test:8443".to_owned())
        );
    }

    #[test]
    fn loopback_http_requires_cookie_secure_false() {
        for raw in [
            "http://127.0.0.1:4173",
            "http://localhost:4173",
            "http://[::1]:4173",
        ] {
            let vars = HashMap::from([("CONSOLE_STATUS_ORIGIN".to_owned(), raw.to_owned())]);
            assert!(status_origin_from_vars(&vars, true).is_err(), "{raw}");
            assert!(status_origin_from_vars(&vars, false).is_ok(), "{raw}");
        }
        let remote_http = HashMap::from([(
            "CONSOLE_STATUS_ORIGIN".to_owned(),
            "http://status.cosskorea.com".to_owned(),
        )]);
        assert!(status_origin_from_vars(&remote_http, false).is_err());
    }

    #[test]
    fn rejects_injection_and_never_echoes_raw_value() {
        let payloads = [
            "https://status.cosskorea.com; script-src 'unsafe-inline'",
            "https://status.cosskorea.com https://evil.example",
            "https://status.cosskorea.com\r\nX-Test: 1",
            "https://status.cosskorea.com\0",
            "https://*.cosskorea.com",
            "*",
            "https://status.cosskorea.com/",
            "https://status.cosskorea.com/active.json",
            "https://status.cosskorea.com?x=1",
            "https://status.cosskorea.com#frag",
            "https://user:pass@status.cosskorea.com",
            "https://@status.cosskorea.com",
            "https://status.cosskorea.com%3B",
            "https://status%3B.cosskorea.com",
            "https://status.cosskorea.com\u{FF1B}evil.test",
            "https://status%2C.cosskorea.com",
            "https://status%27.cosskorea.com",
            "https://status%22.cosskorea.com",
            "https://status\u{FF0C}.cosskorea.com",
            "https://status\u{FF07}.cosskorea.com",
            "https://status\u{FF02}.cosskorea.com",
            "https://status.cosskorea.com:0",
            "https://status.cosskorea.com/.",
            "https://status.cosskorea.com/..",
            "javascript:alert(1)",
            "data:text/plain,ok",
            "wss://status.cosskorea.com",
        ];
        for payload in payloads {
            let vars = HashMap::from([("CONSOLE_STATUS_ORIGIN".to_owned(), payload.to_owned())]);
            let err = status_origin_from_vars(&vars, false)
                .unwrap_err()
                .to_string();
            assert!(!err.contains("evil.example"), "raw echoed: {err}");
            assert!(!err.contains("unsafe-inline"), "raw echoed: {err}");
            assert!(!err.contains("alert(1)"), "raw echoed: {err}");
        }
    }
}
