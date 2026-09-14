-- Monitoramento de PRF — schema Supabase (Postgres)
-- Rodar no SQL Editor do projeto Supabase antes do primeiro deploy.
-- Terminologia e regras seguem o Manual INEA (2016) e o Anexo II — Ficha DAR Quitação Florestas.

create extension if not exists "pgcrypto";
create extension if not exists postgis;

-- Perfil do técnico avaliador — preenchido uma vez, no primeiro login (tela de cadastro).
-- Separado de auth.users porque o Supabase Auth só guarda e-mail; nome/setor/matrícula/formação
-- são dados nossos, usados no cabeçalho "Identificação do técnico avaliador" do PDF (Anexo II).
create table if not exists perfis (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nome_completo text not null,
  setor text,
  matricula text,
  formacao text,
  criado_em timestamptz not null default now()
);

create table if not exists processos (
  id uuid primary key default gen_random_uuid(),
  numero_administrativo text not null,
  formacao_vegetal text not null check (formacao_vegetal in ('Pastagens', 'Capoeira', 'Florestas', 'Outros')),
  area_ha numeric not null,
  num_pontos int not null,

  -- Identificação do requerente (Anexo II)
  razao_social text,
  cpf_cnpj text,
  endereco text,
  complemento text,
  municipio text,
  cep text,
  contato_nome text,
  contato_telefone text,
  contato_email text,

  -- Controle de visibilidade no WebGIS público (mapa somente-leitura, sem login) — padrão privado,
  -- o técnico decide publicar processo a processo. Ver migration-004-webgis-fase0.sql.
  publico boolean not null default false,

  criado_por uuid references auth.users(id),
  criado_em timestamptz not null default now()
);

-- Cada linha é um "ponto de observação" (não "parcela" — parcela é terminologia do método DER, não do DAR).
create table if not exists pontos_observacao (
  id uuid primary key default gen_random_uuid(),
  processo_id uuid not null references processos(id) on delete cascade,

  -- 5 parâmetros avaliados diretamente neste ponto: 0 (Crítica) / 0.65 (Mínima) / 1.0 (Adequada)
  necessidade_replantio numeric not null check (necessidade_replantio in (0, 0.65, 1.0)),
  cobertura_copa numeric not null check (cobertura_copa in (0, 0.65, 1.0)),
  distribuicao_especies numeric not null check (distribuicao_especies in (0, 0.65, 1.0)),
  altura_estimada numeric not null check (altura_estimada in (0, 0.65, 1.0)),
  competicao numeric not null check (competicao in (0, 0.65, 1.0)),

  -- 2 parâmetros cumulativos do polígono inteiro: cada ponto contribui uma contagem de NOVAS
  -- espécies/atrativos vistos ali; a classificação final (0/0.65/1.0) é calculada sobre a soma de
  -- todos os pontos do processo e se aplica igualmente a todos eles — não é escolhida por ponto.
  -- Nesta revisão passaram a ser derivados automaticamente da lista de espécies (ver app.js) em vez
  -- de digitados à mão — mas continuam gravados aqui para não recalcular tudo a cada leitura.
  atrativos_fauna_novos int not null default 0,
  riqueza_aparente_novos int not null default 0,

  especies_zoocoricas_observadas text,
  especies_vegetais_observadas text,
  observacoes text,

  latitude double precision,
  longitude double precision,
  avaliado_em timestamptz not null,

  criado_por uuid references auth.users(id),
  criado_em timestamptz not null default now()
);

create index if not exists idx_pontos_processo on pontos_observacao(processo_id);

-- Geometria de KML importado (polígono da área de plantio e/ou pontos planejados) — reaproveitada
-- tanto pelo app de campo (aba Mapa) quanto pelo WebGIS público. Ver migration-004-webgis-fase0.sql
-- para o histórico: essas duas tabelas não existiam antes, os dados ficavam só no IndexedDB local.
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

-- Row Level Security: cada usuário só lê/grava o que ele mesmo criou.
-- Decisão de produto: um processo é conduzido do início ao fim por um único técnico — não há
-- necessidade de um segundo avaliador enxergar ou completar o processo de outra pessoa. Se isso
-- mudar no futuro (múltiplos técnicos no mesmo processo), trocar "criado_por = auth.uid()" por uma
-- tabela de compartilhamento explícito em vez de abrir para todo mundo de novo.
alter table perfis enable row level security;
alter table processos enable row level security;
alter table pontos_observacao enable row level security;
alter table kml_pontos enable row level security;
alter table kml_poligonos enable row level security;

create policy "usuario le o proprio perfil" on perfis for select using (user_id = auth.uid());
create policy "usuario cria o proprio perfil" on perfis for insert with check (user_id = auth.uid());
create policy "usuario atualiza o proprio perfil" on perfis for update using (user_id = auth.uid());

create policy "dono le seus processos" on processos for select using (criado_por = auth.uid());
create policy "autenticado cria processo" on processos for insert with check (auth.role() = 'authenticated' and criado_por = auth.uid());
create policy "dono atualiza seus processos" on processos for update using (criado_por = auth.uid());

create policy "dono le seus pontos" on pontos_observacao for select using (criado_por = auth.uid());
create policy "autenticado cria ponto" on pontos_observacao for insert with check (auth.role() = 'authenticated' and criado_por = auth.uid());
create policy "dono atualiza seus pontos" on pontos_observacao for update using (criado_por = auth.uid());
-- As três políticas (select/insert/update) valem para as três tabelas: o app.js sempre usa upsert()
-- para sincronizar (nunca insert puro), e upsert numa linha que já existe faz UPDATE por baixo — sem
-- a política de update, a re-sincronização de qualquer registro já enviado falharia silenciosamente.

create policy "dono le seus pontos kml" on kml_pontos for select using (criado_por = auth.uid());
create policy "autenticado cria ponto kml" on kml_pontos for insert with check (auth.role() = 'authenticated' and criado_por = auth.uid());
create policy "dono atualiza seus pontos kml" on kml_pontos for update using (criado_por = auth.uid());

create policy "dono le seus poligonos kml" on kml_poligonos for select using (criado_por = auth.uid());
create policy "autenticado cria poligono kml" on kml_poligonos for insert with check (auth.role() = 'authenticated' and criado_por = auth.uid());
create policy "dono atualiza seus poligonos kml" on kml_poligonos for update using (criado_por = auth.uid());

-- Leitura pública (WebGIS, sem login): só processos marcados publico = true, só SELECT. Convive com
-- as políticas de dono acima (permissivas — OU entre si), nunca ganha INSERT/UPDATE/DELETE.
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
