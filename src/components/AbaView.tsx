/**
 * Documento de view (o TViewTab do desktop, uViewEdit.pas), como o do dbForge: abas Texto da consulta / Dados / SQL.
 * No texto, Nome e Banco em cima, o SELECT à esquerda e Opções (algoritmo, check option, segurança, definer) à
 * direita, com Atualizar objeto / Aplicar alterações / Script das alterações no rodapé. Aplicar grava com CREATE OR
 * REPLACE: se falhar, a view atual fica como estava. Dados roda o SELECT do editor (ainda não gravado), até 1000 linhas.
 * ponytail: sem o Query Design (montador visual) do dbForge.
 *
 * Os nomes vão sem o banco na frente, como no desktop: o Alvo da aba leva o banco (o WithDb do Pascal) e o
 * servidor faz o USE antes de rodar.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, FileCode, Pencil, RefreshCw, Table } from 'lucide-react';
import { Alvo, Conjunto, consulta, escalar, linhas, rodar } from '../lib/api';
import { getCreate, milhar, q, versaoCurta } from '../lib/db';
import { dropParens, formatSql, splitScript, unquote } from '../lib/sqlText';
import { avisar, confirmar, confirmarDescarte } from '../lib/avisos';
import { Aba, useApp, useControleAba } from '../app/contexto';
import { Abas, Botao, CAMPO, Carregando, ItemAba } from './ui';
import { GradeConjunto } from './GradeConjunto';
import { EditorSql, EditorSqlApi } from './EditorSql';
import { Toggle } from './Toggle';
import { CampoDefiner, DuasOpcoes, LinhaOpcao, TituloPainel, comDicaDoDefiner, definerSql, listarDefiners, mensagemDe } from './AbaRotina';

const ALGORITMOS = ['UNDEFINED', 'MERGE', 'TEMPTABLE'];
const LIMITE_DADOS = 1000;

const ABAS: ItemAba[] = [
  { id: 'texto', titulo: 'Texto da consulta', icone: Pencil },
  { id: 'dados', titulo: 'Dados', icone: Table },
  { id: 'sql', titulo: 'SQL', icone: FileCode },
];

/** O que está nos campos da tela */
interface Campos {
  nome: string;
  algoritmo: string;
  /** WITH ... CHECK OPTION */
  check: boolean;
  /** Tipo do check: LOCAL (senão CASCADED) */
  local: boolean;
  /** SQL SECURITY INVOKER (senão DEFINER) */
  invoker: boolean;
  definer: string;
  /** O SELECT */
  corpo: string;
}

const VAZIO: Campos = { nome: '', algoritmo: ALGORITMOS[0], check: false, local: false, invoker: false, definer: '', corpo: '' };

/** O SELECT do editor, sem o ; do fim. */
function corpoSql(texto: string): string {
  const r = texto.trimEnd();
  return r.endsWith(';') ? r.slice(0, -1).trimEnd() : r;
}

/** Nomes sem crase quando não precisam (unquote); o SELECT vai como está no editor. */
function createSql(c: Campos, nome: string, substituir: boolean): string {
  let r =
    unquote(
      'CREATE ' +
        (substituir ? 'OR REPLACE ' : '') +
        'ALGORITHM=' +
        c.algoritmo +
        (c.definer.trim() ? ' DEFINER=' + definerSql(c.definer.trim()) : '') +
        ' SQL SECURITY ' +
        (c.invoker ? 'INVOKER' : 'DEFINER') +
        ' VIEW ' +
        q(nome) +
        ' AS',
    ) +
    '\n' +
    corpoSql(c.corpo);
  if (c.check) r += '\nWITH ' + (c.local ? 'LOCAL' : 'CASCADED') + ' CHECK OPTION';
  return r;
}

/**
 * View nova: CREATE (não sobrescreve outra de mesmo nome). Existente: CREATE OR REPLACE com o nome atual e, se o
 * nome mudou, RENAME depois; se o CREATE falhar, nada muda.
 */
function montarScript(c: Campos, nomeAntigo: string): string {
  const n = c.nome.trim();
  if (nomeAntigo === '') return createSql(c, n, false) + ';\n';
  let r = createSql(c, nomeAntigo, true) + ';\n';
  if (n !== nomeAntigo) r += unquote('RENAME TABLE ' + q(nomeAntigo) + ' TO ' + q(n)) + ';\n';
  return r;
}

export const AbaView: React.FC<{ aba: Extract<Aba, { tipo: 'view' }>; ativa: boolean }> = ({ aba, ativa }) => {
  const app = useApp();
  const banco = aba.banco;
  const alvo = useMemo<Alvo>(() => ({ conexao: aba.conexao, banco: aba.banco }), [aba.conexao, aba.banco]);

  const [campos, setCampos] = useState<Campos>(VAZIO);
  const mudar = (m: Partial<Campos>) => setCampos((c) => ({ ...c, ...m }));
  /** A view como está no banco (nome = '': view nova); null: ainda não carregou */
  const [antigo, setAntigo] = useState<{ nome: string; script: string } | null>(null);
  const [falhou, setFalhou] = useState(false);
  const [interna, setInterna] = useState('texto');
  const [usuarios, setUsuarios] = useState<string[]>([]);
  const [versao, setVersao] = useState('');
  const [info, setInfo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [dados, setDados] = useState<Conjunto | null>(null);
  const [buscando, setBuscando] = useState(false);

  const editor = useRef<EditorSqlApi>(null);
  const campoNome = useRef<HTMLInputElement>(null);
  const carga = useRef(0);
  const busca = useRef(0);

  /** Lê a view do banco para os campos (nomeView = '': view nova). */
  const carregar = async (nomeView: string) => {
    const vez = ++carga.current;
    const c: Campos = { ...VAZIO, nome: nomeView };
    if (nomeView === '') c.definer = await escalar(alvo, 'SELECT CURRENT_USER()');
    else {
      const [r] = await linhas(alvo, 'SELECT check_option, security_type, definer FROM information_schema.views WHERE table_schema = ? AND table_name = ?', [
        banco,
        nomeView,
      ]);
      if (r) {
        c.check = r[0] !== 'NONE';
        c.local = r[0] === 'LOCAL';
        c.invoker = r[1].toUpperCase() === 'INVOKER';
        c.definer = r[2];
      }
      // O SELECT e o algoritmo saem do SHOW CREATE (o information_schema do MySQL não tem o algoritmo).
      let d = unquote(await getCreate(alvo, 'VIEW', banco, nomeView));
      let m = /\bALGORITHM\s*=\s*(\w+)/i.exec(d);
      if (m && ALGORITMOS.includes(m[1].toUpperCase())) c.algoritmo = m[1].toUpperCase();
      m = /\sVIEW\s+(`[^`]*`|\S+)\s+AS\s+/i.exec(d);
      if (m) d = d.slice(m.index + m[0].length);
      d = d.replace(/\s+WITH\s+(CASCADED|LOCAL)\s+CHECK\s+OPTION\s*$/i, '');
      // O formatSql quebra as linhas com CRLF (como no Delphi); o editor trabalha só com LF
      c.corpo = formatSql(dropParens(d)).replace(/\r\n?/g, '\n');
    }
    if (vez !== carga.current) return; // outra carga começou depois desta
    setCampos(c);
    editor.current?.definirTexto(c.corpo);
    setAntigo({ nome: nomeView, script: montarScript(c, nomeView) });
    setInfo('');
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
    // sem a versão a faixa só mostra servidor, usuário e banco
    escalar(alvo, 'SELECT VERSION()').then(
      (v) => setVersao(` (${versaoCurta(v)})`),
      () => {},
    );
    // Só ao abrir: depois quem recarrega é o Atualizar objeto e o Aplicar (a aba continua montada quando inativa)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // O FocusFirst do desktop, na primeira vez que a aba aparece já carregada
  const focou = useRef(false);
  useEffect(() => {
    if (!ativa || !antigo || focou.current) return;
    focou.current = true;
    if (antigo.nome === '') campoNome.current?.focus(); // view nova: o nome é o primeiro campo vazio
    else editor.current?.focar();
  }, [ativa, antigo]);

  const script = antigo ? montarScript(campos, antigo.nome) : '';
  const temAlteracoes = () => antigo !== null && script !== antigo.script;

  // F9 e Ctrl+S não fazem nada neste documento no desktop: só as alterações pendentes interessam à janela
  useControleAba(aba.id, { temAlteracoes });

  /** Volta para o texto com o foco no campo (a aba só reaparece depois de a tela redesenhar). */
  const voltarAoTexto = (noNome: boolean) => {
    setInterna('texto');
    setTimeout(() => (noNome ? campoNome.current?.focus() : editor.current?.focar()));
  };

  /** Roda o SELECT do editor (pode ainda não estar gravado), só para ver. */
  const mostrarDados = async () => {
    const sql = corpoSql(campos.corpo);
    if (sql.trim() === '') return;
    const vez = ++busca.current;
    setBuscando(true);
    try {
      const c = await consulta(alvo, sql, undefined, LIMITE_DADOS);
      if (vez === busca.current) setDados(c);
    } catch (e) {
      if (vez !== busca.current) return;
      avisar.erro(e);
      voltarAoTexto(false);
    } finally {
      if (vez === busca.current) setBuscando(false);
    }
  };

  const trocarAba = (id: string) => {
    setInterna(id);
    if (id === 'dados') void mostrarDados();
  };

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
    if (!temAlteracoes()) setInfo('Nenhuma alteração.');
    else app.abrirConsulta(aba.conexao, banco, script);
  };

  const aplicar = async () => {
    if (!antigo || ocupado) return;
    const n = campos.nome.trim();
    if (n === '' || corpoSql(campos.corpo) === '') {
      avisar.alerta(n === '' ? 'Informe o nome da view.' : 'Informe o SELECT da view.');
      voltarAoTexto(n === '');
      return;
    }
    if (!temAlteracoes()) {
      setInfo('Nenhuma alteração para aplicar.');
      return;
    }
    if (!(await confirmar({ titulo: 'Gravar a view?', mensagem: `Gravar a view "${n}" no banco "${banco}"?`, confirmar: 'Gravar', tom: 'normal' }))) return;
    setOcupado(true);
    try {
      await rodar(alvo, splitScript(script));
    } catch (e) {
      const msg = mensagemDe(e);
      app.log(`View ${banco}.${n}: ERRO ${msg}`);
      avisar.erro(comDicaDoDefiner(msg, campos.definer));
      setOcupado(false);
      return;
    }
    app.log(`View ${banco}.${n}: alterações aplicadas.`);
    app.alterarAba(aba.id, { titulo: `${banco}.${n}`, nome: n });
    app.atualizarArvore(aba.conexao, banco, 'views');
    try {
      await carregar(n);
      setInfo('Alterações aplicadas.');
    } catch (e) {
      avisar.erro(`As alterações foram aplicadas, mas não consegui reler a view: ${mensagemDe(e)}`);
    } finally {
      setOcupado(false);
    }
  };

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

  const cx = app.conexao(aba.conexao);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <Abas
        abas={ABAS}
        ativa={interna}
        onTrocar={trocarAba}
        // Como o "servidor | usuário | banco" do dbForge
        direita={<span className="whitespace-pre">{`${cx?.servidor ?? ''}${versao}   |   ${cx?.usuario ?? ''}   |   ${banco}`}</span>}
      />

      {/* Texto da consulta: fica montado (escondido) nas outras abas, para o editor não perder o que foi digitado */}
      <div className={interna === 'texto' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
        <div className="shrink-0 flex items-center gap-4 px-2 py-1 border-b border-borda text-xs text-texto2">
          <label className="flex items-center gap-2">
            Nome:
            <input ref={campoNome} value={campos.nome} onChange={(e) => mudar({ nome: e.target.value })} required className={`${CAMPO} w-60`} />
          </label>
          <label className="flex items-center gap-2">
            Banco:
            <input value={banco} readOnly tabIndex={-1} className={`${CAMPO} w-45 opacity-60`} />
          </label>
        </div>
        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0 flex flex-col">
            <TituloPainel>Texto da consulta</TituloPainel>
            <EditorSql ref={editor} inicial={campos.corpo} onMudar={(t) => mudar({ corpo: t })} className="flex-1" />
          </div>
          {/* Opções à direita, em planilha (rótulo | campo). */}
          <div className="w-[400px] shrink-0 flex flex-col border-l border-borda overflow-y-auto">
            <TituloPainel>Opções</TituloPainel>
            <div className="border-t border-borda">
              <LinhaOpcao rotulo="Algoritmo:">
                <select value={campos.algoritmo} onChange={(e) => mudar({ algoritmo: e.target.value })} className={`${CAMPO} flex-1`}>
                  {ALGORITMOS.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
              </LinhaOpcao>
              <LinhaOpcao rotulo="Check option:">
                <span className="pl-1 flex items-center">
                  <Toggle checked={campos.check} onChange={(check) => mudar({ check })} size="sm" />
                </span>
              </LinhaOpcao>
              <LinhaOpcao rotulo="Tipo do check:">
                {/* Habilita o tipo do check só com o check option marcado. */}
                <DuasOpcoes
                  opcoes={['Cascaded', 'Local']}
                  valor={campos.local ? 'Local' : 'Cascaded'}
                  onMudar={(v) => mudar({ local: v === 'Local' })}
                  disabled={!campos.check}
                />
              </LinhaOpcao>
              <LinhaOpcao rotulo="Segurança:">
                <DuasOpcoes opcoes={['Invoker', 'Definer']} valor={campos.invoker ? 'Invoker' : 'Definer'} onMudar={(v) => mudar({ invoker: v === 'Invoker' })} />
              </LinhaOpcao>
              <LinhaOpcao rotulo="Definer:">
                <CampoDefiner valor={campos.definer} onMudar={(definer) => mudar({ definer })} usuarios={usuarios} />
              </LinhaOpcao>
            </div>
          </div>
        </div>
      </div>

      {interna === 'dados' &&
        (buscando ? (
          <Carregando />
        ) : dados ? (
          <GradeConjunto conjunto={dados} ordenavel rodapeExtra={dados.truncado ? `Só as primeiras ${milhar(LIMITE_DADOS)} linhas` : undefined} />
        ) : (
          <div className="flex-1 p-6 text-center text-xs text-texto2">Informe o SELECT da view em Texto da consulta.</div>
        ))}

      {/* O script de agora, só para ler: o editor é refeito quando o script muda (ex.: depois de Aplicar) */}
      {interna === 'sql' && <EditorSql key={script} inicial={script} somenteLeitura className="flex-1" />}

      {/* Rodapé, como o do editor de tabela; some na aba Dados */}
      {interna !== 'dados' && (
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
          <span className="ml-auto pr-3 min-w-0 truncate text-xs text-texto2">{info}</span>
        </div>
      )}
    </div>
  );
};
