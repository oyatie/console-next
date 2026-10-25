// SPDX-License-Identifier: LicenseRef-Proprietary
//! Setup shared by the guarded and governed removal regression cases.
use super::*;

pub(super) async fn company(owner: &PgPool, force: bool) -> (Uuid, Uuid, Uuid) {
    let org: Uuid = sqlx::query_scalar(
        "INSERT INTO organizations(slug,name,status) VALUES($1,'Identity removal',$2) RETURNING id",
    )
    .bind(format!(
        "identity-{}",
        &Uuid::new_v4().simple().to_string()[..12]
    ))
    .bind(if force { "ARCHIVED" } else { "ACTIVE" })
    .fetch_one(owner)
    .await
    .unwrap();
    let user = Uuid::new_v4();
    let actor = Uuid::new_v4();
    insert(owner, org, user).await.unwrap();
    insert(owner, *OrgId::platform().as_uuid(), actor)
        .await
        .unwrap();
    if force {
        governed_erase::due(owner, org, actor).await;
    }
    (org, user, actor)
}
