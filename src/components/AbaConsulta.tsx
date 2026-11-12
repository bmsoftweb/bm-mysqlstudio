/**
 * Aba de consulta SQL (o TQueryTab do desktop): banco da aba em cima, editor, resultados em abas embaixo
 * (um por SELECT, e as Mensagens) e a barra de status com situação, tempo, servidor, usuário e banco.
 *
 * A aba tem uma conexão só dela no servidor (sessão = id da aba): USE, variáveis e transações persistem entre
 * execuções. Na Vercel essa conexão pode se perder entre uma execução e outra: aí as Mensagens avisam.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alvo, Conjunto, ehConjunto, executar, fecharSessao, linhas, texto, ErroApi } from '../lib/api';
import { ARQ_SQL, SQL_BANCOS, colunasPk, criarArquivo, exportarCsv, milhar, q } from '../lib/db';
import { formatSql, paraExecutar, singleSelect, statementAt } from '../lib/sqlText';
import { avisar, confirmarDescarte } from '../lib/avisos';
import { Aba, useApp, useControleAba } from '../app/contexto';
import { EditorSql, EditorSqlApi, EsquemaSql } from './EditorSql';
import { GradeConjunto } from './GradeConjunto';
import { GradeDados, GradeDadosApi } from './GradeDados';
import { Abas, CAMPO, Divisor, useTamanho } from './ui';

interface Res {
  id: number;
  conjunto: Conjunto;
  /** Resultado de um SELECT só, com todas as colunas de uma tabela e a chave primária inteira: edita e salva na tabela */
  editavel?: { banco: string; tabela: string };
}

/** Tabelas e colunas de cada banco, para o autocompletar: lidas uma vez por conexão + banco */
const esquemas = new Map<string, Promise<EsquemaSql>>();

function esquemaDe(alvo: Alvo, banco: string): Promise<EsquemaSql> {
  const chave = `${alvo.conexao}|${banco}`;
  let p = esquemas.get(chave);
  if (!p) {
    p = linhas(alvo, 'SELECT table_name, column_name FROM information_schema.columns WHERE table_schema=? ORDER BY table_name, ordinal_position', [banco]).then((r) => {
      const e: EsquemaSql = {};
      for (const [t, c] of r) (e[t] ??= []).push(c);
      return e;
    });
    p.catch(() => esquemas.delete(chave));
    esquemas.set(chave, p);
  }
  return p;
}

const duracao = (ms: number) => {
  const p = (n: number, t = 2) => String(n).padStart(t, '0');
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
};

type JanelaComArquivos = Window & { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> };

export const AbaConsulta: React.FC<{ aba: Extract<Aba, { tipo: 'consulta' }>; ativa: boolean }> = ({ aba, ativa }) => {
  const app = useApp();
  const conexao = app.conexao(aba.conexao);
  const [banco, setBanco] = useState(aba.banco);
  const [bancos, setBancos] = useState<string[]>([]);
  const [limite, setLimite] = useState(1000);
  const [esquema, setEsquema] = useState<EsquemaSql>();
  const [resultados, setResultados] = useState<Res[]>([]);
  const [mensagens, setMensagens] = useState('');
  const [abaRes, setAbaRes] = useState('msg');
  const [rodando, setRodando] = useState(false);
  const [situacao, setSituacao] = useState('');
  const [tempo, setTempo] = useState('');
  const [alturaEditor, arrastar] = useTamanho(300, 80);
  const editor = useRef<EditorSqlApi>(null);
  const gradeEditavel = useRef<GradeDadosApi>(null);
  const cancelar = useRef<AbortController | null>(null);
  const jaRodou = useRef(false);
  const arquivo = useRef<FileSystemFileHandle | null>(null);
  const proximoId = useRef(1);
  const modificado = useRef(false);

  const alvo = useMemo<Alvo>(() => ({ conexao: aba.conexao, banco, sessao: aba.id }), [aba.conexao, aba.id, banco]);

  // Autocompletar: tabelas e colunas do banco em uso
  useEffect(() => {
    let vale = true;
    setEsquema(undefined);
    if (banco) {
      esquemaDe({ conexao: aba.conexao }, banco)
        .then((e) => vale && setEsquema(e))
        .catch((e) => app.log('Autocompletar: ' + (e as Error).message)); // sem lista de tabelas: segue só com as palavras-chave
    }
    return () => {
      vale = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aba.conexao, banco]);

  // Aba fechada: solta a conexão dela no servidor
  useEffect(() => () => void fecharSessao(aba.id), [aba.id]);

  useEffect(() => {
    if (ativa) editor.current?.focar();
  }, [ativa]);

  const temAlteracoes = () => Boolean(gradeEditavel.current?.temAlteracoes());

  /** Editável: um SELECT só, todas as colunas da mesma tabela e a chave primária inteira no resultado. */
  const origemEditavel = async (sql: string, c: Conjunto): Promise<Res['editavel']> => {
    const f = c.campos[0];
    if (!f || !f.tabela || !f.banco || !singleSelect(sql)) return undefined;
    if (c.campos.some((x) => !x.coluna || x.tabela !== f.tabela || x.banco !== f.banco)) return undefined;
    try {
      const pk = await colunasPk({ conexao: aba.conexao }, f.banco, f.tabela);
      const tem = (n: string) => c.campos.some((x) => x.coluna.toLowerCase() === n.toLowerCase());
      // sem a chave inteira o UPDATE não teria como achar a linha
      return pk.length && pk.every(tem) ? { banco: f.banco, tabela: f.tabela } : undefined;
    } catch {
      return undefined; // sem conseguir conferir, fica só leitura
    }
  };

  /** atual: só a instrução onde está o cursor (Ctrl+Enter), que fica selecionada. */
  const rodar = async (atual = false) => {
    const ed = editor.current;
    if (rodando || !ed) return;
    let s = ed.selecao();
    if (atual && !s.texto) {
      const st = statementAt(ed.texto(), s.de);
      if (!st) return;
      ed.selecionar(st.start, st.start + st.len);
      s = ed.selecao();
    }
    const sql = s.texto || ed.texto();
    const lote = paraExecutar(sql);
    if (!sql.trim() || !lote.length) return; // só linhas DELIMITER: nada a executar
    if (temAlteracoes() && !(await confirmarDescarte('O resultado tem alterações não salvas. Descartar?'))) return;

    setResultados([]);
    setMensagens('Executando...');
    setSituacao('Executando...');
    setTempo('');
    setAbaRes('msg');
    setRodando(true);
    cancelar.current = new AbortController();
    const inicio = Date.now();
    let log = '';
    let falhou = false;
    const novos: Res[] = [];
    try {
      const r = await executar(alvo, lote, { limite, sinal: cancelar.current.signal });
      if (r.sessaoNova && jaRodou.current) {
        log += 'Atenção: a conexão desta aba foi reaberta pelo servidor. Variáveis de sessão, tabelas temporárias e transação aberta de antes não existem mais.\r\n';
      }
      jaRodou.current = true;
      for (const x of r.resultados) {
        if (ehConjunto(x)) {
          novos.push({ id: proximoId.current++, conjunto: x });
          log += `${milhar(x.linhas.length)} linha(s) retornada(s).${x.truncado ? ` Resultado cortado no limite de ${milhar(limite)} linhas (ou de tamanho): aumente o limite ou filtre a consulta. As instruções seguintes não foram executadas.` : ''}\r\n`;
        } else log += `${milhar(x.afetadas)} linha(s) afetada(s).${x.info ? ' ' + x.info : ''}\r\n`;
      }
      if (r.erro) {
        falhou = true;
        log += `ERRO: ${r.erro}\r\n`;
      }
      // USE dentro do próprio SQL: o combo "Banco", a barra de status e o autocompletar acompanham
      if (r.banco && r.banco !== banco) setBanco(r.banco);
      // Estrutura mudou: o autocompletar relê as tabelas na próxima vez
      if (/\b(create|alter|drop|rename)\b/i.test(sql)) esquemas.delete(`${aba.conexao}|${r.banco || banco}`);
      if (novos.length === 1 && !r.erro) novos[0].editavel = await origemEditavel(sql, novos[0].conjunto);
    } catch (e) {
      falhou = true;
      log += `ERRO: ${(e as Error).message}\r\n`;
      if (e instanceof ErroApi && e.codigo === 'INTERROMPIDA') jaRodou.current = true;
    }
    setRodando(false);
    setResultados(novos);
    setMensagens(log);
    setAbaRes(novos.length ? String(novos[0].id) : 'msg');
    setSituacao(falhou ? 'Consulta com erro' : 'Consulta executada com sucesso');
    setTempo(duracao(Date.now() - inicio));
    app.log(`${aba.titulo} (${conexao?.nome}/${banco}): ${log.replace(/\r\n/g, ' ').trim()}`);
  };

  const formatar = () => {
    const ed = editor.current;
    if (!ed) return;
    if (!ed.selecao().texto) ed.selecionarTudo();
    ed.substituirSelecao(formatSql(ed.selecao().texto)); // pela seleção: Ctrl+Z desfaz
  };

  /** Troca o banco da aba (combo "Banco"): USE na conexão da aba. */
  const trocarBanco = async (novo: string) => {
    if (rodando || novo === banco) return;
    try {
      const r = await executar(alvo, `USE ${q(novo)}`);
      if (r.erro) throw new Error(r.erro);
      setBanco(novo);
    } catch (e) {
      avisar.erro(e); // consulta rodando ou erro no USE: o combo volta para o banco em uso
    }
  };

  /** Lista os bancos do servidor cada vez que o combo abre (pega os criados depois de a aba abrir). */
  const listarBancos = async () => {
    try {
      setBancos((await linhas({ conexao: aba.conexao }, SQL_BANCOS)).map((r) => r[0]));
    } catch (e) {
      avisar.erro(e);
    }
  };

  /** UTF-8 sem BOM, como o cliente mysql espera. Com acesso ao disco (Chrome/Edge) regrava o mesmo arquivo. */
  const salvar = async (comoNovo: boolean) => {
    const ed = editor.current;
    if (!ed) return;
    const nome = aba.titulo.toLowerCase().endsWith('.sql') ? aba.titulo : aba.titulo + '.sql';
    try {
      const w = window as JanelaComArquivos;
      if (w.showSaveFilePicker) {
        if (comoNovo || !arquivo.current) {
          try {
            arquivo.current = await w.showSaveFilePicker({ suggestedName: nome, types: [{ description: ARQ_SQL.descricao, accept: ARQ_SQL.aceita }] });
          } catch (e) {
            if ((e as Error).name === 'AbortError') return;
            throw e;
          }
        }
        const saida = await arquivo.current.createWritable();
        await saida.write(ed.texto());
        await saida.close();
        app.alterarAba(aba.id, { titulo: arquivo.current.name });
        app.log('SQL salvo em ' + arquivo.current.name);
      } else {
        const g = await criarArquivo(nome, ARQ_SQL);
        if (!g) return;
        await g.escrever(ed.texto());
        await g.fechar();
        app.log('SQL baixado como ' + g.nome);
      }
      modificado.current = false;
    } catch (e) {
      avisar.erro(e);
    }
  };

  const exportar = () => {
    const r = resultados.find((x) => String(x.id) === abaRes) ?? resultados[0];
    if (!r) return avisar.alerta('Nenhum resultado para exportar.');
    if (r.editavel && gradeEditavel.current) return gradeEditavel.current.exportarCsv();
    exportarCsv('resultado.csv', r.conjunto.campos.map((c) => c.nome), r.conjunto.linhas.map((l) => l.map(texto))).catch(avisar.erro);
  };

  useControleAba(aba.id, {
    temAlteracoes,
    rodando: () => rodando,
    executar: () => void rodar(),
    executarAtual: () => void rodar(true),
    parar: () => cancelar.current?.abort(),
    formatar,
    salvar: () => void salvar(false),
    salvarComo: () => void salvar(true),
    exportarCsv: exportar,
  });

  // Primeira execução pedida ao abrir a aba (ex.: Selecionar 1000 linhas)
  const iniciou = useRef(false);
  useEffect(() => {
    if (iniciou.current) return;
    iniciou.current = true;
    if (aba.executar) setTimeout(() => void rodar(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const opcoesBanco = banco && !bancos.includes(banco) ? [banco, ...bancos] : bancos; // mostra o banco em uso, mesmo um de sistema

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-2 py-1 border-b border-borda text-xs">
        <label htmlFor={`banco-${aba.id}`} className="text-texto2">
          Banco:
        </label>
        <select id={`banco-${aba.id}`} value={banco} disabled={rodando} onFocus={listarBancos} onChange={(e) => void trocarBanco(e.target.value)} className={`${CAMPO} w-60`}>
          {!banco && <option value="">(nenhum)</option>}
          {opcoesBanco.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <label htmlFor={`limite-${aba.id}`} className="ml-3 text-texto2" title="Máximo de linhas trazidas por resultado">
          Limite de linhas:
        </label>
        <select id={`limite-${aba.id}`} value={limite} onChange={(e) => setLimite(Number(e.target.value))} className={`${CAMPO} w-24 text-right`}>
          {[1000, 5000, 20000, 100000].map((n) => (
            <option key={n} value={n}>
              {milhar(n)}
            </option>
          ))}
        </select>
      </div>
      <div style={{ height: alturaEditor }} className="shrink-0 flex min-h-0">
        <EditorSql
          ref={editor}
          inicial={aba.sql}
          esquema={esquema}
          onMudar={() => (modificado.current = true)}
          atalhos={{ F9: () => void rodar(), 'Ctrl-Enter': () => void rodar(true), 'Ctrl-k': formatar }}
          className="flex-1"
        />
      </div>
      <Divisor aoArrastar={arrastar} />
      <div className="flex-1 min-h-0 flex flex-col">
        {resultados.map((r) => (
          <div key={r.id} className={`flex-1 min-h-0 flex-col ${String(r.id) === abaRes ? 'flex' : 'hidden'}`}>
            {r.editavel ? (
              <GradeDados ref={gradeEditavel} alvo={{ conexao: aba.conexao }} banco={r.editavel.banco} tabela={r.editavel.tabela} resultado={r.conjunto} aoRecarregar={() => void rodar()} />
            ) : (
              <GradeConjunto conjunto={r.conjunto} ordenavel />
            )}
          </div>
        ))}
        <pre className={`flex-1 min-h-0 overflow-auto m-0 p-2 text-xs font-mono whitespace-pre-wrap ${abaRes === 'msg' ? '' : 'hidden'}`}>{mensagens}</pre>
        <Abas
          embaixo
          ativa={abaRes}
          onTrocar={setAbaRes}
          abas={[...resultados.map((r, i) => ({ id: String(r.id), titulo: `Resultado ${i + 1} (${milhar(r.conjunto.linhas.length)}${r.conjunto.truncado ? '+' : ''})` })), { id: 'msg', titulo: 'Mensagens' }]}
        />
      </div>
      <div className="shrink-0 h-6 flex items-center border-t border-borda bg-fundo2 text-[11px] text-texto2 whitespace-nowrap overflow-hidden">
        <span className={`w-72 px-2 truncate ${situacao === 'Consulta com erro' ? 'text-rose-600 dark:text-rose-400' : ''}`}>{situacao}</span>
        <span className="w-28 px-2 border-l border-borda">{tempo}</span>
        <span className="px-2 border-l border-borda truncate">{conexao?.servidor}</span>
        <span className="px-2 border-l border-borda truncate">{conexao?.usuario}</span>
        <span className="px-2 border-l border-borda truncate">{banco}</span>
      </div>
    </div>
  );
};
