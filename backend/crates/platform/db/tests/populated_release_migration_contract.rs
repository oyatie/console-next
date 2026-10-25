// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use sqlx::{PgPool, migrate::Migrator};
use std::borrow::Cow;
use uuid::Uuid;

static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

#[sqlx::test(migrations = false)]
async fn populated_released_schema_upgrades_and_keeps_n_minus_one_registration_writes(
    pool: PgPool,
) {
    // 89cf5eeb08c2 ends here; these three older-numbered files arrived after that release.
    let released = Migrator {
        migrations: Cow::Owned(
            MIGRATOR
                .iter()
                .filter(|m| {
                    m.version <= 20261021103700000
                        && !matches!(
                            m.version,
                            20261020052001000 | 20261020080000000 | 20261021001028559
                        )
                })
                .cloned()
                .collect(),
        ),
        ..Migrator::DEFAULT
    };
    released.run(&pool).await.unwrap();

    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Populated release')")
        .bind(org)
        .bind(org.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let employee: Uuid = sqlx::query_scalar(
        "INSERT INTO employees(org_id,company,name,source_filename,source_sheet,source_row,source_key) \
         VALUES($1,'Company','Legacy employee','release-contract','employees',1,'legacy') RETURNING id",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    let actor: Uuid = sqlx::query_scalar(
        "INSERT INTO users(org_id,employee_id,display_name) VALUES($1,$2,'Legacy account') RETURNING id",
    )
    .bind(org)
    .bind(employee)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO users(org_id,display_name,is_tenant_ops) VALUES($1,'Legacy operations',true)",
    )
    .bind(org)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO data_import_runs(org_id,entity_type,status,source_filename,source_format,source_sha256,created_by) \
         VALUES($1,'employee_hr','PREVIEWED','release-contract.csv','csv',repeat('a',64),$2)",
    )
    .bind(org).bind(actor).execute(&pool).await.unwrap();
    let case: Uuid = sqlx::query_scalar(
        "INSERT INTO lifecycle_cases(org_id,kind,subject_kind,employee_id,trigger_kind,effective_date,template_key,template_version) \
         VALUES($1,'EXIT','EMPLOYMENT',$2,'SCHEDULE',CURRENT_DATE,'EXIT',1) RETURNING id",
    )
    .bind(org).bind(employee).fetch_one(&pool).await.unwrap();
    let filing_items = sqlx::query(
        "INSERT INTO lifecycle_case_items(org_id,case_id,item_key,source,template_item_version,kind,venue,mode,owner_line, \
         due_rule_ref,due_disposition,status,blocks_close,legal) \
         SELECT $1,$2,item_key,'TEMPLATE',version,kind,venue,mode,owner_line,due_register_code,'UNKNOWN','OPEN',blocks_close,legal \
         FROM case_template_items WHERE template_key='EXIT' AND version=1 AND kind='FIL'",
    )
    .bind(org).bind(case).execute(&pool).await.unwrap().rows_affected();
    assert!(filing_items > 0);
    let entity: Uuid = sqlx::query_scalar(
        "INSERT INTO legal_entities(org_id,needs_confirmation,created_change_mode) \
         VALUES($1,true,'MIGRATION') RETURNING id",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    let registration: Uuid = sqlx::query_scalar(
        "INSERT INTO business_registrations(org_id,legal_entity_id,brn,created_change_mode) \
         VALUES($1,$2,'1234567891','MIGRATION') RETURNING id",
    )
    .bind(org)
    .bind(entity)
    .fetch_one(&pool)
    .await
    .unwrap();

    // Also exercise the company-to-entity backfill, rather than letting an existing entity skip it.
    let legacy_org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Legacy company facts')")
        .bind(legacy_org)
        .bind(legacy_org.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let legacy_actor: Uuid = sqlx::query_scalar(
        "INSERT INTO users(org_id,display_name) VALUES($1,'Legacy company account') RETURNING id",
    )
    .bind(legacy_org)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO company_revisions(org_id,version,command_id,actor_id,payload_digest,attributes,receipt) \
         VALUES($1,1,gen_random_uuid(),$2,decode(repeat('a',64),'hex'), \
         '{\"legal_name\":\"Legacy company\",\"reg_no\":\"9876543210\"}','{}')",
    )
    .bind(legacy_org).bind(legacy_actor).execute(&pool).await.unwrap();

    MIGRATOR.run(&pool).await.unwrap();
    MIGRATOR.run(&pool).await.unwrap();

    let due: bool = sqlx::query_scalar(
        "SELECT due_at <= now() FROM business_registration_check_schedule \
         WHERE org_id=$1 AND registration_id=$2",
    )
    .bind(org)
    .bind(registration)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        due,
        "the existing registration must be scheduled for checking"
    );
    let copied: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM business_registration_check_schedule s \
         JOIN business_registrations r ON (r.org_id,r.id)=(s.org_id,s.registration_id) \
         WHERE r.org_id=$1 AND r.brn='9876543210'",
    )
    .bind(legacy_org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        copied, 1,
        "registrations copied from company facts are also due"
    );
    let unbound: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM users WHERE org_id IN ($1,$2) AND person_id IS NULL",
    )
    .bind(org)
    .bind(legacy_org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        unbound, 0,
        "both tenant and operations accounts are backfilled"
    );
    let restored: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM lifecycle_case_items WHERE org_id=$1 AND case_id=$2",
    )
    .bind(org)
    .bind(case)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        restored as u64, filing_items,
        "existing exit filings survive the upgrade"
    );

    // The released writer supplies no check_pack or schedule row; the new trigger must handle both.
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_rt")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let new_registration: Uuid = sqlx::query_scalar(
        "INSERT INTO business_registrations(org_id,legal_entity_id,brn,created_change_mode,created_by) \
         VALUES($1,$2,'1111111111','SETUP',$3) RETURNING id",
    )
    .bind(org)
    .bind(entity)
    .bind(actor)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let scheduled: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM business_registration_check_schedule WHERE org_id=$1 AND registration_id=$2",
    )
    .bind(org)
    .bind(new_registration)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        scheduled, 1,
        "N-1 inserts still schedule checks under runtime RLS"
    );
}
