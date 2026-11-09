-- Sutura: bootstrap default organization + record placeholder owner.
-- The actual owner user (with password_hash) is created by the backend
-- migration runner when BOOTSTRAP_OWNER_EMAIL + BOOTSTRAP_OWNER_PASSWORD
-- are set. This file only seeds the default organization row so the
-- multi-tenant invariant (everything FKs to an org) holds for fresh DBs.

INSERT INTO organizations (id, name, plan)
VALUES ('00000000-0000-0000-0000-000000000001', 'Default Organization', 'pilot')
ON CONFLICT (id) DO NOTHING;
