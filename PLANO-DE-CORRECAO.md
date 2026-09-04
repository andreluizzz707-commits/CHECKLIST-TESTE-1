# Plano de correção — OPERA / ASL

Ordem de execução. Cada item traz o que fazer, o código pronto e como conferir que funcionou.

Legenda: ❌ bloqueia o lançamento · ⚠️ antes de anunciar para clientes · 🔵 melhoria

---

## Etapa 1 — Banco de dados (10 minutos, faça hoje)

### 1.1 ❌ Rodar a migração

**Problema:** qualquer colaborador logado vira administrador da própria empresa rodando isto no console do navegador:

```js
await sb.from("profiles").update({ role: "admin" }).eq("id", MEU_ID)
```

A policy `profiles_update_self` libera `UPDATE` em toda a linha, e `role` está nela. Junto vêm mais duas: colaborador consegue reescrever qualquer tarefa (`tasks_update_status`), e gestor consegue aprovar a própria conclusão (`compl_approve`).

**O que fazer:** Supabase → SQL Editor → New query → cole o arquivo `opera-migration-01-segmentos.sql` inteiro → Run.

A migração não apaga dado nenhum e pode ser rodada de novo sem quebrar. Ela também instala os segmentos (Parte B).

**Como conferir** — logado como colaborador, no console:

```js
await sb.from("profiles").update({ role: "admin" }).eq("id", (await sb.auth.getUser()).data.user.id)
```

Tem que voltar erro: *"Você não tem permissão para alterar estas informações."* Se voltar sucesso, a migração não rodou.

### 1.2 ❌ Ativar a sua conta de administrador da plataforma

No fim da migração tem um `INSERT` comentado. Crie sua conta pelo app, descomente as duas linhas, troque o e-mail, rode, e comente de novo.

**Como conferir:** `select public.is_platform_admin();` → `true` na sua conta, `false` em qualquer outra.

### 1.3 ⚠️ Subir o mínimo de senha no Supabase

Hoje os 8 caracteres são validados só no `app.js`, e validação de frontend se contorna. O padrão do Supabase é 6.

Authentication → Policies → **Minimum password length: 8**. Ative também *Leaked password protection* se estiver disponível no seu plano.

---

## Etapa 2 — Código do frontend (1 a 2 horas)

### 2.1 ⚠️ Escapar HTML nas telas

**Problema:** 35 pontos do `app.js` jogam texto do usuário direto em `innerHTML`. Alguém cadastra uma tarefa chamada `<img src=x onerror=...>` e o markup entra na tela de todo mundo da empresa.

Sua CSP não tem `unsafe-inline` em `script-src`, o que **bloqueia a execução de script** — é por isso que isto é ⚠️ e não ❌. Mas ainda dá para injetar link e markup de phishing dentro do seu próprio painel.

**O que fazer:** adicione esta função no topo do `app.js`, junto das outras utilitárias:

```js
function esc(v){
  return String(v == null ? "" : v)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
```

Depois envolva com `esc(...)` toda interpolação de texto vindo do usuário. Estas são as linhas, pelo arquivo atual:

| Linha | O que escapar |
|-------|---------------|
| 298, 589, 649, 1048 | `${s.name}` |
| 443 | `${a.text}` |
| 493, 498 | `${top.name}`, `${r.name}` |
| 528 | `${c.title}`, `${userName(c.userId)}` |
| 625, 626 | `${t.title}`, `${t.area}`, `${userName(...)}`, `${shiftName(...)}` |
| 648, 857, 913 | `${u.name}` |
| 746, 747 | `${c.title}`, `${c.area}`, `${c.notes}`, `${userName(...)}` |
| 825 | `${w.item}`, `${w.reason}`, `${w.unit}` |
| 972, 973 | `${c.title}`, `${c.area}`, `${c.notes}`, `${c.rejectionReason}` |
| 1008 | `${s.name}` |
| 1038, 1040 | `${u.name}`, `${u.username}`, `${u.position}` |
| 1184 | `${p.label}` |

Exemplo, na 625:

```js
// antes
<td><div style="font-weight:600;">${t.title}${imgBtn}</div>
// depois
<td><div style="font-weight:600;">${esc(t.title)}${imgBtn}</div>
```

Atalho mais seguro do que ir linha a linha: escape na entrada da função que monta a linha, não em cada interpolação. Mas o `esc()` por interpolação é o que não quebra nada.

**Não precisa escapar:** `${t.id}`, `${s.id}`, datas formatadas, números, e strings que você mesmo escreveu no código.

**Como conferir:** cadastre uma tarefa com o título `<b>teste</b>`. Na tabela tem que aparecer o texto `<b>teste</b>` literalmente, não a palavra "teste" em negrito.

### 2.2 ⚠️ Tirar o Supabase do CDN

**Problema:** o `index.html` carrega `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2` — tag flutuante, sem `integrity`. E a sua CSP libera o jsdelivr **inteiro**, não só esse pacote. Se a versão 2 for comprometida, o código entra no seu site sozinho, com acesso à sessão dos seus clientes.

**O que fazer:**

1. Baixe o arquivo do CDN e salve como `/vendor/supabase.js` no repositório.
2. No `index.html`, troque a linha 840 por:

```html
<script src="/vendor/supabase.js"></script>
```

3. No `vercel.json`, tire o jsdelivr da CSP:

```
script-src 'self';
```

4. No `sw.js`, acrescente `"/vendor/supabase.js"` na lista `SHELL` e suba o cache de `asl-v2` para `asl-v3`.

**Como conferir:** DevTools → Network. Nenhuma requisição para `jsdelivr.net`. Console sem erro de CSP.

### 2.3 🔵 Rate limiting no cadastro

O Supabase Auth tem limite próprio, mas ele é generoso e não impede alguém de criar empresas em massa. Cloudflare Turnstile é gratuito e entra em duas linhas na tela de cadastro. Deixa para quando o sistema virar produto pago — está no seu README e continua sendo a leitura certa.

---

## Etapa 3 — LGPD (antes de qualquer cliente real)

### 3.1 ❌ Preencher os documentos

`privacidade.html` e `termos.html` estão com campos entre colchetes e com os avisos amarelos ainda visíveis. Publicar assim é pior do que não ter documento: mostra que ninguém revisou.

Substituir em **ambos** os arquivos:

- `[RAZÃO SOCIAL]` e `[00.000.000/0001-00]`
- `[email@empresa.com.br]` — precisa ser uma caixa que alguém lê; é por ela que chegam os pedidos de exclusão
- `[DD/MM/AAAA]`
- `[CIDADE/UF]` (só nos termos, cláusula 10)
- `[12]` meses de retenção e `[15]` dias de aviso — confirme se são mesmo os prazos que você quer

Depois apague as duas `<div class="note">` amarelas.

### 3.2 ⚠️ Revisão jurídica

Se você for **cobrar** pelo sistema, os termos precisam passar por advogado. A cláusula 4 (registro de ponto) transfere para a empresa contratante a responsabilidade de conferir se o uso atende à legislação trabalhista. Isso é defensável, mas é exatamente o ponto que um cliente vai questionar em disputa, e não sou advogado para te dizer se segura.

### 3.3 🔵 Exclusão de dados

Hoje é manual, por e-mail. Está declarado na política, o que é honesto e aceitável no começo. Vira problema quando houver volume.

---

## Etapa 4 — Segmentos (a funcionalidade nova)

A Parte B da migração já está instalada quando você roda a Etapa 1.1. O que ela te dá:

**Você define o segmento por CNPJ, antes ou depois de a empresa se cadastrar:**

```sql
select public.set_segment_for_cnpj('12.345.678/0001-99', 'pousada', 'Pousada do Cliente X');
```

Se a empresa ainda não existe, fica pré-atribuído e o `create_company` aplica sozinho no cadastro. Se já existe, aplica na hora.

**Ver todas as suas empresas:**

```sql
select * from public.platform_companies();
```

**Segmentos disponíveis:** `restaurante`, `pousada`, `generico`. Para criar outro:

```sql
insert into public.segments (slug, name, terms, default_areas, sort_order)
values ('padaria', 'Padaria',
  '{"unidade":"Loja","area":"Setor","colaborador":"Colaborador"}'::jsonb,
  array['Produção','Balcão','Estoque','Banheiros'], 30);
```

Cada segmento carrega `terms` (as palavras que trocam na interface) e `default_areas` (as áreas sugeridas). A empresa **não** consegue trocar o próprio segmento — o trigger `companies_guard` bloqueia, mesmo para o admin dela.

**O que ainda falta no frontend** (não está feito, é o próximo passo):

- ler `segment_slug` e os `terms` no login e aplicar os rótulos nas telas
- usar `default_areas` para sugerir áreas quando a empresa começa do zero
- uma tela `/plataforma` só sua, para atribuir segmento sem abrir o SQL Editor

---

## Etapa 5 — Marca e site

O repositório tem três nomes para o mesmo produto:

- `index.html`, `sw.js`, `privacidade.html`, `termos.html` → **ASL**
- `README.md`, `opera-db.js`, `opera-schema.sql`, bucket `opera-fotos` → **OPERA**
- a referência visual que você mandou → **Koncluí**

Isso aparece para o cliente: ele cria a conta no "ASL", recebe e-mail do "OPERA" e viu um anúncio do "Koncluí". Escolher o nome é pré-requisito para a landing page — não é detalhe de design.

Quando o nome estiver definido, trocar em: título e textos do `index.html`, `manifest.webmanifest`, `sw.js`, os dois documentos jurídicos e o README. O nome do bucket (`opera-fotos`) pode ficar como está — é interno, e renomear exige mover os arquivos.

Ponto adicional: o `robots.txt` bloqueia a indexação do site inteiro. Correto enquanto o domínio serve só o app. Quando existir landing page, ela precisa ficar de fora desse bloqueio, senão não aparece no Google.

---

## Resumo por categoria

**1. Autenticação e Supabase**
- ❌ Escalação de papel via `profiles_update_self` → rodar a migração (1.1)
- ⚠️ Colaborador edita qualquer tarefa → corrigido na mesma migração
- ⚠️ Gestor aprova a própria conclusão → corrigido na mesma migração
- ⚠️ Mínimo de senha em 6 no servidor → subir para 8 (1.3)
- 🔵 `find_company_by_cnpj` aberta para anon permite enumerar clientes; devolve só nome e código, é divulgação e não acesso
- ✅ Supabase Auth de verdade, senha nunca no seu banco, reset por link temporário
- ✅ RLS nas 10 tabelas, isolamento entre empresas correto
- ✅ `security definer` com `search_path` fixo

**2. Segredos**
- ✅ Nenhuma `service_role key` no repositório — conferi arquivo por arquivo
- ✅ `sb_publishable_` no `config.js` é pública por design
- ✅ `.gitignore` presente

**3. Ataques comuns**
- ⚠️ XSS armazenado em 35 pontos de `innerHTML` → `esc()` (2.1)
- ⚠️ CDN sem `integrity`, jsdelivr liberado inteiro na CSP → hospedar local (2.2)
- 🔵 Sem CAPTCHA nem rate limiting no cadastro (2.3)
- ✅ Queries via SDK do Supabase, parametrizadas

**4. Headers e HTTPS**
- ⚠️ `script-src` liberando jsdelivr inteiro (2.2)
- ✅ CSP, HSTS com preload, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy
- ✅ Nenhuma chamada HTTP sem "s"

**5. LGPD**
- ❌ Campos entre colchetes em privacidade e termos (3.1)
- ⚠️ Revisão jurídica se for cobrar (3.2)
- 🔵 Exclusão de dados manual (3.3)
- ✅ Documentos linkados e aceite obrigatório no cadastro
- ✅ Sem cookie de publicidade ou analytics

---

## Ordem sugerida

1. Rodar a migração e ativar sua conta de plataforma (Etapa 1) — hoje
2. Preencher os documentos jurídicos (Etapa 3.1) — antes do primeiro cliente
3. `esc()` e tirar o CDN (Etapa 2.1 e 2.2) — antes de anunciar
4. Escolher o nome (Etapa 5) — antes da landing page
5. Frontend dos segmentos e painel da plataforma (Etapa 4)
