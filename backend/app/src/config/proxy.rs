//! Trusted reverse-proxy configuration (`CONSOLE_TRUSTED_PROXY_*`).

use crate::error::AppError;
use ipnet::IpNet;

/// Number of trusted reverse proxies in front of the process, including the
/// direct transport peer. Zero is the fail-closed default: raw forwarding
/// headers are ignored.
pub(crate) fn parse_trusted_proxy_count(raw: Option<&String>) -> Result<usize, AppError> {
    match raw {
        Some(raw) => raw
            .parse::<usize>()
            .map_err(|err| AppError::Config(format!("invalid CONSOLE_TRUSTED_PROXY_COUNT: {err}"))),
        None => Ok(0),
    }
}

pub(crate) fn parse_trusted_proxy_cidrs(
    raw: Option<&String>,
    trusted_proxy_count: usize,
) -> Result<Vec<IpNet>, AppError> {
    let cidrs = raw
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| {
                    value.parse::<IpNet>().map_err(|err| {
                        AppError::Config(format!(
                            "invalid CONSOLE_TRUSTED_PROXY_CIDRS entry {value:?}: {err}"
                        ))
                    })
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    if trusted_proxy_count > 0 && cidrs.is_empty() {
        return Err(AppError::Config(
            "CONSOLE_TRUSTED_PROXY_CIDRS is required when CONSOLE_TRUSTED_PROXY_COUNT is nonzero"
                .to_owned(),
        ));
    }
    Ok(cidrs)
}

#[cfg(test)]
#[cfg(not(feature = "test-postgres"))]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod trusted_ingress_tests {
    use std::net::SocketAddr;

    use axum::extract::{ConnectInfo, Extension};
    use axum::routing::get;
    use console_platform_request_context::TrustedClientIp;
    use http::Request;
    use tower::ServiceExt;

    #[test]
    fn proxy_forwarding_is_disabled_by_default_and_requires_a_trusted_peer_cidr() {
        let direct = crate::config::AppConfig::from_pairs([
            ("CONSOLE_APP_ROLE", "api".to_owned()),
            ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ])
        .unwrap();
        assert_eq!(direct.trusted_proxy_count, 0);
        assert!(direct.trusted_proxy_cidrs.is_empty());

        let err = crate::config::AppConfig::from_pairs([
            ("CONSOLE_APP_ROLE", "api".to_owned()),
            ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
            ("CONSOLE_TRUSTED_PROXY_COUNT", "1".to_owned()),
        ])
        .expect_err("a nonzero proxy count without trusted peers must fail closed");
        assert!(err.to_string().contains("CONSOLE_TRUSTED_PROXY_CIDRS"));
    }

    #[tokio::test]
    async fn ingress_accepts_only_a_complete_trusted_proxy_suffix() {
        async fn observed_client_ip(Extension(ip): Extension<TrustedClientIp>) -> String {
            ip.get().to_string()
        }

        let app = console_platform_request_context::with_trusted_client_ip(
            axum::Router::new().route("/__test/client-ip", get(observed_client_ip)),
            2,
            vec!["10.0.0.0/8".parse().unwrap()],
        );
        let mut request = Request::builder()
            .uri("/__test/client-ip")
            .header("x-forwarded-for", "198.51.100.250, 10.0.0.2")
            .body(axum::body::Body::empty())
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo("10.0.0.3:443".parse::<SocketAddr>().unwrap()));

        let response = app.oneshot(request).await.unwrap();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], b"198.51.100.250");
    }

    #[tokio::test]
    async fn ingress_rejects_an_untrusted_configured_proxy_suffix() {
        async fn observed_client_ip(Extension(ip): Extension<TrustedClientIp>) -> String {
            ip.get().to_string()
        }

        let app = console_platform_request_context::with_trusted_client_ip(
            axum::Router::new().route("/__test/client-ip", get(observed_client_ip)),
            2,
            vec!["10.0.0.0/8".parse().unwrap()],
        );
        let mut request = Request::builder()
            .uri("/__test/client-ip")
            .header("x-forwarded-for", "198.51.100.250, 203.0.113.7")
            .body(axum::body::Body::empty())
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo("10.0.0.3:443".parse::<SocketAddr>().unwrap()));

        let response = app.oneshot(request).await.unwrap();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], b"10.0.0.3");
    }

    #[tokio::test]
    async fn ingress_falls_back_to_transport_peer_for_raw_or_short_xff() {
        async fn observed_client_ip(Extension(ip): Extension<TrustedClientIp>) -> String {
            ip.get().to_string()
        }

        let app = console_platform_request_context::with_trusted_client_ip(
            axum::Router::new().route("/__test/client-ip", get(observed_client_ip)),
            2,
            vec!["10.0.0.0/8".parse().unwrap()],
        );
        let mut request = Request::builder()
            .uri("/__test/client-ip")
            .header("x-forwarded-for", "198.51.100.250")
            .body(axum::body::Body::empty())
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo("10.0.0.3:443".parse::<SocketAddr>().unwrap()));

        let response = app.oneshot(request).await.unwrap();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], b"10.0.0.3");
    }

    #[tokio::test]
    async fn ingress_rejects_direct_client_xff_spoofing_even_with_proxy_hops_configured() {
        async fn observed_client_ip(Extension(ip): Extension<TrustedClientIp>) -> String {
            ip.get().to_string()
        }

        let app = console_platform_request_context::with_trusted_client_ip(
            axum::Router::new().route("/__test/client-ip", get(observed_client_ip)),
            1,
            vec!["10.0.0.0/8".parse().unwrap()],
        );
        let mut request = Request::builder()
            .uri("/__test/client-ip")
            .header("x-forwarded-for", "198.51.100.250")
            .body(axum::body::Body::empty())
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo("192.0.2.10:443".parse::<SocketAddr>().unwrap()));

        let response = app.oneshot(request).await.unwrap();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], b"192.0.2.10");
    }
}
