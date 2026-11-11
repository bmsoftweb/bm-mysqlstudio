/**
 * Comparação de esquemas e de dados entre dois bancos (podem estar em servidores diferentes), geração do script
 * de sincronização e o DDL do editor de tabela. Porte do uCompareLogic.pas (os nomes do Pascal em camelCase, para
 * dar para conferir com a unit). Sem UI: testado em compareLogic.test.ts.
 */
import { Alvo, Campo, Conexao, Conjunto, Valor, consulta, escalar, linhas, listarConexoes, rodar } from './api';
import { TIPO, base64ParaBytes, bytesDe, bytesParaBase64, bytesParaHex, comBanco, ehBinario, ehGrande, ehNumero, getCreate, lerGrande, milhar, q } from './db';

export const OnlySrc = 'Só na origem';
export const OnlyTgt = 'Só no destino';
export const DiffSt = 'Diferente';
export const Same = 'Igual';
// Situação do registro em TableDiff.rows (1º caractere da linha; o resto é a chave).
export const RecSrc = '<';
export const RecTgt = '>';
export const RecDiff = '!';
export const RecSame = '=';

export interface SchemaObj {
  objType: string;
  name: string;
  srcDdl: string;
  tgtDdl: string;
  status: string;
  hasSrc: boolean;
  hasTgt: boolean;
}

export class TableDef {
  colOrder: string[] = [];
  cols = new Map<string, string>();
  keys = new Map<string, string>();
  fks = new Map<string, string>();
  options = '';
}

/**
 * Diferenças de uma tabela. rows: uma linha por registro, situação (RecSrc...) + chave, para a grade de
 * resultado. ins/upd/del: os comandos, em pedaços de texto (o script é o join('') deles).
 */
export class TableDiff {
  note = '';
  key = '';
  equal = 0;
  insCount = 0;
  updCount = 0;
  delCount = 0;
  /** Colunas em comum (ordem da origem) */
  cols: string[] = [];
  /** Colunas da chave usada */
  keyCols: string[] = [];
  /** Por coluna: entra na comparação (opções e mapeamento) */
  compared: boolean[] = [];
  /** Por coluna: registros diferentes nela */
  colDiffs: number[] = [];
  // ponytail: no Pascal eram arquivos temporários; aqui ficam na memória da aba. Script de GB não cabe: o caminho
  // seria gravar em OPFS/arquivo (Gravador do db.ts) e ler em streaming no writeDataScript.
  ins: string[] = [];
  upd: string[] = [];
  del: string[] = [];
  rows: string[] = [];
  /** Tamanho do INSERT / DELETE agrupado ainda aberto (0 = nenhum), enquanto a tabela é comparada */
  insSize = 0;
  delSize = 0;

  constructor(public table: string) {}
}

/**
 * Ajuste de uma tabela no mapeamento. key: índice usado para casar os registros ('' = o padrão: a PRIMARY, ou
 * o primeiro índice único sem coluna nula); ignore: colunas fora da comparação.
 */
export interface TableMap {
  table: string;
  key: string;
  skip: boolean;
  ignore: string[];
}

/** Opções da comparação de dados, como no dbForge. maps: só as tabelas com ajuste no mapeamento. */
export interface CompareOptions {
  ignoreCase: boolean;
  trimSpaces: boolean;
  ignoreEol: boolean;
  nullIsEmpty: boolean;
  /** Máscaras separadas por vírgula ou ponto e vírgula: atualizado_em, *_em */
  ignoreCols: string;
  maps: TableMap[];
}

/**
 * Tabela que existe nos dois bancos: colunas em comum (ordem da origem) e índices que servem de chave (a PRIMARY
 * primeiro); keyCols[i]: colunas do índice keys[i], separadas por vírgula.
 */
export interface MapTable {
  table: string;
  cols: string[];
  keys: string[];
  keyCols: string[];
}

/**
 * Registro na grade de resultado: valores dos dois lados (o array null = o lado não tem o registro; o valor
 * null = nulo) e as colunas com valor diferente.
 */
export interface RecView {
  state: string;
  src: (string | null)[] | null;
  tgt: (string | null)[] | null;
  diff: boolean[];
}

/** Trigger do destino: o script de dados apaga antes e cria de novo no fim (o MySQL não tem DISABLE TRIGGER). */
export interface Trigger {
  table: string;
  name: string;
  ddl: string;
}

/** Opções do script de dados (assistente de sincronização). */
export interface SyncOptions {
  ins: boolean;
  upd: boolean;
  del: boolean;
  useDb: boolean;
  noFks: boolean;
  comments: boolean;
  /** 0: uma transação só (tudo ou nada) */
  commitEvery: number;
  /** Scripts do usuário, antes e depois dos dados */
  before: string;
  after: string;
  triggers: Trigger[];
}

/** Estrutura editada no editor de tabela. orig: nome da coluna ao carregar ('' = coluna nova). */
export interface ColSpec {
  name: string;
  orig: string;
  colType: string;
  /** A expressão SQL: 0, 'abc', CURRENT_TIMESTAMP */
  default: string;
  extra: string;
  comment: string;
  notNull: boolean;
  pk: boolean;
  autoInc: boolean;
}

export interface IdxSpec {
  name: string;
  /** INDEX, UNIQUE, FULLTEXT ou SPATIAL */
  kind: string;
  /** "a, b(10)" */
  cols: string;
}

export interface FkSpec {
  name: string;
  cols: string;
  refTable: string;
  refCols: string;
  onDelete: string;
  onUpdate: string;
}

export interface TableSpec {
  name: string;
  engine: string;
  comment: string;
  cols: ColSpec[];
  idx: IdxSpec[];
  fks: FkSpec[];
}

/** Destino de texto (o TStream do Pascal): um Gravador do db.ts, ou qualquer coisa que junte os pedaços. */
export interface Saida {
  escrever(texto: string): Promise<void> | void;
}

/** Andamento e cancelamento das funções demoradas. */
export interface Andamento {
  progresso?: (texto: string) => void;
  sinal?: AbortSignal;
}

// ==========================================================
// Equivalentes do SysUtils/StrUtils
// ==========================================================
/** Trim do Delphi: espaço e caracteres de controle das pontas. */
const trim = (s: string) => s.replace(/^[\0-\x20]+|[\0-\x20]+$/g, '');

/** SameText/MatchText/IndexText: igual sem diferença de maiúsculas. */
const mesmoTexto = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** CompareText: ordinal, com as letras ASCII em maiúsculas. */
function compareText(a: string, b: string): number {
  const x = a.replace(/[a-z]+/g, (m) => m.toUpperCase());
  const y = b.replace(/[a-z]+/g, (m) => m.toUpperCase());
  return x < y ? -1 : x > y ? 1 : 0;
}

function conferir(op?: Andamento) {
  if (op?.sinal?.aborted) throw new DOMException('Cancelado', 'AbortError');
}

/** fn sobre cada item, até n ao mesmo tempo; o resultado sai na ordem dos itens. */
async function emParalelo<T, R>(itens: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const r = new Array<R>(itens.length);
  let i = 0;
  const fila = async () => {
    while (i < itens.length) {
      const k = i++;
      try {
        r[k] = await fn(itens[k]);
      } catch (e) {
        i = itens.length; // um erro para as outras filas: não continuam consultando à toa
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, fila));
  return r;
}

const paraLista = (l: string[]): Saida => ({
  escrever: (t) => {
    l.push(t);
  },
});

// ==========================================================
// Opções
// ==========================================================
export function newCompareOptions(): CompareOptions {
  return { ignoreCase: false, trimSpaces: false, ignoreEol: false, nullIsEmpty: false, ignoreCols: '', maps: [] };
}

export function mapOf(o: CompareOptions, table: string): TableMap {
  return o.maps.find((m) => mesmoTexto(m.table, table)) ?? { table, key: '', skip: false, ignore: [] };
}

// ponytail: máscara só com * e ? (o MatchesMask do Delphi também aceita conjuntos [a-z]; aqui o [ é literal)
function matchesMask(s: string, mask: string): boolean {
  const re = mask.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : '\\' + ch));
  return new RegExp('^' + re + '$', 'is').test(s);
}

export function ignored(o: CompareOptions, table: string, col: string): boolean {
  let r = mapOf(o, table).ignore.some((c) => mesmoTexto(c, col));
  for (const s of o.ignoreCols.split(/[,;]/)) if (!r && trim(s) !== '') r = matchesMask(col, trim(s));
  return r;
}

/** Compara dois literais do lit: texto vem entre aspas e escapado pelo escapeStr (a quebra de linha vira \n); nulo é NULL. */
export function sameValue(o: CompareOptions, a: string, b: string): boolean {
  const norm = (l: string) => {
    let r = l;
    if (o.nullIsEmpty && r === 'NULL') r = "''";
    if (!r.startsWith("'")) return r;
    if (o.ignoreEol) r = r.replaceAll('\\r\\n', '\\n');
    if (o.trimSpaces) r = "'" + trim(r.slice(1, -1)) + "'";
    if (o.ignoreCase) r = r.toUpperCase();
    return r;
  };
  return a === b || ((o.ignoreCase || o.trimSpaces || o.ignoreEol || o.nullIsEmpty) && norm(a) === norm(b));
}

/** Como o dbForge, mas numa transação só. */
export function newSyncOptions(ins: boolean, upd: boolean, del: boolean): SyncOptions {
  return { ins, upd, del, useDb: true, noFks: true, comments: true, commitEvery: 0, before: '', after: '', triggers: [] };
}

/** Linhas da tabela que o script altera. */
export function changes(o: SyncOptions, d: TableDiff): number {
  return (o.ins ? d.insCount : 0) + (o.upd ? d.updCount : 0) + (o.del ? d.delCount : 0);
}

// ==========================================================
// Esquema
// ==========================================================
/** Tira o que não é diferença real de estrutura: contador do auto incremento, DEFINER e o nome do próprio banco. */
export function normalize(ddl: string, db: string): string {
  return trim(
    ddl
      .replace(/ AUTO_INCREMENT=\d+/g, '')
      .replace(/DEFINER=`(?:[^`]|``)*`@`(?:[^`]|``)*`\s*/g, '')
      .replaceAll(q(db) + '.', '')
      .replaceAll('\r\n', '\n'),
  );
}

async function loadObjs(a: Alvo, db: string, src: boolean, map: Map<string, SchemaObj>, list: SchemaObj[], op?: Andamento): Promise<void> {
  const all = (
    await Promise.all([
      linhas(a, "SELECT IF(table_type='BASE TABLE','TABLE','VIEW'), table_name FROM information_schema.tables WHERE table_schema=?", [db]),
      linhas(a, 'SELECT routine_type, routine_name FROM information_schema.routines WHERE routine_schema=?', [db]),
      linhas(a, "SELECT 'TRIGGER', trigger_name FROM information_schema.triggers WHERE trigger_schema=?", [db]),
    ])
  ).flat();
  let feitos = 0;
  // Um SHOW CREATE por objeto: até 4 ao mesmo tempo (o pool do servidor tem 6 conexões)
  const ddls = await emParalelo(all, 4, async (r) => {
    conferir(op);
    const ddl = await getCreate(a, r[0], db, r[1]);
    op?.progresso?.(`${db}: ${++feitos} de ${all.length} objetos`);
    return ddl === '' ? '-- sem permissão para ver a definição' : normalize(ddl, db);
  });
  all.forEach((r, i) => {
    const key = r[0] + ' ' + r[1];
    let o = map.get(key);
    if (!o) {
      o = { objType: r[0], name: r[1], srcDdl: '', tgtDdl: '', status: '', hasSrc: false, hasTgt: false };
      map.set(key, o);
      list.push(o);
    }
    if (src) {
      o.srcDdl = ddls[i];
      o.hasSrc = true;
    } else {
      o.tgtDdl = ddls[i];
      o.hasTgt = true;
    }
  });
}

const TYPE_RANK = ['TABLE', 'VIEW', 'FUNCTION', 'PROCEDURE', 'TRIGGER'];

export async function compareSchemas(a1: Alvo, db1: string, a2: Alvo, db2: string, op?: Andamento): Promise<SchemaObj[]> {
  const r: SchemaObj[] = [];
  const map = new Map<string, SchemaObj>();
  await loadObjs(a1, db1, true, map, r, op);
  await loadObjs(a2, db2, false, map, r, op);
  for (const o of r) o.status = !o.hasTgt ? OnlySrc : !o.hasSrc ? OnlyTgt : o.srcDdl === o.tgtDdl ? Same : DiffSt;
  return r.sort((x, y) => TYPE_RANK.indexOf(x.objType) - TYPE_RANK.indexOf(y.objType) || compareText(x.name, y.name));
}

/** Rotinas e triggers levam DELIMITER: o corpo tem ';' (vale no executor de script e no cliente mysql). */
function createStmt(o: SchemaObj): string {
  return o.objType === 'TABLE' || o.objType === 'VIEW' ? o.srcDdl + ';' : 'DELIMITER $$\n' + o.srcDdl + '$$\nDELIMITER ;';
}

export function schemaScript(objs: SchemaObj[]): string {
  const pre: string[] = [];
  const main: string[] = [];
  const post: string[] = [];
  for (const o of objs) {
    const drop = `DROP ${o.objType} IF EXISTS ${q(o.name)};\n`;
    if (o.status === OnlyTgt) main.push(drop + '\n');
    else if (o.status === DiffSt && o.objType === 'TABLE') alterTable(o.name, o.srcDdl, o.tgtDdl, pre, main, post);
    else if (o.status === OnlySrc || o.status === DiffSt) {
      if (o.status === DiffSt) main.push(drop);
      main.push(createStmt(o) + '\n\n');
    }
  }
  if (pre.length + main.length + post.length === 0) return '';
  // FK desligada para criar tabelas fora da ordem de dependência.
  return (
    'SET FOREIGN_KEY_CHECKS = 0;\n\n' + pre.join('') + (pre.length ? '\n' : '') + main.join('') + post.join('') + (post.length ? '\n' : '') + 'SET FOREIGN_KEY_CHECKS = 1;\n'
  );
}

/** s[start] é a crase de abertura; devolve o identificador (com `` desfeito). */
function ident(s: string, start: number): string {
  let r = '';
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] !== '`') r += s[i];
    else if (s[i + 1] === '`') {
      r += '`';
      i++;
    } else break;
  }
  return r;
}

/** Lê o SHOW CREATE TABLE linha a linha: colunas, índices, FKs e opções da tabela. */
export function parseTable(ddl: string): TableDef {
  const r = new TableDef();
  const lines = ddl.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const t = trim(lines[i]).replace(/,+$/, '');
    if (t.startsWith('`')) {
      const n = ident(t, 0);
      r.colOrder.push(n);
      r.cols.set(n, t);
    } else if (t.startsWith('PRIMARY KEY')) r.keys.set('PRIMARY', t);
    else if (t.startsWith('CONSTRAINT')) {
      const n = ident(t, t.indexOf('`'));
      if (t.includes(' FOREIGN KEY ')) r.fks.set(n, t);
      else r.keys.set(n, t);
    } else if (t.includes('KEY `')) r.keys.set(ident(t, t.indexOf('`')), t);
    else if (t.startsWith(')')) r.options = trim(t.slice(1));
  }
  return r;
}

function dropKey(name: string, def: string): string {
  if (def.startsWith('PRIMARY KEY')) return 'DROP PRIMARY KEY';
  if (def.startsWith('CONSTRAINT')) return 'DROP CHECK ' + q(name);
  return 'DROP INDEX ' + q(name);
}

/**
 * Colunas em comum que mudam de lugar para t ficar na ordem de s: as de fora da maior sequência que já está na
 * ordem (essas ficam onde estão). Assim subir uma coluna move uma só.
 */
function movedCols(s: TableDef, t: TableDef): string[] {
  const names = s.colOrder.filter((n) => t.cols.has(n));
  const p: number[] = [];
  const len: number[] = [];
  const from: number[] = [];
  let best = -1;
  for (let i = 0; i < names.length; i++) {
    p[i] = t.colOrder.indexOf(names[i]);
    len[i] = 1;
    from[i] = -1;
    for (let j = 0; j < i; j++)
      if (p[j] < p[i] && len[j] + 1 > len[i]) {
        len[i] = len[j] + 1;
        from[i] = j;
      }
    if (best < 0 || len[i] > len[best]) best = i;
  }
  const r = [...names];
  for (; best >= 0; best = from[best]) r.splice(r.indexOf(names[best]), 1);
  return r;
}

/**
 * ALTER TABLE que leva a tabela de tgtDdl para srcDdl. pre, main, post: listas de pedaços de texto (o
 * TStringBuilder do Pascal; o texto é o join('')). FKs saem antes (pre) e voltam depois (post) para não travar
 * alteração de colunas/índices usados por elas.
 * order (editor de tabela): também leva a ordem das colunas; a comparação de esquemas não sincroniza a ordem.
 * As colunas fora de lugar vão como MODIFY ... AFTER, na ordem final (o MySQL posiciona uma a uma, nessa ordem).
 * ren (editor de tabela): nome novo -> nome no banco das colunas renomeadas; tgtDdl já vem com o nome novo. Elas
 * vão como CHANGE COLUMN com a definição inteira, no mesmo ALTER: renomear e mudar o tipo é um comando só, que
 * ou entra inteiro ou não entra (em dois, a falha do segundo deixava a coluna renomeada pela metade).
 */
export function alterTable(
  name: string,
  srcDdl: string,
  tgtDdl: string,
  pre: string[],
  main: string[],
  post: string[],
  order = false,
  ren?: Map<string, string>,
): void {
  const s = parseTable(srcDdl);
  const t = parseTable(tgtDdl);
  const c: string[] = [];
  const moved = movedCols(s, t);
  const qn = q(name);
  for (const [k, v] of t.keys) if (s.keys.get(k) !== v) c.push(dropKey(k, v));
  let prev = '';
  for (const n of s.colOrder) {
    const at = prev === '' ? ' FIRST' : ' AFTER ' + q(prev);
    const sd = s.cols.get(n) ?? '';
    const td = t.cols.get(n);
    const de = ren?.get(n);
    if (td === undefined) c.push('ADD COLUMN ' + sd + at);
    else if (de !== undefined) c.push(`CHANGE COLUMN ${q(de)} ${sd}` + (order && moved.includes(n) ? at : ''));
    else if (order && moved.includes(n)) c.push('MODIFY COLUMN ' + sd + at);
    else if (td !== sd) c.push('MODIFY COLUMN ' + sd);
    prev = n;
  }
  for (const n of t.colOrder) if (!s.cols.has(n)) c.push('DROP COLUMN ' + q(n));
  for (const [k, v] of s.keys) if (t.keys.get(k) !== v) c.push('ADD ' + v);
  if (s.options !== t.options) c.push(s.options);
  const before = pre.length + post.length;
  for (const [k, v] of t.fks) if (s.fks.get(k) !== v) pre.push(`ALTER TABLE ${qn} DROP FOREIGN KEY ${q(k)};\n`);
  for (const [k, v] of s.fks) if (t.fks.get(k) !== v) post.push(`ALTER TABLE ${qn} ADD ${v};\n`);
  if (c.length > 0) main.push(`ALTER TABLE ${qn}\n  ${c.join(',\n  ')};\n\n`);
  else if (pre.length + post.length === before) main.push(`-- ${qn}: difere só na ordem das colunas (não sincronizado)\n\n`);
}

// ==========================================================
// Dados
// ==========================================================
const ESCAPES: Record<string, string> = { '\0': '\\0', '\n': '\\n', '\r': '\\r', '\x1a': '\\Z', "'": "\\'", '"': '\\"', '\\': '\\\\' };

export function escapeStr(s: string): string {
  return s.replace(/[\0\n\r\x1a'"\\]/g, (ch) => ESCAPES[ch]);
}

const NUMERO = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

/**
 * Literal SQL do valor de um campo (o Lit(F: TField) do Pascal). Valor que não veio na resposta ({ bin: null },
 * acima de 1 MB) precisa ser lido antes com o lerGrande: as leituras daqui fazem isso.
 */
export function lit(v: Valor, campo: Campo): string {
  if (v === null) return 'NULL';
  if (typeof v === 'object') {
    if (v.bin === null) throw new Error(`O valor da coluna ${campo.nome} é grande demais para vir na consulta.`);
    return "X'" + bytesParaHex(base64ParaBytes(v.bin)) + "'";
  }
  if (typeof v === 'number') return String(v);
  // DECIMAL, BIGINT e BIT chegam como texto para não perder precisão; a regex não deixa passar nada que não seja número
  if (ehNumero(campo) && NUMERO.test(v)) return v;
  if (campo.tipo === TIPO.DATETIME || campo.tipo === TIPO.TIMESTAMP) {
    // fração só quando tem, como no dbForge: .000000 some, .120000 vira .120
    v = v.replace(/\.(\d+)$/, (_, f: string) => {
      const z = f.replace(/0+$/, '');
      return z ? '.' + z.padEnd(3, '0') : '';
    });
  }
  // ponytail: GEOMETRY chega do servidor como JSON, não como WKB: o literal serve para comparar, não para o
  // INSERT/UPDATE do script. Se precisar, ler a coluna com ST_AsBinary.
  return "'" + escapeStr(v) + "'";
}

/**
 * Junta itens num comando só ("INSERT ... VALUES (a),(b)" ou "DELETE ... IN (a, b)") até ~limit caracteres,
 * como o "Bulk Insert" do dbForge. size: tamanho do comando aberto (0 = nenhum); tail fecha o comando.
 * Devolve o novo size (o "var Size" do Pascal).
 */
export async function bulkAdd(s: Saida, size: number, head: string, item: string, tail: string, limit = 300 * 1024): Promise<number> {
  if (size > 0 && size + item.length > limit) size = await bulkEnd(s, size, tail);
  if (size === 0) {
    await s.escrever(head + item);
    return head.length + item.length;
  }
  await s.escrever(',\n' + item);
  return size + item.length + 2;
}

/** Fecha o comando aberto, se houver. Devolve o novo size (0). */
export async function bulkEnd(s: Saida, size: number, tail: string): Promise<number> {
  if (size > 0) await s.escrever(tail + '\n');
  return 0;
}

function qList(names: string[]): string {
  return names.map(q).join(', ');
}

/** Colunas da chave no SQL: `a`, ou (`a`, `b`) na chave composta (comparado com o keyVal). pki: posição em d.cols. */
function keySql(d: TableDiff): { keyList: string; pki: number[] } {
  const pki = d.keyCols.map((k) => d.cols.findIndex((c) => mesmoTexto(c, k)));
  const keyList = qList(d.keyCols);
  return { keyList: pki.length > 1 ? '(' + keyList + ')' : keyList, pki };
}

/** Valor da chave no SQL: x, ou (x, y) na chave composta. Serve também de chave dos mapas. */
function keyVal(v: string[], pki: number[]): string {
  const r = pki.map((j) => v[j]).join(', ');
  return pki.length > 1 ? '(' + r + ')' : r;
}

/**
 * Começo da comparação de uma tabela: escolhe a chave (mapeamento, ou a primeira) e as colunas comparadas.
 * Sem chave que sirva, volta só com o note e cols vazio: a tabela não é comparada.
 */
export function prepareDiff(t: MapTable, o: CompareOptions): TableDiff {
  const d = new TableDiff(t.table);
  const m = mapOf(o, t.table);
  const ki = m.key === '' ? 0 : t.keys.findIndex((k) => mesmoTexto(k, m.key));
  if (ki < 0 || ki >= t.keys.length) {
    d.note = m.key === '' ? 'sem chave primária nem índice único, não comparada' : `o índice ${m.key} não existe mais, não comparada`;
    return d;
  }
  d.cols = t.cols;
  d.key = t.keys[ki];
  d.keyCols = t.keyCols[ki].split(',');
  const { pki } = keySql(d);
  if (pki.some((i) => i < 0)) {
    d.note = `chave ${d.key} ausente no destino`;
    d.cols = [];
    return d;
  }
  if (d.key !== 'PRIMARY') d.note = 'chave: ' + d.key;
  d.compared = t.cols.map((c) => !ignored(o, t.table, c));
  d.colDiffs = t.cols.map(() => 0);
  for (const i of pki) d.compared[i] = true; // a chave casa os registros: sempre igual
  return d;
}

/**
 * A parte pura da comparação: um bloco da origem (src, na ordem da chave) contra as linhas do destino na mesma
 * faixa de chave (tgt, em páginas), todas já como literais do lit. Os registros são casados pelo literal da chave,
 * num mapa: a ordem e a faixa ficam com o servidor.
 * Os comandos vão para o TableDiff: DELETE e INSERT agrupados, UPDATE um por linha (só das colunas comparadas que
 * mudaram). Em rows, o bloco sai na ordem da origem e os que só existem no destino no fim. Depois do último
 * bloco, chamar o mergeEnd.
 */
export async function mergeChunk(d: TableDiff, o: CompareOptions, src: string[][], tgt: Iterable<string[][]> | AsyncIterable<string[][]>): Promise<void> {
  const { keyList, pki } = keySql(d);
  const qt = q(d.table); // sem o banco: o script roda no destino, depois do USE
  const colList = qList(d.cols);
  const where = (v: string[]) => ' WHERE ' + pki.map((j) => `${q(d.cols[j])} = ${v[j]}`).join(' AND ');
  const porChave = new Map<string, string[]>();
  const st = new Map<string, string>();
  const order: string[] = [];
  const tgtOnly: string[] = [];
  for (const v of src) {
    const k = keyVal(v, pki);
    porChave.set(k, v);
    order.push(k);
  }
  // Destino: igual, diferente ou só no destino.
  for await (const pagina of tgt)
    for (const tv of pagina) {
      const k = keyVal(tv, pki);
      const v = porChave.get(k);
      if (v) {
        let s = '';
        for (let i = 0; i < v.length; i++)
          if (d.compared[i] && !sameValue(o, v[i], tv[i])) {
            s += (s !== '' ? ', ' : '') + q(d.cols[i]) + ' = ' + v[i];
            d.colDiffs[i]++;
          }
        if (s === '') {
          d.equal++;
          st.set(k, RecSame);
        } else {
          d.upd.push(`UPDATE ${qt} SET ${s}${where(v)};\n`);
          d.updCount++;
          st.set(k, RecDiff);
        }
      } else {
        d.delSize = await bulkAdd(paraLista(d.del), d.delSize, `DELETE FROM ${qt} WHERE ${keyList} IN (`, k, ');');
        d.delCount++;
        tgtOnly.push(k);
      }
    }
  // Na ordem da chave da origem; o que não casou só existe na origem.
  for (const k of order) {
    const ch = st.get(k);
    if (ch) d.rows.push(ch + k);
    else {
      d.insSize = await bulkAdd(paraLista(d.ins), d.insSize, `INSERT INTO ${qt} (${colList}) VALUES\n`, '(' + (porChave.get(k) ?? []).join(', ') + ')', ';');
      d.insCount++;
      d.rows.push(RecSrc + k);
    }
  }
  for (const k of tgtOnly) d.rows.push(RecTgt + k);
}

/** Fecha o INSERT e o DELETE agrupados que ficaram abertos no último bloco. */
export async function mergeEnd(d: TableDiff): Promise<void> {
  d.insSize = await bulkEnd(paraLista(d.ins), d.insSize, ';');
  d.delSize = await bulkEnd(paraLista(d.del), d.delSize, ');');
}

/** Troca os valores que não vieram na resposta (acima de 1 MB) pelo valor inteiro, lido em pedaços pela chave. */
async function resolverGrandes(alvo: Alvo, from: string, d: TableDiff, pki: number[], c: Conjunto): Promise<void> {
  for (const l of c.linhas)
    for (let i = 0; i < l.length; i++) {
      if (!ehGrande(l[i])) continue;
      const bin = ehBinario(c.campos[i]);
      const where = pki.map((j) => `${q(d.cols[j])} = ${lit(l[j], c.campos[j])}`).join(' AND ');
      // Texto: convertido para utf8mb4 no servidor, para os bytes virem em UTF-8 seja qual for o charset da coluna
      const b = await lerGrande(alvo, bin ? q(d.cols[i]) : `CONVERT(${q(d.cols[i])} USING utf8mb4)`, `FROM ${from} WHERE ${where}`);
      l[i] = bin ? { bin: bytesParaBase64(b) } : new TextDecoder().decode(b);
    }
}

/**
 * Linhas de from (como literais) com a chave em (apos, ate], na ordem da chave, em páginas de até n linhas;
 * '' = sem esse limite da faixa. max > 0: para ao completar max linhas. O navegador não tem cursor: cada página
 * é um SELECT ... WHERE chave > última lida ORDER BY chave LIMIT n. A resposta pode vir cortada pelo tamanho
 * (truncado): continua da última chave recebida; só acabou quando vem menos que o pedido sem estar cortada.
 */
// ponytail: chave composta vai como (a, b) > (x, y), como no Pascal; o MySQL não usa bem o índice nessa forma e
// tabela grande pode estourar o tempo da requisição. O caminho é a >= x AND (a > x OR b > y).
async function* paginas(alvo: Alvo, from: string, d: TableDiff, apos: string, ate: string, n: number, max = 0, op?: Andamento): AsyncGenerator<string[][]> {
  const { keyList, pki } = keySql(d);
  for (let lidas = 0; ; ) {
    conferir(op);
    const pedir = max > 0 ? Math.min(n, max - lidas) : n;
    const w = [apos && `${keyList} > ${apos}`, ate && `${keyList} <= ${ate}`].filter(Boolean).join(' AND ');
    const c = await consulta(alvo, `SELECT ${qList(d.cols)} FROM ${from}${w && ' WHERE ' + w} ORDER BY ${qList(d.keyCols)} LIMIT ${pedir}`, undefined, pedir);
    await resolverGrandes(alvo, from, d, pki, c);
    const l = c.linhas.map((r) => r.map((v, i) => lit(v, c.campos[i])));
    if (l.length > 0) {
      const k = keyVal(l[l.length - 1], pki);
      // ex.: chave FLOAT, em que "chave > literal" devolve a própria linha de novo
      if (k === apos) throw new Error(`A leitura de ${from} não avança depois da chave ${k}.`);
      apos = k;
      lidas += l.length;
      yield l;
    } else if (c.truncado) throw new Error(`A consulta em ${from} veio cortada sem nenhuma linha.`);
    if ((!c.truncado && l.length < pedir) || (max > 0 && lidas >= max)) return;
  }
}

/**
 * Compara em blocos de chunk linhas da origem, na ordem da chave. Do destino lê só a faixa de chave do bloco,
 * aos poucos e sem guardar. A ordem e a faixa ficam com o servidor (collation da chave), então os dois lados
 * precisam usar a mesma collation na chave.
 */
async function compareTable(a1: Alvo, db1: string, a2: Alvo, db2: string, t: MapTable, o: CompareOptions, chunk: number, op?: Andamento): Promise<TableDiff> {
  const d = prepareDiff(t, o);
  if (d.cols.length === 0) return d;
  const { pki } = keySql(d);
  const from1 = q(db1) + '.' + q(t.table);
  const from2 = q(db2) + '.' + q(t.table);
  let last = '';
  let lidos = 0;
  for (;;) {
    // Bloco da origem: as chunk linhas seguintes pela chave.
    const src: string[][] = [];
    for await (const p of paginas(a1, from1, d, last, '', chunk, chunk, op)) for (const l of p) src.push(l);
    const lastChunk = src.length < chunk;
    const chunkLast = src.length > 0 ? keyVal(src[src.length - 1], pki) : '';
    // Destino na mesma faixa (no último bloco, até o fim da tabela).
    await mergeChunk(d, o, src, paginas(a2, from2, d, last, lastChunk ? '' : chunkLast, chunk, 0, op));
    lidos += src.length;
    op?.progresso?.(`${t.table}: ${milhar(lidos)} registros`);
    last = chunkLast;
    if (lastChunk) break;
  }
  await mergeEnd(d);
  return d;
}

/** Tira a largura de exibição dos inteiros: o MySQL 8 mostra "int" onde o 5.7 mostra "int(11)". */
function colType(t: string): string {
  return t.replace(/^(tinyint|smallint|mediumint|int|bigint)\(\d+\)/i, '$1');
}

// ponytail: aproxima a ordem do TStringList.Sort (AnsiCompareText do Windows) para estas linhas: símbolos <
// dígitos < letras, sem diferença de maiúsculas. Letra acentuada vai para depois do z.
function chaveOrdem(s: string): string {
  return s.toLowerCase().replace(/[0-9a-z\u00c0-\uffff]/g, (c) => (c <= '9' ? '\uffe0' : '\uffe1') + c);
}

/** Diferenças de estrutura entre os bancos (linhas: tabela, coluna, tipo), uma por linha. '': mesma estrutura. */
export function colsDiff(src: string[][], tgt: string[][]): string {
  const MaxLines = 10;
  type Dic = Map<string, [chave: string, tipo: string]>;
  // Chaves "tabela" e "tabela\tcoluna" (valor: o tipo); sem diferença de maiúsculas, como o mapTables.
  const load = (rows: string[][]): Dic => {
    const r: Dic = new Map();
    const set = (k: string, v: string) => r.set(k.toLowerCase(), [r.get(k.toLowerCase())?.[0] ?? k, v]);
    for (const l of rows) {
      set(l[0], '');
      set(l[0] + '\t' + l[1], colType(l[2]));
    }
    return r;
  };
  const a = load(src);
  const b = load(tgt);
  const l: string[] = [];
  // O que só existe em x. Coluna de tabela que nem existe em y não entra: a tabela já sai como "só".
  const only = (x: Dic, y: Dic, side: string) => {
    for (const [lk, [key]] of x) {
      const p = key.indexOf('\t');
      if (y.has(lk) || (p >= 0 && !y.has(key.slice(0, p).toLowerCase()))) continue;
      l.push(key.replace('\t', '.') + ': ' + (p < 0 ? 'tabela' : 'coluna') + ' só ' + side);
    }
  };
  only(a, b, 'na origem');
  only(b, a, 'no destino');
  for (const [lk, [key, ta]] of a) {
    const tb = b.get(lk)?.[1];
    if (key.includes('\t') && tb !== undefined && !mesmoTexto(ta, tb)) l.push(`${key.replace('\t', '.')}: ${ta} na origem, ${tb} no destino`);
  }
  l.sort((x, y) => {
    const kx = chaveOrdem(x);
    const ky = chaveOrdem(y);
    return kx < ky ? -1 : kx > ky ? 1 : 0;
  });
  if (l.length > MaxLines) l.splice(MaxLines, l.length, `... e mais ${l.length - MaxLines} diferença(s)`);
  return trim(l.join('\n'));
}

// ponytail: estes metadados vêm numa consulta só (o linhas dá erro se a resposta for cortada, ~3 MB); esquema
// com dezenas de milhares de colunas pediria ler por tabela.
const SQL_COLS_TIPO =
  'SELECT c.table_name, c.column_name, c.column_type FROM information_schema.columns c ' +
  'JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name ' +
  "AND t.table_type = 'BASE TABLE' WHERE c.table_schema = ?";

/** Tabela desmarcada no mapeamento e coluna ignorada não contam como diferença. */
export async function structDiff(a1: Alvo, db1: string, a2: Alvo, db2: string, o: CompareOptions): Promise<string> {
  const kept = (a: string[][]) => a.filter((r) => !mapOf(o, r[0]).skip && !ignored(o, r[0], r[1]));
  const [s, t] = await Promise.all([linhas(a1, SQL_COLS_TIPO, [db1]), linhas(a2, SQL_COLS_TIPO, [db2])]);
  return colsDiff(kept(s), kept(t));
}

const SQL_COLS_OF =
  'SELECT c.table_name, c.column_name FROM information_schema.columns c JOIN information_schema.tables t ' +
  "ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE' " +
  'WHERE c.table_schema = ? ORDER BY c.table_name, c.ordinal_position';
// Índices únicos sem coluna que aceite nulo: nulo não casa no WHERE nem na faixa da chave.
const SQL_KEYS_OF =
  'SELECT table_name, index_name, GROUP_CONCAT(column_name ORDER BY seq_in_index) ' +
  'FROM information_schema.statistics WHERE table_schema = ? AND non_unique = 0 GROUP BY table_name, index_name ' +
  "HAVING SUM(nullable = 'YES') = 0 ORDER BY table_name, index_name <> 'PRIMARY', index_name";

export async function mapTables(a1: Alvo, db1: string, a2: Alvo, db2: string): Promise<MapTable[]> {
  const [cols2, cols1, keys1] = await Promise.all([linhas(a2, SQL_COLS_OF, [db2]), linhas(a1, SQL_COLS_OF, [db1]), linhas(a1, SQL_KEYS_OF, [db1])]);
  const r: MapTable[] = [];
  // Sem diferença de maiúsculas, como na checagem de estrutura (colsDiff).
  const tgt = new Set(cols2.map((l) => (l[0] + '\t' + l[1]).toLowerCase()));
  const idx = new Map<string, number>();
  for (const l of cols1)
    if (tgt.has((l[0] + '\t' + l[1]).toLowerCase())) {
      let i = idx.get(l[0].toLowerCase());
      if (i === undefined) {
        i = r.length;
        r.push({ table: l[0], cols: [], keys: [], keyCols: [] });
        idx.set(l[0].toLowerCase(), i);
      }
      r[i].cols.push(l[1]);
    }
  for (const l of keys1) {
    const i = idx.get(l[0].toLowerCase());
    if (i !== undefined) {
      r[i].keys.push(l[1]);
      r[i].keyCols.push(l[2]);
    }
  }
  return r;
}

export async function compareData(a1: Alvo, db1: string, a2: Alvo, db2: string, o: CompareOptions, chunk = 5000, op?: Andamento): Promise<TableDiff[]> {
  const r: TableDiff[] = [];
  for (const t of await mapTables(a1, db1, a2, db2))
    if (!mapOf(o, t.table).skip) {
      conferir(op);
      op?.progresso?.(t.table);
      r.push(await compareTable(a1, db1, a2, db2, t, o, Math.max(1, Math.floor(chunk)), op));
    }
  return r;
}

/** Linhas de d.rows com uma das situações de states, até max. */
export function rowLines(d: TableDiff, states: string, max: number): string[] {
  const r: string[] = [];
  for (const l of d.rows) {
    if (r.length >= max) break;
    if (l !== '' && states.includes(l[0])) r.push(l);
  }
  return r;
}

/** Valor para a grade: texto como no app desktop (data dd/mm/aaaa, vírgula decimal); blob só o tamanho; null para nulo. */
function cellValue(v: Valor, c: Campo): string | null {
  if (v === null) return null;
  if (typeof v === 'object') return `(binário, ${bytesDe(v)?.length ?? v.bytes ?? 0} bytes)`;
  const s = String(v);
  if (c.tipo === TIPO.DATE || c.tipo === TIPO.DATETIME || c.tipo === TIPO.TIMESTAMP) return s.replace(/^(\d{4})-(\d\d)-(\d\d)/, '$3/$2/$1');
  if (c.tipo === TIPO.DECIMAL || c.tipo === TIPO.NEWDECIMAL || c.tipo === TIPO.FLOAT || c.tipo === TIPO.DOUBLE) return s.replace('.', ',');
  return s;
}

/** Valores dos dois bancos para as linhas from..from+count-1 de lines (do rowLines). */
export async function loadRecords(
  a1: Alvo,
  db1: string,
  a2: Alvo,
  db2: string,
  d: TableDiff,
  o: CompareOptions,
  lines: string[],
  from: number,
  count: number,
): Promise<RecView[]> {
  const { keyList, pki } = keySql(d);
  count = Math.max(0, Math.min(count, lines.length - from));
  const pagina = lines.slice(from, from + count);

  // Os registros das chaves keys num dos bancos: valores para a grade e literais para comparar.
  const buscar = async (alvo: Alvo, db: string, keys: string[]) => {
    const vals = new Map<string, (string | null)[]>();
    const lits = new Map<string, string[]>();
    const tabela = q(db) + '.' + q(d.table);
    while (keys.length > 0) {
      const c = await consulta(alvo, `SELECT ${qList(d.cols)} FROM ${tabela} WHERE ${keyList} IN (${keys.join(', ')})`);
      await resolverGrandes(alvo, tabela, d, pki, c);
      for (const l of c.linhas) {
        const r = l.map((v, i) => lit(v, c.campos[i]));
        vals.set(keyVal(r, pki), l.map((v, i) => cellValue(v, c.campos[i])));
        lits.set(keyVal(r, pki), r);
      }
      if (!c.truncado) break;
      // Resposta cortada pelo tamanho: pede de novo só as chaves que ainda não vieram.
      const faltam = keys.filter((k) => !lits.has(k));
      if (faltam.length === keys.length) throw new Error(`A consulta em ${tabela} veio cortada sem trazer os registros pedidos.`);
      keys = faltam;
    }
    return { vals, lits };
  };

  const [s, t] = await Promise.all([
    buscar(a1, db1, pagina.filter((l) => l[0] !== RecTgt).map((l) => l.slice(1))),
    buscar(a2, db2, pagina.filter((l) => l[0] !== RecSrc).map((l) => l.slice(1))),
  ]);
  return pagina.map((l) => {
    const k = l.slice(1);
    const a = s.lits.get(k);
    const b = t.lits.get(k);
    return {
      state: l[0],
      src: s.vals.get(k) ?? null,
      tgt: t.vals.get(k) ?? null,
      diff: d.cols.map((_, j) => a !== undefined && b !== undefined && d.compared[j] && !sameValue(o, a[j], b[j])),
    };
  });
}

/** dd/mm/aaaa hh:nn:ss na hora local (nunca toISOString: é UTC). */
function agora(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Comentário do início do script, como o do dbForge (consulta o cadastro das conexões e a versão dos servidores). */
export async function dataScriptHeader(a1: Alvo, db1: string, a2: Alvo, db2: string): Promise<string> {
  let conexoes: Conexao[] = [];
  try {
    conexoes = await listarConexoes();
  } catch {
    // sem o cadastro, fica só o número da conexão
  }
  const server = async (a: Alvo, db: string) => {
    const c = conexoes.find((x) => x.id === a.conexao);
    let r = db + ' em ' + (c ? c.servidor + (c.porta ? ':' + c.porta : '') : 'conexão ' + a.conexao);
    try {
      r += ' (MySQL ' + (await escalar(a, 'SELECT VERSION()')) + ')';
    } catch {
      // sem a versão, fica só o servidor
    }
    return r;
  };
  return (
    `--\n-- Script gerado pelo MySQL Studio em ${agora()}\n-- Origem: ${await server(a1, db1)}\n-- Destino: ${await server(a2, db2)}\n` +
    `-- Rode este script em ${db2} para sincronizá-lo com ${db1}\n--\n\n`
  );
}

function title(t: string, comments: boolean): string {
  return comments ? `--\n-- ${t}\n--\n` : '';
}

/**
 * Triggers das tabelas que o script altera, na ordem em que o MySQL dispara. Erro se algum não puder ser lido:
 * apagar sem ter o CREATE perderia o trigger.
 */
export async function loadTriggers(a: Alvo, db: string, tables: string[]): Promise<Trigger[]> {
  const r: Trigger[] = [];
  const todos = await linhas(
    a,
    'SELECT event_object_table, trigger_name FROM information_schema.triggers WHERE trigger_schema=? ORDER BY event_object_table, action_timing, event_manipulation, action_order',
    [db],
  );
  for (const l of todos)
    if (tables.some((t) => mesmoTexto(t, l[0]))) {
      const ddl = await getCreate(a, 'TRIGGER', db, l[1]);
      if (ddl === '') throw new Error(`Sem permissão para ler o trigger ${l[1]}.`);
      r.push({ table: l[0], name: l[1], ddl });
    }
  return r;
}

/** CREATE dos triggers, com DELIMITER: o corpo tem ';'. O $$ vai na linha de baixo (o DDL pode acabar em comentário). */
export function triggersOn(trs: Trigger[], comments: boolean): string {
  if (trs.length === 0) return '';
  let r = 'DELIMITER $$\n\n';
  for (const t of trs) r += title(`Liga de novo o trigger ${q(t.name)} da tabela ${q(t.table)}`, comments) + t.ddl + '\n$$\n\n';
  return r + 'DELIMITER ;\n\n';
}

/**
 * Depois de erro ou cancelamento na sincronização: cria os triggers que o script apagou e não chegou a recriar.
 * Cada CREATE vai como um comando (o servidor não interpreta DELIMITER), com db como banco da conexão: o DDL do
 * SHOW CREATE TRIGGER não traz o nome do banco.
 */
export async function restoreTriggers(a: Alvo, db: string, trs: Trigger[]): Promise<void> {
  const have = (await linhas(a, 'SELECT trigger_name FROM information_schema.triggers WHERE trigger_schema=?', [db])).map((l) => l[0]);
  const missing = trs.filter((t) => !have.some((h) => mesmoTexto(h, t.name)));
  if (missing.length > 0) await rodar(comBanco(a, db), missing.map((t) => t.ddl));
}

/**
 * Script de sincronização no formato do dbForge: cabeçalho, USE, script do usuário, triggers apagados, chaves
 * estrangeiras desligadas e, por tabela, DELETE, UPDATE e INSERT; no fim, o contrário. Nada escrito se não há
 * diferença. limit > 0: para depois de ~limit bytes (prévia na tela) e devolve false.
 * BEGIN, não START TRANSACTION: no TFDScript do app desktop, START no começo da linha é o comando "rodar o
 * arquivo"; no cliente mysql os dois são a mesma coisa (o script gerado aqui tem que rodar nos dois).
 */
export async function writeDataScript(s: Saida, header: string, db: string, diffs: TableDiff[], o: SyncOptions, limit = 0, op?: Andamento): Promise<boolean> {
  if (!diffs.some((d) => changes(o, d) > 0)) return true;
  const enc = new TextEncoder();
  let size = 0; // bytes (UTF-8) já escritos: o S.Size do Pascal; só contado quando há limite
  let count = 0;
  // Junta em lotes de ~1 MB: um escrever por linha seria uma gravação em disco por linha.
  let lote = '';
  const descarregar = async () => {
    conferir(op);
    if (lote !== '') await s.escrever(lote);
    lote = '';
  };
  const w = async (t: string) => {
    lote += t;
    if (limit > 0) size += enc.encode(t).length;
    if (lote.length >= 1_000_000) await descarregar();
  };

  const userScript = (txt: string, t: string) => {
    const r = trim(txt);
    return r === '' ? '' : title(t, o.comments) + r.replace(/\r\n?/g, '\n') + '\n\n';
  };

  // false: chegou no limite.
  const part = async (pedacos: string[], t: string): Promise<boolean> => {
    op?.progresso?.(t);
    await w(title(t, o.comments));
    if (o.commitEvery > 0) {
      // Linha a linha para contar os comandos: só o fim de comando termina a linha com ';' (os itens do INSERT e
      // do DELETE terminam com ',' e os literais escapam a quebra de linha).
      const linha = async (l: string) => {
        await w(l + '\n');
        if (l.endsWith(';') && ++count % o.commitEvery === 0) await w('COMMIT;\nBEGIN;\n');
        return limit === 0 || size < limit;
      };
      let resto = '';
      for (const p of pedacos) {
        const ls = (resto + p).split('\n');
        resto = ls.pop() ?? '';
        for (const l of ls) if (!(await linha(l))) return false;
      }
      if (resto !== '' && !(await linha(resto))) return false;
    } else
      for (const p of pedacos) {
        if (limit > 0) {
          const b = enc.encode(p);
          if (size + b.length > limit) {
            let n = Math.max(0, limit - size);
            while (n > 0 && (b[n] & 0xc0) === 0x80) n--; // não corta no meio de um caractere
            await w(new TextDecoder().decode(b.subarray(0, n)));
            return false;
          }
        }
        await w(p);
      }
    await w('\n'); // cortado não chega aqui: sem a quebra, quem mostra a prévia descarta a linha cortada no meio
    return true;
  };

  try {
    if (o.comments) await w(header);
    await w("SET NAMES 'utf8mb4';\n\n");
    if (o.useDb) await w(`USE ${q(db)};\n\n`);
    await w(userScript(o.before, 'Script do usuário antes da sincronização'));
    if (o.triggers.length > 0) {
      await w(title('Desliga os triggers (o MySQL não tem DISABLE TRIGGER: são apagados e criados de novo no fim)', o.comments));
      for (const t of o.triggers) await w(`DROP TRIGGER IF EXISTS ${q(t.name)};\n`);
      await w('\n');
    }
    if (o.noFks) await w(title('Desliga as chaves estrangeiras', o.comments) + 'SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;\n\n');
    await w('BEGIN;\n\n');
    for (const d of diffs) {
      if (o.del && d.delCount > 0 && !(await part(d.del, 'Excluindo dados da tabela ' + q(d.table)))) return false;
      if (o.upd && d.updCount > 0 && !(await part(d.upd, 'Atualizando dados da tabela ' + q(d.table)))) return false;
      if (o.ins && d.insCount > 0 && !(await part(d.ins, 'Inserindo dados na tabela ' + q(d.table)))) return false;
    }
    await w('COMMIT;\n\n');
    if (o.noFks) await w(title('Liga as chaves estrangeiras de novo', o.comments) + 'SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;\n\n');
    await w(triggersOn(o.triggers, o.comments));
    await w(userScript(o.after, 'Script do usuário depois da sincronização'));
    return true;
  } finally {
    await descarregar();
  }
}

// ==========================================================
// Editor de tabela
// ==========================================================
/** ColSpec com os campos não informados vazios (o record do Pascal nasce zerado). */
export function newColSpec(c: Partial<ColSpec> = {}): ColSpec {
  return { name: '', orig: '', colType: '', default: '', extra: '', comment: '', notNull: false, pk: false, autoInc: false, ...c };
}

/** "a, b(10)" -> [nome, "(10)"] de cada item */
function nomeTamanho(item: string): [string, string] {
  const n = trim(item);
  const p = n.indexOf('(');
  return p < 0 ? [n, ''] : [trim(n.slice(0, p)), n.slice(p)];
}

/** "a, b(10)" -> "`a`,`b`(10)" */
function identList(cols: string): string {
  return cols
    .split(',')
    .map(nomeTamanho)
    .filter(([n]) => n !== '')
    .map(([n, len]) => q(n) + len)
    .join(',');
}

function colDdl(c: ColSpec): string {
  let r = q(c.name) + ' ' + trim(c.colType);
  if (c.notNull) r += ' NOT NULL';
  if (trim(c.default) !== '') r += ' DEFAULT ' + trim(c.default);
  if (c.autoInc) r += ' AUTO_INCREMENT';
  if (trim(c.extra) !== '') r += ' ' + trim(c.extra);
  if (c.comment !== '') r += " COMMENT '" + escapeStr(c.comment) + "'";
  return r;
}

function fkRule(event: string, r: string): string {
  // RESTRICT e NO ACTION: padrão do MySQL
  return r === '' || mesmoTexto(r, 'RESTRICT') || mesmoTexto(r, 'NO ACTION') ? '' : ` ON ${event} ${r.toUpperCase()}`;
}

/** Uma definição por linha, como o SHOW CREATE TABLE: assim o alterTable compara a estrutura carregada com a editada. */
export function specDdl(t: TableSpec): string {
  const l = t.cols.map(colDdl);
  const pk = t.cols
    .filter((c) => c.pk)
    .map((c) => q(c.name))
    .join(',');
  if (pk !== '') l.push(`PRIMARY KEY (${pk})`);
  for (const i of t.idx) l.push((mesmoTexto(i.kind, 'INDEX') || i.kind === '' ? '' : i.kind.toUpperCase() + ' ') + `KEY ${q(i.name)} (${identList(i.cols)})`);
  for (const f of t.fks)
    l.push(
      `CONSTRAINT ${q(f.name)} FOREIGN KEY (${identList(f.cols)}) REFERENCES ${q(f.refTable)} (${identList(f.refCols)})` +
        fkRule('DELETE', f.onDelete) +
        fkRule('UPDATE', f.onUpdate),
    );
  let r = `CREATE TABLE ${q(t.name)} (\n  ${l.join(',\n  ')}\n) ENGINE=${t.engine === '' ? 'InnoDB' : t.engine}`;
  if (t.comment !== '') r += " COMMENT='" + escapeStr(t.comment) + "'";
  return r;
}

/** Script que leva a tabela de old para novo: RENAME TABLE e o ALTER da comparação, com as renomeadas como CHANGE COLUMN. */
export function designScript(old: TableSpec, novo: TableSpec, isNew: boolean): string {
  const newDdl = specDdl(novo);
  if (isNew) return newDdl + ';\n';
  // cópia: o original não pode ser alterado
  const o: TableSpec = { ...old, cols: old.cols.map((c) => ({ ...c })), idx: old.idx.map((i) => ({ ...i })), fks: old.fks.map((f) => ({ ...f })) };
  let r = '';
  if (novo.name !== old.name) {
    r = `RENAME TABLE ${q(old.name)} TO ${q(novo.name)};\n\n`;
    o.name = novo.name;
  }
  const map = new Map<string, string>(); // nome no banco -> nome novo
  const ren = new Map<string, string>(); // nome novo -> nome no banco
  for (const c of novo.cols)
    if (c.orig !== '' && c.orig !== c.name)
      for (const oc of o.cols)
        if (oc.name === c.orig) {
          map.set(c.orig, c.name);
          ren.set(c.name, c.orig);
          oc.name = c.name; // a comparação abaixo enxerga a coluna pelo nome novo
        }
  const mapList = (cols: string) =>
    cols
      .split(',')
      .map(nomeTamanho)
      .map(([n, len]) => (map.get(n) ?? n) + len)
      .join(', ');
  for (const i of o.idx) i.cols = mapList(i.cols);
  for (const f of o.fks) f.cols = mapList(f.cols);
  if (ren.size > 0 || newDdl !== specDdl(o)) {
    const pre: string[] = [];
    const main: string[] = [];
    const post: string[] = [];
    alterTable(novo.name, newDdl, specDdl(o), pre, main, post, true, ren);
    r += pre.join('') + (pre.length > 0 ? '\n' : '') + main.join('') + post.join('');
  }
  return r;
}

const TIPOS_TEXTO = ['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set', 'json'];
const TIPOS_NUMERO = ['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'float', 'double', 'real'];
const TIPOS_DATA = ['date', 'datetime', 'timestamp'];
const TIPOS_DECIMAIS = ['decimal', 'numeric', 'float', 'double', 'real'];

/** Valor de CSV no padrão BMsoft (1.234,56 e dd/mm/aaaa) como literal SQL, conforme o data_type da coluna. */
export function csvLit(v: string, dataType: string): string {
  const tipo = dataType.toLowerCase();
  if (TIPOS_TEXTO.includes(tipo)) return "'" + escapeStr(v) + "'";
  let s = trim(v);
  if (s === '') return 'NULL';
  if (TIPOS_NUMERO.includes(tipo) && s.includes(',')) s = s.replaceAll('.', '').replace(',', '.');
  else if (TIPOS_DATA.includes(tipo)) s = s.replace(/^(\d{2})\/(\d{2})\/(\d{4})(.*)$/, '$3-$2-$1$4');
  return "'" + escapeStr(s) + "'";
}

/**
 * Default digitado na grade do editor de tabela, como expressão SQL: em coluna de texto (ou data começando por
 * dígito), valor sem aspas ganha aspas: user -> 'user'. Sem isso o enum saía com DEFAULT user, erro de sintaxe.
 * Com aspas ou parênteses já é expressão e fica como foi digitado; NULL e CURRENT_TIMESTAMP também.
 */
export function defaultSql(v: string, colType: string): string {
  const s = trim(v);
  if (s === '' || mesmoTexto(s, 'NULL') || /['"(]/.test(s)) return s;
  const tipo = trim(colType).split(/[ (]/)[0].toLowerCase();
  const literal = TIPOS_TEXTO.includes(tipo) || ([...TIPOS_DATA, 'time'].includes(tipo) && /^\d/.test(s));
  return literal ? "'" + escapeStr(s) + "'" : s;
}

// Tipo de coluna da grade: "decimal(15,2) unsigned" <-> "decimal unsigned", "15", "2" (enum/set: os valores vão no tamanho).
export function hasDecimals(colType: string): boolean {
  return TIPOS_DECIMAIS.includes(trim(colType).split(/[ (]/)[0].toLowerCase());
}

export function splitType(colType: string): { base: string; size: string; dec: string } {
  const p = colType.indexOf('(');
  if (p < 0) return { base: trim(colType), size: '', dec: '' };
  const e = colType.lastIndexOf(')');
  const base = trim(colType.slice(0, p) + colType.slice(e + 1));
  let size = e > p ? colType.slice(p + 1, e) : '';
  let dec = '';
  if (hasDecimals(base) && size.includes(',')) {
    dec = trim(size.slice(size.indexOf(',') + 1));
    size = trim(size.slice(0, size.indexOf(',')));
  }
  return { base, size, dec };
}

export function joinType(base: string, size: string, dec: string): string {
  const b = trim(base);
  const p = b.includes(' ') ? b.indexOf(' ') : b.length;
  let r = b.slice(0, p);
  if (trim(size) !== '') r += '(' + trim(size) + (trim(dec) !== '' ? ',' + trim(dec) : '') + ')';
  return r + b.slice(p);
}
