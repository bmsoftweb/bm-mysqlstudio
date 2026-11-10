-- MySQL Studio web: tabelas do próprio app (login e conexões salvas).
-- Rodar no banco indicado em MYSQL_DATABASE. Reversão: 001_criar_tabelas_reverter.sql

CREATE TABLE usuarios (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  nome VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL,
  -- em branco = primeiro acesso: a senha digitada no login passa a ser a do usuário (bcrypt)
  senha_hash VARCHAR(100) NOT NULL DEFAULT '',
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_usuarios_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Conexões salvas de cada usuário (o conexoes.ini do app desktop).
CREATE TABLE conexoes (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  usuario_id INT UNSIGNED NOT NULL,
  nome VARCHAR(100) NOT NULL,
  servidor VARCHAR(255) NOT NULL,
  porta SMALLINT UNSIGNED NOT NULL DEFAULT 3306,
  usuario VARCHAR(100) NOT NULL,
  -- só com salvar_senha = 1, cifrada com AES-256-GCM (chave derivada do SESSION_SECRET)
  senha TEXT NULL,
  salvar_senha TINYINT(1) NOT NULL DEFAULT 0,
  banco VARCHAR(64) NOT NULL DEFAULT '',
  -- 0 = nenhum, 1 = desenvolvimento, 2 = homologação, 3 = produção
  ambiente TINYINT UNSIGNED NOT NULL DEFAULT 0,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_conexoes_usuario_nome (usuario_id, nome),
  CONSTRAINT fk_conexoes_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Primeiro usuário (a senha é definida no primeiro login):
-- INSERT INTO usuarios (nome, email) VALUES ('Seu nome', 'voce@suaempresa.com.br');
