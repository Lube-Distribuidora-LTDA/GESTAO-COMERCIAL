/* =============================================================================
 * Central Comercial — painel do BI COMERCIAL da Lube Distribuidora
 *
 * Todo o conteúdo vem de /api/dados (que chama comercial.painel_dados no
 * Supabase) e, para as listas grandes, de /api/detalhe. Nenhuma regra de
 * negócio é inventada aqui: a régua da comissão chega no payload, vinda da
 * tabela comercial.dim_faixa_comissao.
 *
 * Sobre os gráficos, por que são assim:
 *   · nunca dois eixos no mesmo desenho — quando há duas medidas de escalas
 *     diferentes (dinheiro e percentual), viram dois desenhos empilhados,
 *     compartilhando o mesmo eixo de tempo;
 *   · cor de dado ≠ cor de estado: as quatro cores de série foram validadas
 *     contra este fundo (faixa de luminosidade, croma, daltonismo, contraste);
 *     verde/âmbar/vermelho ficam reservados para "bom / atenção / alerta";
 *   · texto nunca veste a cor da série: quem carrega identidade é a marca
 *     colorida ao lado;
 *   · todo gráfico tem rótulo de dado onde ele cabe — e some quando não cabe,
 *     em vez de virar sopa de dígitos sobrepostos.
 * ========================================================================== */
(function () {
"use strict";

/* ---------------------------------------------------------------------------
 * Estado
 * ------------------------------------------------------------------------ */
var D = null;
var carregandoPeriodo = false;
var ULTIMOS = {};              /* último valor de cada número, para animar a troca */

var E = {
  pagina: "comissao",
  de: null, ate: null,
  filiais: null,
  supervisor: "",
  busca: "",
  grao: "rca",
  colunas: "essencial",        /* "essencial" | "completo" */
  limiteMargem: 5,
  limitePedido: 20,
  posicoes: null,
  soMotivoRca: false,
  motivo: "",
  ordem: {}, pag: {}, porPagina: {}
};

var PAGINAS = [
  { id: "comissao",  nome: "Comissão por RCA",  icone: "M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" },
  { id: "margem",    nome: "Margem por item",   icone: "M3 3v18h18M7 15l4-4 3 3 5-6" },
  { id: "pedidos",   nome: "Pedidos em aberto", icone: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" },
  { id: "devolucao", nome: "Devoluções",        icone: "M3 10h11a4 4 0 1 1 0 8h-1M3 10l4-4M3 10l4 4" }
];

/* ---------------------------------------------------------------------------
 * Formatadores — sempre em padrão brasileiro
 * ------------------------------------------------------------------------ */
var MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
var MESES_LONGO = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho",
                   "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

function n(v) { return v == null ? 0 : Number(v); }
function fInt(v) { return Math.round(n(v)).toLocaleString("pt-BR"); }
function fNum(v, d) { return v == null ? "—" : Number(v).toLocaleString("pt-BR", { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d }); }
function fR$(v) { return n(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
function fR$0(v) { return n(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }); }
function fPct(v, casas) { return v == null ? "—" : Number(v).toLocaleString("pt-BR", { minimumFractionDigits: casas == null ? 2 : casas, maximumFractionDigits: casas == null ? 2 : casas }) + "%"; }
function fCurto(v) {
  var a = Math.abs(n(v));
  if (a >= 1e9) return "R$ " + fNum(v / 1e9, 2) + " bi";
  if (a >= 1e6) return "R$ " + fNum(v / 1e6, 2) + " mi";
  if (a >= 1e3) return "R$ " + fNum(v / 1e3, 1) + " mil";
  return fR$0(v);
}
function fCurtoSemMoeda(v) {
  var a = Math.abs(n(v));
  if (a >= 1e9) return fNum(v / 1e9, 2) + " bi";
  if (a >= 1e6) return fNum(v / 1e6, 1) + " mi";
  if (a >= 1e3) return fNum(v / 1e3, 0) + " mil";
  return fNum(v, 0);
}
function fData(s) {
  if (!s) return "—";
  var d = String(s).slice(0, 10).split("-");
  return d.length === 3 ? d[2] + "/" + d[1] + "/" + d[0] : String(s);
}
function fDataHora(s) {
  if (!s) return "—";
  var d = new Date(s);
  return isNaN(d) ? "—" : d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}
function rotuloMes(m) { var p = String(m).split("-"); return MESES[+p[1] - 1] + "/" + p[0].slice(2); }
function hoje() { return new Date().toISOString().slice(0, 10); }
function primeiroDiaDoMes(iso) { return String(iso).slice(0, 8) + "01"; }

/* ---------------------------------------------------------------------------
 * DOM
 * ------------------------------------------------------------------------ */
function el(tag, cls, txt) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}
function svgEl(tag, attrs) {
  var e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (var k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
function limpar(e) { while (e.firstChild) e.removeChild(e.firstChild); return e; }
var semMovimento = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Sobe o número de onde ele estava até onde chegou. Sem valor anterior, sobe
   de zero — é o que dá a sensação de o painel contar o dinheiro na sua frente. */
function animarNumero(alvo, chave, valor, formatar) {
  var anterior = ULTIMOS[chave];
  ULTIMOS[chave] = valor;
  if (semMovimento || valor == null || isNaN(valor)) { alvo.textContent = formatar(valor); return; }
  var de = (anterior == null || isNaN(anterior)) ? 0 : anterior;
  if (de === valor) { alvo.textContent = formatar(valor); return; }
  var t0 = null, dur = 900;
  function passo(agora) {
    if (t0 == null) t0 = agora;
    var p = Math.min(1, (agora - t0) / dur);
    var suave = 1 - Math.pow(1 - p, 4);
    alvo.textContent = formatar(de + (valor - de) * suave);
    if (p < 1) requestAnimationFrame(passo);
  }
  requestAnimationFrame(passo);
}

/* ---------------------------------------------------------------------------
 * Nomes
 * ------------------------------------------------------------------------ */
function nomeRca(cod) {
  var r = D.rcas[cod] || D.rcas[String(cod)];
  return r ? r[0] : "RCA " + cod;
}
function supervisorDoRca(cod) {
  var r = D.rcas[cod] || D.rcas[String(cod)];
  return r ? r[1] : null;
}
function nomeSupervisor(cod) { return D.supervisores[cod] || D.supervisores[String(cod)] || "—"; }
function nomeCliente(cod) { return D.clientes[cod] || D.clientes[String(cod)] || ("Cliente " + cod); }
function nomeProduto(cod) { return D.produtos[cod] || D.produtos[String(cod)] || ("Produto " + cod); }
var MOTIVO_MAPA = {};
function motivoDe(cod) { var m = MOTIVO_MAPA[cod]; return m ? m[0] : "—"; }

/* ---------------------------------------------------------------------------
 * A régua da comissão — vem do banco, não está escrita aqui
 * ------------------------------------------------------------------------ */
function percComissao(margemPerc) {
  var p = (margemPerc == null || isNaN(margemPerc)) ? -999999 : margemPerc;
  for (var i = 0; i < D.faixas.length; i++) {
    var f = D.faixas[i];
    if (p >= n(f[0]) && (f[1] == null || p < n(f[1]))) return n(f[2]) / 100;
  }
  return 0;
}

/* Soma os componentes e aplica a faixa UMA vez, no grão pedido.
 * É esta função, e só ela, que decide quanto um RCA recebe. */
function calcular(c) {
  var totalLiquido = c.venda - c.devSt;
  var totalLiquidoSst = c.venda - c.devSst;
  var cmvLiquido = c.cmvVenda - c.cmvDev + c.descfin + c.cmvBonif - c.st;
  var massa = totalLiquidoSst - cmvLiquido;
  var perc = totalLiquidoSst ? (massa / totalLiquidoSst) * 100 : null;
  var faixa = percComissao(perc);
  return {
    venda: c.venda, devSt: c.devSt, st: c.st, cmvVenda: c.cmvVenda, cmvDev: c.cmvDev,
    cmvBonif: c.cmvBonif, descfin: c.descfin, descfinOrig: c.descfinOrig,
    notas: c.notas, pedidos: c.pedidos, clientes: c.clientes,
    totalLiquido: totalLiquido, totalLiquidoSst: totalLiquidoSst,
    cmvLiquido: cmvLiquido, massa: massa, perc: perc,
    faixa: faixa, comissao: totalLiquido * faixa
  };
}
function componentesVazios() {
  return { venda: 0, devSt: 0, devSst: 0, cmvVenda: 0, cmvDev: 0, cmvBonif: 0,
           descfin: 0, descfinOrig: 0, st: 0, notas: 0, pedidos: 0, clientes: 0 };
}
function somar(acc, linha) {
  acc.notas += n(linha[2]); acc.clientes += n(linha[3]); acc.pedidos += n(linha[4]);
  acc.venda += n(linha[5]); acc.devSt += n(linha[6]); acc.devSst += n(linha[7]);
  acc.cmvVenda += n(linha[8]); acc.cmvDev += n(linha[9]); acc.cmvBonif += n(linha[10]);
  acc.descfin += n(linha[11]); acc.descfinOrig += n(linha[12]); acc.st += n(linha[13]);
  return acc;
}

/* ---------------------------------------------------------------------------
 * Filtros
 * ------------------------------------------------------------------------ */
function filiaisDisponiveis() {
  var s = {};
  (D.comissao.rca || []).forEach(function (l) { s[l[1]] = 1; });
  return Object.keys(s).map(Number).sort(function (a, b) { return a - b; });
}
function passaFiltroRca(codusur, codfilial) {
  if (E.filiais && codfilial != null && !E.filiais.has(Number(codfilial))) return false;
  if (E.supervisor && String(supervisorDoRca(codusur)) !== String(E.supervisor)) return false;
  if (E.busca) {
    var alvo = (codusur + " " + nomeRca(codusur)).toLowerCase();
    if (alvo.indexOf(E.busca) === -1) return false;
  }
  return true;
}

/* ---------------------------------------------------------------------------
 * Componentes
 * ------------------------------------------------------------------------ */

/* O número que a página lidera, com o contexto ao lado. */
function heroi(cfg) {
  var g = el("div", "heroi sobe");
  var card = el("div", "heroi-card");
  card.appendChild(el("div", "rot", cfg.rotulo));
  var v = el("div", "valor");
  card.appendChild(v);
  animarNumero(v, "heroi_" + E.pagina, cfg.valor, cfg.formatar || fCurto);
  if (cfg.sub) {
    var s = el("div", "sub");
    s.innerHTML = cfg.sub;
    card.appendChild(s);
  }
  g.appendChild(card);
  var lado = el("div", "heroi-lado");
  blocoKpis(cfg.kpis, lado);
  g.appendChild(lado);
  return g;
}

function blocoKpis(defs, destino) {
  var g = destino || el("div", "kpis");
  defs.forEach(function (d, i) {
    var k = el("div", "kpi sobe " + (d.tom || ""));
    k.style.animationDelay = Math.min(i * 45, 320) + "ms";
    var lbl = el("div", "lbl");
    lbl.appendChild(document.createTextNode(d.rotulo));
    if (d.ajuda) {
      var a = el("span", "ajuda", "?"); a.tabIndex = 0;
      a.appendChild(el("span", "tip", d.ajuda));
      lbl.appendChild(a);
    }
    k.appendChild(lbl);
    var v = el("div", "val");
    if (d.numero != null && d.formatar) {
      animarNumero(v, E.pagina + "_" + d.rotulo, d.numero, d.formatar);
    } else {
      v.textContent = d.valor;
    }
    if (d.titulo) v.title = d.titulo;
    k.appendChild(v);
    if (d.sub) k.appendChild(el("div", "sub", d.sub));
    g.appendChild(k);
  });
  return g;
}

function painel(titulo, sub, acoes) {
  var p = el("section", "painel sobe");
  var cab = el("div", "painel-head");
  var esq = el("div");
  esq.appendChild(el("h2", null, titulo));
  if (sub) esq.appendChild(el("div", "sub", sub));
  cab.appendChild(esq);
  if (acoes) cab.appendChild(acoes);
  p.appendChild(cab);
  var corpo = el("div", "painel-corpo");
  p.appendChild(corpo);
  p.corpo = corpo;
  return p;
}

function nota(texto, tom) {
  var d = el("div", "nota " + (tom || ""));
  d.appendChild(el("span", "ic", tom === "grave" || tom === "atencao" ? "!" : "i"));
  var p = el("div");
  p.innerHTML = texto;
  d.appendChild(p);
  return d;
}

function chips(rotulo, opcoes, atual, aoEscolher, tom) {
  var g = el("div", "fgrupo");
  if (rotulo) g.appendChild(el("span", "frot", rotulo));
  opcoes.forEach(function (o) {
    var b = el("button", "chip" + (String(o.valor) === String(atual) ? " on " + (tom || "") : ""), o.rotulo);
    b.type = "button";
    b.addEventListener("click", function () { aoEscolher(o.valor); });
    g.appendChild(b);
  });
  return g;
}

function chipsMultiplos(rotulo, opcoes, conjunto, aoMudar) {
  var g = el("div", "fgrupo");
  g.appendChild(el("span", "frot", rotulo));
  var todos = el("button", "chip" + (conjunto == null ? " on" : ""), "Todas");
  todos.type = "button";
  todos.addEventListener("click", function () { aoMudar(null); });
  g.appendChild(todos);
  opcoes.forEach(function (o) {
    var ligado = conjunto != null && conjunto.has(o.valor);
    var b = el("button", "chip" + (ligado ? " on" : ""), o.rotulo);
    b.type = "button";
    b.addEventListener("click", function () {
      /* Estando em "Todas", clicar numa opção seleciona SÓ ela — que é o que
         se espera ao clicar em "Filial 1". A versão anterior partia do
         conjunto cheio e removia a clicada, acendendo as outras três e
         deixando justamente a escolhida apagada. A partir daí, cada clique
         acrescenta ou tira; esvaziar a seleção volta para "Todas". */
      var novo;
      if (conjunto == null) {
        novo = new Set([o.valor]);
      } else {
        novo = new Set(conjunto);
        if (novo.has(o.valor)) novo.delete(o.valor); else novo.add(o.valor);
      }
      aoMudar(novo.size === 0 || novo.size === opcoes.length ? null : novo);
    });
    g.appendChild(b);
  });
  return g;
}

function campoBusca(placeholder) {
  var b = el("div", "busca");
  var i = el("input");
  i.type = "search"; i.placeholder = placeholder; i.value = E.busca;
  i.addEventListener("input", function () { E.busca = i.value.trim().toLowerCase(); desenhar(true); });
  var l = el("button", "btn-limpar", "Limpar filtros");
  l.type = "button";
  l.addEventListener("click", function () {
    E.busca = ""; E.filiais = null; E.supervisor = ""; E.posicoes = null;
    E.motivo = ""; E.soMotivoRca = false; desenhar();
  });
  b.appendChild(i); b.appendChild(l);
  return b;
}

function seletorSupervisor() {
  var g = el("div", "fgrupo");
  g.appendChild(el("span", "frot", "Supervisor"));
  var s = el("select");
  var op = el("option", null, "Todos"); op.value = ""; s.appendChild(op);
  Object.keys(D.supervisores)
    .map(function (k) { return { cod: k, nome: D.supervisores[k] }; })
    .sort(function (a, b) { return String(a.nome).localeCompare(String(b.nome), "pt-BR"); })
    .forEach(function (x) {
      var o = el("option", null, x.nome); o.value = x.cod;
      if (String(E.supervisor) === String(x.cod)) o.selected = true;
      s.appendChild(o);
    });
  s.addEventListener("change", function () { E.supervisor = s.value; desenhar(); });
  g.appendChild(s);
  return g;
}

/* ---------------------------------------------------------------------------
 * Gráficos
 * ------------------------------------------------------------------------ */

/* Colunas de UMA medida. Duas medidas de escalas diferentes nunca dividem o
   mesmo desenho: viram dois desenhos empilhados (ver serieTempo). */
function colunas(caixa, dados, opts) {
  opts = opts || {};
  limpar(caixa);
  if (!dados.length) { caixa.appendChild(el("div", "vazio", "Sem dados no período.")); return; }
  var larguraCol = opts.larguraCol || 48;
  var L = Math.max(640, dados.length * larguraCol + 110);
  var A = opts.altura || 230;
  var mE = 66, mD = 18, mT = 30, mB = 30;
  var pw = L - mE - mD, ph = A - mT - mB;
  var svg = svgEl("svg", { viewBox: "0 0 " + L + " " + A, width: L, height: A, role: "img",
                           "aria-label": opts.aria || "Gráfico de colunas" });
  var serie = opts.serie || "viz-1";

  var maxV = Math.max.apply(null, dados.map(function (d) { return Math.abs(n(d.valor)); })) || 1;
  var passos = 4;
  var escala = Math.pow(10, Math.floor(Math.log10(maxV / passos)));
  var passo = Math.ceil(maxV / passos / escala) * escala;
  var topo = passo * passos || 1;

  for (var i = 0; i <= passos; i++) {
    var y = mT + ph - (i * passo / topo) * ph;
    svg.appendChild(svgEl("line", { x1: mE, y1: y, x2: mE + pw, y2: y,
      stroke: i === 0 ? "var(--line-1)" : "var(--grade)", "stroke-width": 1 }));
    var t = svgEl("text", { x: mE - 10, y: y + 4, "text-anchor": "end", "font-size": 10, "font-weight": 700,
                            fill: "var(--txt-3)", "font-family": "JetBrains Mono, monospace" });
    t.textContent = opts.eixoFmt ? opts.eixoFmt(i * passo) : fCurtoSemMoeda(i * passo);
    svg.appendChild(t);
  }

  /* marca fina: no máximo 24px, canto de cima arredondado e base reta */
  var bw = Math.min(24, (pw / dados.length) * 0.56);
  var mostrarRotulos = dados.length <= 26 && opts.rotulos !== false;
  var crescer = [], rotulos = [];
  dados.forEach(function (d, i) {
    var cx = mE + (i + 0.5) * (pw / dados.length);
    var h = Math.max(2, (Math.abs(n(d.valor)) / topo) * ph);
    var y = mT + ph - h;
    var g = svgEl("g", { class: "col" });
    var barra = svgEl("rect", { class: "barra", x: cx - bw / 2, y: semMovimento ? y : mT + ph,
                                width: bw, height: semMovimento ? h : 0, rx: 4,
                                fill: "var(--" + serie + ")" });
    g.appendChild(barra);
    /* o rx arredonda os quatro cantos; este retângulo devolve a base reta,
       porque a coluna nasce da linha de base e não flutua */
    var base = svgEl("rect", { x: cx - bw / 2, y: mT + ph - Math.min(h, 5), width: bw,
                               height: Math.min(h, 5), fill: "var(--" + serie + ")" });
    g.appendChild(base);
    var tit = svgEl("title", {});
    tit.textContent = d.rotulo + ": " + (opts.valorTooltip ? opts.valorTooltip(d.valor) : fR$(d.valor));
    g.appendChild(tit);
    /* área de clique maior que a marca, para o toque e o mouse pegarem fácil */
    g.appendChild(svgEl("rect", { x: cx - (pw / dados.length) / 2, y: mT, width: pw / dados.length,
                                  height: ph, fill: "transparent" }));
    svg.appendChild(g);
    if (!semMovimento) crescer.push([barra, y, h]);

    if (mostrarRotulos && Math.abs(n(d.valor)) > 0) {
      var texto = opts.valorFmt ? opts.valorFmt(d.valor) : fCurtoSemMoeda(d.valor);
      /* rótulo só entra se couber na fatia — senão o valor fica no tooltip */
      if (texto.length * 6.1 <= (pw / dados.length) + 8) {
        var r = svgEl("text", { x: cx, y: y - 9, "text-anchor": "middle", "font-size": 10.5,
                                "font-weight": 800, fill: "var(--txt-1)",
                                "font-family": "JetBrains Mono, monospace" });
        r.textContent = texto;
        r.style.opacity = semMovimento ? 1 : 0;
        r.style.transition = "opacity .4s ease";
        svg.appendChild(r);
        if (!semMovimento) rotulos.push(r);
      }
    }
    var lb = svgEl("text", { x: cx, y: A - 10, "text-anchor": "middle", "font-size": 10,
                             "font-weight": 600, fill: "var(--txt-3)" });
    lb.textContent = d.rotulo;
    svg.appendChild(lb);
  });

  caixa.appendChild(svg);
  if (crescer.length) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        crescer.forEach(function (c, i) {
          c[0].style.transitionDelay = Math.min(i * 22, 400) + "ms";
          c[0].setAttribute("y", c[1]); c[0].setAttribute("height", c[2]);
        });
      });
    });
    setTimeout(function () { rotulos.forEach(function (t) { t.style.opacity = 1; }); }, 620);
  }
}

/* Linha de apoio: a segunda medida, no seu próprio desenho, com o mesmo eixo
   de tempo do de cima. É assim que duas escalas convivem sem inventar
   correlação com dois eixos no mesmo gráfico. */
function linha(caixa, dados, opts) {
  opts = opts || {};
  limpar(caixa);
  var validos = dados.filter(function (d) { return d.valor != null; });
  if (!validos.length) { caixa.appendChild(el("div", "vazio", "Sem dados no período.")); return; }
  var larguraCol = opts.larguraCol || 48;
  var L = Math.max(640, dados.length * larguraCol + 110);
  var A = opts.altura || 185;
  var mE = 66, mD = 18, mT = 26, mB = 24;
  var pw = L - mE - mD, ph = A - mT - mB;
  var svg = svgEl("svg", { viewBox: "0 0 " + L + " " + A, width: L, height: A, role: "img",
                           "aria-label": opts.aria || "Série de apoio" });
  var serie = opts.serie || "viz-4";

  var vals = validos.map(function (d) { return n(d.valor); });
  var max = Math.max.apply(null, vals), min = Math.min.apply(null, vals);
  var folga = (max - min) * 0.25 || Math.abs(max) * 0.12 || 1;
  var topo = max + folga, base = min - folga;
  var faixa = (topo - base) || 1;
  function py(v) { return mT + ph - ((v - base) / faixa) * ph; }

  [topo, base].forEach(function (v) {
    var y = py(v);
    svg.appendChild(svgEl("line", { x1: mE, y1: y, x2: mE + pw, y2: y, stroke: "var(--grade)", "stroke-width": 1 }));
    var t = svgEl("text", { x: mE - 10, y: y + 4, "text-anchor": "end", "font-size": 9.5, "font-weight": 700,
                            fill: "var(--txt-3)", "font-family": "JetBrains Mono, monospace" });
    t.textContent = opts.eixoFmt ? opts.eixoFmt(v) : fPct(v, 1);
    svg.appendChild(t);
  });
  var yRef = null;
  if (opts.referencia != null && opts.referencia > base && opts.referencia < topo) {
    yRef = py(opts.referencia);
    /* linha de limite: tracejada de propósito. Grade é sempre contínua; o
       tracejado aqui significa "isto é um limite", não "isto é uma régua". */
    svg.appendChild(svgEl("line", { x1: mE, y1: yRef, x2: mE + pw, y2: yRef,
      stroke: "var(--atencao)", "stroke-width": 1.6, "stroke-dasharray": "7 5", opacity: .85 }));
    /* o rótulo mora na ESQUERDA, em plaqueta, para nunca disputar espaço com
       o valor do último ponto, que fica na direita */
    var texto = opts.referenciaRotulo || "";
    if (texto) {
      var larg = texto.length * 5.6 + 16;
      svg.appendChild(svgEl("rect", { x: mE + 8, y: yRef - 9, width: larg, height: 18, rx: 9,
        fill: "var(--navy-900)", stroke: "var(--atencao)", "stroke-width": 1, opacity: .95 }));
      var tr = svgEl("text", { x: mE + 8 + larg / 2, y: yRef + 4, "text-anchor": "middle",
        "font-size": 10, "font-weight": 800, fill: "var(--atencao)",
        "font-family": "JetBrains Mono, monospace" });
      tr.textContent = texto;
      svg.appendChild(tr);
    }
  }

  var pts = [];
  dados.forEach(function (d, i) {
    if (d.valor == null) return;
    pts.push([mE + (i + 0.5) * (pw / dados.length), py(n(d.valor)), n(d.valor), d.rotulo]);
  });

  /* área: a mesma cor a 10% — um véu, nunca um bloco saturado */
  var area = "M" + pts[0][0] + "," + (mT + ph) + " " +
             pts.map(function (p) { return "L" + p[0] + "," + p[1]; }).join(" ") +
             " L" + pts[pts.length - 1][0] + "," + (mT + ph) + " Z";
  svg.appendChild(svgEl("path", { d: area, fill: "var(--" + serie + ")", opacity: .10 }));
  svg.appendChild(svgEl("polyline", {
    points: pts.map(function (p) { return p[0] + "," + p[1]; }).join(" "),
    fill: "none", stroke: "var(--" + serie + ")", "stroke-width": 2,
    "stroke-linejoin": "round", "stroke-linecap": "round"
  }));

  pts.forEach(function (p, i) {
    var ultimo = i === pts.length - 1;
    var pto = svgEl("circle", { cx: p[0], cy: p[1], r: ultimo ? 5 : 3.2,
      fill: "var(--" + serie + ")", stroke: "var(--surface-1)", "stroke-width": 2 });
    var tit = svgEl("title", {});
    tit.textContent = p[3] + ": " + (opts.valorFmt ? opts.valorFmt(p[2]) : fPct(p[2], 2));
    pto.appendChild(tit);
    svg.appendChild(pto);
  });

  /* rótulo direto só nos pontos que contam: o último e os dois extremos */
  var iMax = 0, iMin = 0;
  pts.forEach(function (p, i) { if (p[2] > pts[iMax][2]) iMax = i; if (p[2] < pts[iMin][2]) iMin = i; });
  [pts.length - 1, iMax, iMin].filter(function (v, i, a) { return a.indexOf(v) === i; }).forEach(function (i) {
    var p = pts[i];
    /* acima do ponto, mas se a linha de limite estiver logo ali, passa para
       baixo — rótulo nenhum escreve por cima de outra coisa */
    var acima = true;
    if (yRef != null && Math.abs((p[1] - 12) - yRef) < 14) acima = false;
    var t = svgEl("text", { x: Math.min(Math.max(p[0], mE + 18), mE + pw - 18),
      y: acima ? p[1] - 12 : p[1] + 19,
      "text-anchor": "middle", "font-size": 11, "font-weight": 800, fill: "var(--txt-1)",
      "font-family": "JetBrains Mono, monospace" });
    t.textContent = opts.valorFmt ? opts.valorFmt(p[2]) : fPct(p[2], 1);
    svg.appendChild(t);
  });

  caixa.appendChild(svg);
}

/* Duas medidas, dois desenhos, um eixo de tempo só. */
function serieTempo(destino, dados, opts) {
  destino.appendChild(el("div", "gtitulo", opts.tituloBarra));
  var cima = el("div", "gbox");
  destino.appendChild(cima);
  colunas(cima, dados.map(function (d) { return { rotulo: d.rotulo, valor: d.barra }; }), {
    serie: opts.serieBarra, altura: opts.altura || 230,
    valorFmt: opts.barraFmt, valorTooltip: opts.barraTooltip,
    eixoFmt: opts.barraEixo, aria: opts.tituloBarra
  });
  if (opts.tituloLinha) {
    destino.appendChild(el("div", "gtitulo", opts.tituloLinha));
    var baixo = el("div", "gbox");
    destino.appendChild(baixo);
    linha(baixo, dados.map(function (d) { return { rotulo: d.rotulo, valor: d.linha }; }), {
      serie: opts.serieLinha, valorFmt: opts.linhaFmt, eixoFmt: opts.linhaFmt,
      referencia: opts.referencia, referenciaRotulo: opts.referenciaRotulo,
      altura: opts.alturaLinha, aria: opts.tituloLinha
    });
  }
}

/* Parte-do-todo com duas categorias: uma barra, não uma rosca de 2 fatias. */
function barraProporcao(caixa, partes, leitura) {
  limpar(caixa);
  var total = partes.reduce(function (s, p) { return s + n(p.valor); }, 0) || 1;
  var barra = el("div", "prop");
  var alvos = [];
  partes.forEach(function (p) {
    var i = el("i");
    var pct = n(p.valor) / total * 100;
    i.style.background = "var(--" + p.cor + ")";
    i.style.width = semMovimento ? pct + "%" : "0%";
    var texto = fPct(pct, 1);
    /* só rotula dentro quando cabe; senão o valor vive na legenda abaixo */
    if (pct > 12) i.appendChild(el("span", "rot", texto));
    i.title = p.rotulo + ": " + fR$(p.valor) + " (" + texto + ")";
    barra.appendChild(i);
    if (!semMovimento) alvos.push([i, pct + "%"]);
  });
  caixa.appendChild(barra);

  var leg = el("div", "glegenda");
  partes.forEach(function (p) {
    var s = el("span");
    var sw = el("i"); sw.style.background = "var(--" + p.cor + ")";
    s.appendChild(sw);
    s.appendChild(document.createTextNode(p.rotulo + " · " + fCurto(p.valor)));
    leg.appendChild(s);
  });
  caixa.appendChild(leg);
  if (leitura) {
    var p = el("p", null, leitura);
    p.style.cssText = "margin:10px 0 0;font-size:12px;color:var(--txt-3);line-height:1.55;font-weight:500;";
    caixa.appendChild(p);
  }
  if (alvos.length) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { alvos.forEach(function (a) { a[0].style.width = a[1]; }); });
    });
  }
}

/* Ranking: uma série, uma cor. A posição vira número, não cor. */
function ranking(caixa, itens, opts) {
  opts = opts || {};
  limpar(caixa);
  if (!itens.length) { caixa.appendChild(el("div", "vazio", "Sem dados no período.")); return; }
  var lista = el("div", "rank");
  var max = itens.reduce(function (m, i) { return Math.max(m, Math.abs(n(i.valor))); }, 0) || 1;
  var barras = [];
  itens.forEach(function (i, idx) {
    var l = el("div", "rank-l");
    l.appendChild(el("div", "rank-pos", String(idx + 1)));
    l.appendChild(el("div", "rank-nome", i.nome));
    var trilho = el("div", "rank-trilho");
    var b = el("div", "rank-barra");
    var alvo = Math.max(1.5, Math.abs(n(i.valor)) / max * 100) + "%";
    b.style.width = semMovimento ? alvo : "0%";
    b.style.background = "var(--" + (opts.serie || "viz-1") + ")";
    trilho.appendChild(b);
    l.appendChild(trilho);
    l.appendChild(el("div", "rank-val", i.rotulo));
    l.title = i.nome + ": " + i.rotulo;
    lista.appendChild(l);
    if (!semMovimento) barras.push([b, alvo, idx]);
  });
  caixa.appendChild(lista);
  if (barras.length) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        barras.forEach(function (b) {
          b[0].style.transitionDelay = Math.min(b[2] * 40, 500) + "ms";
          b[0].style.width = b[1];
        });
      });
    });
  }
}

/* ---------------------------------------------------------------------------
 * Tabela — ordenação, colunas fixas, paginação, totais em destaque e CSV
 * ------------------------------------------------------------------------ */
function tabela(cfg) {
  var chave = cfg.id;
  var ordem = E.ordem[chave] || { campo: cfg.ordemInicial, dir: cfg.dirInicial == null ? -1 : cfg.dirInicial };
  E.ordem[chave] = ordem;
  var pagina = E.pag[chave] || 1;
  var porPagina = E.porPagina[chave] || cfg.porPagina || 50;

  var linhas = cfg.linhas.slice();
  if (ordem.campo != null) {
    linhas.sort(function (a, b) {
      var va = cfg.valorOrdem(a, ordem.campo), vb = cfg.valorOrdem(b, ordem.campo);
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string" || typeof vb === "string")
        return String(va).localeCompare(String(vb), "pt-BR") * ordem.dir;
      return (va - vb) * ordem.dir;
    });
  }
  var totalLinhas = linhas.length;
  var tudo = porPagina >= 99999;
  var totalPaginas = tudo ? 1 : Math.max(1, Math.ceil(totalLinhas / porPagina));
  if (pagina > totalPaginas) { pagina = totalPaginas; E.pag[chave] = pagina; }
  var visiveis = tudo ? linhas : linhas.slice((pagina - 1) * porPagina, pagina * porPagina);

  var env = el("div");

  /* faixa de totais: o resumo do que está filtrado, antes da tabela e em
     tamanho grande — é o número que a reunião olha */
  if (cfg.totais) {
    var faixa = el("div", "totais");
    cfg.totais(linhas).forEach(function (t) {
      var c = el("div", "t" + (t.destaque ? " destaque" : ""));
      c.appendChild(el("div", "k", t.rotulo));
      var v = el("div", "v");
      if (t.numero != null && t.formatar) animarNumero(v, chave + "_tot_" + t.rotulo, t.numero, t.formatar);
      else v.textContent = t.valor;
      c.appendChild(v);
      if (t.sub) c.appendChild(el("div", "d", t.sub));
      faixa.appendChild(c);
    });
    env.appendChild(faixa);
  }

  var rol = el("div", "tabela-rolagem");
  var t = el("table", "dados");
  var thead = el("thead");
  var tr = el("tr");
  cfg.colunas.forEach(function (c, i) {
    var th = el("th", (c.num ? "n " : "") + (c.fixa ? "fixa" + c.fixa + " " : "") + (ordem.campo === i ? "ordenado" : ""));
    th.appendChild(document.createTextNode(c.titulo));
    th.appendChild(el("span", "seta", ordem.campo === i ? (ordem.dir === 1 ? "▲" : "▼") : "▾"));
    if (c.ajuda) th.title = c.ajuda;
    th.addEventListener("click", function () {
      if (ordem.campo === i) ordem.dir = -ordem.dir; else { ordem.campo = i; ordem.dir = c.num ? -1 : 1; }
      E.pag[chave] = 1;
      desenhar(true);
    });
    tr.appendChild(th);
  });
  thead.appendChild(tr);
  t.appendChild(thead);

  var tb = el("tbody");
  var maxMedida = cfg.medida ? visiveis.reduce(function (m, l) { return Math.max(m, Math.abs(n(cfg.medida(l)))); }, 0) : 0;
  visiveis.forEach(function (linha, idx) {
    var tr = el("tr");
    if (cfg.aoClicar) {
      tr.className = "clicavel";
      tr.addEventListener("click", function () { cfg.aoClicar(linha); });
    }
    cfg.colunas.forEach(function (c, i) {
      var td = el("td", (c.num ? "n " : "") + (c.fraco ? "fraco " : "") + (c.corta ? "corta " : "") +
                        (c.fixa ? "fixa" + c.fixa + " " : "") + (c.medida ? "medida" : ""));
      /* na coluna da medida principal, uma barra clara atrás do número mostra
         o tamanho relativo sem precisar de gráfico à parte */
      if (c.medida && maxMedida) {
        var fundo = el("span", "fundo");
        fundo.style.width = Math.max(2, Math.abs(n(cfg.medida(linha))) / maxMedida * 100) + "%";
        fundo.style.background = "var(--" + (cfg.medidaCor || "viz-2") + ")";
        td.appendChild(fundo);
      }
      var conteudo = c.celula(linha, idx);
      var caixa = c.medida ? el("span") : td;
      if (conteudo instanceof Node) caixa.appendChild(conteudo);
      else if (c.destacar && E.busca) escreverComDestaque(caixa, conteudo, E.busca);
      else caixa.textContent = conteudo == null ? "—" : conteudo;
      if (caixa !== td) td.appendChild(caixa);
      if (c.titulo2) td.title = c.titulo2(linha) || "";
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  rol.appendChild(t);
  if (!totalLinhas) limpar(rol).appendChild(el("div", "vazio", cfg.vazio || "Nada encontrado com estes filtros."));
  env.appendChild(rol);

  var pe = el("div", "tabela-pe");
  var info = el("div", "info");
  info.innerHTML = totalLinhas
    ? ("Mostrando <b>" + fInt(visiveis.length) + "</b> de <b>" + fInt(totalLinhas) + "</b> linhas" +
       (cfg.aviso ? " · " + cfg.aviso : ""))
    : (cfg.aviso || "");
  pe.appendChild(info);

  var dir = el("div", "pe-dir");
  if (totalLinhas > 25) {
    var sel = el("select");
    sel.style.cssText = "background:var(--surface-2);border:1px solid var(--line-2);color:var(--txt-1);border-radius:10px;padding:7px 10px;font-size:12px;font-weight:700;cursor:pointer;";
    [25, 50, 100, 99999].forEach(function (v) {
      var o = el("option", null, v >= 99999 ? "Mostrar tudo" : v + " por página");
      o.value = v;
      if (v === porPagina) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", function () {
      E.porPagina[chave] = +sel.value; E.pag[chave] = 1; desenhar(true);
    });
    dir.appendChild(sel);
  }
  if (cfg.csv) {
    var bx = el("button", "btn-limpar", "Exportar CSV");
    bx.type = "button";
    bx.addEventListener("click", function () { exportarCsv(cfg, linhas); });
    dir.appendChild(bx);
  }
  if (totalPaginas > 1) {
    var pg = el("div", "paginas");
    var botao = function (rotulo, alvo, desabilitado) {
      var b = el("button", null, rotulo);
      b.type = "button"; b.disabled = !!desabilitado;
      b.addEventListener("click", function () { E.pag[chave] = alvo; desenhar(true); });
      return b;
    };
    pg.appendChild(botao("«", 1, pagina <= 1));
    pg.appendChild(botao("‹", pagina - 1, pagina <= 1));
    var atual = el("button", "atual", pagina + " / " + totalPaginas);
    atual.disabled = true;
    pg.appendChild(atual);
    pg.appendChild(botao("›", pagina + 1, pagina >= totalPaginas));
    pg.appendChild(botao("»", totalPaginas, pagina >= totalPaginas));
    dir.appendChild(pg);
  }
  pe.appendChild(dir);
  env.appendChild(pe);
  return env;
}

function escreverComDestaque(td, texto, termo) {
  var s = texto == null ? "" : String(texto);
  var i = s.toLowerCase().indexOf(termo);
  if (i === -1) { td.textContent = s; return; }
  td.appendChild(document.createTextNode(s.slice(0, i)));
  td.appendChild(el("mark", null, s.slice(i, i + termo.length)));
  td.appendChild(document.createTextNode(s.slice(i + termo.length)));
}

/* Planilha sai com a cara do sistema e com os filtros escritos dentro —
   quem recebe precisa saber que aquilo é um recorte, não a lista inteira. */
function exportarCsv(cfg, linhas) {
  var sep = ";";
  var out = [];
  out.push("LUBE DISTRIBUIDORA LTDA — Central Comercial");
  out.push(cfg.tituloCsv || cfg.id);
  out.push("Período" + sep + fData(E.de) + " a " + fData(E.ate));
  out.push("Filiais" + sep + (E.filiais ? Array.from(E.filiais).join(", ") : "todas"));
  out.push("Supervisor" + sep + (E.supervisor ? nomeSupervisor(E.supervisor) : "todos"));
  if (E.busca) out.push("Busca" + sep + E.busca);
  if (cfg.filtrosExtras) cfg.filtrosExtras().forEach(function (f) { out.push(f[0] + sep + f[1]); });
  out.push("Gerado em" + sep + new Date().toLocaleString("pt-BR"));
  out.push("Linhas" + sep + linhas.length);
  out.push("");
  out.push(cfg.colunas.map(function (c) { return c.titulo; }).join(sep));
  linhas.forEach(function (l) {
    out.push(cfg.colunas.map(function (c) {
      var v = c.csv ? c.csv(l) : c.celula(l, 0);
      if (v instanceof Node) v = v.textContent;
      return String(v == null ? "" : v).replace(/[\r\n;]/g, " ");
    }).join(sep));
  });
  var blob = new Blob(["﻿" + out.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "comercial-" + cfg.id + "-" + E.de + "-a-" + E.ate + ".csv";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
}

/* ---------------------------------------------------------------------------
 * Modal
 * ------------------------------------------------------------------------ */
function abrirModal(eyebrow, titulo, meta, montar) {
  var raiz = document.getElementById("modal-raiz");
  limpar(raiz);
  var ov = el("div", "overlay");
  var m = el("div", "modal");
  var cab = el("div", "modal-head");
  var esq = el("div");
  esq.appendChild(el("div", "eyebrow", eyebrow));
  esq.appendChild(el("h3", null, titulo));
  if (meta) {
    var mt = el("div", "meta");
    meta.forEach(function (x) {
      var s = el("span");
      s.appendChild(document.createTextNode(x[0] + " "));
      s.appendChild(el("b", null, x[1]));
      mt.appendChild(s);
    });
    esq.appendChild(mt);
  }
  cab.appendChild(esq);
  var x = el("button", "x", "×"); x.type = "button";
  x.addEventListener("click", fechar);
  cab.appendChild(x);
  m.appendChild(cab);
  var corpo = el("div");
  m.appendChild(corpo);
  ov.appendChild(m);
  ov.addEventListener("click", function (e) { if (e.target === ov) fechar(); });
  document.addEventListener("keydown", aoTeclar);
  raiz.appendChild(ov);
  montar(corpo);
  function fechar() { limpar(raiz); document.removeEventListener("keydown", aoTeclar); }
  function aoTeclar(e) { if (e.key === "Escape") fechar(); }
  return corpo;
}

/* ---------------------------------------------------------------------------
 * Página 1 — COMISSÃO POR RCA
 * ------------------------------------------------------------------------ */
function paginaComissao(raiz) {
  var linhas = (D.comissao.rca || []).filter(function (l) { return passaFiltroRca(l[0], l[1]); });

  var mapa = new Map();
  linhas.forEach(function (l) {
    var k = E.grao === "rca" ? String(l[0]) : l[0] + "|" + l[1];
    if (!mapa.has(k)) mapa.set(k, { codusur: l[0], codfilial: E.grao === "rca" ? null : l[1], c: componentesVazios() });
    somar(mapa.get(k).c, l);
  });
  var itens = Array.from(mapa.values()).map(function (x) {
    var r = calcular(x.c);
    r.codusur = x.codusur; r.codfilial = x.codfilial;
    r.nome = nomeRca(x.codusur);
    r.supervisor = nomeSupervisor(supervisorDoRca(x.codusur));
    if (E.grao === "rca") r.clientes = n((D.comissao.clientes_por_rca || {})[x.codusur]) || r.clientes;
    return r;
  }).sort(function (a, b) { return b.comissao - a.comissao; });

  var geral = componentesVazios();
  linhas.forEach(function (l) { somar(geral, l); });
  var empresa = calcular(geral);
  var somaGrao = itens.reduce(function (s, i) { return s + i.comissao; }, 0);

  function somaNoGrao(chaveDe) {
    var m = new Map();
    linhas.forEach(function (l) {
      var k = chaveDe(l);
      if (!m.has(k)) m.set(k, componentesVazios());
      somar(m.get(k), l);
    });
    var t = 0;
    m.forEach(function (c) { t += calcular(c).comissao; });
    return t;
  }
  var porRca = somaNoGrao(function (l) { return String(l[0]); });
  var porRcaFilial = somaNoGrao(function (l) { return l[0] + "|" + l[1]; });

  var meses = D.comissao.mes || [];
  var ultimo = meses.length ? meses[meses.length - 1] : null;
  var penultimo = meses.length > 1 ? meses[meses.length - 2] : null;
  var variacao = (ultimo && penultimo && n(penultimo[8]))
    ? (n(ultimo[8]) - n(penultimo[8])) / n(penultimo[8]) * 100 : null;

  raiz.appendChild(heroi({
    rotulo: "Comissão a pagar no período",
    valor: somaGrao,
    formatar: fCurto,
    sub: "Soma das comissões calculadas por <b>" + (E.grao === "rca" ? "RCA" : "RCA × filial") + "</b>, " +
         "sobre <b>" + fCurto(empresa.totalLiquido) + "</b> de total líquido e " +
         "<b>" + fPct(empresa.perc, 2) + "</b> de margem." +
         (variacao != null ? " No último mês fechado a comissão variou <b>" + fPct(variacao, 1) + "</b> contra o mês anterior." : ""),
    kpis: [
      { rotulo: "Total líquido", numero: empresa.totalLiquido, formatar: fCurto, titulo: fR$(empresa.totalLiquido),
        tom: "info", sub: "venda sem ST menos devolução",
        ajuda: "É a base sobre a qual a comissão é paga: venda sem ST menos a devolução do período." },
      { rotulo: "Massa de margem", numero: empresa.massa, formatar: fCurto, titulo: fR$(empresa.massa),
        tom: "bom", sub: "total líquido menos CMV líquido" },
      { rotulo: "Margem líquida", numero: empresa.perc, formatar: function (v) { return fPct(v, 2); },
        tom: "roxo", sub: "do conjunto filtrado",
        ajuda: "A margem do total. Cada vendedor tem a margem dele, e é ela que define a faixa dele." },
      { rotulo: "ST no período", numero: empresa.st, formatar: fCurto, titulo: fR$(empresa.st),
        tom: "atencao", sub: "substituição tributária em " + fInt(itens.length) + " vendedores" }
    ]
  }));

  var f = el("div", "filtros sobe");
  var fil = filiaisDisponiveis();
  if (fil.length > 1) {
    f.appendChild(chipsMultiplos("Filial", fil.map(function (x) { return { valor: x, rotulo: "Filial " + x }; }),
      E.filiais, function (novo) { E.filiais = novo; desenhar(); }));
  }
  f.appendChild(chips("Grão da comissão", [
    { valor: "rca", rotulo: "Por RCA" },
    { valor: "rca_filial", rotulo: "Por RCA × filial" }
  ], E.grao, function (v) { E.grao = v; desenhar(); }, "ouro"));
  f.appendChild(seletorSupervisor());
  f.appendChild(campoBusca("Buscar RCA por nome ou código…"));
  raiz.appendChild(f);

  var pc = painel("Como o total muda conforme o grão",
    "A faixa de comissão é aplicada sobre a margem do conjunto — então somar por vendedor, por vendedor e filial, ou tudo de uma vez dá resultados diferentes. O painel paga o grão escolhido acima.");
  var conf = el("div", "confere");
  [
    ["Faixa única sobre o total", fR$(empresa.totalLiquido * empresa.faixa),
     "Uma faixa só (" + fPct(empresa.faixa * 100, 2) + ") aplicada ao total do período.", false],
    ["Soma por RCA", fR$(porRca), "Uma faixa por vendedor, no período inteiro.", E.grao === "rca"],
    ["Soma por RCA × filial", fR$(porRcaFilial), "Uma faixa por vendedor em cada filial.", E.grao === "rca_filial"],
    ["Desconto financeiro", fR$(empresa.descfin), "Contado uma vez por nota fiscal.", false]
  ].forEach(function (c) {
    var cel = el("div", "cel" + (c[3] ? " destaque" : ""));
    cel.appendChild(el("div", "k", c[0]));
    cel.appendChild(el("div", "v", c[1]));
    cel.appendChild(el("div", "d", c[2]));
    conf.appendChild(cel);
  });
  pc.corpo.appendChild(conf);
  var difer = Math.abs(porRca - porRcaFilial);
  if (difer > 0.5) {
    var nt = nota("Separar por filial muda a comissão em <b>" + fR$(difer) + "</b> no período — " +
      "é o mesmo vendedor caindo em faixas diferentes em cada filial.", "atencao");
    nt.style.marginTop = "14px";
    pc.corpo.appendChild(nt);
  }
  raiz.appendChild(pc);

  var essencial = E.colunas === "essencial";
  var cols = [
    { titulo: "#", celula: function (r, i) {
        var pg = E.pag["comissao"] || 1;
        var pp = E.porPagina["comissao"] || 25;
        var pos = (pp >= 99999 ? 0 : (pg - 1) * pp) + i + 1;
        return el("span", "pos" + (pos <= 3 ? " top" : ""), String(pos));
      }, fixa: 1, csv: function () { return ""; } },
    { titulo: "RCA", celula: function (r) { return r.nome; }, destacar: true, corta: true, fixa: 2 },
    { titulo: "Supervisor", celula: function (r) { return r.supervisor; }, fraco: true, corta: true }
  ];
  if (E.grao !== "rca") cols.push({ titulo: "Filial", num: true, celula: function (r) { return r.codfilial; } });
  cols.push(
    { titulo: "Total líquido", num: true, celula: function (r) { return fR$(r.totalLiquido); }, csv: function (r) { return fNum(r.totalLiquido); } },
    { titulo: "Massa", num: true, celula: function (r) { return fR$(r.massa); }, csv: function (r) { return fNum(r.massa); } },
    { titulo: "Margem", num: true, celula: function (r) { return fPct(r.perc, 2); }, csv: function (r) { return fNum(r.perc); } },
    { titulo: "Faixa", num: true, celula: function (r) {
        return el("span", "selo " + (r.faixa >= 0.03 ? "bom" : r.faixa <= 0.01 ? "grave" : "atencao"), fPct(r.faixa * 100, 2));
      }, csv: function (r) { return fNum(r.faixa * 100); } },
    { titulo: "Comissão", num: true, medida: true, celula: function (r) { return fR$(r.comissao); }, csv: function (r) { return fNum(r.comissao); } }
  );
  if (!essencial) {
    cols.push(
      { titulo: "CMV venda", num: true, celula: function (r) { return fR$(r.cmvVenda); }, csv: function (r) { return fNum(r.cmvVenda); } },
      { titulo: "CMV líquido", num: true, celula: function (r) { return fR$(r.cmvLiquido); }, csv: function (r) { return fNum(r.cmvLiquido); } },
      { titulo: "ST", num: true, celula: function (r) { return fR$(r.st); }, csv: function (r) { return fNum(r.st); } },
      { titulo: "Desc. fin.", num: true, celula: function (r) { return fR$(r.descfin); }, csv: function (r) { return fNum(r.descfin); } }
    );
  }
  cols.push(
    { titulo: "Notas", num: true, celula: function (r) { return fInt(r.notas); }, fraco: true },
    { titulo: "Clientes", num: true, celula: function (r) { return fInt(r.clientes); }, fraco: true }
  );

  var campos = ["", "nome", "supervisor"];
  if (E.grao !== "rca") campos.push("codfilial");
  campos = campos.concat(["totalLiquido", "massa", "perc", "faixa", "comissao"]);
  if (!essencial) campos = campos.concat(["cmvVenda", "cmvLiquido", "st", "descfin"]);
  campos = campos.concat(["notas", "clientes"]);

  var pt = painel("Comissão por " + (E.grao === "rca" ? "vendedor" : "vendedor e filial"),
    "Clique numa linha para ver as notas do vendedor no período.",
    chips(null, [{ valor: "essencial", rotulo: "Colunas essenciais" }, { valor: "completo", rotulo: "Todas as colunas" }],
      E.colunas, function (v) { E.colunas = v; desenhar(true); }, "ouro"));
  pt.corpo.remove();
  pt.appendChild(tabela({
    id: "comissao",
    tituloCsv: "Comissão por " + (E.grao === "rca" ? "RCA" : "RCA e filial"),
    colunas: cols,
    linhas: itens,
    medida: function (r) { return r.comissao; },
    medidaCor: "viz-2",
    ordemInicial: campos.indexOf("comissao"),
    valorOrdem: function (r, i) { return campos[i] === "" ? null : r[campos[i]]; },
    totais: function (todas) {
      var soma = function (campo) { return todas.reduce(function (s, r) { return s + n(r[campo]); }, 0); };
      var tl = soma("totalLiquido"), tlsst = soma("totalLiquidoSst"), massa = soma("massa"), com = soma("comissao");
      return [
        { rotulo: "Vendedores", numero: todas.length, formatar: fInt },
        { rotulo: "Total líquido", numero: tl, formatar: fCurto, sub: fR$(tl) },
        { rotulo: "Massa de margem", numero: massa, formatar: fCurto },
        { rotulo: "Margem", numero: tlsst ? massa / tlsst * 100 : 0, formatar: function (v) { return fPct(v, 2); } },
        { rotulo: "Comissão a pagar", numero: com, formatar: fCurto, destaque: true, sub: fR$(com) },
        { rotulo: "Notas", numero: soma("notas"), formatar: fInt }
      ];
    },
    aoClicar: function (r) { abrirNotasDoRca(r); },
    csv: true,
    porPagina: 25
  }));
  raiz.appendChild(pt);

  if (meses.length) {
    var pm = painel("Comissão e margem, mês a mês",
      "A comissão de cada mês é a soma do que os vendedores ganharam nele — não muda com o filtro de período.");
    serieTempo(pm.corpo, meses.map(function (m) {
      return { rotulo: rotuloMes(m[0]), barra: n(m[8]), linha: m[7] == null ? null : n(m[7]) };
    }), {
      tituloBarra: "Comissão paga (R$)", serieBarra: "viz-2",
      barraFmt: fCurtoSemMoeda, barraTooltip: fR$,
      tituloLinha: "Margem líquida da empresa (%)", serieLinha: "viz-4",
      linhaFmt: function (v) { return fPct(v, 1); },
      referencia: 20, referenciaRotulo: "20% — primeira faixa"
    });
    raiz.appendChild(pm);
  }
}

/* Notas de um RCA — vêm do /api/detalhe, porque a base tem 200 mil linhas */
function abrirNotasDoRca(r) {
  var corpo = abrirModal("Detalhe por nota fiscal", r.nome, [
    ["Período", fData(E.de) + " a " + fData(E.ate)],
    ["Total líquido", fR$(r.totalLiquido)],
    ["Margem", fPct(r.perc, 2)],
    ["Comissão", fR$(r.comissao)]
  ], function (corpo) {
    corpo.appendChild(el("div", "vazio", "Buscando as notas no banco…"));
  });

  buscarDetalhe("comissao_nf", r.codusur).then(function (res) {
    limpar(corpo);
    var linhas = (res.linhas || []).map(function (l) {
      var c = componentesVazios();
      c.venda = n(l[6]); c.devSt = n(l[7]); c.devSst = n(l[8]);
      c.cmvVenda = n(l[9]); c.cmvDev = n(l[10]); c.cmvBonif = n(l[11]);
      c.descfin = n(l[12]); c.st = n(l[13]);
      var calc = calcular(c);
      calc.dtmov = l[0]; calc.numnota = l[1]; calc.numped = l[2];
      calc.codcli = l[3]; calc.codfilial = l[4]; calc.quantidade = n(l[5]);
      return calc;
    }).filter(function (x) { return E.filiais == null || E.filiais.has(Number(x.codfilial)); });

    var somaNota = linhas.reduce(function (s, x) { return s + x.comissao; }, 0);
    var aviso = nota("Se a faixa fosse aplicada <b>nota a nota</b>, a comissão daria <b>" + fR$(somaNota) +
      "</b>. No grão do vendedor ela é <b>" + fR$(r.comissao) + "</b> — a faixa depende da margem do " +
      "conjunto, e conjunto menor cai em faixa diferente. O painel paga o valor do grão escolhido.", "atencao");
    aviso.style.margin = "16px 22px 0";
    corpo.appendChild(aviso);

    corpo.appendChild(tabela({
      id: "comissao_nf_" + r.codusur,
      tituloCsv: "Comissão nota a nota — " + r.nome,
      colunas: [
        { titulo: "Data", celula: function (x) { return fData(x.dtmov); }, fixa: 1 },
        { titulo: "Nota", num: true, celula: function (x) { return x.numnota; } },
        { titulo: "Pedido", num: true, celula: function (x) { return x.numped; }, fraco: true },
        { titulo: "Filial", num: true, celula: function (x) { return x.codfilial; }, fraco: true },
        { titulo: "Total líquido", num: true, medida: true, celula: function (x) { return fR$(x.totalLiquido); } },
        { titulo: "Massa", num: true, celula: function (x) { return fR$(x.massa); } },
        { titulo: "Margem", num: true, celula: function (x) { return fPct(x.perc, 2); } },
        { titulo: "Faixa", num: true, celula: function (x) { return fPct(x.faixa * 100, 2); } },
        { titulo: "Comissão", num: true, celula: function (x) { return fR$(x.comissao); } },
        { titulo: "CMV líquido", num: true, celula: function (x) { return fR$(x.cmvLiquido); }, fraco: true },
        { titulo: "ST", num: true, celula: function (x) { return fR$(x.st); }, fraco: true }
      ],
      linhas: linhas,
      medida: function (x) { return x.totalLiquido; }, medidaCor: "viz-1",
      ordemInicial: 0, dirInicial: 1,
      valorOrdem: function (x, i) {
        return [x.dtmov, x.numnota, x.numped, x.codfilial, x.totalLiquido, x.massa, x.perc,
                x.faixa, x.comissao, x.cmvLiquido, x.st][i];
      },
      totais: function (todas) {
        var soma = function (c) { return todas.reduce(function (s, x) { return s + n(x[c]); }, 0); };
        return [
          { rotulo: "Notas", numero: todas.length, formatar: fInt },
          { rotulo: "Total líquido", numero: soma("totalLiquido"), formatar: fCurto },
          { rotulo: "Massa de margem", numero: soma("massa"), formatar: fCurto },
          { rotulo: "Comissão nota a nota", numero: soma("comissao"), formatar: fCurto, destaque: true }
        ];
      },
      csv: true, porPagina: 25,
      vazio: "Nenhuma nota deste RCA no período."
    }));
  }).catch(function (e) {
    limpar(corpo).appendChild(nota("Não consegui buscar as notas: " + e.message, "grave"));
  });
}

/* ---------------------------------------------------------------------------
 * Página 2 — MARGEM POR ITEM
 * ------------------------------------------------------------------------ */
function paginaMargem(raiz) {
  var r = D.margem.resumo || {};
  var limite = E.limiteMargem;
  var abaixo = r["abaixo_" + limite];
  var margemMedia = n(r.venda) ? n(r.margem_valor) / n(r.venda) * 100 : null;

  raiz.appendChild(heroi({
    rotulo: "Margem gerada no período",
    valor: n(r.margem_valor),
    formatar: fCurto,
    sub: "Sobre <b>" + fCurto(r.venda) + "</b> vendidos em <b>" + fInt(r.itens) + "</b> itens faturados, " +
         "uma margem média de <b>" + fPct(margemMedia, 2) + "</b>. " +
         "<b>" + fInt(abaixo) + "</b> itens saíram abaixo de " + limite + "%.",
    kpis: [
      { rotulo: "Venda no período", numero: n(r.venda), formatar: fCurto, titulo: fR$(r.venda), tom: "info",
        sub: fInt(r.itens) + " itens faturados" },
      { rotulo: "Margem média", numero: margemMedia, formatar: function (v) { return fPct(v, 2); }, tom: "bom",
        sub: "no conjunto do período" },
      { rotulo: "Abaixo de " + limite + "%", numero: n(abaixo), formatar: fInt, tom: "atencao",
        sub: r.itens ? fPct(n(abaixo) / n(r.itens) * 100, 1) + " dos itens" : "—" },
      { rotulo: "Margem negativa", numero: n(r.negativa), formatar: fInt, tom: "grave",
        sub: "venderam abaixo do custo" }
    ]
  }));

  var f = el("div", "filtros sobe");
  f.appendChild(chips("Limite de margem", [5, 8, 10, 15, 20].map(function (x) {
    return { valor: x, rotulo: x + "%" };
  }), limite, function (v) { E.limiteMargem = v; desenhar(); }, "atencao"));
  f.appendChild(campoBusca("Buscar produto, nota, pedido ou RCA…"));
  raiz.appendChild(f);

  var piores = (D.margem.piores || []).filter(function (l) {
    if (n(l[8]) >= limite) return false;
    if (!E.busca) return true;
    var alvo = (l[1] + " " + l[2] + " " + l[4] + " " + nomeProduto(l[4]) + " " + nomeRca(l[3])).toLowerCase();
    return alvo.indexOf(E.busca) !== -1;
  });

  var btnCompleta = el("button", "btn-topo", "Baixar lista completa");
  btnCompleta.type = "button";
  btnCompleta.addEventListener("click", function () { baixarMargemCompleta(limite, btnCompleta); });

  var pt = painel("Itens abaixo de " + limite + "% de margem",
    "Do pior percentual para cima. A tela traz os 1.200 piores do período; a lista completa sai pelo botão, direto do banco.",
    btnCompleta);
  pt.corpo.remove();
  pt.appendChild(tabela({
    id: "margem",
    tituloCsv: "Itens abaixo de " + limite + "% de margem",
    filtrosExtras: function () { return [["Limite de margem", limite + "%"]]; },
    colunas: [
      { titulo: "Data", celula: function (l) { return fData(l[0]); }, fixa: 1 },
      { titulo: "Produto", celula: function (l) { return nomeProduto(l[4]); }, corta: true, destacar: true },
      { titulo: "Cód", num: true, celula: function (l) { return l[4]; }, fraco: true },
      { titulo: "RCA", celula: function (l) { return nomeRca(l[3]); }, corta: true, destacar: true },
      { titulo: "Nota", num: true, celula: function (l) { return l[1]; }, destacar: true, fraco: true },
      { titulo: "Qtd", num: true, celula: function (l) { return fNum(l[5], 0); } },
      { titulo: "Preço unit.", num: true, celula: function (l) { return fR$(l[6]); } },
      { titulo: "Venda", num: true, medida: true, celula: function (l) { return fR$(l[7]); }, csv: function (l) { return fNum(l[7]); } },
      { titulo: "Margem", num: true, celula: function (l) {
          return el("span", "selo " + (n(l[8]) < 0 ? "grave" : "atencao"), fPct(l[8], 2));
        }, csv: function (l) { return fNum(l[8]); } },
      { titulo: "Margem R$", num: true, celula: function (l) { return fR$(l[9]); }, csv: function (l) { return fNum(l[9]); } }
    ],
    linhas: piores,
    medida: function (l) { return n(l[7]); }, medidaCor: "viz-1",
    ordemInicial: 8, dirInicial: 1,
    valorOrdem: function (l, i) { return [l[0], nomeProduto(l[4]), l[4], nomeRca(l[3]), l[1], n(l[5]), n(l[6]), n(l[7]), n(l[8]), n(l[9])][i]; },
    totais: function (todas) {
      var venda = todas.reduce(function (s, l) { return s + n(l[7]); }, 0);
      var marg = todas.reduce(function (s, l) { return s + n(l[9]); }, 0);
      return [
        { rotulo: "Itens na lista", numero: todas.length, formatar: fInt },
        { rotulo: "Venda envolvida", numero: venda, formatar: fCurto, destaque: true, sub: fR$(venda) },
        { rotulo: "Margem gerada", numero: marg, formatar: fCurto, sub: fR$(marg) },
        { rotulo: "Margem média", numero: venda ? marg / venda * 100 : 0, formatar: function (v) { return fPct(v, 2); } }
      ];
    },
    csv: true,
    aviso: "os 1.200 piores do período",
    porPagina: 25
  }));
  raiz.appendChild(pt);

  var porRca = (D.margem.rca || [])
    .filter(function (l) { return passaFiltroRca(l[0], null); })
    .map(function (l) { return { cod: l[0], itens: n(l[1]), venda: n(l[2]), margem: n(l[3]), abaixo: n(l[4]) }; })
    .sort(function (a, b) { return b.abaixo - a.abaixo; })
    .slice(0, 12);
  if (porRca.length) {
    var pr = painel("Quem mais vendeu abaixo de 5% de margem",
      "Quantidade de itens abaixo de 5% por vendedor, no período filtrado.");
    var box = el("div");
    pr.corpo.appendChild(box);
    ranking(box, porRca.map(function (x) {
      return { nome: nomeRca(x.cod), valor: x.abaixo, rotulo: fInt(x.abaixo) + " itens · " + fCurto(x.venda) };
    }), { serie: "viz-3" });
    raiz.appendChild(pr);
  }

  var meses = D.margem.mes || [];
  if (meses.length) {
    var pm = painel("Venda e margem, mês a mês", "Toda a base carregada, independente do período escolhido acima.");
    serieTempo(pm.corpo, meses.map(function (m) {
      return { rotulo: rotuloMes(m[0]), barra: n(m[2]), linha: n(m[2]) ? n(m[3]) / n(m[2]) * 100 : null };
    }), {
      tituloBarra: "Venda (R$)", serieBarra: "viz-1", barraFmt: fCurtoSemMoeda, barraTooltip: fR$,
      tituloLinha: "Margem (%)", serieLinha: "viz-4", linhaFmt: function (v) { return fPct(v, 1); }
    });
    raiz.appendChild(pm);
  }
}

function baixarMargemCompleta(limite, botao) {
  botao.disabled = true;
  botao.textContent = "Buscando no banco…";
  buscarDetalhe("margem_item", String(limite), 20000).then(function (res) {
    exportarCsv({
      id: "margem-completa",
      tituloCsv: "Itens abaixo de " + limite + "% de margem (lista completa)",
      filtrosExtras: function () { return [["Limite de margem", limite + "%"], ["Teto de linhas", "20.000"]]; },
      colunas: [
        { titulo: "Data", celula: function (l) { return fData(l[0]); } },
        { titulo: "Nota", celula: function (l) { return l[1]; } },
        { titulo: "Pedido", celula: function (l) { return l[2]; } },
        { titulo: "RCA", celula: function (l) { return nomeRca(l[3]); } },
        { titulo: "Cód produto", celula: function (l) { return l[4]; } },
        { titulo: "Produto", celula: function (l) { return l[5] || nomeProduto(l[4]); } },
        { titulo: "Qtd", celula: function (l) { return fNum(l[6], 0); } },
        { titulo: "Preço unit.", celula: function (l) { return fNum(l[7]); } },
        { titulo: "Venda", celula: function (l) { return fNum(l[8]); } },
        { titulo: "Margem %", celula: function (l) { return fNum(l[9]); } },
        { titulo: "Margem R$", celula: function (l) { return fNum(l[10]); } }
      ]
    }, res.linhas || []);
    botao.disabled = false;
    botao.textContent = "Baixar lista completa";
  }).catch(function (e) {
    botao.disabled = false;
    botao.textContent = "Baixar lista completa";
    alert("Não consegui buscar a lista: " + e.message);
  });
}

/* ---------------------------------------------------------------------------
 * Página 3 — PEDIDOS EM ABERTO
 * ------------------------------------------------------------------------ */
function paginaPedidos(raiz) {
  var todos = D.pedidos || [];
  var posicoes = Array.from(new Set(todos.map(function (p) { return p[6]; }))).sort();
  var limite = E.limitePedido;

  var linhas = todos.filter(function (p) {
    if (E.posicoes && !E.posicoes.has(p[6])) return false;
    if (E.supervisor && String(p[4]) !== String(E.supervisor)) return false;
    if (E.busca) {
      var alvo = (p[1] + " " + p[2] + " " + nomeCliente(p[2]) + " " + nomeRca(p[3])).toLowerCase();
      if (alvo.indexOf(E.busca) === -1) return false;
    }
    return true;
  });
  var fora = linhas.filter(function (p) { return p[9] != null && n(p[9]) < limite; });
  var totalValor = linhas.reduce(function (s, p) { return s + n(p[7]); }, 0);
  var valorFora = fora.reduce(function (s, p) { return s + n(p[7]); }, 0);

  raiz.appendChild(heroi({
    rotulo: "Valor parado na carteira",
    valor: totalValor,
    formatar: fCurto,
    sub: "<b>" + fInt(linhas.length) + "</b> pedidos ainda não faturados. Destes, <b>" + fInt(fora.length) +
         "</b> estão abaixo de " + limite + "% de margem, somando <b>" + fCurto(valorFora) + "</b> — " +
         "é o que dá para segurar antes de faturar.",
    kpis: [
      { rotulo: "Pedidos em aberto", numero: linhas.length, formatar: fInt, tom: "info",
        sub: "não faturados nem cancelados" },
      { rotulo: "Abaixo de " + limite + "%", numero: fora.length, formatar: fInt, tom: "grave",
        sub: linhas.length ? fPct(fora.length / linhas.length * 100, 1) + " dos pedidos" : "—" },
      { rotulo: "Valor fora da margem", numero: valorFora, formatar: fCurto, titulo: fR$(valorFora), tom: "grave",
        sub: "para revisar antes do faturamento" },
      { rotulo: "Ticket médio", numero: linhas.length ? totalValor / linhas.length : 0, formatar: fCurto,
        tom: "atencao", sub: "por pedido em aberto" }
    ]
  }));

  var f = el("div", "filtros sobe");
  f.appendChild(chipsMultiplos("Posição", posicoes.map(function (p) { return { valor: p, rotulo: p }; }),
    E.posicoes, function (novo) { E.posicoes = novo; desenhar(); }));
  f.appendChild(chips("Margem mínima", [15, 20, 21, 25].map(function (x) { return { valor: x, rotulo: x + "%" }; }),
    limite, function (v) { E.limitePedido = v; desenhar(); }, "atencao"));
  f.appendChild(seletorSupervisor());
  f.appendChild(campoBusca("Buscar pedido, cliente ou RCA…"));
  raiz.appendChild(f);

  raiz.appendChild(nota("Esta página é uma <b>foto de agora</b>: vem da carteira do WinThor a cada carga, " +
    "não do período escolhido lá em cima.", ""));

  var pt = painel("Carteira em aberto — filial 1",
    "Pedido de bonificação não tem venda, então fica sem margem: aparece como “—”.");
  pt.corpo.remove();
  pt.appendChild(tabela({
    id: "pedidos",
    tituloCsv: "Pedidos em aberto",
    filtrosExtras: function () { return [["Margem mínima", limite + "%"], ["Posição", E.posicoes ? Array.from(E.posicoes).join(", ") : "todas"]]; },
    colunas: [
      { titulo: "Data", celula: function (p) { return fData(p[0]); }, fixa: 1 },
      { titulo: "Cliente", celula: function (p) { return nomeCliente(p[2]); }, corta: true, destacar: true },
      { titulo: "Pedido", num: true, celula: function (p) { return p[1]; }, destacar: true, fraco: true },
      { titulo: "RCA", celula: function (p) { return nomeRca(p[3]); }, corta: true, destacar: true },
      { titulo: "Supervisor", celula: function (p) { return nomeSupervisor(p[4]); }, fraco: true, corta: true },
      { titulo: "Tipo", celula: function (p) { return p[5]; }, fraco: true },
      { titulo: "Posição", celula: function (p) {
          return el("span", "selo " + (p[6] === "LIBERADO" ? "bom" : p[6] === "BLOQUEADO" ? "grave" : "neutro"), p[6]);
        }, csv: function (p) { return p[6]; } },
      { titulo: "Valor", num: true, medida: true, celula: function (p) { return fR$(p[7]); }, csv: function (p) { return fNum(p[7]); } },
      { titulo: "Qtd", num: true, celula: function (p) { return fNum(p[8], 0); }, fraco: true },
      { titulo: "Margem", num: true, celula: function (p) {
          if (p[9] == null) return "—";
          return el("span", "selo " + (n(p[9]) < limite ? "grave" : "bom"), fPct(p[9], 2));
        }, csv: function (p) { return p[9] == null ? "" : fNum(p[9]); } }
    ],
    linhas: linhas,
    medida: function (p) { return n(p[7]); }, medidaCor: "viz-1",
    ordemInicial: 9, dirInicial: 1,
    valorOrdem: function (p, i) {
      return [p[0], nomeCliente(p[2]), p[1], nomeRca(p[3]), nomeSupervisor(p[4]), p[5], p[6],
              n(p[7]), n(p[8]), p[9] == null ? null : n(p[9])][i];
    },
    totais: function (todas) {
      var v = todas.reduce(function (s, p) { return s + n(p[7]); }, 0);
      var fo = todas.filter(function (p) { return p[9] != null && n(p[9]) < limite; });
      return [
        { rotulo: "Pedidos", numero: todas.length, formatar: fInt },
        { rotulo: "Valor em carteira", numero: v, formatar: fCurto, destaque: true, sub: fR$(v) },
        { rotulo: "Fora da margem", numero: fo.length, formatar: fInt },
        { rotulo: "Valor fora", numero: fo.reduce(function (s, p) { return s + n(p[7]); }, 0), formatar: fCurto }
      ];
    },
    csv: true,
    vazio: "Nenhum pedido em aberto com estes filtros.",
    porPagina: 25
  }));
  raiz.appendChild(pt);
}

/* ---------------------------------------------------------------------------
 * Página 4 — DEVOLUÇÕES
 * ------------------------------------------------------------------------ */
function paginaDevolucoes(raiz) {
  var t = D.devolucao.total_periodo || {};
  var linhas = (D.devolucao.linhas || []).filter(function (l) {
    if (E.soMotivoRca && !(MOTIVO_MAPA[l[4]] && MOTIVO_MAPA[l[4]][1])) return false;
    if (E.motivo && String(l[4]) !== String(E.motivo)) return false;
    if (!passaFiltroRca(l[3], l[5])) return false;
    if (E.busca) {
      var alvo = (l[1] + " " + l[2] + " " + nomeCliente(l[2]) + " " + nomeRca(l[3]) + " " + motivoDe(l[4])).toLowerCase();
      if (alvo.indexOf(E.busca) === -1) return false;
    }
    return true;
  });
  var valorFiltrado = linhas.reduce(function (s, l) { return s + n(l[7]); }, 0);
  var valorRca = n(t.valor_rca), valorTotal = n(t.valor);

  raiz.appendChild(heroi({
    rotulo: "Devolvido no período",
    valor: valorTotal,
    formatar: fCurto,
    sub: "<b>" + fInt(t.notas) + "</b> notas de entrada. <b>" + fCurto(valorRca) + "</b> (" +
         fPct(valorTotal ? valorRca / valorTotal * 100 : 0, 1) + ") por motivos comerciais, " +
         "que são os atribuíveis ao vendedor.",
    kpis: [
      { rotulo: "Responsabilidade do RCA", numero: valorRca, formatar: fCurto, titulo: fR$(valorRca), tom: "atencao",
        sub: valorTotal ? fPct(valorRca / valorTotal * 100, 1) + " do total" : "—",
        ajuda: "Motivos comerciais: não pediu, preço errado, pedido repetido, sem dinheiro… Erro de carregamento, atraso e produto danificado ficam de fora." },
      { rotulo: "No filtro atual", numero: valorFiltrado, formatar: fCurto, titulo: fR$(valorFiltrado), tom: "info",
        sub: fInt(linhas.length) + " linhas",
        ajuda: "Este cartão segue exatamente os mesmos filtros da tabela abaixo." },
      { rotulo: "Notas de entrada", numero: n(t.notas), formatar: fInt, tom: "roxo", sub: "no período" },
      { rotulo: "Valor médio por nota", numero: n(t.notas) ? valorTotal / n(t.notas) : 0, formatar: fCurto,
        sub: "devolvido por nota" }
    ]
  }));

  var f = el("div", "filtros sobe");
  f.appendChild(chips("Responsabilidade", [
    { valor: "todos", rotulo: "Todos os motivos" },
    { valor: "rca", rotulo: "Só do vendedor" }
  ], E.soMotivoRca ? "rca" : "todos", function (v) { E.soMotivoRca = (v === "rca"); desenhar(); }, "atencao"));
  var gm = el("div", "fgrupo");
  gm.appendChild(el("span", "frot", "Motivo"));
  var sel = el("select");
  var o0 = el("option", null, "Todos"); o0.value = ""; sel.appendChild(o0);
  (D.motivos || []).forEach(function (m) {
    var o = el("option", null, m[1] + (m[2] ? " ·" : ""));
    o.value = m[0];
    if (String(E.motivo) === String(m[0])) o.selected = true;
    sel.appendChild(o);
  });
  sel.addEventListener("change", function () { E.motivo = sel.value; desenhar(); });
  gm.appendChild(sel);
  f.appendChild(gm);
  f.appendChild(seletorSupervisor());
  f.appendChild(campoBusca("Buscar nota, cliente, RCA ou motivo…"));
  raiz.appendChild(f);

  var pg = painel("De quem é a devolução",
    "Motivos comerciais são do vendedor; erro de carregamento, atraso na entrega e produto danificado são da operação.");
  var caixa = el("div");
  pg.corpo.appendChild(caixa);
  barraProporcao(caixa, [
    { rotulo: "Do vendedor", valor: valorRca, cor: "atencao" },
    { rotulo: "Da operação", valor: Math.max(0, valorTotal - valorRca), cor: "viz-3" }
  ], "Valor pela linha da nota (quantidade × preço contábil), que é somável. O total das notas de entrada no período, com ST e despesas, é " + fCurto(t.vltotal_somado) + ".");
  raiz.appendChild(pg);

  var porRca = new Map();
  linhas.forEach(function (l) { porRca.set(l[3], n(porRca.get(l[3])) + n(l[7])); });
  var listaRca = Array.from(porRca.entries())
    .map(function (e) { return { cod: e[0], valor: e[1] }; })
    .sort(function (a, b) { return b.valor - a.valor; })
    .slice(0, 12);
  if (listaRca.length) {
    var pr = painel("Devolução por vendedor", "Somente o que está nos filtros atuais.");
    var box = el("div");
    pr.corpo.appendChild(box);
    ranking(box, listaRca.map(function (x) {
      return { nome: nomeRca(x.cod), valor: x.valor, rotulo: fCurto(x.valor) };
    }), { serie: "viz-3" });
    raiz.appendChild(pr);
  }

  var pt = painel("Notas devolvidas", "As 4.000 maiores do período. Clique numa linha para ver todas as devoluções do vendedor.");
  pt.corpo.remove();
  pt.appendChild(tabela({
    id: "devolucao",
    tituloCsv: "Devoluções",
    filtrosExtras: function () {
      return [["Motivo", E.motivo ? motivoDe(E.motivo) : "todos"],
              ["Só responsabilidade do RCA", E.soMotivoRca ? "sim" : "não"]];
    },
    colunas: [
      { titulo: "Data", celula: function (l) { return fData(l[0]); }, fixa: 1 },
      { titulo: "Cliente", celula: function (l) { return nomeCliente(l[2]); }, corta: true, destacar: true },
      { titulo: "Nota", num: true, celula: function (l) { return l[1]; }, destacar: true, fraco: true },
      { titulo: "RCA", celula: function (l) { return nomeRca(l[3]); }, corta: true, destacar: true },
      { titulo: "Motivo", celula: function (l) {
          var m = MOTIVO_MAPA[l[4]];
          return el("span", "selo " + (m && m[1] ? "atencao" : "neutro"), m ? m[0] : "—");
        }, csv: function (l) { return motivoDe(l[4]); } },
      { titulo: "Filial", num: true, celula: function (l) { return l[5]; }, fraco: true },
      { titulo: "Qtd", num: true, celula: function (l) { return fNum(l[6], 0); }, fraco: true },
      { titulo: "Valor devolvido", num: true, medida: true, celula: function (l) { return fR$(l[7]); }, csv: function (l) { return fNum(l[7]); } },
      { titulo: "Total da nota", num: true, celula: function (l) { return fR$(l[8]); }, fraco: true, csv: function (l) { return fNum(l[8]); } }
    ],
    linhas: linhas,
    medida: function (l) { return n(l[7]); }, medidaCor: "viz-3",
    ordemInicial: 7,
    valorOrdem: function (l, i) {
      return [l[0], nomeCliente(l[2]), l[1], nomeRca(l[3]), motivoDe(l[4]), l[5], n(l[6]), n(l[7]), n(l[8])][i];
    },
    totais: function (todas) {
      var v = todas.reduce(function (s, l) { return s + n(l[7]); }, 0);
      var doRca = todas.filter(function (l) { return MOTIVO_MAPA[l[4]] && MOTIVO_MAPA[l[4]][1]; })
                       .reduce(function (s, l) { return s + n(l[7]); }, 0);
      return [
        { rotulo: "Linhas", numero: todas.length, formatar: fInt },
        { rotulo: "Valor devolvido", numero: v, formatar: fCurto, destaque: true, sub: fR$(v) },
        { rotulo: "Do vendedor", numero: doRca, formatar: fCurto },
        { rotulo: "Participação do vendedor", numero: v ? doRca / v * 100 : 0, formatar: function (x) { return fPct(x, 1); } }
      ];
    },
    aoClicar: function (l) { abrirDevolucoesDoRca(l[3]); },
    csv: true,
    porPagina: 25
  }));
  raiz.appendChild(pt);

  var meses = D.devolucao.mes || [];
  if (meses.length) {
    var pm = painel("Devolução mês a mês", "Toda a base carregada, independente do período escolhido acima.");
    serieTempo(pm.corpo, meses.map(function (m) {
      return { rotulo: rotuloMes(m[0]), barra: n(m[1]), linha: n(m[1]) ? n(m[2]) / n(m[1]) * 100 : null };
    }), {
      tituloBarra: "Devolvido (R$)", serieBarra: "viz-3", barraFmt: fCurtoSemMoeda, barraTooltip: fR$,
      tituloLinha: "Quanto disso é do vendedor (%)", serieLinha: "viz-2",
      linhaFmt: function (v) { return fPct(v, 0); }
    });
    raiz.appendChild(pm);
  }
}

function abrirDevolucoesDoRca(codusur) {
  var corpo = abrirModal("Devoluções · detalhe", nomeRca(codusur), [
    ["Período", fData(E.de) + " a " + fData(E.ate)]
  ], function (corpo) { corpo.appendChild(el("div", "vazio", "Buscando no banco…")); });

  buscarDetalhe("devolucao_rca", codusur).then(function (res) {
    limpar(corpo);
    corpo.appendChild(tabela({
      id: "devol_rca_" + codusur,
      tituloCsv: "Devoluções — " + nomeRca(codusur),
      colunas: [
        { titulo: "Data", celula: function (l) { return fData(l[0]); }, fixa: 1 },
        { titulo: "Cliente", celula: function (l) { return nomeCliente(l[2]); }, corta: true },
        { titulo: "Nota", num: true, celula: function (l) { return l[1]; }, fraco: true },
        { titulo: "Motivo", celula: function (l) { return motivoDe(l[3]); }, corta: true },
        { titulo: "Filial", num: true, celula: function (l) { return l[4]; }, fraco: true },
        { titulo: "Qtd", num: true, celula: function (l) { return fNum(l[5], 0); }, fraco: true },
        { titulo: "Valor devolvido", num: true, medida: true, celula: function (l) { return fR$(l[6]); }, csv: function (l) { return fNum(l[6]); } },
        { titulo: "Total da nota", num: true, celula: function (l) { return fR$(l[7]); }, fraco: true }
      ],
      linhas: res.linhas || [],
      medida: function (l) { return n(l[6]); }, medidaCor: "viz-3",
      ordemInicial: 6,
      valorOrdem: function (l, i) { return [l[0], nomeCliente(l[2]), l[1], motivoDe(l[3]), l[4], n(l[5]), n(l[6]), n(l[7])][i]; },
      totais: function (todas) {
        var v = todas.reduce(function (s, l) { return s + n(l[6]); }, 0);
        return [
          { rotulo: "Notas", numero: todas.length, formatar: fInt },
          { rotulo: "Valor devolvido", numero: v, formatar: fCurto, destaque: true, sub: fR$(v) }
        ];
      },
      csv: true, porPagina: 25,
      vazio: "Nenhuma devolução deste RCA no período."
    }));
  }).catch(function (e) {
    limpar(corpo).appendChild(nota("Não consegui buscar: " + e.message, "grave"));
  });
}

/* ---------------------------------------------------------------------------
 * Barra de período
 * ------------------------------------------------------------------------ */
function barraPeriodo() {
  var b = el("div", "periodo sobe");
  b.appendChild(el("span", "rot", "Período"));

  var sel = el("select");
  var meses = mesesDisponiveis();
  var atual = mesSelecionado();
  meses.forEach(function (m) {
    var o = el("option", null, rotuloMesLongo(m));
    o.value = m;
    if (m === atual) o.selected = true;
    sel.appendChild(o);
  });
  var oLivre = el("option", null, "Intervalo personalizado");
  oLivre.value = "livre";
  if (!atual) oLivre.selected = true;
  sel.appendChild(oLivre);
  sel.addEventListener("change", function () {
    if (sel.value === "livre") { desenhar(); return; }
    var de = sel.value + "-01";
    var ate = ultimoDiaDoMes(sel.value);
    if (ate > hoje()) ate = hoje();
    trocarPeriodo(de, ate);
  });
  b.appendChild(sel);

  var de = el("input"); de.type = "date"; de.value = E.de;
  var ate = el("input"); ate.type = "date"; ate.value = E.ate;
  de.addEventListener("change", function () { trocarPeriodo(de.value, ate.value); });
  ate.addEventListener("change", function () { trocarPeriodo(de.value, ate.value); });
  b.appendChild(el("span", "sep", "de"));
  b.appendChild(de);
  b.appendChild(el("span", "sep", "até"));
  b.appendChild(ate);

  var dias = Math.round((new Date(E.ate) - new Date(E.de)) / 86400000) + 1;
  b.appendChild(el("span", "badge", fData(E.de) + " → " + fData(E.ate) + " · " + fInt(dias) + (dias === 1 ? " dia" : " dias")));
  return b;
}

function mesesDisponiveis() {
  var lista = [];
  var fim = new Date(hoje());
  for (var i = 0; i < 24; i++) {
    var d = new Date(fim.getFullYear(), fim.getMonth() - i, 1);
    lista.push(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"));
  }
  return lista;
}
function rotuloMesLongo(m) {
  var p = m.split("-");
  return MESES_LONGO[+p[1] - 1] + "/" + p[0];
}
function ultimoDiaDoMes(m) {
  var p = m.split("-");
  var d = new Date(+p[0], +p[1], 0);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function mesSelecionado() {
  if (!E.de || !E.ate) return null;
  if (E.de.slice(0, 7) !== E.ate.slice(0, 7)) return null;
  if (E.de.slice(8) !== "01") return null;
  var fim = ultimoDiaDoMes(E.de.slice(0, 7));
  if (E.ate !== fim && E.ate !== hoje()) return null;
  return E.de.slice(0, 7);
}

function trocarPeriodo(de, ate) {
  if (!de || !ate) return;
  if (de > ate) { var t = de; de = ate; ate = t; }
  E.de = de; E.ate = ate;
  carregar(false);
}

/* ---------------------------------------------------------------------------
 * Busca de dados
 * ------------------------------------------------------------------------ */
function trabalhando(ligado) {
  document.getElementById("trabalhando").classList.toggle("on", !!ligado);
}

function buscarDados(forcar) {
  var url = "/api/dados?de=" + encodeURIComponent(E.de) + "&ate=" + encodeURIComponent(E.ate);
  var opcoes = { headers: { Accept: "application/json" } };
  if (forcar) { url += "&atualizar=" + Date.now(); opcoes.cache = "no-store"; }
  return fetch(url, opcoes).then(lerResposta);
}

function buscarDetalhe(tipo, chave, limite) {
  trabalhando(true);
  var url = "/api/detalhe?tipo=" + encodeURIComponent(tipo) +
            "&de=" + encodeURIComponent(E.de) + "&ate=" + encodeURIComponent(E.ate) +
            (chave == null ? "" : "&chave=" + encodeURIComponent(chave)) +
            (limite ? "&limite=" + limite : "");
  return fetch(url, { headers: { Accept: "application/json" } })
    .then(lerResposta)
    .then(function (r) { trabalhando(false); return r; })
    .catch(function (e) { trabalhando(false); throw e; });
}

function lerResposta(r) {
  return r.json().then(function (corpo) {
    if (!r.ok) {
      /* A mensagem amigável sozinha não resolve nada para quem vai consertar:
         o motivo real (senha errada, pooler dormindo, variável faltando) vem
         em `detalhe` e tem que chegar na tela junto. */
      var erro = new Error((corpo && corpo.mensagem) || ("HTTP " + r.status));
      erro.detalhe = corpo && corpo.detalhe;
      erro.http = r.status;
      throw erro;
    }
    return corpo;
  }, function () {
    var erro = new Error("A resposta do servidor não veio em JSON (HTTP " + r.status + ").");
    erro.http = r.status;
    if (r.status === 504) {
      erro.detalhe = "A função da Vercel estourou 60 segundos. Costuma ser o primeiro acesso " +
                     "depois de um tempo parado, com o banco e o pooler acordando juntos. " +
                     "Tente de novo — a segunda chamada costuma responder na hora.";
    }
    throw erro;
  });
}

function carregar(forcar) {
  if (carregandoPeriodo) return;
  carregandoPeriodo = true;
  trabalhando(true);
  var demorou = setTimeout(function () {
    var t = document.getElementById("carregandoTexto");
    if (t) t.textContent = "Primeiro acesso depois de um tempo parado — o banco está acordando. Isso leva alguns segundos.";
  }, 7000);
  buscarDados(forcar).then(function (dados) {
    clearTimeout(demorou);
    aplicar(dados);
    carregandoPeriodo = false;
    trabalhando(false);
    document.getElementById("raiz").hidden = false;
    var c = document.getElementById("carregando");
    if (c) c.remove();
    desenhar();
  }).catch(function (e) {
    clearTimeout(demorou);
    carregandoPeriodo = false;
    trabalhando(false);
    falhar(e);
  });
}

function aplicar(dados) {
  D = dados;
  MOTIVO_MAPA = {};
  (D.motivos || []).forEach(function (m) { MOTIVO_MAPA[m[0]] = [m[1], m[2]]; });
  E.de = String(D.periodo.de).slice(0, 10);
  E.ate = String(D.periodo.ate).slice(0, 10);
  E.pag = {};
}

function falhar(e) {
  var caixa = document.getElementById("carregando");
  if (!caixa) { alert("Não consegui atualizar: " + e.message); return; }
  caixa.classList.add("falhou");
  document.getElementById("carregandoTexto").textContent = "Não consegui carregar os dados.";
  var box = el("div", "erro");
  box.appendChild(document.createTextNode(
    "O painel lê o DATA WAREHOUSE pela função /api/dados. Se isto acabou de ser publicado, " +
    "confira as variáveis de ambiente do projeto na Vercel."));
  box.appendChild(el("code", null, (e && e.message ? e.message : String(e)) +
                                   (e && e.http ? "  ·  HTTP " + e.http : "")));
  if (e && e.detalhe) box.appendChild(el("code", null, e.detalhe));
  caixa.appendChild(box);
  var btn = el("button", null, "Tentar de novo");
  btn.addEventListener("click", function () { location.reload(); });
  caixa.appendChild(btn);
}

/* ---------------------------------------------------------------------------
 * Desenho
 * ------------------------------------------------------------------------ */
function desenhar(manterRolagem) {
  var y = window.scrollY;
  var raiz = limpar(document.getElementById("pagina"));

  var pg = PAGINAS.filter(function (p) { return p.id === E.pagina; })[0] || PAGINAS[0];
  document.getElementById("topo-titulo").textContent = pg.nome;
  document.getElementById("topo-eyebrow").textContent = "Business Intelligence · Comercial";
  document.title = pg.nome + " — Central Comercial";

  raiz.appendChild(barraPeriodo());

  var corpo = el("div");
  corpo.style.cssText = "display:flex;flex-direction:column;gap:16px;margin-top:16px;";
  raiz.appendChild(corpo);

  if (E.pagina === "comissao") paginaComissao(corpo);
  else if (E.pagina === "margem") paginaMargem(corpo);
  else if (E.pagina === "pedidos") paginaPedidos(corpo);
  else paginaDevolucoes(corpo);

  document.getElementById("ultima-carga").textContent = fDataHora(D.carga && D.carga.ultima);
  document.getElementById("rodape").innerHTML =
    "Dado ao vivo do <b>DATA WAREHOUSE</b> no Supabase, alimentado a partir do Oracle/WinThor · " +
    "Lube Distribuidora LTDA";

  desenharMenu();
  if (manterRolagem) window.scrollTo(0, y);
}

function desenharMenu() {
  var m = limpar(document.getElementById("menu"));
  PAGINAS.forEach(function (p) {
    var b = el("button", "side-item" + (p.id === E.pagina ? " ativo" : ""));
    b.type = "button";
    var ic = el("span", "ic");
    var svg = svgEl("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
                             "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" });
    svg.appendChild(svgEl("path", { d: p.icone }));
    ic.appendChild(svg);
    b.appendChild(ic);
    b.appendChild(document.createTextNode(p.nome));
    b.addEventListener("click", function () {
      E.pagina = p.id;
      E.busca = "";
      document.getElementById("side").classList.remove("aberto");
      desenhar();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    m.appendChild(b);
  });
}

/* ---------------------------------------------------------------------------
 * Início
 * ------------------------------------------------------------------------ */
document.getElementById("menu-btn").addEventListener("click", function () {
  document.getElementById("side").classList.toggle("aberto");
});
document.getElementById("veu").addEventListener("click", function () {
  document.getElementById("side").classList.remove("aberto");
});
document.getElementById("btn-atualizar").addEventListener("click", function () {
  var b = this;
  b.disabled = true; b.classList.add("girando");
  buscarDados(true).then(function (dados) {
    aplicar(dados);
    b.disabled = false; b.classList.remove("girando");
    desenhar(true);
  }).catch(function (e) {
    b.disabled = false; b.classList.remove("girando");
    alert("Não consegui atualizar: " + e.message);
  });
});

E.ate = hoje();
E.de = primeiroDiaDoMes(E.ate);
carregar(false);

})();
