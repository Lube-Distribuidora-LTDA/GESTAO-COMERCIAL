/**
 * /api/dados — entrega ao painel todo o conteúdo do BI COMERCIAL.
 *
 * O conteúdo vem PRONTO do banco, de `comercial.painel_servir(de, ate)`, que
 * lê a linha que o ETL guardou em `comercial.painel_cache` depois da última
 * carga (ver db/09-painel-cache.sql). Aqui é só encanamento.
 *
 * Esta rota não calcula nada: era o cálculo ao vivo que derrubava o painel
 * quando o banco ficava lento. A tela mostra a data da última carga, então
 * ninguém confunde dado guardado com dado de agora.
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
    // painel_servir, nao painel_dados: le o JSON que o ETL deixou pronto em
    // comercial.painel_cache. Calcular na hora levava 100 s com o banco lento
    // (14/10) e a Vercel corta em 60 — era o 504 que impedia o painel de abrir.
    // Só um período que ninguém pediu ainda cai no cálculo, e uma vez só.
    const r = await consultar("SELECT comercial.painel_servir($1::date, $2::date) AS painel", [de, ate]);
    const painel = r.rows[0] && r.rows[0].painel;
    if (!painel) throw new Error("A consulta não devolveu dados.");

    // O conteúdo agora vem pronto do banco, então o CDN é só a segunda camada.
    // O botão "Atualizar" do painel manda ?atualizar=<hora>, que é uma URL
    // diferente e passa direto pelo CDN até a linha guardada.
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=86400");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).send(JSON.stringify(painel));
  } catch (e) {
    responderErro(res, e, process.env.SUPABASE_DB_PORT);
  }
};
