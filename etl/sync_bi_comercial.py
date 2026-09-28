#!/usr/bin/env python3
"""
sync_bi_comercial.py — orquestrador do BI COMERCIAL inteiro.

Roda, numa tacada so, todas as consultas do Power BI "comercial" do
Oracle/WinThor para o Supabase (projeto DATA WAREHOUSE, schema `comercial`).

Cada consulta roda de forma independente: se uma falhar, as outras continuam, e
o resultado de cada uma fica registrado em comercial.controle_carga — e essa
tabela, nao o log na tela, que responde "a carga entrou?".

Como usar
---------
    python sync_bi_comercial.py                      # tudo, inclusive a margem
    python sync_bi_comercial.py --grupo rapidas      # tudo, menos a margem por item
    python sync_bi_comercial.py --grupo pesadas      # so a margem por item
    python sync_bi_comercial.py --consulta comissao_nf devolucao
    python sync_bi_comercial.py --listar             # mostra o catalogo e sai

Agendamento (ver instalar_e_agendar.ps1):
    - "rapidas" 4x ao dia: comissao, devolucoes, pedidos em aberto e dimensoes;
    - "pesadas" 1x de madrugada: a margem por item, que tem ~3,3 milhoes de
      linhas desde 2023 e nao muda de hora em hora para tras.

Antes da primeira carga, rode o diagnostico_bi_comercial.py: ele testa todas as
consultas SEM gravar nada e ainda soma os valores de referencia do Power BI.
"""

from __future__ import annotations

import argparse
import sys

import bi_comum as bi
from consultas_comercial import CONSULTAS, selecionar

log = bi.configurar_log("sync_bi_comercial.log")

# Diz ao bi_comum onde fica o controle_carga deste sistema. Sem isto ele
# gravaria no schema do BI COMPRAS.
bi.definir_schema("comercial")

# Agregados do painel que sao recalculados depois da carga, na mesma conexao.
# Ficam aqui (e nao presos a uma consulta) porque dependem de mais de uma
# tabela: a comissao le a fato_comissao_nf, a devolucao le a fato_devolucao.
VIEWS_DO_PAINEL = (
    "mv_comissao_rca_mes",
    "mv_comissao_mes",
    "mv_devolucao_rca_mes",
    "mv_margem_mes",
)


def _argumentos() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Sincroniza o BI COMERCIAL (Oracle/WinThor -> Supabase).")
    p.add_argument("--grupo", choices=("todas", "rapidas", "pesadas"), default="todas",
                   help="Quais consultas rodar. 'rapidas' exclui a margem por item.")
    p.add_argument("--consulta", nargs="+", metavar="NOME",
                   help="Roda apenas as consultas indicadas (pelo nome do catalogo).")
    p.add_argument("--listar", action="store_true", help="Mostra o catalogo de consultas e sai.")
    p.add_argument("--sem-views", action="store_true",
                   help="Nao atualiza as views materializadas do painel no fim.")
    return p.parse_args()


def _listar() -> int:
    print()
    print(f"{'CONSULTA':24s} {'GRUPO':9s} {'PAGINA DO BI':42s} {'LINHAS (Power BI)':>18s}")
    print("-" * 96)
    for c in CONSULTAS:
        esperado = f"{c.linhas_esperadas:,}".replace(",", ".") if c.linhas_esperadas else "-"
        print(f"{c.nome:24s} {c.grupo:9s} {c.pagina:42s} {esperado:>18s}")
    print()
    return 0


def _formatar(n: int | None) -> str:
    return "-" if n is None else f"{n:,}".replace(",", ".")


def _atualizar_views(conn_pg) -> None:
    """Recalcula os agregados do painel. Se uma falhar, as outras seguem: o
    painel tem como se virar com a tabela crua, so fica mais lento."""
    for view in VIEWS_DO_PAINEL:
        relogio = bi.cronometro()
        try:
            with conn_pg.cursor() as cur:
                cur.execute(f"REFRESH MATERIALIZED VIEW comercial.{view}")
            conn_pg.commit()
            log.info("  view %s atualizada em %.1fs", view, relogio())
        except Exception as exc:  # noqa: BLE001
            conn_pg.rollback()
            log.warning("  nao consegui atualizar a view %s: %s", view, exc)


def main() -> int:
    args = _argumentos()
    if args.listar:
        return _listar()

    bi.carregar_env()

    try:
        cfg_ora = bi.OracleConfig.from_env()
        cfg_pg = bi.SupabaseConfig.from_env()
    except SystemExit as exc:
        log.error("Configuracao invalida: %s", exc)
        return 1

    log.info("Senha do Supabase carregada do ENV (comprimento: %d caracteres).", len(cfg_pg.password))

    consultas = selecionar(args.grupo, args.consulta)
    log.info("Vou rodar %d consulta(s): %s", len(consultas), ", ".join(c.nome for c in consultas))

    resultados: list[tuple[str, str, int | None, int | None, float]] = []

    try:
        with bi.conectar_oracle(cfg_ora) as conn_ora, bi.conectar_supabase(cfg_pg) as conn_pg:
            for consulta in consultas:
                relogio = bi.cronometro()
                log.info("=" * 70)
                log.info("[%s] %s", consulta.nome, consulta.descricao)
                try:
                    if consulta.streaming:
                        linhas = bi.carregar_em_lotes(conn_ora, conn_pg, consulta)
                    else:
                        brutas = bi.extrair(conn_ora, consulta)
                        log.info("  Oracle devolveu %s linhas.", _formatar(len(brutas)))
                        linhas = bi.carregar(conn_pg, consulta, brutas)
                    conn_pg.commit()
                    segundos = relogio()

                    aviso = bi.avaliar_contagem(consulta, linhas) or ""
                    log.info("  OK — %s linhas em %.1fs -> %s", _formatar(linhas), segundos, consulta.destino)
                    if aviso:
                        log.warning(aviso)
                    resultados.append((consulta.nome, "OK", linhas, consulta.linhas_esperadas, segundos))
                    bi.registrar_execucao(conn_pg, consulta, "OK", linhas, segundos, aviso or None)

                except Exception as exc:  # noqa: BLE001 — uma falha nao pode derrubar as outras
                    conn_pg.rollback()
                    segundos = relogio()
                    log.exception("  FALHOU: %s", consulta.nome)
                    resultados.append((consulta.nome, "ERRO", None, consulta.linhas_esperadas, segundos))
                    bi.registrar_execucao(conn_pg, consulta, "ERRO", None, segundos, f"{type(exc).__name__}: {exc}")

            if not args.sem_views:
                log.info("=" * 70)
                log.info("Atualizando os agregados do painel...")
                _atualizar_views(conn_pg)

            _resumo(resultados)

    except Exception:
        log.exception("Nao consegui nem abrir as conexoes — nada foi carregado.")
        return 1

    falhas = [r for r in resultados if r[1] != "OK"]
    if falhas:
        log.error("%d consulta(s) falharam: %s", len(falhas), ", ".join(r[0] for r in falhas))
        return 1
    log.info("Todas as consultas foram carregadas com sucesso.")
    return 0


def _resumo(resultados) -> None:
    log.info("=" * 70)
    log.info("RESUMO DA CARGA")
    log.info("%-24s %-6s %12s %12s %9s", "CONSULTA", "STATUS", "LINHAS", "ESPERADO", "TEMPO")
    for nome, status, linhas, esperado, segundos in resultados:
        log.info("%-24s %-6s %12s %12s %8.1fs", nome, status, _formatar(linhas), _formatar(esperado), segundos)
    log.info("=" * 70)


if __name__ == "__main__":
    try:
        codigo = main()
    except Exception:
        log.exception("Erro inesperado — veja o traceback acima / no sync_bi_comercial.log.")
        codigo = 1
    sys.exit(codigo)
