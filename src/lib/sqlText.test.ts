import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DivisorScript, dropParens, formatSql, isKeyword, singleSelect, splitScript, sqlKeywords, statementAt, tokenize, unquote,
} from './sqlText';

// Os testes até "SingleSelect" são os do ..\delphi\tests\TestCompare.dpr, com as mesmas entradas e saídas
// (só as posições do StatementAt passaram de 1 para 0 como base).

const at = (s: string, pos: number) => {
  const r = statementAt(s, pos);
  return r && s.slice(r.start, r.start + r.len);
};

test('StatementAt', () => {
  const m = "select 1;\r\nselect ';' as x ;  \r\nselect 3";
  assert.equal(at(m, 1), 'select 1', 'StatementAt 1');
  assert.equal(at(m, 9), 'select 1', 'StatementAt logo depois do ;');
  assert.equal(at(m, 13), "select ';' as x", 'StatementAt ignora ; na string');
  assert.equal(at(m, m.length - 1), 'select 3', 'StatementAt último');
});

test('StatementAt: base 0 e instrução vazia', () => {
  assert.deepEqual(statementAt('  select 1 ; select 2', 0), { start: 2, len: 8 });
  assert.deepEqual(statementAt('select 1;select 2', 10), { start: 9, len: 8 });
  assert.equal(statementAt('select 1;   ', 12), null);
  assert.equal(statementAt('', 0), null);
});

test('FormatSql', () => {
  assert.equal(
    formatSql("select a, b from t where x=1 and y='a;b'"),
    "SELECT\r\n  a,\r\n  b\r\nFROM t\r\nWHERE x = 1\r\n  AND y = 'a;b'",
    'FormatSql 1',
  );
  assert.equal(
    formatSql('select count(*) from t1 left join t2 on t1.id=t2.id where d between 1 and 2 order by 1;select 2'),
    'SELECT\r\n  count(*)\r\nFROM t1\r\nLEFT JOIN t2 ON t1.id = t2.id\r\n' +
      'WHERE d BETWEEN 1 AND 2\r\nORDER BY 1;\r\n\r\nSELECT\r\n  2',
    'FormatSql 2',
  );
  assert.equal(
    formatSql('select * from t where id in (select id from u where a = 1) -- fim'),
    'SELECT\r\n  *\r\nFROM t\r\nWHERE id IN (\r\n    SELECT\r\n      id\r\n    FROM u\r\n' + '    WHERE a = 1) -- fim',
    'FormatSql 3',
  );
  assert.equal(formatSql('select a -- x\r\nfrom t'), 'SELECT\r\n  a -- x\r\nFROM t', 'FormatSql comentário');
});

test('Unquote', () => {
  assert.equal(
    unquote(
      'CREATE DEFINER=`adm`@`%` VIEW `db`.`v` AS select `a`.`ID` AS `id`,`a`.`order` AS `Ação`,' +
        "if((`a`.`x` = '`y`'),1,`2a`) AS `tipo_x` from (`t` `a` join `u` on((`u`.`k` = `a`.`k`)))",
    ),
    'CREATE DEFINER=`adm`@`%` VIEW db.v AS select a.ID AS id,a.`order` AS `Ação`,' +
      "if((a.x = '`y`'),1,`2a`) AS tipo_x from (t a join u on((u.k = a.k)))",
  );
  assert.equal(unquote('DEFINER = `adm` @ `%`'), 'DEFINER = `adm` @ `%`', 'Unquote mantém usuário@host');
});

test('DropParens', () => {
  assert.equal(
    dropParens(
      'select a from ((t a left join u b on((b.id = a.id))) join v c on((c.k = b.k))) ' + 'where (a.x >= 1) order by a.x',
    ),
    'select a from t a left join u b on b.id = a.id join v c on c.k = b.k where a.x >= 1 order by a.x',
    'DropParens junções',
  );
  // junção à direita, vírgula, subconsulta e condição que não é inteira ficam com os parênteses
  assert.equal(
    dropParens('select 1 from a join (b join c on (c.x = b.x)) on (b.y = a.y) where (a.k) = 1'),
    'select 1 from a join (b join c on c.x = b.x) on b.y = a.y where (a.k) = 1',
    'DropParens à direita',
  );
  assert.equal(
    dropParens('select 1 from (a, b) join c on (c.x = a.x) where (select 1) = 1'),
    'select 1 from (a, b) join c on c.x = a.x where (select 1) = 1',
    'DropParens vírgula',
  );
});

test('SingleSelect', () => {
  assert.ok(singleSelect("-- lista\nselect * from t where a = ';' limit 10;  /* fim */ "), 'SingleSelect simples');
  assert.ok(singleSelect('WITH x AS (SELECT 1) SELECT * FROM x'), 'SingleSelect WITH');
  assert.ok(!singleSelect('SELECT 1; SELECT 2'), 'SingleSelect duas instruções');
  assert.ok(!singleSelect('UPDATE t SET a = 1'), 'SingleSelect UPDATE');
  assert.ok(!singleSelect('CALL p()'), 'SingleSelect CALL');
});

// Daqui em diante não há equivalente no TestCompare.dpr.

test('Tokenize: tipos e posição a partir de 0', () => {
  const s = "a1 `b``c` 'd\\'e''f' 12x <= /* g */ -- h\n#i\r\n@v ção";
  const toks = tokenize(s);
  assert.equal(toks.map((t) => t.text).join(''), s);
  for (const t of toks) assert.equal(s.slice(t.start, t.start + t.text.length), t.text);
  assert.deepEqual(
    toks.filter((t) => t.kind !== 'space').map((t) => [t.kind, t.text]),
    [
      ['word', 'a1'], ['quoted', '`b``c`'], ['string', "'d\\'e''f'"], ['number', '12x'], ['symbol', '<='],
      ['comment', '/* g */'], ['lineComment', '-- h'], ['lineComment', '#i'], ['word', '@v'], ['word', 'ção'],
    ],
  );
  // texto e comentário sem fim vão até o fim do texto
  assert.deepEqual(tokenize("'a\\").map((t) => t.text), ["'a\\"]);
  assert.deepEqual(tokenize('x/*y').map((t) => t.kind), ['word', 'comment']);
});

test('IsKeyword', () => {
  assert.equal(sqlKeywords.length, 70);
  assert.ok(isKeyword('select') && isKeyword('Straight_Join') && !isKeyword('selecta') && !isKeyword(''));
});

test('DivisorScript: textos, crases e aspas escapadas', () => {
  assert.deepEqual(splitScript('select 1; select \'a;b\', "c;d", `e;f`;\n\n;;select 3'), [
    'select 1',
    'select \'a;b\', "c;d", `e;f`',
    'select 3',
  ]);
  const ins = String.raw`insert into t values ('it\'s; ok', 'd''agua;', "a\"b;", "c""d;", 'fim\\')`;
  assert.deepEqual(splitScript(ins + '; select 2;'), [ins, 'select 2']);
});

test('DivisorScript: comentários', () => {
  assert.deepEqual(
    splitScript('-- só comentário; aqui\n# outro; aqui\n/* bloco; aqui */;\nselect 1 -- fim; não\n, 2 /* meio; */ ;\n-- sobra\n'),
    ['select 1 -- fim; não\n, 2 /* meio; */'],
  );
  assert.deepEqual(splitScript('select 1--1; select 2 --\n;--'), ['select 1--1', 'select 2 --']);
  assert.deepEqual(splitScript('select 1 /* sem fim; select 2'), ['select 1 /* sem fim; select 2']);
});

test('DivisorScript: /*! */ fica na instrução', () => {
  assert.deepEqual(
    splitScript(
      '/*!40101 SET NAMES utf8mb4 */;\n/*M!100616 SET x=1 */;\n/* nada */;\nselect /*+ MAX_EXECUTION_TIME(1) */ 1;\n' +
        "/*!50001 select 'a*/;b' */;",
    ),
    ['/*!40101 SET NAMES utf8mb4 */', '/*M!100616 SET x=1 */', 'select /*+ MAX_EXECUTION_TIME(1) */ 1', "/*!50001 select 'a*/;b' */"],
  );
});

const rotinas =
  'DROP TRIGGER IF EXISTS t1;\r\n' +
  '-- comentário antes\r\n' +
  'delimiter $$\r\n' +
  "CREATE TRIGGER t1 BEFORE INSERT ON t FOR EACH ROW\r\nBEGIN\r\n  SET NEW.a = 'x$$y'; -- c$$\r\n  SET NEW.b = 1;\r\nEND$$\r\n" +
  'DeLiMiTeR ;\r\n' +
  'select 1;\r\n' +
  '  DELIMITER\t;;  \r\n' +
  '/*!50003 CREATE PROCEDURE p() BEGIN select 1; END */;;\r\n' +
  'DELIMITER ;';
const rotinasEsperado = [
  'DROP TRIGGER IF EXISTS t1',
  "CREATE TRIGGER t1 BEFORE INSERT ON t FOR EACH ROW\r\nBEGIN\r\n  SET NEW.a = 'x$$y'; -- c$$\r\n  SET NEW.b = 1;\r\nEND",
  'select 1',
  '/*!50003 CREATE PROCEDURE p() BEGIN select 1; END */',
];

test('DivisorScript: DELIMITER', () => {
  assert.deepEqual(splitScript(rotinas), rotinasEsperado);
  assert.deepEqual(splitScript('DELIMITER //\nselect 1//\nselect 2//'), ['select 1', 'select 2']);
});

test('DivisorScript: DELIMITER só no começo da linha e fora de instrução', () => {
  assert.deepEqual(splitScript('create table t (\n  delimiter int\n);\nselect 1; delimiter $$\n'), [
    'create table t (\n  delimiter int\n)',
    'select 1',
    'delimiter $$',
  ]);
  assert.deepEqual(splitScript('delimiters;\ndelimiter\n;'), ['delimiters', 'delimiter']);
  assert.deepEqual(splitScript("select '\nDELIMITER $$\n'; select 2"), ["select '\nDELIMITER $$\n'", 'select 2']);
});

test('DivisorScript: fim() devolve o que sobrou sem delimitador', () => {
  const d = new DivisorScript();
  assert.deepEqual(d.alimentar('select 1; select 2'), ['select 1']);
  assert.deepEqual(d.alimentar(' as x'), []);
  assert.deepEqual(d.fim(), ['select 2 as x']);
  assert.deepEqual(d.fim(), []);
});

test('DivisorScript: pedaço cortado em qualquer lugar dá o mesmo resultado', () => {
  const tudo =
    String.raw`insert into t values ('it\'s; ok', 'd''agua;', "a\"b;", 'fim\\'), ('''', "");` +
    '\n-- só comentário; aqui\n# outro\n/* bloco; ** aqui **/select 1 -- fim; não\n, 2 /* meio; */ - 1 / 2 --3;\n' +
    '/*!40101 SET NAMES utf8mb4 */;/*M!100616 SET x=1 */;/**/;select `a``;b`;\r\n' +
    rotinas +
    '\nselect 9';
  const esperado = splitScript(tudo);
  assert.deepEqual(esperado, [
    String.raw`insert into t values ('it\'s; ok', 'd''agua;', "a\"b;", 'fim\\'), ('''', "")`,
    'select 1 -- fim; não\n, 2 /* meio; */ - 1 / 2 --3',
    '/*!40101 SET NAMES utf8mb4 */',
    '/*M!100616 SET x=1 */',
    'select `a``;b`',
    ...rotinasEsperado,
    'select 9',
  ]);
  // pedaços de tamanho fixo, de 1 até o texto inteiro
  for (let tam = 1; tam <= tudo.length; tam++) {
    const d = new DivisorScript();
    const r: string[] = [];
    for (let p = 0; p < tudo.length; p += tam) r.push(...d.alimentar(tudo.slice(p, p + tam)));
    r.push(...d.fim());
    assert.deepEqual(r, esperado, `pedaços de ${tam}`);
  }
  // um corte só, em cada posição
  for (let p = 0; p <= tudo.length; p++) {
    const d = new DivisorScript();
    assert.deepEqual([...d.alimentar(tudo.slice(0, p)), ...d.alimentar(tudo.slice(p)), ...d.fim()], esperado, `corte em ${p}`);
  }
});

test('DivisorScript: instrução maior que os pedaços', () => {
  const grande = "insert into t values ('" + "a;'',\\'".repeat(300_000) + "')"; // 2,4 MB num texto só
  const d = new DivisorScript();
  const r: string[] = [];
  const script = `select 1;${grande};select 2`;
  for (let p = 0; p < script.length; p += 1000) r.push(...d.alimentar(script.slice(p, p + 1000)));
  r.push(...d.fim());
  assert.deepEqual(r, ['select 1', grande, 'select 2']);
});
