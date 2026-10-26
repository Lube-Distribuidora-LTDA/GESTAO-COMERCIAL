/**
 * servidor_local.js — abre o Central Comercial no seu computador, antes (ou sem) publicar na Vercel.
 *
 * Serve a pasta web/ e atende /api/dados, /api/detalhe, /api/versao e /api/atualizar com AS
 * MESMAS funções que a Vercel usa, contra o DATA WAREHOUSE de verdade. As funções são escritas
 * para a Vercel (req.query, res.status().json()); aqui um adaptador pequeno faz o papel dela.
 * A senha do banco vem do ENV do ETL: é lida para a memória deste processo e nunca é impressa
 * nem gravada.
 *
 *   cd web
 *   npm install            (uma vez; ou NODE_PATH apontando para um node_modules com o pg)
 *   node servidor_local.js
 *   abra http://localhost:3105
 *
 * Só escuta a própria máquina (127.0.0.1): o painel tem nome de RCA e não tem login aqui.
 * Onde procura o ENV: o caminho passado como argumento, ..\etl\ENV, C:\BI\COMERCIAL\ENV.
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const WEB = __dirname;
const PORTA = Number(process.env.PORTA || 3105);

const candidatos = [process.argv[2], path.join(WEB, "..", "etl", "ENV"), "C:\\BI\\COMERCIAL\\ENV"].filter(Boolean);
const arquivoEnv = candidatos.find((c) => fs.existsSync(c));
if (!arquivoEnv && !process.env.SUPABASE_DB_PASSWORD) {
  console.error("Nao achei o arquivo ENV. Passe o caminho: node servidor_local.js \"C:\\caminho\\ENV\"");
  process.exit(1);
}
if (arquivoEnv) {
  for (const linha of fs.readFileSync(arquivoEnv, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(linha);
    if (!m || linha.trim().startsWith("#")) continue;
    let v = m[2];
    if (/^".*"$/.test(v)) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
process.env.SUPABASE_DB_PORT = process.env.SUPABASE_DB_PORT || "5432";

const rotas = {
  "/api/dados": require(path.join(WEB, "api", "dados.js")),
  "/api/detalhe": require(path.join(WEB, "api", "detalhe.js")),
  "/api/versao": require(path.join(WEB, "api", "versao.js")),
  "/api/atualizar": require(path.join(WEB, "api", "atualizar.js")),
};
const TIPOS = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2",
};

/* o pedaço da Vercel que as funções usam */
function comoNaVercel(req, res, u) {
  req.query = Object.fromEntries(u.searchParams);
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => {
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(o));
    return res;
  };
  res.send = (s) => { res.end(s); return res; };
}

http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (rotas[u.pathname]) {
    comoNaVercel(req, res, u);
    return Promise.resolve(rotas[u.pathname](req, res)).catch((e) => {
      console.error(e);
      if (!res.headersSent) res.status(500).json({ erro: "servidor_local", mensagem: String(e && e.message) });
    });
  }
  const f = path.join(WEB, u.pathname === "/" ? "index.html" : decodeURIComponent(u.pathname));
  // só serve o que está dentro de web/, nunca o código do servidor, as funções nem o node_modules
  const ok = f.startsWith(WEB + path.sep) && !f.includes("node_modules") && !f.includes(path.sep + "api" + path.sep) &&
             !/servidor_local\.js$|\.ts$|package(-lock)?\.json$/.test(f) && fs.existsSync(f) && fs.statSync(f).isFile();
  if (!ok) { res.statusCode = 404; return res.end("nao encontrado"); }
  res.setHeader("Content-Type", TIPOS[path.extname(f)] || "application/octet-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.end(fs.readFileSync(f));
}).listen(PORTA, "127.0.0.1", () => console.log("Central Comercial em http://localhost:" + PORTA + "   (Ctrl+C para parar)"));
