-- Generated cleanroom architecture has its own source kind; it is never passed
-- off as Form hardware or STEP CAD. Geometry still uses immutable Storage files.
alter table public.assets drop constraint assets_source_kind_check;
alter table public.assets add constraint assets_source_kind_check
  check (source_kind in ('form', 'step', 'generated'));
alter table public.assets add constraint assets_generated_provenance_check
  check (source_kind <> 'generated' or coalesce(
    metadata->'source'->>'kind' = 'generated' and
    metadata->'source'->>'generator' = 'form-industries', false));
