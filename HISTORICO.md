# Histórico de versões

Mais recente primeiro. PATCH a cada envio ao GitHub; MAJOR/MINOR só quando pedido.

## 0.0.2 — 2026-11-10

- Primeira versão web do MySQL Studio, convertida do desktop em Delphi para o stack do crmWeb (Vite + React + Express + mysql2), para rodar na Vercel com login.
- Login com e-mail e senha (a senha é definida no primeiro acesso) e conexões salvas por usuário, com a senha do MySQL cifrada ou só na memória do navegador.
- Explorador de banco de dados, aba de consulta com editor SQL e autocompletar, grade de dados editável, editores de tabela, view, procedure e function.
- Telas do servidor (sessões, variáveis, status, usuários e privilégios), comparação e sincronização de esquemas e de dados, backup, restauração e importação/exportação de CSV.
- Tabelas do app em `sql/001_criar_tabelas.sql` (reversão em `sql/001_criar_tabelas_reverter.sql`).
