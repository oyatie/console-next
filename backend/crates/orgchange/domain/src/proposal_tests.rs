use super::*;

#[test]
fn proposal_ops_round_trip_their_wire_tags() {
    let ops = vec![
        OrgProposalOp::CreateRegion {
            name: "수도권".into(),
        },
        OrgProposalOp::ReassignOrgUnit {
            from_org_unit: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".into(),
            to_org_unit: "ffffffff-0000-1111-2222-333333333333".into(),
            scope: ReassignScope {
                company: "SAE".into(),
            },
            employee_ids: Some(vec![Uuid::nil()]),
        },
        OrgProposalOp::DissolveOrgUnit {
            org_unit_id: Uuid::nil(),
            merged_into: Some(Uuid::max()),
        },
    ];
    let json = serde_json::to_value(&ops).unwrap();
    assert_eq!(json[0]["op"], "CREATE_REGION");
    assert_eq!(json[1]["op"], "REASSIGN_ORG_UNIT");
    assert_eq!(
        json[1]["fromOrgUnit"],
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    );
    assert_eq!(json[1]["employeeIds"][0], Uuid::nil().to_string());
    assert_eq!(json[2]["mergedInto"], Uuid::max().to_string());
    let back: Vec<OrgProposalOp> = serde_json::from_value(json).unwrap();
    assert_eq!(back, ops);
    // A proposal stored before UX-R2 (no employeeIds / mergedInto) still decodes.
    let old: OrgProposalOp = serde_json::from_value(
        serde_json::json!({"op": "DISSOLVE_ORG_UNIT", "orgUnitId": Uuid::nil()}),
    )
    .unwrap();
    assert_eq!(
        old,
        OrgProposalOp::DissolveOrgUnit {
            org_unit_id: Uuid::nil(),
            merged_into: None
        }
    );
}

#[test]
fn a_merge_into_itself_and_an_empty_people_list_are_refused() {
    let unit = Uuid::new_v4();
    assert!(
        OrgProposalOp::DissolveOrgUnit {
            org_unit_id: unit,
            merged_into: Some(unit),
        }
        .validate()
        .is_err()
    );
    assert!(
        OrgProposalOp::ReassignOrgUnit {
            from_org_unit: Uuid::new_v4().to_string(),
            to_org_unit: Uuid::new_v4().to_string(),
            scope: ReassignScope {
                company: "SAE".into()
            },
            employee_ids: Some(vec![]),
        }
        .validate()
        .is_err()
    );
}

#[test]
fn proposal_validation_fails_closed_on_unbounded_or_no_op_input() {
    assert!(
        OrgProposalOp::CreateRegion { name: "  ".into() }
            .validate()
            .is_err()
    );
    assert!(
        OrgProposalOp::RenameBranch {
            branch_id: Uuid::new_v4(),
            name: None,
            region_id: None,
        }
        .validate()
        .is_err()
    );
    assert!(
        OrgProposalOp::ReassignOrgUnit {
            from_org_unit: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".into(),
            to_org_unit: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".into(),
            scope: ReassignScope {
                company: "SAE".into()
            },
            employee_ids: None,
        }
        .validate()
        .is_err()
    );
    assert!(
        OrgProposalOp::ReassignOrgUnit {
            from_org_unit: "정비1팀".into(),
            to_org_unit: "정비2팀".into(),
            scope: ReassignScope {
                company: "SAE".into()
            },
            employee_ids: None,
        }
        .validate()
        .is_err(),
        "free-text team labels must fail closed now that OrgUnit UUIDs are required"
    );
    let too_many = vec![
        OrgProposalOp::CreateRegion {
            name: "지역".into()
        };
        101
    ];
    assert!(validate_proposal(&too_many).is_err());
}

#[test]
fn org_unit_ops_round_trip_and_enforce_nesting() {
    let parent = Uuid::new_v4();
    let op = OrgProposalOp::CreateOrgUnit {
        kind: OrgUnitKind::Department,
        parent_id: Some(parent),
        name: "정비부".into(),
    };
    let json = serde_json::to_value(&op).unwrap();
    assert_eq!(json["op"], "CREATE_ORG_UNIT");
    assert_eq!(json["kind"], "DEPARTMENT");
    assert_eq!(json["parentId"], parent.to_string());
    assert_eq!(serde_json::from_value::<OrgProposalOp>(json).unwrap(), op);
    assert!(
        OrgProposalOp::MoveOrgUnit {
            org_unit_id: parent,
            parent_id: parent
        }
        .validate()
        .is_err()
    );
    use OrgUnitKind as K;
    assert!(K::Site.admits_parent(None));
    assert!(K::Department.admits_parent(Some(K::Site)));
    // One 부서 kind (decisions #18): a 부서 under a 부서, at any depth.
    assert!(K::Department.admits_parent(Some(K::Department)));
    assert!(!K::Department.admits_parent(None));
    assert!(!K::Site.admits_parent(Some(K::Department)));
    // The retired TEAM still deserializes, as a 부서.
    assert_eq!(
        serde_json::from_value::<K>(serde_json::json!("TEAM")).unwrap(),
        K::Department
    );
    assert_eq!(K::from_attr("team"), Some(K::Department));
    assert!(!K::Site.admits_parent(Some(K::Site)));
}

#[test]
fn bare_sites_and_region_branch_edits_are_retired() {
    let id = Uuid::new_v4();
    let site = OrgProposalOp::CreateOrgUnit {
        kind: OrgUnitKind::Site,
        parent_id: None,
        name: "본사".into(),
    };
    assert_eq!(
        site.validate().unwrap_err().code,
        Some(SITE_NEEDS_WORKPLACE)
    );
    for op in [
        OrgProposalOp::CreateRegion {
            name: "수도권".into(),
        },
        OrgProposalOp::RenameRegion {
            region_id: id,
            name: "수도권".into(),
        },
        OrgProposalOp::CreateBranch {
            region_id: id,
            name: "부산".into(),
        },
        OrgProposalOp::RenameBranch {
            branch_id: id,
            name: Some("부산".into()),
            region_id: None,
        },
    ] {
        assert_eq!(op.validate().unwrap_err().code, Some(REGION_BRANCH_RETIRED));
    }
    // Closing a legacy branch or region stays possible (cleanup).
    assert!(
        OrgProposalOp::DeactivateBranch { branch_id: id }
            .validate()
            .is_ok()
    );
    assert!(
        OrgProposalOp::DeactivateRegion { region_id: id }
            .validate()
            .is_ok()
    );
    let department = OrgProposalOp::CreateOrgUnit {
        kind: OrgUnitKind::Department,
        parent_id: Some(id),
        name: "생산부".into(),
    };
    assert!(refuse_retired(std::slice::from_ref(&department)).is_ok());
    assert_eq!(
        refuse_retired(&[department, site]).unwrap_err().code,
        Some(SITE_NEEDS_WORKPLACE)
    );
}
