use url::Url;

/// Build the QR-encoded enrollment URL `{rp_origin}/login#otp=<handoff>` from the
/// validated console origin and the freshly minted handoff code. The OTP is an
/// auth secret, so keep it out of query strings that are commonly logged by
/// servers and proxies; the fragment stays client-side and is cleared by the UI.
pub(crate) fn build_enroll_url(rp_origin: &Url, otp: &str, approve_token: Option<&str>) -> String {
    let mut url = rp_origin.clone();
    url.set_path("/login");
    url.set_query(None);
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("otp", otp);
    if let Some(approve_token) = approve_token {
        serializer.append_pair("desktop_approve", approve_token);
    }
    let fragment = serializer.finish();
    url.set_fragment(Some(&fragment));
    url.to_string()
}

/// Build the QR-encoded approval URL `{rp_origin}/login#desktop_approve=<token>`.
/// The approve token is a short-lived bearer secret, so it stays in the fragment
/// and is never enough to poll/receive the desktop token pair.
pub(crate) fn build_device_login_approve_url(rp_origin: &Url, approve_token: &str) -> String {
    let mut url = rp_origin.clone();
    url.set_path("/login");
    url.set_query(None);
    let fragment = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("desktop_approve", approve_token)
        .finish();
    url.set_fragment(Some(&fragment));
    url.to_string()
}

#[cfg(test)]
mod tests {
    use super::build_enroll_url;

    use url::Url;

    use url::form_urlencoded;

    #[test]
    fn build_enroll_url_keeps_otp_out_of_query_string() -> Result<(), url::ParseError> {
        let origin = Url::parse("https://console.example.com/app?ignored=1")?;
        let otp = "A&c#%_!9";

        let enroll_url = build_enroll_url(&origin, otp, None);
        let parsed = Url::parse(&enroll_url)?;
        let decoded = parsed.fragment().and_then(|fragment| {
            form_urlencoded::parse(fragment.as_bytes())
                .find(|(key, _)| key == "otp")
                .map(|(_, value)| value.into_owned())
        });

        assert_eq!(parsed.path(), "/login");
        assert!(parsed.query().is_none());
        assert_eq!(decoded.as_deref(), Some(otp));
        assert!(!enroll_url.contains("?otp="));
        Ok(())
    }
}
