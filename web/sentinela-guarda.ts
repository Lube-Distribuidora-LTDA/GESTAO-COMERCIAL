/* =========================================================
   SENTINELA LUBE — guarda (núcleo, sem dependências)
   Roda no Routing Middleware da Vercel (runtime nodejs ou edge)
   e dentro do middleware do Next.js 15/16. Só Web APIs.
   Falha aberta: qualquer erro → null (a requisição segue).
   Nunca lê o corpo e nunca altera a requisição.
   Nada de segredo aqui: este arquivo pode ser público.
   ========================================================= */
/* eslint-disable */

// process só existe em alguns runtimes; declarado aqui (escopo do módulo) para
// compilar com ou sem @types/node. Sempre usado atrás de typeof.
declare const process: any;

export const VERSAO = 'sentinela-guarda/1.0.0';

const CENTRAL = 'https://wkkdcsqwlxjxorutrbnx.supabase.co/functions/v1/sentinela';
const PORTAL_PADRAO = 'https://painel-lube-distribuidora.vercel.app';
const OIDC_ISS = 'https://oidc.vercel.com/lube-distribuidora-ltda';
const TEAM_ID = 'team_k8YNfCDhgFwOScWnM5iHGqLC';

const COOKIE_SESSAO = '__Host-sentinela';
const COOKIE_FALHA = '__Host-sentinela-falha';   // quebra o laço portal ↔ sistema quando o passe falha
const PARAM_PASSE = 'sentinela_passe';
const ROTA_SAUDE = '/.sentinela/saude';

const TTL_LISTA = 20000;            // lista fresca por 20 s
const IDADE_MAX_LISTA = 3600000;    // lista com mais de 1 h não é usada (renova antes)
const ESPERA_LISTA = 700;           // sem lista: espera no máximo isso na requisição
const PAUSA_APOS_FALHA = 15000;     // central falhou (rede, tempo, 5xx): lista e /evento param por 15 s
const TEMPO_CENTRAL = 2500;         // prazo de /lista, /evento e /sessao (todas as credenciais juntas)
const DEDUPE_MS = 5000;
const DEDUPE_MAX = 500;
const BLOQ_LOCAL_MS = 24 * 3600000;
const BLOQ_LOCAL_MAX = 1000;
const SESSOES_MAX = 500;
const EVENTOS_DIRETOS_IP_MIN = 30;  // por IP e minuto, sai na hora; o resto vai em lote (a central conta todos)
const LOTE_MAX = 20;                // máximo de eventos por POST (§3)
const LOTE_BYTES = 56000;           // folga sob os 64 KB da central
const FILA_MAX = 200;
const FILA_IDADE = 2000;            // lote incompleto sai na próxima requisição depois disso
const CONTADORES_MAX = 2000;
const RECUSA_MS = 10 * 60000;       // token recusado pela central fica de quarentena
const RECUSA_HMAC_MS = 60000;

// Chave pública ES256 da Sentinela (sentinela.chaves, criada em 2026-10-06). Não é segredo.
// Serve ao modo "fechado" quando a lista não veio (partida a frio, central fora): sem ela não
// daria para conferir a sessão e todo mundo voltaria ao portal. Trocou a chave na central? Atualize aqui.
const CHAVES_FIXAS: any[] = [
  { kty: 'EC', crv: 'P-256', kid: '23295be7908c33a1', alg: 'ES256', use: 'sig',
    x: 'fkhjiIvDNaaNYv8xMzJNYAiAddOuKzPqk8Yj5vENCbw', y: 'OWQCjAwJOJGpni7gEJRrX9rao95slIvVXafs7j_uTsw' },
];

type Tipo = 'pagina' | 'api' | 'arquivo' | 'outro';
type Decisao = 'liberado' | 'observado' | 'bloqueado';
type Nivel = 'certo' | 'suspeito';
type Ctx = { waitUntil?(p: Promise<unknown>): void };
// fechado: sistema que só abre com login do Painel Lube. Vale quando a lista não vem (partida a
// frio, central fora): aí só passa quem tem sessão válida. Com lista, quem manda é o exige_login do banco.
type Fechado = { projeto: string; slug: string; rotas?: string[]; chaves?: any[] };
type Opcoes = { identidade?: { email: string; origem: 'sessao_app' }; fechado?: Fechado | null };
type Resp = { ok: boolean; status: number; json: any; recusada?: boolean };

interface Evento {
  ts: string; metodo: string; host: string; caminho: string; consulta: string; tipo: Tipo;
  ip: string; pais: string | null; regiao: string | null; cidade: string | null;
  lat: number | null; lon: number | null; fuso: string | null;
  ua: string | null; idioma: string | null; referer: string | null; ja4: string | null; vercel_id: string | null;
  sec_fetch_site: string | null; sec_fetch_mode: string | null; sec_fetch_dest: string | null;
  decisao: Decisao; regra: string | null; motivo: string | null;
  identidade: string | null; identidade_origem: 'passe' | 'sessao_app' | null;
}

interface Achado { regra: string; nivel: Nivel | null; motivo: string; decisao?: Decisao }

type Cred =
  | { tipo: 'oidc'; token: string; exp: number }
  | { tipo: 'hmac'; chave: string; projeto: string; ambiente: string };

interface Ip { v: 4 | 6; n: bigint }
interface Rede { v: 4 | 6; rede: bigint; bits: number }
interface Bloq { id: number | null; n: Nivel; ate: number | null }

interface Sistema {
  projeto: string; slug: string | null; exigeLogin: boolean; rotas: string[]; proibidos: RegExp[];
}

interface Lista {
  em: number; ttl: number; modo: 'observar' | 'proteger'; portal: string;
  ipsBloq: Map<string, Bloq[]>; redesBloq: { r: Rede; b: Bloq }[]; ja4Bloq: Map<string, Bloq[]>;
  ipsConf: Set<string>; redesConf: Rede[];
  sistema: Sistema | null;
  jwks: any[]; chaves: Map<string, Promise<CryptoKey | null>>;
  sessoes: Map<string, { email: string | null; exp: number }>;
}

/* ---------- estado do módulo (vive enquanto a instância vive) ---------- */
let cache: Lista | null = null;
let voo: Promise<Lista | null> | null = null;
let vooInicio = 0;
let ultimaFalha = 0;
const dedupe = new Map<string, number>();
const bloqLocal = new Map<string, number>();
const porIp = new Map<string, { ate: number; n: number; bloq: boolean }>();
type ItemFila = { s: string; b: number; em: number };   // evento já em JSON, bytes UTF-8, quando entrou
let fila: ItemFila[] = [];
let oidcAceito: { token: string; exp: number } | null = null;   // token que a central já aceitou
const recusados = new Map<string, number>();                       // token OIDC → até quando não usar
let hmacRecusadoAte = 0;
const plausiveis = new Map<string, number>();                      // token → exp (ms), 0 = não serve
let hmacCache: { chave: string; key: Promise<CryptoKey> } | null = null;

const RUNTIME: string = (function () {
  try {
    if (typeof (globalThis as any).EdgeRuntime === 'string') return 'edge';
    if (typeof process !== 'undefined') return 'nodejs';
  } catch { /* segue */ }
  return 'desconhecido';
})();

/* =========================================================
   Regras locais (§1 da especificação)
   ========================================================= */
const RE_FERRAMENTA = /sqlmap|nikto|nmap|masscan|zgrab|nuclei|wpscan|dirbuster|gobuster|ffuf|feroxbuster|hydra|acunetix|nessus|openvas|w3af|arachni|jaeles|zmeu|morfeus|l9explore|fuzz faster|commix|xsstrike|whatweb|wfuzz/i;

// Aplicadas ao pathname decodificado. Algumas valem em qualquer profundidade
// (/app/.env, /blog/wp-content/...), o que só pega mais ataque.
const RE_VARREDURA: RegExp[] = [
  /(?:^|\/)\.(?:env|git|svn|hg|aws|ssh|ds_store|htaccess|htpasswd)/i,
  /(?:^|\/)wp-(?:admin|login|content|includes|json)/i,
  /xmlrpc\.php/i,
  /\.(?:php\d?|asp|aspx|jsp|cgi|pl)(?:$|\/)/i,
  /(?:^|\/)phpmyadmin/i,
  /^\/pma\//i,
  /^\/cgi-bin\//i,
  /(?:^|\/)vendor\/phpunit/i,
  /^\/server-status/i,
  /^\/actuator/i,
  /^\/boaform/i,
  /^\/hnap1/i,
  /^\/owa\//i,
  /^\/autodiscover/i,
  /^\/solr\//i,
  /^\/_ignition/i,
  /^\/telescope/i,
  /^\/(?:config|credentials|secrets?)\.(?:ya?ml|ini|bak|old)$/i,
  /\.(?:bak|old|swp|save)$/i,
];

// /.well-known/ é varredura, menos o que navegador, gerenciador de senha e
// validação de certificado pedem sozinhos (ex.: o DevTools do Chrome pede
// /.well-known/appspecific/com.chrome.devtools.json; o "Alterar senha" do Chrome
// e do Safari testa antes o resource-that-should-not-exist-..., esperando 404).
const RE_WELL_KNOWN = /^\/\.well-known(?:\/|$)/i;
const RE_WELL_KNOWN_OK = /^\/\.well-known\/(?:acme-challenge\/|pki-validation\/|security\.txt$|appspecific\/|change-password\/?$|resource-that-should-not-exist-whose-status-code-should-not-be-200\/?$|traffic-advice$|apple-app-site-association$|apple-developer-merchantid-domain-association|assetlinks\.json$|gpc\.json$|passkey-endpoints$|web-identity$|webauthn$|microsoft-identity-association\.json$|openid-configuration$|oauth-authorization-server|oauth-protected-resource|jwks\.json$|nodeinfo$|host-meta|webfinger$|mta-sts\.txt$|dnt-policy\.txt$|privacy-sandbox-attestations\.json$|related-website-set\.json$|trust\.txt$|caldav$|carddav$|mcp)/i;

// Todas lineares: o texto inteiro da URL é testado (sem teto que esconda carga no fim).
// Valem para caminho + consulta.
const RE_INJECAO: [RegExp, string][] = [
  [/\.\.\//, 'subida de diretório (../)'],
  [/<script/i, '<script> na URL'],
  [/information_schema/i, 'SQL information_schema'],
  [/\bsleep\(\s*\d/i, 'SQL sleep()'],
  [/benchmark\(/i, 'SQL benchmark()'],
  [/\$\{jndi:/i, 'Log4Shell ${jndi:'],
  [/\/etc\/passwd/i, '/etc/passwd'],
  [/'\s*or\s*'?1'?\s*=\s*'?1/i, "SQL ' or '1'='1"],
  [/\bor\s+1\s*=\s*1\b/i, 'SQL or 1=1'],
];
// UNION SELECT: os comentários /* */ saem antes (laço linear em semComentarios).
const RE_UNION = /union[\s+]+select/i;
// No caminho, como no §1. Na consulta, só com contexto de ataque: busca livre
// ("cmd.exe", "C:\Windows\System32\cmd.exe", "..\backup", "javascript: void")
// não pode render 403 + bloqueio de IP de 24 h.
const RE_INJECAO_CAMINHO: [RegExp, string][] = [
  [/\.\.\\/, 'subida de diretório (..\\)'],
  [/javascript:/i, 'javascript: na URL'],
  [/cmd\.exe/i, 'cmd.exe'],
];
const RE_INJECAO_CONSULTA: [RegExp, string][] = [
  [/(?:\.\.\\){2}|\.\.\\(?:windows|winnt|win\.ini|boot\.ini|web\.config|inetpub|system32)/i, 'subida de diretório (..\\)'],
  [/javascript:[^(`=]{0,60}[(`=]/i, 'javascript: na URL'],
  [/cmd\.exe\s*\/[ckr]\b|[|&;`\n\r]\s*cmd\.exe/i, 'cmd.exe'],
];

const RE_ROBO = /curl|wget|python-requests|python-urllib|aiohttp|httpx|go-http-client|okhttp|java\/|libwww|axios|node-fetch|undici|postmanruntime|insomnia|headlesschrome|phantomjs|scrapy|httpclient|powershell/i;
const RE_CRON = /vercel-cron\//i;
const RE_PREVIA = /whatsapp|telegrambot|slackbot|facebookexternalhit|twitterbot|linkedinbot|discordbot|skypeuripreview|microsoftpreview/i;
const RE_BUSCADOR = /googlebot|bingbot|duckduckbot|yandexbot|baiduspider|applebot/i;

// parâmetros cujo valor não vai para o registro (quando não é ataque)
const RE_PARAM_SENSIVEL = /^(?:access_token|refresh_token|id_token|token|code|senha|password|passwd|pwd|apikey|api_key|key|secret|client_secret|jwt|signature|sig)$/i;

function regraAtaque(ua: string, caminho: string, consulta: string): Achado | null {
  const f = RE_FERRAMENTA.exec(ua);
  if (f) return { regra: 'ferramenta', nivel: 'certo', motivo: 'ferramenta de ataque no user-agent: ' + f[0].toLowerCase() };
  for (const re of RE_VARREDURA) {
    if (re.test(caminho)) return { regra: 'varredura', nivel: 'certo', motivo: 'varredura: caminho típico de ataque' };
  }
  if (RE_WELL_KNOWN.test(caminho) && !RE_WELL_KNOWN_OK.test(caminho)) {
    return { regra: 'varredura', nivel: 'certo', motivo: 'varredura: /.well-known desconhecido' };
  }
  const injecao = (nome: string): Achado => ({ regra: 'injecao', nivel: 'certo', motivo: 'tentativa de injeção: ' + nome });
  const alvo = caminho + ' ' + consulta;
  for (const [re, nome] of RE_INJECAO) if (re.test(alvo)) return injecao(nome);
  if (RE_UNION.test(semComentarios(alvo))) return injecao('SQL UNION SELECT');
  for (const [re, nome] of RE_INJECAO_CAMINHO) if (re.test(caminho)) return injecao(nome);
  for (const [re, nome] of RE_INJECAO_CONSULTA) if (re.test(consulta)) return injecao(nome);
  return null;
}

// Troca cada /* ... */ por espaço, em tempo linear. Comentário sem fim fica como está.
// /*!50000 ... */ do MySQL executa o conteúdo: ele fica (sem a versão).
function semComentarios(s: string): string {
  let i = s.indexOf('/*');
  if (i < 0) return s;
  let out = '';
  let pos = 0;
  while (i >= 0) {
    const f = s.indexOf('*/', i + 2);
    if (f < 0) break;
    const dentro = s.charAt(i + 2) === '!' ? s.slice(i + 3, f).replace(/^\d*/, '') : '';
    out += s.slice(pos, i) + ' ' + dentro + ' ';
    pos = f + 2;
    i = s.indexOf('/*', pos);
  }
  return out + s.slice(pos);
}

function regraLista(lista: Lista | null, ip: Ip | null, ja4: string | null, agora: number, confiavel: boolean): Achado | null {
  if (ip && !confiavel) {
    const ate = bloqLocal.get(chaveIp(ip));
    if (ate && ate > agora) return { regra: 'lista', nivel: 'certo', motivo: 'IP barrado por este guarda (ataque recente)' };
  }
  if (!lista) return null;
  let melhor: Bloq | null = null;
  let qual = '';
  const considerar = (b: Bloq, txt: string) => {
    if (b.ate !== null && b.ate <= agora) return;
    if (!melhor || (melhor.n === 'suspeito' && b.n === 'certo')) { melhor = b; qual = txt; }
  };
  if (ip) {
    for (const b of lista.ipsBloq.get(chaveIp(ip)) || []) considerar(b, 'IP');
    for (const x of lista.redesBloq) if (contem(x.r, ip)) considerar(x.b, 'rede');
  }
  if (ja4) for (const b of lista.ja4Bloq.get(ja4) || []) considerar(b, 'JA4');
  if (!melhor) return null;
  const m: Bloq = melhor;
  return {
    regra: 'lista', nivel: m.n,
    motivo: qual + ' na lista de bloqueio' + (m.id !== null ? ' #' + m.id : '') + ' (' + m.n + ')',
  };
}

function regraArquivo(lista: Lista | null, caminho: string): Achado | null {
  const s = lista && lista.sistema;
  if (!s) return null;
  for (const re of s.proibidos) {
    if (re.test(caminho)) return { regra: 'arquivo_proibido', nivel: 'suspeito', motivo: 'arquivo proibido: ' + re.source };
  }
  return null;
}

function regraExcecao(ua: string): Achado | null {
  if (RE_CRON.test(ua)) return { regra: 'cron', nivel: null, motivo: 'agendamento da Vercel', decisao: 'liberado' };
  if (RE_PREVIA.test(ua)) return { regra: 'previa_link', nivel: null, motivo: 'prévia de link', decisao: 'liberado' };
  const b = RE_BUSCADOR.exec(ua);
  if (b) return { regra: 'buscador', nivel: null, motivo: 'buscador: ' + b[0].toLowerCase(), decisao: 'observado' };
  return null;
}

function regraRobo(ua: string, tipo: Tipo): Achado | null {
  if (tipo !== 'pagina' && tipo !== 'api') return null;
  if (!ua.trim()) return { regra: 'robo', nivel: 'suspeito', motivo: 'user-agent vazio' };
  const m = RE_ROBO.exec(ua);
  if (m) return { regra: 'robo', nivel: 'suspeito', motivo: 'user-agent de robô: ' + m[0].toLowerCase() };
  return null;
}

function exigeLogin(lista: Lista | null, caminho: string): boolean {
  const s = lista && lista.sistema;
  if (!s || !s.exigeLogin || !s.slug) return false;
  for (const p of s.rotas) if (rotaCasa(p, caminho)) return false;
  return true;
}

// "/acompanhar" casa /acompanhar e /acompanhar/123 (não /acompanharx);
// "/_next/" e "/_next/*" casam tudo que começa com /_next/.
// "", "/", "/*" e "*" casariam qualquer caminho (desligariam o exige_login inteiro): ignorados,
// assim como qualquer rota que não seja "/" seguida de pelo menos um caractere (igual ao banco).
function rotaCasa(p: string, caminho: string): boolean {
  if (typeof p !== 'string' || p === '/*' || !/^\/./.test(p)) return false;
  if (p.endsWith('*')) return caminho.startsWith(p.slice(0, -1));
  if (p.endsWith('/')) return caminho.startsWith(p);
  return caminho === p || caminho.startsWith(p + '/');
}

/* =========================================================
   Entrada
   ========================================================= */
export async function sentinela(
  request: Request,
  ctx?: { waitUntil?(p: Promise<unknown>): void },
  opcoes?: Opcoes,
): Promise<Response | null> {
  try {
    return await guardar(request, ctx, opcoes);
  } catch {
    return null;
  }
}

async function guardar(request: Request, ctx: Ctx | undefined, opcoes: Opcoes | undefined): Promise<Response | null> {
  const agora = Date.now();
  const url = new URL(request.url);
  const h = request.headers;
  const metodo = String(request.method || 'GET').toUpperCase();
  let ipTxt = ipCliente(h);
  const ip = lerIp(ipTxt);
  if (!ip) ipTxt = '';
  const cs = credenciais(request);

  if (url.pathname === ROTA_SAUDE && metodo === 'GET') return await saude(h, ipTxt, cs, ctx);

  let lista = await obterLista(cs, ctx);
  // sistema fechado sem lista: espera a central um pouco mais e, se ainda não veio, usa a
  // lista de reserva (só exige login). Fechado não pode virar aberto por partida a frio.
  const fechado = opcoes && opcoes.fechado;
  if (!lista && fechado && typeof fechado.projeto === 'string' && typeof fechado.slug === 'string') {
    lista = (await obterLista(cs, ctx, TEMPO_CENTRAL)) || listaReserva(fechado);
  }

  const caminhoDec = normalizarCaminho(decodificar(url.pathname));
  const tipo = tipoDe(url.pathname);
  const ua = h.get('user-agent') || '';
  const ja4 = h.get('x-vercel-ja4-digest');
  const passe = separarPasse(url.search);
  const consulta = passe ? passe.resto : url.search;
  const consultaDec = decodificar(url.search.replace(/\+/g, ' '));

  const ev = coletar(h, url, metodo, tipo, ipTxt, consulta, ua, agora);

  // identidade: a do app (Next) tem prioridade; senão o cookie de sessão da Sentinela
  const idApp = opcoes && opcoes.identidade && opcoes.identidade.email;
  let sessaoInvalida = false;
  if (idApp) {
    ev.identidade = String(idApp).slice(0, 200);
    ev.identidade_origem = 'sessao_app';
  } else {
    const s = await lerSessao(h, lista, agora);
    if (s.email) { ev.identidade = s.email; ev.identidade_origem = 'passe'; }
    sessaoInvalida = s.invalida;
  }

  const confiavel = !!(lista && ip && ehConfiavel(lista, ip));

  // 1) ataque certo: barra em qualquer modo
  const ataque = regraAtaque(ua, caminhoDec, consultaDec);
  if (ataque) {
    if (confiavel) {
      ataque.motivo = 'ataque partindo de rede confiável — verificar máquina (' + ataque.motivo + ')';
    } else if (ataque.regra !== 'ferramenta' && (h.get('sec-fetch-site') || '').toLowerCase() === 'cross-site') {
      // <img>/link de outro site faz o navegador da vítima pedir o caminho de ataque:
      // barra a requisição, mas não barra o IP (senão um terceiro bloqueia quem quiser)
      ataque.motivo += ' · possível requisição forjada por outro site (cross-site): sem bloqueio de IP';
    } else if (lista && ip) {
      bloquearLocal(ip, agora);
    }
    return await barrar(ev, ataque, url.search, cs, ctx);
  }

  // 2) lista da central (+ mapa local)
  let suspeito: Achado | null = null;
  const bloq = regraLista(lista, ip, ja4, agora, confiavel);
  if (bloq) {
    if (bloq.nivel === 'certo') return await barrar(ev, bloq, consulta, cs, ctx);
    suspeito = bloq;
  }

  // 3) arquivo proibido → 4) exceções → 5) robô
  if (!suspeito) suspeito = regraArquivo(lista, caminhoDec);
  let excecao: Achado | null = null;
  if (!suspeito) {
    excecao = regraExcecao(ua);
    if (!excecao) suspeito = regraRobo(ua, tipo);
  }

  // suspeito: confiável ignora; proteger barra; observar só registra
  let observado: Achado | null = null;
  let ignorado: Achado | null = null;
  if (suspeito) {
    if (confiavel) ignorado = suspeito;
    else if (lista && lista.modo === 'proteger') return await barrar(ev, suspeito, consulta, cs, ctx);
    else observado = suspeito;
  }

  // 6) passe vindo do portal
  if (passe) return await trocarPasse(ev, url, passe, h, cs, ctx);

  // 7) sistema que exige login
  if (!ev.identidade && exigeLogin(lista, caminhoDec)) {
    return semLogin(ev, lista as Lista, h, metodo, tipo, observado, sessaoInvalida, cs, ctx);
  }

  // 8) segue
  if (observado) {
    ev.decisao = 'observado'; ev.regra = observado.regra; ev.motivo = observado.motivo;
  } else if (ignorado) {
    ev.decisao = 'liberado'; ev.regra = ignorado.regra; ev.motivo = 'rede confiável: ' + ignorado.motivo + ' (ignorado)';
  } else if (excecao) {
    ev.decisao = excecao.decisao || 'liberado'; ev.regra = excecao.regra; ev.motivo = excecao.motivo;
  }
  ev.consulta = corta(redigirConsulta(consulta), 300) || '';
  ev.motivo = corta(ev.motivo, 200);
  registrar(ev, cs, ctx);
  return null;
}

/* ---------- respostas ---------- */
async function barrar(ev: Evento, a: Achado, consulta: string, cs: Cred[], ctx: Ctx | undefined): Promise<Response> {
  const cod = (await sha256Hex((ev.vercel_id || '') + ev.ts)).slice(0, 8);
  ev.decisao = 'bloqueado';
  ev.regra = a.regra;
  ev.motivo = corta(a.motivo + ' · incidente ' + cod, 200);
  ev.consulta = corta(semPasse(consulta), 300) || '';   // ataque: guarda a consulta como veio (é a evidência)
  registrar(ev, cs, ctx);
  const base: Record<string, string> = {
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex',
    'x-sentinela': 'bloqueado',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
  if (ev.tipo === 'api') {
    base['content-type'] = 'application/json; charset=utf-8';
    return new Response(JSON.stringify({ erro: 'bloqueado', incidente: cod }), { status: 403, headers: base });
  }
  base['content-type'] = 'text/html; charset=utf-8';
  base['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
  return new Response(paginaBloqueio(cod), { status: 403, headers: base });
}

function semLogin(ev: Evento, lista: Lista, h: Headers, metodo: string, tipo: Tipo, observado: Achado | null,
                  sessaoInvalida: boolean, cs: Cred[], ctx: Ctx | undefined): Response {
  const s = lista.sistema as Sistema;
  ev.decisao = 'bloqueado';
  ev.regra = 'sem_login';
  ev.motivo = corta('login necessário' + (sessaoInvalida ? ' (sessão da Sentinela não reconhecida)' : '') +
    (observado ? ' · também ' + observado.regra + ': ' + observado.motivo : ''), 200);
  ev.consulta = corta(redigirConsulta(ev.consulta), 300) || '';
  registrar(ev, cs, ctx);
  const portal = lista.portal;
  if (tipo === 'pagina' && (metodo === 'GET' || metodo === 'HEAD')) {
    // passe acabou de falhar, ou a sessão existe mas este guarda não a reconhece (chave
    // nova ainda fora da lista): home do portal, sem ?abrir, para não entrar em laço
    const falhou = sessaoInvalida || !!lerCookie(h.get('cookie'), COOKIE_FALHA);
    const destino = falhou ? portal + '/' : portal + '/?abrir=' + encodeURIComponent(s.slug as string);
    return new Response(null, { status: 302, headers: { location: destino, 'cache-control': 'no-store', 'x-sentinela': 'login' } });
  }
  return new Response(JSON.stringify({ erro: 'login_necessario', portal }), {
    status: 401,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-sentinela': 'login' },
  });
}

async function trocarPasse(ev: Evento, url: URL, passe: { valor: string; resto: string }, h: Headers,
                           cs: Cred[], ctx: Ctx | undefined): Promise<Response> {
  const limpa = url.origin + url.pathname + passe.resto;
  let sessao: string | null = null;
  let email: string | null = null;
  if (cs.length && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(passe.valor) && passe.valor.length <= 4096) {
    const r = await chamarCentral('POST', '/sessao', JSON.stringify({ passe: passe.valor }), cs, TEMPO_CENTRAL);
    const j = r && r.ok ? r.json : null;
    if (j && j.ok === true && typeof j.sessao === 'string' && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(j.sessao)) {
      sessao = j.sessao;
      email = typeof j.email === 'string' ? j.email.slice(0, 200) : null;
    }
  }
  const headers = new Headers({ location: limpa, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  ev.consulta = corta(redigirConsulta(passe.resto), 300) || '';
  if (sessao) {
    headers.append('set-cookie', COOKIE_SESSAO + '=' + sessao + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800');
    if (lerCookie(h.get('cookie'), COOKIE_FALHA)) headers.append('set-cookie', COOKIE_FALHA + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    ev.decisao = 'liberado';
    ev.regra = null;
    ev.motivo = 'entrada pelo Painel Lube';
    if (email) { ev.identidade = email; ev.identidade_origem = 'passe'; }
  } else {
    headers.append('set-cookie', COOKIE_FALHA + '=1; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60');
    ev.decisao = 'observado';
    ev.regra = 'passe_invalido';
    ev.motivo = 'passe inválido, expirado ou já usado';
  }
  registrar(ev, cs, ctx);
  return new Response(null, { status: 302, headers });
}

async function saude(h: Headers, ipTxt: string, cs: Cred[], ctx: Ctx | undefined): Promise<Response> {
  const lista = await obterLista(cs, ctx);
  const corpo = {
    guarda: VERSAO,
    runtime: RUNTIME,
    oidc: cs.some((c) => c.tipo === 'oidc'),
    lista: {
      ok: !!lista,
      idade_s: lista ? Math.max(0, Math.round((Date.now() - lista.em) / 1000)) : null,
      modo: lista ? lista.modo : null,
    },
    ip: ipTxt || null,
    pais: h.get('x-vercel-ip-country'),
    cidade: decodificarSeguro(h.get('x-vercel-ip-city')),
  };
  return new Response(JSON.stringify(corpo), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  });
}

function paginaBloqueio(cod: string): string {
  return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">' +
    '<title>Acesso bloqueado · Sentinela Lube</title><style>' +
    'html,body{margin:0;min-height:100%;background:#050b1c;color:#e8edf8;font:500 16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}' +
    'main{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;box-sizing:border-box}' +
    '.c{max-width:440px;width:100%;background:#0d1830;border:1px solid #1d2b55;border-radius:18px;padding:32px 24px;text-align:center;box-shadow:0 0 70px rgba(229,32,44,.14)}' +
    '.s{width:56px;height:56px;margin:0 auto 16px;border-radius:16px;background:rgba(229,32,44,.15);display:flex;align-items:center;justify-content:center}' +
    'h1{font-size:20px;line-height:1.3;margin:0 0 8px;font-weight:800}' +
    'p{margin:8px 0;color:#a9b4d0}' +
    '.k{display:inline-block;margin:14px 0 6px;padding:9px 16px;border-radius:10px;background:#132242;color:#fff;font:800 18px/1 ui-monospace,"JetBrains Mono",Consolas,monospace;letter-spacing:.14em}' +
    'a{color:#5fb2ff}.m{margin-top:20px;font-size:12px;color:#5d6a8c;letter-spacing:.08em;text-transform:uppercase}' +
    '</style></head><body><main><div class="c">' +
    '<div class="s"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ff6b74" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.4 8.4-8 9-4.6-.6-8-4.5-8-9V6l8-3z"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/></svg></div>' +
    '<h1>Acesso bloqueado pela Sentinela Lube</h1>' +
    '<p>Esta requisição foi barrada por segurança.</p>' +
    '<div class="k">' + esc(cod) + '</div>' +
    '<p>Se você é da Lube, envie este código ao TI: <a href="mailto:cpd@lube.com.br">cpd@lube.com.br</a></p>' +
    '<div class="m">Lube Distribuidora · Sentinela</div>' +
    '</div></main></body></html>';
}

/* =========================================================
   Lista (cache em memória, stale-while-revalidate)
   ========================================================= */
async function obterLista(cs: Cred[], ctx: Ctx | undefined, espera: number = ESPERA_LISTA): Promise<Lista | null> {
  const agora = Date.now();
  if (cache && agora - cache.em <= IDADE_MAX_LISTA) {
    if (cs.length && agora - cache.em > cache.ttl) emFundo(ctx, renovar(cs));
    return cache;
  }
  if (!cs.length) return null;
  const limite = agora + espera;
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const p = renovar(cs);
    const resta = Math.min(espera - (Date.now() - vooInicio), limite - Date.now());
    if (resta <= 0) { emFundo(ctx, p); return null; }
    const r = await comLimite(p, resta);
    if (r === ESTOUROU) { emFundo(ctx, p); return null; }
    if (r) return r;
    // o voo era de outra requisição e caiu só porque a credencial dela foi recusada:
    // tenta com as desta, se sobrou alguma (durante a pausa, renovar devolve null na hora)
    if (!cs.some(credUsavel)) return null;
  }
  return null;
}

function renovar(cs: Cred[]): Promise<Lista | null> {
  if (voo) return voo;
  const agora = Date.now();
  if (centralPausada(agora)) return Promise.resolve(null);
  vooInicio = agora;
  const p = buscarLista(cs).then(
    (l) => { if (l) cache = l; return l; },
    () => { marcarFalha(); return null; },
  );
  voo = p;
  p.then(() => { if (voo === p) voo = null; });
  return p;
}

// Credencial recusada não pausa nada: ela fica de quarentena e as outras seguem valendo.
// Pausa (e espera zero) só quando a central falha: rede, tempo, 5xx, resposta ruim.
async function buscarLista(cs: Cred[]): Promise<Lista | null> {
  const r = await chamarCentral('GET', '/lista', '', cs, TEMPO_CENTRAL);
  if (r && r.recusada) return null;
  if (!r || !r.ok || !r.json || typeof r.json !== 'object') { marcarFalha(); return null; }
  return compilarLista(r.json);
}

function marcarFalha(): void {
  ultimaFalha = Date.now();
}

function centralPausada(agora: number): boolean {
  return agora - ultimaFalha < PAUSA_APOS_FALHA;
}

function compilarLista(d: any): Lista {
  const ttlS = Number(d.ttl);
  const l: Lista = {
    em: Date.now(),
    ttl: Number.isFinite(ttlS) && ttlS >= 5 && ttlS <= 300 ? ttlS * 1000 : TTL_LISTA,
    modo: d.modo === 'proteger' ? 'proteger' : 'observar',
    portal: typeof d.portal === 'string' && /^https:\/\/[^\s"'<>]+$/.test(d.portal) ? d.portal.replace(/\/+$/, '') : PORTAL_PADRAO,
    ipsBloq: new Map(), redesBloq: [], ja4Bloq: new Map(),
    ipsConf: new Set(), redesConf: [],
    sistema: null,
    jwks: Array.isArray(d.chaves) ? d.chaves.filter((k: any) => k && typeof k === 'object') : [],
    chaves: new Map(),
    sessoes: new Map(),
  };
  const empilhar = (m: Map<string, Bloq[]>, k: string, b: Bloq) => { const a = m.get(k); if (a) a.push(b); else m.set(k, [b]); };
  for (const x of Array.isArray(d.bloqueios) ? d.bloqueios : []) {
    try {
      if (!x || typeof x.v !== 'string') continue;
      const ate = x.ate ? Date.parse(x.ate) : null;
      const b: Bloq = {
        id: typeof x.id === 'number' ? x.id : null,
        n: x.n === 'suspeito' ? 'suspeito' : 'certo',
        ate: ate === null || Number.isNaN(ate) ? null : ate,
      };
      if (x.t === 'ja4') { empilhar(l.ja4Bloq, x.v.trim(), b); continue; }
      const r = lerRede(x.v);
      if (!r) continue;
      if (r.bits === (r.v === 4 ? 32 : 128)) empilhar(l.ipsBloq, r.v + ':' + r.rede.toString(16), b);
      else l.redesBloq.push({ r, b });
    } catch { /* ignora entrada ruim */ }
  }
  for (const x of Array.isArray(d.confiaveis) ? d.confiaveis : []) {
    try {
      if (!x || typeof x.v !== 'string') continue;
      const r = lerRede(x.v);
      if (!r) continue;
      if (r.bits === (r.v === 4 ? 32 : 128)) l.ipsConf.add(r.v + ':' + r.rede.toString(16));
      else l.redesConf.push(r);
    } catch { /* ignora */ }
  }
  const s = d.sistema;
  if (s && typeof s === 'object' && typeof s.projeto === 'string') {
    const proibidos: RegExp[] = [];
    for (const p of Array.isArray(s.arquivos_proibidos) ? s.arquivos_proibidos : []) {
      try { if (typeof p === 'string' && p) proibidos.push(new RegExp(p, 'i')); } catch { /* regex inválida */ }
    }
    l.sistema = {
      projeto: s.projeto,
      slug: typeof s.sistema_slug === 'string' && s.sistema_slug ? s.sistema_slug : null,
      exigeLogin: s.exige_login === true,
      rotas: Array.isArray(s.rotas_publicas) ? s.rotas_publicas.filter((x: any) => typeof x === 'string' && x) : [],
      proibidos,
    };
  }
  return l;
}

// Lista mínima do modo fechado: sem bloqueios nem confiáveis, só o exige_login e as chaves
// fixas. Nunca vai para o cache: a lista de verdade continua sendo buscada.
let reserva: Lista | null = null;
function listaReserva(f: Fechado): Lista {
  if (reserva && reserva.sistema && reserva.sistema.projeto === f.projeto) return reserva;
  const chaves = Array.isArray(f.chaves) && f.chaves.length ? f.chaves : CHAVES_FIXAS;
  reserva = {
    em: Date.now(), ttl: TTL_LISTA, modo: 'observar', portal: PORTAL_PADRAO,
    ipsBloq: new Map(), redesBloq: [], ja4Bloq: new Map(), ipsConf: new Set(), redesConf: [],
    sistema: {
      projeto: f.projeto, slug: f.slug, exigeLogin: true, proibidos: [],
      rotas: Array.isArray(f.rotas) ? f.rotas.filter((x: any) => typeof x === 'string' && x) : [],
    },
    jwks: chaves.filter((k: any) => k && typeof k === 'object'), chaves: new Map(), sessoes: new Map(),
  };
  return reserva;
}

function ehConfiavel(lista: Lista, ip: Ip): boolean {
  if (lista.ipsConf.has(chaveIp(ip))) return true;
  for (const r of lista.redesConf) if (contem(r, ip)) return true;
  return false;
}

function bloquearLocal(ip: Ip, agora: number): void {
  const k = chaveIp(ip);
  bloqLocal.delete(k);
  bloqLocal.set(k, agora + BLOQ_LOCAL_MS);
  limitar(bloqLocal, BLOQ_LOCAL_MAX);
}

/* =========================================================
   Sessão (cookie __Host-sentinela, JWT ES256)
   ========================================================= */
// invalida = o cookie existe mas não passa (assinatura, chave fora da lista, claims).
// Sessão só vencida não é inválida: aí o caminho certo é reabrir pelo portal.
async function lerSessao(h: Headers, lista: Lista | null, agora: number): Promise<{ email: string | null; invalida: boolean }> {
  const tok = lerCookie(h.get('cookie'), COOKIE_SESSAO);
  if (!tok || !lista || !lista.sistema) return { email: null, invalida: false };
  if (tok.length > 4096 || !lista.jwks.length) return { email: null, invalida: true };
  const c = lista.sessoes.get(tok);
  if (c) return resultadoSessao(c, agora);
  const p = await verificarJwt(tok, lista);
  const proj = lista.sistema.projeto;
  let email: string | null = null;
  let exp = 0;
  if (p && p.iss === 'sentinela-lube' && p.typ === 'sessao' && typeof p.exp === 'number' &&
      (p.aud === proj || (Array.isArray(p.aud) && p.aud.indexOf(proj) >= 0)) &&
      typeof p.email === 'string' && p.email &&
      !(typeof p.iat === 'number' && p.iat * 1000 > agora + 300000)) {
    email = p.email.slice(0, 200);
    exp = p.exp;
  }
  if (lista.sessoes.size >= SESSOES_MAX) lista.sessoes.clear();
  const s = { email, exp };
  lista.sessoes.set(tok, s);
  return resultadoSessao(s, agora);
}

function resultadoSessao(s: { email: string | null; exp: number }, agora: number): { email: string | null; invalida: boolean } {
  if (!s.email) return { email: null, invalida: true };
  return s.exp * 1000 > agora ? { email: s.email, invalida: false } : { email: null, invalida: false };
}

async function verificarJwt(tok: string, lista: Lista): Promise<any | null> {
  const partes = tok.split('.');
  if (partes.length !== 3) return null;
  const cab = jsonB64(partes[0]);
  if (!cab || cab.alg !== 'ES256') return null;
  const sig = b64urlBytes(partes[2]);
  if (!sig || sig.byteLength !== 64) return null;   // JWS ES256 = r||s, 32 + 32 bytes
  const dados = new TextEncoder().encode(partes[0] + '.' + partes[1]);
  const candidatas = typeof cab.kid === 'string'
    ? lista.jwks.filter((k) => k.kid === cab.kid)
    : lista.jwks;
  for (const jwk of candidatas) {
    const chave = await importarChave(lista, jwk);
    if (!chave) continue;
    let ok = false;
    try { ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, chave, sig, dados); } catch { ok = false; }
    if (ok) return jsonB64(partes[1]);
  }
  return null;
}

function importarChave(lista: Lista, jwk: any): Promise<CryptoKey | null> {
  const id = String(jwk.kid || '') + '|' + String(jwk.x || '');
  let p = lista.chaves.get(id);
  if (!p) {
    p = (async () => {
      if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return null;
      try {
        return await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true },
          { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      } catch { return null; }
    })();
    lista.chaves.set(id, p);
  }
  return p;
}

/* =========================================================
   Central: credencial, assinatura, chamadas
   ========================================================= */
function lerEnv(): { oidc?: string; chave?: string; projeto?: string; ambiente?: string } {
  try {
    // Referências literais a process.env.X: o Next só entrega ao middleware as variáveis que vê escritas assim.
    if (typeof process === 'undefined' || !process || !process.env) return {};
    return {
      oidc: process.env.VERCEL_OIDC_TOKEN,
      chave: process.env.SENTINELA_CHAVE,
      projeto: process.env.SENTINELA_PROJETO,
      ambiente: process.env.VERCEL_ENV,
    };
  } catch {
    return {};
  }
}

// Ordem: primeiro o que o visitante não controla (token que a central já aceitou,
// VERCEL_OIDC_TOKEN, HMAC do plano B); por último o token que vem na requisição
// (request-context e header, que podem ser forjados). O guarda não verifica a
// assinatura RS256: quem decide é a central. Um token que ela recusa fica de
// quarentena e a chamada segue com o próximo; nada disso pausa a lista dos outros.
function credenciais(request: Request): Cred[] {
  const agora = Date.now();
  const env = lerEnv();
  const cs: Cred[] = [];
  const vistos = new Set<string>();
  const oidc = (v: unknown) => {
    if (typeof v !== 'string' || !v) return;
    // header repetido chega como "a, b": cada parte é um candidato
    for (const parte of v.split(',').slice(0, 3)) {
      const t = parte.trim();
      if (!t || vistos.has(t)) continue;
      vistos.add(t);
      const exp = oidcExp(t);
      if (exp > agora + 5000 && tokenUsavel(t, agora)) cs.push({ tipo: 'oidc', token: t, exp });
    }
  };
  if (oidcAceito && oidcAceito.exp > agora + 5000) oidc(oidcAceito.token);
  oidc(env.oidc);
  if (env.chave && env.projeto && hmacRecusadoAte <= agora) {
    cs.push({ tipo: 'hmac', chave: env.chave, projeto: env.projeto, ambiente: env.ambiente || 'production' });
  }
  try {
    const rc = (globalThis as any)[Symbol.for('@vercel/request-context')];
    const c = rc && typeof rc.get === 'function' ? rc.get() : null;
    oidc(c && c.headers ? c.headers['x-vercel-oidc-token'] : null);
  } catch { /* segue */ }
  try { oidc(request.headers.get('x-vercel-oidc-token')); } catch { /* segue */ }
  return cs;
}

// exp (ms) de um token com emissor e time da Lube; 0 se não servir. Só lê o payload.
function oidcExp(t: string): number {
  if (t.length > 8192) return 0;
  const c = plausiveis.get(t);
  if (c !== undefined) return c;
  const partes = t.split('.');
  const p = partes.length === 3 ? jsonB64(partes[1]) : null;
  const exp = p && p.iss === OIDC_ISS && p.owner_id === TEAM_ID && typeof p.exp === 'number' && Number.isFinite(p.exp) ? p.exp * 1000 : 0;
  if (plausiveis.size >= 100) plausiveis.clear();
  plausiveis.set(t, exp);
  return exp;
}

function tokenUsavel(t: string, agora: number): boolean {
  const ate = recusados.get(t);
  return !(ate && ate > agora);
}

function credUsavel(c: Cred): boolean {
  const agora = Date.now();
  return c.tipo === 'oidc' ? c.exp > agora + 5000 && tokenUsavel(c.token, agora) : hmacRecusadoAte <= agora;
}

function recusar(c: Cred): void {
  const agora = Date.now();
  if (c.tipo === 'hmac') { hmacRecusadoAte = agora + RECUSA_HMAC_MS; return; }
  recusados.delete(c.token);
  recusados.set(c.token, agora + RECUSA_MS);
  limitar(recusados, 200);
  if (oidcAceito && oidcAceito.token === c.token) oidcAceito = null;
}

function aceitar(c: Cred): void {
  if (c.tipo === 'oidc' && (!oidcAceito || oidcAceito.token !== c.token)) oidcAceito = { token: c.token, exp: c.exp };
}

// 401/403 da central que não seja "passe_invalido" = esta credencial não serve.
function credRecusada(r: Resp): boolean {
  return (r.status === 401 || r.status === 403) && !(r.json && r.json.erro === 'passe_invalido');
}

async function cabecalhos(cred: Cred, corpo: string): Promise<Record<string, string>> {
  const h: Record<string, string> = { 'x-sentinela-guarda': VERSAO, 'x-sentinela-runtime': RUNTIME };
  if (cred.tipo === 'oidc') {
    h.authorization = 'Bearer ' + cred.token;
  } else {
    const t = Math.floor(Date.now() / 1000);
    h['x-sentinela-assinatura'] = 't=' + t + ',v1=' + (await hmacHex(cred.chave, t + '.' + corpo));
    h['x-sentinela-projeto'] = cred.projeto;
    h['x-sentinela-ambiente'] = cred.ambiente;
  }
  return h;
}

// Tenta as credenciais na ordem, dentro de um único prazo. null = rede ou tempo
// (trocar de credencial não ajuda); recusada = todas recusadas.
async function chamarCentral(metodo: 'GET' | 'POST', rota: string, corpo: string, cs: Cred[], ms: number): Promise<Resp | null> {
  const fim = Date.now() + ms;
  for (const c of cs) {
    if (!credUsavel(c)) continue;
    const resta = fim - Date.now();
    if (resta <= 0) return null;
    const r = await chamarUma(metodo, rota, corpo, c, resta);
    if (!r) return null;
    if (credRecusada(r)) { recusar(c); continue; }
    if (r.ok) aceitar(c);
    return r;
  }
  return { ok: false, status: 401, json: null, recusada: true };
}

async function chamarUma(metodo: 'GET' | 'POST', rota: string, corpo: string, cred: Cred, ms: number): Promise<Resp | null> {
  let ctrl: AbortController | null = null;
  try { ctrl = new AbortController(); } catch { ctrl = null; }
  const p = (async () => {
    const headers = await cabecalhos(cred, corpo);
    if (metodo === 'POST') headers['content-type'] = 'application/json';
    const init: RequestInit = { method: metodo, headers };
    if (metodo === 'POST') init.body = corpo;
    if (ctrl) init.signal = ctrl.signal;
    const r = await fetch(CENTRAL + rota, init);
    const txt = await r.text();
    let json: any = null;
    try { json = txt ? JSON.parse(txt) : null; } catch { json = null; }
    return { ok: r.ok, status: r.status, json };
  })().catch(() => null);
  const r = await comLimite(p, ms);
  if (r === ESTOUROU) {
    try { if (ctrl) ctrl.abort(); } catch { /* segue */ }
    return null;
  }
  return r;
}

/* ---------- registro ---------- */
// Dedupe de 5 s; por IP, os primeiros EVENTOS_DIRETOS_IP_MIN do minuto saem na hora e o
// resto vai em lotes de até 20 (a central conta todos para a rajada e os descartados).
// Com a central em pausa, ou sem credencial boa nesta requisição (só token de quarentena),
// o evento espera na fila (limitada) e sai com a próxima requisição que puder enviar.
// Instância sem credencial nenhuma nunca envia (§4.9: não registra).
function registrar(ev: Evento, cs: Cred[], ctx: Ctx | undefined): void {
  try {
    if (!ev.ip) return;
    const agora = Date.now();
    const k = ev.ip + '|' + ev.caminho + '|' + ev.decisao;
    const ate = dedupe.get(k);
    if (ate && ate > agora) return;
    dedupe.delete(k);
    dedupe.set(k, agora + DEDUPE_MS);
    limitar(dedupe, DEDUPE_MAX);

    let c = porIp.get(ev.ip);
    if (!c || c.ate <= agora) {
      porIp.delete(ev.ip);
      c = { ate: agora + 60000, n: 0, bloq: false };
      porIp.set(ev.ip, c);
      limitar(porIp, CONTADORES_MAX);
    }
    c.n++;
    // o 1º bloqueio do IP no minuto sempre sai na hora: é ele que gera o bloqueio central
    const primeiroBloqueio = ev.decisao === 'bloqueado' && !c.bloq;
    if (ev.decisao === 'bloqueado') c.bloq = true;
    const s = JSON.stringify(ev);
    const item: ItemFila = { s, b: bytesUtf8(s), em: agora };
    const pode = podeEnviar(cs, agora);
    if (pode && (c.n <= EVENTOS_DIRETOS_IP_MIN || primeiroBloqueio)) enviar([item], cs, ctx);
    else enfileirar([item], false);
    if (pode) esvaziarFila(cs, ctx, agora);
  } catch { /* registro nunca derruba a requisição */ }
}

// na frente = lote que a central recusou por credencial (não processou): volta primeiro
function enfileirar(itens: ItemFila[], naFrente: boolean): void {
  fila = naFrente ? itens.concat(fila) : fila.concat(itens);
  if (fila.length > FILA_MAX) fila.splice(0, fila.length - FILA_MAX);
}

function podeEnviar(cs: Cred[], agora: number): boolean {
  return !centralPausada(agora) && cs.some(credUsavel);
}

function esvaziarFila(cs: Cred[], ctx: Ctx | undefined, agora: number): void {
  if (!fila.length) return;
  while (fila.length && (fila.length >= LOTE_MAX || agora - fila[0].em >= FILA_IDADE)) {
    const lote: ItemFila[] = [];
    let bytes = 16;
    while (fila.length && lote.length < LOTE_MAX && (lote.length === 0 || bytes + fila[0].b + 1 <= LOTE_BYTES)) {
      const x = fila.shift() as ItemFila;
      lote.push(x);
      bytes += x.b + 1;
    }
    enviar(lote, cs, ctx);
  }
}

// /evento que falha por rede, tempo, 5xx ou 429 liga a mesma pausa da lista (disjuntor).
// Todas as credenciais recusadas: o lote volta para a fila (sai com quem tiver credencial boa).
function enviar(lote: ItemFila[], cs: Cred[], ctx: Ctx | undefined): void {
  const corpo = '{"eventos":[' + lote.map((x) => x.s).join(',') + ']}';
  const p = chamarCentral('POST', '/evento', corpo, cs, TEMPO_CENTRAL).then(
    (r) => {
      if (r && r.recusada) enfileirar(lote, true);
      else if (!r || (!r.ok && (r.status >= 500 || r.status === 429))) marcarFalha();
    },
    () => { marcarFalha(); },
  );
  emFundo(ctx, p);
}

function emFundo(ctx: Ctx | undefined, p: Promise<unknown>): void {
  try { if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p.catch(() => undefined)); } catch { /* segue */ }
}

/* =========================================================
   Coleta do evento
   ========================================================= */
function coletar(h: Headers, url: URL, metodo: string, tipo: Tipo, ip: string, consulta: string, ua: string, agora: number): Evento {
  let referer: string | null = null;
  const ref = h.get('referer');
  if (ref) { try { const o = new URL(ref).origin; referer = o && o !== 'null' ? o.slice(0, 120) : null; } catch { referer = null; } }
  return {
    ts: new Date(agora).toISOString(),
    metodo: metodo.slice(0, 10),
    host: url.host.slice(0, 200),
    caminho: corta(url.pathname, 300) as string,
    consulta,
    tipo,
    ip,
    pais: corta(h.get('x-vercel-ip-country'), 8),
    regiao: corta(h.get('x-vercel-ip-country-region'), 80),
    cidade: corta(decodificarSeguro(h.get('x-vercel-ip-city')), 80),
    lat: numero(h.get('x-vercel-ip-latitude')),
    lon: numero(h.get('x-vercel-ip-longitude')),
    fuso: corta(h.get('x-vercel-ip-timezone'), 60),
    ua: ua ? ua.slice(0, 300) : null,
    idioma: corta(h.get('accept-language'), 60),
    referer,
    ja4: corta(h.get('x-vercel-ja4-digest'), 120),
    vercel_id: corta(h.get('x-vercel-id'), 120),
    sec_fetch_site: corta(h.get('sec-fetch-site'), 40),
    sec_fetch_mode: corta(h.get('sec-fetch-mode'), 40),
    sec_fetch_dest: corta(h.get('sec-fetch-dest'), 40),
    decisao: 'liberado',
    regra: null,
    motivo: null,
    identidade: null,
    identidade_origem: null,
  };
}

function ipCliente(h: Headers): string {
  const real = (h.get('x-real-ip') || '').trim();
  if (real) return real;
  const vf = (h.get('x-vercel-forwarded-for') || '').split(',')[0].trim();
  if (vf) return vf;
  return (h.get('x-forwarded-for') || '').split(',')[0].trim();
}

function tipoDe(caminho: string): Tipo {
  if (caminho === '/api' || caminho.startsWith('/api/')) return 'api';
  const ultimo = caminho.slice(caminho.lastIndexOf('/') + 1);
  const m = /\.([a-z0-9]{1,10})$/i.exec(ultimo);
  if (m && !/^html?$/i.test(m[1])) return 'arquivo';
  return 'pagina';
}

/* ---------- consulta ---------- */
function separarPasse(search: string): { valor: string; resto: string } | null {
  if (!search || search.indexOf(PARAM_PASSE) < 0) return null;
  let valor: string | null = null;
  const resto: string[] = [];
  for (const parte of search.slice(1).split('&')) {
    const i = parte.indexOf('=');
    const nome = decodificarSeguro(i < 0 ? parte : parte.slice(0, i));
    if (nome === PARAM_PASSE) {
      if (valor === null) valor = decodificarSeguro(i < 0 ? '' : parte.slice(i + 1)) || '';
    } else if (parte) {
      resto.push(parte);
    }
  }
  if (valor === null) return null;
  return { valor, resto: resto.length ? '?' + resto.join('&') : '' };
}

function semPasse(consulta: string): string {
  const p = separarPasse(consulta);
  return p ? p.resto : consulta;
}

function redigirConsulta(consulta: string): string {
  if (!consulta || consulta.length < 2) return consulta || '';
  const partes = consulta.slice(1).split('&').map((parte) => {
    const i = parte.indexOf('=');
    if (i < 0) return parte;
    return RE_PARAM_SENSIVEL.test(decodificarSeguro(parte.slice(0, i)) || '') ? parte.slice(0, i) + '=***' : parte;
  });
  return '?' + partes.join('&');
}

/* =========================================================
   IP e redes (IPv4/IPv6 com BigInt)
   ========================================================= */
function lerIp(txt: string): Ip | null {
  let s = (txt || '').trim();
  if (!s || s.length > 64) return null;
  if (s[0] === '[') { const f = s.indexOf(']'); if (f < 0) return null; s = s.slice(1, f); }
  const z = s.indexOf('%');
  if (z >= 0) s = s.slice(0, z);
  if (s.indexOf(':') < 0) {
    const n = lerIpv4(s);
    return n === null ? null : { v: 4, n };
  }
  return lerIpv6(s);
}

// BigInt(…) em vez de literais 0n: o tsconfig padrão do Next mira ES2017.
const B0 = BigInt(0), B8 = BigInt(8), B16 = BigInt(16), B32 = BigInt(32);
const B_FFFF = BigInt(0xffff), B_MASK32 = BigInt(0xffffffff);

function lerIpv4(s: string): bigint | null {
  const p = s.split('.');
  if (p.length !== 4) return null;
  let n = B0;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x)) return null;
    const k = Number(x);
    if (k > 255) return null;
    n = (n << B8) | BigInt(k);
  }
  return n;
}

function lerIpv6(s: string): Ip | null {
  let txt = s;
  const extra: number[] = [];
  const ult = s.lastIndexOf(':');
  if (s.indexOf('.', ult) >= 0) {
    const v4 = lerIpv4(s.slice(ult + 1));
    if (v4 === null) return null;
    const k = Number(v4);
    extra.push(Math.floor(k / 65536), k % 65536);
    txt = s.slice(0, ult + 1);
    if (!txt.endsWith('::')) txt = txt.slice(0, -1);
  }
  const duplo = txt.split('::');
  if (duplo.length > 2) return null;
  const grupos = (t: string) => (t === '' ? [] : t.split(':'));
  const esq = grupos(duplo[0]);
  const dir = duplo.length === 2 ? grupos(duplo[1]) : [];
  for (const g of esq.concat(dir)) if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
  const total = esq.length + dir.length + extra.length;
  if (duplo.length === 1 ? total !== 8 : total > 7) return null;
  const todos: number[] = esq.map((g) => parseInt(g, 16));
  for (let i = 0; i < (duplo.length === 2 ? 8 - total : 0); i++) todos.push(0);
  for (const g of dir) todos.push(parseInt(g, 16));
  for (const g of extra) todos.push(g);
  let n = B0;
  for (const g of todos) n = (n << B16) | BigInt(g);
  if ((n >> B32) === B_FFFF) return { v: 4, n: n & B_MASK32 };   // ::ffff:a.b.c.d vira IPv4
  return { v: 6, n };
}

function lerRede(txt: string): Rede | null {
  const s = txt.trim();
  const i = s.indexOf('/');
  const ip = lerIp(i < 0 ? s : s.slice(0, i));
  if (!ip) return null;
  const L = ip.v === 4 ? 32 : 128;
  let bits = L;
  if (i >= 0) {
    const b = s.slice(i + 1);
    if (!/^\d{1,3}$/.test(b)) return null;
    bits = Number(b);
    if (ip.v === 4 && s.slice(0, i).indexOf(':') >= 0) bits -= 96;   // ::ffff:a.b.c.d/1xx
    if (bits < 0 || bits > L) return null;
  }
  return { v: ip.v, rede: ip.n >> BigInt(L - bits), bits };
}

function contem(r: Rede, ip: Ip): boolean {
  return r.v === ip.v && (ip.n >> BigInt((r.v === 4 ? 32 : 128) - r.bits)) === r.rede;
}

function chaveIp(ip: Ip): string {
  return ip.v + ':' + ip.n.toString(16);
}

/* =========================================================
   Utilidades
   ========================================================= */
const ESTOUROU: unique symbol = Symbol('estourou');

// tira as chaves mais antigas (ordem de inserção) até caber
function limitar(m: Map<string, unknown>, max: number): void {
  while (m.size > max) {
    const primeira = m.keys().next().value;
    if (primeira === undefined) break;
    m.delete(primeira);
  }
}

function bytesUtf8(s: string): number {
  try { return new TextEncoder().encode(s).length; } catch { return s.length * 3; }
}

function comLimite<T>(p: Promise<T>, ms: number): Promise<T | typeof ESTOUROU> {
  let timer: any = null;
  const t = new Promise<typeof ESTOUROU>((res) => { timer = setTimeout(() => res(ESTOUROU), ms); });
  return Promise.race([p, t]).then((r) => { if (timer !== null) clearTimeout(timer); return r; });
}

// Decodifica até 3 vezes (pega %252e%252e); sequência inválida cai byte a byte.
function decodificar(s: string): string {
  let atual = s || '';
  for (let i = 0; i < 3 && atual.indexOf('%') >= 0; i++) {
    let prox: string;
    try { prox = decodeURIComponent(atual); } catch {
      prox = atual.replace(/%([0-9a-f]{2})/gi, (_m, hx: string) => String.fromCharCode(parseInt(hx, 16)));
    }
    if (prox === atual) break;
    atual = prox;
  }
  return atual;
}

function decodificarSeguro(s: string | null): string | null {
  if (s == null) return null;
  try { return decodeURIComponent(s); } catch { return s; }
}

function normalizarCaminho(s: string): string {
  return s.replace(/\/{2,}/g, '/');
}

function corta(s: string | null | undefined, n: number): string | null {
  if (s == null) return null;
  const t = String(s);
  return t.length > n ? t.slice(0, n) : t;
}

function numero(v: string | null): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function lerCookie(h: string | null, nome: string): string | null {
  if (!h) return null;
  for (const parte of h.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    if (parte.slice(0, i).trim() === nome) return parte.slice(i + 1).trim() || null;
  }
  return null;
}

function b64urlBytes(s: string): ArrayBuffer | null {
  try {
    if (!/^[\w-]*$/.test(s)) return null;
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    const bin = atob(b64);
    const buf = new ArrayBuffer(bin.length);
    const out = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return buf;
  } catch {
    return null;
  }
}

function jsonB64(s: string): any | null {
  const b = b64urlBytes(s);
  if (!b) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(b));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function hex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s;
}

async function sha256Hex(txt: string): Promise<string> {
  try {
    return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt)));
  } catch {
    return '00000000';
  }
}

async function hmacHex(chave: string, txt: string): Promise<string> {
  if (!hmacCache || hmacCache.chave !== chave) {
    hmacCache = {
      chave,
      key: crypto.subtle.importKey('raw', new TextEncoder().encode(chave), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    };
  }
  return hex(await crypto.subtle.sign('HMAC', await hmacCache.key, new TextEncoder().encode(txt)));
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}
