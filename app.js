// Sufixo ?v=N nos imports abaixo e no <script> do app.js em index.html: o Cloudflare Pages serve
// esses arquivos com Cache-Control: max-age=14400 (4h) por padrão, sem hash no nome do arquivo —
// um deploy novo não chega pra quem já tinha o app aberto/visitado dentro dessa janela, mesmo o
// service worker fazendo fetch "network-first" (o fetch() do navegador ainda respeita o cache HTTP
// antes de ir à rede). Bug real encontrado em produção: testes pareciam "não ter efeito" porque o
// navegador estava servindo app.js antigo do próprio cache, sem sequer consultar o servidor. Bumpar
// esse número a cada deploy força uma URL nova, que nunca esteve em cache.
import { supabase } from './supabase-client.js?v=36';
import {
  salvarLocal, marcarSincronizado, listarPendentes, listarTodos, contarPendentes,
  salvarTecnico, carregarTecnico, removerLocal, limparTecnico
} from './db.js?v=36';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}

// ---------- Blindagem de boot: index.html e app.js precisam ser da mesma revisão ----------
// Sem isso, um index.html desatualizado servido do cache (ver comentário no topo do arquivo) faz o
// primeiro document.getElementById(id-que-não-existe) lançar TypeError e travar o módulo inteiro
// silenciosamente — nenhum listener abaixo chega a ser registrado (login, ponto, mapa, export, nada),
// e pra quem está com o app aberto isso aparece só como "o botão não faz nada", sem pista nenhuma.
// Lista levantada varrendo o próprio app.js por getElementById que roda ANTES de qualquer listener
// (nível superior do módulo — logins, gates, form-tecnico, e as chamadas imediatas de
// createSpeciesPicker/preencherFormPerfil, que também quebrariam o boot se o id não existisse) mais
// os pontos de entrada de cada aba (Processo, Ponto, Mapa, Relatório), que travariam a primeira vez
// que alguém abrisse aquela aba com um HTML incompatível.
const IDS_OBRIGATORIOS = [
  // Login / cadastro / gates
  'form-login', 'login-titulo', 'login-desc', 'login-email', 'login-senha',
  'login-confirma-wrap', 'login-senha-confirma', 'btn-login', 'btn-cadastrar', 'login-msg',
  'link-alternar-modo', 'link-esqueci-senha', 'btn-logout', 'form-perfil-inicial',
  'btn-verificar-aprovacao', 'form-nova-senha', 'pendentes-badge', 'pendentes-badge-texto',
  'btn-sincronizar-agora', 'app-shell', 'conteudo-principal',
  // Perfil do técnico
  'form-tecnico', 't-nome', 't-matricula', 't-setor', 't-formacao',
  // Processo
  'p-area', 'p-num-pontos', 'p-editar-select', 'btn-cancelar-edicao-processo',
  'form-processo', 'btn-salvar-processo',
  // Ponto de observação (inclui os pickers de espécie, cuja construção roda no boot)
  'pt-processo', 'pt-kml-select', 'btn-gps', 'form-ponto', 'btn-salvar-ponto',
  'btn-cancelar-edicao-ponto', 'ponto-form-titulo', 'pt-id-edicao',
  'pt-fauna-busca', 'pt-fauna-lista', 'pt-fauna-chips',
  'pt-vegetal-busca', 'pt-vegetal-lista', 'pt-vegetal-chips',
  // Mapa
  'mapa-processo', 'mapa-kml', 'mapa-leaflet', 'btn-goto-point', 'btn-parar-navegacao',
  // Relatório
  'm-processo', 'm-revisao-card', 'm-revisao-lista', 'm-revisao-msg', 'btn-confirmar-todos-pontos',
  'm-fotos', 'm-fotos-msg', 'btn-limpar-fotos', 'btn-exportar-pdf', 'btn-exportar-excel'
];
const idsFaltando = IDS_OBRIGATORIOS.filter((id) => !document.getElementById(id));
if (idsFaltando.length) {
  document.body.insertAdjacentHTML('afterbegin',
    `<div role="alert" style="position:fixed;inset:0 0 auto 0;z-index:9999;padding:16px;background:#b02a2a;color:#fff;font:600 .9rem/1.4 system-ui,sans-serif;">
       Versão incompatível do aplicativo (faltam: ${idsFaltando.join(', ')}).
       Feche e reabra o app com internet para atualizar.
     </div>`);
  throw new Error(`[boot] HTML incompatível com este app.js — faltam ids: ${idsFaltando.join(', ')}`);
}

// Só para elementos genuinamente opcionais (condicionais, conveniência) — controles do fluxo
// principal entram em IDS_OBRIGATORIOS acima, nunca aqui.
function onOpcional(id, evento, handler) {
  const el = document.getElementById(id);
  if (!el) { console.warn(`[boot] elemento opcional ausente: #${id}`); return; }
  el.addEventListener(evento, handler);
}

// ---------- Header sticky dinâmico ----------
// header h1 cresce com a escala de fonte (rem), mas "nav.tabs { top: 52px }" era um valor fixo —
// em "A Muito grande" (136%) o header passava de 52px e as abas ficavam sobrepondo o título.
// ResizeObserver acompanha qualquer mudança de altura (fonte, largura, quebra de linha, zoom),
// recalculando sozinho — mais robusto que ouvir "resize" e recalcular só no carregamento.
{
  const header = document.querySelector('header');
  const ro = new ResizeObserver(() => {
    document.documentElement.style.setProperty('--header-h', header.offsetHeight + 'px');
  });
  ro.observe(header);
}

// ---------- Acessibilidade — tamanho do texto ----------
// Guardado por aparelho (não por conta), já que é preferência de quem está segurando o celular
// naquele momento, não do usuário logado. Aplica antes de qualquer outra coisa renderizar, pra não
// dar um "pulo" visual no tamanho do texto logo que a página abre.
const FONTE_KEY = 'monitoramento-prf:tamanho-fonte';
function aplicarTamanhoFonte(nivel) {
  if (nivel === 'padrao') delete document.documentElement.dataset.fonte;
  else document.documentElement.dataset.fonte = nivel;
  // Radio nativo (Fase 6) em vez de classList.toggle('on') — marca o input, o CSS
  // (input:checked + .fonte-btn) cuida do visual sozinho.
  document.querySelectorAll('.fonte-opcoes input[type="radio"]').forEach((r) => { r.checked = r.dataset.fonte === nivel; });
  localStorage.setItem(FONTE_KEY, nivel);
}
aplicarTamanhoFonte(localStorage.getItem(FONTE_KEY) || 'padrao');
document.querySelectorAll('.fonte-opcoes input[type="radio"]').forEach((input) => {
  input.addEventListener('change', () => aplicarTamanhoFonte(input.dataset.fonte));
});

// ---------- Login por e-mail (magic link) ----------
// RLS no Supabase (schema.sql) exige auth.role() = 'authenticated' para ler/gravar — sem sessão,
// nada sincroniza. getSession() lê a sessão em cache local sem precisar de rede, então um técnico
// que já fez login uma vez continua trabalhando offline em campo (a fila local não depende disso;
// só a sincronização com o Supabase é que fica bloqueada até haver sessão + sinal).
let sessaoAtual = null;

// Processo "atual" compartilhado entre as abas Ponto de Obs., Mapa e Relatório — pedido explícito:
// selecionar o processo numa aba deveria refletir nas outras, em vez de cada aba esquecer a
// seleção ao trocar. Atualizado pelos três selects de processo; carregarProcessosNoSelect usa isso
// como preferência quando o select da aba que está abrindo ainda não tem nada escolhido.
let processoAtualId = null;

// Perfil (tabela "perfis" no Supabase) — cadastro mínimo obrigatório no primeiro login: nome
// completo, matrícula, setor e formação. Fica em cache local (mesma chave que já existia) para
// não bloquear o app se o técnico abrir offline depois do primeiro cadastro. "aprovado" começa
// falso por padrão no banco (migration-003) — só um admin muda isso direto no Supabase; o
// trigger protege_aprovado() impede o próprio usuário de se auto-aprovar pelo app.
function mapPerfilRemoto(p) {
  return { nome: p.nome_completo, matricula: p.matricula || '', setor: p.setor || '', formacao: p.formacao || '', aprovado: !!p.aprovado };
}
async function carregarPerfilRemoto() {
  if (!sessaoAtual) return null;
  try {
    const { data, error } = await supabase.from('perfis').select('*').eq('user_id', sessaoAtual.user.id).maybeSingle();
    if (error || !data) return null;
    return data;
  } catch { return null; }
}
async function salvarPerfilRemoto(dados) {
  if (!sessaoAtual) return { error: new Error('Sem sessão — faça login novamente.') };
  return supabase.from('perfis').upsert({ user_id: sessaoAtual.user.id, ...dados });
}
function preencherFormPerfil(p) {
  document.getElementById('t-nome').value = p.nome || '';
  document.getElementById('t-matricula').value = p.matricula || '';
  document.getElementById('t-setor').value = p.setor || '';
  document.getElementById('t-formacao').value = p.formacao || '';
}

// Foco vai pro primeiro campo de cada gate assim que ele abre — hoje não existia NENHUMA chamada
// .focus() no app inteiro, então TalkBack/teclado abriam um gate sem noção nenhuma de onde estavam.
const FOCUS_GATE = {
  login: '#login-email',
  perfil: '#pf-nome',
  aguardando: '#btn-verificar-aprovacao',
  novaSenha: '#ns-senha'
};

// Espelha se o app está liberado (nenhum gate aberto) ou bloqueado. Consumida pela Fase 7
// (navegarPara/hashchange) pra decidir se uma troca de aba deve mover o foco — definida nos DOIS
// sentidos (não só quando libera) pra nunca ficar presa em true depois do primeiro login.
let appLiberado = false;

function mostrarGate(qual) {
  const gates = { login: 'login-gate', perfil: 'perfil-gate', aguardando: 'aguardando-gate', novaSenha: 'nova-senha-gate' };
  Object.values(gates).forEach((id) => { document.getElementById(id).style.display = 'none'; });

  // #app-shell cobre header/user-bar/badge/main/footer — os 4 gates ficam FORA dele (irmãos no
  // HTML), então inert desativa só o conteúdo de fundo, nunca o gate que está aberto. Isso substitui
  // de vez o "nav.style.display='none'" antigo (nav já está dentro do shell) e resolve de graça o
  // botão "Sair" (#user-bar, também dentro do shell) ficar tabulável atrás do gate.
  const shell = document.getElementById('app-shell');
  shell.inert = !!qual;
  appLiberado = !qual;

  if (qual) {
    const gate = document.getElementById(gates[qual]);
    gate.style.display = 'flex';
    requestAnimationFrame(() => { gate.querySelector(FOCUS_GATE[qual])?.focus(); });
  } else {
    // Primeira aplicação de view do ciclo de autenticação — sem mover o foco: o app acabou de abrir
    // pra quem está usando, e jogar o cursor aqui seria tão intrusivo quanto faria no boot. Também
    // é o que resolve o deep link: um hash tipo #view-metricas aberto sem sessão fica só "guardado"
    // em location.hash enquanto o gate de login está no ar (hashchange não faz nada com o app
    // bloqueado, ver listener mais abaixo) e é consumido bem aqui, assim que libera.
    aplicarView(viewDoHash(), { moverFoco: false });
  }
  // Nenhuma view perde ".active" aqui (o código antigo fazia isso, só ao ABRIR um gate) — com o
  // conteúdo de fundo já coberto por "inert", isso era redundante, e escondia um bug real: como
  // mostrarGate(null) nunca reativava nenhuma view, um login sem sessão em cache (que passa por
  // mostrarGate('login') primeiro) deixava a tela em branco depois de logar, até a pessoa clicar
  // numa aba manualmente. Não mexer na ".active" corrige os dois de uma vez.
}

async function atualizarUiAuth(session) {
  sessaoAtual = session;
  const userBar = document.getElementById('user-bar');

  if (!session) {
    mostrarGate('login');
    userBar.style.display = 'none';
    return;
  }

  document.getElementById('user-email').textContent = session.user.email;
  userBar.style.display = 'flex';

  // Perfil já em cache local (de um login anterior) — libera o app sem depender de rede, e tenta
  // atualizar do servidor em segundo plano (sem bloquear). Só confia no cache se ele já indicar
  // aprovação — assim quem ainda não foi aprovado não escapa da tela de espera reabrindo o app.
  const perfilLocal = carregarTecnico();
  if (perfilLocal && perfilLocal.nome && perfilLocal.aprovado === true) {
    mostrarGate(null);
    preencherFormPerfil(perfilLocal);
    sincronizarPendentes();
    carregarPerfilRemoto().then((p) => { if (p) { salvarTecnico(mapPerfilRemoto(p)); if (!p.aprovado) mostrarGate('aguardando'); else preencherFormPerfil(mapPerfilRemoto(p)); } });
    return;
  }

  // Sem cache local aprovado — consulta o servidor pra saber o estado real.
  const perfilRemoto = await carregarPerfilRemoto();
  if (perfilRemoto) {
    salvarTecnico(mapPerfilRemoto(perfilRemoto));
    if (!perfilRemoto.aprovado) {
      mostrarGate('aguardando');
      return;
    }
    mostrarGate(null);
    preencherFormPerfil(mapPerfilRemoto(perfilRemoto));
    sincronizarPendentes();
    return;
  }

  // Primeiro acesso deste usuário — cadastro obrigatório antes de liberar o app.
  mostrarGate('perfil');
}

document.getElementById('form-perfil-inicial').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dados = {
    nome_completo: document.getElementById('pf-nome').value.trim(),
    matricula: document.getElementById('pf-matricula').value.trim() || null,
    setor: document.getElementById('pf-setor').value.trim() || null,
    formacao: document.getElementById('pf-formacao').value.trim() || null
  };
  if (!dados.nome_completo) return;
  const msgEl = document.getElementById('perfil-inicial-msg');
  const { error } = await salvarPerfilRemoto(dados);
  if (error) {
    msgEl.innerHTML = `<div class="msg erro">Não foi possível salvar (${escaparTexto(error.message)}). Confira sua conexão e tente de novo.</div>`;
    return;
  }
  salvarTecnico({ nome: dados.nome_completo, matricula: dados.matricula || '', setor: dados.setor || '', formacao: dados.formacao || '', aprovado: false });
  preencherFormPerfil({ nome: dados.nome_completo, matricula: dados.matricula, setor: dados.setor, formacao: dados.formacao });
  // Cadastro sempre nasce não aprovado (default do banco) — cai na tela de espera, não no app.
  mostrarGate('aguardando');
});

document.getElementById('btn-verificar-aprovacao').addEventListener('click', async () => {
  const btn = document.getElementById('btn-verificar-aprovacao');
  const msgEl = document.getElementById('aguardando-msg');
  btn.disabled = true;
  btn.textContent = 'Verificando...';
  const perfilRemoto = await carregarPerfilRemoto();
  btn.disabled = false;
  btn.textContent = 'Verificar novamente';
  if (!perfilRemoto) {
    msgEl.innerHTML = '<div class="msg erro">Não foi possível verificar agora — confira sua conexão.</div>';
    return;
  }
  salvarTecnico(mapPerfilRemoto(perfilRemoto));
  if (perfilRemoto.aprovado) {
    mostrarGate(null);
    preencherFormPerfil(mapPerfilRemoto(perfilRemoto));
    sincronizarPendentes();
  } else {
    msgEl.innerHTML = '<div class="msg ok">Ainda aguardando aprovação.</div>';
  }
});

supabase.auth.getSession().then(({ data }) => atualizarUiAuth(data.session));
supabase.auth.onAuthStateChange((event, session) => {
  // Clicar num link de "esqueci minha senha" estabelece sessão igual a um login normal — sem
  // esse desvio, o app deixava a pessoa entrar direto sem nunca ter definido a senha nova, e o
  // próximo login por senha continuaria falhando pra sempre. PASSWORD_RECOVERY intercepta antes
  // de atualizarUiAuth liberar o app.
  if (event === 'PASSWORD_RECOVERY') {
    sessaoAtual = session;
    mostrarGate('novaSenha');
    return;
  }
  atualizarUiAuth(session);
});

document.getElementById('form-nova-senha').addEventListener('submit', async (e) => {
  e.preventDefault();
  const senha = document.getElementById('ns-senha').value;
  const confirma = document.getElementById('ns-senha-confirma').value;
  const msgEl = document.getElementById('nova-senha-msg');
  if (senha.length < 6) { msgEl.innerHTML = '<div class="msg erro">A senha precisa ter pelo menos 6 caracteres.</div>'; return; }
  if (senha !== confirma) { msgEl.innerHTML = '<div class="msg erro">As senhas não coincidem.</div>'; return; }
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Salvando...';
  const { error } = await supabase.auth.updateUser({ password: senha });
  btn.disabled = false;
  btn.textContent = 'Salvar nova senha';
  if (error) {
    msgEl.innerHTML = `<div class="msg erro">${escaparTexto(error.message)}</div>`;
    return;
  }
  atualizarUiAuth(sessaoAtual);
});

// ---------- Login por e-mail + senha ----------
// Trocado de magic link pra senha convencional: cadastro só na primeira vez, login direto depois
// — sem ficar dependendo de e-mail chegar toda vez (limite de envio do Supabase, link caindo em
// localhost etc. já causaram problema real em campo).
let modoCadastro = false;

function atualizarModoLogin() {
  document.getElementById('login-titulo').textContent = modoCadastro ? 'Criar conta' : 'Entrar';
  document.getElementById('login-desc').textContent = modoCadastro
    ? 'Cadastre um e-mail e uma senha — qualquer e-mail serve, não precisa ser institucional.'
    : 'Digite seu e-mail e senha.';

  const confirma = document.getElementById('login-senha-confirma');
  // hidden (não style.display) pra ficar legível por tecnologia assistiva; disabled tira do Tab e
  // do envio do form — só hidden não bastaria (o campo continuaria tabulável e indo no submit).
  document.getElementById('login-confirma-wrap').hidden = !modoCadastro;
  confirma.disabled = !modoCadastro;
  confirma.required = modoCadastro;
  if (!modoCadastro) confirma.value = '';

  // Os dois botões são type="submit" dentro do mesmo <form> — só um pode estar habilitado por vez,
  // senão Enter no formulário poderia resolver pro botão errado (o primeiro em ordem no DOM,
  // mesmo escondido) dependendo do navegador.
  const btnLogin = document.getElementById('btn-login');
  const btnCadastrar = document.getElementById('btn-cadastrar');
  btnLogin.style.display = modoCadastro ? 'none' : 'block';
  btnLogin.disabled = modoCadastro;
  btnCadastrar.style.display = modoCadastro ? 'block' : 'none';
  btnCadastrar.disabled = !modoCadastro;

  document.getElementById('link-alternar-modo').textContent = modoCadastro ? 'Já tem conta? Entrar' : 'Ainda não tem conta? Cadastre-se';
  document.getElementById('login-msg').innerHTML = '';
}
// Estabelece o estado inicial sem depender do que já está escrito no HTML (que só cobre a
// aparência visual, não os atributos disabled/required que este JS agora controla).
atualizarModoLogin();

document.getElementById('link-alternar-modo').addEventListener('click', () => {
  modoCadastro = !modoCadastro;
  atualizarModoLogin();
});

async function fazerLogin() {
  const email = document.getElementById('login-email').value.trim();
  const senha = document.getElementById('login-senha').value;
  const msgEl = document.getElementById('login-msg');
  if (!email || !senha) { msgEl.innerHTML = '<div class="msg erro">Preencha e-mail e senha.</div>'; return; }
  const btn = document.getElementById('btn-login');
  btn.disabled = true;
  btn.textContent = 'Entrando...';
  const { error } = await supabase.auth.signInWithPassword({ email, password: senha });
  btn.disabled = false;
  btn.textContent = 'Entrar';
  if (error) {
    msgEl.innerHTML = `<div class="msg erro">${error.message === 'Invalid login credentials' ? 'E-mail ou senha incorretos.' : escaparTexto(error.message)}</div>`;
  }
}

async function fazerCadastro() {
  const email = document.getElementById('login-email').value.trim();
  const senha = document.getElementById('login-senha').value;
  const confirma = document.getElementById('login-senha-confirma').value;
  const msgEl = document.getElementById('login-msg');
  if (!email || !senha) { msgEl.innerHTML = '<div class="msg erro">Preencha e-mail e senha.</div>'; return; }
  if (senha.length < 6) { msgEl.innerHTML = '<div class="msg erro">A senha precisa ter pelo menos 6 caracteres.</div>'; return; }
  if (senha !== confirma) { msgEl.innerHTML = '<div class="msg erro">As senhas não coincidem.</div>'; return; }
  const btn = document.getElementById('btn-cadastrar');
  btn.disabled = true;
  btn.textContent = 'Cadastrando...';
  const { data, error } = await supabase.auth.signUp({ email, password: senha });
  btn.disabled = false;
  btn.textContent = 'Criar conta';
  if (error) {
    msgEl.innerHTML = `<div class="msg erro">${escaparTexto(error.message)}</div>`;
    return;
  }
  if (data.session) {
    // Confirmação de e-mail desligada no projeto — já entra direto, sem precisar checar e-mail.
    msgEl.innerHTML = '';
  } else {
    msgEl.innerHTML = `<div class="msg ok">Conta criada! Confirme o e-mail enviado para ${escaparTexto(email)} e depois volte aqui pra entrar.</div>`;
  }
}

// <form> de verdade em vez de inputs soltos + botões type="button": antes disso, apertar Enter no
// campo de senha não fazia nada — era o único fluxo do app sem submit nativo, e é a primeira tela
// que qualquer pessoa encontra.
document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (modoCadastro) await fazerCadastro(); else await fazerLogin();
});

document.getElementById('link-esqueci-senha').addEventListener('click', async () => {
  const email = document.getElementById('login-email').value.trim();
  const msgEl = document.getElementById('login-msg');
  if (!email) { msgEl.innerHTML = '<div class="msg erro">Digite seu e-mail no campo acima primeiro.</div>'; return; }
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
  msgEl.innerHTML = error
    ? `<div class="msg erro">${escaparTexto(error.message)}</div>`
    : `<div class="msg ok">Enviamos um link de redefinição de senha para ${escaparTexto(email)}.</div>`;
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  await supabase.auth.signOut();
  // kml_pontos/kml_poligonos agora sincronizam com o servidor (ver sincronizarPendentes) e, como
  // processos/pontos, podem ter importações ainda não enviadas — por isso NÃO são apagados aqui de
  // propósito: apagar arriscaria perder um KML importado em campo sem sinal ainda. Na prática, só
  // ficam visíveis na tela de quem está com o processo (já filtrado por dono) selecionado, então o
  // resíduo entre contas no mesmo aparelho não é exposto pela interface.
  limparTecnico();
});

// ---------- Mensagens de feedback (somem sozinhas, não ficam presas na tela) ----------
// ---------- Escape de texto/atributo (Fase 9 do plano de acessibilidade — achado de segurança) ----------
// Vários pontos do app interpolam dado digitado pelo usuário (espécie em texto livre, número do
// processo, observações, nome de arquivo de foto) direto em innerHTML sem escapar. Como processos e
// espécies sincronizam com o Supabase e voltam pra outros aparelhos, isso é XSS ARMAZENADO de
// verdade, não só local. escaparTexto cobre contexto de texto solto; escaparAtributo cobre o que
// entra dentro de aspas de atributo (alt, title, aria-label, data-*) — precisa também escapar aspas,
// que escaparTexto sozinho não cobre.
const escaparTexto = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escaparAtributo = (s) => escaparTexto(s)
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Separador decimal consistente (Fase 8 do plano de acessibilidade) — toFixed(2) sempre produz
// ponto ("5.81"), mas o "1,43" (Fator) estático no HTML está em português. Num relatório que vai
// pra processo administrativo do INEA isso destoa. Usar em todo ponto de EXIBIÇÃO em tela/PDF — não
// no Excel, que grava número de verdade e o próprio Excel formata sozinho conforme o idioma da
// planilha.
const fmtDecimal = (n) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Vários pontos do app recriam uma região inteira do DOM a cada interação (renderMosaico, render()
// dos pickers de espécie) — sem restaurar o foco depois, ele volta pro <body>, e quem navega só por
// teclado/TalkBack perde a posição a cada toque. Centraliza o requestAnimationFrame(foco) em vez de
// repetir em cada ponto que recria DOM.
function renderPreservandoFoco(render, seletorFoco) {
  render();
  if (seletorFoco) {
    requestAnimationFrame(() => { document.querySelector(seletorFoco)?.focus(); });
  }
}

function mostrarMsg(elId, html, ms = 4000) {
  const el = document.getElementById(elId);
  if (el._timer) clearTimeout(el._timer);
  el.innerHTML = html;
  el._timer = setTimeout(() => { el.innerHTML = ''; }, ms);
}

// Único preventDefault em <a> neste app — não é navegação de rota (não altera hash nem histórico),
// só move o foco pra dentro do conteúdo principal. Com o gate aberto o link fica sob "inert" e não
// é alcançável por Tab; com o app liberado, é o primeiro elemento focável da página.
document.querySelector('.skip-link').addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('conteudo-principal').focus();
});

// ---------- Navegação entre views (links reais + hash, Fase 7 do plano de acessibilidade) ----------
// São páginas de verdade da aplicação, não um widget de abas — por isso <a href="#view-x"> em vez
// de <button role="tab"> (que exigiria roving tabindex e navegação por setas próprias). Com <a>
// reais, o próprio navegador já grava a entrada no histórico e dispara "hashchange" sozinho: nada de
// pushState/replaceState/popstate aqui, que duplicariam entradas e divergiriam do hash (pushState
// não dispara hashchange nem popstate). Único ponto de navegação programática é navegarPara(), que
// só altera o hash — quem aplica a view de fato é sempre o listener de "hashchange", seja o clique
// no link ou uma chamada interna do código.
const VIEWS_VALIDAS = ['inicio', 'processo', 'ponto', 'mapa', 'metricas'];

function viewDoHash() {
  const nome = (location.hash || '').replace('#view-', '');
  return VIEWS_VALIDAS.includes(nome) ? nome : 'inicio';
}

function navegarPara(nome) {
  const alvo = VIEWS_VALIDAS.includes(nome) ? nome : 'inicio';
  if (viewDoHash() === alvo) {
    // Hash já é o mesmo (ex.: já estou na aba e algo pede pra "ir" pra ela de novo) — nesse caso
    // não dispara hashchange sozinho, então aplica direto.
    if (appLiberado) aplicarView(alvo, { moverFoco: true });
    return;
  }
  location.hash = `#view-${alvo}`;
}

// Aplica de fato uma view: alterna .active das seções e aria-current dos links, e preserva TODOS os
// efeitos colaterais que existiam no antigo irPara(). moverFoco=false na primeira aplicação (logo
// depois do login) — jogar o cursor ali seria tão intrusivo quanto no boot; nas navegações
// seguintes, moverFoco=true leva o foco pro título da nova seção.
function aplicarView(nome, { moverFoco = false } = {}) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.querySelectorAll('nav.tabs a').forEach((a) => a.removeAttribute('aria-current'));
  document.getElementById(`view-${nome}`).classList.add('active');
  document.querySelector(`nav.tabs a[data-view="${nome}"]`).setAttribute('aria-current', 'page');

  if (nome === 'processo') carregarProcessosEdicao();
  // Recarrega a lista de pontos do KML toda vez que a aba abre, mesmo sem trocar de processo —
  // sem isso, importar um KML pela aba Mapa enquanto o processo já estava selecionado aqui deixava
  // essa lista "congelada" no estado antigo (carregarProcessosNoSelect só dispara o "change" que
  // recarrega isso quando o valor do select realmente muda, de propósito, pra não apagar fotos já
  // carregadas no Relatório toda vez que se revisita a aba).
  if (nome === 'ponto') {
    carregarProcessosNoSelect('#pt-processo').then(() => carregarKmlPontosNoSelectPonto(document.getElementById('pt-processo').value));
  }
  if (nome === 'metricas') carregarProcessosNoSelect('#m-processo').then(atualizarMetricas);
  if (nome === 'mapa') carregarProcessosNoSelect('#mapa-processo').then(() => inicializarMapa());
  // Sai da aba Mapa com a navegação ligada = desperdício de bateria de GPS em campo sem
  // necessidade nenhuma (watchPosition continuaria rodando escondido).
  if (nome !== 'mapa') pararNavegacao();

  if (moverFoco) {
    requestAnimationFrame(() => {
      document.querySelector(`#view-${nome} [data-view-title]`)?.focus();
    });
  }
}

// Links não recebem preventDefault() — a navegação nativa acontece (grava histórico sozinha) e só
// reagimos ao hashchange resultante. Única exceção do app inteiro é o skip-link (não é navegação de
// rota, não deve tocar no hash).
window.addEventListener('hashchange', () => {
  // Com o app ainda bloqueado (gate aberto), o hash muda mas fica só como intenção — nenhum efeito
  // colateral roda até a autenticação liberar o shell (mostrarGate(null) então aplica a view atual
  // do hash). #app-shell já está "inert" nesse momento, então o foco nem entraria no conteúdo de
  // qualquer forma — esta é a segunda barreira, a que impede os efeitos colaterais em si.
  if (!appLiberado) return;
  aplicarView(viewDoHash(), { moverFoco: true });
});

// ---------- Cálculos do protocolo DAR (Manual INEA 2016 + Anexo II) ----------
function calcularPontos(area) {
  const ia = Math.round((area - 1) + 5);
  return Math.min(ia, 50);
}

// Atrativos de fauna e Riqueza aparente são cumulativos do polígono inteiro: cada ponto
// contribui uma contagem de NOVIDADES, e a classificação final vale igual para todos os pontos.
function classificarAtrativos(total) {
  if (total <= 3) return 0;
  if (total === 4) return 0.65;
  return 1.0;
}
function classificarRiqueza(total) {
  if (total < 10) return 0;
  if (total <= 20) return 0.65;
  return 1.0;
}
function labelClassificacao(v) {
  if (v === 0) return 'Crítica (0)';
  if (v === 0.65) return 'Mínima (0,65)';
  return 'Adequada (1,0)';
}
function classificarConceito(c) {
  if (c < 5.0) return { texto: 'Crítico', classe: 'critico' };
  if (c < 8.0) return { texto: 'Mínimo', classe: 'minimo' };
  return { texto: 'Adequado', classe: 'adequado' };
}

const PARAMS_DIRETOS = {
  necessidade_replantio: 'Necessidade de replantio',
  cobertura_copa: 'Cobertura de copa',
  distribuicao_especies: 'Distribuição das espécies',
  altura_estimada: 'Altura estimada',
  competicao: 'Competição'
};

function listaEspecies(campo) {
  return (campo || '').split(';').map((s) => s.trim()).filter(Boolean);
}

// Busca os pontos de um processo mesclando o IndexedDB local com o Supabase (mesmo padrão já usado
// em carregarProcessosNoSelect/carregarProcessosEdicao para processos). Sem isso, um ponto lançado
// num aparelho diferente do que está sendo usado agora (ou um IndexedDB limpo pelo Safari por
// inatividade) simplesmente não aparecia aqui — mesmo já estando salvo e sincronizado no servidor.
// Isso derrubava Relatório, mosaico de fotos e exportação inteiros ("nenhum ponto avaliado") para
// quem trabalha em mais de um aparelho ou reinstala o app.
// Mesma lógica de buscarPontosDoProcesso, mas pro próprio registro do processo — achado depois de
// um relato real: mesmo com os pontos já mesclando local+remoto corretamente, o Relatório e os
// exports de PDF/Excel ainda buscavam o PROCESSO só no IndexedDB local (listarTodos('processos')
// + find). Depois de limpar os dados do Safari (pedido nosso, pra testar cache), o processo sumiu
// do local nesse aparelho — e mesmo os pontos sendo encontrados certinho no servidor, o app trava
// achando "processo inválido" antes mesmo de chegar nos pontos.
// O IndexedDB local é um banco só, do aparelho — não é filtrado pelo Supabase (RLS só protege
// consultas de verdade ao servidor) e nunca é limpo ao trocar de conta no mesmo aparelho/navegador.
// Sem esse filtro, quem loga com uma conta diferente da que usou esse aparelho antes enxergava os
// processos/pontos da conta anterior misturados nos dela — vazamento real de dado entre usuários,
// só do lado do cache local (o servidor sempre protegeu certo, via criado_por = auth.uid()).
function listarLocaisDoUsuario(todos) {
  const uid = sessaoAtual?.user?.id;
  if (!uid) return [];
  return todos.filter((r) => r.criado_por === uid);
}

async function buscarProcessoPorId(processoId) {
  if (!processoId) return null;
  const [locaisTodos, remotos] = await Promise.all([
    listarTodos('processos'),
    estaOnline().then((ok) => (ok ? supabase.from('processos').select('*').eq('id', processoId) : { data: [] }))
  ]);
  const locais = listarLocaisDoUsuario(locaisTodos);
  const todos = [...locais, ...(remotos.data || [])];
  const unicos = Object.fromEntries(todos.map((p) => [p.id, p]));
  return unicos[processoId] || null;
}

async function buscarPontosDoProcesso(processoId) {
  const [locaisTodos, remotos] = await Promise.all([
    listarTodos('pontos'),
    estaOnline().then((ok) => (ok ? supabase.from('pontos_observacao').select('*').eq('processo_id', processoId) : { data: [] }))
  ]);
  const locais = listarLocaisDoUsuario(locaisTodos).filter((p) => p.processo_id === processoId);
  const todos = [...locais, ...(remotos.data || [])];
  return Object.values(Object.fromEntries(todos.map((p) => [p.id, p])));
}

// Conceito final = média dos somatórios dos pontos x (10 / n° parâmetros) — Manual INEA, seção 4.3.2.
async function calcularMetricasProcesso(processoId) {
  const pontos = await buscarPontosDoProcesso(processoId);
  if (pontos.length === 0) return null;

  const totalAtrativos = pontos.reduce((a, p) => a + (p.atrativos_fauna_novos || 0), 0);
  const totalRiqueza = pontos.reduce((a, p) => a + (p.riqueza_aparente_novos || 0), 0);
  const notaAtrativos = classificarAtrativos(totalAtrativos);
  const notaRiqueza = classificarRiqueza(totalRiqueza);

  const linhas = pontos.map((p) => {
    const diretas = Object.keys(PARAMS_DIRETOS).map((k) => p[k]);
    const somatorio = diretas.reduce((a, b) => a + b, 0) + notaAtrativos + notaRiqueza;
    return { ponto: p, somatorio };
  });

  const mediaSomatorios = linhas.reduce((a, l) => a + l.somatorio, 0) / linhas.length;
  const conceito = Number((mediaSomatorios * (10 / 7)).toFixed(2));

  const alertas = [];
  let temZero = notaAtrativos === 0 || notaRiqueza === 0;
  for (const [key, nome] of Object.entries(PARAMS_DIRETOS)) {
    const zeros = pontos.filter((p) => p[key] === 0).length;
    if (zeros > 0) temZero = true;
    if (zeros / pontos.length > 0.5) alertas.push(`"${nome}" está crítico em mais de 50% dos pontos de observação.`);
  }
  if (temZero) {
    alertas.unshift('Ao menos um parâmetro obteve nota crítica (0). Pelo protocolo, o processo não pode ser considerado apto para quitação, mesmo que o conceito final seja maior ou igual a 8,0.');
  }

  const especiesFauna = new Set();
  const especiesVegetal = new Set();
  pontos.forEach((p) => {
    listaEspecies(p.especies_zoocoricas_observadas).forEach((s) => especiesFauna.add(s));
    listaEspecies(p.especies_vegetais_observadas).forEach((s) => especiesVegetal.add(s));
  });

  return {
    pontos, linhas, mediaSomatorios, conceito, notaAtrativos, notaRiqueza,
    totalAtrativos, totalRiqueza, apto: conceito >= 8.0 && !temZero, alertas,
    especiesFauna, especiesVegetal
  };
}

// ---------- Controle Crítica/Mínima/Adequada (radios nativos com visual "segmented") ----------
// Textos oficiais do Anexo II (Ficha DAR) — mostrados ao selecionar cada opção, pra levar o
// avaliador a confirmar se a situação marcada realmente bate com o que ele está vendo no ponto.
const DESCRICOES_SITUACAO = {
  necessidade_replantio: {
    '0': 'Apresenta muitas falhas na área observada, verifica-se necessidade de replantio na maior parte do ponto observação. As falhas ocorrem em "manchas" e espalhadas por toda a área. O replantio, adensamento e/ou enriquecimento é necessário para o sucesso do projeto.',
    '0.65': 'As falhas na área observada são pontuais na maior parte do ponto observação. A necessidade de replantio, adensamento e/ou enriquecimento é baixa.',
    '1.0': 'As falhas na área observada não são evidentes. Considera-se não haver necessidade de replantio, adensamento e/ou enriquecimento.'
  },
  cobertura_copa: {
    '0': 'As copas das mudas/árvores se tocam em poucos ou nenhum ponto da área avaliada. Há predominância de indivíduos isolados.',
    '0.65': 'As copas das mudas/árvores se tocam em alguns pontos da área avaliada, as árvores formam pequenos agrupamentos e há pouca presença de indivíduos isolados.',
    '1.0': 'As copas das mudas/árvores se tocam na maioria dos pontos da área avaliada.'
  },
  distribuicao_especies: {
    '0': 'Há predomínio de uma espécie arbustiva/arbórea no ponto de observação avaliado.',
    '0.65': 'Percebe-se o predomínio de até três espécies arbóreas no ponto avaliado.',
    '1.0': 'Não há predominância aparente e as espécies encontram-se bem distribuídas no ponto avaliado.'
  },
  altura_estimada: {
    '0': 'Os indivíduos na área avaliada apresentam altura média estimada de até 1,5 m, estão acima da linha da cintura e próximos do nível do peito do avaliador.',
    '0.65': 'Os indivíduos na área avaliada apresentam altura média estimada maior que 1,5 e até 3,0 m. As plantas ultrapassam em poucos centímetros a altura do avaliador com os braços esticados para cima.',
    '1.0': 'Os indivíduos na área avaliada apresentam altura média estimada maior que 3,0 m. As plantas ultrapassam em alguns metros a altura do avaliador.'
  },
  competicao: {
    '0': 'A presença de gramíneas (ou outras espécies invasoras) compromete o desenvolvimento das mudas/árvores plantadas e o estabelecimento da regeneração natural.',
    '0.65': 'Apresenta competição com as mudas/árvores em pequenas porções do ponto avaliado, percebe-se que a presença das gramíneas (ou outras espécies invasoras) impede/prejudica o estabelecimento da regeneração natural.',
    '1.0': 'Não há presença de gramíneas (ou outras espécies invasoras) ou quando presentes não há competição aparente com as mudas/árvores ou não impedem o desenvolvimento do plantio e o estabelecimento da regeneração natural.'
  }
};

// Radios nativos (Fase 6 do plano de acessibilidade) em vez de <button> com estado só em classList —
// os botões já respondiam a Enter/Espaço (não havia bloqueio de teclado), mas o estado selecionado
// não existia pra tecnologia assistiva. Radio nativo dá de graça agrupamento, estado, navegação por
// setas e semântica corretos — é escolha exclusiva de três, o caso de uso exato pra radio.
document.querySelectorAll('.segmented').forEach((group) => {
  group.querySelectorAll('input[type="radio"]').forEach((input) => {
    input.addEventListener('change', () => {
      const paramEl = group.closest('.dar-param[data-param]');
      const explicacaoEl = paramEl?.querySelector('.explicacao-situacao');
      const descricoes = paramEl && DESCRICOES_SITUACAO[paramEl.dataset.param];
      if (explicacaoEl && descricoes) {
        const label = group.querySelector(`label[for="${input.id}"]`);
        explicacaoEl.innerHTML = `<b>${label?.textContent ?? ''} — faz sentido pro que você está vendo neste ponto?</b><br>${descricoes[input.dataset.valor]}`;
        explicacaoEl.classList.add('show');
      }
    });
  });
});
function getSegmentedValue(paramName) {
  const el = document.querySelector(`.dar-param[data-param="${paramName}"] input[type="radio"]:checked`);
  return el ? parseFloat(el.dataset.valor) : null;
}
function resetSegmented() {
  document.querySelectorAll('.dar-param input[type="radio"]:checked').forEach((el) => { el.checked = false; });
}
// Contraparte de getSegmentedValue, pra preencher o formulário na correção de um ponto já salvo —
// marca o radio e dispara "change" manualmente (setar .checked por script não dispara o evento
// sozinho) pra também mostrar o texto de explicação da situação, igual aconteceria se o avaliador
// tivesse clicado na hora.
function setSegmentedValue(paramName, valor) {
  // data-valor no HTML é sempre "0", "0.65" ou "1.0" (texto) — valor aqui vem do banco como número
  // (parseFloat("1.0") === 1), então "1" não bate com o atributo "1.0" por comparação direta de string.
  const texto = valor === 1 ? '1.0' : String(valor);
  const el = document.querySelector(`.dar-param[data-param="${paramName}"] input[data-valor="${texto}"]`);
  if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
}

// ---------- Busca de espécies (lista IBAMA — nome vulgar / nome científico) ----------
let especiesCache = null;
async function carregarEspecies() {
  if (especiesCache) return especiesCache;
  const resp = await fetch('/especies.json');
  especiesCache = await resp.json();
  return especiesCache;
}
// opts.onAdd(texto): chamado quando uma espécie NOVA é adicionada por interação direta do usuário
// (clique na lista ou Enter) — não dispara em adicaoExterna(), pra evitar loop entre os dois pickers.
function createSpeciesPicker(inputId, listId, chipsId, opts = {}) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  const chipsEl = document.getElementById(chipsId);
  let chips = [];
  let excluidas = new Set(); // espécies já contabilizadas em pontos anteriores deste processo

  // ---------- Combobox ARIA (Fase 5 do plano de acessibilidade) ----------
  // Antes, as sugestões eram <div class="item"> com click, sem ArrowDown/ArrowUp, sem opção ativa,
  // sem Esc, sem listbox/option — a entrada de espécie por texto livre já era operável por teclado
  // (Enter), mas o autocomplete/sugestões em si não era nem operável nem exposto a tecnologia
  // assistiva. Ids das opções precisam ser únicos no documento inteiro porque este picker é
  // instanciado duas vezes (fauna/vegetal) e as duas listas coexistem na mesma tela — por isso o
  // prefixo com o próprio listId, que já é único.
  // Decisão 12.1 (texto livre no autocomplete) ainda não foi tomada pelo usuário — preservado
  // exatamente como estava (Enter sem opção ativa continua adicionando o texto digitado). Tratar
  // como entrega separada quando a decisão vier, sem travar esta fase.
  let matchesAtuais = [];
  let indiceAtivo = -1;
  const idOpcao = (i) => `${listId}-opt-${i}`;

  function fecharLista() {
    list.classList.remove('show');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    matchesAtuais = [];
    indiceAtivo = -1;
  }

  function renderLista(matches) {
    matchesAtuais = matches;
    indiceAtivo = -1;
    input.removeAttribute('aria-activedescendant');
    list.innerHTML = matches.length
      ? matches.map((e, i) => `<div class="item" role="option" id="${idOpcao(i)}" aria-selected="false" data-t="${escaparAtributo(e.texto)}"><div class="cientifico">${escaparTexto(e.c)}</div><div class="popular">${escaparTexto(e.p)}</div></div>`).join('')
      : '<div class="item" role="option" aria-disabled="true">Nenhuma espécie nova encontrada (as já contadas neste processo ficam de fora da busca) — pressione Enter para adicionar como texto livre, só se for mesmo uma novidade.</div>';
    list.classList.add('show');
    input.setAttribute('aria-expanded', 'true');
  }

  // Move a opção ativa com as setas, sem tirar o foco do input — atualiza aria-activedescendant
  // (é isso que o leitor de tela anuncia) e rola a opção pra dentro da área visível.
  function moverOpcaoAtiva(delta) {
    const itens = list.querySelectorAll('.item[role="option"]:not([aria-disabled])');
    if (!itens.length) return;
    if (indiceAtivo >= 0) itens[indiceAtivo]?.setAttribute('aria-selected', 'false');
    indiceAtivo = (indiceAtivo + delta + itens.length) % itens.length;
    itens[indiceAtivo].setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', itens[indiceAtivo].id);
    itens[indiceAtivo].scrollIntoView({ block: 'nearest' });
  }

  function render() {
    chipsEl.innerHTML = chips.map((c, i) =>
      `<span class="chip">${escaparTexto(c)}<button type="button" data-i="${i}" aria-label="Remover espécie ${escaparAtributo(c)}">×</button></span>`).join('');
    chipsEl.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      chips.splice(Number(b.dataset.i), 1);
      // O chip removido deixa de existir, então não tem "o mesmo elemento" pra devolver o foco —
      // o campo de busca é o destino que faz sentido pra continuar navegando/digitando.
      renderPreservandoFoco(render, `#${inputId}`);
      // Remover uma espécie muda o cumulativo do processo tanto quanto adicionar — sem isso, o
      // número exibido em tela (Atrativos de fauna / Riqueza aparente) ficava desatualizado até
      // trocar de processo, e é esse número que orienta a classificação em campo.
      if (opts.onChange) opts.onChange();
    }));
  }

  function adicionar(texto, { externa } = {}) {
    if (!texto || excluidas.has(texto) || chips.includes(texto)) return false;
    chips.push(texto);
    render();
    if (!externa && opts.onAdd) opts.onAdd(texto);
    if (opts.onChange) opts.onChange();
    return true;
  }

  input.addEventListener('input', async () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { fecharLista(); list.innerHTML = ''; return; }
    const especies = await carregarEspecies();
    const matches = especies
      .map((e) => ({ ...e, texto: `${e.c} (${e.p})` }))
      .filter((e) => (e.p.toLowerCase().includes(q) || e.c.toLowerCase().includes(q)) && !excluidas.has(e.texto) && !chips.includes(e.texto))
      .slice(0, 20);
    renderLista(matches);
  });

  list.addEventListener('click', (e) => {
    const item = e.target.closest('.item[data-t]');
    if (!item) return;
    adicionar(item.dataset.t);
    input.value = '';
    fecharLista();
  });

  input.addEventListener('keydown', (e) => {
    const listaAberta = list.classList.contains('show');
    if (e.key === 'ArrowDown') {
      if (!listaAberta) return;
      e.preventDefault();
      moverOpcaoAtiva(1);
    } else if (e.key === 'ArrowUp') {
      if (!listaAberta) return;
      e.preventDefault();
      moverOpcaoAtiva(-1);
    } else if (e.key === 'Escape') {
      if (!listaAberta) return;
      e.preventDefault();
      fecharLista();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Opção ativa (navegada por seta) tem prioridade — vira a forma canônica. Sem opção ativa,
      // mantém o comportamento atual de texto livre (decisão 12.1 ainda pendente, ver comentário
      // acima da função).
      if (indiceAtivo >= 0 && matchesAtuais[indiceAtivo]) {
        adicionar(matchesAtuais[indiceAtivo].texto);
      } else {
        adicionar(input.value.trim());
      }
      input.value = '';
      fecharLista();
    }
    // Home/End: comportamento normal de texto do input — não interceptar.
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest(`#${inputId}`) && !e.target.closest(`#${listId}`)) fecharLista();
  });

  return {
    getValue: () => chips.join('; '),
    reset: () => { chips = []; render(); },
    setExcluidas: (set) => { excluidas = set; },
    adicionarExterna: (texto) => adicionar(texto, { externa: true }),
    contagem: () => chips.length
  };
}
// Riqueza aparente conta TODAS as espécies arbustivas/arbóreas vistas (>60cm); Atrativos de fauna
// conta as que têm flor/fruto — ou seja, toda espécie de atrativos também é, por definição, uma
// espécie de riqueza. Por isso o picker de fauna precisa existir depois do de riqueza, pra poder
// empurrar a espécie pra lá automaticamente (sem digitar duas vezes).
// onChange (novo, Fase 10 do plano de acessibilidade): antes só o faunaPicker notificava o
// cumulativo, e só no onAdd — vegetalPicker não tinha onAdd nenhum, e remover um chip em qualquer
// um dos dois não notificava nada. Resultado real: adicionar espécie direto na Riqueza aparente, ou
// remover qualquer chip, deixava o número cumulativo exibido em tela desatualizado até trocar de
// processo — e é esse número que orienta a classificação (Crítica/Mínima/Adequada) em campo.
const vegetalPicker = createSpeciesPicker('pt-vegetal-busca', 'pt-vegetal-lista', 'pt-vegetal-chips', {
  onChange: () => atualizarPreviewCumulativo()
});
const faunaPicker = createSpeciesPicker('pt-fauna-busca', 'pt-fauna-lista', 'pt-fauna-chips', {
  onAdd: (texto) => { vegetalPicker.adicionarExterna(texto); },
  onChange: () => atualizarPreviewCumulativo()
});

// ---------- Dados do técnico avaliador (edição posterior — o cadastro obrigatório é no perfil-gate) ----------
preencherFormPerfil(carregarTecnico());
document.getElementById('form-tecnico').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dados = {
    nome: document.getElementById('t-nome').value.trim(),
    matricula: document.getElementById('t-matricula').value.trim(),
    setor: document.getElementById('t-setor').value.trim(),
    formacao: document.getElementById('t-formacao').value.trim(),
    // Preserva o "aprovado" já em cache — esse formulário só edita dados de exibição,
    // nunca deve apagar o estado de aprovação salvo localmente.
    aprovado: carregarTecnico().aprovado === true
  };
  salvarTecnico(dados);
  mostrarMsg('tecnico-msg', '<div class="msg ok">Dados salvos neste aparelho.</div>');
  const { error } = await salvarPerfilRemoto({
    nome_completo: dados.nome, matricula: dados.matricula || null, setor: dados.setor || null, formacao: dados.formacao || null
  });
  if (!error) mostrarMsg('tecnico-msg', '<div class="msg ok">Dados salvos e sincronizados.</div>');
});

// ---------- Fila local + sincronização ----------
async function estaOnline() {
  if (!navigator.onLine) return false;
  try {
    const { error } = await supabase.from('processos').select('id').limit(1);
    return !error;
  } catch {
    return false;
  }
}

async function sincronizarPendentes() {
  if (!(await estaOnline())) { await atualizarBadgePendentes(); return; }

  const processosPendentes = await listarPendentes('processos');
  for (const p of processosPendentes) {
    const { sincronizado, ...registro } = p;
    const { error } = await supabase.from('processos').upsert(registro);
    if (!error) await marcarSincronizado('processos', p.id);
  }

  // pontos NÃO entram aqui — ver enviarPontoRevisado/enviarTodosPontosRevisados. A pedido explícito:
  // como hoje não existe forma de corrigir um ponto já sincronizado, ele fica retido neste aparelho
  // até o avaliador revisar e confirmar o envio na aba Relatório, em vez de subir sozinho.

  // kml_pontos/kml_poligonos ficavam só no aparelho (ver comentário mais acima) — passaram a
  // sincronizar porque o mapa público (WebGIS) precisa ler essa geometria do servidor, não só do
  // IndexedDB local. Sem criado_por (importações antigas, feitas antes desta mudança) não têm dono
  // pra RLS aceitar — ficam puladas aqui e continuam funcionando normalmente só neste aparelho.
  const kmlPontosPendentes = (await listarPendentes('kml_pontos')).filter((p) => p.criado_por);
  for (const kp of kmlPontosPendentes) {
    const { sincronizado, lat, lon, ...resto } = kp;
    const registro = { ...resto, geom: `SRID=4326;POINT(${lon} ${lat})` };
    const { error } = await supabase.from('kml_pontos').upsert(registro);
    if (!error) await marcarSincronizado('kml_pontos', kp.id);
  }

  const kmlPoligonosPendentes = (await listarPendentes('kml_poligonos')).filter((p) => p.criado_por);
  for (const kpol of kmlPoligonosPendentes) {
    const { sincronizado, anel, ...resto } = kpol;
    const fechado = anel[0][0] === anel[anel.length - 1][0] && anel[0][1] === anel[anel.length - 1][1]
      ? anel : [...anel, anel[0]];
    const wkt = 'SRID=4326;POLYGON((' + fechado.map(([lat, lon]) => `${lon} ${lat}`).join(', ') + '))';
    const registro = { ...resto, geom: wkt };
    const { error } = await supabase.from('kml_poligonos').upsert(registro);
    if (!error) await marcarSincronizado('kml_poligonos', kpol.id);
  }

  atualizarBadgePendentes();
}

// Envio manual de UM ponto já revisado — chamado a partir do card "Revisão antes de enviar" na aba
// Relatório (ver carregarRevisaoPontos). Separado de sincronizarPendentes de propósito: pontos não
// sobem mais sozinhos, só quando o avaliador confirma aqui (ou em "Confirmar e enviar todos").
async function enviarPontoRevisado(id) {
  if (!(await estaOnline())) return { ok: false, motivo: 'sem-sinal' };
  const pt = (await listarTodos('pontos')).find((p) => p.id === id);
  if (!pt) return { ok: false, motivo: 'não encontrado neste aparelho' };
  const { sincronizado, ...registro } = pt;
  const { error } = await supabase.from('pontos_observacao').upsert(registro);
  if (error) return { ok: false, motivo: error.message };
  await marcarSincronizado('pontos', id);
  return { ok: true };
}

async function atualizarBadgePendentes() {
  const n = await contarPendentes();
  const badge = document.getElementById('pendentes-badge');
  const texto = document.getElementById('pendentes-badge-texto');
  if (n > 0) {
    badge.style.display = 'flex';
    // "Processo/KML" pra deixar claro que isso NÃO inclui pontos de observação — esses ficam
    // retidos de propósito pra revisão manual (ver card "Revisão antes de enviar" no Relatório) e
    // têm contagem própria, não entram neste número (ver comentário em contarPendentes, db.js).
    texto.textContent = `${n} registro(s) de processo/KML pendente(s) de sincronização`;
  } else {
    badge.style.display = 'none';
  }
}
document.getElementById('btn-sincronizar-agora').addEventListener('click', async () => {
  const btn = document.getElementById('btn-sincronizar-agora');
  btn.disabled = true;
  btn.textContent = 'Sincronizando...';
  await sincronizarPendentes();
  btn.disabled = false;
  btn.textContent = 'Sincronizar agora';
});
window.addEventListener('online', sincronizarPendentes);
document.addEventListener('visibilitychange', () => { if (!document.hidden) sincronizarPendentes(); });

// ---------- Adicionar / Corrigir Processo ----------
document.getElementById('p-area').addEventListener('input', (e) => {
  const area = parseFloat(e.target.value);
  document.getElementById('p-num-pontos').value = isNaN(area) ? '—' : calcularPontos(area);
});

async function carregarProcessosEdicao() {
  const [locaisTodos, remotos] = await Promise.all([
    listarTodos('processos'),
    estaOnline().then((ok) => (ok ? supabase.from('processos').select('*') : { data: [] }))
  ]);
  const todos = [...listarLocaisDoUsuario(locaisTodos), ...(remotos.data || [])];
  const unicos = Object.values(Object.fromEntries(todos.map((p) => [p.id, p])));
  const el = document.getElementById('p-editar-select');
  const valorAtual = el.value;
  el.innerHTML = '<option value="">— Novo processo —</option>' +
    unicos.map((p) => `<option value="${escaparAtributo(p.id)}">${escaparTexto(p.numero_administrativo)}</option>`).join('');
  el.value = unicos.some((p) => p.id === valorAtual) ? valorAtual : '';
  return unicos;
}

function preencherFormProcesso(p) {
  document.getElementById('p-id-edicao').value = p ? p.id : '';
  document.getElementById('p-numero').value = p?.numero_administrativo || '';
  document.getElementById('p-formacao').value = p?.formacao_vegetal || '';
  document.getElementById('p-area').value = p?.area_ha ?? '';
  document.getElementById('p-num-pontos').value = p ? p.num_pontos : '—';
  document.getElementById('p-razao-social').value = p?.razao_social || '';
  document.getElementById('p-cpf-cnpj').value = p?.cpf_cnpj || '';
  document.getElementById('p-endereco').value = p?.endereco || '';
  document.getElementById('p-complemento').value = p?.complemento || '';
  document.getElementById('p-municipio').value = p?.municipio || '';
  document.getElementById('p-cep').value = p?.cep || '';
  document.getElementById('p-contato-nome').value = p?.contato_nome || '';
  document.getElementById('p-contato-telefone').value = p?.contato_telefone || '';
  document.getElementById('p-contato-email').value = p?.contato_email || '';
  document.getElementById('p-publico').checked = p?.publico || false;
  document.getElementById('processo-form-titulo').textContent = p ? 'Corrigir Processo' : 'Adicionar Processo';
  document.getElementById('btn-salvar-processo').textContent = p ? 'Salvar correções' : 'Salvar processo';
  document.getElementById('btn-cancelar-edicao-processo').style.display = p ? 'inline-block' : 'none';
}

document.getElementById('p-editar-select').addEventListener('change', async (e) => {
  const id = e.target.value;
  if (!id) { preencherFormProcesso(null); return; }
  processoAtualId = id;
  preencherFormProcesso(await buscarProcessoPorId(id));
});

document.getElementById('btn-cancelar-edicao-processo').addEventListener('click', () => {
  document.getElementById('p-editar-select').value = '';
  preencherFormProcesso(null);
});

document.getElementById('form-processo').addEventListener('submit', async (e) => {
  e.preventDefault();
  const area = parseFloat(document.getElementById('p-area').value);
  const idEdicao = document.getElementById('p-id-edicao').value;
  const original = idEdicao ? await buscarProcessoPorId(idEdicao) : null;
  const registro = {
    id: idEdicao || crypto.randomUUID(),
    numero_administrativo: document.getElementById('p-numero').value,
    formacao_vegetal: document.getElementById('p-formacao').value,
    area_ha: area,
    num_pontos: calcularPontos(area),
    razao_social: document.getElementById('p-razao-social').value || null,
    cpf_cnpj: document.getElementById('p-cpf-cnpj').value || null,
    endereco: document.getElementById('p-endereco').value || null,
    complemento: document.getElementById('p-complemento').value || null,
    municipio: document.getElementById('p-municipio').value || null,
    cep: document.getElementById('p-cep').value || null,
    contato_nome: document.getElementById('p-contato-nome').value || null,
    contato_telefone: document.getElementById('p-contato-telefone').value || null,
    contato_email: document.getElementById('p-contato-email').value || null,
    publico: document.getElementById('p-publico').checked,
    criado_por: original?.criado_por ?? sessaoAtual?.user?.id ?? null,
    criado_em: original?.criado_em || new Date().toISOString()
  };
  await salvarLocal('processos', registro);
  // Processo recém-cadastrado (ou corrigido) vira o "processo atual" — quem acabou de cadastrar
  // normalmente quer seguir direto pra Ponto de Obs./Mapa já com ele selecionado, sem escolher de
  // novo numa lista.
  processoAtualId = registro.id;

  // KML opcional no próprio cadastro do processo — evita ter que ir na aba Mapa separadamente só
  // pra subir o polígono/pontos planejados logo depois de cadastrar.
  const kmlFile = document.getElementById('p-kml').files[0];
  let kmlMsgExtra = '';
  if (kmlFile) {
    try {
      const { pontos, poligonos } = await importarKmlNoProcesso(kmlFile, registro.id);
      const partes = [];
      if (pontos) partes.push(`${pontos} ponto(s)`);
      if (poligonos) partes.push(`${poligonos} polígono(s)`);
      kmlMsgExtra = partes.length
        ? ` ${partes.join(' e ')} do KML importado(s) — já aparecem na aba Mapa.`
        : ' O arquivo KML enviado não tinha ponto nem polígono reconhecível.';
    } catch (erroKml) {
      kmlMsgExtra = ' Processo salvo, mas não foi possível ler o arquivo KML enviado.';
      console.error('Erro ao importar KML no cadastro do processo:', erroKml);
    }
  }

  mostrarMsg('processo-msg', `<div class="msg ok">${idEdicao ? 'Processo atualizado.' : 'Processo salvo.'}${kmlMsgExtra}</div>`);
  e.target.reset();
  preencherFormProcesso(null);
  document.getElementById('p-editar-select').value = '';
  carregarProcessosEdicao();
  // Sincroniza em segundo plano — salvar localmente já é suficiente pra liberar o formulário;
  // esperar a rede aqui deixava o app parecendo travado em sinal fraco de campo.
  sincronizarPendentes();
});

// ---------- Adicionar Ponto de Observação ----------
async function carregarProcessosNoSelect(seletor) {
  const [locaisTodos, remotos] = await Promise.all([
    listarTodos('processos'),
    estaOnline().then((ok) => (ok ? supabase.from('processos').select('*') : { data: [] }))
  ]);
  const todos = [...listarLocaisDoUsuario(locaisTodos), ...(remotos.data || [])];
  const unicos = Object.values(Object.fromEntries(todos.map((p) => [p.id, p])));
  const el = document.querySelector(seletor);
  const valorAnterior = el.value; // captura antes do innerHTML resetar o <select>
  // Se esta aba ainda não tem nada selecionado, usa o processo escolhido por último em qualquer
  // outra aba (Ponto de Obs./Mapa/Relatório) — é o que faz o processo "grudar" ao trocar de aba.
  const valorAtual = valorAnterior || processoAtualId;
  el.innerHTML = '<option value="" disabled>Selecione o processo</option>' +
    unicos.map((p) => `<option value="${escaparAtributo(p.id)}">${escaparTexto(p.numero_administrativo)}</option>`).join('');
  if (valorAtual && unicos.some((p) => p.id === valorAtual)) {
    el.value = valorAtual;
    // Só dispara "change" quando o valor está sendo definido AGORA (veio da memória compartilhada
    // processoAtualId, esta aba ainda não tinha nada escolhido) — sem isso, os efeitos colaterais
    // (contadores, espécies já observadas, marcadores do mapa) nunca rodavam ao trocar de aba.
    // Só dispara quando o valor muda de verdade: se já disparasse toda vez, revisitar a aba
    // Relatório sem trocar de processo apagaria as fotos já carregadas (o handler daquele select
    // reseta o mosaico a cada "change").
    if (valorAtual !== valorAnterior) el.dispatchEvent(new Event('change'));
  } else {
    el.querySelector('option[value=""]').selected = true;
  }
  return unicos;
}

// Espécies já registradas em pontos anteriores do mesmo processo — agora BLOQUEIA de verdade a
// repetição (via setExcluidas nos pickers), além de mostrar a lista como referência.
async function atualizarEspeciesJaObservadas() {
  const processoId = document.getElementById('pt-processo').value;
  const faunaEl = document.getElementById('pt-fauna-ja-observadas');
  const vegetalEl = document.getElementById('pt-vegetal-ja-observadas');
  if (!processoId) {
    faunaEl.textContent = ''; vegetalEl.textContent = '';
    faunaPicker.setExcluidas(new Set()); vegetalPicker.setExcluidas(new Set());
    return;
  }

  // Na correção de um ponto já salvo, o próprio ponto não pode contar contra si mesmo — senão as
  // espécies que ele mesmo registrou apareceriam "já observadas" e bloqueariam o picker de aceitar
  // de volta os valores que estamos justamente tentando restaurar no formulário.
  const idEmEdicao = document.getElementById('pt-id-edicao').value;
  const pontos = (await buscarPontosDoProcesso(processoId)).filter((p) => p.id !== idEmEdicao);
  const fauna = new Set();
  const vegetal = new Set();
  pontos.forEach((p) => {
    listaEspecies(p.especies_zoocoricas_observadas).forEach((s) => fauna.add(s));
    listaEspecies(p.especies_vegetais_observadas).forEach((s) => vegetal.add(s));
  });
  faunaPicker.setExcluidas(fauna);
  vegetalPicker.setExcluidas(vegetal);
  faunaEl.textContent = fauna.size
    ? `Já contabilizadas neste processo (${fauna.size}) — não aparecem mais na busca: ${[...fauna].join('; ')}`
    : 'Nenhuma espécie com atrativo registrada ainda neste processo.';
  vegetalEl.textContent = vegetal.size
    ? `Já contabilizadas neste processo (${vegetal.size}) — não aparecem mais na busca: ${[...vegetal].join('; ')}`
    : 'Nenhuma espécie vegetal registrada ainda neste processo.';
}

async function atualizarConceitoParcial() {
  const processoId = document.getElementById('pt-processo').value;
  const el = document.getElementById('pt-conceito-parcial');
  if (!processoId) { el.textContent = ''; return; }
  const metricas = await calcularMetricasProcesso(processoId);
  if (!metricas) { el.textContent = 'Conceito parcial: ainda sem pontos avaliados neste processo.'; return; }
  const cls = classificarConceito(metricas.conceito);
  el.textContent = `Conceito parcial com ${metricas.pontos.length} ponto(s) já avaliado(s): ${fmtDecimal(metricas.conceito)} — ${cls.texto} (o valor final consolidado fica na aba Relatório).`;
}

// Atrativos de fauna e Riqueza aparente não são mais digitados como número — são derivados da
// contagem de espécies NOVAS adicionadas nos pickers (duplicatas já ficam bloqueadas por setExcluidas).
async function atualizarPreviewCumulativo() {
  const processoId = document.getElementById('pt-processo').value;
  if (!processoId) return;
  const idEmEdicao = document.getElementById('pt-id-edicao').value;
  const pontos = (await buscarPontosDoProcesso(processoId)).filter((p) => p.id !== idEmEdicao);
  const totalAtrativos = pontos.reduce((a, p) => a + (p.atrativos_fauna_novos || 0), 0) + faunaPicker.contagem();
  const totalRiqueza = pontos.reduce((a, p) => a + (p.riqueza_aparente_novos || 0), 0) + vegetalPicker.contagem();
  document.getElementById('pt-atrativos-acumulado').textContent =
    `Cumulativo do processo até agora: ${totalAtrativos} → classificação: ${labelClassificacao(classificarAtrativos(totalAtrativos))}`;
  document.getElementById('pt-riqueza-acumulado').textContent =
    `Cumulativo do processo até agora: ${totalRiqueza} → classificação: ${labelClassificacao(classificarRiqueza(totalRiqueza))}`;
}

// Painel lateral com os pontos já lançados neste processo — visível a partir do 1º ponto salvo,
// pra dar referência de comparação enquanto se preenche os próximos.
async function atualizarPontosLancados() {
  const processoId = document.getElementById('pt-processo').value;
  const painel = document.getElementById('pt-lancados-painel');
  const lista = document.getElementById('pt-lancados-lista');
  if (!processoId) { painel.style.display = 'none'; return; }
  const pontos = (await buscarPontosDoProcesso(processoId))
    .sort((a, b) => new Date(a.avaliado_em) - new Date(b.avaliado_em));
  if (!pontos.length) { painel.style.display = 'none'; return; }
  painel.style.display = 'block';
  lista.innerHTML = pontos.map((p, i) => {
    const soma = Object.keys(PARAMS_DIRETOS).reduce((a, k) => a + p[k], 0);
    const hora = new Date(p.avaliado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `<div class="ponto-lancado-item"><span><b>Ponto ${i + 1}</b> — ${hora}</span><span>soma direta: ${fmtDecimal(soma)}</span></div>`;
  }).join('');
}

// Terceira forma de preencher a posição geográfica (além de GPS automático e digitação manual):
// escolher um ponto já importado do KML na aba Mapa. Uma vez que o ponto de observação é salvo
// usando essa coordenada, o kml_ponto correspondente é apagado do IndexedDB (removerLocal) — assim
// a lista some da seleção e reflete só o que ainda falta visitar em campo.
async function carregarKmlPontosNoSelectPonto(processoId) {
  const sel = document.getElementById('pt-kml-select');
  sel.innerHTML = '<option value="">— Nenhum —</option>';
  if (!processoId) return;
  const kmlTodos = await listarTodos('kml_pontos');
  const kmlPontos = kmlTodos.filter((p) => p.processo_id === processoId);
  kmlPontos.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.nome} (${p.lat.toFixed(6)}, ${p.lon.toFixed(6)})`;
    sel.appendChild(opt);
  });
}

document.getElementById('pt-processo').addEventListener('change', async (e) => {
  const processoId = e.target.value;
  processoAtualId = processoId || null;
  const [processo, pontos] = await Promise.all([buscarProcessoPorId(processoId), buscarPontosDoProcesso(processoId)]);
  const avaliados = pontos.length;
  if (processo) {
    document.getElementById('pt-restantes').textContent =
      `${Math.max(processo.num_pontos - avaliados, 0)} ponto(s) restante(s) de ${processo.num_pontos}`;
  }
  await atualizarEspeciesJaObservadas(); // precisa rodar antes do preview, pra excluidas já valer
  atualizarPreviewCumulativo();
  atualizarConceitoParcial();
  atualizarPontosLancados();
  carregarKmlPontosNoSelectPonto(processoId);
});

document.getElementById('pt-kml-select').addEventListener('change', (e) => {
  const id = e.target.value;
  if (!id) return;
  listarTodos('kml_pontos').then((todos) => {
    const p = todos.find((k) => k.id === id);
    if (!p) return;
    document.getElementById('pt-lat').value = p.lat.toFixed(6);
    document.getElementById('pt-lng').value = p.lon.toFixed(6);
  });
});

// Editar a coordenada manualmente depois de ter escolhido um ponto do KML significa que a posição
// final não é mais exatamente a do KML — desmarca a seleção pra não apagar aquele ponto da lista
// por engano no submit (só dispara em digitação real do usuário, não quando o próprio app grava o
// valor via GPS/seleção do KML, porque atribuição programática de .value não dispara "input").
['pt-lat', 'pt-lng'].forEach((id) => {
  document.getElementById(id).addEventListener('input', () => {
    document.getElementById('pt-kml-select').value = '';
  });
});

document.getElementById('btn-gps').addEventListener('click', () => {
  const btn = document.getElementById('btn-gps');
  btn.textContent = 'Capturando...';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      document.getElementById('pt-lat').value = pos.coords.latitude.toFixed(6);
      document.getElementById('pt-lng').value = pos.coords.longitude.toFixed(6);
      document.getElementById('pt-kml-select').value = '';
      btn.textContent = 'Capturar GPS automaticamente';
    },
    () => {
      btn.textContent = 'Capturar GPS automaticamente';
      alert('Não foi possível capturar o GPS. Digite as coordenadas manualmente.');
    },
    { enableHighAccuracy: true, timeout: 15000 }
  );
});

// Limpa o formulário de ponto tanto depois de salvar quanto ao cancelar uma correção — os dois
// casos precisam voltar pro estado "Adicionar" (título, texto do botão, id de edição zerado).
function limparFormPonto() {
  document.getElementById('form-ponto').reset();
  document.getElementById('pt-id-edicao').value = '';
  resetSegmented();
  document.querySelectorAll('.explicacao-situacao').forEach((el) => { el.classList.remove('show'); el.innerHTML = ''; });
  faunaPicker.reset();
  vegetalPicker.reset();
  document.getElementById('ponto-form-titulo').textContent = 'Adicionar Ponto de Observação';
  document.getElementById('btn-salvar-ponto').textContent = 'Salvar ponto';
  document.getElementById('btn-cancelar-edicao-ponto').style.display = 'none';
}

// Preenche o formulário de Ponto de Obs. com um ponto já salvo, pra correção — chamado a partir da
// revisão na aba Relatório (ver carregarRevisaoPontos). pt-id-edicao precisa ser setado ANTES do
// "change" do processo disparar, senão atualizarEspeciesJaObservadas/atualizarPreviewCumulativo
// ainda contariam este próprio ponto contra si mesmo e bloqueariam repovoar seus próprios chips.
async function preencherFormPonto(p) {
  document.getElementById('pt-id-edicao').value = p.id;
  document.getElementById('pt-processo').value = p.processo_id;
  document.getElementById('pt-processo').dispatchEvent(new Event('change'));
  await atualizarEspeciesJaObservadas();
  Object.keys(PARAMS_DIRETOS).forEach((key) => setSegmentedValue(key, p[key]));
  faunaPicker.reset();
  listaEspecies(p.especies_zoocoricas_observadas).forEach((s) => faunaPicker.adicionarExterna(s));
  vegetalPicker.reset();
  listaEspecies(p.especies_vegetais_observadas).forEach((s) => vegetalPicker.adicionarExterna(s));
  document.getElementById('pt-observacoes').value = p.observacoes || '';
  document.getElementById('pt-lat').value = p.latitude ?? '';
  document.getElementById('pt-lng').value = p.longitude ?? '';
  document.getElementById('pt-kml-select').value = '';
  atualizarPreviewCumulativo();
  document.getElementById('ponto-form-titulo').textContent = 'Corrigir Ponto de Observação';
  document.getElementById('btn-salvar-ponto').textContent = 'Salvar correções';
  document.getElementById('btn-cancelar-edicao-ponto').style.display = 'inline-block';
}

document.getElementById('btn-cancelar-edicao-ponto').addEventListener('click', () => {
  const processoId = document.getElementById('pt-processo').value;
  limparFormPonto();
  if (processoId) document.getElementById('pt-processo').value = processoId;
  atualizarEspeciesJaObservadas();
  atualizarPreviewCumulativo();
});

document.getElementById('form-ponto').addEventListener('submit', async (e) => {
  e.preventDefault();

  const processoId = document.getElementById('pt-processo').value;
  const idEdicao = document.getElementById('pt-id-edicao').value;
  const kmlPontoUsadoId = document.getElementById('pt-kml-select').value || null;
  const valores = {};
  for (const key of Object.keys(PARAMS_DIRETOS)) {
    const v = getSegmentedValue(key);
    if (v === null) {
      mostrarMsg('ponto-msg', '<div class="msg erro">Preencha todos os 5 parâmetros diretos (Crítica/Mínima/Adequada) antes de salvar.</div>');
      return;
    }
    valores[key] = v;
  }

  const original = idEdicao ? (await buscarPontosDoProcesso(processoId)).find((p) => p.id === idEdicao) : null;
  const registro = {
    id: idEdicao || crypto.randomUUID(),
    processo_id: processoId,
    ...valores,
    atrativos_fauna_novos: faunaPicker.contagem(),
    riqueza_aparente_novos: vegetalPicker.contagem(),
    especies_zoocoricas_observadas: faunaPicker.getValue(),
    especies_vegetais_observadas: vegetalPicker.getValue(),
    observacoes: document.getElementById('pt-observacoes').value || null,
    latitude: document.getElementById('pt-lat').value ? parseFloat(document.getElementById('pt-lat').value) : null,
    longitude: document.getElementById('pt-lng').value ? parseFloat(document.getElementById('pt-lng').value) : null,
    // Corrigir um ponto não muda quando ele foi avaliado em campo — só o que foi observado.
    avaliado_em: original?.avaliado_em || new Date().toISOString(),
    criado_por: original?.criado_por ?? sessaoAtual?.user?.id ?? null,
    criado_em: original?.criado_em || new Date().toISOString()
  };
  await salvarLocal('pontos', registro);
  if (kmlPontoUsadoId) await removerLocal('kml_pontos', kmlPontoUsadoId);

  mostrarMsg('ponto-msg', `<div class="msg ok">${idEdicao ? 'Ponto corrigido.' : 'Ponto de observação salvo!'}</div>`);
  limparFormPonto();
  // O processo continua selecionado — o avaliador trabalha no mesmo processo do início ao fim,
  // não faz sentido pedir de novo a cada ponto.
  document.getElementById('pt-processo').value = processoId;
  document.getElementById('pt-processo').dispatchEvent(new Event('change'));
  // Pontos de observação NÃO sincronizam mais sozinhos (ver sincronizarPendentes) — ficam retidos
  // neste aparelho até serem revisados e confirmados na aba Relatório, porque hoje não existe forma
  // de corrigir um ponto que já foi pro banco. Processo/KML continuam automáticos, sem mudança.
});

// ---------- Métricas / conceito final ----------
document.getElementById('m-processo').addEventListener('change', (e) => {
  processoAtualId = e.target.value || null;
  fotosCarregadas = [];
  mosaicoAtual = {};
  mosaicoManual = new Set();
  pickerAbertoId = null;
  document.getElementById('m-fotos-resultado').innerHTML = '';
  atualizarMetricas();
});

function renderChipsEspecies(set) {
  if (!set.size) return '<span class="hint">Nenhuma registrada.</span>';
  return `<div class="chips">${[...set].sort().map((s) => `<span class="chip">${escaparTexto(s)}</span>`).join('')}</div>`;
}

async function atualizarMetricas() {
  const processoId = document.getElementById('m-processo').value;
  carregarRevisaoPontos(processoId);
  if (!processoId) return;
  const [metricas, processo] = await Promise.all([calcularMetricasProcesso(processoId), buscarProcessoPorId(processoId)]);

  const classificacaoEl = document.getElementById('m-classificacao');
  const alertasEl = document.getElementById('m-alertas');
  const especiesEl = document.getElementById('m-especies');
  const esforcoEl = document.getElementById('m-esforco-amostral');

  if (!metricas) {
    document.getElementById('m-media').textContent = '—';
    document.getElementById('m-conceito').textContent = '—';
    document.getElementById('m-pontos').textContent = processo ? `0 / ${processo.num_pontos}` : '0';
    classificacaoEl.innerHTML = '';
    alertasEl.innerHTML = '';
    especiesEl.innerHTML = '';
    esforcoEl.textContent = processo ? `Esforço amostral: faltam ${processo.num_pontos} ponto(s) para completar os ${processo.num_pontos} previstos.` : '';
    return;
  }

  const cls = classificarConceito(metricas.conceito);
  document.getElementById('m-media').textContent = fmtDecimal(metricas.mediaSomatorios);
  document.getElementById('m-conceito').textContent = fmtDecimal(metricas.conceito);
  document.getElementById('m-conceito').className = 'val ' + cls.classe;
  document.getElementById('m-pontos').textContent = processo ? `${metricas.pontos.length} / ${processo.num_pontos}` : metricas.pontos.length;

  if (processo) {
    const restantes = Math.max(processo.num_pontos - metricas.pontos.length, 0);
    esforcoEl.textContent = restantes > 0
      ? `Esforço amostral: faltam ${restantes} ponto(s) para completar os ${processo.num_pontos} previstos.`
      : `Esforço amostral completo — os ${processo.num_pontos} pontos previstos foram avaliados.`;
  } else {
    esforcoEl.textContent = '';
  }

  classificacaoEl.innerHTML = `<span class="badge-classificacao ${cls.classe}">${cls.texto}${metricas.apto ? ' — apto para quitação' : ''}</span>`;
  alertasEl.innerHTML = metricas.alertas.length
    ? `<div class="alerta"><strong>Atenção</strong>${metricas.alertas.map((a) => `<div>• ${a}</div>`).join('')}</div>` : '';

  especiesEl.innerHTML = `
    <p class="hint" style="font-weight:700;color:var(--verde-escuro);margin-top:10px;">Espécies com atrativos para fauna (${metricas.especiesFauna.size})</p>
    ${renderChipsEspecies(metricas.especiesFauna)}
    <p class="hint" style="font-weight:700;color:var(--verde-escuro);margin-top:14px;">Espécies vegetais / riqueza aparente (${metricas.especiesVegetal.size})</p>
    ${renderChipsEspecies(metricas.especiesVegetal)}
  `;
}

// ---------- Revisão de pontos antes de enviar (card na aba Relatório) ----------
// Pontos de observação não sincronizam mais sozinhos (ver enviarPontoRevisado) — ficam retidos
// neste aparelho até o avaliador revisar aqui e confirmar o envio, ponto a ponto ou todos de uma vez.
async function carregarRevisaoPontos(processoId) {
  const card = document.getElementById('m-revisao-card');
  const lista = document.getElementById('m-revisao-lista');
  document.getElementById('m-revisao-msg').innerHTML = '';
  if (!processoId) { card.style.display = 'none'; lista.innerHTML = ''; return; }

  const todosLocais = await listarTodos('pontos');
  const pendentes = listarLocaisDoUsuario(todosLocais)
    .filter((p) => p.processo_id === processoId && p.sincronizado === false)
    .sort((a, b) => new Date(a.avaliado_em) - new Date(b.avaliado_em));

  if (!pendentes.length) { card.style.display = 'none'; lista.innerHTML = ''; return; }
  card.style.display = 'block';

  lista.innerHTML = pendentes.map((p) => {
    const soma = Object.keys(PARAMS_DIRETOS).reduce((a, k) => a + p[k], 0);
    const hora = new Date(p.avaliado_em).toLocaleString('pt-BR');
    const coords = (p.latitude != null && p.longitude != null) ? `${p.latitude.toFixed(6)}, ${p.longitude.toFixed(6)}` : 'sem coordenada registrada';
    return `<div class="revisao-item">
      <div class="resumo"><b>Ponto avaliado em ${hora}</b><br>Soma direta dos 5 parâmetros: ${fmtDecimal(soma)} · ${coords}${p.observacoes ? `<br>${escaparTexto(p.observacoes)}` : ''}</div>
      <div class="acoes">
        <button type="button" class="btn secundario btn-editar-ponto-revisao" data-id="${p.id}">Editar</button>
        <button type="button" class="btn btn-enviar-ponto-revisao" data-id="${p.id}">Confirmar e enviar</button>
      </div>
    </div>`;
  }).join('');

  lista.querySelectorAll('.btn-editar-ponto-revisao').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const p = pendentes.find((x) => x.id === btn.dataset.id);
      if (!p) return;
      navegarPara('ponto');
      // aplicarView('ponto') (disparada pelo hashchange acima) recarrega o select de processos de
      // forma assíncrona (local+remoto) — sem esperar isso aqui de novo, preencherFormPonto setaria
      // o .value antes das <option> existirem e a seleção do processo se perderia.
      await carregarProcessosNoSelect('#pt-processo');
      await preencherFormPonto(p);
    });
  });
  lista.querySelectorAll('.btn-enviar-ponto-revisao').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Enviando...';
      const r = await enviarPontoRevisado(btn.dataset.id);
      if (r.ok) {
        mostrarMsg('m-revisao-msg', '<div class="msg ok">Ponto enviado.</div>');
        carregarRevisaoPontos(processoId);
      } else {
        btn.disabled = false;
        btn.textContent = 'Confirmar e enviar';
        mostrarMsg('m-revisao-msg', `<div class="msg erro">${r.motivo === 'sem-sinal' ? 'Sem sinal agora — tente de novo com internet.' : 'Não foi possível enviar: ' + r.motivo}</div>`);
      }
    });
  });
}

document.getElementById('btn-confirmar-todos-pontos').addEventListener('click', async (e) => {
  const processoId = document.getElementById('m-processo').value;
  if (!processoId) return;
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = 'Enviando...';

  const todosLocais = await listarTodos('pontos');
  const pendentes = listarLocaisDoUsuario(todosLocais).filter((p) => p.processo_id === processoId && p.sincronizado === false);
  let falhas = 0;
  for (const p of pendentes) {
    const r = await enviarPontoRevisado(p.id);
    if (!r.ok) falhas++;
  }

  btn.disabled = false;
  btn.textContent = 'Confirmar e enviar todos';
  mostrarMsg('m-revisao-msg', falhas
    ? `<div class="msg erro">${pendentes.length - falhas} de ${pendentes.length} enviado(s) — ${falhas} falharam. Sem sinal? Tente de novo.</div>`
    : '<div class="msg ok">Todos os pontos foram enviados.</div>');
  carregarRevisaoPontos(processoId);
});

// ---------- Mosaico de fotos por horário (correspondência EXIF, com atribuição manual) ----------
// fotosCarregadas acumula entre seleções (o navegador substituiria o conteúdo do <input> a cada
// escolha, então guardamos aqui fora para permitir montar o mosaico em vários lotes de fotos).
// Fotos reenviadas por WhatsApp (ou recomprimidas por outros apps) chegam SEM o metadado EXIF de
// data/hora — nesses casos não há como casar automaticamente, e o ponto fica com a opção de
// atribuição manual em vez de simplesmente não mostrar nada.
let proximoFotoId = 1;
let fotosCarregadas = []; // { id, nome, tamanho, dataUrl, dataHora }
// mosaicoAtual: ponto.id -> [fotoId, ...] (ids, não objetos — sobrevive a novos uploads sem perder escolha manual)
let mosaicoAtual = {};
// Pontos que o usuário já editou manualmente (via "Escolher fotos manualmente" ou removendo uma
// miniatura) — para esses o recálculo automático abaixo nunca mais mexe, senão apagaria a escolha
// da pessoa. Sem essa distinção, o primeiro cálculo automático (mesmo que vazio, ex: 1º lote de
// fotos sem nenhuma dentro da janela de tempo) ficava congelado pra sempre: `!mosaicoAtual[p.id]`
// é falso para um array vazio, então lotes de fotos carregados depois nunca eram reconsiderados —
// essa é a causa raiz confirmada de PDFs saindo sem nenhuma foto mesmo com fotos carregadas.
let mosaicoManual = new Set();

function fotoPorId(id) { return fotosCarregadas.find((f) => f.id === id); }

// Atribuição automática GLOBAL, não mais ponto a ponto: em campo, o deslocamento entre pontos
// vizinhos (ex.: ~200m, uns 5-7 min de caminhada) é curto o bastante pra cair dentro de qualquer
// janela de tolerância razoável — calcular "essa foto está no meu alcance?" separadamente por
// ponto deixava a mesma foto ser sugerida pros dois pontos ao mesmo tempo. Aqui, cada FOTO é
// casada com o ponto mais próximo no tempo entre TODOS os pontos, e uma vez usada por um ponto
// não entra mais na disputa dos outros — elimina o conflito entre vizinhos independente da
// distância entre eles. toleranciaMin ainda existe, mas só como corte de sanidade (descarta fotos
// de outro dia/momento), não é mais ele quem decide qual ponto ganha a foto.
function calcularAtribuicaoAutomatica(pontos, candidatas, toleranciaMin = 6, max = 2) {
  const pares = [];
  pontos.forEach((p) => {
    const alvo = new Date(p.avaliado_em).getTime();
    candidatas.forEach((f) => {
      if (!f.dataHora) return;
      const diff = Math.abs(f.dataHora.getTime() - alvo);
      if (diff <= toleranciaMin * 60 * 1000) pares.push({ pontoId: p.id, fotoId: f.id, diff });
    });
  });
  pares.sort((a, b) => a.diff - b.diff); // casamentos mais próximos no tempo ganham prioridade

  const resultado = {};
  pontos.forEach((p) => { resultado[p.id] = []; });
  const fotosUsadas = new Set();
  for (const par of pares) {
    if (fotosUsadas.has(par.fotoId)) continue; // foto já foi pro ponto mais próximo dela
    if (resultado[par.pontoId].length >= max) continue; // ponto já completou o limite de 2
    resultado[par.pontoId].push(par.fotoId);
    fotosUsadas.add(par.fotoId);
  }
  return resultado;
}

// Ponto cujo picker de atribuição manual está aberto — sobrevive ao re-render que acontece a cada
// escolha de foto. Sem isso, o picker fechava sozinho a cada toque (renderMosaico recria a tela
// inteira do zero), obrigando reabrir pra cada foto — e num toque de celular é fácil confundir isso
// com "não está funcionando" e desistir sem ter escolhido nada.
let pickerAbertoId = null;

function abrirPickerFoto(resultado, pontoId, metricas) {
  const picker = resultado.querySelector(`.foto-picker[data-picker="${pontoId}"]`);
  if (!picker) return;
  // Fotos já atribuídas a OUTRO ponto (automática ou manualmente) ficam fora da lista aqui — sem
  // isso, dava pra escolher a mesma foto pra dois pontos diferentes e ela saía duplicada no PDF.
  // Uma vez usada em algum ponto, só fica disponível de novo se for removida de lá primeiro (botão
  // "×" na miniatura do ponto).
  const fotosUsadasEmOutros = new Set(
    metricas.pontos.filter((p) => p.id !== pontoId).flatMap((p) => mosaicoAtual[p.id] || [])
  );
  const disponiveis = fotosCarregadas.filter((f) => !fotosUsadasEmOutros.has(f.id));
  const bloqueadas = fotosCarregadas.length - disponiveis.length;
  // Ver a foto aparecer aqui NÃO significa que ela já foi atribuída — é só a galeria de escolha.
  // Precisa clicar em cima da foto pra valer. Sem essa instrução explícita e sem um selo visual
  // óbvio de "selecionada", ficava fácil achar que abrir o picker já bastava (confirmado por
  // relato real de uso: usuário abriu o picker, viu as fotos, mas nunca clicou nelas).
  picker.innerHTML = disponiveis.length
    ? `<p class="hint" style="width:100%;margin:0 0 6px;font-weight:600;">Toque em cada foto abaixo para atribuí-la a este ponto (máx. 2) — toque de novo para remover.${
        bloqueadas ? ` (${bloqueadas} foto(s) já atribuída(s) a outro ponto não aparecem aqui.)` : ''
      }</p>` +
      disponiveis.map((f, i) => {
        const selecionada = mosaicoAtual[pontoId].includes(f.id);
        // Botão real em vez de <img> com onclick — só assim recebe foco e responde a Enter/Espaço.
        // Nome acessível ESTÁVEL ("Foto 3 de 8"), não muda quando a seleção muda — quem comunica o
        // estado é aria-pressed. Colocar a ação no nome ("Atribuir foto 3") criaria duas fontes de
        // verdade que se contradizem quando já está selecionada. Pelo mesmo motivo o selo visual
        // "✓ atribuída" é aria-hidden: seria a mesma informação anunciada duas vezes. alt="" na
        // imagem porque é decorativa — o nome vem do botão.
        return `<span class="thumb-pick-wrap">
          <button type="button" class="thumb-pick-btn" data-foto="${f.id}" aria-pressed="${selecionada}" aria-label="Foto ${i + 1} de ${disponiveis.length}">
            <img src="${f.dataUrl}" class="thumb-pick ${selecionada ? 'selecionada' : ''}" alt="">
          </button>
          ${selecionada ? '<span class="thumb-pick-check" aria-hidden="true">✓ atribuída</span>' : ''}
        </span>`;
      }).join('')
    : `<span class="hint">${bloqueadas ? 'Todas as fotos carregadas já estão atribuídas a outros pontos.' : 'Nenhuma foto carregada ainda.'}</span>`;
  picker.classList.add('show');
  picker.querySelectorAll('.thumb-pick-btn').forEach((btn) => btn.addEventListener('click', () => {
    const fotoId = Number(btn.dataset.foto);
    mosaicoManual.add(pontoId);
    const atual = mosaicoAtual[pontoId];
    if (atual.includes(fotoId)) {
      mosaicoAtual[pontoId] = atual.filter((id) => id !== fotoId);
    } else {
      if (atual.length >= 2) { alert('Máximo de 2 fotos por ponto.'); return; }
      mosaicoAtual[pontoId] = [...atual, fotoId];
    }
    // Preserva o foco na mesma foto depois do re-render completo do mosaico — sem isso, cada toque
    // devolvia o foco pro <body>, perdendo a posição de quem navega só por teclado/TalkBack.
    renderPreservandoFoco(
      () => renderMosaico(metricas),
      `.foto-picker[data-picker="${pontoId}"] [data-foto="${fotoId}"]`
    );
  }));
}

function renderMosaico(metricas) {
  const resultado = document.getElementById('m-fotos-resultado');
  const semData = fotosCarregadas.filter((f) => !f.dataHora).length;

  // Recalcula a atribuição automática só para pontos ainda não editados manualmente — os travados
  // (mosaicoManual) mantêm a escolha da pessoa, e suas fotos saem da disputa dos demais pontos
  // (senão uma foto que alguém já atribuiu manualmente ao Ponto 2 poderia "vazar" automaticamente
  // pro Ponto 3 também).
  const pontosTravados = metricas.pontos.filter((p) => mosaicoManual.has(p.id));
  const pontosLivres = metricas.pontos.filter((p) => !mosaicoManual.has(p.id));
  const fotosJaManuais = new Set(pontosTravados.flatMap((p) => mosaicoAtual[p.id] || []));
  const candidatasAuto = fotosCarregadas.filter((f) => !fotosJaManuais.has(f.id));
  const auto = calcularAtribuicaoAutomatica(pontosLivres, candidatasAuto);
  pontosLivres.forEach((p) => { mosaicoAtual[p.id] = auto[p.id] || []; });

  // Galeria de TODAS as fotos carregadas, sempre visível — antes, uma foto que não batia com
  // nenhum ponto pelo horário só aparecia escondida dentro do picker de atribuição manual de cada
  // ponto (que nem fica aberto por padrão). Do lado de fora, carregar 12 fotos e nenhuma bater no
  // horário parecia visualmente idêntico a "nada carregou" — essa galeria prova imediatamente que
  // o upload funcionou, independente do casamento automático ter dado certo ou não.
  const galeria = fotosCarregadas.length
    ? `<div class="thumbs" style="margin:8px 0 14px;">${fotosCarregadas.map((f) => `<img src="${f.dataUrl}" class="thumb-pick selecionada" style="cursor:default;" alt="${escaparAtributo(f.nome)}" title="${escaparAtributo(f.nome)}">`).join('')}</div>`
    : '';

  // Mensagem de progresso separada da galeria — role="status" numa região que é inteiramente
  // recriada a cada re-render (como m-fotos-resultado) não é confiável pra leitor de tela. O
  // resumo (marco: quantas fotos, quantas sem data) vai num elemento próprio e estável; miniaturas
  // e botões continuam fora da live region, senão o leitor tentaria anunciar cada thumbnail.
  document.getElementById('m-fotos-msg').textContent = `${fotosCarregadas.length} foto(s) carregada(s) ao todo.${
    semData ? ` ${semData} sem data/hora no arquivo (comum em fotos reenviadas por WhatsApp — o reenvio apaga essa informação). Use "Escolher fotos manualmente" nesses pontos.` : ''
  }`;

  resultado.innerHTML = `${galeria}` + metricas.pontos.map((p, i) => {
    const atribuidas = (mosaicoAtual[p.id] || []).map(fotoPorId).filter(Boolean);
    const thumbs = atribuidas.length
      ? atribuidas.map((f) => `<span class="thumb-wrap"><img src="${f.dataUrl}" alt="foto do ponto ${i + 1}"><button type="button" class="thumb-remove" data-ponto="${p.id}" data-foto="${f.id}" aria-label="Remover foto do ponto ${i + 1}"><span aria-hidden="true">×</span></button></span>`).join('')
      : '<span class="hint">sem foto atribuída ainda</span>';
    // id real (não só data-picker) porque aria-controls precisa resolver pra um id de verdade —
    // data-picker continua existindo porque p.id (UUID) pode começar com dígito, o que é válido em
    // getElementById/aria-controls mas quebra em querySelector sem escape; o resto do código
    // continua buscando por atributo, só o aria-controls/getElementById usa o id novo.
    return `<div class="foto-ponto">
      <div class="hint"><strong>Ponto ${i + 1}</strong> (${new Date(p.avaliado_em).toLocaleString('pt-BR')})</div>
      <div class="thumbs">${thumbs}</div>
      <button type="button" class="btn secundario pequeno btn-escolher-fotos" data-ponto="${p.id}" aria-expanded="${pickerAbertoId === p.id}" aria-controls="foto-picker-${p.id}">Escolher fotos manualmente</button>
      <div class="foto-picker" id="foto-picker-${p.id}" data-picker="${p.id}"></div>
    </div>`;
  }).join('');

  resultado.querySelectorAll('.thumb-remove').forEach((btn) => btn.addEventListener('click', () => {
    const pontoId = btn.dataset.ponto;
    const fotoId = Number(btn.dataset.foto);
    mosaicoManual.add(pontoId);
    mosaicoAtual[pontoId] = mosaicoAtual[pontoId].filter((id) => id !== fotoId);
    renderMosaico(metricas);
  }));

  resultado.querySelectorAll('.btn-escolher-fotos').forEach((btn) => btn.addEventListener('click', () => {
    const pontoId = btn.dataset.ponto;
    const jaAberto = pickerAbertoId === pontoId;
    resultado.querySelectorAll('.foto-picker').forEach((el) => el.classList.remove('show'));
    resultado.querySelectorAll('.btn-escolher-fotos').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    pickerAbertoId = jaAberto ? null : pontoId;
    if (jaAberto) return;
    btn.setAttribute('aria-expanded', 'true');
    abrirPickerFoto(resultado, pontoId, metricas);
  }));

  // Reabre o picker que já estava aberto antes deste re-render (ex.: logo depois de escolher uma
  // foto) — sem isso, cada toque numa foto fechava o picker de novo, forçando reabrir pra cada uma.
  if (pickerAbertoId) abrirPickerFoto(resultado, pickerAbertoId, metricas);
}

// Corrige a rotação da foto usando a tag EXIF Orientation, desenhando num canvas já na orientação
// certa. Necessário porque doc.addImage() do jsPDF ignora essa tag por completo — desenha os pixels
// crus, do jeito que o sensor da câmera gravou, então uma foto tirada "na vertical" (câmera lida
// como paisagem + tag de rotação) saía deitada no PDF mesmo aparecendo em pé no rolo de fotos do
// celular. Corrigindo aqui, uma vez só, no momento do carregamento, tanto o mosaico na tela quanto
// o PDF usam a mesma imagem já orientada certo.
function corrigirOrientacao(dataUrl, orientacao) {
  if (!orientacao || orientacao === 1) return Promise.resolve(dataUrl);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const troca = orientacao >= 5 && orientacao <= 8; // 90°/270° trocam largura por altura
      const canvas = document.createElement('canvas');
      canvas.width = troca ? img.height : img.width;
      canvas.height = troca ? img.width : img.height;
      const ctx = canvas.getContext('2d');
      switch (orientacao) {
        case 2: ctx.transform(-1, 0, 0, 1, img.width, 0); break;
        case 3: ctx.transform(-1, 0, 0, -1, img.width, img.height); break;
        case 4: ctx.transform(1, 0, 0, -1, 0, img.height); break;
        case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
        case 6: ctx.transform(0, 1, -1, 0, img.height, 0); break;
        case 7: ctx.transform(0, -1, -1, 0, img.height, img.width); break;
        case 8: ctx.transform(0, -1, 1, 0, 0, img.width); break;
        default: break;
      }
      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = () => resolve(dataUrl); // não conseguiu reprocessar — usa a original mesmo assim
    img.src = dataUrl;
  });
}

document.getElementById('m-fotos').addEventListener('change', async (e) => {
  const processoId = document.getElementById('m-processo').value;
  const resultado = document.getElementById('m-fotos-resultado');
  if (!processoId) { resultado.innerHTML = '<div class="msg erro">Selecione um processo primeiro.</div>'; return; }

  const metricas = await calcularMetricasProcesso(processoId);
  if (!metricas) { resultado.innerHTML = '<div class="msg erro">Nenhum ponto avaliado para este processo ainda.</div>'; return; }

  const novos = Array.from(e.target.files);
  const falhas = [];
  let processadas = 0;
  for (const file of novos) {
    processadas++;
    resultado.innerHTML = `<p class="hint">Processando foto ${processadas} de ${novos.length}...</p>`;
    try {
      const jaExiste = fotosCarregadas.some((f) => f.nome === file.name && f.tamanho === file.size);
      if (jaExiste) continue;
      // Nem toda foto do iPhone tem DateTimeOriginal (fotos editadas, importadas de outro app,
      // ou passadas pela conversão automática HEIC->JPEG do picker do Safari às vezes só gravam
      // CreateDate/ModifyDate) — sem esse fallback, fotos assim ficavam sem nenhuma data e nunca
      // casavam com ponto nenhum. Como último recurso, usa a data de modificação do próprio
      // arquivo: não é tão precisa quanto o EXIF, mas ainda é muito melhor que não ter nada —
      // a foto some do mosaico automático quando não há match nenhum, mesmo com hora aproximada.
      const exif = await window.exifr.parse(file, ['DateTimeOriginal', 'CreateDate', 'ModifyDate']).catch(() => null);
      const dataHoraExif = exif?.DateTimeOriginal || exif?.CreateDate || exif?.ModifyDate;
      // "!= null" (não "?") de propósito: lastModified=0 (epoch) é um timestamp válido, ainda que
      // raro — tratá-lo como falso faria essa foto cair na categoria "sem data" por engano.
      const dataHora = dataHoraExif ? new Date(dataHoraExif) : (file.lastModified != null ? new Date(file.lastModified) : null);
      // Fotos do iPhone costumam vir em HEIC/HEIF — o jsPDF não sabe desenhar esse formato (falha
      // silenciosa no addImage, a foto simplesmente não aparece no PDF). Converte pra JPEG aqui,
      // antes de guardar, pra garantir que a foto realmente entra no relatório.
      const ehHeic = /heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
      let arquivoParaLer = file;
      if (ehHeic && window.heic2any) {
        try {
          const convertido = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.85 });
          arquivoParaLer = Array.isArray(convertido) ? convertido[0] : convertido;
        } catch { /* não conseguiu converter — tenta ler o arquivo original mesmo assim */ }
      }
      const dataUrlBruto = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(arquivoParaLer);
      });
      // Orientação lida do ARQUIVO ORIGINAL (não do convertido de HEIC) — o heic2any já entrega a
      // imagem com os pixels na orientação certa, então aplicar a correção de novo em cima disso
      // giraria a foto errado, na direção oposta.
      const orientacao = ehHeic ? 1 : await window.exifr.orientation(file).catch(() => 1);
      const dataUrl = await corrigirOrientacao(dataUrlBruto, orientacao);
      fotosCarregadas.push({ id: proximoFotoId++, nome: file.name, tamanho: file.size, dataUrl, dataHora });
    } catch (erroFoto) {
      console.error('Erro ao processar foto', file.name, erroFoto);
      falhas.push(file.name);
    }
  }
  e.target.value = ''; // permite selecionar o mesmo arquivo de novo e escolher outro lote em seguida

  renderMosaico(metricas);
  if (falhas.length) {
    resultado.insertAdjacentHTML('afterbegin', `<div class="msg erro">Não foi possível processar: ${falhas.join(', ')}. Tente escolher essas fotos separadamente, ou use fotos em JPEG.</div>`);
  }
});

document.getElementById('btn-limpar-fotos').addEventListener('click', () => {
  fotosCarregadas = [];
  mosaicoAtual = {};
  mosaicoManual = new Set();
  pickerAbertoId = null;
  document.getElementById('m-fotos-resultado').innerHTML = '';
  document.getElementById('m-fotos-msg').textContent = '';
});

// ---------- Exportar ----------
// Entrega o arquivo gerado pro usuário — três métodos, na ordem de confiabilidade real testada:
// 1) Web Share API: único caminho que funciona de forma consistente num PWA instalado (modo
//    standalone) no iPhone — window.open() e <a download> não são confiáveis nesse contexto,
//    às vezes simplesmente não fazem nada, sem erro. Abre a folha de compartilhamento nativa,
//    com opção de "Salvar em Arquivos".
// 2) Aba pré-aberta (abaPreAberta, criada de forma síncrona no clique, antes de qualquer await):
//    funciona bem em navegador normal (não instalado como app).
// 3) <a download>: último recurso.
async function entregarArquivo(nome, conteudo, tipo, abaPreAberta) {
  const blob = new Blob([conteudo], { type: tipo });
  try {
    const file = new File([blob], nome, { type: tipo });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      if (abaPreAberta) abaPreAberta.close();
      await navigator.share({ files: [file] });
      return;
    }
  } catch (erroShare) {
    if (erroShare && erroShare.name === 'AbortError') return; // usuário cancelou o compartilhamento de propósito
    // qualquer outro erro do share: cai pros métodos seguintes em vez de desistir
  }
  const url = URL.createObjectURL(blob);
  if (abaPreAberta) {
    abaPreAberta.location.href = url;
    return;
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  a.click();
}

// ---------- Exportar Excel (.xlsx) — planilhas separadas, organizadas por assunto ----------
document.getElementById('btn-exportar-excel').addEventListener('click', async () => {
  const abaExcel = (navigator.canShare) ? null : window.open('', '_blank');
  mostrarMsg('exportar-msg', '<div class="msg ok">Gerando Excel...</div>', 30000);
  try {
  const processoId = document.getElementById('m-processo').value;
  const processo = await buscarProcessoPorId(processoId);
  const metricas = await calcularMetricasProcesso(processoId);
  if (!processo || !metricas) {
    if (abaExcel) abaExcel.close();
    mostrarMsg('exportar-msg', '<div class="msg erro">Selecione um processo com pelo menos um ponto avaliado antes de exportar.</div>');
    return;
  }
  const cls = classificarConceito(metricas.conceito);

  const wb = XLSX.utils.book_new();

  const wsResumo = XLSX.utils.aoa_to_sheet([
    ['Processo administrativo', processo.numero_administrativo],
    ['Formação vegetal', processo.formacao_vegetal],
    ['Área (ha)', processo.area_ha],
    ['Nº de pontos previstos', processo.num_pontos],
    ['Pontos de observação avaliados', metricas.pontos.length],
    [],
    ['Razão social', processo.razao_social || ''],
    ['CPF/CNPJ', processo.cpf_cnpj || ''],
    ['Município', processo.municipio || ''],
    [],
    ['Média dos somatórios', Number(metricas.mediaSomatorios.toFixed(2))],
    ['Fator (10/7)', 1.4285714],
    ['Conceito final', metricas.conceito],
    ['Classificação', cls.texto],
    ['Apto para quitação', metricas.apto ? 'Sim' : 'Não'],
    ['Alertas', metricas.alertas.join(' | ') || 'Nenhum']
  ]);
  wsResumo['!cols'] = [{ wch: 30 }, { wch: 50 }];
  XLSX.utils.book_append_sheet(wb, wsResumo, 'Resumo');

  const wsPontos = XLSX.utils.json_to_sheet(metricas.linhas.map(({ ponto: p, somatorio }, i) => ({
    'Ponto': i + 1,
    'Necessidade de replantio': p.necessidade_replantio,
    'Cobertura de copa': p.cobertura_copa,
    'Distribuição das espécies': p.distribuicao_especies,
    'Altura estimada': p.altura_estimada,
    'Competição': p.competicao,
    'Atrativos de fauna (nota cumulativa)': metricas.notaAtrativos,
    'Riqueza aparente (nota cumulativa)': metricas.notaRiqueza,
    'Soma das notas': Number(somatorio.toFixed(2)),
    'Latitude': p.latitude,
    'Longitude': p.longitude,
    'Avaliado em': new Date(p.avaliado_em).toLocaleString('pt-BR'),
    'Espécies com atrativos p/ fauna': p.especies_zoocoricas_observadas || '',
    'Espécies vegetais': p.especies_vegetais_observadas || '',
    'Observações': p.observacoes || ''
  })));
  wsPontos['!cols'] = [
    { wch: 6 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 12 },
    { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 18 },
    { wch: 35 }, { wch: 35 }, { wch: 35 }
  ];
  XLSX.utils.book_append_sheet(wb, wsPontos, 'Pontos de Observação');

  const especiesRows = [
    ...[...metricas.especiesFauna].sort().map((s) => ({ Tipo: 'Atrativo de fauna', Espécie: s })),
    ...[...metricas.especiesVegetal].sort().map((s) => ({ Tipo: 'Vegetal (riqueza aparente)', Espécie: s }))
  ];
  const wsEspecies = XLSX.utils.json_to_sheet(especiesRows.length ? especiesRows : [{ Tipo: '', Espécie: 'Nenhuma espécie registrada' }]);
  wsEspecies['!cols'] = [{ wch: 22 }, { wch: 55 }];
  XLSX.utils.book_append_sheet(wb, wsEspecies, 'Espécies Observadas');

  const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  await entregarArquivo(
    `monitoramento-prf-${processo.numero_administrativo.replace(/\W+/g, '-')}.xlsx`,
    buffer,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    abaExcel
  );
  mostrarMsg('exportar-msg', '<div class="msg ok">Excel gerado.</div>');
  } catch (erro) {
    if (abaExcel) abaExcel.close();
    mostrarMsg('exportar-msg', `<div class="msg erro">Não foi possível gerar o Excel: ${escaparTexto(erro?.message || erro)}</div>`, 10000);
    console.error('Erro ao gerar Excel:', erro);
  }
});

// ---------- Exportar PDF (segue a estrutura do Anexo II — Ficha DAR) ----------
function formatoImagem(dataUrl) {
  const m = /^data:image\/(\w+);/.exec(dataUrl);
  const t = (m && m[1] || 'jpeg').toUpperCase();
  return t === 'JPG' ? 'JPEG' : t;
}
function textoComQuebra(doc, texto, x, y, maxWidth, lineHeight = 4) {
  const linhas = doc.splitTextToSize(texto, maxWidth);
  doc.text(linhas, x, y);
  return y + linhas.length * lineHeight;
}

// Mapa de localização pro PDF — desenhado do zero num canvas, não é um "print" do Leaflet com tiles
// de fundo: um screenshot do mapa real esbarraria em tiles do OpenStreetMap sem CORS liberado,
// o que contamina o canvas e bloqueia doc.addImage() de ler os pixels. Em troca, ganhamos uma
// escala gráfica sempre exata (calculada em metros de verdade, não estimada de um zoom de tile) e
// nenhuma dependência de sinal no momento da exportação. Projeção equirretangular local (válida
// pra áreas pequenas, na escala de um projeto de restauração — não pro globo inteiro): converte
// lat/lon em metros a partir do centro da área, com a mesma escala X/Y pra não distorcer distância.
// Busca vias (highway) e hidrografia (waterway/natural=water) do OpenStreetMap via Overpass API,
// dentro de uma caixa delimitadora — só dados vetoriais (coordenadas em JSON), nunca imagem, então
// nunca esbarra no problema de CORS/canvas contaminado dos tiles (ver gerarMapaEstatico). Exige
// internet no momento da exportação — se falhar (sem sinal, serviço fora, demorou demais), volta
// listas vazias e o mapa sai igual antes, só sem essa camada de contexto. Nunca deve travar o PDF.
async function buscarContextoOSM(minLat, minLon, maxLat, maxLon) {
  const query = `[out:json][timeout:12];(way["highway"](${minLat},${minLon},${maxLat},${maxLon});way["waterway"](${minLat},${minLon},${maxLat},${maxLon});way["natural"="water"](${minLat},${minLon},${maxLat},${maxLon}););out geom;`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 9000);
  try {
    const resp = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      signal: controller.signal
    });
    if (!resp.ok) throw new Error(`Overpass respondeu ${resp.status}`);
    const json = await resp.json();
    const vias = [];
    const hidrografia = [];
    (json.elements || []).forEach((el) => {
      if (!el.geometry?.length) return; // sem geometria resolvida (comum em relations) — ignora
      const linha = el.geometry.map((pt) => [pt.lat, pt.lon]);
      if (el.tags?.highway) vias.push(linha);
      else if (el.tags?.waterway || el.tags?.natural === 'water') hidrografia.push(linha);
    });
    return { vias, hidrografia };
  } catch {
    return { vias: [], hidrografia: [] }; // offline, timeout ou serviço fora — mapa sai sem essa camada
  } finally {
    clearTimeout(timeoutId);
  }
}

async function gerarMapaEstatico(pontosNumerados, poligonos) {
  const todasCoords = [
    ...pontosNumerados.map((p) => [p.lat, p.lon]),
    ...poligonos.flatMap((pol) => pol.anel)
  ];
  if (todasCoords.length === 0) return null;

  const lats = todasCoords.map((c) => c[0]);
  const lons = todasCoords.map((c) => c[1]);
  const latCentro = (Math.min(...lats) + Math.max(...lats)) / 2;
  const lonCentro = (Math.min(...lons) + Math.max(...lons)) / 2;
  const metrosPorGrauLat = 111320;
  const metrosPorGrauLon = 111320 * Math.cos((latCentro * Math.PI) / 180);
  const paraMetros = ([lat, lon]) => [(lon - lonCentro) * metrosPorGrauLon, (lat - latCentro) * metrosPorGrauLat];

  const pontosM = todasCoords.map(paraMetros);
  const xs = pontosM.map((p) => p[0]);
  const ys = pontosM.map((p) => p[1]);
  const extentX = Math.max(...xs) - Math.min(...xs);
  const extentY = Math.max(...ys) - Math.min(...ys);
  // Margem de 25% pra mostrar o entorno imediato da área, não só o polígono/pontos "encostados"
  // na borda da imagem — pedido explícito.
  const margem = Math.max(extentX, extentY, 40) * 0.25;
  const minX = Math.min(...xs) - margem, maxX = Math.max(...xs) + margem;
  const minY = Math.min(...ys) - margem, maxY = Math.max(...ys) + margem;

  const CANVAS_W = 1400, CANVAS_H = 1000, PAD = 90;
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d');

  // Uma escala só (m/px), a mais restritiva das duas dimensões — senão a imagem distorce e a
  // barra de escala mente pra um dos eixos.
  const escala = Math.min((CANVAS_W - PAD * 2) / (maxX - minX), (CANVAS_H - PAD * 2) / (maxY - minY));
  const centroPxX = CANVAS_W / 2, centroPxY = CANVAS_H / 2;
  const centroMX = (minX + maxX) / 2, centroMY = (minY + maxY) / 2;
  const projetar = (coordLatLon) => {
    const [mx, my] = paraMetros(coordLatLon);
    return [centroPxX + (mx - centroMX) * escala, centroPxY - (my - centroMY) * escala];
  };

  ctx.fillStyle = '#eef2ef';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Contexto do entorno (vias e hidrografia) — busca na mesma área geográfica já enquadrada acima
  // (com a margem de 25% incluída), convertendo os limites em metros de volta pra lat/lon.
  const minLatBBox = latCentro + minY / metrosPorGrauLat;
  const maxLatBBox = latCentro + maxY / metrosPorGrauLat;
  const minLonBBox = lonCentro + minX / metrosPorGrauLon;
  const maxLonBBox = lonCentro + maxX / metrosPorGrauLon;
  const { vias, hidrografia } = await buscarContextoOSM(minLatBBox, minLonBBox, maxLatBBox, maxLonBBox);

  // Hidrografia primeiro (fica embaixo de tudo) — corpos d'água fechados (lagos/represas) preenchidos,
  // rios/córregos (linha aberta) só contornados.
  hidrografia.forEach((linha) => {
    const px = linha.map(projetar);
    const fechado = linha.length > 2 &&
      Math.abs(linha[0][0] - linha[linha.length - 1][0]) < 1e-6 &&
      Math.abs(linha[0][1] - linha[linha.length - 1][1]) < 1e-6;
    ctx.beginPath();
    px.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    if (fechado) {
      ctx.closePath();
      ctx.fillStyle = 'rgba(90, 155, 213, 0.35)';
      ctx.fill();
    }
    ctx.strokeStyle = '#5a9bd5';
    ctx.lineWidth = fechado ? 1.5 : 2.5;
    ctx.stroke();
  });

  // Vias — linha clara com contorno sutil, no estilo de mapa de referência (não é o foco do
  // diagrama, só dá contexto de acesso à área).
  vias.forEach((linha) => {
    const px = linha.map(projetar);
    ctx.beginPath();
    px.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.strokeStyle = '#c9ccc7';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.strokeStyle = '#8b9089';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  poligonos.forEach((pol) => {
    const pxPontos = pol.anel.map(projetar);
    ctx.beginPath();
    pxPontos.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(107, 79, 160, 0.15)';
    ctx.fill();
    ctx.strokeStyle = '#6b4fa0';
    ctx.lineWidth = 3;
    ctx.stroke();
  });

  pontosNumerados.forEach((p) => {
    const [x, y] = projetar([p.lat, p.lon]);
    ctx.beginPath();
    ctx.arc(x, y, 15, 0, Math.PI * 2);
    ctx.fillStyle = '#40916c';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#1b4332';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 17px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(p.numero), x, y + 1);
  });

  // Escala gráfica: escolhe o maior valor "redondo" que ainda caiba em ~28% da largura útil —
  // assim a barra fica proporcional ao tamanho real da área, nem minúscula nem cortada.
  const larguraDisponivelM = ((CANVAS_W - PAD * 2) / escala) * 0.28;
  const passosRedondos = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
  const distanciaEscalaM = passosRedondos.reduce((melhor, v) => (v <= larguraDisponivelM ? v : melhor), passosRedondos[0]);
  const escalaPx = distanciaEscalaM * escala;
  const escY = CANVAS_H - 40, escX0 = PAD;
  ctx.strokeStyle = '#1c2620';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(escX0, escY); ctx.lineTo(escX0 + escalaPx, escY);
  ctx.moveTo(escX0, escY - 6); ctx.lineTo(escX0, escY + 6);
  ctx.moveTo(escX0 + escalaPx, escY - 6); ctx.lineTo(escX0 + escalaPx, escY + 6);
  ctx.stroke();
  ctx.fillStyle = '#1c2620';
  ctx.font = '20px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(distanciaEscalaM >= 1000 ? `${distanciaEscalaM / 1000} km` : `${distanciaEscalaM} m`, escX0 + escalaPx / 2, escY + 10);

  // Seta indicando Norte — a projeção local usada aqui sempre tem "pra cima" = Norte verdadeiro.
  const nX = CANVAS_W - 60, nY = 70;
  ctx.beginPath();
  ctx.moveTo(nX, nY - 30); ctx.lineTo(nX - 12, nY + 15); ctx.lineTo(nX, nY + 4); ctx.lineTo(nX + 12, nY + 15);
  ctx.closePath();
  ctx.fillStyle = '#1c2620';
  ctx.fill();
  ctx.font = 'bold 20px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('N', nX, nY - 40);

  ctx.strokeStyle = '#dde5e0';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, CANVAS_W - 2, CANVAS_H - 2);

  // Devolve também o que realmente foi encontrado (vias/hidrografia) — quem chama usa isso pra
  // montar a tabela de legenda só com as linhas que fazem sentido pra este mapa específico.
  return { dataUrl: canvas.toDataURL('image/png'), temVias: vias.length > 0, temHidrografia: hidrografia.length > 0 };
}

// ---------- Texto interpretativo (recomendações por parâmetro, molde do PAR/Mananciais) ----------
// Frases adaptadas das próprias descrições de cada situação no Anexo II — não são um índice novo,
// só traduzem o enquadramento numérico em orientação prática para quem for ler o relatório.
const RECOMENDACOES_DIRETAS = {
  necessidade_replantio: {
    nome: 'Necessidade de replantio',
    0: 'falhas de plantio generalizadas — recomenda-se replantio, adensamento e/ou enriquecimento na maior parte da área.',
    0.65: 'falhas pontuais de plantio — adensamento localizado é suficiente, mas atrasa a trajetória de sucessão se não corrigido.'
  },
  cobertura_copa: {
    nome: 'Cobertura de copa',
    0: 'copas ainda não se tocam na maior parte da área — reforçar o adensamento para acelerar o fechamento do dossel.',
    0.65: 'fechamento de copa em formação, com pequenos agrupamentos — manter acompanhamento na próxima vistoria.'
  },
  distribuicao_especies: {
    nome: 'Distribuição das espécies',
    0: 'predomínio de uma única espécie arbustiva/arbórea — recomenda-se enriquecimento com espécies diferentes das já implantadas.',
    0.65: 'predomínio de até três espécies — ampliar a diversidade nos próximos plantios de enriquecimento.'
  },
  altura_estimada: {
    nome: 'Altura estimada',
    0: 'indivíduos ainda baixos (até 1,5m) — acompanhar o desenvolvimento e investigar fatores limitantes (competição, solo, manejo).',
    0.65: 'crescimento em curso (1,5 a 3,0m), porém aquém do potencial — monitorar na próxima vistoria.'
  },
  competicao: {
    nome: 'Competição',
    0: 'gramíneas ou outras invasoras comprometendo o desenvolvimento das mudas — controle de plantas daninhas necessário antes da próxima vistoria.',
    0.65: 'competição localizada em pequenas porções da área — controle pontual recomendado.'
  }
};

function gerarInterpretacao(metricas) {
  const cls = classificarConceito(metricas.conceito);
  const textoGeral = {
    critico: 'Situação crítica: recomendam-se grandes intervenções ou refazer a implantação da restauração por completo.',
    minimo: 'Situação mínima: ações corretivas são necessárias para que o projeto retome a trajetória adequada.',
    adequado: 'Situação adequada: conceito compatível com aprovação para fins de quitação, desde que não haja nota crítica em nenhum parâmetro (ver alertas).'
  };
  const linhas = [textoGeral[cls.classe]];
  const total = metricas.pontos.length;

  for (const [key, info] of Object.entries(RECOMENDACOES_DIRETAS)) {
    const criticos = metricas.pontos.filter((p) => p[key] === 0).length;
    const minimos = metricas.pontos.filter((p) => p[key] === 0.65).length;
    if (criticos > 0) {
      linhas.push(`${info.nome}: crítico em ${criticos} de ${total} ponto(s) (${Math.round((criticos / total) * 100)}%) — ${info[0]}`);
    } else if (minimos > 0) {
      linhas.push(`${info.nome}: mínimo em ${minimos} de ${total} ponto(s) (${Math.round((minimos / total) * 100)}%) — ${info[0.65]}`);
    }
  }

  if (metricas.notaAtrativos === 0) {
    linhas.push(`Atrativos de fauna: situação crítica (${metricas.totalAtrativos} espécie(s) com flores/frutos identificadas no polígono) — plantio de espécies atrativas para fauna recomendado, para estimular a chegada de dispersores.`);
  } else if (metricas.notaAtrativos === 0.65) {
    linhas.push(`Atrativos de fauna: situação mínima (${metricas.totalAtrativos} espécie(s) identificadas) — reforçar com mais espécies zoocóricas nos próximos plantios.`);
  }
  if (metricas.notaRiqueza === 0) {
    linhas.push(`Riqueza aparente: situação crítica (${metricas.totalRiqueza} espécie(s) arbustivas/arbóreas nativas identificadas no polígono) — enriquecimento florístico recomendado.`);
  } else if (metricas.notaRiqueza === 0.65) {
    linhas.push(`Riqueza aparente: situação mínima (${metricas.totalRiqueza} espécie(s) identificadas) — diversificar ainda mais em plantios futuros.`);
  }

  return linhas;
}

document.getElementById('btn-exportar-pdf').addEventListener('click', async () => {
  // Num PWA instalado no iPhone (modo standalone), window.open() não é confiável — por isso só
  // abrimos essa aba de reserva quando o Web Share API não existir (entregarArquivo() usa share
  // como método principal). Quando existe window.open, é aberto AQUI, de forma síncrona, antes de
  // qualquer await, porque esperar demais faz o navegador tratar como se não fosse mais um gesto
  // confiável do usuário e bloquear o download sem aviso nenhum.
  const abaPdf = (navigator.canShare) ? null : window.open('', '_blank');
  mostrarMsg('exportar-msg', '<div class="msg ok">Gerando PDF...</div>', 30000);

  try {
    const processoId = document.getElementById('m-processo').value;
    const processo = await buscarProcessoPorId(processoId);
    const metricas = await calcularMetricasProcesso(processoId);
    if (!processo || !metricas) {
      if (abaPdf) abaPdf.close();
      mostrarMsg('exportar-msg', '<div class="msg erro">Selecione um processo com pelo menos um ponto avaliado antes de exportar.</div>');
      return;
    }
    // Trava explícita: antes só gerávamos o PDF direto, e se a atribuição automática por horário
    // não encontrasse nenhuma foto pra nenhum ponto (ex: fotos sem EXIF, ou fora da janela de
    // tempo), o PDF saía "normal" mas sem nenhuma página de Anexo Fotográfico — sem aviso nenhum.
    // Isso é exatamente o que aconteceu em campo. Agora, se há fotos carregadas mas nenhuma foi
    // atribuída a ponto nenhum, para a exportação e manda revisar o mosaico antes de gerar de novo.
    if (fotosCarregadas.length > 0) {
      const comFotoAtribuida = metricas.pontos.filter((p) => (mosaicoAtual[p.id] || []).length > 0).length;
      if (comFotoAtribuida === 0) {
        if (abaPdf) abaPdf.close();
        mostrarMsg('exportar-msg', `<div class="msg erro">Você carregou ${fotosCarregadas.length} foto(s), mas nenhuma foi atribuída a um ponto ainda (o casamento automático por horário não encontrou nenhuma correspondência). Role até "Mosaico de fotos por horário" acima, confira se algum ponto ficou "sem foto atribuída" e use "Escolher fotos manualmente" nesses casos — depois exporte de novo.</div>`, 15000);
        const elMosaico = document.getElementById('m-fotos-resultado');
        const cardMosaico = elMosaico?.closest('.card') || elMosaico;
        cardMosaico?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }
    const tec = carregarTecnico();

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
  const LARGURA = doc.internal.pageSize.getWidth();

  // ---- Cabeçalho oficial (Anexo II) ----
  doc.setFontSize(10);
  doc.setFont(undefined, 'bold');
  doc.text('GOVERNO DO ESTADO DO RIO DE JANEIRO', LARGURA / 2, 14, { align: 'center' });
  doc.text('SECRETARIA DE ESTADO DO AMBIENTE – SEA', LARGURA / 2, 19, { align: 'center' });
  doc.text('INSTITUTO ESTADUAL DO AMBIENTE – INEA', LARGURA / 2, 24, { align: 'center' });
  doc.text('PROTOCOLO DE MONITORAMENTO PARA PROJETOS DE RESTAURAÇÃO', LARGURA / 2, 31, { align: 'center' });

  doc.setFillColor(27, 67, 50);
  doc.rect(14, 35, LARGURA - 28, 7, 'F');
  doc.setTextColor('#ffffff');
  doc.text('DIAGNÓSTICO AMBIENTAL RÁPIDO (DAR) – QUITAÇÃO FLORESTAS', LARGURA / 2, 39.5, { align: 'center' });
  doc.setTextColor('#000000');
  doc.setFont(undefined, 'normal');

  // Nota: nenhum caractere fora do WinAnsiEncoding pode entrar num doc.text() daqui pra baixo —
  // "Σ", "≥" etc. quebram a fonte padrão do jsPDF (o PDF fragmenta o texto em blocos com encoding
  // diferente, o que também corrompe a extração de texto/cópia, não só o visual).
  doc.setFontSize(7.5);
  let y = textoComQuebra(doc,
    'Percurso pelo polígono da área em restauração com avaliação dos indicadores em cada ponto de observação (raio aproximado de 10m). Parâmetros enquadrados em Crítica (nota=0), Mínima (nota=0,65) ou Adequada (nota=1,0). Conceito final = soma das notas de cada ponto x (10/n° parâmetros). Nenhum parâmetro pode ficar crítico em nenhum ponto; os cumulativos (Atrativos de fauna e Riqueza aparente) não podem ficar críticos em mais de 50% dos pontos.',
    14, 46, LARGURA - 28, 3.6);
  y += 4;

  // ---- Identificação do técnico avaliador ----
  doc.autoTable({
    startY: y,
    margin: { left: 14, right: 14 },
    styles: { fontSize: 8, cellPadding: 2 },
    head: [['IDENTIFICAÇÃO DO TÉCNICO AVALIADOR', '']],
    headStyles: { fillColor: [217, 231, 211], textColor: '#1b4332', halign: 'left' },
    body: [
      [`Responsável: ${tec.nome || '—'}`, `Data: ${new Date().toLocaleDateString('pt-BR')}`],
      [`Setor: ${tec.setor || '—'}`, `Matrícula: ${tec.matricula || '—'}`],
      [`Formação: ${tec.formacao || '—'}`, '']
    ]
  });
  y = doc.lastAutoTable.finalY + 4;

  // ---- Identificação do requerente ----
  doc.autoTable({
    startY: y,
    margin: { left: 14, right: 14 },
    styles: { fontSize: 8, cellPadding: 2 },
    head: [['IDENTIFICAÇÃO DO REQUERENTE', '']],
    headStyles: { fillColor: [217, 231, 211], textColor: '#1b4332', halign: 'left' },
    body: [
      [`N° do processo administrativo: ${processo.numero_administrativo}`, `Formação vegetal / Área: ${processo.formacao_vegetal} — ${processo.area_ha} ha`],
      [`Razão social: ${processo.razao_social || '—'}`, `CPF/CNPJ: ${processo.cpf_cnpj || '—'}`],
      [`Endereço: ${processo.endereco || '—'}`, `Complemento: ${processo.complemento || '—'}`],
      [`Município: ${processo.municipio || '—'}`, `CEP: ${processo.cep || '—'}`],
      [`Contato — Nome: ${processo.contato_nome || '—'}`, `Telefone: ${processo.contato_telefone || '—'}   E-mail: ${processo.contato_email || '—'}`]
    ]
  });
  y = doc.lastAutoTable.finalY + 6;

  // ---- Tabelas de parâmetros, no formato do Quadro 5 do manual: situação x pontos, com marcação ----
  // (em vez de só a nota numérica — repete a estrutura da ficha oficial de campo, com uma linha por
  // situação Crítica/Mínima/Adequada e uma marca "X" na célula do ponto enquadrado ali).
  // Observação: "●" (U+25CF) não é suportado pela fonte padrão do jsPDF (vira lixo tipo "%l"
  // no PDF gerado) — "X" é ASCII puro e sempre renderiza certo.
  function tabelaSituacaoGrid(nome, chunk, valores, startY) {
    const head = [['Parâmetro', 'Situação', ...chunk.map((l) => `${l.n}`)]];
    const body = [
      [nome, 'Crítica (nota=0)', ...valores.map((v) => (v === 0 ? 'X' : ''))],
      ['', 'Mínima (nota=0,65)', ...valores.map((v) => (v === 0.65 ? 'X' : ''))],
      ['', 'Adequada (nota=1,0)', ...valores.map((v) => (v === 1 ? 'X' : ''))]
    ];
    doc.autoTable({
      head, body, startY, margin: { left: 14, right: 14 }, styles: { fontSize: 8, halign: 'center' },
      columnStyles: { 0: { halign: 'left', fontStyle: 'bold', cellWidth: 34 }, 1: { halign: 'left', cellWidth: 22 } },
      headStyles: { fillColor: [27, 67, 50] }
    });
    return doc.lastAutoTable.finalY;
  }

  // TAMANHO_BLOCO = 20: medido de propósito com doc.getTextWidth() antes de fixar esse número — a
  // tabela (34mm parâmetro + 22mm situação + o resto dividido entre os pontos) só cabe na largura
  // da página A4 até 35 colunas de ponto; acima disso a tabela passa a vazar da margem direita.
  // 20 fica bem abaixo desse limite técnico (coluna de ~7,2mm, ainda legível numa impressão física
  // em papel) — 35 tecnicamente cabe, mas fica visualmente apertado demais pra imprimir.
  const TAMANHO_BLOCO = 20;
  const linhasComIndice = metricas.linhas.map((l, i) => ({ ...l, n: i + 1 }));
  const chunks = [];
  for (let i = 0; i < linhasComIndice.length; i += TAMANHO_BLOCO) chunks.push(linhasComIndice.slice(i, i + TAMANHO_BLOCO));

  chunks.forEach((chunk) => {
    if (y > 230) { doc.addPage(); y = 16; }
    const inicio = chunk[0].n;
    const fim = chunk[chunk.length - 1].n;
    doc.setFontSize(9.5);
    doc.setTextColor('#1b4332');
    doc.setFont(undefined, 'bold');
    doc.text(`Pontos de observação ${inicio}–${fim}`, 14, y);
    doc.setFont(undefined, 'normal');
    doc.setTextColor('#000000');
    y += 3;

    y = tabelaSituacaoGrid('Necessidade de replantio', chunk, chunk.map((l) => l.ponto.necessidade_replantio), y) + 3;
    if (y > 250) { doc.addPage(); y = 16; }
    y = tabelaSituacaoGrid('Atrativos de fauna (cumulativo)', chunk, chunk.map(() => metricas.notaAtrativos), y) + 3;
    if (y > 250) { doc.addPage(); y = 16; }
    y = tabelaSituacaoGrid('Cobertura de copa', chunk, chunk.map((l) => l.ponto.cobertura_copa), y) + 3;
    if (y > 250) { doc.addPage(); y = 16; }
    y = tabelaSituacaoGrid('Distribuição das espécies', chunk, chunk.map((l) => l.ponto.distribuicao_especies), y) + 3;
    if (y > 250) { doc.addPage(); y = 16; }
    y = tabelaSituacaoGrid('Riqueza aparente (cumulativo)', chunk, chunk.map(() => metricas.notaRiqueza), y) + 3;
    if (y > 250) { doc.addPage(); y = 16; }
    y = tabelaSituacaoGrid('Altura estimada', chunk, chunk.map((l) => l.ponto.altura_estimada), y) + 3;
    if (y > 250) { doc.addPage(); y = 16; }
    y = tabelaSituacaoGrid('Competição', chunk, chunk.map((l) => l.ponto.competicao), y) + 3;

    if (y > 245) { doc.addPage(); y = 16; }
    doc.autoTable({
      head: [['', ...chunk.map((l) => `${l.n}`)]],
      body: [['Soma das notas', ...chunk.map((l) => fmtDecimal(l.somatorio))]],
      startY: y, margin: { left: 14, right: 14 }, styles: { fontSize: 8, halign: 'center' },
      columnStyles: { 0: { halign: 'left', fontStyle: 'bold', cellWidth: 34 } },
      headStyles: { fillColor: [212, 172, 13], textColor: '#1b4332' },
      bodyStyles: { fontStyle: 'bold' }
    });
    y = doc.lastAutoTable.finalY + 4;

    const comObs = chunk.filter((l) => l.ponto.observacoes && l.ponto.observacoes.trim());
    if (comObs.length) {
      if (y > 240) { doc.addPage(); y = 16; }
      doc.autoTable({
        head: [['Ponto', 'Observações']],
        body: comObs.map((l) => [`${l.n}`, l.ponto.observacoes]),
        startY: y, margin: { left: 14, right: 14 }, styles: { fontSize: 7 },
        columnStyles: { 0: { cellWidth: 14, halign: 'center' } },
        headStyles: { fillColor: [217, 231, 211], textColor: '#1b4332' }
      });
      y = doc.lastAutoTable.finalY + 4;
    }
    y += 6;
  });

  // ---- Conceito final e alertas ----
  if (y > 250) { doc.addPage(); y = 16; }
  const cls = classificarConceito(metricas.conceito);
  doc.setFontSize(12);
  doc.setFont(undefined, 'bold');
  doc.setTextColor(cls.classe === 'adequado' ? '#1b4332' : cls.classe === 'minimo' ? '#b8860b' : '#b23a2c');
  doc.text(`Conceito final: ${fmtDecimal(metricas.conceito)} — ${cls.texto}${metricas.apto ? ' (apto para quitação)' : ''}`, 14, y);
  doc.setFont(undefined, 'normal');
  doc.setTextColor('#000000');
  doc.setFontSize(9);
  y += 6;
  doc.text(`Pontos de observação avaliados: ${metricas.pontos.length} de ${processo.num_pontos}`, 14, y);
  y += 6;

  if (metricas.alertas.length) {
    doc.setFontSize(8);
    doc.setTextColor('#b23a2c');
    metricas.alertas.forEach((a) => { y = textoComQuebra(doc, `• ${a}`, 14, y, LARGURA - 28, 4) + 1; });
    doc.setTextColor('#000000');
    y += 4;
  }

  // ---- Interpretação e recomendações (molde do PAR/Mananciais: um parecer por índice/parâmetro) ----
  if (y > 250) { doc.addPage(); y = 16; }
  doc.setFontSize(10);
  doc.setFont(undefined, 'bold');
  doc.setTextColor('#1b4332');
  doc.text('INTERPRETAÇÃO E RECOMENDAÇÕES', 14, y);
  doc.setFont(undefined, 'normal');
  doc.setTextColor('#000000');
  y += 5;
  doc.setFontSize(8);
  gerarInterpretacao(metricas).forEach((texto, i) => {
    if (y > 265) { doc.addPage(); y = 16; }
    y = textoComQuebra(doc, i === 0 ? texto : `• ${texto}`, 14, y, LARGURA - 28, 4) + 2;
  });
  y += 4;

  // ---- Espécies observadas ----
  if (y > 255) { doc.addPage(); y = 16; }
  doc.setFontSize(10);
  doc.setFont(undefined, 'bold');
  doc.setTextColor('#1b4332');
  doc.text(`Espécies com atrativos para fauna observadas (${metricas.especiesFauna.size})`, 14, y);
  doc.setFont(undefined, 'normal');
  doc.setTextColor('#000000');
  doc.setFontSize(8);
  y = textoComQuebra(doc, [...metricas.especiesFauna].sort().join('; ') || 'Nenhuma registrada.', 14, y + 5, LARGURA - 28, 4) + 6;

  if (y > 255) { doc.addPage(); y = 16; }
  doc.setFontSize(10);
  doc.setFont(undefined, 'bold');
  doc.setTextColor('#1b4332');
  doc.text(`Espécies vegetais / riqueza aparente observadas (${metricas.especiesVegetal.size})`, 14, y);
  doc.setFont(undefined, 'normal');
  doc.setTextColor('#000000');
  doc.setFontSize(8);
  y = textoComQuebra(doc, [...metricas.especiesVegetal].sort().join('; ') || 'Nenhuma registrada.', 14, y + 5, LARGURA - 28, 4) + 6;

  // ---- Mapa de localização: distribuição dos pontos + polígono da área de plantio (quando tem
  // KML importado na aba Mapa para este processo). Fica antes do anexo fotográfico, numa folha
  // própria — pedido explícito, pra dar contexto espacial antes de ver as fotos de cada ponto.
  const pontosComCoordNumerados = metricas.pontos
    .map((p, i) => ({ ...p, numero: i + 1 }))
    .filter((p) => p.latitude != null && p.longitude != null)
    .map((p) => ({ lat: p.latitude, lon: p.longitude, numero: p.numero }));
  const poligonosDoProcesso = (await listarTodos('kml_poligonos')).filter((pol) => pol.processo_id === processoId);
  const resultadoMapa = await gerarMapaEstatico(pontosComCoordNumerados, poligonosDoProcesso);
  if (resultadoMapa) {
    const { dataUrl: mapaDataUrl, temVias, temHidrografia } = resultadoMapa;
    doc.addPage();
    let yMapa = 16;
    doc.setFontSize(12);
    doc.setFont(undefined, 'bold');
    doc.setTextColor('#1b4332');
    doc.text('MAPA DE LOCALIZAÇÃO', 14, yMapa);
    doc.setFont(undefined, 'normal');
    doc.setTextColor('#000000');
    doc.setFontSize(8);
    yMapa += 7;
    yMapa = textoComQuebra(doc,
      'Distribuição dos pontos de observação e do contorno da área de plantio, com vias e hidrografia do entorno quando disponíveis (ver legenda).',
      14, yMapa, LARGURA - 28, 4) + 4;
    const imgW = LARGURA - 28;
    const imgH = imgW * (1000 / 1400); // mesma proporção do canvas gerado (1400x1000)
    doc.addImage(mapaDataUrl, 'PNG', 14, yMapa, imgW, imgH);
    doc.setDrawColor(219, 228, 223);
    doc.rect(14, yMapa, imgW, imgH);

    // Tabela de legenda — só com as linhas que realmente aparecem neste mapa específico (ex.: não
    // lista hidrografia se nenhum rio/lago foi encontrado nem polígono se não houver KML importado).
    const linhasLegenda = [[{ content: '', styles: { fillColor: [64, 145, 108] } }, 'Ponto de observação avaliado']];
    if (poligonosDoProcesso.length) linhasLegenda.push([{ content: '', styles: { fillColor: [107, 79, 160] } }, 'Contorno da área de plantio (KML importado)']);
    if (temVias) linhasLegenda.push([{ content: '', styles: { fillColor: [139, 144, 137] } }, 'Vias de acesso (OpenStreetMap)']);
    if (temHidrografia) linhasLegenda.push([{ content: '', styles: { fillColor: [90, 155, 213] } }, 'Hidrografia — rios, córregos e corpos d\'água (OpenStreetMap)']);
    doc.autoTable({
      startY: yMapa + imgH + 4,
      margin: { left: 14, right: 14 },
      theme: 'plain',
      styles: { fontSize: 7.5, cellPadding: { top: 2.5, bottom: 2.5, left: 2, right: 2 }, lineColor: [221, 229, 224], lineWidth: 0.2 },
      columnStyles: { 0: { cellWidth: 8 } },
      body: linhasLegenda
    });
  }

  // ---- Anexo fotográfico (fotos casadas por horário, ou atribuídas manualmente, a cada ponto) ----
  // Uma folha por ponto, até 4 fotos em grade 2x2 (tamanho maior, legível), cada foto com legenda
  // indicando o ponto de observação a que se refere — pedido explícito para facilitar a conferência.
  const fotosDoPonto = (pontoId) => (mosaicoAtual[pontoId] || []).map(fotoPorId).filter(Boolean);
  const pontosComFotos = metricas.pontos.filter((p) => fotosDoPonto(p.id).length);

  function folhaFotosPonto(idx, dataHora, fotos) {
    doc.addPage();
    let yFoto = 16;
    doc.setFontSize(12);
    doc.setFont(undefined, 'bold');
    doc.setTextColor('#1b4332');
    doc.text(`ANEXO FOTOGRÁFICO — PONTO ${idx}`, 14, yFoto);
    doc.setFont(undefined, 'normal');
    doc.setTextColor('#000000');
    doc.setFontSize(8);
    yFoto += 7;
    doc.text(`Avaliado em: ${dataHora}`, 14, yFoto);
    yFoto += 6;

    // Limite de 2 fotos por ponto — uma linha só, imagens maiores.
    const imgW = 88, imgH = 100, gapX = 8;
    const grupo = fotos.slice(0, 2);
    grupo.forEach((f, i) => {
      const x = 14 + i * (imgW + gapX);
      try { doc.addImage(f.dataUrl, formatoImagem(f.dataUrl), x, yFoto, imgW, imgH); } catch { /* formato não suportado — ignora a miniatura */ }
      doc.setDrawColor(219, 228, 223);
      doc.rect(x, yFoto, imgW, imgH);
      doc.setFontSize(7.5);
      doc.setTextColor('#5b6b62');
      doc.text(`Ponto ${idx} — foto ${i + 1} de ${fotos.length}`, x, yFoto + imgH + 4.5);
      doc.setTextColor('#000000');
    });

    if (fotos.length > 2) folhaFotosPonto(idx, dataHora, fotos.slice(2));
  }

  pontosComFotos.forEach((p) => {
    const idx = metricas.pontos.indexOf(p) + 1;
    folhaFotosPonto(idx, new Date(p.avaliado_em).toLocaleString('pt-BR'), fotosDoPonto(p.id));
  });

    const nomeArquivo = `monitoramento-prf-${processo.numero_administrativo.replace(/\W+/g, '-')}.pdf`;
    await entregarArquivo(nomeArquivo, doc.output('arraybuffer'), 'application/pdf', abaPdf);
    mostrarMsg('exportar-msg', '<div class="msg ok">PDF gerado.</div>');
  } catch (erro) {
    if (abaPdf) abaPdf.close();
    mostrarMsg('exportar-msg', `<div class="msg erro">Não foi possível gerar o PDF: ${escaparTexto(erro?.message || erro)}</div>`, 10000);
    console.error('Erro ao gerar PDF:', erro);
  }
});

// ---------- Mapa — importação de KML e "Ir para o ponto" ----------
// Pontos do KML ficam só no IndexedDB deste aparelho (kml_pontos) — são uma referência de
// navegação em campo, não fazem parte do protocolo DAR, então não sincronizam com o Supabase.
let mapaLeaflet = null;
let mapaMarcadores = {}; // kmlPontoId -> L.Marker
let mapaPoligonos = []; // L.Polygon[] — contorno(s) da área de plantio importados do KML
let marcadorDestaque = null;

// ---------- Navegação ao vivo até o ponto selecionado ----------
let watchIdNavegacao = null;
let minhaPosicaoMarker = null;
let pontoAlvoNavegacao = null; // {lat, lng}

function distanciaMetros(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function formatarDistancia(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${fmtDecimal(m / 1000)} km`;
}

function pararNavegacao() {
  if (watchIdNavegacao !== null) {
    navigator.geolocation.clearWatch(watchIdNavegacao);
    watchIdNavegacao = null;
  }
  if (minhaPosicaoMarker && mapaLeaflet) {
    mapaLeaflet.removeLayer(minhaPosicaoMarker);
  }
  minhaPosicaoMarker = null;
  pontoAlvoNavegacao = null;
  const painel = document.getElementById('mapa-navegacao');
  if (painel) painel.style.display = 'none';
}

function iniciarNavegacao(alvoLatLng) {
  pontoAlvoNavegacao = alvoLatLng;
  const painel = document.getElementById('mapa-navegacao');
  const distEl = document.getElementById('mapa-distancia');
  painel.style.display = 'block';

  if (!navigator.geolocation) {
    distEl.textContent = 'Geolocalização não disponível neste aparelho.';
    return;
  }

  // Se já havia uma navegação rodando (trocou de ponto sem parar), reaproveita o watch — só
  // atualiza o alvo; não precisa pedir permissão de novo nem recriar o marcador de posição.
  if (watchIdNavegacao !== null) {
    distEl.textContent = 'Atualizando distância...';
    return;
  }

  distEl.textContent = 'Obtendo sua localização...';
  watchIdNavegacao = navigator.geolocation.watchPosition(
    (pos) => {
      const latlng = window.L.latLng(pos.coords.latitude, pos.coords.longitude);
      if (!minhaPosicaoMarker) {
        minhaPosicaoMarker = window.L.circleMarker(latlng, {
          radius: 8, color: '#ffffff', weight: 2, fillColor: '#1a73e8', fillOpacity: 1
        }).addTo(mapaLeaflet).bindPopup('Você está aqui');
      } else {
        minhaPosicaoMarker.setLatLng(latlng);
      }
      if (pontoAlvoNavegacao) {
        const d = distanciaMetros(latlng.lat, latlng.lng, pontoAlvoNavegacao.lat, pontoAlvoNavegacao.lng);
        distEl.textContent = `Distância até o ponto: ${formatarDistancia(d)}`;
      }
    },
    (erro) => {
      distEl.textContent = `Não foi possível obter sua localização (${erro.message || 'confira a permissão de GPS'}). A navegação continua tentando.`;
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
  );
}

document.getElementById('btn-parar-navegacao').addEventListener('click', pararNavegacao);

// Lê tanto <Point> (pontos de planejamento) quanto <Polygon> (contorno da área de plantio) do
// mesmo arquivo KML — o polígono normalmente vem no mesmo shapefile/KML exportado do GIS que já
// tem os pontos previstos, então processar os dois de uma vez evita pedir dois uploads separados.
function parseKml(texto) {
  const xml = new DOMParser().parseFromString(texto, 'text/xml');
  const placemarks = Array.from(xml.querySelectorAll('Placemark'));
  const pontos = [];
  const poligonos = [];
  placemarks.forEach((pm, i) => {
    const nome = pm.querySelector('name')?.textContent?.trim() || `Ponto ${i + 1}`;

    const coordTextPonto = pm.querySelector('Point > coordinates')?.textContent?.trim();
    if (coordTextPonto) {
      const [lon, lat] = coordTextPonto.split(',').map((v) => parseFloat(v.trim()));
      if (!isNaN(lat) && !isNaN(lon)) pontos.push({ nome, lat, lon });
    }

    // outerBoundaryIs é o contorno externo do polígono — innerBoundaryIs (buracos internos) não é
    // relevante aqui, é só a área de plantio como um todo.
    const coordTextPoligono = pm.querySelector('Polygon outerBoundaryIs coordinates')?.textContent?.trim();
    if (coordTextPoligono) {
      const anel = coordTextPoligono.split(/\s+/).filter(Boolean).map((par) => {
        const [lon, lat] = par.split(',').map((v) => parseFloat(v.trim()));
        return [lat, lon];
      }).filter(([lat, lon]) => !isNaN(lat) && !isNaN(lon));
      if (anel.length >= 3) poligonos.push({ nome: pm.querySelector('name')?.textContent?.trim() || `Polígono ${i + 1}`, anel });
    }
  });
  return { pontos, poligonos };
}

// Importa pontos e/ou polígono de um KML pro processo indicado — mesma lógica usada tanto no
// cadastro do processo (campo opcional, evita ter que ir na aba Mapa depois) quanto na própria
// aba Mapa. Retorna as contagens pra quem chamou decidir a mensagem certa.
async function importarKmlNoProcesso(file, processoId) {
  const texto = await file.text();
  const { pontos, poligonos } = parseKml(texto);
  const criadoPor = sessaoAtual?.user?.id ?? null;
  for (const p of pontos) {
    await salvarLocal('kml_pontos', { id: crypto.randomUUID(), processo_id: processoId, nome: p.nome, lat: p.lat, lon: p.lon, criado_por: criadoPor, criado_em: new Date().toISOString() });
  }
  for (const pol of poligonos) {
    await salvarLocal('kml_poligonos', { id: crypto.randomUUID(), processo_id: processoId, nome: pol.nome, anel: pol.anel, criado_por: criadoPor, criado_em: new Date().toISOString() });
  }
  return { pontos: pontos.length, poligonos: poligonos.length };
}

document.getElementById('mapa-kml').addEventListener('change', async (e) => {
  const processoId = document.getElementById('mapa-processo').value;
  const msgEl = document.getElementById('mapa-kml-msg');
  if (!processoId) { msgEl.innerHTML = '<div class="msg erro">Selecione um processo primeiro.</div>'; e.target.value = ''; return; }
  const file = e.target.files[0];
  if (!file) return;

  try {
    const { pontos, poligonos } = await importarKmlNoProcesso(file, processoId);
    if (!pontos && !poligonos) {
      msgEl.innerHTML = '<div class="msg erro">Nenhum ponto ou polígono com coordenadas encontrado nesse KML.</div>';
      return;
    }
    const partes = [];
    if (pontos) partes.push(`${pontos} ponto(s)`);
    if (poligonos) partes.push(`${poligonos} polígono(s)`);
    msgEl.innerHTML = `<div class="msg ok">${partes.join(' e ')} importado(s) do KML.</div>`;
    e.target.value = '';
    await carregarPontosNoMapa(processoId);
  } catch (erro) {
    msgEl.innerHTML = `<div class="msg erro">Não foi possível ler esse KML: ${escaparTexto(erro?.message || erro)}</div>`;
    console.error('Erro ao importar KML:', erro);
  }
});

document.getElementById('mapa-processo').addEventListener('change', (e) => {
  processoAtualId = e.target.value || null;
  carregarPontosNoMapa(e.target.value);
});

function inicializarMapa() {
  const processoId = document.getElementById('mapa-processo').value;
  if (mapaLeaflet) {
    setTimeout(() => mapaLeaflet.invalidateSize(), 150);
    // Recarrega os pontos toda vez que a aba é reaberta — sem isso, um ponto de observação
    // recém-salvo só apareceria no mapa depois de trocar de processo manualmente.
    if (processoId) carregarPontosNoMapa(processoId);
    return;
  }
  mapaLeaflet = window.L.map('mapa-leaflet').setView([-22.9, -43.3], 9);
  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  }).addTo(mapaLeaflet);
  // O service worker cacheia os tiles conforme o mapa é usado — depois de visitar uma área
  // com sinal, ela continua disponível offline (ver sw.js).
  adicionarCamadasInea(mapaLeaflet);
  setTimeout(() => mapaLeaflet.invalidateSize(), 150);
  if (processoId) carregarPontosNoMapa(processoId);
}

// Camadas oficiais do INEA/GERGET (geoportal.inea.rj.gov.br), consumidas ao vivo via ArcGIS REST —
// nenhum dado é baixado/duplicado no nosso banco, são os mesmos serviços públicos do Mapa Interativo
// do INEA. Desligadas por padrão (o técnico liga pelo controle de camadas no canto do mapa) pra não
// gastar dados/bateria em campo à toa. Cada camada é isolada em try/catch: se o serviço do INEA
// estiver fora do ar, só aquela camada falha — pontos e polígono do KML continuam funcionando.
function adicionarCamadasInea(mapa) {
  if (!window.L?.esri) return;
  const BASE = 'https://geoportal.inea.rj.gov.br/server/rest/services';
  const overlays = {};
  const definir = (nome, criar) => {
    try { overlays[nome] = criar(); } catch (e) { console.warn(`Camada INEA "${nome}" indisponível:`, e); }
  };
  definir('APP — Rios (INEA)', () => window.L.esri.featureLayer({ url: `${BASE}/APPs_e_Uso_Restrito/FeatureServer/5`, style: { color: '#2a6f97', weight: 1, fillOpacity: 0.25 } }));
  definir('APP — Nascentes (INEA)', () => window.L.esri.featureLayer({ url: `${BASE}/APPs_e_Uso_Restrito/FeatureServer/3`, style: { color: '#0077b6', weight: 1, fillOpacity: 0.25 } }));
  definir('APP — Declividade (INEA)', () => window.L.esri.featureLayer({ url: `${BASE}/APPs_e_Uso_Restrito/FeatureServer/1`, style: { color: '#c9184a', weight: 1, fillOpacity: 0.2 } }));
  definir('APP — Topo de morro (INEA)', () => window.L.esri.featureLayer({ url: `${BASE}/APPs_e_Uso_Restrito/FeatureServer/6`, style: { color: '#7f5539', weight: 1, fillOpacity: 0.2 } }));
  definir('Hidrografia oficial IBGE (INEA)', () => window.L.esri.featureLayer({ url: `${BASE}/Recursos_Hidricos_Gestao_Costeira/FeatureServer/1`, style: { color: '#3a86ff', weight: 1.5 } }));
  definir('Unidades de Conservação estaduais (INEA)', () => window.L.esri.featureLayer({ url: `${BASE}/Unidades_de_Conserva%C3%A7%C3%A3o/FeatureServer/1`, style: { color: '#40916c', weight: 1, fillOpacity: 0.15 } }));
  definir('Unidades de Conservação federais (INEA)', () => window.L.esri.featureLayer({ url: `${BASE}/Unidades_de_Conserva%C3%A7%C3%A3o/FeatureServer/10`, style: { color: '#1b4332', weight: 1, fillOpacity: 0.15 } }));
  definir('Uso e cobertura do solo 2018 (INEA)', () => window.L.esri.dynamicMapLayer({ url: `${BASE}/Uso_e_Cobertura/MapServer`, layers: [3], opacity: 0.6 }));
  if (Object.keys(overlays).length) window.L.control.layers(null, overlays, { collapsed: true }).addTo(mapa);
}

async function carregarPontosNoMapa(processoId) {
  if (!mapaLeaflet) return;
  // Os marcadores antigos somem e são recriados — se a navegação continuasse apontando pro
  // objeto de marcador antigo, "restaurarEstiloPadrao" quebraria ao tentar mexer numa camada
  // que não existe mais no mapa.
  pararNavegacao();
  Object.values(mapaMarcadores).forEach((m) => mapaLeaflet.removeLayer(m));
  mapaMarcadores = {};
  mapaPoligonos.forEach((pol) => mapaLeaflet.removeLayer(pol));
  mapaPoligonos = [];
  marcadorDestaque = null;
  const gotoSelect = document.getElementById('mapa-goto');
  gotoSelect.innerHTML = '<option value="">Selecione um ponto</option>';
  if (!processoId) return;

  const grupo = [];

  // Contorno da área de plantio importado do KML — desenhado ANTES dos marcadores, pra ficar por
  // baixo deles visualmente. Não entra no select "Ir para o ponto" (não é um ponto de navegação).
  const poligonosTodos = await listarTodos('kml_poligonos');
  const poligonosDoProcesso = poligonosTodos.filter((p) => p.processo_id === processoId);
  poligonosDoProcesso.forEach((pol) => {
    const layer = window.L.polygon(pol.anel, {
      color: '#6b4fa0', weight: 2, fillColor: '#6b4fa0', fillOpacity: 0.12
    }).addTo(mapaLeaflet).bindPopup(`${escaparTexto(pol.nome)} (área de plantio)`);
    mapaPoligonos.push(layer);
    grupo.push(...pol.anel);
  });

  // Pontos importados por KML — planejamento prévio, ícone padrão (pino azul).
  const kmlTodos = await listarTodos('kml_pontos');
  const kmlPontos = kmlTodos.filter((p) => p.processo_id === processoId);
  kmlPontos.forEach((p) => {
    const marker = window.L.marker([p.lat, p.lon]).addTo(mapaLeaflet).bindPopup(`${escaparTexto(p.nome)} (planejado)`);
    mapaMarcadores[p.id] = marker;
    grupo.push([p.lat, p.lon]);
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.nome;
    gotoSelect.appendChild(opt);
  });

  // Pontos de observação já lançados de verdade em campo — círculo verde, pra diferenciar
  // visualmente do que foi só planejado no KML e do que já foi de fato avaliado.
  const obsTodos = await buscarPontosDoProcesso(processoId);
  const obsPontos = obsTodos.filter((p) => p.latitude != null && p.longitude != null);
  obsPontos.forEach((p, i) => {
    const nome = `Ponto avaliado ${i + 1}`;
    const marker = window.L.circleMarker([p.latitude, p.longitude], {
      radius: 8, color: '#1b4332', fillColor: '#40916c', fillOpacity: 0.9, weight: 2
    }).addTo(mapaLeaflet).bindPopup(`${nome}<br>${new Date(p.avaliado_em).toLocaleString('pt-BR')}`);
    mapaMarcadores[`obs-${p.id}`] = marker;
    grupo.push([p.latitude, p.longitude]);
    const opt = document.createElement('option');
    opt.value = `obs-${p.id}`;
    opt.textContent = nome;
    gotoSelect.appendChild(opt);
  });

  if (grupo.length) mapaLeaflet.fitBounds(grupo, { padding: [30, 30] });
}

function restaurarEstiloPadrao(id) {
  const m = mapaMarcadores[id];
  if (!m) return;
  if (m instanceof window.L.CircleMarker) {
    m.setStyle({ color: '#1b4332', fillColor: '#40916c', radius: 8 });
  } else if (m.setIcon) {
    m.setIcon(new window.L.Icon.Default());
  }
}

document.getElementById('btn-goto-point').addEventListener('click', () => {
  const id = document.getElementById('mapa-goto').value;
  if (!id || !mapaMarcadores[id]) return;
  const marker = mapaMarcadores[id];

  if (marcadorDestaque) restaurarEstiloPadrao(marcadorDestaque);

  if (marker instanceof window.L.CircleMarker) {
    marker.setStyle({ color: '#d4ac0d', fillColor: '#d4ac0d', radius: 11 });
  } else if (marker.setIcon) {
    const iconeDourado = new window.L.Icon({
      iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
      iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
      shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
      iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41],
      className: 'marcador-destaque'
    });
    marker.setIcon(iconeDourado);
  }
  marcadorDestaque = id;
  mapaLeaflet.setView(marker.getLatLng(), 17);
  marker.openPopup();
  iniciarNavegacao(marker.getLatLng());
});

// ---------- Boot ----------
atualizarBadgePendentes();
sincronizarPendentes();
