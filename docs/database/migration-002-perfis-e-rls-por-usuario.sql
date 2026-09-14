-- Migração 002: tabela de perfil do técnico + RLS passa a ser por dono (criado_por = auth.uid()),
-- em vez de compartilhado entre todos os autenticados. Rodar uma vez no projeto de produção.

create table if not exists perfis (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nome_completo text not null,
  setor text,
  matricula text,
  formacao text,
  criado_em timestamptz not null default now()
);
alter table perfis enable row level security;
create policy "usuario le o proprio perfil" on perfis for select using (user_id = auth.uid());
create policy "usuario cria o proprio perfil" on perfis for insert with check (user_id = auth.uid());
create policy "usuario atualiza o proprio perfil" on perfis for update using (user_id = auth.uid());

-- Troca as políticas antigas (compartilhadas) pelas novas (por dono)
drop policy if exists "autenticados leem processos" on processos;
drop policy if exists "autenticados inserem processos" on processos;
drop policy if exists "autenticados atualizam processos" on processos;
create policy "dono le seus processos" on processos for select using (criado_por = auth.uid());
create policy "autenticado cria processo" on processos for insert with check (auth.role() = 'authenticated' and criado_por = auth.uid());
create policy "dono atualiza seus processos" on processos for update using (criado_por = auth.uid());

drop policy if exists "autenticados leem pontos" on pontos_observacao;
drop policy if exists "autenticados inserem pontos" on pontos_observacao;
drop policy if exists "autenticados atualizam pontos" on pontos_observacao;
create policy "dono le seus pontos" on pontos_observacao for select using (criado_por = auth.uid());
create policy "autenticado cria ponto" on pontos_observacao for insert with check (auth.role() = 'authenticated' and criado_por = auth.uid());
create policy "dono atualiza seus pontos" on pontos_observacao for update using (criado_por = auth.uid());

-- Atenção: qualquer processo/ponto com criado_por NULL (dados de teste anteriores ao login)
-- fica invisível para todo mundo com a política nova, já que NULL nunca é igual a auth.uid().
-- Se quiser reaproveitar esses registros de teste, rode manualmente:
--   update processos set criado_por = '<seu-uuid-de-usuario>' where criado_por is null;
--   update pontos_observacao set criado_por = '<seu-uuid-de-usuario>' where criado_por is null;
