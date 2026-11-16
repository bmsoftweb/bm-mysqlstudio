/**
 * IA que escreve SQL (consulta, view, function, procedure) a partir de um pedido em português.
 *
 * O navegador lê a estrutura do banco uma vez (src/lib/ia.ts) e manda junto com cada pedido: aqui só se monta a
 * chamada ao Claude. A estrutura vai num bloco próprio do system, com cache: pedidos seguidos sobre o mesmo banco
 * (em até 5 minutos) pagam 10% por ela. Nada é executado: o SQL volta para o editor e o usuário revisa.
 */
import Anthropic from '@anthropic-ai/sdk';
import { Request, Response, Router } from 'express';

const MODELO = 'claude-opus-5-5';

const INSTRUCOES = `Você escreve SQL para MySQL dentro do MySQL Studio, uma ferramenta de administração de bancos usada por desenvolvedores de sistemas de gestão (ERP) no Brasil. O usuário descreve em português o que precisa e você devolve o SQL para ele revisar no editor: nada é executado sem que ele veja antes.

A estrutura do banco em uso vem logo abaixo: tabelas e views com as colunas (tipo, chaves, referências e comentários) e as rotinas que já existem. Use só tabelas e colunas que existem nela, com os nomes exatos. Quando o pedido depender de algo que a estrutura não mostra (por exemplo, qual valor de uma coluna de situação significa "cancelada", ou qual de duas tabelas parecidas é a certa), escolha a leitura mais provável pelos nomes e comentários e diga em "observacao" o que assumiu, para o usuário conferir. Se o pedido não puder ser atendido com essa estrutura, deixe "sql" vazio e explique em "observacao" o que falta.

Respeite a versão do servidor informada no cabeçalho da estrutura (CTE e funções de janela, por exemplo, só existem a partir do MySQL 8.0). Escreva SQL legível: palavras-chave em maiúsculas, uma cláusula por linha, apelidos curtos nas tabelas, crases só nos nomes que precisam. Valores monetários ficam em DECIMAL, nunca em ponto flutuante. Períodos relativos ("este mês", "hoje") usam as funções de data do MySQL e filtram por intervalo na própria coluna (coluna >= início AND coluna < fim), para o índice continuar valendo.

"observacao" é um texto curto em português para o usuário; fica vazio quando não há nada a avisar.`;

const CORPO_ROTINA =
  'Em "sql", só o corpo, de BEGIN a END, sem o cabeçalho CREATE e sem DELIMITER. Em "nome", um nome no padrão dos nomes do banco. ' +
  'Em "parametros", cada parâmetro com nome, tipo MySQL e modo. "acesso" e "deterministico" conforme o que o corpo faz; "comentario" é uma frase curta dizendo o que a rotina faz.';

/** O que pedir em cada tela */
const PEDIDOS: Record<string, string> = {
  sql: 'Escreva o SQL para o pedido abaixo. Em "sql", uma ou mais instruções, cada uma terminada em ";". Deixe "nome" vazio.',
  view: 'Escreva uma view para o pedido abaixo. Em "sql", só o SELECT da view, sem CREATE VIEW e sem ";" no fim. Em "nome", um nome para a view no padrão dos nomes do banco.',
  funcao: `Escreva uma function para o pedido abaixo. ${CORPO_ROTINA} Parâmetro de function é sempre IN. Em "retorno", o tipo devolvido.`,
  procedure: `Escreva uma procedure para o pedido abaixo. ${CORPO_ROTINA} Deixe "retorno" vazio.`,
};

const texto = { type: 'string' };
const objeto = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

const FORMATO_SQL = objeto({ nome: texto, sql: texto, observacao: texto });
const FORMATO_ROTINA = objeto({
  nome: texto,
  comentario: texto,
  parametros: { type: 'array', items: objeto({ nome: texto, tipo: texto, modo: { type: 'string', enum: ['IN', 'OUT', 'INOUT'] } }) },
  retorno: texto,
  deterministico: { type: 'boolean' },
  acesso: { type: 'string', enum: ['CONTAINS SQL', 'NO SQL', 'READS SQL DATA', 'MODIFIES SQL DATA'] },
  sql: texto,
  observacao: texto,
});

let cliente: Anthropic | undefined;

export function createIaRouter(): Router {
  const r = Router();

  /**
   * POST /api/ia { tipo: sql | view | funcao | procedure, pedido, estrutura, atual? }
   * -> { nome, sql, observacao } e, nas rotinas, também { comentario, parametros, retorno, deterministico, acesso }
   */
  r.post('/api/ia', async (req: Request, res: Response) => {
    const b = req.body || {};
    const tipo = String(b.tipo || '');
    const pedido = typeof b.pedido === 'string' ? b.pedido.trim() : '';
    const estrutura = typeof b.estrutura === 'string' ? b.estrutura : '';
    const atual = typeof b.atual === 'string' ? b.atual.trim() : '';
    if (!Object.hasOwn(PEDIDOS, tipo)) return res.status(400).json({ erro: 'Tipo de pedido inválido.' });
    if (!pedido) return res.status(400).json({ erro: 'Descreva o que você precisa.' });
    if (!estrutura) return res.status(400).json({ erro: 'A estrutura do banco não foi enviada.' });
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      return res.status(503).json({ erro: 'A IA não está configurada: falta a variável ANTHROPIC_API_KEY no servidor.' });
    }

    cliente ??= new Anthropic();
    // Em streaming: a resposta pode demorar (o modelo pensa antes) e a requisição não fica parada esperando
    const stream = cliente.beta.messages.stream({
      model: MODELO,
      max_tokens: 16000,
      // Se o modelo recusar o pedido por engano, a API refaz em outro modelo na mesma chamada
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: tipo === 'sql' || tipo === 'view' ? FORMATO_SQL : FORMATO_ROTINA } },
      system: [
        { type: 'text', text: INSTRUCOES },
        { type: 'text', text: estrutura, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        {
          role: 'user',
          content:
            PEDIDOS[tipo] +
            (atual ? `\n\nO que está no editor agora (o pedido pode ser uma alteração disto):\n<sql_atual>\n${atual}\n</sql_atual>` : '') +
            `\n\nPedido do usuário:\n${pedido}`,
        },
      ],
    });
    // O usuário fechou o diálogo: não gasta o resto da resposta
    res.on('close', () => {
      if (!res.writableEnded) stream.abort();
    });

    try {
      const m = await stream.finalMessage();
      if (m.stop_reason === 'refusal') return res.status(422).json({ erro: 'A IA recusou este pedido. Tente descrever de outra forma.' });
      if (m.stop_reason === 'max_tokens') return res.status(422).json({ erro: 'A resposta da IA ficou grande demais. Peça uma coisa de cada vez.' });
      const saida = m.content.find((c) => c.type === 'text');
      if (!saida || saida.type !== 'text') return res.status(502).json({ erro: 'A IA não devolveu resposta.' });
      res.json(JSON.parse(saida.text));
    } catch (e) {
      if (e instanceof Anthropic.APIUserAbortError) return; // o navegador já foi embora
      if (e instanceof Anthropic.AuthenticationError) return res.status(503).json({ erro: 'A chave da IA (ANTHROPIC_API_KEY) não foi aceita.' });
      if (e instanceof Anthropic.RateLimitError) return res.status(429).json({ erro: 'Limite de uso da IA atingido. Aguarde um pouco e tente de novo.' });
      if (e instanceof Anthropic.BadRequestError) return res.status(400).json({ erro: `A IA não aceitou o pedido: ${e.message}` });
      if (e instanceof Anthropic.APIError) return res.status(502).json({ erro: `Erro na IA: ${e.message}` });
      res.status(500).json({ erro: (e as Error).message });
    }
  });

  return r;
}
