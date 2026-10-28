-- ===========================================================================
-- O cache do painel passa a saber COM QUE REGRA foi feito
--
-- O cache servia a linha guardada mesmo depois de uma carga nova: dado de
-- algumas horas, com a data da carga a vista, e melhor do que o painel nao
-- abrir. Isso continua certo.
--
-- Mas em 2026-10-28, ao corrigir as faixas de comissao, ficou claro que
-- "desatualizado" tem dois significados muito diferentes:
--
--   dado velho  -> aceitavel. A tela mostra a data da ultima carga.
--   REGRA velha -> inaceitavel. A tela mostra a comissao errada e nao tem
--                  como quem olha perceber.
--
-- Naquele dia, 11 dos 14 periodos guardados ficaram com a escada antiga
-- (piso de 1,0% em vez de 3,0%). Quem abrisse um deles veria comissao errada
-- em silencio.
--
-- Agora cada linha guarda a ASSINATURA das regras com que foi feita. Mudou a
-- regra, a assinatura muda, e a linha deixa de valer: o painel refaz.
--
-- ARMADILHA, caida e registrada: a primeira tentativa marcou como validas as
-- linhas "geradas nos ultimos 30 minutos". Tres delas eram anteriores a troca
-- das faixas por poucos minutos e foram marcadas por engano. Tempo nao prova
-- nada; o que prova e o conteudo. A limpeza certa compara as faixas DENTRO do
-- JSON com as da tabela.
--
-- Copia versionada da migracao `comercial_painel_cache_assina_as_regras`.
-- ===========================================================================

ALTER TABLE comercial.painel_cache ADD COLUMN IF NOT EXISTS regras text;

COMMENT ON COLUMN comercial.painel_cache.regras IS
    'Assinatura das regras de calculo com que este JSON foi feito (hoje, as '
    'faixas de comissao). Se a assinatura de agora for outra, a linha nao vale '
    'e o painel refaz — dado velho pode ser servido, regra velha nao.';

CREATE OR REPLACE FUNCTION comercial._regras_comissao()
RETURNS text
LANGUAGE sql
STABLE
AS $fn$
    SELECT coalesce(string_agg(
             vigencia_desde::text || ':' || perc_min::text || '-' ||
             coalesce(perc_max::text, '~') || '=' || perc_comissao::text,
             '|' ORDER BY vigencia_desde, perc_min), 'sem-faixas')
      FROM comercial.dim_faixa_comissao;
$fn$;

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

    INSERT INTO comercial.painel_cache (de, ate, gerado_em, carga, bytes, payload, regras)
    VALUES (v_p[1], v_p[2], now(), v_carga, length(v_json), v_json,
            comercial._regras_comissao())
    ON CONFLICT (de, ate) DO UPDATE
       SET gerado_em = EXCLUDED.gerado_em, carga = EXCLUDED.carga,
           bytes = EXCLUDED.bytes, payload = EXCLUDED.payload,
           regras = EXCLUDED.regras;

    RETURN length(v_json);
END;
$fn$;

CREATE OR REPLACE FUNCTION comercial.painel_servir(
    p_de date DEFAULT NULL, p_ate date DEFAULT NULL)
RETURNS json
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_p      date[] := comercial._periodo(p_de, p_ate);
    v_json   text;
    v_regras text;
    v_agora  text := comercial._regras_comissao();
BEGIN
    SELECT payload, regras INTO v_json, v_regras
      FROM comercial.painel_cache WHERE de = v_p[1] AND ate = v_p[2];

    -- Serve o guardado so se ele tiver sido feito com as regras de agora.
    IF v_json IS NOT NULL AND v_regras IS NOT DISTINCT FROM v_agora THEN
        RETURN v_json::json;
    END IF;

    PERFORM comercial.painel_cache_guardar(v_p[1], v_p[2]);

    SELECT payload INTO v_json FROM comercial.painel_cache
     WHERE de = v_p[1] AND ate = v_p[2];
    RETURN v_json::json;
END;
$fn$;
