/**
 * Dados editáveis de uma tabela (o TEditTab do desktop): a aba Dados do documento de tabela e o resultado
 * editável da aba SQL. As alterações ficam pendentes (linha nova em verde, alterada em âmbar, excluída riscada)
 * até Salvar, que grava tudo numa transação só: ou entra tudo, ou nada.
 *
 * Tabela: lida aos poucos pela chave primária, conforme a grade desce ("Registro 3 de 500+").
 * Resultado da aba SQL: as linhas já vieram na consulta; Recarregar roda a consulta de novo.
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ClipboardPaste, Copy, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { Alvo, Campo, Conjunto, Feito, Valor, consulta, ehConjunto, executar, linhas as lerLinhas, texto } from '../lib/api';
import { base64ParaBytes, bytesParaHex, ehBinario, ehGrande, ehNumero, exportarCsv, lerGrande, lit, milhar, novoIdApp, q, valoresEnum, FLAG } from '../lib/db';
import { colsDiff } from '../lib/compareLogic';
import { avisar, confirmar, confirmarDescarte } from '../lib/avisos';
import type { ColunaGrade, GradeApi } from './Grade';
import { GradeConjunto } from './GradeConjunto';
import { Botao, Carregando, ItemMenu, MenuContexto } from './ui';

export interface GradeDadosApi {
  temAlteracoes(): boolean;
  /** Grava as alterações pendentes; false se deu erro (já avisado) */
  salvar(): Promise<boolean>;
  /** Recarrega do banco (pergunta antes se há alterações) */
  recarregar(): Promise<void>;
  exportarCsv(): void;
}

interface GradeDadosProps {
  alvo: Alvo;
  banco: string;
  tabela: string;
  /** Resultado editável de uma aba SQL (todas as colunas da tabela e a chave primária inteira) */
  resultado?: Conjunto;
  /** No modo resultado: roda a consulta de novo */
  aoRecarregar?: () => void;
  /** Mostra os atalhos nos botões: na aba SQL o Ctrl+S salva o arquivo e o F9 executa, então lá ficam sem */
  comAtalhos?: boolean;
}

type Marca = '' | 'N' | 'A' | 'E';

interface Dados {
  campos: Campo[];
  linhas: Valor[][];
  marcas: Marca[];
  /** Valores do banco das linhas alteradas (para o WHERE e para saber o que mudou) */
  origs: (Valor[] | null)[];
  /** Não há mais linhas para buscar */
  fim: boolean;
}

/** Linhas de information_schema.columns: nome, tipo, chave, extra */
type Estrutura = string[][];

const SQL_COLUNAS =
  'SELECT column_name, column_type, column_key, extra FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position';

const PAGINA = 500;

/** Registro do "Copiar registro", para colar numa tabela de mesma estrutura (neste banco ou em outro): um só para o app. */
let copiado: { origem: string; cols: Estrutura; valores: Valor[] } | null = null;

const gerada = (extra: string) => /VIRTUAL GENERATED|STORED GENERATED/i.test(extra);

/** Valor como literal SQL para INSERT/UPDATE/WHERE. */
export function literal(v: Valor, campo: Campo): string {
  if (v === null) return 'NULL';
  if (typeof v === 'object') return v.bin ? '0x' + bytesParaHex(base64ParaBytes(v.bin)) : "''";
  if (typeof v === 'number') return String(v);
  // Número sem aspas: em coluna BIT, '1' entre aspas seria o caractere "1" (49)
  if (ehNumero(campo) && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v)) return v;
  return lit(v);
}

const iguais = (a: Valor, b: Valor) =>
  a === b || (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' ? a.bin === b.bin : a !== null && b !== null && typeof a !== 'object' && typeof b !== 'object' && String(a) === String(b));

export const GradeDados = forwardRef<GradeDadosApi, GradeDadosProps>(function GradeDados({ alvo, banco, tabela, resultado, aoRecarregar, comAtalhos }, ref) {
  const [dados, setDados] = useState<Dados | null>(null);
  const [estrutura, setEstrutura] = useState<Estrutura>([]);
  const [info, setInfo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; l: number } | null>(null);
  const [focoLinha, setFocoLinha] = useState(-1);
  const grade = useRef<GradeApi>(null);
  const buscando = useRef(false);
  /** Chave da última linha lida do banco (paginação) */
  const ultimaChave = useRef<Valor[] | null>(null);
  const atual = useRef<Dados | null>(null);
  /** Estado e ref juntos: quem lê logo depois de alterar (Salvar confirmando a célula em edição) já vê o valor novo */
  const mudar = (fn: (d: Dados | null) => Dados | null) => {
    atual.current = fn(atual.current);
    setDados(atual.current);
  };

  const nomeTabela = `${q(banco)}.${q(tabela)}`;

  // Índice do campo que vem de cada coluna da tabela (no SELECT da aba SQL a coluna pode ter apelido)
  const indiceDe = useCallback((campos: Campo[], coluna: string) => campos.findIndex((c) => (c.coluna || c.nome).toLowerCase() === coluna.toLowerCase()), []);
  const pk = useMemo(() => estrutura.filter((r) => r[2] === 'PRI').map((r) => r[0]), [estrutura]);
  // Chave id_app varchar(25) das tabelas BMsoft: o app gera o valor na inclusão, como a trigger
  const idApp = useMemo(() => estrutura.some((r) => r[0].toLowerCase() === 'id_app' && r[1] === 'varchar(25)' && r[2] === 'PRI'), [estrutura]);
  // ponytail: sem chave primária a grade fica só leitura (não há como apontar a linha no UPDATE/DELETE)
  const editavel = dados !== null && pk.length > 0 && pk.every((c) => indiceDe(dados.campos, c) >= 0);

  const temAlteracoes = () => Boolean(atual.current?.marcas.some((m) => m !== ''));

  const ordem = (chave: string[]) => (chave.length ? ` ORDER BY ${chave.map(q).join(', ')}` : '');

  const buscar = async (cols: Estrutura, depoisDe: Valor[] | null, deslocamento: number): Promise<Conjunto> => {
    const chave = cols.filter((r) => r[2] === 'PRI').map((r) => r[0]);
    let onde = '';
    if (chave.length && depoisDe) {
      // (a, b) > (x, y): continua de onde parou mesmo que linhas tenham sido incluídas ou excluídas no meio
      onde = ` WHERE (${chave.map(q).join(', ')}) > (${depoisDe.map((v) => (v === null ? 'NULL' : typeof v === 'object' ? (v.bin ? '0x' + bytesParaHex(base64ParaBytes(v.bin)) : "''") : lit(String(v)))).join(', ')})`;
    }
    const sql = `SELECT * FROM ${nomeTabela}${onde}${ordem(chave)} LIMIT ${PAGINA}${chave.length ? '' : ` OFFSET ${deslocamento}`}`;
    return consulta(alvo, sql, undefined, PAGINA);
  };

  const guardarChave = (c: Conjunto, cols: Estrutura) => {
    const chave = cols.filter((r) => r[2] === 'PRI').map((r) => r[0]);
    const ultima = c.linhas[c.linhas.length - 1];
    if (ultima && chave.length) ultimaChave.current = chave.map((n) => ultima[indiceDe(c.campos, n)] ?? null);
  };

  const carregar = useCallback(async () => {
    setOcupado(true);
    setErro('');
    try {
      const cols = await lerLinhas(alvo, SQL_COLUNAS, [banco, tabela]);
      setEstrutura(cols);
      ultimaChave.current = null;
      let c: Conjunto;
      if (resultado) c = resultado;
      else {
        c = await buscar(cols, null, 0);
        guardarChave(c, cols);
      }
      mudar(() => ({
        campos: c.campos,
        linhas: c.linhas,
        marcas: c.linhas.map((): Marca => ''),
        origs: c.linhas.map(() => null),
        fim: resultado ? true : !c.truncado && c.linhas.length < PAGINA,
      }));
      setInfo(resultado?.truncado ? 'Resultado cortado no limite de linhas.' : ''); // o aviso anterior era dos dados de antes
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setOcupado(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alvo.conexao, banco, tabela, resultado]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /** Mais um pedaço da tabela, quando a grade chega perto do fim */
  const buscarMais = async () => {
    const d = atual.current;
    if (!d || d.fim || buscando.current || resultado) return;
    buscando.current = true;
    try {
      const lidas = d.marcas.filter((m) => m !== 'N').length;
      const c = await buscar(estrutura, ultimaChave.current, lidas);
      guardarChave(c, estrutura);
      mudar((x) =>
        x && {
          ...x,
          linhas: [...x.linhas, ...c.linhas],
          marcas: [...x.marcas, ...c.linhas.map((): Marca => '')],
          origs: [...x.origs, ...c.linhas.map(() => null)],
          fim: !c.truncado && c.linhas.length < PAGINA,
        },
      );
    } catch (e) {
      avisar.erro(e);
    } finally {
      buscando.current = false;
    }
  };

  const recarregar = async () => {
    if (temAlteracoes() && !(await confirmarDescarte('Descartar alterações não salvas?'))) return;
    if (resultado && aoRecarregar) aoRecarregar();
    else await carregar();
  };

  const alterar = (l: number, c: number, v: Valor) => {
    mudar((d) => {
      if (!d || d.marcas[l] === 'E') return d;
      const campo = d.campos[c];
      // Coluna que não é de texto: vazio é nulo
      if (v === '' && (ehNumero(campo) || campo.tipo === 7 || (campo.tipo >= 10 && campo.tipo <= 13))) v = null;
      const linhas = d.linhas.slice();
      const marcas = d.marcas.slice();
      const origs = d.origs.slice();
      if (marcas[l] === '') {
        origs[l] = d.linhas[l];
        marcas[l] = 'A';
      }
      linhas[l] = d.linhas[l].map((x, i) => (i === c ? v : x));
      // Voltou ao que estava no banco: deixa de ser alteração
      if (marcas[l] === 'A' && origs[l]!.every((x, i) => iguais(x, linhas[l][i]))) {
        marcas[l] = '';
        origs[l] = null;
      }
      return { ...d, linhas, marcas, origs };
    });
  };

  /** Linha nova na posição da atual (o fim da tabela pode nem ter sido lido ainda); gravada só ao Salvar. */
  const inserir = (valores?: (campos: Campo[]) => Valor[]): number => {
    const d = atual.current;
    if (!d || !editavel) return -1;
    const em = focoLinha >= 0 && focoLinha < d.linhas.length ? focoLinha : 0;
    const nova = valores ? valores(d.campos) : d.campos.map((): Valor => null);
    const iId = idApp ? indiceDe(d.campos, 'id_app') : -1;
    if (iId >= 0 && (nova[iId] === null || nova[iId] === '')) nova[iId] = novoIdApp();
    mudar(() => ({
      ...d,
      linhas: [...d.linhas.slice(0, em), nova, ...d.linhas.slice(em)],
      marcas: [...d.marcas.slice(0, em), 'N', ...d.marcas.slice(em)],
      origs: [...d.origs.slice(0, em), null, ...d.origs.slice(em)],
    }));
    // O id_app já vem preenchido: o foco vai para a coluna seguinte
    setTimeout(() => grade.current?.focar(em, iId === 0 && d.campos.length > 1 ? 1 : 0), 0);
    return em;
  };

  const excluir = async (l: number) => {
    const d = atual.current;
    if (!d || !editavel || l < 0 || l >= d.linhas.length || d.marcas[l] === 'E') return;
    if (!(await confirmar({ titulo: 'Excluir a linha?', mensagem: 'Excluir esta linha? A exclusão só é gravada ao Salvar.' }))) return;
    mudar((x) => {
      if (!x) return x;
      if (x.marcas[l] === 'N') {
        const tira = <T,>(a: T[]) => a.filter((_, i) => i !== l);
        return { ...x, linhas: tira(x.linhas), marcas: tira(x.marcas), origs: tira(x.origs) };
      }
      const marcas = x.marcas.slice();
      const linhas = x.linhas.slice();
      const origs = x.origs.slice();
      if (origs[l]) linhas[l] = origs[l]!; // a edição pendente da linha excluída não vale mais
      origs[l] = null;
      marcas[l] = 'E';
      return { ...x, linhas, marcas, origs };
    });
  };

  const salvar = async (): Promise<boolean> => {
    if (!grade.current?.confirmarEdicao()) return false;
    const d = atual.current;
    if (!d) return true;
    if (!d.marcas.some((m) => m !== '')) {
      setInfo('Nada a salvar');
      return true;
    }
    const naoGravaveis = new Set(estrutura.filter((r) => gerada(r[3])).map((r) => r[0].toLowerCase()));
    const grava = (c: Campo) => c.coluna !== '' && !naoGravaveis.has(c.coluna.toLowerCase());
    const onde = (valores: Valor[]) =>
      pk.map((n) => {
        const i = indiceDe(d.campos, n);
        return `${q(n)} = ${literal(valores[i], d.campos[i])}`;
      }).join(' AND ');

    const comandos: string[] = [];
    const linhaDoComando: number[] = [];
    d.marcas.forEach((m, l) => {
      const linha = d.linhas[l];
      if (m === 'E') comandos.push(`DELETE FROM ${nomeTabela} WHERE ${onde(linha)} LIMIT 1`);
      else if (m === 'A') {
        const orig = d.origs[l]!;
        const sets = d.campos.map((c, i) => (grava(c) && !iguais(orig[i], linha[i]) && !ehGrande(linha[i]) ? `${q(c.coluna)} = ${literal(linha[i], c)}` : '')).filter(Boolean);
        if (!sets.length) return;
        comandos.push(`UPDATE ${nomeTabela} SET ${sets.join(', ')} WHERE ${onde(orig)} LIMIT 1`);
      } else if (m === 'N') {
        // Só as colunas preenchidas: as outras ficam com o padrão da tabela (auto_increment, DEFAULT)
        const cols = d.campos.map((c, i) => (grava(c) && linha[i] !== null ? i : -1)).filter((i) => i >= 0);
        comandos.push(`INSERT INTO ${nomeTabela} (${cols.map((i) => q(d.campos[i].coluna)).join(', ')}) VALUES (${cols.map((i) => literal(linha[i], d.campos[i])).join(', ')})`);
      } else return;
      linhaDoComando.push(l);
    });

    setOcupado(true);
    try {
      // ponytail: tudo numa requisição (limite de 4 MB): muitas linhas com blob grande pedem salvar em partes
      const r = await executar(alvo, ['START TRANSACTION', ...comandos, 'COMMIT']);
      if (r.erro) {
        avisar.erro(`Erro ao salvar: ${r.erro}\nNada foi gravado.`);
        return false;
      }
      const feitos = r.resultados.filter((x): x is Feito => !ehConjunto(x)).slice(1); // sem o START TRANSACTION
      const iAuto = d.campos.findIndex((c) => (c.flags & FLAG.AUTO_INCREMENT) !== 0);
      const linhas = d.linhas.slice();
      linhaDoComando.forEach((l, k) => {
        // O valor gerado pelo auto_increment volta para a grade
        if (d.marcas[l] === 'N' && iAuto >= 0 && linhas[l][iAuto] === null && feitos[k] && feitos[k].idInserido !== '0') {
          linhas[l] = linhas[l].map((v, i) => (i === iAuto ? feitos[k].idInserido : v));
        }
      });
      const fica = d.marcas.map((m) => m !== 'E');
      mudar(() => ({
        ...d,
        linhas: linhas.filter((_, i) => fica[i]),
        marcas: d.marcas.filter((_, i) => fica[i]).map((): Marca => ''),
        origs: d.origs.filter((_, i) => fica[i]).map(() => null),
      }));
      setInfo(`${comandos.length} alteração(ões) gravada(s)`);
      return true;
    } catch (e) {
      avisar.erro(e);
      return false;
    } finally {
      setOcupado(false);
    }
  };

  const exportar = () => {
    const d = atual.current;
    if (!d) return avisar.alerta('Nenhum resultado para exportar.');
    exportarCsv(`${tabela || 'resultado'}.csv`, d.campos.map((c) => c.nome), d.linhas.map((l) => l.map(texto)))
      .then((ok) => {
        if (ok && !d.fim) avisar.alerta(`Exportados só os ${milhar(d.linhas.length)} registros já carregados. Para a tabela inteira, use Exportar dados da tabela (CSV) no explorador.`);
      })
      .catch(avisar.erro);
  };

  useImperativeHandle(ref, () => ({ temAlteracoes, salvar, recarregar, exportarCsv: exportar }));

  // Guarda os valores da linha (com o que estiver digitado e ainda não salvo) e a estrutura da tabela
  const copiar = (l: number) => {
    const d = atual.current;
    if (!d) return;
    copiado = {
      origem: `${banco}.${tabela}`,
      cols: estrutura,
      valores: estrutura.map((r) => {
        const i = indiceDe(d.campos, r[0]);
        return i >= 0 ? d.linhas[l][i] : null;
      }),
    };
    setInfo('Registro copiado. Para colar: clique com o direito na grade da tabela de destino > Colar registro.');
  };

  /**
   * Cola o registro copiado como linha nova, gravada só ao Salvar. A estrutura tem que ser igual (nome e tipo das
   * colunas, como na comparação de dados); chave primária, auto_increment e colunas calculadas não são copiadas.
   */
  const colar = () => {
    const c = copiado;
    if (!c || !atual.current) return;
    // A mesma tabela nos dois lados do colsDiff: só as colunas contam (pode colar em outra tabela de estrutura igual)
    const dif = colsDiff(c.cols.map((r) => [tabela, r[0], r[1]]), estrutura.map((r) => [tabela, r[0], r[1]]));
    if (dif) return avisar.alerta(`${banco}.${tabela} não tem a mesma estrutura de ${c.origem}, de onde o registro foi copiado:\n\n${dif}`);
    const puladas: string[] = [];
    let preencher = '';
    const em = inserir((campos) => {
      const nova = campos.map((): Valor => null);
      for (const r of estrutura) {
        const i = indiceDe(campos, r[0]);
        if (r[2] === 'PRI' || /auto_increment/i.test(r[3]) || gerada(r[3])) {
          puladas.push(r[0]);
          // Chave sem auto_increment nem valor gerado: quem cola preenche (o id_app já é gerado ao incluir)
          if (!preencher && r[3] === '' && i >= 0 && !(idApp && r[0].toLowerCase() === 'id_app')) preencher = r[0];
          continue;
        }
        const k = c.cols.findIndex((x) => x[0].toLowerCase() === r[0].toLowerCase());
        if (i >= 0 && k >= 0) nova[i] = c.valores[k];
      }
      return nova;
    });
    if (em < 0) return;
    if (preencher) {
      setInfo(`Registro colado: preencha ${preencher} e clique em Salvar.`);
      const i = indiceDe(atual.current.campos, preencher);
      setTimeout(() => grade.current?.focar(em, i), 0);
    } else setInfo(`Registro colado${puladas.length ? ' sem copiar ' + puladas.join(', ') : ''}: confira e clique em Salvar.`);
  };

  const conjunto = useMemo<Conjunto | null>(() => (dados ? { campos: dados.campos, linhas: dados.linhas, truncado: false } : null), [dados]);

  // ENUM vira lista só com os valores aceitos (fora dela o MySQL recusa com "Data truncated")
  const extra = useCallback(
    (campo: Campo): Partial<ColunaGrade> | undefined => {
      const r = estrutura.find((x) => x[0].toLowerCase() === campo.coluna.toLowerCase());
      if (!r) return undefined;
      if (gerada(r[3])) return { editor: 'nenhum', dica: 'Coluna calculada' };
      if (r[1].toLowerCase().startsWith('enum(')) return { editor: 'lista', itens: valoresEnum(r[1]), fixo: true, subtitulo: 'ENUM' };
      return undefined;
    },
    [estrutura],
  );

  if (erro) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-xs text-rose-600 dark:text-rose-400">
        <span className="whitespace-pre-line text-center">{erro}</span>
        <Botao icone={RefreshCw} onClick={() => void carregar()}>
          Tentar de novo
        </Botao>
      </div>
    );
  }
  if (!dados || !conjunto) return <Carregando texto={`Abrindo ${banco}.${tabela}...`} />;

  const itensMenu = (l: number): ItemMenu[] => [
    { texto: 'Copiar registro', icone: Copy, onClick: () => copiar(l), desabilitado: l < 0 },
    { texto: 'Colar registro' + (copiado ? ` (de ${copiado.origem})` : ''), icone: ClipboardPaste, onClick: colar, desabilitado: !copiado || !editavel },
    '-',
    { texto: 'Incluir linha', icone: Plus, onClick: () => inserir(), desabilitado: !editavel },
    { texto: 'Excluir linha', icone: Trash2, onClick: () => void excluir(l), perigo: true, desabilitado: !editavel || l < 0 },
  ];

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 flex items-center gap-1 px-1 py-1 border-b border-borda">
        <Botao icone={Save} onClick={() => void salvar()} ocupado={ocupado} disabled={!editavel} title="Grava as alterações pendentes">
          {comAtalhos ? 'Salvar (Ctrl+S)' : 'Salvar'}
        </Botao>
        <Botao icone={RefreshCw} onClick={() => void recarregar()} disabled={ocupado}>
          {comAtalhos ? 'Recarregar (F9)' : 'Recarregar'}
        </Botao>
        <Botao icone={Plus} onClick={() => inserir()} disabled={!editavel} title="Incluir linha (Insert)">
          Incluir
        </Botao>
        <Botao icone={Trash2} onClick={() => void excluir(focoLinha)} disabled={!editavel || focoLinha < 0} title="Excluir a linha atual">
          Excluir
        </Botao>
        <span className="ml-2 min-w-0 truncate text-xs text-texto2">
          {info || (!editavel ? 'Tabela sem chave primária no resultado: só leitura.' : '')}
        </span>
      </div>
      <GradeConjunto
        refGrade={grade}
        conjunto={conjunto}
        extra={extra}
        editavel={editavel}
        podeEditar={(l, c) => dados.marcas[l] !== 'E' && dados.campos[c].coluna !== '' && !ehGrande(dados.linhas[l][c])}
        onAlterar={alterar}
        onFoco={(l) => setFocoLinha(l)}
        onInserir={() => inserir()}
        onMenu={(e, l) => setMenu({ x: e.clientX, y: e.clientY, l })}
        onFimDaRolagem={() => void buscarMais()}
        classeLinha={(l) =>
          dados.marcas[l] === 'N'
            ? '!bg-emerald-50 dark:!bg-emerald-950/40'
            : dados.marcas[l] === 'A'
              ? '!bg-amber-50 dark:!bg-amber-950/40'
              : dados.marcas[l] === 'E'
                ? 'line-through text-rose-600 dark:text-rose-400 opacity-70'
                : undefined
        }
        rodape={(pos, total) =>
          pos > 0 && dados.marcas[pos - 1] === 'N' ? 'Novo registro' : `Registro ${milhar(pos)} de ${milhar(total)}${dados.fim ? '' : '+'}`
        }
        lerGrande={(l, c) => {
          const campo = dados.campos[c];
          const linha = dados.origs[l] ?? dados.linhas[l];
          const onde = pk.map((n) => {
            const i = indiceDe(dados.campos, n);
            return `${q(n)} = ${literal(linha[i], dados.campos[i])}`;
          });
          if (!onde.length || !ehBinario(campo) && !campo.coluna) return Promise.reject(new Error('Sem chave primária para buscar o valor.'));
          return lerGrande(alvo, q(campo.coluna), `FROM ${nomeTabela} WHERE ${onde.join(' AND ')}`);
        }}
      />
      {menu && <MenuContexto x={menu.x} y={menu.y} itens={itensMenu(menu.l)} onFechar={() => setMenu(null)} />}
    </div>
  );
});
