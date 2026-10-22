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
                        GREATEST($2, effective_from), CASE WHEN (SELECT e.biz_kind FROM legal_entities e JOIN business_registrations b ON b.legal_entity_id = e.id WHERE b.id = $1) = 'INDIVIDUAL' THEN trade_name ELSE NULL END, opened_on, business_address_id, production_factor, issue_reason_kind, \
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

/// The reason legacy N-1 name copies carry; registration history leaves these rows out.
pub(crate) const LEGAL_NAME_DERIVED: &str =
    console_entity_domain::SystemReason::LegalNameDerived.as_str();

/// SS-001 / AD-F02c: a 법인명 change appends nothing to its registrations. The released
/// binary derives every registration's ① from the entity at read time, so no reader of
/// `trade_name` remains. Kept as a no-op until the contract step removes its callers.
pub(crate) async fn append_renamed_registrations(
    _tx: &mut Tx<'_>,
    _entity: Uuid,
    _name: &str,
    _on: time::Date,
    _at: RevisionAt,
) -> Result<(), PgEntityError> {
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
