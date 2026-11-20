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
    let mut sealed = vault.seal(org, &rrn).unwrap();
    assert_eq!(sealed.key_version, 1);
    let v2 = vault
        .cipher
        .encrypt_with_suite(2, rrn.digits().as_bytes(), aad(&org.to_string()))
        .unwrap();
    sealed.ciphertext = v2.ciphertext;
    sealed.nonce = v2.nonce;
    sealed.dek_wrapped = v2.dek_wrapped;
    sealed.dek_nonce = v2.dek_nonce;
    sealed.key_version = v2.key_version;
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
            hmac_v2: row.get("rrn_hmac_v2"),
            blind_index_version: row.get("blind_index_version"),
            ciphertext: row.get("ciphertext"),
            nonce: row.get("nonce"),
            dek_wrapped: row.get("dek_wrapped"),
            dek_nonce: row.get("dek_nonce"),
            key_version: row.get("key_version"),
            masked: row.get("masked"),
            alg_id: row.get("alg_id"),
            kek_id: row.get("kek_id"),
            msg_id: row.get("msg_id"),
            commitment_tag: row.get("commitment_tag"),
        };
        assert_eq!(vault.open(org, &stored).unwrap(), rrn);
        assert_eq!(vault.open(Uuid::new_v4(), &stored), Err(VaultError));
        for assignment in [
            "nonce = decode('00', 'hex')",
            "dek_nonce = decode('00', 'hex')",
            "key_version = 4",
            "dek_wrapped = decode('00', 'hex')",
            "dek_wrapped = decode(repeat('00', 39), 'hex')",
            "dek_wrapped = decode(repeat('00', 41), 'hex')",
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

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn v3_round_trips_through_both_rrn_tables_and_refuses_missing_commitment(pool: PgPool) {
    let org = Uuid::new_v4();
    let employee = Uuid::new_v4();
    let actor = Uuid::new_v4();
    let run = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Vault v3 test')")
        .bind(org)
        .bind(org.to_string())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (id, org_id, display_name) VALUES ($1, $2, 'Vault v3 test')")
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
    let v3 = vault
        .cipher
        .encrypt_with_suite(3, rrn.digits().as_bytes(), aad(&org.to_string()))
        .unwrap();
    assert_eq!(v3.key_version, 3);

    for (table, suffix) in [
        (
            "employee_rrn",
            ", employee_id, source, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'FORM',$17)",
        ),
        (
            "data_import_row_identities",
            ", run_id, source_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)",
        ),
    ] {
        let statement = format!(
            "INSERT INTO {table} (org_id,rrn_hmac,hmac_key_version,rrn_hmac_v2,blind_index_version,ciphertext,nonce,dek_wrapped,dek_nonce,key_version,masked,alg_id,kek_id,msg_id,commitment_tag{suffix}"
        );
        let query = sqlx::query(sqlx::AssertSqlSafe(statement))
            .bind(org)
            .bind(vault.blind_index_v1(&rrn))
            .bind(LEGACY_HMAC_KEY_VERSION)
            .bind(vault.blind_index(org, &rrn))
            .bind(vault.active_blind_index_version())
            .bind(&v3.ciphertext)
            .bind(&v3.nonce)
            .bind(&v3.dek_wrapped)
            .bind(&v3.dek_nonce)
            .bind(v3.key_version)
            .bind(rrn.masked())
            .bind(v3.alg_id.as_deref())
            .bind(v3.kek_id.as_deref())
            .bind(v3.msg_id.as_deref())
            .bind(v3.commitment_tag.as_deref());
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
            hmac_v2: row.get("rrn_hmac_v2"),
            blind_index_version: row.get("blind_index_version"),
            ciphertext: row.get("ciphertext"),
            nonce: row.get("nonce"),
            dek_wrapped: row.get("dek_wrapped"),
            dek_nonce: row.get("dek_nonce"),
            key_version: row.get("key_version"),
            masked: row.get("masked"),
            alg_id: row.get("alg_id"),
            kek_id: row.get("kek_id"),
            msg_id: row.get("msg_id"),
            commitment_tag: row.get("commitment_tag"),
        };
        assert_eq!(stored.hmac_v2, Some(vault.blind_index(org, &rrn)));
        assert_eq!(stored.blind_index_version, Some(2));
        assert_eq!(vault.open(org, &stored).unwrap(), rrn);
        assert_eq!(vault.open(Uuid::new_v4(), &stored), Err(VaultError));

        for assignment in [
            "commitment_tag = NULL",
            "msg_id = NULL",
            "kek_id = NULL",
            "alg_id = NULL",
            "commitment_tag = decode('00', 'hex')",
            "msg_id = decode('00', 'hex')",
            "rrn_hmac_v2 = decode('00', 'hex')",
            "blind_index_version = 1",
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
    }
}
