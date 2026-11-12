// Texto SQL sem banco: quebra em tokens, acha a instrução do cursor e formata. Porte de ..\delphi\uSqlText.pas,
// mais o divisor de script (DivisorScript), que faz o papel do TFDScript no RunScript do uDb.pas.

export type TokKind = 'space' | 'word' | 'quoted' | 'string' | 'number' | 'comment' | 'lineComment' | 'symbol';

export interface SqlTok {
  kind: TokKind;
  text: string;
  start: number; // posição no texto, a partir de 0 (índice de string JS; no Pascal era a partir de 1)
}

export const sqlKeywords: string[] = [
  'ADD', 'ALL', 'ALTER', 'AND', 'AS', 'ASC', 'BETWEEN', 'BY', 'CASE', 'COLUMN', 'CREATE', 'CROSS', 'DATABASE',
  'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DROP', 'ELSE', 'END', 'EXISTS', 'EXPLAIN', 'FOREIGN', 'FROM',
  'GROUP', 'HAVING', 'IF', 'IN', 'INDEX', 'INNER', 'INSERT', 'INTO', 'IS', 'JOIN', 'KEY', 'LEFT', 'LIKE',
  'LIMIT', 'MODIFY', 'NATURAL', 'NOT', 'NULL', 'OFFSET', 'ON', 'OR', 'ORDER', 'OUTER', 'PRIMARY',
  'PROCEDURE', 'REFERENCES', 'REPLACE', 'RIGHT', 'SELECT', 'SET', 'SHOW', 'TABLE', 'THEN', 'TRIGGER',
  'TRUNCATE', 'UNION', 'UNIQUE', 'UPDATE', 'USE', 'USING', 'VALUES', 'VIEW', 'WHEN', 'WHERE', 'WITH',
  'STRAIGHT_JOIN',
];

// Palavras reservadas do MySQL 8 (+ algumas do MariaDB): como nome, só entre crases.
const reserved = new Set([
  'ACCESSIBLE', 'ADD', 'ALL', 'ALTER', 'ANALYZE', 'AND', 'AS', 'ASC', 'ASENSITIVE', 'BEFORE', 'BETWEEN', 'BIGINT',
  'BINARY', 'BLOB', 'BOTH', 'BY', 'CALL', 'CASCADE', 'CASE', 'CHANGE', 'CHAR', 'CHARACTER', 'CHECK', 'COLLATE',
  'COLUMN', 'CONDITION', 'CONSTRAINT', 'CONTINUE', 'CONVERT', 'CREATE', 'CROSS', 'CUBE', 'CUME_DIST', 'CURRENT_DATE',
  'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'CURRENT_USER', 'CURSOR', 'DATABASE', 'DATABASES', 'DAY_HOUR',
  'DAY_MICROSECOND', 'DAY_MINUTE', 'DAY_SECOND', 'DEC', 'DECIMAL', 'DECLARE', 'DEFAULT', 'DELAYED', 'DELETE',
  'DENSE_RANK', 'DESC', 'DESCRIBE', 'DETERMINISTIC', 'DISTINCT', 'DISTINCTROW', 'DIV', 'DOUBLE', 'DROP', 'DUAL',
  'EACH', 'ELSE', 'ELSEIF', 'EMPTY', 'ENCLOSED', 'ESCAPED', 'EXCEPT', 'EXISTS', 'EXIT', 'EXPLAIN', 'FALSE', 'FETCH',
  'FIRST_VALUE', 'FLOAT', 'FLOAT4', 'FLOAT8', 'FOR', 'FORCE', 'FOREIGN', 'FROM', 'FULLTEXT', 'FUNCTION', 'GENERATED',
  'GET', 'GRANT', 'GROUP', 'GROUPING', 'GROUPS', 'HAVING', 'HIGH_PRIORITY', 'HOUR_MICROSECOND', 'HOUR_MINUTE',
  'HOUR_SECOND', 'IF', 'IGNORE', 'IN', 'INDEX', 'INFILE', 'INNER', 'INOUT', 'INSENSITIVE', 'INSERT', 'INT', 'INT1',
  'INT2', 'INT3', 'INT4', 'INT8', 'INTEGER', 'INTERSECT', 'INTERVAL', 'INTO', 'IO_AFTER_GTIDS', 'IO_BEFORE_GTIDS',
  'IS', 'ITERATE', 'JOIN', 'JSON_TABLE', 'KEY', 'KEYS', 'KILL', 'LAG', 'LAST_VALUE', 'LATERAL', 'LEAD', 'LEADING',
  'LEAVE', 'LEFT', 'LIKE', 'LIMIT', 'LINEAR', 'LINES', 'LOAD', 'LOCALTIME', 'LOCALTIMESTAMP', 'LOCK', 'LONG',
  'LONGBLOB', 'LONGTEXT', 'LOOP', 'LOW_PRIORITY', 'MASTER_BIND', 'MASTER_SSL_VERIFY_SERVER_CERT', 'MATCH',
  'MAXVALUE', 'MEDIUMBLOB', 'MEDIUMINT', 'MEDIUMTEXT', 'MIDDLEINT', 'MINUTE_MICROSECOND', 'MINUTE_SECOND', 'MOD',
  'MODIFIES', 'NATURAL', 'NOT', 'NO_WRITE_TO_BINLOG', 'NTH_VALUE', 'NTILE', 'NULL', 'NUMERIC', 'OF', 'OFFSET', 'ON',
  'OPTIMIZE', 'OPTIMIZER_COSTS', 'OPTION', 'OPTIONALLY', 'OR', 'ORDER', 'OUT', 'OUTER', 'OUTFILE', 'OVER',
  'PARTITION', 'PERCENT_RANK', 'PRECISION', 'PRIMARY', 'PROCEDURE', 'PURGE', 'QUALIFY', 'RANGE', 'RANK', 'READ',
  'READS', 'READ_WRITE', 'REAL', 'RECURSIVE', 'REFERENCES', 'REGEXP', 'RELEASE', 'RENAME', 'REPEAT', 'REPLACE',
  'REQUIRE', 'RESIGNAL', 'RESTRICT', 'RETURN', 'RETURNING', 'REVOKE', 'RIGHT', 'RLIKE', 'ROW', 'ROWS', 'ROW_NUMBER',
  'SCHEMA', 'SCHEMAS', 'SECOND_MICROSECOND', 'SELECT', 'SENSITIVE', 'SEPARATOR', 'SET', 'SHOW', 'SIGNAL', 'SMALLINT',
  'SPATIAL', 'SPECIFIC', 'SQL', 'SQLEXCEPTION', 'SQLSTATE', 'SQLWARNING', 'SQL_BIG_RESULT', 'SQL_CALC_FOUND_ROWS',
  'SQL_SMALL_RESULT', 'SSL', 'STARTING', 'STORED', 'STRAIGHT_JOIN', 'SYSTEM', 'TABLE', 'TERMINATED', 'THEN',
  'TINYBLOB', 'TINYINT', 'TINYTEXT', 'TO', 'TRAILING', 'TRIGGER', 'TRUE', 'UNDO', 'UNION', 'UNIQUE', 'UNLOCK',
  'UNSIGNED', 'UPDATE', 'USAGE', 'USE', 'USING', 'UTC_DATE', 'UTC_TIME', 'UTC_TIMESTAMP', 'VALUES', 'VARBINARY',
  'VARCHAR', 'VARCHARACTER', 'VARYING', 'VIRTUAL', 'WHEN', 'WHERE', 'WHILE', 'WINDOW', 'WITH', 'WRITE', 'XOR',
  'YEAR_MONTH', 'ZEROFILL',
]);

const keywordSet = new Set(sqlKeywords);
const lineBreak = '\r\n'; // sLineBreak do Delphi no Windows
const vazio: SqlTok = { kind: 'space', text: '', start: 0 }; // "não tem token" (NextSig/Near do Pascal)

// UpperCase do Delphi: só a..z. O toUpperCase do JS trocaria também ı, ſ, ß..., e "ſelect" viraria palavra-chave.
const upper = (s: string) => s.replace(/[a-z]+/g, (m) => m.toUpperCase());

export function isKeyword(w: string): boolean {
  return keywordSet.has(upper(w));
}

// Um caractere (unidade UTF-16) por vez, como o Char.IsLetterOrDigit / IsDigit do Delphi.
const isWordChar = (c: string) => /[\p{L}\p{Nd}_$@]/u.test(c);
const isDigit = (c: string) => /\p{Nd}/u.test(c);

export function tokenize(s: string): SqlTok[] {
  const result: SqlTok[] = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    let j = i + 1;
    const c = s[i];
    let k: TokKind;
    if (c <= ' ') {
      while (j < n && s[j] <= ' ') j++;
      k = 'space';
    } else if (c === '#' || (c === '-' && s[i + 1] === '-')) {
      while (j < n && s[j] !== '\n' && s[j] !== '\r') j++;
      k = 'lineComment';
    } else if (c === '/' && s[i + 1] === '*') {
      j = s.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      k = 'comment';
    } else if (c === "'" || c === '"' || c === '`') {
      while (j < n)
        if (s[j] === '\\' && c !== '`') j += 2;
        else if (s[j] === c) {
          if (s[j + 1] === c) j += 2; // aspas dobradas
          else {
            j++;
            break;
          }
        } else j++;
      if (j > n) j = n;
      k = c === '`' ? 'quoted' : 'string';
    } else if (isWordChar(c)) {
      while (j < n && isWordChar(s[j])) j++;
      k = isDigit(c) ? 'number' : 'word';
    } else {
      if (['<>', '<=', '>=', '!=', ':=', '||', '&&', '<<', '>>'].includes(s.slice(i, i + 2))) j = i + 2;
      k = 'symbol';
    }
    result.push({ kind: k, text: s.slice(i, j), start: i });
    i = j;
  }
  return result;
}

/** Instrução (separada por ;) onde está o cursor, sem os espaços das pontas; null se ela é vazia.
 *  `pos` e `start` são índices de string JS, a partir de 0 (no Pascal, APos e AStart eram a partir de 1):
 *  `pos` é a posição do cursor no texto (0 = antes do primeiro caractere) e a instrução é
 *  `s.slice(start, start + len)`. */
export function statementAt(s: string, pos: number): { start: number; len: number } | null {
  let start = 0;
  let len = s.length;
  for (const t of tokenize(s))
    if (t.kind === 'symbol' && t.text === ';') {
      if (pos <= t.start + 1) {
        // logo depois do ; ainda conta como a instrução que ele fecha
        len = t.start - start;
        break;
      }
      start = t.start + 1;
      len = s.length - start;
    }
  while (len > 0 && s[start] <= ' ') {
    start++;
    len--;
  }
  while (len > 0 && s[start + len - 1] <= ' ') len--;
  return len > 0 ? { start, len } : null;
}

/** Uma instrução só (o ; do fim é opcional), começando com SELECT ou WITH: dá para rodar de novo sem efeito colateral. */
export function singleSelect(s: string): boolean {
  let first = '';
  let ended = false;
  for (const t of tokenize(s))
    if (t.kind === 'space' || t.kind === 'comment' || t.kind === 'lineComment') continue;
    else if (ended) return false; // outra instrução depois do ;
    else if (t.kind === 'symbol' && t.text === ';') ended = true;
    else if (first === '') first = t.text;
  return ['SELECT', 'WITH'].includes(upper(first));
}

const clauses = ['SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'VALUES', 'SET', 'UPDATE', 'DELETE', 'UNION'];
const joinStarts = ['LEFT', 'RIGHT', 'INNER', 'CROSS', 'NATURAL', 'STRAIGHT_JOIN'];

/** Cláusulas em linha própria, itens do SELECT/SET um por linha, AND/OR recuados, palavras-chave em maiúsculas. */
export function formatSql(s: string): string {
  const toks = tokenize(s);
  const sb: string[] = [];
  const base: number[] = [0]; // recuo de cada nível de parênteses
  const clause: string[] = ['']; // cláusula atual de cada nível
  let depth = 0;
  let t = vazio;
  let prev = vazio;
  let prevWord = '';
  let lineStart = true;
  let stmtStart = true;
  let itemBreak = false;
  let newStmt = false;
  let inBetween = false;
  let forceNL = false;

  const nextSig = (from: number): SqlTok => {
    for (let k = from; k < toks.length; k++) if (toks[k].kind !== 'space') return toks[k];
    return vazio;
  };

  const newLine = (extra: number) => {
    if (stmtStart) return;
    const recuo = ' '.repeat((base[depth] + extra) * 2);
    if (lineStart) {
      // já numa linha nova (depois de comentário --): só acerta o recuo. O Pascal tira os espaços do fim e põe o
      // recuo novo; aqui o fim é sempre o recuo que o newLine anterior pôs, então basta trocar.
      sb[sb.length - 1] = recuo;
      return;
    }
    sb.push(lineBreak, recuo);
    lineStart = true;
  };

  const emit = (text: string) => {
    let space = !lineStart && !stmtStart;
    if (space) {
      if (t.kind === 'symbol' && [',', ';', ')', '.'].includes(t.text)) space = false;
      else if (prev.kind === 'symbol' && ['(', '.'].includes(prev.text)) space = false;
      else if (t.text === '(' && (prev.kind === 'quoted' || (prev.kind === 'word' && !isKeyword(prev.text))))
        space = false; // chamada de função: count(
    }
    if (space) sb.push(' ');
    sb.push(text);
    lineStart = false;
    stmtStart = false;
  };

  for (let i = 0; i < toks.length; i++) {
    t = toks[i];
    if (t.kind === 'space') continue;
    if (newStmt) {
      sb.push(lineBreak, lineBreak);
      newStmt = false;
      stmtStart = true;
      lineStart = true;
    }
    if (forceNL) {
      forceNL = false;
      newLine(0);
    }
    let w = t.text;
    if (t.kind === 'word' && isKeyword(w)) {
      w = upper(w);
      if (itemBreak && w !== 'DISTINCT') {
        itemBreak = false;
        newLine(1);
      }
      const join = joinStarts.includes(w);
      if (
        (clauses.includes(w) && !(w === 'SET' && upper(prevWord) === 'CHARACTER')) ||
        (join && nextSig(i + 1).text !== '(') ||
        (w === 'JOIN' && !['LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'NATURAL'].includes(upper(prevWord)))
      ) {
        newLine(0);
        clause[depth] = join || w === 'JOIN' ? 'FROM' : w;
        inBetween = false;
      } else if ((w === 'AND' || w === 'OR') && ['WHERE', 'HAVING', 'FROM'].includes(clause[depth])) {
        if (inBetween && w === 'AND') inBetween = false; // BETWEEN x AND y fica na mesma linha
        else newLine(1);
      } else if (w === 'BETWEEN') inBetween = true;
      emit(w);
      if ((w === 'SELECT' || w === 'SET') && clause[depth] === w) itemBreak = true;
      prevWord = w;
    } else {
      if (itemBreak) {
        itemBreak = false;
        newLine(1);
      }
      if (t.kind === 'symbol') {
        if (w === '(') {
          emit(w);
          depth++;
          base[depth] = base[depth - 1];
          if (upper(nextSig(i + 1).text) === 'SELECT') base[depth] = base[depth - 1] + 2; // subconsulta
          clause[depth] = '';
        } else if (w === ')') {
          if (depth > 0) depth--;
          emit(w);
        } else if (w === ',') {
          emit(w);
          if (clause[depth] === 'SELECT' || clause[depth] === 'SET') newLine(1);
        } else if (w === ';') {
          emit(w);
          depth = 0;
          clause[0] = '';
          newStmt = true;
        } else emit(w);
      } else {
        emit(w);
        if (t.kind === 'lineComment') forceNL = true;
      }
      if (t.kind === 'word') prevWord = w;
    }
    prev = t;
  }
  return sb.join('');
}

/** Tira as crases dos nomes que não precisam delas: só letras sem acento, dígitos e _, sem começar com dígito e sem
 *  ser palavra reservada. Strings e comentários não mudam; o usuário@host do DEFINER fica como está. */
export function unquote(s: string): string {
  const toks = tokenize(s);
  const sb: string[] = [];
  const palavra = (k: TokKind) => k === 'word' || k === 'number' || k === 'quoted';
  for (let i = 0; i < toks.length; i++) {
    // Vizinho na direção d: o colado (skip = false) ou o primeiro que não é espaço.
    const near = (d: number, skip: boolean): SqlTok => {
      let k = i + d;
      while (skip && k >= 0 && k < toks.length && toks[k].kind === 'space') k += d;
      return k >= 0 && k < toks.length ? toks[k] : vazio;
    };
    const n = toks[i].text.slice(1, -1);
    const plain =
      toks[i].kind === 'quoted' &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) &&
      !reserved.has(n.toUpperCase()) &&
      // sem crase não pode encostar em outra palavra nem fazer parte do usuário@host
      !palavra(near(-1, false).kind) &&
      !palavra(near(1, false).kind) &&
      !near(-1, true).text.endsWith('@') &&
      !near(1, true).text.startsWith('@');
    sb.push(plain ? n : toks[i].text);
  }
  return sb.join('');
}

const ends = ['JOIN', 'LEFT', 'RIGHT', 'INNER', 'CROSS', 'STRAIGHT_JOIN', 'NATURAL', 'WHERE', 'GROUP', 'ORDER', 'HAVING',
  'LIMIT', 'UNION', 'WINDOW'];

/** Tira os parênteses que o MySQL põe no SELECT da view e não mudam o resultado: em volta das junções encadeadas
 *  (FROM ((a JOIN b ON ...) JOIN c ON ...)) e em volta da condição inteira do ON / WHERE / HAVING. */
// Um par por vez, até não sobrar nenhum (ponytail: refaz os tokens a cada par; serve para o tamanho de uma view).
// Só sai o par cujo ")" fecha a cláusula (vem antes de JOIN, WHERE, ORDER..., ")" ou do fim). No FROM, só se tiver
// JOIN dentro e nenhuma vírgula (a, b JOIN c não é o mesmo que (a, b) JOIN c). Subconsulta fica.
export function dropParens(s: string): string {
  let result = s;

  // Tira o caractere da posição p; vira espaço se ia colar duas palavras.
  const cut = (p: number, open: boolean) => {
    const side = result[open ? p - 1 : p + 1];
    const espaco = side !== undefined && side > ' ' && !'();'.includes(side);
    result = result.slice(0, p) + (espaco ? ' ' : '') + result.slice(p + 1);
  };

  for (;;) {
    let done = true;
    // tokens fora espaço e comentário
    const sig = tokenize(result).filter((x) => x.kind !== 'space' && x.kind !== 'comment' && x.kind !== 'lineComment');
    for (let i = 1; i < sig.length - 1; i++) {
      const prev = upper(sig[i - 1].text);
      if (sig[i].text !== '(' || sig[i - 1].kind !== 'word' || !['FROM', 'ON', 'WHERE', 'HAVING'].includes(prev)) continue;
      let d = 0;
      let hasJoin = false;
      let hasComma = false;
      let j = i;
      do {
        const x = sig[j];
        if (x.kind === 'symbol') {
          if (x.text === '(') d++;
          else if (x.text === ')') d--;
          else if (x.text === ',' && d === 1) hasComma = true;
        } else if (d === 1 && x.kind === 'word' && ['JOIN', 'STRAIGHT_JOIN'].includes(upper(x.text))) hasJoin = true;
        j++;
      } while (d !== 0 && j < sig.length);
      if (d !== 0) return result; // parênteses desbalanceados: fica como está
      // o ")" é sig[j - 1]; next é o que vem depois dele
      const next = j < sig.length ? upper(sig[j].text) : '';
      if (
        hasComma ||
        ['SELECT', 'WITH'].includes(upper(sig[i + 1].text)) ||
        (prev === 'FROM' && !hasJoin) ||
        !(next === '' || next === ')' || next === ';' || (sig[j].kind === 'word' && ends.includes(next)))
      )
        continue;
      cut(sig[j - 1].start, false); // o de trás primeiro: não muda a posição do outro
      cut(sig[i].start, true);
      done = false;
      break;
    }
    if (done) return result;
  }
}

// Onde o texto entre aspas pode fechar ou escapar (crase não tem \).
const reAspas: Record<string, RegExp> = { "'": /['\\]/g, '"': /["\\]/g, '`': /`/g };
const reFimLinha = /[\r\n]/g;

/** Quebra um script em instruções, como o cliente mysql: separa por ';' fora de textos, crases e comentários, e
 *  entende DELIMITER (linha "DELIMITER $$" troca o separador; a linha em si não vira instrução). Instruções vazias
 *  e só de comentário são descartadas. As instruções saem sem o delimitador do fim. */
// Cada instrução sai como está no arquivo, do primeiro caractere que não é espaço nem comentário até o delimitador
// (os comentários de antes dela ficam de fora; os do meio vão junto).
// - O miolo de /*! ... */ (e /*M! do MariaDB) é código, como no cliente mysql: conta como instrução e um
//   delimitador lá dentro separa (por isso o mysqldump põe DELIMITER ;; em volta das rotinas).
// - "--" só é comentário seguido de espaço ou fim de linha, como no servidor (1--1 é uma conta).
// - DELIMITER só vale no começo da linha e sem instrução pendente (o TFDScript também só via comando no começo):
//   no meio de uma instrução é texto dela, como a coluna "delimiter int" num CREATE TABLE.
// Cada caractere é lido uma vez: a instrução pendente fica guardada em pedaços e o estado (dentro de texto, de
// comentário) passa de uma chamada para a outra. Só volta para a chamada seguinte o fim que não deu para decidir.
export class DivisorScript {
  private delim = ';';
  private resto = ''; // fim do pedaço anterior que depende do que vem depois (\ ou aspa no fim, "/", "-", "DELIM"...)
  private partes: string[] = []; // instrução pendente, o que já foi lido dela
  private modo = ''; // dentro de quê: ' " ` (texto ou crase), '-' (comentário até o fim da linha), '*' (/* */)
  private conteudo = false; // a instrução pendente já começou (tem algo além de espaço e comentário)
  private inicioLinha = true; // só espaço desde o começo da linha

  /** Recebe mais um pedaço do texto (arquivo lido aos poucos) e devolve as instruções que ficaram completas. */
  alimentar(pedaco: string): string[] {
    return this.ler(pedaco, false);
  }

  /** Fim do texto: devolve a instrução que sobrou sem delimitador, se houver. */
  fim(): string[] {
    return this.ler('', true);
  }

  private ler(pedaco: string, final: boolean): string[] {
    const s = this.resto + pedaco;
    const n = s.length;
    const saida: string[] = [];
    let ini = 0; // de onde, em s, a instrução pendente ainda não foi para partes
    let i = 0;

    // O caractere em i é da instrução: se ela ainda não tinha começado, começa aqui.
    const tem = () => {
      if (this.conteudo) return;
      this.conteudo = true;
      ini = i;
    };

    const fecha = (ate: number) => {
      if (this.conteudo) {
        this.partes.push(s.slice(ini, ate));
        const t = this.partes.join('').trim();
        if (t) saida.push(t);
      }
      this.partes = [];
      this.conteudo = false;
    };

    // Sair do laço com i < n = falta texto para decidir: de i em diante fica para a próxima chamada.
    while (i < n) {
      const c = s[i];
      if (this.modo === '-') {
        reFimLinha.lastIndex = i;
        const m = reFimLinha.exec(s);
        if (!m) {
          i = n;
          break;
        }
        i = m.index; // a quebra de linha é lida no modo normal
        this.modo = '';
      } else if (this.modo === '*') {
        const j = s.indexOf('*/', i);
        if (j < 0) {
          i = !final && s.endsWith('*') ? n - 1 : n; // pode ter cortado entre o * e a /
          break;
        }
        i = j + 2;
        this.modo = '';
      } else if (this.modo) {
        const re = reAspas[this.modo];
        re.lastIndex = i;
        const m = re.exec(s);
        if (!m) {
          i = n;
          break;
        }
        i = m.index;
        // \x, aspa dobrada ou aspa que fecha: depende do caractere seguinte
        if (i + 1 >= n && !final) break;
        if (s[i] === '\\' || s[i + 1] === this.modo) i += 2;
        else {
          i++;
          this.modo = '';
        }
      } else if (c <= ' ') {
        if (c === '\n' || c === '\r') this.inicioLinha = true;
        i++;
      } else {
        if (this.inicioLinha && !this.conteudo && (c === 'd' || c === 'D')) {
          const p = s.slice(i, i + 10).toLowerCase();
          if ('delimiter '.startsWith(p) || 'delimiter\t'.startsWith(p)) {
            // ponytail: espera a linha inteira e procura o fim dela de novo a cada pedaço; só pesa se vier
            // "DELIMITER " seguido de MBs sem quebra de linha
            reFimLinha.lastIndex = i;
            const m = reFimLinha.exec(s);
            if (!m && !final) break;
            const fimLinha = m ? m.index : n;
            const d = /^delimiter[ \t]+(\S+)/i.exec(s.slice(i, fimLinha));
            if (d) {
              this.delim = d[1];
              i = fimLinha;
              continue;
            }
          }
        }
        this.inicioLinha = false;
        if (c === this.delim[0]) {
          if (s.startsWith(this.delim, i)) {
            fecha(i);
            i += this.delim.length;
            continue;
          }
          // delimitador cortado no meio
          if (!final && n - i < this.delim.length && this.delim.startsWith(s.slice(i))) break;
        }
        if (c === "'" || c === '"' || c === '`') {
          tem();
          this.modo = c;
          i++;
        } else if (c === '#') {
          this.modo = '-';
          i++;
        } else if (c === '-') {
          if (i + 2 >= n && !final && (i + 1 >= n || s[i + 1] === '-')) break; // "-- " precisa de mais dois
          if (s[i + 1] === '-' && (i + 2 >= n || s[i + 2] <= ' ')) {
            this.modo = '-';
            i += 2;
          } else {
            tem();
            i++;
          }
        } else if (c === '/') {
          if (i + 3 >= n && !final && (i + 1 >= n || s[i + 1] === '*')) break; // "/*M!" precisa de mais três
          if (s[i + 1] !== '*') {
            tem();
            i++;
          } else if (s[i + 2] === '!' || (s[i + 2] === 'M' && s[i + 3] === '!')) {
            tem();
            i += 2;
          } else {
            this.modo = '*';
            i += 2;
          }
        } else {
          tem();
          i++;
        }
      }
    }

    if (final) {
      fecha(n);
      this.modo = '';
      this.inicioLinha = true;
    } else if (this.conteudo) this.partes.push(s.slice(ini, i));
    this.resto = final ? '' : s.slice(i);
    return saida;
  }
}

/** Script inteiro na memória. */
export function splitScript(s: string): string[] {
  const d = new DivisorScript();
  return [...d.alimentar(s), ...d.fim()];
}

/**
 * O que a aba de consulta manda ao servidor. Sem DELIMITER vai o texto inteiro: o MySQL separa as instruções e
 * entende o corpo com ';' de trigger/rotina. DELIMITER é comando do cliente (o servidor dá erro 1064 nele): com
 * uma linha dessas, o texto vai quebrado em instruções, como no cliente mysql.
 */
// ponytail: a linha é reconhecida por regex; uma coluna "delimiter int" sozinha na linha também quebra o texto por
// ';' (só atrapalha se o mesmo texto tiver trigger/rotina com corpo e sem DELIMITER). Se incomodar, perguntar ao
// DivisorScript se o delimitador mudou.
export function paraExecutar(sql: string): string | string[] {
  return /^[ \t]*delimiter[ \t]+\S/im.test(sql) ? splitScript(sql) : sql;
}
