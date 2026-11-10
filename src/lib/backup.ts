/**
 * Backup (arquivo .sql com estrutura, dados, views, rotinas e triggers), restauração e importação/exportação CSV.
 * Porte da lógica do uBackup.pas e do RunScript do uDb.pas (os nomes do Pascal em camelCase, para dar para conferir
 * com a unit). Sem UI: os diálogos ficam em components\Backup.tsx; testado em backup.test.ts.
 */
import { Alvo, Campo, Conjunto, ErroApi, RespostaSql, Valor, consulta, executar, fecharSessao, linhas } from './api';
import { ARQ_CSV, TIPO, bytesDe, bytesParaBase64, bytesParaHex, colunasPk, criarArquivo, ehBinario, ehGrande, getCreate, lerCsv, lerGrande, linhaCsv, q } from './db';
import { Andamento, Saida, csvLit, lit, normalize } from './compareLogic';
import { DivisorScript } from './sqlText';
import { avisar } from './avisos';

const NL = '\r\n'; // o WriteLine do Pascal (sLineBreak do Windows)
/** Linhas pedidas por consulta; a resposta ainda pode vir cortada pelo tamanho (truncado) */
const PAGINA = 5000;
/** INSERTs de ~0,5 MB: abaixo do max_allowed_packet padrão (e do limite de uma requisição na restauração) */
const INSERT_MAXIMO = 500_000;

/** Trim do Delphi: espaço e caracteres de controle das pontas. */
const trim = (s: string) => s.replace(/^[\0-\x20]+|[\0-\x20]+$/g, '');

function conferir(sinal?: AbortSignal) {
  if (sinal?.aborted) throw new DOMException('Cancelado', 'AbortError');
}

/** dd/mm/aaaa hh:nn:ss na hora local (nunca toISOString: é UTC). */
function agora(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ==========================================================
// Leitura de uma tabela inteira, em pedaços
// ==========================================================
/** "Chave depois de vals" na forma que o MySQL resolve pelo índice: (`a` > x) OR (`a` = x AND `b` > y) */
const depoisDe = (pk: string[], vals: string[]) =>
  pk.map((_, i) => '(' + pk.slice(0, i + 1).map((c, j) => `${q(c)} ${j < i ? '=' : '>'} ${vals[j]}`).join(' AND ') + ')').join(' OR ');

/**
 * O "SELECT * FROM tabela" do Pascal (lá com cursor unidirecional), em páginas: o navegador não tem cursor e cada
 * resposta tem limite de tamanho. Pagina pela chave primária (WHERE chave > última lida ORDER BY chave LIMIT n); a
 * resposta cortada (truncado) continua da última chave recebida. Os valores que não vieram por serem grandes
 * ({ bin: null }, acima de 1 MB) já saem lidos. A primeira página sai mesmo vazia (quem chama precisa dos campos).
 */
async function* paginas(alvo: Alvo, banco: string, tabela: string, sinal?: AbortSignal): AsyncGenerator<Conjunto> {
  const de = `${q(banco)}.${q(tabela)}`;
  const pk = await colunasPk(alvo, banco, tabela);
  let sel = '*';
  let apos = '';
  let lidas = 0;
  for (let primeira = true; ; ) {
    conferir(sinal);
    // ponytail: sem chave primária vai de LIMIT/OFFSET: cada página relê a tabela desde o começo (lento em tabela
    // grande) e, sem ORDER BY, linha pode repetir ou faltar se a tabela mudar durante a leitura. O caminho é paginar
    // por um índice único sem coluna nula (como o SQL_KEYS_OF do compareLogic).
    const c = await consulta(
      alvo,
      pk.length > 0
        ? `SELECT ${sel} FROM ${de}${apos && ' WHERE ' + apos} ORDER BY ${pk.map(q).join(', ')} LIMIT ${PAGINA}`
        : `SELECT ${sel} FROM ${de} LIMIT ${PAGINA} OFFSET ${lidas}`,
      undefined,
      PAGINA,
    );
    // GEOMETRY chega do servidor como JSON (não serve de literal): pede de novo como os bytes internos do MySQL
    // (SRID + WKB), que é o que o Pascal gravava em X'...' e o INSERT aceita.
    if (sel === '*' && c.campos.some((f) => f.tipo === TIPO.GEOMETRY)) {
      sel = c.campos.map((f) => (f.tipo === TIPO.GEOMETRY ? `CAST(${q(f.nome)} AS BINARY) AS ${q(f.nome)}` : q(f.nome))).join(', ');
      continue;
    }
    const ipk = pk.map((k) => c.campos.findIndex((f) => f.nome === k));
    const chave = (l: Valor[]) => ipk.map((i) => lit(l[i], c.campos[i]));
    for (const [n, l] of c.linhas.entries())
      for (let i = 0; i < l.length; i++) {
        if (!ehGrande(l[i])) continue;
        const bin = ehBinario(c.campos[i]);
        const col = q(c.campos[i].nome);
        const linha = pk.length > 0 ? `WHERE ${chave(l).map((v, j) => `${q(pk[j])} = ${v}`).join(' AND ')}` : `LIMIT 1 OFFSET ${lidas + n}`;
        // Texto: convertido para utf8mb4 no servidor, para os bytes virem em UTF-8 seja qual for o charset da coluna
        const b = await lerGrande(alvo, bin ? col : `CONVERT(${col} USING utf8mb4)`, `FROM ${de} ${linha}`);
        l[i] = bin ? { bin: bytesParaBase64(b) } : new TextDecoder().decode(b);
      }
    if (c.linhas.length === 0 && c.truncado) throw new Error(`A consulta em ${de} veio cortada sem nenhuma linha.`);
    if (pk.length > 0 && c.linhas.length > 0) {
      const novo = depoisDe(pk, chave(c.linhas[c.linhas.length - 1]));
      // ex.: chave FLOAT, em que "chave > literal" devolve a própria linha de novo
      if (novo === apos) throw new Error(`A leitura de ${de} não avança depois da chave ${novo}.`);
      apos = novo;
    }
    lidas += c.linhas.length;
    if (primeira || c.linhas.length > 0) yield c;
    primeira = false;
    if (!c.truncado && c.linhas.length < PAGINA) return;
  }
}

// ==========================================================
// Backup
// ==========================================================
/** DDL do objeto. O Pascal gravava vazio quando o usuário não podia ver; aqui para: o script apagaria o objeto sem criar de novo. */
async function ddl(alvo: Alvo, tipo: string, banco: string, nome: string): Promise<string> {
  const r = await getCreate(alvo, tipo, banco, nome);
  if (r === '') throw new Error(`Sem permissão para ler a definição de ${tipo} ${nome}: o backup ficaria sem esse objeto.`);
  return r;
}

/** O DumpDb do Pascal: mesmo conteúdo e mesma ordem do arquivo gerado lá. */
export async function dumpDb(alvo: Alvo, banco: string, saida: Saida, o: { estrutura: boolean; dados: boolean; objetos: boolean }, ctl?: Andamento): Promise<void> {
  const passo = (texto: string) => {
    conferir(ctl?.sinal);
    ctl?.progresso?.(texto);
  };
  await saida.escrever(`-- Backup de ${q(banco)} gerado pelo MySQL Studio em ${agora()}${NL}SET NAMES utf8mb4;${NL}SET FOREIGN_KEY_CHECKS = 0;${NL}${NL}`);
  for (const [t] of await linhas(alvo, "SELECT table_name FROM information_schema.tables WHERE table_schema=? AND table_type='BASE TABLE' ORDER BY 1", [banco])) {
    passo(`Tabela ${t}...`);
    if (o.estrutura) await saida.escrever(`DROP TABLE IF EXISTS ${q(t)};${NL}${await ddl(alvo, 'TABLE', banco, t)};${NL}${NL}`);
    if (!o.dados) continue;
    let cols = '';
    let sb = ''; // o INSERT aberto
    let n = 0;
    for await (const c of paginas(alvo, banco, t, ctl?.sinal)) {
      cols ||= c.campos.map((f) => q(f.nome)).join(', ');
      for (const l of c.linhas) {
        const linha = '(' + l.map((v, i) => lit(v, c.campos[i])).join(', ') + ')';
        sb += sb === '' ? `INSERT INTO ${q(t)} (${cols}) VALUES${NL}${linha}` : `,${NL}${linha}`;
        if (sb.length > INSERT_MAXIMO) {
          await saida.escrever(sb + ';' + NL);
          sb = '';
        }
        if (++n % 5000 === 0) ctl?.progresso?.(`Tabela ${t}: ${n} linhas...`);
      }
    }
    if (sb !== '') await saida.escrever(sb + ';' + NL);
    if (n > 0) await saida.escrever(NL);
  }
  if (o.objetos) {
    // ponytail: views em ordem alfabética; view que usa outra view de nome "maior" falha na restauração
    for (const [v] of await linhas(alvo, 'SELECT table_name FROM information_schema.views WHERE table_schema=? ORDER BY 1', [banco])) {
      passo(`View ${v}...`);
      await saida.escrever(`DROP VIEW IF EXISTS ${q(v)};${NL}${normalize(await ddl(alvo, 'VIEW', banco, v), banco)};${NL}${NL}`);
    }
    await saida.escrever('DELIMITER $$' + NL);
    const rotinas = await linhas(
      alvo,
      'SELECT routine_type, routine_name FROM information_schema.routines WHERE routine_schema=? ' +
        "UNION ALL SELECT 'TRIGGER', trigger_name FROM information_schema.triggers WHERE trigger_schema=? ORDER BY 1, 2",
      [banco, banco],
    );
    for (const [ty, nome] of rotinas) {
      passo(`${ty} ${nome}...`);
      await saida.escrever(`DROP ${ty} IF EXISTS ${q(nome)}$$${NL}${normalize(await ddl(alvo, ty, banco, nome), banco)}$$${NL}${NL}`);
    }
    await saida.escrever('DELIMITER ;' + NL);
  }
  await saida.escrever('SET FOREIGN_KEY_CHECKS = 1;' + NL);
}

// ==========================================================
// Execução de script
// ==========================================================
/** Um lote vai numa requisição: até ~1 MB de SQL ou 300 instruções, o que vier primeiro */
const LOTE_BYTES = 1_000_000;
const LOTE_INSTRUCOES = 300;
/** O servidor aceita corpo de até 4 MB: uma instrução maior que isto não tem como ir */
const INSTRUCAO_MAXIMA = 3_500_000;
/** Fatia lida do arquivo por vez */
const FATIA = 1024 * 1024;

const utf8 = new TextEncoder();
/** Bytes da instrução dentro do JSON da requisição: aspas, barras e quebras de linha escapadas; letra acentuada = 2. */
const pesoDe = (s: string) => utf8.encode(JSON.stringify(s)).length;
const comeco = (s: string) => (s.length > 200 ? s.slice(0, 200) + '...' : s);

/**
 * Manda instruções em lotes, todas na mesma conexão do MySQL: uma sessão própria no servidor, para SET, USE,
 * transação e tabela temporária valerem até o fim. Do segundo lote em diante exige a mesma sessão: se a Vercel
 * trocou de instância no meio, para em vez de continuar numa conexão nova. Para no primeiro erro do MySQL.
 * fechar() solta a conexão: sem COMMIT, a transação aberta é desfeita (como o C.Free do Pascal).
 */
function novoExecutor(alvo: Alvo, sinal?: AbortSignal) {
  const destino: Alvo = { ...alvo, sessao: crypto.randomUUID() };
  let lote: string[] = [];
  let peso = 0;
  let feitas = 0; // instruções que já rodaram
  let aberta = false; // a sessão já existe no servidor

  // ponytail: o cancelamento vale entre as requisições (espera o lote em andamento, até 300 instruções); abortar a
  // requisição no meio deixaria a sessão ocupada no servidor, sem dar para fechar (a transação ficaria aberta até
  // a faxina de sessões ociosas). Se precisar parar na hora, o servidor tem que fechar a sessão ao ser abortado.
  const enviar = async () => {
    while (lote.length > 0) {
      conferir(sinal);
      let r: RespostaSql;
      try {
        r = await executar(destino, lote, { exigeSessao: aberta });
      } catch (e) {
        if (!(e instanceof ErroApi) || e.codigo !== 'SESSAO_PERDIDA') throw e;
        throw new Error(
          `A conexão do script foi perdida depois de ${feitas} instrução(ões): o servidor trocou de instância no meio da execução. ` +
            'O que já rodou fora de transação continua feito; a transação que estava aberta não foi confirmada. Confira o banco antes de rodar de novo.',
        );
      }
      aberta = true;
      feitas += r.feitos;
      if (r.erro) throw new Error(`${r.erro}\nInstrução ${feitas + 1} do script: ${comeco(lote[r.feitos] ?? '')}`);
      if (r.feitos === 0) throw new Error('O servidor não executou as instruções do script.');
      // Menos feitas que enviadas, sem erro: consulta do script com resultado cortado (o servidor para nela). O resto vai de novo.
      lote = lote.slice(r.feitos);
    }
    peso = 0;
  };

  return {
    async add(inst: string) {
      const p = pesoDe(inst);
      if (p > INSTRUCAO_MAXIMA) {
        await enviar(); // as anteriores rodam: para na instrução que não cabe, como num erro
        throw new Error(
          `A instrução ${feitas + 1} do script tem ${(p / 1_000_000).toFixed(1).replace('.', ',')} MB e não cabe numa requisição ` +
            `(limite de 3,5 MB por instrução; as ${feitas} anteriores já rodaram). Rode este arquivo pelo cliente mysql.\n${comeco(inst)}`,
        );
      }
      if (lote.length >= LOTE_INSTRUCOES || (lote.length > 0 && peso + p > LOTE_BYTES)) await enviar();
      lote.push(inst);
      peso += p;
    },
    enviar,
    fechar: () => fecharSessao(destino.sessao ?? ''),
  };
}

/** O texto do script em pedaços, com quanto já foi lido (bytes do arquivo, ou caracteres do texto). */
async function* pedacos(origem: string | Blob): AsyncGenerator<[texto: string, lidos: number]> {
  if (typeof origem === 'string') {
    yield [origem, origem.length];
    return;
  }
  // stream: o caractere UTF-8 cortado na fronteira da fatia fica guardado para a próxima. O BOM do começo é descartado.
  const dec = new TextDecoder();
  for (let i = 0; i < origem.size; i += FATIA) {
    yield [dec.decode(await origem.slice(i, i + FATIA).arrayBuffer(), { stream: true }), Math.min(i + FATIA, origem.size)];
  }
  const fim = dec.decode();
  if (fim !== '') yield [fim, origem.size];
}

/** O RunScript do uDb.pas: roda um script (texto, ou arquivo .sql de qualquer tamanho) no MySQL do alvo. */
export async function runScript(
  alvo: Alvo,
  origem: string | Blob,
  ctl?: { progresso?: (lidos: number, total: number) => void; sinal?: AbortSignal },
): Promise<void> {
  const total = typeof origem === 'string' ? origem.length : origem.size;
  const ex = novoExecutor(alvo, ctl?.sinal);
  const div = new DivisorScript();
  try {
    let antes = 0;
    for await (const [texto, lidos] of pedacos(origem)) {
      ctl?.progresso?.(antes, total); // o que já foi para o servidor (o pedaço lido agora ainda vai rodar)
      for (const inst of div.alimentar(texto)) await ex.add(inst);
      antes = lidos;
    }
    for (const inst of div.fim()) await ex.add(inst);
    await ex.enviar();
    ctl?.progresso?.(total, total);
  } finally {
    await ex.fechar();
  }
}

// ==========================================================
// CSV
// ==========================================================
/** O Fields[I].AsString do Pascal no Windows pt-BR: data dd/mm/aaaa, vírgula decimal, '' para nulo. */
function textoCsv(v: Valor, c: Campo): string {
  if (v === null) return '';
  // ponytail: binário sai em hexadecimal (no Pascal saíam os bytes crus como texto); nenhum dos dois volta igual
  // pela importação. Se precisar de ida e volta de BLOB, combinar um formato (ex.: 0x...) com o csvLit.
  if (typeof v === 'object') return bytesParaHex(bytesDe(v) ?? new Uint8Array());
  const s = String(v);
  if (c.tipo === TIPO.DATE || c.tipo === TIPO.DATETIME || c.tipo === TIPO.TIMESTAMP) return s.replace(/^(\d{4})-(\d\d)-(\d\d)/, '$3/$2/$1');
  if (c.tipo === TIPO.DECIMAL || c.tipo === TIPO.NEWDECIMAL || c.tipo === TIPO.FLOAT || c.tipo === TIPO.DOUBLE) return s.replace('.', ',');
  return s;
}

/**
 * O ExportTableCsv: pede onde salvar (criarArquivo + ARQ_CSV) e exporta a tabela inteira. Não faz nada se o usuário
 * cancelar a escolha do arquivo. No fim, a linha que o Pascal punha na Saída ("banco.tabela: N linha(s)
 * exportada(s) para arquivo") vai como aviso de sucesso e como última chamada de ctl.progresso.
 */
export async function exportTableCsv(alvo: Alvo, banco: string, tabela: string, ctl?: Andamento): Promise<void> {
  const g = await criarArquivo(tabela + '.csv', ARQ_CSV);
  if (!g) return;
  try {
    let n = 0;
    let cabecalho = true;
    for await (const c of paginas(alvo, banco, tabela, ctl?.sinal)) {
      let texto = cabecalho ? '﻿' + linhaCsv(c.campos.map((f) => f.nome)) : '';
      cabecalho = false;
      for (const l of c.linhas) texto += linhaCsv(l.map((v, i) => textoCsv(v, c.campos[i])));
      await g.escrever(texto);
      n += c.linhas.length;
      ctl?.progresso?.(`Tabela ${tabela}: ${n} linhas...`);
    }
    await g.fechar();
    const fim = `${banco}.${tabela}: ${n} linha(s) exportada(s) para ${g.nome}`;
    ctl?.progresso?.(fim);
    avisar.sucesso(fim);
  } catch (e) {
    await g.cancelar().catch(() => {});
    throw e;
  }
}

/**
 * O ImportCsv: devolve quantas linhas entraram. Colunas pelo cabeçalho (nome igual, sem diferenciar maiúsculas) ou
 * na ordem da tabela. Tudo numa transação: com erro (ou cancelamento) no meio, nada entra.
 */
export async function importCsv(alvo: Alvo, banco: string, tabela: string, arquivo: Blob, cabecalho: boolean, ctl?: Andamento): Promise<number> {
  // ponytail: o arquivo inteiro na memória (o texto e as células), como o TFile.ReadAllText do Pascal: serve até
  // umas centenas de MB (o texto de um arquivo não passa de ~500 MB no Chrome). Acima disso, ler em fatias como o
  // runScript, com um lerCsv que aceite pedaços.
  const csv = lerCsv(await arquivo.text());
  if (csv.length === 0) return 0;
  const cols = await linhas(alvo, 'SELECT column_name, data_type FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position', [
    banco,
    tabela,
  ]);
  const map = csv[0].map((titulo, i) => {
    if (cabecalho) {
      const nome = trim(titulo);
      const k = cols.findIndex((c) => c[0].toLowerCase() === nome.toLowerCase());
      if (k < 0) throw new Error(`A coluna "${nome}" do arquivo não existe na tabela ${tabela}.`);
      return k;
    }
    if (i >= cols.length) throw new Error(`O arquivo tem ${csv[0].length} colunas e a tabela ${tabela} tem ${cols.length}.`);
    return i;
  });
  const inicio = `INSERT INTO ${q(tabela)} (${map.map((k) => q(cols[k][0])).join(', ')}) VALUES `;
  const primeira = cabecalho ? 1 : 0;
  const ex = novoExecutor({ ...alvo, banco }, ctl?.sinal);
  try {
    await ex.add('BEGIN');
    let sb = '';
    for (let k = primeira; k < csv.length; k++) {
      // linha com menos células que o cabeçalho: as que faltam entram como vazio
      sb += (sb === '' ? inicio : ', ') + '(' + map.map((c, i) => csvLit(csv[k][i] ?? '', cols[c][1])).join(', ') + ')';
      if (sb.length > INSERT_MAXIMO || k === csv.length - 1) {
        await ex.add(sb);
        sb = '';
        ctl?.progresso?.(`${k - primeira + 1} linha(s)...`);
      }
    }
    await ex.add('COMMIT');
    await ex.enviar();
    return csv.length - primeira;
  } finally {
    await ex.fechar(); // sem o COMMIT, a transação é desfeita
  }
}
