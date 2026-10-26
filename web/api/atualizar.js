/**
 * /api/atualizar (POST) — o botão Atualizar pede ao AGENTE LUBE uma leitura do WinThor agora.
 *
 * A ponte é o próprio banco: agente.pedir_atualizacao() grava o pedido e avisa por NOTIFY;
 * o agente, na SRV-IA, escuta na conexão que já mantém aberta para fora, lê o WinThor na
 * hora (os fluxos comercial.*), refaz o JSON pronto do painel e responde no pedido
 * (agente.pedido). Nenhuma porta aberta na rede da Lube, e o painel nunca chega no Oracle.
 * O navegador acompanha por /api/versao?pedido=<id>.
 *
 * Dez cliques seguidos viram uma leitura só (o pedido aberto serve para todos). Com o agente
 * fora do ar (batimento com mais de 3 minutos), nada é pedido: a resposta diz isso e o
 * navegador cai no jeito antigo (buscar a última carga guardada no banco).
 */

const { consultar, faltandoVariaveis, responderErro } = require("./_db");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ erro: "metodo", mensagem: "Use POST." });
    return;
  }
  const faltando = faltandoVariaveis();
  if (faltando.length) {
    res.status(500).json({ erro: "configuracao_incompleta", mensagem: "Faltam variáveis de ambiente: " + faltando.join(", ") });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  try {
    let r;
    try {
      r = await consultar(
        `WITH a AS (SELECT max(visto_em) AS visto, bool_or(ligado) AS ligado FROM agente.batimento WHERE visto_em > now() - interval '3 minutes')
         SELECT a.visto, coalesce(a.ligado, false) AS ligado,
                CASE WHEN a.visto IS NOT NULL AND a.ligado THEN agente.pedir_atualizacao('comercial', 'painel central-comercial') END AS pedido
           FROM a`, []);
    } catch (e) {
      if (e && (e.code === "42P01" || e.code === "3F000" || e.code === "42883")) {
        res.status(200).json({ agente: false, mensagem: "O agente do WinThor ainda não foi instalado." });
        return;
      }
      throw e;
    }
    const l = r.rows[0] || {};
    if (!l.pedido) {
      res.status(200).json({ agente: false, visto_em: l.visto || null,
        mensagem: l.visto ? "O agente do WinThor está em pausa." : "O agente do WinThor não está ligado agora." });
      return;
    }
    res.status(200).json({ agente: true, pedido: Number(l.pedido) });
  } catch (e) {
    responderErro(res, e, process.env.SUPABASE_DB_PORT);
  }
};
