# Mono Design System

Toda a interface usa **só** o que está em `src/renderer/design-system.css`. O `styles.css` cuida do layout das telas e compõe esses componentes. Ele não declara cores, raios ou tamanhos de fonte soltos.

## Regras

1. **Cor sempre por token.** Nada de `#hex` em tela nova. Use `--text`, `--muted`, `--surface`, `--border`, as semânticas (`--success`, `--warning`, `--danger`, `--info`) e as de método (`--m-GET`…).
2. **Espaço na escala de 4px:** `--sp-1` (4) · `--sp-2` (8) · `--sp-3` (12) · `--sp-4` (16) · `--sp-5` (20) · `--sp-6` (24) · `--sp-8` (32).
3. **Raios:** `--r-xs` (4) chips e etiquetas · `--r-sm` (6) botões pequenos · `--r-md` (8) campos e botões · `--r-lg` (10) cartões · `--r-xl` (14) modais e menus.
4. **Tipografia:** `--font-sans` para interface e `--font-mono` para URLs, código, métodos e valores. Tamanhos de `--fs-2xs` (10) a `--fs-xl` (16).
5. **Todo tema define o conjunto completo de tokens** (`dark`, `light`, `blue`). Tema novo é só um bloco `[data-theme="x"]`.
6. **Nada de `<select>` nativo:** use `customSelect(select, { variant })`, com as variantes `field`, `ghost` e `compact`.

## Tokens de cor

| Token | Uso |
|---|---|
| `--bg` | fundo da janela |
| `--surface` / `--surface-2` | campos e áreas de edição / realces e seleção |
| `--hover` | fundo ao passar o mouse |
| `--border` / `--border-strong` | divisórias / bordas de controles |
| `--text` / `--text-2` / `--muted` | texto principal / secundário / apagado |
| `--invert-bg` / `--invert-text` | ação primária (botão Enviar, chip ativo, indicador de aba) |
| `--success` `--warning` `--danger` `--info` (+ `-bg`) | status 2xx/4xx/5xx, selos, diffs, produção |
| `--m-GET` … `--m-OPTIONS`, `--m-CUSTOM` | cores dos métodos (padrão Postman) |
| `--syn-key` `--syn-string` `--syn-number` `--syn-literal` `--syn-punc` `--syn-tag` `--syn-attr` `--syn-comment` | realce de código |

## Componentes

| Componente | Classes |
|---|---|
| Botões | `.btn-primary` · `.btn-ghost` (`.sm`, `.wide`) · `.btn-text` · `.btn-danger-solid` · `.icon-btn` |
| Segmentado | `.seg` (`.sm`) > `.seg-btn` (`.active`) |
| Chips | `.radio-row` > `.chip` (`.active`) |
| Campos | `.field` > `label` + `.input` · `.field-row` (2 colunas) · `.hint` · `.form-err` · `textarea.code` |
| Selects | `customSelect()` → `.cs-btn` `.cs-field`/`.cs-ghost`/`.cs-compact` + menu `.cs-menu` |
| Listas suspensas | `.method-menu` > `.mm-group` · `.mm-item` (`.selected`, `.kb`) > `.mm-icon` `.mm-desc` `.mm-check` · `.mm-sep` |
| Abas | `.subtabs` > `button.active` (+ `.count`) |
| Método / status | `.m.GET` … · `.status.s2` / `.s4` / `.err` |
| Selos | `.flag` (`.ok`, `.warn`, `.bad`) · `.kbadge.k-added` / `-removed` / `-changed` / `-type` / `-length` · `.tag` (`.danger`) · `.badge` |
| Tabelas | `.kv` (chave/valor editável) · `.data-table` (somente leitura) · `.mono-cell` |
| Menu de contexto | `showMenu()` → `.menu` |
| Modal | `openModal()` → `.modal` (`.wide`) > `h2` · `.sub` · `.modal-actions` |
| Feedback | `toast()` · `.empty` · `.empty-state` (`.es-icon`) · `.spinner` |
| Código | `codeView(texto, 'json' \| 'markup' \| 'plain')` → `pre.code-view` com números de linha e recuo preservado na quebra |
