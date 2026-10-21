//! Canonical JSON equality (ME-9, RFC 6902 §4.6).
//!
//! `serde_json::Value`'s own `==` treats `1` and `1.0` as different, because
//! it compares the number's storage variant. RFC 6902 compares numbers by
//! value, strings by code point, objects ignoring member order.

use serde_json::{Number, Value};

/// RFC 6902 §4.6 equality.
#[must_use]
pub fn json_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => number_eq(x, y),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_eq(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(key, p)| y.get(key).is_some_and(|q| json_eq(p, q)))
        }
        // Strings: UTF-8 byte equality is code-point equality.
        _ => a == b,
    }
}

// an integer above 2^53 compared with a float falls back to f64 and
// can match a neighbour. Canonical record JSON (ME-9) carries no such
// numbers; compare as decimal text if one ever appears.
fn number_eq(x: &Number, y: &Number) -> bool {
    if let (Some(p), Some(q)) = (x.as_i64(), y.as_i64()) {
        return p == q;
    }
    if let (Some(p), Some(q)) = (x.as_u64(), y.as_u64()) {
        return p == q;
    }
    matches!((x.as_f64(), y.as_f64()), (Some(p), Some(q)) if p == q)
}

#[cfg(test)]
mod tests {
    use super::json_eq;
    use serde_json::json;

    #[test]
    fn numbers_compare_by_value() {
        assert!(json_eq(&json!(1), &json!(1.0)));
        assert!(json_eq(&json!(-3), &json!(-3.0)));
        assert!(!json_eq(&json!(1), &json!(1.5)));
        assert!(!json_eq(&json!(-1), &json!(u64::MAX)));
    }

    #[test]
    fn structures_compare_deeply_and_strings_exactly() {
        assert!(json_eq(
            &json!({"a": [1, {"b": 2.0}], "c": "x"}),
            &json!({"c": "x", "a": [1.0, {"b": 2}]})
        ));
        assert!(!json_eq(&json!({"a": 1}), &json!({"a": 1, "b": null})));
        assert!(!json_eq(&json!("1.50"), &json!("1.5")));
        assert!(!json_eq(&json!(null), &json!(0)));
        assert!(!json_eq(&json!([1, 2]), &json!([2, 1])));
    }
}
