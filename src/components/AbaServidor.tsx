/**
 * Telas do servidor, como no dbForge: sessões (com encerrar), variáveis (com alterar) e status (os usuários ficam
 * na AbaSeguranca). Conversão do uServer.pas.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pencil, RefreshCw, Unplug } from 'lucide-react';
import { Alvo, Conjunto, Valor, consulta, rodar, texto } from '../lib/api';
import { escapeStr } from '../lib/compareLogic';
import { avisar, confirmar } from '../lib/avisos';
import { Aba, useApp, useControleAba } from '../app/contexto';
import type { GradeApi } from './Grade';
import { GradeConjunto } from './GradeConjunto';
import { Toggle } from './Toggle';
import { Barra, Botao, BotaoBarra, CAMPO, Carregando, Dialogo, LinhaCampo, SeparadorBarra } from './ui';

const SQLS = { sessoes: 'SHOW FULL PROCESSLIST', variaveis: 'SHOW GLOBAL VARIABLES', status: 'SHOW GLOBAL STATUS' } as const;

/** O SqlStr do Pascal */
const sqlStr = (s: string) => "'" + escapeStr(s) + "'";

export const AbaServidor: React.FC<{ aba: Extract<Aba, { tipo: 'servidor' }>; ativa: boolean }> = ({ aba, ativa }) => {
  const app = useApp();
  const alvo = useMemo<Alvo>(() => ({ conexao: aba.conexao }), [aba.conexao]);
  const nomeConexao = app.conexao(aba.conexao)?.nome ?? '';
  const [conjunto, setConjunto] = useState<Conjunto | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [filtro, setFiltro] = useState('');
  const [auto, setAuto] = useState(false);
  /** Variável no diálogo "Alterar variável" */
  const [variavel, setVariavel] = useState<{ nome: string; valor: string } | null>(null);
  const grade = useRef<GradeApi>(null);
  /** Só o resultado do pedido mais recente vale (Atualizar clicado durante a atualização automática) */
  const pedido = useRef(0);
  const emCurso = useRef(false);
  /** Primeiro campo da linha a escolher depois de recarregar ('' = a primeira); null = nada a fazer */
  const posicionar = useRef<string | null>(null);

  // Filtro pelo nome (primeiro campo), sem diferenciar maiúsculas: o OnFilterRecord do Pascal
  const visivel = useMemo<Conjunto | null>(() => {
    const f = filtro.trim().toLowerCase();
    if (!conjunto || !f) return conjunto;
    return { ...conjunto, linhas: conjunto.linhas.filter((l) => texto(l[0]).toLowerCase().includes(f)) };
  }, [conjunto, filtro]);

  /** A linha escolhida na grade (a "atual do FQry", que Encerrar/Alterar usam) */
  const linhaAtual = (): Valor[] | undefined => {
    const f = grade.current?.foco();
    return f && visivel ? visivel.linhas[f.linha] : undefined;
  };

  // Mantém a linha selecionada (pelo primeiro campo) ao atualizar.
  const recarregar = async () => {
    const n = ++pedido.current;
    emCurso.current = true;
    setOcupado(true);
    const l = linhaAtual();
    try {
      const c = await consulta(alvo, SQLS[aba.qual]);
      if (n !== pedido.current) return;
      posicionar.current = l ? texto(l[0]) : '';
      setConjunto(c);
    } catch (e) {
      if (n !== pedido.current) return;
      setAuto(false); // com erro, a atualização automática para
      avisar.erro(e);
    } finally {
      if (n === pedido.current) {
        emCurso.current = false;
        setOcupado(false);
      }
    }
  };
  const recarregarAtual = useRef(recarregar);
  recarregarAtual.current = recarregar;

  useEffect(() => {
    void recarregarAtual.current();
  }, []);

  // Depois de recarregar: volta para a linha que estava escolhida (ou fica na primeira, como o grid do desktop)
  useEffect(() => {
    const chave = posicionar.current;
    if (chave === null || !visivel) return;
    posicionar.current = null;
    if (!visivel.linhas.length) return;
    const i = Math.max(0, chave === '' ? 0 : visivel.linhas.findIndex((l) => texto(l[0]) === chave));
    if (grade.current?.foco()?.linha === i) return;
    // focar() leva o teclado para a grade: quem estava com o foco (ex.: o filtro) continua com ele
    const antes = document.activeElement;
    grade.current?.focar(i);
    if (antes instanceof HTMLElement && antes !== document.body) antes.focus();
  }, [visivel]);

  // Atualização automática (o TTimer de 5 s): só com a aba em primeiro plano; não empilha pedidos
  useEffect(() => {
    if (!auto || !ativa) return;
    const t = setInterval(() => {
      if (!emCurso.current) void recarregarAtual.current();
    }, 5000);
    return () => clearInterval(t);
  }, [auto, ativa]);

  useControleAba(aba.id, { executar: () => void recarregar() });

  /** Campo pelo nome, sem diferenciar maiúsculas (o FieldByName) */
  const valor = (l: Valor[], nome: string): string => {
    const i = conjunto?.campos.findIndex((c) => c.nome.toLowerCase() === nome) ?? -1;
    return i >= 0 ? texto(l[i]) : '';
  };

  const encerrar = async () => {
    const l = linhaAtual();
    if (!l) return;
    const id = valor(l, 'id');
    if (!/^\d+$/.test(id)) return; // o Id vai direto no KILL: só número
    if (
      !(await confirmar({
        titulo: 'Encerrar sessão',
        mensagem: `Encerrar a sessão ${id} (${valor(l, 'user')} em ${valor(l, 'host')})?\nO que ela estiver executando é interrompido.`,
        confirmar: 'Encerrar',
      }))
    )
      return;
    try {
      await rodar(alvo, 'KILL ' + id);
      app.log(`${nomeConexao}: sessão ${id} encerrada.`);
    } catch (e) {
      avisar.erro(e);
    }
    await recarregar();
  };

  const alterar = (l = linhaAtual()) => {
    if (!l) return;
    const nome = texto(l[0]);
    if (!/^\w+$/.test(nome)) return; // o nome vai direto no SET GLOBAL
    setVariavel({ nome, valor: texto(l[1]) });
  };

  const gravarVariavel = async (nome: string, digitado: string) => {
    setVariavel(null);
    const v = digitado.trim();
    const l = /^-?\d+(\.\d+)?$/.test(v) || ['ON', 'OFF', 'DEFAULT'].includes(v.toUpperCase()) ? v : sqlStr(v);
    try {
      await rodar(alvo, `SET GLOBAL ${nome} = ${l}`);
      app.log(`${nomeConexao}: SET GLOBAL ${nome} = ${l}`);
    } catch (e) {
      avisar.erro(e);
    }
    await recarregar();
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <Barra>
        <BotaoBarra icone={RefreshCw} titulo="Atualizar" texto onClick={() => void recarregar()} />
        {aba.qual === 'sessoes' && (
          <>
            <SeparadorBarra />
            <BotaoBarra icone={Unplug} titulo="Encerrar sessão" texto onClick={() => void encerrar()} />
            <SeparadorBarra />
            <span className="px-1 flex items-center">
              <Toggle size="sm" checked={auto} onChange={setAuto} label="Atualizar a cada 5 s" />
            </span>
          </>
        )}
        {aba.qual === 'variaveis' && (
          <>
            <SeparadorBarra />
            <BotaoBarra icone={Pencil} titulo="Alterar valor" texto onClick={() => alterar()} />
          </>
        )}
        {aba.qual !== 'sessoes' && (
          <>
            <SeparadorBarra />
            <input value={filtro} onChange={(e) => setFiltro(e.target.value)} placeholder="Filtrar pelo nome" className={`${CAMPO} w-[220px]`} />
          </>
        )}
        <span className="px-2 text-xs text-texto2 whitespace-nowrap">
          {visivel && `${visivel.linhas.length} linha(s)`}
          {ocupado && conjunto && ' (atualizando...)'}
        </span>
      </Barra>
      {visivel ? (
        <GradeConjunto
          refGrade={grade}
          conjunto={visivel}
          onDuploClique={aba.qual === 'variaveis' ? (l) => alterar(visivel.linhas[l]) : undefined}
        />
      ) : ocupado ? (
        <Carregando />
      ) : (
        <div className="flex-1" />
      )}
      {variavel && <DialogoVariavel nome={variavel.nome} valor={variavel.valor} onOk={(v) => void gravarVariavel(variavel.nome, v)} onFechar={() => setVariavel(null)} />}
    </div>
  );
};

/**
 * O InputQuery do "Alterar variável". Não é o pedirTexto comum porque ele recusa valor em branco, e variável
 * pode ficar vazia (SET GLOBAL sql_mode = '').
 */
const DialogoVariavel: React.FC<{ nome: string; valor: string; onOk: (valor: string) => void; onFechar: () => void }> = ({ nome, valor, onOk, onFechar }) => {
  const [v, setV] = useState(valor);
  return (
    <Dialogo
      titulo="Alterar variável"
      subtitulo={`${nome} (SET GLOBAL)`}
      onFechar={onFechar}
      onEnviar={() => onOk(v)}
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
      <LinhaCampo rotulo="Valor:">
        <input autoFocus value={v} onChange={(e) => setV(e.target.value)} className={`${CAMPO} flex-1`} />
      </LinhaCampo>
    </Dialogo>
  );
};
