# Monitoramento de PRF — guia para trabalhar neste repositório

PWA estático (sem build step) implementando o protocolo DAR do INEA. Antes de mexer em qualquer coisa, leia:

- **`docs/PRD.md`** — o que o app faz, pra quem, glossário do domínio (DAR, ponto de observação, conceito final), decisões de produto não óbvias no código.
- **`docs/DESIGN_SYSTEM.md`** — tokens de cor/tipografia, padrões de componente (segmented=radio nativo, chips, autocomplete), convenções de acessibilidade obrigatórias em telas novas.
- **`docs/database/DATABASE.md`** — schema atual e cumulativo do Postgres/Supabase, RLS, pegadinhas conhecidas.

## Estrutura do repositório

```
public/           ← TUDO que é deployado (site real). Nada fora daqui vai pro ar.
  index.html
  app.js          ← toda a lógica do app, um arquivo só
  db.js           ← fila local IndexedDB
  supabase-client.js
  sw.js           ← service worker
docs/             ← nunca deployado — PRD, design system, schema/migrações do banco
.claude/launch.json
package.json
```

**Por que `public/` existe**: até setembro/2026 o deploy subia a raiz inteira (`wrangler pages deploy .`), e por isso `schema.sql`/migrações/documentação interna precisavam ficar fora do repositório git só pra não ir parar publicamente no ar. Isso era arriscado (documentação sem versionamento). A solução foi mover os arquivos do app pra `public/` e deployar só essa subpasta — `docs/` agora pode ficar versionado com segurança.

## Comandos

```bash
npm run dev      # wrangler pages dev public — servidor local, porta 8790
npm run deploy   # wrangler pages deploy public — publica em produção
```

**Nunca** rode `wrangler pages deploy .` (a raiz) — isso publicaria `docs/` no ar.

## Convenção de cache-busting (importante, fácil de esquecer)

Cloudflare Pages serve os arquivos com `max-age` alto por padrão, sem hash no nome. Todo deploy que muda `app.js`, `db.js` ou `supabase-client.js` precisa bumpar o `?v=N` em **3 lugares ao mesmo tempo**, senão quem já tinha o app aberto continua rodando a versão antiga sem perceber:

1. `public/index.html` — `<script type="module" src="/app.js?v=N">`
2. `public/app.js` — os dois `import` no topo do arquivo (`supabase-client.js?v=N`, `db.js?v=N`)
3. `public/sw.js` — `CACHE_NAME` (bumpar o número) e `SHELL_FILES` (as 3 URLs com `?v=N`)

Os três precisam do **mesmo N**, sempre. Versão atual em produção: **v37** (checar `public/sw.js` pra confirmar, este número fica desatualizado).

## Migrações de banco

**Não há migração automatizada.** Todo SQL em `docs/database/migration-*.sql` precisa ser colado manualmente no SQL Editor do Supabase pelo usuário — avisar isso explicitamente sempre que uma mudança de schema for necessária, e não assumir que rodou sozinho. `docs/database/schema.sql` reflete o estado final esperado depois de todas as migrações — mantenha-o em sincronia ao escrever uma migração nova.

## Fluxo de trabalho esperado (preferência confirmada do usuário)

- **Sempre perguntar antes de `git commit`/`git push`** — mesmo depois do usuário já ter aprovado/testado a mudança em código. São duas confirmações separadas, não uma.
- Testar localmente (`npm run dev` + o Browser pane) antes de pedir aprovação pra commit — nunca só "parece certo pelo código".
- Depois do commit, perguntar separadamente se quer fazer deploy agora ou só acumular.
- Mensagens de commit em português, explicando o *porquê* da mudança (não só o quê).

## Coisas fáceis de esquecer neste projeto

- `kml_pontos`/`kml_poligonos` só sincronizam se o registro tiver `criado_por` — sem isso, ficam presos pra sempre só no aparelho que importou (ver `docs/database/DATABASE.md`).
- Pontos de observação (`pontos_observacao`) **não sincronizam automaticamente** — ficam retidos até revisão manual na aba Relatório (decisão de produto deliberada, não bug).
- Qualquer HTML novo interpolando dado do usuário precisa de `escaparTexto()`/`escaparAtributo()` — processos e espécies sincronizam com o servidor (XSS armazenado é real aqui, não hipotético).
- Alvo de toque de 44px é decisão de produto (uso em campo), não exigência normativa — não confundir um com o outro em comentário/PR.
- O WebGIS público está com a Fase 0/1 prontas (RLS + PostGIS habilitados); as fases seguintes (mapa público em si) não foram iniciadas.
