// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::HashSet;

#[derive(Default)]
pub(super) struct FreshObjects {
    tables: HashSet<String>,
    functions: HashSet<String>,
}

fn name(words: &[&str]) -> Option<(String, usize)> {
    match words {
        [schema, ".", object, ..] => Some((format!("{schema}.{object}"), 3)),
        [object, ..] if !["if", "only", "."].contains(object) => {
            Some((format!("public.{object}"), 1))
        }
        _ => None,
    }
}

impl FreshObjects {
    pub(super) fn remember(&mut self, statement: &str, words: &[&str]) {
        // The shared tokenizer folds identifier case, so quoted names cannot prove freshness.
        if statement.contains("__quoted_identifier__") {
            return;
        }
        match words {
            ["create", "table", rest @ ..] if !words.contains(&"partition") => {
                if let Some((name, _)) = name(rest) {
                    self.tables.insert(name);
                }
            }
            // Only an unconditional CREATE proves this overload did not exist.
            // Parameterized overloads stay contract until their signatures can be compared.
            ["create", "function", rest @ ..]
                if statement
                    .split_once('(')
                    .is_some_and(|(_, args)| args.trim_start().starts_with(')')) =>
            {
                if let Some((name, _)) = name(rest) {
                    self.functions.insert(name);
                }
            }
            _ => {}
        }
    }

    pub(super) fn rls(&self, table: &[&str], action: &[&str]) -> bool {
        name(table).is_some_and(|(name, _)| self.tables.contains(&name))
            && matches!(action, ["enable" | "force", "row", "level", "security"])
    }

    pub(super) fn policy(&self, words: &[&str]) -> bool {
        name(words).is_some_and(|(name, end)| {
            self.tables.contains(&name)
                && matches!(words.get(end), Some(&"using" | &"with" | &"for" | &"to"))
        })
    }

    pub(super) fn revoke(&self, statement: &str) -> bool {
        let Some((_, tail)) = statement.split_once(" on ") else {
            return false;
        };
        let Some((objects, roles)) = tail.split_once(" from ") else {
            return false;
        };
        let (objects, fresh, function) = if let Some(objects) = objects.strip_prefix("function ") {
            (objects, &self.functions, true)
        } else {
            (
                objects.strip_prefix("table ").unwrap_or(objects),
                &self.tables,
                false,
            )
        };
        !roles.is_empty()
            && objects.split(',').all(|object| {
                let compact = object.split_whitespace().collect::<String>();
                let object = if function {
                    let Some(object) = compact.strip_suffix("()") else {
                        return false;
                    };
                    object
                } else {
                    &compact
                };
                let tokens = crate::tokenize_table_reference_sql(object);
                let words: Vec<_> = tokens.iter().map(String::as_str).collect();
                name(&words).is_some_and(|(name, end)| end == words.len() && fresh.contains(&name))
            })
    }
}

pub(super) fn column(statement: &str, words: &[&str]) -> bool {
    let ["add", "column", _, rest @ ..] = words else {
        return false;
    };
    let mut depth = 0;
    for ch in statement.chars() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => return false,
            _ => {}
        }
    }
    let end = rest
        .iter()
        .position(|word| ["null", "not", "default"].contains(word))
        .unwrap_or(rest.len());
    let types = &rest[..end];
    let valid_type = match types {
        [word] => ![
            "check",
            "references",
            "unique",
            "primary",
            "constraint",
            "generated",
        ]
        .contains(word),
        [_, ".", _] | ["double", "precision"] | ["character" | "bit", "varying"] => true,
        ["timestamp" | "time", "with" | "without", "time", "zone"] => true,
        [
            "numeric" | "decimal" | "varchar" | "char" | "timestamp" | "time",
            precision @ ..,
        ] => {
            !precision.is_empty()
                && precision
                    .iter()
                    .all(|value| value.bytes().all(|ch| ch.is_ascii_digit()))
        }
        _ => false,
    };
    if !valid_type {
        return false;
    }
    match &rest[end..] {
        [] | ["null"] => true,
        options if options.contains(&"default") => {
            let Some((_, value)) = statement.rsplit_once(" default ") else {
                return false;
            };
            let value = value
                .strip_suffix(" not null")
                .or_else(|| value.strip_suffix(" null"))
                .unwrap_or(value)
                .trim();
            let not_null = options.windows(2).any(|pair| pair == ["not", "null"]);
            let constant = matches!(value, "__sql_literal__" | "true" | "false")
                || (value == "null" && !not_null)
                || (value
                    .bytes()
                    .all(|ch| ch.is_ascii_digit() || b".+-e".contains(&ch))
                    && value.parse::<f64>().is_ok());
            let allowed = matches!(
                options,
                ["default", ..] | ["not", "null", "default", ..] | ["null", "default", ..]
            );
            constant && allowed
        }
        _ => false,
    }
}
