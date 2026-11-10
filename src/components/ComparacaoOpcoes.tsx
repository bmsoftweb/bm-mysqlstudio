/**
 * Diálogos da comparação de dados (uCompareOpts.pas), como no dbForge: Opções (como os valores são comparados) e
 * Mapeamento (quais tabelas entram, a chave que casa os registros e as colunas comparadas).
 */
import React, { useEffect, useRef, useState } from 'react';
import type { Valor } from '../lib/api';
import { CompareOptions, MapTable, TableMap, ignored, mapOf } from '../lib/compareLogic';
import { Botao, CAMPO, Dialogo, LinhaCampo } from './ui';
import { ColunaGrade, Grade, GradeApi } from './Grade';
import { Toggle } from './Toggle';

/** SameText/MatchText/IndexText do Delphi */
const mesmoTexto = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// ==========================================================
// Opções
// ==========================================================
const OPCOES: ['ignoreCase' | 'trimSpaces' | 'ignoreEol' | 'nullIsEmpty', string][] = [
  ['ignoreCase', 'Ignorar maiúsculas e minúsculas:'],
  ['trimSpaces', 'Ignorar espaços no começo e no fim:'],
  ['ignoreEol', 'Quebra de linha CRLF igual a LF:'],
  ['nullIsEmpty', 'Nulo igual a texto vazio:'],
];

/** O EditCompareOptions do Pascal: onOk recebe as opções alteradas (os maps não mudam aqui). */
export const DialogoOpcoes: React.FC<{ opcoes: CompareOptions; onOk: (o: CompareOptions) => void; onFechar: () => void }> = ({ opcoes, onOk, onFechar }) => {
  const [o, setO] = useState(opcoes);
  return (
    <Dialogo
      titulo="Opções da comparação"
      subtitulo="Como os valores são comparados. Valem a partir da próxima comparação."
      largura={640}
      onFechar={onFechar}
      onEnviar={() => onOk({ ...o, ignoreCols: o.ignoreCols.trim() })}
      rodape={
        <>
          <Botao onClick={onFechar}>Cancelar</Botao>
          <Botao tom="primario" type="submit">
            OK
          </Botao>
        </>
      }
    >
      {OPCOES.map(([campo, rotulo]) => (
        <LinhaCampo key={campo} rotulo={rotulo} larguraRotulo={240}>
          <Toggle checked={o[campo]} onChange={(v) => setO({ ...o, [campo]: v })} />
        </LinhaCampo>
      ))}
      <LinhaCampo rotulo="Colunas ignoradas:" larguraRotulo={240}>
        <input
          value={o.ignoreCols}
          onChange={(e) => setO({ ...o, ignoreCols: e.target.value })}
          placeholder="em todas as tabelas, com máscara: atualizado_em, *_log"
          className={`${CAMPO} flex-1`}
        />
      </LinhaCampo>
    </Dialogo>
  );
};

// ==========================================================
// Mapeamento
// ==========================================================
const COLUNAS_TABELAS: ColunaGrade[] = [
  { titulo: '', largura: 30, editor: 'check', dica: 'A tabela entra na comparação' },
  { titulo: 'Tabela', largura: 250, editor: 'nenhum' },
  { titulo: 'Chave', largura: 170, editor: 'nenhum' },
  { titulo: 'Colunas', largura: 100, alinhar: 'dir', editor: 'nenhum' },
];
const COLUNAS_COLUNAS: ColunaGrade[] = [
  { titulo: '', largura: 30, editor: 'check', dica: 'A coluna entra na comparação' },
  { titulo: 'Coluna', largura: 320, editor: 'nenhum' },
];

interface MapeamentoProps {
  /** Tabelas em comum dos dois bancos (mapTables); nunca vazio */
  tabelas: MapTable[];
  opcoes: CompareOptions;
  db1: string;
  db2: string;
  /** Só as tabelas com algum ajuste; as outras seguem o padrão */
  onOk: (maps: TableMap[]) => void;
  onFechar: () => void;
}

/** O TfrmMapping do Pascal (quem lê as tabelas e avisa quando não há nenhuma em comum é a aba). */
export const DialogoMapeamento: React.FC<MapeamentoProps> = ({ tabelas, opcoes, db1, db2, onOk, onFechar }) => {
  // Um ajuste por tabela, em cópia: Cancelar não mexe nas opções
  const [maps, setMaps] = useState<TableMap[]>(() =>
    tabelas.map((t) => {
      const m = mapOf(opcoes, t.table);
      return { ...m, ignore: [...m.ignore] };
    }),
  );
  const [cur, setCur] = useState(0);
  const grade = useRef<GradeApi>(null);
  // só as Colunas ignoradas das Opções (sem os maps)
  const global: CompareOptions = { ...opcoes, maps: [] };

  // Como o ActiveControl := FList do desktop, com a primeira tabela escolhida
  useEffect(() => {
    grade.current?.focar(0, 1);
  }, []);

  /** Índice da chave em tabelas[i].keys: o padrão é o primeiro (PRIMARY, ou o primeiro único). -1: não existe mais. */
  const keyIndex = (i: number) => (maps[i].key === '' ? (tabelas[i].keys.length > 0 ? 0 : -1) : tabelas[i].keys.findIndex((k) => mesmoTexto(k, maps[i].key)));

  const isKeyCol = (i: number, col: string) => {
    const k = keyIndex(i);
    return k >= 0 && tabelas[i].keyCols[k].split(',').some((c) => mesmoTexto(c, col));
  };

  const compared = (i: number, col: string) => isKeyCol(i, col) || !(maps[i].ignore.some((c) => mesmoTexto(c, col)) || ignored(global, tabelas[i].table, col));

  /** A chave sempre entra; a máscara das Opções vale para todas as tabelas */
  const habilitada = (i: number, col: string) => !isKeyCol(i, col) && !ignored(global, tabelas[i].table, col);

  const mudar = (i: number, m: Partial<TableMap>) => setMaps((ms) => ms.map((x, j) => (j === i ? { ...x, ...m } : x)));

  // Colunas Chave e Colunas de cada tabela na lista (o ShowItem do Pascal).
  const linhasTabelas: Valor[][] = tabelas.map((t, i) => {
    const k = keyIndex(i);
    const chave = k >= 0 ? t.keys[k] : t.keys.length === 0 ? '(sem chave)' : maps[i].key + ' (não existe)';
    return [maps[i].skip ? '' : '1', t.table, chave, `${t.cols.filter((c) => compared(i, c)).length} de ${t.cols.length}`];
  });

  const t = tabelas[cur];
  const k = keyIndex(cur);

  return (
    <Dialogo
      titulo={`Mapeamento: ${db1} → ${db2}`}
      subtitulo="Desmarque as tabelas que não entram; escolha a chave que casa os registros e as colunas comparadas."
      largura={980}
      altura={620}
      focar={false}
      onFechar={onFechar}
      onEnviar={() => onOk(maps.filter((m) => m.skip || m.key !== '' || m.ignore.length > 0))}
      rodape={
        <>
          <Botao onClick={onFechar}>Cancelar</Botao>
          <Botao tom="primario" type="submit">
            OK
          </Botao>
        </>
      }
    >
      <div className="flex-1 min-h-0 flex">
        <div className="w-[590px] max-w-[60%] shrink-0 flex flex-col border-r border-borda">
          <Grade
            ref={grade}
            colunas={COLUNAS_TABELAS}
            linhas={linhasTabelas}
            editavel
            onAlterar={(l, _c, v) => mudar(l, { skip: v !== '1' })}
            onFoco={(l) => setCur(l)}
            rodape={(_p, n) => `${n} tabela(s)`}
          />
        </div>
        <div className="flex-1 min-w-0 flex flex-col">
          <LinhaCampo rotulo="Chave:" larguraRotulo={50}>
            <select
              value={k}
              disabled={t.keys.length <= 1}
              // o primeiro é o padrão: fica sem ajuste
              onChange={(e) => mudar(cur, { key: Number(e.target.value) === 0 ? '' : t.keys[Number(e.target.value)] })}
              className={`${CAMPO} flex-1`}
            >
              {t.keys.length === 0 && <option value={-1}>nenhum índice único sem coluna nula: a tabela não é comparada</option>}
              {t.keys.length > 0 && k < 0 && <option value={-1} hidden />}
              {t.keys.map((key, j) => (
                <option key={key} value={j}>
                  {key} ({t.keyCols[j].replaceAll(',', ', ')})
                </option>
              ))}
            </select>
          </LinhaCampo>
          <div className="shrink-0 px-4 pt-2 pb-1 text-xs text-texto2">Colunas comparadas (a chave sempre entra):</div>
          {/* Refeita a cada tabela: a rolagem e o foco voltam para o começo */}
          <Grade
            key={cur}
            colunas={COLUNAS_COLUNAS}
            linhas={t.cols.map((c) => [compared(cur, c) ? '1' : '', c])}
            editavel
            podeEditar={(l) => habilitada(cur, t.cols[l])}
            classeLinha={(l) => (habilitada(cur, t.cols[l]) ? undefined : 'text-texto2')}
            // Ignoradas: as colunas destravadas que ficaram desmarcadas (o ColsClick do Pascal).
            onAlterar={(l, _c, v) => mudar(cur, { ignore: t.cols.filter((c, j) => habilitada(cur, c) && !(j === l ? v === '1' : compared(cur, c))) })}
            rodape={(_p, n) => `${n} coluna(s)`}
          />
        </div>
      </div>
    </Dialogo>
  );
};
