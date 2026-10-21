//! What a dated revision changed: field-by-field text diff against the state
//! it replaces, which is the one in force on its date when it was recorded.

use console_entity_application::FieldChange;
use serde_json::{Map, Value};

/// The states recorded so far in one chain, each with the date it holds from.
pub(crate) type Recorded = Vec<(time::Date, Map<String, Value>)>;

fn text(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => Some(
            items
                .iter()
                .filter_map(|i| text(Some(i)))
                .collect::<Vec<_>>()
                .join(", "),
        ),
        other => Some(other.to_string()),
    }
}

/// What changed from `before` to `after` (field order: `after`'s keys, sorted).
pub(crate) fn diff(before: &Map<String, Value>, after: &Map<String, Value>) -> Vec<FieldChange> {
    let mut keys: Vec<&String> = after.keys().chain(before.keys()).collect();
    keys.sort();
    keys.dedup();
    keys.into_iter()
        .filter_map(|k| {
            let (b, a) = (text(before.get(k)), text(after.get(k)));
            (b != a).then(|| FieldChange {
                field: k.clone(),
                before: b,
                after: a,
            })
        })
        .collect()
}

/// The state a revision dated `at` replaces, among those recorded before it
/// (in recorded order): the latest-dated one on or before `at`, the later
/// recorded on a tie. A 정정 of today recorded after a change scheduled for a
/// later date is compared with today's state, not with the scheduled one.
/// A revision dated before every earlier one falls back to the last recorded.
pub(crate) fn predecessor(
    earlier: &[(time::Date, Map<String, Value>)],
    at: time::Date,
) -> Option<&Map<String, Value>> {
    earlier
        .iter()
        .enumerate()
        .filter(|(_, (d, _))| *d <= at)
        .max_by_key(|(i, (d, _))| (*d, *i))
        .map(|(_, (_, m))| m)
        .or_else(|| earlier.last().map(|(_, m)| m))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use time::macros::date;

    fn map(v: Value) -> Map<String, Value> {
        match v {
            Value::Object(m) => m,
            _ => Map::new(),
        }
    }

    #[test]
    fn diff_lists_changed_fields_only_as_text() {
        let before = map(json!({ "name": "가", "capital_won": 100, "reps": ["A"], "gone": "x" }));
        let after =
            map(json!({ "name": "나", "capital_won": 100, "reps": ["A", "B"], "new": true }));
        let changes = diff(&before, &after);
        let fields: Vec<_> = changes
            .iter()
            .map(|c| (c.field.as_str(), c.before.as_deref(), c.after.as_deref()))
            .collect();
        assert_eq!(
            fields,
            vec![
                ("gone", Some("x"), None),
                ("name", Some("가"), Some("나")),
                ("new", None, Some("true")),
                ("reps", Some("A"), Some("A, B")),
            ]
        );
        // The first revision lists every value it set.
        assert_eq!(
            diff(&Map::new(), &map(json!({ "a": null, "b": 1 }))).len(),
            1
        );
    }

    /// Regression (parity S3, 2026-10-07): a 대표전화 정정 of today recorded
    /// after a 대표자 변경 scheduled for next month listed 대표자 and 대표 방식
    /// as changed too, because it was diffed against the scheduled state.
    #[test]
    fn a_correction_after_a_scheduled_change_is_diffed_against_the_state_in_force() {
        let today = map(json!({ "reps": ["홍길동"], "mode": "SINGLE", "phone": null }));
        let scheduled =
            map(json!({ "reps": ["홍길동", "한지원"], "mode": "SEVERAL", "phone": null }));
        let earlier = vec![
            (date!(2026 - 10 - 07), today.clone()),
            (date!(2026 - 11 - 01), scheduled.clone()),
        ];
        let corrected = map(json!({ "reps": ["홍길동"], "mode": "SINGLE", "phone": "025550142" }));
        let before = predecessor(&earlier, date!(2026 - 10 - 07)).unwrap();
        let fields: Vec<_> = diff(before, &corrected)
            .into_iter()
            .map(|c| c.field)
            .collect();
        assert_eq!(fields, vec!["phone"]);
        // The scheduled change itself still reads against today's state.
        assert_eq!(
            predecessor(&earlier[..1], date!(2026 - 11 - 01)),
            Some(&today)
        );
        // A tie on the date: the later recorded one.
        let again = vec![
            (date!(2026 - 10 - 07), today),
            (date!(2026 - 10 - 07), scheduled.clone()),
        ];
        assert_eq!(predecessor(&again, date!(2026 - 10 - 07)), Some(&scheduled));
        // Dated before everything recorded: the last recorded.
        assert_eq!(predecessor(&again, date!(2020 - 01 - 01)), Some(&scheduled));
        assert_eq!(predecessor(&[], date!(2020 - 01 - 01)), None);
    }
}
