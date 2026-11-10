/**
 * Grade de um resultado de consulta (Conjunto): monta as colunas a partir dos campos (tipo embaixo do nome,
 * datas centralizadas em dd/mm/aaaa, números à direita) e, se houver texto longo ou blob, mostra embaixo o painel
 * do campo (o TFieldPanel do desktop), onde eles são vistos e editados.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Campo, Conjunto, Valor } from '../lib/api';
import { baixar, bytesDe, bytesParaBase64, ehBinario, ehData, ehDataHora, ehGrande, ehNumero, ehTextoLongo, escolherArquivo, milhar, tipoBlob, tipoTexto, TIPO } from '../lib/db';
import { avisar, confirmar } from '../lib/avisos';
import { ColunaGrade, Grade, GradeApi, GradeProps } from './Grade';
import { Botao, Divisor, useTamanho } from './ui';

/** Campo que não cabe na célula: visto e editado no painel embaixo da grade */
export const ehDePainel = (c: Campo) => ehBinario(c) || ehTextoLongo(c);

function larguraDe(c: Campo): number {
  if (ehDePainel(c)) return 200;
  if (ehData(c)) return 100;
  if (ehDataHora(c)) return 150;
  if (c.tipo === TIPO.TIME) return 90;
  // ponytail: estimativa pelo tamanho declarado (bytes do utf8mb4 / 4 = letras); duplo clique na divisória ajusta ao conteúdo
  const letras = ehNumero(c) ? Math.min(c.tamanho, 14) : Math.floor(c.tamanho / 4);
  return Math.min(300, Math.max(60, Math.max(letras, c.nome.length) * 7 + 22));
}

export function colunasDoConjunto(campos: Campo[], extra?: (campo: Campo, i: number) => Partial<ColunaGrade> | undefined): ColunaGrade[] {
  return campos.map((c, i) => ({
    titulo: c.nome,
    subtitulo: tipoTexto(c),
    largura: larguraDe(c),
    alinhar: ehNumero(c) ? 'dir' : ehData(c) || ehDataHora(c) ? 'centro' : 'esq',
    editor: ehDePainel(c) ? 'nenhum' : ehData(c) ? 'data' : ehDataHora(c) ? 'datahora' : 'texto',
    ...extra?.(c, i),
  }));
}

interface GradeConjuntoProps extends Omit<GradeProps, 'colunas' | 'linhas'> {
  conjunto: Conjunto;
  /** Ajuste por coluna (ex.: ENUM vira lista) */
  extra?: (campo: Campo, i: number) => Partial<ColunaGrade> | undefined;
  refGrade?: React.Ref<GradeApi>;
  /** Busca o valor que não veio por ser grande (para Salvar... no painel) */
  lerGrande?: (linha: number, coluna: number) => Promise<Uint8Array>;
}

export const GradeConjunto: React.FC<GradeConjuntoProps> = ({ conjunto, extra, refGrade, lerGrande, onFoco, ...resto }) => {
  const colunas = useMemo(() => colunasDoConjunto(conjunto.campos, extra), [conjunto.campos, extra]);
  const [foco, setFoco] = useState<{ l: number; c: number } | null>(null);
  // Coluna do painel: a focada, se for de painel; numa coluna comum, fica na última escolhida (ou na primeira que houver)
  const [colunaPainel, setColunaPainel] = useState(-1);
  const [altura, arrastar] = useTamanho(180, 80, -1);

  const primeira = conjunto.campos.findIndex(ehDePainel);
  const cPainel = colunaPainel >= 0 && conjunto.campos[colunaPainel] && ehDePainel(conjunto.campos[colunaPainel]) ? colunaPainel : primeira;
  const linha = foco && foco.l < conjunto.linhas.length ? foco.l : conjunto.linhas.length ? 0 : -1;

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col">
      <Grade
        ref={refGrade}
        colunas={colunas}
        linhas={conjunto.linhas}
        onFoco={(l, c) => {
          setFoco({ l, c });
          if (conjunto.campos[c] && ehDePainel(conjunto.campos[c])) setColunaPainel(c);
          onFoco?.(l, c);
        }}
        {...resto}
      />
      {cPainel >= 0 && (
        <>
          <Divisor aoArrastar={arrastar} />
          <div style={{ height: altura }} className="shrink-0 flex flex-col min-h-0">
            <PainelCampo
              key={`${linha}:${cPainel}`}
              campo={conjunto.campos[cPainel]}
              valor={linha >= 0 ? conjunto.linhas[linha][cPainel] : null}
              semLinha={linha < 0}
              editavel={Boolean(resto.editavel) && linha >= 0 && (resto.podeEditar ? resto.podeEditar(linha, cPainel) : true)}
              onAlterar={(v) => resto.onAlterar?.(linha, cPainel, v)}
              lerGrande={lerGrande && linha >= 0 ? () => lerGrande(linha, cPainel) : undefined}
            />
          </div>
        </>
      )}
    </div>
  );
};

// ==========================================================
// Painel do campo (texto longo e blob)
// ==========================================================
interface PainelCampoProps {
  campo: Campo;
  valor: Valor;
  semLinha?: boolean;
  editavel: boolean;
  onAlterar: (valor: Valor) => void;
  lerGrande?: () => Promise<Uint8Array>;
}

const EXTENSAO: Record<string, string> = { JPEG: 'jpg', PNG: 'png', GIF: 'gif', BMP: 'bmp', PDF: 'pdf', Binário: 'bin' };
const MIME: Record<string, string> = { JPEG: 'image/jpeg', PNG: 'image/png', GIF: 'image/gif', BMP: 'image/bmp' };

const PainelCampo: React.FC<PainelCampoProps> = ({ campo, valor, semLinha, editavel, onAlterar, lerGrande }) => {
  const blob = ehBinario(campo);
  const bytes = useMemo(() => (blob ? bytesDe(valor) : null), [blob, valor]);
  const tipo = bytes ? tipoBlob(bytes) : 'Binário';
  const [url, setUrl] = useState('');
  const [medidas, setMedidas] = useState('');
  // Texto: grava de volta com a mesma quebra de linha do banco
  const original = typeof valor === 'string' || typeof valor === 'number' ? String(valor) : '';
  const crlf = original.includes('\r');
  const [texto, setTexto] = useState(original.replace(/\r\n?/g, '\n'));
  const mudou = useRef(false);

  useEffect(() => {
    if (!bytes || !MIME[tipo]) return setUrl('');
    const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[tipo] }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [bytes, tipo]);

  let info = '';
  if (semLinha) info = '';
  else if (valor === null) info = '(null)';
  else if (ehGrande(valor)) info = `${milhar(valor.bytes ?? 0)} bytes (grande demais para mostrar aqui${lerGrande ? ': use Salvar...' : ''})`;
  else if (bytes) info = `${tipo} | ${milhar(bytes.length)} bytes${medidas}`;

  const gravarTexto = () => {
    if (!mudou.current) return;
    mudou.current = false;
    onAlterar(crlf ? texto.replace(/\n/g, '\r\n') : texto);
  };

  const carregar = async () => {
    const arq = await escolherArquivo('image/*,*/*');
    if (!arq) return;
    onAlterar({ bin: bytesParaBase64(new Uint8Array(await arq.arrayBuffer())) });
  };
  const salvar = async () => {
    try {
      const b = bytes ?? (lerGrande ? await lerGrande() : null);
      if (!b) return;
      const t = tipoBlob(b);
      baixar(`${campo.nome}.${EXTENSAO[t]}`, new Blob([b as BlobPart]));
    } catch (e) {
      avisar.erro(e);
    }
  };
  const limpar = async () => {
    if (await confirmar({ titulo: 'Limpar o campo?', mensagem: `Limpar o campo ${campo.nome} deste registro? Ele fica nulo; a alteração só é gravada ao Salvar.`, confirmar: 'Limpar' })) {
      onAlterar(null);
    }
  };

  return (
    <>
      <div className="shrink-0 flex items-center gap-2 px-2 py-1 border-b border-borda text-xs">
        <span className="flex-1 min-w-0 truncate">
          <b>{campo.nome}</b> <span className="text-texto2">({tipoTexto(campo)})</span>
          {info && <span className="text-texto2">: {info}</span>}
        </span>
        {blob && editavel && <Botao onClick={carregar}>Carregar...</Botao>}
        {blob && <Botao onClick={salvar} disabled={valor === null || (!bytes && !lerGrande)}>Salvar...</Botao>}
        {blob && editavel && <Botao onClick={limpar} disabled={valor === null}>Limpar</Botao>}
      </div>
      {blob ? (
        <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-1 bg-fundo">
          {url && (
            <img
              src={url}
              alt={campo.nome}
              onLoad={(e) => setMedidas(` | ${e.currentTarget.naturalWidth} x ${e.currentTarget.naturalHeight}`)}
              onError={() => setMedidas(' | imagem não pôde ser aberta')}
              className="max-w-full max-h-full object-contain"
            />
          )}
        </div>
      ) : (
        <textarea
          value={ehGrande(valor) ? '' : texto}
          readOnly={!editavel || ehGrande(valor)}
          onChange={(e) => {
            setTexto(e.target.value);
            mudou.current = true;
          }}
          onBlur={gravarTexto}
          spellCheck={false}
          className="sem-barra flex-1 min-h-0 resize-none p-2 bg-fundo text-xs font-mono text-texto outline-none"
        />
      )}
    </>
  );
};
