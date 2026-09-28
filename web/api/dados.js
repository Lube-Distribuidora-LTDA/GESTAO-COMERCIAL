/**
 * /api/dados — entrega ao painel todo o conteúdo do BI COMERCIAL.
 *
 * Toda a consulta mora no banco, na função `comercial.painel_dados(de, ate)`
 * (ver db/02-views-e-funcoes.sql). Aqui é só encanamento: valida o período que
 * veio na URL, chama a função e devolve o JSON.
 *
 *   /api/dados                         → mês corrente
 *   /api/dados?de=2026-02-01&ate=2026-02-28
 */

const { consultar, faltandoVariaveis, dataOuNulo, responderErro } = require("./_db");

module.exports = async function handler(req, res) {
  const faltando = faltandoVariaveis();
  if (faltando.length) {
    res.status(500).json({
      erro: "configuracao_incompleta",
      mensagem:
        "Faltam variáveis de ambiente no projeto da Vercel: " + faltando.join(", ") +
        ". Cadastre em Settings › Environment Variables e publique de novo.",
    });
    return;
  }

  const de = dataOuNulo(req.query && req.query.de);
  const ate = dataOuNulo(req.query && req.query.ate);

  try {
    const r = await consultar("SELECT comercial.painel_dados($1::date, $2::date) AS painel", [de, ate]);
    const painel = r.rows[0] && r.rows[0].painel;
    if (!painel) throw new Error("A consulta não devolveu dados.");

    // O ETL roda 4x ao dia; guardar 10 minutos no CDN faz com que só o
    // primeiro acesso de cada janela toque o banco. O botão "Atualizar" do
    // painel manda ?atualizar=<hora>, que é uma URL diferente e ignora o cache.
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).send(JSON.stringify(painel));
  } catch (e) {
    responderErro(res, e, process.env.SUPABASE_DB_PORT);
  }
};
