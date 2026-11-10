/**
 * Explorador de banco de dados (a árvore e os comandos de objeto do uMain.pas): conexões > bancos > pastas
 * (Tabelas, Views, Procedures, Functions, Triggers) > objetos, carregados ao abrir cada nó. Menu de contexto,
 * seleção de várias tabelas com Ctrl/Shift, filtro e os comandos: nova consulta, gerar CREATE/SELECT, clonar,
 * renomear, deletar, backup, importar/exportar CSV, telas do servidor.
 */
import React, { forwardRef, useEffect, useImperativeHandle, useReducer, useRef, useState } from 'react';
import {
  ChevronDown, ChevronRight, Cog, Copy, Database, DatabaseBackup, Download, Eye, FileCode, Filter, Folder, History, Loader2, Pencil, Plug, Plus,
  RefreshCw, Search, Server, SlidersHorizontal, SquareFunction, Table2, TableProperties, Trash2, Unplug, Upload, Users, Activity, Zap, type LucideIcon,
} from 'lucide-react';
import { Alvo, Conexao, esquecerSenha, excluirConexao, linhas, rodar } from '../lib/api';
import { SQL_BANCOS, baixar, getCreate, milhar, q } from '../lib/db';
import { formatSql, isKeyword, dropParens, unquote } from '../lib/sqlText';
import { dumpDb, exportTableCsv, runScript } from '../lib/backup';
import { avisar, confirmar, pedirTexto } from '../lib/avisos';
import { AMBIENTES, COR_AMBIENTE, PastaArvore, useApp } from '../app/contexto';
import { ConexaoDialog } from './ConexaoDialog';
import { DialogoBackup, DialogoImportar } from './Backup';
import { Barra, Botao, BotaoBarra, CAMPO, Dialogo, ItemMenu, LinhaCampo, MenuContexto, SeparadorBarra } from './ui';
import { Toggle } from './Toggle';

type Tipo = 'conn' | 'db' | PastaArvore | 'table' | 'view' | 'routine' | 'trigger';

interface No {
  id: string;
  tipo: Tipo;
  conexao: number;
  banco: string;
  nome: string;
  texto: string;
  /** Tabela: quantidade de registros; rotina: PROCEDURE ou FUNCTION */
  extra: string;
}

export type Comando =
  | 'consulta' | 'selecionar' | 'dados' | 'create' | 'atualizar' | 'select' | 'novaConexao' | 'editarConexao' | 'duplicarConexao' | 'desconectar'
  | 'excluirConexao' | 'localizar' | 'conectar' | 'novaTabela' | 'editarTabela' | 'backup' | 'restaurar' | 'importar' | 'exportar' | 'sessoes'
  | 'variaveis' | 'status' | 'usuarios' | 'novaProcedure' | 'novaFunction' | 'novaTrigger' | 'novaView' | 'clonar' | 'deletar' | 'renomear' | 'novoBanco';

export interface ArvoreApi {
  /** Comando dos menus e botões da janela, sobre o nó selecionado */
  comando(c: Comando): void;
  /** Recarrega a pasta do banco (ou o banco, ou a conexão), se estiver aberta */
  atualizar(conexao: number, banco?: string, pasta?: PastaArvore): void;
  /** Conexão e banco do nó selecionado */
  selecionado(): { conexao: number; banco: string } | null;
  alternarFiltro(): void;
}

const PASTAS: PastaArvore[] = ['tables', 'views', 'procs', 'funcs', 'triggers'];
const NOME_PASTA: Record<PastaArvore, string> = { tables: 'Tabelas', views: 'Views', procs: 'Procedures', funcs: 'Functions', triggers: 'Triggers' };
const ehPasta = (t: Tipo): t is PastaArvore => (PASTAS as string[]).includes(t);
const ehFolha = (t: Tipo) => t === 'table' || t === 'view' || t === 'routine' || t === 'trigger';

const textoConexao = (c: Conexao) => c.nome + (c.ambiente > 0 ? `  [${AMBIENTES[c.ambiente]}]` : '');
const noConexao = (c: Conexao): No => ({ id: `c${c.id}`, tipo: 'conn', conexao: c.id, banco: '', nome: '', texto: textoConexao(c), extra: '' });

/** Crase só quando precisa: nome com caractere especial ou palavra reservada. */
// ponytail: isKeyword cobre as reservadas mais comuns, não a lista inteira do MySQL; ampliar sqlKeywords se faltar alguma
const ident = (nome: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(nome) && !isKeyword(nome) ? nome : q(nome));

/** Colunas para copiar os dados com INSERT ... SELECT: sem as calculadas (o INSERT não aceita valor nelas). */
async function copyCols(alvo: Alvo, banco: string, tabela: string): Promise<string> {
  const r = await linhas(
    alvo,
    "SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=? AND extra NOT LIKE '%VIRTUAL GENERATED%' AND extra NOT LIKE '%STORED GENERATED%' ORDER BY ordinal_position",
    [banco, tabela],
  );
  return r.map((l) => q(l[0])).join(', ');
}

/** Banco vazio com o charset e a collation de origem. Sem IF NOT EXISTS: se o destino já existe, para aqui. */
async function createDbLike(alvo: Alvo, origem: string, destino: string) {
  const r = await linhas(alvo, 'SELECT default_character_set_name, default_collation_name FROM information_schema.schemata WHERE schema_name=?', [origem]);
  await rodar(alvo, `CREATE DATABASE ${q(destino)}${r.length ? ` CHARACTER SET ${r[0][0]} COLLATE ${r[0][1]}` : ''}`);
}

/** Dump em memória (estrutura ou objetos de um banco: cabe com folga). */
async function dumpTexto(alvo: Alvo, banco: string, o: { estrutura: boolean; dados: boolean; objetos: boolean }): Promise<string> {
  const partes: string[] = [];
  await dumpDb(alvo, banco, { escrever: (t: string) => void partes.push(t) }, o);
  return partes.join('');
}

export const Arvore = forwardRef<ArvoreApi, { conexoes: Conexao[]; onConexoes: (c: Conexao[]) => void; onTitulo: (nome: string) => void }>(function Arvore(
  { conexoes, onConexoes, onTitulo },
  ref,
) {
  const app = useApp();
  // Estado mutável + contador de render: os comandos encadeiam várias cargas e precisam ler o que acabou de mudar
  const st = useRef({ filhos: new Map<string, No[]>(), abertos: new Set<string>(), carregando: new Set<string>() }).current;
  const [, render] = useReducer((x: number) => x + 1, 0);
  const [sel, setSel] = useState<string[]>([]); // o último é o nó atual
  const [filtro, setFiltro] = useState('');
  const [comFiltro, setComFiltro] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; itens: ItemMenu[] } | null>(null);
  const [dialogo, setDialogo] = useState<React.ReactNode>(null);
  const [ocupado, setOcupado] = useState('');
  const campoFiltro = useRef<HTMLInputElement>(null);
  const lista = useRef<HTMLDivElement>(null);

  const conexaoDe = (id: number) => conexoes.find((c) => c.id === id);
  const alvoDe = (no: No): Alvo => ({ conexao: no.conexao });
  const conectado = (no: No) => st.filhos.has(`c${no.conexao}`);

  // ==========================================================
  // Nós
  // ==========================================================
  const passa = (nome: string) => !filtro.trim() || nome.toLowerCase().includes(filtro.trim().toLowerCase());
  const filhosVisiveis = (no: No): No[] => {
    const f = st.filhos.get(no.id) ?? [];
    return ehPasta(no.tipo) ? f.filter((x) => passa(x.nome)) : f;
  };

  const visiveis: { no: No; nivel: number }[] = [];
  const andar = (nos: No[], nivel: number) => {
    for (const no of nos) {
      visiveis.push({ no, nivel });
      if (st.abertos.has(no.id) && st.filhos.has(no.id)) andar(filhosVisiveis(no), nivel + 1);
    }
  };
  andar(conexoes.map(noConexao), 0);
  const noDe = (id: string) => visiveis.find((v) => v.no.id === id)?.no;
  const atual = sel.length ? noDe(sel[sel.length - 1]) : undefined;

  useEffect(() => {
    onTitulo(atual ? (conexaoDe(atual.conexao)?.nome ?? '') : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atual?.conexao]);

  /** Carrega os filhos de um nó (o LoadChildren do desktop). */
  const carregar = async (no: No): Promise<No[]> => {
    const a = alvoDe(no);
    const base = { conexao: no.conexao, banco: no.banco, extra: '' };
    if (no.tipo === 'conn') {
      return (await linhas(a, SQL_BANCOS)).map((r) => ({ ...base, id: `${no.id}/${r[0]}`, tipo: 'db' as const, banco: r[0], nome: '', texto: r[0] }));
    }
    if (no.tipo === 'db') return PASTAS.map((p) => ({ ...base, id: `${no.id}/${p}`, tipo: p, nome: '', texto: NOME_PASTA[p] }));
    if (no.tipo === 'tables' || no.tipo === 'views') {
      const tabela = no.tipo === 'tables';
      const t = await linhas(
        a,
        `SELECT table_name, table_rows FROM information_schema.tables WHERE table_schema=? AND table_type ${tabela ? "= 'BASE TABLE'" : "LIKE '%VIEW'"} ORDER BY 1`,
        [no.banco],
      );
      // Quantidade de registros ao lado da tabela. O table_rows é só estimativa no InnoDB: as tabelas pequenas são
      // contadas de verdade (numa consulta só); as grandes ficam com a estimativa, marcada com "~".
      // ponytail: limite fixo por tabela; se muitas tabelas médias deixarem a abertura lenta, contar em segundo plano
      const extras = t.map((r) => (tabela ? '~' + milhar(Number(r[1]) || 0) : ''));
      if (tabela) {
        const contar = t.map((r, i) => ((Number(r[1]) || 0) < 100000 ? `SELECT ${i}, COUNT(*) FROM ${q(no.banco)}.${q(r[0])}` : '')).filter(Boolean);
        if (contar.length) {
          try {
            for (const r of await linhas(a, contar.join(' UNION ALL '))) extras[Number(r[0])] = milhar(r[1]);
          } catch {
            // sem permissão de SELECT ou tabela com defeito: fica a estimativa
          }
        }
      }
      return t.map((r, i) => ({ ...base, id: `${no.id}/${r[0]}`, tipo: tabela ? ('table' as const) : ('view' as const), nome: r[0], texto: r[0], extra: extras[i] }));
    }
    if (no.tipo === 'procs' || no.tipo === 'funcs') {
      const r = await linhas(a, 'SELECT routine_name, routine_type FROM information_schema.routines WHERE routine_schema=? AND routine_type=? ORDER BY 1', [
        no.banco,
        no.tipo === 'procs' ? 'PROCEDURE' : 'FUNCTION',
      ]);
      return r.map((l) => ({ ...base, id: `${no.id}/${l[0]}`, tipo: 'routine' as const, nome: l[0], texto: l[0], extra: l[1] }));
    }
    if (no.tipo === 'triggers') {
      const r = await linhas(a, 'SELECT trigger_name, event_object_table FROM information_schema.triggers WHERE trigger_schema=? ORDER BY 1', [no.banco]);
      return r.map((l) => ({ ...base, id: `${no.id}/${l[0]}`, tipo: 'trigger' as const, nome: l[0], texto: `${l[0]} (${l[1]})` }));
    }
    return [];
  };

  /** Abre o nó, carregando os filhos se preciso. false em erro: o nó continua fechado (dá para tentar de novo). */
  const expandir = async (no: No): Promise<boolean> => {
    if (ehFolha(no.tipo)) return true;
    if (!st.filhos.has(no.id)) {
      if (st.carregando.has(no.id)) return false;
      st.carregando.add(no.id);
      render();
      try {
        st.filhos.set(no.id, await carregar(no));
      } catch (e) {
        if ((e as { codigo?: string }).codigo !== 'CANCELADA') avisar.erro(e);
        return false;
      } finally {
        st.carregando.delete(no.id);
        render();
      }
    }
    st.abertos.add(no.id);
    render();
    return true;
  };

  /** Esquece os filhos do nó e de tudo abaixo dele. */
  const limpar = (no: No) => {
    for (const k of [...st.filhos.keys()]) if (k === no.id || k.startsWith(no.id + '/')) st.filhos.delete(k);
    for (const k of [...st.abertos]) if (k.startsWith(no.id + '/')) st.abertos.delete(k);
  };

  const recarregar = async (no: No) => {
    limpar(no);
    await expandir(no);
  };

  /** Volta o nó de conexão ao estado "fechado" (depois de editar ou desconectar). */
  const desconectar = (no: No) => {
    limpar(no);
    st.abertos.delete(no.id);
    render();
  };

  const selecionar = (id: string) => {
    setSel([id]);
    setTimeout(() => lista.current?.querySelector(`[data-no="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' }), 0);
  };

  /** Abre a árvore até o objeto: conexão > banco > pasta > objeto. */
  const navegar = async (conexao: number, banco: string, pasta?: PastaArvore, nome?: string) => {
    const c = conexaoDe(conexao);
    if (!c) return;
    const raiz = noConexao(c);
    if (!(await expandir(raiz))) return;
    const db = st.filhos.get(raiz.id)?.find((n) => n.banco.toLowerCase() === banco.toLowerCase());
    if (!db) return selecionar(raiz.id);
    if (!pasta || !(await expandir(db))) return selecionar(db.id);
    const p = st.filhos.get(db.id)?.find((n) => n.tipo === pasta);
    if (!p || !(await expandir(p))) return selecionar(db.id);
    const obj = nome ? st.filhos.get(p.id)?.find((n) => n.nome.toLowerCase() === nome.toLowerCase()) : undefined;
    selecionar((obj ?? p).id);
  };

  // ==========================================================
  // Comandos
  // ==========================================================
  const erro = (e: unknown) => {
    if ((e as { codigo?: string }).codigo !== 'CANCELADA') avisar.erro(e);
  };

  const novaConexao = (base?: Partial<Conexao>) =>
    setDialogo(
      <ConexaoDialog
        conexao={base ?? {}}
        nomesEmUso={conexoes.map((c) => c.nome)}
        onFechar={() => setDialogo(null)}
        onSalvar={(c) => {
          setDialogo(null);
          onConexoes([...conexoes, c]);
          selecionar(`c${c.id}`);
        }}
      />,
    );

  const editarConexao = (no: No) => {
    const c = conexaoDe(no.conexao);
    if (!c) return;
    setDialogo(
      <ConexaoDialog
        conexao={c}
        nomesEmUso={conexoes.filter((x) => x.id !== c.id).map((x) => x.nome)}
        onFechar={() => setDialogo(null)}
        onSalvar={(nova) => {
          setDialogo(null);
          onConexoes(conexoes.map((x) => (x.id === nova.id ? nova : x)));
          desconectar(no);
        }}
      />,
    );
  };

  /** SELECT com todas as colunas, na ordem da tabela, numa aba nova (formatado, sem executar). Várias tabelas: um para cada. */
  const gerarSelect = async (no: No, tabelas: string[]) => {
    try {
      const r = await linhas(
        alvoDe(no),
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema=?${tabelas.length === 1 ? ' AND table_name=?' : ''} ORDER BY ordinal_position`,
        tabelas.length === 1 ? [no.banco, tabelas[0]] : [no.banco],
      );
      const cols = new Map<string, string[]>();
      for (const [t, c] of r) cols.set(t, [...(cols.get(t) ?? []), 'A.' + ident(c)]);
      // já formatado como no "Formatar SQL": um campo por linha, com a tabela no alias A
      const sql = tabelas.map((t) => formatSql(`SELECT ${cols.get(t)?.join(', ') || 'A.*'} FROM ${ident(t)} A;`)).join('\r\n\r\n');
      app.abrirConsulta(no.conexao, no.banco, sql);
    } catch (e) {
      erro(e);
    }
  };

  /** AEdit: pronto para alterar e Executar (rotina e trigger com DROP antes: o MySQL não tem CREATE OR REPLACE para elas). */
  const showCreate = async (no: No, tipoObj: string, editar = false) => {
    try {
      let ddl = await getCreate(alvoDe(no), tipoObj, no.banco, no.nome);
      if (tipoObj === 'VIEW') ddl = dropParens(unquote(ddl)); // o MySQL põe crase e parênteses em tudo: ficam só onde precisa
      if (!ddl) ddl = '-- sem permissão para ver a definição';
      else if (tipoObj === 'TABLE' && / FOREIGN KEY /i.test(ddl)) {
        // A tabela referenciada pode ainda não existir no banco onde o script vai rodar (como no mysqldump)
        ddl = `SET FOREIGN_KEY_CHECKS = 0;\n\n${ddl};\n\nSET FOREIGN_KEY_CHECKS = 1`;
      } else if (editar && tipoObj === 'VIEW') ddl = '-- Altere e clique em Executar para gravar.\n' + ddl.replace(/CREATE /i, 'CREATE OR REPLACE ');
      else if (editar) ddl = `-- Altere e clique em Executar para gravar.\nDROP ${tipoObj} IF EXISTS ${q(no.nome)};\n${ddl}`;
      app.abrirConsulta(no.conexao, no.banco, ddl + ';');
    } catch (e) {
      erro(e);
    }
  };

  const pastaDe = (no: No, pasta: PastaArvore): No => ({ ...no, id: `c${no.conexao}/${no.banco}/${pasta}`, tipo: pasta, nome: '', texto: NOME_PASTA[pasta], extra: '' });

  const comOcupado = async (textoOcupado: string, fn: () => Promise<void>) => {
    setOcupado(textoOcupado);
    try {
      await fn();
    } finally {
      setOcupado('');
    }
  };

  /**
   * Cópia da tabela no mesmo banco: CREATE TABLE ... LIKE (colunas, índices e chave primária) e, se ligado, os dados.
   * O LIKE do MySQL não copia chaves estrangeiras nem triggers; o diálogo avisa.
   */
  const clonarTabela = (no: No) =>
    setDialogo(
      <DialogoClonar
        titulo="Clonar tabela"
        origem={no.nome}
        subtitulo="Mesmas colunas, índices e chave primária. Chaves estrangeiras e triggers não vão junto."
        onFechar={() => setDialogo(null)}
        onOk={(destino, comDados) => {
          setDialogo(null);
          void comOcupado(`Clonando ${no.nome}...`, async () => {
            const a = alvoDe(no);
            try {
              const comandos = [`CREATE TABLE ${q(no.banco)}.${q(destino)} LIKE ${q(no.banco)}.${q(no.nome)}`];
              if (comDados) {
                const cols = await copyCols(a, no.banco, no.nome);
                comandos.push(`INSERT INTO ${q(no.banco)}.${q(destino)} (${cols}) SELECT ${cols} FROM ${q(no.banco)}.${q(no.nome)}`);
              }
              await rodar(a, comandos);
              app.log(`${no.banco}.${no.nome} clonada como ${destino} (${comDados ? 'com os dados' : 'só a estrutura'})`);
            } catch (e) {
              erro(e);
            }
            // Recarrega a pasta Tabelas mesmo com erro (o CREATE pode ter passado e o INSERT não)
            limpar(pastaDe(no, 'tables'));
            await navegar(no.conexao, no.banco, 'tables', destino);
          });
        }}
      />,
    );

  /**
   * Banco novo com o mesmo charset: tabelas (do SHOW CREATE, com as chaves estrangeiras), dados copiados no próprio
   * servidor e, por último, views, rotinas e triggers (depois dos dados, para as triggers não dispararem no INSERT).
   */
  const clonarBanco = (no: No) =>
    setDialogo(
      <DialogoClonar
        titulo="Clonar banco"
        origem={no.banco}
        subtitulo="Tabelas, dados, views, procedures, functions e triggers. Usuários e privilégios não vão junto."
        onFechar={() => setDialogo(null)}
        onOk={(destino, comDados) => {
          setDialogo(null);
          void comOcupado(`Clonando o banco ${no.banco}...`, async () => {
            const a = alvoDe(no);
            const noDestino: Alvo = { ...a, banco: destino };
            try {
              await createDbLike(a, no.banco, destino);
              await runScript(noDestino, await dumpTexto(a, no.banco, { estrutura: true, dados: false, objetos: false }));
              if (comDados) {
                const comandos = ['SET FOREIGN_KEY_CHECKS = 0'];
                for (const [t] of await linhas(a, "SELECT table_name FROM information_schema.tables WHERE table_schema=? AND table_type='BASE TABLE'", [no.banco])) {
                  const cols = await copyCols(a, no.banco, t);
                  comandos.push(`INSERT INTO ${q(destino)}.${q(t)} (${cols}) SELECT ${cols} FROM ${q(no.banco)}.${q(t)}`);
                }
                // ponytail: um INSERT ... SELECT por tabela dentro de uma requisição; tabela enorme pode passar do tempo
                // limite da Vercel (5 min): aí clonar pelo backup + restauração
                await rodar(a, comandos);
              }
              await runScript(noDestino, await dumpTexto(a, no.banco, { estrutura: false, dados: false, objetos: true }));
              app.log(`Banco ${no.banco} clonado como ${destino} (${comDados ? 'com os dados' : 'só a estrutura'})`);
            } catch (e) {
              erro(e);
            }
            // Recarrega a conexão mesmo com erro: o banco novo pode ter ficado pela metade e precisa aparecer
            const c = conexaoDe(no.conexao);
            if (c) limpar(noConexao(c));
            await navegar(no.conexao, destino);
          });
        }}
      />,
    );

  /**
   * MySQL não tem RENAME DATABASE: cria o banco novo, passa as tabelas com RENAME TABLE (só metadado: dados, índices e
   * chaves estrangeiras vão junto), recria views, rotinas e triggers no novo e apaga o antigo, já sem tabelas.
   * As triggers saem antes (o RENAME TABLE não passa tabela com trigger para outro banco); se o RENAME falha, nada
   * foi movido e elas voltam. Depois desse ponto, se algo der errado, o .sql com os objetos é baixado.
   */
  const renomearBanco = async (no: No) => {
    const a = alvoDe(no);
    const origem = no.banco;
    const c = conexaoDe(no.conexao);
    if (!c) return;
    if (origem.toLowerCase() === c.banco.toLowerCase()) return avisar.alerta('É o banco padrão da conexão: troque o banco em Editar conexão antes de renomear.');
    try {
      if ((await linhas(a, 'SELECT 1 FROM information_schema.events WHERE event_schema=? LIMIT 1', [origem])).length) {
        return avisar.alerta('O banco tem eventos agendados (EVENT), que esta opção não leva para o novo nome.');
      }
    } catch (e) {
      return erro(e);
    }
    const destino = await pedirTexto({
      titulo: `Renomear ${origem}`,
      subtitulo: 'Tabelas, dados, views, rotinas e triggers vão para o novo nome. Privilégios dados no banco antigo não acompanham.',
      rotulo: 'Novo nome:',
      botao: 'Renomear',
      padrao: origem,
      validar: (v) => (v.toLowerCase() === origem.toLowerCase() ? 'Informe um nome diferente do atual.' : ''),
    });
    if (!destino) return;
    await comOcupado(`Renomeando ${origem}...`, async () => {
      let objetos = '';
      let guardar = false;
      try {
        objetos = await dumpTexto(a, origem, { estrutura: false, dados: false, objetos: true }); // views, rotinas e triggers
        await createDbLike(a, origem, destino);
        const triggers = (await linhas(a, 'SELECT trigger_name FROM information_schema.triggers WHERE trigger_schema=?', [origem])).map((r) => `DROP TRIGGER ${q(origem)}.${q(r[0])}`);
        const tabelas = (await linhas(a, "SELECT table_name FROM information_schema.tables WHERE table_schema=? AND table_type='BASE TABLE'", [origem]))
          .map((r) => `${q(origem)}.${q(r[0])} TO ${q(destino)}.${q(r[0])}`)
          .join(', ');
        guardar = true; // daqui em diante o banco antigo muda
        if (triggers.length) await rodar(a, triggers);
        try {
          if (tabelas) await rodar(a, `RENAME TABLE ${tabelas}`);
        } catch (e) {
          await runScript({ ...a, banco: origem }, objetos); // o RENAME TABLE é tudo ou nada: só devolve as triggers
          guardar = false;
          await rodar(a, `DROP DATABASE ${q(destino)}`); // criado acima, ainda vazio
          throw e;
        }
        await runScript({ ...a, banco: destino }, objetos);
        if (!(await linhas(a, "SELECT 1 FROM information_schema.tables WHERE table_schema=? AND table_type='BASE TABLE' LIMIT 1", [origem])).length) {
          await rodar(a, `DROP DATABASE ${q(origem)}`);
        }
        guardar = false;
        app.log(`Banco ${origem} renomeado para ${destino}`);
        app.fecharAbasDoObjeto(no.conexao, origem); // abertas com o nome antigo
      } catch (e) {
        if (guardar) {
          baixar(`objetos_${origem}.sql`, objetos);
          avisar.erro(`${(e as Error).message}\n\nAs views, rotinas e triggers de ${origem} foram baixadas no arquivo objetos_${origem}.sql.`);
        } else erro(e);
      }
      limpar(noConexao(c));
      await navegar(no.conexao, destino);
    });
  };

  /** CREATE DATABASE com o charset padrão do servidor; recarrega a conexão e deixa o banco novo selecionado. */
  const novoBanco = async (no: No) => {
    const c = conexaoDe(no.conexao);
    if (!c) return;
    const nome = await pedirTexto({ titulo: `Novo banco em ${c.nome}`, subtitulo: 'Usa o charset e a collation padrão do servidor.', rotulo: 'Nome:', botao: 'Criar' });
    if (!nome) return;
    try {
      await rodar(alvoDe(no), `CREATE DATABASE ${q(nome)}`);
      app.log(`Banco ${nome} criado`);
    } catch (e) {
      return erro(e); // ex.: já existe um banco com esse nome
    }
    limpar(noConexao(c));
    await navegar(no.conexao, nome);
  };

  /** DROP TABLE / DROP DATABASE só depois de digitar o nome. */
  const deletar = async (no: No) => {
    const c = conexaoDe(no.conexao);
    if (!c) return;
    const banco = no.tipo === 'db';
    if (banco && no.banco.toLowerCase() === c.banco.toLowerCase()) {
      return avisar.alerta('É o banco padrão da conexão: troque o banco em Editar conexão antes de deletar.');
    }
    const esperado = banco ? no.banco : no.nome;
    const ok = await pedirTexto({
      titulo: `Deletar ${banco ? no.banco : `${no.banco}.${no.nome}`}`,
      subtitulo: banco
        ? 'Apaga o banco inteiro (tabelas, dados, views e rotinas), sem como desfazer. Digite o nome dele para confirmar.'
        : 'Apaga a tabela e todos os dados, sem como desfazer. Digite o nome dela para confirmar.',
      rotulo: 'Confirme o nome:',
      botao: 'Deletar',
      tom: 'perigo',
      validar: (v) => (v !== esperado ? 'O nome digitado não confere.' : ''),
    });
    if (!ok) return;
    try {
      await rodar(alvoDe(no), banco ? `DROP DATABASE ${q(no.banco)}` : `DROP TABLE ${q(no.banco)}.${q(no.nome)}`);
      app.log(banco ? `Banco ${no.banco} deletado` : `${no.banco}.${no.nome} deletada`);
    } catch (e) {
      return erro(e); // ex.: chave estrangeira de outra tabela apontando para ela
    }
    app.fecharAbasDoObjeto(no.conexao, no.banco, banco ? undefined : no.nome);
    if (banco) await recarregar(noConexao(c));
    else await recarregar(pastaDe(no, 'tables'));
  };

  /** Nomes das tabelas selecionadas com Ctrl/Shift, quando o nó é uma delas e a seleção é só de tabelas da mesma pasta. */
  const tabelasSelecionadas = (no: No | undefined): string[] | null => {
    if (!no || sel.length < 2 || !sel.includes(no.id)) return null;
    const nos = visiveis.filter((v) => sel.includes(v.no.id)).map((v) => v.no);
    if (nos.length !== sel.length || nos.some((n) => n.tipo !== 'table' || n.conexao !== no.conexao || n.banco !== no.banco)) return null;
    return nos.map((n) => n.nome);
  };

  const gerarCreates = async (no: No, tabelas: string[]) => {
    await comOcupado('Lendo as definições...', async () => {
      try {
        const partes: string[] = [];
        for (const t of tabelas) {
          const d = await getCreate(alvoDe(no), 'TABLE', no.banco, t);
          partes.push(d ? d + ';' : `-- ${t}: sem permissão para ver a definição`);
        }
        // Saem em ordem alfabética: sem a checagem, a chave estrangeira pode apontar para tabela criada depois
        // (ou para ela mesma / em ciclo), como no mysqldump.
        app.abrirConsulta(no.conexao, no.banco, `SET FOREIGN_KEY_CHECKS = 0;\n\n${partes.join('\n\n')}\n\nSET FOREIGN_KEY_CHECKS = 1;`);
      } catch (e) {
        erro(e);
      }
    });
  };

  const deletarTabelas = async (no: No, tabelas: string[]) => {
    // A quantidade, e não os nomes: confere se o Shift não pegou tabelas a mais
    const ok = await pedirTexto({
      titulo: `Deletar ${tabelas.length} tabelas de ${no.banco}`,
      subtitulo: 'Apaga as tabelas selecionadas e todos os dados, sem como desfazer. Digite a quantidade de tabelas para confirmar.',
      rotulo: 'Quantidade:',
      botao: 'Deletar',
      tom: 'perigo',
      validar: (v) => (v !== String(tabelas.length) ? 'A quantidade digitada não confere.' : ''),
    });
    if (!ok) return;
    try {
      // um comando só: no InnoDB, ou apaga todas ou nenhuma
      await rodar(alvoDe(no), `DROP TABLE ${tabelas.map((t) => `${q(no.banco)}.${q(t)}`).join(', ')}`);
      app.log(`${tabelas.length} tabelas deletadas de ${no.banco}: ${tabelas.join(', ')}`);
    } catch (e) {
      return erro(e); // ex.: chave estrangeira de outra tabela apontando para uma delas
    }
    for (const t of tabelas) app.fecharAbasDoObjeto(no.conexao, no.banco, t);
    setSel([]);
    await recarregar(pastaDe(no, 'tables'));
  };

  const precisa = (no: No | undefined, tipos: Tipo[], aviso: string): no is No => {
    if (no && tipos.includes(no.tipo)) return true;
    avisar.alerta(aviso);
    return false;
  };

  const comando = (c: Comando, alvoNo: No | undefined = atual) => {
    if (c === 'novaConexao') return novaConexao();
    const no = alvoNo;
    if (!no) {
      if (c === 'consulta') avisar.alerta('Selecione uma conexão na árvore.');
      else if (c === 'localizar') avisar.alerta(conexoes.length ? 'Selecione uma conexão na árvore.' : 'Cadastre uma conexão primeiro.');
      else avisar.alerta('Selecione uma conexão, um banco ou uma tabela no explorador.');
      return;
    }
    const cx = conexaoDe(no.conexao);
    if (!cx) return;
    const raiz = noConexao(cx);
    const banco = no.banco || cx.banco;
    switch (c) {
      case 'consulta': return app.abrirConsulta(no.conexao, banco, '');
      case 'selecionar': return app.abrirConsulta(no.conexao, no.banco, `SELECT * FROM ${q(no.nome)} LIMIT 1000;`, true);
      case 'dados': return precisa(no, ['table'], 'Selecione uma tabela no explorador.') && app.abrirTabela(no.conexao, no.banco, no.nome, true);
      case 'editarTabela': return precisa(no, ['table'], 'Selecione uma tabela no explorador.') && app.abrirTabela(no.conexao, no.banco, no.nome, false);
      case 'create':
        return void showCreate(no, no.tipo === 'table' ? 'TABLE' : no.tipo === 'view' ? 'VIEW' : no.tipo === 'trigger' ? 'TRIGGER' : no.extra);
      case 'select': return void gerarSelect(no, [no.nome]);
      case 'atualizar': {
        // Em rotina e trigger, atualiza a pasta; conexão fechada não tem o que atualizar
        const n = ehFolha(no.tipo) ? pastaDe(no, no.tipo === 'table' ? 'tables' : no.tipo === 'view' ? 'views' : no.tipo === 'trigger' ? 'triggers' : no.extra === 'FUNCTION' ? 'funcs' : 'procs') : no;
        if (n.tipo === 'conn' && !conectado(n)) return;
        return void recarregar(n);
      }
      case 'editarConexao': return editarConexao(raiz);
      case 'duplicarConexao': return novaConexao({ ...cx, id: undefined, nome: cx.nome + ' (cópia)', tem_senha: false });
      case 'desconectar': {
        esquecerSenha(cx.id);
        return desconectar(raiz); // as abas de consulta abertas continuam com a conexão delas
      }
      case 'excluirConexao':
        return void confirmar({ titulo: 'Excluir a conexão?', mensagem: `Excluir a conexão "${cx.nome}"?\nSó sai do cadastro: o banco não é alterado.` }).then(async (ok) => {
          if (!ok) return;
          try {
            await excluirConexao(cx.id);
            desconectar(raiz);
            onConexoes(conexoes.filter((x) => x.id !== cx.id));
            setSel([]);
          } catch (e) {
            erro(e);
          }
        });
      case 'conectar': return void expandir(raiz);
      case 'localizar':
        return setDialogo(<Localizar conexao={cx} onFechar={() => setDialogo(null)} onIr={(tipo, db, nome, detalhe) => {
          setDialogo(null);
          setFiltro(''); // o objeto pode estar escondido pelo filtro
          if (tipo === 'Tabela') void navegar(cx.id, db, 'tables', nome);
          else if (tipo === 'View') void navegar(cx.id, db, 'views', nome);
          else if (tipo === 'Rotina') void navegar(cx.id, db, detalhe.toLowerCase() === 'function' ? 'funcs' : 'procs', nome);
          else if (tipo === 'Trigger') void navegar(cx.id, db, 'triggers', nome);
          else void navegar(cx.id, db, 'tables', detalhe); // coluna: a tabela dela
        }} />);
      case 'novaTabela':
        if (!banco) return avisar.alerta('Selecione um banco no explorador.');
        return app.abrirTabela(no.conexao, banco, '');
      case 'backup':
      case 'restaurar':
        return setDialogo(<DialogoBackup conexao={cx} banco={banco} restaurar={c === 'restaurar'} onFechar={() => {
          setDialogo(null);
          if (c === 'restaurar') void recarregar(raiz);
        }} />);
      case 'importar':
        if (!precisa(no, ['table'], 'Selecione uma tabela no explorador.')) return;
        return setDialogo(<DialogoImportar conexao={cx} banco={no.banco} tabela={no.nome} onFechar={() => setDialogo(null)} />);
      case 'exportar':
        if (!precisa(no, ['table'], 'Selecione uma tabela no explorador.')) return;
        return void exportTableCsv(alvoDe(no), no.banco, no.nome).catch(erro);
      case 'sessoes':
      case 'variaveis':
      case 'status':
      case 'usuarios':
        return app.abrirServidor(no.conexao, c);
      case 'novaProcedure': return app.abrirRotina(no.conexao, banco, '', false);
      case 'novaFunction': return app.abrirRotina(no.conexao, banco, '', true);
      case 'novaTrigger':
        // Consulta com o modelo do CREATE; o Executar manda o texto inteiro, então o corpo com ';' não precisa de DELIMITER
        return app.abrirConsulta(
          no.conexao,
          banco,
          'CREATE TRIGGER `nova_trigger` BEFORE INSERT ON `nome_da_tabela`\r\nFOR EACH ROW\r\nBEGIN\r\n    -- NEW.coluna = valor novo, OLD.coluna = valor anterior\r\nEND;',
        );
      case 'novaView': return app.abrirView(no.conexao, banco, '');
      case 'clonar':
        if (!precisa(no, ['table', 'db'], 'Selecione uma tabela no explorador.')) return;
        return no.tipo === 'db' ? clonarBanco(no) : clonarTabela(no);
      case 'deletar':
        if (!precisa(no, ['table', 'db'], 'Selecione uma tabela no explorador.')) return;
        return void deletar(no);
      case 'renomear': return precisa(no, ['db'], 'Selecione um banco no explorador.') && void renomearBanco(no);
      case 'novoBanco': return void novoBanco(raiz);
    }
  };

  const alternarFiltro = () => {
    if (comFiltro) setFiltro(''); // esconder o filtro volta a mostrar tudo
    else setTimeout(() => campoFiltro.current?.focus(), 0);
    setComFiltro(!comFiltro);
  };

  useImperativeHandle(ref, () => ({
    comando: (c) => comando(c),
    atualizar: (conexao, banco, pasta) => {
      const c = conexaoDe(conexao);
      if (!c) return;
      const raiz = noConexao(c);
      const no: No = !banco ? raiz : !pasta ? { ...raiz, id: `${raiz.id}/${banco}`, tipo: 'db', banco } : pastaDe({ ...raiz, banco }, pasta);
      // Só o que já estava carregado: pasta nunca aberta carrega atualizada quando abrir
      if (st.filhos.has(no.id)) void (st.abertos.has(no.id) ? recarregar(no) : (limpar(no), render()));
    },
    selecionado: () => (atual ? { conexao: atual.conexao, banco: atual.banco || conexaoDe(atual.conexao)?.banco || '' } : null),
    alternarFiltro,
  }));

  // ==========================================================
  // Menu de contexto
  // ==========================================================
  const itensMenu = (no: No | undefined): ItemMenu[] => {
    const varias = tabelasSelecionadas(no);
    if (no && varias) {
      // Clique numa das várias tabelas selecionadas: ações para todas; a seleção fica como está
      return [
        { texto: 'Gerar CREATE', icone: FileCode, onClick: () => void gerarCreates(no, varias) },
        { texto: 'Gerar SELECT', icone: FileCode, onClick: () => void gerarSelect(no, varias) },
        '-',
        { texto: 'Deletar tabelas...', icone: Trash2, perigo: true, onClick: () => void deletarTabelas(no, varias) },
      ];
    }
    if (!no) return [{ texto: 'Nova conexão...', icone: Plus, onClick: () => comando('novaConexao') }];
    const it: ItemMenu[] = [];
    const add = (texto: string, c: Comando, icone?: LucideIcon, perigo?: boolean) => it.push({ texto, icone, perigo, onClick: () => comando(c, no) });
    const t = no.tipo;
    if (t === 'conn' || t === 'db') {
      add('Nova consulta', 'consulta', FileCode);
      add('Localizar objeto...', 'localizar', Search);
    }
    if (t === 'conn') add('Novo banco...', 'novoBanco', Database);
    if (t === 'db' || t === 'tables') add('Nova tabela...', 'novaTabela', Plus);
    if (t === 'views') add('Nova view...', 'novaView', Eye);
    if (t === 'procs') add('Nova procedure...', 'novaProcedure', Cog);
    if (t === 'funcs') add('Nova function...', 'novaFunction', SquareFunction);
    if (t === 'triggers') add('Nova trigger...', 'novaTrigger', Zap);
    if (t === 'table' || t === 'view') {
      add('Selecionar 1000 linhas', 'selecionar', Table2);
      if (t === 'table') {
        add('Editar dados', 'dados', Pencil);
        add('Editar tabela', 'editarTabela', TableProperties);
        add('Clonar...', 'clonar', Copy);
      }
      add('Gerar CREATE', 'create', FileCode);
      add('Gerar SELECT', 'select', FileCode);
    }
    if (t === 'table') {
      it.push('-');
      add('Exportar dados (CSV)...', 'exportar', Download);
      add('Importar dados (CSV)...', 'importar', Upload);
    }
    if (t === 'routine' || t === 'trigger') add('Gerar CREATE', 'create', FileCode);
    if (t === 'conn' || t === 'db') {
      it.push('-');
      add('Backup do banco...', 'backup', DatabaseBackup);
      add('Restaurar backup...', 'restaurar', History);
    }
    if (t === 'db') {
      add('Clonar...', 'clonar', Copy);
      add('Renomear...', 'renomear', Pencil);
    }
    if (t === 'conn') {
      it.push('-');
      add('Sessões', 'sessoes', Activity);
      add('Variáveis do servidor', 'variaveis', SlidersHorizontal);
      add('Status do servidor', 'status', Server);
      add('Usuários e privilégios', 'usuarios', Users);
    }
    if (!ehFolha(t) && (t !== 'conn' || conectado(no))) {
      it.push('-');
      add('Atualizar', 'atualizar', RefreshCw);
    }
    if (t === 'table' || t === 'db') {
      it.push('-');
      add(t === 'db' ? 'Deletar banco...' : 'Deletar tabela...', 'deletar', Trash2, true);
    }
    if (t === 'conn') {
      if (conectado(no)) add('Desconectar', 'desconectar', Unplug);
      it.push('-');
      add('Nova conexão...', 'novaConexao', Plus);
      add('Duplicar conexão...', 'duplicarConexao', Copy);
      add('Editar conexão...', 'editarConexao', Pencil);
      it.push('-');
      add('Excluir conexão', 'excluirConexao', Trash2, true);
    }
    return it;
  };

  // ==========================================================
  // Mouse e teclado
  // ==========================================================
  const clicar = (e: React.MouseEvent, no: No) => {
    if (e.ctrlKey || e.metaKey) setSel((s) => (s.includes(no.id) ? s.filter((x) => x !== no.id) : [...s, no.id]));
    else if (e.shiftKey && atual) {
      const a = visiveis.findIndex((v) => v.no.id === atual.id);
      const b = visiveis.findIndex((v) => v.no.id === no.id);
      const faixa = visiveis.slice(Math.min(a, b), Math.max(a, b) + 1).map((v) => v.no.id);
      setSel([...faixa.filter((x) => x !== no.id), no.id]);
    } else setSel([no.id]);
  };

  const alternar = (no: No) => {
    if (st.abertos.has(no.id) && st.filhos.has(no.id)) {
      st.abertos.delete(no.id);
      render();
    } else void expandir(no);
  };

  const abrir = (no: No) => {
    if (no.tipo === 'table') app.abrirTabela(no.conexao, no.banco, no.nome, true);
    else if (no.tipo === 'view') app.abrirView(no.conexao, no.banco, no.nome);
    else if (no.tipo === 'routine') app.abrirRotina(no.conexao, no.banco, no.nome, no.extra.toUpperCase() === 'FUNCTION');
    else if (no.tipo === 'trigger') void showCreate(no, 'TRIGGER', true);
    else alternar(no);
  };

  const teclar = (e: React.KeyboardEvent) => {
    const i = atual ? visiveis.findIndex((v) => v.no.id === atual.id) : -1;
    if (e.key === 'ArrowDown' && i < visiveis.length - 1) selecionar(visiveis[i + 1].no.id);
    else if (e.key === 'ArrowUp' && i > 0) selecionar(visiveis[i - 1].no.id);
    else if (e.key === 'ArrowRight' && atual && !ehFolha(atual.tipo)) void expandir(atual);
    else if (e.key === 'ArrowLeft' && atual && st.abertos.has(atual.id)) alternar(atual);
    else if (e.key === 'Enter' && atual) abrir(atual);
    else return;
    e.preventDefault();
  };

  const icone = (no: No) => {
    const cls = 'w-4 h-4 shrink-0';
    switch (no.tipo) {
      case 'conn': return conectado(no) ? <Plug className={`${cls} text-emerald-600`} /> : <Unplug className={`${cls} text-texto2`} />;
      case 'db': return <Database className={`${cls} text-amber-600`} />;
      case 'table': return <Table2 className={`${cls} text-blue-600`} />;
      case 'view': return <Eye className={`${cls} text-teal-600`} />;
      case 'routine': return no.extra.toUpperCase() === 'FUNCTION' ? <SquareFunction className={`${cls} text-purple-600`} /> : <Cog className={`${cls} text-purple-600`} />;
      case 'trigger': return <Zap className={`${cls} text-orange-600`} />;
      default: return <Folder className={`${cls} text-amber-500`} />;
    }
  };

  const barra = (titulo: string, c: Comando, Icone: LucideIcon) => <BotaoBarra icone={Icone} titulo={titulo} onClick={() => comando(c)} />;

  return (
    <div className="flex-1 min-h-0 flex flex-col text-xs">
      <Barra>
        {barra('Atualizar (Shift+F5)', 'atualizar', RefreshCw)}
        {barra('Excluir conexão', 'excluirConexao', Trash2)}
        {barra('Duplicar conexão...', 'duplicarConexao', Copy)}
        <SeparadorBarra />
        {barra('Nova conexão...', 'novaConexao', Plus)}
        {barra('Conectar', 'conectar', Plug)}
        {barra('Desconectar', 'desconectar', Unplug)}
        <SeparadorBarra />
        {barra('Editar conexão...', 'editarConexao', Pencil)}
        <BotaoBarra icone={Filter} titulo="Filtro do explorador" onClick={alternarFiltro} ativo={comFiltro} />
        {barra('Localizar objeto... (Ctrl+Shift+F)', 'localizar', Search)}
      </Barra>
      {comFiltro && (
        <div className="shrink-0 p-1 border-b border-borda">
          <input ref={campoFiltro} value={filtro} onChange={(e) => setFiltro(e.target.value)} placeholder="Filtrar tabelas, views, rotinas..." className={`${CAMPO} w-full`} />
        </div>
      )}
      <div
        ref={lista}
        tabIndex={0}
        onKeyDown={teclar}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, itens: itensMenu(undefined) }); // clique em área vazia da árvore
        }}
        className="flex-1 min-h-0 overflow-auto outline-none py-0.5 select-none"
      >
        {visiveis.map(({ no, nivel }) => {
          const selecionado = sel.includes(no.id);
          const aberto = st.abertos.has(no.id) && st.filhos.has(no.id);
          const cx = no.tipo === 'conn' ? conexaoDe(no.conexao) : undefined;
          return (
            <div
              key={no.id}
              data-no={no.id}
              onMouseDown={(e) => e.button === 0 && clicar(e, no)}
              onDoubleClick={() => abrir(no)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                // Com várias selecionadas e o clique fora delas, fica só este (o menu é dele)
                if (!tabelasSelecionadas(no)) setSel([no.id]);
                setMenu({ x: e.clientX, y: e.clientY, itens: itensMenu(no) });
              }}
              style={{ paddingLeft: 4 + nivel * 16 }}
              className={`h-6 flex items-center gap-1 pr-2 cursor-default whitespace-nowrap ${selecionado ? 'bg-selecao' : 'hover:bg-fundo2'}`}
            >
              <span
                className="w-4 h-4 shrink-0 flex items-center justify-center text-texto2"
                onMouseDown={(e) => {
                  if (ehFolha(no.tipo)) return;
                  e.stopPropagation();
                  alternar(no);
                }}
              >
                {st.carregando.has(no.id) ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : ehFolha(no.tipo) ? null : aberto ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
              </span>
              {icone(no)}
              <span className={`truncate ${cx && !selecionado ? COR_AMBIENTE[cx.ambiente] : ''}`}>
                {no.texto}
                {ehPasta(no.tipo) && st.filhos.has(no.id) && ` (${filhosVisiveis(no).length})`}
              </span>
              {no.tipo === 'table' && no.extra && <span className="ml-auto pl-3 text-texto2">{no.extra}</span>}
            </div>
          );
        })}
        {!conexoes.length && (
          <div className="p-4 text-center text-texto2">
            Nenhuma conexão cadastrada.
            <div className="mt-2 flex justify-center">
              <Botao icone={Plus} onClick={() => novaConexao()}>
                Nova conexão
              </Botao>
            </div>
          </div>
        )}
      </div>
      {ocupado && (
        <div className="shrink-0 flex items-center gap-2 px-2 py-1 border-t border-borda bg-fundo2 text-texto2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span className="truncate">{ocupado}</span>
        </div>
      )}
      {menu && <MenuContexto x={menu.x} y={menu.y} itens={menu.itens} onFechar={() => setMenu(null)} />}
      {dialogo}
    </div>
  );
});

// ==========================================================
// Clonar (tabela ou banco): nome da cópia e se vai com os dados
// ==========================================================
const DialogoClonar: React.FC<{ titulo: string; origem: string; subtitulo: string; onOk: (destino: string, comDados: boolean) => void; onFechar: () => void }> = ({
  titulo,
  origem,
  subtitulo,
  onOk,
  onFechar,
}) => {
  const [destino, setDestino] = useState(origem + '_copia');
  const [comDados, setComDados] = useState(true);
  const ok = () => (destino.trim() ? onOk(destino.trim(), comDados) : avisar.alerta('Informe o nome da cópia.'));
  return (
    <Dialogo
      titulo={`${titulo}: ${origem}`}
      subtitulo={subtitulo}
      largura={560}
      onFechar={onFechar}
      onEnviar={ok}
      focar={false}
      rodape={
        <>
          <Botao onClick={onFechar}>Cancelar</Botao>
          <Botao tom="primario" type="submit">
            OK
          </Botao>
        </>
      }
    >
      <LinhaCampo rotulo="Nome da cópia:">
        {/* o nome vem selecionado: é só digitar outro */}
        <input autoFocus required value={destino} onChange={(e) => setDestino(e.target.value)} className={`${CAMPO} flex-1`} />
      </LinhaCampo>
      <LinhaCampo rotulo="Copiar os dados:">
        <Toggle checked={comDados} onChange={setComDados} />
      </LinhaCampo>
    </Dialogo>
  );
};

// ==========================================================
// Localizar objeto (tabela, view, rotina, trigger ou coluna) em todos os bancos de uma conexão
// ==========================================================
const SQL_LOCALIZAR =
  'SELECT tipo, banco, nome, detalhe FROM (' +
  " SELECT CASE WHEN table_type = 'BASE TABLE' THEN 'Tabela' ELSE 'View' END tipo, table_schema banco, table_name nome, '' detalhe FROM information_schema.tables" +
  " UNION ALL SELECT 'Rotina', routine_schema, routine_name, LOWER(routine_type) FROM information_schema.routines" +
  " UNION ALL SELECT 'Trigger', trigger_schema, trigger_name, event_object_table FROM information_schema.triggers" +
  " UNION ALL SELECT 'Coluna', table_schema, column_name, table_name FROM information_schema.columns" +
  ") x WHERE nome LIKE ? AND banco NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')" +
  ' ORDER BY banco, tipo, nome LIMIT 500';

const Localizar: React.FC<{ conexao: Conexao; onIr: (tipo: string, banco: string, nome: string, detalhe: string) => void; onFechar: () => void }> = ({ conexao, onIr, onFechar }) => {
  const [termo, setTermo] = useState('');
  const [achados, setAchados] = useState<string[][] | null>(null);
  const [atual, setAtual] = useState(0);
  const [ocupado, setOcupado] = useState(false);

  const buscar = async () => {
    if (!termo.trim()) return;
    setOcupado(true);
    try {
      setAchados(await linhas({ conexao: conexao.id }, SQL_LOCALIZAR, [`%${termo.trim()}%`]));
      setAtual(0);
    } catch (e) {
      avisar.erro(e);
    } finally {
      setOcupado(false);
    }
  };
  const ir = (i = atual) => achados?.[i] && onIr(achados[i][0], achados[i][1], achados[i][2], achados[i][3]);

  return (
    <Dialogo
      titulo="Localizar objeto"
      subtitulo={`Procura tabelas, views, rotinas, triggers e colunas em todos os bancos de ${conexao.nome}.`}
      largura={760}
      altura={520}
      onFechar={onFechar}
      onEnviar={buscar}
      rodape={
        <>
          <span className="mr-auto text-xs text-texto2">
            {achados && (achados.length === 500 ? 'Mostrando os 500 primeiros: refine a busca' : `${achados.length} encontrado(s)`)}
          </span>
          <Botao onClick={() => ir()} disabled={!achados?.length}>
            Ir para
          </Botao>
          <Botao onClick={onFechar}>Fechar</Botao>
        </>
      }
    >
      <div className="shrink-0 flex gap-1 p-2 border-b border-borda">
        <input value={termo} onChange={(e) => setTermo(e.target.value)} placeholder="Parte do nome: tabela, view, rotina, trigger ou coluna" className={`${CAMPO} flex-1`} />
        <Botao tom="primario" type="submit" icone={Search} ocupado={ocupado}>
          Buscar
        </Botao>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full text-xs border-separate border-spacing-0">
          <thead>
            <tr>
              {['Tipo', 'Banco', 'Objeto', 'Detalhe'].map((t) => (
                <th key={t} className="sticky top-0 px-2 h-7 bg-fundo2 border-b border-r border-borda font-semibold text-center">
                  {t}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {achados?.map((r, i) => (
              <tr key={i} onClick={() => setAtual(i)} onDoubleClick={() => ir(i)} className={`cursor-default ${i === atual ? 'bg-selecao' : 'hover:bg-fundo2'}`}>
                {r.map((v, k) => (
                  <td key={k} className="px-2 h-7 border-b border-r border-borda whitespace-nowrap">
                    {v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Dialogo>
  );
};
