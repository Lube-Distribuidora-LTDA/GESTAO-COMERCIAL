-- ===========================================================================
-- BI COMERCIAL — o painel para de ler o banco ao abrir
--
-- POR QUE
-- O DATA WAREHOUSE ficou lento: em 14/10 contar ate um milhao levava 42 s
-- (o normal e 0,1 s) e em 19/10 passava de 120 s. A painel_dados, que levava
-- 0,2 s em 29/09, passou a levar 100 s — e a Vercel corta em 60, entao o
-- painel respondia 504 e nao abria para ninguem.
--
-- Nenhuma consulta esta mal escrita: todas leem de memoria, zero disco. Medido
-- no EXPLAIN: uma busca de UMA linha por indice, com a pagina ja em cache,
-- levava 18,6 ms (o normal e 0,01 ms), e so o PLANEJAMENTO da consulta, que
-- nem toca no disco, levava 574 ms. Tudo lento pelo mesmo fator: e a maquina
-- do banco que nao da conta, nao o SQL.
--
-- O MESMO REMEDIO DAS REPOSICOES
-- O ETL guarda o JSON pronto aqui depois de cada carga; o painel so le a linha
-- pronta. Foi isso que fez o painel de reposicoes responder em 0,18 s no dia
-- em que o banco saturou (07/10).
--
-- Medido aqui: 100 s no pior caso -> 8 ms lendo o pronto.
--
-- A DIFERENCA PARA AS REPOSICOES: o comercial tem periodo. O cache e por
-- (de, ate) — o ETL aquece o mes corrente e o anterior, que sao os que quase
-- todo mundo abre; um periodo incomum e calculado na primeira vez e fica
-- guardado para as proximas.
--
-- Cópia versionada das migrações `comercial_painel_cache` e
-- `comercial_painel_servir_limpa`.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS comercial.painel_cache (
    de        date NOT NULL,
    ate       date NOT NULL,
    gerado_em timestamptz NOT NULL DEFAULT now(),
    carga     timestamptz,          -- ultima carga OK quando este JSON foi feito
    bytes     integer,
    payload   text NOT NULL,
    PRIMARY KEY (de, ate)
);
ALTER TABLE comercial.painel_cache ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE comercial.painel_cache IS
    'JSON pronto do painel, por periodo. O painel le daqui e nao chama a painel_dados: '
    'com o banco lento, calcular na hora estourava os 60 s da Vercel (504).';


-- ---------------------------------------------------------------------------
-- O periodo, resolvido do mesmo jeito que a painel_dados resolve
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION comercial._periodo(p_de date, p_ate date)
RETURNS date[]
LANGUAGE sql
IMMUTABLE
AS $fn$
    SELECT ARRAY[
        coalesce(p_de, date_trunc('month', coalesce(p_ate, current_date))::date),
        coalesce(p_ate, current_date)
    ];
$fn$;


-- ---------------------------------------------------------------------------
-- Guardar: calcula e grava. E o que o ETL chama depois de cada carga.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION comercial.painel_cache_guardar(
    p_de date DEFAULT NULL, p_ate date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_p     date[] := comercial._periodo(p_de, p_ate);
    v_json  text;
    v_carga timestamptz;
BEGIN
    v_json := comercial.painel_dados(v_p[1], v_p[2])::text;
    SELECT max(executado_em) INTO v_carga
      FROM comercial.controle_carga WHERE status = 'OK';

    INSERT INTO comercial.painel_cache (de, ate, gerado_em, carga, bytes, payload)
    VALUES (v_p[1], v_p[2], now(), v_carga, length(v_json), v_json)
    ON CONFLICT (de, ate) DO UPDATE
       SET gerado_em = EXCLUDED.gerado_em,
           carga     = EXCLUDED.carga,
           bytes     = EXCLUDED.bytes,
           payload   = EXCLUDED.payload;

    RETURN length(v_json);
END;
$fn$;


-- ---------------------------------------------------------------------------
-- Servir: e so isto que a /api/dados chama.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION comercial.painel_servir(
    p_de date DEFAULT NULL, p_ate date DEFAULT NULL)
RETURNS json
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_p    date[] := comercial._periodo(p_de, p_ate);
    v_json text;
BEGIN
    SELECT payload INTO v_json FROM comercial.painel_cache
     WHERE de = v_p[1] AND ate = v_p[2];

    -- Tem linha? Devolve, mesmo que uma carga tenha entrado depois dela.
    -- Servir dado de algumas horas atras e melhor do que nao abrir: a tela
    -- mostra a data da ultima carga, entao ninguem e enganado. O ETL reaquece
    -- a cada carga; se parar de aquecer, quem avisa e o Guardiao.
    IF v_json IS NOT NULL THEN
        RETURN v_json::json;
    END IF;

    -- Periodo que ninguem pediu ainda: calcula uma vez e guarda. Esta e a
    -- unica chamada que ainda pode demorar — e so na primeira vez.
    PERFORM comercial.painel_cache_guardar(v_p[1], v_p[2]);

    SELECT payload INTO v_json FROM comercial.painel_cache
     WHERE de = v_p[1] AND ate = v_p[2];
    RETURN v_json::json;
END;
$fn$;

COMMENT ON FUNCTION comercial.painel_servir(date, date) IS
    'O que a /api/dados chama. Le o JSON pronto; so calcula quando o periodo '
    'nunca foi pedido. Nunca deixa o painel sem resposta por lentidao do banco.';
