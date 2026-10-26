/**
 * /api/versao — o que há de novo, numa consulta pequena e sem cache:
 *   periodo   quando o JSON pronto do período foi feito (comercial.painel_versao). O AGENTE
 *             LUBE refaz o JSON a cada vez que grava; o navegador só baixa /api/dados de novo
 *             quando isto muda. A pergunta também marca o período "em uso", e é o que diz ao
 *             agente quais períodos refazer (ver db/10-ao-vivo.sql).
 *   agente    o agente do WinThor está ligado? (batimento com menos de 3 minutos)
 *   views     quando o resumo da margem e os gráficos por mês foram refeitos (15 em 15 min)
 *   pedido    com ?pedido=<id>: como está o pedido do botão Atualizar
 * O navegador pergunta isto de 15 em 15 segundos com a aba aberta. Sem o schema do agente
 * (banco antigo), responde só o período, e a tela fica como era.
 */

const { consultar, faltandoVariaveis, dataOuNulo, responderErro } = require("./_db");

const SQL_PERIODO = "SELECT comercial.painel_versao($1::date, $2::date) AS periodo";

const SQL_COMPLETA =
  `SELECT comercial.painel_versao($1::date, $2::date) AS periodo,
          b.visto AS agente_visto, coalesce(b.ligado, false) AS agente_ligado,
          (SELECT min(atualizado_em) FROM comercial.views_ao_vivo) AS views_em,
          p.id AS pedido_id, p.status AS pedido_status, p.mensagem AS pedido_mensagem, p.detalhe AS pedido_detalhe,
          p.segundos AS pedido_segundos, p.atendido_em AS pedido_atendido_em
     FROM (SELECT max(visto_em) AS visto, bool_or(ligado) AS ligado FROM agente.batimento
            WHERE visto_em > now() - interval '3 minutes') b
     LEFT JOIN agente.pedido p ON p.id = $3 AND p.sistema = 'comercial'`;

module.exports = async function handler(req, res) {
  const faltando = faltandoVariaveis();
  if (faltando.length) {
    res.status(500).json({ erro: "configuracao_incompleta", mensagem: "Faltam variáveis de ambiente: " + faltando.join(", ") });
    return;
  }
  const de = dataOuNulo(req.query && req.query.de);
  const ate = dataOuNulo(req.query && req.query.ate);
  const bruto = String((req.query && req.query.pedido) || "");
  const pedido = /^\d{1,15}$/.test(bruto) ? bruto : null;

  res.setHeader("Cache-Control", "no-store");
  try {
    let r, completa = true;
    try {
      r = await consultar(SQL_COMPLETA, [de, ate, pedido]);
    } catch (e) {
      if (!(e && (e.code === "42P01" || e.code === "3F000"))) throw e;
      completa = false;
      r = await consultar(SQL_PERIODO, [de, ate]);
    }
    const l = r.rows[0] || {};
    const out = { periodo: l.periodo || null };
    if (completa) {
      out.agente = { vivo: !!(l.agente_visto && l.agente_ligado), visto_em: l.agente_visto || null };
      out.views_em = l.views_em || null;
      if (pedido) {
        out.pedido = l.pedido_id ? {
          id: Number(l.pedido_id), status: l.pedido_status, mensagem: l.pedido_mensagem, detalhe: l.pedido_detalhe,
          segundos: l.pedido_segundos == null ? null : Number(l.pedido_segundos), atendido_em: l.pedido_atendido_em,
        } : null;
      }
    }
    res.status(200).json(out);
  } catch (e) {
    responderErro(res, e, process.env.SUPABASE_DB_PORT);
  }
};
