//! INF-06: refuse to boot with the published dev cold-start OTP.
//!
//! Migration 0023 revoked the fixed `coss0000` seed, but boot re-seeds whatever
//! `CONSOLE_COLDSTART_OTP` says. Local development now draws a random code per
//! checkout (`scripts/dev-secrets.ts`), so the published literal has no valid
//! use: a server that carries it is refused whatever the cookie setting
//! (DECISIONS 2026-10-19T18:56:02Z item 2, fail closed).
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

#[cfg(test)]
mod tests {
    use super::refuse_dev_literal;

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
