import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle, ShieldAlert, X } from 'lucide-react';
import { Aviso, PedidoConfirmar, PedidoTexto, assinarAvisos, fecharAviso, fecharPedido, lerAvisos } from '../lib/avisos';
import { Botao, CAMPO, Dialogo, LinhaCampo } from './ui';

const CORES = {
  erro: { caixa: 'bg-rose-50 dark:bg-rose-950 border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300', icone: 'text-rose-600' },
  alerta: { caixa: 'bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-300', icone: 'text-amber-600' },
  sucesso: { caixa: 'bg-emerald-50 dark:bg-emerald-950 border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-300', icone: 'text-emerald-600' },
};

/** Tempo que o aviso fica na tela antes de se fechar sozinho */
const SEGUNDOS = 10;

const Flutuante: React.FC<{ aviso: Aviso }> = ({ aviso }) => {
  useEffect(() => {
    const t = setTimeout(() => fecharAviso(aviso.id), (aviso.tom === 'sucesso' ? 4 : SEGUNDOS) * 1000);
    return () => clearTimeout(t);
  }, [aviso.id, aviso.tom]);
  const cor = CORES[aviso.tom];
  const Icone = aviso.tom === 'sucesso' ? CheckCircle : AlertCircle;
  return (
    <div role="alert" className={`pointer-events-auto max-w-full p-3 rounded-xl shadow-2xl border flex items-start gap-2.5 text-xs ${cor.caixa}`}>
      <Icone className={`w-4 h-4 shrink-0 mt-0.5 ${cor.icone}`} />
      <span className="flex-1 min-w-0 whitespace-pre-line break-words max-h-60 overflow-y-auto">{aviso.mensagem}</span>
      <button type="button" onClick={() => fecharAviso(aviso.id)} title="Fechar aviso" className="p-0.5 -mt-0.5 rounded shrink-0 cursor-pointer opacity-60 hover:opacity-100">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};

const Confirmacao: React.FC<{ p: PedidoConfirmar }> = ({ p }) => {
  const responder = (ok: boolean) => {
    fecharPedido(p);
    p.resolver(ok);
  };
  const perigo = (p.tom ?? 'perigo') === 'perigo';
  return (
    <Dialogo
      titulo={p.titulo}
      largura={440}
      onFechar={() => responder(false)}
      onEnviar={() => responder(true)}
      rodape={
        <>
          <Botao onClick={() => responder(false)}>Cancelar</Botao>
          <Botao tom={perigo ? 'perigo' : 'primario'} type="submit" autoFocus>
            {p.confirmar ?? 'Excluir'}
          </Botao>
        </>
      }
      focar={false}
    >
      <div className="flex items-start gap-3 p-4">
        <ShieldAlert className={`w-6 h-6 shrink-0 ${perigo ? 'text-rose-600' : 'text-blue-600'}`} />
        <div className="text-xs text-texto whitespace-pre-line break-words min-w-0">{p.mensagem}</div>
      </div>
    </Dialogo>
  );
};

const PedirTexto: React.FC<{ p: PedidoTexto }> = ({ p }) => {
  const [valor, setValor] = useState(p.padrao ?? '');
  const [erro, setErro] = useState('');
  const cancelar = () => {
    fecharPedido(p);
    p.resolver(null);
  };
  const ok = () => {
    const v = valor.trim();
    const e = v === '' ? 'Informe o valor.' : (p.validar?.(v) ?? '');
    if (e) return setErro(e);
    fecharPedido(p);
    p.resolver(v);
  };
  return (
    <Dialogo
      titulo={p.titulo}
      subtitulo={p.subtitulo}
      onFechar={cancelar}
      onEnviar={ok}
      rodape={
        <>
          <Botao onClick={cancelar}>Cancelar</Botao>
          <Botao tom={p.tom === 'perigo' ? 'perigo' : 'primario'} type="submit">
            {p.botao ?? 'OK'}
          </Botao>
        </>
      }
      focar={false}
    >
      <LinhaCampo rotulo={p.rotulo}>
        <input
          autoFocus
          required
          value={valor}
          onChange={(e) => {
            setValor(e.target.value);
            setErro('');
          }}
          className={`${CAMPO} flex-1`}
        />
      </LinhaCampo>
      {erro && <div className="px-4 py-2 text-xs text-amber-700 dark:text-amber-400">{erro}</div>}
    </Dialogo>
  );
};

/** Pilha do canto inferior direito, por cima de tudo (diálogos inclusive), e os diálogos imperativos do avisos.ts. */
export const Avisos: React.FC = () => {
  const { avisos, pedidos } = useSyncExternalStore(assinarAvisos, lerAvisos);
  return (
    <>
      {pedidos.map((p, i) => (p.tipo === 'confirmar' ? <Confirmacao key={i} p={p} /> : <PedirTexto key={i} p={p} />))}
      {createPortal(
        <div className="fixed bottom-8 right-5 z-[80] w-[min(28rem,calc(100vw-2.5rem))] flex flex-col items-end gap-2 pointer-events-none">
          {avisos.map((a) => (
            <Flutuante key={a.id} aviso={a} />
          ))}
        </div>,
        document.body,
      )}
    </>
  );
};
