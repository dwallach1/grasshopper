-- Constrain thesis lifecycle to the statuses the desk and workers already use.
-- Existing production rows are forming or hardening only.

alter table public.theses
  drop constraint if exists theses_status_check;

alter table public.theses
  add constraint theses_status_check
  check (status in ('forming', 'hardening', 'rejected', 'killed'));
