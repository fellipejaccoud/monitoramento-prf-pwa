-- Migração 004: base de dados para o WebGIS público (Fase 0 da trilha de desenvolvimento).
-- Rodar uma vez no SQL Editor do projeto Supabase, depois da migração 003.
--
-- Achado importante ao implementar esta fase: kml_pontos e kml_poligonos, apesar do nome, nunca
-- foram tabelas no Supabase — eram só IndexedDB local no aparelho do técnico (comentário original
-- em app.js: "não sincronizam com o servidor"). O app.js foi ajustado nesta mesma leva para passar
-- a sincronizá-las (ver sincronizarPendentes em app.js), então esta migração cria as tabelas do zero,
-- não "migra tipo de coluna" como o documento de especificação original previa.

create extension if not exists postgis;

-- Controle de visibilidade pública, por processo. Padrão false (privado) — o técnico decide
-- explicitamente publicar, processo a processo, marcando a caixa no cadastro.
alter table processos add column if not exists publico boolean not null default false;

create table if not exists kml_pontos (
  id uuid primary key default gen_random_uuid(),
  processo_id uuid not null references processos(id) on delete cascade,
  nome text,
  geom geometry(Point, 4326) not null,
  criado_por uuid references auth.users(id),
  criado_em timestamptz not null default now()
);

create table if not exists kml_poligonos (
  id uuid primary key default gen_random_uuid(),
  processo_id uuid not null references processos(id) on delete cascade,
  nome text,
  geom geometry(Polygon, 4326) not null,
  criado_por uuid references auth.users(id),
  criado_em timestamptz not null default now()
);

create index if not exists idx_kml_pontos_processo on kml_pontos(processo_id);
create index if not exists idx_kml_poligonos_processo on kml_poligonos(processo_id);
create index if not exists idx_kml_pontos_geom on kml_pontos using gist(geom);
create index if not exists idx_kml_poligonos_geom on kml_poligonos using gist(geom);

alter table kml_pontos enable row level security;
alter table kml_poligonos enable row level security;

-- Mesmo padrão de dono já usado em processos/pontos_observacao (migração 002).
create policy "dono le seus pontos kml" on kml_pontos for select using (criado_por = auth.uid());
create policy "autenticado cria ponto kml" on kml_pontos for insert with check (auth.role() = 'authenticated' and criado_por = auth.uid());
create policy "dono atualiza seus pontos kml" on kml_pontos for update using (criado_por = auth.uid());

create policy "dono le seus poligonos kml" on kml_poligonos for select using (criado_por = auth.uid());
create policy "autenticado cria poligono kml" on kml_poligonos for insert with check (auth.role() = 'authenticated' and criado_por = auth.uid());
create policy "dono atualiza seus poligonos kml" on kml_poligonos for update using (criado_por = auth.uid());

-- Leitura pública (Fase 1 da trilha do WebGIS, aplicada aqui junto porque é uma linha de política
-- por tabela, sem custo extra de fazer depois): só processos marcados publico = true, só SELECT —
-- em nenhum momento o papel anon ganha INSERT/UPDATE/DELETE. É uma policy adicional (permissiva),
-- convive com as policies de dono já existentes sem substituí-las.
create policy "publico le processos publicos" on processos for select using (publico = true);

create policy "publico le pontos de processos publicos" on pontos_observacao for select using (
  exists (select 1 from processos where processos.id = pontos_observacao.processo_id and processos.publico = true)
);

create policy "publico le pontos kml de processos publicos" on kml_pontos for select using (
  exists (select 1 from processos where processos.id = kml_pontos.processo_id and processos.publico = true)
);

create policy "publico le poligonos kml de processos publicos" on kml_poligonos for select using (
  exists (select 1 from processos where processos.id = kml_poligonos.processo_id and processos.publico = true)
);

-- Força o PostgREST a reconhecer as tabelas/coluna novas imediatamente.
NOTIFY pgrst, 'reload schema';

-- Referência: dado de campo já sincronizado antes desta migração (processos antigos) fica com
-- publico = false por padrão — nada vira público sozinho. Para publicar manualmente um processo
-- de teste, no SQL Editor:
--   update processos set publico = true where id = '<uuid-do-processo>';
