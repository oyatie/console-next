//! 사업장 typed revision rows and the per-insurer 4대보험 rows.

use console_entity_domain::Refusal;
use console_entity_domain::codes::WithholdingMode;
use console_entity_domain::insurance::InsuranceDraft;
use console_entity_domain::workplace::{WorkplaceAddress, WorkplaceDraft};
use console_kernel_core::kr::InsuranceMgmtNo;
use uuid::Uuid;

use crate::address::{insert_address, insert_optional};
use crate::command::command_id;
use crate::{PgEntityError, RevisionMeta, Tx};
pub(crate) async fn insert_revision(
    tx: &mut Tx<'_>,
    id: Uuid,
    d: &WorkplaceDraft,
    registration_address: Option<Uuid>,
    m: &RevisionMeta<'_>,
) -> Result<(), PgEntityError> {
    let address = match &d.address {
        WorkplaceAddress::Own(a) => Some(insert_address(tx, a).await?),
        WorkplaceAddress::SameAsRegistration => registration_address,
    };
    let address =
        address.ok_or_else(|| Refusal::field("address", "registration_has_no_address"))?;
    let mail = insert_optional(tx, d.mail_address.as_ref()).await?;
    let phone =
        |p: &Option<console_kernel_core::kr::PhoneE164>| p.as_ref().map(|p| p.as_str().to_owned());
    sqlx::query(
        "INSERT INTO workplace_revisions (org_id, workplace_id, version, effective_from, name, address_id, \
           mail_address_id, opened_on, representative_name, main_product, phone, fax, mobile, email, \
           is_construction_site, status, status_since, status_until, withholding_mode, bulk_filed_on, independent_lsa_unit, \
           independent_lsa_evidence, change_mode, reason_code, actor_id, payload_digest, settings_snapshot, command_id) \
         VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, \
           $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24, sha256(convert_to($25::jsonb::text, 'UTF8')), $26, $27)",
    )
    .bind(id)
    .bind(m.version)
    .bind(m.effective_from)
    .bind(&d.name)
    .bind(address)
    .bind(mail)
    .bind(d.opened_on)
    .bind(&d.representative_name)
    .bind(&d.main_product)
    .bind(phone(&d.phone))
    .bind(phone(&d.fax))
    .bind(phone(&d.mobile))
    .bind(d.email.as_ref().map(|e| e.as_str().to_owned()))
    .bind(d.is_construction_site)
    .bind(d.status.as_str())
    .bind(d.status_since)
    .bind(d.status_until)
    .bind(d.withholding_mode.map(WithholdingMode::as_str))
    .bind(d.bulk_filed_on)
    .bind(d.independent_lsa_unit)
    .bind(&d.independent_lsa_evidence)
    .bind(m.admitted.mode.as_str())
    .bind(m.reason_code.as_str())
    .bind(*m.actor.user.as_uuid())
    .bind(&m.payload)
    .bind(m.admitted.snapshot())
    .bind(command_id(m.actor)?)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

pub(crate) async fn insert_insurance(
    tx: &mut Tx<'_>,
    workplace: Uuid,
    d: &InsuranceDraft,
    m: &RevisionMeta<'_>,
) -> Result<(), PgEntityError> {
    let version: i32 = sqlx::query_scalar(
        "SELECT COALESCE(max(version), 0) + 1 FROM workplace_insurance_revisions WHERE workplace_id = $1 AND insurer = $2",
    )
    .bind(workplace)
    .bind(d.insurer.as_str())
    .fetch_one(tx.as_mut())
    .await?;
    let no = |n: &Option<InsuranceMgmtNo>| n.as_ref().map(|n| n.as_str().to_owned());
    sqlx::query(
        "INSERT INTO workplace_insurance_revisions (org_id, workplace_id, insurer, version, effective_from, status, \
           mgmt_no, established_on, unit_mode, main_workplace_id, nps_separate_application, nhis_unit_workplace_code, \
           nhis_branch_office_code, nhis_workplace_class, iaci_business_type_code, iaci_business_type_label, \
           iaci_insurance_year, iaci_business_form, iaci_term_from, iaci_term_to, prime_contractor_mgmt_no, \
           change_mode, reason_code, actor_id, payload_digest, settings_snapshot, command_id) \
         VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, \
           $14,$15,$16,$17,$18,$19,$20,$21,$22,$23, sha256(convert_to($24::jsonb::text, 'UTF8')), $25, $26)",
    )
    .bind(workplace)
    .bind(d.insurer.as_str())
    .bind(version)
    .bind(m.effective_from)
    .bind(d.status.as_str())
    .bind(no(&d.mgmt_no))
    .bind(d.established_on)
    .bind(d.unit_mode.as_str())
    .bind(d.main_workplace_id)
    .bind(d.nps_separate_application)
    .bind(&d.nhis_unit_workplace_code)
    .bind(&d.nhis_branch_office_code)
    .bind(d.nhis_workplace_class.map(|c| c.as_str()))
    .bind(d.iaci_business_type.as_ref().map(|t| t.0.clone()))
    .bind(d.iaci_business_type.as_ref().map(|t| t.1.clone()))
    .bind(d.iaci_business_type.as_ref().map(|t| t.2))
    .bind(d.iaci_business_form.map(|f| f.as_str()))
    .bind(d.iaci_term.map(|t| t.0))
    .bind(d.iaci_term.map(|t| t.1))
    .bind(no(&d.prime_contractor_mgmt_no))
    .bind(m.admitted.mode.as_str())
    .bind(m.reason_code.as_str())
    .bind(*m.actor.user.as_uuid())
    .bind(serde_json::to_value(d)?)
    .bind(m.admitted.snapshot())
    .bind(command_id(m.actor)?)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}
