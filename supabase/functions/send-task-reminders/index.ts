import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type Task = {
  id: string;
  user_id: string;
  title: string;
  scheduled_at: string;
  reminder_at: string;
  email_reminder: boolean;
  sms_reminder: boolean;
};

type NotificationSettings = {
  user_id: string;
  email_to: string;
  phone_to: string | null;
  email_enabled: boolean;
  sms_enabled: boolean;
};

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const supabase = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
  : null;

function escapeHtml(value: string) {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (character) => entities[character] || character);
}

async function sendEmail(to: string, title: string) {
  const apiKey = Deno.env.get("BREVO_API_KEY");
  const senderEmail = Deno.env.get("BREVO_SENDER_EMAIL");
  if (!apiKey || !senderEmail) throw new Error("Brevo is not configured.");

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      sender: { name: "Agenda Steve", email: senderEmail },
      to: [{ email: to }],
      subject: `Rappel : ${title}`,
      textContent: `Votre tâche « ${title} » commence dans une minute.`,
      htmlContent: `<p>Votre tâche <strong>« ${escapeHtml(title)} »</strong> commence dans une minute.</p>`,
    }),
  });

  if (!response.ok) throw new Error(`Brevo returned HTTP ${response.status}.`);
  const result = await response.json();
  return typeof result.messageId === "string" ? result.messageId : null;
}

async function sendSms(to: string, title: string) {
  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM_NUMBER");
  if (!accountSid || !authToken || !from) throw new Error("Twilio is not configured.");

  const body = new URLSearchParams({
    To: to,
    From: from,
    Body: `Agenda Steve : « ${title} » commence dans une minute.`,
  });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) throw new Error(`Twilio returned HTTP ${response.status}.`);
  const result = await response.json();
  return typeof result.sid === "string" ? result.sid : null;
}

async function deliver(
  task: Task,
  channel: "email" | "sms",
  reminderFor: string,
  recipient: string,
) {
  if (!supabase) throw new Error("Supabase service credentials are missing.");

  const { data: claimed, error: claimError } = await supabase.rpc("claim_reminder_delivery", {
    p_task_id: task.id,
    p_channel: channel,
    p_reminder_for: reminderFor,
  });
  if (claimError) throw new Error("Could not claim reminder delivery.");
  if (!claimed) return "already-claimed" as const;

  try {
    const providerMessageId = channel === "email"
      ? await sendEmail(recipient, task.title)
      : await sendSms(recipient, task.title);
    const { error } = await supabase
      .from("reminder_deliveries")
      .update({ status: "sent", sent_at: new Date().toISOString(), provider_message_id: providerMessageId })
      .eq("task_id", task.id)
      .eq("channel", channel)
      .eq("reminder_for", reminderFor);
    if (error) throw new Error("Could not record reminder delivery.");
    return "sent" as const;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Unknown provider error.";
    await supabase
      .from("reminder_deliveries")
      .update({ status: "failed", error_message: message })
      .eq("task_id", task.id)
      .eq("channel", channel)
      .eq("reminder_for", reminderFor);
    return "failed" as const;
  }
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!supabase) return Response.json({ error: "Reminder service is not configured." }, { status: 500 });

  const now = new Date();
  const nowIso = now.toISOString();
  const lookbackIso = new Date(now.getTime() - 5 * 60_000).toISOString();
  const { data: tasks, error: taskError } = await supabase
    .from("tasks")
    .select("id,user_id,title,scheduled_at,reminder_at,email_reminder,sms_reminder")
    .eq("completed", false)
    .not("scheduled_at", "is", null)
    .gte("reminder_at", lookbackIso)
    .lte("reminder_at", nowIso)
    .gt("scheduled_at", nowIso)
    .order("reminder_at", { ascending: true })
    .limit(200);

  if (taskError) return Response.json({ error: "Could not load due reminders." }, { status: 500 });
  const dueTasks = (tasks || []) as Task[];
  if (dueTasks.length === 0) return Response.json({ sent: 0, failed: 0, skipped: 0 });

  const userIds = [...new Set(dueTasks.map((task) => task.user_id))];
  const { data: settings, error: settingsError } = await supabase
    .from("notification_settings")
    .select("user_id,email_to,phone_to,email_enabled,sms_enabled")
    .in("user_id", userIds);
  if (settingsError) return Response.json({ error: "Could not load notification settings." }, { status: 500 });
  const settingsByUser = new Map((settings as NotificationSettings[] || []).map((item) => [item.user_id, item]));

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const task of dueTasks) {
    const preference = settingsByUser.get(task.user_id);
    if (!preference) {
      skipped += 1;
      continue;
    }

    const channels: Array<{ channel: "email" | "sms"; enabled: boolean; recipient: string | null }> = [
      { channel: "email", enabled: task.email_reminder && preference.email_enabled, recipient: preference.email_to },
      { channel: "sms", enabled: task.sms_reminder && preference.sms_enabled, recipient: preference.phone_to },
    ];
    for (const item of channels) {
      if (!item.enabled) continue;
      if (!item.recipient) {
        skipped += 1;
        continue;
      }
      const result = await deliver(task, item.channel, task.reminder_at, item.recipient);
      if (result === "sent") sent += 1;
      if (result === "failed") failed += 1;
      if (result === "already-claimed") skipped += 1;
    }
  }

  return Response.json({ sent, failed, skipped });
});
