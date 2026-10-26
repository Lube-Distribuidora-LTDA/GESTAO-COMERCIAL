-- ===========================================================================
-- BI COMERCIAL — o painel ao vivo (AGENTE LUBE)
--
-- POR QUE
-- O Julio quer o painel mudando sozinho e o botao Atualizar lendo o WinThor na
-- hora (2026-10-26). Quem le o WinThor e o AGENTE LUBE, na SRV-IA, de segundos em
-- segundos (fluxos "comercial.*" em agente.fluxo); este arquivo e o lado do banco:
--
--   1. Depois de gravar, o agente roda comercial.atualizar_ao_vivo() (agente.sistema.
--      apos_gravar, no maximo de 15 em 15 s): refaz o JSON pronto do painel
--      (painel_cache) do mes corrente e dos periodos que alguem esta olhando. A tela
--      continua lendo so a linha pronta, entao abre na hora mesmo com o banco lento.
--   2. A tela pergunta comercial.painel_versao(de, ate) de 15 em 15 s: quando o JSON
--      do periodo dela mudou, baixa de novo, sem recarregar a pagina. A pergunta
--      tambem marca o periodo como "em uso" (usado_em), e e isso que diz ao passo 1
--      o que refazer.
--   3. O resumo da margem e os graficos por mes leem das views materializadas, que
--      varrem a fato_margem_item inteira (3,3 milhoes de linhas). Essas ficam de 15 em
--      15 min (decisao do Julio): comercial.atualizar_views_ao_vivo(), pelo pg_cron, e
--      so quando o agente gravou alguma coisa depois da ultima vez. CONCURRENTLY: quem
--      le a view nao espera. Com 64 MB de memoria, a mv_margem_dia sai em ~5 s sem
--      espalhar em disco (com os 5 MB padrao: 8,5 s e 220 MB em disco).
--
-- Copia versionada das migracoes `comercial_agente_chaves` e `comercial_ao_vivo`.
-- ===========================================================================

-- comercial_agente_chaves: o modo chave do agente grava so a linha que mudou e precisa
-- saber qual linha e qual. As duas fotos (carteira e piso de margem) ja sao unicas por
-- construcao (PCPEDC por NUMPED; PCPRODFILIAL por filial e produto); a carga antiga
-- (TRUNCATE + INSERT) continua igual.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pedido_aberto_numped ON comercial.fato_pedido_aberto (numped);
CREATE UNIQUE INDEX IF NOT EXISTS ux_margem_filial ON comercial.fato_margem_filial (codfilial, codprod);

-- "Hoje" e o de Brasilia: o banco roda em UTC, e das 21h a meia-noite o current_date
-- ja e amanha (era assim que o painel pedia o mes errado depois das 21h).
CREATE OR REPLACE FUNCTION comercial._hoje()
RETURNS date LANGUAGE sql STABLE AS $fn$
    SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date;
$fn$;

-- Mesma regra de antes, com o hoje de Brasilia (e STABLE: depende da data).
CREATE OR REPLACE FUNCTION comercial._periodo(p_de date, p_ate date)
RETURNS date[] LANGUAGE sql STABLE AS $fn$
    SELECT ARRAY[
        coalesce(p_de, date_trunc('month', coalesce(p_ate, comercial._hoje()))::date),
        coalesce(p_ate, comercial._hoje())
    ];
$fn$;

ALTER TABLE comercial.painel_cache ADD COLUMN IF NOT EXISTS usado_em timestamptz;
COMMENT ON COLUMN comercial.painel_cache.usado_em IS
    'Ultima vez que uma tela pediu este periodo (painel_servir ou painel_versao). O agente refaz os periodos em uso.';


-- ---------------------------------------------------------------------------
-- 1. O que o agente roda depois de gravar
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION comercial.atualizar_ao_vivo()
RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE
    v_hoje date := comercial._hoje();
    v_m0   date := date_trunc('month', comercial._hoje())::date;
    v_n    integer := 1;
    r      record;
BEGIN
    -- o mes corrente sempre (e o que a tela abre)
    PERFORM comercial.painel_cache_guardar(v_m0, v_hoje);
    -- e ate 6 periodos que alguem olhou na ultima meia hora. Todos, mesmo os antigos:
    -- os pedidos em aberto e os cadastros vao em qualquer periodo.
    FOR r IN SELECT de, ate FROM comercial.painel_cache
              WHERE usado_em > now() - interval '30 minutes'
                AND NOT (de = v_m0 AND ate = v_hoje)
              ORDER BY usado_em DESC
              LIMIT 6
    LOOP
        PERFORM comercial.painel_cache_guardar(r.de, r.ate);
        v_n := v_n + 1;
    END LOOP;
    RETURN v_n;
END;
$fn$;
COMMENT ON FUNCTION comercial.atualizar_ao_vivo() IS
    'Refaz o JSON pronto do painel (mes corrente + periodos em uso). Quem chama: o AGENTE LUBE depois de gravar '
    '(agente.sistema.apos_gravar) e o comercial.atualizar_views_ao_vivo(). ~0,2 s por periodo.';


-- ---------------------------------------------------------------------------
-- 2. A versao que a tela pergunta, e servir marcando "em uso"
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION comercial.painel_versao(p_de date DEFAULT NULL, p_ate date DEFAULT NULL)
RETURNS json LANGUAGE plpgsql AS $fn$
DECLARE
    v_p date[] := comercial._periodo(p_de, p_ate);
    v_g timestamptz;
BEGIN
    -- marca o uso no maximo de 2 em 2 min (a tela pergunta de 15 em 15 s)
    UPDATE comercial.painel_cache SET usado_em = now()
     WHERE de = v_p[1] AND ate = v_p[2]
       AND (usado_em IS NULL OR usado_em < now() - interval '2 minutes');
    SELECT gerado_em INTO v_g FROM comercial.painel_cache WHERE de = v_p[1] AND ate = v_p[2];
    RETURN json_build_object('de', v_p[1], 'ate', v_p[2], 'gerado_em', v_g);
END;
$fn$;
COMMENT ON FUNCTION comercial.painel_versao(date, date) IS
    'O que a /api/versao chama de 15 em 15 s: quando o JSON pronto do periodo foi feito. Marca o periodo em uso.';

CREATE OR REPLACE FUNCTION comercial.painel_servir(
    p_de date DEFAULT NULL, p_ate date DEFAULT NULL)
RETURNS json
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_p    date[] := comercial._periodo(p_de, p_ate);
    v_json text;
BEGIN
    UPDATE comercial.painel_cache SET usado_em = now()
     WHERE de = v_p[1] AND ate = v_p[2]
       AND (usado_em IS NULL OR usado_em < now() - interval '2 minutes');

    SELECT payload INTO v_json FROM comercial.painel_cache
     WHERE de = v_p[1] AND ate = v_p[2];

    -- Tem linha? Devolve, mesmo que uma carga tenha entrado depois dela.
    -- Servir dado de algumas horas atras e melhor do que nao abrir: a tela
    -- mostra a hora do dado, entao ninguem e enganado. O agente refaz os
    -- periodos em uso; se parar, quem avisa e o Guardiao.
    IF v_json IS NOT NULL THEN
        RETURN v_json::json;
    END IF;

    -- Periodo que ninguem pediu ainda: calcula uma vez e guarda. Esta e a
    -- unica chamada que ainda pode demorar — e so na primeira vez.
    PERFORM comercial.painel_cache_guardar(v_p[1], v_p[2]);
    UPDATE comercial.painel_cache SET usado_em = now() WHERE de = v_p[1] AND ate = v_p[2];

    SELECT payload INTO v_json FROM comercial.painel_cache
     WHERE de = v_p[1] AND ate = v_p[2];
    RETURN v_json::json;
END;
$fn$;


-- ---------------------------------------------------------------------------
-- 3. As views materializadas de 15 em 15 min
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comercial.views_ao_vivo (
    view           text PRIMARY KEY,
    atualizado_em  timestamptz,      -- comeco do ultimo REFRESH que deu certo
    ms             integer,
    erro           text,
    erro_em        timestamptz
);
ALTER TABLE comercial.views_ao_vivo ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE comercial.views_ao_vivo IS
    'Ultimo REFRESH de cada view do painel feito por comercial.atualizar_views_ao_vivo() (pg_cron, 15 em 15 min).';

CREATE OR REPLACE FUNCTION comercial.atualizar_views_ao_vivo(p_forcar boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql AS $fn$
DECLARE
    v_mudou  timestamptz;
    v_ultima timestamptz;
    v_view   text;
    v_t0     timestamptz;
    v_ok     integer := 0;
    v_erros  integer := 0;
BEGIN
    SELECT mudou_em INTO v_mudou FROM agente.sistema WHERE sistema = 'comercial';
    SELECT min(atualizado_em) INTO v_ultima FROM comercial.views_ao_vivo;
    IF NOT p_forcar AND (v_mudou IS NULL OR (v_ultima IS NOT NULL AND v_mudou <= v_ultima)) THEN
        RETURN 'nada mudou desde a ultima vez';
    END IF;

    PERFORM set_config('work_mem', '64MB', true);
    PERFORM set_config('max_parallel_workers_per_gather', '0', true);
    -- a carga antiga faz REFRESH sem CONCURRENTLY (trava a view): nao fica na fila dela
    PERFORM set_config('lock_timeout', '5s', true);

    -- a ordem importa: a mv_comissao_mes le da mv_comissao_rca_mes
    FOREACH v_view IN ARRAY ARRAY['mv_comissao_rca_mes', 'mv_comissao_mes', 'mv_devolucao_rca_mes',
                                  'mv_margem_dia', 'mv_margem_mes']
    LOOP
        v_t0 := clock_timestamp();
        BEGIN
            EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY comercial.%I', v_view);
            INSERT INTO comercial.views_ao_vivo (view, atualizado_em, ms, erro, erro_em)
            VALUES (v_view, v_t0, (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::integer, NULL, NULL)
            ON CONFLICT (view) DO UPDATE SET atualizado_em = EXCLUDED.atualizado_em, ms = EXCLUDED.ms,
                                             erro = NULL, erro_em = NULL;
            v_ok := v_ok + 1;
        EXCEPTION WHEN OTHERS THEN
            INSERT INTO comercial.views_ao_vivo (view, erro, erro_em) VALUES (v_view, SQLERRM, now())
            ON CONFLICT (view) DO UPDATE SET erro = EXCLUDED.erro, erro_em = EXCLUDED.erro_em;
            v_erros := v_erros + 1;
        END;
    END LOOP;

    PERFORM comercial.atualizar_ao_vivo();
    RETURN format('%s view(s) atualizada(s), %s com erro', v_ok, v_erros);
END;
$fn$;
COMMENT ON FUNCTION comercial.atualizar_views_ao_vivo(boolean) IS
    'REFRESH CONCURRENTLY das views do painel e o JSON pronto de novo, so se o agente gravou algo depois da '
    'ultima vez. pg_cron de 15 em 15 min (comercial-views-ao-vivo). ~12 s quando roda.';

revoke all on function comercial.atualizar_ao_vivo() from public;
revoke all on function comercial.atualizar_views_ao_vivo(boolean) from public;
revoke all on function comercial.painel_versao(date, date) from public;

SELECT cron.schedule('comercial-views-ao-vivo', '*/15 * * * *', 'select comercial.atualizar_views_ao_vivo()');

-- O agente: o que rodar depois de gravar no schema comercial
insert into agente.sistema (sistema, versao, apos_gravar, apos_gravar_s)
values ('comercial', '', 'select comercial.atualizar_ao_vivo()', 15)
on conflict (sistema) do update set apos_gravar = excluded.apos_gravar, apos_gravar_s = excluded.apos_gravar_s;
