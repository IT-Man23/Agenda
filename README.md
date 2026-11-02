# Agenda Steve

Agenda Steve is a static GitHub Pages app backed by Supabase for private task sync and scheduled reminders. The app keeps its current local-storage data until a successful one-time import into the signed-in Supabase account.

## Local mode

Open `index.html` in a browser. Until Supabase is configured, tasks continue to work in that browser only; email and SMS reminders are disabled.

## Supabase setup

1. Create a Supabase project in a region near Belgium. The Free plan can pause projects after inactivity, so it is not an uptime guarantee for reminders.
2. In Authentication settings, disable public sign-ups and add the owner account from the dashboard. Set the site URL to `https://it-man23.github.io/Agenda/` and allow that URL as a redirect URL. Configure custom SMTP if the default Supabase email service cannot deliver sign-in links to the account.
3. Run `supabase/migrations/202611020001_agenda.sql` in the Supabase SQL Editor.
4. Copy the project URL and publishable key into `supabase-config.js`. The publishable key is intended for the browser; it is not a service-role secret. RLS policies protect all user data.
5. Install the Supabase CLI, run `supabase login`, then link and deploy the function:

   ```powershell
   supabase link --project-ref YOUR_PROJECT_REF
   supabase functions deploy send-task-reminders
   ```

6. In the Supabase Edge Function secrets, configure these provider values:
   - `BREVO_API_KEY`
   - `BREVO_SENDER_EMAIL` (must be verified in Brevo)
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_FROM_NUMBER`

   Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the Edge Function. Never put service-role keys, Brevo keys, or Twilio credentials in this repository or in `supabase-config.js`.
7. In Supabase Vault, create two secrets named `agenda_project_url` and `agenda_service_role_key`. Use the project URL and service-role key from the Supabase dashboard. The service-role key must remain in Vault; do not paste it into this repository.
8. Enable the `pg_cron` and `pg_net` extensions in Supabase, then run this once in the SQL Editor to invoke the function every minute:

   ```sql
   select cron.schedule(
     'agenda-reminders-every-minute',
     '* * * * *',
     $job$
       select net.http_post(
         url := (select decrypted_secret from vault.decrypted_secrets where name = 'agenda_project_url') || '/functions/v1/send-task-reminders',
         headers := jsonb_build_object(
           'Content-Type', 'application/json',
           'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'agenda_service_role_key')
         ),
         body := '{}'::jsonb
       );
     $job$
   );
   ```

9. Push `supabase-config.js` and the app changes to `main`. Open GitHub Pages, sign in with the account created above, and save the email and phone under **Notifications**. Phone numbers are stored in the account's private Supabase settings in international format.

## Reminder behavior

Tasks with an hour have email reminders enabled by default. SMS reminders are disabled by default until the recipient number and Twilio sender have been verified. Each enabled reminder is scheduled for one minute before the task. Supabase Cron runs once per minute, so delivery is approximate, not guaranteed to the second. The function retries reported provider failures up to three attempts and records delivery status to prevent concurrent sends. If a provider accepts a message immediately before the function crashes, a later recovery attempt can still produce a duplicate; exactly-once delivery cannot be guaranteed across independent providers. Tasks already due when created do not receive a reminder.

SMS delivery is billed separately by Twilio; trial accounts may only send to verified recipient numbers. Verify sender and recipient eligibility before relying on alerts. Supabase Free projects may pause after inactivity, which can interrupt scheduled reminders.

## Security and privacy

- Supabase Auth sign-up is disabled; only users manually added in the Supabase dashboard can request a sign-in link.
- RLS restricts tasks and notification settings to their owner. The reminder function uses a server-side service key and is invoked by Supabase Cron.
- The email address and phone number are entered in the authenticated app and are never hard-coded in source.
- Do not commit `.env` files, service-role keys, or provider credentials. `.gitignore` excludes local environment files.
