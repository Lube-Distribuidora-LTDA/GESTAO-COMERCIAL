/* =============================================================================
 * planilha.js — gera um arquivo .xlsx de verdade, no navegador, sem biblioteca.
 *
 * Por que não é CSV: CSV não carrega formato. A planilha que sai daqui precisa
 * chegar em quem recebe já com a cara da Lube, com filtro em cima de cada
 * coluna, número em formato de moeda (não texto), percentual que ordena como
 * percentual e data que o Excel entende como data. Nada disso cabe num CSV.
 *
 * Por que não uma biblioteca de CDN: as duas populares pesam de 400 KB a 1 MB,
 * carregariam de um servidor de fora a cada clique e quebrariam se a rede da
 * empresa bloqueasse o domínio. Um .xlsx é um ZIP com alguns XML dentro — dá
 * para escrever à mão em menos código do que o peso do download.
 *
 * O que sai pronto na planilha:
 *   · faixa de identidade (empresa, relatório) em azul-marinho e dourado;
 *   · bloco de filtros aplicados, escrito por extenso — quem recebe precisa
 *     saber que aquilo é um recorte, não a lista inteira;
 *   · cabeçalho congelado e filtro automático em todas as colunas;
 *   · moeda, percentual, inteiro e data com formato nativo do Excel;
 *   · linhas alternadas, valor negativo em vermelho e linha de total.
 *
 * Uso: Planilha.gerar({ arquivo, titulo, filtros, colunas, linhas })
 *   colunas: [{ titulo, tipo, valor(linha, indice) }]
 *   tipo:    "texto" | "moeda" | "percentual" | "inteiro" | "data"
 *            percentual recebe o número em 0–100 (20,75 = 20,75%).
 * ========================================================================== */
(function () {
"use strict";

/* ---------------------------------------------------------------------------
 * ZIP (sem compressão) — um .xlsx é exatamente isto com XML dentro
 * ------------------------------------------------------------------------ */
var TABELA_CRC = (function () {
  var t = new Uint32Array(256);
  for (var i = 0; i < 256; i++) {
    var c = i;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  var c = 0xFFFFFFFF;
  for (var i = 0; i < bytes.length; i++) c = TABELA_CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function texto2bytes(s) {
  return new TextEncoder().encode(s);
}

function zip(arquivos) {
  var partes = [], central = [], deslocamento = 0;
  arquivos.forEach(function (a) {
    var nome = texto2bytes(a.nome);
    var dados = a.bytes || texto2bytes(a.conteudo);
    var crc = crc32(dados);

    var local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);            // versão necessária
    local.setUint16(6, 0x0800, true);        // nome do arquivo em UTF-8
    local.setUint16(8, 0, true);             // método: armazenado
    local.setUint32(14, crc, true);
    local.setUint32(18, dados.length, true);
    local.setUint32(22, dados.length, true);
    local.setUint16(26, nome.length, true);
    partes.push(new Uint8Array(local.buffer), nome, dados);

    var cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, dados.length, true);
    cen.setUint32(24, dados.length, true);
    cen.setUint16(28, nome.length, true);
    cen.setUint32(42, deslocamento, true);
    central.push(new Uint8Array(cen.buffer), nome);

    deslocamento += 30 + nome.length + dados.length;
  });

  var tamanhoCentral = central.reduce(function (s, p) { return s + p.length; }, 0);
  var fim = new DataView(new ArrayBuffer(22));
  fim.setUint32(0, 0x06054b50, true);
  fim.setUint16(8, arquivos.length, true);
  fim.setUint16(10, arquivos.length, true);
  fim.setUint32(12, tamanhoCentral, true);
  fim.setUint32(16, deslocamento, true);

  var todas = partes.concat(central, [new Uint8Array(fim.buffer)]);
  var total = todas.reduce(function (s, p) { return s + p.length; }, 0);
  var saida = new Uint8Array(total), pos = 0;
  todas.forEach(function (p) { saida.set(p, pos); pos += p.length; });
  return saida;
}

/* ---------------------------------------------------------------------------
 * Auxiliares de XML e de célula
 * ------------------------------------------------------------------------ */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    /* caracteres de controle quebram o arquivo no Excel */
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

function letraColuna(n) {            // 1 -> A, 27 -> AA
  var s = "";
  while (n > 0) {
    var r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = (n - 1 - r) / 26;
  }
  return s;
}

/* O Excel conta dias desde 30/12/1899. */
function serialData(v) {
  var d = (v instanceof Date) ? v : new Date(String(v).slice(0, 10) + "T12:00:00");
  if (isNaN(d)) return null;
  return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 86400000);
}

/* ---------------------------------------------------------------------------
 * Estilos
 *
 * A tabela abaixo vira o styles.xml. Cada linha é um estilo que a planilha
 * usa; o índice na lista é o que vai no atributo `s` de cada célula.
 * ------------------------------------------------------------------------ */
var FONTES = [
  { tam: 10, cor: "FF1B2537" },                               // 0 base
  { tam: 10, cor: "FF1B2537", negrito: true },                // 1 base negrito
  { tam: 18, cor: "FFE9C877", negrito: true },                // 2 título
  { tam: 11, cor: "FFFFFFFF", negrito: true },                // 3 subtítulo
  { tam: 10, cor: "FFFFFFFF", negrito: true },                // 4 cabeçalho
  { tam: 9,  cor: "FF6B7A99", negrito: true },                // 5 rótulo de filtro
  { tam: 10, cor: "FFC0392B", negrito: true },                // 6 negativo
  { tam: 11, cor: "FF0D1830", negrito: true },                // 7 total
  { tam: 9,  cor: "FF8A97B0" }                                // 8 rodapé
];
var PREENCHIMENTOS = [
  null, null,                                                  // 0 e 1 são reservados
  "FF0D1830",                                                  // 2 azul-marinho
  "FFF4F7FB",                                                  // 3 faixa alternada
  "FF132242",                                                  // 4 cabeçalho
  "FFF7E7BE"                                                   // 5 total (dourado claro)
];
var BORDAS = [
  null,                                                        // 0 sem borda
  { baixo: "FFE2E8F0" },                                       // 1 linha de grade suave
  { baixo: "FFE9C877", espessura: "medium" },                  // 2 sob o cabeçalho
  { cima: "FF0D1830", espessura: "double" }                    // 3 sobre o total
];
var FORMATOS = {
  moeda:      { id: 164, codigo: "&quot;R$&quot;\\ #,##0.00" },
  percentual: { id: 165, codigo: "0.00%" },
  inteiro:    { id: 166, codigo: "#,##0" },
  data:       { id: 167, codigo: "dd/mm/yyyy" }
};

/* [fonte, preenchimento, borda, formato, alinhamento] */
var ESTILOS = [
  [0, 0, 0, null, null],            // 0  base
  [2, 2, 0, null, "esquerda"],      // 1  título
  [3, 2, 0, null, "esquerda"],      // 2  subtítulo
  [5, 0, 0, null, null],            // 3  rótulo de filtro
  [0, 0, 0, null, null],            // 4  valor de filtro
  [4, 4, 2, null, "centro"],        // 5  cabeçalho
  [0, 0, 1, null, null],            // 6  texto
  [0, 3, 1, null, null],            // 7  texto alternado
  [0, 0, 1, "moeda", null],         // 8  moeda
  [0, 3, 1, "moeda", null],         // 9  moeda alternada
  [0, 0, 1, "percentual", null],    // 10 percentual
  [0, 3, 1, "percentual", null],    // 11 percentual alternado
  [0, 0, 1, "inteiro", null],       // 12 inteiro
  [0, 3, 1, "inteiro", null],       // 13 inteiro alternado
  [0, 0, 1, "data", "centro"],      // 14 data
  [0, 3, 1, "data", "centro"],      // 15 data alternada
  [6, 0, 1, "moeda", null],         // 16 moeda negativa
  [6, 3, 1, "moeda", null],         // 17 moeda negativa alternada
  [6, 0, 1, "percentual", null],    // 18 percentual negativo
  [6, 3, 1, "percentual", null],    // 19 percentual negativo alternado
  [7, 5, 3, null, null],            // 20 total texto
  [7, 5, 3, "moeda", null],         // 21 total moeda
  [7, 5, 3, "inteiro", null],       // 22 total inteiro
  [8, 0, 0, null, null]             // 23 rodapé
];
var E_TITULO = 1, E_SUBTITULO = 2, E_ROTULO = 3, E_VALOR = 4, E_CABECALHO = 5;
var E_TOTAL_TEXTO = 20, E_TOTAL_MOEDA = 21, E_TOTAL_INTEIRO = 22, E_RODAPE = 23;

function estiloDaCelula(tipo, alternada, negativo) {
  var base;
  if (tipo === "moeda") base = negativo ? 16 : 8;
  else if (tipo === "percentual") base = negativo ? 18 : 10;
  else if (tipo === "inteiro") base = 12;
  else if (tipo === "data") base = 14;
  else base = 6;
  return base + (alternada ? 1 : 0);
}

function xmlEstilos() {
  var numFmts = Object.keys(FORMATOS).map(function (k) {
    return '<numFmt numFmtId="' + FORMATOS[k].id + '" formatCode="' + FORMATOS[k].codigo + '"/>';
  }).join("");

  var fontes = FONTES.map(function (f) {
    return "<font><sz val=\"" + f.tam + "\"/><color rgb=\"" + f.cor + "\"/>" +
           "<name val=\"Segoe UI\"/>" + (f.negrito ? "<b/>" : "") + "</font>";
  }).join("");

  var preench = PREENCHIMENTOS.map(function (c, i) {
    if (i === 0) return '<fill><patternFill patternType="none"/></fill>';
    if (i === 1) return '<fill><patternFill patternType="gray125"/></fill>';
    return '<fill><patternFill patternType="solid"><fgColor rgb="' + c + '"/><bgColor indexed="64"/></patternFill></fill>';
  }).join("");

  var bordas = BORDAS.map(function (b) {
    if (!b) return "<border><left/><right/><top/><bottom/><diagonal/></border>";
    var esp = b.espessura || "thin";
    return "<border><left/><right/>" +
      (b.cima ? '<top style="' + esp + '"><color rgb="' + b.cima + '"/></top>' : "<top/>") +
      (b.baixo ? '<bottom style="' + esp + '"><color rgb="' + b.baixo + '"/></bottom>' : "<bottom/>") +
      "<diagonal/></border>";
  }).join("");

  var xfs = ESTILOS.map(function (e) {
    var fmt = e[3] ? FORMATOS[e[3]].id : 0;
    var al = e[4] === "centro" ? '<alignment horizontal="center" vertical="center"/>'
           : e[4] === "esquerda" ? '<alignment horizontal="left" vertical="center"/>'
           : '<alignment vertical="center"/>';
    return '<xf numFmtId="' + fmt + '" fontId="' + e[0] + '" fillId="' + e[1] + '" borderId="' + e[2] +
           '" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1">' +
           al + "</xf>";
  }).join("");

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="' + Object.keys(FORMATOS).length + '">' + numFmts + "</numFmts>" +
    '<fonts count="' + FONTES.length + '">' + fontes + "</fonts>" +
    '<fills count="' + PREENCHIMENTOS.length + '">' + preench + "</fills>" +
    '<borders count="' + BORDAS.length + '">' + bordas + "</borders>" +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="' + ESTILOS.length + '">' + xfs + "</cellXfs>" +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    "</styleSheet>";
}

/* ---------------------------------------------------------------------------
 * A planilha
 * ------------------------------------------------------------------------ */
function celula(ref, estilo, valor, tipoExcel) {
  if (valor == null || valor === "") return '<c r="' + ref + '" s="' + estilo + '"/>';
  if (tipoExcel === "n") return '<c r="' + ref + '" s="' + estilo + '"><v>' + valor + "</v></c>";
  return '<c r="' + ref + '" s="' + estilo + '" t="inlineStr"><is><t xml:space="preserve">' +
         esc(valor) + "</t></is></c>";
}

function gerar(cfg) {
  var colunas = cfg.colunas, linhas = cfg.linhas || [];
  var nCols = colunas.length;
  var ultimaLetra = letraColuna(nCols);
  var linha = 1, xml = [];

  function juntar(numero, altura, celulas) {
    xml.push('<row r="' + numero + '"' + (altura ? ' ht="' + altura + '" customHeight="1"' : "") + ">" +
             celulas.join("") + "</row>");
  }

  /* --- faixa de identidade --- */
  var faixa1 = [], faixa2 = [];
  for (var c = 1; c <= nCols; c++) {
    faixa1.push(celula(letraColuna(c) + linha, E_TITULO, c === 1 ? "LUBE DISTRIBUIDORA LTDA" : ""));
  }
  juntar(linha, 30, faixa1);
  var mesclas = ["A" + linha + ":" + ultimaLetra + linha];
  linha++;
  for (c = 1; c <= nCols; c++) {
    faixa2.push(celula(letraColuna(c) + linha, E_SUBTITULO, c === 1 ? "Central Comercial · " + cfg.titulo : ""));
  }
  juntar(linha, 22, faixa2);
  mesclas.push("A" + linha + ":" + ultimaLetra + linha);
  linha += 2;

  /* --- filtros aplicados, por extenso --- */
  (cfg.filtros || []).forEach(function (f) {
    juntar(linha, null, [
      celula("A" + linha, E_ROTULO, f[0]),
      celula("B" + linha, E_VALOR, f[1])
    ]);
    linha++;
  });
  linha++;

  /* --- cabeçalho --- */
  var linhaCabecalho = linha;
  juntar(linha, 26, colunas.map(function (col, i) {
    return celula(letraColuna(i + 1) + linha, E_CABECALHO, col.titulo);
  }));
  linha++;

  /* --- dados --- */
  var primeiraDados = linha;
  var somas = colunas.map(function () { return null; });
  linhas.forEach(function (l, idx) {
    var alternada = idx % 2 === 1;
    var celulas = colunas.map(function (col, i) {
      var ref = letraColuna(i + 1) + linha;
      var v = col.valor(l, idx);
      if (col.tipo === "moeda" || col.tipo === "inteiro") {
        /* arredonda ao gravar: sem isso a barra de fórmulas do Excel mostra
           127423,39999999997, que é ruído de ponto flutuante e assusta quem lê */
        var num = (v == null || v === "" || isNaN(v)) ? null
                : col.tipo === "moeda" ? Math.round(Number(v) * 100) / 100 : Math.round(Number(v));
        if (num != null) somas[i] = (somas[i] || 0) + num;
        return celula(ref, estiloDaCelula(col.tipo, alternada, num < 0), num, "n");
      }
      if (col.tipo === "percentual") {
        var p = (v == null || v === "" || isNaN(v)) ? null : Math.round(Number(v) * 1e6) / 1e8;
        return celula(ref, estiloDaCelula(col.tipo, alternada, p < 0), p, "n");
      }
      if (col.tipo === "data") {
        var s = serialData(v);
        return celula(ref, estiloDaCelula("data", alternada, false), s, "n");
      }
      return celula(ref, estiloDaCelula("texto", alternada, false), v);
    });
    juntar(linha, null, celulas);
    linha++;
  });
  var ultimaDados = linha - 1;

  /* --- total: só nas colunas que fazem sentido somar --- */
  if (linhas.length) {
    juntar(linha, 22, colunas.map(function (col, i) {
      var ref = letraColuna(i + 1) + linha;
      if (i === 0) return celula(ref, E_TOTAL_TEXTO, "TOTAL — " + linhas.length + " linha" + (linhas.length > 1 ? "s" : ""));
      if (col.tipo === "moeda") return celula(ref, E_TOTAL_MOEDA, Math.round((somas[i] || 0) * 100) / 100, "n");
      if (col.tipo === "inteiro" && col.somar !== false) return celula(ref, E_TOTAL_INTEIRO, somas[i] || 0, "n");
      /* percentual não se soma nem se tira média sem peso: fica vazio de propósito */
      return celula(ref, E_TOTAL_TEXTO, "");
    }));
    linha++;
  }

  linha++;
  juntar(linha, null, [celula("A" + linha, E_RODAPE,
    "Gerado pela Central Comercial · dado do WinThor pelo DATA WAREHOUSE · " +
    new Date().toLocaleString("pt-BR"))]);

  /* --- largura das colunas, pelo conteúdo --- */
  var larguras = colunas.map(function (col, i) {
    var maior = String(col.titulo).length;
    var amostra = Math.min(linhas.length, 400);
    for (var k = 0; k < amostra; k++) {
      var v = col.valor(linhas[k], k);
      var t = col.tipo === "moeda" ? String(Math.round(Number(v) || 0)).length + 6
            : col.tipo === "data" ? 10
            : String(v == null ? "" : v).length;
      if (t > maior) maior = t;
    }
    return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' +
           Math.min(Math.max(maior + 3, 9), 46) + '" customWidth="1"/>';
  }).join("");

  var planilha =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheetPr><outlinePr summaryBelow="1" summaryRight="1"/></sheetPr>' +
    '<dimension ref="A1:' + ultimaLetra + (linha) + '"/>' +
    '<sheetViews><sheetView showGridLines="0" tabSelected="1" workbookViewId="0">' +
    '<pane ySplit="' + linhaCabecalho + '" topLeftCell="A' + (linhaCabecalho + 1) +
    '" activePane="bottomLeft" state="frozen"/>' +
    '<selection pane="bottomLeft" activeCell="A' + (linhaCabecalho + 1) + '" sqref="A' + (linhaCabecalho + 1) + '"/>' +
    "</sheetView></sheetViews>" +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    "<cols>" + larguras + "</cols>" +
    "<sheetData>" + xml.join("") + "</sheetData>" +
    (linhas.length ? '<autoFilter ref="A' + linhaCabecalho + ":" + ultimaLetra + ultimaDados + '"/>' : "") +
    (mesclas.length ? '<mergeCells count="' + mesclas.length + '">' +
      mesclas.map(function (m) { return '<mergeCell ref="' + m + '"/>'; }).join("") + "</mergeCells>" : "") +
    '<pageMargins left="0.4" right="0.4" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>' +
    '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>' +
    "</worksheet>";

  var nomeAba = (cfg.aba || "Dados").slice(0, 28).replace(/[\\\/\?\*\[\]:]/g, " ");

  var arquivos = [
    { nome: "[Content_Types].xml", conteudo:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      "</Types>" },
    { nome: "_rels/.rels", conteudo:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      "</Relationships>" },
    { nome: "xl/workbook.xml", conteudo:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="' + esc(nomeAba) + '" sheetId="1" r:id="rId1"/></sheets>' +
      "</workbook>" },
    { nome: "xl/_rels/workbook.xml.rels", conteudo:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      "</Relationships>" },
    { nome: "xl/styles.xml", conteudo: xmlEstilos() },
    { nome: "xl/worksheets/sheet1.xml", conteudo: planilha }
  ];

  return zip(arquivos);
}

function baixar(cfg) {
  var bytes = gerar(cfg);
  var blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = cfg.arquivo;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
}

window.Planilha = { gerar: gerar, baixar: baixar };

})();
