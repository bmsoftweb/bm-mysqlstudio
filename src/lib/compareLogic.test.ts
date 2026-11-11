// Checagem da lógica de comparação (sem banco): porte do tests\TestCompare.dpr. Rodar: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Alvo, Campo, Valor } from './api';
import { TIPO, lerCsv, novoIdApp, valoresEnum } from './db';
import {
  ColSpec,
  RecDiff,
  RecSame,
  RecSrc,
  RecTgt,
  DiffSt,
  OnlySrc,
  OnlyTgt,
  Same,
  SchemaObj,
  TableDiff,
  TableSpec,
  alterTable,
  bulkAdd,
  bulkEnd,
  defaultSql,
  changes,
  colsDiff,
  compareData,
  csvLit,
  designScript,
  escapeStr,
  hasDecimals,
  ignored,
  joinType,
  lit,
  loadRecords,
  mapOf,
  mergeChunk,
  mergeEnd,
  newColSpec,
  newCompareOptions,
  newSyncOptions,
  normalize,
  parseTable,
  prepareDiff,
  rowLines,
  sameValue,
  schemaScript,
  specDdl,
  splitType,
  triggersOn,
  writeDataScript,
} from './compareLogic';

const SRC =
  'CREATE TABLE `pedido` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  `cliente_id` int NOT NULL,\n' +
  "  `total` decimal(15,2) NOT NULL DEFAULT '0.00',\n  `obs` varchar(200) DEFAULT NULL,\n" +
  '  PRIMARY KEY (`id`),\n  KEY `ix_cliente` (`cliente_id`,`total`),\n' +
  '  CONSTRAINT `fk_cli` FOREIGN KEY (`cliente_id`) REFERENCES `cliente` (`id`)\n' +
  ') ENGINE=InnoDB AUTO_INCREMENT=57 DEFAULT CHARSET=utf8mb4';
const TGT =
  'CREATE TABLE `pedido` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  `cliente_id` int NOT NULL,\n' +
  '  `total` decimal(10,2) NOT NULL,\n  `velho` int DEFAULT NULL,\n' +
  '  PRIMARY KEY (`id`),\n  KEY `ix_cliente` (`cliente_id`)\n' +
  ') ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4';

/** Saida que junta o texto (o TStringStream do teste em Pascal). */
const novaSaida = () => ({
  texto: '',
  escrever(t: string) {
    this.texto += t;
  },
});

test('normalize', () => {
  assert.equal(normalize('CREATE DEFINER=`root`@`%` VIEW `v` AS select `loja`.`t`.`a` from `loja`.`t`', 'loja'), 'CREATE VIEW `v` AS select `t`.`a` from `t`');
  assert.ok(normalize(SRC, 'x').includes('ENGINE=InnoDB DEFAULT'), 'Normalize tira AUTO_INCREMENT=');
});

test('parseTable', () => {
  const d = parseTable(normalize(SRC, 'x'));
  assert.deepEqual([d.colOrder.length, d.keys.size, d.fks.size], [4, 2, 1], 'ParseTable contagens');
  assert.equal(d.options, 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
});

test('alterTable', () => {
  const pre: string[] = [];
  const main: string[] = [];
  const post: string[] = [];
  alterTable('pedido', normalize(SRC, 'x'), normalize(TGT, 'x'), pre, main, post);
  const m = main.join('');
  assert.ok(m.includes('DROP INDEX `ix_cliente`') && m.includes('ADD KEY `ix_cliente` (`cliente_id`,`total`)'), 'recria índice');
  assert.ok(m.includes("MODIFY COLUMN `total` decimal(15,2) NOT NULL DEFAULT '0.00'"), 'MODIFY');
  assert.ok(m.includes('ADD COLUMN `obs` varchar(200) DEFAULT NULL AFTER `total`'), 'ADD COLUMN AFTER');
  assert.ok(m.includes('DROP COLUMN `velho`'), 'DROP COLUMN');
  assert.ok(!m.includes('PRIMARY') && !m.includes('ENGINE'), 'não mexe no que é igual');
  assert.equal(pre.length, 0);
  assert.equal(post.join(''), 'ALTER TABLE `pedido` ADD CONSTRAINT `fk_cli` FOREIGN KEY (`cliente_id`) REFERENCES `cliente` (`id`);\n', 'FK no Post');

  // Ordem das colunas: só com order (editor de tabela), movendo só a que saiu de lugar.
  const tgt = 'CREATE TABLE `t` (\n  `a` int,\n  `b` int,\n  `c` int,\n  `d` int\n) ENGINE=InnoDB';
  const src = tgt.replace('`b` int,\n  `c` int', '`c` int,\n  `b` int'); // a c b d
  main.length = 0;
  alterTable('t', src, tgt, pre, main, post);
  assert.ok(main.join('').includes('não sincronizado'), 'comparação não mexe na ordem');
  main.length = 0;
  alterTable('t', src, tgt, pre, main, post, true);
  assert.equal(main.join(''), 'ALTER TABLE `t`\n  MODIFY COLUMN `b` int AFTER `c`;\n\n', 'ordem AFTER');
  main.length = 0;
  alterTable('t', tgt.replace('`a` int,\n  `b` int,\n  `c` int', '`c` int,\n  `a` int,\n  `b` int'), tgt, pre, main, post, true); // c a b d
  assert.equal(main.join(''), 'ALTER TABLE `t`\n  MODIFY COLUMN `c` int FIRST;\n\n', 'ordem FIRST');
});

test('schemaScript', () => {
  const obj = (objType: string, name: string, status: string, srcDdl = '', tgtDdl = ''): SchemaObj => ({ objType, name, status, srcDdl, tgtDdl, hasSrc: true, hasTgt: true });
  assert.equal(schemaScript([obj('TABLE', 'igual', Same, 'x', 'x')]), '');
  assert.equal(
    schemaScript([
      obj('TABLE', 'novo', OnlySrc, 'CREATE TABLE `novo` (\n  `id` int\n) ENGINE=InnoDB'),
      obj('TABLE', 'pedido', DiffSt, normalize(SRC, 'x'), normalize(TGT, 'x').replace('KEY `ix_cliente` (`cliente_id`)', 'KEY `ix_cliente` (`cliente_id`,`total`)')),
      obj('VIEW', 'v', OnlyTgt),
      obj('PROCEDURE', 'p', DiffSt, 'CREATE PROCEDURE `p`()\nSELECT 1', 'CREATE PROCEDURE `p`()\nSELECT 2'),
    ]),
    'SET FOREIGN_KEY_CHECKS = 0;\n\n' +
      'CREATE TABLE `novo` (\n  `id` int\n) ENGINE=InnoDB;\n\n' +
      "ALTER TABLE `pedido`\n  MODIFY COLUMN `total` decimal(15,2) NOT NULL DEFAULT '0.00',\n  ADD COLUMN `obs` varchar(200) DEFAULT NULL AFTER `total`,\n  DROP COLUMN `velho`;\n\n" +
      'DROP VIEW IF EXISTS `v`;\n\n' +
      'DROP PROCEDURE IF EXISTS `p`;\nDELIMITER $$\nCREATE PROCEDURE `p`()\nSELECT 1$$\nDELIMITER ;\n\n' +
      'ALTER TABLE `pedido` ADD CONSTRAINT `fk_cli` FOREIGN KEY (`cliente_id`) REFERENCES `cliente` (`id`);\n\n' +
      'SET FOREIGN_KEY_CHECKS = 1;\n',
  );
});

test('splitType / joinType', () => {
  const t = splitType('decimal(15,2) unsigned');
  assert.deepEqual(t, { base: 'decimal unsigned', size: '15', dec: '2' }, 'SplitType decimal');
  assert.equal(joinType(t.base, t.size, t.dec), 'decimal(15,2) unsigned', 'JoinType decimal');
  for (const n of ['varchar(50)', 'int unsigned', "enum('a','b(c)')", 'datetime(6)', 'text']) {
    const p = splitType(n);
    assert.equal(joinType(p.base, p.size, p.dec), n, 'Split/JoinType: ' + n);
  }
  assert.ok(hasDecimals('Decimal(15,2)') && hasDecimals('double unsigned') && !hasDecimals('int') && !hasDecimals(''), 'HasDecimals');
});

// Default digitado na grade: [valor, tipo, expressão que vai no DDL]
test('defaultSql', () => {
  const casos = [
    ['user', 'enum', "'user'"],
    [' user ', 'ENUM', "'user'"],
    ["'user'", 'enum', "'user'"],
    ['abc', 'varchar', "'abc'"],
    ['', 'varchar', ''],
    ['null', 'varchar', 'null'],
    ['(uuid())', 'char', '(uuid())'],
    ["_utf8mb4'x'", 'varchar', "_utf8mb4'x'"],
    ['0', 'tinyint', '0'],
    ['1.5', 'decimal unsigned', '1.5'],
    ['2026-01-01', 'date', "'2026-01-01'"],
    ['CURRENT_TIMESTAMP', 'datetime', 'CURRENT_TIMESTAMP'],
    ['CURRENT_TIMESTAMP(6)', 'timestamp', 'CURRENT_TIMESTAMP(6)'],
  ];
  for (const [v, tipo, esperado] of casos) assert.equal(defaultSql(v, tipo), esperado, `${tipo}: ${v}`);
});

test('escapeStr', () => {
  assert.equal(escapeStr("d'Ávila\\"), "d\\'Ávila\\\\");
  assert.equal(escapeStr('a\0b\nc\rd\x1ae"f'), 'a\\0b\\nc\\rd\\Ze\\"f');
});

test('lit', () => {
  const campo = (tipo: number, charset = 255): Campo => ({ nome: 'c', coluna: 'c', tabela: 't', banco: 'db', tipo, tamanho: 0, decimais: 0, flags: 0, charset });
  assert.equal(lit("d'Ávila", campo(TIPO.VAR_STRING)), "'d\\'Ávila'", 'Lit string');
  assert.equal(lit('1467.45', campo(TIPO.NEWDECIMAL, 63)), '1467.45', 'Lit decimal');
  assert.equal(lit(0.1, campo(TIPO.DOUBLE, 63)), '0.1', 'Lit float');
  assert.equal(lit('2026-11-04', campo(TIPO.DATE, 63)), "'2026-11-04'", 'Lit date');
  assert.equal(lit('2026-11-04 13:05:09', campo(TIPO.DATETIME, 63)), "'2026-11-04 13:05:09'", 'Lit datetime');
  assert.equal(lit({ bin: Buffer.from([0xab, 1]).toString('base64') }, campo(TIPO.BLOB, 63)), "X'AB01'", 'Lit binário');
  assert.equal(lit(null, campo(TIPO.LONG, 63)), 'NULL', 'Lit null');
  // o que o FireDAC não trazia e o servidor web traz
  assert.equal(lit('2026-11-04 13:05:09.000000', campo(TIPO.DATETIME, 63)), "'2026-11-04 13:05:09'", 'fração zerada some');
  assert.equal(lit('2026-11-04 13:05:09.120000', campo(TIPO.TIMESTAMP, 63)), "'2026-11-04 13:05:09.120'", 'milissegundo só quando tem');
  assert.equal(lit('13:05:09', campo(TIPO.TIME, 63)), "'13:05:09'", 'Lit time');
  assert.equal(lit('18446744073709551615', campo(TIPO.LONGLONG, 63)), '18446744073709551615', 'bigint sem perder precisão');
  assert.equal(lit(57, campo(TIPO.LONG, 63)), '57', 'Lit inteiro');
  assert.equal(lit('1 OR 1=1', campo(TIPO.NEWDECIMAL, 63)), "'1 OR 1=1'", 'o que não é número vai entre aspas');
  assert.equal(lit({ bin: '' }, campo(TIPO.BLOB, 63)), "X''", 'binário vazio');
  assert.throws(() => lit({ bin: null, bytes: 2_000_000 }, campo(TIPO.BLOB, 63)), 'valor grande precisa do lerGrande');
});

// Editor de tabela: renomear tabela e coluna, mudar tipo, incluir e excluir colunas.
test('specDdl / designScript', () => {
  const t1: TableSpec = {
    name: 'pedido',
    engine: 'InnoDB',
    comment: '',
    cols: [
      newColSpec({ name: 'id', colType: 'int', notNull: true, pk: true, autoInc: true }),
      newColSpec({ name: 'nome', colType: 'varchar(50)' }),
      newColSpec({ name: 'obs', colType: 'text' }),
    ],
    idx: [{ name: 'ix_nome', kind: 'INDEX', cols: 'nome' }],
    fks: [],
  };
  assert.equal(designScript(t1, t1, false), '', 'sem alteração: script vazio');
  assert.equal(
    designScript(t1, t1, true),
    'CREATE TABLE `pedido` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  `nome` varchar(50),\n  `obs` text,\n  PRIMARY KEY (`id`),\n  KEY `ix_nome` (`nome`)\n) ENGINE=InnoDB;\n',
    'CREATE da tabela nova',
  );
  const cols: ColSpec[] = [
    t1.cols[0],
    { ...t1.cols[1], name: 'descricao', orig: 'nome', colType: 'varchar(80)' },
    newColSpec({ name: 'total', colType: 'decimal(15,2)', notNull: true, default: '0' }),
  ];
  const t2: TableSpec = { ...t1, name: 'pedidos', cols, idx: [{ ...t1.idx[0], cols: 'descricao' }] };
  const n = designScript(t1, t2, false);
  assert.ok(n.startsWith('RENAME TABLE `pedido` TO `pedidos`;\n\nALTER TABLE `pedidos`\n  CHANGE COLUMN `nome` `descricao` varchar(80),'), 'renomeia e muda o tipo no mesmo comando');
  assert.equal(n.split('ALTER TABLE').length, 2, 'um ALTER só: ou entra inteiro ou não entra');
  assert.ok(n.includes('ADD COLUMN `total` decimal(15,2) NOT NULL DEFAULT 0 AFTER `descricao`'), 'inclui coluna');
  assert.ok(n.includes('DROP COLUMN `obs`') && !n.includes('INDEX'), 'exclui coluna sem mexer no índice');
  assert.equal(t1.cols[1].name, 'nome', 'DesignScript não altera o original');

  // renomear e trocar o tipo (admin tinyint -> nivel enum), só renomear, renomear e subir a coluna
  const u1: TableSpec = { ...t1, name: 'u', idx: [], cols: [t1.cols[0], newColSpec({ name: 'admin', orig: 'admin', colType: 'tinyint', notNull: true, default: '0' }), t1.cols[2]] };
  const nivel = { ...u1.cols[1], name: 'nivel', colType: "enum('super','admin','user')", default: "'user'" };
  assert.equal(
    designScript(u1, { ...u1, cols: [u1.cols[0], nivel, u1.cols[2]] }, false),
    "ALTER TABLE `u`\n  CHANGE COLUMN `admin` `nivel` enum('super','admin','user') NOT NULL DEFAULT 'user';\n\n",
    'renomeia e troca o tipo',
  );
  assert.equal(
    designScript(u1, { ...u1, cols: [u1.cols[0], { ...u1.cols[1], name: 'adm' }, u1.cols[2]] }, false),
    'ALTER TABLE `u`\n  CHANGE COLUMN `admin` `adm` tinyint NOT NULL DEFAULT 0;\n\n',
    'só renomeia',
  );
  assert.equal(
    designScript(u1, { ...u1, cols: [u1.cols[0], u1.cols[2], { ...u1.cols[1], name: 'adm' }] }, false),
    'ALTER TABLE `u`\n  CHANGE COLUMN `admin` `adm` tinyint NOT NULL DEFAULT 0 AFTER `obs`;\n\n',
    'renomeia e muda de lugar',
  );

  // índice único, FK com regra, comentários e engine padrão
  const t3: TableSpec = {
    name: 'item',
    engine: '',
    comment: "it's",
    cols: [newColSpec({ name: 'id', colType: ' int ', pk: true, comment: 'chave "x"', extra: ' ON UPDATE x ' })],
    idx: [{ name: 'uk', kind: 'unique', cols: 'a, b(10)' }],
    fks: [{ name: 'fk', cols: 'pedido_id', refTable: 'pedido', refCols: 'id', onDelete: 'cascade', onUpdate: 'No Action' }],
  };
  assert.equal(
    specDdl(t3),
    'CREATE TABLE `item` (\n  `id` int ON UPDATE x COMMENT \'chave \\"x\\"\',\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uk` (`a`,`b`(10)),\n' +
      "  CONSTRAINT `fk` FOREIGN KEY (`pedido_id`) REFERENCES `pedido` (`id`) ON DELETE CASCADE\n) ENGINE=InnoDB COMMENT='it\\'s'",
  );
});

// CSV: conversão do padrão brasileiro.
test('csvLit', () => {
  assert.equal(csvLit('1.467,45', 'decimal'), "'1467.45'", 'CsvLit decimal');
  assert.equal(csvLit('04/11/2026 13:05:09', 'datetime'), "'2026-11-04 13:05:09'", 'CsvLit data');
  assert.ok(csvLit('', 'int') === 'NULL' && csvLit('', 'varchar') === "''", 'CsvLit vazio');
  assert.equal(csvLit("d'x", 'varchar'), "'d\\'x'", 'CsvLit texto');
});

// Estrutura para a comparação de dados: int(11) do 5.7 = int do 8; maiúsculas não contam.
test('colsDiff', () => {
  assert.equal(
    colsDiff(
      [
        ['t', 'id', 'int(11)'],
        ['t', 'v', 'decimal(15,2)'],
      ],
      [
        ['T', 'ID', 'int'],
        ['t', 'v', 'decimal(15,2)'],
      ],
    ),
    '',
    'ColsDiff igual',
  );
  assert.equal(
    colsDiff(
      [
        ['t', 'id', 'int'],
        ['t', 'v', 'decimal(15,2)'],
        ['u', 'id', 'int'],
      ],
      [
        ['t', 'id', 'int'],
        ['t', 'v', 'decimal(10,2)'],
        ['t', 'x', 'date'],
      ],
    ),
    't.v: decimal(15,2) na origem, decimal(10,2) no destino\nt.x: coluna só no destino\nu: tabela só na origem',
    'ColsDiff diferente',
  );
  // mais de 10 diferenças: corta e diz quantas faltaram; tabela com prefixo de outra vem depois
  const muitas = Array.from({ length: 12 }, (_, i) => ['pedido_itens', 'c' + String(i).padStart(2, '0'), 'int']);
  const r = colsDiff([['pedido', 'id', 'int'], ['pedido_itens', 'id', 'int'], ['pedido', 'x', 'int'], ...muitas], [['pedido', 'id', 'int'], ['pedido_itens', 'id', 'int']]).split('\n');
  assert.equal(r.length, 11);
  assert.equal(r[0], 'pedido.x: coluna só na origem');
  assert.equal(r[1], 'pedido_itens.c00: coluna só na origem');
  assert.equal(r[10], '... e mais 3 diferença(s)');
});

// INSERT agrupado: junta até o limite e abre outro comando quando passa.
test('bulkAdd / bulkEnd', async () => {
  const bs = novaSaida();
  let sz = 0;
  sz = await bulkAdd(bs, sz, 'INSERT INTO t VALUES\n', '(1)', ';', 40);
  sz = await bulkAdd(bs, sz, 'INSERT INTO t VALUES\n', '(2)', ';', 40);
  sz = await bulkAdd(bs, sz, 'INSERT INTO t VALUES\n', '(3)', ';', 30);
  sz = await bulkEnd(bs, sz, ';');
  sz = await bulkEnd(bs, sz, ';'); // fechar de novo não escreve nada
  assert.equal(sz, 0);
  assert.equal(bs.texto, 'INSERT INTO t VALUES\n(1),\n(2);\nINSERT INTO t VALUES\n(3);\n', 'BulkAdd');
});

// Script de dados: inteiro sem limite; com limite (prévia) para no meio e devolve false; opções.
test('writeDataScript', async () => {
  const td = new TableDiff('t');
  td.ins = ['INSERT INTO t VALUES\n(1),\n(2);\nINSERT INTO t VALUES\n(3);\n', 'INSERT INTO t VALUES\n(4);\n'];
  td.insCount = 4;
  let o = newSyncOptions(true, true, true);
  let bs = novaSaida();
  assert.ok(await writeDataScript(bs, '', 'db', [td], o), 'WriteDataScript inteiro');
  assert.ok(bs.texto.includes('USE `db`;') && bs.texto.includes('(4);') && bs.texto.endsWith('SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;\n\n'), 'WriteDataScript inteiro');
  const sz = bs.texto.indexOf('(1)'); // só ASCII antes: posição = bytes
  bs = novaSaida();
  assert.equal(await writeDataScript(bs, '', 'db', [td], o, sz), false, 'WriteDataScript prévia');
  assert.ok(bs.texto.length === sz && !bs.texto.includes('(1)'), 'WriteDataScript prévia');
  // a prévia conta bytes e não corta um caractere no meio
  const acento = new TableDiff('t');
  acento.upd = ["UPDATE t SET a = 'ááá';\n"];
  acento.updCount = 1;
  bs = novaSaida();
  const antes = "SET NAMES 'utf8mb4';\n\nBEGIN;\n\nUPDATE t SET a = 'á";
  o = { ...newSyncOptions(false, true, false), useDb: false, noFks: false, comments: false };
  assert.equal(await writeDataScript(bs, '', 'db', [acento], o, antes.length + 2), false);
  assert.equal(bs.texto, antes, 'prévia com acento');

  o = newSyncOptions(true, true, true);
  o.ins = false;
  assert.equal(changes(o, td), 0, 'Changes sem inserir');
  bs = novaSaida();
  assert.ok((await writeDataScript(bs, 'cabeçalho', 'db', [td], o)) && bs.texto === '', 'sem diferença: nada escrito');
  // COMMIT a cada 2 comandos; sem USE, chaves e comentários; triggers e scripts do usuário nos lugares certos.
  o = newSyncOptions(true, false, false);
  o.commitEvery = 2;
  o.useDb = false;
  o.noFks = false;
  o.comments = false;
  o.before = ' SET @a = 1;\r\n';
  o.after = 'SET @b = 2;';
  o.triggers = [{ table: 't', name: 'tg', ddl: 'CREATE TRIGGER tg BEFORE INSERT ON t FOR EACH ROW SET NEW.a = 1' }];
  bs = novaSaida();
  assert.ok(await writeDataScript(bs, 'cabeçalho', 'db', [td], o));
  assert.equal(
    bs.texto,
    "SET NAMES 'utf8mb4';\n\nSET @a = 1;\n\nDROP TRIGGER IF EXISTS `tg`;\n\nBEGIN;\n\n" +
      'INSERT INTO t VALUES\n(1),\n(2);\nINSERT INTO t VALUES\n(3);\nCOMMIT;\nBEGIN;\n' +
      'INSERT INTO t VALUES\n(4);\n\nCOMMIT;\n\n' +
      'DELIMITER $$\n\nCREATE TRIGGER tg BEFORE INSERT ON t FOR EACH ROW SET NEW.a = 1\n$$\n\nDELIMITER ;\n\n' +
      'SET @b = 2;\n\n',
    'WriteDataScript com opções',
  );
  // com comentários: cabeçalho e títulos
  o = newSyncOptions(true, false, false);
  bs = novaSaida();
  await writeDataScript(bs, '-- cabeçalho\n\n', 'db', [td], o);
  assert.ok(bs.texto.startsWith("-- cabeçalho\n\nSET NAMES 'utf8mb4';\n\nUSE `db`;\n\n--\n-- Desliga as chaves estrangeiras\n--\nSET @OLD_FOREIGN_KEY_CHECKS"), bs.texto);
  assert.ok(bs.texto.includes('BEGIN;\n\n--\n-- Inserindo dados na tabela `t`\n--\nINSERT INTO t VALUES\n(1)'), bs.texto);
  assert.equal(triggersOn([], true), '');
  await assert.rejects(writeDataScript(novaSaida(), '', 'db', [td], o, 0, { sinal: AbortSignal.abort() }), { name: 'AbortError' });
});

// Opções da comparação de dados: valores iguais com as opções, colunas ignoradas (máscara e mapeamento).
test('sameValue / ignored / mapOf', () => {
  const co = newCompareOptions();
  assert.ok(!sameValue(co, "'Ana'", "'ANA'") && sameValue(co, '1', '1'), 'SameValue sem opções');
  co.ignoreCase = true;
  co.trimSpaces = true;
  co.ignoreEol = true;
  co.nullIsEmpty = true;
  assert.ok(
    sameValue(co, "'Ana'", "'ANA '") && sameValue(co, "'a\\r\\nb'", "'a\\nb'") && sameValue(co, 'NULL', "''") && !sameValue(co, '1', '2') && sameValue(co, "'Ávila'", "'ávila'"),
    'SameValue com opções',
  );
  co.ignoreCols = 'atualizado_em; *_log';
  co.maps = [{ table: 'Pedido', key: '', skip: false, ignore: ['obs'] }];
  assert.ok(
    ignored(co, 'pedido', 'OBS') && ignored(co, 'x', 'atualizado_em') && ignored(co, 'x', 'erro_log') && !ignored(co, 'x', 'obs') && !ignored(co, 'pedido', 'total'),
    'Ignored',
  );
  assert.ok(mapOf(co, 'PEDIDO').ignore.length > 0 && mapOf(co, 'outra').key === '' && !mapOf(co, 'outra').skip, 'Map');
});

// Registros por situação para a grade de resultado.
test('rowLines', () => {
  const td = new TableDiff('t');
  td.rows = ['<1', '=2', '!3', ">(4, 'a')"];
  assert.deepEqual(rowLines(td, RecSrc + RecDiff + RecTgt, 10), ['<1', '!3', ">(4, 'a')"], 'RowLines');
  assert.equal(rowLines(td, RecSrc + RecDiff + RecTgt + RecSame, 2).length, 2, 'RowLines com limite');
});

// A parte pura da comparação de dados: linhas já lidas dos dois lados -> ins/upd/del/rows.
test('prepareDiff / mergeChunk', async () => {
  const co = newCompareOptions();
  assert.equal(prepareDiff({ table: 't', cols: ['a'], keys: [], keyCols: [] }, co).note, 'sem chave primária nem índice único, não comparada');
  co.maps = [{ table: 'T', key: 'uk_velho', skip: false, ignore: [] }];
  assert.equal(prepareDiff({ table: 't', cols: ['a'], keys: ['PRIMARY'], keyCols: ['a'] }, co).note, 'o índice uk_velho não existe mais, não comparada');
  co.maps = [];
  let d = prepareDiff({ table: 't', cols: ['a'], keys: ['PRIMARY'], keyCols: ['id'] }, co);
  assert.deepEqual([d.note, d.cols], ['chave PRIMARY ausente no destino', []]);

  // chave simples; coluna ignorada pela máscara não gera UPDATE
  co.ignoreCols = '*_em';
  d = prepareDiff({ table: 't', cols: ['id', 'nome', 'obs', 'atualizado_em'], keys: ['PRIMARY'], keyCols: ['id'] }, co);
  assert.deepEqual([d.note, d.key, d.keyCols, d.compared], ['', 'PRIMARY', ['id'], [true, true, true, false]]);
  await mergeChunk(
    d,
    co,
    [
      ['1', "'a'", "'x'", "'2026-01-01'"],
      ['2', "'b'", 'NULL', "'2026-01-01'"],
      ['3', "'c'", "'z'", "'2026-01-01'"],
      ['5', "'e'", "'e'", "'2026-01-01'"],
    ],
    [
      [
        ['1', "'a'", "'x'", "'2025-12-31'"],
        ['3', "'C'", "'y'", "'2026-01-01'"],
      ],
      [['4', "'d'", 'NULL', 'NULL']],
    ],
  );
  // segundo bloco: os comandos agrupados continuam abertos entre os blocos; destino em página assíncrona
  await mergeChunk(
    d,
    co,
    [['6', "'f'", 'NULL', 'NULL']],
    (async function* () {
      yield [['7', "'g'", 'NULL', 'NULL']];
    })(),
  );
  await mergeEnd(d);
  assert.deepEqual([d.equal, d.insCount, d.updCount, d.delCount], [1, 3, 1, 2]);
  assert.deepEqual(d.colDiffs, [0, 1, 1, 0]);
  assert.deepEqual(d.rows, ['=1', '<2', '!3', '<5', '>4', '<6', '>7']);
  assert.equal(d.upd.join(''), "UPDATE `t` SET `nome` = 'c', `obs` = 'z' WHERE `id` = 3;\n");
  assert.equal(
    d.ins.join(''),
    "INSERT INTO `t` (`id`, `nome`, `obs`, `atualizado_em`) VALUES\n(2, 'b', NULL, '2026-01-01'),\n(5, 'e', 'e', '2026-01-01'),\n(6, 'f', NULL, NULL);\n",
  );
  assert.equal(d.del.join(''), 'DELETE FROM `t` WHERE `id` IN (4,\n7);\n');
  assert.deepEqual([d.insSize, d.delSize], [0, 0]);

  // chave composta por índice único escolhido no mapeamento; opções valem na comparação
  co.ignoreCols = '';
  co.ignoreCase = true;
  co.maps = [{ table: 't', key: 'UK', skip: false, ignore: ['obs'] }];
  d = prepareDiff({ table: 't', cols: ['a', 'b', 'v', 'obs'], keys: ['PRIMARY', 'uk'], keyCols: ['id', 'b,a'] }, co);
  assert.deepEqual([d.note, d.keyCols, d.compared], ['chave: uk', ['b', 'a'], [true, true, true, false]]);
  await mergeChunk(
    d,
    co,
    [
      ['1', "'x'", "'Ana'", "'o'"],
      ['1', "'y'", "'Bia'", "'o'"],
    ],
    [
      [
        ['1', "'x'", "'ANA'", "'outra'"],
        ['1', "'y'", "'Bia2'", "'o'"],
        ['2', "'x'", 'NULL', 'NULL'],
      ],
    ],
  );
  await mergeEnd(d);
  assert.deepEqual(d.rows, ["=('x', 1)", "!('y', 1)", ">('x', 2)"]);
  assert.equal(d.upd.join(''), "UPDATE `t` SET `v` = 'Bia' WHERE `b` = 'y' AND `a` = 1;\n");
  assert.equal(d.del.join(''), "DELETE FROM `t` WHERE (`b`, `a`) IN (('x', 2));\n");
  assert.equal(d.ins.length, 0);
});

// ==========================================================
// Leitura paginada pela chave, contra um /api/sql de mentira (uma tabela `t` (id, nome) em cada banco)
// ==========================================================
const ORIGEM: Valor[][] = [1, 2, 3, 4, 5, 6, 7].map((id) => [id, 'n' + id]);
const DESTINO: Valor[][] = [9, 8, 7, 6, 4, 3, 2].map((id) => [id, id === 3 ? 'outro' : 'n' + id]); // fora de ordem: quem ordena é o ORDER BY
const A1: Alvo = { conexao: 1 };
const A2: Alvo = { conexao: 2 };

/** maxLinhas: a partir de quantas linhas a resposta vem cortada (truncado), como o limite de tamanho do servidor. */
function servidorDeMentira(maxLinhas: number): string[] {
  const sqls: string[] = [];
  const campo = (nome: string, tipo: number, charset: number): Campo => ({ nome, coluna: nome, tabela: 't', banco: '', tipo, tamanho: 0, decimais: 0, flags: 0, charset });
  const responder = (conexao: number, sql: string, params: unknown[] = []) => {
    const banco = conexao === 1 ? 'origem' : 'destino';
    const texto = (linhas: string[][]) => ({ campos: linhas[0].map((_, i) => campo('c' + i, TIPO.VAR_STRING, 255)), linhas, truncado: false });
    if (sql.includes('information_schema.statistics')) return texto([['t', 'PRIMARY', 'id']]);
    if (sql.includes('information_schema.columns')) {
      assert.deepEqual(params, [banco]);
      return texto([
        ['t', 'id'],
        ['t', 'nome'],
      ]);
    }
    const m = /^SELECT `id`, `nome` FROM `(\w+)`\.`t`(?: WHERE (.*?))?(?: ORDER BY `id` LIMIT (\d+))?$/.exec(sql);
    assert.ok(m, 'SQL inesperado: ' + sql);
    assert.equal(m[1], banco, 'tabela qualificada com o banco do lado certo');
    const w = m[2] ?? '';
    const gt = /`id` > (\d+)/.exec(w);
    const le = /`id` <= (\d+)/.exec(w);
    const em = /`id` IN \((.*)\)/.exec(w);
    let l = (conexao === 1 ? ORIGEM : DESTINO)
      .filter((r) => (!gt || Number(r[0]) > Number(gt[1])) && (!le || Number(r[0]) <= Number(le[1])) && (!em || em[1].split(', ').includes(String(r[0]))))
      .sort((x, y) => Number(x[0]) - Number(y[0]));
    if (m[3]) l = l.slice(0, Number(m[3]));
    return { campos: [campo('id', TIPO.LONG, 63), campo('nome', TIPO.VAR_STRING, 255)], linhas: l.slice(0, maxLinhas), truncado: l.length > maxLinhas };
  };
  globalThis.fetch = (async (_rota: string, init: { body: string }) => {
    const b = JSON.parse(init.body) as { conexao: number; sql: string; params?: unknown[] };
    sqls.push(b.sql);
    return new Response(JSON.stringify({ resultados: [responder(b.conexao, b.sql, b.params)], feitos: 1, cortado: false, sessaoNova: false, ms: 0 }));
  }) as unknown as typeof fetch;
  return sqls;
}

test('compareData: paginação pela chave e resposta cortada', async () => {
  const resumo = (d: TableDiff) => ({ rows: d.rows, ins: d.ins.join(''), upd: d.upd.join(''), del: d.del.join(''), n: [d.equal, d.insCount, d.updCount, d.delCount] });
  const esperado = {
    rows: ['<1', '=2', '!3', '=4', '<5', '=6', '=7', '>8', '>9'],
    ins: "INSERT INTO `t` (`id`, `nome`) VALUES\n(1, 'n1'),\n(5, 'n5');\n",
    upd: "UPDATE `t` SET `nome` = 'n3' WHERE `id` = 3;\n",
    del: 'DELETE FROM `t` WHERE `id` IN (8,\n9);\n',
    n: [4, 2, 1, 2],
  };
  const progresso: string[] = [];
  let sqls = servidorDeMentira(1000);
  let r = await compareData(A1, 'origem', A2, 'destino', newCompareOptions(), 3, { progresso: (t) => progresso.push(t) });
  assert.equal(r.length, 1);
  assert.deepEqual(resumo(r[0]), esperado, 'blocos de 3');
  assert.deepEqual(progresso, ['t', 't: 3 registros', 't: 6 registros', 't: 7 registros']);
  assert.deepEqual(
    sqls.filter((s) => s.includes('`destino`.`t`')),
    [
      'SELECT `id`, `nome` FROM `destino`.`t` WHERE `id` <= 3 ORDER BY `id` LIMIT 3',
      'SELECT `id`, `nome` FROM `destino`.`t` WHERE `id` > 3 AND `id` <= 6 ORDER BY `id` LIMIT 3',
      'SELECT `id`, `nome` FROM `destino`.`t` WHERE `id` > 6 ORDER BY `id` LIMIT 3',
      'SELECT `id`, `nome` FROM `destino`.`t` WHERE `id` > 9 ORDER BY `id` LIMIT 3',
    ],
    'destino: só a faixa de chave de cada bloco',
  );

  // cada resposta com no máximo 2 linhas (cortada): continua da última chave e chega no mesmo resultado
  sqls = servidorDeMentira(2);
  r = await compareData(A1, 'origem', A2, 'destino', newCompareOptions(), 3);
  assert.deepEqual(resumo(r[0]), esperado, 'resposta cortada');
  assert.ok(sqls.includes('SELECT `id`, `nome` FROM `origem`.`t` WHERE `id` > 2 ORDER BY `id` LIMIT 1'), 'completa o bloco da origem a partir da última chave');

  // bloco maior que a tabela e bloco de 1
  servidorDeMentira(1000);
  assert.deepEqual(resumo((await compareData(A1, 'origem', A2, 'destino', newCompareOptions(), 5000))[0]), esperado, 'um bloco só');
  servidorDeMentira(1);
  assert.deepEqual(resumo((await compareData(A1, 'origem', A2, 'destino', newCompareOptions(), 1))[0]), esperado, 'bloco de 1');

  // tabela desmarcada no mapeamento não é comparada; cancelamento
  const co = newCompareOptions();
  co.maps = [{ table: 't', key: '', skip: true, ignore: [] }];
  assert.equal((await compareData(A1, 'origem', A2, 'destino', co)).length, 0);
  await assert.rejects(compareData(A1, 'origem', A2, 'destino', newCompareOptions(), 3, { sinal: AbortSignal.abort() }), { name: 'AbortError' });
});

test('loadRecords', async () => {
  servidorDeMentira(1000);
  const co = newCompareOptions();
  const [d] = await compareData(A1, 'origem', A2, 'destino', co, 3);
  const linhas = rowLines(d, RecSrc + RecDiff + RecTgt, 100);
  assert.deepEqual(linhas, ['<1', '!3', '<5', '>8', '>9']);
  const esperado = [
    { state: '<', src: ['1', 'n1'], tgt: null, diff: [false, false] },
    { state: '!', src: ['3', 'n3'], tgt: ['3', 'outro'], diff: [false, true] },
    { state: '<', src: ['5', 'n5'], tgt: null, diff: [false, false] },
    { state: '>', src: null, tgt: ['8', 'n8'], diff: [false, false] },
  ];
  assert.deepEqual(await loadRecords(A1, 'origem', A2, 'destino', d, co, linhas, 0, 4), esperado);
  // resposta cortada: pede de novo as chaves que faltaram
  servidorDeMentira(1);
  assert.deepEqual(await loadRecords(A1, 'origem', A2, 'destino', d, co, linhas, 0, 4), esperado);
  assert.deepEqual(await loadRecords(A1, 'origem', A2, 'destino', d, co, linhas, 4, 10), [{ state: '>', src: null, tgt: ['9', 'n9'], diff: [false, false] }], 'count além do fim');
});

// ==========================================================
// Testes do TestCompare.dpr para funções do uDb (aqui em db.ts)
// ==========================================================
test('db.ts: lerCsv, novoIdApp, valoresEnum', () => {
  // CSV: aspas, ; e quebra de linha dentro da célula
  const csv = lerCsv('﻿a;"b;""c"""\r\n1;"x\ny"\r\n\r\n');
  assert.ok(csv.length === 2 && csv[0][1] === 'b;"c"' && csv[1][1] === 'x\ny' && csv[0][0] === 'a', 'ParseCsv');

  // id_app como a trigger: 17 dígitos de data e hora local (com milissegundos) + 8 aleatórios.
  const n = novoIdApp();
  const d = new Date();
  const hoje = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  assert.ok(/^\d{25}$/.test(n) && n.startsWith(hoje) && novoIdApp() !== n, 'NewIdApp: ' + n);

  assert.equal(valoresEnum("enum('CONSTRUTORA','D''AGUA','','A,B')").join('|'), "CONSTRUTORA|D'AGUA||A,B", 'EnumValues');
  assert.equal(valoresEnum('varchar(20)').length, 0, 'EnumValues sem lista');
});
