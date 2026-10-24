#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Shared fixtures: a tenant opened by the organizations trigger (SETUP),
//! its first SUPER_ADMIN, and certificate-shaped inputs.

use console_entity_adapter_postgres::{PgEntityError, PgEntityStore};
use console_entity_application::{Actor, CreateWorkplace, EntityScope};
use console_entity_domain::AddressInput;
use console_entity_domain::insurance::InsuranceSetupInput;
use console_entity_domain::legal_entity::LegalEntityInput;
use console_entity_domain::registration::{BusinessTypeInput, RegistrationInput};
use console_entity_domain::workplace::WorkplaceInput;
use console_kernel_core::{OrgId, TraceContext};
use sqlx::PgPool;
use uuid::Uuid;

pub async fn tenant(owner: &PgPool, org: Uuid, tag: &str) -> (PgEntityStore, Actor) {
    let user = console_platform_test_support::seed_org_and_super_admin(owner, org, tag).await;
    let rt = console_platform_test_support::runtime_role_pool(owner).await;
    let actor = Actor {
        org: OrgId::from_uuid(org),
        user,
        trace: TraceContext::generate(),
        command_id: None,
        scope: EntityScope::Tenant,
    };
    (PgEntityStore::new(rt), actor)
}

/// The actor of one write: a fresh command id (Idempotency-Key) per call.
pub fn cmd(actor: &Actor) -> Actor {
    Actor {
        command_id: Some(Uuid::new_v4()),
        ..actor.clone()
    }
}

pub async fn set_operating(owner: &PgPool, org: Uuid) {
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    // rls-arming: ok test fixture flips the phase as owner
    sqlx::query("UPDATE tenant_phase SET phase = 'OPERATING'")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

pub fn address(road: &str) -> AddressInput {
    AddressInput {
        source: Some("MANUAL_UNVERIFIED".into()),
        road_addr_part1: Some(road.into()),
        si_nm: Some("서울특별시".into()),
        sgg_nm: Some("강남구".into()),
        detail: Some("12층".into()),
        ..AddressInput::default()
    }
}

pub fn corporation(name: &str, crn: &str) -> LegalEntityInput {
    LegalEntityInput {
        biz_kind: Some("CORPORATION".into()),
        incorporated_on: Some("2020-03-02".into()),
        name: Some(name.into()),
        representation_mode: Some("SINGLE".into()),
        representatives: vec!["홍길동".into()],
        crn: Some(crn.into()),
        head_office_address: Some(address("서울특별시 강남구 테헤란로 152")),
        ..LegalEntityInput::default()
    }
}

/// A 사업자등록증; its ① is the entity's name (one stored source).
pub fn certificate(brn: &str) -> RegistrationInput {
    RegistrationInput {
        brn: Some(brn.into()),
        opened_on: Some("2020-03-02".into()),
        business_address: Some(address("서울특별시 강남구 테헤란로 152")),
        business_types: vec![BusinessTypeInput {
            is_main: Some(true),
            sector: Some("정보통신업".into()),
            item: Some("응용 소프트웨어 개발 및 공급업".into()),
            ..BusinessTypeInput::default()
        }],
        unit_taxation: Some(false),
        tax_office_label: Some("삼성세무서".into()),
        tax_type: Some("01".into()),
        ..RegistrationInput::default()
    }
}

pub fn workplace_from(registration: Uuid, name: &str) -> CreateWorkplace {
    CreateWorkplace {
        input: WorkplaceInput {
            name: Some(name.into()),
            registration_id: Some(registration),
            same_address_as_registration: true,
            opened_on: Some("2020-03-02".into()),
            insurance: Some(InsuranceSetupInput {
                shortcut: Some("ALL_ESTABLISHED_NUMBERS_LATER".into()),
                insurers: vec![],
            }),
            ..WorkplaceInput::default()
        },
        is_primary: None,
        is_head_office: Some(true),
        default_branch_id: None,
        kind_code: None,
    }
}

pub fn code(
    err: PgEntityError,
) -> (
    &'static str,
    Vec<(String, &'static str)>,
    Option<&'static str>,
) {
    match err {
        PgEntityError::Refused(r) => (
            r.code,
            r.fields.into_iter().map(|f| (f.field, f.code)).collect(),
            r.remedy,
        ),
        PgEntityError::Db(e) => panic!("db error: {e}"),
    }
}

/// The canonical OrgUnit owner behind the setup org-unit seam, wired exactly
/// as the composition root does (`app/src/entity_wiring.rs`).
struct CanonicalPort;

impl console_entity_adapter_postgres::OrgUnitSetupWritePort for CanonicalPort {
    fn write<'tx>(
        &self,
        tx: &'tx mut sqlx::Transaction<'_, sqlx::Postgres>,
        org: OrgId,
        actor: console_kernel_core::UserId,
        command_id: Uuid,
        org_unit_id: Option<Uuid>,
        attributes: serde_json::Value,
    ) -> console_entity_adapter_postgres::OrgUnitSetupFuture<'tx> {
        use console_ontology_canonical_adapter_postgres::org_unit::{
            OrgUnitCommand, OrgUnitQuery, write_in_tx,
        };
        Box::pin(async move {
            let query = match org_unit_id {
                None => OrgUnitQuery::Create {
                    source: None,
                    attributes,
                },
                Some(org_unit_id) => OrgUnitQuery::Revise {
                    org_unit_id,
                    source: None,
                    attributes,
                },
            };
            let command = OrgUnitCommand {
                org_id: org,
                command_id: console_ontology_canonical_domain::CommandId::from_uuid(command_id),
                actor_id: actor,
                query,
                action_key: "internal.setup.test_org_unit".to_owned(),
                object_type_id: Uuid::nil(),
            };
            let receipt = write_in_tx(tx, &command)
                .await
                .map_err(|e| console_kernel_core::KernelError::conflict(e.to_string()))?;
            Ok(Uuid::parse_str(receipt.result()["org_unit_id"].as_str().unwrap()).unwrap())
        })
    }

    /// As the root's settings read: routed unless the tenant's override says
    /// `none` or there is none (the registry default is `none`).
    fn org_changes_routed<'tx>(
        &self,
        tx: &'tx mut sqlx::Transaction<'_, sqlx::Postgres>,
        _org: OrgId,
    ) -> console_entity_adapter_postgres::RoutedFuture<'tx> {
        Box::pin(async move {
            let routed: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM tenant_setting_overrides \
                  WHERE key = 'approval.policy.org_structure' AND value <> '\"none\"'::jsonb)",
            )
            .fetch_one(tx.as_mut())
            .await
            .map_err(|e| console_kernel_core::KernelError::internal(e.to_string()))?;
            Ok(routed)
        })
    }
}

pub fn port() -> std::sync::Arc<dyn console_entity_adapter_postgres::OrgUnitSetupWritePort> {
    std::sync::Arc::new(CanonicalPort)
}

/// A 법인 with two 사업장 (본사, 공장): (entity, [(workplace, its own unit); 2]).
pub async fn two_workplaces(store: &PgEntityStore, actor: &Actor) -> (Uuid, [(Uuid, Uuid); 2]) {
    let entity = store
        .create_entity(&cmd(actor), corporation("주식회사 가나", "000211-0006241"))
        .await
        .unwrap()
        .record
        .id;
    let reg = store
        .create_registration(&cmd(actor), entity, certificate("000-81-00009"))
        .await
        .unwrap()
        .record
        .id;
    let mut out = Vec::new();
    for name in ["본사", "공장"] {
        let wp = store
            .create_workplace(&cmd(actor), entity, workplace_from(reg, name), port())
            .await
            .unwrap()
            .record;
        out.push((wp.id, wp.org_unit_id.unwrap()));
    }
    (entity, [out[0], out[1]])
}

/// A person in org unit `unit`, placed at `workplace` of `entity` from 2026-01-02.
pub async fn person(
    owner: &PgPool,
    store: &PgEntityStore,
    actor: &Actor,
    (entity, workplace, unit): (Uuid, Uuid, Uuid),
    key: &str,
) -> Uuid {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key, org_unit_id) \
         VALUES ($1, '주식회사 가나', '김직원', 'x', 'x', 1, $2, $3) RETURNING id",
    )
    .bind(*actor.org.as_uuid())
    .bind(key)
    .bind(unit)
    .fetch_one(owner)
    .await
    .unwrap();
    store
        .bind_assignment(
            &cmd(actor),
            console_entity_application::BindAssignment {
                employee_id: id,
                legal_entity_id: Some(entity),
                workplace_id: Some(workplace),
                valid_from: Some("2026-01-02".into()),
            },
        )
        .await
        .unwrap();
    id
}

/// The open placement's 사업장 of `employee`.
pub async fn placed_at(owner: &PgPool, employee: Uuid) -> Uuid {
    sqlx::query_scalar(
        "SELECT workplace_id FROM employment_assignments WHERE employee_id = $1 AND superseded_at IS NULL AND valid_to IS NULL",
    )
    .bind(employee)
    .fetch_one(owner)
    .await
    .unwrap()
}

/// A unit's current (kind, status, parent, version), read as the owner.
pub async fn unit_head(owner: &PgPool, unit: Uuid) -> (String, String, Option<String>, i64) {
    sqlx::query_as(
        "SELECT attributes->>'kind', COALESCE(attributes->>'status', 'active'), attributes->>'parent_id', version \
         FROM org_unit_revisions WHERE org_unit_id = $1 ORDER BY version DESC LIMIT 1",
    )
    .bind(unit)
    .fetch_one(owner)
    .await
    .unwrap()
}

/// Batch op: a 부서 named `name` directly in `workplace`, labelled `r`.
pub fn under_workplace(
    r: &str,
    name: &str,
    workplace: Uuid,
) -> console_entity_application::OrgSetupOp {
    console_entity_application::OrgSetupOp::Create {
        client_ref: Some(r.into()),
        name: Some(name.into()),
        parent: console_entity_application::OrgParent {
            workplace_id: Some(workplace),
            ..console_entity_application::OrgParent::default()
        },
        code: None,
        head_employee_id: None,
    }
}

/// Batch op: a 부서 under the unit labelled `parent` in the same batch.
pub fn under_ref(r: &str, name: &str, parent: &str) -> console_entity_application::OrgSetupOp {
    console_entity_application::OrgSetupOp::Create {
        client_ref: Some(r.into()),
        name: Some(name.into()),
        parent: console_entity_application::OrgParent {
            parent_ref: Some(parent.into()),
            ..console_entity_application::OrgParent::default()
        },
        code: None,
        head_employee_id: None,
    }
}
