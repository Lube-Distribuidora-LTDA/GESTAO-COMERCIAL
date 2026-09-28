/**
 * _db.js — conexão com o DATA WAREHOUSE, compartilhada pelas rotas da API.
 *
 * A senha fica numa variável de ambiente da Vercel e nunca chega ao navegador.
 * As tabelas do Supabase estão com Row Level Security ligado e sem políticas,
 * então a chave pública não lê nada: só quem conecta com credencial de
 * servidor — o ETL e estas funções — enxerga os dados.
 *
 * Quase tudo aqui foi aprendido apanhando na publicação do GESTÃO FINANCEIRO,
 * que usa o mesmo projeto do Supabase. Os comentários dizem o porquê de cada
 * ajuste; sem eles, o próximo sistema repete o mesmo dia de depuração.
 *
 * Variáveis necessárias (Settings › Environment Variables):
 *   SUPABASE_DB_HOST      aws-0-sa-east-1.pooler.supabase.com
 *   SUPABASE_DB_PORT      5432   (ver a nota sobre pooler abaixo)
 *   SUPABASE_DB_NAME      postgres
 *   SUPABASE_DB_USER      postgres.ivcnotrynogaljrvvyes
 *   SUPABASE_DB_PASSWORD  a senha do projeto DATA WAREHOUSE
 */

const { Pool } = require("pg");

/* O pooler do Supabase responde em IPv4. Em ambiente sem rota IPv6, tentar AAAA
   primeiro deixa a conexão pendurada até a função estourar o tempo. */
try { require("dns").setDefaultResultOrder("ipv4first"); } catch (_) { /* Node antigo */ }

/* ref do projeto DATA WAREHOUSE. A máquina do Júlio tem variáveis de ambiente
   apontando para OUTRO projeto (painel-icms-lube), e variável do sistema vence
   .env.local — sem esta conferência, um deploy mal configurado leria o banco
   errado sem avisar. */
const REF_ESPERADO = "ivcnotrynogaljrvvyes";
const OBRIGATORIAS = ["SUPABASE_DB_HOST", "SUPABASE_DB_USER", "SUPABASE_DB_PASSWORD"];

let pool = null;

function configuracao() {
  const usuario = process.env.SUPABASE_DB_USER || "";
  if (!usuario.endsWith(REF_ESPERADO)) {
    throw new Error("SUPABASE_DB_USER aponta para outro projeto (esperado ..." + REF_ESPERADO + ")");
  }
  return {
    host: process.env.SUPABASE_DB_HOST || "aws-0-sa-east-1.pooler.supabase.com",
    /* 5432 = session pooler. O padrão da casa para função serverless é o
       transaction pooler (6543), mas o deste projeto conecta e trava a consulta
       ("Query read timeout"), enquanto o 5432 responde em menos de 1s — medido
       da Vercel em 25/09/2026. Se o 6543 voltar ao normal, basta trocar a
       variável: o código lê a porta do ambiente. */
    port: Number(process.env.SUPABASE_DB_PORT || 5432),
    database: process.env.SUPABASE_DB_NAME || "postgres",
    user: usuario,
    password: process.env.SUPABASE_DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
    max: 1,
    idleTimeoutMillis: 50000,
    /* o primeiro handshake leva de 7 a 15s com o pooler frio; abaixo disso a
       conexão é cortada antes mesmo de autenticar. */
    connectionTimeoutMillis: 15000,
    statement_timeout: 40000,
    application_name: "painel-comercial",
  };
}

function obterPool() {
  if (!pool) {
    pool = new Pool(configuracao());
    /* Se a conexão ociosa cair sozinha (o pooler reciclou, a rede oscilou),
       descarta o Pool: a próxima chamada cria um do zero. */
    pool.on("error", (e) => {
      console.error("Conexão Postgres ociosa caiu:", e && e.message);
      pool = null;
    });
  }
  return pool;
}

function erroDeConexao(e) {
  return /timeout|ECONNRESET|ECONNREFUSED|terminated|ETIMEDOUT|EAUTHQUERY/i
    .test(String((e && e.message) || ""));
}

/**
 * Roda a consulta. A função e o pooler acordam juntos: a primeira chamada
 * depois de um tempo parado pode levar dezenas de segundos ou não completar.
 * Quando o erro é de conexão, o pool é descartado e a chamada refeita — a
 * segunda tentativa costuma responder na hora.
 */
async function consultar(sql, valores, tentativas = 3) {
  let ultimoErro;
  for (let i = 0; i < tentativas; i++) {
    try {
      return await obterPool().query(sql, valores);
    } catch (e) {
      ultimoErro = e;
      if (!erroDeConexao(e)) throw e;
      try { if (pool) await pool.end(); } catch (_) { /* já estava morto */ }
      pool = null;
      if (i < tentativas - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw ultimoErro;
}

function faltandoVariaveis() {
  return OBRIGATORIAS.filter((v) => !process.env[v]);
}

/** Aceita só AAAA-MM-DD. Qualquer outra coisa vira null (a função do banco tem
 *  padrão próprio). Nada do que vem na URL entra na consulta sem passar por
 *  aqui, e mesmo assim vai como parâmetro, nunca concatenado. */
function dataOuNulo(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function responderErro(res, e, porta) {
  console.error("Falha ao consultar o Supabase:", e);
  res.status(502).json({
    erro: "falha_no_banco",
    mensagem:
      "Não consegui ler o DATA WAREHOUSE. Se for o primeiro acesso do dia, o pooler pode " +
      "estar acordando — tente de novo. Persistindo, confira as variáveis de ambiente e a porta " +
      (porta || 5432) + ".",
    detalhe: String(e && e.message ? e.message : e),
  });
}

module.exports = { consultar, faltandoVariaveis, dataOuNulo, responderErro };
