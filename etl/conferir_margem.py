#!/usr/bin/env python3
"""
conferir_margem.py — confere no WinThor se a margem esta mesmo como dizemos.

POR QUE ISTO EXISTE

A tela diz "concluido, 40 linhas alteradas". O banco guarda quem pediu e o
valor anterior de cada produto. Mas as duas coisas sao o NOSSO registro: se
houvesse um erro entre o pedido e o UPDATE, os dois contariam a mesma mentira
com a mesma convicao.

Este programa nao olha o nosso registro para dizer o que aconteceu: ele vai no
PCPRODFILIAL e le o que esta la agora. E a unica verificacao que vale.

SO LEITURA. Usa o usuario do ETL (ORACLE_USER), que nao tem permissao de
escrever. Nao da para estragar nada rodando isto.

COMO USAR

  python conferir_margem.py
      Quantos produtos estao sem piso em cada filial, direto do Oracle.
      Compara com o que a nossa foto (comercial.fato_margem_filial) diz.

  python conferir_margem.py --produtos 1234 5678
      A situacao desses produtos nas quatro filiais, agora.

  python conferir_margem.py --pedido 7
      Pega o pedido numero 7, ve o que ele dizia ter feito, e confere
      produto por produto se o WinThor esta assim de verdade.
"""

from __future__ import annotations

import argparse
import sys

import psycopg2.extras

import bi_comum as bi

log = bi.configurar_log("conferir_margem.log")
bi.definir_schema("comercial")

FILIAIS = (1, 7, 11, 12)


def piso(valor) -> str:
    """Como escrever um PERCMARGEMMIN para gente ler."""
    if valor is None:
        return "ABERTO (sem piso)"
    return f"piso {float(valor):g}%"


def ler_oracle(conn_ora, produtos: list[int] | None) -> dict[tuple[int, int], object]:
    """Le PCPRODFILIAL agora. Chave: (filial, produto)."""
    marcas = ", ".join(str(int(f)) for f in FILIAIS)
    sql = ("SELECT TO_NUMBER(CODFILIAL) AS f, CODPROD AS c, PERCMARGEMMIN AS p "
           f"  FROM PCPRODFILIAL WHERE CODFILIAL IN ({marcas})")
    binds: dict = {}
    if produtos:
        # Em lotes de 900: o Oracle limita quantos itens cabem num IN.
        achados: dict[tuple[int, int], object] = {}
        with conn_ora.cursor() as cur:
            for inicio in range(0, len(produtos), 900):
                lote = produtos[inicio:inicio + 900]
                nomes = ", ".join(f":p{i}" for i in range(len(lote)))
                cur.execute(sql + f" AND CODPROD IN ({nomes})",
                            {f"p{i}": c for i, c in enumerate(lote)})
                for f, c, p in cur.fetchall():
                    achados[(int(f), int(c))] = p
        return achados

    achados = {}
    with conn_ora.cursor() as cur:
        cur.arraysize = 5000
        cur.execute(sql, binds)
        for f, c, p in cur:
            achados[(int(f), int(c))] = p
    return achados


# ---------------------------------------------------------------------------
# Modo 1: a contagem geral
# ---------------------------------------------------------------------------

def contagem(conn_ora, conn_pg) -> int:
    print("\nLendo PCPRODFILIAL direto do WinThor...\n")
    oracle = ler_oracle(conn_ora, None)

    with conn_pg.cursor() as cur:
        cur.execute("""SELECT codfilial,
                              count(*) FILTER (WHERE percmargemmin IS NULL),
                              max(data_carga)
                         FROM comercial.fato_margem_filial GROUP BY codfilial""")
        nosso = {int(f): (int(n), q) for f, n, q in cur.fetchall()}

    print(f"{'FILIAL':>8}  {'SEM PISO (WinThor)':>19}  {'A FOTO DIZ':>11}  {'PISO 0%':>8}  CONFERE")
    print("-" * 68)
    tudo_bate = True
    for f in FILIAIS:
        no_oracle = sum(1 for (ff, _), p in oracle.items() if ff == f and p is None)
        zerados = sum(1 for (ff, _), p in oracle.items() if ff == f and p is not None and float(p) == 0)
        na_foto = nosso.get(f, (0, None))[0]
        bate = "sim" if no_oracle == na_foto else "NAO <<<"
        if no_oracle != na_foto:
            tudo_bate = False
        print(f"{f:>8}  {no_oracle:>19}  {na_foto:>11}  {zerados:>8}  {bate}")

    carga = next((q for (_, q) in nosso.values() if q), None)
    print("-" * 68)
    print(f"A foto do painel e de {carga:%d/%m/%Y %H:%M} (hora do banco)." if carga else "")
    if tudo_bate:
        print("\nA tela esta contando certo: o que ela mostra e o que o WinThor tem.\n")
    else:
        print("\nATENCAO: a foto esta diferente do WinThor. Isso e normal se alguem")
        print("mexeu depois da ultima carga; se persistir, rode o sync.\n")

    zerados_total = sum(1 for p in oracle.values() if p is not None and float(p) == 0)
    if zerados_total:
        print(f"Nota: {zerados_total} produto(s) estao com piso 0%. Eles contam como")
        print("'fechados' porque tem um piso, mas 0% nao barra quase nada.\n")
    return 0


# ---------------------------------------------------------------------------
# Modo 2: produtos avulsos
# ---------------------------------------------------------------------------

def olhar_produtos(conn_ora, conn_pg, produtos: list[int]) -> int:
    oracle = ler_oracle(conn_ora, produtos)

    with conn_pg.cursor() as cur:
        cur.execute("""SELECT codprod, descricao FROM core.dim_produto
                        WHERE codprod = ANY(%s)""", (produtos,))
        nomes = dict(cur.fetchall())
        cur.execute("""SELECT codfilial, codprod, aberto_por, aberto_em
                         FROM comercial.margem_estado
                        WHERE codprod = ANY(%s)""", (produtos,))
        donos = {(int(f), int(c)): (q, quando) for f, c, q, quando in cur.fetchall()}

    print("\nSituacao agora, lida do WinThor:\n")
    for c in produtos:
        print(f"  {c}  {nomes.get(c, '(nao esta no cadastro do BI)')}")
        for f in FILIAIS:
            if (f, c) not in oracle:
                print(f"      filial {f:>2}: nao existe nesta filial")
                continue
            valor = oracle[(f, c)]
            linha = f"      filial {f:>2}: {piso(valor)}"
            dono, quando = donos.get((f, c), (None, None))
            if valor is None:
                linha += f"  — aberto por {dono} em {quando:%d/%m %H:%M}" if dono else \
                         "  — sem dono registrado (aberto antes do sistema)"
            print(linha)
        print()
    return 0


# ---------------------------------------------------------------------------
# Modo 3: conferir um pedido
# ---------------------------------------------------------------------------

def conferir_pedido(conn_ora, conn_pg, pedido_id: int) -> int:
    with conn_pg.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""SELECT * FROM comercial.margem_solicitacao WHERE id = %s""", (pedido_id,))
        p = cur.fetchone()
    if not p:
        print(f"\nNao existe pedido #{pedido_id}.\n")
        return 1

    esperado = None if p["acao"] == "abrir" else float(p["margem"])
    print(f"\nPEDIDO #{p['id']}")
    print(f"  quem      : {p['solicitante']}")
    print(f"  quando    : {p['criado_em']:%d/%m/%Y %H:%M}")
    print(f"  motivo    : {p['motivo']}")
    print(f"  acao      : {p['acao'].upper()}  ->  deveria ficar {piso(esperado)}")
    print(f"  filiais   : {list(p['filiais'])}")
    print(f"  produtos  : {len(p['produtos'])}")
    print(f"  situacao  : {p['status']}  —  {p['mensagem'] or ''}")
    print(f"  linhas    : {p['linhas_afetadas']}")

    produtos = [int(c) for c in p["produtos"]]
    filiais = [int(f) for f in p["filiais"]]
    oracle = ler_oracle(conn_ora, produtos)

    print("\nConferindo no WinThor, produto por produto...\n")
    certos = errados = ausentes = 0
    for f in filiais:
        for c in produtos:
            if (f, c) not in oracle:
                ausentes += 1
                continue
            valor = oracle[(f, c)]
            igual = (valor is None and esperado is None) or \
                    (valor is not None and esperado is not None and float(valor) == esperado)
            if igual:
                certos += 1
            else:
                errados += 1
                print(f"  DIFERENTE  filial {f}, produto {c}: "
                      f"esperava {piso(esperado)}, esta {piso(valor)}")

    print(f"\n  como o pedido mandou : {certos}")
    print(f"  diferente            : {errados}")
    print(f"  nao existem na filial: {ausentes}  (ignorados na execucao, o normal)")

    if errados == 0 and certos > 0:
        print("\nO pedido foi executado no WinThor exatamente como dizia.\n")
    elif errados:
        print("\nHa produto fora do esperado. Pode ser que alguem tenha mexido DEPOIS")
        print("deste pedido — veja o historico para ver se houve um pedido posterior.\n")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Confere no WinThor se a margem esta como o sistema diz. So leitura.")
    ap.add_argument("--produtos", nargs="+", type=int, metavar="COD",
                    help="Mostra a situacao destes produtos nas quatro filiais.")
    ap.add_argument("--pedido", type=int, metavar="N",
                    help="Confere um pedido do historico contra o WinThor.")
    args = ap.parse_args()

    bi.carregar_env()
    with bi.conectar_oracle(bi.OracleConfig.from_env()) as conn_ora, \
         bi.conectar_supabase(bi.SupabaseConfig.from_env()) as conn_pg:
        if args.pedido:
            return conferir_pedido(conn_ora, conn_pg, args.pedido)
        if args.produtos:
            return olhar_produtos(conn_ora, conn_pg, sorted(set(args.produtos)))
        return contagem(conn_ora, conn_pg)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        log.exception("Erro ao conferir a margem.")
        sys.exit(1)
