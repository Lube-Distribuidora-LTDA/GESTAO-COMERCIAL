#!/usr/bin/env python3
"""
diagnostico_bi_comercial.py — testa TODAS as consultas do BI COMERCIAL sem gravar nada.

Para que serve: os SQLs foram escritos a partir da documentacao tecnica do
Power BI "comercial", sem acesso ao Oracle para testar. Em vez de descobrir os
erros um de cada vez (rodar, falhar, avisar, corrigir, rodar de novo...), este
script roda todas as consultas de uma vez em modo "so leitura" e escreve um
relatorio unico — diagnostico_bi_comercial.txt — com o que funcionou, o que
falhou, a primeira linha de cada consulta e como a contagem ficou em relacao
ao Power BI.

Ele NAO grava nada no Supabase. Pode rodar tranquilo quantas vezes quiser.

Como usar
---------
    python diagnostico_bi_comercial.py                 # testa tudo (margem por amostra)
    python diagnostico_bi_comercial.py --completo      # conta a margem inteira (demora)
    python diagnostico_bi_comercial.py --consulta comissao_nf devolucao

Depois, e so mandar o arquivo diagnostico_bi_comercial.txt que a gente ajusta o
que precisar de uma vez so.
"""

from __future__ import annotations

import argparse
import os
import sys
import traceback
from datetime import datetime

import bi_comum as bi
from consultas_comercial import CONSULTAS, conferir, selecionar

log = bi.configurar_log("diagnostico_bi_comercial.log")

RELATORIO = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), "diagnostico_bi_comercial.txt")
AMOSTRA_STREAMING = 500  # quantas linhas ler das consultas gigantes no modo rapido

_linhas_relatorio: list[str] = []


def escrever(texto: str = "") -> None:
    print(texto)
    _linhas_relatorio.append(texto)


def salvar_relatorio() -> None:
    with open(RELATORIO, "w", encoding="utf-8") as arq:
        arq.write("\n".join(_linhas_relatorio) + "\n")
    log.info("Relatorio salvo em: %s", RELATORIO)


def _formatar(n) -> str:
    return "-" if n is None else f"{n:,}".replace(",", ".")


def _resumir_valor(valor, limite: int = 38) -> str:
    if valor is None:
        return "NULL"
    texto = str(valor)
    return texto if len(texto) <= limite else texto[: limite - 1] + "…"


# ---------------------------------------------------------------------------
# Checagens
# ---------------------------------------------------------------------------

def checar_env() -> bool:
    escrever("1) CONFIGURACAO (arquivo ENV)")
    escrever("-" * 72)
    obrigatorias = ("ORACLE_HOST", "ORACLE_SERVICE_NAME", "ORACLE_USER", "ORACLE_PASSWORD",
                    "SUPABASE_DB_HOST", "SUPABASE_DB_USER", "SUPABASE_DB_PASSWORD")
    tudo_ok = True
    for chave in obrigatorias:
        valor = os.environ.get(chave)
        if not valor:
            escrever(f"   FALTANDO  {chave}")
            tudo_ok = False
        elif "PASSWORD" in chave:
            escrever(f"   ok        {chave} (definida, {len(valor)} caracteres)")
        else:
            escrever(f"   ok        {chave} = {valor}")
    escrever()
    return tudo_ok


def checar_colunas(conn_pg, consultas) -> None:
    """Confere se as colunas declaradas no catalogo existem mesmo no Supabase."""
    escrever("3) CONFERENCIA DE COLUNAS (catalogo x banco)")
    escrever("-" * 72)
    with conn_pg.cursor() as cur:
        cur.execute("""
            SELECT table_schema || '.' || table_name, array_agg(column_name::text)
              FROM information_schema.columns
             WHERE table_schema IN ('core','comercial')
             GROUP BY 1
        """)
        no_banco = {tabela: set(colunas) for tabela, colunas in cur.fetchall()}

    for consulta in consultas:
        existentes = no_banco.get(consulta.destino)
        if existentes is None:
            escrever(f"   FALTA A TABELA  {consulta.destino}  (consulta {consulta.nome})")
            continue
        faltando = [c for c in consulta.colunas if c not in existentes]
        if faltando:
            escrever(f"   PROBLEMA  {consulta.destino}: colunas inexistentes -> {', '.join(faltando)}")
        else:
            escrever(f"   ok        {consulta.destino} ({len(consulta.colunas)} colunas)")
    escrever()


def testar_consulta(conn_ora, consulta, completo: bool) -> dict:
    """Roda o SQL e mede — sem gravar nada."""
    relogio = bi.cronometro()
    resultado = {"nome": consulta.nome, "status": "OK", "linhas": 0, "erro": None,
                 "segundos": 0.0, "amostra": None, "parcial": False}
    try:
        with conn_ora.cursor() as cur:
            cur.arraysize = 5000
            cur.execute(consulta.sql, consulta.binds or {})
            nomes = [d[0].lower() for d in cur.description]
            resultado["colunas_oracle"] = nomes

            total = 0
            primeira = None
            limite = None if (completo or not consulta.streaming) else AMOSTRA_STREAMING
            while True:
                lote = cur.fetchmany(5000)
                if not lote:
                    break
                if primeira is None:
                    primeira = dict(zip(nomes, lote[0]))
                total += len(lote)
                if limite and total >= limite:
                    resultado["parcial"] = True
                    break
            resultado["linhas"] = total
            resultado["amostra"] = primeira

        # Testa tambem a conversao linha-do-Oracle -> linha-do-Postgres.
        if resultado["amostra"] is not None:
            convertida = consulta.mapear(resultado["amostra"])
            if len(convertida) != len(consulta.colunas):
                resultado["status"] = "ERRO"
                resultado["erro"] = (f"O mapeamento devolveu {len(convertida)} valores, "
                                     f"mas a tabela espera {len(consulta.colunas)} colunas.")
    except Exception as exc:  # noqa: BLE001
        resultado["status"] = "ERRO"
        resultado["erro"] = f"{type(exc).__name__}: {exc}"
        resultado["traceback"] = traceback.format_exc(limit=3)
    resultado["segundos"] = relogio()
    return resultado


def _fmt_valor(v) -> str:
    if v is None:
        return "-"
    return f"{v:,.2f}".replace(",", "_").replace(".", ",").replace("_", ".")


def conferir_valores(conn_ora) -> None:
    """Soma no Oracle os mesmos numeros lidos do Power BI e mostra lado a lado.

    Contar linhas nao prova nada sobre valor: e aqui que se ve se a
    reconstrucao chega no mesmo dinheiro que a tela antiga."""
    escrever("5) CONFERENCIA DE VALORES CONTRA O POWER BI")
    escrever("-" * 72)
    try:
        linhas = conferir(conn_ora)
    except Exception as exc:  # noqa: BLE001
        escrever(f"   FALHOU: {type(exc).__name__}: {exc}")
        escrever(traceback.format_exc(limit=3))
        escrever()
        return

    escrever(f"   {'':52s} {'OBTIDO':>16s} {'POWER BI':>16s} {'DIF':>10s}")
    for rotulo, obtido, esperado, obs in linhas:
        if obtido is None and esperado is None:
            escrever()
            escrever(f"   {rotulo}")
            continue
        if esperado:
            dif = (obtido - esperado) / esperado * 100 if esperado else 0
            marca_dif = f"{dif:+.2f}%"
        else:
            marca_dif = "-"
        escrever(f"   {rotulo:52s} {_fmt_valor(obtido):>16s} {_fmt_valor(esperado):>16s} {marca_dif:>10s}"
                 + (f"   {obs}" if obs else ""))
    escrever()
    escrever("   Diferenca de ate 0,01% e arredondamento. Acima disso, investigue ANTES")
    escrever("   de carregar — menos onde a observacao diz que a diferenca e esperada.")
    escrever()


# ---------------------------------------------------------------------------

def main() -> int:
    p = argparse.ArgumentParser(description="Testa as consultas do BI COMERCIAL sem gravar nada.")
    p.add_argument("--completo", action="store_true",
                   help="Conta a margem por item inteira (~3,3 mi de linhas). Demora bem mais.")
    p.add_argument("--consulta", nargs="+", metavar="NOME", help="Testa apenas estas consultas.")
    args = p.parse_args()

    bi.carregar_env()
    consultas = selecionar("todas", args.consulta)

    escrever("=" * 72)
    escrever("DIAGNOSTICO DO BI COMERCIAL — modo somente leitura (nada e gravado)")
    escrever(f"Gerado em {datetime.now().strftime('%d/%m/%Y %H:%M:%S')}")
    escrever(f"Python {sys.version.split()[0]}")
    escrever("=" * 72)
    escrever()

    if not checar_env():
        escrever("Sem as variaveis obrigatorias nao da para continuar.")
        escrever("Confira se o arquivo ENV esta na pasta do script ou na pasta acima.")
        salvar_relatorio()
        return 1

    try:
        cfg_ora = bi.OracleConfig.from_env()
        cfg_pg = bi.SupabaseConfig.from_env()
    except SystemExit as exc:
        escrever(f"Configuracao invalida: {exc}")
        salvar_relatorio()
        return 1

    escrever("2) CONEXOES")
    escrever("-" * 72)
    resultados = []
    try:
        with bi.conectar_oracle(cfg_ora) as conn_ora:
            escrever(f"   ok        Oracle {cfg_ora.host}:{cfg_ora.port}/{cfg_ora.service_name}")
            try:
                with bi.conectar_supabase(cfg_pg) as conn_pg:
                    escrever(f"   ok        Supabase {cfg_pg.host}")
                    escrever()
                    checar_colunas(conn_pg, consultas)
            except Exception as exc:  # noqa: BLE001
                escrever(f"   FALHOU    Supabase: {type(exc).__name__}: {exc}")
                escrever()

            escrever("4) CONSULTAS NO ORACLE")
            escrever("-" * 72)
            escrever(f"   {'CONSULTA':26s} {'STATUS':7s} {'LINHAS':>12s} {'ESPERADO':>12s} {'TEMPO':>8s}")
            for consulta in consultas:
                r = testar_consulta(conn_ora, consulta, args.completo)
                resultados.append((consulta, r))
                marca = "amostra" if r["parcial"] else ""
                escrever(f"   {consulta.nome:26s} {r['status']:7s} {_formatar(r['linhas']):>12s} "
                         f"{_formatar(consulta.linhas_esperadas):>12s} {r['segundos']:7.1f}s {marca}")
            escrever()
            if not args.consulta:
                conferir_valores(conn_ora)
    except Exception as exc:  # noqa: BLE001
        escrever(f"   FALHOU    Oracle: {type(exc).__name__}: {exc}")
        escrever()
        escrever(traceback.format_exc(limit=3))
        salvar_relatorio()
        return 1

    # ---- detalhes ----
    escrever("6) DETALHE POR CONSULTA")
    escrever("-" * 72)
    for consulta, r in resultados:
        escrever()
        escrever(f"### {consulta.nome}  ({consulta.pagina})")
        escrever(f"    {consulta.descricao}")
        escrever(f"    destino: {consulta.destino}")
        if r["status"] == "ERRO":
            escrever(f"    ERRO: {r['erro']}")
            if r.get("traceback"):
                for linha in r["traceback"].splitlines():
                    escrever(f"      {linha}")
            continue
        escrever(f"    linhas: {_formatar(r['linhas'])}"
                 + ("  (so a amostra inicial — rode com --completo para contar tudo)" if r["parcial"] else ""))
        if consulta.linhas_esperadas and not r["parcial"]:
            aviso = bi.avaliar_contagem(consulta, r["linhas"])
            dif = r["linhas"] - consulta.linhas_esperadas
            situacao = f"DIVERGENTE do Power BI ({dif:+d})" if aviso else f"bate com o Power BI ({dif:+d})"
            escrever(f"    esperado no Power BI: {_formatar(consulta.linhas_esperadas)} — {situacao}")
        if r["amostra"]:
            escrever("    primeira linha:")
            for chave, valor in r["amostra"].items():
                escrever(f"      {chave:24s} = {_resumir_valor(valor)}")

    escrever()
    escrever("=" * 72)
    falhas = [c.nome for c, r in resultados if r["status"] == "ERRO"]
    divergentes = [c.nome for c, r in resultados
                   if r["status"] == "OK" and not r["parcial"]
                   and bi.avaliar_contagem(c, r["linhas"])]
    if falhas:
        escrever(f"CONSULTAS COM ERRO ({len(falhas)}): {', '.join(falhas)}")
    if divergentes:
        escrever(f"CONSULTAS COM CONTAGEM DIFERENTE DO POWER BI ({len(divergentes)}): {', '.join(divergentes)}")
    if not falhas and not divergentes:
        escrever("Tudo certo: nenhuma consulta com erro e todas as contagens batem com o Power BI.")
        escrever("Pode rodar o sync_bi_comercial.py para carregar de verdade.")
    else:
        escrever("Mande este arquivo (diagnostico_bi_comercial.txt) para ajustarmos o que falta.")
    escrever("=" * 72)

    salvar_relatorio()
    return 1 if falhas else 0


if __name__ == "__main__":
    try:
        codigo = main()
    except Exception:
        log.exception("Erro inesperado no diagnostico.")
        escrever("ERRO INESPERADO:")
        escrever(traceback.format_exc())
        salvar_relatorio()
        codigo = 1
    sys.exit(codigo)
