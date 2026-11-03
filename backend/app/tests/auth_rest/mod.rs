// SPDX-License-Identifier: LicenseRef-Proprietary

use super::*;

mod consent;
mod credential_issue_access;
mod credential_reset_access;

async fn seed_credential_role(pool: &PgPool, actor: UserId, include_pay: bool) -> Uuid {
    let role = Uuid::new_v4();
    let name = if include_pay {
        "초대 권한 검증"
    } else {
        "계정 관리 전용"
    };
    sqlx::query(
        "INSERT INTO access_roles (org_id,id,name_ko,status,version,created_by) \
         VALUES ($1,$2,$3,'ACTIVE',1,$4)",
    )
    .bind(OrgId::one().as_uuid())
    .bind(role)
    .bind(name)
    .bind(actor.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO access_role_versions \
         (org_id,role_id,version,name_ko,status,change_mode,created_by) \
         VALUES ($1,$2,1,$3,'ACTIVE','SETUP',$4)",
    )
    .bind(OrgId::one().as_uuid())
    .bind(role)
    .bind(name)
    .bind(actor.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) \
         SELECT $1,$2,1,'access',ARRAY['edit'] \
         UNION ALL SELECT $1,$2,1,'pay',ARRAY['view'] WHERE $3",
    )
    .bind(OrgId::one().as_uuid())
    .bind(role)
    .bind(include_pay)
    .execute(pool)
    .await
    .unwrap();
    role
}
