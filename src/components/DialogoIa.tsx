/**
 * "Gerar com IA": o usuário descreve o que precisa e a IA devolve o SQL (consulta, SELECT da view, ou a function /
 * procedure inteira) para a aba pôr no editor. Nada é executado aqui. A estrutura do banco vai junto com o pedido:
 * é lida uma vez por banco (src/lib/ia.ts) e reaproveitada; "Reler estrutura" lê de novo.
 */
import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { ErroApi, RespostaIa, TipoIa, pedirIa } from '../lib/api';
import { estruturaDe } from '../lib/ia';
import { avisar } from '../lib/avisos';
import { useApp } from '../app/contexto';
import { Botao, Dialogo } from './ui';

const TEXTOS: Record<TipoIa, { titulo: string; exemplo: string }> = {
  sql: { titulo: 'Gerar SQL com IA', exemplo: 'faça um SQL para listar as vendas do mês' },
  view: { titulo: 'Gerar view com IA', exemplo: 'crie uma view com o cálculo de comissão por vendedor' },
  funcao: { titulo: 'Gerar function com IA', exemplo: 'crie uma função para recalcular o estoque de um produto' },
  procedure: { titulo: 'Gerar procedure com IA', exemplo: 'crie uma procedure para recalcular o estoque de um produto' },
};

interface DialogoIaProps {
  tipo: TipoIa;
  conexao: number;
  banco: string;
  /** O que já está no editor: o pedido pode ser uma alteração disso */
  atual?: string;
  /** Linha de ajuda embaixo do campo */
  dica?: string;
  /** A IA devolveu SQL: a aba põe no editor (o diálogo fecha em seguida) */
  onPronto: (r: RespostaIa) => void;
  onFechar: () => void;
}

export const DialogoIa: React.FC<DialogoIaProps> = ({ tipo, conexao, banco, atual = '', dica, onPronto, onFechar }) => {
  const app = useApp();
  const [pedido, setPedido] = useState('');
  /** '' = parado; senão, o que está fazendo */
  const [fazendo, setFazendo] = useState('');
  const cancelar = useRef<AbortController | null>(null);

  // Diálogo fechado no meio: o servidor para de gerar
  useEffect(() => () => cancelar.current?.abort(), []);

  const gerar = async () => {
    const p = pedido.trim();
    if (fazendo || !p) return;
    cancelar.current = new AbortController();
    try {
      setFazendo('Lendo a estrutura do banco...');
      const estrutura = await estruturaDe(conexao, banco);
      setFazendo('Gerando...');
      const r = await pedirIa({ tipo, pedido: p, estrutura, atual: atual.trim() || undefined }, cancelar.current.signal);
      if (!r.sql.trim()) {
        avisar.alerta(r.observacao || 'A IA não conseguiu gerar o SQL para este pedido.');
        return;
      }
      app.log(`IA (${banco}): ${p}${r.observacao ? ` | ${r.observacao}` : ''}`);
      if (r.observacao) avisar.alerta(`IA: ${r.observacao}`);
      onPronto(r);
      onFechar();
    } catch (e) {
      if (!(e instanceof ErroApi && e.codigo === 'INTERROMPIDA')) avisar.erro(e);
    } finally {
      setFazendo('');
    }
  };

  const reler = async () => {
    if (fazendo) return;
    setFazendo('Lendo a estrutura do banco...');
    try {
      await estruturaDe(conexao, banco, true);
      avisar.sucesso(`Estrutura do banco ${banco} relida.`);
    } catch (e) {
      avisar.erro(e);
    } finally {
      setFazendo('');
    }
  };

  const t = TEXTOS[tipo];
  return (
    <Dialogo
      titulo={t.titulo}
      subtitulo={`Banco ${banco}. O resultado vai para o editor, para você revisar: nada é executado.`}
      largura={620}
      onFechar={onFechar}
      rodape={
        <>
          <Botao
            icone={RefreshCw}
            onClick={() => void reler()}
            disabled={Boolean(fazendo)}
            className="mr-auto"
            title="A estrutura do banco é lida uma vez e reaproveitada nos pedidos seguintes. Releia se as tabelas mudaram por fora do MySQL Studio."
          >
            Reler estrutura
          </Botao>
          <span className="min-w-0 truncate text-xs text-texto2">{fazendo}</span>
          <Botao onClick={onFechar}>Cancelar</Botao>
          <Botao tom="primario" icone={Sparkles} onClick={() => void gerar()} ocupado={Boolean(fazendo)} disabled={!pedido.trim()}>
            Gerar
          </Botao>
        </>
      }
    >
      <div className="flex flex-col gap-2 p-4">
        <label htmlFor="pedido-ia" className="text-xs text-texto2">
          O que você precisa?
        </label>
        <textarea
          id="pedido-ia"
          value={pedido}
          onChange={(e) => setPedido(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void gerar();
            }
          }}
          required
          readOnly={Boolean(fazendo)}
          placeholder={`Ex.: ${t.exemplo}`}
          className="h-32 resize-none bg-fundo2 px-2 py-1.5 text-xs text-texto placeholder:text-texto2"
        />
        <div className="text-xs text-texto2">
          {atual.trim() ? 'O que está no editor vai junto: o pedido pode ser uma alteração dele. ' : dica ? dica + ' ' : ''}
          Ctrl+Enter gera.
        </div>
      </div>
    </Dialogo>
  );
};
