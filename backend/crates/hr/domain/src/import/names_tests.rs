use std::collections::BTreeMap;

use uuid::Uuid;

use super::*;

fn index(names: &[&str]) -> (BTreeMap<String, Vec<Uuid>>, BTreeMap<String, Uuid>) {
    let mut index = BTreeMap::<String, Vec<Uuid>>::new();
    let mut ids = BTreeMap::new();
    for name in names {
        let id = Uuid::new_v4();
        index.entry((*name).to_owned()).or_default().push(id);
        ids.insert((*name).to_owned(), id);
    }
    (index, ids)
}

fn bases(text: &str, index: &BTreeMap<String, Vec<Uuid>>) -> Vec<(String, &'static str)> {
    candidates(text, index)
        .into_iter()
        .map(|c| (c.name, c.basis))
        .collect()
}

/// regression (W03): the walkthrough's near-miss names matched nothing and
/// 125 people came in 미배치 with no candidate offered.
#[test]
fn regression_walkthrough_near_misses_are_offered() {
    let (units, _) = index(&[
        "영업2팀",
        "플랫폼팀",
        "총무팀",
        "생산 1팀",
        "QA팀",
        "품질팀",
    ]);
    assert_eq!(
        bases("영업 2팀", &units),
        [("영업2팀".into(), "normalized")]
    );
    assert_eq!(
        bases("플랫폼 파트", &units),
        [("플랫폼팀".into(), "suffix")]
    );
    assert_eq!(
        bases("경영지원본부>총무팀", &units),
        [("총무팀".into(), "path")]
    );
    let (path_units, _) = index(&["영업팀"]);
    assert_eq!(
        bases("경영지원본부>영업파트", &path_units),
        [("영업팀".into(), "path")]
    );
    assert_eq!(
        bases("생산1팀", &units),
        [("생산 1팀".into(), "normalized")]
    );
    assert_eq!(bases("ＱＡ팀", &units), [("QA팀".into(), "normalized")]);
    let (places, _) = index(&["평택공장", "판교사업장", "본사"]);
    assert_eq!(
        bases("평택 공장", &places),
        [("평택공장".into(), "normalized")]
    );
    assert_eq!(bases("판교", &places), [("판교사업장".into(), "suffix")]);
}

#[test]
fn an_exact_single_name_needs_no_candidate_and_a_shared_one_lists_every_holder() {
    let mut units = BTreeMap::new();
    let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
    units.insert("인사팀".to_owned(), vec![a]);
    units.insert("총무팀".to_owned(), vec![a, b]);
    assert!(candidates("인사팀", &units).is_empty());
    let shared = candidates("총무팀", &units);
    assert_eq!(shared.len(), 2);
    assert!(shared.iter().all(|c| c.basis == "same_name"));
}

#[test]
fn unrelated_names_are_never_candidates() {
    let (units, _) = index(&["영업1팀", "개발팀", "공장"]);
    assert!(candidates("영업 2팀", &units).is_empty());
    assert!(candidates("인사", &units).is_empty());
    // A bare suffix is not a name: `팀` never strips to empty.
    assert!(candidates("팀", &units).is_empty());
    assert!(candidates("", &units).is_empty());
}

#[test]
fn candidates_are_capped_and_never_repeat_a_record() {
    let mut units = BTreeMap::new();
    for suffix in SUFFIXES {
        units.insert(format!("영업{suffix}"), vec![Uuid::new_v4()]);
    }
    let found = candidates("영업", &units);
    assert_eq!(found.len(), MAX_CANDIDATES);
    let twice = Uuid::new_v4();
    let units = BTreeMap::from([
        ("영업팀".to_owned(), vec![twice]),
        ("영업 팀".to_owned(), vec![twice]),
    ]);
    assert_eq!(candidates("영업파트", &units).len(), 1, "one record once");
}

#[test]
fn org_name_keys_ignore_space_width_case_and_separators() {
    assert_eq!(org_name_key(" 영업 2팀 "), "영업2팀");
    assert_eq!(org_name_key("ＱＡ　팀"), "qa팀");
    assert_eq!(org_name_key("경영-지원·본부(서울)"), "경영지원본부서울");
}

#[test]
fn review_choices_use_their_own_index_and_never_map_a_company_alias_as_a_unit() {
    use crate::import::review::{Resolution, ReviewItem, ReviewQueue};
    let (units, unit_ids) = index(&["영업팀"]);
    let (workplaces, workplace_ids) = index(&["영업공장"]);
    let item = |decision: &'static str| ReviewItem {
        source_column: None,
        id: decision.into(),
        reason: "unmapped",
        blocking: false,
        sheet: "roster".into(),
        row: None,
        cell: None,
        field: None,
        value: Some("영업파트".into()),
        rows: 1,
        candidates: vec![],
        resolution: Some(Resolution {
            decision,
            key: "영업파트".into(),
            choices: vec!["stale".into()],
        }),
    };
    let mut queue = ReviewQueue {
        items: vec![item("unit_map"), item("workplace_map"), item("company_map")],
        ..Default::default()
    };
    with_candidates(&mut queue, &units, &workplaces);
    for (i, id) in [(0, unit_ids["영업팀"]), (1, workplace_ids["영업공장"])] {
        assert_eq!(queue.items[i].candidates[0].id, id);
        assert!(queue.items[i].candidates[0].alias.is_none());
        assert_eq!(
            queue.items[i].resolution.as_ref().unwrap().choices,
            [id.to_string()]
        );
    }
    assert!(queue.items[2].candidates.is_empty());
    assert_eq!(
        queue.items[2].resolution.as_ref().unwrap().choices,
        ["stale"]
    );
}
