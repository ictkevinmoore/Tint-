-- =====================================================================
-- Fleet Pipeline - Supabase schema
-- Run this once in your Supabase project: SQL Editor -> paste -> Run.
-- Then run crm-policies.sql for the browser CRM.
--
-- Updated Sep 15, 2026 to match what's live in the "Tint" project:
--   * explicit service_role grants (new Supabase projects no longer
--     auto-grant table access to the API roles)
--   * cadence texts use plain hyphens (an em dash forces UCS-2 SMS encoding)
--   * locks down the rls_auto_enable() helper when the project has one
-- =====================================================================

-- ---------- leads ----------
create table if not exists leads (
  id             uuid primary key default gen_random_uuid(),
  company        text not null,
  contact        text,
  phone          text,          -- STORE IN E.164, e.g. +13165550142
  email          text,
  account_type   text,
  service        text,
  fleet_size     int default 0,
  vehicles       int default 0,
  stage          text default 'new'
                 check (stage in ('new','contacted','bid','negotiating','won','lost')),
  bid_amount     numeric default 0,
  notes          text,
  cadence_step   int default 0,
  next_follow_up date,
  consent_status text default 'pending'
                 check (consent_status in ('pending','opted_in','opted_out')),
  auto_paused    boolean default false,   -- flips true the moment a human replies
  last_outbound_at timestamptz,
  last_inbound_at  timestamptz,
  created_at     timestamptz default now()
);

create index if not exists idx_leads_due     on leads (next_follow_up);
create index if not exists idx_leads_phone    on leads (phone);
create index if not exists idx_leads_consent  on leads (consent_status);

-- ---------- templates (also holds the cadence timing) ----------
create table if not exists templates (
  key          text primary key,
  step_order   int not null,          -- 0,1,2,... matches leads.cadence_step
  label        text,
  body         text not null,         -- supports {{contact}} {{company}} {{vehicles}} {{bid}} {{me}} {{shop}}
  cadence_days int not null default 4 -- days until the NEXT touch after this one sends
);

-- ---------- message_log (audit trail + TCPA proof) ----------
create table if not exists message_log (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid references leads(id) on delete set null,
  direction  text check (direction in ('out','in')),
  body       text,
  twilio_sid text,
  status     text,
  created_at timestamptz default now()
);
create index if not exists idx_log_lead on message_log (lead_id, created_at);

-- ---------- settings (single row) ----------
create table if not exists settings (
  id         int primary key default 1,
  me         text,
  shop       text,
  quiet_start int default 8,
  quiet_end   int default 21,
  timezone   text default 'America/Chicago',
  check (id = 1)
);
insert into settings (id, me, shop) values (1, '', '')
  on conflict (id) do nothing;

-- ---------- seed the cadence messages ----------
-- Keep these plain: no em dashes, curly quotes, or emoji (each forces UCS-2).
insert into templates (key, step_order, label, body, cadence_days) values
 ('intro', 0, 'Intro',
  'Hi {{contact}}, this is {{me}} with {{shop}} here in Wichita - thanks for the interest in tinting for {{company}}. I can put a quote together for your {{vehicles}}. When''s a good time for a quick look at the fleet?', 3),
 ('followup1', 1, 'Bid follow-up 1',
  'Hi {{contact}}, following up on the tint quote for {{company}} ({{bid}}). Happy to walk through options or adjust anything - want me to get you on the schedule?', 4),
 ('followup2', 2, 'Bid follow-up 2',
  'Hi {{contact}}, checking in on the {{company}} bid. We''ve got install slots opening next week if you''d like to lock one in.', 7),
 ('checkin', 3, 'Check-in',
  'Hi {{contact}}, just keeping in touch. Whenever {{company}} is ready to move on the fleet tint, I''ll make it easy. Anything I can answer in the meantime?', 16),
 ('reengage', 4, 'Re-engage',
  'Hi {{contact}}, it''s been a little while - still glad to help {{company}} with tint or paint protection whenever the timing''s right. Worth a quick call?', 30)
on conflict (key) do nothing;

-- ---------- Row Level Security ----------
-- RLS ON with no policies = only the SERVICE ROLE key can read/write.
-- The Netlify functions use that key, so they work. Browser access stays
-- locked until crm-policies.sql opens it to signed-in users.
alter table leads       enable row level security;
alter table templates   enable row level security;
alter table message_log enable row level security;
alter table settings    enable row level security;

-- ---------- API grants ----------
-- New Supabase projects don't auto-grant table privileges to the Data API
-- roles. service_role (the functions' secret key) bypasses RLS but still
-- needs these. anon and authenticated get nothing here.
grant select, insert, update, delete
  on table public.leads, public.templates, public.message_log, public.settings
  to service_role;

-- ---------- Hardening ----------
-- Supabase's optional auto-enable-RLS setup adds an rls_auto_enable() helper
-- behind the ensure_rls event trigger. It only needs to run as a trigger,
-- so block API calls to it. Skipped if the project doesn't have it.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end
$$;
