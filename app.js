(() => {
  const storageKey = "le-fil-daily-tasks-v1";
  const categories = { work: "Travail", personal: "Personnel", home: "Maison" };
  const timezoneName = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const today = new Date();
  let viewedDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let activeFilter = "all";
  let tasksByDate = readLocalTasks();
  let client = null;
  let user = null;
  let settings = null;
  let sessionInitialized = false;
  let dayLoadId = 0;

  const byId = (id) => document.getElementById(id);
  const dateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const currentTasks = () => tasksByDate[dateKey(viewedDate)] || [];
  const dateFormat = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" });
  const weekdayFormat = new Intl.DateTimeFormat("fr-FR", { weekday: "long", year: "numeric" });
  const longDateFormat = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  const config = window.AGENDA_SUPABASE_CONFIG || {};
  const hasConfig = Boolean(config.url && config.publishableKey && window.supabase?.createClient);
  if (hasConfig) client = window.supabase.createClient(config.url, config.publishableKey);

  function readLocalTasks() {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeLocalTasks() {
    localStorage.setItem(storageKey, JSON.stringify(tasksByDate));
  }

  function showNotice(message, kind = "info") {
    const notice = byId("appNotice");
    notice.textContent = message;
    notice.dataset.kind = kind;
    notice.hidden = !message;
  }

  function localSchedule(date, time) {
    if (!time) return null;
    const value = new Date(`${date}T${time}:00`);
    if (Number.isNaN(value.getTime())) throw new Error("L’heure de cette tâche est invalide.");
    return value.toISOString();
  }

  function legacyRows() {
    const rows = [];
    for (const [taskDate, tasks] of Object.entries(tasksByDate)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(taskDate) || !Array.isArray(tasks)) continue;
      for (const task of tasks) {
        if (!task || typeof task.title !== "string" || !task.title.trim()) continue;
        const time = typeof task.time === "string" && /^\d{2}:\d{2}/.test(task.time) ? task.time.slice(0, 5) : null;
        let id = task.id;
        if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
          id = crypto.randomUUID();
        }
        rows.push({
          id,
          user_id: user.id,
          title: task.title.trim().slice(0, 100),
          category: categories[task.category] ? task.category : "personal",
          task_date: taskDate,
          local_time: time,
          scheduled_at: time ? localSchedule(taskDate, time) : null,
          timezone_name: timezoneName,
          completed: Boolean(task.done),
          email_reminder: task.emailReminder !== false,
          sms_reminder: task.smsReminder === true,
        });
      }
    }
    return rows;
  }

  async function importLegacyTasks() {
    const marker = `agenda-supabase-imported:${user.id}`;
    if (localStorage.getItem(marker)) return;
    const rows = legacyRows();
    if (rows.length) {
      const { error } = await client.from("tasks").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
      if (error) throw new Error("Import des tâches locales impossible. La copie locale est conservée.");
    }
    localStorage.setItem(marker, new Date().toISOString());
  }

  async function loadSettings() {
    const { data, error } = await client
      .from("notification_settings")
      .select("user_id,email_to,phone_to,email_enabled,sms_enabled,timezone_name")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) throw new Error("Lecture des préférences de notification impossible.");
    if (data) {
      settings = data;
      return;
    }
    if (!user.email) throw new Error("Le compte connecté ne fournit pas d’adresse e-mail.");
    const initial = {
      user_id: user.id,
      email_to: user.email,
      phone_to: null,
      email_enabled: true,
      sms_enabled: false,
      timezone_name: timezoneName,
    };
    const { data: created, error: insertError } = await client
      .from("notification_settings")
      .insert(initial)
      .select("user_id,email_to,phone_to,email_enabled,sms_enabled,timezone_name")
      .single();
    if (insertError) throw new Error("Création des préférences de notification impossible.");
    settings = created;
  }

  function rowToTask(row) {
    return {
      id: row.id,
      title: row.title,
      category: row.category,
      time: row.local_time ? row.local_time.slice(0, 5) : "",
      done: row.completed,
      emailReminder: row.email_reminder,
      smsReminder: row.sms_reminder,
    };
  }

  async function loadDay() {
    const requestId = ++dayLoadId;
    if (!client || !user) {
      render();
      return;
    }
    byId("syncStatus").textContent = "Synchronisation…";
    const { data, error } = await client
      .from("tasks")
      .select("id,title,category,local_time,completed,email_reminder,sms_reminder")
      .eq("user_id", user.id)
      .eq("task_date", dateKey(viewedDate))
      .order("local_time", { ascending: true, nullsFirst: false });
    if (requestId !== dayLoadId) return;
    if (error) {
      byId("syncStatus").textContent = "Erreur de synchronisation";
      showNotice("Impossible de charger les tâches depuis Supabase. Vérifie la configuration du projet.", "error");
      return;
    }
    tasksByDate[dateKey(viewedDate)] = (data || []).map(rowToTask);
    byId("syncStatus").textContent = "Synchronisé";
    showNotice("");
    render();
  }

  function render() {
    const tasks = currentTasks();
    const doneCount = tasks.filter((task) => task.done).length;
    const percent = tasks.length ? Math.round((doneCount / tasks.length) * 100) : 0;
    byId("topDate").textContent = longDateFormat.format(today);
    byId("selectedDate").textContent = dateFormat.format(viewedDate);
    byId("selectedWeekday").textContent = weekdayFormat.format(viewedDate);
    byId("progressPercent").textContent = `${percent}%`;
    byId("progressCount").textContent = `${doneCount} tâche${doneCount > 1 ? "s" : ""} terminée${doneCount > 1 ? "s" : ""}`;
    byId("progressFill").style.width = `${percent}%`;
    byId("progressFill").parentElement.setAttribute("aria-valuenow", String(percent));
    byId("progressNote").textContent = percent === 100 ? "Bravo, tu as tout accompli !" : percent > 0 ? "Tu avances bien, continue à ton rythme." : "Chaque petit pas compte.";
    byId("taskCount").textContent = `${tasks.length} tâche${tasks.length > 1 ? "s" : ""}`;
    const visibleTasks = tasks.filter((task) => activeFilter === "all" || (activeFilter === "done" ? task.done : !task.done));
    const list = byId("taskList");
    list.replaceChildren();
    byId("emptyState").hidden = visibleTasks.length > 0;
    if (visibleTasks.length === 0) {
      const noTasks = tasks.length === 0;
      byId("emptyTitle").textContent = noTasks ? "Une journée toute neuve" : activeFilter === "active" ? "Tout est fait" : "Rien ici pour le moment";
      byId("emptyMessage").textContent = noTasks ? "Ajoute une tâche pour commencer." : activeFilter === "active" ? "Profite de ce moment, tu l’as bien mérité." : "Les tâches terminées apparaîtront ici.";
    }
    visibleTasks.slice().sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99")).forEach((task, index) => {
      const row = document.createElement("li");
      row.className = `task-row${task.done ? " done" : ""}`;
      row.style.animationDelay = `${Math.min(index * 35, 175)}ms`;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "task-check";
      checkbox.checked = task.done;
      checkbox.setAttribute("aria-label", `Marquer « ${task.title} » comme ${task.done ? "à faire" : "terminée"}`);
      checkbox.addEventListener("change", () => {
        const completed = checkbox.checked;
        checkbox.checked = task.done;
        void updateTask(task.id, { done: completed });
      });
      const details = document.createElement("div");
      const name = document.createElement("span");
      name.className = "task-name";
      name.textContent = task.title;
      const meta = document.createElement("div");
      meta.className = "task-meta";
      const category = document.createElement("span");
      category.className = `category ${task.category}`;
      category.textContent = categories[task.category] || "Personnel";
      meta.append(category);
      if (task.time && client && user) {
        const reminder = document.createElement("span");
        reminder.className = "reminder-hint";
        reminder.textContent = [task.emailReminder !== false && settings?.email_enabled && settings?.email_to ? "e-mail" : "", task.smsReminder !== false && settings?.sms_enabled && settings?.phone_to ? "SMS" : ""].filter(Boolean).join(" + ");
        if (reminder.textContent) {
          reminder.textContent += " · 1 min avant";
          meta.append(reminder);
        }
      }
      details.append(name, meta);
      const time = document.createElement("time");
      time.className = "task-time";
      if (task.time) { time.textContent = task.time; time.setAttribute("datetime", task.time); }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "delete-button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Supprimer « ${task.title} »`);
      remove.title = "Supprimer";
      remove.addEventListener("click", () => { void deleteTask(task.id); });
      row.append(checkbox, details, time, remove);
      list.append(row);
    });
    document.querySelectorAll(".filter-button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.filter === activeFilter)));
  }

  async function updateTask(id, changes) {
    if (client && user) {
      const update = {};
      if ("done" in changes) update.completed = changes.done;
      if ("emailReminder" in changes) update.email_reminder = changes.emailReminder;
      if ("smsReminder" in changes) update.sms_reminder = changes.smsReminder;
      const { error } = await client.from("tasks").update(update).eq("id", id).eq("user_id", user.id);
      if (error) {
        showNotice("La tâche n’a pas pu être mise à jour.", "error");
        render();
        return;
      }
    }
    tasksByDate[dateKey(viewedDate)] = currentTasks().map((task) => task.id === id ? { ...task, ...changes } : task);
    if (!client) writeLocalTasks();
    render();
  }

  async function deleteTask(id) {
    if (client && user) {
      const { error } = await client.from("tasks").delete().eq("id", id).eq("user_id", user.id);
      if (error) {
        showNotice("La tâche n’a pas pu être supprimée.", "error");
        return;
      }
    }
    tasksByDate[dateKey(viewedDate)] = currentTasks().filter((task) => task.id !== id);
    if (!client) writeLocalTasks();
    render();
  }

  function shiftDate(amount) {
    viewedDate.setDate(viewedDate.getDate() + amount);
    void loadDay();
  }

  const taskBackdrop = byId("modalBackdrop");
  const authBackdrop = byId("authBackdrop");
  const settingsBackdrop = byId("settingsBackdrop");

  function openTaskDialog() {
    taskBackdrop.hidden = false;
    byId("taskTitle").focus();
  }

  function closeTaskDialog() {
    taskBackdrop.hidden = true;
    byId("taskForm").reset();
    byId("emailReminder").checked = true;
    byId("smsReminder").checked = false;
    byId("openDialog").focus();
  }

  function openSettings() {
    if (!settings) return;
    byId("settingsEmail").value = settings.email_to || user.email || "";
    byId("settingsPhone").value = settings.phone_to || "";
    byId("emailEnabled").checked = settings.email_enabled;
    byId("smsEnabled").checked = settings.sms_enabled;
    byId("timezoneValue").textContent = settings.timezone_name || timezoneName;
    settingsBackdrop.hidden = false;
    byId("settingsEmail").focus();
  }

  function closeBackdrop(backdrop, focusId) {
    backdrop.hidden = true;
    if (focusId) byId(focusId).focus();
  }

  async function saveSettings(event) {
    event.preventDefault();
    if (!client || !user) return;
    const email = byId("settingsEmail").value.trim();
    const phoneInput = byId("settingsPhone").value.trim();
    const phone = phoneInput.startsWith("00") ? `+${phoneInput.slice(2)}` : phoneInput;
    if (phone && !/^\+[1-9]\d{7,14}$/.test(phone)) {
      showNotice("Saisis le téléphone au format international, par exemple +32…", "error");
      return;
    }
    if (byId("smsEnabled").checked && !phone) {
      showNotice("Ajoute un numéro international ou désactive les rappels SMS.", "error");
      return;
    }
    const next = {
      user_id: user.id,
      email_to: email,
      phone_to: phone || null,
      email_enabled: byId("emailEnabled").checked,
      sms_enabled: byId("smsEnabled").checked,
      timezone_name: timezoneName,
    };
    const { data, error } = await client
      .from("notification_settings")
      .upsert(next, { onConflict: "user_id" })
      .select("user_id,email_to,phone_to,email_enabled,sms_enabled,timezone_name")
      .single();
    if (error) {
      showNotice("Les préférences n’ont pas pu être enregistrées.", "error");
      return;
    }
    settings = data;
    showNotice("Préférences enregistrées.", "success");
    closeBackdrop(settingsBackdrop, "accountButton");
    render();
  }

  async function handleSession(nextUser) {
    if (nextUser?.id === user?.id && sessionInitialized) return;
    user = nextUser;
    sessionInitialized = Boolean(nextUser);
    if (!user) {
      settings = null;
      byId("accountButton").textContent = "Connexion";
      byId("signOutButton").hidden = true;
      if (client) {
        tasksByDate = readLocalTasks();
        render();
        byId("syncStatus").textContent = "Connexion requise";
        authBackdrop.hidden = false;
      }
      return;
    }

    authBackdrop.hidden = true;
    byId("accountButton").textContent = "Notifications";
    byId("signOutButton").hidden = false;
    byId("syncStatus").textContent = "Initialisation…";
    try {
      await importLegacyTasks();
      await loadSettings();
      await loadDay();
      if (settings.sms_enabled && !settings.phone_to) {
        showNotice("Ajoute ton numéro dans Notifications pour activer les rappels SMS.");
      }
    } catch (error) {
      byId("syncStatus").textContent = "Configuration incomplète";
      showNotice(error instanceof Error ? error.message : "Initialisation Supabase impossible.", "error");
    }
  }

  if (!client) {
    byId("syncStatus").textContent = "Mode local · rappels désactivés";
    byId("accountButton").textContent = "Cloud non configuré";
    showNotice("Les tâches restent dans ce navigateur. Configure Supabase pour synchroniser et activer les rappels e-mail/SMS.");
  } else {
    byId("syncStatus").textContent = "Connexion requise";
    authBackdrop.hidden = false;
    client.auth.onAuthStateChange((_event, session) => {
      window.setTimeout(() => { void handleSession(session?.user || null); }, 0);
    });
    void client.auth.getSession().then(({ data, error }) => {
      if (error) {
        showNotice("Lecture de la session impossible.", "error");
        return;
      }
      void handleSession(data.session?.user || null);
    });
  }

  byId("openDialog").addEventListener("click", openTaskDialog);
  byId("closeDialog").addEventListener("click", closeTaskDialog);
  byId("cancelDialog").addEventListener("click", closeTaskDialog);
  taskBackdrop.addEventListener("click", (event) => { if (event.target === taskBackdrop) closeTaskDialog(); });
  byId("previousDay").addEventListener("click", () => shiftDate(-1));
  byId("nextDay").addEventListener("click", () => shiftDate(1));
  byId("goToday").addEventListener("click", () => { viewedDate = new Date(today.getFullYear(), today.getMonth(), today.getDate()); void loadDay(); });
  document.querySelectorAll(".filter-button").forEach((button) => button.addEventListener("click", () => { activeFilter = button.dataset.filter; render(); }));
  byId("accountButton").addEventListener("click", () => {
    if (!client) {
      showNotice("Ajoute l’URL Supabase et la clé publishable dans supabase-config.js, puis recharge la page.");
    } else if (user) {
      openSettings();
    } else {
      authBackdrop.hidden = false;
      byId("loginEmail").focus();
    }
  });
  byId("signOutButton").addEventListener("click", async () => {
    const { error } = await client.auth.signOut();
    if (error) showNotice("La déconnexion a échoué.", "error");
  });
  byId("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = byId("loginMessage");
    message.textContent = "Envoi du lien…";
    const { error } = await client.auth.signInWithOtp({
      email: byId("loginEmail").value.trim(),
      options: { shouldCreateUser: false, emailRedirectTo: window.location.href.split("#")[0] },
    });
    message.textContent = error ? "Envoi impossible. Vérifie que le compte existe et que l’URL de redirection est autorisée." : "Lien de connexion envoyé. Consulte ta boîte e-mail.";
  });
  byId("settingsForm").addEventListener("submit", (event) => { void saveSettings(event); });
  byId("closeSettings").addEventListener("click", () => closeBackdrop(settingsBackdrop, "accountButton"));
  byId("cancelSettings").addEventListener("click", () => closeBackdrop(settingsBackdrop, "accountButton"));
  settingsBackdrop.addEventListener("click", (event) => { if (event.target === settingsBackdrop) closeBackdrop(settingsBackdrop, "accountButton"); });
  byId("taskForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const title = String(formData.get("title") || "").trim();
    if (!title) return;
    const date = dateKey(viewedDate);
    const time = String(formData.get("time") || "");
    const task = {
      id: crypto.randomUUID(),
      title,
      category: String(formData.get("category") || "personal"),
      time,
      done: false,
      emailReminder: byId("emailReminder").checked,
      smsReminder: byId("smsReminder").checked,
    };
    if (client && user) {
      let scheduledAt;
      try { scheduledAt = localSchedule(date, time); } catch (error) {
        showNotice(error instanceof Error ? error.message : "Heure invalide.", "error");
        return;
      }
      const { error } = await client.from("tasks").insert({
        id: task.id,
        user_id: user.id,
        title: task.title,
        category: task.category,
        task_date: date,
        local_time: time || null,
        scheduled_at: scheduledAt,
        timezone_name: timezoneName,
        completed: false,
        email_reminder: task.emailReminder,
        sms_reminder: task.smsReminder,
      });
      if (error) {
        showNotice("La tâche n’a pas pu être enregistrée dans Supabase.", "error");
        return;
      }
      tasksByDate[date] = [...currentTasks(), task];
    } else {
      tasksByDate[date] = [...currentTasks(), task];
      writeLocalTasks();
    }
    activeFilter = "all";
    closeTaskDialog();
    render();
  });

  render();
})();
