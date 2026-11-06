// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use super::*;
use base64::Engine as _;
use sqlx::{PgPool, Row};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn v2_round_trips_through_both_rrn_tables_and_refuses_malformed_shapes(pool: PgPool) {
    let org = Uuid::new_v4();
    let employee = Uuid::new_v4();
    let actor = Uuid::new_v4();
    let run = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Vault test')")
        .bind(org)
        .bind(org.to_string())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (id, org_id, display_name) VALUES ($1, $2, 'Vault test')")
        .bind(actor)
        .bind(org)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO employees (id, org_id, company, name, source_filename, source_sheet, source_row, source_key) VALUES ($1, $2, 'Test', 'Test', 'console', 'test', 1, $3)")
        .bind(employee).bind(org).bind(employee.to_string()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO data_import_runs (id, org_id, entity_type, status, source_filename, source_format, source_sha256, pay_period_start, pay_period_end) VALUES ($1, $2, 'employee_hr', 'PREVIEWED', 'test.xlsx', 'xlsx', repeat('a', 64), CURRENT_DATE, CURRENT_DATE)")
        .bind(run).bind(org).execute(&pool).await.unwrap();
    let key = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
    let vault = EnvRrnVault::from_keys(&key, &key).unwrap();
    let rrn = Rrn::parse("900101-1234567").unwrap();
    let sealed = vault.seal(org, &rrn).unwrap();
    assert_eq!(sealed.key_version, 2);
    for (table, suffix) in [
        (
            "employee_rrn",
            ", employee_id, source, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'FORM',$11)",
        ),
        (
            "data_import_row_identities",
            ", run_id, source_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        ),
    ] {
        let statement = format!(
            "INSERT INTO {table} (org_id,rrn_hmac,hmac_key_version,ciphertext,nonce,dek_wrapped,dek_nonce,key_version,masked{suffix}"
        );
        let query = sqlx::query(sqlx::AssertSqlSafe(statement))
            .bind(org)
            .bind(&sealed.hmac)
            .bind(sealed.hmac_key_version)
            .bind(&sealed.ciphertext)
            .bind(&sealed.nonce)
            .bind(&sealed.dek_wrapped)
            .bind(&sealed.dek_nonce)
            .bind(sealed.key_version)
            .bind(&sealed.masked);
        if table == "employee_rrn" {
            query
                .bind(employee)
                .bind(actor)
                .execute(&pool)
                .await
                .unwrap();
        } else {
            query.bind(run).bind("row").execute(&pool).await.unwrap();
        }
        let row = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT * FROM {table} WHERE org_id = $1"
        )))
        .bind(org)
        .fetch_one(&pool)
        .await
        .unwrap();
        let stored = SealedRrn {
            hmac: row.get("rrn_hmac"),
            hmac_key_version: row.get("hmac_key_version"),
            ciphertext: row.get("ciphertext"),
            nonce: row.get("nonce"),
            dek_wrapped: row.get("dek_wrapped"),
            dek_nonce: row.get("dek_nonce"),
            key_version: row.get("key_version"),
            masked: row.get("masked"),
        };
        assert_eq!(vault.open(org, &stored).unwrap(), rrn);
        assert_eq!(vault.open(Uuid::new_v4(), &stored), Err(VaultError));
        for assignment in [
            "nonce = decode('00', 'hex')",
            "dek_nonce = decode('00', 'hex')",
            "key_version = 3",
            "dek_wrapped = decode('00', 'hex')",
        ] {
            let error = sqlx::query(sqlx::AssertSqlSafe(format!(
                "UPDATE {table} SET {assignment} WHERE org_id = $1"
            )))
            .bind(org)
            .execute(&pool)
            .await
            .unwrap_err();
            assert_eq!(
                error.as_database_error().unwrap().code().as_deref(),
                Some("23514")
            );
        }
        // A legacy shape is still accepted without rewriting the stored row.
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE {table} SET key_version = 1, nonce = $2, dek_nonce = $2 WHERE org_id = $1"
        )))
        .bind(org)
        .bind(vec![0u8; 24])
        .execute(&pool)
        .await
        .unwrap();
    }
}
