-- Migração 003: aprovação de novo usuário pelo administrador.
-- Roda uma vez no projeto de produção, depois da migração 002.

alter table perfis add column if not exists aprovado boolean not null default false;

-- Trigger de proteção: um usuário comum (client autenticado pela anon key) nunca consegue
-- aprovar a si mesmo, mesmo que edite o próprio perfil — o campo "aprovado" é sempre mantido
-- igual ao valor anterior quando quem grava é o app (auth.role() = 'authenticated'). Só muda
-- de verdade quando o UPDATE roda como admin no SQL Editor do Supabase (que não carrega essa role).
create or replace function protege_aprovado()
returns trigger
language plpgsql
security definer
as $$
begin
  if auth.role() = 'authenticated' then
    new.aprovado := old.aprovado;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protege_aprovado on perfis;
create trigger trg_protege_aprovado
before update on perfis
for each row execute function protege_aprovado();

-- Referência: para aprovar alguém manualmente depois de rodar isso, no SQL Editor:
--   update perfis set aprovado = true where user_id = '<uuid-do-usuario>';
-- Para achar o uuid a partir do e-mail:
--   select id, email from auth.users where email = 'pessoa@exemplo.com';
