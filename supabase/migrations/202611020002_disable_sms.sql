alter table public.notification_settings
  alter column sms_enabled set default false;

alter table public.tasks
  alter column sms_reminder set default false;

update public.notification_settings
set sms_enabled = false
where sms_enabled = true;

update public.tasks
set sms_reminder = false
where sms_reminder = true;
