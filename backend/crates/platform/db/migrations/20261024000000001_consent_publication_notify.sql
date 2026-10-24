-- SPDX-License-Identifier: LicenseRef-Proprietary
SET LOCAL lock_timeout = '2s';

-- The listener re-reads committed documents; NOTIFY carries no legal text or account data.
CREATE FUNCTION notify_consent_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('privacy_consent_changed', '');
    RETURN NULL;
END;
$$;
CREATE TRIGGER trg_consent_publication AFTER INSERT ON terms_documents
    FOR EACH STATEMENT EXECUTE FUNCTION notify_consent_publication();

-- Expose only the next wake time; runtime RLS continues to hide unpublished document text.
CREATE FUNCTION next_consent_publication() RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT min(published_at) FROM public.terms_documents WHERE published_at > now();
$$;
REVOKE ALL ON FUNCTION next_consent_publication() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION next_consent_publication() TO console_rt;
