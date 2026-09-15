-- Carry the user's approved RA-5 catalog into production. The earlier migration
-- created only the table; the approved rows were configured in development.
-- Source: docs/ra5-approved-categories.json (approved 2026-09-08), restored under
-- the user's 2026-09-15 request to fix the empty production category selector.
-- This is deployment configuration, not a receipt approval. Do not attribute it
-- to an invented administrator or change existing category choices/settings.
insert into public.receipt_categories (id, label, active, keywords)
values
  ('dump', 'Dump', true, '["disposal", "debris"]'::jsonb),
  ('fuel', 'Fuel', true, '["diesel", "gasoline"]'::jsonb),
  ('materials', 'Materials', true,
   '["limestone", "topsoil", "sand", "pipe", "elbow", "cement", "screws", "concrete", "cedar", "tube", "brush"]'::jsonb),
  ('misc', 'Misc', true, '[]'::jsonb)
on conflict (id) do nothing;
