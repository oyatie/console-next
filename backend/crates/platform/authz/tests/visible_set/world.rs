// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::OrgId;
use console_platform_authz::access::{NodeKind, NodeRef};
use console_platform_test_support::{seed_active_user, seed_org_and_super_admin};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

pub const KINDS: [NodeKind; 4] = [
    NodeKind::Tenant,
    NodeKind::LegalEntity,
    NodeKind::Workplace,
    NodeKind::Department,
];

pub struct World {
    pub org: OrgId,
    pub nodes: Vec<NodeRef>,
    role: Uuid,
    maker: Uuid,
}

impl World {
    pub async fn seed(pool: &PgPool, shape: &[Vec<usize>]) -> Self {
        let org = OrgId::from_uuid(Uuid::new_v4());
        let maker = *seed_org_and_super_admin(pool, *org.as_uuid(), "visible")
            .await
            .as_uuid();
        let role = Uuid::new_v4();
        sqlx::query("INSERT INTO access_roles (org_id,id,name_ko,status,version,created_by) VALUES ($1,$2,'조회','ACTIVE',1,$3)")
            .bind(org.as_uuid()).bind(role).bind(maker).execute(pool).await.unwrap();
        sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,'조회','ACTIVE','SETUP',$3)")
            .bind(org.as_uuid()).bind(role).bind(maker).execute(pool).await.unwrap();
        sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'hr_basic',ARRAY['view'])")
            .bind(org.as_uuid()).bind(role).execute(pool).await.unwrap();
        let mut nodes = vec![NodeRef {
            kind: NodeKind::Tenant,
            id: *org.as_uuid(),
        }];
        for workplaces in shape {
            let le = Uuid::new_v4();
            sqlx::query("INSERT INTO legal_entities (org_id,id,needs_confirmation,created_change_mode) VALUES ($1,$2,true,'MIGRATION')")
                .bind(org.as_uuid()).bind(le).execute(pool).await.unwrap();
            nodes.push(NodeRef {
                kind: NodeKind::LegalEntity,
                id: le,
            });
            for depth in workplaces {
                let wp = Uuid::new_v4();
                sqlx::query("INSERT INTO workplaces (org_id,id,legal_entity_id,needs_confirmation,created_change_mode) VALUES ($1,$2,$3,true,'MIGRATION')")
                    .bind(org.as_uuid()).bind(wp).bind(le).execute(pool).await.unwrap();
                nodes.push(NodeRef {
                    kind: NodeKind::Workplace,
                    id: wp,
                });
                let mut parent = None;
                for _ in 0..*depth {
                    let unit = Uuid::new_v4();
                    sqlx::query("INSERT INTO org_units (org_id,id) VALUES ($1,$2)")
                        .bind(org.as_uuid())
                        .bind(unit)
                        .execute(pool)
                        .await
                        .unwrap();
                    sqlx::query("INSERT INTO org_unit_revisions (org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) VALUES ($1,$2,1,$3,$4,$5,$6,'{}')")
                        .bind(org.as_uuid()).bind(unit).bind(Uuid::new_v4()).bind(maker).bind(vec![0u8; 32])
                        .bind(serde_json::json!({"parent_id": parent, "status": "active"})).execute(pool).await.unwrap();
                    if parent.is_none() {
                        sqlx::query("INSERT INTO org_unit_placements (org_id,org_unit_id,legal_entity_id,workplace_id,valid_from,change_mode,command_id) VALUES ($1,$2,$3,$4,'2026-01-01','MIGRATION',$5)")
                            .bind(org.as_uuid()).bind(unit).bind(le).bind(wp).bind(Uuid::new_v4()).execute(pool).await.unwrap();
                    }
                    nodes.push(NodeRef {
                        kind: NodeKind::Department,
                        id: unit,
                    });
                    parent = Some(unit);
                }
            }
        }
        Self {
            org,
            nodes,
            role,
            maker,
        }
    }

    pub async fn holder(
        &self,
        pool: &PgPool,
        kind: Option<NodeKind>,
        ops: bool,
        choice: usize,
    ) -> Uuid {
        let actor = *seed_active_user(pool, *self.org.as_uuid(), "MEMBER", "holder")
            .await
            .as_uuid();
        sqlx::query("UPDATE users SET is_tenant_ops=$2 WHERE id=$1")
            .bind(actor)
            .bind(ops)
            .execute(pool)
            .await
            .unwrap();
        if let Some(kind) = kind {
            let choices: Vec<_> = self.nodes.iter().filter(|n| n.kind == kind).collect();
            let node = choices[choice % choices.len()];
            sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,legal_entity_id,workplace_id,org_unit_id,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,now()-interval '1 day',true,'SETUP','TEST',$8)")
                .bind(self.org.as_uuid()).bind(actor).bind(self.role).bind(kind.as_str())
                .bind((kind == NodeKind::LegalEntity).then_some(node.id))
                .bind((kind == NodeKind::Workplace).then_some(node.id))
                .bind((kind == NodeKind::Department).then_some(node.id))
                .bind(self.maker).execute(pool).await.unwrap();
        }
        actor
    }
}

pub async fn arm(tx: &mut Transaction<'_, Postgres>, org: OrgId) {
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
}
