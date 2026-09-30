#!/usr/bin/env python3
"""
agente_margem.py — abre e fecha a margem minima das filiais no WinThor.

SUBSTITUI oito arquivos .bat (Definir_margen_5_filial_*.bat e
zera_margem_filial*.bat), que faziam a mesma coisa sem registrar quem fez,
quando e por que, montando SQL por concatenacao de texto e com a senha do
WinThor escrita dentro do arquivo, numa pasta de rede compartilhada.

O QUE E "ABRIR" E "FECHAR"
  abrir  -> PCPRODFILIAL.PERCMARGEMMIN = NULL  (o produto pode ser vendido sem
            piso de margem naquela filial)
  fechar -> PCPRODFILIAL.PERCMARGEMMIN = <margem>  (volta a exigir o piso; os
            .bat usavam 5 fixo, aqui o valor vem no pedido)

DOIS MODOS

1) Fila do painel (e assim que a tarefa agendada roda):

       python agente_margem.py --servir

   Pega os pedidos que o pessoal do comercial registrou no painel, executa no
   Oracle e devolve o resultado para a mesma tabela. O painel nao alcanca o
   Oracle — ele vive na Vercel, e o banco do WinThor esta dentro da rede — por
   isso existe a fila.

2) Direto, para a TI, quando for mais rapido que abrir o painel:

       python agente_margem.py --acao abrir  --filiais 1 7 --produtos 1234 5678 \\
              --nome "Julio" --motivo "liberacao para a campanha de outubro"
       python agente_margem.py --acao fechar --filiais 1 --produtos 1234 --margem 5 \\
              --nome "Julio" --motivo "fim da campanha"

   Passa pela mesma fila e pelo mesmo registro: nada acontece sem nome e motivo.

ANTES DE MUDAR, ELE GUARDA O VALOR ANTERIOR de cada produto em
comercial.margem_alteracao. E o que permite auditar e desfazer — coisa que os
.bat nao davam: depois de rodar, ninguem sabia o que havia antes.

O usuario do Oracle e OUTRO: o do ETL e de leitura. Este precisa de um com
permissao de escrita em PCPRODFILIAL, declarado no ENV como
ORACLE_USER_ESCRITA / ORACLE_PASSWORD_ESCRITA. A senha nao fica em lugar
nenhum do codigo nem do repositorio.
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone

import oracledb
import psycopg2
import psycopg2.extras

import bi_comum as bi

log = bi.configurar_log("agente_margem.log")
bi.definir_schema("comercial")

FILIAIS_ATENDIDAS = (1, 7, 11, 12)
MAXIMO_PRODUTOS = 500


# ---------------------------------------------------------------------------
# Conexoes
# ---------------------------------------------------------------------------

def conectar_oracle_escrita():
    """Conecta com o usuario que pode ESCREVER em PCPRODFILIAL.

    Deliberadamente separado do usuario do ETL: aquele e de leitura, e um erro
    aqui mexeria no cadastro de produto da empresa inteira."""
    usuario = os.environ.get("ORACLE_USER_ESCRITA", "").strip()
    senha = os.environ.get("ORACLE_PASSWORD_ESCRITA", "")
    if not usuario or not senha:
        # RuntimeError, e nao SystemExit: assim o erro pertence ao PEDIDO e e
        # gravado no historico, em vez de derrubar o agente e deixar a
        # solicitacao presa em "executando" para sempre.
        raise RuntimeError(
            "Faltam ORACLE_USER_ESCRITA e ORACLE_PASSWORD_ESCRITA no ENV da maquina. "
            "O usuario do ETL e so de leitura; para mexer na margem e preciso um com "
            "permissao de UPDATE em PCPRODFILIAL."
        )
    cfg = bi.OracleConfig.from_env()
    dsn = oracledb.makedsn(cfg.host, cfg.port, service_name=cfg.service_name)
    log.info("Conectando no Oracle %s:%s/%s como %s (escrita)",
             cfg.host, cfg.port, cfg.service_name, usuario)
    return oracledb.connect(user=usuario, password=senha, dsn=dsn)


# ---------------------------------------------------------------------------
# Execucao de um pedido
# ---------------------------------------------------------------------------

def executar_pedido(conn_ora, conn_pg, pedido) -> tuple[int, str]:
    """Aplica um pedido no Oracle e devolve (linhas afetadas, mensagem).

    O SQL usa bind — nunca texto montado. Os .bat originais colavam o codigo
    digitado direto na instrucao; aqui, um codigo estranho simplesmente nao
    casa com nenhuma linha."""
    acao = pedido["acao"]
    valor = None if acao == "abrir" else float(pedido["margem"])
    filiais = [int(f) for f in pedido["filiais"]]
    produtos = [int(p) for p in pedido["produtos"]]

    if len(produtos) > MAXIMO_PRODUTOS:
        raise ValueError(f"pedido com {len(produtos)} produtos; o teto e {MAXIMO_PRODUTOS}")
    for f in filiais:
        if f not in FILIAIS_ATENDIDAS:
            raise ValueError(f"filial {f} fora das atendidas {FILIAIS_ATENDIDAS}")

    total = 0
    anteriores: list[tuple] = []
    cur = conn_ora.cursor()

    for filial in filiais:
        # 1) guarda o que existe hoje, em lotes (o Oracle limita a lista do IN)
        for inicio in range(0, len(produtos), 900):
            lote = produtos[inicio:inicio + 900]
            marcas = ", ".join(f":p{i}" for i in range(len(lote)))
            binds = {f"p{i}": c for i, c in enumerate(lote)}
            binds["filial"] = str(filial)   # CODFILIAL e VARCHAR no WinThor
            cur.execute(
                f"SELECT CODPROD, PERCMARGEMMIN FROM PCPRODFILIAL "
                f"WHERE CODFILIAL = :filial AND CODPROD IN ({marcas})", binds)
            for codprod, atual in cur.fetchall():
                anteriores.append((pedido["id"], filial, int(codprod),
                                   None if atual is None else float(atual), valor))

        # 2) muda
        cur.executemany(
            "UPDATE PCPRODFILIAL SET PERCMARGEMMIN = :valor "
            " WHERE CODFILIAL = :filial AND CODPROD = :codprod",
            [{"valor": valor, "filial": str(filial), "codprod": c} for c in produtos])
        total += cur.rowcount

    conn_ora.commit()
    log.info("  Oracle: %d linha(s) alterada(s)", total)

    if anteriores:
        with conn_pg.cursor() as cpg:
            psycopg2.extras.execute_values(
                cpg,
                "INSERT INTO comercial.margem_alteracao "
                "(solicitacao_id, codfilial, codprod, valor_anterior, valor_novo) VALUES %s",
                anteriores, page_size=1000)
        conn_pg.commit()

    encontrados = len({a[2] for a in anteriores})
    faltando = len(produtos) - encontrados
    msg = f"{total} linha(s) alterada(s) em {len(filiais)} filial(is)"
    if faltando > 0:
        msg += f"; {faltando} codigo(s) nao existem no cadastro dessas filiais"
    return total, msg


MINUTOS_PRESO = 15
TENTATIVAS_MAXIMAS = 3


def destravar_presos(conn_pg) -> None:
    """Pedido que ficou em "executando" e nao terminou volta para a fila.

    Acontece se a maquina reiniciar ou a rede cair no meio. Sem isto, a
    solicitacao fica presa e ninguem entende por que nada acontece — e quem
    pediu nao tem como saber. Depois de algumas tentativas, vira erro, com o
    motivo escrito."""
    with conn_pg.cursor() as cur:
        cur.execute("""
            UPDATE comercial.margem_solicitacao
               SET status = CASE WHEN tentativas >= %s THEN 'erro' ELSE 'pendente' END,
                   mensagem = CASE WHEN tentativas >= %s
                                   THEN 'Desistiu depois de ' || tentativas || ' tentativas: o agente comecou e nao terminou.'
                                   ELSE mensagem END,
                   concluido_em = CASE WHEN tentativas >= %s THEN now() END
             WHERE status = 'executando'
               AND iniciado_em < now() - (%s || ' minutes')::interval
         RETURNING id, status
        """, (TENTATIVAS_MAXIMAS, TENTATIVAS_MAXIMAS, TENTATIVAS_MAXIMAS, MINUTOS_PRESO))
        soltos = cur.fetchall()
    conn_pg.commit()
    for identificador, status in soltos:
        log.warning("Pedido #%s estava preso em 'executando' -> %s", identificador, status)


def processar_fila(conn_pg, limite: int) -> int:
    """Pega os pedidos pendentes e executa. Devolve quantos foram tratados."""
    destravar_presos(conn_pg)
    with conn_pg.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""
            SELECT id, solicitante, motivo, acao, filiais, produtos, margem, tentativas
              FROM comercial.margem_solicitacao
             WHERE status = 'pendente'
             ORDER BY id
             LIMIT %s
            FOR UPDATE SKIP LOCKED
        """, (limite,))
        pendentes = cur.fetchall()

    if not pendentes:
        conn_pg.rollback()
        return 0

    log.info("%d pedido(s) na fila.", len(pendentes))
    conn_ora = None
    tratados = 0
    try:
        for pedido in pendentes:
            with conn_pg.cursor() as cur:
                cur.execute("""UPDATE comercial.margem_solicitacao
                                  SET status = 'executando', iniciado_em = now(),
                                      tentativas = tentativas + 1
                                WHERE id = %s""", (pedido["id"],))
            conn_pg.commit()

            log.info("=" * 64)
            log.info("[#%s] %s — %s produto(s), filiais %s — pedido de %s",
                     pedido["id"], pedido["acao"].upper(), len(pedido["produtos"]),
                     pedido["filiais"], pedido["solicitante"])
            log.info("      motivo: %s", pedido["motivo"])
            try:
                if conn_ora is None:
                    conn_ora = conectar_oracle_escrita()
                linhas, msg = executar_pedido(conn_ora, conn_pg, pedido)
                with conn_pg.cursor() as cur:
                    cur.execute("""UPDATE comercial.margem_solicitacao
                                      SET status = 'concluida', concluido_em = now(),
                                          linhas_afetadas = %s, mensagem = %s
                                    WHERE id = %s""", (linhas, msg, pedido["id"]))
                conn_pg.commit()
                log.info("      OK — %s", msg)
            except Exception as exc:  # noqa: BLE001 — um pedido ruim nao para os outros
                if conn_ora is not None:
                    try:
                        conn_ora.rollback()
                    except Exception:
                        pass
                conn_pg.rollback()
                with conn_pg.cursor() as cur:
                    cur.execute("""UPDATE comercial.margem_solicitacao
                                      SET status = 'erro', concluido_em = now(), mensagem = %s
                                    WHERE id = %s""",
                                (f"{type(exc).__name__}: {exc}"[:2000], pedido["id"]))
                conn_pg.commit()
                log.exception("      FALHOU no pedido %s", pedido["id"])
            tratados += 1
    finally:
        if conn_ora is not None:
            conn_ora.close()
    return tratados


# ---------------------------------------------------------------------------
# Linha de comando
# ---------------------------------------------------------------------------

def registrar_pela_linha_de_comando(conn_pg, args) -> int:
    produtos = [int(p) for p in args.produtos]
    filiais = [int(f) for f in args.filiais]
    with conn_pg.cursor() as cur:
        cur.execute("""SELECT comercial.margem_registrar(%s, %s, %s, %s::smallint[], %s::integer[], %s, %s)""",
                    (args.nome, args.motivo, args.acao, filiais, produtos, args.margem, "linha de comando"))
        resposta = cur.fetchone()[0]
    conn_pg.commit()
    if resposta.get("erro"):
        log.error("Pedido recusado: %s", resposta["erro"])
        return 1
    log.info("Pedido #%s registrado (%s produto(s), %s filial(is)).",
             resposta["id"], resposta["produtos"], resposta["filiais"])
    return 0


def main() -> int:
    p = argparse.ArgumentParser(
        description="Abre e fecha a margem minima de produtos por filial no WinThor.")
    p.add_argument("--servir", action="store_true",
                   help="Executa os pedidos pendentes da fila do painel e sai.")
    p.add_argument("--limite", type=int, default=5, help="Maximo de pedidos por rodada.")
    p.add_argument("--acao", choices=("abrir", "fechar"), help="Registra um pedido direto.")
    p.add_argument("--filiais", nargs="+", metavar="N", help="Filiais: 1 7 11 12")
    p.add_argument("--produtos", nargs="+", metavar="COD", help="Codigos de produto.")
    p.add_argument("--margem", type=float, help="Margem a aplicar quando a acao for fechar.")
    p.add_argument("--nome", help="Quem esta pedindo.")
    p.add_argument("--motivo", help="Por que esta pedindo.")
    p.add_argument("--agora", action="store_true",
                   help="Com --acao, executa na hora em vez de so deixar na fila.")
    args = p.parse_args()

    bi.carregar_env()
    cfg_pg = bi.SupabaseConfig.from_env()

    with bi.conectar_supabase(cfg_pg) as conn_pg:
        if args.acao:
            faltando = [n for n, v in (("--filiais", args.filiais), ("--produtos", args.produtos),
                                       ("--nome", args.nome), ("--motivo", args.motivo)) if not v]
            if faltando:
                log.error("Faltou: %s", ", ".join(faltando))
                return 2
            codigo = registrar_pela_linha_de_comando(conn_pg, args)
            if codigo or not args.agora:
                return codigo
            processar_fila(conn_pg, args.limite)
            return 0

        if args.servir:
            tratados = processar_fila(conn_pg, args.limite)
            if tratados == 0:
                log.info("Nada na fila.")
            return 0

    p.print_help()
    return 2


if __name__ == "__main__":
    try:
        codigo = main()
    except SystemExit as saida:
        raise
    except Exception:
        log.exception("Erro inesperado no agente de margem.")
        codigo = 1
    sys.exit(codigo)
