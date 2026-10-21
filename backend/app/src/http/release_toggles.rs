//! B-15: release toggles, deploy separate from release (Fowler's "release
//! toggle": static per-deployment config, short-lived, removed once the
//! feature is fully out). `CONSOLE_RELEASE_TOGGLES=a,b` names the features
//! released on this deployment; the SPA reads `GET /api/v1/release-toggles`
//! once at boot and shows a toggled feature only when its name is listed. An
//! unlisted or misspelt name is off, so a toggle fails safe.

use axum::Json;
use axum::extract::State;

use crate::error::AppError;
use crate::state::AppState;

/// Parse and validate the comma list (lowercase `a-z0-9-`, at most 40 chars).
pub(crate) fn parse(raw: Option<&String>) -> Result<Vec<String>, AppError> {
    let mut names: Vec<String> = Vec::new();
    for name in raw
        .map(String::as_str)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
    {
        if name.is_empty() {
            continue;
        }
        let valid = name.len() <= 40
            && name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !valid {
            return Err(AppError::Config(format!(
                "CONSOLE_RELEASE_TOGGLES: {name:?} is not a toggle name (a-z, 0-9, -; at most 40)"
            )));
        }
        if !names.iter().any(|known| known == name) {
            names.push(name.to_owned());
        }
    }
    Ok(names)
}

/// `GET /api/v1/release-toggles`: unauthenticated (the login screen may be
/// toggled too); the names are deployment config, not tenant data.
pub(crate) async fn release_toggles(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "enabled": state.config.release_toggles }))
}

#[cfg(test)]
mod tests {
    use axum::body::{Body, to_bytes};
    use http::Request;
    use tower::ServiceExt;

    use super::parse;
    use crate::config::AppConfig;
    use crate::routes::build_router;
    use crate::state::{AppState, DatabaseDependency};

    #[tokio::test]
    async fn the_spa_reads_the_released_names_unauthenticated() {
        let config = AppConfig::from_pairs([
            ("CONSOLE_HTTP_ADDR", "127.0.0.1:0"),
            ("CONSOLE_RELEASE_TOGGLES", "new-payslip"),
        ])
        .unwrap();
        let app = build_router(AppState::new(config, DatabaseDependency::NotConfigured).unwrap());
        let response = app
            .oneshot(
                Request::get("/api/v1/release-toggles")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), http::StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(&body[..], br#"{"enabled":["new-payslip"]}"#);
    }

    #[test]
    fn names_are_validated_trimmed_and_deduplicated() {
        let raw = " new-payslip, bulk-sheet ,,new-payslip".to_owned();
        assert_eq!(parse(Some(&raw)).unwrap(), ["new-payslip", "bulk-sheet"]);
        assert!(parse(None).unwrap().is_empty());
        for bad in ["New-Payslip", "a b", "x;y", &"a".repeat(41)] {
            assert!(parse(Some(&bad.to_owned())).is_err(), "{bad}");
        }
    }
}
