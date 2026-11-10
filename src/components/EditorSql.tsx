/**
 * Editor de SQL (o SynEdit do app desktop): destaque de MySQL com as cores do dbForge, números de linha,
 * autocompletar (tabelas, colunas depois de "tabela." ou "apelido.", palavras-chave), localizar/substituir
 * (Ctrl+F / Ctrl+H) e desfazer/refazer.
 */
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, redo } from '@codemirror/commands';
import { HighlightStyle, bracketMatching, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { MySQL, sql } from '@codemirror/lang-sql';
import { tags as t } from '@lezer/highlight';

/** Tabelas do banco da aba e as colunas de cada uma, para o autocompletar */
export type EsquemaSql = Record<string, string[]>;

export interface EditorSqlApi {
  texto(): string;
  definirTexto(texto: string): void;
  /** Seleção atual: posições (base 0) e o texto selecionado ('' sem seleção; de = posição do cursor) */
  selecao(): { de: number; ate: number; texto: string };
  selecionar(de: number, ate: number): void;
  /** Troca a seleção pelo texto (entra no desfazer) */
  substituirSelecao(texto: string): void;
  selecionarTudo(): void;
  focar(): void;
  refazer(): void;
}

interface EditorSqlProps {
  inicial?: string;
  somenteLeitura?: boolean;
  esquema?: EsquemaSql;
  onMudar?: (texto: string) => void;
  /** Atalhos próprios, ex.: { 'F9': executar, 'Ctrl-Enter': executarAtual, 'Ctrl-k': formatar } */
  atalhos?: Record<string, () => void>;
  className?: string;
}

const cores = HighlightStyle.define([
  { tag: [t.keyword, t.typeName, t.operatorKeyword, t.bool, t.null], class: 'sql-chave' },
  { tag: [t.function(t.variableName), t.standard(t.name)], class: 'sql-funcao' },
  { tag: [t.string, t.special(t.string)], class: 'sql-texto' },
  { tag: [t.lineComment, t.blockComment, t.comment], class: 'sql-comentario' },
  { tag: [t.special(t.name)], class: 'sql-variavel' },
  { tag: [t.number], class: 'sql-numero' },
]);

export const EditorSql = forwardRef<EditorSqlApi, EditorSqlProps>(function EditorSql({ inicial = '', somenteLeitura, esquema, onMudar, atalhos, className = '' }, ref) {
  const caixa = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const linguagem = useRef(new Compartment());
  const leitura = useRef(new Compartment());
  // Em refs: o editor é criado uma vez só e chama sempre a versão atual
  const mudar = useRef(onMudar);
  mudar.current = onMudar;
  const teclas = useRef(atalhos);
  teclas.current = atalhos;

  useEffect(() => {
    const proprias = Object.keys(teclas.current ?? {}).map((key) => ({
      key,
      preventDefault: true,
      run: () => {
        teclas.current?.[key]?.();
        return true;
      },
    }));
    const v = new EditorView({
      parent: caixa.current!,
      state: EditorState.create({
        doc: inicial,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches(),
          indentUnit.of('    '),
          EditorState.tabSize.of(4),
          syntaxHighlighting(cores),
          autocompletion({ activateOnTypingDelay: 300 }),
          linguagem.current.of(sql({ dialect: MySQL, schema: esquema, upperCaseKeywords: true })),
          leitura.current.of([EditorState.readOnly.of(Boolean(somenteLeitura)), EditorView.editable.of(!somenteLeitura)]),
          keymap.of([...proprias, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, ...completionKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) mudar.current?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: linguagem.current.reconfigure(sql({ dialect: MySQL, schema: esquema, upperCaseKeywords: true })) });
  }, [esquema]);

  useEffect(() => {
    view.current?.dispatch({
      effects: leitura.current.reconfigure([EditorState.readOnly.of(Boolean(somenteLeitura)), EditorView.editable.of(!somenteLeitura)]),
    });
  }, [somenteLeitura]);

  useImperativeHandle(ref, () => ({
    texto: () => view.current?.state.doc.toString() ?? '',
    definirTexto: (texto) => {
      const v = view.current;
      if (v && v.state.doc.toString() !== texto) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: texto } });
    },
    selecao: () => {
      const v = view.current;
      if (!v) return { de: 0, ate: 0, texto: '' };
      const s = v.state.selection.main;
      return { de: s.from, ate: s.to, texto: v.state.sliceDoc(s.from, s.to) };
    },
    selecionar: (de, ate) => {
      const v = view.current;
      if (!v) return;
      const n = v.state.doc.length;
      v.dispatch({ selection: EditorSelection.range(Math.min(de, n), Math.min(ate, n)), scrollIntoView: true });
    },
    substituirSelecao: (texto) => {
      const v = view.current;
      if (v) v.dispatch(v.state.replaceSelection(texto));
    },
    selecionarTudo: () => {
      const v = view.current;
      if (v) v.dispatch({ selection: EditorSelection.range(0, v.state.doc.length) });
    },
    focar: () => view.current?.focus(),
    refazer: () => {
      if (view.current) redo(view.current);
    },
  }));

  return <div ref={caixa} className={`min-h-0 min-w-0 overflow-hidden ${className}`} />;
});
