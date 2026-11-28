use crate::directory::dto::VisibleDirectoryPerson;
use crate::directory::routes::list_visible_directory_people;
use axum::http::HeaderMap;
use console_identity_adapter_postgres::PgOrgStore;
use console_identity_application::TenantFactsRead;
use console_platform_auth::JwtVerifier;
use console_platform_auth::PasskeyService;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct IdentityRestState {
    pub(crate) integrity_access: fn(&console_platform_authz::Principal) -> (bool, bool),
    pub(crate) calendar_access: fn(&console_platform_authz::Principal) -> bool,
    pub(crate) consulting_access: fn(&console_platform_authz::Principal) -> (bool, bool),
    pub(crate) benefit_access: fn(&console_platform_authz::Principal) -> (bool, bool),
    pub(crate) evaluation_tasks: fn(&console_platform_authz::Principal) -> bool,
    pub(crate) evaluation_cycles: fn(&console_platform_authz::Principal) -> (bool, bool),
    pub(crate) ledger_access: fn(&console_platform_authz::Principal) -> bool,
    pub(crate) documents_served: bool,
    pub(crate) store: PgOrgStore,
    pub(crate) tenant_facts: Arc<dyn TenantFactsRead>,
    pub(crate) jwt_verifier: Option<JwtVerifier>,
    pub(crate) passkey_step_up: Option<PasskeyService>,
}

impl IdentityRestState {
    #[must_use]
    pub fn new(
        store: PgOrgStore,
        jwt_verifier: Option<JwtVerifier>,
        tenant_facts: impl TenantFactsRead + 'static,
    ) -> Self {
        Self {
            calendar_access: |_| false,
            consulting_access: |_| (false, false),
            benefit_access: |_| (false, false),
            evaluation_tasks: |_| false,
            evaluation_cycles: |_| (false, false),
            ledger_access: |_| false,
            documents_served: false,
            integrity_access: |_| (false, false),
            store,
            tenant_facts: Arc::new(tenant_facts),
            jwt_verifier,
            passkey_step_up: None,
        }
    }

    #[must_use]
    pub fn with_passkey_step_up(mut self, passkey_step_up: Option<PasskeyService>) -> Self {
        self.passkey_step_up = passkey_step_up;
        self
    }

    #[must_use]
    pub fn with_documents_served(mut self, served: bool) -> Self {
        self.documents_served = served;
        self
    }

    #[must_use]
    pub fn with_integrity_access(
        mut self,
        access: fn(&console_platform_authz::Principal) -> (bool, bool),
    ) -> Self {
        self.integrity_access = access;
        self
    }

    #[must_use]
    pub fn with_calendar_access(
        mut self,
        access: fn(&console_platform_authz::Principal) -> bool,
    ) -> Self {
        self.calendar_access = access;
        self
    }

    #[must_use]
    pub fn with_evaluation_tasks(
        mut self,
        access: fn(&console_platform_authz::Principal) -> bool,
    ) -> Self {
        self.evaluation_tasks = access;
        self
    }

    #[must_use]
    pub fn with_consulting_access(
        mut self,
        access: fn(&console_platform_authz::Principal) -> (bool, bool),
    ) -> Self {
        self.consulting_access = access;
        self
    }

    #[must_use]
    pub fn with_benefit_access(
        mut self,
        access: fn(&console_platform_authz::Principal) -> (bool, bool),
    ) -> Self {
        self.benefit_access = access;
        self
    }

    #[must_use]
    pub fn with_evaluation_cycles(
        mut self,
        access: fn(&console_platform_authz::Principal) -> (bool, bool),
    ) -> Self {
        self.evaluation_cycles = access;
        self
    }

    #[must_use]
    pub fn with_ledger_access(
        mut self,
        access: fn(&console_platform_authz::Principal) -> bool,
    ) -> Self {
        self.ledger_access = access;
        self
    }

    pub(crate) fn pool(&self) -> &PgPool {
        self.store.pool()
    }

    /// SSR composition helper: the same `EmployeeDirectoryRead` listing as
    /// GET `/directory/people`, or an empty vec (omit) when the caller is
    /// unauthenticated, unauthorized, or the listing fails.
    pub async fn visible_directory_people(
        &self,
        headers: &HeaderMap,
    ) -> Vec<VisibleDirectoryPerson> {
        list_visible_directory_people(self, headers)
            .await
            .unwrap_or_default()
    }
}
