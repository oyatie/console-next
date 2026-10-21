//! A dated copy of a 사업장's or 사업자등록's current revision with a new
//! status: CLOSED for a close (MR-14/15), or the status it had before its
//! close for a withdrawn 법인 close (UX-R3 company-15). The copy keeps every
//! other field (업태·종목 and 공동사업자 rows for a 사업자등록) and is dated so
//! it reads as the head.

use console_kernel_core::UserId;
use uuid::Uuid;

use crate::{Admitted, PgEntityError, Tx, today_kst};

/// What the copy records.
pub(crate) enum Copy {
    /// CLOSED from this date, copied from the revision in force today.
    Closed(time::Date),
    /// The last revision before the close, again, dated with the close so it
    /// reads as the head.
    Reopened,
}

/// The write's provenance.
pub(crate) struct RevisionAt {
    pub admitted: Admitted,
    pub actor: UserId,
    pub command: Uuid,
}

const REGISTRATION: &str = "WITH src AS (SELECT * FROM business_registration_revisions r WHERE r.registration_id = $1 {SRC}), \
              ins AS (INSERT INTO business_registration_revisions (org_id, registration_id, version, effective_from, trade_name, \
                        opened_on, business_address_id, production_factor, issue_reason_kind, issue_reason_sub, \
                        issue_reason_as_printed, liquor_license_no, unit_taxation, e_invoice_email, cert_issued_on, tax_office_code, \
                        tax_office_label, tax_type, status, status_since, change_mode, reason_code, actor_id, payload_digest, \
                        settings_snapshot, command_id, classification_reason) \
                      SELECT org_id, registration_id, (SELECT max(version) + 1 FROM business_registration_revisions WHERE registration_id = $1), \
                        GREATEST($2, effective_from), trade_name, opened_on, business_address_id, production_factor, issue_reason_kind, \
                        issue_reason_sub, issue_reason_as_printed, liquor_license_no, unit_taxation, e_invoice_email, cert_issued_on, \
                        tax_office_code, tax_office_label, tax_type, {STATUS}, {SINCE}, $3, $4, $5, \
                        sha256(convert_to(jsonb_build_object('{KEY}', version, 'status_since', $2::date)::text, 'UTF8')), $6, $7, classification_reason \
                      FROM src RETURNING id), \
              types AS (INSERT INTO business_registration_business_types (org_id, revision_id, seq, is_main, sector_as_printed, \
                          item_as_printed, nts_code, ksic_code, ksic_label, ksic_version) \
                        SELECT b.org_id, ins.id, b.seq, b.is_main, b.sector_as_printed, b.item_as_printed, b.nts_code, b.ksic_code, \
                          b.ksic_label, b.ksic_version \
                        FROM business_registration_business_types b, src, ins WHERE b.revision_id = src.id) \
         INSERT INTO business_registration_co_owners (org_id, revision_id, seq, name) \
         SELECT c.org_id, ins.id, c.seq, c.name FROM business_registration_co_owners c, src, ins WHERE c.revision_id = src.id";
const WORKPLACE: &str = "INSERT INTO workplace_revisions (org_id, workplace_id, version, effective_from, name, address_id, mail_address_id, \
           opened_on, representative_name, main_product, phone, fax, mobile, email, is_construction_site, status, status_since, \
           withholding_mode, bulk_filed_on, independent_lsa_unit, independent_lsa_evidence, change_mode, reason_code, actor_id, \
           payload_digest, settings_snapshot, command_id) \
         SELECT org_id, workplace_id, (SELECT max(version) + 1 FROM workplace_revisions WHERE workplace_id = $1), \
           GREATEST($2, effective_from), name, address_id, mail_address_id, opened_on, representative_name, main_product, phone, \
           fax, mobile, email, is_construction_site, {STATUS}, {SINCE}, withholding_mode, bulk_filed_on, independent_lsa_unit, \
           independent_lsa_evidence, $3, $4, $5, \
           sha256(convert_to(jsonb_build_object('{KEY}', version, 'status_since', $2::date)::text, 'UTF8')), $6, $7 \
         FROM workplace_revisions r WHERE r.workplace_id = $1 {SRC}";

/// Append the copy of one 사업장 (`registration` false) or 사업자등록 (true).
///
/// a revision scheduled after today still reads as the head on its
/// date; a scheduled-revision runner should re-apply the close then.
pub(crate) async fn append_copy(
    tx: &mut Tx<'_>,
    registration: bool,
    id: Uuid,
    copy: Copy,
    reason: &str,
    at: RevisionAt,
) -> Result<(), PgEntityError> {
    let (table, column) = if registration {
        ("business_registration_revisions", "registration_id")
    } else {
        ("workplace_revisions", "workplace_id")
    };
    let (on, src, status, since, key) = match copy {
        Copy::Closed(on) => (
            on,
            "ORDER BY (r.effective_from <= $8) DESC, r.effective_from DESC, r.version DESC LIMIT 1",
            "'CLOSED'",
            "$2",
            "closed_from_version",
        ),
        Copy::Reopened => {
            // The table and column are this module's own constants, never input.
            let head: time::Date = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "SELECT max(effective_from) FROM {table} WHERE {column} = $1"
            )))
            .bind(id)
            .fetch_one(tx.as_mut())
            .await?;
            (
                head,
                "AND r.status <> 'CLOSED' ORDER BY r.version DESC LIMIT 1",
                "status",
                "status_since",
                "reopened_from_version",
            )
        }
    };
    let sql = if registration {
        REGISTRATION
    } else {
        WORKPLACE
    }
    .replace("{SRC}", src)
    .replace("{STATUS}", status)
    .replace("{SINCE}", since)
    .replace("{KEY}", key);
    let today = today_kst(tx).await?;
    // The SQL is this module's constants with constant fragments; every value is a bind.
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(on)
        .bind(at.admitted.mode.as_str())
        .bind(reason)
        .bind(*at.actor.as_uuid())
        .bind(at.admitted.snapshot())
        .bind(at.command)
        .bind(today)
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

/// The reason the N-1 copy records; registration history leaves these rows out.
pub(crate) const LEGAL_NAME_DERIVED: &str =
    console_entity_domain::SystemReason::LegalNameDerived.as_str();

/// Copy registration revision `$1` whole (every column, so nothing new is ever
/// dropped), overriding what the new row must own.
const RENAMED: &str = "INSERT INTO business_registration_revisions SELECT (jsonb_populate_record(NULL::business_registration_revisions, \
     to_jsonb(r) || jsonb_build_object('id', gen_random_uuid(), 'created_at', now(), \
       'version', (SELECT max(version) + 1 FROM business_registration_revisions WHERE registration_id = r.registration_id), \
       'effective_from', GREATEST($2, r.effective_from), 'trade_name', $3::text, 'change_mode', $4::text, 'reason_code', $5::text, \
       'actor_id', $6::uuid, 'command_id', $7::uuid, 'settings_snapshot', $8::jsonb, 'evidence_document_id', NULL, \
       'payload_digest', sha256(convert_to(jsonb_build_object('renamed_from_version', r.version, 'trade_name', $3::text)::text, 'UTF8'))))).* \
     FROM business_registration_revisions r WHERE r.id = $1 RETURNING id";

/// N-1 canary consistency (0h): the binary derives every registration's ① from
/// the 법인명, but the previous release still reads `trade_name`. A 법인명
/// change therefore appends, in the same transaction, a copy of each live
/// registration's head revision carrying the new name, dated with the rename.
/// Goes away with the contract migration that drops `trade_name`.
pub(crate) async fn append_renamed_registrations(
    tx: &mut Tx<'_>,
    entity: Uuid,
    name: &str,
    on: time::Date,
    at: RevisionAt,
) -> Result<(), PgEntityError> {
    let heads: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT registration, head FROM (SELECT DISTINCT ON (b.id) b.id AS registration, r.id AS head, r.trade_name \
           FROM business_registrations b JOIN business_registration_revisions r ON r.registration_id = b.id \
           WHERE b.legal_entity_id = $1 AND b.voided_at IS NULL ORDER BY b.id, r.effective_from DESC, r.version DESC) h \
         WHERE h.trade_name IS DISTINCT FROM $2",
    )
    .bind(entity)
    .bind(name)
    .fetch_all(tx.as_mut())
    .await?;
    for (registration, head) in heads {
        let rev: Uuid = sqlx::query_scalar(RENAMED)
            .bind(head)
            .bind(on)
            .bind(name)
            .bind(at.admitted.mode.as_str())
            .bind(LEGAL_NAME_DERIVED)
            .bind(*at.actor.as_uuid())
            .bind(crate::closure::per_record(at.command, registration))
            .bind(at.admitted.snapshot())
            .fetch_one(tx.as_mut())
            .await?;
        // 업태·종목 and 공동사업자 rows belong to a revision: carry them over.
        for sql in [
            "INSERT INTO business_registration_business_types (org_id, revision_id, seq, is_main, sector_as_printed, \
               item_as_printed, nts_code, ksic_code, ksic_label, ksic_version) \
             SELECT org_id, $2, seq, is_main, sector_as_printed, item_as_printed, nts_code, ksic_code, ksic_label, ksic_version \
             FROM business_registration_business_types WHERE revision_id = $1",
            "INSERT INTO business_registration_co_owners (org_id, revision_id, seq, name) \
             SELECT org_id, $2, seq, name FROM business_registration_co_owners WHERE revision_id = $1",
        ] {
            sqlx::query(sql)
                .bind(head)
                .bind(rev)
                .execute(tx.as_mut())
                .await?;
        }
    }
    Ok(())
}

/// 409 `stale_revision` unless the client read the registration at a version no
/// person has changed since: an N-1 name copy appended after it is not a change,
/// so an open 등록증 sheet stays valid across a 법인명 change.
pub(crate) async fn ensure_registration_version(
    tx: &mut Tx<'_>,
    id: Uuid,
    expected: i32,
) -> Result<(), PgEntityError> {
    let (current, person): (i32, i32) = sqlx::query_as(
        "SELECT COALESCE(max(version), 0), COALESCE(max(version) FILTER (WHERE reason_code <> $2), 0) \
         FROM business_registration_revisions WHERE registration_id = $1",
    )
    .bind(id)
    .bind(LEGAL_NAME_DERIVED)
    .fetch_one(tx.as_mut())
    .await?;
    if (person..=current).contains(&expected) {
        Ok(())
    } else {
        Err(console_entity_domain::Refusal::stale_revision(expected, current).into())
    }
}
