#!/usr/bin/env python3
"""
bi_comum.py — infraestrutura compartilhada dos ETLs de BI da Lube.

Aqui mora tudo que NAO muda de uma consulta para outra: leitura do arquivo
ENV, conexao com o Oracle/WinThor, conexao com o Supabase, logging e as
rotinas genericas de carga (full refresh normal e full refresh em lotes,
para tabelas grandes).

Cada BI/consulta so precisa declarar: o SQL, a tabela de destino, as colunas
e como transformar uma linha do Oracle numa linha do Postgres. Ver
consultas_compras.py.

Nao roda sozinho — e importado pelos scripts sync_*.py e diagnostico_*.py.
"""

from __future__ import annotations

import hashlib
import logging
import os
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterator, Sequence

import oracledb
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

log = logging.getLogger("bi")

# Schema onde fica o controle_carga do sistema que estiver usando este modulo.
# Cada BI tem o seu (compras.controle_carga, comercial.controle_carga...), e o
# orquestrador avisa qual e o dele logo no comeco, com definir_schema().
# O padrao continua sendo "compras" para nao mudar nada no BI que ja roda.
SCHEMA_CONTROLE = "compras"


def definir_schema(nome: str) -> None:
    """Diz em qual schema fica o controle_carga deste sistema."""
    global SCHEMA_CONTROLE
    SCHEMA_CONTROLE = nome


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def configurar_log(nome_arquivo: str) -> logging.Logger:
    """Liga o log num arquivo ao lado do script e, quando houver tela, nela tambem.

    Detalhe importante para o agendamento: a tarefa do Windows roda o script com
    o `pythonw.exe`, que e a versao do Python sem janela de console — e assim o
    ETL nao fica abrindo prompt na cara de quem estiver usando a maquina. So que
    no pythonw o `sys.stdout` e o `sys.stderr` sao None, e qualquer `print` ou
    handler de tela quebraria com AttributeError. Por isso, aqui: se nao houver
    saida de tela, apontamos as duas para o vazio e o log vai so para o arquivo.
    """
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")

    caminho = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), nome_arquivo)

    # Quando um programa importa outro (o servidor_margem importa o
    # agente_margem, e os dois chamam esta funcao), o logging ja esta de pe na
    # segunda chamada e o basicConfig nao faz nada. So que o FileHandler do
    # argumento E criado antes de ser descartado — e deixa para tras um arquivo
    # de log VAZIO, com o nome certo e nada dentro. Quem for procurar o que
    # aconteceu abre esse, ve o vazio e conclui que o programa nem rodou.
    # Entao: se ja esta configurado, nao cria arquivo nenhum; diz onde o log
    # realmente esta saindo e pronto.
    if logging.getLogger().handlers:
        atual = next((h.baseFilename for h in logging.getLogger().handlers
                      if isinstance(h, logging.FileHandler)), None)
        if atual and os.path.abspath(atual) != os.path.abspath(caminho):
            log.info("Log deste processo continua em: %s", atual)
        return log

    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[
            logging.StreamHandler(sys.stdout),
            logging.FileHandler(caminho, encoding="utf-8"),
        ],
    )
    log.info("Log tambem sendo salvo em: %s", caminho)
    return log


# ---------------------------------------------------------------------------
# Configuracao
# ---------------------------------------------------------------------------

def carregar_env() -> None:
    """Procura ENV/.env/env na pasta do script e depois na pasta acima
    (a raiz compartilhada "INTEGRAÇÃO BI"). A ideia e ter um unico arquivo
    com as credenciais, valendo para todos os BIs."""
    pasta_do_script = os.path.dirname(os.path.abspath(sys.argv[0]))
    pasta_compartilhada = os.path.dirname(pasta_do_script)
    # Na pasta de rede, arrumada em subpastas por assunto, o ENV mora em
    # "1 - CONFIGURACAO" — que e IRMA da pasta do script, nao pai dela. Sem
    # este terceiro lugar, rodar qualquer coisa direto da rede falha dizendo
    # que falta SUPABASE_DB_HOST, o que nao ajuda ninguem a entender o que
    # houve. Na maquina instalada tudo fica junto e o primeiro lugar resolve.
    pasta_de_configuracao = os.path.join(pasta_compartilhada, "1 - CONFIGURACAO")
    for pasta in (pasta_do_script, pasta_compartilhada, pasta_de_configuracao):
        for candidato in ("ENV", ".env", "env"):
            caminho = os.path.join(pasta, candidato)
            if os.path.isfile(caminho):
                load_dotenv(caminho)
                log.info("Variaveis de configuracao carregadas de %s", caminho)
                return
    log.warning(
        "Nenhum arquivo ENV/.env encontrado (procurei em %s, %s e %s) — usando "
        "apenas variaveis de ambiente ja definidas no sistema.",
        pasta_do_script, pasta_compartilhada, pasta_de_configuracao
    )


@dataclass(frozen=True)
class OracleConfig:
    host: str
    port: int
    service_name: str
    user: str
    password: str

    @classmethod
    def from_env(cls) -> "OracleConfig":
        try:
            return cls(
                host=os.environ["ORACLE_HOST"].strip(),
                port=int(os.environ.get("ORACLE_PORT", "1521")),
                service_name=os.environ["ORACLE_SERVICE_NAME"].strip(),
                user=os.environ["ORACLE_USER"].strip(),
                password=os.environ["ORACLE_PASSWORD"],
            )
        except KeyError as exc:
            raise SystemExit(f"Variavel de ambiente obrigatoria ausente: {exc}. Veja ENV.example.") from exc


@dataclass(frozen=True)
class SupabaseConfig:
    host: str
    port: int
    dbname: str
    user: str
    password: str

    @classmethod
    def from_env(cls) -> "SupabaseConfig":
        try:
            return cls(
                host=os.environ["SUPABASE_DB_HOST"].strip(),
                port=int(os.environ.get("SUPABASE_DB_PORT", "5432")),
                dbname=os.environ.get("SUPABASE_DB_NAME", "postgres").strip(),
                user=os.environ["SUPABASE_DB_USER"].strip(),
                password=os.environ["SUPABASE_DB_PASSWORD"].strip(),
            )
        except KeyError as exc:
            raise SystemExit(f"Variavel de ambiente obrigatoria ausente: {exc}. Veja ENV.example.") from exc


# ---------------------------------------------------------------------------
# Conexoes
# ---------------------------------------------------------------------------

@contextmanager
def conectar_oracle(cfg: OracleConfig):
    log.info("Conectando no Oracle %s:%s/%s como %s", cfg.host, cfg.port, cfg.service_name, cfg.user)
    dsn = oracledb.makedsn(cfg.host, cfg.port, service_name=cfg.service_name)
    conn = oracledb.connect(user=cfg.user, password=cfg.password, dsn=dsn)
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def conectar_supabase(cfg: SupabaseConfig):
    """Abre a conexao com o Supabase com timeout e keepalive.

    Sem isso, uma conexao que "morre" no meio do caminho (o pooler do
    Supabase derruba ela silenciosamente, sem mandar FIN/RST) deixa o
    psycopg2 esperando resposta para sempre — foi o que travou a carga na
    VM por mais de 5 minutos sem nenhum erro aparecer. keepalives faz o
    sistema operacional notar a conexao morta em ~30-40s; statement_timeout
    evita que uma consulta trave o processo indefinidamente do lado do
    banco; connect_timeout cobre a fase inicial de conexao.
    """
    log.info("Conectando no Supabase %s:%s/%s como %s", cfg.host, cfg.port, cfg.dbname, cfg.user)
    conn = psycopg2.connect(
        host=cfg.host, port=cfg.port, dbname=cfg.dbname,
        user=cfg.user, password=cfg.password, sslmode="require",
        connect_timeout=20,
        keepalives=1, keepalives_idle=20, keepalives_interval=10, keepalives_count=3,
        options="-c statement_timeout=120000",
    )
    try:
        yield conn
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Tranca: uma carga de cada vez, na empresa inteira
# ---------------------------------------------------------------------------

@contextmanager
def tranca_de_carga(conn_pg, grupo: str):
    """Garante que so uma carga deste grupo rode por vez, em qualquer maquina.

    POR QUE ISTO EXISTE

    Em 08/10/2026 descobrimos que DUAS maquinas tinham as mesmas tarefas
    agendadas (a VM e a estacao de quem instalou). As duas truncavam e inseriam
    nas mesmas tabelas no mesmo minuto; uma ganhava e a outra morria esperando o
    lock, aos exatos 120 segundos do statement_timeout. A carga da margem (3,3
    milhoes de linhas) falhou na primeira tentativa todas as noites por uma
    semana, e em dois dias nao foi atualizada.

    Apagar a tarefa duplicada resolveu aquele caso. Esta tranca resolve a
    classe: nao importa quantas maquinas tenham a tarefa, quem chegar depois
    descobre na hora que ja tem carga rodando, avisa e sai sem estragar nada.

    E um advisory lock do proprio Postgres: morre junto com a sessao, entao uma
    maquina que trave ou perca a rede nao deixa a tranca presa para sempre.
    """
    # Um numero por grupo, estavel: o mesmo texto sempre da a mesma chave.
    chave = _chave_da_tranca("carga:" + SCHEMA_CONTROLE + ":" + grupo)
    with conn_pg.cursor() as cur:
        cur.execute("SELECT pg_try_advisory_lock(%s)", (chave,))
        peguei = cur.fetchone()[0]
    conn_pg.rollback()

    if not peguei:
        raise CargaJaRodando(
            f"Ja existe uma carga do grupo '{grupo}' rodando (possivelmente em "
            f"outra maquina). Esta rodada vai ser pulada — e o certo: duas "
            f"cargas ao mesmo tempo disputam as mesmas tabelas e uma morre no "
            f"meio. Se isto se repetir, confira se mais de uma maquina tem a "
            f"tarefa agendada."
        )
    try:
        yield
    finally:
        try:
            with conn_pg.cursor() as cur:
                cur.execute("SELECT pg_advisory_unlock(%s)", (chave,))
            conn_pg.rollback()
        except Exception:
            pass  # a sessao fechando ja solta o lock


class CargaJaRodando(RuntimeError):
    """Outra maquina esta com a carga deste grupo na mao."""


def _chave_da_tranca(texto: str) -> int:
    """Texto -> inteiro de 64 bits, que e o que o advisory lock aceita."""
    digest = hashlib.sha1(texto.encode("utf-8")).digest()[:8]
    return int.from_bytes(digest, "big", signed=True)


# ---------------------------------------------------------------------------
# Declaracao de uma consulta
# ---------------------------------------------------------------------------

@dataclass
class Consulta:
    """Tudo que o orquestrador precisa saber sobre uma consulta do BI."""

    nome: str
    descricao: str
    pagina: str                       # pagina do Power BI que essa consulta alimenta
    sql: str
    destino: str                      # schema.tabela
    colunas: Sequence[str]            # colunas do destino, na ordem
    mapear: Callable[[dict[str, Any]], tuple]   # linha do Oracle -> tupla do Postgres
    linhas_esperadas: int | None = None         # referencia do Power BI, para validar
    grupo: str = "rapidas"                      # "rapidas" | "pesadas"
    streaming: bool = False                     # True para tabelas muito grandes
    binds: dict[str, Any] = field(default_factory=dict)
    pos_carga: Callable[[Any], None] | None = None   # SQL extra depois da carga
    # Quanto a contagem pode variar em relacao a linhas_esperadas antes de
    # virar aviso. Consultas cujo filtro depende do ESTOQUE DE HOJE (as de
    # sugestao e excesso) oscilam sozinhas de um dia para o outro, entao usam
    # uma margem maior — senao o alerta dispara toda hora sem motivo.
    tolerancia_pct: float = 0.02
    # Se preenchido, a carga vira upsert (INSERT ... ON CONFLICT) em vez de
    # TRUNCATE + INSERT. Usado nas DIMENSOES: um comprador que ficou sem
    # produtos nesta rodada nao deve sumir do cadastro (e nem quebrar as
    # chaves estrangeiras dos fatos que ainda apontam para ele).
    chave_conflito: Sequence[str] | None = None


# ---------------------------------------------------------------------------
# Extracao e carga
# ---------------------------------------------------------------------------

def extrair(conn_ora, consulta: Consulta) -> list[dict[str, Any]]:
    """Roda o SQL no Oracle e devolve tudo de uma vez (para consultas pequenas)."""
    with conn_ora.cursor() as cur:
        cur.arraysize = 5000
        cur.execute(consulta.sql, consulta.binds or {})
        nomes = [d[0].lower() for d in cur.description]
        linhas = [dict(zip(nomes, linha)) for linha in cur.fetchall()]
    return linhas


def _lotes(conn_ora, consulta: Consulta, tamanho: int) -> Iterator[list[dict[str, Any]]]:
    """Le o resultado do Oracle em lotes, sem carregar tudo na memoria."""
    with conn_ora.cursor() as cur:
        cur.arraysize = 5000
        cur.execute(consulta.sql, consulta.binds or {})
        nomes = [d[0].lower() for d in cur.description]
        while True:
            bruto = cur.fetchmany(tamanho)
            if not bruto:
                break
            yield [dict(zip(nomes, linha)) for linha in bruto]


def _sql_insercao(consulta: Consulta) -> str:
    colunas = ", ".join(consulta.colunas)
    sql = f"INSERT INTO {consulta.destino} ({colunas}) VALUES %s"
    if consulta.chave_conflito:
        chaves = set(consulta.chave_conflito)
        atualizar = [c for c in consulta.colunas if c not in chaves]
        sets = ", ".join(f"{c} = EXCLUDED.{c}" for c in atualizar)
        sql += f" ON CONFLICT ({', '.join(consulta.chave_conflito)}) DO UPDATE SET {sets}"
    return sql


def carregar(conn_pg, consulta: Consulta, linhas: list[dict[str, Any]]) -> int:
    """Grava o resultado no Supabase, numa transacao so.

    Fatos: full refresh (TRUNCATE + INSERT). Dimensoes (as que declaram
    chave_conflito): upsert, para nao apagar cadastro historico.

    Se der erro no meio, o rollback devolve a tabela ao estado anterior — nunca
    fica meio carregada."""
    dados = [consulta.mapear(linha) for linha in linhas]
    with conn_pg.cursor() as cur:
        if not consulta.chave_conflito:
            cur.execute(f"TRUNCATE TABLE {consulta.destino}")
        if dados:
            psycopg2.extras.execute_values(cur, _sql_insercao(consulta), dados, page_size=2000)
        if consulta.pos_carga:
            consulta.pos_carga(cur)
    return len(dados)


def carregar_em_lotes(conn_ora, conn_pg, consulta: Consulta, tamanho: int = 50000) -> int:
    """Mesma coisa, mas lendo do Oracle e gravando no Postgres aos poucos.

    Usado na Consulta10 (faturamento), que tem ~1,6 milhao de linhas e nao
    cabe confortavelmente na memoria de uma vez."""
    sql_insercao = _sql_insercao(consulta)
    total = 0
    with conn_pg.cursor() as cur:
        if not consulta.chave_conflito:
            cur.execute(f"TRUNCATE TABLE {consulta.destino}")
        for lote in _lotes(conn_ora, consulta, tamanho):
            dados = [consulta.mapear(linha) for linha in lote]
            psycopg2.extras.execute_values(cur, sql_insercao, dados, page_size=5000)
            total += len(dados)
            log.info("    ... %s linhas gravadas ate agora", f"{total:,}".replace(",", "."))
        if consulta.pos_carga:
            consulta.pos_carga(cur)
    return total


def avaliar_contagem(consulta: Consulta, linhas: int) -> str | None:
    """Compara a contagem obtida com a referencia do Power BI.

    Devolve None quando esta dentro da margem, ou a frase de aviso quando nao."""
    if not consulta.linhas_esperadas:
        return None
    diferenca = linhas - consulta.linhas_esperadas
    margem = max(50, consulta.linhas_esperadas * consulta.tolerancia_pct)
    if abs(diferenca) <= margem:
        return None
    sinal = "+" if diferenca > 0 else "-"
    esperado = f"{consulta.linhas_esperadas:,}".replace(",", ".")
    obtido = f"{linhas:,}".replace(",", ".")
    dif = f"{abs(diferenca):,}".replace(",", ".")
    return (f"ATENCAO: o Power BI tinha {esperado} linhas; vieram {obtido} "
            f"(diferenca de {sinal}{dif}).")


def registrar_execucao(conn_pg, consulta: Consulta, status: str, linhas: int | None,
                       segundos: float, mensagem: str | None = None) -> None:
    """Grava uma linha em <sistema>.controle_carga para auditoria."""
    try:
        with conn_pg.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO {SCHEMA_CONTROLE}.controle_carga
                    (consulta, tabela_destino, status, linhas, linhas_esperadas, segundos, mensagem, executado_em)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (consulta.nome, consulta.destino, status, linhas,
                 consulta.linhas_esperadas, round(segundos, 1),
                 (mensagem or "")[:2000], datetime.now(timezone.utc)),
            )
        conn_pg.commit()
    except psycopg2.Error:
        conn_pg.rollback()
        log.warning("Nao consegui gravar o controle de carga da consulta %s.", consulta.nome)


# ---------------------------------------------------------------------------
# Helpers de conversao
# ---------------------------------------------------------------------------

def num(valor: Any, padrao: Any = None) -> Any:
    """None -> padrao. Serve para reproduzir o 'substituir null por 0' que o
    Power Query fazia em varias colunas."""
    return padrao if valor is None else valor


def texto(valor: Any) -> str | None:
    """Tira espacos das pontas; string vazia vira None."""
    if valor is None:
        return None
    limpo = str(valor).strip()
    return limpo or None


def inteiro(valor: Any) -> int | None:
    if valor is None:
        return None
    try:
        return int(valor)
    except (TypeError, ValueError):
        return None


def status_produto(valor: Any) -> str:
    """O DECODE de OBS2 no WinThor nao tem ELSE: produto cujo OBS2 nao seja
    exatamente ' ' ou 'FL' volta NULL. Ate corrigirmos a origem, tratamos
    qualquer coisa que nao seja explicitamente FORALINHA como ATIVO — mesmo
    criterio ja usado no painel de Ruptura/Cobertura."""
    return "FORALINHA" if (valor or "").strip().upper() == "FORALINHA" else "ATIVO"


def cronometro() -> Callable[[], float]:
    inicio = time.monotonic()
    return lambda: time.monotonic() - inicio
