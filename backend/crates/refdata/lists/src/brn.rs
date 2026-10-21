//! Publish the entity domain's versioned NTS classification as reference data.
use crate::Code;
use std::sync::LazyLock;

pub(crate) static CODES: LazyLock<Vec<Code>> = LazyLock::new(|| {
    console_entity_domain::registration_classification::classifications()
        .iter()
        .map(|r| Code {
            code: r.code,
            label: r.label,
            parent_label: None,
            citation_url: None,
            abstract_workplace: None,
            biz_kinds: Some(r.biz_kinds.clone()),
            head_office: Some(r.head_office),
        })
        .collect()
});
