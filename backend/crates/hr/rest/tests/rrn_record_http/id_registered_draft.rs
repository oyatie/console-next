// SPDX-License-Identifier: LicenseRef-Proprietary
use super::id_registered::{draft_binding_body, put_draft};
use super::*;
use serde_json::json;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn import_draft_row_identifier_malformed_json_does_not_echo_raw_rrn(pool: PgPool) {
    let f = fixture(&pool).await;
    let org = *f.principal.org_id.as_uuid();
    let run_id = Uuid::new_v4();
    let source_key = "draft-malformed-1";
    sqlx::query(
        "INSERT INTO data_import_runs (org_id, id, entity_type, source_filename, source_format, source_sha256, status, input_rows, candidate_rows, preserved_rows, created_by) \
         VALUES ($1, $2, 'employee_hr', 'draft.xlsx', 'xlsx', repeat('a', 64), 'PREVIEWED', 1, 1, 0, $3)",
    )
    .bind(org)
    .bind(run_id)
    .bind(f.principal.user_id.as_uuid())
    .execute(&pool)
    .await
    .unwrap();

    let (status, err) = put_draft(
        app(&f, true),
        run_id,
        source_key,
        json!({ "rrn": 9001015000014_i64 }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{err}");
    assert_eq!(err["error"]["code"], "rrn_invalid");
    assert!(!err.to_string().contains("9001015000014"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn import_draft_row_identifier_supersedes_not_issued_and_blocks_in_run_duplicate_rrn(
    pool: PgPool,
) {
    let mut f = fixture(&pool).await;
    let org = *f.principal.org_id.as_uuid();
    let run_id = Uuid::new_v4();
    let row1 = "draft-not-issued-1";
    let row2 = "draft-not-issued-2";
    sqlx::query(
        "INSERT INTO data_import_runs (org_id, id, entity_type, source_filename, source_format, source_sha256, mapping_profile, status, input_rows, candidate_rows, preserved_rows, created_by) \
         VALUES ($1, $2, 'employee_hr', 'draft.xlsx', 'xlsx', repeat('b', 64), '{\"confirmed\":true,\"columns\":[]}'::jsonb, 'PREVIEWED', 2, 2, 0, $3)",
    )
    .bind(org)
    .bind(run_id)
    .bind(f.principal.user_id.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    for (idx, (key, emp_no, name)) in [
        (row1, "PRE-101", "Draft Prehire One"),
        (row2, "PRE-102", "Draft Prehire Two"),
    ]
    .into_iter()
    .enumerate()
    {
        sqlx::query(
            "INSERT INTO data_import_rows (org_id, run_id, source_sheet, source_row, source_key, row_status, raw_row, canonical_row, validation) \
             VALUES ($1, $2, 'Sheet1', $3, $4, 'CANDIDATE', '{}', $5, '{}')",
        )
        .bind(org)
        .bind(run_id)
        .bind(i32::try_from(idx + 2).unwrap())
        .bind(key)
        .bind(json!({
            "company": "Acme",
            "name": name,
            "source_filename": "draft.xlsx",
            "source_sheet": "Sheet1",
            "source_row": idx + 2,
            "source_key": key,
            "canonical": {
                "employee_number": emp_no,
                "hire_date": "2029-05-01",
                "birth_date": "1995-03-04",
                "id_type": "NOT_ISSUED"
            }
        }))
        .execute(&pool)
        .await
        .unwrap();
    }

    let hr_with_vault = f.hr.clone().with_rrn_vault(Some(Arc::new(DraftVault)));
    f.hr = hr_with_vault.clone();
    let principal_copy = f.principal.clone();
    let draft_app = || {
        router(
            hr_with_vault.clone(),
            Some(Arc::new(DraftVault) as Arc<dyn RrnVault>),
            Some(passkey_service()),
        )
        .layer(Extension(principal_copy.clone()))
    };

    let body1 = draft_binding_body(
        &pool,
        &mut f,
        run_id,
        row1,
        "900101-6000017",
        Some("DOMESTIC_RESIDENCE"),
    )
    .await;
    let (s1, ok1) = put_draft(draft_app(), run_id, row1, body1).await;
    assert_eq!(s1, StatusCode::OK, "{ok1}");
    assert_eq!(ok1["id_type"], "DOMESTIC_RESIDENCE");
    assert_eq!(ok1["sex_derived"], "FEMALE");

    let body2 = draft_binding_body(
        &pool,
        &mut f,
        run_id,
        row2,
        "900101-6000017",
        Some("DOMESTIC_RESIDENCE"),
    )
    .await;
    let (s2, err2) = put_draft(draft_app(), run_id, row2, body2).await;
    assert_eq!(s2, StatusCode::CONFLICT, "{err2}");
    assert_eq!(err2["error"]["code"], "rrn_in_use");

    let summary =
        f.hr.dry_run_import(
            f.principal.clone(),
            run_id,
            console_hr_adapter_postgres::import::types::ImportDryRunRequest {
                decisions: console_hr_domain::import::plan::Decisions::default(),
            },
        )
        .await
        .unwrap();
    assert_eq!(summary.rows[0].outcome, "insert");
    assert_eq!(summary.rows[0].refusal_code, None);
    assert_eq!(
        summary.rows[0]
            .new_person
            .as_ref()
            .and_then(|p| p.id_type.as_deref()),
        Some("DOMESTIC_RESIDENCE")
    );
    assert_eq!(
        summary.rows[0]
            .new_person
            .as_ref()
            .and_then(|p| p.sex.as_deref()),
        Some("FEMALE")
    );
}

struct DraftVault;

impl RrnVault for DraftVault {
    fn seal(&self, org: Uuid, r: &Rrn) -> Result<SealedRrn, VaultError> {
        Ok(SealedRrn {
            hmac: self.blind_index_v1(r),
            hmac_key_version: 1,
            hmac_v2: Some(self.blind_index(org, r)),
            blind_index_version: Some(2),
            ciphertext: r.digits().bytes().chain([b'#'; 3]).collect(),
            nonce: vec![0; 24],
            dek_wrapped: vec![0; 16],
            dek_nonce: vec![0; 24],
            key_version: 1,
            masked: r.masked(),
            alg_id: None,
            kek_id: None,
            msg_id: None,
            commitment_tag: None,
        })
    }

    fn blind_index(&self, org: Uuid, r: &Rrn) -> Vec<u8> {
        org.as_bytes()
            .iter()
            .copied()
            .chain(r.digits().bytes())
            .cycle()
            .take(32)
            .collect()
    }

    fn blind_index_v1(&self, r: &Rrn) -> Vec<u8> {
        r.digits().bytes().cycle().take(32).collect()
    }

    fn open(&self, _: Uuid, sealed: &SealedRrn) -> Result<Rrn, VaultError> {
        let digits = std::str::from_utf8(sealed.ciphertext.get(..13).ok_or(VaultError)?)
            .map_err(|_| VaultError)?;
        Rrn::parse(digits).map_err(|_| VaultError)
    }
}
