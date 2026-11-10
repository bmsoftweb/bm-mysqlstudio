import 'dotenv/config';
import mysql from 'mysql2/promise';

// Banco do próprio app (usuarios, conexoes). Credenciais só pelo ambiente (.env): nunca no código.
for (const nome of ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD']) {
  if (!process.env[nome]) throw new Error(`${nome} não definido no .env.`);
}

export const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT) || 3306,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || 'mysqlstudio',
  waitForConnections: true,
  connectionLimit: 5,
  connectTimeout: 20000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  dateStrings: true,
});

// O sistema opera no horário de Brasília: NOW() e os DEFAULT CURRENT_TIMESTAMP saem em UTC-3,
// qualquer que seja o fuso do servidor MySQL.
pool.pool.on('connection', (conn) => {
  conn.query("SET time_zone = '-03:00'");
});
