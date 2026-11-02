create table if not exists public.notification_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email_to text not null,
  phone_to text,
  email_enabled boolean not null default true,
  sms_enabled boolean not null default false,
  timezone_name text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 100),
  category text not null default 'personal' check (category in ('work', 'personal', 'home')),
  task_date date not null,
  local_time time without time zone,
  scheduled_at timestamptz,
  timezone_name text not null default 'UTC',
  completed boolean not null default false,
  email_reminder boolean not null default true,
  sms_reminder boolean not null default false,
  reminder_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tasks_time_schedule_consistent check (
    (local_time is null and scheduled_at is null)
    or (local_time is not null and scheduled_at is not null)
  )
);

create index if not exists tasks_user_date_idx
  on public.tasks (user_id, task_date, local_time);

create index if not exists tasks_due_reminders_idx
  on public.tasks (reminder_at)
  where completed = false and scheduled_at is not null;

create table if not exists public.reminder_deliveries (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  channel text not null check (channel in ('email', 'sms')),
  reminder_for timestamptz not null,
  status text not null check (status in ('processing', 'sent', 'failed', 'skipped')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 3),
  claimed_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  error_message text check (error_message is null or char_length(error_message) <= 500),
  created_at timestamptz not null default now(),
  unique (task_id, channel, reminder_for)
);

create index if not exists reminder_deliveries_task_idx
  on public.reminder_deliveries (task_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.now();
  return new;
end;
$$;

create or replace function public.claim_reminder_delivery(
  p_task_id uuid,
  p_channel text,
  p_reminder_for timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_id uuid;
begin
  insert into public.reminder_deliveries (
    task_id, channel, reminder_for, status, attempt_count, claimed_at
  ) values (
    p_task_id, p_channel, p_reminder_for, 'processing', 1, pg_catalog.now()
  )
  on conflict (task_id, channel, reminder_for) do update
    set status = 'processing',
        attempt_count = public.reminder_deliveries.attempt_count + 1,
        claimed_at = pg_catalog.now(),
        error_message = null
    where (
      public.reminder_deliveries.status = 'failed'
      and public.reminder_deliveries.attempt_count < 3
      and public.reminder_deliveries.claimed_at < pg_catalog.now() - interval '30 seconds'
    ) or (
      public.reminder_deliveries.status = 'processing'
      and public.reminder_deliveries.attempt_count < 3
      and public.reminder_deliveries.claimed_at < pg_catalog.now() - interval '5 minutes'
    )
  returning id into claimed_id;

  return claimed_id is not null;
end;
$$;

create or replace function public.touch_task_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.now();
  new.reminder_at = case
    when new.scheduled_at is null then null
    else new.scheduled_at - interval '1 minute'
  end;
  return new;
end;
$$;

drop trigger if exists notification_settings_set_updated_at on public.notification_settings;
create trigger notification_settings_set_updated_at
  before update on public.notification_settings
  for each row execute function public.set_updated_at();

drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at
  before insert or update on public.tasks
  for each row execute function public.touch_task_updated_at();

alter table public.notification_settings enable row level security;
alter table public.tasks enable row level security;
alter table public.reminder_deliveries enable row level security;

drop policy if exists "Users manage their notification settings" on public.notification_settings;
create policy "Users manage their notification settings"
  on public.notification_settings
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "Users manage their own tasks" on public.tasks;
create policy "Users manage their own tasks"
  on public.tasks
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "Users read their own reminder deliveries" on public.reminder_deliveries;
create policy "Users read their own reminder deliveries"
  on public.reminder_deliveries
  for select to authenticated
  using (
    exists (
      select 1
      from public.tasks
      where tasks.id = reminder_deliveries.task_id
        and tasks.user_id = (select auth.uid())
    )
  );

revoke all on table public.notification_settings, public.tasks, public.reminder_deliveries from public, anon, authenticated;
grant select, insert, update on table public.notification_settings to authenticated;
grant select, insert, update, delete on table public.tasks to authenticated;
grant select on table public.reminder_deliveries to authenticated;
grant all on table public.notification_settings, public.tasks, public.reminder_deliveries to service_role;

revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.touch_task_updated_at() from public, anon, authenticated;
revoke all on function public.claim_reminder_delivery(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_reminder_delivery(uuid, text, timestamptz) to service_role;
