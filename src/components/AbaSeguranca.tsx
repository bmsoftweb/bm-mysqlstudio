/**
 * Gerenciador de segurança, como o Security Manager do dbForge: os usuários do servidor à esquerda (por host) e,
 * à direita, Geral (usuário, host, senha, bloqueio), Privilégios globais e Privilégios de objetos (bancos e tabelas).
 * As alterações ficam pendentes até Salvar, que executa o script (RENAME/ALTER USER, GRANT e REVOKE).
 * Conversão do uSecurity.pas.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Database, FileCode, Folder, KeyRound, RefreshCw, Save, Table, Trash2, Undo2, User, UserPlus, Users, X, type LucideIcon } from 'lucide-react';
import { Alvo, Valor, escalar, linhas, rodar } from '../lib/api';
import { q } from '../lib/db';
import { escapeStr } from '../lib/compareLogic';
import { avisar, confirmar, confirmarDescarte } from '../lib/avisos';
import { Aba, useApp, useControleAba } from '../app/contexto';
import { ColunaGrade, Grade, GradeApi } from './Grade';
import { Toggle } from './Toggle';
import { Abas, Barra, Botao, BotaoBarra, CAMPO, Carregando, Dialogo, Divisor, LinhaCampo, SeparadorBarra, useTamanho } from './ui';

const TODOS = '(Todos os privilégios)';
const GLOBAL_PRIVS = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'RELOAD', 'SHUTDOWN', 'PROCESS', 'FILE', 'REFERENCES', 'INDEX', 'ALTER',
  'SHOW DATABASES', 'SUPER', 'CREATE TEMPORARY TABLES', 'LOCK TABLES', 'EXECUTE', 'REPLICATION SLAVE', 'REPLICATION CLIENT', 'CREATE VIEW',
  'SHOW VIEW', 'CREATE ROUTINE', 'ALTER ROUTINE', 'CREATE USER', 'EVENT', 'TRIGGER', 'CREATE TABLESPACE',
];
const DB_PRIVS = [
  'ALTER', 'ALTER ROUTINE', 'CREATE', 'CREATE ROUTINE', 'CREATE TEMPORARY TABLES', 'CREATE VIEW', 'DELETE', 'DROP', 'EVENT', 'EXECUTE',
  'GRANT OPTION', 'INDEX', 'INSERT', 'LOCK TABLES', 'REFERENCES', 'SELECT', 'SHOW VIEW', 'TRIGGER', 'UPDATE',
];
const TABLE_PRIVS = ['ALTER', 'CREATE', 'CREATE VIEW', 'DELETE', 'DROP', 'GRANT OPTION', 'INDEX', 'INSERT', 'REFERENCES', 'SELECT', 'SHOW VIEW', 'TRIGGER', 'UPDATE'];
const AUTENTICACOES = ['caching_sha2_password', 'mysql_native_password', 'sha256_password'];

const ABAS = [
  { id: 'geral', titulo: 'Geral', icone: User },
  { id: 'globais', titulo: 'Privilégios globais', icone: KeyRound },
  { id: 'objetos', titulo: 'Privilégios de objetos', icone: Database },
];
const COLUNAS_GLOBAIS: ColunaGrade[] = [
  { titulo: 'Nome', largura: 500, editor: 'nenhum' },
  { titulo: 'Concedido', largura: 120, editor: 'check' },
];
const COLUNAS_CONCEDIDOS: ColunaGrade[] = [
  { titulo: '', largura: 30, editor: 'check' },
  { titulo: 'Privilégio', largura: 240, editor: 'nenhum' },
  { titulo: 'Objeto', largura: 420, editor: 'nenhum' },
];

// Senhas e nomes vão como literais no script (o mesmo texto que o usuário vê em "Script das alterações")
const lit = (s: string) => "'" + escapeStr(s) + "'";
const account = (u: string, h: string) => lit(u) + '@' + lit(h);
// Chave de privilégio: "PRIVILÉGIO|objeto"; objeto = *.*, `banco`.* ou `banco`.`tabela`
const privOf = (chave: string) => chave.slice(0, chave.indexOf('|'));
const objOf = (chave: string) => chave.slice(chave.indexOf('|') + 1);
/** Objeto sem crases, como aparece na grade: banco ou banco.tabela */
const nomeObjeto = (obj: string) => obj.replace(/`/g, '').replace(/\.\*$/, '');
// ponytail: as listas do Pascal eram TStringList.Sorted (ordem do Windows); o localeCompare pode divergir em
// símbolos, o que só muda a ordem dos comandos/privilégios no script, não o resultado
const ordenar = (itens: Iterable<string>) => [...new Set(itens)].sort((a, b) => a.localeCompare(b, 'pt-BR'));
const mesmos = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/** O usuário escolhido como está no servidor (FOldUser, FOldHost, FOldAuth, FOldLocked e FOld do Pascal) */
interface Antigo {
  usuario: string;
  host: string;
  auth: string;
  bloqueado: boolean;
  privs: Set<string>;
}

/**
 * Script das alterações de `antigo` para `novo` (usuário e host já sem espaços nas pontas): um comando por item,
 * sem o ';', na ordem RENAME USER, ALTER USER (senha/autenticação), ALTER USER (bloqueio) e, por objeto, REVOKE e
 * GRANT. paraVer: a senha não aparece (vira comentário). Função pura, exportada para poder ser testada.
 */
export function montarScript(antigo: Antigo, novo: Antigo & { senha: string }, paraVer: boolean): string[] {
  const r: string[] = [];
  let acc = account(antigo.usuario, antigo.host);
  const novoAcc = account(novo.usuario, novo.host);
  if (novoAcc !== acc) {
    r.push(`RENAME USER ${acc} TO ${novoAcc}`);
    acc = novoAcc;
  }
  if (novo.senha !== '' || novo.auth !== antigo.auth) {
    const s = `ALTER USER ${acc} IDENTIFIED${novo.auth !== antigo.auth ? ' WITH ' + novo.auth : ''} BY `;
    r.push(paraVer ? `-- ${s}(a senha digitada, que não é mostrada)` : s + lit(novo.senha));
  }
  if (novo.bloqueado !== antigo.bloqueado) r.push(`ALTER USER ${acc} ACCOUNT ${novo.bloqueado ? 'LOCK' : 'UNLOCK'}`);
  const velhos = ordenar(antigo.privs);
  const atuais = ordenar(novo.privs);
  for (const obj of ordenar([...velhos, ...atuais].map(objOf))) {
    const grants: string[] = [];
    const revokes: string[] = [];
    let grantOpt = false;
    for (const s of atuais) {
      if (objOf(s) !== obj || antigo.privs.has(s)) continue;
      if (privOf(s) === 'GRANT OPTION') grantOpt = true; // não entra na lista do GRANT: vai como WITH GRANT OPTION
      else grants.push(privOf(s));
    }
    for (const s of velhos) if (objOf(s) === obj && !novo.privs.has(s)) revokes.push(privOf(s));
    if (revokes.length) r.push(`REVOKE ${revokes.join(', ')} ON ${obj} FROM ${acc}`);
    if (grants.length || grantOpt) r.push(`GRANT ${grants.length ? grants.join(', ') : 'USAGE'} ON ${obj} TO ${acc}${grantOpt ? ' WITH GRANT OPTION' : ''}`);
  }
  return r;
}

export const AbaSeguranca: React.FC<{ aba: Extract<Aba, { tipo: 'seguranca' }>; ativa: boolean }> = ({ aba }) => {
  const app = useApp();
  const alvo = useMemo<Alvo>(() => ({ conexao: aba.conexao }), [aba.conexao]);
  const nomeConexao = app.conexao(aba.conexao)?.nome ?? '';

  const [carregado, setCarregado] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [bancos, setBancos] = useState<string[]>([]);
  /** Os fixos + os dinâmicos que o servidor tem (BACKUP_ADMIN etc.) */
  const [privsGlobais, setPrivsGlobais] = useState<string[]>(GLOBAL_PRIVS);
  /** [usuário, host], na ordem da árvore (por host) */
  const [contas, setContas] = useState<[string, string][]>([]);
  /** Nós fechados da árvore de usuários: '' = a raiz, 'h:host' = o grupo do host */
  const [recolhidos, setRecolhidos] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<[string, string] | null>(null);
  const [carregandoUsuario, setCarregandoUsuario] = useState(false);
  /** null = painel de detalhes escondido */
  const [antigo, setAntigo] = useState<Antigo | null>(null);
  /** Privilégios como vão ficar (FNew): as alterações pendentes são a diferença para antigo.privs */
  const [novos, setNovos] = useState<Set<string>>(new Set());
  const [usuario, setUsuario] = useState('');
  const [host, setHost] = useState('');
  const [auth, setAuth] = useState('');
  const [senha, setSenha] = useState('');
  const [senha2, setSenha2] = useState('');
  const [bloqueado, setBloqueado] = useState(false);
  const [abaInterna, setAbaInterna] = useState('geral');
  const [mostrarTodos, setMostrarTodos] = useState(true);
  /** Bancos abertos na árvore de objetos e as tabelas de cada um (entram ao abrir o banco) */
  const [abertos, setAbertos] = useState<Set<string>>(new Set());
  const [tabelas, setTabelas] = useState<Record<string, string[]>>({});
  const [objeto, setObjeto] = useState<{ banco: string; tabela?: string } | null>(null);
  const [novoUsuario, setNovoUsuario] = useState(false);
  const gradeConcedidos = useRef<GradeApi>(null);
  /** Só a carga mais recente de usuário vale (cliques seguidos na árvore) */
  const pedido = useRef(0);
  const [larguraUsuarios, arrastarUsuarios] = useTamanho(250, 150);
  const [alturaConcedidos, arrastarConcedidos] = useTamanho(220, 80, -1);

  // O HasChanges do Pascal
  const alterado =
    antigo !== null &&
    (!mesmos(novos, antigo.privs) ||
      usuario.trim() !== antigo.usuario ||
      host.trim() !== antigo.host ||
      senha !== '' ||
      auth !== antigo.auth ||
      bloqueado !== antigo.bloqueado);

  // ==========================================================
  // Carga
  // ==========================================================
  // Privilégios do usuário: globais, por banco e por tabela. O information_schema já traz o nome do GRANT.
  const carregarUsuario = async (u: string, h: string, globais = privsGlobais) => {
    const n = ++pedido.current;
    setSel([u, h]);
    setAntigo(null);
    setCarregandoUsuario(true);
    try {
      const grantee = `'${u}'@'${h}'`;
      const [privilegios, plugin, bloqueada] = await Promise.all([
        linhas(
          alvo,
          "SELECT '*', '', privilege_type, is_grantable FROM information_schema.user_privileges WHERE grantee=?" +
            " UNION ALL SELECT table_schema, '', privilege_type, is_grantable FROM information_schema.schema_privileges WHERE grantee=?" +
            ' UNION ALL SELECT table_schema, table_name, privilege_type, is_grantable FROM information_schema.table_privileges WHERE grantee=?',
          [grantee, grantee, grantee],
        ),
        escalar(alvo, 'SELECT plugin FROM mysql.user WHERE user=? AND host=?', [u, h]),
        escalar(alvo, 'SELECT account_locked FROM mysql.user WHERE user=? AND host=?', [u, h]).catch(() => ''), // MariaDB/5.x sem a coluna
      ]);
      if (n !== pedido.current) return;
      const privs = new Set<string>();
      for (const r of privilegios) {
        const obj = r[0] === '*' ? '*.*' : r[1] === '' ? q(r[0]) + '.*' : q(r[0]) + '.' + q(r[1]);
        if (obj !== '*.*' || globais.includes(r[2].toUpperCase())) privs.add(r[2].toUpperCase() + '|' + obj); // USAGE fica de fora
        if (r[3] === 'YES') privs.add('GRANT OPTION|' + obj);
      }
      setAntigo({ usuario: u, host: h, auth: plugin, bloqueado: bloqueada === 'Y', privs });
      setNovos(new Set(privs));
      setUsuario(u);
      setHost(h);
      setAuth(plugin);
      setSenha('');
      setSenha2('');
      setBloqueado(bloqueada === 'Y');
    } catch (e) {
      if (n === pedido.current) avisar.erro(e);
    } finally {
      if (n === pedido.current) setCarregandoUsuario(false);
    }
  };

  /** Lê os usuários e escolhe u@h (ou o primeiro, se ele não existir mais). */
  const carregarUsuarios = async (u: string, h: string, globais = privsGlobais) => {
    const lista = (await linhas(alvo, 'SELECT user, host FROM mysql.user ORDER BY host, user')).map((r): [string, string] => [r[0], r[1]]);
    setContas(lista);
    setRecolhidos(new Set()); // a árvore volta toda aberta
    const escolhido = lista.find((c) => c[0] === u && c[1] === h) ?? lista[0];
    if (escolhido) await carregarUsuario(escolhido[0], escolhido[1], globais);
    else {
      pedido.current++;
      setSel(null);
      setAntigo(null);
    }
  };

  // O Reload do Pascal (Atualizar e F9)
  const recarregar = async () => {
    if (ocupado) return;
    if (alterado && !(await confirmarDescarte('Descartar as alterações não salvas?'))) return;
    setOcupado(true);
    try {
      const [dbs, dinamicos] = await Promise.all([
        linhas(alvo, 'SHOW DATABASES'),
        linhas(alvo, 'SELECT DISTINCT privilege_type FROM information_schema.user_privileges'),
      ]);
      const globais = ordenar([...GLOBAL_PRIVS, ...dinamicos.map((r) => r[0].toUpperCase()).filter((p) => p !== 'USAGE' && p !== 'GRANT OPTION')]);
      setBancos(dbs.map((r) => r[0]));
      setPrivsGlobais(globais);
      // A árvore de objetos volta fechada: as tabelas são lidas de novo ao abrir o banco
      setAbertos(new Set());
      setTabelas({});
      await carregarUsuarios(sel?.[0] ?? '', sel?.[1] ?? '', globais);
    } catch (e) {
      avisar.erro(e);
    } finally {
      setOcupado(false);
      setCarregado(true);
    }
  };
  const recarregarAtual = useRef(recarregar);
  recarregarAtual.current = recarregar;
  useEffect(() => {
    void recarregarAtual.current();
  }, []);

  // ==========================================================
  // Script
  // ==========================================================
  const script = (paraVer: boolean): string[] =>
    antigo ? montarScript(antigo, { usuario: usuario.trim(), host: host.trim(), auth, senha, bloqueado, privs: novos }, paraVer) : [];
  const textoScript = () => script(true).map((s) => s + ';').join('\n');

  // ==========================================================
  // Ações
  // ==========================================================
  const salvar = async () => {
    if (!alterado || !antigo || ocupado) return;
    if (usuario.trim() === '') return avisar.alerta('Informe o usuário.');
    if (senha !== senha2) return avisar.alerta('A confirmação não confere com a nova senha.');
    // IDENTIFIED WITH sem senha deixaria o usuário com senha vazia.
    if (auth !== antigo.auth && senha === '') return avisar.alerta('Para trocar a autenticação, informe a nova senha (pode ser a mesma de hoje).');
    if (
      !(await confirmar({
        titulo: 'Aplicar alterações',
        mensagem: `Aplicar no servidor as alterações de ${antigo.usuario}@${antigo.host}?\n\n${textoScript()}`,
        confirmar: 'Aplicar',
        tom: 'normal',
      }))
    )
      return;
    let u = usuario.trim();
    let h = host.trim();
    setOcupado(true);
    try {
      try {
        await rodar(alvo, script(false));
        for (const s of script(true)) app.log(`${nomeConexao}: ${s};`); // sem a senha
      } catch (e) {
        avisar.erro(`${e instanceof Error ? e.message : String(e)}\n\nParte das alterações pode ter sido aplicada; a tela foi recarregada.`);
        u = antigo.usuario;
        h = antigo.host;
      }
      await carregarUsuarios(u, h);
    } catch (e) {
      avisar.erro(e);
    } finally {
      setOcupado(false);
    }
  };

  const desfazer = () => {
    if (alterado && antigo) void carregarUsuario(antigo.usuario, antigo.host);
  };

  const verScript = () => {
    const s = textoScript();
    if (s === '') avisar.alerta('Nenhuma alteração.');
    else app.abrirConsulta(aba.conexao, '', s);
  };

  /** Trocar de usuário com alterações pendentes: pergunta antes */
  const podeSair = async () =>
    !alterado || !antigo || (await confirmarDescarte(`Descartar as alterações não salvas de ${antigo.usuario}@${antigo.host}?`));

  const escolher = async (u: string, h: string) => {
    // O mesmo usuário já carregado: nada a fazer (se a carga falhou, o clique tenta de novo)
    if ((antigo && antigo.usuario === u && antigo.host === h) || !(await podeSair())) return;
    await carregarUsuario(u, h);
  };

  const abrirNovo = async () => {
    // Criar recarrega a lista e escolhe o usuário novo: as alterações pendentes do atual se perderiam caladas
    if (await podeSair()) setNovoUsuario(true);
  };

  const criar = async (u: string, h: string, p: string) => {
    try {
      await rodar(alvo, `CREATE USER ${account(u, h)} IDENTIFIED BY ${lit(p)}`);
      app.log(`${nomeConexao}: usuário ${u}@${h} criado.`); // sem a senha
      setNovoUsuario(false);
      await carregarUsuarios(u, h);
    } catch (e) {
      avisar.erro(e);
    }
  };

  const excluir = async () => {
    if (!sel || ocupado) return;
    const [u, h] = sel;
    if (!(await confirmar({ titulo: 'Excluir usuário', mensagem: `Excluir o usuário ${u}@${h}?\nEle perde o acesso ao servidor e os privilégios.` }))) return;
    setOcupado(true);
    try {
      await rodar(alvo, 'DROP USER ' + account(u, h));
      app.log(`${nomeConexao}: usuário ${u}@${h} excluído.`);
      await carregarUsuarios('', ''); // não pergunta pelas alterações do usuário que saiu
    } catch (e) {
      avisar.erro(e);
    } finally {
      setOcupado(false);
    }
  };

  /** Marca/desmarca privilégios: ficam pendentes em `novos` até Salvar. */
  const marcar = (chaves: string[], ligar: boolean) =>
    setNovos((atual) => {
      const r = new Set(atual);
      for (const k of chaves) {
        if (ligar) r.add(k);
        else r.delete(k);
      }
      return r;
    });

  // ==========================================================
  // Privilégios globais
  // ==========================================================
  const linhasGlobais = useMemo<Valor[][]>(() => privsGlobais.map((p) => [p, novos.has(p + '|*.*') ? '1' : '']), [privsGlobais, novos]);
  const todosGlobais = privsGlobais.every((p) => novos.has(p + '|*.*'));

  // ==========================================================
  // Privilégios de objetos
  // ==========================================================
  // Árvore de objetos: todos os bancos, ou (Mostrar todos desligado) só os em que o usuário tem algum privilégio.
  // O banco escolhido continua na lista mesmo depois de desmarcar tudo nele.
  const bancosVisiveis = useMemo(() => {
    if (mostrarTodos || !antigo) return bancos;
    const objetos = [...antigo.privs, ...novos].map(objOf);
    return bancos.filter((b) => b === objeto?.banco || objetos.some((o) => o.startsWith(q(b) + '.')));
  }, [mostrarTodos, antigo, novos, bancos, objeto]);

  // Banco escolhido = `banco`.*; tabela = `banco`.`tabela`.
  const objAtual = objeto && bancosVisiveis.includes(objeto.banco) ? objeto : null;
  const chaveObjeto = !objAtual ? '' : objAtual.tabela === undefined ? q(objAtual.banco) + '.*' : q(objAtual.banco) + '.' + q(objAtual.tabela);
  const privsObjeto = !objAtual ? [] : objAtual.tabela === undefined ? DB_PRIVS : TABLE_PRIVS;

  const alternarBanco = async (banco: string) => {
    const abrir = !abertos.has(banco);
    const mudar = (ligar: boolean) =>
      setAbertos((a) => {
        const r = new Set(a);
        if (ligar) r.add(banco);
        else r.delete(banco);
        return r;
      });
    mudar(abrir);
    if (!abrir || tabelas[banco]) return;
    try {
      const l = await linhas(alvo, 'SELECT table_name FROM information_schema.tables WHERE table_schema=? ORDER BY 1', [banco]);
      setTabelas((t) => ({ ...t, [banco]: l.map((r) => r[0]) }));
    } catch (e) {
      mudar(false);
      avisar.erro(e);
    }
  };

  // Grade de baixo: privilégios em bancos e tabelas (os globais ficam na aba deles), os que o usuário tem e os
  // marcados/revogados na tela, por privilégio.
  const concedidos = useMemo(() => (antigo ? ordenar([...antigo.privs, ...novos].filter((s) => objOf(s) !== '*.*')) : []), [antigo, novos]);
  const linhasConcedidos = useMemo<Valor[][]>(() => concedidos.map((k) => [novos.has(k) ? '1' : '', privOf(k), nomeObjeto(objOf(k))]), [concedidos, novos]);

  // Revoga (na tela; vai ao servidor no Salvar) o privilégio da linha escolhida.
  const revogar = async () => {
    const f = gradeConcedidos.current?.foco();
    if (!f) {
      if (concedidos.length) avisar.alerta('Escolha na grade o privilégio a revogar.');
      return;
    }
    const k = concedidos[f.linha];
    if (!k || !novos.has(k)) return;
    if (
      !(await confirmar({
        titulo: 'Revogar privilégio',
        mensagem: `Revogar ${privOf(k)} em ${nomeObjeto(objOf(k))}?\nA alteração só vai para o servidor ao clicar em Salvar.`,
        confirmar: 'Revogar',
      }))
    )
      return;
    marcar([k], false);
  };

  const revogarTudo = async () => {
    if (!antigo) return;
    if (
      !(await confirmar({
        titulo: 'Revogar todos os privilégios',
        mensagem: `Revogar todos os privilégios de ${antigo.usuario}@${antigo.host} em bancos e tabelas?\nA alteração só vai para o servidor ao clicar em Salvar.`,
        confirmar: 'Revogar',
      }))
    )
      return;
    setNovos((atual) => new Set([...atual].filter((s) => objOf(s) === '*.*')));
  };

  useControleAba(aba.id, { temAlteracoes: () => alterado, executar: () => void recarregar(), salvar: () => void salvar() });

  // ==========================================================
  // Tela
  // ==========================================================
  // Usuários agrupados por host (a consulta já vem ordenada por host)
  const grupos = useMemo(() => {
    const g: { host: string; usuarios: string[] }[] = [];
    for (const [u, h] of contas) {
      const ultimo = g[g.length - 1];
      if (ultimo && ultimo.host === h) ultimo.usuarios.push(u);
      else g.push({ host: h, usuarios: [u] });
    }
    return g;
  }, [contas]);

  const alternarNo = (no: string) =>
    setRecolhidos((atual) => {
      const r = new Set(atual);
      if (!r.delete(no)) r.add(no);
      return r;
    });

  const telaGeral = antigo && (
    <div className="flex-1 min-h-0 overflow-auto">
      <LinhaCampo rotulo="Usuário:">
        <input value={usuario} onChange={(e) => setUsuario(e.target.value)} required autoComplete="off" className={`${CAMPO} w-[260px]`} />
      </LinhaCampo>
      <LinhaCampo rotulo="Host:">
        <input value={host} onChange={(e) => setHost(e.target.value)} autoComplete="off" className={`${CAMPO} w-[260px]`} />
      </LinhaCampo>
      <LinhaCampo rotulo="Autenticação:">
        <select value={auth} onChange={(e) => setAuth(e.target.value)} className={`${CAMPO} w-[260px]`}>
          {/* auth_socket etc.: mantém o que o servidor usa */}
          {(AUTENTICACOES.includes(antigo.auth) ? AUTENTICACOES : [...AUTENTICACOES, antigo.auth]).map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </LinhaCampo>
      <LinhaCampo rotulo="Nova senha:">
        <input type="password" value={senha} onChange={(e) => setSenha(e.target.value)} autoComplete="new-password" className={`${CAMPO} w-[260px]`} />
      </LinhaCampo>
      <LinhaCampo rotulo="Confirmar senha:">
        <input type="password" value={senha2} onChange={(e) => setSenha2(e.target.value)} autoComplete="new-password" className={`${CAMPO} w-[260px]`} />
      </LinhaCampo>
      <LinhaCampo rotulo="Conta bloqueada:">
        <Toggle checked={bloqueado} onChange={setBloqueado} />
      </LinhaCampo>
      <p className="px-4 py-2 text-xs text-texto2">
        Senha em branco: continua a mesma. Ao trocar a autenticação, informe a nova senha. Host % aceita conexão de qualquer máquina.
      </p>
    </div>
  );

  const telaGlobais = (
    <>
      <div className="shrink-0 flex flex-wrap items-center gap-x-6 gap-y-1 px-2 py-1.5 border-b border-borda">
        <Toggle
          size="sm"
          checked={novos.has('GRANT OPTION|*.*')}
          onChange={(v) => marcar(['GRANT OPTION|*.*'], v)}
          label="Com GRANT OPTION (pode repassar os privilégios a outros usuários)"
        />
        {/* No desktop era o clique no título da coluna Concedido: marca/desmarca todos */}
        <Toggle size="sm" checked={todosGlobais} onChange={(v) => marcar(privsGlobais.map((p) => p + '|*.*'), v)} label={TODOS} />
      </div>
      {/* Um clique marca, como no dbForge */}
      <Grade colunas={COLUNAS_GLOBAIS} linhas={linhasGlobais} editavel onAlterar={(l, _c, v) => marcar([privsGlobais[l] + '|*.*'], v === '1')} />
    </>
  );

  // Objetos (bancos e tabelas) e os privilégios do escolhido; embaixo, tudo o que o usuário tem em bancos/tabelas.
  const telaObjetos = (
    <>
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="shrink-0 h-8 flex items-center justify-between gap-2 px-2 text-xs">
            Objetos:
            <Toggle size="sm" checked={mostrarTodos} onChange={setMostrarTodos} label="Mostrar todos" title="Desligado: só os bancos em que o usuário tem privilégio" />
          </div>
          <div className="flex-1 min-h-0 overflow-auto border-t border-borda">
            {bancosVisiveis.map((b) => (
              <React.Fragment key={b}>
                <ItemArvore
                  nivel={0}
                  icone={Database}
                  texto={b}
                  aberto={abertos.has(b)}
                  selecionado={objAtual?.banco === b && objAtual.tabela === undefined}
                  onClick={() => setObjeto({ banco: b })}
                  onAlternar={() => void alternarBanco(b)}
                />
                {abertos.has(b) &&
                  (tabelas[b] ? (
                    tabelas[b].map((t) => (
                      <ItemArvore
                        key={t}
                        nivel={1}
                        icone={Table}
                        texto={t}
                        selecionado={objAtual?.banco === b && objAtual.tabela === t}
                        onClick={() => setObjeto({ banco: b, tabela: t })}
                      />
                    ))
                  ) : (
                    <div className="pl-11 py-1 text-xs text-texto2">Carregando...</div>
                  ))}
              </React.Fragment>
            ))}
          </div>
        </div>
        <div className="w-[300px] shrink-0 flex flex-col border-l border-borda">
          <div className="shrink-0 h-8 flex items-center px-2 text-xs">Privilégios disponíveis:</div>
          <div className="flex-1 min-h-0 overflow-auto border-t border-borda px-2 py-1 flex flex-col gap-1.5">
            {objAtual && (
              <>
                <Toggle
                  size="sm"
                  checked={privsObjeto.every((p) => novos.has(p + '|' + chaveObjeto))}
                  onChange={(v) => marcar(privsObjeto.map((p) => p + '|' + chaveObjeto), v)}
                  label={TODOS}
                />
                {privsObjeto.map((p) => (
                  <Toggle key={p} size="sm" checked={novos.has(p + '|' + chaveObjeto)} onChange={(v) => marcar([p + '|' + chaveObjeto], v)} label={p} />
                ))}
              </>
            )}
          </div>
        </div>
      </div>
      <Divisor aoArrastar={arrastarConcedidos} />
      <div style={{ height: alturaConcedidos }} className="shrink-0 flex min-h-0">
        {/* Barra em pé, como a do dbForge */}
        <div className="shrink-0 flex flex-col gap-0.5 p-1 bg-fundo2 border-r border-borda">
          <BotaoBarra icone={X} titulo="Revogar o privilégio escolhido" onClick={() => void revogar()} />
          <BotaoBarra icone={Trash2} titulo="Revogar todos os privilégios de bancos e tabelas" onClick={() => void revogarTudo()} />
        </div>
        {/* Concedidos e revogados na tela: desmarcar revoga, marcar de novo devolve (vale no Salvar). */}
        <Grade
          ref={gradeConcedidos}
          colunas={COLUNAS_CONCEDIDOS}
          linhas={linhasConcedidos}
          editavel
          onAlterar={(l, _c, v) => marcar([concedidos[l]], v === '1')}
        />
      </div>
    </>
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <Barra>
        <BotaoBarra icone={RefreshCw} titulo="Atualizar" texto onClick={() => void recarregar()} disabled={ocupado} />
        <SeparadorBarra />
        <BotaoBarra icone={Save} titulo="Salvar" texto onClick={() => void salvar()} disabled={ocupado || !alterado} />
        <BotaoBarra icone={Undo2} titulo="Desfazer" texto onClick={desfazer} disabled={ocupado || !alterado} />
        <BotaoBarra icone={FileCode} titulo="Script das alterações" texto onClick={verScript} />
      </Barra>
      {!carregado ? (
        <Carregando />
      ) : (
        <div className="flex-1 min-h-0 flex">
          {/* Usuários, agrupados por host. */}
          <div style={{ width: larguraUsuarios }} className="shrink-0 flex flex-col min-h-0">
            <Barra>
              <BotaoBarra icone={UserPlus} titulo="Novo usuário" texto onClick={() => void abrirNovo()} disabled={ocupado} />
              <BotaoBarra icone={Trash2} titulo="Excluir" texto onClick={() => void excluir()} disabled={ocupado || !sel} />
            </Barra>
            <div className="flex-1 min-h-0 overflow-auto">
              <ItemArvore nivel={0} icone={Users} texto="Usuários" aberto={!recolhidos.has('')} onClick={() => alternarNo('')} />
              {!recolhidos.has('') &&
                grupos.map((g) => (
                  <React.Fragment key={g.host}>
                    <ItemArvore
                      nivel={1}
                      icone={Folder}
                      texto={`${g.host} (${g.usuarios.length})`}
                      aberto={!recolhidos.has('h:' + g.host)}
                      onClick={() => alternarNo('h:' + g.host)}
                    />
                    {!recolhidos.has('h:' + g.host) &&
                      g.usuarios.map((u) => (
                        <ItemArvore
                          key={u}
                          nivel={2}
                          icone={User}
                          texto={u}
                          selecionado={sel !== null && sel[0] === u && sel[1] === g.host}
                          onClick={() => void escolher(u, g.host)}
                        />
                      ))}
                  </React.Fragment>
                ))}
            </div>
          </div>
          <Divisor vertical aoArrastar={arrastarUsuarios} />
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            {carregandoUsuario ? (
              <Carregando />
            ) : (
              antigo && (
                <>
                  <div className="shrink-0 px-2 py-1.5 text-xs font-bold truncate">
                    Detalhes do usuário {antigo.usuario}@{antigo.host}
                  </div>
                  <Abas abas={ABAS} ativa={abaInterna} onTrocar={setAbaInterna} />
                  {abaInterna === 'geral' ? telaGeral : abaInterna === 'globais' ? telaGlobais : telaObjetos}
                </>
              )
            )}
          </div>
        </div>
      )}
      {novoUsuario && <DialogoNovoUsuario onCriar={criar} onFechar={() => setNovoUsuario(false)} />}
    </div>
  );
};

/**
 * Linha das árvores (usuários e objetos). aberto indefinido = folha; com onAlternar, a seta e o duplo clique
 * abrem/fecham e o clique escolhe; sem ele, o clique é o que o dono mandar (nos grupos, abrir/fechar).
 */
const ItemArvore: React.FC<{
  nivel: number;
  icone: LucideIcon;
  texto: string;
  aberto?: boolean;
  selecionado?: boolean;
  onClick: () => void;
  onAlternar?: () => void;
}> = ({ nivel, icone: Icone, texto, aberto, selecionado, onClick, onAlternar }) => {
  const Seta = aberto ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={onAlternar}
      aria-expanded={aberto}
      style={{ paddingLeft: 4 + nivel * 16 }}
      className={`w-full h-6 pr-2 flex items-center gap-1 text-left text-xs text-texto whitespace-nowrap cursor-pointer ${selecionado ? 'bg-selecao' : 'hover:bg-fundo3'}`}
    >
      <span
        className="w-4 h-4 shrink-0 flex items-center justify-center"
        onClick={
          onAlternar &&
          ((e) => {
            e.stopPropagation();
            onAlternar();
          })
        }
      >
        {aberto !== undefined && <Seta className="w-3.5 h-3.5 text-texto2" />}
      </span>
      <Icone className="w-3.5 h-3.5 shrink-0 text-texto2" />
      <span className="truncate">{texto}</span>
    </button>
  );
};

/** Usuário, host e senha do usuário novo (o UserDialog do Pascal). Com erro ao criar, continua aberto. */
const DialogoNovoUsuario: React.FC<{ onCriar: (usuario: string, host: string, senha: string) => Promise<void>; onFechar: () => void }> = ({ onCriar, onFechar }) => {
  const [usuario, setUsuario] = useState('');
  const [host, setHost] = useState('%');
  const [senha, setSenha] = useState('');
  const [senha2, setSenha2] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const ok = async () => {
    if (ocupado) return;
    if (usuario.trim() === '') return avisar.alerta('Informe o usuário.');
    if (senha !== senha2) return avisar.alerta('A confirmação não confere com a senha.');
    setOcupado(true);
    await onCriar(usuario.trim(), host.trim() || '%', senha);
    setOcupado(false);
  };

  return (
    <Dialogo
      titulo="Novo usuário"
      subtitulo="Host % aceita conexão de qualquer máquina."
      largura={430}
      onFechar={onFechar}
      onEnviar={() => void ok()}
      travado={ocupado}
      rodape={
        <>
          <Botao onClick={onFechar} disabled={ocupado}>
            Cancelar
          </Botao>
          <Botao tom="primario" type="submit" ocupado={ocupado}>
            OK
          </Botao>
        </>
      }
    >
      <LinhaCampo rotulo="Usuário:">
        <input value={usuario} onChange={(e) => setUsuario(e.target.value)} required autoComplete="off" className={`${CAMPO} flex-1`} />
      </LinhaCampo>
      <LinhaCampo rotulo="Host:">
        <input value={host} onChange={(e) => setHost(e.target.value)} autoComplete="off" className={`${CAMPO} flex-1`} />
      </LinhaCampo>
      <LinhaCampo rotulo="Senha:">
        <input type="password" value={senha} onChange={(e) => setSenha(e.target.value)} autoComplete="new-password" className={`${CAMPO} flex-1`} />
      </LinhaCampo>
      <LinhaCampo rotulo="Confirmar senha:">
        <input type="password" value={senha2} onChange={(e) => setSenha2(e.target.value)} autoComplete="new-password" className={`${CAMPO} flex-1`} />
      </LinhaCampo>
    </Dialogo>
  );
};
