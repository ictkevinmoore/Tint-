-- =====================================================================
-- Fleet Pipeline - CRM access policies
-- Run AFTER schema.sql.
--
-- schema.sql turned RLS on with no policies, so only the service_role key
-- (your Netlify functions) can touch the data. These policies additionally
-- let any LOGGED-IN user read/write from the browser CRM using the public
-- publishable (anon) key. Because access requires an authenticated session,
-- that key is safe to embed in the CRM HTML - as long as new-user sign-ups
-- are turned off in Supabase Auth.
--
-- This is a single-operator setup, so every authenticated user gets full
-- access. If you ever add staff with separate scopes, replace `using (true)`
-- with an owner check.
--
-- Updated Sep 15, 2026: added the table grants signed-in users now need.
-- =====================================================================

-- Table privileges for signed-in users. New Supabase projects don't grant
-- these automatically, and policies alone don't confer access. Scoped to
-- exactly the operations the policies below allow; anon gets nothing.
grant select, insert, update, delete on table public.leads       to authenticated;
grant select, update                 on table public.templates   to authenticated;
grant select, insert                 on table public.message_log to authenticated;
grant select, insert, update         on table public.settings    to authenticated;

create policy "crm read leads"   on public.leads       for select to authenticated using (true);
create policy "crm write leads"  on public.leads       for insert to authenticated with check (true);
create policy "crm update leads" on public.leads       for update to authenticated using (true) with check (true);
create policy "crm delete leads" on public.leads       for delete to authenticated using (true);

create policy "crm read tpl"     on public.templates   for select to authenticated using (true);
create policy "crm update tpl"   on public.templates   for update to authenticated using (true) with check (true);

create policy "crm read log"     on public.message_log for select to authenticated using (true);
create policy "crm write log"    on public.message_log for insert to authenticated with check (true);

create policy "crm read settings"   on public.settings for select to authenticated using (true);
create policy "crm update settings" on public.settings for update to authenticated using (true) with check (true);
create policy "crm insert settings" on public.settings for insert to authenticated with check (true);
