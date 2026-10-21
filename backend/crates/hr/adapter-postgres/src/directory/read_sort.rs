//! `GET /employees?sort=&cursor=`: the roster's server sort and keyset paging
//! (hr-polish A1; data-display-and-realtime §6.1). A page continues after the
//! last row's `(sort key, id)`, so a row added or removed mid-paging never
//! shifts the next page. The sort keys match migration 0261's indexes.

use sqlx::{Postgres, QueryBuilder};
use uuid::Uuid;

use crate::HrError;

/// A roster sort: one key, ascending or (`-key`) descending; `id` breaks ties.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RosterSort {
    key: SortKey,
    descending: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SortKey {
    Name,
    EmployeeNumber,
    HireDate,
    OrgUnit,
}

const KEYS: [(&str, SortKey); 4] = [
    ("name", SortKey::Name),
    ("employee_number", SortKey::EmployeeNumber),
    ("hire_date", SortKey::HireDate),
    ("org_unit", SortKey::OrgUnit),
];

/// Where the next page starts: after this sort value and id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RosterCursor {
    pub sort: RosterSort,
    pub value: String,
    pub id: Uuid,
}

fn invalid_sort() -> HrError {
    HrError::validation(
        "sort must be name, employee_number, hire_date or org_unit, optionally prefixed with -",
    )
}

fn invalid_cursor() -> HrError {
    HrError::validation("cursor is not a cursor this list returned for this sort")
}

impl RosterSort {
    pub fn parse(raw: &str) -> Result<Self, HrError> {
        let raw = raw.trim();
        let (descending, name) = match raw.strip_prefix('-') {
            Some(rest) => (true, rest),
            None => (false, raw),
        };
        KEYS.iter()
            .find(|(key, _)| *key == name)
            .map(|(_, key)| Self {
                key: *key,
                descending,
            })
            .ok_or_else(invalid_sort)
    }

    fn token(self) -> String {
        let name = KEYS
            .iter()
            .find(|(_, key)| *key == self.key)
            .map_or("name", |(name, _)| name);
        if self.descending {
            format!("-{name}")
        } else {
            name.to_owned()
        }
    }

    /// The SQL sort expression; a missing value sorts as `''`.
    pub fn expr(self) -> &'static str {
        match self.key {
            SortKey::Name => "e.name",
            SortKey::EmployeeNumber => "COALESCE(e.employee_number, '')",
            SortKey::HireDate => "COALESCE(e.hire_date, '')",
            SortKey::OrgUnit => "COALESCE(e.org_unit, '')",
        }
    }

    /// ` AND (key, id) >/< (value, id)` for the page after `cursor`.
    pub fn push_after(self, builder: &mut QueryBuilder<Postgres>, cursor: &RosterCursor) {
        let op = if self.descending { "<" } else { ">" };
        builder.push(format!(" AND ({}, e.id) {op} (", self.expr()));
        builder.push_bind(cursor.value.clone());
        builder.push(", ");
        builder.push_bind(cursor.id);
        builder.push(")");
    }

    /// ` ORDER BY key, id` in this sort's direction.
    pub fn push_order(self, builder: &mut QueryBuilder<Postgres>) {
        let direction = if self.descending { "DESC" } else { "ASC" };
        builder.push(format!(
            " ORDER BY {} {direction}, e.id {direction}",
            self.expr()
        ));
    }
}

impl RosterCursor {
    /// Opaque on the wire: hex of `sort~value~id`.
    pub fn encode(&self) -> String {
        hex::encode(format!("{}~{}~{}", self.sort.token(), self.value, self.id))
    }

    pub fn decode(raw: &str) -> Result<Self, HrError> {
        let text = hex::decode(raw.trim())
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .ok_or_else(invalid_cursor)?;
        let (sort, rest) = text.split_once('~').ok_or_else(invalid_cursor)?;
        let (value, id) = rest.rsplit_once('~').ok_or_else(invalid_cursor)?;
        Ok(Self {
            sort: RosterSort::parse(sort).map_err(|_| invalid_cursor())?,
            value: value.to_owned(),
            id: Uuid::parse_str(id).map_err(|_| invalid_cursor())?,
        })
    }
}

/// The page mode of one list read: the legacy offset order, or a keyset page.
#[derive(Clone, Debug)]
pub enum RosterPaging {
    Offset(i64),
    Keyset {
        sort: RosterSort,
        after: Option<RosterCursor>,
    },
}

impl RosterPaging {
    /// `sort` and `cursor` select keyset paging; a cursor carries its sort, so
    /// a different `sort` beside it, or an `offset`, is refused.
    pub fn from_query(
        sort: Option<&str>,
        cursor: Option<&str>,
        offset: Option<i64>,
    ) -> Result<Self, HrError> {
        let sort = sort
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(RosterSort::parse)
            .transpose()?;
        let cursor = cursor
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .map(RosterCursor::decode)
            .transpose()?;
        match (sort, cursor) {
            (None, None) => Ok(Self::Offset(offset.unwrap_or(0).max(0))),
            (_, Some(_)) if offset.is_some_and(|o| o > 0) => {
                Err(HrError::validation("cursor and offset cannot be combined"))
            }
            (Some(sort), Some(cursor)) if cursor.sort != sort => Err(invalid_cursor()),
            (_, Some(cursor)) => Ok(Self::Keyset {
                sort: cursor.sort,
                after: Some(cursor),
            }),
            (Some(sort), None) => Ok(Self::Keyset { sort, after: None }),
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn cursor_round_trips_with_tildes_in_the_value() {
        let cursor = RosterCursor {
            sort: RosterSort::parse("-hire_date").unwrap(),
            value: "a~b~c".to_owned(),
            id: Uuid::nil(),
        };
        assert_eq!(RosterCursor::decode(&cursor.encode()).unwrap(), cursor);
    }

    #[test]
    fn paging_refuses_bad_sorts_mismatched_cursors_and_offsets() {
        assert!(RosterSort::parse("salary").is_err());
        let cursor = RosterCursor {
            sort: RosterSort::parse("name").unwrap(),
            value: "Kim".into(),
            id: Uuid::nil(),
        }
        .encode();
        assert!(RosterPaging::from_query(Some("-name"), Some(&cursor), None).is_err());
        assert!(RosterPaging::from_query(None, Some(&cursor), Some(100)).is_err());
        assert!(RosterPaging::from_query(None, Some("zz"), None).is_err());
        assert!(matches!(
            RosterPaging::from_query(None, Some(&cursor), None),
            Ok(RosterPaging::Keyset { after: Some(_), .. })
        ));
        assert!(matches!(
            RosterPaging::from_query(None, None, Some(-3)),
            Ok(RosterPaging::Offset(0))
        ));
    }
}
