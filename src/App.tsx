/**
 * Janela principal (o TfrmMain do desktop): menu, barra de ferramentas, Explorador à esquerda, documentos em
 * abas, Saída embaixo e barra de status. Antes disso, o login.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, Cog, Database, DatabaseBackup, Download, Eye, FileCode, FolderOpen, GitCompare, GitCompareArrows, History, KeyRound, LogOut, Moon, Play, Plus, Save,
  Square, Sun, Table2, Grid2x2Plus, Users, WandSparkles, X, type LucideIcon,
} from 'lucide-react';
import {
  Conexao, UsuarioSessao, aoExpirarSessao, aoPedirSenha, definirToken, esquecerSenhas, listarConexoes, trocarSenha, validarSessao, ErroApi,
} from './lib/api';
import { Tema, aplicarTema, lerSessao, limparSessao, salvarSessao, temaInicial } from './lib/sessao';
import { avisar, confirmarDescarte } from './lib/avisos';
import { escolherArquivo } from './lib/db';
import { Aba, AppApi, AppContexto, controles } from './app/contexto';
import { Avisos } from './components/Avisos';
import { Login } from './components/Login';
import { Arvore, ArvoreApi, Comando } from './components/Arvore';
import { ConexaoDialog } from './components/ConexaoDialog';
import { AbaConsulta } from './components/AbaConsulta';
import { AbaTabela } from './components/AbaTabela';
import { AbaView } from './components/AbaView';
import { AbaRotina } from './components/AbaRotina';
import { AbaServidor } from './components/AbaServidor';
import { AbaSeguranca } from './components/AbaSeguranca';
import { AbaComparacao } from './components/AbaComparacao';
import { Barra, Botao, BotaoBarra, CAMPO, Carregando, Dialogo, Divisor, ItemMenu, LinhaCampo, MenuContexto, SeparadorBarra, useTamanho } from './components/ui';

const ICONE_ABA: Record<Aba['tipo'], LucideIcon> = {
  consulta: FileCode,
  tabela: Table2,
  view: Eye,
  rotina: Cog,
  servidor: Activity,
  seguranca: Users,
  comparacao: GitCompare,
};

const TITULO_SERVIDOR = { sessoes: 'Sessões', variaveis: 'Variáveis', status: 'Status' };

let proximaAba = 1;
const novoId = () => `aba${proximaAba++}-${Math.random().toString(36).slice(2, 8)}`;

export default function App() {
  const [tema, setTema] = useState<Tema>(temaInicial);
  const [sessao, setSessao] = useState(lerSessao);
  const [conferida, setConferida] = useState(false);
  const [avisoLogin, setAvisoLogin] = useState<string | null>(null);

  useEffect(() => aplicarTema(tema), [tema]);

  const sair = useCallback((mensagem: string | null = null) => {
    limparSessao();
    esquecerSenhas();
    definirToken('');
    setSessao(null);
    setAvisoLogin(mensagem);
  }, []);

  // Sessão guardada no navegador: confere no servidor antes de abrir o app
  useEffect(() => {
    aoExpirarSessao((mensagem) => sair(mensagem));
    if (!sessao) return setConferida(true);
    definirToken(sessao.token);
    validarSessao()
      .catch((e) => {
        // Só a recusa do servidor derruba a sessão; sem rede, o app abre e avisa nas consultas
        if (e instanceof ErroApi && e.status === 401) sair(e.message);
      })
      .finally(() => setConferida(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const entrar = (usuario: UsuarioSessao, token: string, lembrar: boolean) => {
    definirToken(token);
    salvarSessao({ usuario, token }, lembrar);
    setAvisoLogin(null);
    setSessao({ usuario, token });
  };

  return (
    <>
      {!conferida ? (
        <div className="h-full flex">
          <Carregando />
        </div>
      ) : sessao ? (
        <Principal key={sessao.usuario.id} usuario={sessao.usuario} tema={tema} onTema={() => setTema(tema === 'dark' ? 'light' : 'dark')} onSair={() => sair()} />
      ) : (
        <Login avisoInicial={avisoLogin} tema={tema} onTrocarTema={() => setTema(tema === 'dark' ? 'light' : 'dark')} onEntrar={entrar} />
      )}
      <Avisos />
    </>
  );
}

// ==========================================================
// Janela principal
// ==========================================================
const Principal: React.FC<{ usuario: UsuarioSessao; tema: Tema; onTema: () => void; onSair: () => void }> = ({ usuario, tema, onTema, onSair }) => {
  const [conexoes, setConexoes] = useState<Conexao[] | null>(null);
  const [abas, setAbas] = useState<Aba[]>([]);
  const [ativa, setAtiva] = useState('');
  const [saida, setSaida] = useState<string[]>([]);
  const [verExplorador, setVerExplorador] = useState(true);
  const [verSaida, setVerSaida] = useState(false); // a Saída começa escondida; Exibir > Saída mostra
  const [larguraExplorador, arrastarExplorador] = useTamanho(320, 180);
  const [alturaSaida, arrastarSaida] = useTamanho(150, 60, -1);
  const [tituloExplorador, setTituloExplorador] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; itens: ItemMenu[] } | null>(null);
  const [dialogo, setDialogo] = useState<React.ReactNode>(null);
  const [pedidoSenha, setPedidoSenha] = useState<{ conexao: Conexao; motivo: string; resolver: (ok: boolean) => void } | null>(null);
  const arvore = useRef<ArvoreApi>(null);
  const contador = useRef(0);
  // Em refs: as funções do contexto não mudam a cada render e leem sempre o estado atual
  const abasRef = useRef(abas);
  abasRef.current = abas;
  const conexoesRef = useRef(conexoes);
  conexoesRef.current = conexoes;

  useEffect(() => {
    listarConexoes()
      .then(setConexoes)
      .catch((e) => {
        avisar.erro(e);
        setConexoes([]);
      });
  }, []);

  // Senha que falta (conexão sem "Salvar senha") ou recusada: abre a tela da conexão, com o foco na senha
  useEffect(() => {
    aoPedirSenha(
      (id, motivo) =>
        new Promise((resolver) => {
          const c = conexoesRef.current?.find((x) => x.id === id);
          if (!c) return resolver(false);
          setPedidoSenha({ conexao: c, motivo, resolver });
        }),
    );
  }, []);

  // Fechar ou recarregar a página com alterações pendentes: o navegador pergunta
  useEffect(() => {
    const antes = (e: BeforeUnloadEvent) => {
      if ([...controles.values()].some((c) => c.temAlteracoes?.() || c.rodando?.())) e.preventDefault();
    };
    window.addEventListener('beforeunload', antes);
    return () => window.removeEventListener('beforeunload', antes);
  }, []);

  const abrir = (aba: Aba) => {
    setAbas((a) => [...a, aba]);
    setAtiva(aba.id);
  };

  const fecharSemPerguntar = (ids: string[]) => {
    if (!ids.length) return;
    const restantes = abasRef.current.filter((a) => !ids.includes(a.id));
    setAbas(restantes);
    setAtiva((at) => (ids.includes(at) ? (restantes[restantes.length - 1]?.id ?? '') : at));
  };

  /** O CanCloseTab do desktop. */
  const podeFechar = async (aba: Aba): Promise<boolean> => {
    const c = controles.get(aba.id);
    if (c?.rodando?.()) {
      avisar.alerta(`A aba "${aba.titulo}" está executando uma consulta. Clique em Parar antes de fechar.`);
      return false;
    }
    if (c?.temAlteracoes?.()) {
      setAtiva(aba.id);
      return confirmarDescarte(`A aba "${aba.titulo}" tem alterações não salvas. Descartar?`);
    }
    return true;
  };

  const fechar = async (id: string) => {
    const aba = abasRef.current.find((a) => a.id === id);
    if (aba && (await podeFechar(aba))) fecharSemPerguntar([id]);
  };

  const fecharTodas = async () => {
    for (const a of [...abasRef.current].reverse()) if (!(await podeFechar(a))) return;
    fecharSemPerguntar(abasRef.current.map((a) => a.id));
  };

  const log = useCallback((texto: string) => {
    const agora = new Date(); // hora local (Brasília)
    const p = (n: number) => String(n).padStart(2, '0');
    setSaida((s) => [...s.slice(-999), `${p(agora.getHours())}:${p(agora.getMinutes())}:${p(agora.getSeconds())}  ${texto}`]);
  }, []);

  const app = useMemo<AppApi>(() => {
    const igual = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    /** Se o documento já estiver aberto, só volta para ele */
    const existente = (teste: (a: Aba) => boolean) => {
      const a = abasRef.current.find(teste);
      if (a) setAtiva(a.id);
      return a;
    };
    const nomeConexao = (id: number) => conexoesRef.current?.find((c) => c.id === id)?.nome ?? '';
    return {
      get conexoes() {
        return conexoesRef.current ?? [];
      },
      conexao: (id) => conexoesRef.current?.find((c) => c.id === id),
      log,
      abrirConsulta: (conexao, banco, sql, executar = false) => abrir({ id: novoId(), tipo: 'consulta', titulo: `SQL${++contador.current}`, conexao, banco, sql, executar }),
      abrirTabela: (conexao, banco, tabela, dados = false) => {
        if (tabela) {
          const a = existente((x) => x.tipo === 'tabela' && x.conexao === conexao && igual(x.banco, banco) && igual(x.tabela, tabela));
          if (a) return dados ? setAbas((l) => l.map((x) => (x.id === a.id ? ({ ...x, dados: true } as Aba) : x))) : undefined;
        }
        abrir({ id: novoId(), tipo: 'tabela', titulo: tabela ? `${banco}.${tabela}` : 'Nova tabela', conexao, banco, tabela, dados });
      },
      abrirView: (conexao, banco, nome) => {
        if (nome && existente((x) => x.tipo === 'view' && x.conexao === conexao && igual(x.banco, banco) && igual(x.nome, nome))) return;
        abrir({ id: novoId(), tipo: 'view', titulo: nome ? `${banco}.${nome}` : 'Nova view', conexao, banco, nome });
      },
      abrirRotina: (conexao, banco, nome, funcao) => {
        if (nome && existente((x) => x.tipo === 'rotina' && x.conexao === conexao && igual(x.banco, banco) && igual(x.nome, nome) && x.funcao === funcao)) return;
        abrir({ id: novoId(), tipo: 'rotina', titulo: nome ? `${banco}.${nome}` : funcao ? 'Nova function' : 'Nova procedure', conexao, banco, nome, funcao });
      },
      abrirServidor: (conexao, qual) => {
        if (qual === 'usuarios') {
          if (existente((x) => x.tipo === 'seguranca' && x.conexao === conexao)) return;
          return abrir({ id: novoId(), tipo: 'seguranca', titulo: `Usuários - ${nomeConexao(conexao)}`, conexao });
        }
        if (existente((x) => x.tipo === 'servidor' && x.conexao === conexao && x.qual === qual)) return;
        abrir({ id: novoId(), tipo: 'servidor', titulo: `${TITULO_SERVIDOR[qual]} - ${nomeConexao(conexao)}`, conexao, qual });
      },
      alterarAba: (id, mudancas) => setAbas((l) => l.map((x) => (x.id === id ? ({ ...x, ...mudancas } as Aba) : x))),
      fecharAba: (id) => fecharSemPerguntar([id]),
      fecharAbasDoObjeto: (conexao, banco, tabela) =>
        fecharSemPerguntar(
          abasRef.current
            .filter((a) => {
              if (!('banco' in a) || a.conexao !== conexao || !igual(a.banco ?? '', banco)) return false;
              if (tabela) return (a.tipo === 'tabela' && igual(a.tabela, tabela)) || (a.tipo === 'view' && igual(a.nome, tabela));
              // O banco inteiro: tabelas, views, rotinas e as consultas nele que não estejam rodando
              return a.tipo === 'tabela' || a.tipo === 'view' || a.tipo === 'rotina' || (a.tipo === 'consulta' && !controles.get(a.id)?.rodando?.());
            })
            .map((a) => a.id),
        ),
      atualizarArvore: (conexao, banco, pasta) => arvore.current?.atualizar(conexao, banco, pasta),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log]);

  // ==========================================================
  // Ações da janela
  // ==========================================================
  const controle = () => controles.get(ativa);
  const cmd = (c: Comando) => arvore.current?.comando(c);

  const comparar = (dados: boolean) => {
    const s = arvore.current?.selecionado();
    abrir({ id: novoId(), tipo: 'comparacao', titulo: dados ? 'Comparar dados' : 'Comparar esquemas', dados, conexao: s?.conexao, banco: s?.banco });
  };

  /** Abre o .sql numa consulta nova, na conexão escolhida na árvore. */
  const abrirSql = async () => {
    const s = arvore.current?.selecionado();
    if (!s) return avisar.alerta('Selecione na árvore a conexão (ou o banco) onde o SQL vai rodar.');
    const arq = await escolherArquivo('.sql,.txt');
    if (!arq) return;
    // ponytail: o arquivo inteiro vai para o editor; script de dezenas de MB deve ir por Restaurar backup
    if (arq.size > 20_000_000) return avisar.alerta('Arquivo grande demais para o editor. Para rodar um script grande, use Restaurar backup.');
    abrir({ id: novoId(), tipo: 'consulta', titulo: arq.name, conexao: s.conexao, banco: s.banco, sql: await arq.text(), executar: false });
  };

  const sobre = () =>
    setDialogo(
      <Dialogo titulo="Sobre o MySQL Studio" largura={420} onFechar={() => setDialogo(null)} rodape={<Botao onClick={() => setDialogo(null)}>Fechar</Botao>} focar={false}>
        <div className="p-4 text-xs leading-relaxed">
          <b>MySQL Studio</b> v{__APP_VERSION__}
          <br />
          Cliente MySQL na web (React + Express + mysql2).
          <br />
          <br />
          Ícones: Lucide, licença ISC.
        </div>
      </Dialogo>,
    );

  const acoes = {
    novaConsulta: () => cmd('consulta'),
    executar: () => controle()?.executar?.(),
    executarAtual: () => controle()?.executarAtual?.(),
    parar: () => controle()?.parar?.(),
    formatar: () => controle()?.formatar?.(),
    salvar: () => controle()?.salvar?.(),
    salvarComo: () => controle()?.salvarComo?.(),
    csv: () => (controle()?.exportarCsv ? controle()!.exportarCsv!() : avisar.alerta('Nenhum resultado para exportar.')),
  };

  // Atalhos da janela (os do navegador, como Ctrl+N e Ctrl+W, não podem ser tomados)
  const acoesRef = useRef(acoes);
  acoesRef.current = acoes;
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      const a = acoesRef.current;
      let feito = true;
      if (e.key === 'F9') a.executar();
      else if (e.key === 'F5' && e.shiftKey) arvore.current?.comando('atualizar');
      else if (ctrl && e.shiftKey && k === 's') a.salvarComo();
      else if (ctrl && k === 's') a.salvar();
      else if (ctrl && !e.shiftKey && k === 'o' && !e.altKey) void abrirSql();
      else if (ctrl && e.shiftKey && k === 'f') arvore.current?.comando('localizar');
      else if (ctrl && e.altKey && k === 'd') setVerExplorador((v) => !v);
      else if (ctrl && e.altKey && k === 'o') setVerSaida((v) => !v);
      else feito = false;
      if (feito) e.preventDefault();
    };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ==========================================================
  // Menu principal, na ordem do dbForge
  // ==========================================================
  const it = (texto: string, onClick: () => void, icone?: LucideIcon, atalho?: string): ItemMenu => ({ texto, onClick, icone, atalho });
  const menus: [string, ItemMenu[]][] = [
    [
      'Arquivo',
      [
        it('Nova consulta', acoes.novaConsulta, FileCode),
        it('Nova conexão...', () => cmd('novaConexao'), Plus),
        '-',
        it('Abrir SQL...', () => void abrirSql(), FolderOpen, 'Ctrl+O'),
        it('Salvar', acoes.salvar, Save, 'Ctrl+S'),
        it('Salvar SQL como...', acoes.salvarComo, undefined, 'Ctrl+Shift+S'),
        '-',
        it('Exportar CSV...', acoes.csv, Download),
        '-',
        it('Fechar aba', () => void fechar(ativa), X),
        it('Fechar todas as abas', () => void fecharTodas()),
        '-',
        it('Sair', onSair, LogOut),
      ],
    ],
    ['Exibir', [it('Explorador de banco de dados', () => setVerExplorador(!verExplorador), undefined, 'Ctrl+Alt+D'), it('Saída', () => setVerSaida(!verSaida), undefined, 'Ctrl+Alt+O'), '-', it('Filtro do explorador', () => {
      setVerExplorador(true);
      setTimeout(() => arvore.current?.alternarFiltro(), 0);
    }), it(tema === 'dark' ? 'Tema claro' : 'Tema escuro', onTema, tema === 'dark' ? Sun : Moon)]],
    [
      'Banco de dados',
      [
        it('Nova conexão...', () => cmd('novaConexao'), Plus),
        it('Editar conexão...', () => cmd('editarConexao')),
        it('Duplicar conexão...', () => cmd('duplicarConexao')),
        it('Excluir conexão', () => cmd('excluirConexao')),
        '-',
        it('Conectar', () => cmd('conectar')),
        it('Desconectar', () => cmd('desconectar')),
        it('Atualizar', () => cmd('atualizar'), undefined, 'Shift+F5'),
        '-',
        it('Localizar objeto...', () => cmd('localizar'), undefined, 'Ctrl+Shift+F'),
        '-',
        it('Nova tabela...', () => cmd('novaTabela'), Grid2x2Plus),
        it('Editar tabela', () => cmd('editarTabela')),
        '-',
        it('Backup do banco...', () => cmd('backup'), DatabaseBackup),
        it('Restaurar backup...', () => cmd('restaurar'), History),
        '-',
        it('Importar dados (CSV)...', () => cmd('importar')),
        it('Exportar dados da tabela (CSV)...', () => cmd('exportar')),
      ],
    ],
    ['Servidor', [it('Sessões', () => cmd('sessoes'), Activity), it('Variáveis do servidor', () => cmd('variaveis')), it('Status do servidor', () => cmd('status')), '-', it('Usuários e privilégios', () => cmd('usuarios'), Users)]],
    ['Comparação', [it('Comparar esquemas...', () => comparar(false), GitCompare), it('Comparar dados...', () => comparar(true), GitCompareArrows)]],
    ['SQL', [it('Executar', acoes.executar, Play, 'F9'), it('Executar instrução atual', acoes.executarAtual, undefined, 'Ctrl+Enter'), it('Parar', acoes.parar, Square), '-', it('Formatar SQL', acoes.formatar, WandSparkles, 'Ctrl+K')]],
    ['Ferramentas', [it('Exportar CSV...', acoes.csv), it('Importar dados (CSV)...', () => cmd('importar')), '-', it('Backup do banco...', () => cmd('backup')), it('Restaurar backup...', () => cmd('restaurar'))]],
    ['Janela', [it('Fechar aba', () => void fechar(ativa)), it('Fechar todas as abas', () => void fecharTodas())]],
    ['Ajuda', [it('Sobre o MySQL Studio', sobre)]],
  ];

  const abrirMenu = (e: React.MouseEvent, itens: ItemMenu[]) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom, itens });
  };

  const conteudo = (aba: Aba, emPrimeiroPlano: boolean) => {
    switch (aba.tipo) {
      case 'consulta': return <AbaConsulta aba={aba} ativa={emPrimeiroPlano} />;
      case 'tabela': return <AbaTabela aba={aba} ativa={emPrimeiroPlano} />;
      case 'view': return <AbaView aba={aba} ativa={emPrimeiroPlano} />;
      case 'rotina': return <AbaRotina aba={aba} ativa={emPrimeiroPlano} />;
      case 'servidor': return <AbaServidor aba={aba} ativa={emPrimeiroPlano} />;
      case 'seguranca': return <AbaSeguranca aba={aba} ativa={emPrimeiroPlano} />;
      case 'comparacao': return <AbaComparacao aba={aba} ativa={emPrimeiroPlano} />;
    }
  };

  if (!conexoes) {
    return (
      <div className="h-full flex">
        <Carregando />
      </div>
    );
  }

  const abaAtiva = abas.find((a) => a.id === ativa);
  const conexaoAtiva = abaAtiva && 'conexao' in abaAtiva && abaAtiva.conexao ? conexoes.find((c) => c.id === abaAtiva.conexao) : undefined;

  return (
    <AppContexto.Provider value={app}>
      <div className="h-full flex flex-col bg-fundo text-texto text-xs">
        {/* Menu principal */}
        <div className="shrink-0 flex items-center px-1 bg-fundo2 border-b border-borda">
          <Database className="w-4 h-4 mx-1.5 text-realce" />
          {menus.map(([nome, itens]) => (
            <button key={nome} type="button" onClick={(e) => abrirMenu(e, itens)} className="h-7 px-2.5 rounded hover:bg-fundo3 cursor-pointer">
              {nome}
            </button>
          ))}
          <button
            type="button"
            onClick={(e) =>
              abrirMenu(e, [
                it('Trocar a minha senha...', () => setDialogo(<TrocarSenha onFechar={() => setDialogo(null)} />), KeyRound),
                it(tema === 'dark' ? 'Tema claro' : 'Tema escuro', onTema, tema === 'dark' ? Sun : Moon),
                '-',
                it('Sair', onSair, LogOut),
              ])
            }
            className="ml-auto h-7 px-2.5 rounded hover:bg-fundo3 cursor-pointer text-texto2"
            title={usuario.email}
          >
            {usuario.nome}
          </button>
        </div>

        {/* Barra padrão */}
        <Barra>
          <BotaoBarra icone={FileCode} titulo="Nova consulta" texto onClick={acoes.novaConsulta} />
          <BotaoBarra icone={Plus} titulo="Nova conexão..." texto onClick={() => cmd('novaConexao')} />
          <SeparadorBarra />
          <BotaoBarra icone={Play} titulo="Executar" texto cor="text-emerald-600" onClick={acoes.executar} />
          <BotaoBarra icone={Square} titulo="Parar" texto cor="text-rose-600" onClick={acoes.parar} />
          <BotaoBarra icone={WandSparkles} titulo="Formatar SQL" texto onClick={acoes.formatar} />
          <SeparadorBarra />
          <BotaoBarra icone={Save} titulo="Salvar (Ctrl+S)" onClick={acoes.salvar} />
          <BotaoBarra icone={FolderOpen} titulo="Abrir SQL... (Ctrl+O)" onClick={() => void abrirSql()} />
          <SeparadorBarra />
          <BotaoBarra icone={Download} titulo="Exportar CSV..." onClick={acoes.csv} />
          <SeparadorBarra />
          <BotaoBarra icone={GitCompare} titulo="Comparar esquemas..." onClick={() => comparar(false)} />
          <BotaoBarra icone={GitCompareArrows} titulo="Comparar dados..." onClick={() => comparar(true)} />
          <SeparadorBarra />
          <BotaoBarra icone={Grid2x2Plus} titulo="Nova tabela..." onClick={() => cmd('novaTabela')} />
          <BotaoBarra icone={DatabaseBackup} titulo="Backup do banco..." onClick={() => cmd('backup')} />
          <BotaoBarra icone={History} titulo="Restaurar backup..." onClick={() => cmd('restaurar')} />
          <SeparadorBarra />
          <BotaoBarra icone={Activity} titulo="Sessões" onClick={() => cmd('sessoes')} />
          <BotaoBarra icone={Users} titulo="Usuários e privilégios" onClick={() => cmd('usuarios')} />
        </Barra>

        <div className="flex-1 min-h-0 flex">
          {/* Explorador de banco de dados */}
          <div style={{ width: larguraExplorador }} className={`shrink-0 min-h-0 flex-col ${verExplorador ? 'flex' : 'hidden'}`}>
            <TituloPainel titulo={`Explorador de banco de dados${tituloExplorador ? ' - ' + tituloExplorador : ''}`} onFechar={() => setVerExplorador(false)} />
            <Arvore ref={arvore} conexoes={conexoes} onConexoes={setConexoes} onTitulo={setTituloExplorador} />
          </div>
          {verExplorador && <Divisor vertical aoArrastar={arrastarExplorador} />}

          {/* Documentos (abas) em cima, Saída embaixo */}
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            <div className="shrink-0 flex items-stretch bg-fundo2 border-b border-borda">
              <div className="flex-1 min-w-0 flex items-stretch overflow-x-auto">
                {abas.map((a) => {
                  const Icone = ICONE_ABA[a.tipo];
                  return (
                    <div
                      key={a.id}
                      onMouseDown={(e) => (e.button === 1 ? (e.preventDefault(), void fechar(a.id)) : e.button === 0 && setAtiva(a.id))}
                      title={a.titulo}
                      className={`group h-7.5 max-w-56 pl-2.5 pr-1 flex items-center gap-1.5 border-b-2 whitespace-nowrap cursor-default ${
                        a.id === ativa ? 'bg-fundo border-realce font-semibold' : 'border-transparent text-texto2 hover:bg-fundo3'
                      }`}
                    >
                      <Icone className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">{a.titulo}</span>
                      <button
                        type="button"
                        title="Fechar aba"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => void fechar(a.id)}
                        className="p-0.5 rounded shrink-0 text-texto2 hover:bg-fundo3 hover:text-texto cursor-pointer"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
              {conexaoAtiva && (
                <span className="hidden xl:flex items-center gap-1.5 px-2 text-texto2 whitespace-nowrap">
                  <Database className="w-3.5 h-3.5 text-emerald-600" />
                  {conexaoAtiva.servidor} | {conexaoAtiva.usuario}
                </span>
              )}
              {abas.length > 0 && (
                <button type="button" title="Fechar todas as abas" onClick={() => void fecharTodas()} className="w-7.5 shrink-0 flex items-center justify-center border-l border-borda text-texto2 hover:bg-fundo3 cursor-pointer">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <div className="flex-1 min-h-0 flex flex-col">
              {abas.map((a) => (
                <div key={a.id} className={`flex-1 min-h-0 flex-col ${a.id === ativa ? 'flex' : 'hidden'}`}>
                  {conteudo(a, a.id === ativa)}
                </div>
              ))}
              {!abas.length && (
                <div className="flex-1 flex items-center justify-center text-texto2">
                  Dê dois cliques numa tabela do explorador, ou escolha uma conexão e clique em Nova consulta.
                </div>
              )}
            </div>
            {verSaida && (
              <>
                <Divisor aoArrastar={arrastarSaida} />
                <div style={{ height: alturaSaida }} className="shrink-0 flex flex-col min-h-0">
                  <TituloPainel titulo="Saída" onFechar={() => setVerSaida(false)} />
                  <pre className="flex-1 min-h-0 overflow-auto m-0 p-1.5 font-mono text-[11px] whitespace-pre">{saida.join('\n')}</pre>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="shrink-0 h-6 flex items-center px-2 bg-fundo2 border-t border-borda text-[11px] text-texto2">
          <span className="truncate">{saida.length ? saida[saida.length - 1] : 'Pronto'}</span>
        </div>
      </div>

      {menu && <MenuContexto x={menu.x} y={menu.y} itens={menu.itens} onFechar={() => setMenu(null)} />}
      {dialogo}
      {pedidoSenha && (
        <ConexaoDialog
          conexao={pedidoSenha.conexao}
          nomesEmUso={conexoes.filter((c) => c.id !== pedidoSenha.conexao.id).map((c) => c.nome)}
          motivoSenha={pedidoSenha.motivo}
          onFechar={() => {
            pedidoSenha.resolver(false);
            setPedidoSenha(null);
          }}
          onSalvar={(nova) => {
            setConexoes(conexoes.map((c) => (c.id === nova.id ? nova : c)));
            pedidoSenha.resolver(true);
            setPedidoSenha(null);
          }}
        />
      )}
    </AppContexto.Provider>
  );
};

/** Título de painel encaixado (Explorador, Saída), com o × que esconde o painel. */
const TituloPainel: React.FC<{ titulo: string; onFechar: () => void }> = ({ titulo, onFechar }) => (
  <div className="shrink-0 h-6.5 flex items-center pl-2 bg-fundo3 text-xs">
    <span className="flex-1 truncate">{titulo}</span>
    <button type="button" title="Fechar" onClick={onFechar} className="w-6 h-full flex items-center justify-center text-texto2 hover:text-texto cursor-pointer">
      <X className="w-3.5 h-3.5" />
    </button>
  </div>
);

const TrocarSenha: React.FC<{ onFechar: () => void }> = ({ onFechar }) => {
  const [atual, setAtual] = useState('');
  const [nova, setNova] = useState('');
  const [repetir, setRepetir] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const ok = async () => {
    if (nova !== repetir) return avisar.alerta('A nova senha e a repetição não conferem.');
    setOcupado(true);
    try {
      await trocarSenha(atual, nova);
      avisar.sucesso('Senha alterada.');
      onFechar();
    } catch (e) {
      avisar.erro(e);
    } finally {
      setOcupado(false);
    }
  };
  return (
    <Dialogo
      titulo="Trocar a minha senha"
      subtitulo="A senha de acesso ao MySQL Studio (não a das conexões)."
      largura={440}
      onFechar={onFechar}
      onEnviar={ok}
      rodape={
        <>
          <Botao onClick={onFechar}>Cancelar</Botao>
          <Botao tom="primario" type="submit" ocupado={ocupado}>
            Trocar
          </Botao>
        </>
      }
    >
      <LinhaCampo rotulo="Senha atual:">
        <input type="password" value={atual} onChange={(e) => setAtual(e.target.value)} autoComplete="current-password" required className={`${CAMPO} flex-1`} />
      </LinhaCampo>
      <LinhaCampo rotulo="Nova senha:">
        <input type="password" value={nova} onChange={(e) => setNova(e.target.value)} autoComplete="new-password" minLength={8} required className={`${CAMPO} flex-1`} />
      </LinhaCampo>
      <LinhaCampo rotulo="Repita a nova:">
        <input type="password" value={repetir} onChange={(e) => setRepetir(e.target.value)} autoComplete="new-password" minLength={8} required className={`${CAMPO} flex-1`} />
      </LinhaCampo>
    </Dialogo>
  );
};
