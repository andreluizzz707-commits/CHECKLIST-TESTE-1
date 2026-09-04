/* ============================================================================
   OPERA — camada de dados (Supabase)
   Depende de config.js (SUPABASE_URL / SUPABASE_ANON_KEY) e do SDK do Supabase.
   ============================================================================ */

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const OperaDB = (function () {
  "use strict";

  let companyId = null;
  let userId = null;

  const BUCKET = "opera-fotos";
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const nowTime = () => new Date().toTimeString().slice(0, 5);

  function fail(error, msg) {
    if (error) throw new Error(msg + ": " + error.message);
  }

  /* ------------------------------------------------------------------
     AUTENTICAÇÃO
     ------------------------------------------------------------------ */

  // Tela do CNPJ. Funciona sem estar logado (RPC liberada para anon).
  async function findCompanyByCnpj(cnpj) {
    const { data, error } = await sb.rpc("find_company_by_cnpj", { p_cnpj: cnpj });
    fail(error, "Erro ao buscar empresa");
    return data && data.length ? data[0] : null;
  }

  async function signIn(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw new Error("E-mail ou senha inválidos.");
    userId = data.user.id;
    return data.user;
  }

  async function signOut() {
    await sb.auth.signOut();
    companyId = null; userId = null;
  }

  // Sessão já existente: o Supabase guarda e renova o token sozinho.
  async function currentUser() {
    const { data } = await sb.auth.getSession();
    if (!data.session) return null;
    userId = data.session.user.id;
    return data.session.user;
  }

  async function resetPassword(email) {
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname
    });
    fail(error, "Erro ao enviar o link");
  }

  // Cadastro da empresa: cria o usuário no Auth e depois a empresa via RPC.
  async function registerCompany({ cnpj, companyName, adminName, email, password, phone }) {
    let { data, error } = await sb.auth.signUp({ email, password });
    if (error && /already|registered/i.test(error.message)) {
      // conta já existe (tentativa anterior que falhou no meio) — entra e segue
      const r = await sb.auth.signInWithPassword({ email: email, password: password });
      if (r.error) throw new Error("Este e-mail já tem uma conta. Entre com ela ou use outro e-mail.");
      data = r.data;
    } else if (error) {
      throw new Error("Erro ao criar usuário: " + error.message);
    }
    if (!data.session) {
      throw new Error("Confirme o seu e-mail e depois entre para concluir o cadastro.");
    }
    userId = data.user.id;
    const { data: res, error: e2 } = await sb.rpc("create_company", {
      p_cnpj: cnpj, p_name: companyName, p_admin_name: adminName,
      p_email: email, p_phone: phone || null
    });
    if (e2) { await sb.auth.signOut(); throw new Error(e2.message); }
    companyId = res.company_id;
    return res; // { company_id, code }
  }

  // Funcionário ativando a própria conta com o código de convite.
  async function activateWithInvite({ email, password, code }) {
    let { data, error } = await sb.auth.signUp({ email, password });
    if (error && /already|registered/i.test(error.message)) {
      const r = await sb.auth.signInWithPassword({ email: email, password: password });
      if (r.error) throw new Error("Este e-mail já tem uma conta. Use a senha dela ou fale com o administrador.");
      data = r.data;
    } else if (error) {
      throw new Error("Erro ao criar conta: " + error.message);
    }
    if (!data.session) throw new Error("Confirme o seu e-mail e depois entre novamente.");
    userId = data.user.id;
    const { data: res, error: e2 } = await sb.rpc("accept_invite", { p_code: code });
    if (e2) { await sb.auth.signOut(); throw new Error(e2.message); }
    return res;
  }

  /* ------------------------------------------------------------------
     FOTOS (Storage)
     ------------------------------------------------------------------ */

  function dataUrlToBlob(dataUrl) {
    const parts = dataUrl.split(",");
    const mime = parts[0].match(/:(.*?);/)[1];
    const bin = atob(parts[1]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now() + "-" + Math.random().toString(36).slice(2, 10);
  }

  // Recebe o dataURL que o seu fileToCompressedDataURL() já produz.
  // Devolve o CAMINHO dentro do bucket — é isso que vai pro banco, não a URL.
  async function uploadPhoto(dataUrl, folder) {
    if (!dataUrl) return null;
    const path = companyId + "/" + folder + "/" + newId() + ".jpg";
    const { error } = await sb.storage.from(BUCKET)
      .upload(path, dataUrlToBlob(dataUrl), { contentType: "image/jpeg", upsert: false });
    fail(error, "Erro ao enviar a foto");
    return path;
  }

  // O bucket é privado. Assinamos as URLs em lote depois de carregar tudo,
  // para que as suas telas continuem recebendo um src pronto para usar.
  async function signAll(paths) {
    const clean = [];
    paths.forEach(p => { if (p && clean.indexOf(p) === -1) clean.push(p); });
    if (!clean.length) return {};
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(clean, 60 * 60 * 8);
    if (error) return {};
    const map = {};
    data.forEach(d => { if (!d.error) map[d.path] = d.signedUrl; });
    return map;
  }

  /* ------------------------------------------------------------------
     CARGA — devolve um objeto no MESMO formato do seu `company` de antes,
     para que todas as suas funções de render continuem funcionando.
     ------------------------------------------------------------------ */

  async function loadCompany() {
    const { data: me, error: eMe } = await sb.from("profiles")
      .select("id, company_id, name, email, position, role, is_owner, shift_id, active")
      .eq("id", userId).single();
    if (eMe) throw new Error("Seu usuário ainda não está ligado a nenhuma empresa.");
    companyId = me.company_id;

    const res = await Promise.all([
      sb.from("companies").select("*").eq("id", companyId).single(),
      sb.from("profiles").select("*").eq("company_id", companyId).order("name"),
      sb.from("shifts").select("*").eq("company_id", companyId).order("start_time"),
      sb.from("tasks").select("*").eq("company_id", companyId).order("due_date"),
      sb.from("task_completions").select("*").eq("company_id", companyId).order("created_at", { ascending: false }).limit(500),
      sb.from("timesheets").select("*").eq("company_id", companyId).order("work_date", { ascending: false }).limit(500),
      sb.from("shift_photos").select("*").eq("company_id", companyId).order("work_date", { ascending: false }).limit(200),
      sb.from("wastes").select("*").eq("company_id", companyId).order("created_at", { ascending: false }).limit(500),
      sb.from("image_checklists").select("*").eq("company_id", companyId)
    ]);
    res.forEach(r => { if (r.error) throw new Error("Erro ao carregar dados: " + r.error.message); });
    const comp = res[0], users = res[1], shifts = res[2], tasks = res[3],
          compls = res[4], ts = res[5], sphotos = res[6], wastes = res[7], ics = res[8];

    const paths = [];
    compls.data.forEach(c => paths.push(c.photo_url));
    ts.data.forEach(r => { paths.push(r.entry_photo_url); paths.push(r.exit_photo_url); });
    sphotos.data.forEach(p => paths.push(p.photo_url));
    wastes.data.forEach(w => paths.push(w.photo_url));
    ics.data.forEach(i => paths.push(i.image_url));
    const urls = await signAll(paths);
    const u = p => (p ? urls[p] || null : null);
    const hhmm = t => (t ? String(t).slice(0, 5) : null);

    return {
      id: comp.data.id,
      code: comp.data.code,
      name: comp.data.name,
      cnpj: comp.data.cnpj,
      createdAt: comp.data.created_at,
      permissions: comp.data.permissions,
      settings: comp.data.settings,

      users: users.data.filter(x => x.active).map(x => ({
        id: x.id, name: x.name, username: x.email, email: x.email,
        role: x.role, position: x.position || "", shift: x.shift_id || "",
        isOwner: x.is_owner, active: x.active
      })),

      shifts: shifts.data.map(s => ({
        id: s.id, name: s.name, start: hhmm(s.start_time), end: hhmm(s.end_time)
      })),

      checklists: tasks.data.map(t => ({
        id: t.id, type: t.type, title: t.title, area: t.area || "",
        responsible: t.responsible_id || "", shift: t.shift_id || "",
        frequency: t.frequency, priority: t.priority, due: t.due_date,
        status: t.status, notes: t.notes || "", completedAt: t.completed_at,
        imageRef: t.image_checklist_id
          ? { checklistImageId: t.image_checklist_id, pinId: t.image_pin_id }
          : undefined
      })),

      completions: compls.data.map(c => ({
        id: c.id, taskId: c.task_id, title: c.title, type: c.type, area: c.area,
        userId: c.user_id, date: c.work_date, time: hhmm(c.work_time),
        photo: u(c.photo_url), notes: c.notes || "", status: c.status,
        approvedBy: c.approved_by, approvedAt: c.approved_at,
        rejectionReason: c.rejection_reason
      })),

      timesheet: ts.data.map(r => ({
        id: r.id, userId: r.user_id, date: r.work_date,
        clockIn: hhmm(r.clock_in), clockOut: hhmm(r.clock_out),
        photo: u(r.entry_photo_url), shift: r.shift_id || "",
        geo: r.latitude == null ? null : {
          lat: r.latitude, lng: r.longitude,
          distance: r.distance_m, withinFence: r.within_fence
        }
      })),

      shiftPhotos: sphotos.data.map(p => ({
        id: p.id, userId: p.user_id, date: p.work_date,
        time: hhmm(p.work_time), photo: u(p.photo_url)
      })),

      wastes: wastes.data.map(w => ({
        id: w.id, userId: w.user_id, date: w.work_date, createdAt: w.created_at,
        item: w.item, quantity: Number(w.quantity), unit: w.unit,
        reason: w.reason, photo: u(w.photo_url)
      })),

      imageChecklists: ics.data.map(i => ({
        id: i.id, title: i.title, image: u(i.image_url), pins: i.pins,
        type: i.type, area: i.area, createdAt: i.created_at
      })),

      _me: { id: me.id, role: me.role, isOwner: me.is_owner }
    };
  }

  /* ------------------------------------------------------------------
     ESCRITAS — uma por ação, no lugar do antigo saveCompany() global
     ------------------------------------------------------------------ */

  async function saveTask(task) {
    const row = {
      company_id: companyId, title: task.title, type: task.type,
      area: task.area || null, responsible_id: task.responsible || null,
      shift_id: task.shift || null, frequency: task.frequency,
      priority: task.priority, due_date: task.due || null,
      notes: task.notes || null
    };
    if (task.id) {
      const { data, error } = await sb.from("tasks").update(row).eq("id", task.id).select().single();
      fail(error, "Erro ao salvar a tarefa");
      return data;
    }
    row.status = "pendente";
    row.created_by = userId;
    const { data, error } = await sb.from("tasks").insert(row).select().single();
    fail(error, "Erro ao criar a tarefa");
    return data;
  }

  async function deleteTask(id) {
    const { error } = await sb.from("tasks").delete().eq("id", id);
    fail(error, "Erro ao excluir a tarefa");
  }

  async function setTaskStatus(id, patch) {
    const { error } = await sb.from("tasks").update(patch).eq("id", id);
    fail(error, "Erro ao atualizar a tarefa");
  }

  async function addCompletion({ task, notes, photoDataUrl }) {
    const photo_url = await uploadPhoto(photoDataUrl, "checklists");
    const { data, error } = await sb.from("task_completions").insert({
      company_id: companyId, task_id: task.id, user_id: userId,
      title: task.title, type: task.type, area: task.area,
      work_date: todayISO(), work_time: nowTime(),
      photo_url: photo_url, notes: notes || null, status: "pendente"
    }).select().single();
    fail(error, "Erro ao enviar o checklist");
    await setTaskStatus(task.id, { status: "aguardando_aprovacao" });
    return data;
  }

  async function approveCompletion(id, taskPatch, taskId) {
    const { error } = await sb.from("task_completions")
      .update({ status: "aprovado", approved_by: userId, approved_at: new Date().toISOString() })
      .eq("id", id);
    fail(error, "Erro ao aprovar");
    if (taskId && taskPatch) await setTaskStatus(taskId, taskPatch);
  }

  async function rejectCompletion(id, reason, taskId) {
    const { error } = await sb.from("task_completions").update({
      status: "reprovado", rejection_reason: reason,
      approved_by: userId, approved_at: new Date().toISOString()
    }).eq("id", id);
    fail(error, "Erro ao reprovar");
    if (taskId) await setTaskStatus(taskId, { status: "pendente" });
  }

  // Início de expediente: foto do turno + abertura do ponto.
  async function startShift({ photoDataUrl, shiftId, geo }) {
    const photo_url = await uploadPhoto(photoDataUrl, "turnos");
    const { error: e1 } = await sb.from("shift_photos").insert({
      company_id: companyId, user_id: userId,
      work_date: todayISO(), work_time: nowTime(), photo_url: photo_url
    });
    fail(e1, "Erro ao salvar a foto do turno");
    return clockIn({ shiftId: shiftId, geo: geo, photoPath: photo_url });
  }

  // Batida de entrada. O unique (user_id, work_date) impede ponto duplicado.
  async function clockIn({ shiftId, geo, photoPath }) {
    const { data, error } = await sb.from("timesheets").upsert({
      company_id: companyId, user_id: userId, shift_id: shiftId || null,
      work_date: todayISO(), clock_in: nowTime(), entry_photo_url: photoPath || null,
      latitude: geo ? geo.lat : null, longitude: geo ? geo.lng : null,
      distance_m: geo ? geo.distance : null, within_fence: geo ? geo.withinFence : null
    }, { onConflict: "user_id,work_date", ignoreDuplicates: true }).select();
    fail(error, "Erro ao registrar a entrada");
    return data;
  }

  async function clockOut(entryId, photoDataUrl) {
    const exit_photo_url = photoDataUrl ? await uploadPhoto(photoDataUrl, "turnos") : null;
    const patch = { clock_out: nowTime() };
    if (exit_photo_url) patch.exit_photo_url = exit_photo_url;
    const { error } = await sb.from("timesheets").update(patch).eq("id", entryId);
    fail(error, "Erro ao registrar a saída");
  }

  async function addWaste({ item, quantity, unit, reason, photoDataUrl }) {
    const photo_url = await uploadPhoto(photoDataUrl, "desperdicio");
    const { data, error } = await sb.from("wastes").insert({
      company_id: companyId, user_id: userId, work_date: todayISO(),
      item: item, quantity: quantity, unit: unit,
      reason: reason || null, photo_url: photo_url
    }).select().single();
    fail(error, "Erro ao registrar o desperdício");
    return data;
  }

  async function deleteWaste(id) {
    const { error } = await sb.from("wastes").delete().eq("id", id);
    fail(error, "Erro ao excluir o registro");
  }

  async function saveShift({ id, name, start, end }) {
    const row = { company_id: companyId, name: name, start_time: start, end_time: end };
    const q = id ? sb.from("shifts").update(row).eq("id", id) : sb.from("shifts").insert(row);
    const { data, error } = await q.select().single();
    fail(error, "Erro ao salvar o turno");
    return data;
  }

  async function deleteShift(id) {
    const { error } = await sb.from("shifts").delete().eq("id", id);
    fail(error, "Erro ao excluir o turno");
  }

  // Substitui o antigo company.users.push(). Não cria senha para ninguém:
  // gera um convite que o próprio funcionário usa para ativar a conta.
  async function createInvite({ name, email, position, role, shiftId }) {
    let code = "";
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
    const { data, error } = await sb.from("invites").insert({
      company_id: companyId, name: name, email: email.toLowerCase().trim(),
      position: position || null, role: role, shift_id: shiftId || null,
      code: code, created_by: userId
    }).select().single();
    fail(error, "Erro ao gerar o convite");
    return data;
  }

  async function updateUser(id, patch) {
    const { error } = await sb.from("profiles").update(patch).eq("id", id);
    fail(error, "Erro ao atualizar o usuário");
  }

  // Desativa em vez de apagar: o histórico de ponto e checklist continua válido.
  async function deactivateUser(id) {
    const { error } = await sb.from("profiles").update({ active: false }).eq("id", id);
    fail(error, "Erro ao desativar o usuário");
  }

  async function savePermissions(permissions) {
    const { error } = await sb.from("companies").update({ permissions: permissions }).eq("id", companyId);
    fail(error, "Erro ao salvar as permissões");
  }

  async function saveSettings(settings) {
    const { error } = await sb.from("companies").update({ settings: settings }).eq("id", companyId);
    fail(error, "Erro ao salvar as configurações");
  }

  // Salva a imagem, os pinos e já cria uma tarefa para cada pino.
  async function saveImageChecklist({ title, imageDataUrl, pins, type, area }) {
    const image_url = await uploadPhoto(imageDataUrl, "checklist-imagem");
    const { data: ic, error } = await sb.from("image_checklists").insert({
      company_id: companyId, title: title, image_url: image_url,
      pins: pins, type: type, area: area, created_by: userId
    }).select().single();
    fail(error, "Erro ao salvar o checklist por imagem");

    const rows = pins.map(p => ({
      company_id: companyId, title: p.label, type: type, area: area,
      frequency: "unica", priority: "normal", due_date: todayISO(),
      status: "pendente", created_by: userId,
      notes: 'Criado a partir do checklist por imagem "' + title + '"',
      image_checklist_id: ic.id, image_pin_id: p.id
    }));
    const { error: e2 } = await sb.from("tasks").insert(rows);
    fail(e2, "Erro ao criar as tarefas do checklist");
    return ic;
  }

  return {
    findCompanyByCnpj: findCompanyByCnpj,
    signIn: signIn, signOut: signOut, currentUser: currentUser,
    resetPassword: resetPassword,
    registerCompany: registerCompany, activateWithInvite: activateWithInvite,
    loadCompany: loadCompany,
    saveTask: saveTask, deleteTask: deleteTask, setTaskStatus: setTaskStatus,
    addCompletion: addCompletion,
    approveCompletion: approveCompletion, rejectCompletion: rejectCompletion,
    startShift: startShift, clockIn: clockIn, clockOut: clockOut,
    addWaste: addWaste, deleteWaste: deleteWaste,
    saveShift: saveShift, deleteShift: deleteShift,
    createInvite: createInvite, updateUser: updateUser, deactivateUser: deactivateUser,
    savePermissions: savePermissions, saveSettings: saveSettings,
    saveImageChecklist: saveImageChecklist,
    uploadPhoto: uploadPhoto,
    get companyId() { return companyId; },
    get userId() { return userId; }
  };
})();
