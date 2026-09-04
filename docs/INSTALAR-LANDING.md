# Instalar a landing page e fixar o nome

## 1. Onde cada coisa mora

Hoje `/` é o aplicativo. A landing precisa de `/`, e o app vai para `/app`.

No repositório:

1. Renomeie `index.html` → `app.html`
2. Adicione `landing.html` e renomeie para `index.html`

Fica assim:

```
index.html    landing page (público, indexável)
app.html      o sistema (login e painel)
```

Com `cleanUrls: true` no `vercel.json`, `/app` serve o `app.html` sozinho. Não precisa de rewrite.

## 2. Ajustes que a renomeação exige

**`sw.js`** — a lista `SHELL` aponta para `/index.html`, que agora é outra página. Troque:

```js
const CACHE = "asl-v3";           // era asl-v2 — obrigatório subir, senão o cache velho fica

const SHELL = [
  "/",
  "/index.html",
  "/app.html",                     // novo
  "/app.js",
  "/opera-db.js",
  "/config.js",
  "/bg-gate.jpg",
  "/logo-mark.png",
  "/logo-mark-light.png",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.webmanifest"
];
```

E no `fetch`, o fallback offline `caches.match("/index.html")` passa a devolver a landing para quem está dentro do app. Troque por `caches.match("/app.html")`.

**`manifest.webmanifest`** — o `start_url` precisa apontar para o app, não para a landing. Quem instala o PWA quer abrir logando, não vendo o anúncio:

```json
"start_url": "/app",
"scope": "/"
```

**`robots.txt`** — hoje bloqueia o site inteiro, o que impede a landing de aparecer no Google. Troque por:

```
User-agent: *
Allow: /$
Allow: /privacidade
Allow: /termos
Disallow: /app

Sitemap: https://seudominio.com.br/sitemap.xml
```

O `Disallow: /app` mantém o sistema fora dos buscadores, que é o que você queria com o bloqueio original.

## 3. Trocar o nome para ASL Consultoria.IA

O repositório hoje mistura três nomes. Substitua em:

| Arquivo | O que trocar |
|---|---|
| `app.html` (antigo `index.html`) | `<title>`, nome na barra superior, textos de tela |
| `manifest.webmanifest` | `name` e `short_name` |
| `sw.js` | comentário do topo |
| `privacidade.html` | todas as ocorrências de "ASL" viram "ASL Consultoria.IA" |
| `termos.html` | idem |
| `README.md` | título e todas as menções a "OPERA" |

**Não troque:** o bucket `opera-fotos`, os nomes de arquivo `opera-db.js` e `opera-schema.sql`, e as funções SQL. São internos, o cliente nunca vê, e renomear o bucket exige mover todas as fotos já enviadas.

## 4. Conferir depois do deploy

- `/` abre a landing, `/app` abre o login
- DevTools → Network → nenhuma requisição fora de `fonts.googleapis.com`, `fonts.gstatic.com` e o seu domínio
- Console sem erro de CSP (a landing usa `<style>` inline, que a sua CSP permite via `style-src 'unsafe-inline'`, e nenhum JavaScript)
- No celular, o cartão do herói desempilha e fica reto
- Tab pela página: o foco fica visível em todos os links e botões

## 5. O que ficou de fora de propósito

**Preço.** Não coloquei seção de planos porque você ainda não me disse o modelo de cobrança. Landing sem preço funciona quando a venda é consultiva, que parece ser o seu caso.

**Prova social.** Sem depoimento, logo de cliente ou número de unidades atendidas. Inventar isso é o caminho mais rápido de perder a confiança de quem está avaliando. Quando você tiver o primeiro cliente rodando, esse é o bloco a acrescentar, logo depois da lista de resultados.

**Foto real.** O cartão do herói usa um retângulo em degradê no lugar da foto do turno. Trocar por uma foto real de operação — cozinha limpa, quarto pronto — vale mais do que qualquer ajuste de cor que eu faça ali. Se ela for de cliente, precisa de autorização por escrito, e as pessoas não podem estar identificáveis sem consentimento.
