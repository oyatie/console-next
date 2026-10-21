//! Expand a fully consumed literal table loop; every other PL/pgSQL body keeps the normal refusal.
use super::{Tok, lex, lex_with_completeness, statements};

pub(super) fn expand(tokens: Vec<Tok>) -> Vec<Tok> {
    let mut output = Vec::new();
    for statement in statements(&tokens) {
        output.extend(expand_loop(statement).unwrap_or_else(|| statement.to_vec()));
        output.push(Tok::Punct(';'));
    }
    output
}

struct Reader {
    tokens: Vec<Tok>,
    index: usize,
}
impl Reader {
    fn word(&mut self, value: &str) -> Option<()> {
        (self.tokens.get(self.index)?.word() == Some(value)).then(|| self.index += 1)
    }
    fn punct(&mut self, value: char) -> Option<()> {
        (self.tokens.get(self.index)? == &Tok::Punct(value)).then(|| self.index += 1)
    }
    fn text(&mut self) -> Option<String> {
        let Tok::Str(value) = self.tokens.get(self.index)? else {
            return None;
        };
        self.index += 1;
        Some(value.clone())
    }
}

fn expand_loop(statement: &[Tok]) -> Option<Vec<Tok>> {
    let [Tok::Word(head), Tok::Body(body)] = statement else {
        return None;
    };
    if head != "do" {
        return None;
    }
    let (tokens, complete) = lex_with_completeness(body);
    if !complete {
        return None;
    }
    let mut r = Reader { tokens, index: 0 };
    r.word("declare")?;
    let variable = r.tokens.get(r.index)?.word()?.to_owned();
    r.index += 1;
    r.word("text")?;
    r.punct(';')?;
    r.word("begin")?;
    r.word("foreach")?;
    r.word(&variable)?;
    r.word("in")?;
    r.word("array")?;
    r.word("array")?;
    r.punct('[')?;
    let mut tables = vec![r.text()?];
    while r.punct(',').is_some() {
        tables.push(r.text()?);
        if tables.len() > 64 {
            return None;
        }
    }
    r.punct(']')?;
    r.word("loop")?;
    let mut calls = Vec::new();
    while r.word("execute").is_some() {
        r.word("format")?;
        r.punct('(')?;
        let template = r.text()?;
        r.punct(',')?;
        r.word(&variable)?;
        let literal = if r.punct(',').is_some() {
            Some(r.text()?)
        } else {
            None
        };
        r.punct(')')?;
        r.punct(';')?;
        calls.push((template, literal));
        if calls.len() > 16 {
            return None;
        }
    }
    r.word("end")?;
    r.word("loop")?;
    r.punct(';')?;
    r.word("end")?;
    let _ = r.punct(';');
    if r.index != r.tokens.len() || calls.is_empty() {
        return None;
    }
    let mut output = Vec::new();
    for table in tables {
        for (template, literal) in &calls {
            output.extend(lex(&format_sql(template, &table, literal.as_deref())?));
            output.push(Tok::Punct(';'));
        }
    }
    Some(output)
}

fn format_sql(template: &str, table: &str, literal: Option<&str>) -> Option<String> {
    if template.len() > 8192
        || template.matches("%I").count() != 1
        || template.matches("%L").count() != usize::from(literal.is_some())
    {
        return None;
    }
    let identifier = format!("\"{}\"", table.replace('"', "\"\""));
    let value = literal.map(|v| format!("'{}'", v.replace('\'', "''")));
    let mut sql = String::new();
    let mut remaining = template;
    while let Some(at) = remaining.find('%') {
        sql.push_str(&remaining[..at]);
        match remaining.get(at..at + 2)? {
            "%I" => sql.push_str(&identifier),
            "%L" => sql.push_str(value.as_deref()?),
            _ => return None,
        }
        remaining = &remaining[at + 2..];
    }
    sql.push_str(remaining);
    Some(sql)
}
