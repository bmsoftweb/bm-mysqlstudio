# MySQL Studio web

Conversão do MySQL Studio desktop (`..\delphi\*.pas`, Delphi + FireDAC + cxGrid, inspirado no dbForge) para web.
Regras da stack: @../../_claude/web.md (modelo 1: Vite + React + Express, igual ao crmWeb em `D:\projetos\bm-crm\code`).

## Como funciona

Roda na Vercel, com login. Por causa do limite de tempo e de tamanho (4,5 MB) de cada requisição:

- **Servidor fino** (`server\`): login (`app.ts`), conexões salvas por usuário (`conexoes.ts`, senha cifrada) e
  `POST /api/sql` (`alvo.ts`), que executa SQL no MySQL da conexão escolhida. Nada de regra de tela no servidor.
- **A lógica roda no navegador** (`src\lib\`), como as units Delphi faziam com `Rows`/`RunScript`:
  - `api.ts`: `executar` (devolve resultados + erro), `consulta`, `linhas` (o `Rows` do Delphi: tudo como texto),
    `escalar`, `rodar`. Parâmetros com `?` (não `:db`/`:t`). `Alvo = { conexao, banco?, sessao? }` é o "Params" do Delphi.
  - `db.ts`: `q()` (crases), `lit()`, `getCreate`, tipos (`tipoTexto`, `ehBinario`...), CSV, arquivos (`criarArquivo`,
    `escolherArquivo`, `baixar`), `lerGrande`.
- Resultado grande volta **cortado** (`Conjunto.truncado`): quem precisa de tudo (backup, comparação, exportação)
  busca em pedaços pela chave. Valor sozinho acima de 1 MB vem como `{ bin: null, bytes }` (use `lerGrande`).
- Conexão por aba: `Alvo.sessao` mantém a conexão no servidor entre execuções (USE, variáveis, transação). Pode
  se perder se a Vercel trocar de instância: a resposta traz `sessaoNova`.
- As tabelas do próprio app (`usuarios`, `conexoes`) são criadas à mão pelo script em `sql\`. Nunca criar tabela automaticamente.

## Convenções

- Interface e mensagens em pt-BR. Identificadores novos em português; lógica portada do Pascal pode manter o nome
  original em camelCase (`compareSchemas`, `formatSql`) para dar para conferir com a unit.
- Comentário `// ponytail:` em toda simplificação com teto conhecido (o Pascal também usa).
- UI: Tailwind 4 com as cores semânticas de `src\index.css` (`bg-fundo`, `bg-fundo2`, `text-texto`, `text-texto2`,
  `border-borda`, `bg-selecao`, `text-realce`), que já trocam no tema escuro. Ícones `lucide-react`.
- Componentes prontos em `src\components\`: ver o cabeçalho de `ui.tsx` (Botao, Dialogo, Abas, LinhaCampo...),
  `Grade.tsx` (grade de dados e de edição), `EditorSql.tsx`, `Toggle.tsx`. Avisos e diálogos imperativos em
  `src\lib\avisos.ts` (`avisar.erro/alerta/sucesso`, `confirmar`, `pedirTexto`): nunca `window.alert/confirm`.
- Sim/não é `Toggle`; excluir sempre confirma; erro de ação é aviso flutuante (`avisar.erro`), não faixa na tela.
- Validar com `npm run lint` (tsc), `npm test` e `npm run build`.
