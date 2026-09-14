# Banco de dados — Monitoramento de PRF

Postgres gerenciado pelo Supabase (Auth + RLS + PostgREST). **Não existe ambiente de staging** — toda migração roda direto em produção, uma vez, manualmente, colando o SQL no **SQL Editor** do painel do Supabase. Não há CLI de migração automatizada neste projeto.

Este documento descreve o **estado atual e cumulativo** do schema (já com as 4 migrações aplicadas). O histórico completo de como se chegou aqui está nos arquivos `migration-00N-*.sql` desta mesma pasta — leia-os só se precisar entender *por que* uma coluna existe, não para recriar o banco do zero (para isso, use `schema.sql`, que já está com o estado final).

## Extensões habilitadas

- `pgcrypto` — `gen_random_uuid()` para as chaves primárias.
- `postgis` — geometria nativa (`geometry(Point,4326)`, `geometry(Polygon,4326)`), habilitada na migration-004 para o WebGIS.

## Tabelas

### `perfis`
Perfil do técnico avaliador — não confundir com `auth.users` (que só guarda e-mail/senha). Preenchido uma vez, no primeiro login.

| Coluna | Tipo | Notas |
|---|---|---|
| `user_id` | uuid PK | referencia `auth.users(id)`, cascade delete |
| `nome_completo` | text not null | |
| `setor` | text | |
| `matricula` | text | |
| `formacao` | text | |
| `aprovado` | boolean not null default false | só um admin muda isso, via SQL Editor. Trigger `protege_aprovado()` impede o próprio usuário de se auto-aprovar pelo app (migration-003) |
| `criado_em` | timestamptz | |

### `processos`
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `numero_administrativo` | text not null | identificador único visível ao usuário, formato INEA |
| `formacao_vegetal` | text not null | check: `Pastagens \| Capoeira \| Florestas \| Outros` |
| `area_ha` | numeric not null | |
| `num_pontos` | int not null | calculado no app: `(área − 1) + 5`, teto 50 |
| `razao_social`, `cpf_cnpj`, `endereco`, `complemento`, `municipio`, `cep`, `contato_nome`, `contato_telefone`, `contato_email` | text, todos opcionais | identificação do requerente (Anexo II) |
| `publico` | boolean not null default false | **migration-004** — controla visibilidade no WebGIS público. Default privado; técnico decide publicar processo a processo |
| `criado_por` | uuid | referencia `auth.users(id)`. **Pode ser `null` em registros legados** pré-migration-002 — nesse caso o registro fica invisível pra todo mundo sob a RLS atual |
| `criado_em` | timestamptz | |

### `pontos_observacao`
Cada linha é um **ponto de observação** (não "parcela" — terminologia é do método DER, não do DAR).

| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `processo_id` | uuid not null | FK `processos(id)`, cascade delete |
| `necessidade_replantio`, `cobertura_copa`, `distribuicao_especies`, `altura_estimada`, `competicao` | numeric not null | check: `in (0, 0.65, 1.0)` — os 5 parâmetros diretos do DAR (Crítica/Mínima/Adequada) |
| `atrativos_fauna_novos` | int not null default 0 | contagem de espécies **novas** com flor/fruto vistas neste ponto (derivado do picker no app, não digitado) |
| `riqueza_aparente_novos` | int not null default 0 | contagem de espécies vegetais **novas** vistas neste ponto |
| `especies_zoocoricas_observadas` | text | lista separada por `;` |
| `especies_vegetais_observadas` | text | lista separada por `;` — **toda espécie de atrativos de fauna também entra aqui automaticamente** (propagação fauna→vegetal no app; o inverso não acontece) |
| `observacoes` | text | |
| `latitude`, `longitude` | double precision | |
| `avaliado_em` | timestamptz not null | quando o ponto foi avaliado em campo — não muda numa correção posterior |
| `criado_por` | uuid | idem `processos.criado_por` |
| `criado_em` | timestamptz | |

**Atrativos de fauna e Riqueza aparente são cumulativos do processo inteiro**, não por ponto — a classificação final (Crítica/Mínima/Adequada) é calculada sobre a soma de todos os pontos e vale igualmente para todos eles (ver `classificarAtrativos`/`classificarRiqueza` em `public/app.js`).

### `kml_pontos` / `kml_poligonos`
**Criadas na migration-004.** Antes disso, essas duas "tabelas" só existiam como IndexedDB local no aparelho do técnico — nunca sincronizavam com o servidor. Guardam o que foi importado de um arquivo KML (pontos planejados e/ou contorno da área de plantio).

| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `processo_id` | uuid not null | FK `processos(id)`, cascade delete |
| `nome` | text | nome do placemark no KML |
| `geom` | `geometry(Point,4326)` (kml_pontos) / `geometry(Polygon,4326)` (kml_poligonos) | gravado pelo app como texto EWKT (`SRID=4326;POINT(lon lat)` / `...;POLYGON((...))`) via upsert do PostgREST |
| `criado_por` | uuid | **sem isso a linha não sincroniza** — o app filtra por `criado_por` antes de tentar subir (ver `sincronizarPendentes` em `app.js`) |
| `criado_em` | timestamptz | |

Índices GiST em `geom` nas duas tabelas, para consulta espacial futura (WebGIS).

## Row Level Security

Padrão em todas as tabelas de dado do usuário (`perfis`, `processos`, `pontos_observacao`, `kml_pontos`, `kml_poligonos`): **um processo é conduzido do início ao fim por um único técnico** — RLS por dono (`criado_por = auth.uid()`), não compartilhado entre técnicos.

- `select`/`insert`/`update` por dono em todas — nunca `delete` (o app nunca apaga linha nenhuma no servidor).
- `insert` sempre exige `auth.role() = 'authenticated'` **e** `criado_por = auth.uid()`.
- O app usa `upsert()` pra tudo (nunca `insert` puro) — por isso a política de `update` é obrigatória mesmo pra dados "novos": reenviar um registro que já sincronizou faz `UPDATE` por baixo.

**Leitura pública (WebGIS, migration-004)** — 4 políticas adicionais, permissivas (somam com as de dono, não substituem):
```sql
processos.publico = true                                          → select liberado pro papel anon
pontos_observacao  → select se processos.publico = true (via join)
kml_pontos         → select se processos.publico = true (via join)
kml_poligonos      → select se processos.publico = true (via join)
```
Nunca existe `insert`/`update`/`delete` pra `anon` em nenhuma tabela.

## Pegadinhas conhecidas

- **`criado_por` nulo** em `processos`/`pontos_observacao` só existe em dado de teste anterior à migration-002 — fica invisível pra sempre sob a RLS atual. Recuperar manualmente via SQL Editor se precisar (`update ... set criado_por = '<uuid>' where criado_por is null`).
- **`kml_pontos`/`kml_poligonos` sem `criado_por`**: importações feitas *antes* da correção que passou a gravar isso (mesma leva da migration-004) nunca sincronizam — ficam só no aparelho que importou, indefinidamente. Não é erro, é o filtro de sincronização funcionando como projetado.
- **Sem tabela de fotos**: fotos nunca são enviadas ao Supabase. Ficam em memória no navegador durante a sessão (mosaico do Relatório) e só saem embutidas no PDF exportado.
- `NOTIFY pgrst, 'reload schema';` no fim de toda migração — sem isso o PostgREST cacheia o schema antigo e a sincronização falha com "coluna não encontrada" mesmo depois da migração rodar certo.
