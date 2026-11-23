// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use console_hr_domain::import::plan::{ImportRow, OnFile};
use console_hr_domain::import::rrn_value::{Rrn, RrnVault, SealedRrn};
use uuid::Uuid;

use super::*;

#[test]
fn t1_tenant_and_context_separation_and_normalization_parity() {
    let master = BASE64.encode([0x12u8; 32]);
    let k1 = BASE64.encode([0x34u8; 32]);
    let k2 = BASE64.encode([0x56u8; 32]);
    let k3 = BASE64.encode([0x78u8; 32]);
    let hmac_ring = format!(r#"{{"active":3,"keys":{{"1":"{k1}","2":"{k2}","3":"{k3}"}}}}"#);
    let vault =
        EnvRrnVault::from_keyrings(None, Some(&master), Some(&hmac_ring), Some(&k1)).unwrap();

    let (org_a, org_b) = (Uuid::new_v4(), Uuid::new_v4());
    let dashed = Rrn::parse("900101-1234567").unwrap();
    let plain = Rrn::parse("9001011234567").unwrap();
    let stripped = Rrn::parse("501013234567").unwrap();
    let zero_padded = Rrn::parse("050101-3234567").unwrap();

    // Normalized spellings produce identical v2 tags within one tenant
    assert_eq!(
        vault.blind_index(org_a, &dashed),
        vault.blind_index(org_a, &plain)
    );
    assert_eq!(
        vault.blind_index(org_a, &stripped),
        vault.blind_index(org_a, &zero_padded)
    );

    // Different tenants produce strictly distinct v2 tags for the same RRN
    assert_ne!(
        vault.blind_index(org_a, &dashed),
        vault.blind_index(org_b, &dashed)
    );
    // v1 legacy digest remains un-tenanted for N-1 dual-read compatibility
    assert_eq!(vault.blind_index_v1(&dashed), vault.blind_index_v1(&plain));
    assert_ne!(
        vault.blind_index(org_a, &dashed),
        vault.blind_index_v1(&dashed)
    );

    // Multi-version v2+ candidates place active (3) first, then retired (2)
    let candidates = vault.blind_index_v2_candidates(org_a, &dashed);
    assert_eq!(candidates.len(), 2);
    assert_eq!(candidates[0], vault.blind_index(org_a, &dashed));
    assert_ne!(candidates[0], candidates[1]);

    // Domain matching helper prefers v2 when both present, falls back to v1 during rollout
    let row = ImportRow {
        rrn_hmac: Some(vault.blind_index_v1(&dashed)),
        rrn_hmac_v2: Some(candidates[0].clone()),
        rrn_hmac_v2_candidates: candidates.clone(),
        ..ImportRow::default()
    };
    let v2_person = OnFile {
        rrn_hmac: Some(vault.blind_index_v1(&dashed)),
        rrn_hmac_v2: Some(candidates[1].clone()),
        ..OnFile::default()
    };
    assert_eq!(row.matches_person_rrn(&v2_person), Some(true));

    let v1_only_person = OnFile {
        rrn_hmac: Some(vault.blind_index_v1(&dashed)),
        rrn_hmac_v2: None,
        ..OnFile::default()
    };
    assert_eq!(row.matches_person_rrn(&v1_only_person), Some(true));

    let wrong_v2_person = OnFile {
        rrn_hmac: Some(vault.blind_index_v1(&dashed)),
        rrn_hmac_v2: Some(vault.blind_index(org_b, &dashed)),
        ..OnFile::default()
    };
    assert_eq!(row.matches_person_rrn(&wrong_v2_person), Some(false));
}

#[test]
fn t6_debug_redacts_rrn_digits_hmac_bytes_and_key_material() {
    let master_b64 = BASE64.encode([0x99u8; 32]);
    let hmac_b64 = BASE64.encode([0x77u8; 32]);
    let vault = EnvRrnVault::from_keys(&master_b64, &hmac_b64).unwrap();
    let org = Uuid::new_v4();
    let rrn = Rrn::parse("850505-2234567").unwrap();
    let sealed: SealedRrn = vault.seal(org, &rrn).unwrap();

    let hex = |bytes: &[u8]| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let v1_hex = hex(&sealed.hmac);
    let v2_hex = hex(sealed.hmac_v2.as_deref().unwrap());

    let row = ImportRow {
        source_key: "sheet:1:2".into(),
        name: "Synthetic".into(),
        rrn_hmac: Some(sealed.hmac.clone()),
        rrn_hmac_v2: sealed.hmac_v2.clone(),
        rrn_hmac_v2_candidates: vault.blind_index_v2_candidates(org, &rrn),
        ..ImportRow::default()
    };
    let person = OnFile {
        id: Uuid::new_v4(),
        name: "Synthetic".into(),
        rrn_hmac: Some(sealed.hmac.clone()),
        rrn_hmac_v2: sealed.hmac_v2.clone(),
        ..OnFile::default()
    };

    for dbg in [
        format!("{rrn:?}"),
        format!("{sealed:?}"),
        format!("{row:?}"),
        format!("{person:?}"),
        format!("{vault:?}"),
    ] {
        assert!(!dbg.contains("850505"), "leaked birth prefix in: {dbg}");
        assert!(!dbg.contains("2234567"), "leaked suffix digits in: {dbg}");
        assert!(!dbg.contains(&v1_hex), "leaked v1 hex in: {dbg}");
        assert!(!dbg.contains(&v2_hex), "leaked v2 hex in: {dbg}");
        assert!(!dbg.contains(&master_b64), "leaked master key in: {dbg}");
        assert!(!dbg.contains(&hmac_b64), "leaked hmac key in: {dbg}");
        assert!(
            !dbg.contains(&format!("{:?}", &sealed.hmac[..4])),
            "leaked raw hmac bytes in: {dbg}"
        );
    }
}
