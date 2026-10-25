// SPDX-License-Identifier: LicenseRef-Proprietary
//! Setup shared by the guarded and governed removal regression cases.
use super::*;

pub(super) async fn fixture(owner: &PgPool, force: bool) -> (Uuid, [Uuid; 2], Uuid) {
    let org:Uuid=sqlx::query_scalar("INSERT INTO organizations(slug,name,status) VALUES($1,'Removal lock test',$2) RETURNING id").bind(format!("lock-{}", &Uuid::new_v4().simple().to_string()[..16])).bind(if force{"ARCHIVED"}else{"ACTIVE"}).fetch_one(owner).await.unwrap();
    let mut users = [Uuid::new_v4(), Uuid::new_v4()];
    users.sort();
    for id in users {
        sqlx::query("INSERT INTO users(id,display_name,roles,org_id) VALUES($1,'Lock target',ARRAY['MEMBER'],$2)").bind(id).bind(org).execute(owner).await.unwrap();
    }
    let actor:Uuid=sqlx::query_scalar("INSERT INTO users(display_name,roles,org_id) VALUES('Separate actor',ARRAY['SUPER_ADMIN'],$1) RETURNING id").bind(*OrgId::platform().as_uuid()).fetch_one(owner).await.unwrap();
    if force {
        governed_erase::due(owner, org, actor).await;
    }
    (org, users, actor)
}
