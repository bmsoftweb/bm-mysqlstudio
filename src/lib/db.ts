/** Helpers de banco compartilhados (o uDb do app desktop): nomes, metadados, DDL, tipos, CSV e arquivos. */
import { Alvo, Campo, Valor, consulta, linhas } from './api';

/** Bancos do usuário, sem os de sistema do MySQL. */
export const SQL_BANCOS =
  "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') ORDER BY 1";

/** Nome entre crases: `nome` */
export const q = (nome: string) => '`' + nome.replace(/`/g, '``') + '`';

/** Texto como literal SQL: 'it''s'. A barra invertida é dobrada: supõe o sql_mode padrão, sem NO_BACKSLASH_ESCAPES. */
export const lit = (s: string) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";

/** "8.0.36" -> "8.0" */
export function versaoCurta(v: string): string {
  const p = v.split(/[.-]/);
  return p.length >= 2 ? `${p[0]}.${p[1]}` : v;
}

export const comBanco = (alvo: Alvo, banco: string): Alvo => ({ ...alvo, banco: banco || alvo.banco });

/** DDL do objeto (TABLE, VIEW, PROCEDURE, FUNCTION, TRIGGER); '' quando o usuário não tem permissão para ver. */
export async function getCreate(alvo: Alvo, tipo: string, banco: string, nome: string): Promise<string> {
  const c = await consulta(alvo, `SHOW CREATE ${tipo} ${q(banco)}.${q(nome)}`);
  // A coluna do DDL muda conforme o tipo ("Create Table", "Create Procedure", "SQL Original Statement"...)
  const coluna = tipo.toUpperCase() === 'TRIGGER' ? 'SQL Original Statement' : 'Create ' + tipo[0].toUpperCase() + tipo.slice(1).toLowerCase();
  const i = c.campos.findIndex((f) => f.nome === coluna);
  const v = i >= 0 ? c.linhas[0]?.[i] : null;
  return typeof v === 'string' ? v.replace(/\r\n?/g, '\n') : '';
}

/**
 * Chave id_app (varchar(25)) das tabelas BMsoft, como a trigger: data e hora local com milissegundos
 * (17 dígitos) + 8 dígitos aleatórios.
 */
export function novoIdApp(): string {
  const d = new Date();
  const p = (n: number, t = 2) => String(n).padStart(t, '0');
  const dataHora = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
  return dataHora + p(Math.floor(Math.random() * 99999999), 8);
}

/** Valores do column_type de um ENUM no information_schema: enum('a','b''c') -> [a, b'c]. */
export function valoresEnum(columnType: string): string[] {
  const r: string[] = [];
  let i = columnType.indexOf('(') + 1;
  while (i > 0 && i < columnType.length && columnType[i] === "'") {
    let s = '';
    i++;
    while (i < columnType.length) {
      if (columnType[i] !== "'") s += columnType[i++];
      else if (columnType[i + 1] === "'") {
        s += "'"; // aspa dobrada dentro do valor
        i += 2;
      } else break;
    }
    r.push(s);
    i += 2; // aspa de fechamento e a vírgula (ou o ")")
  }
  return r;
}

// ==========================================================
// Tipos do protocolo (Campo.tipo / Campo.flags)
// ==========================================================
export const TIPO = {
  DECIMAL: 0, TINY: 1, SHORT: 2, LONG: 3, FLOAT: 4, DOUBLE: 5, NULL: 6, TIMESTAMP: 7, LONGLONG: 8, INT24: 9, DATE: 10,
  TIME: 11, DATETIME: 12, YEAR: 13, VARCHAR: 15, BIT: 16, JSON: 245, NEWDECIMAL: 246, ENUM: 247, SET: 248,
  TINY_BLOB: 249, MEDIUM_BLOB: 250, LONG_BLOB: 251, BLOB: 252, VAR_STRING: 253, STRING: 254, GEOMETRY: 255,
} as const;

export const FLAG = { NOT_NULL: 1, PRI_KEY: 2, UNSIGNED: 32, BINARY: 128, ENUM: 256, AUTO_INCREMENT: 512, SET: 2048 } as const;

const BLOBS: number[] = [TIPO.TINY_BLOB, TIPO.MEDIUM_BLOB, TIPO.LONG_BLOB, TIPO.BLOB];
const NUMEROS: number[] = [TIPO.DECIMAL, TIPO.TINY, TIPO.SHORT, TIPO.LONG, TIPO.FLOAT, TIPO.DOUBLE, TIPO.LONGLONG, TIPO.INT24, TIPO.YEAR, TIPO.NEWDECIMAL, TIPO.BIT];

export const ehNumero = (c: Campo) => NUMEROS.includes(c.tipo);
export const ehData = (c: Campo) => c.tipo === TIPO.DATE;
export const ehDataHora = (c: Campo) => c.tipo === TIPO.DATETIME || c.tipo === TIPO.TIMESTAMP;
/** BLOB, BINARY, VARBINARY, GEOMETRY: o valor vem como { bin } */
export const ehBinario = (c: Campo) =>
  c.tipo === TIPO.GEOMETRY || (c.charset === 63 && (BLOBS.includes(c.tipo) || c.tipo === TIPO.VAR_STRING || c.tipo === TIPO.STRING || c.tipo === TIPO.VARCHAR));
/** TEXT e JSON: não cabem na célula, são vistos e editados no painel embaixo da grade */
export const ehTextoLongo = (c: Campo) => c.tipo === TIPO.JSON || (BLOBS.includes(c.tipo) && c.charset !== 63);

/** Tipo como no MySQL: VARCHAR(14), DECIMAL(15,2), INT... */
export function tipoTexto(c: Campo): string {
  const semSinal = (c.flags & FLAG.UNSIGNED) !== 0;
  // ponytail: tamanho de texto vem em bytes do utf8mb4 (4 por letra); conferir se a conexão usar outro charset
  const letras = Math.floor(c.tamanho / 4);
  switch (c.tipo) {
    case TIPO.TINY: return 'TINYINT';
    case TIPO.SHORT: return 'SMALLINT';
    case TIPO.LONG: return 'INT';
    case TIPO.INT24: return 'MEDIUMINT';
    case TIPO.LONGLONG: return 'BIGINT';
    case TIPO.FLOAT: return 'FLOAT';
    case TIPO.DOUBLE: return 'DOUBLE';
    case TIPO.DECIMAL:
    case TIPO.NEWDECIMAL: return `DECIMAL(${c.tamanho - (c.decimais > 0 ? 1 : 0) - (semSinal ? 0 : 1)},${c.decimais})`;
    case TIPO.TIMESTAMP: return 'TIMESTAMP';
    case TIPO.DATE: return 'DATE';
    case TIPO.TIME: return 'TIME';
    case TIPO.DATETIME: return 'DATETIME';
    case TIPO.YEAR: return 'YEAR';
    case TIPO.BIT: return `BIT(${c.tamanho})`;
    case TIPO.JSON: return 'JSON';
    case TIPO.GEOMETRY: return 'GEOMETRY';
    case TIPO.ENUM: return 'ENUM';
    case TIPO.SET: return 'SET';
    case TIPO.TINY_BLOB:
    case TIPO.MEDIUM_BLOB:
    case TIPO.LONG_BLOB:
    case TIPO.BLOB: return c.charset === 63 ? 'BLOB' : 'TEXT';
    case TIPO.VARCHAR:
    case TIPO.VAR_STRING: return c.charset === 63 ? `VARBINARY(${c.tamanho})` : `VARCHAR(${letras})`;
    case TIPO.STRING:
      if (c.flags & FLAG.ENUM) return 'ENUM';
      if (c.flags & FLAG.SET) return 'SET';
      return c.charset === 63 ? `BINARY(${c.tamanho})` : `CHAR(${letras})`;
    default: return '';
  }
}

// ==========================================================
// Binários
// ==========================================================
export function base64ParaBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const r = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) r[i] = s.charCodeAt(i);
  return r;
}

export function bytesParaBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function bytesParaHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s.toUpperCase();
}

/** Bytes de um valor binário que veio junto; null se for nulo ou grande demais (bin = null). */
export function bytesDe(v: Valor): Uint8Array | null {
  return v !== null && typeof v === 'object' && v.bin !== null ? base64ParaBytes(v.bin) : null;
}

/** Valor que não veio na resposta por ser grande demais: precisa do lerGrande. */
export const ehGrande = (v: Valor): v is { bin: null; bytes?: number } => v !== null && typeof v === 'object' && v.bin === null;

/**
 * Lê um valor grande (texto ou blob acima de 1 MB) em pedaços. expressao/origem: ex. lerGrande(alvo, '`foto`',
 * 'FROM `db`.`t` WHERE `id` = 5'). Devolve os bytes (de texto: em UTF-8).
 */
export async function lerGrande(alvo: Alvo, expressao: string, origem: string): Promise<Uint8Array> {
  const PEDACO = 700_000;
  const partes: Uint8Array[] = [];
  for (let pos = 1; ; pos += PEDACO) {
    const c = await consulta(alvo, `SELECT SUBSTRING(CAST(${expressao} AS BINARY), ${pos}, ${PEDACO}) ${origem}`);
    const b = bytesDe(c.linhas[0]?.[0] ?? null);
    if (!b || !b.length) break;
    partes.push(b);
    if (b.length < PEDACO) break;
  }
  const total = new Uint8Array(partes.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of partes) {
    total.set(p, o);
    o += p.length;
  }
  return total;
}

/** Formato de um blob pela assinatura dos primeiros bytes. */
export function tipoBlob(b: Uint8Array): 'JPEG' | 'PNG' | 'GIF' | 'BMP' | 'PDF' | 'Binário' {
  if (b.length < 4) return 'Binário';
  if (b[0] === 0xff && b[1] === 0xd8) return 'JPEG';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'PNG';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'GIF';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'BMP';
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'PDF';
  return 'Binário';
}

export const milhar = (n: number | bigint | string) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

// ==========================================================
// CSV no padrão BMsoft: ';', UTF-8 com BOM
// ==========================================================
export function celulaCsv(s: string): string {
  return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export const linhaCsv = (valores: string[]) => valores.map(celulaCsv).join(';') + '\r\n';

/** CSV com aspas duplas (e quebra de linha dentro delas); ignora o BOM e linhas vazias. */
export function lerCsv(s: string, sep = ';'): string[][] {
  const r: string[][] = [];
  let linha: string[] = [];
  let celula = '';
  let aspas = false;
  const fimCelula = () => {
    linha.push(celula);
    celula = '';
  };
  const fimLinha = () => {
    fimCelula();
    if (linha.length > 1 || linha[0] !== '') r.push(linha);
    linha = [];
  };
  for (let i = s.charCodeAt(0) === 0xfeff ? 1 : 0; i < s.length; i++) {
    const ch = s[i];
    if (aspas) {
      if (ch !== '"') celula += ch;
      else if (s[i + 1] === '"') {
        celula += '"';
        i++;
      } else aspas = false;
    } else if (ch === '"') aspas = true;
    else if (ch === sep) fimCelula();
    else if (ch === '\n') fimLinha();
    else if (ch !== '\r') celula += ch;
  }
  if (celula.length > 0 || linha.length > 0) fimLinha();
  return r;
}

// ==========================================================
// Arquivos (o navegador no lugar dos diálogos Abrir/Salvar)
// ==========================================================
interface TipoArquivo {
  descricao: string;
  /** ex.: { 'application/sql': ['.sql'] } */
  aceita: Record<string, string[]>;
}

export const ARQ_SQL: TipoArquivo = { descricao: 'SQL', aceita: { 'application/sql': ['.sql'] } };
export const ARQ_CSV: TipoArquivo = { descricao: 'CSV', aceita: { 'text/csv': ['.csv'] } };

/** Onde o arquivo vai sendo gravado: direto no disco (Chrome/Edge) ou na memória, baixado no fim. */
export interface Gravador {
  escrever(parte: string | Uint8Array): Promise<void>;
  /** Fecha e, sem acesso direto ao disco, dispara o download */
  fechar(): Promise<void>;
  /** Desiste: não deixa arquivo pela metade */
  cancelar(): Promise<void>;
  nome: string;
}

type JanelaComArquivos = Window & {
  showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle>;
};

/**
 * Escolhe onde salvar e devolve um gravador; null se o usuário cancelou. Com a File System Access API (Chrome,
 * Edge) grava direto no disco, sem limite de tamanho; nos outros navegadores junta na memória e baixa no fim.
 */
export async function criarArquivo(nomeSugerido: string, tipo: TipoArquivo): Promise<Gravador | null> {
  const w = window as JanelaComArquivos;
  if (w.showSaveFilePicker) {
    let handle: FileSystemFileHandle;
    try {
      handle = await w.showSaveFilePicker({ suggestedName: nomeSugerido, types: [{ description: tipo.descricao, accept: tipo.aceita }] });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null;
      throw e;
    }
    const saida = await handle.createWritable();
    return {
      nome: handle.name,
      escrever: (parte) => saida.write(parte as FileSystemWriteChunkType),
      fechar: () => saida.close(),
      cancelar: () => saida.abort(),
    };
  }
  // ponytail: sem acesso ao disco o arquivo inteiro fica na memória até o fim; backup de GB pede Chrome ou Edge
  const partes: BlobPart[] = [];
  return {
    nome: nomeSugerido,
    escrever: async (parte) => {
      partes.push(parte as BlobPart);
    },
    fechar: async () => baixar(nomeSugerido, new Blob(partes)),
    cancelar: async () => {},
  };
}

/** Download de um conteúdo pronto. */
export function baixar(nome: string, conteudo: Blob | string) {
  const blob = typeof conteudo === 'string' ? new Blob([conteudo], { type: 'text/plain;charset=utf-8' }) : conteudo;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Diálogo Abrir: o arquivo escolhido, ou null se cancelou. extensoes: ex. '.sql,.txt' */
export function escolherArquivo(extensoes: string): Promise<File | null> {
  return new Promise((resolver) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = extensoes;
    input.onchange = () => resolver(input.files?.[0] ?? null);
    input.oncancel = () => resolver(null);
    input.click();
  });
}

/** Exporta linhas (já como texto) para CSV. */
export async function exportarCsv(nomeSugerido: string, titulos: string[], dados: Iterable<string[]>): Promise<boolean> {
  const g = await criarArquivo(nomeSugerido, ARQ_CSV);
  if (!g) return false;
  try {
    let lote = '﻿' + linhaCsv(titulos);
    for (const l of dados) {
      lote += linhaCsv(l);
      if (lote.length > 1_000_000) {
        await g.escrever(lote);
        lote = '';
      }
    }
    await g.escrever(lote);
    await g.fechar();
    return true;
  } catch (e) {
    await g.cancelar();
    throw e;
  }
}

/** Colunas da chave primária, na ordem da chave. */
export async function colunasPk(alvo: Alvo, banco: string, tabela: string): Promise<string[]> {
  return (
    await linhas(
      alvo,
      "SELECT column_name FROM information_schema.key_column_usage WHERE table_schema = ? AND table_name = ? AND constraint_name = 'PRIMARY' ORDER BY ordinal_position",
      [banco, tabela],
    )
  ).map((l) => l[0]);
}
