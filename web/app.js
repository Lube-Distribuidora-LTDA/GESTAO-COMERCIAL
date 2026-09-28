/* =============================================================================
 * Central Comercial — painel do BI COMERCIAL da Lube Distribuidora
 *
 * Todo o conteúdo vem de /api/dados (que chama comercial.painel_dados no
 * Supabase) e, para as listas grandes, de /api/detalhe. Aqui não há regra de
 * negócio inventada: a régua da comissão chega no payload, vinda da tabela
 * comercial.dim_faixa_comissao.
 *
 * Quatro páginas: Comissão, Margem por item, Pedidos em aberto e Devoluções.
 * ========================================================================== */
(function () {
"use strict";

/* ---------------------------------------------------------------------------
 * Estado
 * ------------------------------------------------------------------------ */
var D = null;                       // payload do /api/dados
var carregandoPeriodo = false;

var E = {
  pagina: "comissao",
  de: null, ate: null,              // período (strings AAAA-MM-DD)
  filiais: null,                    // Set; null = todas
  supervisor: "",                   // "" = todos
  busca: "",
  grao: "rca",                      // "rca" | "rca_filial"
  limiteMargem: 5,                  // % usado nas páginas de margem
  limitePedido: 20,
  posicoes: null,                   // Set; null = todas
  soMotivoRca: false,
  motivo: "",
  ordem: {}, pag: {}
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
/* R$ 1,25 mi / R$ 14,4 mil — cabe dentro de barra e de cartão */
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
function motivoDe(cod) {
  var m = MOTIVO_MAPA[cod];
  return m ? m[0] : "—";
}
var MOTIVO_MAPA = {};

/* ---------------------------------------------------------------------------
 * A régua da comissão — vem do banco, não está escrita aqui
 * ------------------------------------------------------------------------ */
function percComissao(margemPerc) {
  var p = (margemPerc == null || isNaN(margemPerc)) ? -999999 : margemPerc;
  for (var i = 0; i < D.faixas.length; i++) {
    var f = D.faixas[i];                       // [perc_min, perc_max, perc_comissao]
    if (p >= n(f[0]) && (f[1] == null || p < n(f[1]))) return n(f[2]) / 100;
  }
  return 0;
}

/* Soma os componentes e aplica a faixa UMA vez, no grão pedido.
 * É esta função, e só ela, que decide quanto um RCA recebe. */
function calcular(c) {
  var totalLiquido = c.venda - c.devSt;             // [44] base do pagamento
  var totalLiquidoSst = c.venda - c.devSst;         // [Medida 6] denominador do %
  var cmvLiquido = c.cmvVenda - c.cmvDev + c.descfin + c.cmvBonif - c.st;   // [45]
  var massa = totalLiquidoSst - cmvLiquido;                                  // [46]
  var perc = totalLiquidoSst ? (massa / totalLiquidoSst) * 100 : null;       // [47]
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
 * Filtros aplicados às linhas de comissão
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
 * Componentes visuais
 * ------------------------------------------------------------------------ */
function blocoKpis(defs) {
  var g = el("div", "kpis");
  defs.forEach(function (d, i) {
    var k = el("div", "kpi rise " + (d.tom || ""));
    k.style.animationDelay = Math.min(i * 40, 300) + "ms";
    if (d.grande) k.classList.add("grande");
    var lbl = el("div", "lbl");
    lbl.appendChild(document.createTextNode(d.rotulo));
    if (d.ajuda) {
      var a = el("span", "ajuda", "i"); a.tabIndex = 0;
      a.appendChild(el("span", "tip", d.ajuda));
      lbl.appendChild(a);
    }
    k.appendChild(lbl);
    var v = el("div", "val", d.valor);
    if (d.titulo) v.title = d.titulo;
    k.appendChild(v);
    if (d.sub) k.appendChild(el("div", "sub", d.sub));
    g.appendChild(k);
  });
  return g;
}

function painel(titulo, sub, acoes) {
  var p = el("section", "painel rise");
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
  p.cabecalho = cab;
  return p;
}

function nota(texto, tom) {
  var d = el("div", "nota " + (tom || ""));
  d.appendChild(el("span", "ic", tom === "alerta" ? "!" : tom === "aviso" ? "!" : "i"));
  var p = el("div");
  p.innerHTML = texto;
  d.appendChild(p);
  return d;
}

function chips(rotulo, opcoes, atual, aoEscolher, tom) {
  var g = el("div", "fgrupo");
  g.appendChild(el("span", "frot", rotulo));
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
      var novo = new Set(conjunto == null ? opcoes.map(function (x) { return x.valor; }) : conjunto);
      if (novo.has(o.valor)) novo.delete(o.valor); else novo.add(o.valor);
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
  s.className = "";
  s.style.cssText = "background:var(--surface-2);border:1px solid var(--line-1);color:var(--txt-1);border-radius:10px;padding:7px 10px;font-size:12.5px;font-weight:700;cursor:pointer;";
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

/* ---------- gráfico de colunas com rótulo de dados ---------- */
function colunas(caixa, dados, opts) {
  opts = opts || {};
  limpar(caixa);
  if (!dados.length) { caixa.appendChild(el("div", "vazio", "Sem dados no período.")); return; }
  var larguraCol = opts.larguraCol || 46;
  var L = Math.max(620, dados.length * larguraCol + 110);
  var A = opts.altura || 250;
  var mostrarRotulos = dados.length <= 26 && opts.rotulos !== false;
  var mE = 68, mD = opts.linha ? 58 : 16, mT = mostrarRotulos ? 34 : 16, mB = 34;
  var pw = L - mE - mD, ph = A - mT - mB;
  var svg = svgEl("svg", { viewBox: "0 0 " + L + " " + A, width: L, height: A, role: "img",
                           "aria-label": opts.aria || "Gráfico de colunas" });

  var maxV = Math.max.apply(null, dados.map(function (d) { return Math.abs(n(d.valor)); })) || 1;
  var passos = 4;
  var escala = Math.pow(10, Math.floor(Math.log10(maxV / passos)));
  var passo = Math.ceil(maxV / passos / escala) * escala;
  var topo = passo * passos || 1;

  for (var i = 0; i <= passos; i++) {
    var y = mT + ph - (i * passo / topo) * ph;
    svg.appendChild(svgEl("line", { x1: mE, y1: y, x2: mE + pw, y2: y, stroke: "var(--grid)", "stroke-width": 1 }));
    var t = svgEl("text", { x: mE - 9, y: y + 4, "text-anchor": "end", "font-size": 10, "font-weight": 700,
                            fill: "var(--txt-3)", "font-family": "JetBrains Mono, monospace" });
    t.textContent = opts.eixoFmt ? opts.eixoFmt(i * passo) : fCurtoSemMoeda(i * passo);
    svg.appendChild(t);
  }

  var bw = Math.min(30, (pw / dados.length) * 0.58);
  var crescer = [], rotulos = [];
  dados.forEach(function (d, i) {
    var cx = mE + (i + 0.5) * (pw / dados.length);
    var h = Math.max(1, (Math.abs(n(d.valor)) / topo) * ph);
    var y = mT + ph - h;
    var barra = svgEl("rect", { class: "barra", x: cx - bw / 2, y: semMovimento ? y : mT + ph,
                                width: bw, height: semMovimento ? h : 0, rx: 5,
                                fill: "var(--" + (d.cor || opts.cor || "brand-blue-lt") + ")" });
    var tit = svgEl("title", {});
    tit.textContent = d.rotulo + ": " + (opts.valorTooltip ? opts.valorTooltip(d.valor) : fR$(d.valor));
    barra.appendChild(tit);
    svg.appendChild(barra);
    if (!semMovimento) crescer.push([barra, y, h]);

    /* rótulo de dados em cima da coluna — não quero passar o mouse para saber
       quanto é. Se não couber (coluna estreita demais), fica só o tooltip. */
    if (mostrarRotulos && Math.abs(n(d.valor)) > 0) {
      var r = svgEl("text", { x: cx, y: y - 9, "text-anchor": "middle", "font-size": 10.5,
                              "font-weight": 800, fill: "var(--txt-1)", "font-family": "JetBrains Mono, monospace" });
      r.textContent = opts.valorFmt ? opts.valorFmt(d.valor) : fCurtoSemMoeda(d.valor);
      r.style.opacity = semMovimento ? 1 : 0;
      r.style.transition = "opacity .35s ease";
      svg.appendChild(r);
      if (!semMovimento) rotulos.push(r);
    }
    var lb = svgEl("text", { x: cx, y: A - 12, "text-anchor": "middle", "font-size": 10,
                             "font-weight": 600, fill: "var(--txt-3)" });
    lb.textContent = d.rotulo;
    svg.appendChild(lb);
  });

  if (opts.linha) {
    var vals = opts.linha.filter(function (v) { return v != null; });
    var maxL = Math.max.apply(null, vals) || 1, minL = Math.min.apply(null, vals);
    var faixa = (maxL - minL) || 1;
    var pts = [];
    opts.linha.forEach(function (v, i) {
      if (v == null) return;
      var cx = mE + (i + 0.5) * (pw / dados.length);
      var y = mT + ph - ((v - minL) / faixa) * ph * 0.72 - ph * 0.14;
      pts.push([cx, y, v]);
    });
    if (pts.length) {
      svg.appendChild(svgEl("polyline", {
        points: pts.map(function (p) { return p[0] + "," + p[1]; }).join(" "),
        fill: "none", stroke: "var(--" + (opts.linhaCor || "amber") + ")", "stroke-width": 2.4,
        "stroke-linejoin": "round", "stroke-linecap": "round"
      }));
      pts.forEach(function (p, i) {
        svg.appendChild(svgEl("circle", { cx: p[0], cy: p[1], r: 3.4,
          fill: "var(--" + (opts.linhaCor || "amber") + ")", stroke: "var(--navy-900)", "stroke-width": 1.6 }));
        if (mostrarRotulos) {
          var t = svgEl("text", { x: p[0], y: p[1] - 9, "text-anchor": "middle", "font-size": 9.5,
            "font-weight": 800, fill: "var(--" + (opts.linhaCor || "amber") + ")",
            "font-family": "JetBrains Mono, monospace" });
          t.textContent = opts.linhaFmt ? opts.linhaFmt(p[2]) : fPct(p[2], 1);
          svg.appendChild(t);
        }
      });
    }
  }

  caixa.appendChild(svg);
  if (crescer.length) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        crescer.forEach(function (c) { c[0].setAttribute("y", c[1]); c[0].setAttribute("height", c[2]); });
      });
    });
    setTimeout(function () { rotulos.forEach(function (t) { t.style.opacity = 1; }); }, 520);
  }
}

/* ---------- rosca ---------- */
function rosca(caixa, partes, leitura) {
  limpar(caixa);
  var total = partes.reduce(function (s, p) { return s + n(p.valor); }, 0) || 1;
  var env = el("div", "donut");
  var box = el("div", "donut-svg");
  var svg = svgEl("svg", { viewBox: "0 0 158 158" });
  svg.style.cssText = "width:100%;height:100%;transform:rotate(-90deg);";
  var r = 62, circ = 2 * Math.PI * r, offset = 0, segs = [];
  svg.appendChild(svgEl("circle", { cx: 79, cy: 79, r: r, fill: "none", stroke: "var(--surface-3)", "stroke-width": 19 }));
  partes.forEach(function (p) {
    var len = circ * (n(p.valor) / total);
    var seg = svgEl("circle", { cx: 79, cy: 79, r: r, fill: "none", stroke: "var(--" + p.cor + ")",
                                "stroke-width": 19, "stroke-linecap": "butt",
                                "stroke-dashoffset": -offset });
    var alvo = Math.max(len - 1.5, 0) + " " + (circ - len + 1.5);
    seg.setAttribute("stroke-dasharray", semMovimento ? alvo : "0 " + circ);
    seg.style.transition = "stroke-dasharray .9s var(--ease)";
    var t = svgEl("title", {}); t.textContent = p.rotulo + ": " + fR$(p.valor);
    seg.appendChild(t);
    svg.appendChild(seg);
    if (!semMovimento) segs.push([seg, alvo]);
    offset += len;
  });
  box.appendChild(svg);
  var centro = el("div", "donut-centro");
  var pctEl = el("span", "p", fPct(n(partes[0].valor) / total * 100, 1));
  pctEl.style.color = "var(--" + partes[0].cor + ")";
  centro.appendChild(pctEl);
  centro.appendChild(el("span", "r", partes[0].rotulo));
  box.appendChild(centro);
  env.appendChild(box);

  var leg = el("div", "donut-leg");
  partes.forEach(function (p) {
    var l = el("div", "l");
    var sw = el("span", "sw"); sw.style.background = "var(--" + p.cor + ")";
    l.appendChild(sw);
    l.appendChild(el("span", "lb", p.rotulo));
    l.appendChild(el("span", "vl", fCurto(p.valor) + " · " + fPct(n(p.valor) / total * 100, 1)));
    leg.appendChild(l);
  });
  if (leitura) {
    var p = el("p", null, leitura);
    p.style.cssText = "margin:4px 0 0;font-size:12px;color:var(--txt-3);line-height:1.55;font-weight:500;";
    leg.appendChild(p);
  }
  env.appendChild(leg);
  caixa.appendChild(env);
  if (segs.length) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { segs.forEach(function (s) { s[0].setAttribute("stroke-dasharray", s[1]); }); });
    });
  }
}

/* ---------- ranking horizontal ---------- */
function ranking(caixa, itens, opts) {
  opts = opts || {};
  limpar(caixa);
  if (!itens.length) { caixa.appendChild(el("div", "vazio", "Sem dados no período.")); return; }
  var lista = el("div", "rank");
  var max = itens.reduce(function (m, i) { return Math.max(m, Math.abs(n(i.valor))); }, 0) || 1;
  var barras = [];
  itens.forEach(function (i) {
    var l = el("div", "rank-l");
    l.appendChild(el("div", "rank-nome", i.nome));
    var trilho = el("div", "rank-trilho");
    var b = el("div", "rank-barra");
    var alvo = Math.max(1.5, Math.abs(n(i.valor)) / max * 100) + "%";
    b.style.width = semMovimento ? alvo : "0%";
    b.style.background = "var(--" + (i.cor || opts.cor || "brand-blue-lt") + ")";
    trilho.appendChild(b);
    l.appendChild(trilho);
    l.appendChild(el("div", "rank-val", i.rotulo));
    l.title = i.nome + ": " + i.rotulo;
    lista.appendChild(l);
    if (!semMovimento) barras.push([b, alvo]);
  });
  caixa.appendChild(lista);
  if (barras.length) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { barras.forEach(function (b) { b[0].style.width = b[1]; }); });
    });
  }
}

/* ---------- tabela com ordenação, paginação e exportação ---------- */
function tabela(cfg) {
  var chave = cfg.id;
  var ordem = E.ordem[chave] || { campo: cfg.ordemInicial, dir: cfg.dirInicial == null ? -1 : cfg.dirInicial };
  E.ordem[chave] = ordem;
  var pagina = E.pag[chave] || 1;
  var porPagina = cfg.porPagina || 60;

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
  var totalPaginas = Math.max(1, Math.ceil(totalLinhas / porPagina));
  if (pagina > totalPaginas) { pagina = totalPaginas; E.pag[chave] = pagina; }
  var visiveis = linhas.slice((pagina - 1) * porPagina, pagina * porPagina);

  var env = el("div");
  var rol = el("div", "tabela-rolagem");
  var t = el("table", "dados");
  var thead = el("thead");
  var tr = el("tr");
  cfg.colunas.forEach(function (c, i) {
    var th = el("th", (c.num ? "n " : "") + (ordem.campo === i ? "ordenado" : ""));
    th.appendChild(document.createTextNode(c.titulo));
    var seta = el("span", "seta", ordem.campo === i ? (ordem.dir === 1 ? "▲" : "▼") : "▾");
    th.appendChild(seta);
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
  visiveis.forEach(function (linha) {
    var tr = el("tr");
    if (cfg.aoClicar) {
      tr.className = "clicavel";
      tr.addEventListener("click", function () { cfg.aoClicar(linha); });
    }
    cfg.colunas.forEach(function (c, i) {
      var td = el("td", (c.num ? "n " : "") + (c.fraco ? "fraco " : "") + (c.corta ? "corta" : ""));
      var conteudo = c.celula(linha);
      if (conteudo instanceof Node) td.appendChild(conteudo);
      else if (c.destacar && E.busca) escreverComDestaque(td, conteudo, E.busca);
      else td.textContent = conteudo == null ? "—" : conteudo;
      if (c.titulo2) td.title = c.titulo2(linha) || "";
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  });
  t.appendChild(tb);

  if (cfg.total && totalLinhas) {
    var tf = el("tfoot");
    var trT = el("tr", "total");
    cfg.colunas.forEach(function (c, i) {
      var td = el("td", c.num ? "n" : "");
      td.textContent = cfg.total(linhas, i) || (i === 0 ? "Total" : "");
      trT.appendChild(td);
    });
    tf.appendChild(trT);
    t.appendChild(tf);
  }

  rol.appendChild(t);
  if (!totalLinhas) limpar(rol).appendChild(el("div", "vazio", cfg.vazio || "Nada encontrado com estes filtros."));
  env.appendChild(rol);

  var pe = el("div", "tabela-pe");
  pe.appendChild(el("div", "info",
    totalLinhas ? ("Mostrando " + fInt(visiveis.length) + " de " + fInt(totalLinhas) + " linhas" +
                   (cfg.aviso ? " · " + cfg.aviso : "")) : (cfg.aviso || "")));
  var dir = el("div");
  dir.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;";
  if (cfg.csv) {
    var bx = el("button", "btn-limpar", "Exportar CSV");
    bx.type = "button";
    bx.addEventListener("click", function () { exportarCsv(cfg, linhas); });
    dir.appendChild(bx);
  }
  if (totalPaginas > 1) {
    var pg = el("div", "paginas");
    var ant = el("button", null, "‹ Anterior"); ant.type = "button"; ant.disabled = pagina <= 1;
    ant.addEventListener("click", function () { E.pag[chave] = pagina - 1; desenhar(true); });
    var pos = el("button", null, "Próxima ›"); pos.type = "button"; pos.disabled = pagina >= totalPaginas;
    pos.addEventListener("click", function () { E.pag[chave] = pagina + 1; desenhar(true); });
    var meio = el("button", null, pagina + " / " + totalPaginas); meio.disabled = true;
    pg.appendChild(ant); pg.appendChild(meio); pg.appendChild(pos);
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
  var m = el("mark", null, s.slice(i, i + termo.length));
  td.appendChild(m);
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
      var v = c.csv ? c.csv(l) : c.celula(l);
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

/* ---------- modal ---------- */
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
  corpo.style.padding = "4px 0 0";
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

  /* agrega no grão escolhido */
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

  /* três formas de somar a mesma comissão — é o ponto mais delicado do BI */
  var geral = componentesVazios();
  linhas.forEach(function (l) { somar(geral, l); });
  var empresa = calcular(geral);
  var somaGrao = itens.reduce(function (s, i) { return s + i.comissao; }, 0);
  var porRcaFilial = (function () {
    var m = new Map();
    linhas.forEach(function (l) {
      var k = l[0] + "|" + l[1];
      if (!m.has(k)) m.set(k, componentesVazios());
      somar(m.get(k), l);
    });
    var t = 0;
    m.forEach(function (c) { t += calcular(c).comissao; });
    return t;
  })();
  var porRca = (function () {
    var m = new Map();
    linhas.forEach(function (l) {
      var k = String(l[0]);
      if (!m.has(k)) m.set(k, componentesVazios());
      somar(m.get(k), l);
    });
    var t = 0;
    m.forEach(function (c) { t += calcular(c).comissao; });
    return t;
  })();

  raiz.appendChild(blocoKpis([
    { rotulo: "Total líquido", valor: fCurto(empresa.totalLiquido), titulo: fR$(empresa.totalLiquido),
      tom: "money", grande: true, sub: "venda s/ ST − devolução c/ ST",
      ajuda: "É a base sobre a qual a comissão é paga: [30] − [37] do Power BI." },
    { rotulo: "Massa de margem", valor: fCurto(empresa.massa), titulo: fR$(empresa.massa),
      tom: "info", grande: true, sub: "total líquido − CMV líquido" },
    { rotulo: "% líquido da empresa", valor: fPct(empresa.perc, 2), tom: "roxo",
      sub: "margem do conjunto filtrado",
      ajuda: "É a margem do TOTAL. A faixa de cada RCA é calculada sobre a margem DELE, não sobre esta." },
    { rotulo: "Comissão a pagar", valor: fCurto(somaGrao), titulo: fR$(somaGrao), tom: "ok", grande: true,
      sub: "soma por " + (E.grao === "rca" ? "RCA" : "RCA × filial"),
      ajuda: "Soma das comissões calculadas uma a uma. Não é a faixa da empresa aplicada ao total — ver o bloco de conferência abaixo." },
    { rotulo: "RCAs com movimento", valor: fInt(itens.length), tom: "", sub: "no período e nos filtros" },
    { rotulo: "ST no período", valor: fCurto(empresa.st), titulo: fR$(empresa.st), tom: "aviso", grande: true,
      sub: "substituição tributária" }
  ]));

  /* filtros */
  var f = el("div", "filtros rise");
  var fil = filiaisDisponiveis();
  if (fil.length > 1) {
    f.appendChild(chipsMultiplos("Filial", fil.map(function (x) { return { valor: x, rotulo: "Filial " + x }; }),
      E.filiais, function (novo) { E.filiais = novo; desenhar(); }));
  }
  f.appendChild(chips("Grão da comissão", [
    { valor: "rca", rotulo: "Por RCA" },
    { valor: "rca_filial", rotulo: "Por RCA × filial" }
  ], E.grao, function (v) { E.grao = v; desenhar(); }));
  f.appendChild(seletorSupervisor());
  f.appendChild(campoBusca("Buscar RCA por nome ou código…"));
  raiz.appendChild(f);

  /* conferência: os três totais que o Power BI mostrava misturados */
  var pc = painel("Conferência da comissão",
    "O Power BI aplicava a faixa sobre o contexto do visual, então o rodapé da tela nunca era a soma das linhas. Aqui os três números aparecem juntos, e o que vale é o grão escolhido acima.");
  var conf = el("div", "confere");
  [
    ["Faixa sobre a empresa", fR$(empresa.totalLiquido * empresa.faixa),
     "Como o rodapé do Power BI calculava: uma faixa só (" + fPct(empresa.faixa * 100, 2) + ") sobre o total.", false],
    ["Soma por RCA", fR$(porRca), "Uma faixa por vendedor, no mês inteiro.", E.grao === "rca"],
    ["Soma por RCA × filial", fR$(porRcaFilial), "Como a tela principal do Power BI somava linha a linha.", E.grao === "rca_filial"],
    ["Desconto financeiro", fR$(empresa.descfin),
     "Contado uma vez por nota. Do jeito antigo seria " + fR$(empresa.descfinOrig) + ".", false]
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
      "é o mesmo vendedor caindo em faixas diferentes em cada filial. Qual dos dois vale é decisão do comercial; " +
      "o painel paga o que estiver selecionado em <b>Grão da comissão</b>.", "aviso");
    nt.style.marginTop = "14px";
    pc.corpo.appendChild(nt);
  }
  raiz.appendChild(pc);

  /* tabela principal */
  var colunas = [
    { titulo: "Cód", num: false, celula: function (r) { return String(r.codusur); }, fraco: true },
    { titulo: "RCA", celula: function (r) { return r.nome; }, destacar: true, corta: true },
    { titulo: "Supervisor", celula: function (r) { return r.supervisor; }, fraco: true, corta: true }
  ];
  if (E.grao !== "rca") colunas.push({ titulo: "Filial", num: true, celula: function (r) { return r.codfilial; } });
  colunas = colunas.concat([
    { titulo: "Total líquido", num: true, celula: function (r) { return fR$(r.totalLiquido); }, csv: function (r) { return fNum(r.totalLiquido); } },
    { titulo: "Massa de margem", num: true, celula: function (r) { return fR$(r.massa); }, csv: function (r) { return fNum(r.massa); } },
    { titulo: "% líquido", num: true, celula: function (r) { return fPct(r.perc, 2); }, csv: function (r) { return fNum(r.perc); } },
    { titulo: "% comissão", num: true, celula: function (r) {
        var s = el("span", "selo " + (r.faixa >= 0.03 ? "ok" : r.faixa <= 0.01 ? "alerta" : "aviso"), fPct(r.faixa * 100, 2));
        return s;
      }, csv: function (r) { return fNum(r.faixa * 100); } },
    { titulo: "Comissão", num: true, celula: function (r) { return fR$(r.comissao); }, csv: function (r) { return fNum(r.comissao); } },
    { titulo: "CMV venda", num: true, celula: function (r) { return fR$(r.cmvVenda); }, csv: function (r) { return fNum(r.cmvVenda); } },
    { titulo: "CMV líquido", num: true, celula: function (r) { return fR$(r.cmvLiquido); }, csv: function (r) { return fNum(r.cmvLiquido); } },
    { titulo: "ST", num: true, celula: function (r) { return fR$(r.st); }, csv: function (r) { return fNum(r.st); } },
    { titulo: "Desc. fin.", num: true, celula: function (r) { return fR$(r.descfin); }, csv: function (r) { return fNum(r.descfin); } },
    { titulo: "Notas", num: true, celula: function (r) { return fInt(r.notas); } },
    { titulo: "Clientes", num: true, celula: function (r) { return fInt(r.clientes); } }
  ]);

  var pt = painel("Comissão por " + (E.grao === "rca" ? "RCA" : "RCA × filial"),
    "Clique numa linha para ver as notas do vendedor no período.");
  pt.corpo.remove();
  pt.appendChild(tabela({
    id: "comissao",
    tituloCsv: "Comissão por " + (E.grao === "rca" ? "RCA" : "RCA e filial"),
    colunas: colunas,
    linhas: itens,
    ordemInicial: (E.grao === "rca" ? 3 : 4) + 4,   /* coluna Comissão */
    valorOrdem: function (r, i) {
      var mapaCampos = ["codusur", "nome", "supervisor"];
      if (E.grao !== "rca") mapaCampos.push("codfilial");
      mapaCampos = mapaCampos.concat(["totalLiquido", "massa", "perc", "faixa", "comissao",
                                      "cmvVenda", "cmvLiquido", "st", "descfin", "notas", "clientes"]);
      return r[mapaCampos[i]];
    },
    total: function (todas, i) {
      var soma = function (campo) { return todas.reduce(function (s, r) { return s + n(r[campo]); }, 0); };
      var base = E.grao === "rca" ? 3 : 4;
      if (i === 0) return "Total (" + fInt(todas.length) + ")";
      if (i === base) return fR$(soma("totalLiquido"));
      if (i === base + 1) return fR$(soma("massa"));
      if (i === base + 2) return fPct(soma("totalLiquidoSst") ? soma("massa") / soma("totalLiquidoSst") * 100 : null, 2);
      if (i === base + 4) return fR$(soma("comissao"));
      if (i === base + 5) return fR$(soma("cmvVenda"));
      if (i === base + 6) return fR$(soma("cmvLiquido"));
      if (i === base + 7) return fR$(soma("st"));
      if (i === base + 8) return fR$(soma("descfin"));
      if (i === base + 9) return fInt(soma("notas"));
      return "";
    },
    aoClicar: function (r) { abrirNotasDoRca(r); },
    csv: true,
    porPagina: 80
  }));
  raiz.appendChild(pt);

  /* tendência mensal */
  var meses = (D.comissao.mes || []);
  if (meses.length) {
    var pm = painel("Comissão e margem mês a mês",
      "Comissão é a soma do que cada RCA ganhou naquele mês — não depende de filtro de tela. A linha é a margem líquida do mês.");
    var box = el("div", "gbox");
    pm.corpo.appendChild(box);
    colunas_mes(box, meses);
    var leg = el("div", "glegenda");
    leg.innerHTML = '<span><i style="background:var(--green)"></i>Comissão do mês</span>' +
                    '<span><i class="linha" style="background:var(--amber)"></i>% líquido da empresa</span>';
    pm.corpo.appendChild(leg);
    raiz.appendChild(pm);
  }
}

function colunas_mes(box, meses) {
  colunas(box, meses.map(function (m) {
    return { rotulo: rotuloMes(m[0]), valor: n(m[8]), cor: "green" };
  }), {
    altura: 260,
    linha: meses.map(function (m) { return m[7] == null ? null : n(m[7]); }),
    linhaCor: "amber",
    linhaFmt: function (v) { return fPct(v, 1); },
    valorFmt: function (v) { return fCurtoSemMoeda(v); },
    valorTooltip: function (v) { return fR$(v); },
    aria: "Comissão paga por mês"
  });
}

/* Notas de um RCA — vem do /api/detalhe, porque a base tem 200 mil linhas */
function abrirNotasDoRca(r) {
  var corpo = abrirModal("Comissão · detalhe por nota", r.nome, [
    ["Período", fData(E.de) + " a " + fData(E.ate)],
    ["Total líquido", fR$(r.totalLiquido)],
    ["% líquido", fPct(r.perc, 2)],
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
    var aviso = nota("Aplicando a faixa <b>nota a nota</b>, a comissão daria <b>" + fR$(somaNota) +
      "</b>. No grão do vendedor ela é <b>" + fR$(r.comissao) + "</b>. A diferença não é erro de conta: " +
      "a faixa depende da margem do conjunto, e conjunto menor cai em faixa diferente. " +
      "O que o painel paga é o valor no grão escolhido.", "aviso");
    aviso.style.margin = "0 22px 14px";
    corpo.appendChild(aviso);

    corpo.appendChild(tabela({
      id: "comissao_nf_" + r.codusur,
      tituloCsv: "Comissão nota a nota — " + r.nome,
      colunas: [
        { titulo: "Data", celula: function (x) { return fData(x.dtmov); } },
        { titulo: "Nota", num: true, celula: function (x) { return x.numnota; } },
        { titulo: "Pedido", num: true, celula: function (x) { return x.numped; }, fraco: true },
        { titulo: "Filial", num: true, celula: function (x) { return x.codfilial; }, fraco: true },
        { titulo: "Total líquido", num: true, celula: function (x) { return fR$(x.totalLiquido); } },
        { titulo: "Massa", num: true, celula: function (x) { return fR$(x.massa); } },
        { titulo: "% líquido", num: true, celula: function (x) { return fPct(x.perc, 2); } },
        { titulo: "% comissão", num: true, celula: function (x) { return fPct(x.faixa * 100, 2); } },
        { titulo: "Comissão", num: true, celula: function (x) { return fR$(x.comissao); } },
        { titulo: "CMV líquido", num: true, celula: function (x) { return fR$(x.cmvLiquido); } },
        { titulo: "ST", num: true, celula: function (x) { return fR$(x.st); } }
      ],
      linhas: linhas,
      ordemInicial: 0, dirInicial: 1,
      valorOrdem: function (x, i) {
        return [x.dtmov, x.numnota, x.numped, x.codfilial, x.totalLiquido, x.massa, x.perc,
                x.faixa, x.comissao, x.cmvLiquido, x.st][i];
      },
      csv: true,
      porPagina: 50,
      vazio: "Nenhuma nota deste RCA no período."
    }));
  }).catch(function (e) {
    limpar(corpo).appendChild(nota("Não consegui buscar as notas: " + e.message, "alerta"));
  });
}

/* ---------------------------------------------------------------------------
 * Página 2 — MARGEM POR ITEM
 * ------------------------------------------------------------------------ */
function paginaMargem(raiz) {
  var r = D.margem.resumo || {};
  var limite = E.limiteMargem;
  var chaveAbaixo = "abaixo_" + limite;
  var abaixo = r[chaveAbaixo];
  var margemMedia = n(r.venda) ? n(r.margem_valor) / n(r.venda) * 100 : null;

  raiz.appendChild(blocoKpis([
    { rotulo: "Venda no período", valor: fCurto(r.venda), titulo: fR$(r.venda), tom: "money", grande: true,
      sub: fInt(r.itens) + " itens faturados" },
    { rotulo: "Margem em reais", valor: fCurto(r.margem_valor), titulo: fR$(r.margem_valor), tom: "ok", grande: true,
      sub: "venda − CMV, item a item" },
    { rotulo: "Margem média", valor: fPct(margemMedia, 2), tom: "info", sub: "no conjunto do período" },
    { rotulo: "Itens abaixo de " + limite + "%", valor: fInt(abaixo), tom: "alerta",
      sub: r.itens ? fPct(n(abaixo) / n(r.itens) * 100, 1) + " dos itens" : "—" },
    { rotulo: "Itens com margem negativa", valor: fInt(r.negativa), tom: "alerta",
      sub: "venderam abaixo do custo" }
  ]));

  var f = el("div", "filtros rise");
  f.appendChild(chips("Limite de margem", [5, 8, 10, 15, 20].map(function (x) {
    return { valor: x, rotulo: x + "%" };
  }), limite, function (v) { E.limiteMargem = v; desenhar(); }, "alerta"));
  f.appendChild(campoBusca("Buscar produto, nota, pedido ou RCA…"));
  raiz.appendChild(f);

  raiz.appendChild(nota("No Power BI esta página existia duas vezes — <b>MARGEM X PRODUTO 5%</b> e " +
    "<b>10%</b> — e as duas usavam a mesma coluna, que testava 5%. Aqui o limite é um botão: " +
    "os cartões e a tabela mudam junto.", ""));

  /* tabela dos piores */
  var piores = (D.margem.piores || []).filter(function (l) {
    if (n(l[8]) >= limite) return false;
    if (!E.busca) return true;
    var alvo = (l[1] + " " + l[2] + " " + l[4] + " " + nomeProduto(l[4]) + " " + nomeRca(l[3])).toLowerCase();
    return alvo.indexOf(E.busca) !== -1;
  });

  var pt = painel("Itens abaixo de " + limite + "% de margem",
    "Os piores do período, do menor percentual para cima. A lista traz os 1.200 piores itens; " +
    "para a lista completa use o botão de exportar, que busca direto no banco.",
    (function () {
      var b = el("button", "btn-topo", "Baixar lista completa");
      b.type = "button";
      b.addEventListener("click", function () { baixarMargemCompleta(limite, b); });
      return b;
    })());
  pt.corpo.remove();
  pt.appendChild(tabela({
    id: "margem",
    tituloCsv: "Itens abaixo de " + limite + "% de margem",
    filtrosExtras: function () { return [["Limite de margem", limite + "%"]]; },
    colunas: [
      { titulo: "Data", celula: function (l) { return fData(l[0]); } },
      { titulo: "Nota", num: true, celula: function (l) { return l[1]; }, destacar: true },
      { titulo: "Pedido", num: true, celula: function (l) { return l[2]; }, fraco: true },
      { titulo: "RCA", celula: function (l) { return nomeRca(l[3]); }, corta: true, destacar: true },
      { titulo: "Cód", num: true, celula: function (l) { return l[4]; }, fraco: true },
      { titulo: "Produto", celula: function (l) { return nomeProduto(l[4]); }, corta: true, destacar: true },
      { titulo: "Qtd", num: true, celula: function (l) { return fNum(l[5], 0); } },
      { titulo: "Preço unit.", num: true, celula: function (l) { return fR$(l[6]); } },
      { titulo: "Venda", num: true, celula: function (l) { return fR$(l[7]); }, csv: function (l) { return fNum(l[7]); } },
      { titulo: "Margem %", num: true, celula: function (l) {
          var s = el("span", "selo " + (n(l[8]) < 0 ? "alerta" : n(l[8]) < limite ? "aviso" : "ok"), fPct(l[8], 2));
          return s;
        }, csv: function (l) { return fNum(l[8]); } },
      { titulo: "Margem R$", num: true, celula: function (l) { return fR$(l[9]); }, csv: function (l) { return fNum(l[9]); } }
    ],
    linhas: piores,
    ordemInicial: 9, dirInicial: 1,
    valorOrdem: function (l, i) { return [l[0], l[1], l[2], nomeRca(l[3]), l[4], nomeProduto(l[4]), n(l[5]), n(l[6]), n(l[7]), n(l[8]), n(l[9])][i]; },
    total: function (todas, i) {
      if (i === 0) return "Total (" + fInt(todas.length) + ")";
      if (i === 8) return fR$(todas.reduce(function (s, l) { return s + n(l[7]); }, 0));
      if (i === 10) return fR$(todas.reduce(function (s, l) { return s + n(l[9]); }, 0));
      return "";
    },
    csv: true,
    aviso: "os 1.200 piores do período",
    porPagina: 60
  }));
  raiz.appendChild(pt);

  /* ranking por RCA */
  var porRca = (D.margem.rca || [])
    .filter(function (l) { return passaFiltroRca(l[0], null); })
    .map(function (l) { return { cod: l[0], itens: n(l[1]), venda: n(l[2]), margem: n(l[3]), abaixo: n(l[4]) }; })
    .sort(function (a, b) { return b.abaixo - a.abaixo; })
    .slice(0, 15);
  if (porRca.length) {
    var pr = painel("Quem mais vendeu abaixo de 5% de margem",
      "Quantidade de itens abaixo de 5% por vendedor — é a contagem que o cartão do Power BI mostrava.");
    var box = el("div");
    pr.corpo.appendChild(box);
    ranking(box, porRca.map(function (x) {
      return { nome: nomeRca(x.cod), valor: x.abaixo, rotulo: fInt(x.abaixo) + " itens · " + fCurto(x.venda), cor: "brand-red-lt" };
    }));
    raiz.appendChild(pr);
  }

  /* série mensal */
  var meses = D.margem.mes || [];
  if (meses.length) {
    var pm = painel("Venda e margem mês a mês",
      "Toda a base carregada, independente do período escolhido acima.");
    var box2 = el("div", "gbox");
    pm.corpo.appendChild(box2);
    colunas(box2, meses.map(function (m) { return { rotulo: rotuloMes(m[0]), valor: n(m[2]), cor: "brand-blue-lt" }; }), {
      altura: 250,
      linha: meses.map(function (m) { return n(m[2]) ? n(m[3]) / n(m[2]) * 100 : null; }),
      linhaCor: "green",
      linhaFmt: function (v) { return fPct(v, 1); },
      valorFmt: function (v) { return fCurtoSemMoeda(v); },
      valorTooltip: function (v) { return fR$(v); },
      aria: "Venda por mês"
    });
    var leg = el("div", "glegenda");
    leg.innerHTML = '<span><i style="background:var(--brand-blue-lt)"></i>Venda</span>' +
                    '<span><i class="linha" style="background:var(--green)"></i>Margem %</span>';
    pm.corpo.appendChild(leg);
    raiz.appendChild(pm);
  }
}

function baixarMargemCompleta(limite, botao) {
  botao.disabled = true;
  botao.textContent = "Buscando no banco…";
  buscarDetalhe("margem_item", String(limite), 20000).then(function (res) {
    var linhas = res.linhas || [];
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
    }, linhas);
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

  raiz.appendChild(blocoKpis([
    { rotulo: "Pedidos em aberto", valor: fInt(linhas.length), tom: "info",
      sub: "não faturados nem cancelados" },
    { rotulo: "Valor em carteira", valor: fCurto(totalValor), titulo: fR$(totalValor), tom: "money", grande: true,
      sub: "soma do valor total dos pedidos" },
    { rotulo: "Abaixo de " + limite + "% de margem", valor: fInt(fora.length), tom: "alerta",
      sub: linhas.length ? fPct(fora.length / linhas.length * 100, 1) + " dos pedidos" : "—" },
    { rotulo: "Valor fora da margem", valor: fCurto(valorFora), titulo: fR$(valorFora), tom: "alerta", grande: true,
      sub: "para segurar antes de faturar" }
  ]));

  var f = el("div", "filtros rise");
  f.appendChild(chipsMultiplos("Posição", posicoes.map(function (p) { return { valor: p, rotulo: p }; }),
    E.posicoes, function (novo) { E.posicoes = novo; desenhar(); }));
  f.appendChild(chips("Margem mínima", [15, 20, 21, 25].map(function (x) { return { valor: x, rotulo: x + "%" }; }),
    limite, function (v) { E.limitePedido = v; desenhar(); }, "alerta"));
  f.appendChild(seletorSupervisor());
  f.appendChild(campoBusca("Buscar pedido, cliente ou RCA…"));
  raiz.appendChild(f);

  raiz.appendChild(nota("Esta é uma <b>foto de agora</b>: ela vem da carteira do WinThor a cada carga, " +
    "não do período escolhido lá em cima. No Power BI a página abria vazia porque o filtro de data " +
    "tinha ficado salvo em junho de 2025.", ""));

  var pt = painel("Carteira em aberto — filial 1",
    "Pedido de bonificação não tem venda, então fica sem margem: aparece como “—”.");
  pt.corpo.remove();
  pt.appendChild(tabela({
    id: "pedidos",
    tituloCsv: "Pedidos em aberto",
    filtrosExtras: function () { return [["Margem mínima", limite + "%"], ["Posição", E.posicoes ? Array.from(E.posicoes).join(", ") : "todas"]]; },
    colunas: [
      { titulo: "Data", celula: function (p) { return fData(p[0]); } },
      { titulo: "Pedido", num: true, celula: function (p) { return p[1]; }, destacar: true },
      { titulo: "Cód", num: true, celula: function (p) { return p[2]; }, fraco: true },
      { titulo: "Cliente", celula: function (p) { return nomeCliente(p[2]); }, corta: true, destacar: true },
      { titulo: "RCA", celula: function (p) { return nomeRca(p[3]); }, corta: true, destacar: true },
      { titulo: "Supervisor", celula: function (p) { return nomeSupervisor(p[4]); }, fraco: true, corta: true },
      { titulo: "Tipo", celula: function (p) { return p[5]; }, fraco: true },
      { titulo: "Posição", celula: function (p) {
          return el("span", "selo " + (p[6] === "LIBERADO" ? "ok" : p[6] === "BLOQUEADO" ? "alerta" : "neutro"), p[6]);
        }, csv: function (p) { return p[6]; } },
      { titulo: "Valor", num: true, celula: function (p) { return fR$(p[7]); }, csv: function (p) { return fNum(p[7]); } },
      { titulo: "Qtd", num: true, celula: function (p) { return fNum(p[8], 0); } },
      { titulo: "Margem", num: true, celula: function (p) {
          if (p[9] == null) return "—";
          return el("span", "selo " + (n(p[9]) < limite ? "alerta" : "ok"), fPct(p[9], 2));
        }, csv: function (p) { return p[9] == null ? "" : fNum(p[9]); } }
    ],
    linhas: linhas,
    ordemInicial: 10, dirInicial: 1,
    valorOrdem: function (p, i) {
      return [p[0], p[1], p[2], nomeCliente(p[2]), nomeRca(p[3]), nomeSupervisor(p[4]), p[5], p[6],
              n(p[7]), n(p[8]), p[9] == null ? null : n(p[9])][i];
    },
    total: function (todas, i) {
      if (i === 0) return "Total (" + fInt(todas.length) + ")";
      if (i === 8) return fR$(todas.reduce(function (s, p) { return s + n(p[7]); }, 0));
      return "";
    },
    csv: true,
    vazio: "Nenhum pedido em aberto com estes filtros.",
    porPagina: 60
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

  raiz.appendChild(blocoKpis([
    { rotulo: "Devolvido no período", valor: fCurto(valorTotal), titulo: fR$(valorTotal), tom: "alerta", grande: true,
      sub: fInt(t.notas) + " notas de entrada" },
    { rotulo: "Responsabilidade do RCA", valor: fCurto(valorRca), titulo: fR$(valorRca), tom: "aviso", grande: true,
      sub: valorTotal ? fPct(valorRca / valorTotal * 100, 1) + " do total" : "—",
      ajuda: "Motivos comerciais (não pediu, preço errado, sem dinheiro…). Os de logística ficam fora." },
    { rotulo: "No filtro atual", valor: fCurto(valorFiltrado), titulo: fR$(valorFiltrado), tom: "info", grande: true,
      sub: fInt(linhas.length) + " linhas",
      ajuda: "Este cartão segue os mesmos filtros da tabela — no Power BI o cartão ignorava o filtro de motivo e mostrava mais que o dobro." },
    { rotulo: "Pelo total da nota", valor: fCurto(t.vltotal_somado), titulo: fR$(t.vltotal_somado), tom: "", grande: true,
      sub: "número do BI antigo, superestimado",
      ajuda: "O Power BI somava o total da NOTA em cada linha; notas com mais de uma linha entravam mais de uma vez." }
  ]));

  var f = el("div", "filtros rise");
  f.appendChild(chips("Responsabilidade", [
    { valor: "todos", rotulo: "Todos os motivos" },
    { valor: "rca", rotulo: "Só do vendedor" }
  ], E.soMotivoRca ? "rca" : "todos", function (v) { E.soMotivoRca = (v === "rca"); desenhar(); }, "aviso"));
  var gm = el("div", "fgrupo");
  gm.appendChild(el("span", "frot", "Motivo"));
  var sel = el("select");
  sel.style.cssText = "background:var(--surface-2);border:1px solid var(--line-1);color:var(--txt-1);border-radius:10px;padding:7px 10px;font-size:12.5px;font-weight:700;cursor:pointer;max-width:280px;";
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

  /* rosca: RCA x empresa */
  var pg = painel("De quem é a devolução",
    "Motivos comerciais são do vendedor; erro de carregamento, atraso na entrega e produto danificado são da operação.");
  var caixa = el("div");
  pg.corpo.appendChild(caixa);
  rosca(caixa, [
    { rotulo: "Do vendedor", valor: valorRca, cor: "amber" },
    { rotulo: "Da operação", valor: Math.max(0, valorTotal - valorRca), cor: "info" }
  ], "Valor pela linha da nota (quantidade × preço contábil), que é somável.");
  raiz.appendChild(pg);

  /* ranking por RCA no período */
  var porRca = new Map();
  linhas.forEach(function (l) {
    porRca.set(l[3], n(porRca.get(l[3])) + n(l[7]));
  });
  var listaRca = Array.from(porRca.entries())
    .map(function (e) { return { cod: e[0], valor: e[1] }; })
    .sort(function (a, b) { return b.valor - a.valor; })
    .slice(0, 15);
  if (listaRca.length) {
    var pr = painel("Devolução por RCA", "Somente o que está nos filtros atuais.");
    var box = el("div");
    pr.corpo.appendChild(box);
    ranking(box, listaRca.map(function (x) {
      return { nome: nomeRca(x.cod), valor: x.valor, rotulo: fCurto(x.valor), cor: "brand-red-lt" };
    }));
    raiz.appendChild(pr);
  }

  var pt = painel("Notas devolvidas", "As 4.000 maiores do período. Clique numa linha para ver todas as devoluções daquele RCA.");
  pt.corpo.remove();
  pt.appendChild(tabela({
    id: "devolucao",
    tituloCsv: "Devoluções",
    filtrosExtras: function () {
      return [["Motivo", E.motivo ? motivoDe(E.motivo) : "todos"],
              ["Só responsabilidade do RCA", E.soMotivoRca ? "sim" : "não"]];
    },
    colunas: [
      { titulo: "Data", celula: function (l) { return fData(l[0]); } },
      { titulo: "Nota", num: true, celula: function (l) { return l[1]; }, destacar: true },
      { titulo: "Cód", num: true, celula: function (l) { return l[2]; }, fraco: true },
      { titulo: "Cliente", celula: function (l) { return nomeCliente(l[2]); }, corta: true, destacar: true },
      { titulo: "RCA", celula: function (l) { return nomeRca(l[3]); }, corta: true, destacar: true },
      { titulo: "Motivo", celula: function (l) {
          var m = MOTIVO_MAPA[l[4]];
          var s = el("span", "selo " + (m && m[1] ? "aviso" : "neutro"), m ? m[0] : "—");
          return s;
        }, csv: function (l) { return motivoDe(l[4]); } },
      { titulo: "Filial", num: true, celula: function (l) { return l[5]; }, fraco: true },
      { titulo: "Qtd", num: true, celula: function (l) { return fNum(l[6], 0); } },
      { titulo: "Valor devolvido", num: true, celula: function (l) { return fR$(l[7]); }, csv: function (l) { return fNum(l[7]); } },
      { titulo: "Total da nota", num: true, celula: function (l) { return fR$(l[8]); }, fraco: true, csv: function (l) { return fNum(l[8]); } }
    ],
    linhas: linhas,
    ordemInicial: 8,
    valorOrdem: function (l, i) {
      return [l[0], l[1], l[2], nomeCliente(l[2]), nomeRca(l[3]), motivoDe(l[4]), l[5], n(l[6]), n(l[7]), n(l[8])][i];
    },
    total: function (todas, i) {
      if (i === 0) return "Total (" + fInt(todas.length) + ")";
      if (i === 8) return fR$(todas.reduce(function (s, l) { return s + n(l[7]); }, 0));
      return "";
    },
    aoClicar: function (l) { abrirDevolucoesDoRca(l[3]); },
    csv: true,
    porPagina: 60
  }));
  raiz.appendChild(pt);

  var meses = D.devolucao.mes || [];
  if (meses.length) {
    var pm = painel("Devolução mês a mês", "Barra: total devolvido. Linha: quanto disso é responsabilidade do vendedor.");
    var box2 = el("div", "gbox");
    pm.corpo.appendChild(box2);
    colunas(box2, meses.map(function (m) { return { rotulo: rotuloMes(m[0]), valor: n(m[1]), cor: "brand-red-lt" }; }), {
      altura: 240,
      linha: meses.map(function (m) { return n(m[1]) ? n(m[2]) / n(m[1]) * 100 : null; }),
      linhaCor: "amber",
      linhaFmt: function (v) { return fPct(v, 0); },
      valorFmt: function (v) { return fCurtoSemMoeda(v); },
      valorTooltip: function (v) { return fR$(v); },
      aria: "Devolução por mês"
    });
    var leg = el("div", "glegenda");
    leg.innerHTML = '<span><i style="background:var(--brand-red-lt)"></i>Devolvido</span>' +
                    '<span><i class="linha" style="background:var(--amber)"></i>% do vendedor</span>';
    pm.corpo.appendChild(leg);
    raiz.appendChild(pm);
  }
}

function abrirDevolucoesDoRca(codusur) {
  var corpo = abrirModal("Devoluções · detalhe", nomeRca(codusur), [
    ["Período", fData(E.de) + " a " + fData(E.ate)]
  ], function (corpo) { corpo.appendChild(el("div", "vazio", "Buscando no banco…")); });

  buscarDetalhe("devolucao_rca", codusur).then(function (res) {
    limpar(corpo);
    var linhas = res.linhas || [];
    corpo.appendChild(tabela({
      id: "devol_rca_" + codusur,
      tituloCsv: "Devoluções — " + nomeRca(codusur),
      colunas: [
        { titulo: "Data", celula: function (l) { return fData(l[0]); } },
        { titulo: "Nota", num: true, celula: function (l) { return l[1]; } },
        { titulo: "Cliente", celula: function (l) { return nomeCliente(l[2]); }, corta: true },
        { titulo: "Motivo", celula: function (l) { return motivoDe(l[3]); }, corta: true },
        { titulo: "Filial", num: true, celula: function (l) { return l[4]; }, fraco: true },
        { titulo: "Qtd", num: true, celula: function (l) { return fNum(l[5], 0); } },
        { titulo: "Valor devolvido", num: true, celula: function (l) { return fR$(l[6]); }, csv: function (l) { return fNum(l[6]); } },
        { titulo: "Total da nota", num: true, celula: function (l) { return fR$(l[7]); }, fraco: true }
      ],
      linhas: linhas,
      ordemInicial: 6,
      valorOrdem: function (l, i) { return [l[0], l[1], nomeCliente(l[2]), motivoDe(l[3]), l[4], n(l[5]), n(l[6]), n(l[7])][i]; },
      total: function (todas, i) {
        if (i === 0) return "Total (" + fInt(todas.length) + ")";
        if (i === 6) return fR$(todas.reduce(function (s, l) { return s + n(l[6]); }, 0));
        return "";
      },
      csv: true, porPagina: 50,
      vazio: "Nenhuma devolução deste RCA no período."
    }));
  }).catch(function (e) {
    limpar(corpo).appendChild(nota("Não consegui buscar: " + e.message, "alerta"));
  });
}

/* ---------------------------------------------------------------------------
 * Barra de período
 * ------------------------------------------------------------------------ */
function barraPeriodo() {
  var b = el("div", "periodo rise");
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
  b.appendChild(el("span", "badge", fData(E.de) + " a " + fData(E.ate) + " · " + fInt(dias) + (dias === 1 ? " dia" : " dias")));
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
  /* O primeiro acesso depois de um tempo parado acorda a função e o pooler
     juntos e pode levar dezenas de segundos. Melhor dizer isso do que deixar
     a tela parada dando a impressão de travamento. */
  var demorou = setTimeout(function () {
    var t = document.getElementById("carregandoTexto");
    if (t) t.textContent = "Primeiro acesso depois de um tempo parado — o banco está acordando. Isso leva alguns segundos.";
  }, 7000);
  buscarDados(forcar).then(function (dados) {
    clearTimeout(demorou);
    D = dados;
    MOTIVO_MAPA = {};
    (D.motivos || []).forEach(function (m) { MOTIVO_MAPA[m[0]] = [m[1], m[2]]; });
    E.de = String(D.periodo.de).slice(0, 10);
    E.ate = String(D.periodo.ate).slice(0, 10);
    E.pag = {};
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
  corpo.style.cssText = "display:flex;flex-direction:column;gap:18px;margin-top:18px;";
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
    D = dados;
    MOTIVO_MAPA = {};
    (D.motivos || []).forEach(function (m) { MOTIVO_MAPA[m[0]] = [m[1], m[2]]; });
    b.disabled = false; b.classList.remove("girando");
    desenhar(true);
  }).catch(function (e) {
    b.disabled = false; b.classList.remove("girando");
    alert("Não consegui atualizar: " + e.message);
  });
});

/* período inicial: o mês corrente */
E.ate = hoje();
E.de = primeiroDiaDoMes(E.ate);
carregar(false);

})();
