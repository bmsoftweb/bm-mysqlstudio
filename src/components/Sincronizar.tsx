/**
 * Assistente de sincronização de dados (uSync.pas), como o do dbForge: saída, opções, scripts adicionais e resumo.
 * Gera e executa com andamento e cancelar (o script sai do writeDataScript do compareLogic).
 *
 * Diferenças do desktop: o arquivo é escolhido no diálogo Salvar do navegador ao clicar em Sincronizar (o campo
 * Arquivo é só o nome sugerido, e é o navegador que pergunta se substitui); executando direto no destino, o script
 * é montado na memória (não num arquivo temporário) e vai para o runScript.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { Alvo } from '../lib/api';
import { ARQ_SQL, Gravador, baixar, criarArquivo, milhar, q } from '../lib/db';
import { SyncOptions, TableDiff, Trigger, changes, loadTriggers, newSyncOptions, restoreTriggers, triggersOn, writeDataScript } from '../lib/compareLogic';
import { runScript } from '../lib/backup';
import { avisar, confirmar } from '../lib/avisos';
import { useApp } from '../app/contexto';
import { Botao, CAMPO, Dialogo, LinhaCampo } from './ui';
import { Toggle } from './Toggle';
import { mensagemDe } from './AbaRotina';

const PAGINAS = ['Saída', 'Opções', 'Scripts adicionais', 'Resumo'];
const SAIDAS = ['Abrir o script no editor de consulta', 'Salvar o script em arquivo', 'Executar direto no destino'];
const EDITOR_LIMIT = 5 * 1024 * 1024; // o editor de consulta fica lento com script maior: aí é arquivo ou executar
const ROTULO = 210;
const MEMO = 'min-h-0 bg-fundo2 px-2 py-1 text-xs font-mono text-texto resize-none disabled:opacity-60';

/** _aaaammdd_hhnnss na hora local (nunca toISOString: é UTC). */
function carimbo(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

interface SincronizarProps {
  /** Destino, já com o banco (o Params do Pascal) */
  alvo: Alvo;
  db: string;
  header: string;
  /** As tabelas marcadas na comparação */
  diffs: TableDiff[];
  ins: boolean;
  upd: boolean;
  del: boolean;
  /**
   * resultado: o que foi feito, para a barra da comparação ('' = fechou sem fazer nada);
   * recomparar: executou com "Comparar de novo depois".
   */
  onFechar: (resultado: string, recomparar: boolean) => void;
}

export const Sincronizar: React.FC<SincronizarProps> = ({ alvo, db, header, diffs, ins, upd, del, onFechar }) => {
  const app = useApp();
  const cx = app.conexao(alvo.conexao);
  const info = cx ? ` (${cx.usuario}@${cx.servidor}:${cx.porta})` : '';

  const [pagina, setPagina] = useState(0);
  const [resumo, setResumo] = useState('');
  // Saída
  const [saida, setSaida] = useState(0); // como no dbForge: não mexe no destino
  const [arquivo, setArquivo] = useState(`sincronizar_${db}.sql`);
  const [stamp, setStamp] = useState(true);
  const [again, setAgain] = useState(true);
  // Opções
  const [useDb, setUseDb] = useState(true);
  const [noFks, setNoFks] = useState(true);
  const [noTriggers, setNoTriggers] = useState(true);
  const [comments, setComments] = useState(true);
  const [commit, setCommit] = useState('0');
  // Scripts adicionais
  const [before, setBefore] = useState('');
  const [after, setAfter] = useState('');
  /** Triggers das tabelas que vão mudar (o script apaga e cria de novo); null: ainda lendo */
  const [triggers, setTriggers] = useState<Trigger[] | null>(null);
  const [erroTriggers, setErroTriggers] = useState('');
  // Execução
  const [ocupado, setOcupado] = useState(false);
  const [status, setStatus] = useState('');
  const [pct, setPct] = useState(0);
  const ctl = useRef<AbortController | null>(null);

  useEffect(() => {
    const o = newSyncOptions(ins, upd, del);
    loadTriggers(
      alvo,
      db,
      diffs.filter((d) => changes(o, d) > 0).map((d) => d.table),
    ).then(setTriggers, (e) => {
      setErroTriggers(mensagemDe(e));
      setTriggers([]);
    });
    // Só ao abrir, como no construtor do desktop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Texto de andamento; depois do Cancelar fica o "Cancelando..." */
  const andamento = (texto: string) => {
    if (!ctl.current?.signal.aborted) setStatus(texto);
  };

  const temTriggers = (triggers?.length ?? 0) > 0;
  const nomesTriggers = (triggers ?? []).map((t) => t.name).join(', ');

  const opcoes = (): SyncOptions => ({
    ...newSyncOptions(ins, upd, del),
    useDb,
    noFks,
    comments,
    commitEvery: Number(commit.replace(/\D/g, '')) || 0,
    before,
    after,
    triggers: noTriggers ? (triggers ?? []) : [],
  });

  /** Nome sugerido do arquivo, com a data e a hora antes da extensão se pedido. */
  const targetFile = (): string => {
    const r = arquivo.trim();
    if (!stamp || r === '') return r;
    const p = r.lastIndexOf('.');
    return p < 0 ? r + carimbo() : r.slice(0, p) + carimbo() + r.slice(p);
  };

  /** Plano de ações na ordem do script, e avisos. */
  const summary = (): string => {
    const o = opcoes();
    const l: string[] = [];
    const w: string[] = [];
    let n = 0;
    const step = (texto: string) => l.push(`  ${++n}. ${texto}`);

    l.push('Destino: ' + db + info);
    l.push('Saída: ' + SAIDAS[saida]);
    if (saida === 1) l.push('Arquivo: ' + targetFile());
    l.push('', 'PLANO DE AÇÕES', '');
    if (o.before.trim() !== '') step('Rodar o script do usuário (antes)');
    if (o.triggers.length > 0) step(`Apagar ${o.triggers.length} trigger(s): ${o.triggers.map((t) => t.name).join(', ')}`);
    if (o.noFks) step('Desligar as chaves estrangeiras');
    if (o.commitEvery > 0) step(`Alterar os dados, com COMMIT a cada ${milhar(o.commitEvery)} comandos:`);
    else step('Alterar os dados numa transação só (tudo ou nada):');
    let skipped = 0;
    for (const d of diffs) {
      if (!o.del) skipped += d.delCount;
      if (changes(o, d) === 0) continue;
      const s: string[] = [];
      if (o.del && d.delCount > 0) s.push('excluir ' + milhar(d.delCount));
      if (o.upd && d.updCount > 0) s.push('atualizar ' + milhar(d.updCount));
      if (o.ins && d.insCount > 0) s.push('inserir ' + milhar(d.insCount));
      l.push(`       ${d.table}: ${s.join(', ')} linha(s)`);
    }
    if (o.noFks) step('Ligar as chaves estrangeiras de novo');
    if (o.triggers.length > 0) step('Criar de novo os triggers');
    if (o.after.trim() !== '') step('Rodar o script do usuário (depois)');

    if (cx?.ambiente === 3) w.push('O destino é uma conexão de PRODUÇÃO.');
    if (skipped > 0) w.push(milhar(skipped) + ' linha(s) que só existem no destino continuam lá: "Excluir" está desmarcado na comparação.');
    if (o.triggers.length > 0)
      w.push(
        'Os triggers são apagados e criados de novo com o mesmo DEFINER: o usuário da conexão precisa poder criar ' +
          'trigger com esse DEFINER (SUPER ou SET_USER_ID quando é outro usuário). Executando direto no destino, se der ' +
          'erro ou for cancelado, os que faltarem são criados de novo.',
      );
    if (erroTriggers !== '') w.push(`Não deu para ler os triggers do destino (${erroTriggers}): se houver, eles disparam durante a sincronização.`);
    else if (temTriggers && o.triggers.length === 0) w.push('Os triggers ficam ligados e disparam a cada linha alterada.');
    if (!o.noFks) w.push('Com as chaves estrangeiras ligadas, a ordem das tabelas (alfabética) pode dar erro de chave.');
    if (o.commitEvery > 0) w.push(`Com COMMIT a cada ${milhar(o.commitEvery)} comandos, se der erro no meio, o que já teve COMMIT fica no destino.`);
    if (!o.useDb && saida < 2) w.push('Sem USE: rode o script já conectado no banco de destino.');
    l.push('', 'AVISOS', '');
    if (w.length === 0) l.push('  Nenhum.');
    for (const s of w) l.push('  - ' + s);
    return l.join('\n');
  };

  const mostrarPagina = (i: number) => {
    if (i === 3) setResumo(summary());
    setPagina(i);
  };

  /** O script inteiro (ou até limit bytes) na memória; false no lugar das partes: passou do limite. */
  const gerar = async (o: SyncOptions, limit: number, sinal?: AbortSignal): Promise<string[] | false> => {
    const partes: string[] = [];
    const completo = await writeDataScript(
      {
        escrever: (t) => {
          partes.push(t);
        },
      },
      header,
      db,
      diffs,
      o,
      limit,
      { progresso: (t) => andamento('Gerando o script... ' + t), sinal },
    );
    return completo && partes;
  };

  /**
   * Roda no destino. Erro ou cancelamento: o que não teve COMMIT é desfeito (o runScript encerra a conexão do
   * script) e os triggers que o script apagou voltam. Devolve false se não concluiu (já avisado).
   */
  const execute = async (o: SyncOptions, script: Blob, sinal: AbortSignal): Promise<boolean> => {
    try {
      let ultimo = -1;
      await runScript(alvo, script, {
        progresso: (lidos, total) => {
          const p = Math.min(100, Math.floor((lidos * 100) / Math.max(total, 1)));
          if (p === ultimo) return;
          ultimo = p;
          setPct(p);
          andamento(`Executando no destino: ${p}%`);
        },
        sinal,
      });
      return true;
    } catch (e) {
      let msg = sinal.aborted ? 'Sincronização cancelada.' : 'Erro na sincronização:\n\n' + mensagemDe(e);
      msg += '\n\nO que não teve COMMIT foi desfeito.';
      if (o.triggers.length > 0)
        try {
          await restoreTriggers(alvo, db, o.triggers);
        } catch (e2) {
          const nome = `triggers_${db}${carimbo()}.sql`;
          baixar(nome, triggersOn(o.triggers, true)); // sem BOM, como os scripts
          msg += `\n\nOs triggers não foram criados de novo (${mensagemDe(e2)}). O CREATE deles foi baixado no arquivo:\n${nome}`;
        }
      if (sinal.aborted) avisar.alerta(msg);
      else avisar.erro(msg);
      return false;
    }
  };

  const sincronizar = async () => {
    if (ocupado || triggers === null) return;
    const o = opcoes();
    let gravador: Gravador | null = null;
    if (saida === 1) {
      const nome = targetFile();
      if (nome === '') {
        avisar.alerta('Informe o arquivo.');
        mostrarPagina(0);
        return;
      }
      try {
        gravador = await criarArquivo(nome, ARQ_SQL);
      } catch (e) {
        avisar.erro(e);
        return;
      }
      if (!gravador) return;
    } else if (saida === 2) {
      const ok = await confirmar({
        titulo: 'Sincronizar o destino?',
        mensagem:
          `Sincronizar o banco de destino "${db}"?\nEssa operação altera o destino.` +
          (cx?.ambiente === 3 ? '\n\nATENÇÃO: o destino é uma conexão de PRODUÇÃO.' : ''),
        confirmar: 'Sincronizar',
        tom: 'normal',
      });
      if (!ok) return;
    }

    const c = new AbortController();
    ctl.current = c;
    setOcupado(true);
    setPct(0);
    setStatus('Gerando o script...');
    let resultado = '';
    let recomparar = false;
    try {
      if (saida === 0) {
        const partes = await gerar(o, EDITOR_LIMIT);
        if (!partes) {
          avisar.alerta('O script passa de 5 MB, grande demais para o editor de consulta.\nSalve em arquivo ou execute direto no destino.');
          return;
        }
        app.abrirConsulta(alvo.conexao, db, partes.join(''));
        onFechar('Script aberto numa aba de consulta.', false);
        return;
      }
      if (gravador) {
        try {
          await writeDataScript(gravador, header, db, diffs, o, 0, { progresso: (t) => andamento('Gerando o script... ' + t), sinal: c.signal });
          await gravador.fechar();
        } catch (e) {
          await gravador.cancelar().catch(() => {}); // não deixa arquivo pela metade
          throw e;
        }
        resultado = 'Script salvo em ' + gravador.nome;
      } else {
        const partes = await gerar(o, 0, c.signal);
        // ponytail: o script inteiro fica na memória (como as listas do TableDiff); de GB, só salvando em arquivo
        if (!partes || !(await execute(o, new Blob(partes), c.signal))) return;
        recomparar = again;
        resultado = 'Sincronização concluída.' + (recomparar ? '' : ' Compare de novo para conferir.');
      }
    } catch (e) {
      // Cancelado enquanto gerava: nada foi executado nem gravado
      if (!c.signal.aborted) avisar.erro(e);
      return;
    } finally {
      setOcupado(false);
      setStatus('');
    }
    avisar.sucesso(resultado);
    onFechar(resultado, recomparar);
  };

  const fechar = () => {
    if (ocupado) {
      ctl.current?.abort(); // o runScript vê no próximo lote do script
      setStatus('Cancelando...');
    } else onFechar('', false);
  };

  return (
    <Dialogo
      titulo="Sincronizar dados"
      subtitulo={`Destino: ${db}${info}. Escolha a saída e as opções e clique em Sincronizar.`}
      largura={820}
      altura={480}
      onFechar={fechar}
      travado={ocupado}
      rodape={
        <>
          <div className="mr-auto min-w-0 flex items-center gap-2 text-xs text-texto2">
            {ocupado && <progress value={pct} max={100} className="w-48 shrink-0" />}
            <span className="truncate">{status}</span>
          </div>
          <Botao onClick={() => mostrarPagina(pagina - 1)} disabled={pagina === 0 || ocupado}>
            {'< Voltar'}
          </Botao>
          <Botao onClick={() => mostrarPagina(pagina + 1)} disabled={pagina === PAGINAS.length - 1 || ocupado}>
            {'Avançar >'}
          </Botao>
          <Botao tom="primario" onClick={() => void sincronizar()} disabled={ocupado || triggers === null}>
            Sincronizar
          </Botao>
          <Botao onClick={fechar}>{ocupado ? 'Cancelar' : 'Fechar'}</Botao>
        </>
      }
    >
      <div className="flex-1 min-h-0 flex">
        <div className="w-[170px] shrink-0 flex flex-col gap-0.5 p-1 border-r border-borda">
          {PAGINAS.map((nome, i) => (
            <button
              key={nome}
              type="button"
              disabled={ocupado}
              onClick={() => mostrarPagina(i)}
              className={`h-7.5 px-2 rounded text-left text-xs cursor-pointer disabled:cursor-default ${i === pagina ? 'bg-selecao font-semibold' : 'hover:bg-fundo3'}`}
            >
              {nome}
            </button>
          ))}
        </div>
        {/* Em execução, as páginas ficam travadas */}
        <fieldset disabled={ocupado} className="flex-1 min-w-0 min-h-0 flex flex-col overflow-auto">
          {pagina === 0 && (
            <>
              <LinhaCampo rotulo="Saída:" larguraRotulo={ROTULO}>
                <select value={saida} onChange={(e) => setSaida(Number(e.target.value))} className={`${CAMPO} w-75`}>
                  {SAIDAS.map((s, i) => (
                    <option key={s} value={i}>
                      {s}
                    </option>
                  ))}
                </select>
              </LinhaCampo>
              <LinhaCampo rotulo="Arquivo:" larguraRotulo={ROTULO} dica="Nome sugerido: a pasta é escolhida ao clicar em Sincronizar">
                <input value={arquivo} onChange={(e) => setArquivo(e.target.value)} disabled={saida !== 1} className={`${CAMPO} flex-1`} />
              </LinhaCampo>
              <LinhaCampo rotulo="Data e hora no nome do arquivo:" larguraRotulo={ROTULO}>
                <Toggle checked={stamp} onChange={setStamp} disabled={saida !== 1} />
              </LinhaCampo>
              <LinhaCampo rotulo="Comparar de novo depois:" larguraRotulo={ROTULO}>
                <Toggle checked={again} onChange={setAgain} disabled={saida !== 2} />
                <span className="text-xs text-texto2">depois de executar no destino</span>
              </LinhaCampo>
            </>
          )}
          {pagina === 1 && (
            <>
              <LinhaCampo rotulo="Incluir USE do banco:" larguraRotulo={ROTULO}>
                <Toggle checked={useDb} onChange={setUseDb} />
                <span className="text-xs text-texto2">USE {q(db)}; no começo do script</span>
              </LinhaCampo>
              <LinhaCampo rotulo="Desligar chaves estrangeiras:" larguraRotulo={ROTULO}>
                <Toggle checked={noFks} onChange={setNoFks} />
                <span className="text-xs text-texto2">FOREIGN_KEY_CHECKS = 0 durante a sincronização</span>
              </LinhaCampo>
              <LinhaCampo rotulo="Desligar triggers:" larguraRotulo={ROTULO}>
                <Toggle checked={noTriggers && temTriggers} onChange={setNoTriggers} disabled={!temTriggers} />
                <span className="min-w-0 truncate text-xs text-texto2" title={nomesTriggers}>
                  {triggers === null
                    ? 'lendo os triggers...'
                    : erroTriggers !== ''
                      ? 'não deu para ler os triggers: ' + erroTriggers
                      : temTriggers
                        ? 'apaga e cria de novo: ' + nomesTriggers
                        : 'nenhum trigger nas tabelas alteradas'}
                </span>
              </LinhaCampo>
              <LinhaCampo rotulo="Comentários no script:" larguraRotulo={ROTULO}>
                <Toggle checked={comments} onChange={setComments} />
              </LinhaCampo>
              <LinhaCampo rotulo="COMMIT a cada:" larguraRotulo={ROTULO}>
                {/* Inteiro no padrão de app bancário: só dígitos, com separador de milhar. */}
                <input
                  value={commit}
                  onChange={(e) => setCommit(milhar(Number(e.target.value.replace(/\D/g, '').slice(0, 9))))}
                  inputMode="numeric"
                  className={`${CAMPO} w-20 text-right`}
                />
                <span className="text-xs text-texto2">comandos (0 = uma transação só: tudo ou nada)</span>
              </LinhaCampo>
            </>
          )}
          {pagina === 2 && (
            <div className="flex-1 min-h-0 flex flex-col px-3 pb-3">
              <span className="py-2 text-xs text-texto2">Antes da sincronização (roda no destino, logo depois do USE):</span>
              <textarea value={before} onChange={(e) => setBefore(e.target.value)} wrap="off" spellCheck={false} className={`${MEMO} h-40 shrink-0`} />
              <span className="py-2 text-xs text-texto2">Depois da sincronização (no fim do script):</span>
              <textarea value={after} onChange={(e) => setAfter(e.target.value)} wrap="off" spellCheck={false} className={`${MEMO} flex-1`} />
            </div>
          )}
          {pagina === 3 && <pre className="flex-1 min-h-0 overflow-auto p-3 font-sans text-xs text-texto whitespace-pre-wrap">{resumo}</pre>}
        </fieldset>
      </div>
    </Dialogo>
  );
};
