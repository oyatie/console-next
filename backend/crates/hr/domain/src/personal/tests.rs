use super::*;
use time::macros::date;

#[test]
fn hanja_and_english_names_are_shape_checked_and_collapsed() {
    assert_eq!(
        normalize_name_hanja(" 金  河늘 ").ok(),
        None,
        "Hangul inside a 한자 name is refused"
    );
    assert_eq!(
        normalize_name_hanja(" 金 河娜 ").unwrap(),
        Some("金 河娜".into())
    );
    assert_eq!(normalize_name_hanja("   ").unwrap(), None);
    assert_eq!(
        normalize_name_en("  KIM   Ha-neul ").unwrap(),
        Some("KIM Ha-neul".into())
    );
    assert_eq!(
        normalize_name_en("José O'Neil").unwrap(),
        Some("José O'Neil".into())
    );
    for bad in ["김하늘", "KIM1", "---", "A×B"] {
        assert!(normalize_name_en(bad).is_err(), "{bad}");
    }
}

#[test]
fn nationality_is_an_upper_case_alpha_2_code_or_unset() {
    assert_eq!(normalize_nationality(" kr ").unwrap(), Some("KR".into()));
    assert_eq!(normalize_nationality("").unwrap(), None);
    for bad in ["KOR", "K", "대한민국", "K1"] {
        assert!(normalize_nationality(bad).is_err(), "{bad}");
    }
}

#[test]
fn emergency_contacts_are_bounded_and_named() {
    let row = |name: &str, phone: &str| EmergencyContactInput {
        name: name.into(),
        relation: ContactRelation::Spouse,
        phone: phone.into(),
        contact_notified: Some(true),
    };
    let rows = normalize_emergency_contacts(vec![row(" 이 하나 ", "010-1234-5678")]).unwrap();
    assert_eq!(rows[0].name, "이 하나");
    assert!(normalize_emergency_contacts(vec![row(" ", "010")]).is_err());
    assert!(normalize_emergency_contacts(vec![row("이", " ")]).is_err());
    assert!(normalize_emergency_contacts(vec![row("a", "1"); 4]).is_err());
    assert!(normalize_emergency_contacts(Vec::new()).unwrap().is_empty());
}

#[test]
fn photos_are_raster_images_within_the_size_limit() {
    assert_eq!(check_photo("IMAGE/PNG", 10).unwrap(), "image/png");
    assert!(check_photo("image/svg+xml", 10).is_err());
    assert!(check_photo("image/jpeg", 0).is_err());
    assert!(check_photo("image/jpeg", PHOTO_MAX_BYTES + 1).is_err());
}

#[test]
fn the_group_service_start_is_never_after_the_hire() {
    let hire = Some(date!(2024 - 03 - 02));
    assert!(validate_group_service_start(date!(2019 - 01 - 02), hire).is_ok());
    assert!(validate_group_service_start(date!(2024 - 03 - 02), hire).is_ok());
    assert!(validate_group_service_start(date!(2024 - 03 - 03), hire).is_err());
    assert!(validate_group_service_start(date!(1899 - 12 - 31), None).is_err());
}

#[test]
fn notice_confirmation_is_required_only_for_new_or_changed_contacts() {
    let row = EmergencyContact {
        name: "이하나".into(),
        relation: ContactRelation::Spouse,
        phone: "+821012345678".into(),
        contact_notified: false,
    };
    for input in [None, Some(false)] {
        let normalized = normalize_emergency_contacts(vec![EmergencyContactInput {
            name: row.name.clone(),
            relation: row.relation,
            phone: row.phone.clone(),
            contact_notified: input,
        }])
        .unwrap();
        assert_eq!(
            validate_emergency_contacts(&normalized, &[])
                .unwrap_err()
                .code,
            Some("emergency_contact_notice_unconfirmed")
        );
    }
    assert!(
        validate_emergency_contacts(std::slice::from_ref(&row), std::slice::from_ref(&row)).is_ok()
    );
    let mut changed = row.clone();
    changed.phone = "+821099998888".into();
    assert!(
        validate_emergency_contacts(std::slice::from_ref(&changed), std::slice::from_ref(&row))
            .is_err()
    );
    changed.contact_notified = true;
    assert!(validate_emergency_contacts(&[changed], std::slice::from_ref(&row)).is_ok());
    assert!(
        validate_emergency_contacts(&[row.clone(), row.clone()], &[row]).is_err(),
        "one historical row cannot authorize duplicates"
    );
    assert!(validate_emergency_contacts(&[], &[]).is_ok());
}
