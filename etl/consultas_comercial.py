#!/usr/bin/env python3
"""
consultas_comercial.py — o catalogo completo das consultas do BI COMERCIAL.

Cada entrada de CONSULTAS descreve uma consulta: o SQL no Oracle/WinThor, a
tabela de destino no Supabase (projeto DATA WAREHOUSE), as colunas, como
converter uma linha e quantas linhas o Power BI tinha na documentacao — esse
numero e usado pelo diagnostico para avisar quando a contagem fugir demais.

Correspondencia com o Power BI "comercial" (workspace COMERCIAL):

    Pagina do Power BI               Consulta original   Destino aqui
    -------------------------------  ------------------  ---------------------------
    MARGEM X PRODUTO 5% e 10%        Consulta2           comercial.fato_margem_item
    CONSULTA MARGEM 21               Consulta4           comercial.fato_pedido_aberto
    TABELA COMISSAO POR RCA -ST      Consulta6           comercial.fato_comissao_nf
    COMISSAO ST NF (drill)           Consulta6           a mesma tabela
    DEVOLUCOES / DEVOLUCOES POR RCA  Consulta3           comercial.fato_devolucao
    (nenhuma)                        Consulta5           NAO carregada — ver nota 5

A Consulta1 do Power BI era so um carimbo de data/hora (DateTimeZone.LocalNow);
o equivalente aqui e a coluna data_carga de cada tabela e o log em
comercial.controle_carga.

-------------------------------------------------------------------------------
DIFERENCAS CONSCIENTES EM RELACAO AO POWER BI (todas repetidas no README)
-------------------------------------------------------------------------------
1. Desconto financeiro (Consulta6). No original, o VLDESCFIN da CAPA da nota
   (PCNFSAID) era repetido em cada linha de operacao da mesma nota — uma linha
   'S', outra 'ED', outra 'SB' — e a medida somava o mesmo desconto varias
   vezes. Aqui ele e contado UMA vez, na venda, e o valor do jeito antigo fica
   ao lado em desc_financeiro_original, para conferir a diferenca.

2. Devolucao (Consulta3). O original trazia PCNFENT.VLTOTAL, o total da NOTA,
   e havia 81 notas aparecendo em mais de uma linha (mesma nota com mais de um
   NUMNOTADEV/CODUSUR/data) — o total da nota era somado de novo a cada linha,
   superestimando as devolucoes. Aqui o valor vem da LINHA (QT x PUNITCONT),
   que e somavel, e o total da nota fica em vltotal_nota para comparar.

3. Grao da Consulta6. O original separava uma linha por CODOPER (venda,
   devolucao, bonificacao). Aqui cada nota vira UMA linha, com venda,
   devolucao, bonificacao, CMV e ST lado a lado. A contagem de linhas cai em
   relacao as 205.503 do Power BI; os SOMATORIOS sao os mesmos.

4. Joins que nao traziam coluna. A Consulta2 e a Consulta6 faziam LEFT JOIN em
   PCNFSAID sem usar nenhuma coluna dela (na Consulta2) — esse join saiu, e so
   ele: os demais (PCPRODUT, PCFORNEC, PCUSUARI, PCSUPERV, PCCLIENT) continuam,
   porque, mesmo sem trazer coluna, eles FILTRAM, e tirar mudaria a contagem.

5. Consulta5 (positivacao) nao e carregada. Ela nao alimentava nenhuma pagina
   do relatorio e o grao ja vinha errado (produtos distintos contados DENTRO de
   cada cliente, entao somar entre clientes conta o mesmo produto varias
   vezes). Clientes positivados e pedidos distintos por RCA saem de graca da
   fato_comissao_nf, que tem CODCLI, NUMPED e DTMOV — ver a funcao do painel.

6. A regra de comissao NAO esta mais no SQL nem na tela: ela vive em
   comercial.dim_faixa_comissao (as faixas) e em comercial.comissao_percentual()
   (a busca da faixa). O Power BI tinha DUAS regras diferentes convivendo — a
   coluna SQL COMISSAO (que pagava 0% para margem negativa, e nao era usada) e
   a medida DAX (que paga 1%). Vale a DAX, que e a que aparece na tela.
"""

from __future__ import annotations

import os
from datetime import date, datetime, timezone

from bi_comum import Consulta, inteiro, num, texto

AGORA = lambda: datetime.now(timezone.utc)  # noqa: E731


# ---------------------------------------------------------------------------
# Recortes que o Power BI tinha escritos a mao dentro do SQL. Ficam aqui em
# cima, num lugar so, e podem ser mudados pelo ENV sem mexer em consulta.
# ---------------------------------------------------------------------------

def _data_env(chave: str, padrao: str) -> date:
    bruto = os.environ.get(chave, padrao).strip()
    try:
        return date.fromisoformat(bruto)
    except ValueError:
        return date.fromisoformat(padrao)


# Consulta2 (margem por item): o original pegava so a filial 1 desde 01/01/2023.
DATA_INICIAL_MARGEM = _data_env("MARGEM_DATA_INICIAL", "2023-01-01")
FILIAIS_MARGEM = tuple(
    int(f) for f in os.environ.get("MARGEM_FILIAIS", "1").replace(";", ",").split(",") if f.strip()
)

# Consulta6 (comissao): filiais 1, 7, 10, 11 e 12 desde 01/01/2025.
DATA_INICIAL_COMISSAO = _data_env("COMISSAO_DATA_INICIAL", "2025-01-01")
# Filiais onde o piso de margem (PCPRODFILIAL.PERCMARGEMMIN) e aberto e fechado
# pelo comercial. Sao as mesmas quatro que os .bat antigos atendiam.
FILIAIS_PISO_MARGEM = (1, 7, 11, 12)

FILIAIS_COMISSAO = tuple(
    int(f) for f in os.environ.get("COMISSAO_FILIAIS", "1,7,10,11,12").replace(";", ",").split(",") if f.strip()
)

# Consulta3 (devolucoes): todas as filiais desde 01/01/2025.
DATA_INICIAL_DEVOLUCAO = _data_env("DEVOLUCAO_DATA_INICIAL", "2025-01-01")

# CFOP excluido da base de comissao no original (1949 = outras entradas).
CFOP_EXCLUIDOS = (1949,)


def _lista(valores) -> str:
    return ", ".join(str(v) for v in valores)


# ---------------------------------------------------------------------------
# Motivos de devolucao que sao responsabilidade do RCA.
#
# No Power BI essa lista estava presa DENTRO do filtro de um visual da pagina
# "DEVOLUCOES POR RCA" — e o cartao de total, ao lado, nao tinha o filtro: a
# tela mostrava R$ 365.013,47 no cartao e R$ 156.347,65 na tabela, no mesmo
# periodo. Aqui a lista virou uma coluna (responsabilidade_rca) na dimensao de
# motivos, entao cartao e tabela leem a mesma coisa.
#
# A comparacao e feita sem acento, sem pontuacao e sem espaco duplicado,
# porque os motivos vem do WinThor com ponto final solto e espaco no fim.
# ---------------------------------------------------------------------------
MOTIVOS_DO_RCA = (
    "CLIENTE NAO LOCALIZADO",
    "COMERCIO FECHADO",
    "DESISTIU DA COMPRA",
    "DEVP. NAO PEDIU",
    "ENDERECO NAO CONFERE",
    "FORM.PAG DIFE .NEGOCIADO",
    "NAO PEDIU",
    "PEDIDO EMITIDO CLIENTE ERRADO",
    "PEDIDO ERRADO",
    "PEDIDO REPETIDO",
    "PRECO ERRADO",
    "PRODUTO NAO CADASTRADO",
    "S/ FUNCIONARIO P/ RECEBER",
    "SEM DINHEIRO",
)

_ACENTOS = str.maketrans("ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ", "AAAAAEEEEIIIIOOOOOUUUUC")


def _normalizar_motivo(texto_motivo) -> str:
    """Tira acento, pontuacao solta e espaco repetido, para comparar motivos."""
    s = str(texto_motivo or "").upper().translate(_ACENTOS)
    s = s.replace(".", " ").replace(",", " ").replace("-", " ")
    return " ".join(s.split())


_MOTIVOS_RCA_NORM = {_normalizar_motivo(m) for m in MOTIVOS_DO_RCA}


def motivo_e_do_rca(motivo) -> bool:
    return _normalizar_motivo(motivo) in _MOTIVOS_RCA_NORM


# ===========================================================================
# DIMENSOES — carga por upsert, nunca apagam cadastro (ver skill data-warehouse)
# ===========================================================================

# O nome do RCA no Power BI vinha da propria tabela de vendas: um RCA que teve
# devolucao mas nao teve venda nas filiais da comissao simplesmente sumia da
# tela. Com a dimensao, o nome existe independente de ter vendido.
SQL_DIM_RCA = """
SELECT U.CODUSUR, U.NOME, U.CODSUPERVISOR, U.CODEQUIPE
  FROM PCUSUARI U
"""

SQL_DIM_SUPERVISOR = """
SELECT S.CODSUPERVISOR, S.NOME
  FROM PCSUPERV S
"""

SQL_DIM_CLIENTE = """
SELECT C.CODCLI, C.CLIENTE, C.CODCIDADE, CI.NOMECIDADE, CI.UF,
       NVL(C.PERDESCFIN, 0) AS PERDESCFIN
  FROM PCCLIENT C, PCCIDADE CI
 WHERE C.CODCIDADE = CI.CODCIDADE (+)
"""

# Motivos de devolucao (PCTABDEV). A coluna responsabilidade_rca e calculada
# aqui no Python, a partir da lista MOTIVOS_DO_RCA.
SQL_DIM_MOTIVO = """
SELECT D.CODDEVOL, D.MOTIVO
  FROM PCTABDEV D
"""


# ===========================================================================
# Consulta2 -> comercial.fato_margem_item
# Margem de cada item vendido (linha de nota), para as paginas de margem.
# ===========================================================================
#
# Como o grao ja e o item, a margem do item e, na pratica,
#     (PUNIT + VLOUTROS - CUSTOFIN) / (PUNIT + VLOUTROS)
# e nas linhas ED e SB a venda e zero, entao a margem sai nula — e por isso que
# as tabelas do relatorio filtram CODOPER = 'S'. A expressao completa do
# original esta reproduzida abaixo UMA vez (no original ela aparecia duas, e
# na Consulta6 sete vezes, sempre coladas inline).
SQL_MARGEM_ITEM = f"""
SELECT a.dtmov,
       a.numnota,
       a.numped,
       a.codoper,
       a.codusur,
       a.codprod,
       a.codfilial,

       NVL(SUM(DECODE(a.codoper,'S',  a.qt)), 0)                                  AS quantidade,
       TRUNC(NVL(SUM(DECODE(a.codoper,'S',  a.qt*(a.punit + a.vloutros))), 0), 2) AS venda,
       TRUNC(NVL(SUM(DECODE(a.codoper,'ED', a.qt*(a.punit + a.vloutros))), 0), 2) AS vl_devolucao,
       TRUNC(NVL(SUM(DECODE(a.codoper,'SB', a.qt*(a.punit + a.vloutros))), 0), 2) AS vl_bonificacao,
       TRUNC(NVL(SUM(DECODE(a.codoper,'S',  a.qt*a.custofin)), 0), 2)             AS cmv_venda,
       TRUNC(NVL(SUM(DECODE(a.codoper,'ED', a.qt*a.custofin)), 0), 2)             AS cmv_devolucao,
       TRUNC(NVL(SUM(DECODE(a.codoper,'SB', a.qt*a.pbonific)), 0), 2)             AS vl_bonific_custo,
       TRUNC(NVL(SUM(a.qt*a.st), 0), 2)                                           AS st,
       TRUNC(NVL(MAX(a.punit + a.vloutros), 0), 2)                                AS punit,

       /* MARGEM % = (venda - devolucao + custo devolvido - (bonificacao + custo da venda)) / venda * 100
          Mesma expressao do Power BI, escrita uma vez so. */
       CASE WHEN NVL(SUM(DECODE(a.codoper,'S', a.qt*(a.punit + a.vloutros))), 0) = 0 THEN NULL
            ELSE ROUND(
                   ( NVL(SUM(DECODE(a.codoper,'S',  a.qt*(a.punit + a.vloutros))), 0)
                   - NVL(SUM(DECODE(a.codoper,'ED', a.qt*a.punit)), 0)
                   + NVL(SUM(DECODE(a.codoper,'ED', a.qt*a.custofin)), 0)
                   - NVL(SUM(DECODE(a.codoper,'SB', a.qt*a.pbonific)), 0)
                   - NVL(SUM(DECODE(a.codoper,'S',  a.qt*a.custofin)), 0) )
                   / NVL(SUM(DECODE(a.codoper,'S', a.qt*(a.punit + a.vloutros))), 0) * 100, 2)
       END                                                                        AS margem_perc

  FROM pcmov a, pcprodut b, pcfornec c, pcusuari e, pcsuperv f, pcclient g
 WHERE a.codprod = b.codprod
   AND b.codfornec = c.codfornec
   AND a.codusur = e.codusur
   AND e.codsupervisor = f.codsupervisor
   AND a.codcli = g.codcli
   AND a.codfilial IN ({_lista(FILIAIS_MARGEM)})
   AND a.dtcancel IS NULL
   AND a.dtmov >= :data_inicial
 GROUP BY a.dtmov, a.numnota, a.numped, a.codoper, a.codusur, a.codprod, a.codfilial
"""


def _mapear_margem(r: dict) -> tuple:
    venda = num(r["venda"], 0)
    cmv = num(r["cmv_venda"], 0)
    return (
        r["dtmov"].date() if isinstance(r["dtmov"], datetime) else r["dtmov"],
        inteiro(r["numnota"]), inteiro(r["numped"]), texto(r["codoper"]),
        inteiro(r["codusur"]), inteiro(r["codprod"]), inteiro(r["codfilial"]),
        num(r["quantidade"], 0), venda,
        num(r["vl_devolucao"], 0), num(r["vl_bonificacao"], 0),
        cmv, num(r["cmv_devolucao"], 0), num(r["vl_bonific_custo"], 0),
        num(r["st"], 0), num(r["punit"], 0),
        r["margem_perc"],
        # margem em reais: para linha de venda e exatamente venda - CMV, que e o
        # mesmo que venda x margem% / 100. Somavel, ao contrario do percentual.
        round(float(venda) - float(cmv), 2) if r["margem_perc"] is not None else 0,
        AGORA(),
    )


# ===========================================================================
# Consulta6 -> comercial.fato_comissao_nf   (a tabela principal)
# ===========================================================================
#
# Uma linha por nota x pedido x cliente x RCA x filial, com tudo que a cadeia
# da comissao precisa. As colunas complexas que o original calculava no SQL
# (MARGEM, CMV_LIQUIDO, MASSA_MARGEM, PERC_LIQUIDO, COMISSAO...) NAO estao
# aqui de proposito: elas dependem do grao em que a comissao e calculada, e
# fixa-las por nota foi exatamente o que fez o total da tela nao bater com a
# soma das linhas. Quem calcula e a funcao do painel, no grao oficial.
SQL_COMISSAO_NF = f"""
SELECT a.dtmov,
       a.numnota,
       a.numped,
       a.codcli,
       a.codusur,
       f.codsupervisor,
       a.codfilial,

       NVL(SUM(DECODE(a.codoper,'S',  a.qt)), 0)                              AS quantidade,
       NVL(SUM(DECODE(a.codoper,'S',  a.qt*(a.punit - a.st))), 0)             AS venda,
       NVL(SUM(DECODE(a.codoper,'ED', a.qt*a.punitcont)), 0)                  AS devolucao_com_st,
       NVL(SUM(DECODE(a.codoper,'ED', a.qt*(a.punitcont - a.st))), 0)         AS devolucao_sem_st,
       NVL(SUM(DECODE(a.codoper,'S',  a.qt*a.custofin)), 0)                   AS cmv_venda,
       NVL(SUM(DECODE(a.codoper,'ED', a.qt*a.custofin)), 0)                   AS cmv_devolucao,
       NVL(SUM(DECODE(a.codoper,'SB', a.qt*a.custofin)), 0)                   AS cmv_bonificacao,
       NVL(SUM(DECODE(a.codoper,'SB', a.qt*a.pbonific)), 0)                   AS vl_bonificacao,
       NVL(SUM(a.qt * a.st), 0)                                               AS st,

       /* CORRIGIDO: o desconto financeiro vem da CAPA da nota e era repetido em
          cada linha de operacao. Aqui ele entra uma vez, pela venda. */
       TRUNC(NVL(MAX(DECODE(a.codoper,'S', d.vldescfin)), 0), 2)              AS desc_financeiro,
       /* do jeito antigo, para conferir lado a lado: o valor da capa contado
          uma vez para CADA tipo de operacao da nota que casava com ela. */
       TRUNC(NVL(MAX(d.vldescfin), 0), 2)
         * COUNT(DISTINCT CASE WHEN d.vldescfin IS NOT NULL THEN a.codoper END) AS desc_financeiro_original

  FROM pcmov a, pcprodut b, pcfornec c, pcnfsaid d, pcusuari e, pcsuperv f, pcclient g
 WHERE a.codprod = b.codprod
   AND b.codfornec = c.codfornec
   AND a.codusur = e.codusur
   AND e.codsupervisor = f.codsupervisor
   AND a.codcli = g.codcli
   AND a.numtransvenda = d.numtransvenda (+)
   AND a.codfiscal NOT IN ({_lista(CFOP_EXCLUIDOS)})
   AND a.codfilial IN ({_lista(FILIAIS_COMISSAO)})
   AND a.dtcancel IS NULL
   AND a.dtmov >= :data_inicial
 GROUP BY a.dtmov, a.numnota, a.numped, a.codcli, a.codusur, f.codsupervisor, a.codfilial
"""


def _mapear_comissao(r: dict) -> tuple:
    return (
        r["dtmov"].date() if isinstance(r["dtmov"], datetime) else r["dtmov"],
        inteiro(r["numnota"]), inteiro(r["numped"]), inteiro(r["codcli"]),
        inteiro(r["codusur"]), inteiro(r["codsupervisor"]), inteiro(r["codfilial"]),
        num(r["quantidade"], 0), num(r["venda"], 0),
        num(r["devolucao_com_st"], 0), num(r["devolucao_sem_st"], 0),
        num(r["cmv_venda"], 0), num(r["cmv_devolucao"], 0), num(r["cmv_bonificacao"], 0),
        num(r["vl_bonificacao"], 0), num(r["st"], 0),
        num(r["desc_financeiro"], 0), num(r["desc_financeiro_original"], 0),
        AGORA(),
    )


# ===========================================================================
# Consulta3 -> comercial.fato_devolucao
# ===========================================================================
#
# Devolucoes de cliente (entrada 'ED') com o motivo. O valor agora e o da
# LINHA (QT x PUNITCONT), somavel; o total da nota fica ao lado, so para
# comparar com o numero antigo.
SQL_DEVOLUCAO = """
SELECT a.dtmov,
       b.numnota,
       b.numtransent,
       a.codcli,
       a.codusur,
       a.codfilial,
       a.numnotadev,
       c.coddevol,
       SUM(a.qt)                                  AS qt,
       TRUNC(NVL(SUM(a.qt * a.punitcont), 0), 2)  AS valor_devolucao,
       TRUNC(NVL(SUM(a.qt * a.st), 0), 2)         AS st,
       MAX(b.vltotal)                             AS vltotal_nota
  FROM pcmov a, pcnfent b, pctabdev c
 WHERE a.numtransent = b.numtransent
   AND a.codoper = 'ED'
   AND b.coddevol = c.coddevol
   AND a.dtcancel IS NULL
   AND a.dtmov >= :data_inicial
 GROUP BY a.dtmov, b.numnota, b.numtransent, a.codcli, a.codusur, a.codfilial,
          a.numnotadev, c.coddevol
"""


def _mapear_devolucao(r: dict) -> tuple:
    return (
        r["dtmov"].date() if isinstance(r["dtmov"], datetime) else r["dtmov"],
        inteiro(r["numnota"]), inteiro(r["numtransent"]), inteiro(r["codcli"]),
        inteiro(r["codusur"]), inteiro(r["codfilial"]), inteiro(r["numnotadev"]),
        inteiro(r["coddevol"]),
        num(r["qt"], 0), num(r["valor_devolucao"], 0), num(r["st"], 0),
        num(r["vltotal_nota"], 0),
        AGORA(),
    )


# ===========================================================================
# Consulta4 -> comercial.fato_pedido_aberto
# ===========================================================================
#
# Foto da carteira: pedidos da filial 1 que ainda nao foram faturados nem
# cancelados, com a margem do pedido. Muda o dia inteiro, entao e full refresh
# a cada carga.
SQL_PEDIDO_ABERTO = """
SELECT a.data,
       a.numped,
       a.codcli,
       e.codusur,
       f.codsupervisor,
       a.codfilial,
       a.condvenda,
       DECODE(a.condvenda, '1','VENDA', '5','BONIFICACAO', 'OUTROS')          AS tipo_pedido,
       DECODE(a.posicao, 'B','BLOQUEADO', 'P','PENDENTE', 'L','LIBERADO',
                         'M','MONTADO', a.posicao)                            AS posicao,
       a.vltotal,
       SUM(b.qt)                                                              AS quantidade,

       /* MARGEM = (venda - (custo da venda + custo da bonificacao)) / venda * 100 */
       CASE WHEN NVL(SUM(DECODE(a.condvenda, 1, b.qt*b.pvenda)), 0) = 0 THEN NULL
            ELSE ROUND( ( NVL(SUM(DECODE(a.condvenda, 1, b.qt*b.pvenda)), 0)
                        - ( NVL(SUM(DECODE(a.condvenda, 1, b.qt*b.vlcustofin)), 0)
                          + NVL(SUM(DECODE(a.condvenda, 5, b.qt*b.vlcustofin)), 0) ) )
                      / NVL(SUM(DECODE(a.condvenda, 1, b.qt*b.pvenda)), 0) * 100, 2)
       END                                                                    AS margem_perc

  FROM pcpedc a, pcpedi b, pcprodut c, pcfornec d, pcusuari e, pcsuperv f, pcclient g
 WHERE a.numped = b.numped
   AND b.codprod = c.codprod
   AND a.codcli = g.codcli
   AND c.codfornec = d.codfornec
   AND a.codusur = e.codusur
   AND e.codsupervisor = f.codsupervisor
   AND a.codfilial = 1
   AND a.posicao NOT IN ('C','F')
 GROUP BY a.data, a.numped, a.vltotal, a.condvenda, a.posicao, a.codcli,
          e.codusur, f.codsupervisor, a.codfilial
"""


def _mapear_pedido(r: dict) -> tuple:
    return (
        r["data"].date() if isinstance(r["data"], datetime) else r["data"],
        inteiro(r["numped"]), inteiro(r["codcli"]), inteiro(r["codusur"]),
        inteiro(r["codsupervisor"]), inteiro(r["codfilial"]),
        texto(r["condvenda"]), texto(r["tipo_pedido"]), texto(r["posicao"]),
        num(r["vltotal"], 0), num(r["quantidade"], 0), r["margem_perc"],
        AGORA(),
    )


# ===========================================================================
# CATALOGO
# ===========================================================================

# ---------------------------------------------------------------------------
# O PISO DE MARGEM DE CADA PRODUTO, POR FILIAL
# ---------------------------------------------------------------------------
#
# PERCMARGEMMIN e a margem minima que o produto aceita naquela filial. Quando
# fica NULL, o piso sai do caminho: da para vender abaixo da margem. E disso
# que o comercial fala quando diz "abrir o sistema".
#
# Esta consulta e a FOTO: o painel de abertura mostra o que esta aberto agora
# lendo daqui, nao do nosso proprio historico. Se alguem mexer por fora — no
# WinThor, ou num .bat que sobrou — a tela conta a verdade do mesmo jeito.
SQL_MARGEM_FILIAL = f"""
SELECT TO_NUMBER(pf.CODFILIAL) AS codfilial,
       pf.CODPROD             AS codprod,
       pf.PERCMARGEMMIN       AS percmargemmin
  FROM PCPRODFILIAL pf
 WHERE pf.CODFILIAL IN ({_lista(FILIAIS_PISO_MARGEM)})
"""


CONSULTAS: list[Consulta] = [
    # ---------------- dimensoes (upsert) ----------------
    Consulta(
        nome="dim_rca",
        descricao="RCAs (PCUSUARI) com supervisor e equipe",
        pagina="(dimensao compartilhada)",
        sql=SQL_DIM_RCA,
        destino="core.dim_rca",
        colunas=("codusur", "nome", "codsupervisor", "codequipe", "updated_at"),
        chave_conflito=("codusur",),
        mapear=lambda r: (inteiro(r["codusur"]), texto(r["nome"]),
                          inteiro(r["codsupervisor"]), inteiro(r["codequipe"]), AGORA()),
        linhas_esperadas=None,
    ),
    Consulta(
        nome="dim_supervisor",
        descricao="Supervisores (PCSUPERV)",
        pagina="(dimensao compartilhada)",
        sql=SQL_DIM_SUPERVISOR,
        destino="core.dim_supervisor",
        colunas=("codsupervisor", "nome", "updated_at"),
        chave_conflito=("codsupervisor",),
        mapear=lambda r: (inteiro(r["codsupervisor"]), texto(r["nome"]), AGORA()),
        linhas_esperadas=None,
    ),
    Consulta(
        nome="dim_cliente",
        descricao="Clientes (PCCLIENT) com cidade, UF e % de desconto financeiro",
        pagina="(dimensao compartilhada)",
        sql=SQL_DIM_CLIENTE,
        destino="core.dim_cliente",
        colunas=("codcli", "cliente", "codcidade", "cidade", "uf", "perc_descfin", "updated_at"),
        chave_conflito=("codcli",),
        mapear=lambda r: (inteiro(r["codcli"]), texto(r["cliente"]), inteiro(r["codcidade"]),
                          texto(r["nomecidade"]), texto(r["uf"]), num(r["perdescfin"], 0), AGORA()),
        linhas_esperadas=None,
    ),
    Consulta(
        nome="dim_motivo_devolucao",
        descricao="Motivos de devolucao (PCTABDEV) com a marca de responsabilidade do RCA",
        pagina="DEVOLUCOES / DEVOLUCOES POR RCA",
        sql=SQL_DIM_MOTIVO,
        destino="comercial.dim_motivo_devolucao",
        colunas=("coddevol", "motivo", "responsabilidade_rca", "updated_at"),
        chave_conflito=("coddevol",),
        mapear=lambda r: (inteiro(r["coddevol"]), texto(r["motivo"]),
                          motivo_e_do_rca(r["motivo"]), AGORA()),
        linhas_esperadas=None,
    ),

    # ---------------- fatos ----------------
    Consulta(
        nome="pedido_aberto",
        descricao="Consulta4 — pedidos em aberto da filial 1 com a margem do pedido",
        pagina="CONSULTA MARGEM 21",
        sql=SQL_PEDIDO_ABERTO,
        destino="comercial.fato_pedido_aberto",
        colunas=("data", "numped", "codcli", "codusur", "codsupervisor", "codfilial",
                 "condvenda", "tipo_pedido", "posicao", "vltotal", "quantidade",
                 "margem_perc", "data_carga"),
        mapear=_mapear_pedido,
        linhas_esperadas=446,
        # E uma foto da carteira: 446 foi o que existia as 13h de 28/09/2026.
        # Varia o dia inteiro, entao a margem de aviso e larga de proposito.
        tolerancia_pct=1.50,
        grupo="rapidas",
    ),
    Consulta(
        nome="devolucao",
        descricao="Consulta3 — devolucoes de cliente com motivo (valor pela linha, nao pela nota)",
        pagina="DEVOLUCOES / DEVOLUCOES POR RCA",
        sql=SQL_DEVOLUCAO,
        destino="comercial.fato_devolucao",
        colunas=("dtmov", "numnota", "numtransent", "codcli", "codusur", "codfilial",
                 "numnotadev", "coddevol", "qt", "valor_devolucao", "st",
                 "vltotal_nota", "data_carga"),
        mapear=_mapear_devolucao,
        linhas_esperadas=12803,
        tolerancia_pct=0.10,
        binds={"data_inicial": DATA_INICIAL_DEVOLUCAO},
        grupo="rapidas",
    ),
    Consulta(
        nome="comissao_nf",
        descricao="Consulta6 — base da comissao: venda, devolucao, CMV, ST e desconto por nota",
        pagina="TABELA COMISSAO POR RCA -ST / COMISSAO ST NF",
        sql=SQL_COMISSAO_NF,
        destino="comercial.fato_comissao_nf",
        colunas=("dtmov", "numnota", "numped", "codcli", "codusur", "codsupervisor",
                 "codfilial", "quantidade", "venda", "devolucao_com_st", "devolucao_sem_st",
                 "cmv_venda", "cmv_devolucao", "cmv_bonificacao", "vl_bonificacao", "st",
                 "desc_financeiro", "desc_financeiro_original", "data_carga"),
        mapear=_mapear_comissao,
        # O Power BI tinha 205.503 linhas separando por CODOPER; aqui cada nota
        # vira uma linha so, entao a contagem cai de proposito (ver nota 3).
        linhas_esperadas=205503,
        tolerancia_pct=0.30,
        binds={"data_inicial": DATA_INICIAL_COMISSAO},
        grupo="rapidas",
    ),
    Consulta(
        nome="margem_filial",
        descricao="Piso de margem de cada produto por filial (PCPRODFILIAL.PERCMARGEMMIN)",
        pagina="Abertura de margem",
        sql=SQL_MARGEM_FILIAL,
        destino="comercial.fato_margem_filial",
        colunas=("codfilial", "codprod", "percmargemmin", "data_carga"),
        mapear=lambda r: (inteiro(r["codfilial"]), inteiro(r["codprod"]),
                          r["percmargemmin"], AGORA()),
        # Nao tem referencia no Power BI: e cadastro, nao movimento. O numero
        # abaixo e a ordem de grandeza (4 filiais x ~34 mil produtos) so para o
        # diagnostico gritar se a consulta voltar vazia.
        linhas_esperadas=137000,
        tolerancia_pct=0.50,
        grupo="rapidas",
    ),
    Consulta(
        nome="margem_item",
        descricao="Consulta2 — margem de cada item vendido (filial 1, desde 2023)",
        pagina="MARGEM X PRODUTO 5% / 10%",
        sql=SQL_MARGEM_ITEM,
        destino="comercial.fato_margem_item",
        colunas=("dtmov", "numnota", "numped", "codoper", "codusur", "codprod", "codfilial",
                 "quantidade", "venda", "vl_devolucao", "vl_bonificacao", "cmv_venda",
                 "cmv_devolucao", "vl_bonific_custo", "st", "punit", "margem_perc",
                 "margem_valor", "data_carga"),
        mapear=_mapear_margem,
        linhas_esperadas=3288372,
        tolerancia_pct=0.05,
        binds={"data_inicial": DATA_INICIAL_MARGEM},
        grupo="pesadas",
        streaming=True,
    ),
]


# ===========================================================================
# CONFERENCIA CONTRA O POWER BI
# ===========================================================================
#
# Contar linhas nao prova que os valores estao certos. Estas consultas somam,
# no Oracle, exatamente os mesmos numeros que foram lidos do modelo do Power BI
# em 28/09/2026 (secao 13 da documentacao tecnica) — mesmo periodo, mesmas
# filiais. O diagnostico roda todas e imprime obtido x esperado, lado a lado.
#
# Onde a reconstrucao corrige um erro do original, a diferenca e ESPERADA e
# esta anotada na propria linha da conferencia.

PERIODO_CONFERENCIA = (date(2026, 2, 2), date(2026, 2, 27))
PERIODO_CONFERENCIA_DEVOL = (date(2025, 6, 1), date(2026, 9, 28))

SQL_CONFERE_COMISSAO = f"""
SELECT COUNT(*)                                        AS linhas,
       COUNT(DISTINCT codusur)                         AS rcas,
       SUM(venda)                                      AS venda,
       SUM(devolucao_com_st)                           AS devolucao_com_st,
       SUM(devolucao_sem_st)                           AS devolucao_sem_st,
       SUM(st)                                         AS st,
       SUM(cmv_venda)                                  AS cmv_venda,
       SUM(cmv_devolucao)                              AS cmv_devolucao,
       SUM(cmv_bonificacao)                            AS cmv_bonificacao,
       SUM(desc_financeiro)                            AS desc_financeiro,
       SUM(desc_financeiro_original)                   AS desc_financeiro_original
  FROM ({SQL_COMISSAO_NF}) q
 WHERE q.dtmov <= :data_final
"""

SQL_CONFERE_DEVOLUCAO = f"""
SELECT COUNT(*)              AS linhas,
       SUM(valor_devolucao)  AS valor_devolucao,
       SUM(vltotal_nota)     AS vltotal_somado,
       SUM(st)               AS st
  FROM ({SQL_DEVOLUCAO}) q
 WHERE q.dtmov <= :data_final
"""


def _um(conn_ora, sql: str, binds: dict) -> dict:
    with conn_ora.cursor() as cur:
        cur.execute(sql, binds)
        nomes = [d[0].lower() for d in cur.description]
        linha = cur.fetchone()
    return dict(zip(nomes, linha)) if linha else {}


def conferir(conn_ora) -> list[tuple]:
    """Devolve [(rotulo, obtido, esperado, observacao)] para o diagnostico.

    `esperado` None significa "nao ha referencia do Power BI para isso"."""
    de, ate = PERIODO_CONFERENCIA
    c = _um(conn_ora, SQL_CONFERE_COMISSAO, {"data_inicial": de, "data_final": ate})
    resultado: list[tuple] = []

    if c:
        f = lambda k: float(c.get(k) or 0)  # noqa: E731
        venda = f("venda")
        dev_st = f("devolucao_com_st")
        dev_sst = f("devolucao_sem_st")
        st = f("st")
        total_liquido = venda - dev_st                      # [44] base da comissao
        total_liquido_sst = venda - dev_sst                 # [Medida 6] denominador do %
        cmv_liquido_orig = (f("cmv_venda") - f("cmv_devolucao")
                            + f("desc_financeiro_original") + f("cmv_bonificacao") - st)
        cmv_liquido = (f("cmv_venda") - f("cmv_devolucao")
                       + f("desc_financeiro") + f("cmv_bonificacao") - st)
        massa_orig = total_liquido_sst - cmv_liquido_orig
        massa = total_liquido_sst - cmv_liquido

        resultado += [
            (f"COMISSAO — periodo {de:%d/%m/%Y} a {ate:%d/%m/%Y}, filiais {_lista(FILIAIS_COMISSAO)}",
             None, None, ""),
            ("  Total vendas s/ ST [30]", venda, 9297704.78, ""),
            ("  Total devolucao c/ ST [37]", dev_st, 271106.53, ""),
            ("  TOTAL LIQUIDO [44] (base da comissao)", total_liquido, 9026598.25, ""),
            ("  TOTAL LIQUIDO s/ ST [Medida 6] (denominador do %)", total_liquido_sst, 9031601.57, ""),
            ("  TOTAL ST", st, 179866.47, ""),
            ("  CMV LIQUIDO [45] — regra antiga do desconto", cmv_liquido_orig, 7157039.00, ""),
            ("  CMV LIQUIDO [45] — desconto contado uma vez", cmv_liquido, None,
             "diferenca esperada: correcao 1"),
            ("  MASSA DE MARGEM [46] — regra antiga", massa_orig, 1874562.57, ""),
            ("  MASSA DE MARGEM [46] — corrigida", massa, None, "diferenca esperada: correcao 1"),
            ("  % LIQUIDO [47] — regra antiga",
             (massa_orig / total_liquido_sst * 100) if total_liquido_sst else None, 20.7556, "em %"),
            ("  RCAs com movimento", float(c.get("rcas") or 0), 145.0, ""),
            ("  Desconto financeiro — antigo x corrigido",
             f("desc_financeiro"), f("desc_financeiro_original"),
             "a 2a coluna e o valor do jeito antigo, nao uma referencia do BI"),
        ]

    de2, ate2 = PERIODO_CONFERENCIA_DEVOL
    d = _um(conn_ora, SQL_CONFERE_DEVOLUCAO, {"data_inicial": de2, "data_final": ate2})
    if d:
        resultado += [
            (f"DEVOLUCOES — periodo {de2:%d/%m/%Y} a {ate2:%d/%m/%Y}, todas as filiais",
             None, None, ""),
            ("  Soma dos totais de nota (jeito antigo)", float(d.get("vltotal_somado") or 0),
             6125108.84, ""),
            ("  Valor devolvido pela linha (corrigido)", float(d.get("valor_devolucao") or 0),
             None, "diferenca esperada: correcao 2"),
        ]
    return resultado


def por_nome(nome: str) -> Consulta | None:
    for c in CONSULTAS:
        if c.nome == nome:
            return c
    return None


def selecionar(grupo: str = "todas", nomes: list[str] | None = None) -> list[Consulta]:
    """Escolhe o que rodar. As dimensoes entram em qualquer grupo: sao rapidas e
    e delas que os fatos dependem para ter nome de RCA, cliente e motivo."""
    if nomes:
        escolhidas = [por_nome(n) for n in nomes]
        faltando = [n for n, c in zip(nomes, escolhidas) if c is None]
        if faltando:
            raise SystemExit(f"Consulta(s) desconhecida(s): {', '.join(faltando)}")
        return [c for c in escolhidas if c]
    if grupo == "todas":
        return list(CONSULTAS)
    return [c for c in CONSULTAS if c.grupo == grupo or c.nome.startswith("dim_")]
