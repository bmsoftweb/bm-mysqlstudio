// Diálogos de backup/restauração (o TfrmBackup) e de importação de CSV (o TfrmImport) do uBackup.pas.
// A lógica fica em lib\backup.ts.
import React, { useEffect, useRef, useState } from 'react';
import { Conexao, linhas, rodar } from '../lib/api';
import { ARQ_SQL, Gravador, SQL_BANCOS, criarArquivo, escolherArquivo, q } from '../lib/db';
import { dumpDb, importCsv, runScript } from '../lib/backup';
import { avisar, confirmar } from '../lib/avisos';
import { COR_AMBIENTE, useApp } from '../app/contexto';
import { Botao, CAMPO, Dialogo, LinhaCampo } from './ui';
import { Toggle } from './Toggle';

const ROTULO = 190; // cabe "Criar o banco se não existir:" (o SheetCol do Pascal)

/** aaaammdd_hhnn na hora local, para o nome sugerido do backup. */
function carimbo(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

const cancelado = (e: unknown) => (e as Error).name === 'AbortError';

/** Linha "Arquivo:" de quem abre um arquivo: o nome escolhido e o botão "..." (o navegador não mostra a pasta). */
const LinhaArquivo: React.FC<{ arquivo: File | null; extensoes: string; onEscolher: (f: File) => void }> = ({ arquivo, extensoes, onEscolher }) => {
  const escolher = async () => {
    const f = await escolherArquivo(extensoes);
    if (f) onEscolher(f);
  };
  return (
    <LinhaCampo rotulo="Arquivo:" larguraRotulo={ROTULO}>
      <input readOnly required value={arquivo?.name ?? ''} placeholder="Clique para escolher o arquivo" onClick={escolher} className={`${CAMPO} flex-1 cursor-pointer`} />
      <Botao onClick={escolher} title="Escolher o arquivo">
        ...
      </Botao>
    </LinhaCampo>
  );
};

/** Rodapé dos dois diálogos: andamento à esquerda; durante a operação, Fechar dá lugar a Cancelar. */
const Rodape: React.FC<{ status: string; acao: string; ocupado: boolean; onCancelar: () => void; onFechar: () => void }> = ({ status, acao, ocupado, onCancelar, onFechar }) => (
  <>
    <span className="mr-auto min-w-0 truncate text-xs text-texto2" title={status}>
      {status}
    </span>
    <Botao tom="primario" type="submit" ocupado={ocupado}>
      {acao}
    </Botao>
    {ocupado ? <Botao onClick={onCancelar}>Cancelar</Botao> : <Botao onClick={onFechar}>Fechar</Botao>}
  </>
);

/** Backup do banco em .sql, ou (restaurar) execução de um .sql no banco escolhido. */
export const DialogoBackup: React.FC<{ conexao: Conexao; banco: string; restaurar: boolean; onFechar: () => void }> = ({ conexao, banco, restaurar, onFechar }) => {
  const app = useApp();
  const [bancos, setBancos] = useState<string[]>([]);
  const [db, setDb] = useState(banco);
  /** Backup: nome digitado; null = o sugerido (banco_data_hora.sql) */
  const [nomeDigitado, setNomeDigitado] = useState<string | null>(null);
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [estrutura, setEstrutura] = useState(true);
  const [dados, setDados] = useState(true);
  const [objetos, setObjetos] = useState(true);
  const [criarBanco, setCriarBanco] = useState(true);
  const [status, setStatus] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const cancelar = useRef<AbortController | null>(null);
  const [aberto] = useState(carimbo);
  const nomeArquivo = nomeDigitado ?? (db.trim() ? `${db.trim()}_${aberto}.sql` : '');

  useEffect(() => {
    linhas({ conexao: conexao.id }, SQL_BANCOS).then((l) => {
      const nomes = l.map((r) => r[0]);
      setBancos(nomes);
      // No backup só vale banco que existe (na restauração pode digitar um novo)
      if (!restaurar) setDb((atual) => (nomes.includes(atual) ? atual : ''));
    }, avisar.erro);
  }, [conexao.id, restaurar]);

  const iniciar = async () => {
    if (ocupado) return;
    const nomeDb = db.trim();
    if (!nomeDb) return avisar.alerta('Escolha o banco.');
    if (restaurar ? !arquivo : !nomeArquivo.trim()) return avisar.alerta('Informe o arquivo.');
    const oQue = `${restaurar ? 'Restauração' : 'Backup'} de ${nomeDb}`;
    let gravador: Gravador | null = null;
    try {
      if (restaurar && arquivo) {
        const producao = conexao.ambiente === 3;
        const confirmou = await confirmar({
          titulo: 'Restaurar backup',
          mensagem: (
            <>
              {`Restaurar "${arquivo.name}" no banco "${nomeDb}" de ${conexao.nome} (${conexao.servidor})?\nTabelas e objetos com o mesmo nome são substituídos.`}
              {producao && <div className={`mt-2 ${COR_AMBIENTE[3]}`}>Atenção: esta conexão é de PRODUÇÃO.</div>}
            </>
          ),
          confirmar: 'Restaurar',
          tom: producao ? 'perigo' : 'normal',
        });
        if (!confirmou) return;
      } else {
        // O navegador pergunta se substitui o arquivo que já existe
        gravador = await criarArquivo(nomeArquivo.trim(), ARQ_SQL);
        if (!gravador) return;
      }
      const destino = gravador?.nome ?? arquivo?.name ?? '';
      const ctl = new AbortController();
      cancelar.current = ctl;
      setOcupado(true);
      setStatus(restaurar ? 'Restaurando...' : 'Gerando...');
      try {
        if (gravador) {
          await dumpDb({ conexao: conexao.id, banco: nomeDb }, nomeDb, gravador, { estrutura, dados, objetos }, { progresso: setStatus, sinal: ctl.signal });
          await gravador.fechar();
        } else if (arquivo) {
          if (criarBanco) await rodar({ conexao: conexao.id }, `CREATE DATABASE IF NOT EXISTS ${q(nomeDb)}`);
          await runScript({ conexao: conexao.id, banco: nomeDb }, arquivo, {
            progresso: (lidos, total) => setStatus(`Restaurando... ${total > 0 ? Math.floor((lidos * 100) / total) : 100}%`),
            sinal: ctl.signal,
          });
        }
        setStatus('Concluído: ' + destino);
        app.log(`${oQue} concluído(a): ${destino}`);
      } finally {
        setOcupado(false);
      }
    } catch (e) {
      await gravador?.cancelar().catch(() => {});
      if (cancelado(e)) {
        setStatus('Cancelado.');
        app.log(`${oQue}: cancelado(a) pelo usuário.`);
      } else {
        setStatus('Erro.');
        app.log(`${oQue}: ERRO ${e instanceof Error ? e.message : String(e)}`);
        avisar.erro(e);
      }
    }
  };

  return (
    <Dialogo
      titulo={`${restaurar ? 'Restaurar backup' : 'Backup do banco'} - ${conexao.nome}`}
      subtitulo={
        restaurar
          ? 'Executa um arquivo .sql no banco escolhido. Objetos com o mesmo nome são substituídos.'
          : 'Gera um arquivo .sql com a estrutura e os dados, para restaurar aqui ou no cliente mysql.'
      }
      largura={560}
      onFechar={onFechar}
      onEnviar={iniciar}
      travado={ocupado}
      rodape={<Rodape status={status} acao={restaurar ? 'Restaurar' : 'Iniciar'} ocupado={ocupado} onCancelar={() => cancelar.current?.abort()} onFechar={onFechar} />}
    >
      <fieldset disabled={ocupado} className="min-w-0">
        <LinhaCampo rotulo="Banco:" larguraRotulo={ROTULO}>
          {restaurar ? (
            <>
              <input value={db} onChange={(e) => setDb(e.target.value)} list="backup-bancos" required className={`${CAMPO} w-72`} />
              <datalist id="backup-bancos">
                {bancos.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </>
          ) : (
            <select value={db} onChange={(e) => setDb(e.target.value)} required className={`${CAMPO} w-72`}>
              {!bancos.includes(db) && <option value={db}>{db}</option>}
              {bancos.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          )}
        </LinhaCampo>
        {restaurar ? (
          <>
            <LinhaArquivo arquivo={arquivo} extensoes=".sql" onEscolher={setArquivo} />
            <LinhaCampo rotulo="Criar o banco se não existir:" larguraRotulo={ROTULO}>
              <Toggle checked={criarBanco} onChange={setCriarBanco} />
            </LinhaCampo>
          </>
        ) : (
          <>
            <LinhaCampo rotulo="Arquivo:" larguraRotulo={ROTULO} dica="A pasta é escolhida ao clicar em Iniciar.">
              <input value={nomeArquivo} onChange={(e) => setNomeDigitado(e.target.value)} required className={`${CAMPO} flex-1`} />
            </LinhaCampo>
            <LinhaCampo rotulo="Estrutura das tabelas:" larguraRotulo={ROTULO}>
              <Toggle checked={estrutura} onChange={setEstrutura} />
            </LinhaCampo>
            <LinhaCampo rotulo="Dados (INSERT):" larguraRotulo={ROTULO}>
              <Toggle checked={dados} onChange={setDados} />
            </LinhaCampo>
            <LinhaCampo rotulo="Views, rotinas e triggers:" larguraRotulo={ROTULO}>
              <Toggle checked={objetos} onChange={setObjetos} />
            </LinhaCampo>
          </>
        )}
      </fieldset>
    </Dialogo>
  );
};

/** Importação de um CSV (";", UTF-8) para a tabela. */
export const DialogoImportar: React.FC<{ conexao: Conexao; banco: string; tabela: string; onFechar: () => void }> = ({ conexao, banco, tabela, onFechar }) => {
  const app = useApp();
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [cabecalho, setCabecalho] = useState(true);
  const [status, setStatus] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const cancelar = useRef<AbortController | null>(null);

  const importar = async () => {
    if (ocupado) return;
    if (!arquivo) return avisar.alerta('Informe o arquivo.');
    const ctl = new AbortController();
    cancelar.current = ctl;
    setOcupado(true);
    setStatus('Importando...');
    try {
      const n = await importCsv({ conexao: conexao.id }, banco, tabela, arquivo, cabecalho, { progresso: setStatus, sinal: ctl.signal });
      setStatus(`${n} linha(s) importada(s).`);
      app.log(`${banco}.${tabela}: ${n} linha(s) importada(s) de ${arquivo.name}`);
    } catch (e) {
      setStatus(cancelado(e) ? 'Nada importado (cancelado).' : 'Nada importado (erro).');
      if (!cancelado(e)) avisar.erro(e);
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Dialogo
      titulo={`Importar dados (CSV) - ${conexao.nome}`}
      subtitulo={'Arquivo separado por ";" (UTF-8), como o exportado pelo MySQL Studio.'}
      largura={560}
      onFechar={onFechar}
      onEnviar={importar}
      travado={ocupado}
      rodape={<Rodape status={status} acao="Importar" ocupado={ocupado} onCancelar={() => cancelar.current?.abort()} onFechar={onFechar} />}
    >
      <fieldset disabled={ocupado} className="min-w-0">
        <LinhaCampo rotulo="Tabela:" larguraRotulo={ROTULO}>
          <span className="text-xs font-bold text-texto">
            {banco}.{tabela}
          </span>
        </LinhaCampo>
        <LinhaArquivo arquivo={arquivo} extensoes=".csv,.txt" onEscolher={setArquivo} />
        <LinhaCampo rotulo="Cabeçalho na 1ª linha:" larguraRotulo={ROTULO}>
          <Toggle checked={cabecalho} onChange={setCabecalho} />
        </LinhaCampo>
      </fieldset>
    </Dialogo>
  );
};
