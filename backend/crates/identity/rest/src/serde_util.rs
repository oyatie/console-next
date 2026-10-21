use serde::Deserialize;

/// Deserialize a field so that a present-but-null JSON value maps to
/// `Some(None)` (clear), an absent field to `None` (leave unchanged), and a
/// present value to `Some(Some(value))` (set).
pub(crate) fn deserialize_optional_field<'de, D, T>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::<T>::deserialize(deserializer)?))
}
