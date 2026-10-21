//! `AppState` construction from an `AppConfig`.

use crate::audit_chain_signer;
use crate::config::AppConfig;
use crate::config::auth::JwtVerifierConfig;
use crate::config::auth::build_view_as_issuer;
use crate::config::auth::policy_step_up_from_auth_config;
use crate::config::role::AppRole;
use crate::error::AppError;
use crate::state::AppState;
use crate::state::DatabaseDependency;
#[cfg(any(debug_assertions, feature = "e2e-test-support"))]
use crate::state::db::migration::migration_database_pool_options;
use crate::state::db::runtime_pool::connect_runtime_pool;
use crate::state::db::serving::connect_command_pool;
#[cfg(any(feature = "dispatch", feature = "support", feature = "mail"))]
use crate::state::modules;
use crate::wiring::realtime::realtime_hub_from_database;
use console_platform_auth_rest::AuthRestState;
use console_platform_email::{DisabledEmailSender, EmailSender, LettreSmtpSender, StubEmailSender};
#[cfg(any(feature = "dispatch", feature = "workorder"))]
use console_platform_jobs::ApalisPostgresJobQueue;
use console_platform_storage::{EvidenceService, SeaweedS3Storage};
use sqlx::PgPool;
use std::sync::Arc;

impl AppState {
    pub fn new(config: AppConfig, database: DatabaseDependency) -> Result<Self, AppError> {
        let jwt_verifier = config
            .jwt
            .as_ref()
            .map(JwtVerifierConfig::build)
            .transpose()?;
        // The view-as issuer is built from the SAME ES256 keypair as auth-rest,
        // so impersonation tokens it mints verify against the live `jwt_verifier`.
        // The per-call TTL override (≤30 min) is enforced in the START handler;
        // the issuer's default TTL here is a backstop of the same length.
        let view_as_issuer = config
            .auth_rest
            .as_ref()
            .map(build_view_as_issuer)
            .transpose()?;
        let policy_step_up = config
            .auth_rest
            .as_ref()
            .map(policy_step_up_from_auth_config)
            .transpose()?;
        let email_sender: Arc<dyn EmailSender> = match config.email.clone() {
            Some(email_config) => Arc::new(
                LettreSmtpSender::new(email_config)
                    .map_err(|err| AppError::Config(format!("invalid email config: {err}")))?,
            ),
            None => match config.email_stub_mode {
                Some(mode) => Arc::new(StubEmailSender::new(mode)),
                None => Arc::new(DisabledEmailSender),
            },
        };
        let auth_rest = match &database {
            DatabaseDependency::Postgres(pool) => match &config.auth_rest {
                Some(auth_config) => Some(
                    AuthRestState::new(pool.clone(), auth_config.clone())
                        .map_err(|err| {
                            AppError::Config(format!("invalid auth REST config: {err}"))
                        })?
                        .with_email_sender(email_sender.clone()),
                ),
                None => Some(AuthRestState::disabled(pool.clone())),
            },
            DatabaseDependency::NotConfigured => None,
        };
        let audit_attestation_signer =
            audit_chain_signer::build_attestation_signer(config.audit_chain_external.as_ref())?;
        let realtime_hub = realtime_hub_from_database(&database);
        let juso = Arc::new(console_entity_adapter_juso::JusoClient::new(
            config.juso.clone(),
        ));

        Ok(Self {
            config,
            database,
            leave_command_database: DatabaseDependency::NotConfigured,
            ontology_command_database: DatabaseDependency::NotConfigured,
            platform_force_command_database: DatabaseDependency::NotConfigured,
            #[cfg(any(debug_assertions, feature = "e2e-test-support"))]
            e2e_fixture_database: DatabaseDependency::NotConfigured,
            jwt_verifier,
            view_as_issuer,
            policy_step_up,
            auth_rest,
            evidence_storage: None,
            sales_media_storage: None,
            #[cfg(feature = "docs")]
            worm_evidence_storage: None,
            #[cfg(any(feature = "dispatch", feature = "workorder"))]
            dispatch_job_queue: None,
            #[cfg(any(feature = "dispatch", feature = "support"))]
            push_notifier: None,
            email_sender,
            realtime_hub,
            realtime_bridge: None,
            #[cfg(feature = "mail")]
            mail_cipher: None,
            #[cfg(feature = "mail")]
            mail_sync_handle: None,
            audit_attestation_signer,
            juso,
            draining: Arc::default(),
        })
    }

    /// Attach the isolated `console_leave_cmd` command pool used for protected
    /// leave and People mutations. Production configuration constructs this
    /// pool only from `LEAVE_COMMAND_DATABASE_URL`; this builder supports
    /// explicit dependency injection for integration composition.
    #[must_use]
    pub fn with_leave_command_database(mut self, pool: PgPool) -> Self {
        self.leave_command_database = DatabaseDependency::Postgres(pool);
        self
    }

    #[must_use]
    pub fn with_platform_force_command_database(mut self, pool: PgPool) -> Self {
        self.platform_force_command_database = DatabaseDependency::Postgres(pool);
        self
    }

    pub async fn from_config(config: AppConfig) -> Result<Self, AppError> {
        let database = match config.database_url.as_deref() {
            Some(url) => DatabaseDependency::Postgres(connect_runtime_pool(url, &config).await?),
            None => DatabaseDependency::NotConfigured,
        };

        let leave_command_database = match (
            config.role,
            config.database_url.as_ref(),
            config.leave_command_database_url.as_deref(),
        ) {
            (AppRole::Api, Some(_), Some(url)) => DatabaseDependency::Postgres(
                connect_command_pool(
                    url,
                    "console_leave_cmd",
                    "LEAVE_COMMAND_DATABASE_URL",
                    &config,
                )
                .await?,
            ),
            _ => DatabaseDependency::NotConfigured,
        };
        let ontology_command_database = match (
            config.role,
            config.database_url.as_ref(),
            config.ontology_command_database_url.as_deref(),
        ) {
            (AppRole::Api, Some(_), Some(url)) => DatabaseDependency::Postgres(
                connect_command_pool(
                    url,
                    "console_ontology_cmd",
                    "ONTOLOGY_COMMAND_DATABASE_URL",
                    &config,
                )
                .await?,
            ),
            _ => DatabaseDependency::NotConfigured,
        };
        let platform_force_command_database = match (
            config.role,
            config.database_url.as_ref(),
            config.platform_force_command_database_url.as_deref(),
        ) {
            (AppRole::Api, Some(_), Some(url)) => DatabaseDependency::Postgres(
                connect_command_pool(
                    url,
                    "console_platform_force_cmd",
                    "PLATFORM_FORCE_COMMAND_DATABASE_URL",
                    &config,
                )
                .await?,
            ),
            _ => DatabaseDependency::NotConfigured,
        };
        #[cfg(any(debug_assertions, feature = "e2e-test-support"))]
        let e2e_fixture_database = match config.e2e_fixture_database_url.as_deref() {
            Some(url) => DatabaseDependency::Postgres(
                migration_database_pool_options()
                    .connect(url)
                    .await
                    .map_err(AppError::Database)?,
            ),
            None => DatabaseDependency::NotConfigured,
        };

        let mut state = Self::new(config.clone(), database)?;
        state.leave_command_database = leave_command_database;
        state.ontology_command_database = ontology_command_database;
        state.platform_force_command_database = platform_force_command_database;
        #[cfg(any(debug_assertions, feature = "e2e-test-support"))]
        {
            state.e2e_fixture_database = e2e_fixture_database;
        }
        if let (DatabaseDependency::Postgres(pool), Some(storage_config)) =
            (&state.database, config.storage.as_ref())
        {
            let object_store = SeaweedS3Storage::from_config(storage_config)
                .await
                .map_err(AppError::Storage)?;
            state.sales_media_storage =
                Some((object_store.clone(), storage_config.primary_bucket.clone()));
            #[cfg(feature = "docs")]
            {
                state.worm_evidence_storage =
                    Some((object_store.clone(), storage_config.replica_bucket.clone()));
            }
            state.evidence_storage = Some(EvidenceService::new(
                pool.clone(),
                object_store,
                storage_config.primary_bucket.clone(),
                storage_config.replica_bucket.clone(),
            ));
        }
        #[cfg(any(feature = "dispatch", feature = "workorder"))]
        if let (DatabaseDependency::Postgres(_), Some(database_url)) =
            (&state.database, config.database_url.as_deref())
            && config.dispatch_jobs_enabled
        {
            let queue = ApalisPostgresJobQueue::connect(database_url, "console.dispatch")
                .await
                .map_err(|err| AppError::Config(format!("invalid dispatch job queue: {err}")))?;
            state.dispatch_job_queue = Some(Arc::new(queue));
        }
        #[cfg(any(feature = "dispatch", feature = "support"))]
        modules::attach_push_notifier(&mut state, &config)?;
        if let Some(email_config) = config.email.clone() {
            let sender = LettreSmtpSender::new(email_config)
                .map_err(|err| AppError::Config(format!("invalid email config: {err}")))?;
            state.email_sender = Arc::new(sender);
        } else if let Some(mode) = config.email_stub_mode {
            state.email_sender = Arc::new(StubEmailSender::new(mode));
            tracing::warn!(
                email_stub_mode = %mode,
                "CONSOLE_EMAIL_STUB_MODE enabled: outbound OTP email uses the logging stub (non-production only)"
            );
        } else {
            tracing::warn!(
                "CONSOLE_EMAIL_* unset and CONSOLE_EMAIL_STUB_MODE disabled: outbound OTP email fails closed without logging OTPs"
            );
        }
        // Hand the resolved OTP email sender to the auth REST layer so its
        // open-signup endpoint (#38) can deliver the code. Done here (not in
        // `AppState::new`) because the live SMTP sender is only known once
        // `config.email` is resolved above.
        if let Some(auth_rest) = state.auth_rest.take() {
            state.auth_rest = Some(auth_rest.with_email_sender(state.email_sender.clone()));
        }
        #[cfg(feature = "mail")]
        modules::attach_mail_cipher(&mut state)?;
        if let Some(hub) = state.realtime_hub.clone() {
            state.realtime_bridge = Some(
                hub.start_postgres_listener()
                    .await
                    .map_err(AppError::Realtime)?,
            );
        }
        #[cfg(feature = "mail")]
        modules::spawn_mail_sync(&mut state, &config);
        Ok(state)
    }

    pub fn config(&self) -> &AppConfig {
        &self.config
    }

    /// Outbound OTP email sender. Always present: live SMTP, explicit non-prod
    /// logging stub, or fail-closed disabled sender.
    #[must_use]
    pub fn email_sender(&self) -> Arc<dyn EmailSender> {
        self.email_sender.clone()
    }

    pub async fn shutdown_realtime(&self) {
        if let Some(bridge) = &self.realtime_bridge {
            bridge.shutdown();
        }
        if let Some(hub) = &self.realtime_hub {
            hub.shutdown().await;
        }
        #[cfg(feature = "mail")]
        if let Some(handle) = &self.mail_sync_handle {
            handle.shutdown();
        }
    }
}
