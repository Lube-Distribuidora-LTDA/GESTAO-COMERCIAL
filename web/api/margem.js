/**
 * /api/margem — abrir e fechar a margem mínima das filiais.
 *
 * GET  → últimos pedidos, para a tela acompanhar.
 * POST → registra um pedido na fila (comercial.margem_registrar).
 *
 * O painel NÃO executa nada no WinThor: o Oracle vive dentro da rede da
 * empresa e não é alcançável daqui. Esta rota só registra o pedido; quem
 * executa é o `agente_margem.py`, que roda na mesma máquina do ETL e devolve o
 * resultado para a mesma tabela.
 *
 * TRAVA DE SEGURANÇA
 * O POST só funciona com a variável de ambiente MARGEM_ATIVA=sim no projeto da
 * Vercel. Enquanto o painel estiver aberto (sem Vercel Authentication), um
 * botão que muda o cadastro de produto da empresa não pode ficar ao alcance de
 * quem tiver o link. Ligue a proteção de acesso primeiro; depois a variável.
 */

const { consultar, faltandoVariaveis, responderErro } = require("./_db");

function ativo() {
  return String(process.env.MARGEM_ATIVA || "").trim().toLowerCase() === "sim";
}

async function lerCorpo(req) {
  if (req.body && typeof req.body === "object") return req.body;
  var bruto = "";
  for await (const pedaco of req) bruto += pedaco;
  try { return JSON.parse(bruto || "{}"); } catch (e) { return {}; }
}

function inteiros(v, teto) {
  if (!Array.isArray(v)) return [];
  var saida = [];
  for (var i = 0; i < v.length && saida.length < teto; i++) {
    var n = parseInt(v[i], 10);
    if (!isNaN(n) && n > 0) saida.push(n);
  }
  return saida;
}

module.exports = async function handler(req, res) {
  const faltando = faltandoVariaveis();
  if (faltando.length) {
    res.status(500).json({
      erro: "configuracao_incompleta",
      mensagem: "Faltam variáveis de ambiente no projeto da Vercel: " + faltando.join(", ")
    });
    return;
  }

  try {
    if (req.method === "GET") {
      const r = await consultar("SELECT comercial.margem_historico($1) AS h", [40]);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.status(200).send(JSON.stringify({ ativo: ativo(), historico: r.rows[0].h }));
      return;
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      res.status(405).json({ erro: "metodo_nao_permitido" });
      return;
    }

    if (!ativo()) {
      res.status(423).json({
        erro: "funcao_desligada",
        mensagem:
          "A mudança de margem está desligada. Ligue a proteção de acesso do painel " +
          "(Settings › Deployment Protection › Vercel Authentication) e depois crie a " +
          "variável MARGEM_ATIVA=sim no projeto. Enquanto o painel estiver aberto, " +
          "qualquer pessoa com o link poderia mexer no cadastro de produto."
      });
      return;
    }

    const corpo = await lerCorpo(req);
    const acao = corpo.acao === "fechar" ? "fechar" : corpo.acao === "abrir" ? "abrir" : null;
    if (!acao) {
      res.status(400).json({ erro: "acao_invalida", mensagem: "A ação precisa ser abrir ou fechar." });
      return;
    }

    const filiais = inteiros(corpo.filiais, 10);
    const produtos = inteiros(corpo.produtos, 500);
    const margem = corpo.margem == null || corpo.margem === "" ? null : Number(corpo.margem);
    const origem = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() || null;

    const r = await consultar(
      "SELECT comercial.margem_registrar($1, $2, $3, $4::smallint[], $5::integer[], $6, $7) AS r",
      [String(corpo.solicitante || "").slice(0, 120),
       String(corpo.motivo || "").slice(0, 1000),
       acao, filiais, produtos, margem, origem]
    );
    const resposta = r.rows[0].r;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(resposta && resposta.erro ? 400 : 200).send(JSON.stringify(resposta));
  } catch (e) {
    responderErro(res, e, process.env.SUPABASE_DB_PORT);
  }
};
