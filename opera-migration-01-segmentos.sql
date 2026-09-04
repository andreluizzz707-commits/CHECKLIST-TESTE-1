-- ============================================================================
-- OPERA — MIGRAÇÃO 01
--   Parte A: correções de segurança (escalação de privilégio no RLS)
--   Parte B: segmentos + administrador da plataforma
--
-- Rode no SQL Editor do Supabase DEPOIS do opera-schema.sql.
-- É idempotente: pode rodar de novo sem quebrar.
-- ============================================================================


-- ############################################################################
-- PARTE A — CORREÇÕES DE SEGURANÇA (aplicar mesmo que você adie os segmentos)
-- ############################################################################

-- ----------------------------------------------------------------------------
-- A.1  Escalação de privilégio em profiles  [CRÍTICO]
--
-- A policy profiles_update_self permite UPDATE em qualquer coluna da própria
-- linha. Como "role" está nessa linha, qualquer colaborador logado consegue,
-- pelo console do navegador:
--     await sb.from("profiles").update({ role: "admin" }).eq("id", MEU_ID)
-- e passa a enxergar ponto, relatórios e usuários da empresa inteira.
--
-- RLS não sabe restringir coluna. A trava correta é um trigger.
-- ----------------------------------------------------------------------------

create or replace function public.profiles_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- o admin da plataforma pode tudo (é ele quem conserta cadastro errado)
  if public.is_platform_admin() then
    return new;
  end if;

  -- ninguém troca de empresa por conta própria, nunca
  if new.company_id is distinct from old.company_id then
    raise exception 'Não é permitido alterar a empresa do usuário.';
  end if;

  -- só quem é admin da empresa mexe em papel, dono e situação
  if not public.is_admin() then
    if new.role     is distinct from old.role
    or new.is_owner is distinct from old.is_owner
    or new.active   is distinct from old.active then
      raise exception 'Você não tem permissão para alterar estas informações.';
    end if;
  end if;

  -- nem o admin transfere a titularidade da conta pelo app
  if new.is_owner is distinct from old.is_owner then
    raise exception 'A titularidade da conta só muda pelo suporte.';
  end if;

  -- o dono não pode se rebaixar e trancar a empresa fora da administração
  if old.is_owner and new.role <> 'admin' then
    raise exception 'O proprietário da conta precisa continuar como administrador.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_profiles_guard on public.profiles;
create trigger trg_profiles_guard
  before update on public.profiles
  for each row execute function public.profiles_guard();


-- ----------------------------------------------------------------------------
-- A.2  Tarefa editável por qualquer um  [MÉDIO]
--
-- tasks_update_status foi escrita para deixar o colaborador marcar a tarefa
-- como concluída, mas ela libera UPDATE em todas as colunas. Na prática o
-- colaborador consegue reescrever título, área, prazo e responsável de
-- qualquer tarefa da empresa — inclusive apagar a evidência do atraso.
-- ----------------------------------------------------------------------------

create or replace function public.tasks_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.is_manager() or public.is_platform_admin() then
    return new;
  end if;

  -- colaborador só encosta em status, conclusão e observação
  if new.title          is distinct from old.title
  or new.type           is distinct from old.type
  or new.area           is distinct from old.area
  or new.responsible_id is distinct from old.responsible_id
  or new.shift_id       is distinct from old.shift_id
  or new.frequency      is distinct from old.frequency
  or new.priority       is distinct from old.priority
  or new.due_date       is distinct from old.due_date
  or new.company_id     is distinct from old.company_id then
    raise exception 'Você só pode concluir a tarefa, não editá-la.';
  end if;

  -- e não pode se autoaprovar
  if new.status = 'concluido' and old.status <> 'concluido' then
    new.status := 'aguardando_aprovacao';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_tasks_guard on public.tasks;
create trigger trg_tasks_guard
  before update on public.tasks
  for each row execute function public.tasks_guard();


-- ----------------------------------------------------------------------------
-- A.3  Aprovação da própria conclusão  [MÉDIO]
--
-- compl_approve exige is_manager(), mas um gestor que também executa tarefas
-- aprova a si mesmo. Se a evidência serve para discussão trabalhista, isso
-- enfraquece o registro.
-- ----------------------------------------------------------------------------

create or replace function public.completions_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status is distinct from old.status
     and new.status in ('aprovado','reprovado')
     and old.user_id = auth.uid()
     and not public.is_admin() then
    raise exception 'Você não pode aprovar a sua própria conclusão.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_completions_guard on public.task_completions;
create trigger trg_completions_guard
  before update on public.task_completions
  for each row execute function public.completions_guard();


-- ############################################################################
-- PARTE B — SEGMENTOS E ADMINISTRADOR DA PLATAFORMA
-- ############################################################################

-- ----------------------------------------------------------------------------
-- B.1  Quem é você dentro do sistema
--
-- Hoje NÃO existe ninguém acima das empresas: toda policy é
-- "company_id = current_company_id()". Nem você consegue listar as empresas
-- sem abrir o painel do Supabase.
--
-- Este é o papel novo. Repare que não existe policy de INSERT nesta tabela:
-- ninguém vira admin da plataforma pelo app. Você se cadastra rodando o
-- INSERT comentado no fim do arquivo, aqui no SQL Editor.
-- ----------------------------------------------------------------------------

create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  note       text,
  created_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;

create or replace function public.is_platform_admin()
returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.platform_admins where user_id = auth.uid()) $$;

drop policy if exists pa_select on public.platform_admins;
create policy pa_select on public.platform_admins
  for select to authenticated
  using (user_id = auth.uid());


-- ----------------------------------------------------------------------------
-- B.2  Catálogo de segmentos
--
-- "terms" troca as palavras da interface sem duplicar tela nenhuma.
-- "default_areas" alimenta as áreas sugeridas quando a empresa começa.
-- ----------------------------------------------------------------------------

create table if not exists public.segments (
  slug          text primary key,
  name          text not null,
  terms         jsonb not null default '{}'::jsonb,
  default_areas text[] not null default '{}',
  active        boolean not null default true,
  sort_order    int not null default 100,
  created_at    timestamptz not null default now()
);

insert into public.segments (slug, name, terms, default_areas, sort_order) values
  ('restaurante', 'Restaurante',
   '{"unidade":"Loja","unidades":"Lojas","area":"Setor","areas":"Setores","colaborador":"Colaborador"}'::jsonb,
   array['Cozinha','Salão','Bar','Estoque','Banheiros','Área externa'], 10),

  ('pousada', 'Pousada e Hotel',
   '{"unidade":"Unidade","unidades":"Unidades","area":"Ambiente","areas":"Ambientes","colaborador":"Camareira"}'::jsonb,
   array['Quartos','Recepção','Café da manhã','Piscina','Lavanderia','Áreas comuns'], 20),

  ('generico', 'Geral',
   '{"unidade":"Unidade","unidades":"Unidades","area":"Área","areas":"Áreas","colaborador":"Colaborador"}'::jsonb,
   array['Operação','Estoque','Banheiros','Área externa'], 999)
on conflict (slug) do nothing;

alter table public.segments enable row level security;

-- catálogo é leitura pública para quem está logado: a tela precisa dos rótulos
drop policy if exists segments_select on public.segments;
create policy segments_select on public.segments
  for select to authenticated using (active or public.is_platform_admin());

drop policy if exists segments_write on public.segments;
create policy segments_write on public.segments
  for all to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());


-- ----------------------------------------------------------------------------
-- B.3  O segmento na empresa
-- ----------------------------------------------------------------------------

alter table public.companies
  add column if not exists segment_slug text references public.segments(slug) on delete set null;

update public.companies set segment_slug = 'generico' where segment_slug is null;


-- ----------------------------------------------------------------------------
-- B.4  Pré-atribuição por CNPJ
--
-- É isto que você pediu: você marca o CNPJ ANTES de a empresa se cadastrar.
-- Quando ela cria a conta, o create_company já encontra o segmento definido
-- por você. Ela nunca escolhe.
-- ----------------------------------------------------------------------------

create table if not exists public.segment_assignments (
  cnpj_digits  text primary key,
  segment_slug text not null references public.segments(slug) on delete restrict,
  note         text,
  assigned_by  uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

alter table public.segment_assignments enable row level security;

-- ninguém além de você enxerga ou escreve aqui
drop policy if exists sa_platform on public.segment_assignments;
create policy sa_platform on public.segment_assignments
  for all to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());


-- ----------------------------------------------------------------------------
-- B.5  create_company passa a respeitar a pré-atribuição
--
-- Assinatura idêntica à original, então o opera-db.js continua funcionando
-- sem alteração nenhuma.
-- ----------------------------------------------------------------------------

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
  v_segment text;
  v_areas   text[];
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

  -- o segmento vem da SUA pré-atribuição; sem ela, cai no genérico
  select segment_slug into v_segment
    from public.segment_assignments where cnpj_digits = v_digits;
  if v_segment is null then v_segment := 'generico'; end if;

  v_code := upper(substring(regexp_replace(
              translate(p_name, 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
                                'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'),
              '[^A-Za-z]', '', 'g'), 1, 4));
  if v_code is null or v_code = '' then v_code := 'EMP'; end if;
  v_code := v_code || lpad((1000 + floor(random()*9000))::int::text, 4, '0');

  insert into public.companies (cnpj_digits, cnpj, code, name, email, phone, segment_slug)
  values (v_digits, p_cnpj, v_code, p_name, p_email, p_phone, v_segment)
  returning id into v_company;

  insert into public.shifts (company_id, name, start_time, end_time) values
    (v_company, 'Manhã', '06:00', '14:00'),
    (v_company, 'Tarde', '14:00', '22:00'),
    (v_company, 'Noite', '22:00', '06:00');

  insert into public.profiles (id, company_id, name, email, role, is_owner, position)
  values (v_uid, v_company, p_admin_name,
          coalesce((select email from auth.users where id = v_uid), p_email),
          'admin', true, 'Administração');

  return json_build_object('company_id', v_company, 'code', v_code, 'segment', v_segment);
end;
$$;

revoke all on function public.create_company(text,text,text,text,text) from public;
grant execute on function public.create_company(text,text,text,text,text) to authenticated;


-- ----------------------------------------------------------------------------
-- B.6  Empresa lê o próprio segmento; só você troca
-- ----------------------------------------------------------------------------

-- companies_update já exige is_admin() da empresa, o que deixaria o admin dela
-- trocar o próprio segmento. Este trigger fecha isso.
create or replace function public.companies_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if public.is_platform_admin() then
    return new;
  end if;
  if new.segment_slug is distinct from old.segment_slug then
    raise exception 'O segmento é definido pela administração da plataforma.';
  end if;
  if new.cnpj_digits is distinct from old.cnpj_digits
  or new.code        is distinct from old.code
  or new.plan        is distinct from old.plan
  or new.status      is distinct from old.status then
    raise exception 'Estes dados só mudam pelo suporte.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_companies_guard on public.companies;
create trigger trg_companies_guard
  before update on public.companies
  for each row execute function public.companies_guard();


-- ----------------------------------------------------------------------------
-- B.7  Visão da plataforma — as policies que deixam VOCÊ enxergar tudo
-- ----------------------------------------------------------------------------

drop policy if exists companies_select on public.companies;
create policy companies_select on public.companies
  for select to authenticated
  using (id = public.current_company_id() or public.is_platform_admin());

drop policy if exists companies_update on public.companies;
create policy companies_update on public.companies
  for update to authenticated
  using ((id = public.current_company_id() and public.is_admin()) or public.is_platform_admin())
  with check (id = public.current_company_id() or public.is_platform_admin());


-- ----------------------------------------------------------------------------
-- B.8  RPCs do painel da plataforma
-- ----------------------------------------------------------------------------

-- lista as empresas com o segmento atual
create or replace function public.platform_companies()
returns table (
  id uuid, cnpj text, name text, code text,
  segment_slug text, segment_name text,
  users_count bigint, status text, created_at timestamptz
)
language sql stable security definer set search_path = public
as $$
  select c.id, c.cnpj, c.name, c.code,
         c.segment_slug, s.name,
         (select count(*) from public.profiles p where p.company_id = c.id),
         c.status, c.created_at
  from public.companies c
  left join public.segments s on s.slug = c.segment_slug
  where public.is_platform_admin()
  order by c.created_at desc
$$;

revoke all on function public.platform_companies() from public;
grant execute on function public.platform_companies() to authenticated;


-- define o segmento de um CNPJ, já tenha ele se cadastrado ou não
create or replace function public.set_segment_for_cnpj(p_cnpj text, p_segment text, p_note text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_digits text := regexp_replace(coalesce(p_cnpj,''), '\D', '', 'g');
  v_hit    int;
begin
  if not public.is_platform_admin() then
    raise exception 'Sem permissão.';
  end if;
  if length(v_digits) <> 14 then
    raise exception 'CNPJ inválido.';
  end if;
  if not exists (select 1 from public.segments where slug = p_segment and active) then
    raise exception 'Segmento inexistente.';
  end if;

  insert into public.segment_assignments (cnpj_digits, segment_slug, note, assigned_by)
  values (v_digits, p_segment, p_note, auth.uid())
  on conflict (cnpj_digits) do update
    set segment_slug = excluded.segment_slug,
        note         = excluded.note,
        assigned_by  = excluded.assigned_by;

  -- se a empresa já existe, aplica agora
  update public.companies set segment_slug = p_segment where cnpj_digits = v_digits;
  get diagnostics v_hit = row_count;

  return json_build_object('cnpj', v_digits, 'segment', p_segment, 'aplicado_agora', v_hit > 0);
end;
$$;

revoke all on function public.set_segment_for_cnpj(text,text,text) from public;
grant execute on function public.set_segment_for_cnpj(text,text,text) to authenticated;


-- ----------------------------------------------------------------------------
-- B.9  ATIVE A SUA CONTA DE ADMIN DA PLATAFORMA
--
-- 1. Crie a conta normalmente pelo app (ou em Authentication → Users).
-- 2. Descomente as duas linhas abaixo, troque o e-mail e rode.
-- 3. Comente de novo. Este INSERT só funciona aqui, pelo SQL Editor:
--    o app nunca consegue fazer isso, e é assim que tem que ser.
-- ----------------------------------------------------------------------------

-- insert into public.platform_admins (user_id, note)
-- select id, 'dono da plataforma' from auth.users where email = 'SEU-EMAIL@dominio.com.br'
-- on conflict (user_id) do nothing;


-- ============================================================================
-- CONFERÊNCIA
--   select * from public.segments;
--   select id, name, segment_slug from public.companies;
--   select public.is_platform_admin();     -- true só na sua conta
--   select * from public.platform_companies();
-- ============================================================================
