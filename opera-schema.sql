-- ============================================================================
-- OPERA — Schema multiempresa (Supabase / PostgreSQL)
-- Cole TUDO isso no SQL Editor do Supabase e rode uma vez.
-- Pode rodar de novo sem quebrar (tudo é "if not exists" / "or replace").
-- ============================================================================

create extension if not exists pgcrypto;

-- ============================================================================
-- 1. TABELAS
-- ============================================================================

-- ---------- EMPRESAS ----------
create table if not exists public.companies (
  id           uuid primary key default gen_random_uuid(),
  cnpj_digits  text not null unique,          -- só números, sem pontuação
  cnpj         text not null,                 -- formatado, como o usuário digitou
  code         text not null unique,          -- o seu genCompanyCode(), ex: HOTE4821
  name         text not null,
  legal_name   text,
  email        text,
  phone        text,
  address      text,
  logo_url     text,
  plan         text not null default 'trial',
  status       text not null default 'ativa' check (status in ('ativa','suspensa','cancelada')),
  -- estes dois continuam como JSON: são config de UI, não dado transacional.
  -- Equivalem ao seu defaultPermissions() e defaultSettings().
  permissions  jsonb not null default '{
    "admin":       {"verDashboard":true,"gerenciarTarefas":true,"concluirTarefas":true,"registrarDesperdicio":true,"aprovarChecklists":true,"verRelatorios":true,"gerenciarUsuarios":true},
    "gestor":      {"verDashboard":true,"gerenciarTarefas":true,"concluirTarefas":false,"registrarDesperdicio":false,"aprovarChecklists":true,"verRelatorios":true,"gerenciarUsuarios":false},
    "colaborador": {"verDashboard":false,"gerenciarTarefas":false,"concluirTarefas":true,"registrarDesperdicio":true,"aprovarChecklists":false,"verRelatorios":false,"gerenciarUsuarios":false}
  }'::jsonb,
  settings     jsonb not null default '{
    "geofence": {"enabled":false,"lat":null,"lng":null,"radius":150},
    "alerts": {
      "atraso":            {"app":true,"email":false},
      "pontoAberto":       {"app":true,"email":false},
      "aprovacaoPendente": {"app":true,"email":false}
    }
  }'::jsonb,
  created_at   timestamptz not null default now()
);

-- ---------- TURNOS ----------
create table if not exists public.shifts (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name       text not null,
  start_time time not null,
  end_time   time not null,
  created_at timestamptz not null default now()
);

-- ---------- USUÁRIOS (perfil ligado ao Supabase Auth) ----------
-- IMPORTANTE: a senha NÃO fica aqui. Fica em auth.users, criptografada pelo
-- Supabase. Esta tabela só guarda quem é a pessoa e de que empresa ela é.
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  name       text not null,
  email      text not null,
  phone      text,
  position   text,                            -- seu campo "position" (cargo)
  role       text not null default 'colaborador' check (role in ('admin','gestor','colaborador')),
  is_owner   boolean not null default false,   -- proprietário da conta (só 1 por empresa)
  shift_id   uuid references public.shifts(id) on delete set null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- CONVITES (para criar funcionário sem Edge Function) ----------
create table if not exists public.invites (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  email      text not null,
  name       text not null,
  position   text,
  role       text not null default 'colaborador' check (role in ('admin','gestor','colaborador')),
  shift_id   uuid references public.shifts(id) on delete set null,
  code       text not null unique,
  used_at    timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days'
);

-- ---------- TAREFAS (seu company.checklists) ----------
create table if not exists public.tasks (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id) on delete cascade,
  title              text not null,
  type               text not null default 'limpeza',
  area               text,
  responsible_id     uuid references public.profiles(id) on delete set null,
  shift_id           uuid references public.shifts(id) on delete set null,
  frequency          text not null default 'unica' check (frequency in ('unica','diaria','semanal','mensal')),
  priority           text not null default 'normal' check (priority in ('baixa','normal','alta')),
  due_date           date,
  status             text not null default 'pendente' check (status in ('pendente','concluido','atrasado','aguardando_aprovacao')),
  notes              text,
  completed_at       timestamptz,
  -- seu imageRef: {checklistImageId, pinId}
  image_checklist_id uuid,
  image_pin_id       uuid,
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now()
);

-- ---------- FINALIZAÇÕES (seu company.completions) ----------
create table if not exists public.task_completions (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  task_id          uuid references public.tasks(id) on delete set null,
  user_id          uuid not null references public.profiles(id) on delete cascade,
  -- cópia dos dados da tarefa no momento da conclusão (histórico não muda
  -- se a tarefa for editada depois)
  title            text not null,
  type             text,
  area             text,
  work_date        date not null default current_date,
  work_time        time not null default localtime,
  photo_url        text,
  notes            text,
  status           text not null default 'pendente' check (status in ('pendente','aprovado','reprovado')),
  approved_by      uuid references public.profiles(id) on delete set null,
  approved_at      timestamptz,
  rejection_reason text,
  created_at       timestamptz not null default now()
);

-- ---------- PONTO (seu company.timesheet) ----------
create table if not exists public.timesheets (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  shift_id     uuid references public.shifts(id) on delete set null,
  work_date    date not null default current_date,
  clock_in     time,
  clock_out    time,
  entry_photo_url text,
  exit_photo_url  text,
  latitude     double precision,
  longitude    double precision,
  distance_m   integer,
  within_fence boolean,
  created_at   timestamptz not null default now(),
  -- uma pessoa só tem um registro por dia (evita ponto duplicado)
  unique (user_id, work_date)
);

-- ---------- FOTOS DE INÍCIO DE TURNO (seu company.shiftPhotos) ----------
create table if not exists public.shift_photos (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  work_date  date not null default current_date,
  work_time  time not null default localtime,
  photo_url  text not null,
  created_at timestamptz not null default now()
);

-- ---------- DESPERDÍCIO (seu company.wastes) ----------
create table if not exists public.wastes (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  work_date  date not null default current_date,
  item       text not null,
  quantity   numeric(12,3) not null,
  unit       text not null,
  reason     text,
  photo_url  text,
  created_at timestamptz not null default now()
);

-- ---------- CHECKLIST POR IMAGEM (seu company.imageChecklists) ----------
create table if not exists public.image_checklists (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  title      text not null,
  image_url  text not null,
  type       text,
  area       text,
  pins       jsonb not null default '[]'::jsonb,   -- [{id,x,y,label}]
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------- ÍNDICES ----------
create index if not exists idx_profiles_company     on public.profiles(company_id);
create index if not exists idx_shifts_company       on public.shifts(company_id);
create index if not exists idx_tasks_company_status on public.tasks(company_id, status);
create index if not exists idx_tasks_due            on public.tasks(company_id, due_date);
create index if not exists idx_compl_company_status on public.task_completions(company_id, status);
create index if not exists idx_compl_date           on public.task_completions(company_id, work_date);
create index if not exists idx_timesheets_date      on public.timesheets(company_id, work_date);
create index if not exists idx_wastes_date          on public.wastes(company_id, work_date);
create index if not exists idx_invites_code         on public.invites(code);

-- ============================================================================
-- 2. FUNÇÕES AUXILIARES DE SEGURANÇA
--    São SECURITY DEFINER de propósito: elas ignoram RLS e por isso não
--    entram em recursão infinita quando a policy de profiles consulta profiles.
-- ============================================================================

create or replace function public.current_company_id()
returns uuid
language sql stable security definer set search_path = public
as $$ select company_id from public.profiles where id = auth.uid() and active = true $$;

create or replace function public.auth_role()
returns text
language sql stable security definer set search_path = public
as $$ select role from public.profiles where id = auth.uid() and active = true $$;

create or replace function public.is_manager()
returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce(public.auth_role() in ('admin','gestor'), false) $$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce(public.auth_role() = 'admin', false) $$;

-- ============================================================================
-- 3. RPCs — as únicas coisas que o frontend chama fora do CRUD normal
-- ============================================================================

-- ---------- 3.1 Buscar empresa pelo CNPJ (tela 1 do login) ----------
-- Chamável por quem NÃO está logado. Devolve só nome e código: o mínimo
-- para o funcionário confirmar que é a empresa certa. Nada sensível.
create or replace function public.find_company_by_cnpj(p_cnpj text)
returns table (id uuid, name text, code text)
language sql stable security definer set search_path = public
as $$
  select c.id, c.name, c.code
  from public.companies c
  where c.cnpj_digits = regexp_replace(coalesce(p_cnpj,''), '\D', '', 'g')
    and c.status = 'ativa'
  limit 1
$$;

revoke all on function public.find_company_by_cnpj(text) from public;
grant execute on function public.find_company_by_cnpj(text) to anon, authenticated;

-- ---------- 3.2 Criar empresa + virar proprietário ----------
-- Chamada DEPOIS do supabase.auth.signUp(). O usuário já existe no Auth,
-- mas ainda não tem profile. Esta função cria a empresa, os 3 turnos padrão
-- e o profile de admin/proprietário, tudo numa transação só.
create or replace function public.create_company(
  p_cnpj       text,
  p_name       text,
  p_admin_name text,
  p_email      text default null,
  p_phone      text default null
)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_digits  text := regexp_replace(coalesce(p_cnpj,''), '\D', '', 'g');
  v_code    text;
  v_company uuid;
begin
  if v_uid is null then
    raise exception 'Não autenticado.';
  end if;
  if exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'Este usuário já pertence a uma empresa.';
  end if;
  if length(v_digits) <> 14 then
    raise exception 'CNPJ inválido.';
  end if;
  if exists (select 1 from public.companies where cnpj_digits = v_digits) then
    raise exception 'Já existe uma empresa cadastrada com este CNPJ.';
  end if;

  -- mesma lógica do seu genCompanyCode(): 4 letras + 4 dígitos
  v_code := upper(substring(regexp_replace(
              translate(p_name, 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
                                'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'),
              '[^A-Za-z]', '', 'g'), 1, 4));
  if v_code is null or v_code = '' then v_code := 'EMP'; end if;
  v_code := v_code || lpad((1000 + floor(random()*9000))::int::text, 4, '0');

  insert into public.companies (cnpj_digits, cnpj, code, name, email, phone)
  values (v_digits, p_cnpj, v_code, p_name, p_email, p_phone)
  returning id into v_company;

  insert into public.shifts (company_id, name, start_time, end_time) values
    (v_company, 'Manhã', '06:00', '14:00'),
    (v_company, 'Tarde', '14:00', '22:00'),
    (v_company, 'Noite', '22:00', '06:00');

  insert into public.profiles (id, company_id, name, email, role, is_owner, position)
  values (v_uid, v_company, p_admin_name,
          coalesce((select email from auth.users where id = v_uid), p_email),
          'admin', true, 'Administração');

  return json_build_object('company_id', v_company, 'code', v_code);
end;
$$;

revoke all on function public.create_company(text,text,text,text,text) from public;
grant execute on function public.create_company(text,text,text,text,text) to authenticated;

-- ---------- 3.3 Aceitar convite (funcionário ativa a própria conta) ----------
-- Chamada depois do signUp do funcionário. O e-mail do convite TEM que bater
-- com o e-mail autenticado — senão um código vazado viraria porta de entrada.
create or replace function public.accept_invite(p_code text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_inv   public.invites%rowtype;
begin
  if v_uid is null then
    raise exception 'Não autenticado.';
  end if;
  if exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'Este usuário já pertence a uma empresa.';
  end if;

  select email into v_email from auth.users where id = v_uid;

  select * into v_inv from public.invites
   where code = upper(trim(p_code)) and used_at is null and expires_at > now();

  if not found then
    raise exception 'Convite inválido, já usado ou expirado.';
  end if;
  if lower(v_inv.email) <> lower(v_email) then
    raise exception 'Este convite foi emitido para outro e-mail.';
  end if;

  insert into public.profiles (id, company_id, name, email, position, role, shift_id)
  values (v_uid, v_inv.company_id, v_inv.name, v_email, v_inv.position, v_inv.role, v_inv.shift_id);

  update public.invites set used_at = now() where id = v_inv.id;

  return json_build_object('company_id', v_inv.company_id, 'role', v_inv.role);
end;
$$;

revoke all on function public.accept_invite(text) from public;
grant execute on function public.accept_invite(text) to authenticated;

-- ============================================================================
-- 4. ROW LEVEL SECURITY
--    Esta é a parte que realmente protege. Esconder botão no frontend não é
--    segurança — aqui é onde o Hotel A deixa de enxergar o Hotel B.
-- ============================================================================

alter table public.companies        enable row level security;
alter table public.profiles         enable row level security;
alter table public.shifts           enable row level security;
alter table public.invites          enable row level security;
alter table public.tasks            enable row level security;
alter table public.task_completions enable row level security;
alter table public.timesheets       enable row level security;
alter table public.shift_photos     enable row level security;
alter table public.wastes           enable row level security;
alter table public.image_checklists enable row level security;

-- ---------- COMPANIES ----------
drop policy if exists companies_select on public.companies;
create policy companies_select on public.companies
  for select to authenticated
  using (id = public.current_company_id());

drop policy if exists companies_update on public.companies;
create policy companies_update on public.companies
  for update to authenticated
  using (id = public.current_company_id() and public.is_admin())
  with check (id = public.current_company_id());
-- INSERT só via create_company(). Não existe policy de insert de propósito.

-- ---------- PROFILES ----------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (company_id = public.current_company_id());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin on public.profiles
  for update to authenticated
  using (company_id = public.current_company_id() and public.is_admin())
  with check (company_id = public.current_company_id());

drop policy if exists profiles_delete_admin on public.profiles;
create policy profiles_delete_admin on public.profiles
  for delete to authenticated
  using (company_id = public.current_company_id() and public.is_admin() and is_owner = false);

-- ---------- SHIFTS ----------
drop policy if exists shifts_select on public.shifts;
create policy shifts_select on public.shifts
  for select to authenticated using (company_id = public.current_company_id());

drop policy if exists shifts_write on public.shifts;
create policy shifts_write on public.shifts
  for all to authenticated
  using (company_id = public.current_company_id() and public.is_admin())
  with check (company_id = public.current_company_id() and public.is_admin());

-- ---------- INVITES ----------
drop policy if exists invites_admin on public.invites;
create policy invites_admin on public.invites
  for all to authenticated
  using (company_id = public.current_company_id() and public.is_admin())
  with check (company_id = public.current_company_id() and public.is_admin());

-- ---------- TASKS ----------
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks
  for select to authenticated using (company_id = public.current_company_id());

drop policy if exists tasks_manage on public.tasks;
create policy tasks_manage on public.tasks
  for all to authenticated
  using (company_id = public.current_company_id() and public.is_manager())
  with check (company_id = public.current_company_id() and public.is_manager());

-- colaborador não cria nem apaga tarefa, mas o status muda quando ele conclui
drop policy if exists tasks_update_status on public.tasks;
create policy tasks_update_status on public.tasks
  for update to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ---------- TASK_COMPLETIONS ----------
drop policy if exists compl_select on public.task_completions;
create policy compl_select on public.task_completions
  for select to authenticated
  using (
    company_id = public.current_company_id()
    and (public.is_manager() or user_id = auth.uid())
  );

drop policy if exists compl_insert on public.task_completions;
create policy compl_insert on public.task_completions
  for insert to authenticated
  with check (company_id = public.current_company_id() and user_id = auth.uid());

drop policy if exists compl_approve on public.task_completions;
create policy compl_approve on public.task_completions
  for update to authenticated
  using (company_id = public.current_company_id() and public.is_manager())
  with check (company_id = public.current_company_id());

-- ---------- TIMESHEETS ----------
drop policy if exists ts_select on public.timesheets;
create policy ts_select on public.timesheets
  for select to authenticated
  using (
    company_id = public.current_company_id()
    and (public.is_manager() or user_id = auth.uid())
  );

drop policy if exists ts_insert on public.timesheets;
create policy ts_insert on public.timesheets
  for insert to authenticated
  with check (company_id = public.current_company_id() and user_id = auth.uid());

-- o funcionário só mexe no próprio ponto; gestor pode corrigir o da equipe
drop policy if exists ts_update on public.timesheets;
create policy ts_update on public.timesheets
  for update to authenticated
  using (company_id = public.current_company_id() and (user_id = auth.uid() or public.is_manager()))
  with check (company_id = public.current_company_id());

-- ---------- SHIFT_PHOTOS ----------
drop policy if exists sp_select on public.shift_photos;
create policy sp_select on public.shift_photos
  for select to authenticated
  using (company_id = public.current_company_id() and (public.is_manager() or user_id = auth.uid()));

drop policy if exists sp_insert on public.shift_photos;
create policy sp_insert on public.shift_photos
  for insert to authenticated
  with check (company_id = public.current_company_id() and user_id = auth.uid());

-- ---------- WASTES ----------
drop policy if exists wastes_select on public.wastes;
create policy wastes_select on public.wastes
  for select to authenticated using (company_id = public.current_company_id());

drop policy if exists wastes_insert on public.wastes;
create policy wastes_insert on public.wastes
  for insert to authenticated
  with check (company_id = public.current_company_id() and user_id = auth.uid());

drop policy if exists wastes_delete on public.wastes;
create policy wastes_delete on public.wastes
  for delete to authenticated
  using (company_id = public.current_company_id() and public.is_manager());

-- ---------- IMAGE_CHECKLISTS ----------
drop policy if exists ic_select on public.image_checklists;
create policy ic_select on public.image_checklists
  for select to authenticated using (company_id = public.current_company_id());

drop policy if exists ic_write on public.image_checklists;
create policy ic_write on public.image_checklists
  for all to authenticated
  using (company_id = public.current_company_id() and public.is_manager())
  with check (company_id = public.current_company_id() and public.is_manager());

-- ============================================================================
-- 5. STORAGE — as fotos saem do banco e vão pro bucket
--    Caminho obrigatório: <company_id>/<pasta>/<arquivo>.jpg
--    A policy lê a primeira pasta do caminho e compara com a empresa do usuário.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('opera-fotos', 'opera-fotos', false)
on conflict (id) do nothing;

drop policy if exists opera_fotos_select on storage.objects;
create policy opera_fotos_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'opera-fotos'
    and (storage.foldername(name))[1] = public.current_company_id()::text
  );

drop policy if exists opera_fotos_insert on storage.objects;
create policy opera_fotos_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'opera-fotos'
    and (storage.foldername(name))[1] = public.current_company_id()::text
  );

drop policy if exists opera_fotos_delete on storage.objects;
create policy opera_fotos_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'opera-fotos'
    and (storage.foldername(name))[1] = public.current_company_id()::text
    and public.is_admin()
  );

-- ============================================================================
-- FIM
-- ============================================================================
