(function(){
  "use strict";


  /* Escapa texto do usuário antes de ir para innerHTML.
     Sem isto, um título de tarefa com "<img src=x>" entra como markup
     na tela de todo mundo da empresa. */
  function esc(v){
    return String(v == null ? "" : v)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  }
  let company = null;
  let pendingCompany = null;   // empresa encontrada pelo CNPJ, antes do login
  let session = null;
  let currentRole = null;
  let activeChecklistType = "todos";
  let shiftPhotoDataUrl = null;
  let wastePhotoDataUrl = null;
  let completePhotoDataUrl = null;
  let pendingCompleteTaskId = null;
  let icPins = [];
  let icImageDataUrl = null;

  const uid = () => Math.random().toString(36).slice(2,10);
  const todayISO = () => new Date().toISOString().slice(0,10);
  const nowTime = () => new Date().toTimeString().slice(0,5);
  const fmtDate = (iso) => { if(!iso) return "—"; const [y,m,d]=iso.split("-"); return `${d}/${m}/${y}`; };
  const STATUS_LABEL = {pendente:"Pendente", concluido:"Concluído", atrasado:"Atrasado", aguardando_aprovacao:"Aguardando aprovação"};

  function showToast(msg){
    const t = document.getElementById("toast");
    t.textContent = msg; t.style.display = "block";
    clearTimeout(t._timer); t._timer = setTimeout(()=>{ t.style.display="none"; }, 2600);
  }
  function showScreen(id){
    document.querySelectorAll(".gate").forEach(s=>s.style.display="none");
    document.getElementById("app").style.display = "none";
    if(id==="app"){ document.getElementById("app").style.display = "block"; }
    else { document.getElementById(id).style.display = "flex"; }
  }
  function fileToCompressedDataURL(file, maxDim, quality){
    maxDim = maxDim || 640; quality = quality || 0.6;
    return new Promise((resolve, reject)=>{
      const reader = new FileReader();
      reader.onload = (e)=>{
        const img = new Image();
        img.onload = ()=>{
          let w = img.width, h = img.height;
          if(w > h && w > maxDim){ h = Math.round(h * maxDim / w); w = maxDim; }
          else if(h > maxDim){ w = Math.round(w * maxDim / h); h = maxDim; }
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
  function distanceMeters(lat1,lng1,lat2,lng2){
    const R=6371000, toRad=d=>d*Math.PI/180;
    const dLat=toRad(lat2-lat1), dLng=toRad(lng2-lng1);
    const a=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
    return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }
  function minutesBetween(a,b){
    const [h1,m1]=a.split(":").map(Number), [h2,m2]=b.split(":").map(Number);
    let mins=(h2*60+m2)-(h1*60+m1); if(mins<0) mins+=24*60; return mins;
  }
  function nextDueDate(due, frequency){
    const d = due? new Date(due+"T00:00:00") : new Date();
    if(frequency==="diaria") d.setDate(d.getDate()+1);
    else if(frequency==="semanal") d.setDate(d.getDate()+7);
    else if(frequency==="mensal") d.setMonth(d.getMonth()+1);
    return d.toISOString().slice(0,10);
  }

  // ---------------- PERMISSIONS ----------------
  function can(cap){ if(currentRole==="admin") return true; return !!(company.permissions[currentRole] && company.permissions[currentRole][cap]); }

  // ---------------- COMPANY DATA ----------------
  // Os turnos e as permissões padrão agora nascem no banco (RPC create_company
  // e defaults da tabela companies). Não existe mais seed no navegador.
  // Recarrega TUDO do Supabase para o objeto `company`, no mesmo formato de antes.
  // Chamada depois de cada escrita, para que todo mundo veja o mesmo estado.
  async function refresh(){
    company = await OperaDB.loadCompany();
  }
  // Mostra erro de forma consistente em qualquer operação de escrita.
  function oops(e){
    console.error(e);
    showToast(e && e.message ? e.message : "Erro ao salvar. Tente de novo.");
  }

  function userName(id){ if(!id) return "Não atribuído"; const u = company.users.find(u=>u.id===id); return u? u.name : "—"; }
  function shiftName(id){ if(!id) return "Qualquer turno"; const s = company.shifts.find(s=>s.id===id); return s? s.name : "—"; }
  function userShiftLabel(u){ if(!u || !u.shift) return "Sem turno fixo"; return shiftName(u.shift); }
  function computeStatus(task){
    if(task.status === "concluido") return "concluido";
    if(task.status === "aguardando_aprovacao") return "aguardando_aprovacao";
    if(task.due && task.due < todayISO()) return "atrasado";
    return "pendente";
  }
  function statusBadge(s){
    if(s==="concluido") return `<span class="badge badge-ok">● Concluído</span>`;
    if(s==="aguardando_aprovacao") return `<span class="badge badge-info">◔ Aguardando aprovação</span>`;
    if(s==="atrasado") return `<span class="badge badge-danger">● Atrasado</span>`;
    return `<span class="badge badge-warn">● Pendente</span>`;
  }
  function openImage(dataUrl){ if(!dataUrl) return; document.getElementById("image-view-img").src = dataUrl; document.getElementById("modal-image").classList.add("active"); }

  // ---------------- INIT / GATE FLOW ----------------
  async function init(){
    try{
      const u = await OperaDB.currentUser();
      if(u){
        company = await OperaDB.loadCompany();
        session = company._me.id; currentRole = company._me.role;
        return afterLogin();
      }
    }catch(e){
      // sessão existe no Auth mas o perfil sumiu (empresa apagada, convite não aceito)
      console.error(e); await OperaDB.signOut();
    }
    showScreen("screen-welcome");
  }
  document.getElementById("go-register").addEventListener("click", ()=> showScreen("screen-register"));
  document.getElementById("go-join").addEventListener("click", ()=> showScreen("screen-join"));
  document.getElementById("go-invite").addEventListener("click", ()=> showScreen("screen-invite"));
  document.querySelectorAll("[data-back]").forEach(b=> b.addEventListener("click", ()=> showScreen(b.dataset.back)));

  // ---------------- MÁSCARA DE CNPJ (00.000.000/0000-00) ----------------
  function maskCnpj(value){
    const digits = value.replace(/\D/g, "").slice(0, 14);
    let out = digits;
    if(digits.length > 12) out = digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{0,2})/, "$1.$2.$3/$4-$5");
    else if(digits.length > 8) out = digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{0,4})/, "$1.$2.$3/$4");
    else if(digits.length > 5) out = digits.replace(/^(\d{2})(\d{3})(\d{0,3})/, "$1.$2.$3");
    else if(digits.length > 2) out = digits.replace(/^(\d{2})(\d{0,3})/, "$1.$2");
    return out;
  }
  function applyCnpjMask(input){
    input.setAttribute("inputmode", "numeric");
    input.setAttribute("maxlength", "18");
    input.addEventListener("input", ()=>{
      const pos = input.selectionStart;
      const before = input.value.length;
      input.value = maskCnpj(input.value);
      const after = input.value.length;
      // mantém o cursor perto de onde estava, ajustando pela diferença de tamanho
      const newPos = Math.max(0, pos + (after - before));
      input.setSelectionRange(newPos, newPos);
    });
  }
  ["reg-company-cnpj", "join-cnpj"].forEach(id=>{
    const el = document.getElementById(id);
    if(el) applyCnpjMask(el);
  });

  // ---------------- CADASTRO DA EMPRESA ----------------
  document.getElementById("reg-submit").addEventListener("click", async ()=>{
    const cnpj = document.getElementById("reg-company-cnpj").value.trim();
    const name = document.getElementById("reg-company-name").value.trim();
    const adminName = document.getElementById("reg-admin-name").value.trim();
    const email = document.getElementById("reg-admin-email").value.trim();
    const pass = document.getElementById("reg-admin-password").value;
    const err = document.getElementById("register-error");
    const btn = document.getElementById("reg-submit");
    if(!cnpj || !name || !adminName || !email || !pass){
      err.textContent = "Preencha todos os campos."; err.style.display="block"; return;
    }
    if(!document.getElementById("reg-accept").checked){
      err.textContent = "\u00c9 preciso aceitar os Termos de Uso e a Pol\u00edtica de Privacidade."; err.style.display="block"; return;
    }
    if(cnpj.replace(/\D/g,"").length !== 14){
      err.textContent = "CNPJ inv\u00e1lido. Precisa ter 14 d\u00edgitos."; err.style.display="block"; return;
    }
    if(pass.length < 8){
      err.textContent = "A senha precisa ter pelo menos 8 caracteres."; err.style.display="block"; return;
    }
    btn.disabled = true; btn.textContent = "Criando...";
    try{
      const res = await OperaDB.registerCompany({cnpj, companyName:name, adminName, email, password:pass});
      company = await OperaDB.loadCompany();
      session = company._me.id; currentRole = company._me.role;
      err.style.display = "none";
      showToast("Empresa criada! C\u00f3digo: " + res.code);
      enterApp("dashboard");
    }catch(e){
      err.textContent = e.message; err.style.display = "block";
    }finally{
      btn.disabled = false; btn.textContent = "Criar empresa e continuar";
    }
  });

  // ---------------- CNPJ -> EMPRESA ----------------
  document.getElementById("join-submit").addEventListener("click", async ()=>{
    const cnpj = document.getElementById("join-cnpj").value.trim();
    const err = document.getElementById("join-error");
    if(cnpj.replace(/\D/g,"").length !== 14){
      err.textContent = "Informe um CNPJ com 14 d\u00edgitos."; err.style.display="block"; return;
    }
    try{
      const found = await OperaDB.findCompanyByCnpj(cnpj);
      if(!found){ err.textContent = "Empresa n\u00e3o encontrada para este CNPJ."; err.style.display="block"; return; }
      pendingCompany = found;
      err.style.display = "none";
      prepareLoginScreen();
      showScreen("screen-login");
    }catch(e){ err.textContent = e.message; err.style.display = "block"; }
  });

  // ---------------- ATIVAR CONTA COM CONVITE ----------------
  document.getElementById("inv-submit").addEventListener("click", async ()=>{
    const code = document.getElementById("inv-code").value.trim().toUpperCase();
    const email = document.getElementById("inv-email").value.trim();
    const pass = document.getElementById("inv-password").value;
    const err = document.getElementById("invite-error");
    const btn = document.getElementById("inv-submit");
    if(!code || !email || !pass){ err.textContent = "Preencha todos os campos."; err.style.display="block"; return; }
    if(pass.length < 8){ err.textContent = "A senha precisa ter pelo menos 8 caracteres."; err.style.display="block"; return; }
    btn.disabled = true; btn.textContent = "Ativando...";
    try{
      await OperaDB.activateWithInvite({email, password:pass, code});
      company = await OperaDB.loadCompany();
      session = company._me.id; currentRole = company._me.role;
      err.style.display = "none";
      showToast("Conta ativada. Bem-vindo!");
      afterLogin();
    }catch(e){
      err.textContent = e.message; err.style.display = "block";
    }finally{
      btn.disabled = false; btn.textContent = "Ativar conta";
    }
  });

  function prepareLoginScreen(){
    const c = pendingCompany || company;
    document.getElementById("login-company-name").textContent = c ? c.name : "\u2014";
    document.getElementById("login-company-code").textContent = c ? ("C\u00f3digo: " + c.code) : "\u2014";
    document.getElementById("login-company-avatar").textContent = c ? c.name.charAt(0).toUpperCase() : "?";
    document.getElementById("login-error").style.display = "none";
  }

  // ---------------- LOGIN ----------------
  document.getElementById("login-form").addEventListener("submit", async (e)=>{
    e.preventDefault();
    const email = document.getElementById("login-user").value.trim();
    const pass = document.getElementById("login-pass").value;
    const errBox = document.getElementById("login-error");
    try{
      await OperaDB.signIn(email, pass);
      company = await OperaDB.loadCompany();
    }catch(err){
      errBox.textContent = err.message; errBox.style.display = "block";
      await OperaDB.signOut();
      return;
    }
    // O CNPJ digitado tem que bater com a empresa do usu\u00e1rio.
    if(pendingCompany && company.id !== pendingCompany.id){
      errBox.textContent = "Este usu\u00e1rio n\u00e3o pertence \u00e0 empresa " + pendingCompany.name + ".";
      errBox.style.display = "block";
      await OperaDB.signOut(); company = null;
      return;
    }
    errBox.style.display = "none";
    session = company._me.id; currentRole = company._me.role;
    document.getElementById("login-user").value = ""; document.getElementById("login-pass").value = "";
    afterLogin();
  });

  // Depois de autenticar: colaborador passa pela foto de in\u00edcio de turno.
  function afterLogin(){
    const me = company.users.find(u=>u.id===session) || {shift:""};
    if(currentRole === "colaborador"){
      const already = company.shiftPhotos.find(p=>p.userId===session && p.date===todayISO());
      if(already){ enterApp("checklist"); return; }
      resetShiftPhotoScreen(me); showScreen("screen-shift-photo"); return;
    }
    enterApp(can("verDashboard") ? "dashboard" : "checklist");
  }

  document.getElementById("forgot-pass").addEventListener("click", async ()=>{
    const email = document.getElementById("login-user").value.trim();
    if(!email){ showToast("Digite o seu e-mail primeiro."); return; }
    try{ await OperaDB.resetPassword(email); showToast("Enviamos um link de redefini\u00e7\u00e3o para o seu e-mail."); }
    catch(e){ oops(e); }
  });

  document.getElementById("logout-btn").addEventListener("click", async ()=>{
    await OperaDB.signOut();
    session = null; currentRole = null; company = null; pendingCompany = null;
    showScreen("screen-welcome");
  });

  // ---------------- SHIFT START PHOTO ----------------
  function resetShiftPhotoScreen(user){
    shiftPhotoDataUrl = null;
    document.getElementById("shift-photo-preview").style.display = "none";
    document.getElementById("shift-photo-placeholder").style.display = "flex";
    document.getElementById("shift-photo-confirm").disabled = true;
    document.getElementById("shift-photo-input").value = "";
    const sel = document.getElementById("shift-turno-select");
    sel.innerHTML = company.shifts.map(s=>`<option value="${s.id}">${esc(s.name)} (${s.start}–${s.end})</option>`).join("") + `<option value="">Sem turno fixo</option>`;
    if(user.shift) sel.value = user.shift;
  }
  document.getElementById("shift-photo-trigger").addEventListener("click", ()=> document.getElementById("shift-photo-input").click());
  document.getElementById("shift-photo-input").addEventListener("change", async (e)=>{
    const file = e.target.files[0]; if(!file) return;
    shiftPhotoDataUrl = await fileToCompressedDataURL(file, 480, 0.6);
    document.getElementById("shift-photo-preview").src = shiftPhotoDataUrl;
    document.getElementById("shift-photo-preview").style.display = "block";
    document.getElementById("shift-photo-placeholder").style.display = "none";
    document.getElementById("shift-photo-confirm").disabled = false;
  });
  document.getElementById("shift-photo-confirm").addEventListener("click", async ()=>{
    const chosenShift = document.getElementById("shift-turno-select").value;
    let geo = null;
    if(company.settings.geofence.enabled && navigator.geolocation && company.settings.geofence.lat!=null){
      try{
        const pos = await new Promise((res,rej)=> navigator.geolocation.getCurrentPosition(res, rej, {timeout:6000}));
        const dist = distanceMeters(pos.coords.latitude, pos.coords.longitude, company.settings.geofence.lat, company.settings.geofence.lng);
        geo = { lat: pos.coords.latitude, lng: pos.coords.longitude, distance: Math.round(dist), withinFence: dist <= company.settings.geofence.radius };
      }catch(e){ geo = null; }
    }
    try{
      await OperaDB.startShift({ photoDataUrl: shiftPhotoDataUrl, shiftId: chosenShift || null, geo });
      await refresh();
      showToast("Turno iniciado. Bom trabalho!");
      enterApp("checklist");
    }catch(e){ oops(e); }
  });

  // ---------------- NAV / ROLE VISIBILITY ----------------
  function applyRoleNav(){
    const map = {dashboard:"verDashboard", checklist:true, ponto:true, aprovacoes:"aprovarChecklists", relatorios:"verRelatorios", usuarios:"gerenciarUsuarios", configuracoes: currentRole==="admin"};
    document.querySelectorAll(".nav-item[data-view]").forEach(btn=>{
      const key = map[btn.dataset.view];
      const visible = key===true ? true : (typeof key==="string" ? can(key) : !!key);
      btn.style.display = visible ? "flex" : "none";
    });
  }
  // ---------------- MENU DE 3 PONTINHOS (gaveta mobile) ----------------
  const sidebarEl = document.getElementById("sidebar");
  const scrimEl   = document.getElementById("drawer-scrim");
  const menuBtn   = document.getElementById("menu-btn");

  function openDrawer(){
    sidebarEl.classList.add("open");
    scrimEl.classList.add("show");
    menuBtn.setAttribute("aria-expanded","true");
    document.body.style.overflow = "hidden";
  }
  function closeDrawer(){
    sidebarEl.classList.remove("open");
    scrimEl.classList.remove("show");
    menuBtn.setAttribute("aria-expanded","false");
    document.body.style.overflow = "";
  }
  function toggleDrawer(){
    sidebarEl.classList.contains("open") ? closeDrawer() : openDrawer();
  }

  menuBtn.addEventListener("click", (e)=>{ e.stopPropagation(); toggleDrawer(); });
  scrimEl.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e)=>{ if(e.key === "Escape") closeDrawer(); });
  // se a tela voltar a ser grande (girar tablet, redimensionar janela), a gaveta some
  window.addEventListener("resize", ()=>{ if(window.innerWidth > 860) closeDrawer(); });

  // fecha a gaveta ANTES de trocar de aba: se a renderização falhar,
  // o menu não fica preso aberto por cima da tela
  document.querySelectorAll(".nav-item[data-view]").forEach(btn=> btn.addEventListener("click", ()=>{ closeDrawer(); switchView(btn.dataset.view); }));

  function switchView(view){
    document.querySelectorAll(".nav-item[data-view]").forEach(b=>b.classList.remove("active"));
    const target = document.querySelector(`.nav-item[data-view="${view}"]`);
    if(target) target.classList.add("active");
    document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
    document.getElementById("view-"+view).classList.add("active");
    const titles = {dashboard:["Dashboard","Visão geral, checklist e ponto da empresa"],
      checklist:["Checklists","Tarefas de limpeza, manutenção e desperdício"],
      ponto:["Folha de Ponto","Registro de entrada e saída da equipe"],
      aprovacoes:["Aprovações","Checklists enviados pelos colaboradores"],
      relatorios:["Relatórios","Exportação e conferência de dados operacionais"],
      usuarios:["Usuários","Gestão de acessos, funções e turnos"],
      configuracoes:["Configurações","Permissões, alertas e cerca digital"]};
    document.getElementById("topbar-title").textContent = titles[view][0];
    document.getElementById("topbar-sub").textContent = titles[view][1];
    if(view==="dashboard") renderDashboardAll();
    if(view==="checklist") { setupChecklistForRole(); renderChecklist(); }
    if(view==="ponto") renderPonto();
    if(view==="aprovacoes") renderApprovals();
    if(view==="relatorios") renderRelatorios();
    if(view==="usuarios") { renderShifts(); renderUsuarios(); }
    if(view==="configuracoes") renderConfiguracoes();
    renderBell();
  }

  function enterApp(defaultView){
    const u = company.users.find(x=>x.id===session);
    currentRole = u.role;
    document.getElementById("side-company-name").textContent = company.name;
    document.getElementById("side-company-code").textContent = company.code;
    document.getElementById("side-name").textContent = u.name;
    document.getElementById("side-role").textContent = u.role==="admin"?"Administrador":u.role==="gestor"?"Gestor":"Colaborador";
    const av = document.getElementById("side-avatar");
    const myPhoto = company.shiftPhotos.filter(p=>p.userId===u.id).sort((a,b)=> (b.date+b.time).localeCompare(a.date+a.time))[0];
    av.innerHTML = myPhoto ? `<img src="${myPhoto.photo}">` : u.name.charAt(0).toUpperCase();
    applyRoleNav();
    document.getElementById("topbar-date").textContent = new Date().toLocaleDateString('pt-BR', {weekday:'long', day:'2-digit', month:'long', year:'numeric'});
    showScreen("app");
    switchView(defaultView);
  }

  function setupChecklistForRole(){
    const canManage = can("gerenciarTarefas");
    const canDo = can("concluirTarefas");
    const canWaste = can("registrarDesperdicio");
    document.getElementById("subtab-desperdicio").style.display = canWaste ? "inline-block" : "none";
    document.getElementById("btn-new-task").style.display = canManage ? "inline-flex" : "none";
    document.getElementById("btn-new-image-checklist").style.display = canManage ? "inline-flex" : "none";
    document.getElementById("th-actions").style.display = canManage ? "table-cell" : "none";
    if(!canWaste && activeChecklistType === "desperdicio"){
      activeChecklistType = "todos";
      document.querySelectorAll(".subtab[data-type]").forEach(s=>s.classList.remove("active"));
      document.querySelector('.subtab[data-type="todos"]').classList.add("active");
    }
    document.getElementById("checklist-tasks-section").style.display = "block";
    document.getElementById("checklist-waste-section").style.display = "none";
  }

  // ---------------- BELL / ALERTS ----------------
  function computeAlerts(){
    const alerts = [];
    const lateCount = company.checklists.filter(t=>computeStatus(t)==="atrasado").length;
    if(lateCount>0) alerts.push({text:`${lateCount} tarefa(s) atrasada(s)`});
    const openToday = company.timesheet.filter(r=> r.clockIn && !r.clockOut && r.date===todayISO());
    let longOpen = 0;
    openToday.forEach(r=>{ if(minutesBetween(r.clockIn, nowTime()) > 600) longOpen++; });
    if(longOpen>0) alerts.push({text:`${longOpen} turno(s) aberto(s) há mais de 10h sem bater saída`});
    const pendingAppr = company.completions.filter(c=>c.status==="pendente").length;
    if(pendingAppr>0 && can("aprovarChecklists")) alerts.push({text:`${pendingAppr} checklist(s) aguardando sua aprovação`});
    return alerts;
  }
  function renderBell(){
    const alerts = computeAlerts();
    const badge = document.getElementById("bell-badge");
    if(alerts.length){ badge.style.display = "inline-block"; badge.textContent = alerts.length; } else { badge.style.display = "none"; }
    document.getElementById("bell-list").innerHTML = alerts.length ? alerts.map(a=>`<div class="bell-item">${esc(a.text)}</div>`).join("") : `<div class="empty-state" style="padding:24px;">Sem alertas no momento.</div>`;
  }
  document.getElementById("bell-btn").addEventListener("click", ()=>{
    const dd = document.getElementById("bell-dropdown");
    dd.style.display = dd.style.display==="block" ? "none" : "block";
  });
  document.addEventListener("click", (e)=>{ if(!e.target.closest("#bell-btn") && !e.target.closest("#bell-dropdown")) document.getElementById("bell-dropdown").style.display="none"; });

  // ---------------- DASHBOARD ----------------
  document.querySelectorAll('.subtabs .subtab[data-dash]').forEach(st=>{
    st.addEventListener("click", ()=>{
      document.querySelectorAll('.subtabs .subtab[data-dash]').forEach(s=>s.classList.remove("active"));
      st.classList.add("active");
      document.querySelectorAll(".dash-panel").forEach(p=>p.classList.remove("active"));
      document.getElementById("dash-panel-"+st.dataset.dash).classList.add("active");
    });
  });
  function computeRanking(){
    const counts = {};
    company.completions.filter(c=>c.status==="aprovado").forEach(c=>{ counts[c.userId] = (counts[c.userId]||0) + 1; });
    return Object.entries(counts).map(([userId,count])=>({userId, count, name:userName(userId)})).sort((a,b)=> b.count - a.count);
  }
  function renderDashboardAll(){ renderDashboardGeral(); renderDashboardChecklist(); renderDashboardPonto(); }

  function renderDashboardGeral(){
    const today = todayISO();
    const total = company.checklists.length;
    const done = company.checklists.filter(t=>computeStatus(t)==="concluido").length;
    const late = company.checklists.filter(t=>computeStatus(t)==="atrasado").length;
    document.getElementById("g-kpi-rate").textContent = (total? Math.round(done/total*100):0) + "%";
    document.getElementById("g-kpi-late").textContent = late;
    const monthPrefix = today.slice(0,7);
    document.getElementById("g-kpi-waste").textContent = company.wastes.filter(w=>w.date.startsWith(monthPrefix)).length;

    const todayEntries = company.timesheet.filter(r=>r.date===today);
    let onTime = 0;
    todayEntries.forEach(r=>{
      const sh = company.shifts.find(s=>s.id===r.shift);
      if(!sh){ onTime++; return; }
      if(r.clockIn <= addMinutes(sh.start, 15)) onTime++;
    });
    document.getElementById("g-kpi-punct").textContent = todayEntries.length? Math.round(onTime/todayEntries.length*100)+"%" : "—";

    const ranking = computeRanking();
    const highlightEl = document.getElementById("g-highlight");
    if(ranking.length){
      const top = ranking[0];
      const u = company.users.find(x=>x.id===top.userId);
      const photo = company.shiftPhotos.filter(p=>p.userId===top.userId).sort((a,b)=>(b.date+b.time).localeCompare(a.date+a.time))[0];
      highlightEl.innerHTML = `<div class="highlight-card"><div class="highlight-avatar">${photo? `<img src="${photo.photo}">` : (u? u.name.charAt(0).toUpperCase() : "?")}</div>
        <div><div class="highlight-name">${esc(top.name)}</div><div class="highlight-sub">${top.count} tarefa(s) aprovada(s) no total</div></div></div>`;
    } else { highlightEl.innerHTML = `<div class="empty-state">Ainda não há tarefas aprovadas para destacar alguém.</div>`; }
    const rankEl = document.getElementById("g-ranking");
    const max = Math.max(1, ...ranking.map(r=>r.count));
    rankEl.innerHTML = ranking.slice(0,6).map((r,i)=>`
      <div class="bar-row"><div class="bar-label">${i+1}. ${esc(r.name)}</div>
      <div class="bar-track"><div class="bar-fill ${i===0?'gold':''}" style="width:${(r.count/max*100).toFixed(0)}%"></div></div>
      <div class="bar-val">${r.count}</div></div>`).join("") || `<div class="empty-state">Sem dados ainda.</div>`;
  }
  function addMinutes(hhmm, mins){
    const [h,m] = hhmm.split(":").map(Number);
    const d = new Date(2000,0,1,h,m+mins);
    return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0");
  }
  function renderDashboardChecklist(){
    const today = todayISO();
    let done=0, pending=0, late=0;
    company.checklists.forEach(t=>{ const s=computeStatus(t); if(s==="concluido") done++; else if(s==="atrasado") late++; else if(s==="pendente") pending++; });
    document.getElementById("kpi-done").textContent = done;
    document.getElementById("kpi-pending").textContent = pending;
    document.getElementById("kpi-late").textContent = late;
    document.getElementById("kpi-pendappr").textContent = company.completions.filter(c=>c.status==="pendente").length;

    const areas = {};
    company.checklists.forEach(t=>{ areas[t.area] = (areas[t.area]||0)+1; });
    const max = Math.max(1, ...Object.values(areas));
    document.getElementById("dash-bars").innerHTML = Object.entries(areas).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([area,count])=>`
      <div class="bar-row"><div class="bar-label" title="${area}">${area}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(count/max*100).toFixed(0)}%"></div></div>
      <div class="bar-val">${count}</div></div>`).join("") || `<div class="empty-state">Sem tarefas cadastradas.</div>`;

    renderProgramacaoSemana();

    const recent = company.completions.filter(c=>c.status==="aprovado").sort((a,b)=> (b.date+b.time).localeCompare(a.date+a.time)).slice(0,6);
    document.getElementById("dash-activity").innerHTML = recent.map(c=>`
      <tr><td style="font-weight:600;">${esc(c.title)}</td><td style="color:var(--ink-soft);">${esc(userName(c.userId))}</td>
      <td style="color:var(--ink-faint); font-size:12.5px;">${fmtDate(c.date)} às ${c.time}</td><td>${statusBadge("concluido")}</td></tr>`
    ).join("") || `<tr><td class="empty-state">Sem atividade aprovada ainda.</td></tr>`;
  }
  function renderProgramacaoSemana(){
    const days = []; const base = new Date();
    for(let i=0;i<7;i++){
      const d = new Date(base); d.setDate(base.getDate()+i);
      const iso = d.toISOString().slice(0,10);
      const count = company.checklists.filter(t=>t.due===iso && computeStatus(t)!=="concluido").length;
      days.push({label: d.toLocaleDateString('pt-BR',{weekday:'short', day:'2-digit'}), count});
    }
    const max = Math.max(1, ...days.map(d=>d.count));
    document.getElementById("dash-week").innerHTML = days.map(d=>`
      <div class="bar-row"><div class="bar-label">${esc(d.label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(d.count/max*100).toFixed(0)}%"></div></div>
      <div class="bar-val">${d.count}</div></div>`).join("");
  }
  function renderDashboardPonto(){
    const today = todayISO();
    const todayEntries = company.timesheet.filter(r=>r.date===today);
    const active = todayEntries.filter(r=>r.clockIn && !r.clockOut).length;
    const closed = todayEntries.filter(r=>r.clockOut).length;
    document.getElementById("p-kpi-active").textContent = active;
    document.getElementById("p-kpi-closed").textContent = closed;
    document.getElementById("p-kpi-open").textContent = active;
    const closedMins = todayEntries.filter(r=>r.clockOut).map(r=> minutesBetween(r.clockIn, r.clockOut));
    const avgMins = closedMins.length? Math.round(closedMins.reduce((a,b)=>a+b,0)/closedMins.length) : 0;
    document.getElementById("p-kpi-avg").textContent = avgMins? `${Math.floor(avgMins/60)}h${String(avgMins%60).padStart(2,"0")}` : "0h";
    const max = Math.max(1, ...todayEntries.map(r=> r.clockOut? minutesBetween(r.clockIn,r.clockOut) : minutesBetween(r.clockIn, nowTime())));
    document.getElementById("p-bars").innerHTML = todayEntries.map(r=>{
      const mins = r.clockOut? minutesBetween(r.clockIn,r.clockOut) : minutesBetween(r.clockIn, nowTime());
      return `<div class="bar-row"><div class="bar-label">${esc(userName(r.userId))}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(mins/max*100).toFixed(0)}%"></div></div>
        <div class="bar-val">${Math.floor(mins/60)}h${String(mins%60).padStart(2,"0")}</div></div>`;
    }).join("") || `<div class="empty-state">Ninguém bateu ponto hoje ainda.</div>`;
  }

  // ---------------- CHECKLIST ----------------
  document.querySelectorAll(".subtab[data-type]").forEach(st=>{
    st.addEventListener("click", ()=>{
      document.querySelectorAll(".subtab[data-type]").forEach(s=>s.classList.remove("active"));
      st.classList.add("active");
      activeChecklistType = st.dataset.type;
      const isWaste = activeChecklistType === "desperdicio";
      document.getElementById("checklist-tasks-section").style.display = isWaste? "none":"block";
      document.getElementById("checklist-waste-section").style.display = isWaste? "block":"none";
      if(isWaste) renderWasteTable(); else renderChecklist();
    });
  });
  ["filter-status","filter-area","filter-shift","filter-search"].forEach(id=>{ document.getElementById(id).addEventListener("input", renderChecklist); });
  document.getElementById("waste-filter-date").addEventListener("change", renderWasteTable);

  function populateAreaFilter(){
    const sel = document.getElementById("filter-area"); const current = sel.value;
    const areas = [...new Set(company.checklists.map(t=>t.area))];
    sel.innerHTML = `<option value="todos">Todas as áreas</option>` + areas.map(a=>`<option value="${a}">${a}</option>`).join("");
    sel.value = current && areas.includes(current) ? current : "todos";
  }
  function populateShiftFilter(){
    const sel = document.getElementById("filter-shift"); const current = sel.value;
    sel.innerHTML = `<option value="todos">Todos os turnos</option>` + company.shifts.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join("");
    sel.value = current || "todos";
  }
  function renderChecklist(){
    if(activeChecklistType === "desperdicio"){ renderWasteTable(); return; }
    populateAreaFilter(); populateShiftFilter();
    const statusF = document.getElementById("filter-status").value;
    const areaF = document.getElementById("filter-area").value;
    const shiftF = document.getElementById("filter-shift").value;
    const searchF = document.getElementById("filter-search").value.trim().toLowerCase();
    const canManage = can("gerenciarTarefas");
    const canDo = can("concluirTarefas");

    let rows = company.checklists.filter(t=>{
      if(activeChecklistType!=="todos" && t.type!==activeChecklistType) return false;
      const s = computeStatus(t);
      if(statusF!=="todos" && s!==statusF) return false;
      if(areaF!=="todos" && t.area!==areaF) return false;
      if(shiftF!=="todos" && t.shift!==shiftF) return false;
      if(searchF && !t.title.toLowerCase().includes(searchF)) return false;
      return true;
    }).sort((a,b)=>(a.due||"9999").localeCompare(b.due||"9999"));

    const tbody = document.getElementById("checklist-table");
    document.getElementById("checklist-empty").style.display = rows.length? "none":"block";
    tbody.innerHTML = rows.map(t=>{
      const s = computeStatus(t);
      let firstCell = "";
      if(canDo){
        if(s==="pendente" || s==="atrasado") firstCell = `<button class="icon-btn go" data-complete="${t.id}" title="Concluir">✓</button>`;
        else if(s==="concluido") firstCell = `<button class="icon-btn go" data-reopen="${t.id}" title="Reabrir">↺</button>`;
      }
      const actionsCell = canManage ? `<div class="row-actions"><button class="icon-btn" data-edit="${t.id}" title="Editar">✎</button><button class="icon-btn" data-del="${t.id}" title="Excluir">🗑</button></div>` : "";
      const imgBtn = t.imageRef ? ` <button class="icon-btn" data-viewimg="${t.id}" title="Ver imagem de referência" style="margin-left:4px;">🖼</button>` : "";
      return `<tr>
        <td>${firstCell}</td>
        <td><div style="font-weight:600;">${esc(t.title)}${imgBtn}</div><div style="font-size:11.5px; color:var(--ink-faint);">${t.type==="limpeza"?"Limpeza":"Manutenção"} · Prioridade ${t.priority}</div></td>
        <td>${esc(t.area)}</td><td>${esc(userName(t.responsible))}</td><td>${esc(shiftName(t.shift))}</td>
        <td>${fmtDate(t.due)}</td><td>${statusBadge(s)}</td>
        <td style="${canManage?'':'display:none;'}">${actionsCell}</td>
      </tr>`;
    }).join("");

    tbody.querySelectorAll("[data-complete]").forEach(b=> b.addEventListener("click", ()=> openCompleteModal(b.dataset.complete)));
    tbody.querySelectorAll("[data-reopen]").forEach(b=> b.addEventListener("click", async ()=>{
      try{
        await OperaDB.setTaskStatus(b.dataset.reopen, {status:"pendente", completed_at:null});
        await refresh(); renderChecklist(); showToast("Tarefa reaberta.");
      }catch(e){ oops(e); }
    }));
    tbody.querySelectorAll("[data-edit]").forEach(b=>b.addEventListener("click", ()=>openTaskModal(b.dataset.edit)));
    tbody.querySelectorAll("[data-del]").forEach(b=>b.addEventListener("click", async ()=>{
      if(!confirm("Excluir esta tarefa?")) return;
      try{ await OperaDB.deleteTask(b.dataset.del); await refresh(); renderChecklist(); showToast("Tarefa exclu\u00edda."); }
      catch(e){ oops(e); }
    }));
    tbody.querySelectorAll("[data-viewimg]").forEach(b=> b.addEventListener("click", ()=> openImageChecklistView(b.dataset.viewimg)));
  }

  function fillResponsibleSelect(){ document.getElementById("task-responsible").innerHTML = `<option value="">Não atribuído</option>` + company.users.map(u=>`<option value="${u.id}">${esc(u.name)}</option>`).join(""); }
  function fillTaskShiftSelect(){ document.getElementById("task-shift").innerHTML = `<option value="">Qualquer turno</option>` + company.shifts.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join(""); }
  function openTaskModal(id){
    fillResponsibleSelect(); fillTaskShiftSelect();
    const isEdit = !!id;
    document.getElementById("task-modal-title").textContent = isEdit? "Editar tarefa":"Nova tarefa";
    if(isEdit){
      const t = company.checklists.find(x=>x.id===id);
      document.getElementById("task-id").value = t.id;
      document.getElementById("task-title").value = t.title;
      document.getElementById("task-type").value = t.type;
      document.getElementById("task-priority").value = t.priority;
      document.getElementById("task-area").value = t.area;
      document.getElementById("task-responsible").value = t.responsible || "";
      document.getElementById("task-shift").value = t.shift || "";
      document.getElementById("task-frequency").value = t.frequency;
      document.getElementById("task-due").value = t.due || "";
      document.getElementById("task-notes").value = t.notes || "";
    } else {
      document.getElementById("task-id").value = "";
      document.getElementById("task-title").value = "";
      document.getElementById("task-type").value = ["limpeza","manutencao"].includes(activeChecklistType)?activeChecklistType:"limpeza";
      document.getElementById("task-priority").value = "normal";
      document.getElementById("task-area").value = "";
      document.getElementById("task-responsible").value = "";
      document.getElementById("task-shift").value = "";
      document.getElementById("task-frequency").value = "unica";
      document.getElementById("task-due").value = todayISO();
      document.getElementById("task-notes").value = "";
    }
    document.getElementById("modal-task").classList.add("active");
  }
  document.getElementById("btn-new-task").addEventListener("click", ()=>openTaskModal(null));
  document.getElementById("task-save").addEventListener("click", async ()=>{
    const title = document.getElementById("task-title").value.trim();
    const area = document.getElementById("task-area").value.trim();
    if(!title || !area){ showToast("Preencha t\u00edtulo e \u00e1rea."); return; }
    const data = {
      id: document.getElementById("task-id").value || null,
      type: document.getElementById("task-type").value, title, area,
      responsible: document.getElementById("task-responsible").value,
      shift: document.getElementById("task-shift").value,
      frequency: document.getElementById("task-frequency").value,
      priority: document.getElementById("task-priority").value,
      due: document.getElementById("task-due").value,
      notes: document.getElementById("task-notes").value,
    };
    try{
      await OperaDB.saveTask(data);
      await refresh();
      document.getElementById("modal-task").classList.remove("active");
      renderChecklist();
      showToast("Tarefa salva.");
    }catch(e){ oops(e); }
  });

  // ---------------- COMPLETE TASK (envia para aprovação) ----------------
  function openCompleteModal(taskId){
    pendingCompleteTaskId = taskId; completePhotoDataUrl = null;
    const t = company.checklists.find(x=>x.id===taskId);
    document.getElementById("complete-task-title").textContent = t.title;
    document.getElementById("complete-notes").value = "";
    document.getElementById("complete-photo-preview").style.display = "none";
    document.getElementById("complete-photo-placeholder").style.display = "flex";
    document.getElementById("complete-photo-input").value = "";
    document.getElementById("modal-complete").classList.add("active");
  }
  document.getElementById("complete-photo-trigger").addEventListener("click", ()=> document.getElementById("complete-photo-input").click());
  document.getElementById("complete-photo-input").addEventListener("change", async (e)=>{
    const file = e.target.files[0]; if(!file) return;
    completePhotoDataUrl = await fileToCompressedDataURL(file, 480, 0.6);
    document.getElementById("complete-photo-preview").src = completePhotoDataUrl;
    document.getElementById("complete-photo-preview").style.display = "block";
    document.getElementById("complete-photo-placeholder").style.display = "none";
  });
  document.getElementById("complete-save").addEventListener("click", async ()=>{
    const t = company.checklists.find(x=>x.id===pendingCompleteTaskId); if(!t) return;
    const notes = document.getElementById("complete-notes").value.trim();
    const btn = document.getElementById("complete-save");
    btn.disabled = true; btn.textContent = "Enviando...";
    try{
      // A foto sobe para o Storage; no banco fica s\u00f3 o caminho dela.
      await OperaDB.addCompletion({ task:t, notes, photoDataUrl: completePhotoDataUrl });
      await refresh();
      document.getElementById("modal-complete").classList.remove("active");
      renderChecklist();
      showToast("Enviado para aprova\u00e7\u00e3o do supervisor.");
    }catch(e){ oops(e); }
    finally{ btn.disabled = false; btn.textContent = "Enviar para aprova\u00e7\u00e3o"; }
  });

  // ---------------- APROVACOES ----------------
  function renderApprovals(){
    const rows = company.completions.filter(c=>c.status==="pendente").sort((a,b)=> (a.date+a.time).localeCompare(b.date+b.time));
    document.getElementById("approvals-empty").style.display = rows.length? "none":"block";
    document.getElementById("approvals-table").innerHTML = rows.map(c=>`
      <tr>
        <td>${c.photo? `<img src="${c.photo}" class="thumb" data-imgappr="${c.id}">`:`<div class="thumb-placeholder">—</div>`}</td>
        <td style="font-weight:600;">${esc(userName(c.userId))}</td><td>${esc(c.title)}</td><td>${esc(c.area)}</td>
        <td>${fmtDate(c.date)}</td><td>${c.time}</td><td style="color:var(--ink-soft);">${esc(c.notes||"—")}</td>
        <td><div class="row-actions"><button class="icon-btn go" data-approve="${c.id}" title="Aprovar">✓</button><button class="icon-btn" style="border-color:var(--danger);color:var(--danger);" data-reject="${c.id}" title="Reprovar">✕</button></div></td>
      </tr>`).join("");
    document.querySelectorAll("[data-imgappr]").forEach(img=> img.addEventListener("click", ()=>{ const c = company.completions.find(x=>x.id===img.dataset.imgappr); openImage(c.photo); }));
    document.querySelectorAll("[data-approve]").forEach(b=> b.addEventListener("click", ()=> approveCompletion(b.dataset.approve)));
    document.querySelectorAll("[data-reject]").forEach(b=> b.addEventListener("click", ()=> rejectCompletion(b.dataset.reject)));
  }
  async function approveCompletion(id){
    const c = company.completions.find(x=>x.id===id); if(!c) return;
    const t = company.checklists.find(x=>x.id===c.taskId);
    let patch = null;
    if(t){
      if(t.frequency && t.frequency !== "unica"){
        patch = { due_date: nextDueDate(t.due, t.frequency), status:"pendente", completed_at: new Date().toISOString() };
      } else {
        patch = { status:"concluido", completed_at: new Date().toISOString() };
      }
    }
    try{
      await OperaDB.approveCompletion(id, patch, t ? t.id : null);
      await refresh(); renderApprovals(); renderBell();
      showToast("Checklist aprovado.");
    }catch(e){ oops(e); }
  }
  async function rejectCompletion(id){
    const motivo = window.prompt("Motivo da reprova\u00e7\u00e3o (o colaborador ver\u00e1 isso):", "");
    if(motivo===null) return;
    const c = company.completions.find(x=>x.id===id); if(!c) return;
    try{
      await OperaDB.rejectCompletion(id, motivo, c.taskId);
      await refresh(); renderApprovals(); renderBell();
      showToast("Checklist reprovado e devolvido ao colaborador.");
    }catch(e){ oops(e); }
  }

  // ---------------- WASTE ----------------
  document.getElementById("waste-reason").addEventListener("change", (e)=>{ document.getElementById("waste-reason-other-wrap").style.display = e.target.value==="Outro"?"block":"none"; });
  function resetWasteModal(){
    wastePhotoDataUrl = null;
    document.getElementById("waste-item").value = ""; document.getElementById("waste-qty").value = "";
    document.getElementById("waste-unit").value = "kg"; document.getElementById("waste-reason").value = "Vencido/estragado";
    document.getElementById("waste-reason-other").value = ""; document.getElementById("waste-reason-other-wrap").style.display = "none";
    document.getElementById("waste-photo-preview").style.display = "none"; document.getElementById("waste-photo-placeholder").style.display = "flex";
    document.getElementById("waste-photo-input").value = "";
  }
  document.getElementById("btn-new-waste").addEventListener("click", ()=>{ resetWasteModal(); document.getElementById("modal-waste").classList.add("active"); });
  document.getElementById("waste-photo-trigger").addEventListener("click", ()=> document.getElementById("waste-photo-input").click());
  document.getElementById("waste-photo-input").addEventListener("change", async (e)=>{
    const file = e.target.files[0]; if(!file) return;
    wastePhotoDataUrl = await fileToCompressedDataURL(file, 480, 0.6);
    document.getElementById("waste-photo-preview").src = wastePhotoDataUrl;
    document.getElementById("waste-photo-preview").style.display = "block";
    document.getElementById("waste-photo-placeholder").style.display = "none";
  });
  document.getElementById("waste-save").addEventListener("click", async ()=>{
    const item = document.getElementById("waste-item").value.trim();
    const qty = document.getElementById("waste-qty").value.trim();
    if(!item || !qty){ showToast("Informe o item e a quantidade."); return; }
    let reason = document.getElementById("waste-reason").value;
    if(reason==="Outro"){ reason = document.getElementById("waste-reason-other").value.trim() || "Outro"; }
    const btn = document.getElementById("waste-save");
    btn.disabled = true;
    try{
      await OperaDB.addWaste({ item, quantity: parseFloat(String(qty).replace(",",".")), unit: document.getElementById("waste-unit").value, reason, photoDataUrl: wastePhotoDataUrl });
      await refresh();
      document.getElementById("modal-waste").classList.remove("active");
      renderWasteTable();
      showToast("Desperd\u00edcio registrado.");
    }catch(e){ oops(e); }
    finally{ btn.disabled = false; }
  });
  function renderWasteTable(){
    const dateF = document.getElementById("waste-filter-date").value;
    let rows = company.wastes.filter(w=> !dateF || w.date===dateF).sort((a,b)=> b.createdAt.localeCompare(a.createdAt));
    document.getElementById("waste-empty").style.display = rows.length? "none":"block";
    document.getElementById("waste-table").innerHTML = rows.map(w=>`
      <tr>
        <td>${w.photo? `<img src="${w.photo}" class="thumb" data-img="${w.id}">` : `<div class="thumb-placeholder">—</div>`}</td>
        <td style="font-weight:600;">${esc(w.item)}</td><td>${w.quantity} ${esc(w.unit)}</td><td>${esc(w.reason)}</td>
        <td>${esc(userName(w.userId))}</td><td>${fmtDate(w.date)}</td>
        <td><button class="icon-btn" data-delwaste="${w.id}" title="Excluir">🗑</button></td>
      </tr>`).join("");
    document.querySelectorAll("[data-img]").forEach(img=> img.addEventListener("click", ()=>{ const w = company.wastes.find(x=>x.id===img.dataset.img); openImage(w.photo); }));
    document.querySelectorAll("[data-delwaste]").forEach(b=>b.addEventListener("click", async ()=>{
      if(!confirm("Excluir este registro de desperd\u00edcio?")) return;
      try{ await OperaDB.deleteWaste(b.dataset.delwaste); await refresh(); renderWasteTable(); showToast("Registro exclu\u00eddo."); }
      catch(e){ oops(e); }
    }));
  }

  // ---------------- PONTO ----------------
  function tick(){ document.getElementById("clock-now").textContent = new Date().toLocaleTimeString('pt-BR'); }
  setInterval(tick, 1000); tick();
  function myTodayEntry(){ return company.timesheet.find(r=>r.userId===session && r.date===todayISO()); }
  function renderPonto(){
    const entry = myTodayEntry();
    const btn = document.getElementById("btn-clock"); const statusEl = document.getElementById("clock-status");
    btn.disabled = false; btn.style.opacity = 1;
    if(!entry){ btn.textContent = "Bater ponto (Entrada)"; btn.className="btn btn-accent clock-btn"; btn.style.background=""; statusEl.textContent = "Você ainda não bateu o ponto hoje."; }
    else if(entry.clockIn && !entry.clockOut){ btn.textContent = "Bater ponto (Saída)"; btn.className="btn btn-primary clock-btn"; btn.style.background="var(--danger)"; statusEl.textContent = `Entrada registrada às ${entry.clockIn}.`; }
    else { btn.textContent = "Ponto do dia encerrado"; btn.disabled = true; btn.style.opacity=.5; statusEl.textContent = `Hoje: ${entry.clockIn} → ${entry.clockOut}`; }

    const today = todayISO();
    const todayEntries = company.timesheet.filter(r=>r.date===today);
    document.getElementById("ponto-resumo-hoje").innerHTML = todayEntries.length? todayEntries.map(r=>`
      <div class="bar-row" style="align-items:center;"><div class="bar-label" style="width:140px;">${esc(userName(r.userId))}</div>
      <div style="flex:1; font-size:13px; color:var(--ink-soft);">${r.clockIn||"—"} → ${r.clockOut||"em andamento"}</div>
      <div>${r.clockOut? statusBadge("concluido") : `<span class="badge badge-warn">● Ativo</span>`}</div></div>`).join("") : `<div class="empty-state">Ninguém bateu ponto hoje ainda.</div>`;

    const sel = document.getElementById("ponto-filter-user"); const current = sel.value;
    sel.innerHTML = `<option value="todos">Todos os colaboradores</option>` + company.users.map(u=>`<option value="${u.id}">${esc(u.name)}</option>`).join("");
    sel.value = current || "todos";
    renderPontoTable();
  }
  function calcHours(clockIn, clockOut){ if(!clockIn || !clockOut) return "—"; const mins = minutesBetween(clockIn, clockOut); return `${Math.floor(mins/60)}h${String(mins%60).padStart(2,"0")}`; }
  function renderPontoTable(){
    const userF = document.getElementById("ponto-filter-user").value;
    const dateF = document.getElementById("ponto-filter-date").value;
    let rows = company.timesheet.filter(r=>{ if(userF!=="todos" && r.userId!==userF) return false; if(dateF && r.date!==dateF) return false; return true; }).sort((a,b)=> b.date.localeCompare(a.date));
    document.getElementById("ponto-empty").style.display = rows.length?"none":"block";
    document.getElementById("ponto-table").innerHTML = rows.map(r=>{
      let localBadge = `<span class="badge badge-neutral">—</span>`;
      if(r.geo){ localBadge = r.geo.withinFence ? `<span class="badge badge-ok" title="${r.geo.distance}m do centro">📍 Na área</span>` : `<span class="badge badge-danger" title="${r.geo.distance}m do centro">📍 Fora</span>`; }
      return `<tr>
        <td>${r.photo? `<img src="${r.photo}" class="thumb" data-imgponto="${r.id}">` : `<div class="thumb-placeholder">—</div>`}</td>
        <td style="font-weight:600;">${esc(userName(r.userId))}</td><td>${esc(shiftName(r.shift))}</td><td>${localBadge}</td>
        <td>${fmtDate(r.date)}</td><td>${r.clockIn||"—"}</td><td>${r.clockOut||"—"}</td>
        <td>${calcHours(r.clockIn,r.clockOut)}</td>
        <td>${r.clockOut? statusBadge("concluido") : `<span class="badge badge-warn">● Em andamento</span>`}</td>
      </tr>`;
    }).join("");
    document.querySelectorAll("[data-imgponto]").forEach(img=> img.addEventListener("click", ()=>{ const r = company.timesheet.find(x=>x.id===img.dataset.imgponto); openImage(r.photo); }));
  }
  document.getElementById("ponto-filter-user").addEventListener("change", renderPontoTable);
  document.getElementById("ponto-filter-date").addEventListener("change", renderPontoTable);
  document.getElementById("btn-clock").addEventListener("click", async ()=>{
    const entry = myTodayEntry();
    const u = company.users.find(x=>x.id===session);
    const btn = document.getElementById("btn-clock");
    btn.disabled = true;
    try{
      if(!entry){
        await OperaDB.clockIn({ shiftId: (u && u.shift) || null, geo: null });
        showToast("Entrada registrada \u00e0s " + nowTime() + ".");
      } else if(entry.clockIn && !entry.clockOut){
        await OperaDB.clockOut(entry.id, null);
        showToast("Sa\u00edda registrada \u00e0s " + nowTime() + ".");
      }
      await refresh(); renderPonto();
    }catch(e){ oops(e); btn.disabled = false; }
  });

  // ---------------- RELATORIOS ----------------
  function renderRelatorios(){
    const total = company.checklists.length;
    const done = company.checklists.filter(t=>computeStatus(t)==="concluido").length;
    const late = company.checklists.filter(t=>computeStatus(t)==="atrasado").length;
    const rate = total? Math.round(done/total*100) : 0;
    document.getElementById("rep-summary").innerHTML = `
      <div class="kpi-grid" style="margin-bottom:0;">
        <div class="kpi-card"><div class="kpi-label">Taxa de conclusão</div><div class="kpi-num">${rate}%</div><div class="kpi-sub">${done} de ${total} tarefas</div></div>
        <div class="kpi-card accent-danger"><div class="kpi-label">Tarefas atrasadas</div><div class="kpi-num">${late}</div><div class="kpi-sub">requerem atenção</div></div>
        <div class="kpi-card accent-steel"><div class="kpi-label">Registros de ponto</div><div class="kpi-num">${company.timesheet.length}</div><div class="kpi-sub">no total</div></div>
        <div class="kpi-card accent-warn"><div class="kpi-label">Desperdícios registrados</div><div class="kpi-num">${company.wastes.length}</div><div class="kpi-sub">no total</div></div>
      </div>`;
    const sel = document.getElementById("comp-filter-user"); const current = sel.value;
    sel.innerHTML = `<option value="todos">Todos os colaboradores</option>` + company.users.map(u=>`<option value="${u.id}">${esc(u.name)}</option>`).join("");
    sel.value = current || "todos";
    renderCompletionsTable();
    renderRoleReport();
  }
  function downloadCSV(filename, rows){
    const csv = rows.map(r => r.map(v => `"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\r\n");
    const blob = new Blob(["\uFEFF"+csv], {type:"text/csv;charset=utf-8;"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  }
  document.getElementById("btn-export-checklist").addEventListener("click", ()=>{
    const typeF = document.getElementById("rep-checklist-type").value; const statusF = document.getElementById("rep-checklist-status").value;
    let rows = company.checklists.filter(t=>{ if(typeF!=="todos" && t.type!==typeF) return false; const s = computeStatus(t); if(statusF!=="todos" && s!==statusF) return false; return true; });
    const header = ["Título","Tipo","Área","Responsável","Turno","Prazo","Status","Concluído em"];
    const data = rows.map(t=>[t.title, t.type==="limpeza"?"Limpeza":"Manutenção", t.area, userName(t.responsible), shiftName(t.shift), fmtDate(t.due), STATUS_LABEL[computeStatus(t)], t.completedAt? new Date(t.completedAt).toLocaleString('pt-BR') : ""]);
    downloadCSV(`relatorio-checklist-${todayISO()}.csv`, [header, ...data]);
    showToast("Relatório exportado.");
  });
  document.getElementById("btn-export-ponto").addEventListener("click", ()=>{
    const from = document.getElementById("rep-ponto-from").value; const to = document.getElementById("rep-ponto-to").value;
    let rows = company.timesheet.filter(r=>{ if(from && r.date<from) return false; if(to && r.date>to) return false; return true; });
    const header = ["Colaborador","Turno","Data","Entrada","Saída","Total de horas"];
    const data = rows.map(r=>[userName(r.userId), shiftName(r.shift), fmtDate(r.date), r.clockIn||"", r.clockOut||"", calcHours(r.clockIn,r.clockOut)]);
    downloadCSV(`relatorio-ponto-${todayISO()}.csv`, [header, ...data]);
    showToast("Relatório exportado.");
  });
  document.getElementById("btn-export-waste").addEventListener("click", ()=>{
    const from = document.getElementById("rep-waste-from").value; const to = document.getElementById("rep-waste-to").value;
    let rows = company.wastes.filter(w=>{ if(from && w.date<from) return false; if(to && w.date>to) return false; return true; });
    const header = ["Item","Quantidade","Unidade","Motivo","Registrado por","Data"];
    const data = rows.map(w=>[w.item, w.quantity, w.unit, w.reason, userName(w.userId), fmtDate(w.date)]);
    downloadCSV(`relatorio-desperdicio-${todayISO()}.csv`, [header, ...data]);
    showToast("Relatório exportado. As fotos ficam disponíveis dentro do sistema.");
  });
  function getCompletionFilters(){
    return { user: document.getElementById("comp-filter-user").value, date: document.getElementById("comp-filter-date").value, from: document.getElementById("comp-filter-from").value, to: document.getElementById("comp-filter-to").value };
  }
  function filterCompletions(){
    const f = getCompletionFilters();
    return company.completions.filter(c=>{
      if(f.user!=="todos" && c.userId!==f.user) return false;
      if(f.date){ if(c.date!==f.date) return false; } else { if(f.from && c.date<f.from) return false; if(f.to && c.date>f.to) return false; }
      return true;
    }).sort((a,b)=> (b.date+b.time).localeCompare(a.date+a.time));
  }
  function completionStatusBadge(status){
    if(status==="aprovado") return `<span class="badge badge-ok">Aprovado</span>`;
    if(status==="reprovado") return `<span class="badge badge-danger">Reprovado</span>`;
    return `<span class="badge badge-info">Aguardando</span>`;
  }
  function renderCompletionsTable(){
    const rows = filterCompletions();
    document.getElementById("comp-empty").style.display = rows.length? "none":"block";
    document.getElementById("comp-table").innerHTML = rows.map(c=>`
      <tr>
        <td>${c.photo? `<img src="${c.photo}" class="thumb" data-imgcomp="${c.id}">` : `<div class="thumb-placeholder">—</div>`}</td>
        <td style="font-weight:600;">${esc(userName(c.userId))}</td><td>${fmtDate(c.date)}</td><td>${c.time}</td>
        <td>${esc(c.title)}</td><td>${esc(c.area)}</td><td>${completionStatusBadge(c.status)}</td>
        <td style="color:var(--ink-soft);">${esc(c.notes||"—")}${c.status==="reprovado" && c.rejectionReason? ` <span style="color:var(--danger);">(${esc(c.rejectionReason)})</span>`:""}</td>
      </tr>`).join("");
    document.querySelectorAll("[data-imgcomp]").forEach(img=> img.addEventListener("click", ()=>{ const c = company.completions.find(x=>x.id===img.dataset.imgcomp); openImage(c.photo); }));
  }
  ["comp-filter-user","comp-filter-date","comp-filter-from","comp-filter-to"].forEach(id=>{ document.getElementById(id).addEventListener("change", renderCompletionsTable); });
  document.getElementById("comp-filter-clear").addEventListener("click", ()=>{
    document.getElementById("comp-filter-user").value = "todos"; document.getElementById("comp-filter-date").value = "";
    document.getElementById("comp-filter-from").value = ""; document.getElementById("comp-filter-to").value = "";
    renderCompletionsTable();
  });
  document.getElementById("btn-export-completions").addEventListener("click", ()=>{
    const rows = filterCompletions();
    const header = ["Colaborador","Data","Hora","Tarefa","Área","Status","Observação"];
    const data = rows.map(c=>[userName(c.userId), fmtDate(c.date), c.time, c.title, c.area, c.status, c.notes||""]);
    downloadCSV(`finalizacoes-checklist-${todayISO()}.csv`, [header, ...data]);
    showToast("Relatório exportado. As fotos ficam disponíveis dentro do sistema.");
  });
  function renderRoleReport(){
    const roles = ["admin","gestor","colaborador"];
    const labels = {admin:"Administrador", gestor:"Gestor", colaborador:"Colaborador"};
    let html = `<thead><tr><th>Função</th><th>Usuários</th><th>Tarefas aprovadas</th><th>Desperdícios</th><th>Registros de ponto</th></tr></thead><tbody>`;
    roles.forEach(r=>{
      const ids = company.users.filter(u=>u.role===r).map(u=>u.id);
      const completed = company.completions.filter(c=>c.status==="aprovado" && ids.includes(c.userId)).length;
      const wastes = company.wastes.filter(w=>ids.includes(w.userId)).length;
      const punches = company.timesheet.filter(t=>ids.includes(t.userId)).length;
      html += `<tr><td style="font-weight:600;">${labels[r]}</td><td>${ids.length}</td><td>${completed}</td><td>${wastes}</td><td>${punches}</td></tr>`;
    });
    html += `</tbody>`;
    document.getElementById("role-report").innerHTML = html;
  }

  // ---------------- USUARIOS & TURNOS ----------------
  function renderShifts(){
    document.getElementById("shifts-table").innerHTML = company.shifts.map(s=>`
      <tr><td style="font-weight:600;">${esc(s.name)}</td><td>${s.start}</td><td>${s.end}</td>
      <td><button class="icon-btn" data-delshift="${s.id}" title="Remover">🗑</button></td></tr>`).join("") || `<tr><td colspan="4" class="empty-state">Nenhum turno cadastrado.</td></tr>`;
    document.querySelectorAll("[data-delshift]").forEach(b=>b.addEventListener("click", async ()=>{
      if(!confirm("Remover este turno? Usu\u00e1rios e tarefas ligados a ele ficar\u00e3o sem turno definido.")) return;
      try{
        await OperaDB.deleteShift(b.dataset.delshift);
        await refresh(); renderShifts(); renderUsuarios();
        showToast("Turno removido.");
      }catch(e){ oops(e); }
    }));
  }
  document.getElementById("btn-new-shift").addEventListener("click", ()=>{
    document.getElementById("shift-name").value = ""; document.getElementById("shift-start").value = ""; document.getElementById("shift-end").value = "";
    document.getElementById("modal-shift").classList.add("active");
  });
  document.getElementById("shift-save").addEventListener("click", async ()=>{
    const name = document.getElementById("shift-name").value.trim();
    const start = document.getElementById("shift-start").value; const end = document.getElementById("shift-end").value;
    if(!name || !start || !end){ showToast("Preencha nome, in\u00edcio e fim."); return; }
    try{
      await OperaDB.saveShift({ name, start, end });
      await refresh();
      document.getElementById("modal-shift").classList.remove("active");
      renderShifts();
      showToast("Turno criado.");
    }catch(e){ oops(e); }
  });
  function renderUsuarios(){
    const roleLabel = {admin:"Administrador", gestor:"Gestor", colaborador:"Colaborador"};
    document.getElementById("usuarios-table").innerHTML = company.users.map(u=>`
      <tr><td style="font-weight:600;">${esc(u.name)}</td><td style="color:var(--ink-soft);">@${esc(u.username)}</td>
      <td><span class="badge badge-neutral">${roleLabel[u.role]||u.role}</span></td>
      <td>${esc(userShiftLabel(u))}</td><td>${esc(u.position||"—")}</td>
      <td><div class="row-actions"><button class="icon-btn" data-deluser="${u.id}" title="Remover" ${u.id===session?"disabled":""}>🗑</button></div></td></tr>`).join("");
    document.querySelectorAll("[data-deluser]").forEach(b=>b.addEventListener("click", async ()=>{
      if(!confirm("Desativar este usu\u00e1rio? Ele perde o acesso, mas o hist\u00f3rico dele continua nos relat\u00f3rios.")) return;
      try{ await OperaDB.deactivateUser(b.dataset.deluser); await refresh(); renderUsuarios(); showToast("Usu\u00e1rio desativado."); }
      catch(e){ oops(e); }
    }));
  }
  function fillUserShiftSelect(){ document.getElementById("user-shift").innerHTML = `<option value="">Sem turno fixo</option>` + company.shifts.map(s=>`<option value="${s.id}">${esc(s.name)} (${s.start}–${s.end})</option>`).join(""); }
  document.getElementById("btn-new-user").addEventListener("click", ()=>{
    ["user-name","user-email","user-position"].forEach(id=>document.getElementById(id).value="");
    document.getElementById("invite-result").style.display = "none";
    document.getElementById("user-role").value = "colaborador";
    fillUserShiftSelect();
    document.getElementById("modal-user").classList.add("active");
  });
  document.getElementById("user-save").addEventListener("click", async ()=>{
    const name = document.getElementById("user-name").value.trim();
    const email = document.getElementById("user-email").value.trim();
    if(!name || !email){ showToast("Preencha nome e e-mail."); return; }
    const btn = document.getElementById("user-save");
    btn.disabled = true; btn.textContent = "Gerando...";
    try{
      const inv = await OperaDB.createInvite({
        name, email,
        position: document.getElementById("user-position").value.trim(),
        role: document.getElementById("user-role").value,
        shiftId: document.getElementById("user-shift").value
      });
      const box = document.getElementById("invite-result");
      box.style.display = "block";
      box.innerHTML = '<div style="font-size:12px; color:var(--ink-soft); margin-bottom:6px;">C\u00f3digo de convite para ' + esc(name) + '</div>' +
                      '<div style="font-size:26px; font-weight:700; letter-spacing:3px;">' + esc(inv.code) + '</div>' +
                      '<div style="font-size:12px; color:var(--ink-soft); margin-top:8px;">Vale 14 dias. O funcion\u00e1rio usa em "Ativar minha conta", com o e-mail ' + esc(email) + '.</div>';
      showToast("Convite gerado.");
    }catch(e){ oops(e); }
    finally{ btn.disabled = false; btn.textContent = "Gerar convite"; }
  });

  // ---------------- CONFIGURACOES ----------------
  function renderConfiguracoes(){
    renderPermTable();
    renderAlertsConfig();
    const g = company.settings.geofence;
    document.getElementById("geo-enabled").checked = g.enabled;
    document.getElementById("geo-lat").value = g.lat!=null? g.lat.toFixed(6):"";
    document.getElementById("geo-lng").value = g.lng!=null? g.lng.toFixed(6):"";
    document.getElementById("geo-radius").value = g.radius;
  }
  function renderPermTable(){
    const caps = [
      ["verDashboard","Ver dashboard"], ["gerenciarTarefas","Criar/editar/excluir tarefas"],
      ["concluirTarefas","Concluir tarefas do checklist"], ["registrarDesperdicio","Registrar desperdício"],
      ["aprovarChecklists","Aprovar checklists de outros"], ["verRelatorios","Ver relatórios"],
      ["gerenciarUsuarios","Gerenciar usuários e turnos"],
    ];
    let html = `<thead><tr><th>Permissão</th><th>Gestor</th><th>Colaborador</th></tr></thead><tbody>`;
    caps.forEach(([key,label])=>{
      html += `<tr><td>${label}</td>
        <td><input type="checkbox" data-perm="gestor:${key}" ${company.permissions.gestor[key]?"checked":""}></td>
        <td><input type="checkbox" data-perm="colaborador:${key}" ${company.permissions.colaborador[key]?"checked":""}></td></tr>`;
    });
    html += `</tbody>`;
    document.getElementById("perm-table").innerHTML = html;
    document.querySelectorAll("[data-perm]").forEach(cb=>{
      cb.addEventListener("change", async ()=>{
        const [role,key] = cb.dataset.perm.split(":");
        company.permissions[role][key] = cb.checked;
        try{ await OperaDB.savePermissions(company.permissions); showToast("Permiss\u00e3o atualizada."); }
        catch(e){ oops(e); cb.checked = !cb.checked; company.permissions[role][key] = cb.checked; }
      });
    });
  }
  function renderAlertsConfig(){
    const triggers = [["atraso","Tarefa atrasada"],["pontoAberto","Turno aberto por muito tempo"],["aprovacaoPendente","Checklist aguardando aprovação"]];
    document.getElementById("alerts-config").innerHTML = triggers.map(([key,label])=>`
      <div class="toggle-row"><div>${label}</div><div class="toggle-opts">
        <label><input type="checkbox" data-alert="${key}:app" ${company.settings.alerts[key].app?"checked":""}> App</label>
        <label><input type="checkbox" data-alert="${key}:email" ${company.settings.alerts[key].email?"checked":""}> E-mail</label>
      </div></div>`).join("") + `<div class="field-hint">O envio de e-mail é apenas uma preferência salva neste protótipo — disparos reais exigem integração de e-mail no backend.</div>`;
    document.querySelectorAll("[data-alert]").forEach(cb=>{
      cb.addEventListener("change", async ()=>{
        const [key,channel] = cb.dataset.alert.split(":");
        company.settings.alerts[key][channel] = cb.checked;
        try{ await OperaDB.saveSettings(company.settings); }
        catch(e){ oops(e); cb.checked = !cb.checked; company.settings.alerts[key][channel] = cb.checked; }
      });
    });
  }
  document.getElementById("geo-capture").addEventListener("click", ()=>{
    if(!navigator.geolocation){ showToast("Geolocalização não suportada neste navegador."); return; }
    navigator.geolocation.getCurrentPosition((pos)=>{
      document.getElementById("geo-lat").value = pos.coords.latitude.toFixed(6);
      document.getElementById("geo-lng").value = pos.coords.longitude.toFixed(6);
      showToast("Localização capturada.");
    }, ()=> showToast("Não foi possível obter sua localização."), {timeout:8000});
  });
  document.getElementById("geo-save").addEventListener("click", async ()=>{
    company.settings.geofence = {
      enabled: document.getElementById("geo-enabled").checked,
      lat: parseFloat(document.getElementById("geo-lat").value) || null,
      lng: parseFloat(document.getElementById("geo-lng").value) || null,
      radius: parseInt(document.getElementById("geo-radius").value) || 150,
    };
    try{ await OperaDB.saveSettings(company.settings); showToast("Cerca digital salva."); }
    catch(e){ oops(e); }
  });

  // ---------------- CHECKLIST POR IMAGEM ----------------
  document.getElementById("btn-new-image-checklist").addEventListener("click", ()=>{
    icPins = []; icImageDataUrl = null;
    document.getElementById("ic-title").value = ""; document.getElementById("ic-area").value = ""; document.getElementById("ic-type").value = "limpeza";
    document.getElementById("ic-placeholder").style.display = "block";
    document.getElementById("ic-image-wrap").style.display = "none";
    document.getElementById("ic-image-wrap").innerHTML = "";
    document.getElementById("ic-pins-list").innerHTML = "";
    document.getElementById("ic-image-input").value = "";
    document.getElementById("modal-imgchecklist").classList.add("active");
  });
  document.getElementById("ic-image-trigger").addEventListener("click", ()=> document.getElementById("ic-image-input").click());
  document.getElementById("ic-image-input").addEventListener("change", async (e)=>{
    const file = e.target.files[0]; if(!file) return;
    icImageDataUrl = await fileToCompressedDataURL(file, 900, 0.75);
    icPins = [];
    renderIcImage();
  });
  function renderIcImage(){
    document.getElementById("ic-placeholder").style.display = "none";
    const wrap = document.getElementById("ic-image-wrap");
    wrap.style.display = "block";
    wrap.innerHTML = `<img src="${icImageDataUrl}" style="width:100%; border-radius:8px; display:block;">` + icPins.map((p,i)=>`<div class="pin-marker" style="left:${p.x}%; top:${p.y}%;">${i+1}</div>`).join("");
    wrap.onclick = (e)=>{
      const rect = wrap.getBoundingClientRect();
      const x = ((e.clientX-rect.left)/rect.width*100).toFixed(1);
      const y = ((e.clientY-rect.top)/rect.height*100).toFixed(1);
      const label = window.prompt("Nome deste item do checklist (ex: Verificar extintor):");
      if(!label) return;
      icPins.push({id:uid(), x:parseFloat(x), y:parseFloat(y), label});
      renderIcImage();
    };
    renderIcPinsList();
  }
  function renderIcPinsList(){
    document.getElementById("ic-pins-list").innerHTML = icPins.length? (`<div class="field-hint" style="margin-bottom:6px;">${icPins.length} item(ns) marcado(s):</div>` +
      icPins.map((p,i)=>`<div class="bar-row"><div style="flex:1;">${i+1}. ${esc(p.label)}</div><button class="icon-btn" data-rmpin="${p.id}">✕</button></div>`).join("")) : "";
    document.querySelectorAll("[data-rmpin]").forEach(b=> b.addEventListener("click", ()=>{ icPins = icPins.filter(p=>p.id!==b.dataset.rmpin); renderIcImage(); }));
  }
  document.getElementById("ic-save").addEventListener("click", async ()=>{
    const title = document.getElementById("ic-title").value.trim();
    const area = document.getElementById("ic-area").value.trim();
    const type = document.getElementById("ic-type").value;
    if(!title || !area || !icImageDataUrl || icPins.length===0){ showToast("Preencha t\u00edtulo, \u00e1rea, imagem e marque ao menos um item."); return; }
    const btn = document.getElementById("ic-save");
    btn.disabled = true; btn.textContent = "Salvando...";
    try{
      await OperaDB.saveImageChecklist({ title, imageDataUrl: icImageDataUrl, pins: icPins, type, area });
      await refresh();
      document.getElementById("modal-imgchecklist").classList.remove("active");
      renderChecklist();
      showToast("Checklist por imagem criado com " + icPins.length + " item(ns).");
    }catch(e){ oops(e); }
    finally{ btn.disabled = false; btn.textContent = "Criar checklist"; }
  });
  function openImageChecklistView(taskId){
    const t = company.checklists.find(x=>x.id===taskId); if(!t || !t.imageRef) return;
    const ic = company.imageChecklists.find(x=>x.id===t.imageRef.checklistImageId); if(!ic) return;
    document.getElementById("icv-title").textContent = ic.title;
    document.getElementById("icv-image-wrap").innerHTML = `<img src="${ic.image}" style="width:100%; border-radius:8px; display:block;">` +
      ic.pins.map((p,i)=> `<div class="pin-marker ${p.id===t.imageRef.pinId?'':'muted'}" style="left:${p.x}%; top:${p.y}%;">${i+1}</div>`).join("");
    document.getElementById("modal-imgview").classList.add("active");
  }

  // ---------------- MODAL CLOSE ----------------
  document.querySelectorAll("[data-close]").forEach(b=> b.addEventListener("click", ()=> document.getElementById(b.dataset.close).classList.remove("active")));
  document.querySelectorAll(".modal-backdrop").forEach(m=> m.addEventListener("click", (e)=>{ if(e.target===m) m.classList.remove("active"); }));

  init();

  // ---------------- PWA: instalar na tela inicial ----------------
  if("serviceWorker" in navigator){
    window.addEventListener("load", ()=>{
      navigator.serviceWorker.register("/sw.js").catch(()=>{});
    });
  }
})();
