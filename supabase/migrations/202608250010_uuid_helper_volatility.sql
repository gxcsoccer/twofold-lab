-- PostgreSQL classifies convert_to(text, name) as STABLE because its result
-- depends on database encoding.  Match that catalog contract instead of
-- overstating the volatility of the internal deterministic UUID helper.

begin;

alter function public.deterministic_uuid_from_sha256(text, text) stable;

comment on function public.deterministic_uuid_from_sha256(text, text) is
  'Internal stable SHA-256-to-UUIDv8 derivation. Revoked from client and service roles; used only by trusted settlement functions.';

commit;
