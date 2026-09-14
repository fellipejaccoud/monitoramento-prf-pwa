# Configurando o projeto do zero

## Local

```bash
npm install
npm run dev
```
Abre em `http://localhost:8790` via Wrangler (emula o Cloudflare Pages).

## Supabase

1. Criar um projeto em [supabase.com](https://supabase.com).
2. Rodar `docs/database/schema.sql` no **SQL Editor** do projeto — cria as tabelas, habilita PostGIS/pgcrypto e configura a RLS já no estado final (equivale a rodar as 4 migrações em `docs/database/`, sem precisar rodá-las uma a uma).
3. Project Settings → API: copiar **Project URL** e **anon public key** para `public/supabase-client.js` (a anon key é pública por natureza — a RLS que protege os dados, não o segredo da chave).
4. Authentication → Providers → habilitar Email (com senha, não magic link).
5. Aprovar manualmente o primeiro técnico: depois do primeiro cadastro no app, no SQL Editor:
   ```sql
   update perfis set aprovado = true where user_id = '<uuid-do-usuario>';
   ```
   (achar o uuid: `select id, email from auth.users where email = '...';`)

## Cloudflare Pages

```bash
npm run deploy
```
Publica `public/` (nunca a raiz do repositório — ver `CLAUDE.md`). Domínio customizado configurado à parte, no painel do Cloudflare.

## Testando offline

Depois de abrir o app uma vez com sinal (pro Service Worker cachear o shell): modo avião, confirmar que o app abre normalmente, dá pra cadastrar processo/ponto (ficam na fila local, aviso no topo), e que a fila sincroniza sozinha ao voltar a conexão (ou reabrir o app / trocar de aba).
