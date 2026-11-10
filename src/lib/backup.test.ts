// Checagem do backup, da execução de script e do CSV (sem banco: um fetch de mentira responde /api/sql).
// Rodar: npx tsx --test src/lib/backup.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Alvo, Campo, Valor } from './api';
import { TIPO } from './db';
import { splitScript } from './sqlText';
import { dumpDb, exportTableCsv, importCsv, runScript } from './backup';

const ALVO: Alvo = { conexao: 7, banco: 'loja' };

interface Corpo {
  sql: string | string[];
  params?: unknown[];
  banco?: string;
  sessao?: string;
  exigeSessao?: boolean;
}
type Resposta = { status?: number; corpo: unknown };

/** Troca o fetch: cada POST /api/sql vai para responder; devolve os corpos recebidos e as sessões fechadas. */
function servidorDeMentira(responder: (b: Corpo, n: number) => Resposta) {
  const corpos: Corpo[] = [];
  const fechadas: string[] = [];
  globalThis.fetch = (async (rota: string, init: { method: string; body?: string }) => {
    if (init.method === 'DELETE') {
      fechadas.push(decodeURIComponent(rota.replace('/api/sessoes/', '')));
      return new Response('{"ok":true}');
    }
    const b = JSON.parse(init.body ?? '{}') as Corpo;
    corpos.push(b);
    const r = responder(b, corpos.length);
    return new Response(JSON.stringify(r.corpo), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { corpos, fechadas };
}

const feito = (b: Corpo, extra: object = {}): Resposta => ({
  corpo: { resultados: [], feitos: Array.isArray(b.sql) ? b.sql.length : 1, cortado: false, sessaoNova: false, ms: 0, ...extra },
});

// ==========================================================
// runScript
// ==========================================================
test('runScript: lotes de 300 instruções na mesma sessão, exigeSessao do 2º em diante', async () => {
  const s = servidorDeMentira((b) => feito(b));
  const script = Array.from({ length: 650 }, (_, i) => `SELECT ${i};`).join('\n');
  const progresso: number[][] = [];
  await runScript(ALVO, script, { progresso: (lidos, total) => progresso.push([lidos, total]) });
  assert.deepEqual(s.corpos.map((b) => b.sql.length), [300, 300, 50]);
  assert.deepEqual(s.corpos.map((b) => Boolean(b.exigeSessao)), [false, true, true]);
  assert.deepEqual((s.corpos[1].sql as string[]).slice(0, 2), ['SELECT 300', 'SELECT 301'], 'na ordem, sem o delimitador');
  const sessao = s.corpos[0].sessao;
  assert.ok(sessao, 'sessão própria');
  assert.ok(s.corpos.every((b) => b.sessao === sessao && b.banco === 'loja'), 'mesma sessão e banco em todos os lotes');
  assert.deepEqual(s.fechadas, [sessao], 'fecha a sessão no fim');
  assert.deepEqual(progresso[progresso.length - 1], [script.length, script.length]);
});

test('runScript: lote fecha em ~1 MB; DELIMITER; script vazio não manda nada', async () => {
  let s = servidorDeMentira((b) => feito(b));
  const grande = (i: number) => `SELECT '${String(i).repeat(400_000)}'`;
  await runScript(ALVO, [0, 1, 2, 3, 4].map((i) => grande(i) + ';').join('\n'));
  assert.deepEqual(s.corpos.map((b) => b.sql.length), [2, 2, 1]);
  assert.equal((s.corpos[2].sql as string[])[0], grande(4));

  s = servidorDeMentira((b) => feito(b));
  await runScript(ALVO, 'DELIMITER $$\nCREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND$$\nDELIMITER ;\nSELECT 2;');
  assert.deepEqual(s.corpos.map((b) => b.sql), [['CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND', 'SELECT 2']]);

  s = servidorDeMentira((b) => feito(b));
  await runScript(ALVO, '-- só comentário\n');
  assert.equal(s.corpos.length, 0);
});

test('runScript: para no erro do MySQL, com a instrução que falhou', async () => {
  // 2º lote: 3 instruções rodam e a 4ª (a 304ª do script) falha
  const s = servidorDeMentira((b, n) => (n === 2 ? feito(b, { feitos: 3, erro: 'Erro 1146: Table x.y doesn\'t exist' }) : feito(b)));
  const script = Array.from({ length: 650 }, (_, i) => `UPDATE t SET a = ${i};`).join('\n');
  await assert.rejects(runScript(ALVO, script), (e: Error) => {
    assert.equal(e.message, "Erro 1146: Table x.y doesn't exist\nInstrução 304 do script: UPDATE t SET a = 303");
    return true;
  });
  assert.equal(s.corpos.length, 2, 'não manda o resto');
  assert.equal(s.fechadas.length, 1, 'fecha a sessão (a transação aberta é desfeita)');
});

test('runScript: SESSAO_PERDIDA no meio', async () => {
  const s = servidorDeMentira((b, n) =>
    n === 2 ? { status: 409, corpo: { erro: 'A conexão do script foi perdida no meio da execução.', codigo: 'SESSAO_PERDIDA' } } : feito(b),
  );
  const script = Array.from({ length: 650 }, (_, i) => `SELECT ${i};`).join('\n');
  await assert.rejects(runScript(ALVO, script), /perdida depois de 300 instrução\(ões\): o servidor trocou de instância.*fora de transação continua feito/s);
  assert.equal(s.corpos.length, 2);
  assert.equal(s.fechadas.length, 1);
});

test('runScript: consulta cortada no meio do lote manda o resto de novo', async () => {
  const s = servidorDeMentira((b, n) => (n === 1 ? feito(b, { feitos: 2, cortado: true }) : feito(b)));
  await runScript(ALVO, 'SET @a = 1; SELECT * FROM grande; SET @b = 2; SET @c = 3;');
  assert.deepEqual(s.corpos.map((b) => b.sql), [
    ['SET @a = 1', 'SELECT * FROM grande', 'SET @b = 2', 'SET @c = 3'],
    ['SET @b = 2', 'SET @c = 3'],
  ]);
  assert.equal(s.corpos[1].exigeSessao, true);
});

test('runScript: instrução acima de 3,5 MB', async () => {
  const s = servidorDeMentira((b) => feito(b));
  await assert.rejects(runScript(ALVO, `SELECT 1;\nSELECT '${'x'.repeat(3_600_000)}';\nSELECT 3;`), /A instrução 2 do script tem 3,6 MB e não cabe numa requisição.*as 1 anteriores já rodaram/s);
  assert.deepEqual(s.corpos.map((b) => b.sql), [['SELECT 1']], 'as anteriores rodam; a grande e as seguintes não');
});

test('runScript: arquivo (Blob) com BOM e caractere acentuado na fronteira da fatia de 1 MB', async () => {
  const s = servidorDeMentira((b) => feito(b));
  // o "é" (2 bytes em UTF-8) fica com um byte em cada fatia
  const inicio = "\uFEFFSELECT '" + 'a'.repeat(1024 * 1024 - 1 - 3 - 8);
  assert.equal(new TextEncoder().encode(inicio).length, 1024 * 1024 - 1);
  const arquivo = new Blob([inicio + "é';\nSELECT 'ção';\n"]);
  const progresso: number[][] = [];
  await runScript(ALVO, arquivo, { progresso: (lidos, total) => progresso.push([lidos, total]) });
  const sqls = s.corpos.flatMap((b) => b.sql);
  assert.equal(sqls.length, 2);
  assert.equal(sqls[0], inicio.slice(1) + "é'", 'sem BOM e sem caractere quebrado');
  assert.equal(sqls[1], "SELECT 'ção'");
  assert.deepEqual(progresso, [
    [0, arquivo.size],
    [1024 * 1024, arquivo.size],
    [arquivo.size, arquivo.size],
  ]);
});

test('runScript: cancelado antes de mandar', async () => {
  const s = servidorDeMentira((b) => feito(b));
  const c = new AbortController();
  c.abort();
  await assert.rejects(runScript(ALVO, 'SELECT 1;', { sinal: c.signal }), { name: 'AbortError' });
  assert.equal(s.corpos.length, 0);
});

// ==========================================================
// Banco de mentira (dumpDb e exportTableCsv)
// ==========================================================
const campo = (nome: string, tipo: number = TIPO.VAR_STRING, charset = 255): Campo => ({ nome, coluna: nome, tabela: '', banco: '', tipo, tamanho: 0, decimais: 0, flags: 0, charset });
const CAMPOS_CLIENTE = [campo('id', TIPO.LONG, 63), campo('nome'), campo('valor', TIPO.NEWDECIMAL, 63), campo('criado', TIPO.DATETIME, 63), campo('obs', TIPO.BLOB), campo('foto', TIPO.BLOB, 63)];
const CLIENTES: Valor[][] = [
  [1, 'Ana', '10.50', '2024-01-31 10:20:30', null, { bin: 'AQID' }],
  [2, "O'Neil\n", '-3.00', null, 'x', null],
  [3, 'Zé', '0.00', null, { bin: null, bytes: 1_500_000 }, null], // obs grande demais para vir na consulta
];
const OBS_GRANDE = 'texto grande ção';
const DDL: Record<string, string> = {
  'TABLE cliente': 'CREATE TABLE `cliente` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB AUTO_INCREMENT=4',
  'TABLE sem_pk': 'CREATE TABLE `sem_pk` (\n  `c` varchar(10)\n) ENGINE=InnoDB',
  'VIEW v': 'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v` AS select `loja`.`cliente`.`id` AS `id` from `loja`.`cliente`',
  'PROCEDURE p': 'CREATE DEFINER=`root`@`%` PROCEDURE `p`()\r\nBEGIN\r\n  SELECT 1;\r\nEND',
  'TRIGGER tg': 'CREATE DEFINER=`root`@`%` TRIGGER `tg` BEFORE INSERT ON `cliente` FOR EACH ROW SET NEW.nome = TRIM(NEW.nome)',
};
const COLUNA_DDL: Record<string, string> = { TABLE: 'Create Table', VIEW: 'Create View', PROCEDURE: 'Create Procedure', TRIGGER: 'SQL Original Statement' };

/** maxLinhas: quantas linhas cabem numa resposta (o resto fica para a próxima: truncado). */
function bancoDeMentira(maxLinhas: number, semPermissao = '') {
  const sqls: string[] = [];
  const texto = (linhas: string[][]) => ({ campos: (linhas[0] ?? ['']).map((_, i) => campo('c' + i)), linhas, truncado: false });
  const responder = (sql: string, params: unknown[] = []) => {
    if (sql.includes('information_schema.tables')) return texto([['cliente'], ['sem_pk']]);
    if (sql.includes('key_column_usage')) return texto(params[1] === 'cliente' ? [['id']] : []);
    if (sql.includes('information_schema.views')) return texto([['v']]);
    if (sql.includes('information_schema.routines')) {
      assert.deepEqual(params, ['loja', 'loja']);
      return texto([
        ['PROCEDURE', 'p'],
        ['TRIGGER', 'tg'],
      ]);
    }
    let m = /^SHOW CREATE (\w+) `loja`\.`(\w+)`$/.exec(sql);
    if (m) {
      const chave = `${m[1]} ${m[2]}`;
      return { campos: [campo('Nome'), campo(COLUNA_DDL[m[1]])], linhas: [[m[2], chave === semPermissao ? null : DDL[chave]]], truncado: false };
    }
    if (sql === 'SELECT SUBSTRING(CAST(CONVERT(`obs` USING utf8mb4) AS BINARY), 1, 700000) FROM `loja`.`cliente` WHERE `id` = 3') {
      return { campos: [campo('x', TIPO.BLOB, 63)], linhas: [[{ bin: Buffer.from(OBS_GRANDE).toString('base64') }]], truncado: false };
    }
    m = /^SELECT \* FROM `loja`\.`(cliente|sem_pk)`(?: WHERE \(`id` > (\d+)\))?(?: ORDER BY `id`)? LIMIT 5000(?: OFFSET (\d+))?$/.exec(sql);
    assert.ok(m, 'SQL inesperado: ' + sql);
    const todas = m[1] === 'cliente' ? CLIENTES.filter((l) => Number(l[0]) > Number(m[2] ?? 0)) : [['a'], ['b'], ['c']].slice(Number(m[3] ?? 0));
    // cópia: o backup troca o valor grande dentro da linha recebida
    return { campos: m[1] === 'cliente' ? CAMPOS_CLIENTE : [campo('c')], linhas: todas.slice(0, maxLinhas).map((l) => [...l]), truncado: todas.length > maxLinhas };
  };
  servidorDeMentira((b) => {
    assert.equal(typeof b.sql, 'string');
    sqls.push(b.sql as string);
    return { corpo: { resultados: [responder(b.sql as string, b.params)], feitos: 1, cortado: false, sessaoNova: false, ms: 0 } };
  });
  return sqls;
}

const novaSaida = () => ({
  texto: '',
  escrever(t: string) {
    this.texto += t;
  },
});

const DUMP_CABECALHO = 'SET NAMES utf8mb4;\r\nSET FOREIGN_KEY_CHECKS = 0;\r\n\r\n';
const DUMP_ESTRUTURA_CLIENTE = 'DROP TABLE IF EXISTS `cliente`;\r\n' + DDL['TABLE cliente'] + ';\r\n\r\n';
const DUMP_DADOS_CLIENTE =
  'INSERT INTO `cliente` (`id`, `nome`, `valor`, `criado`, `obs`, `foto`) VALUES\r\n' +
  "(1, 'Ana', 10.50, '2024-01-31 10:20:30', NULL, X'010203'),\r\n" +
  "(2, 'O\\'Neil\\n', -3.00, NULL, 'x', NULL),\r\n" +
  "(3, 'Zé', 0.00, NULL, 'texto grande ção', NULL);\r\n\r\n";
const DUMP_ESTRUTURA_SEM_PK = 'DROP TABLE IF EXISTS `sem_pk`;\r\n' + DDL['TABLE sem_pk'] + ';\r\n\r\n';
const DUMP_DADOS_SEM_PK = "INSERT INTO `sem_pk` (`c`) VALUES\r\n('a'),\r\n('b'),\r\n('c');\r\n\r\n";
const DUMP_OBJETOS =
  'DROP VIEW IF EXISTS `v`;\r\nCREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v` AS select `cliente`.`id` AS `id` from `cliente`;\r\n\r\n' +
  'DELIMITER $$\r\n' +
  'DROP PROCEDURE IF EXISTS `p`$$\r\nCREATE PROCEDURE `p`()\nBEGIN\n  SELECT 1;\nEND$$\r\n\r\n' +
  'DROP TRIGGER IF EXISTS `tg`$$\r\nCREATE TRIGGER `tg` BEFORE INSERT ON `cliente` FOR EACH ROW SET NEW.nome = TRIM(NEW.nome)$$\r\n\r\n' +
  'DELIMITER ;\r\n';
const DUMP_RODAPE = 'SET FOREIGN_KEY_CHECKS = 1;\r\n';

/** Tira a 1ª linha (tem a data e a hora) depois de conferir o formato. */
function semData(dump: string): string {
  const fim = dump.indexOf('\r\n');
  assert.match(dump.slice(0, fim), /^-- Backup de `loja` gerado pelo MySQL Studio em \d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d$/);
  return dump.slice(fim + 2);
}

test('dumpDb: o arquivo inteiro, com resposta cortada, tabela sem chave e valor grande', async () => {
  const sqls = bancoDeMentira(2);
  const s = novaSaida();
  const progresso: string[] = [];
  await dumpDb(ALVO, 'loja', s, { estrutura: true, dados: true, objetos: true }, { progresso: (t) => progresso.push(t) });
  assert.equal(
    semData(s.texto),
    DUMP_CABECALHO + DUMP_ESTRUTURA_CLIENTE + DUMP_DADOS_CLIENTE + DUMP_ESTRUTURA_SEM_PK + DUMP_DADOS_SEM_PK + DUMP_OBJETOS + DUMP_RODAPE,
  );
  assert.deepEqual(progresso, ['Tabela cliente...', 'Tabela sem_pk...', 'View v...', 'PROCEDURE p...', 'TRIGGER tg...']);
  assert.deepEqual(
    sqls.filter((x) => x.startsWith('SELECT *') || x.startsWith('SELECT SUBSTRING')),
    [
      'SELECT * FROM `loja`.`cliente` ORDER BY `id` LIMIT 5000',
      // veio cortada em 2 linhas: continua da última chave recebida
      'SELECT * FROM `loja`.`cliente` WHERE (`id` > 2) ORDER BY `id` LIMIT 5000',
      'SELECT SUBSTRING(CAST(CONVERT(`obs` USING utf8mb4) AS BINARY), 1, 700000) FROM `loja`.`cliente` WHERE `id` = 3',
      'SELECT * FROM `loja`.`sem_pk` LIMIT 5000 OFFSET 0',
      'SELECT * FROM `loja`.`sem_pk` LIMIT 5000 OFFSET 2',
    ],
  );
  // O que o runScript vai mandar na restauração
  assert.deepEqual(
    splitScript(s.texto).map((x) => x.split(/[\r\n(]/)[0].trim()),
    [
      'SET NAMES utf8mb4',
      'SET FOREIGN_KEY_CHECKS = 0',
      'DROP TABLE IF EXISTS `cliente`',
      'CREATE TABLE `cliente`',
      'INSERT INTO `cliente`',
      'DROP TABLE IF EXISTS `sem_pk`',
      'CREATE TABLE `sem_pk`',
      'INSERT INTO `sem_pk`',
      'DROP VIEW IF EXISTS `v`',
      'CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v` AS select `cliente`.`id` AS `id` from `cliente`',
      'DROP PROCEDURE IF EXISTS `p`',
      'CREATE PROCEDURE `p`',
      'DROP TRIGGER IF EXISTS `tg`',
      'CREATE TRIGGER `tg` BEFORE INSERT ON `cliente` FOR EACH ROW SET NEW.nome = TRIM',
      'SET FOREIGN_KEY_CHECKS = 1',
    ],
  );
});

test('dumpDb: opções, cancelamento e objeto sem permissão', async () => {
  bancoDeMentira(1000);
  let s = novaSaida();
  await dumpDb(ALVO, 'loja', s, { estrutura: true, dados: false, objetos: false });
  assert.equal(semData(s.texto), DUMP_CABECALHO + DUMP_ESTRUTURA_CLIENTE + DUMP_ESTRUTURA_SEM_PK + DUMP_RODAPE);
  s = novaSaida();
  await dumpDb(ALVO, 'loja', s, { estrutura: false, dados: true, objetos: false });
  assert.equal(semData(s.texto), DUMP_CABECALHO + DUMP_DADOS_CLIENTE + DUMP_DADOS_SEM_PK + DUMP_RODAPE);
  s = novaSaida();
  await dumpDb(ALVO, 'loja', s, { estrutura: false, dados: false, objetos: true });
  assert.equal(semData(s.texto), DUMP_CABECALHO + DUMP_OBJETOS + DUMP_RODAPE);

  const c = new AbortController();
  await assert.rejects(dumpDb(ALVO, 'loja', novaSaida(), { estrutura: true, dados: true, objetos: true }, { sinal: c.signal, progresso: () => c.abort() }), { name: 'AbortError' });

  bancoDeMentira(1000, 'PROCEDURE p');
  await assert.rejects(dumpDb(ALVO, 'loja', novaSaida(), { estrutura: false, dados: false, objetos: true }), /Sem permissão para ler a definição de PROCEDURE p/);
});

test('dumpDb: chave composta e coluna GEOMETRY', async () => {
  const sqls: string[] = [];
  const conjunto = (geometria: boolean, linhas: Valor[][], truncado = false) => ({
    campos: [campo('pedido_id', TIPO.LONG, 63), campo('seq', TIPO.LONG, 63), geometria ? campo('ponto', TIPO.GEOMETRY, 63) : campo('ponto', TIPO.VAR_STRING, 63)],
    linhas,
    truncado,
  });
  servidorDeMentira((b) => {
    const sql = b.sql as string;
    sqls.push(sql);
    const r = sql.includes('information_schema.tables')
      ? { campos: [campo('c0')], linhas: [['item']], truncado: false }
      : sql.includes('key_column_usage')
        ? { campos: [campo('c0')], linhas: [['pedido_id'], ['seq']], truncado: false }
        : sql.startsWith('SELECT *')
          ? conjunto(true, [[1, 1, '{"x":1,"y":2}']]) // como o servidor manda GEOMETRY: não serve de literal
          : sql.includes('WHERE')
            ? conjunto(false, [[2, 1, null]])
            : conjunto(false, [[1, 1, { bin: 'AAAA' }], [1, 2, { bin: 'AAAA' }]], true);
    return { corpo: { resultados: [r], feitos: 1, cortado: false, sessaoNova: false, ms: 0 } };
  });
  const s = novaSaida();
  await dumpDb(ALVO, 'loja', s, { estrutura: false, dados: true, objetos: false });
  const colunas = '`pedido_id`, `seq`, CAST(`ponto` AS BINARY) AS `ponto`';
  assert.deepEqual(sqls.slice(2), [
    'SELECT * FROM `loja`.`item` ORDER BY `pedido_id`, `seq` LIMIT 5000',
    `SELECT ${colunas} FROM \`loja\`.\`item\` ORDER BY \`pedido_id\`, \`seq\` LIMIT 5000`,
    `SELECT ${colunas} FROM \`loja\`.\`item\` WHERE (\`pedido_id\` > 1) OR (\`pedido_id\` = 1 AND \`seq\` > 2) ORDER BY \`pedido_id\`, \`seq\` LIMIT 5000`,
  ]);
  assert.equal(
    semData(s.texto),
    DUMP_CABECALHO + "INSERT INTO `item` (`pedido_id`, `seq`, `ponto`) VALUES\r\n(1, 1, X'000000'),\r\n(1, 2, X'000000'),\r\n(2, 1, NULL);\r\n\r\n" + DUMP_RODAPE,
  );
});

// ==========================================================
// CSV
// ==========================================================
test('exportTableCsv: ";", BOM, datas e decimais no padrão brasileiro', async () => {
  bancoDeMentira(2);
  const partes: string[] = [];
  let fechado = false;
  (globalThis as { window?: unknown }).window = {
    showSaveFilePicker: async (o: { suggestedName: string }) => ({
      name: o.suggestedName,
      createWritable: async () => ({
        write: async (p: string) => void partes.push(p),
        close: async () => void (fechado = true),
        abort: async () => {},
      }),
    }),
  };
  const progresso: string[] = [];
  try {
    await exportTableCsv(ALVO, 'loja', 'cliente', { progresso: (t) => progresso.push(t) });
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
  assert.equal(
    partes.join(''),
    '\uFEFFid;nome;valor;criado;obs;foto\r\n' +
      '1;Ana;10,50;31/01/2024 10:20:30;;010203\r\n' +
      '2;"O\'Neil\n";-3,00;;x;\r\n' +
      '3;Zé;0,00;;texto grande ção;\r\n',
  );
  assert.ok(fechado);
  assert.equal(progresso[progresso.length - 1], 'loja.cliente: 3 linha(s) exportada(s) para cliente.csv');
});

const COLUNAS = [
  ['id', 'int'],
  ['nome', 'varchar'],
  ['valor', 'decimal'],
  ['criado', 'datetime'],
];

function servidorDeImportacao() {
  return servidorDeMentira((b) =>
    typeof b.sql === 'string'
      ? { corpo: { resultados: [{ campos: [campo('a'), campo('b')], linhas: COLUNAS, truncado: false }], feitos: 1, cortado: false, sessaoNova: false, ms: 0 } }
      : feito(b),
  );
}

test('importCsv: colunas pelo cabeçalho, vazio/nulo, tudo numa transação', async () => {
  const s = servidorDeImportacao();
  const csv = '\uFEFF Nome ;ID;valor;CRIADO\r\n"Ana;Maria";1;1.234,56;31/01/2024 10:20\r\n;2;;\r\n\r\nx;3\r\n';
  assert.equal(await importCsv({ conexao: 7 }, 'loja', 'cliente', new Blob([csv]), true), 3);
  assert.deepEqual(s.corpos[0].params, ['loja', 'cliente']);
  const lote = s.corpos[1];
  assert.deepEqual(lote.sql, [
    'BEGIN',
    'INSERT INTO `cliente` (`nome`, `id`, `valor`, `criado`) VALUES ' +
      "('Ana;Maria', '1', '1234.56', '2024-01-31 10:20'), ('', '2', NULL, NULL), ('x', '3', NULL, NULL)",
    'COMMIT',
  ]);
  assert.equal(lote.banco, 'loja');
  assert.ok(lote.sessao, 'transação precisa da mesma conexão');
  assert.deepEqual(s.fechadas, [lote.sessao]);
});

test('importCsv: sem cabeçalho, erros de mapeamento e erro do MySQL', async () => {
  let s = servidorDeImportacao();
  assert.equal(await importCsv(ALVO, 'loja', 'cliente', new Blob(['5;Bia\r\n6;Caio\r\n']), false), 2);
  assert.equal((s.corpos[1].sql as string[])[1], "INSERT INTO `cliente` (`id`, `nome`) VALUES ('5', 'Bia'), ('6', 'Caio')");
  assert.equal(await importCsv(ALVO, 'loja', 'cliente', new Blob(['']), true), 0);

  await assert.rejects(importCsv(ALVO, 'loja', 'cliente', new Blob(['id;apelido\r\n1;x\r\n']), true), /A coluna "apelido" do arquivo não existe na tabela cliente\./);
  await assert.rejects(importCsv(ALVO, 'loja', 'cliente', new Blob(['1;a;2;3;4\r\n']), false), /O arquivo tem 5 colunas e a tabela cliente tem 4\./);

  // Erro no INSERT: o COMMIT não roda e a sessão é fechada (a transação é desfeita)
  s = servidorDeMentira((b) =>
    typeof b.sql === 'string'
      ? { corpo: { resultados: [{ campos: [campo('a'), campo('b')], linhas: COLUNAS, truncado: false }], feitos: 1, cortado: false, sessaoNova: false, ms: 0 } }
      : feito(b, { feitos: 1, erro: "Erro 1062: Duplicate entry '5' for key 'PRIMARY'" }),
  );
  await assert.rejects(importCsv(ALVO, 'loja', 'cliente', new Blob(['5;Bia\r\n']), false), /^Error: Erro 1062: Duplicate entry '5' for key 'PRIMARY'\nInstrução 2 do script: INSERT INTO `cliente`/);
  assert.equal(s.fechadas.length, 1);
});
