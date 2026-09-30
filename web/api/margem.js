/**
 * /api/margem — acompanhamento da abertura de margem das filiais.
 *
 * SÓ LEITURA. Quem abre e fecha é o sistema local (`etl/servidor_margem.py`),
 * que roda numa máquina dentro da rede. Aqui ficam os números e o histórico.
 *
 * POR QUE A OPERAÇÃO NÃO MORA AQUI
 *
 * O Oracle do WinThor vive em 192.168.0.5, dentro da rede, e não é alcançável
 * da Vercel. O painel chegou a ter um formulário que enfileirava o pedido para
 * um agente executar; com o sistema local, a fila deixou de ser necessária —
 * lá o pedido é executado na hora, e a espera some.
 *
 * Como efeito, um botão que muda o cadastro de produto da empresa deixa de
 * existir num endereço público. Este painel mostra, não mexe.
 *
 * GET → { painel, abertos, historico, endereco }
 */

const { consultar, faltandoVariaveis, responderErro } = require("./_db");

/* Onde o pessoal do comercial abre o sistema. Configurável porque a máquina
   pode mudar; sem a variável, a tela explica em vez de inventar um endereço. */
function endereco() {
  return String(process.env.MARGEM_ENDERECO || "").trim() || null;
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

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({
      erro: "metodo_nao_permitido",
      mensagem: "Abrir e fechar a margem é feito no sistema local da rede, não por aqui."
    });
    return;
  }

  try {
    const r = await consultar(
      "SELECT comercial.margem_painel($1) AS painel, " +
      "       comercial.margem_abertos($2) AS abertos, " +
      "       comercial.margem_historico($3) AS historico",
      [90, 2000, 60]
    );
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).send(JSON.stringify({
      painel: r.rows[0].painel,
      abertos: r.rows[0].abertos,
      historico: r.rows[0].historico,
      endereco: endereco()
    }));
  } catch (e) {
    responderErro(res, e, process.env.SUPABASE_DB_PORT);
  }
};
