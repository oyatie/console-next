-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
SET LOCAL lock_timeout = '2s';

-- A replica may exist after COPY succeeds and verification or its commit fails.
CREATE OR REPLACE FUNCTION platform_force_remove_organization_command(
    p_id UUID, p_actor UUID, p_trace_id CHAR(32), p_span_id CHAR(16), p_occurred_at TIMESTAMPTZ
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    sentinel_org CONSTANT UUID := '00000000-0000-0000-0000-00000000face'::uuid;
    v_slug TEXT;
    v_name TEXT;
    v_outcome TEXT;
    v_wiped JSONB;
    v_request tenant_erase_requests%ROWTYPE;
    v_status TEXT;
    v_now TIMESTAMPTZ := clock_timestamp();
    v_shredded_count BIGINT := 0;
    v_key_fingerprint BYTEA;
    v_s3_outbox_queued BIGINT := 0;
    v_witness_seq BIGINT;
    v_witness_hash BYTEA;
BEGIN
    SET LOCAL row_security = off;
    -- Lock both operators before tenant accounts, then the organization and request.
    PERFORM id FROM users WHERE id IN (
        SELECT requested_by FROM tenant_erase_requests WHERE target_org_id = p_id AND cancelled_at IS NULL AND erased_at IS NULL
        UNION SELECT approved_by FROM tenant_erase_requests WHERE target_org_id = p_id AND cancelled_at IS NULL AND erased_at IS NULL
    ) ORDER BY id FOR NO KEY UPDATE;
    PERFORM platform_lock_organization_accounts_for_removal(p_id);
    IF EXISTS (SELECT 1 FROM docs_evidence_legal_holds WHERE org_id = p_id AND status = 'ACTIVE') THEN
        INSERT INTO audit_events (org_id, actor, action, target_type, target_id,
            after_snap, trace_id, span_id, occurred_at,
            principal_type, actor_kind, source, outcome, command_id)
        VALUES (p_id, p_actor, 'platform.tenant.force_remove.refused', 'organizations', p_id::text,
            jsonb_build_object('reason_code', 'blocked_legal_hold'), p_trace_id, p_span_id, p_occurred_at,
            'SUPPORT_OPERATOR', 'SUPPORT_OPERATOR', 'API', 'DENIED', gen_random_uuid());
        RETURN 'blocked_legal_hold';
    END IF;
    SELECT slug, name, status INTO v_slug, v_name, v_status FROM organizations WHERE id = p_id;
    IF v_slug IS NULL OR v_slug = 'platform' THEN RETURN 'not_found'; END IF;
    IF v_status <> 'ARCHIVED' THEN RETURN 'blocked_active'; END IF;
    SELECT * INTO v_request FROM tenant_erase_requests
        WHERE target_org_id = p_id AND cancelled_at IS NULL AND erased_at IS NULL FOR UPDATE;
    IF v_request.approved_by IS NULL THEN RETURN 'erase_requires_second_operator'; END IF;
    IF v_request.approved_by = v_request.requested_by THEN RETURN 'erase_same_operator'; END IF;
    IF p_actor IS DISTINCT FROM v_request.approved_by
       OR NOT tenant_erase_proof(v_request.requested_by, v_request.open_assertion, p_id, v_request.id, 'open')
       OR NOT tenant_erase_proof(v_request.approved_by, v_request.approve_assertion, p_id, v_request.id, 'approve') THEN
        RETURN 'erase_requires_second_operator';
    END IF;
    v_now := clock_timestamp();
    IF v_now < v_request.cooling_until THEN RETURN 'erase_cooling'; END IF;
    SELECT jsonb_build_object(
        'users', (SELECT count(*) FROM users WHERE org_id = p_id),
        'registry_customers', (SELECT count(*) FROM registry_customers WHERE org_id = p_id),
        'registry_sites', (SELECT count(*) FROM registry_sites WHERE org_id = p_id),
        'registry_equipment', (SELECT count(*) FROM registry_equipment WHERE org_id = p_id),
        'work_orders', (SELECT count(*) FROM work_orders WHERE org_id = p_id),
        'financial_rental_quotes', (SELECT count(*) FROM financial_rental_quotes WHERE org_id = p_id),
        'financial_purchase_requests', (SELECT count(*) FROM financial_purchase_requests WHERE org_id = p_id),
        'messenger_threads', (SELECT count(*) FROM messenger_threads WHERE org_id = p_id),
        'evidence_media', (SELECT count(*) FROM evidence_media WHERE org_id = p_id),
        'audit_events', (SELECT count(*) FROM audit_events WHERE org_id = p_id)
    ) INTO v_wiped;

    -- Capture all object-backed storage keys across tenant tables into the
    -- platform-owned outbox prior to row deletion.
    WITH candidates AS (
        SELECT 'PRIMARY'::text AS bucket_kind, NULL::text AS explicit_bucket, s3_key AS object_key
          FROM evidence_media WHERE org_id = p_id
        UNION ALL
        SELECT 'PRIMARY', NULL, staging_s3_key
          FROM evidence_media WHERE org_id = p_id AND staging_s3_key IS NOT NULL
        UNION ALL
        SELECT 'PRIMARY', NULL, thumbnail_s3_key
          FROM evidence_media WHERE org_id = p_id AND thumbnail_s3_key IS NOT NULL
        UNION ALL
        SELECT 'REPLICA', NULL, s3_key
          FROM evidence_media WHERE org_id = p_id
        UNION ALL
        SELECT 'PRIMARY', NULL, object_key
          FROM employee_photo_uploads WHERE org_id = p_id
        UNION ALL
        SELECT 'PRIMARY', NULL, storage_key
          FROM document_versions WHERE org_id = p_id
        UNION ALL
        SELECT 'PRIMARY', NULL, s3_key
          FROM email_attachments WHERE org_id = p_id
        UNION ALL
        SELECT 'PRIMARY', NULL, raw_object_key
          FROM mailbox_messages WHERE org_id = p_id
        UNION ALL
        SELECT 'EXPLICIT', s3_bucket, s3_key
          FROM financial_purchase_attachments WHERE org_id = p_id
        UNION ALL
        SELECT 'PRIMARY', NULL, s3_key
          FROM sales_listing_media WHERE org_id = p_id
        UNION ALL
        SELECT 'PRIMARY', NULL, storage_object_id
          FROM docs_evidence_copies WHERE org_id = p_id
        UNION ALL
        SELECT 'PRIMARY', NULL, token_storage_object_id
          FROM docs_evidence_tsa_proofs WHERE org_id = p_id AND token_storage_object_id IS NOT NULL
    )
    INSERT INTO tenant_erase_s3_outbox (
        org_id, target_org_id, request_id, bucket_kind, explicit_bucket, object_key
    )
    SELECT DISTINCT
        sentinel_org,
        p_id,
        v_request.id,
        c.bucket_kind,
        NULLIF(btrim(c.explicit_bucket), ''),
        btrim(c.object_key)
    FROM candidates AS c
    WHERE NULLIF(btrim(c.object_key), '') IS NOT NULL
      AND (c.bucket_kind <> 'EXPLICIT' OR NULLIF(btrim(c.explicit_bucket), '') IS NOT NULL)
    ON CONFLICT (target_org_id, bucket_kind, COALESCE(explicit_bucket, ''), object_key) DO NOTHING;
    GET DIAGNOSTICS v_s3_outbox_queued = ROW_COUNT;

    -- Atomically shred all tenant DEKs and ensure SHREDDED tombstones exist
    -- across all key scopes so restored ciphertext fails closed.
    PERFORM set_config('app.platform_force_remove_org', 'on', true);
    UPDATE tenant_encryption_keys
       SET state = 'SHREDDED',
           wrapped_dek = NULL,
           shredded_at = v_now,
           shredded_request_id = v_request.id
     WHERE org_id = p_id
       AND state <> 'SHREDDED';

    INSERT INTO tenant_encryption_keys (
        org_id, key_scope, key_version, state, alg_id, kek_id,
        wrapped_dek, key_fingerprint, created_at, shredded_at, shredded_request_id
    )
    SELECT p_id,
           s.scope,
           1,
           'SHREDDED',
           'shredded',
           'shredded',
           NULL,
           digest(convert_to('console.tenant_dek.tombstone.v1:' || p_id::text || ':' || s.scope || ':' || v_request.id::text, 'UTF8'), 'sha256'),
           v_now,
           v_now,
           v_request.id
      FROM (VALUES ('rrn'), ('mail')) AS s(scope)
     WHERE NOT EXISTS (
         SELECT 1 FROM tenant_encryption_keys k
          WHERE k.org_id = p_id AND k.key_scope = s.scope
     );

    SELECT count(*),
           COALESCE(
               digest(convert_to(
                   string_agg(key_scope || ':' || key_version::text || ':' || encode(key_fingerprint, 'hex'), ',' ORDER BY key_scope, key_version),
                   'UTF8'
               ), 'sha256'),
               decode(repeat('00', 32), 'hex')
           )
      INTO v_shredded_count, v_key_fingerprint
      FROM tenant_encryption_keys
     WHERE org_id = p_id
       AND state = 'SHREDDED';

    -- Clear EV child tables in topological child-before-parent order (including
    -- self-referencing ON DELETE RESTRICT chains) after S3 outbox capture and
    -- legal-hold clearance, before platform_force_remove_organization runs.
    DELETE FROM docs_equipment_handover_custody WHERE org_id = p_id;
    DELETE FROM docs_evidence_exports WHERE org_id = p_id;
    DELETE FROM docs_evidence_tsa_proofs WHERE org_id = p_id;
    LOOP
        DELETE FROM docs_evidence_copies c
         WHERE c.org_id = p_id
           AND NOT EXISTS (
               SELECT 1 FROM docs_evidence_copies child
                WHERE child.org_id = p_id AND child.parent_copy_id = c.id
           );
        EXIT WHEN NOT FOUND;
    END LOOP;
    LOOP
        DELETE FROM docs_evidence_custody_events e
         WHERE e.org_id = p_id
           AND NOT EXISTS (
               SELECT 1 FROM docs_evidence_custody_events child
                WHERE child.org_id = p_id AND child.previous_event_id = e.id
           );
        EXIT WHEN NOT FOUND;
    END LOOP;
    PERFORM set_config('app.platform_force_remove_org', 'off', true);

    v_outcome := platform_force_remove_organization(p_id);
    IF v_outcome <> 'removed' THEN
        RETURN v_outcome;
    END IF;

    -- platform_force_remove_organization resets row_security = on at exit.
    SET LOCAL row_security = off;

    INSERT INTO erasure_ledger (
        org_id, seq, subject_kind, subject_digest,
        erased_relation, erased_selector, erased_row_count,
        effective_at, actor, authority, prev_entry_hash, entry_hash
    ) VALUES (
        p_id,
        0,
        'tenant_dek',
        erasure_ledger_subject_digest(p_id, 'tenant_dek', v_request.id),
        'tenant_encryption_keys',
        format('request_id=%s key_fingerprint=%s', v_request.id, encode(v_key_fingerprint, 'hex')),
        v_shredded_count,
        v_now,
        p_actor::text,
        'platform.tenant.erase.two_operator',
        decode(repeat('00', 32), 'hex'),
        decode(repeat('00', 32), 'hex')
    )
    RETURNING seq, entry_hash INTO v_witness_seq, v_witness_hash;

    UPDATE tenant_erase_requests
       SET erased_at = v_now,
           erasure_witness_seq = v_witness_seq,
           erasure_witness_hash = v_witness_hash,
           shredded_key_fingerprint = v_key_fingerprint
     WHERE id = v_request.id;

    INSERT INTO audit_events (
        org_id, actor, action, target_type, target_id, branch_id,
        before_snap, after_snap, trace_id, span_id, occurred_at
    ) VALUES (
        NULL, p_actor, 'platform.tenant.force_remove', 'organizations', p_id::text, NULL,
        jsonb_build_object('org_id', p_id, 'slug', v_slug, 'name', v_name, 'wiped', v_wiped),
        jsonb_build_object(
            'witness_seq', v_witness_seq,
            'witness_entry_hash', encode(v_witness_hash, 'hex'),
            'shredded_key_fingerprint', encode(v_key_fingerprint, 'hex'),
            's3_outbox_queued', v_s3_outbox_queued
        ),
        p_trace_id, p_span_id, p_occurred_at
    );

    INSERT INTO audit_events (org_id, actor, action, target_type, target_id, after_snap, trace_id, span_id, occurred_at)
    VALUES (
        v_request.org_id,
        p_actor,
        'platform.tenant.erase.run',
        'tenant_erase_request',
        v_request.id::text,
        jsonb_build_object(
            'target_org_id', p_id,
            'witness_seq', v_witness_seq,
            'witness_entry_hash', encode(v_witness_hash, 'hex'),
            'shredded_key_fingerprint', encode(v_key_fingerprint, 'hex'),
            's3_outbox_queued', v_s3_outbox_queued
        ),
        p_trace_id,
        p_span_id,
        v_now
    );

    SET LOCAL row_security = on;
    RETURN 'removed';
END;
$$;
