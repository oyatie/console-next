// SPDX-License-Identifier: LicenseRef-Proprietary
use console_platform_authz::{Principal, cedar_pbac::visible::load_facts};
use console_platform_db::{DbError, with_org_conn};
use sqlx::PgPool;
use uuid::Uuid;

pub(super) async fn may_read(pool: &PgPool, principal: &Principal, id: &str) -> bool {
    let Ok(owner) = Uuid::parse_str(id) else {
        return false;
    };
    let org = principal.org_id;
    let actor = *principal.user_id.as_uuid();
    with_org_conn::<_, _, DbError>(pool, org, |tx| {
        Box::pin(async move {
            let facts = load_facts(tx, org, actor)
                .await
                .map_err(|e| DbError::Sqlx(sqlx::Error::Protocol(e.to_string())))?;
            Ok(facts.authorize_employee_view(org, owner).unwrap_or(false))
        })
    })
    .await
    .unwrap_or(false)
}
