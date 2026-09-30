#!/usr/bin/env python3
"""
servidor_margem.py — o sistema de abrir e fechar a margem das filiais.

E um programa pequeno que roda numa maquina da rede e serve uma pagina. Quem
esta no comercial abre http://<maquina>:8080 no navegador, escolhe filial e
produtos, escreve o nome e o motivo, e pronto: a mudanca vai para o WinThor na
hora e fica registrada no banco do BI.

POR QUE UM PROGRAMA, E NAO UM index.html NA PASTA DA REDE

Um arquivo HTML aberto do disco nao consegue executar um .bat nem falar com o
Oracle — o navegador impede, e ainda bem: se conseguisse, qualquer pagina da
internet tambem conseguiria. Entao a pagina existe, mas quem executa e este
programa, que roda numa maquina so.

O QUE ELE FAZ, DE PONTA A PONTA

  navegador  --POST-->  este programa  --UPDATE-->  Oracle (WinThor)
                              |
                              +--------------------> Supabase: quem, quando,
                                                     por que, e o valor que o
                                                     produto tinha antes

Os .bat sao dispensados de proposito. Chama-los de volta traria a senha do
WinThor escrita dentro do arquivo e perderia o registro — que e justamente o
que faltava.

A REGRA: QUEM ABRIU E QUEM FECHA

Quem abriu um produto e o unico que pode fechar aquele produto. Sem excecao.
O bloqueio mora no banco (comercial.margem_registrar), nao nesta tela: tela e
conveniencia, regra e regra.

Produto que ja estava aberto ANTES deste sistema nao tem dono — os .bat nao
registravam ninguem — entao qualquer um fecha. Isso nao e uma excecao a regra;
e a ausencia de alguem a quem cobrar. A tela diz isso com todas as letras.

COMO SUBIR

    python servidor_margem.py                 (escuta em 0.0.0.0:8080)
    python servidor_margem.py --porta 8090
    python servidor_margem.py --host 127.0.0.1    (so esta maquina)

Precisa das mesmas variaveis de ambiente do ETL, mais ORACLE_USER_ESCRITA e
ORACLE_PASSWORD_ESCRITA — o usuario do ETL e de leitura e continua sendo.

Opcional: MARGEM_PESSOAS="Ana Paula;Carlos Eduardo;Marcia" transforma o campo
do nome numa lista fechada. Sem isso o nome e digitado livremente, e ai a regra
de quem fecha vale pelo que a pessoa escreveu. Com a lista, vale de verdade.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import threading
from datetime import date, datetime
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import psycopg2.extras

import agente_margem as agente
import bi_comum as bi

log = bi.configurar_log("servidor_margem.log")

PASTA = os.path.dirname(os.path.abspath(__file__))
PAGINA = os.path.join(PASTA, "painel_margem.html")
MAXIMO_CORPO = 512 * 1024      # um pedido de 500 produtos cabe folgado aqui


def pessoas_permitidas() -> list[str]:
    bruto = os.environ.get("MARGEM_PESSOAS", "").replace(";", ",")
    return [p.strip() for p in bruto.split(",") if p.strip()]


# ---------------------------------------------------------------------------
# Conexao com o Supabase: uma so, reaberta quando cai
# ---------------------------------------------------------------------------

_trava = threading.Lock()
_contexto = None   # o "with" do bi.conectar_supabase, mantido aberto
_conn = None


def _fechar() -> None:
    global _contexto, _conn
    if _contexto is not None:
        try:
            _contexto.__exit__(None, None, None)
        except Exception:
            pass
    _contexto = None
    _conn = None


def pg():
    """Devolve uma conexao viva com o Supabase.

    O servidor fica ligado o dia inteiro e a rede da empresa nao e perfeita;
    entao, em vez de confiar que a conexao sobreviveu, cada uso confere e
    reabre se precisar.

    bi.conectar_supabase e um gerenciador de contexto (ele fecha a conexao ao
    sair do "with"). Como aqui a conexao precisa durar o dia inteiro, o
    contexto e aberto na mao e guardado — e so fecha quando a conexao cai."""
    global _contexto, _conn
    with _trava:
        if _conn is not None:
            try:
                with _conn.cursor() as c:
                    c.execute("SELECT 1")
                _conn.rollback()
                return _conn
            except Exception:
                log.warning("A conexao com o Supabase caiu; reabrindo.")
                _fechar()
        _contexto = bi.conectar_supabase(bi.SupabaseConfig.from_env())
        _conn = _contexto.__enter__()
        log.info("Conexao com o Supabase aberta.")
        return _conn


def um_valor(sql: str, binds: tuple = ()):
    conn = pg()
    with conn.cursor() as cur:
        cur.execute(sql, binds)
        valor = cur.fetchone()[0]
    conn.rollback()
    return valor


def json_seguro(obj):
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, Decimal):
        return float(obj)
    return str(obj)


# ---------------------------------------------------------------------------
# O que a tela precisa saber
# ---------------------------------------------------------------------------

def estado(dias: int) -> dict:
    return {
        "painel": um_valor("SELECT comercial.margem_painel(%s)", (dias,)),
        "abertos": um_valor("SELECT comercial.margem_abertos(3000)"),
        "historico": um_valor("SELECT comercial.margem_historico(60)"),
        "pessoas": pessoas_permitidas(),
        "maquina": socket.gethostname(),
        "agora": datetime.now().isoformat(timespec="seconds"),
    }


def conferir(corpo: dict) -> dict:
    """Diz, produto a produto, o que vai acontecer — ANTES de acontecer.

    E aqui que a regra de quem fecha aparece cedo: em vez de a pessoa montar um
    pedido de 200 codigos e levar um "nao" no final, a tela ja mostra quais sao
    de outra pessoa."""
    filiais = [int(f) for f in corpo.get("filiais") or []]
    produtos = [int(p) for p in corpo.get("produtos") or []]
    quem = (corpo.get("solicitante") or "").strip()
    if not filiais or not produtos:
        return {"itens": [], "faltando": [], "resumo": {}}

    conn = pg()
    with conn.cursor() as cur:
        cur.execute("""
            SELECT f.codfilial, f.codprod, p.descricao,
                   (f.percmargemmin IS NULL)      AS aberto,
                   f.percmargemmin                AS piso,
                   e.aberto_por, e.aberto_em, e.sem_dono
              FROM comercial.fato_margem_filial f
              LEFT JOIN core.dim_produto p ON p.codprod = f.codprod
              LEFT JOIN comercial.margem_estado e
                     ON e.codfilial = f.codfilial AND e.codprod = f.codprod
             WHERE f.codfilial = ANY(%s) AND f.codprod = ANY(%s)
             ORDER BY f.codfilial, f.codprod
        """, (filiais, produtos))
        achados = cur.fetchall()
    conn.rollback()

    encontrados = {(a[0], a[1]) for a in achados}
    itens = []
    for f, c, desc, aberto, piso, dono, quando, sem_dono in achados:
        bloqueado = bool(aberto and dono and dono.strip().lower() != quem.lower())
        itens.append({
            "filial": f, "codprod": c, "descricao": desc,
            "aberto": aberto, "piso": None if piso is None else float(piso),
            "dono": dono, "desde": quando.isoformat() if quando else None,
            "sem_dono": bool(aberto and sem_dono),
            "bloqueado": bloqueado,
        })

    faltando = [[f, c] for f in filiais for c in produtos if (f, c) not in encontrados]
    return {
        "itens": itens,
        "faltando": faltando[:200],
        "resumo": {
            "total": len(itens),
            "abertos": sum(1 for i in itens if i["aberto"]),
            "fechados": sum(1 for i in itens if not i["aberto"]),
            "bloqueados": sum(1 for i in itens if i["bloqueado"]),
            "sem_dono": sum(1 for i in itens if i["sem_dono"]),
            "nao_cadastrados": len(faltando),
        },
    }


def executar(corpo: dict, de_onde: str) -> tuple[dict, int]:
    """Registra o pedido (com a regra) e ja executa no WinThor."""
    quem = (corpo.get("solicitante") or "").strip()
    permitidas = pessoas_permitidas()
    if permitidas and quem.lower() not in {p.lower() for p in permitidas}:
        return {"erro": "Escolha seu nome na lista."}, 400

    filiais = [int(f) for f in corpo.get("filiais") or []]
    produtos = [int(p) for p in corpo.get("produtos") or []]

    conn = pg()
    with conn.cursor() as cur:
        cur.execute(
            "SELECT comercial.margem_registrar(%s,%s,%s,%s::smallint[],%s::integer[],%s,%s)",
            (quem, corpo.get("motivo"), corpo.get("acao"), filiais, produtos,
             corpo.get("margem") if corpo.get("acao") == "fechar" else None, de_onde))
        resposta = cur.fetchone()[0]
    conn.commit()

    if resposta.get("erro"):
        log.warning("Pedido recusado (%s): %s", quem, resposta["erro"])
        return resposta, 400

    pedido_id = resposta["id"]
    log.info("Pedido #%s de %s (%s, %d produto(s), filiais %s) via %s",
             pedido_id, quem, corpo.get("acao"), len(produtos), filiais, de_onde)

    # Aqui nao ha fila de espera: este programa esta DENTRO da rede, alcanca o
    # Oracle, e executa na hora. A tabela da fila continua sendo o registro.
    agente.processar_fila(conn, limite=5)

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""SELECT id, status, mensagem, linhas_afetadas, concluido_em
                         FROM comercial.margem_solicitacao WHERE id = %s""", (pedido_id,))
        final = cur.fetchone()
    conn.rollback()

    resultado = dict(final)
    return resultado, (200 if resultado["status"] == "concluida" else 500)


# ---------------------------------------------------------------------------
# O servidor
# ---------------------------------------------------------------------------

class Manipulador(BaseHTTPRequestHandler):
    server_version = "MargemLube"
    sys_version = ""

    def log_message(self, formato, *args):       # noqa: A003
        log.info("%s %s", self.client_address[0], formato % args)

    # -- respostas -----------------------------------------------------------
    def _enviar(self, corpo: bytes, tipo: str, codigo: int = 200) -> None:
        self.send_response(codigo)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(corpo)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(corpo)

    def _json(self, dados, codigo: int = 200) -> None:
        self._enviar(json.dumps(dados, default=json_seguro, ensure_ascii=False).encode("utf-8"),
                     "application/json; charset=utf-8", codigo)

    def _erro(self, mensagem: str, codigo: int) -> None:
        self._json({"erro": mensagem}, codigo)

    def _corpo(self) -> dict:
        tamanho = int(self.headers.get("Content-Length") or 0)
        if tamanho > MAXIMO_CORPO:
            raise ValueError("pedido grande demais")
        return json.loads(self.rfile.read(tamanho).decode("utf-8") or "{}")

    # -- rotas ---------------------------------------------------------------
    def do_GET(self):                            # noqa: N802
        caminho = urlparse(self.path).path
        try:
            if caminho in ("/", "/index.html"):
                with open(PAGINA, "rb") as arq:
                    return self._enviar(arq.read(), "text/html; charset=utf-8")
            if caminho == "/api/estado":
                q = parse_qs(urlparse(self.path).query)
                dias = int((q.get("dias") or ["90"])[0])
                return self._json(estado(dias))
            if caminho == "/api/saude":
                return self._json({"ok": True, "maquina": socket.gethostname()})
            return self._erro("Pagina nao encontrada.", 404)
        except FileNotFoundError:
            log.error("Falta o arquivo da pagina: %s", PAGINA)
            return self._erro("Falta o painel_margem.html ao lado do servidor.", 500)
        except Exception as exc:                 # noqa: BLE001
            log.exception("Falha no GET %s", caminho)
            return self._erro(f"{type(exc).__name__}: {exc}"[:400], 500)

    def do_POST(self):                           # noqa: N802
        caminho = urlparse(self.path).path
        try:
            corpo = self._corpo()
            if caminho == "/api/conferir":
                return self._json(conferir(corpo))
            if caminho == "/api/executar":
                de_onde = "servidor local - " + self.client_address[0]
                dados, codigo = executar(corpo, de_onde)
                return self._json(dados, codigo)
            return self._erro("Pagina nao encontrada.", 404)
        except ValueError as exc:
            return self._erro(str(exc), 400)
        except Exception as exc:                 # noqa: BLE001
            log.exception("Falha no POST %s", caminho)
            return self._erro(f"{type(exc).__name__}: {exc}"[:400], 500)


def endereco_na_rede(porta: int) -> str:
    """O endereco que o pessoal vai digitar. Descobre o IP olhando por onde a
    maquina sai para a rede — o nome do host nem sempre resolve para todo mundo."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("192.168.0.5", 1521))
        ip = s.getsockname()[0]
        s.close()
    except Exception:
        ip = socket.gethostbyname(socket.gethostname())
    return "http://" + ip + ":" + str(porta)


def main() -> int:
    p = argparse.ArgumentParser(description="Servidor da abertura de margem das filiais.")
    p.add_argument("--host", default=os.environ.get("MARGEM_HOST", "0.0.0.0"))
    p.add_argument("--porta", type=int, default=int(os.environ.get("MARGEM_PORTA", "8080")))
    args = p.parse_args()

    bi.carregar_env()
    bi.definir_schema("comercial")

    pg()  # falha agora, e nao na cara de quem abrir a pagina
    pessoas = pessoas_permitidas()

    servidor = ThreadingHTTPServer((args.host, args.porta), Manipulador)
    endereco = endereco_na_rede(args.porta)
    log.info("=" * 64)
    log.info("Servidor da margem no ar em %s", endereco)
    log.info("Nomes: %s", ", ".join(pessoas) if pessoas else "campo livre (defina MARGEM_PESSOAS)")
    print("\n  Abertura de margem no ar:  " + endereco)
    print("  (esta janela precisa ficar aberta; Ctrl+C para parar)\n")
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        log.info("Servidor parado pelo teclado.")
    finally:
        servidor.server_close()
        _fechar()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        log.exception("Erro inesperado no servidor da margem.")
        sys.exit(1)
