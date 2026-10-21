use super::{AuditRow, row_hash};
use crate::{
    AuditChainError, InMemoryEd25519Signer, SealSigner, batch_hash, row_context::RowContext,
    seal_hash,
};
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

fn fixture(version: i16) -> AuditRow {
    let mut context = RowContext::legacy();
    context.row_hash_version = version;
    AuditRow {
        id: Uuid::from_u128(0x1111),
        actor: None,
        action: "a.b".into(),
        target_type: "t".into(),
        target_id: "x".into(),
        branch_id: None,
        org_id: Some(Uuid::from_u128(0xa1)),
        before_snap: None,
        after_snap: None,
        trace_id: "0".repeat(32),
        span_id: "0".repeat(16),
        occurred_at: OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap(),
        created_at: OffsetDateTime::from_unix_timestamp(1_700_000_001).unwrap(),
        context,
    }
}
fn seal(rows: &[AuditRow]) -> [u8; 32] {
    let first = rows.first().unwrap();
    let last = rows.last().unwrap();
    seal_hash(
        first.org_id.unwrap(),
        1,
        first.created_at,
        first.id,
        last.created_at,
        last.id,
        u64::try_from(rows.len()).unwrap(),
        &batch_hash(rows).unwrap(),
        &[0; 32],
    )
    .unwrap()
}

#[test]
fn v1_encoding_matches_frozen_hash_and_ignores_added_columns() {
    let mut row = fixture(1);
    assert_eq!(
        hex::encode(row_hash(&row).unwrap()),
        "b6186a0ee776f54f702250d0060d728235f305cead3cf6fcd8f629520c37eac2"
    );
    let legacy = row_hash(&row).unwrap();
    row.context.source = Some("IMPORT".into());
    row.context.actor_kind = Some("OPS_ACCOUNT".into());
    row.context.command_id = Some(Uuid::from_u128(7));
    row.context.decision_snapshot = Some(json!({"approval.policy.org_structure":42}));
    assert_eq!(
        row_hash(&row).unwrap(),
        legacy,
        "new columns must not invalidate existing v1 seals"
    );
}

#[test]
fn v2_hash_seals_every_command_and_viewer_context_column() {
    let original = fixture(2);
    let hash = row_hash(&original).unwrap();
    macro_rules! sealed {
        ($field:ident,$value:expr) => {{
            let mut tampered = original.clone();
            tampered.context.$field = Some($value);
            assert_ne!(
                row_hash(&tampered).unwrap(),
                hash,
                "unsealed {}",
                stringify!($field)
            );
        }};
    }
    sealed!(source, "IMPORT".to_owned());
    sealed!(change_mode, "SOLE_HOLDER".to_owned());
    sealed!(reason_code, "TYPO".to_owned());
    sealed!(
        decision_snapshot,
        json!({"approval.policy.org_structure":7})
    );
    sealed!(command_id, Uuid::from_u128(7));
    sealed!(scope_ids, vec![Uuid::from_u128(8)]);
    sealed!(actor_kind, "OPS_ACCOUNT".to_owned());
    sealed!(principal_type, "TENANT_USER".to_owned());
    sealed!(session_id, Uuid::from_u128(9));
    sealed!(outcome, "DENIED".to_owned());
    sealed!(actor_display, "Verified actor".to_owned());
    sealed!(actor_employer, "Vendor".to_owned());
    sealed!(ip, "203.0.113.1".to_owned());
    sealed!(user_agent, "Browser".to_owned());
    sealed!(auth_method, "PASSKEY".to_owned());
    sealed!(device, "Desktop".to_owned());
    sealed!(classification_badges, vec!["PERSONAL".to_owned()]);
    sealed!(anomaly, false);
    sealed!(reason, "Read with purpose".to_owned());
    sealed!(scope_ids, vec![]);
    sealed!(classification_badges, vec![]);
    assert_ne!(
        hash,
        row_hash(&fixture(1)).unwrap(),
        "encoding versions are domain separated"
    );
}

#[test]
fn mixed_v1_v2_batch_preserves_legacy_hash_and_commits_to_order() {
    let first = fixture(1);
    let mut second = fixture(2);
    second.id = Uuid::from_u128(0x1112);
    second.created_at = OffsetDateTime::from_unix_timestamp(1_700_000_002).unwrap();
    assert_eq!(
        hex::encode(row_hash(&second).unwrap()),
        "c48a859a759458fd1da051a033767e054ed0673c00405ce74c23ac23e87db83d"
    );
    let rows = [first.clone(), second.clone()];
    assert_eq!(
        hex::encode(batch_hash(&rows).unwrap()),
        "ab1c6105bedb498738d662bf4b4f5556253b43ab93fd1f3e54fe63d04636d581"
    );
    let signer = InMemoryEd25519Signer::generate().unwrap();
    let original = seal(&rows);
    let signature = signer.sign(&original).unwrap();
    assert!(
        signer
            .verify(&original, &signature, signer.key_ref())
            .unwrap()
    );
    assert_ne!(
        batch_hash(&rows).unwrap(),
        batch_hash(&[second, first]).unwrap()
    );
}

#[test]
fn changed_decision_snapshot_breaks_signed_seal_for_many_versions() {
    let signer = InMemoryEd25519Signer::generate().unwrap();
    for version in 0_u64..256 {
        let mut row = fixture(2);
        row.context.decision_snapshot = Some(json!({"approval.policy.org_structure":version,
            "setting.revision":Uuid::from_u128(u128::from(version)).to_string()}));
        let original = seal(std::slice::from_ref(&row));
        let signature = signer.sign(&original).unwrap();
        assert!(
            signer
                .verify(&original, &signature, signer.key_ref())
                .unwrap()
        );
        row.context.decision_snapshot.as_mut().unwrap()["approval.policy.org_structure"] =
            json!(version + 1);
        let tampered = seal(&[row]);
        assert_ne!(original, tampered, "changed setting version {version}");
        assert!(
            !signer
                .verify(&tampered, &signature, signer.key_ref())
                .unwrap()
        );
    }
}

#[test]
fn context_and_snapshot_hashes_ignore_object_key_insertion_order() {
    let mut left = fixture(2);
    let mut right = fixture(2);
    left.context.decision_snapshot =
        Some(serde_json::from_str::<Value>(r#"{"z":2,"a":1}"#).unwrap());
    right.context.decision_snapshot =
        Some(serde_json::from_str::<Value>(r#"{"a":1,"z":2}"#).unwrap());
    left.after_snap =
        Some(serde_json::from_str(r#"{"nested":[{"z":2,"a":1}],"first":true}"#).unwrap());
    right.after_snap =
        Some(serde_json::from_str(r#"{"first":true,"nested":[{"a":1,"z":2}]}"#).unwrap());
    assert_eq!(row_hash(&left).unwrap(), row_hash(&right).unwrap());
    assert_eq!(seal(&[left]), seal(&[right]));
}

#[test]
fn unsupported_versions_fail_closed_before_sealing() {
    for version in [-1, 0, 3, i16::MAX] {
        let row = fixture(version);
        assert!(
            matches!(row_hash(&row),Err(AuditChainError::Canonical(ref message))
            if message=="unknown audit row hash version")
        );
        assert!(
            batch_hash(&[fixture(1), row]).is_err(),
            "unknown encoding cannot enter a seal"
        );
    }
}
