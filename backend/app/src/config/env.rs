//! `AppConfig::from_env` / `from_pairs`: the environment parser.

use crate::audit_chain_signer;
use crate::config::AppConfig;
use crate::config::DEFAULT_COLDSTART_OTP_TTL_SECS;
use crate::config::DEFAULT_EVIDENCE_TRANSCODE_CONCURRENCY;
use crate::config::DEFAULT_HTTP_ADDR;
use crate::config::DEFAULT_JWT_AUDIENCE;
use crate::config::DEFAULT_JWT_ISSUER;
use crate::config::DEFAULT_SERVICE_NAME;
use crate::config::DEFAULT_SHUTDOWN_TIMEOUT_SECS;
use crate::config::REQUEST_TIMEOUT;
use crate::config::auth::access_token_ttl_from_vars;
use crate::config::auth::auth_rest_config_from_vars;
use crate::config::auth::{JwtVerifierConfig, verification_key_set};
use crate::config::database::validate_database_urls;
use crate::config::db_pool::DbPoolConfig;
use crate::config::dispatch::dispatch_timer_config_from_vars;
use crate::config::email::email_config_from_vars;
use crate::config::email::email_stub_mode_from_vars;
use crate::config::links::app_links_config_from_vars;
use crate::config::notify::fcm_config_from_vars;
use crate::config::notify::solapi_config_from_vars;
use crate::config::office;
use crate::config::parse::non_empty;
use crate::config::parse::parse_time_duration_secs;
use crate::config::proxy::parse_trusted_proxy_cidrs;
use crate::config::proxy::parse_trusted_proxy_count;
use crate::config::storage::storage_config_from_vars;
use crate::error::AppError;
use base64::Engine as _;
use console_kernel_core::OrgId;
#[cfg(any(debug_assertions, feature = "e2e-test-support"))]
use console_platform_email::StubEmailMode;
use std::collections::HashMap;
use std::env;
use std::net::SocketAddr;
use std::str::FromStr;
use std::time::Duration;

impl AppConfig {
    pub fn from_env() -> Result<Self, AppError> {
        Self::from_pairs(env::vars())
    }

    pub fn from_pairs<I, K, V>(pairs: I) -> Result<Self, AppError>
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        let mut vars: HashMap<String, String> = pairs
            .into_iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect();
        crate::config::secret_files::resolve_file_vars(&mut vars)?;

        let role = vars
            .get("CONSOLE_APP_ROLE")
            .map(String::as_str)
            .unwrap_or("api")
            .parse()?;
        let service_name = vars
            .get("OTEL_SERVICE_NAME")
            .or_else(|| vars.get("CONSOLE_SERVICE_NAME"))
            .cloned()
            .unwrap_or_else(|| DEFAULT_SERVICE_NAME.to_owned());
        let http_addr = vars
            .get("CONSOLE_HTTP_ADDR")
            .map(String::as_str)
            .unwrap_or(DEFAULT_HTTP_ADDR)
            .parse::<SocketAddr>()
            .map_err(|err| AppError::Config(format!("invalid CONSOLE_HTTP_ADDR: {err}")))?;
        let internal_addr = non_empty(vars.get("CONSOLE_INTERNAL_ADDR"))
            .map(|addr| addr.parse::<SocketAddr>())
            .transpose()
            .map_err(|err| AppError::Config(format!("invalid CONSOLE_INTERNAL_ADDR: {err}")))?;
        let database_url = non_empty(vars.get("DATABASE_URL"));
        let leave_command_database_url = non_empty(vars.get("LEAVE_COMMAND_DATABASE_URL"));
        let ontology_command_database_url = non_empty(vars.get("ONTOLOGY_COMMAND_DATABASE_URL"));
        let platform_force_command_database_url =
            non_empty(vars.get("PLATFORM_FORCE_COMMAND_DATABASE_URL"));
        validate_database_urls(
            role,
            database_url.as_deref(),
            leave_command_database_url.as_deref(),
            ontology_command_database_url.as_deref(),
            platform_force_command_database_url.as_deref(),
        )?;
        let otlp_endpoint = non_empty(vars.get("OTEL_EXPORTER_OTLP_ENDPOINT"));
        let jwt_public_key_pem = non_empty(vars.get("CONSOLE_JWT_PUBLIC_KEY_PEM"));
        let access_token_ttl = access_token_ttl_from_vars(&vars)?;
        let jwt_has_partial_config = jwt_public_key_pem.is_none()
            && (non_empty(vars.get("CONSOLE_JWT_ISSUER")).is_some()
                || non_empty(vars.get("CONSOLE_JWT_AUDIENCE")).is_some());
        if jwt_has_partial_config {
            return Err(AppError::Config(
                "CONSOLE_JWT_PUBLIC_KEY_PEM is required when JWT issuer/audience is configured"
                    .to_owned(),
            ));
        }
        let jwt = jwt_public_key_pem
            .map(|current| {
                Ok::<_, AppError>(JwtVerifierConfig {
                    issuer: non_empty(vars.get("CONSOLE_JWT_ISSUER"))
                        .unwrap_or_else(|| DEFAULT_JWT_ISSUER.to_owned()),
                    audience: non_empty(vars.get("CONSOLE_JWT_AUDIENCE"))
                        .unwrap_or_else(|| DEFAULT_JWT_AUDIENCE.to_owned()),
                    access_token_ttl,
                    public_key_pem: verification_key_set(
                        current,
                        non_empty(vars.get("CONSOLE_JWT_ROTATION_PUBLIC_KEYS")),
                    )?,
                })
            })
            .transpose()?;
        let auth_rest = auth_rest_config_from_vars(&vars, jwt.as_ref())?;
        let storage = storage_config_from_vars(&vars)?;
        let dispatch_timers = dispatch_timer_config_from_vars(&vars)?;
        let dispatch_jobs_enabled = match vars.get("CONSOLE_DISPATCH_JOBS_ENABLED") {
            Some(raw) => raw.parse::<bool>().map_err(|err| {
                AppError::Config(format!("invalid CONSOLE_DISPATCH_JOBS_ENABLED: {err}"))
            })?,
            None => true,
        };
        let evidence_transcode_concurrency =
            match vars.get("CONSOLE_EVIDENCE_TRANSCODE_CONCURRENCY") {
                Some(raw) => raw
                    .parse::<usize>()
                    .map_err(|err| {
                        AppError::Config(format!(
                            "invalid CONSOLE_EVIDENCE_TRANSCODE_CONCURRENCY: {err}"
                        ))
                    })
                    .map(|value| value.max(1))?,
                None => DEFAULT_EVIDENCE_TRANSCODE_CONCURRENCY,
            };
        let fcm = fcm_config_from_vars(&vars)?;
        let (solapi, solapi_disabled_reason) = solapi_config_from_vars(&vars)?;
        let email_stub_mode = email_stub_mode_from_vars(&vars)?;
        let email = email_config_from_vars(&vars, email_stub_mode)?;
        #[cfg(any(debug_assertions, feature = "e2e-test-support"))]
        let e2e_fixture_database_url = non_empty(vars.get("CONSOLE_E2E_FIXTURE_DATABASE_URL"));
        #[cfg(any(debug_assertions, feature = "e2e-test-support"))]
        if e2e_fixture_database_url.is_some()
            && (email_stub_mode != Some(StubEmailMode::E2e)
                || role != crate::config::role::AppRole::Api)
        {
            return Err(AppError::Config(
                "CONSOLE_E2E_FIXTURE_DATABASE_URL requires the API role and CONSOLE_EMAIL_STUB_MODE=e2e"
                    .to_owned(),
            ));
        }
        let shutdown_timeout = match vars.get("CONSOLE_SHUTDOWN_TIMEOUT_SECS") {
            Some(raw) => raw.parse::<u64>().map(Duration::from_secs).map_err(|err| {
                AppError::Config(format!("invalid CONSOLE_SHUTDOWN_TIMEOUT_SECS: {err}"))
            })?,
            None => Duration::from_secs(DEFAULT_SHUTDOWN_TIMEOUT_SECS),
        };
        let request_timeout = match vars.get("CONSOLE_REQUEST_TIMEOUT_SECS") {
            Some(raw) => raw.parse::<u64>().map(Duration::from_secs).map_err(|err| {
                AppError::Config(format!("invalid CONSOLE_REQUEST_TIMEOUT_SECS: {err}"))
            })?,
            None => REQUEST_TIMEOUT,
        };
        let db_pool = DbPoolConfig::from_vars(|name| vars.get(name).cloned())?;
        let coldstart_otp = non_empty(vars.get("CONSOLE_COLDSTART_OTP"));
        let coldstart_otp_ttl = parse_time_duration_secs(
            vars.get("CONSOLE_COLDSTART_OTP_TTL_SECS"),
            DEFAULT_COLDSTART_OTP_TTL_SECS,
            "CONSOLE_COLDSTART_OTP_TTL_SECS",
        )?;
        let trusted_proxy_count =
            parse_trusted_proxy_count(vars.get("CONSOLE_TRUSTED_PROXY_COUNT"))?;
        let trusted_proxy_cidrs = parse_trusted_proxy_cidrs(
            vars.get("CONSOLE_TRUSTED_PROXY_CIDRS"),
            trusted_proxy_count,
        )?;
        let app_links = app_links_config_from_vars(&vars);
        let mail_enabled = match vars.get("CONSOLE_MAIL_ENABLED") {
            Some(raw) => raw
                .parse::<bool>()
                .map_err(|err| AppError::Config(format!("invalid CONSOLE_MAIL_ENABLED: {err}")))?,
            None => false,
        };
        let mail_mox_base_url = non_empty(vars.get("CONSOLE_MAIL_MOX_BASE_URL"));
        let mail_mox_webhook_secret = non_empty(vars.get("CONSOLE_MAIL_MOX_WEBHOOK_SECRET"));
        let audit_chain_seal_enabled = match vars.get("CONSOLE_AUDIT_CHAIN_SEAL_ENABLED") {
            Some(raw) => raw.parse::<bool>().map_err(|err| {
                AppError::Config(format!("invalid CONSOLE_AUDIT_CHAIN_SEAL_ENABLED: {err}"))
            })?,
            None => false,
        };
        let audit_chain_external =
            audit_chain_signer::external_config_from_vars(|key| non_empty(vars.get(key)))?;
        let audit_chain_allow_dev_signer = match vars.get("CONSOLE_AUDIT_CHAIN_ALLOW_DEV_SIGNER") {
            Some(raw) => raw.parse::<bool>().map_err(|err| {
                AppError::Config(format!(
                    "invalid CONSOLE_AUDIT_CHAIN_ALLOW_DEV_SIGNER: {err}"
                ))
            })?,
            None => false,
        };
        let storefront_org = match non_empty(vars.get("STOREFRONT_ORG_ID")) {
            Some(raw) => Some(
                OrgId::from_str(&raw)
                    .map_err(|err| AppError::Config(format!("invalid STOREFRONT_ORG_ID: {err}")))?,
            ),
            None => None,
        };
        let office = office::office_config_from_vars(|key| non_empty(vars.get(key)))
            .map_err(AppError::Config)?;
        let production_service_principal_hmac_key =
            non_empty(vars.get("CONSOLE_PRODUCTION_SERVICE_PRINCIPAL_HMAC_KEY"))
                .map(|encoded| {
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(encoded)
                        .map_err(|_| {
                            AppError::Config(
                                "CONSOLE_PRODUCTION_SERVICE_PRINCIPAL_HMAC_KEY must be base64"
                                    .to_owned(),
                            )
                        })?;
                    bytes.try_into().map_err(|_: Vec<u8>| {
                        AppError::Config(
                    "CONSOLE_PRODUCTION_SERVICE_PRINCIPAL_HMAC_KEY must decode to exactly 32 bytes"
                        .to_owned(),
                )
                    })
                })
                .transpose()?;
        // INF-06: the published dev OTP never boots, whatever the cookie setting.
        crate::coldstart_guard::refuse_dev_literal(coldstart_otp.as_deref())
            .map_err(AppError::Config)?;

        Ok(Self {
            role,
            service_name,
            http_addr,
            internal_addr,
            release_toggles: crate::http::release_toggles::parse(
                vars.get("CONSOLE_RELEASE_TOGGLES"),
            )?,
            database_url,
            leave_command_database_url,
            ontology_command_database_url,
            platform_force_command_database_url,
            otlp_endpoint,
            jwt,
            auth_rest,
            storage,
            juso: console_entity_adapter_juso::JusoConfig::from_lookup(|k| vars.get(k).cloned()),
            dispatch_timers,
            dispatch_jobs_enabled,
            evidence_transcode_concurrency,
            fcm,
            solapi,
            solapi_disabled_reason,
            email,
            email_stub_mode,
            #[cfg(any(debug_assertions, feature = "e2e-test-support"))]
            e2e_fixture_database_url,
            shutdown_timeout,
            request_timeout,
            db_pool,
            coldstart_otp,
            coldstart_otp_ttl,
            trusted_proxy_count,
            trusted_proxy_cidrs,
            app_links,
            mail_enabled,
            mail_mox_base_url,
            mail_mox_webhook_secret,
            audit_chain_seal_enabled,
            audit_chain_external,
            audit_chain_allow_dev_signer,
            storefront_org,
            office,
            production_service_principal_hmac_key,
            web_dist: non_empty(vars.get("CONSOLE_WEB_DIST")).map(std::path::PathBuf::from),
        })
    }
}
