//! Office editor config (ONLYOFFICE DocumentServer). Parsed in every build so the
//! env contract does not depend on which modules are compiled in; the office
//! routes themselves are the `office` feature (`crate::office`).

/// Office integration config. Present only when all of `CONSOLE_OFFICE_JWT_SECRET`,
/// `CONSOLE_OFFICE_CALLBACK_BASE_URL`, and `CONSOLE_OFFICE_DOCSERVER_URL` are set.
#[derive(Debug, Clone)]
pub struct OfficeConfig {
    /// Shared HS256 secret — identical to the DocumentServer JWT secret. Signs
    /// the editor config + callback token, and verifies the inbound callback.
    pub jwt_secret: String,
    /// Public base URL DocumentServer uses to reach the host callback (in dev,
    /// `http://host.docker.internal:8090`). Becomes `editorConfig.callbackUrl`.
    pub callback_base_url: String,
    /// DocumentServer origin the browser loads `api.js` from — and the host
    /// allowlist for the callback-produced document URL (SSRF guard).
    pub docserver_url: String,
}

/// Parse [`OfficeConfig`] from env. Returns `None` (office disabled) unless all
/// three vars are present, and errors only if a present value is malformed.
pub fn office_config_from_vars(
    get: impl Fn(&str) -> Option<String>,
) -> Result<Option<OfficeConfig>, String> {
    let secret = get("CONSOLE_OFFICE_JWT_SECRET").filter(|s| !s.trim().is_empty());
    let callback_base_url =
        get("CONSOLE_OFFICE_CALLBACK_BASE_URL").filter(|s| !s.trim().is_empty());
    let docserver_url = get("CONSOLE_OFFICE_DOCSERVER_URL").filter(|s| !s.trim().is_empty());
    match (secret, callback_base_url, docserver_url) {
        (Some(jwt_secret), Some(callback_base_url), Some(docserver_url)) => {
            // Validate the docserver URL up front so the SSRF host allowlist has
            // a real host to compare against.
            url::Url::parse(&docserver_url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_owned))
                .ok_or_else(|| "CONSOLE_OFFICE_DOCSERVER_URL must be an absolute URL".to_owned())?;
            Ok(Some(OfficeConfig {
                jwt_secret,
                callback_base_url: callback_base_url.trim_end_matches('/').to_owned(),
                docserver_url,
            }))
        }
        (None, None, None) => Ok(None),
        _ => Err(
            "office editor needs all of CONSOLE_OFFICE_JWT_SECRET, CONSOLE_OFFICE_CALLBACK_BASE_URL, \
             CONSOLE_OFFICE_DOCSERVER_URL, or none"
                .to_owned(),
        ),
    }
}
