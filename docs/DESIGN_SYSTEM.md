# Design system — Monitoramento de PRF

CSS puro, tudo inline em `<style>` no `public/index.html` — sem framework, sem build step. Este documento existe pra qualquer mudança nova reaproveitar o que já existe em vez de reinventar um padrão parecido com nome diferente.

## Princípio geral

Interface pensada pra **uso em campo**: sol forte, luva, mão molhada, tela pequena, uma mão só. Isso motiva várias escolhas que pareceriam exagero num app de escritório — alvo de toque de 44px, contraste alto, texto grande por padrão, zero dependência de mouse/hover.

## Cor

Tokens em `:root`, todos com nome semântico (nunca usar o hex direto fora da declaração):

| Token | Valor | Uso |
|---|---|---|
| `--verde-escuro` | `#1b4332` | header, texto de destaque, estado ativo (nav, radios "Adequada") |
| `--verde` | `#2d6a4f` | botão primário, links, eyebrow, foco |
| `--verde-claro` | `#40916c` | decoração pura (borda de chip, marcador do mapa) — **nunca em texto**, reprova contraste (3,83:1) |
| `--dourado` | `#d4ac0d` | título no header (contraste com fundo verde-escuro), destaque de foco em botões primários |
| `--minimo` | `#b8860b` | texto/borda sobre fundo claro (passa contraste) |
| `--minimo-texto` | `#8a6400` | **só** quando o fundo É esse tom de dourado e o texto é branco (badge, radio "Mínima") — versão mais escura, `--minimo` sozinho reprova nesse sentido inverso (3,25:1) |
| `--critico` | `#b23a2c` | erro, estado "Crítica" |
| `--adequado` | `#2d6a4f` | mesmo que `--verde`, nome semântico separado pro contexto de classificação |
| `--bg` | `#f4f7f5` | fundo da página |
| `--card` | `#ffffff` | fundo de cartão |
| `--borda` | `#dde5e0` | toda borda de 1px |
| `--texto` | `#1c2620` | texto principal |
| `--texto-suave` | `#5b6b62` | texto secundário/hint |

**Regra**: uma cor só ganha um novo token quando o contexto muda o requisito de contraste (caso `--minimo` / `--minimo-texto`) — nunca crie um token novo só por organização, sem motivo de contraste ou semântica por trás.

## Tipografia

Sem webfont — pilha do sistema (`-apple-system, Segoe UI, Roboto, Arial, sans-serif`), decisão de performance/offline (nada pra baixar, funciona no primeiro load sem sinal).

Escala em `rem`, quase sem exceção — é o que permite o seletor de tamanho de texto (Início → Acessibilidade) escalar o app inteiro só mudando `html[data-fonte] { font-size: 118% | 136% }`, sem precisar de regra própria em cada elemento:

| Papel | Tamanho |
|---|---|
| Título de card (`h2`) | `.98rem` |
| Corpo padrão | `.8–.9rem` |
| Texto secundário/hint | `.72–.78rem` |
| Eyebrow (rótulo de categoria) | `.64rem`, uppercase, `letter-spacing:.06em`, `font-weight:800` |

## Espaço e alvo de toque

- `--toque: 44px` — `min-height` de **todo** controle interativo (botão, link de nav, input, item de lista de autocomplete). Decisão de produto (WCAG 2.2 AA exige só 24px, SC 2.5.8) — documentar isso no CSS sempre que o token for usado num contexto novo, pra não virar "exigência de acessibilidade" incorretamente.
- Layout por `flex`/`grid` com `gap`, não margem por elemento.
- Grids responsivos usam `repeat(auto-fit, minmax(Xrem, 1fr))` — nunca coluna fixa (`1fr 1fr 1fr`) — é o que permite reflow em fonte grande (136%) e larguras pequenas (320px) sem sobreposição. Ver `.segmented`, `.kpi-grid`, `.checklist-grid`.

## Componentes

### `.card`
Bloco branco, borda 1px, `border-radius:14px`, sombra suave. Unidade básica de organização de conteúdo — quase toda tela é uma pilha de `.card`.

### `.btn`
Botão primário (fundo `--verde`, texto branco) e `.btn.secundario` (fundo branco, borda/texto `--verde`). `.btn.pequeno` reduz padding, mantém `--toque`.

### Segmented (radio nativo com visual de botão)
**Não é mais `<button>` com `classList`** — desde a Fase 6 do plano de acessibilidade, é `<input type="radio" class="sr-only">` + `<label>` adjacente, com o visual todo carregado por `input:checked + label`. Usar exatamente este padrão pra qualquer escolha exclusiva nova de 3+ opções (nunca `aria-pressed` num grupo exclusivo — isso é pra toggles independentes).

```html
<fieldset class="dar-param" data-param="x">
  <legend class="nome">Nome do parâmetro</legend>
  <div class="segmented">
    <input type="radio" id="x-critica" name="x" data-nivel="critica" data-valor="0" class="sr-only" required>
    <label for="x-critica">Crítica (0)</label>
    <!-- ...minima, adequada -->
  </div>
</fieldset>
```

Estado nunca depende só de cor: `input:checked + label::after { content:" ✓" }`.

### Chips (`.chip`)
Espécie/tag removível. Botão de remover é uma caixa real de 44×44 (não área fantasma por pseudo-elemento) com o "×" pequeno centralizado dentro — ver `.chip button` no CSS pra o padrão exato de "alvo grande, desenho pequeno".

### Mensagens (`.msg.ok` / `.msg.erro`)
Container de feedback transitório (`mostrarMsg()` em `app.js`, some sozinho em 4s). **Sempre** com `role="status"` (ou `role="alert"` só pra erro de autenticação) no elemento container no HTML — nunca adicionar isso via JS depois.

### Autocomplete/combobox
Padrão ARIA completo (`role="combobox"` no input, `role="listbox"` na lista, `role="option"` + `aria-selected` em cada item, `aria-activedescendant` sincronizado via seta). Ver `createSpeciesPicker()` em `app.js` — é a única implementação, reaproveitada duas vezes (fauna/vegetal). Qualquer busca-com-sugestão nova deve reaproveitar essa função, não recriar do zero.

## Acessibilidade — convenções obrigatórias em qualquer tela nova

Resultado da varredura completa feita no "plano de acessibilidade" (11 fases, todas implementadas — ver commits do histórico do git para o raciocínio de cada uma):

- Todo `<label>` com `for` explícito. Caso de um label pra dois inputs (ex.: lat/lng) vira `<fieldset><legend>` com um `<label>` por input, nunca um label solto.
- `escaparTexto()`/`escaparAtributo()` (em `app.js`) em **qualquer** interpolação de dado do usuário dentro de `innerHTML` — processos e espécies sincronizam com o servidor, então isso é XSS armazenado de verdade, não só local.
- Foco visível global (`:focus-visible`), nunca removido sem substituto.
- Navegação principal é `<a href="#view-x">` real (hash + `hashchange`), nunca `pushState`/`popstate` — um só ponto de navegação programática (`navegarPara()` em `app.js`).
- `.sr-only` pra esconder visualmente sem tirar do foco/Tab — nunca `display:none` num controle que precisa continuar focável.
- `prefers-reduced-motion` e `prefers-contrast` respeitados globalmente.
- Português em toda a interface — inclusive nome de botão (não teve exceção nem pra rótulo técnico).
- Separador decimal `,` em toda **exibição** de número na tela/PDF (`fmtDecimal()` em `app.js`) — nunca no Excel, que grava número real e formata sozinho.
