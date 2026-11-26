// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, dead_code)]

use sqlx::PgPool;
use uuid::Uuid;

/// Seed all 9 S3-backed tables (including WORM-verified `evidence_media` and
/// EV WORM/append-only tables with self-referencing chains) for `org_uuid`.
pub async fn seed_all_nine_s3_tables(
    owner: &PgPool,
    org_uuid: Uuid,
    actor: Uuid,
    employee_id: Uuid,
    mail_account_id: Uuid,
) -> Vec<(String, Option<String>, String)> {
    let mut keys = Vec::new();
    let region_id = Uuid::new_v4();
    let branch_id = Uuid::new_v4();
    let customer_id = Uuid::new_v4();
    let site_id = Uuid::new_v4();
    let equip_id = Uuid::new_v4();
    let wo_id = Uuid::new_v4();

    sqlx::query("INSERT INTO regions (id, org_id, name) VALUES ($1,$2,'R1')") // rls-arming: ok owner fixture
        .bind(region_id)
        .bind(org_uuid)
        .execute(owner)
        .await
        .unwrap();
    sqlx::query("INSERT INTO branches (id, org_id, region_id, name) VALUES ($1,$2,$3,'B1')") // rls-arming: ok owner fixture
        .bind(branch_id)
        .bind(org_uuid)
        .bind(region_id)
        .execute(owner)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO registry_customers (id, org_id, branch_id, name) VALUES ($1,$2,$3,'C1')",
    ) // rls-arming: ok owner fixture
    .bind(customer_id)
    .bind(org_uuid)
    .bind(branch_id)
    .execute(owner)
    .await
    .unwrap();
    sqlx::query("INSERT INTO registry_sites (id, org_id, branch_id, customer_id, name) VALUES ($1,$2,$3,$4,'S1')") // rls-arming: ok owner fixture
        .bind(site_id).bind(org_uuid).bind(branch_id).bind(customer_id).execute(owner).await.unwrap();
    let standby_status: String = [0xC608_u32, 0xBE44]
        .into_iter()
        .filter_map(char::from_u32)
        .collect();
    sqlx::query( // rls-arming: ok owner fixture
        "INSERT INTO registry_equipment (id, org_id, branch_id, customer_id, site_id, equipment_no, \
         manufacturer_code, kind_code, power_code, status, specification, ton_text, source_sheet, source_row) \
         VALUES ($1,$2,$3,$4,$5,'ABC01-0001','M','K','P',$6,'SPEC','2t','S',1)",
    )
    .bind(equip_id)
    .bind(org_uuid)
    .bind(branch_id)
    .bind(customer_id)
    .bind(site_id)
    .bind(standby_status)
    .execute(owner)
    .await
    .unwrap();
    sqlx::query( // rls-arming: ok owner fixture
        "INSERT INTO work_orders (id, org_id, request_no, branch_id, equipment_id, customer_id, site_id, requested_by, status, symptom) \
         VALUES ($1,$2,'20261120-001',$3,$4,$5,$6,$7,'RECEIVED','noise')",
    )
    .bind(wo_id).bind(org_uuid).bind(branch_id).bind(equip_id).bind(customer_id).bind(site_id).bind(actor)
    .execute(owner).await.unwrap();

    // 1. evidence_media (s3_key, staging_s3_key, thumbnail_s3_key + VERIFIED REPLICA)
    let em_id = Uuid::new_v4();
    let em_key = format!("orgs/{org_uuid}/wo/{wo_id}/final.jpg");
    let em_stg = format!("orgs/{org_uuid}/wo/{wo_id}/staging.jpg");
    let em_th = format!("orgs/{org_uuid}/wo/{wo_id}/thumb.jpg");
    sqlx::query( // rls-arming: ok owner fixture
        "INSERT INTO evidence_media (id, org_id, work_order_id, stage, s3_key, staging_s3_key, thumbnail_s3_key, \
         content_type, size_bytes, uploaded_by, worm_replica_status, verified_at) \
         VALUES ($1,$2,$3,'AFTER',$4,$5,$6,'image/jpeg',100,$7,'VERIFIED',now())",
    )
    .bind(em_id).bind(org_uuid).bind(wo_id).bind(&em_key).bind(&em_stg).bind(&em_th).bind(actor)
    .execute(owner).await.unwrap();
    keys.push(("PRIMARY".into(), None, em_key.clone()));
    keys.push(("PRIMARY".into(), None, em_stg));
    keys.push(("PRIMARY".into(), None, em_th));
    keys.push(("REPLICA".into(), None, em_key));

    let pending_key = format!("orgs/{org_uuid}/wo/{wo_id}/pending.jpg");
    sqlx::query( // rls-arming: ok owner fixture
        "INSERT INTO evidence_media (org_id,work_order_id,stage,s3_key,content_type,size_bytes,uploaded_by,worm_replica_status)
         VALUES ($1,$2,'AFTER',$3,'image/jpeg',100,$4,'PENDING')",
    ).bind(org_uuid).bind(wo_id).bind(&pending_key).bind(actor).execute(owner).await.unwrap();
    keys.push(("PRIMARY".into(), None, pending_key.clone()));
    keys.push(("REPLICA".into(), None, pending_key));

    // 2. employee_photo_uploads
    let photo_key = format!("orgs/{org_uuid}/employees/{employee_id}/photo.jpg");
    sqlx::query("INSERT INTO employee_photo_uploads (org_id, id, employee_id, object_key, content_type, byte_size, issued_by) VALUES ($1,$2,$3,$4,'image/jpeg',128,$5)") // rls-arming: ok owner fixture
        .bind(org_uuid).bind(Uuid::new_v4()).bind(employee_id).bind(&photo_key).bind(actor)
        .execute(owner).await.unwrap();
    keys.push(("PRIMARY".into(), None, photo_key));

    // 3. document_versions
    let doc_key = format!("orgs/{org_uuid}/docs/v1.docx");
    sqlx::query( // rls-arming: ok owner fixture
        "INSERT INTO document_versions (org_id, document_ref, version_no, content_hash, storage_key, file_type, byte_size, created_by) \
         VALUES ($1,'DOC-1',1,$2,$3,'docx',64,$4)",
    )
    .bind(org_uuid).bind("a".repeat(64)).bind(&doc_key).bind(actor)
    .execute(owner).await.unwrap();
    keys.push(("PRIMARY".into(), None, doc_key));

    // 4. email_attachments
    let folder_id = Uuid::new_v4();
    let thread_id = Uuid::new_v4();
    let msg_id = Uuid::new_v4();
    let att_key = format!("orgs/{org_uuid}/mail/att.pdf");
    sqlx::query("INSERT INTO email_folders (id, org_id, account_id, imap_path, name) VALUES ($1,$2,$3,'INBOX','Inbox')") // rls-arming: ok owner fixture
        .bind(folder_id).bind(org_uuid).bind(mail_account_id).execute(owner).await.unwrap();
    sqlx::query("INSERT INTO email_threads (id, org_id, account_id, normalized_subject, subject, last_message_at) VALUES ($1,$2,$3,'s','s',now())") // rls-arming: ok owner fixture
        .bind(thread_id).bind(org_uuid).bind(mail_account_id).execute(owner).await.unwrap();
    sqlx::query("INSERT INTO email_messages (id, org_id, account_id, folder_id, thread_id, direction, from_address, received_at) VALUES ($1,$2,$3,$4,$5,'IN','a@ex.test',now())") // rls-arming: ok owner fixture
        .bind(msg_id).bind(org_uuid).bind(mail_account_id).bind(folder_id).bind(thread_id).execute(owner).await.unwrap();
    sqlx::query("INSERT INTO email_attachments (org_id, message_id, s3_key, filename, content_type, size_bytes, sort_order) VALUES ($1,$2,$3,'a.pdf','application/pdf',42,1)") // rls-arming: ok owner fixture
        .bind(org_uuid).bind(msg_id).bind(&att_key).execute(owner).await.unwrap();
    keys.push(("PRIMARY".into(), None, att_key));

    // 5. mailbox_messages
    let mb_dom = Uuid::new_v4();
    let mb_id = Uuid::new_v4();
    let raw_key = format!("orgs/{org_uuid}/mailbox/raw.eml");
    sqlx::query(
        "INSERT INTO mailbox_domains (id, org_id, domain, created_by) VALUES ($1,$2,$3,$4)",
    ) // rls-arming: ok owner fixture
    .bind(mb_dom)
    .bind(org_uuid)
    .bind(format!("d{}.ex.test", &org_uuid.simple().to_string()[..8]))
    .bind(actor)
    .execute(owner)
    .await
    .unwrap();
    sqlx::query("INSERT INTO mailboxes (id, org_id, domain_id, local_part, display_name, mailbox_kind, created_by) VALUES ($1,$2,$3,'team','Team','SHARED',$4)") // rls-arming: ok owner fixture
        .bind(mb_id).bind(org_uuid).bind(mb_dom).bind(actor)
        .execute(owner).await.unwrap();
    sqlx::query("INSERT INTO mailbox_messages (org_id, mailbox_id, domain_id, direction, raw_object_key, raw_size_bytes, received_at) VALUES ($1,$2,$3,'IN',$4,99,now())") // rls-arming: ok owner fixture
        .bind(org_uuid).bind(mb_id).bind(mb_dom).bind(&raw_key)
        .execute(owner).await.unwrap();
    keys.push(("PRIMARY".into(), None, raw_key));

    // 6. financial_purchase_attachments (EXPLICIT bucket; missing from S3 -> 404 NoSuchKey check)
    let fpa_key = format!("orgs/{org_uuid}/purchase/quote.pdf");
    sqlx::query( // rls-arming: ok owner fixture
        "INSERT INTO financial_purchase_attachments (org_id, branch_id, uploaded_by, role, file_name, content_type, size_bytes, s3_bucket, s3_key) \
         VALUES ($1,$2,$3,'QUOTE','q.pdf','application/pdf',10,'custom-purchase-bkt',$4)",
    )
    .bind(org_uuid).bind(branch_id).bind(actor).bind(&fpa_key)
    .execute(owner).await.unwrap();
    keys.push((
        "EXPLICIT".into(),
        Some("custom-purchase-bkt".into()),
        fpa_key,
    ));

    // 7. sales_listing_media
    let listing_id = Uuid::new_v4();
    let slm_key = format!("orgs/{org_uuid}/sales/forklift.png");
    sqlx::query("INSERT INTO sales_listings (id, org_id, kind, model_name) VALUES ($1,$2,'ELECTRIC','FL-1')") // rls-arming: ok owner fixture
        .bind(listing_id).bind(org_uuid).execute(owner).await.unwrap();
    sqlx::query("INSERT INTO sales_listing_media (org_id, listing_id, s3_key, content_type) VALUES ($1,$2,$3,'image/png')") // rls-arming: ok owner fixture
        .bind(org_uuid).bind(listing_id).bind(&slm_key).execute(owner).await.unwrap();
    keys.push(("PRIMARY".into(), None, slm_key));

    // 8 & 9. docs_evidence_objects + docs_evidence_copies (ORIGINAL + DERIVATIVE) + docs_evidence_tsa_proofs + custody + exports
    let ev_obj = Uuid::new_v4();
    let copy_orig = Uuid::new_v4();
    let copy_deriv = Uuid::new_v4();
    let ev_orig_key = format!("orgs/{org_uuid}/ev/orig.pdf");
    let ev_deriv_key = format!("orgs/{org_uuid}/ev/deriv.pdf");
    let ev_tsa_key = format!("orgs/{org_uuid}/ev/tsa.tsr");
    sqlx::query( // rls-arming: ok owner fixture
        "INSERT INTO docs_evidence_objects (id, org_id, code, title, source_type, source_id, classification, created_by, updated_by) \
         VALUES ($1,$2,'EV-001','Ev','external_document','ext-1','INTERNAL',$3,$3)",
    )
    .bind(ev_obj).bind(org_uuid).bind(actor).execute(owner).await.unwrap();
    sqlx::query( // rls-arming: ok owner fixture
        "INSERT INTO docs_evidence_copies (id, org_id, evidence_object_id, copy_kind, storage_provider, storage_object_id, digest_sha256, content_type, size_bytes, created_by) \
         VALUES ($1,$2,$3,'ORIGINAL','seaweedfs',$4,$5,'application/pdf',10,$6)",
    )
    .bind(copy_orig).bind(org_uuid).bind(ev_obj).bind(&ev_orig_key).bind("b".repeat(64)).bind(actor)
    .execute(owner).await.unwrap();
    sqlx::query( // rls-arming: ok owner fixture
        "INSERT INTO docs_evidence_copies (id, org_id, evidence_object_id, copy_kind, derivative_kind, parent_copy_id, storage_provider, storage_object_id, digest_sha256, content_type, size_bytes, created_by) \
         VALUES ($1,$2,$3,'DERIVATIVE','REDACTED',$4,'seaweedfs',$5,$6,'application/pdf',8,$7)",
    )
    .bind(copy_deriv).bind(org_uuid).bind(ev_obj).bind(copy_orig).bind(&ev_deriv_key).bind("c".repeat(64)).bind(actor)
    .execute(owner).await.unwrap();
    sqlx::query( // rls-arming: ok owner fixture
        "INSERT INTO docs_evidence_tsa_proofs (org_id, evidence_object_id, copy_id, status, provider, hash_algorithm, token_storage_provider, token_storage_object_id, created_by) \
         VALUES ($1,$2,$3,'PENDING','tsa','SHA-256','seaweedfs',$4,$5)",
    )
    .bind(org_uuid).bind(ev_obj).bind(copy_orig).bind(&ev_tsa_key).bind(actor)
    .execute(owner).await.unwrap();
    let ce1 = Uuid::new_v4();
    let ce2 = Uuid::new_v4();
    sqlx::query( // rls-arming: ok owner fixture
        "INSERT INTO docs_evidence_custody_events (id, org_id, evidence_object_id, stage, actor_user_id, reason, event_digest_sha256, occurred_at) \
         VALUES ($1,$2,$3,'REGISTERED',$4,'reg',$5,now())",
    )
    .bind(ce1).bind(org_uuid).bind(ev_obj).bind(actor).bind("d".repeat(64)).execute(owner).await.unwrap();
    sqlx::query( // rls-arming: ok owner fixture
        "INSERT INTO docs_evidence_custody_events (id, org_id, evidence_object_id, stage, actor_user_id, reason, previous_event_id, event_digest_sha256, occurred_at) \
         VALUES ($1,$2,$3,'HASH_RECORDED',$4,'hash',$5,$6,now())",
    )
    .bind(ce2).bind(org_uuid).bind(ev_obj).bind(actor).bind(ce1).bind("e".repeat(64)).execute(owner).await.unwrap();
    sqlx::query( // rls-arming: ok owner fixture
        "INSERT INTO docs_evidence_exports (org_id, evidence_object_id, manifest_digest_sha256, signature_algorithm, export_reason, exported_by, exported_at, custody_event_id) \
         VALUES ($1,$2,$3,'Ed25519','audit',$4,now(),$5)",
    )
    .bind(org_uuid).bind(ev_obj).bind("f".repeat(64)).bind(actor).bind(ce2).execute(owner).await.unwrap();

    keys.push(("PRIMARY".into(), None, ev_orig_key));
    keys.push(("PRIMARY".into(), None, ev_deriv_key));
    keys.push(("PRIMARY".into(), None, ev_tsa_key));
    keys
}
