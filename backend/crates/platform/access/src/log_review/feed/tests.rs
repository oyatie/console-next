// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[test]
fn search_cursor_binds_normalized_terms_without_embedding_personal_search_text() {
    let org = OrgId::new();
    let query = |search: &str, cursor: Option<&str>| -> Query {
        serde_json::from_value(json!({"search":search,"cursor":cursor})).unwrap()
    };
    let q = query(" Historical~Actor ", None);
    let unfiltered: Query = serde_json::from_value(json!({})).unwrap();
    assert_eq!(
        query("", None).prefix(org, "2026-09"),
        unfiltered.prefix(org, "2026-09")
    );
    let prefix = q.prefix(org, "2026-09");
    assert!(!prefix.contains("historical"));
    assert_ne!(prefix, query("", None).prefix(org, "2026-09"));
    let cursor = format!("{prefix}1234567890~123456789~{}", Uuid::new_v4());
    assert!(
        query("historical~ACTOR", Some(&cursor))
            .cursor(org, "2026-09")
            .is_ok()
    );
    for term in ["historical", "", "different"] {
        assert_eq!(
            query(term, Some(&cursor))
                .cursor(org, "2026-09")
                .unwrap_err()
                .code,
            "cursor_invalid"
        );
    }
    assert_eq!(
        query(" \t", None).prefix(org, "2026-09"),
        query("", None).prefix(org, "2026-09")
    );
}

#[test]
fn cursor_round_trips_exact_timestamps_and_is_bound_to_the_query() {
    let org = OrgId::new();
    let id = Uuid::new_v4();
    let mut q = Query {
        period: Some("2026-09".into()),
        search: None,
        filters: Filters::default(),
        flagged: false,
        cursor: None,
        limit: None,
    };
    assert_eq!(q.cursor(org, "2026-09").unwrap(), None);
    q.cursor = Some(format!(
        "{}1234567890~123456789~{id}",
        q.prefix(org, "2026-09")
    ));
    let c = q.cursor(org, "2026-09").unwrap().unwrap();
    assert_eq!(
        (c.0.unix_timestamp_nanos(), c.1.unix_timestamp_nanos(), c.2),
        (1234567890, 123456789, id)
    );
    assert_eq!(
        q.cursor(OrgId::new(), "2026-09").unwrap_err().code,
        "cursor_invalid"
    );
    assert_eq!(q.cursor(org, "2026-08").unwrap_err().code, "cursor_invalid");
    q.flagged = true;
    assert_eq!(q.cursor(org, "2026-09").unwrap_err().code, "cursor_invalid");
}

#[test]
fn malformed_cursor_components_refuse_without_panicking() {
    let org = OrgId::new();
    let mut q = Query {
        period: Some("2026-09".into()),
        search: None,
        filters: Filters::default(),
        flagged: false,
        cursor: None,
        limit: None,
    };
    for tail in [
        "",
        "1",
        "1~2",
        "bad~2~00000000-0000-0000-0000-000000000000",
        "1~bad~00000000-0000-0000-0000-000000000000",
        "99999999999999999999999999999999999999999~0~00000000-0000-0000-0000-000000000000",
        "1~2~bad",
        "1~2~00000000-0000-0000-0000-000000000000~extra",
    ] {
        q.cursor = Some(format!("{}{tail}", q.prefix(org, "2026-09")));
        assert_eq!(
            q.cursor(org, "2026-09").unwrap_err().code,
            "cursor_invalid",
            "{tail}"
        );
    }
}

#[test]
fn page_limits_use_the_shared_list_contract() {
    for limit in [i64::MIN, -1, 0, super::super::MAX_PAGE_SIZE + 1, i64::MAX] {
        assert_eq!(
            list::validate_limit(limit).unwrap_err().code,
            "limit_out_of_range"
        );
    }
    for limit in [1, super::super::MAX_PAGE_SIZE] {
        list::validate_limit(limit).unwrap();
    }
}

#[test]
fn a_period_whose_exclusive_end_overflows_is_invalid() {
    let period = format!("{:04}-12", time::Date::MAX.year());
    assert!(list::period_day("9999-11").is_ok());
    assert_eq!(
        list::period_day(&period).unwrap_err().code,
        "period_invalid"
    );
}

#[test]
fn structured_filter_cursors_bind_each_field_and_cannot_alias_a_literal_search() {
    let org = OrgId::new();
    let filters = json!({"actor":Uuid::new_v4(),"action":"employee.export","target_type":"employee","from":"2026-09-01","to":"2026-09-30"});
    let query = |value| serde_json::from_value::<Query>(value).unwrap();
    let q = query(filters.clone());
    for field in ["actor", "action", "target_type", "from", "to"] {
        let mut changed = filters.clone();
        changed.as_object_mut().unwrap().remove(field);
        assert_ne!(
            q.prefix(org, "2026-09"),
            query(changed).prefix(org, "2026-09"),
            "{field}"
        );
    }
    let search = query(json!({"search":filters.to_string()}));
    assert_ne!(q.prefix(org, "2026-09"), search.prefix(org, "2026-09"));
    assert!(!q.prefix(org, "2026-09").contains("employee.export"));
}

#[test]
fn structured_filters_validate_options_and_calendar_bounds() {
    let zero: Query = serde_json::from_value(json!({"from":"0000-09-01"})).unwrap();
    assert_eq!(
        zero.filters
            .validate("0000-09", &json!({}))
            .unwrap_err()
            .code,
        "filter_invalid"
    );
    let actor = Uuid::new_v4().to_string();
    let options = json!({"actors":[{"id":actor}],"actions":[{"id":"employee.export"}],"target_types":[{"id":"employee"}]});
    for value in [
        json!({"actor":"unknown"}),
        json!({"action":"unknown.action"}),
        json!({"target_type":"unknown"}),
        json!({"from":"2026-08-31"}),
        json!({"to":"2026-10-01"}),
        json!({"from":"2026-09-31"}),
        json!({"from":"2026-09-1"}),
        json!({"from":""}),
        json!({"from":"2026-09-11","to":"2026-09-10"}),
    ] {
        let q: Query = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(
            q.filters.validate("2026-09", &options).unwrap_err().code,
            "filter_invalid",
            "{value}"
        );
    }
    for value in [
        json!({}),
        json!({"actor":actor,"action":"employee.export","target_type":"employee","from":"2026-09-01","to":"2026-09-30"}),
    ] {
        let q: Query = serde_json::from_value(value).unwrap();
        q.filters.validate("2026-09", &options).unwrap();
    }
}
