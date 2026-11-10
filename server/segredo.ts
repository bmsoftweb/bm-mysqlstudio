import crypto from 'crypto';

/**
 * Sem SESSION_SECRET, uma chave aleatória por processo: as sessões expiram a cada reinício e as senhas
 * salvas das conexões deixam de abrir (o app pede a senha de novo).
 */
export const SEGREDO =
  process.env.SESSION_SECRET ||
  (console.warn('SESSION_SECRET não definido: sessões e senhas salvas valem só até o servidor reiniciar.'),
  crypto.randomBytes(32).toString('hex'));

/** Senhas das conexões salvas, cifradas com AES-256-GCM (o DPAPI do app desktop). */
const chave = () => crypto.createHash('sha256').update(`mysqlstudio-conexoes:${SEGREDO}`).digest();

export function cifrar(texto: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chave(), iv);
  const dados = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), dados].map((b) => b.toString('base64')).join('.');
}

/** null quando não abre (SESSION_SECRET mudou): aí a senha é pedida de novo, como no Unprotect do desktop. */
export function decifrar(cifrado: string): string | null {
  try {
    const [iv, tag, dados] = cifrado.split('.').map((p) => Buffer.from(p, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', chave(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(dados), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
