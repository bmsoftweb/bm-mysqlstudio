/**
 * Estrutura do banco para a IA: tabelas, views, colunas (tipo, chaves, referências, comentários) e rotinas, num
 * texto compacto. É lida uma vez por conexão + banco e reaproveitada em todos os pedidos; relê quando a estrutura
 * muda por aqui (esquecerEstrutura) ou quando o usuário pede (Reler estrutura).
 */
import { Alvo, escalar, linhas } from './api';

/**
 * Uma linha por tabela/view e por rotina. O texto sai sempre igual para o mesmo banco (tudo ordenado): é o que
 * deixa o cache do lado da IA valer entre um pedido e outro.
 *
 * tabelas: [nome, tipo (BASE TABLE | VIEW), comentário]; colunas: [tabela, coluna, tipo, nula (YES | NO), chave
 * (PRI | UNI | MUL), extra, comentário]; fks: [tabela, coluna, tabela referenciada, coluna referenciada];
 * rotinas: [tipo, nome]; pars: [rotina, tipo da rotina, ordem (0 = retorno), modo, nome, tipo].
 */
export function montarEstrutura(versao: string, banco: string, tabelas: string[][], colunas: string[][], fks: string[][], rotinas: string[][], pars: string[][]): string {
  const ref = new Map(fks.map((f) => [`${f[0]}.${f[1]}`, `${f[2]}.${f[3]}`]));
  const cols = new Map<string, string[]>();
  for (const [t, c, tipo, nula, chave, extra, com] of colunas) {
    let s = `${c} ${tipo}`;
    if (chave === 'PRI') s += ' PK';
    else if (nula === 'NO') s += ' NOT NULL';
    if (chave === 'UNI') s += ' UNIQUE';
    if (/auto_increment/i.test(extra)) s += ' auto_increment';
    const r = ref.get(`${t}.${c}`);
    if (r) s += ` -> ${r}`;
    if (com) s += ` /* ${com} */`;
    let lista = cols.get(t);
    if (!lista) cols.set(t, (lista = []));
    lista.push(s);
  }
  const saida = [
    `-- MySQL ${versao}, banco ${banco}`,
    '-- Uma linha por tabela ou view: nome(coluna tipo [PK] [NOT NULL] [UNIQUE] [auto_increment] [-> tabela.coluna referenciada] [/* comentário */], ...)',
    '',
  ];
  for (const [t, tipo, com] of tabelas) {
    const view = tipo === 'VIEW';
    saida.push(`${view ? 'VIEW' : 'TABLE'} ${t}(${(cols.get(t) ?? []).join(', ')})${com && !view ? ` /* ${com} */` : ''}`);
  }
  if (rotinas.length) saida.push('');
  for (const [tipo, nome] of rotinas) {
    const p = pars.filter((x) => x[0] === nome && x[1] === tipo);
    const lista = p.filter((x) => x[2] !== '0').map((x) => `${tipo === 'PROCEDURE' ? x[3] + ' ' : ''}${x[4]} ${x[5]}`);
    const retorno = p.find((x) => x[2] === '0');
    saida.push(`${tipo} ${nome}(${lista.join(', ')})${retorno ? ` RETURNS ${retorno[5]}` : ''}`);
  }
  return saida.join('\n');
}

const estruturas = new Map<string, Promise<string>>();

/**
 * A estrutura do banco, lida uma vez só por conexão + banco (reler = true: lê de novo).
 * ponytail: o banco inteiro vai em cada pedido (com cache do lado da IA). Num banco com milhares de tabelas isso
 * pesa no custo e pode passar do limite de uma consulta: aí mandar só os nomes e deixar a IA pedir as tabelas.
 */
export function estruturaDe(conexao: number, banco: string, reler = false): Promise<string> {
  const chave = `${conexao}|${banco}`;
  let p = reler ? undefined : estruturas.get(chave);
  if (!p) {
    const alvo: Alvo = { conexao };
    const I = 'information_schema';
    p = Promise.all([
      escalar(alvo, 'SELECT VERSION()'),
      linhas(alvo, `SELECT table_name, table_type, table_comment FROM ${I}.tables WHERE table_schema = ? ORDER BY table_name`, [banco]),
      linhas(
        alvo,
        `SELECT table_name, column_name, column_type, is_nullable, column_key, extra, column_comment FROM ${I}.columns WHERE table_schema = ? ORDER BY table_name, ordinal_position`,
        [banco],
      ),
      linhas(
        alvo,
        `SELECT table_name, column_name, referenced_table_name, referenced_column_name FROM ${I}.key_column_usage WHERE table_schema = ? AND referenced_table_name IS NOT NULL ORDER BY 1, 2`,
        [banco],
      ),
      linhas(alvo, `SELECT routine_type, routine_name FROM ${I}.routines WHERE routine_schema = ? ORDER BY 1, 2`, [banco]),
      linhas(
        alvo,
        `SELECT specific_name, routine_type, ordinal_position, parameter_mode, parameter_name, dtd_identifier FROM ${I}.parameters WHERE specific_schema = ? ORDER BY 1, 2, 3`,
        [banco],
      ),
    ]).then(([versao, tabelas, colunas, fks, rotinas, pars]) => montarEstrutura(versao, banco, tabelas, colunas, fks, rotinas, pars));
    p.catch(() => estruturas.get(chave) === p && estruturas.delete(chave)); // falhou: a próxima tenta de novo
    estruturas.set(chave, p);
  }
  return p;
}

/** A estrutura mudou (tabela, view ou rotina criada/alterada): o próximo pedido lê de novo. Sem banco: todos os da conexão. */
export function esquecerEstrutura(conexao: number, banco?: string) {
  for (const k of [...estruturas.keys()]) if (banco === undefined ? k.startsWith(`${conexao}|`) : k === `${conexao}|${banco}`) estruturas.delete(k);
}
