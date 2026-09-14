# PRD — Monitoramento de PRF

## O que é

PWA (Progressive Web App) de campo para aplicar o protocolo **DAR — Diagnóstico Ambiental Rápido**, do Manual de Monitoramento de Projetos de Reposição Florestal do INEA (2016) e seu Anexo II (Ficha DAR / Quitação Florestas). Um técnico avaliador usa o celular em campo, sem sinal a maior parte do tempo, para cadastrar processos, lançar pontos de observação e gerar o relatório final que instrui o processo administrativo.

**Não é** um substituto do trabalho de GIS/planejamento espacial (shapefile, delimitação do polígono) — isso continua sendo feito à parte, no GIS de costume do técnico. O app cobre as etapas de **campo** e **análise** do manual, não o **planejamento**.

## Quem usa

- **Técnico avaliador** (perfil único hoje) — cadastra processos, lança pontos, exporta relatório. Precisa de aprovação de um admin antes do primeiro uso (`perfis.aprovado`).
- **Administrador** — aprova novos técnicos direto no SQL Editor do Supabase (não existe tela de admin no app). Não há hierarquia além disso hoje.
- **Público em geral** (futuro, em construção) — visualização somente-leitura de processos marcados como públicos, via WebGIS separado. Ver seção WebGIS abaixo.

## Por que existe

O protocolo DAR precisa de: (a) coleta em campo confiável mesmo sem internet, (b) cálculo automático e sem erro do conceito final (fórmula do manual, seção 4.3.2), (c) um relatório PDF que sirva de peça no processo administrativo do INEA. Antes deste app, isso era feito em planilha/papel, com risco de erro de cálculo e de perda de dado em campo.

## Conceitos do domínio (glossário)

- **Processo** — o processo administrativo de reposição florestal em si (1 processo = 1 número administrativo = 1 polígono de plantio).
- **Ponto de observação** — uma amostragem pontual georreferenciada dentro do polígono, com raio de observação de até 20m. **Não confundir com "parcela"** (terminologia do método DER, que usa parcelas de 25×4m com trena — o DAR não demarca fisicamente nada).
- **Os 5 parâmetros diretos**, avaliados visualmente em cada ponto, cada um com nota `0` (Crítica) / `0,65` (Mínima) / `1,0` (Adequada): necessidade de replantio, cobertura de copa, distribuição das espécies, altura estimada, competição (gramíneas/invasoras).
- **Atrativos de fauna** e **Riqueza aparente** — os outros 2 parâmetros, mas **cumulativos do processo inteiro**, não por ponto: conta-se a novidade (espécie ainda não vista em nenhum ponto anterior) a cada ponto, e a classificação final (mesmas 3 faixas) vale igualmente para todos os pontos do processo.
- **Conceito final** = média dos somatórios de todos os pontos × (10 / 7). Faixas: `0,0–4,9` Crítico (refazer implantação) · `5,0–7,9` Mínimo (ações corretivas) · `8,0–10,0` Adequado (apto para quitação).
- **Regra de reprovação automática**: nenhum parâmetro pode ter nota crítica (0) em nenhum ponto — se acontecer, o processo não é apto, mesmo com conceito ≥ 8,0.

## Funcionalidades

### Autenticação
E-mail + senha via Supabase Auth (trocado de magic link por senha, ainda no início do projeto — envio de e-mail tinha limite de taxa baixo demais para uso real). Cadastro exige aprovação manual de admin antes de liberar o app (tela de espera).

### Cadastro de processo
Número administrativo, formação vegetacional, área (hectares) → número de pontos calculado automaticamente (`IA = (área − 1) + 5`, teto 50), dados do requerente (opcionais, Anexo II), KML opcional (polígono + pontos planejados), toggle "tornar público" (WebGIS).

### Lançamento de ponto de observação
Os 5 parâmetros diretos (Crítica/Mínima/Adequada), busca de espécie com combobox (atrativos de fauna e riqueza aparente — a mesma espécie em atrativos entra automaticamente em riqueza, nunca o contrário), observações livres, posição geográfica (GPS automático, digitação manual, ou escolha de um ponto planejado importado do KML).

**Revisão antes de enviar**: pontos de observação **não sincronizam automaticamente** com o servidor — ficam retidos no aparelho até o técnico revisar e confirmar manualmente na aba Relatório (decisão de produto: hoje não existe forma de corrigir um ponto que já foi pro banco, então reter localmente até confirmação evita erro irreversível). Processo e KML importado continuam sincronizando sozinhos.

### Mapa
Leaflet, offline-first (tiles cacheados pelo service worker após a primeira visita com sinal). Mostra pontos avaliados, pontos planejados (do KML) e o polígono da área de plantio. Camadas de referência oficiais do INEA/GERGET (APPs, hidrografia, unidades de conservação, uso e cobertura do solo) via Esri-Leaflet, consumidas ao vivo do `geoportal.inea.rj.gov.br` — nenhum dado duplicado.

### Relatório
Conceito final, alertas do protocolo, espécies consolidadas, mosaico de fotos (casamento automático por EXIF data/hora com atribuição manual como reserva), exportação em **PDF** (jsPDF — inclui mapa esquemático desenhado em canvas, tabelas de parâmetros, legenda) e **Excel** (xlsx — dado bruto).

### WebGIS público (em construção, fora do app de campo)
Site estático separado, mesmo Supabase, mostrando só processos marcados `publico = true`, somente leitura, sem login. Ver `docs/database/DATABASE.md` para o desenho de RLS já implementado (Fase 0/1 da trilha, PostGIS habilitado). Fases seguintes (MVP do mapa em si) ainda não iniciadas — ver histórico de decisões nesta pasta se precisar retomar.

## Não-metas explícitas

- Não substitui o GIS de planejamento espacial do técnico.
- Não tem tela de administração — aprovações e correções administrativas são feitas direto no SQL Editor do Supabase, de propósito (baixo volume de usuários não justifica construir isso ainda).
- Não guarda foto no servidor — fica só no PDF exportado.
- Não valida origem (nativa/exótica) de espécie — o relatório fala em "espécies vegetais", não "nativas", justamente por não ter como verificar isso (ver decisão registrada no plano de acessibilidade, seção 12.2).

## Decisões de produto registradas (não óbvias no código)

- **Offline-first de verdade**: fila local em IndexedDB antes de qualquer coisa; login uma vez com internet libera uso completamente offline depois.
- **Um processo, um técnico**: RLS por dono, não compartilhado — decisão consciente, revisitar só se surgir necessidade real de múltiplos técnicos no mesmo processo.
- **44px de alvo de toque** em toda a interface é decisão de produto pra uso em campo (sol, luva, mão molhada) — não é exigência da norma de acessibilidade seguida (WCAG 2.2 AA pede só 24px).
- **Texto livre no autocomplete de espécie**: decisão ainda em aberto sobre se isso deve continuar permitindo duplicata de contagem perto das faixas de corte do cumulativo (ver plano de acessibilidade, decisão 12.1, ainda não resolvida).
