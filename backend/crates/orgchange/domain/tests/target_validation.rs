// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::ErrorKind;
use console_orgchange_domain::{OrgChangeTarget, TargetKind};
use uuid::Uuid;

#[test]
fn canonical_targets_require_a_uuid_and_legacy_targets_keep_their_contract() {
    for kind in [TargetKind::OrgUnit, TargetKind::Site, TargetKind::Entity] {
        let mut target = OrgChangeTarget {
            kind,
            target_ref: "not-a-uuid".into(),
            label: "조직".into(),
        };
        assert_eq!(
            target.validate().err().map(|e| e.kind),
            Some(ErrorKind::Validation)
        );
        target.target_ref = Uuid::nil().to_string();
        assert!(target.validate().is_ok());
    }
    for kind in [TargetKind::Region, TargetKind::Branch] {
        assert!(
            OrgChangeTarget {
                kind,
                target_ref: "legacy-ref".into(),
                label: "조직".into()
            }
            .validate()
            .is_ok()
        );
    }
}
