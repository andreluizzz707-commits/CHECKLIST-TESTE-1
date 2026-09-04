# ASL Consultoria.IA

Gestão de limpeza, manutenção e ponto para restaurantes, pousadas e hotéis.
Sistema web multiempresa. Frontend estático (sem build) na Vercel, banco e autenticação no Supabase.

```
asl/
├── index.html                        landing page (pública, indexável)
├── app.html                          o sistema (login e painel)
├── config.js                         URL e anon key do Supabase  ← ÚNICO arquivo de configuração
├── opera-db.js                       camada de acesso ao Supabase
├── app.js                            lógica das telas
├── vendor/supabase.js                SDK do Supabase, hospedado localmente
├── opera-schema.sql                  schema inicial
├── opera-migration-01-segmentos.sql  correções de segurança + segmentos
├── privacidade.html                  política de privacidade (LGPD)
├── termos.html                       termos de uso
├── vercel.json                       headers de segurança e cache
├── robots.txt                        libera a landing, bloqueia o app
├── sw.js                             service worker (PWA)
├── manifest.webmanifest
└── docs/
    ├── PLANO-DE-CORRECAO.md          o que corrigir, em ordem
    └── INSTALAR-LANDING.md           notas da landing page
```

Não tem `package.json`, não tem build. A Vercel só serve os arquivos.

---

## Faça isto primeiro

### 1. Rodar a migração de segurança

Supabase → SQL Editor → New query → cole `opera-migration-01-segmentos.sql` inteiro → Run.

Ela corrige uma falha crítica: sem ela, qualquer colaborador logado vira administrador da própria empresa rodando isto no console do navegador:

```js
await sb.from("profiles").update({ role: "admin" }).eq("id", MEU_ID)
```

A migração não apaga dado e pode ser rodada de novo sem quebrar. Ela também instala os segmentos.

### 2. Ativar a sua conta de administrador da plataforma

No fim da migração tem um `INSERT` comentado. Crie sua conta pelo app, descomente as duas linhas, troque o e-mail, rode, comente de novo.

Confira com `select public.is_platform_admin();` — `true` só na sua conta.

### 3. Subir o mínimo de senha

Supabase → Authentication → Policies → **Minimum password length: 8**.
O padrão é 6, e a validação de 8 que existe no `app.js` se contorna pelo console.

### 4. Preencher os documentos jurídicos

`privacidade.html` e `termos.html` estão com campos entre colchetes. Substitua `[RAZÃO SOCIAL]`, `[00.000.000/0001-00]`, `[email@empresa.com.br]`, `[DD/MM/AAAA]` e `[CIDADE/UF]`, e apague as duas caixas amarelas de aviso.

Publicar com os colchetes é pior que não ter documento.

---

## Configurar o Supabase do zero

1. Crie o projeto em supabase.com. Guarde a senha do banco.
2. SQL Editor → cole `opera-schema.sql` → Run. Depois `opera-migration-01-segmentos.sql` → Run.
3. Authentication → Providers → Email → desligue **Confirm email**.
   Com a confirmação ligada, o `signUp` não devolve sessão e o cadastro trava no meio.
4. Authentication → URL Configuration → *Site URL*: `https://seudominio.com.br`.
5. Project Settings → API → copie o *Project URL* e a chave *anon public* para o `config.js`.

**Conferência:** no Table Editor devem aparecer as tabelas com cadeado (RLS ativo). Sem cadeado significa aberta para qualquer um.

A `anon key` é pública por design: ela chega no navegador de qualquer forma. Quem protege os dados são as policies de RLS. A **`service_role key` nunca entra neste repositório** — se vazar, qualquer pessoa lê e apaga tudo de todas as empresas.

---

## Segmentos

Você define o segmento por CNPJ, antes ou depois de a empresa se cadastrar:

```sql
select public.set_segment_for_cnpj('12.345.678/0001-99', 'pousada', 'Pousada do Cliente X');
```

Se a empresa ainda não existe, fica pré-atribuído e o cadastro aplica sozinho. Se já existe, aplica na hora.

Ver todas as empresas:

```sql
select * from public.platform_companies();
```

Criar um segmento novo:

```sql
insert into public.segments (slug, name, terms, default_areas, sort_order)
values ('padaria', 'Padaria',
  '{"unidade":"Loja","area":"Setor","colaborador":"Colaborador"}'::jsonb,
  array['Produção','Balcão','Estoque','Banheiros'], 30);
```

A empresa **não** consegue trocar o próprio segmento — o trigger `companies_guard` bloqueia, mesmo para o admin dela.

---

## Publicar

### GitHub

Repositório **privado**. Add file → Upload files, arrastando todos os arquivos.

### Vercel

vercel.com → Add New → Project → Import Git Repository.
Framework Preset **Other**, Build Command e Output Directory em branco. Deploy.

Sai uma URL `.vercel.app` em cerca de um minuto. Teste por ela antes de mexer no domínio.

### Domínio .com.br

Registre no **registro.br**, com CPF ou CNPJ. Registrar em outro lugar não funciona.

Na Vercel: Project → Settings → Domains → Add → `seudominio.com.br` e `www.seudominio.com.br`.
Use os registros DNS **que o painel dela mostrar**, não os de tutorial: projetos novos recebem IPs diferentes e a verificação confere o valor exato.

| Tipo  | Nome | Valor                     |
|-------|------|---------------------------|
| A     | @    | o IP que o painel mostrar |
| CNAME | www  | `cname.vercel-dns.com`    |

No registro.br: entre no domínio → DNS → Editar zona → adicione os dois → salve.

A propagação leva de minutos a horas. Quando concluir, a Vercel emite o HTTPS sozinha. Se travar em "Invalid Configuration" por mais de uma hora, quase sempre é registro antigo conflitante na zona.

Depois que o domínio subir, volte no Supabase → Authentication → URL Configuration e ajuste a *Site URL*.

---

## Antes de anunciar para clientes

- [ ] Migração de segurança rodada e testada
- [ ] Documentos jurídicos preenchidos, avisos amarelos apagados
- [ ] `Ctrl+F` por `service_role` no repositório — não pode aparecer
- [ ] **Teste de isolamento entre empresas:** crie duas com CNPJs diferentes. Logado na segunda, no console: `await sb.from("tasks").select("*")`. Só podem voltar as tarefas da segunda.
- [ ] **Teste de escalação de papel:** logado como colaborador, no console:
      `await sb.from("profiles").update({role:"admin"}).eq("id",(await sb.auth.getUser()).data.user.id)`
      Tem que dar erro de permissão. Se der sucesso, a migração não rodou.
- [ ] **Teste de XSS:** cadastre uma tarefa com o título `<b>teste</b>`. Tem que aparecer o texto literal, não negrito.
- [ ] Fluxo completo em celular: CNPJ → login → foto de turno → concluir tarefa → aprovar no admin
- [ ] Headers: DevTools → Network → clique no documento → em Response Headers devem aparecer `content-security-policy` e `strict-transport-security`
- [ ] Nenhuma requisição para `jsdelivr.net` na aba Network

---

## Limitações conhecidas

**Sem rate limiting no cadastro.** O Supabase Auth tem limites próprios, mas generosos. Quando virar produto pago, vale Cloudflare Turnstile na tela de cadastro de empresa.

**Convites por código, não por e-mail.** O administrador gera um código e entrega ao funcionário. Enviar por e-mail exige Edge Function com a `service_role key`, que não pode ficar no frontend.

**Fotos com URL assinada de 8 horas.** Quem deixar a aba aberta mais que isso precisa recarregar.

**Exclusão de dados manual.** O pedido previsto na LGPD é atendido pelo e-mail da política.

**Landing sem preço nem prova social.** Proposital: o modelo de cobrança ainda não está definido, e inventar depoimento derruba a confiança de quem avalia.

---

## Ao publicar uma mudança

Troque o número do cache no `sw.js` (`asl-v3` → `asl-v4`). Sem isso, o navegador dos seus clientes continua servindo a versão antiga.
