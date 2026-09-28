/**
 * /api/detalhe — as listas que não cabem no payload do painel.
 *
 * Duas listas são grandes demais para viajar junto com o resto: as notas de um
 * RCA (a base tem 205 mil linhas) e os itens abaixo da margem (3,3 milhões).
 * Elas continuam saindo de uma função do banco — `comercial.painel_detalhe` —
 * e esta rota só repassa.
 *
 *   /api/detalhe?tipo=comissao_nf&de=2026-02-01&ate=2026-02-28&chave=123
 *   /api/detalhe?tipo=margem_item&de=...&ate=...&chave=5&limite=20000
 *   /api/detalhe?tipo=devolucao_rca&de=...&ate=...&chave=123
 */

const { consultar, faltandoVariaveis, dataOuNulo, responderErro } = require("./_db");

const TIPOS = ["comissao_nf", "margem_item", "devolucao_rca"];

module.exports = async function handler(req, res) {
  const faltando = faltandoVariaveis();
  if (faltando.length) {
    res.status(500).json({
      erro: "configuracao_incompleta",
      mensagem: "Faltam variáveis de ambiente no projeto da Vercel: " + faltando.join(", "),
    });
    return;
  }

  const q = req.query || {};
  const tipo = TIPOS.indexOf(String(q.tipo)) >= 0 ? String(q.tipo) : null;
  const de = dataOuNulo(q.de);
  const ate = dataOuNulo(q.ate);
  const chave = q.chave == null ? null : String(q.chave).slice(0, 32);
  const limite = Math.min(Math.max(parseInt(q.limite, 10) || 2000, 1), 20000);

  if (!tipo || !de || !ate) {
    res.status(400).json({
      erro: "parametros_invalidos",
      mensagem: "Informe tipo (" + TIPOS.join(", ") + "), de e ate no formato AAAA-MM-DD.",
    });
    return;
  }

  try {
    const r = await consultar(
      "SELECT comercial.painel_detalhe($1, $2::date, $3::date, $4, $5) AS detalhe",
      [tipo, de, ate, chave, limite]
    );
    const detalhe = r.rows[0] && r.rows[0].detalhe;
    if (!detalhe) throw new Error("A consulta não devolveu dados.");
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=1800");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).send(JSON.stringify(detalhe));
  } catch (e) {
    responderErro(res, e, process.env.SUPABASE_DB_PORT);
  }
};
