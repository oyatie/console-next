// SPDX-License-Identifier: LicenseRef-Proprietary
//! Register operations for callers already admitted by Cedar; no transport or identity policy here.
use console_ops_domain::obligation::{Event, Kind, Obligation, Refusal, State};
use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, UtcOffset};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Operator {
    pub person: String,
    pub method: String,
}

/// Supplied by the verified operator fact loader and request support-reference middleware.
#[derive(Debug, Clone, Deserialize)]
pub struct Context {
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    pub operator: Operator,
    pub support_ref: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    pub operator: Operator,
    pub obligation_id: String,
    #[serde(flatten)]
    pub event: Event,
}

#[derive(Debug, Clone, Serialize)]
pub struct Record {
    pub seq: u64,
    pub hash: String,
    pub support_ref: String,
    #[serde(flatten)]
    pub entry: Entry,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    Obligation(Refusal),
    ChainBroken(u64),
    Unreadable,
    WriteFailed,
}

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Obligation(refusal) => refusal.code(),
            Self::ChainBroken(_) | Self::Unreadable => "OPS_RECORD_CHAIN_BROKEN",
            Self::WriteFailed => "OPS_RECORD_WRITE_FAILED",
        }
    }

    pub fn reason(&self) -> String {
        match self {
            Self::ChainBroken(seq) => format!("record chain broken at {seq}"),
            Self::Unreadable => "records unreadable".into(),
            _ => self.code().into(),
        }
    }
}

/// Implementations verify on every read and hold one writer lock through build and durable append.
pub trait RecordSpool {
    fn read(&self) -> Result<Vec<Record>, Error>;
    fn append(
        &self,
        support_ref: &str,
        build: impl FnOnce(&[Record]) -> Result<Entry, Error>,
    ) -> Result<Record, Error>;
}

#[derive(Debug, Clone, Serialize)]
pub struct Item {
    pub id: String,
    #[serde(flatten)]
    pub obligation: Obligation,
}

#[derive(Debug, Serialize)]
pub struct Detail {
    #[serde(flatten)]
    pub item: Item,
    pub history: Vec<Record>,
}

pub struct Register<'a, S>(&'a S);

impl<'a, S: RecordSpool> Register<'a, S> {
    pub fn new(spool: &'a S) -> Self {
        Self(spool)
    }

    pub fn list(&self, kind: Option<Kind>, state: Option<State>) -> Result<Vec<Item>, Error> {
        Ok(replay(&self.0.read()?)?
            .into_iter()
            .filter(|item| {
                kind.is_none_or(|kind| item.obligation.kind() == kind)
                    && state.is_none_or(|state| item.obligation.state() == state)
            })
            .collect())
    }

    pub fn detail(&self, id: &str) -> Result<Detail, Error> {
        let records = self.0.read()?;
        let item = replay(&records)?
            .into_iter()
            .find(|item| item.id == id)
            .ok_or(Error::Obligation(Refusal::NotFound))?;
        Ok(Detail {
            item,
            history: records
                .into_iter()
                .filter(|record| record.entry.obligation_id == id)
                .collect(),
        })
    }

    pub fn open(&self, event: Event, context: &Context) -> Result<Record, Error> {
        self.commit(None, event, context)
    }

    pub fn event(&self, id: &str, event: Event, context: &Context) -> Result<Record, Error> {
        self.commit(Some(id), event, context)
    }

    fn commit(&self, id: Option<&str>, event: Event, context: &Context) -> Result<Record, Error> {
        self.0.append(&context.support_ref, |records| {
            let items = replay(records)?;
            if !valid_metadata(&context.operator, &context.support_ref)
                || id.is_none() != matches!(event, Event::Opened { .. })
            {
                return Err(Error::Obligation(Refusal::Invalid));
            }
            let current = id.and_then(|id| items.iter().find(|item| item.id == id));
            Obligation::evolve(current.map(|item| &item.obligation), &event)
                .map_err(Error::Obligation)?;
            Ok(Entry {
                at: context.at.to_offset(UtcOffset::UTC),
                operator: context.operator.clone(),
                // The opening record's global sequence is unique under the append lock.
                obligation_id: id.map_or_else(|| (records.len() + 1).to_string(), str::to_owned),
                event,
            })
        })
    }
}

fn valid_metadata(operator: &Operator, support_ref: &str) -> bool {
    [&operator.person, &operator.method, support_ref]
        .iter()
        .all(|value| !value.trim().is_empty())
}

fn replay(records: &[Record]) -> Result<Vec<Item>, Error> {
    let mut items: Vec<Item> = Vec::new();
    for record in records {
        let entry = &record.entry;
        if entry.obligation_id.trim().is_empty()
            || !valid_metadata(&entry.operator, &record.support_ref)
        {
            return Err(Error::ChainBroken(record.seq));
        }
        let current = items.iter_mut().find(|item| item.id == entry.obligation_id);
        let obligation = Obligation::evolve(
            current.as_deref().map(|item| &item.obligation),
            &entry.event,
        )
        .map_err(|_| Error::ChainBroken(record.seq))?;
        if let Some(item) = current {
            item.obligation = obligation;
        } else {
            items.push(Item {
                id: entry.obligation_id.clone(),
                obligation,
            });
        }
    }
    Ok(items)
}
