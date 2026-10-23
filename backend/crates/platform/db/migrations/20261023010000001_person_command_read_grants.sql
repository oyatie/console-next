-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Isolated commands snapshot the actor through the same canonical read as HTTP.
-- These NOLOGIN roles already read users; the invoker view retains tenant RLS.
GRANT SELECT ON person_accounts_current TO console_leave_definer, console_ontology_writer;
GRANT SELECT ON person_revisions TO console_ontology_writer;
