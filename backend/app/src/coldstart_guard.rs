//! INF-06: refuse to boot with the published dev cold-start OTP.
//!
//! Migration 0023 revoked the fixed `coss0000` seed, but boot re-seeds whatever
//! `CONSOLE_COLDSTART_OTP` says. Local development now draws a random code per
//! checkout (`scripts/dev-secrets.ts`), so the published literal has no valid
//! use: a server that carries it is refused whatever the cookie setting
//! (DECISIONS 2026-10-19T18:56:02Z item 2, fail closed).
//!
//! B7 strict: a non-development (release) build refuses dev authentication,
//! whether it is asked for at run time (`CONSOLE_DEV_AUTH`) or compiled in
//! (the `dev-auth` feature; `lib.rs` also refuses that at compile time).
//!
//! Called from `config::env` (`AppConfig::from_env`), just before the config
//! is returned.

/// The retired, published dev cold-start OTP.
const DEV_COLDSTART_OTP: &str = "coss0000";

pub(crate) fn refuse_dev_literal(coldstart_otp: Option<&str>) -> Result<(), String> {
    if coldstart_otp.is_some_and(|otp| otp.trim() == DEV_COLDSTART_OTP) {
        return Err(
            "CONSOLE_COLDSTART_OTP is the published dev value; set a fresh one-time secret \
             (deploy/SECRETS.md; locally scripts/backend-dev.mjs makes one) or unset it"
                .to_owned(),
        );
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BuildProfile {
    Development,
    NonDevelopment,
}

impl BuildProfile {
    pub(crate) const fn current() -> Self {
        if cfg!(debug_assertions) {
            Self::Development
        } else {
            Self::NonDevelopment
        }
    }
}

pub(crate) fn refuse_dev_auth(
    dev_auth_enabled: bool,
    dev_auth_feature_enabled: bool,
    build_profile: BuildProfile,
) -> Result<(), String> {
    if build_profile == BuildProfile::NonDevelopment
        && (dev_auth_enabled || dev_auth_feature_enabled)
    {
        return Err("dev authentication is not allowed in a non-development build".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{BuildProfile, refuse_dev_auth, refuse_dev_literal};

    #[test]
    fn non_development_profile_refuses_dev_auth_marker_or_feature() {
        for (marker, feature) in [(true, false), (false, true), (true, true)] {
            assert!(refuse_dev_auth(marker, feature, BuildProfile::NonDevelopment).is_err());
            assert!(refuse_dev_auth(marker, feature, BuildProfile::Development).is_ok());
        }
    }

    #[test]
    fn non_development_build_allows_boot_without_dev_auth() {
        assert!(refuse_dev_auth(false, false, BuildProfile::NonDevelopment).is_ok());
    }

    #[test]
    fn active_build_profile_controls_dev_auth_guard() {
        let expected_profile = if cfg!(debug_assertions) {
            BuildProfile::Development
        } else {
            BuildProfile::NonDevelopment
        };
        let build_profile = BuildProfile::current();
        assert_eq!(build_profile, expected_profile);
        assert_eq!(
            refuse_dev_auth(true, false, build_profile).is_err(),
            !cfg!(debug_assertions),
            "active profile {build_profile:?}"
        );
    }

    #[test]
    fn dev_literal_refuses_to_boot() {
        assert!(refuse_dev_literal(Some("coss0000")).is_err());
        assert!(refuse_dev_literal(Some(" coss0000\n")).is_err());
    }

    #[test]
    fn fresh_secrets_and_no_otp_still_boot() {
        assert!(refuse_dev_literal(Some("a-fresh-one-time-secret")).is_ok());
        assert!(refuse_dev_literal(None).is_ok());
    }

    #[test]
    fn the_refusal_never_echoes_the_secret() {
        let message = refuse_dev_literal(Some("coss0000")).unwrap_err();
        assert!(!message.contains("coss0000"), "{message}");
    }
}
