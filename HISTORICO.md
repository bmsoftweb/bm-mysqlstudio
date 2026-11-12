# Histórico de versões

Mais recente primeiro. PATCH a cada envio ao GitHub; MAJOR/MINOR só quando pedido.

## 0.0.5 — 2026-11-12

- Aba de consulta: script com `DELIMITER` (triggers, procedures) roda como no cliente `mysql`. O texto ia inteiro para o servidor, que não conhece esse comando e dava erro 1064; agora, com uma linha `DELIMITER`, vai quebrado em instruções.

## 0.0.4 — 2026-11-11

- Editor de tabela: renomear uma coluna e mudar o tipo dela sai num único `ALTER TABLE` (`CHANGE COLUMN` com a definição inteira). Em dois comandos, a falha do segundo deixava a coluna renomeada no banco e o Aplicar seguinte dava "Unknown column".
- Editor de tabela: Default digitado sem aspas em coluna de texto, enum ou set (e data começando por dígito) vai entre aspas: `user` vira `'user'`.

## 0.0.3 — 2026-11-10

- App instalável (PWA), no modelo do crmWeb: manifesto, ícones (192, 512, adaptável e iPhone) e service worker sem cache; abre em janela própria.

## 0.0.2 — 2026-11-10

- Primeira versão web do MySQL Studio, convertida do desktop em Delphi para o stack do crmWeb (Vite + React + Express + mysql2), para rodar na Vercel com login.
- Login com e-mail e senha (a senha é definida no primeiro acesso) e conexões salvas por usuário, com a senha do MySQL cifrada ou só na memória do navegador.
- Explorador de banco de dados, aba de consulta com editor SQL e autocompletar, grade de dados editável, editores de tabela, view, procedure e function.
- Telas do servidor (sessões, variáveis, status, usuários e privilégios), comparação e sincronização de esquemas e de dados, backup, restauração e importação/exportação de CSV.
- Tabelas do app em `sql/001_criar_tabelas.sql` (reversão em `sql/001_criar_tabelas_reverter.sql`).
