// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
pub(super) fn mask(
    value: &mut Value,
    classes: &BTreeMap<String, String>,
    grants: &[String],
    path: &str,
) {
    let mut visible = grants.to_vec();
    visible.push("metadata".into());
    super::mask(value, classes, &visible, path);
}
#[test]
fn nested_personal_aliases_override_metadata_names_at_every_tree_depth() {
    let classes = BTreeMap::from([
        ("name".into(), "metadata".into()),
        ("entities".into(), "container".into()),
        ("children".into(), "container".into()),
        ("head".into(), "container".into()),
        ("head.name".into(), "personal".into()),
    ]);
    let mut value = json!({"entities":[{"name":"부서","children":[{"name":"하위 부서","head":{"name":"담당자"}}]}]});
    mask(&mut value, &classes, &[], "");
    assert_eq!(value["entities"][0]["name"], "부서");
    assert_eq!(value["entities"][0]["children"][0]["name"], "하위 부서");
    assert_eq!(value["entities"][0]["children"][0]["head"]["name"], "••••");
    let mut value = json!({"head":{"name":"담당자"}});
    mask(&mut value, &classes, &["personal".into()], "");
    assert_eq!(value["head"]["name"], "담당자");
}

#[test]
fn classified_personal_containers_cannot_expose_metadata_named_children() {
    let classes = BTreeMap::from([
        ("contacts".into(), "personal".into()),
        ("name".into(), "metadata".into()),
    ]);
    let mut value = json!({"contacts":[{"name":"개인 이름"}]});
    mask(&mut value, &classes, &[], "");
    assert!(value["contacts"].is_null());
}

#[test]
fn metadata_arrays_preserve_their_values() {
    let classes = BTreeMap::from([("codes".into(), "metadata".into())]);
    let mut value = json!({"codes":["A","B"]});
    mask(&mut value, &classes, &[], "");
    assert_eq!(value["codes"], json!(["A", "B"]));
}

#[test]
fn unknown_and_sensitive_fields_stay_masked_with_a_personal_grant() {
    let classes = BTreeMap::from([
        ("items".into(), "container".into()),
        ("count".into(), "metadata".into()),
        ("name".into(), "personal".into()),
        ("rrn".into(), "sensitive".into()),
    ]);
    let mut value =
        json!({"items":[{"name":"이름","rrn":"protected","phone":"private","count":2}]});
    mask(&mut value, &classes, &[], "");
    assert_eq!(value["items"][0]["name"], "••••");
    assert_eq!(value["items"][0]["count"], 2);
    let mut value = json!({"name":"이름","rrn":"protected"});
    mask(&mut value, &classes, &["personal".into()], "");
    assert_eq!(value["name"], "이름");
    assert_eq!(value["rrn"], "••••");
}
#[test]
fn unknown_objects_cannot_expose_metadata_named_children() {
    let classes = BTreeMap::from([("name".into(), "metadata".into())]);
    let mut value = json!({"unreviewed":{"name":"private"}});
    mask(&mut value, &classes, &[], "");
    assert!(value["unreviewed"].is_null());
}
