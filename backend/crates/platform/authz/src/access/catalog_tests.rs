//! AX-2 catalog: tags, offered levels, normalization.

use super::super::catalog::*;
use super::*;

#[test]
fn every_tag_lands_on_an_offered_level_of_a_grantable_domain() {
    for (feature, domain, level) in tagged() {
        assert!(domain.grantable(), "{feature:?} tagged into {domain:?}");
        assert!(
            domain.offered().contains(&level),
            "{feature:?}: {domain:?} does not offer {level:?}"
        );
    }
}

#[test]
fn fenced_keys_are_untagged() {
    for f in [
        Feature::WorkOrderCreate,
        Feature::EquipmentManage,
        Feature::AiAssist,
        Feature::MailUse,
        Feature::TenantOffboard,
        Feature::Login,
    ] {
        assert_eq!(tag(f), None, "{f:?} must stay fenced");
    }
}

#[test]
fn normalize_adds_view_and_refuses_what_the_domain_does_not_offer() {
    assert_eq!(
        normalize_levels(Domain::HrBasic, &[Level::Edit]),
        Ok(vec![Level::View, Level::Edit])
    );
    assert_eq!(
        normalize_levels(Domain::Tenant, &[Level::Approve]),
        Ok(vec![Level::Approve])
    );
    assert_eq!(
        normalize_levels(Domain::Bank, &[Level::Approve]),
        Err(CatalogError::LevelNotOffered)
    );
    assert_eq!(
        normalize_levels(Domain::Discipline, &[Level::View]),
        Err(CatalogError::DomainNotGrantable)
    );
    assert_eq!(
        normalize_levels(Domain::Org, &[]),
        Err(CatalogError::LevelsEmpty)
    );
}

#[test]
fn wire_names_round_trip() {
    for d in Domain::ALL {
        assert_eq!(Domain::parse(d.as_str()), Ok(d));
    }
    for l in Level::ALL {
        assert_eq!(Level::parse(l.as_str()), Ok(l));
    }
    assert_eq!(Domain::parse("hr"), Err(CatalogError::DomainUnknown));
}

/// governance-17 / governance-04 walk: 퇴직 등록·수정 confirms an exit (the
/// HR confirmation is the exit, not a 결재); only the routed HQ tier is 결재.
#[test]
fn the_hr_exit_confirmation_is_an_edit_not_an_approval() {
    use crate::Feature;
    use crate::access::tags::tag;
    assert_eq!(
        tag(Feature::ExitCaseHrConfirm),
        Some((Domain::Exit, Level::Edit))
    );
    assert_eq!(
        tag(Feature::ExitCaseHqConfirm),
        Some((Domain::Exit, Level::Approve))
    );
}
