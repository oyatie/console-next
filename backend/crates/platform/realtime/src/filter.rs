//! The read filter and per-subscriber coalescing (spec §3.3). One function
//! decides for every transport, so SSE and WS subscribers see the same frames.
//!
//! Each type is decided by the door its REST read uses today, with every
//! attribute taken from the `resource_changes` row (no DB read):
//! * the 법인/조직 surfaces read with the `org_change_read` capability
//!   (`entity-rest` `Need::Read`, onboarding), accounts and roles with their
//!   manage capability (identity-rest);
//! * the people surfaces read through the HR doors
//!   (`hr-adapter-postgres` `authz.rs`): a row branch is checked with
//!   `authorize`; a row without one needs org-wide authority, so a
//!   branch-scoped reader never learns of an employee outside its branches.
//!
//! `authorize_scoped` is not usable here: its `ResourceBranch` comes only from
//! `ResourceBranch::lookup`, a DB read over a closed enum with no HR or entity
//! variant. Move this filter when those REST reads adopt Cedar.

use std::collections::BTreeMap;

use console_kernel_core::BranchId;
use console_platform_authz::{
    Action, Feature, Principal, authorize, authorize_capability, authorize_org_wide,
};
use time::OffsetDateTime;

use crate::event::{ChangeData, RealtimeEvent};

/// One `resource_changes` row as the hub reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChangeRow {
    pub(crate) seq: i64,
    pub(crate) resource_type: String,
    pub(crate) resource_id: Option<String>,
    pub(crate) branch_id: Option<uuid::Uuid>,
    pub(crate) ver: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Door {
    /// A tenant-level record with no branch: the matrix cell or grant only.
    Capability(Feature),
    /// A people record: the row's branch, or org-wide authority without one.
    Scoped(Feature),
}

/// Unknown type → `None` → never delivered (fail closed).
fn door(resource_type: &str) -> Option<Door> {
    Some(match resource_type {
        "tenant"
        | "legal_entity"
        | "business_registration"
        | "workplace"
        | "org_unit"
        | "org_change"
        | "entity_setup_batch" => Door::Capability(Feature::OrgChangeRead),
        "employee" | "exit_case" => Door::Scoped(Feature::EmployeeDirectoryRead),
        "lifecycle_case" | "lifecycle_case_item" => {
            Door::Capability(Feature::EmployeeDirectoryRead)
        }
        "change_request" | "import_run" => Door::Scoped(Feature::EmployeeDirectoryManage),
        // Locks carry no branch: org-wide close authority only.
        "period_lock" => Door::Scoped(Feature::PeriodLockManage),
        "user" => Door::Capability(Feature::UserManage),
        "role" => Door::Capability(Feature::RoleManage),
        _ => return None,
    })
}

pub(crate) fn may_read(principal: &Principal, row: &ChangeRow) -> bool {
    if row.resource_type == "identifier_correction" {
        return principal.branch_scope == console_kernel_core::BranchScope::All
            && [Feature::LegalEntityManage, Feature::OrgChangeApply]
                .into_iter()
                .any(|f| authorize_capability(principal, Action::new(f)).is_ok());
    }
    if matches!(row.resource_type.as_str(), "command_outcome" | "inbox") {
        return row.resource_id.is_none()
            && console_platform_authz::cedar_pbac::actions::command_outcome::decide(
                &principal.user_id.to_string(),
                &principal.org_id.to_string(),
                true,
                false,
            )
            .unwrap_or(false);
    }
    match door(&row.resource_type) {
        Some(Door::Capability(feature)) => {
            authorize_capability(principal, Action::new(feature)).is_ok()
        }
        Some(Door::Scoped(feature)) => match row.branch_id {
            Some(branch) => {
                authorize(principal, Action::new(feature), BranchId::from_uuid(branch)).is_ok()
            }
            None => authorize_org_wide(principal, Action::new(feature)).is_ok(),
        },
        None => false,
    }
}

/// The frames one subscriber gets for one batch of rows (a transaction, or a
/// replay page): filtered, the same `(type, id)` once, and more than
/// `threshold` rows of one type folded into one `id: null` frame.
pub(crate) fn frames_for(
    principal: &crate::ChangeReader,
    rows: &[ChangeRow],
    threshold: usize,
    at: OffsetDateTime,
) -> Vec<RealtimeEvent> {
    // type → (id → highest row); BTreeMap keeps the output deterministic.
    let mut by_type: BTreeMap<&str, BTreeMap<Option<&str>, &ChangeRow>> = BTreeMap::new();
    for row in rows.iter().filter(|row| principal.may_read(row)) {
        let ids = by_type.entry(row.resource_type.as_str()).or_default();
        let slot = ids.entry(row.resource_id.as_deref()).or_insert(row);
        if row.seq > slot.seq {
            *slot = row;
        }
    }
    let mut frames = Vec::new();
    for (resource_type, ids) in by_type {
        let max_seq = ids.values().map(|row| row.seq).max().unwrap_or_default();
        if ids.len() > threshold || ids.contains_key(&None) {
            frames.push(change(resource_type, None, None, max_seq, at));
            continue;
        }
        for row in ids.values() {
            frames.push(change(
                resource_type,
                row.resource_id.clone(),
                row.ver.clone(),
                row.seq,
                at,
            ));
        }
    }
    frames.sort_by_key(|frame| match frame {
        RealtimeEvent::Change { id, .. } => id.parse::<i64>().unwrap_or_default(),
        _ => 0,
    });
    frames
}

fn change(
    resource_type: &str,
    id: Option<String>,
    ver: Option<String>,
    seq: i64,
    at: OffsetDateTime,
) -> RealtimeEvent {
    RealtimeEvent::Change {
        id: seq.to_string(),
        data: ChangeData {
            resource_type: resource_type.to_owned(),
            id,
            ver,
            at,
        },
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use console_kernel_core::{BranchScope, OrgId, UserId};
    use console_platform_authz::{EffectiveFeatureGrant, PermissionLevel};

    use super::*;

    fn row(
        seq: i64,
        resource_type: &str,
        id: Option<&str>,
        branch: Option<uuid::Uuid>,
    ) -> ChangeRow {
        ChangeRow {
            seq,
            resource_type: resource_type.to_owned(),
            resource_id: id.map(str::to_owned),
            branch_id: branch,
            ver: None,
        }
    }

    /// A tenant-defined role's grants (no preset role): `features` over `scope`.
    fn reader(features: &[Feature], scope: BranchScope) -> Principal {
        let grants = features
            .iter()
            .map(|f| EffectiveFeatureGrant::new(*f, PermissionLevel::Allow, scope.clone()))
            .collect();
        Principal::new(UserId::new(), OrgId::one(), BTreeSet::new(), scope)
            .with_effective_feature_grants(grants)
    }

    const HR: &[Feature] = &[
        Feature::EmployeeDirectoryRead,
        Feature::EmployeeDirectoryManage,
        Feature::OrgChangeRead,
    ];

    fn ids(frames: &[RealtimeEvent]) -> Vec<(String, Option<String>)> {
        frames
            .iter()
            .map(|frame| match frame {
                RealtimeEvent::Change { data, .. } => (data.resource_type.clone(), data.id.clone()),
                other => panic!("not a change frame: {other:?}"),
            })
            .collect()
    }

    #[test]
    fn an_inbox_hint_reaches_its_authenticated_reader_without_exposing_record_ids() {
        let principal = reader(&[], BranchScope::All);
        assert!(may_read(&principal, &row(1, "inbox", None, None)));
        assert!(!may_read(
            &principal,
            &row(1, "inbox", Some("private-record"), None)
        ));
    }

    #[test]
    fn correction_events_use_the_same_org_wide_read_door_as_the_register() {
        let change = row(1, "identifier_correction", Some("case"), None);
        for feature in [Feature::LegalEntityManage, Feature::OrgChangeApply] {
            assert!(may_read(&reader(&[feature], BranchScope::All), &change));
            let scoped = BranchScope::single(BranchId::from_uuid(uuid::Uuid::new_v4()));
            assert!(!may_read(&reader(&[feature], scoped), &change));
        }
        assert!(!may_read(
            &reader(&[Feature::OrgChangeRead], BranchScope::All),
            &change
        ));
        assert!(!may_read(&reader(&[], BranchScope::All), &change));
    }

    #[test]
    fn unknown_types_never_pass() {
        let admin = reader(HR, BranchScope::All);
        assert!(!may_read(&admin, &row(1, "payroll_run", Some("x"), None)));
    }

    #[test]
    fn a_branch_reader_gets_its_branch_only_and_no_branchless_people_rows() {
        let (x, y) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let branch_admin = reader(HR, BranchScope::single(BranchId::from_uuid(y)));
        assert!(may_read(
            &branch_admin,
            &row(1, "employee", Some("a"), Some(y))
        ));
        assert!(!may_read(
            &branch_admin,
            &row(2, "employee", Some("b"), Some(x))
        ));
        assert!(!may_read(
            &branch_admin,
            &row(3, "employee", Some("c"), None)
        ));
        // Spec §10.2 test 8: 5,700 rows from branch X → zero frames for Y.
        let burst: Vec<_> = (0..5_700)
            .map(|n| row(n, "employee", Some(&n.to_string()), Some(x)))
            .collect();
        let reader = branch_admin.into();
        assert!(frames_for(&reader, &burst, 50, OffsetDateTime::now_utc()).is_empty());
    }

    #[test]
    fn a_lock_change_reaches_org_wide_close_authorities_only() {
        let lock = row(1, "period_lock", Some("l"), None);
        assert!(may_read(
            &reader(&[Feature::PeriodLockManage], BranchScope::All),
            &lock
        ));
        let branch = BranchScope::single(BranchId::from_uuid(uuid::Uuid::new_v4()));
        assert!(!may_read(
            &reader(&[Feature::PeriodLockManage], branch),
            &lock
        ));
        assert!(!may_read(&reader(HR, BranchScope::All), &lock));
    }

    #[test]
    fn a_reader_without_the_read_feature_gets_nothing() {
        let no_roles = reader(&[], BranchScope::All);
        let rows = [
            row(1, "employee", Some("a"), None),
            row(2, "legal_entity", Some("e"), None),
        ];
        let reader = no_roles.into();
        assert!(frames_for(&reader, &rows, 50, OffsetDateTime::now_utc()).is_empty());
    }

    #[test]
    fn lifecycle_hints_reach_directory_readers_without_record_ids() {
        let rows = [
            row(1, "lifecycle_case", None, None),
            row(2, "lifecycle_case_item", None, None),
        ];
        for scope in [
            BranchScope::All,
            BranchScope::single(BranchId::from_uuid(uuid::Uuid::new_v4())),
        ] {
            let holder = reader(&[Feature::EmployeeDirectoryRead], scope);
            for hint in &rows {
                assert!(may_read(&holder, hint), "{}", hint.resource_type);
            }
            let frames = frames_for(&holder.into(), &rows, 50, OffsetDateTime::now_utc());
            assert_eq!(
                ids(&frames),
                vec![
                    ("lifecycle_case".to_owned(), None),
                    ("lifecycle_case_item".to_owned(), None),
                ]
            );
        }
        for features in [&[][..], &[Feature::OrgChangeRead][..]] {
            let denied = reader(features, BranchScope::All);
            for hint in &rows {
                assert!(!may_read(&denied, hint), "{}", hint.resource_type);
            }
            assert!(frames_for(&denied.into(), &rows, 50, OffsetDateTime::now_utc()).is_empty());
        }
    }

    #[test]
    fn coalesces_over_the_threshold_and_dedupes_ids() {
        let admin = reader(HR, BranchScope::All);
        let now = OffsetDateTime::now_utc();
        let mut rows: Vec<_> = (0..3)
            .map(|n| row(n, "employee", Some(&n.to_string()), None))
            .collect();
        rows.push(row(9, "employee", Some("0"), None));
        rows.push(row(10, "legal_entity", Some("e"), None));
        let frames = frames_for(&admin.clone().into(), &rows, 50, now);
        assert_eq!(
            ids(&frames),
            vec![
                ("employee".to_owned(), Some("1".to_owned())),
                ("employee".to_owned(), Some("2".to_owned())),
                ("employee".to_owned(), Some("0".to_owned())),
                ("legal_entity".to_owned(), Some("e".to_owned())),
            ]
        );
        let folded = frames_for(&admin.clone().into(), &rows, 2, now);
        assert_eq!(
            ids(&folded),
            vec![
                ("employee".to_owned(), None),
                ("legal_entity".to_owned(), Some("e".to_owned()))
            ]
        );
        let RealtimeEvent::Change { id, .. } = &folded[0] else {
            panic!()
        };
        assert_eq!(id, "9", "a folded frame carries the highest seq it folds");
    }

    #[test]
    fn an_id_null_row_folds_its_type() {
        let admin = reader(HR, BranchScope::All);
        let rows = [
            row(1, "org_unit", Some("u"), None),
            row(2, "org_unit", None, None),
        ];
        let frames = frames_for(&admin.clone().into(), &rows, 50, OffsetDateTime::now_utc());
        assert_eq!(ids(&frames), vec![("org_unit".to_owned(), None)]);
    }
}
