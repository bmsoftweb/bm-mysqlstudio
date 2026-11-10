/**
 * Documento de procedure / function (o TRoutineTab do desktop, uRoutineEdit.pas), como o do dbForge: Nome / Banco /
 * Comentário em cima, Parâmetros à esquerda, Opções (segurança, definer, acesso SQL, determinístico) à direita e o
 * corpo embaixo, com Atualizar objeto / Aplicar alterações / Script das alterações no rodapé. O MySQL não altera
 * parâmetros nem corpo com ALTER: Aplicar refaz a rotina com DROP + CREATE (e, se o CREATE falhar, recria a versão
 * anterior).
 *
 * Os nomes vão sem o banco na frente, como no desktop: o Alvo da aba leva o banco (o WithDb do Pascal) e o
 * servidor faz o USE antes de rodar.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, FileCode, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Alvo, escalar, linhas, rodar, texto } from '../lib/api';
import { getCreate, lit, q } from '../lib/db';
import { splitScript } from '../lib/sqlText';
import { avisar, confirmar, confirmarDescarte } from '../lib/avisos';
import { Aba, useApp, useControleAba } from '../app/contexto';
import { Botao, CAMPO, Carregando, Divisor, SeparadorBarra, useTamanho } from './ui';
import { ColunaGrade, Grade, GradeApi } from './Grade';
import { EditorSql, EditorSqlApi } from './EditorSql';
import { Toggle } from './Toggle';

// ==========================================================
// Peças usadas também pelo documento de view (AbaView)
// ==========================================================
/** usuario@host -> 'usuario'@'host' */
export function definerSql(s: string): string {
  const p = s.lastIndexOf('@');
  return p < 0 ? lit(s) : lit(s.slice(0, p)) + '@' + lit(s.slice(p + 1));
}

/** Usuários do servidor para a lista do Definer; sem a lista o definer ainda pode ser digitado. */
export async function listarDefiners(alvo: Alvo): Promise<string[]> {
  try {
    return (await linhas(alvo, 'SELECT DISTINCT grantee FROM information_schema.user_privileges ORDER BY 1')).map((l) => l[0].replace(/'/g, ''));
  } catch {
    return [];
  }
}

/** Erro do Aplicar por causa do definer (de um usuário com mais privilégios que o da conexão): acrescenta o que fazer. */
export function comDicaDoDefiner(mensagem: string, definer: string): string {
  if (!/SYSTEM_USER|SET_USER_ID/i.test(mensagem)) return mensagem;
  return `${mensagem}\n\nO definer ${definer.trim()} é de um usuário com mais privilégios que o da conexão. Troque o Definer para o seu usuário (ou deixe em branco) e aplique de novo.`;
}

export const mensagemDe = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Título de um painel (Parâmetros, Opções, Corpo...) */
export const TituloPainel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="shrink-0 px-2 py-1 text-xs font-bold text-texto">{children}</div>
);

/**
 * Linha da planilha de opções (o AddSheetLines do desktop): rótulo | campo, com um risco embaixo e outro entre as
 * colunas. É div e não o LinhaCampo (um label): a linha pode ter dois radios, e o clique no rótulo marcaria o primeiro.
 */
export const LinhaOpcao: React.FC<{ rotulo: string; children: React.ReactNode }> = ({ rotulo, children }) => (
  <div className="flex items-stretch min-h-8 border-b border-borda">
    <span className="w-28 shrink-0 flex items-center px-2 text-xs text-texto2 border-r border-borda">{rotulo}</span>
    <span className="flex-1 min-w-0 flex items-center gap-4 px-1 py-0.5">{children}</span>
  </div>
);

/** Par de opções excludentes (os dois TRadioButton da linha). */
export const DuasOpcoes: React.FC<{ opcoes: [string, string]; valor: string; onMudar: (valor: string) => void; disabled?: boolean }> = ({
  opcoes,
  valor,
  onMudar,
  disabled,
}) => {
  const grupo = useId();
  return (
    <>
      {opcoes.map((o) => (
        <label key={o} className={`inline-flex items-center gap-1.5 pl-1 text-xs text-texto ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
          <input type="radio" name={grupo} checked={valor === o} disabled={disabled} onChange={() => onMudar(o)} className="accent-realce" />
          {o}
        </label>
      ))}
    </>
  );
};

/** Campo do Definer: lista dos usuários do servidor, mas aceita digitar outro. */
export const CampoDefiner: React.FC<{ valor: string; onMudar: (valor: string) => void; usuarios: string[] }> = ({ valor, onMudar, usuarios }) => {
  const lista = useId();
  return (
    <>
      <input value={valor} onChange={(e) => onMudar(e.target.value)} list={lista} autoComplete="off" className={`${CAMPO} flex-1`} />
      <datalist id={lista}>
        {usuarios.map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>
    </>
  );
};

// ==========================================================
// O CREATE e o script
// ==========================================================
// Grade de parâmetros; na function a linha 0 é o retorno.
const P_NOME = 0;
const P_TIPO = 1;
const P_MODO = 2;
const RETORNO = '(Retorno)';
const TIPOS = ['INT', 'BIGINT', 'TINYINT(1)', 'DECIMAL(15,2)', 'DECIMAL(15,4)', 'VARCHAR(255)', 'CHAR(1)', 'TEXT', 'DATE', 'DATETIME', 'TIME', 'JSON'];
const ACESSOS = ['CONTAINS SQL', 'NO SQL', 'READS SQL DATA', 'MODIFIES SQL DATA'];
const RX_NOME = /((?:PROCEDURE|FUNCTION)\s+)(`[^`]+`|[\w$]+)/i;

/** O que está nos campos da tela. No modo Raw, corpo é o CREATE inteiro. */
interface Campos {
  nome: string;
  comentario: string;
  /** SQL SECURITY INVOKER (senão DEFINER) */
  invoker: boolean;
  definer: string;
  acesso: string;
  determ: boolean;
  /** [nome, tipo, modo] */
  pars: string[][];
  corpo: string;
}

const VAZIO: Campos = { nome: '', comentario: '', invoker: false, definer: '', acesso: ACESSOS[0], determ: false, pars: [], corpo: '' };

/** O CREATE montado com o que está nos campos (sem DELIMITER). */
function createSql(funcao: boolean, c: Campos, nome: string): string {
  let pars = '';
  let retorno = '';
  c.pars.forEach((p, k) => {
    if (funcao && k === 0) retorno = p[P_TIPO].trim();
    else pars += (pars ? ', ' : '') + (funcao ? '' : (p[P_MODO] || 'IN') + ' ') + q(p[P_NOME].trim()) + ' ' + p[P_TIPO].trim();
  });
  let r = 'CREATE ' + (c.definer.trim() ? 'DEFINER=' + definerSql(c.definer.trim()) + ' ' : '') + (funcao ? 'FUNCTION' : 'PROCEDURE') + ' ' + q(nome) + '(' + pars + ')\n';
  if (funcao) r += 'RETURNS ' + retorno + '\n';
  if (c.comentario.trim()) r += 'COMMENT ' + lit(c.comentario.trim()) + '\n';
  return r + (c.determ ? 'DETERMINISTIC' : 'NOT DETERMINISTIC') + '\n' + c.acesso + '\nSQL SECURITY ' + (c.invoker ? 'INVOKER' : 'DEFINER') + '\n' + c.corpo.trimEnd();
}

/**
 * DROP (se já existe) + CREATE: o dos campos ou, no modo Raw, o texto do editor.
 * nomeTemp: só o CREATE, com esse nome (validação antes do DROP).
 */
function montarScript(funcao: boolean, c: Campos, raw: boolean, nomeAntigo: string, nomeTemp = ''): string {
  let create: string;
  if (!raw) create = createSql(funcao, c, nomeTemp || c.nome.trim());
  else if (nomeTemp) create = c.corpo.trimEnd().replace(RX_NOME, (_m, antes: string) => antes + q(nomeTemp));
  else create = c.corpo.trimEnd();
  const drop = nomeAntigo !== '' && nomeTemp === '' ? `DROP ${funcao ? 'FUNCTION' : 'PROCEDURE'} IF EXISTS ${q(nomeAntigo)};\n` : '';
  return drop + 'DELIMITER $$\n' + create + '$$\nDELIMITER ;\n';
}

/** A rotina como está no banco (o FOld* do desktop) */
interface Antigo {
  /** '' = rotina nova */
  nome: string;
  script: string;
  /** SHOW CREATE de antes, para recriar se o Aplicar falhar ('' sem permissão para ver) */
  create: string;
  definer: string;
}

// ==========================================================
// A aba
// ==========================================================
export const AbaRotina: React.FC<{ aba: Extract<Aba, { tipo: 'rotina' }>; ativa: boolean }> = ({ aba, ativa }) => {
  const app = useApp();
  const funcao = aba.funcao;
  const tipo = funcao ? 'FUNCTION' : 'PROCEDURE';
  const banco = aba.banco;
  const alvo = useMemo<Alvo>(() => ({ conexao: aba.conexao, banco: aba.banco }), [aba.conexao, aba.banco]);

  const [campos, setCampos] = useState<Campos>(VAZIO);
  // Cópia sempre atual dos campos: as ações leem daqui logo depois de confirmar a célula em edição da grade
  // (o PostEdit do desktop), sem esperar a tela redesenhar.
  const atual = useRef(campos);
  const mudar = (m: Partial<Campos>) => {
    atual.current = { ...atual.current, ...m };
    setCampos(atual.current);
  };
  /** null: ainda não carregou */
  const [antigo, setAntigo] = useState<Antigo | null>(null);
  const [falhou, setFalhou] = useState(false);
  const [raw, setRaw] = useState(false);
  /** Modo Raw: o corpo que estava nos campos (volta ao sair) e o CREATE como entrou no editor */
  const design = useRef({ corpo: '', inicio: '' });
  const [usuarios, setUsuarios] = useState<string[]>([]);
  const [info, setInfo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [altura, arrastar] = useTamanho(250, 120);

  const grade = useRef<GradeApi>(null);
  const editor = useRef<EditorSqlApi>(null);
  const campoNome = useRef<HTMLInputElement>(null);
  const carga = useRef(0);

  const porCorpo = (t: string) => {
    mudar({ corpo: t });
    editor.current?.definirTexto(t);
  };

  /** Lê a rotina do banco para os campos (nomeRotina = '': rotina nova). */
  const carregar = async (nomeRotina: string) => {
    const vez = ++carga.current;
    const c: Campos = { ...VAZIO, nome: nomeRotina, pars: funcao ? [[RETORNO, 'INT', '']] : [] };
    let create = '';
    let definerAntigo = '';
    if (nomeRotina === '') {
      c.definer = await escalar(alvo, 'SELECT CURRENT_USER()');
      c.corpo = funcao ? 'BEGIN\n    RETURN 0;\nEND' : 'BEGIN\n    \nEND';
    } else {
      const [r] = await linhas(
        alvo,
        'SELECT routine_comment, security_type, sql_data_access, is_deterministic, definer, routine_definition ' +
          'FROM information_schema.routines WHERE routine_schema = ? AND routine_name = ? AND routine_type = ?',
        [banco, nomeRotina, tipo],
      );
      if (r) {
        c.comentario = r[0];
        c.invoker = r[1].toUpperCase() === 'INVOKER';
        c.acesso = ACESSOS.includes(r[2].toUpperCase()) ? r[2].toUpperCase() : ACESSOS[0];
        c.determ = r[3] === 'YES';
        c.definer = r[4];
        definerAntigo = r[4];
        c.corpo = r[5].replace(/\r\n?/g, '\n'); // vazio sem permissão para ver a definição
      }
      // ordinal 0 = retorno da function
      const pars = await linhas(
        alvo,
        'SELECT ordinal_position, parameter_name, dtd_identifier, parameter_mode FROM information_schema.parameters ' +
          'WHERE specific_schema = ? AND specific_name = ? AND routine_type = ? ORDER BY ordinal_position',
        [banco, nomeRotina, tipo],
      );
      for (const p of pars) {
        if (p[0] !== '0') c.pars.push([p[1], p[2], p[3]]);
        else if (funcao) c.pars[0][P_TIPO] = p[2];
      }
      try {
        create = await getCreate(alvo, tipo, banco, nomeRotina);
      } catch {
        // sem a definição antiga não dá para recriar se o Aplicar falhar; o Aplicar avisa
      }
    }
    if (vez !== carga.current) return; // outra carga começou depois desta
    atual.current = c;
    setCampos(c);
    editor.current?.definirTexto(c.corpo);
    setRaw(false);
    setAntigo({ nome: nomeRotina, script: montarScript(funcao, c, false, nomeRotina), create, definer: definerAntigo });
    setInfo(`${c.pars.length - (funcao ? 1 : 0)} parâmetro(s)`);
  };

  const abrir = async () => {
    setFalhou(false);
    try {
      await carregar(aba.nome);
    } catch (e) {
      avisar.erro(e);
      setFalhou(true);
    }
  };

  useEffect(() => {
    void abrir();
    void listarDefiners(alvo).then(setUsuarios);
    // Só ao abrir: depois quem recarrega é o Atualizar objeto e o Aplicar (a aba continua montada quando inativa)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // O FocusFirst do desktop, na primeira vez que a aba aparece já carregada
  const focou = useRef(false);
  useEffect(() => {
    if (!ativa || !antigo || focou.current) return;
    focou.current = true;
    if (antigo.nome === '') campoNome.current?.focus(); // rotina nova: o nome é o primeiro campo vazio
    else editor.current?.focar();
  }, [ativa, antigo]);

  const script = (nomeTemp = '') => montarScript(funcao, atual.current, raw, antigo?.nome ?? '', nomeTemp);
  const temAlteracoes = () => antigo !== null && script() !== antigo.script;

  // F9 e Ctrl+S não fazem nada neste documento no desktop: só as alterações pendentes interessam à janela
  useControleAba(aba.id, { temAlteracoes });

  // ----------------------------------------------------------
  // Raw: o CREATE inteiro no editor, como texto; os campos somem. Voltar descarta o que foi editado no texto
  // (ponytail: não reinterpreta o CREATE para preencher os campos; fazer se for preciso alternar editando).
  // ----------------------------------------------------------
  const alternarRaw = async () => {
    if (
      raw &&
      atual.current.corpo !== design.current.inicio &&
      !(await confirmar({ titulo: 'Voltar para os campos?', mensagem: 'Voltar para os campos descarta o que foi editado no SQL. Continuar?', confirmar: 'Descartar' }))
    ) {
      return;
    }
    if (raw) porCorpo(design.current.corpo);
    else {
      grade.current?.confirmarEdicao();
      const create = createSql(funcao, atual.current, atual.current.nome.trim());
      design.current = { corpo: atual.current.corpo, inicio: create };
      porCorpo(create);
    }
    setRaw(!raw);
    editor.current?.focar();
  };

  /** Nome da rotina no CREATE do modo Raw ('' se não achar). */
  const nomeNoRaw = () => RX_NOME.exec(atual.current.corpo)?.[2].replace(/`/g, '') ?? '';

  // ----------------------------------------------------------
  // Parâmetros
  // ----------------------------------------------------------
  const colunas = useMemo<ColunaGrade[]>(
    () => [
      { titulo: 'Nome', largura: 220 },
      { titulo: 'Tipo', largura: 160, editor: 'lista', itens: TIPOS },
      // parâmetro de function é sempre IN: a coluna fica escondida
      { titulo: 'Modo', largura: funcao ? -80 : 80, editor: 'lista', itens: ['IN', 'OUT', 'INOUT'], fixo: true },
    ],
    [funcao],
  );

  const incluir = () => {
    grade.current?.confirmarEdicao();
    const pars = [...atual.current.pars, ['', 'INT', 'IN']];
    mudar({ pars });
    // A linha nova só existe na grade depois de a tela redesenhar; com o foco no Nome, é só digitar
    setTimeout(() => grade.current?.focar(pars.length - 1, P_NOME));
  };

  const remover = async () => {
    const l = grade.current?.foco()?.linha ?? -1;
    const par = atual.current.pars[l];
    if (!par || (funcao && l === 0)) return;
    if (
      !(await confirmar({
        titulo: 'Remover o parâmetro?',
        mensagem: `Remover o parâmetro "${par[P_NOME]}"?\nA alteração só vai para o banco ao clicar em Aplicar alterações.`,
        confirmar: 'Remover',
      }))
    ) {
      return;
    }
    mudar({ pars: atual.current.pars.filter((p) => p !== par) });
  };

  /** d = -1 para cima, 1 para baixo; o retorno da function fica sempre na primeira linha. */
  const mover = (d: number) => {
    grade.current?.confirmarEdicao();
    const r = grade.current?.foco()?.linha ?? -1;
    const t = r + d;
    const primeira = funcao ? 1 : 0;
    if (r < primeira || t < primeira || t >= atual.current.pars.length) return;
    const pars = [...atual.current.pars];
    [pars[r], pars[t]] = [pars[t], pars[r]];
    mudar({ pars });
    grade.current?.focar(t);
  };

  // ----------------------------------------------------------
  // Rodapé
  // ----------------------------------------------------------
  const recarregar = async () => {
    if (!antigo) return;
    if (temAlteracoes() && !(await confirmarDescarte('Descartar as alterações não aplicadas?'))) return;
    setOcupado(true);
    try {
      await carregar(antigo.nome);
    } catch (e) {
      avisar.erro(e);
    } finally {
      setOcupado(false);
    }
  };

  const scriptDasAlteracoes = () => {
    grade.current?.confirmarEdicao();
    if (!temAlteracoes()) setInfo('Nenhuma alteração.');
    else app.abrirConsulta(aba.conexao, banco, script());
  };

  const aplicar = async () => {
    if (!antigo || ocupado) return;
    grade.current?.confirmarEdicao();
    const c = atual.current;
    const rotina = tipo.toLowerCase();
    let n: string;
    if (raw) {
      n = nomeNoRaw();
      if (n === '') {
        avisar.alerta(`Não achei o nome da ${rotina} no CREATE.`);
        editor.current?.focar();
        return;
      }
    } else n = c.nome.trim();
    if (n === '') {
      avisar.alerta('Informe o nome.');
      campoNome.current?.focus();
      return;
    }
    if (!raw) {
      const k = c.pars.findIndex((p) => p[P_NOME].trim() === '' || p[P_TIPO].trim() === '');
      if (k >= 0) {
        avisar.alerta(`Informe o nome e o tipo do parâmetro da linha ${k + 1}.`);
        grade.current?.focar(k);
        return;
      }
    }
    if (c.corpo.trim() === '') {
      avisar.alerta('Informe o corpo.');
      editor.current?.focar();
      return;
    }
    if (!temAlteracoes()) {
      setInfo('Nenhuma alteração para aplicar.');
      return;
    }
    // Os dois scripts saem dos campos como estão agora, antes de qualquer espera
    const agora = new Date();
    const dois = (x: number) => String(x).padStart(2, '0');
    const temp = n.slice(0, 50) + '_tmp' + dois(agora.getHours()) + dois(agora.getMinutes()) + dois(agora.getSeconds());
    const sc = script();
    const scTemp = script(temp);
    if (
      !(await confirmar({
        titulo: `Gravar a ${rotina}?`,
        mensagem: `Gravar a ${rotina} "${n}" no banco "${banco}"?` + (antigo.nome !== '' ? '\n\nA versão atual é removida e criada de novo (DROP + CREATE).' : ''),
        confirmar: 'Gravar',
        tom: 'normal',
      }))
    ) {
      return;
    }
    setOcupado(true);
    try {
      // Antes do DROP, cria com um nome temporário: erro de sintaxe ou de permissão (ex.: definer de outro
      // usuário) aparece aqui, com a rotina atual intacta.
      try {
        await rodar(alvo, [...splitScript(scTemp), `DROP ${tipo} IF EXISTS ${q(temp)}`]);
      } catch (e) {
        const msg = mensagemDe(e);
        app.log(`${tipo} ${banco}.${n}: ERRO ${msg}`);
        avisar.erro(comDicaDoDefiner(msg, c.definer) + '\n\nNada foi alterado no banco.');
        return;
      }
      try {
        await rodar(alvo, splitScript(sc));
      } catch (e) {
        const msg = mensagemDe(e);
        app.log(`${tipo} ${banco}.${n}: ERRO ${msg}`);
        // O CREATE já passou no teste: SYSTEM_USER aqui é o DROP barrado (rotina de um definer como o root),
        // e o script para nele, sem mexer em nada.
        if (/SYSTEM_USER/i.test(msg)) {
          avisar.erro(
            `A ${rotina} "${antigo.nome}" foi criada por ${antigo.definer}, um usuário com o privilégio SYSTEM_USER. O usuário da ` +
              'conexão não pode removê-la nem alterá-la.\n\nPara alterar: conecte como esse usuário (ex.: root) ou ' +
              'dê ao usuário da conexão o privilégio SYSTEM_USER.\n\nNada foi alterado no banco.',
          );
          return;
        }
        // O DROP pode ter passado e o CREATE não: recria a versão anterior para não perder a rotina.
        // Sem permissão para o definer antigo, recria sem DEFINER (fica o usuário da conexão).
        // (Só o primeiro DEFINER=, o do cabeçalho do CREATE: o corpo fica como está.)
        for (const velho of [antigo.create, antigo.create.replace(/DEFINER\s*=\s*\S+\s+/i, '')]) {
          if (velho === '') continue;
          try {
            await rodar(alvo, [`DROP ${tipo} IF EXISTS ${q(antigo.nome)}`, velho]);
            avisar.erro(`${msg}\n\nA versão anterior foi mantida${velho !== antigo.create ? ', mas com o definer do usuário da conexão' : ''}.`);
            return;
          } catch {
            // tenta a próxima forma; sem nenhuma, segue para o aviso abaixo
          }
        }
        avisar.erro(`${msg}\n\nConfira no explorador se a rotina ainda existe (Atualizar).`);
        return;
      }
      app.log(`${tipo} ${banco}.${n}: alterações aplicadas.`);
      app.alterarAba(aba.id, { titulo: `${banco}.${n}`, nome: n });
      app.atualizarArvore(aba.conexao, banco, funcao ? 'funcs' : 'procs');
      // Fora do try do script: uma falha ao reler não pode acionar a recriação da versão anterior
      try {
        await carregar(n);
        setInfo('Alterações aplicadas.');
      } catch (e) {
        avisar.erro(`As alterações foram aplicadas, mas não consegui reler a ${rotina}: ${mensagemDe(e)}`);
      }
    } catch (e) {
      avisar.erro(e); // falha fora do SQL (conexão caiu, senha cancelada)
    } finally {
      setOcupado(false);
    }
  };

  // ----------------------------------------------------------
  // Tela
  // ----------------------------------------------------------
  if (!antigo) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        {falhou ? (
          <div className="flex-1 flex items-center justify-center">
            <Botao icone={RefreshCw} onClick={() => void abrir()}>
              Tentar de novo
            </Botao>
          </div>
        ) : (
          <Carregando />
        )}
      </div>
    );
  }

  const parametros = campos.pars.length - (funcao ? 1 : 0);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 flex items-center gap-4 px-2 py-1 border-b border-borda text-xs text-texto2">
        <label className="flex items-center gap-2">
          Nome:
          <input
            ref={campoNome}
            value={campos.nome}
            onChange={(e) => mudar({ nome: e.target.value })}
            readOnly={raw}
            required
            className={`${CAMPO} w-60 ${raw ? 'opacity-60' : ''}`}
          />
        </label>
        <label className="flex items-center gap-2">
          Banco:
          <input value={banco} readOnly tabIndex={-1} className={`${CAMPO} w-45 opacity-60`} />
        </label>
        <label className="flex-1 min-w-0 flex items-center gap-2">
          Comentário:
          <input
            value={campos.comentario}
            onChange={(e) => mudar({ comentario: e.target.value })}
            readOnly={raw}
            className={`${CAMPO} flex-1 max-w-90 ${raw ? 'opacity-60' : ''}`}
          />
        </label>
      </div>

      {/* Parâmetros (esquerda) e Opções (direita); o corpo ocupa o resto. */}
      {!raw && (
        <>
          <div style={{ height: altura }} className="shrink-0 min-h-0 flex">
            <div className="flex-1 min-w-0 flex flex-col">
              <TituloPainel>Parâmetros</TituloPainel>
              <div className="shrink-0 flex items-center gap-1 px-1 pb-1 border-b border-borda">
                <Botao icone={Plus} onClick={incluir}>
                  Incluir
                </Botao>
                <Botao icone={Trash2} onClick={() => void remover()}>
                  Remover
                </Botao>
                <Botao icone={ArrowUp} onClick={() => mover(-1)}>
                  Mover para cima
                </Botao>
                <Botao icone={ArrowDown} onClick={() => mover(1)}>
                  Mover para baixo
                </Botao>
              </div>
              <Grade
                ref={grade}
                colunas={colunas}
                linhas={campos.pars}
                editavel
                // O nome do retorno da function não se edita.
                podeEditar={(l, c) => !(funcao && l === 0 && c === P_NOME)}
                onAlterar={(l, c, v) => mudar({ pars: atual.current.pars.map((p, i) => (i === l ? p.map((x, j) => (j === c ? texto(v) : x)) : p)) })}
                rodape={() => `${parametros} parâmetro(s)`}
                vazio="Nenhum parâmetro"
              />
            </div>
            <div className="w-[400px] shrink-0 flex flex-col border-l border-borda overflow-y-auto">
              <TituloPainel>Opções</TituloPainel>
              <div className="border-t border-borda">
                <LinhaOpcao rotulo="Segurança:">
                  <DuasOpcoes opcoes={['Invoker', 'Definer']} valor={campos.invoker ? 'Invoker' : 'Definer'} onMudar={(v) => mudar({ invoker: v === 'Invoker' })} />
                </LinhaOpcao>
                <LinhaOpcao rotulo="Definer:">
                  <CampoDefiner valor={campos.definer} onMudar={(definer) => mudar({ definer })} usuarios={usuarios} />
                </LinhaOpcao>
                <LinhaOpcao rotulo="Acesso SQL:">
                  <select value={campos.acesso} onChange={(e) => mudar({ acesso: e.target.value })} className={`${CAMPO} flex-1`}>
                    {ACESSOS.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                </LinhaOpcao>
                <LinhaOpcao rotulo="Determinístico:">
                  <span className="pl-1 flex items-center">
                    <Toggle checked={campos.determ} onChange={(determ) => mudar({ determ })} size="sm" />
                  </span>
                </LinhaOpcao>
              </div>
            </div>
          </div>
          <Divisor aoArrastar={arrastar} />
        </>
      )}

      <TituloPainel>{raw ? 'SQL' : 'Corpo'}</TituloPainel>
      <EditorSql ref={editor} inicial={campos.corpo} onMudar={(t) => mudar({ corpo: t })} className="flex-1" />

      <div className="shrink-0 flex items-center gap-1 px-1 py-1 bg-fundo2 border-t border-borda">
        <Botao icone={RefreshCw} onClick={() => void recarregar()} disabled={ocupado}>
          Atualizar objeto
        </Botao>
        <Botao icone={Check} onClick={() => void aplicar()} ocupado={ocupado}>
          Aplicar alterações
        </Botao>
        <Botao icone={FileCode} onClick={scriptDasAlteracoes} disabled={ocupado}>
          Script das alterações
        </Botao>
        <SeparadorBarra />
        <Toggle checked={raw} onChange={() => void alternarRaw()} label="Raw" title="Editar o CREATE inteiro como texto" disabled={ocupado} size="sm" />
        <span className="ml-auto pr-3 min-w-0 truncate text-xs text-texto2">{info}</span>
      </div>
    </div>
  );
};
