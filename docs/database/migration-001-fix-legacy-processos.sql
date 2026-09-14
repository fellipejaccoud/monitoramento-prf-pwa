-- Migração pontual: o projeto Supabase já tinha uma tabela "processos" de um rascunho
-- anterior (num_parcelas/usuario_email em vez de num_pontos/criado_por, sem os campos do
-- requerente). Como schema.sql usa "create table if not exists", ele não mexeu numa tabela
-- que já existia — por isso a sincronização falhava com "Could not find the 'cep' column".
-- Rodar uma vez só, depois de já ter rodado o schema.sql principal.

-- 1) Tabela órfã do rascunho antigo (esp_vegetais, foto_url, somatorio) — não é usada pelo
--    app atual (que grava em pontos_observacao). Sem dados reais, seguro remover.
drop table if exists parcelas;

-- 2) Corrige "processos" para o formato atual
alter table processos rename column num_parcelas to num_pontos;
alter table processos drop column if exists usuario_email;

alter table processos add column if not exists razao_social text;
alter table processos add column if not exists cpf_cnpj text;
alter table processos add column if not exists endereco text;
alter table processos add column if not exists complemento text;
alter table processos add column if not exists municipio text;
alter table processos add column if not exists cep text;
alter table processos add column if not exists contato_nome text;
alter table processos add column if not exists contato_telefone text;
alter table processos add column if not exists contato_email text;
alter table processos add column if not exists criado_por uuid references auth.users(id);

-- A tabela antiga não tinha esse check — reaplica para bater com schema.sql
alter table processos add constraint processos_formacao_vegetal_check
  check (formacao_vegetal in ('Pastagens', 'Capoeira', 'Florestas', 'Outros'));

-- Força o PostgREST a esquecer o cache antigo de colunas
NOTIFY pgrst, 'reload schema';
