use crate::directory::dto::VisibleDirectoryPerson;
use crate::directory::routes::list_visible_directory_people;
use axum::http::HeaderMap;
use console_identity_adapter_postgres::PgOrgStore;
use console_platform_auth::JwtVerifier;
use console_platform_auth::PasskeyService;
use sqlx::PgPool;

#[derive(Clone)]
pub struct IdentityRestState {
    pub(crate) documents_served: bool,
    pub(crate) store: PgOrgStore,
    pub(crate) jwt_verifier: Option<JwtVerifier>,
    pub(crate) passkey_step_up: Option<PasskeyService>,
}

impl IdentityRestState {
    #[must_use]
    pub fn new(store: PgOrgStore, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            documents_served: false,
            store,
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
