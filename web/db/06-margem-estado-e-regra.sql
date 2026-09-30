-- ===========================================================================
-- BI COMERCIAL — estado da margem, a regra de quem fecha, e o painel de uso
--
-- TRÊS COISAS ENTRAM AQUI
--
-- 1. O ESTADO VEM DO WINTHOR, não do nosso registro.
--    `comercial.fato_margem_filial` é a foto de PCPRODFILIAL.PERCMARGEMMIN,
--    carregada pelo ETL junto com o resto. Se alguém abrir um produto por fora
--    do sistema — no próprio WinThor, ou por um .bat antigo — a tela mostra
--    aberto do mesmo jeito. O contrário (a tela achar que está aberto porque
--    registramos um pedido) seria mentira na hora que mais importa.
--
-- 2. QUEM ABRIU É QUEM FECHA.
--    O dono de um produto aberto é quem fez a última abertura registrada. Se
--    não há registro — é o caso dos 545 produtos abertos pelos .bat antigos —
--    o produto não tem dono, e aí qualquer um fecha. Isso não é exceção à
--    regra: é a ausência de alguém a quem cobrar.
--
-- 3. O PAINEL DE USO: quantas aberturas, quem abre, quais filiais, e o que
--    está aberto agora.
--
-- Cópia versionada da migração `comercial_margem_estado`.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- A foto do WinThor (carregada pelo ETL, consulta `margem_filial`)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comercial.fato_margem_filial (
    codfilial      smallint NOT NULL,
    codprod        integer  NOT NULL,
    percmargemmin  numeric,
    data_carga     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_margem_filial_aberto
    ON comercial.fato_margem_filial (codfilial, codprod) WHERE percmargemmin IS NULL;
CREATE INDEX IF NOT EXISTS ix_margem_filial_prod
    ON comercial.fato_margem_filial (codprod, codfilial);
ALTER TABLE comercial.fato_margem_filial ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE comercial.fato_margem_filial IS
    'Foto de PCPRODFILIAL.PERCMARGEMMIN das filiais atendidas. É daqui que sai '
    '"o que está aberto agora" — a verdade é o WinThor, não o nosso histórico.';

-- ---------------------------------------------------------------------------
-- Quem é o dono de cada produto aberto
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW comercial.margem_estado AS
WITH ultima AS (
    SELECT DISTINCT ON (a.codfilial, a.codprod)
           a.codfilial, a.codprod, a.aplicado_em,
           s.id AS solicitacao_id, s.solicitante, s.motivo, s.acao
      FROM comercial.margem_alteracao a
      JOIN comercial.margem_solicitacao s ON s.id = a.solicitacao_id
     WHERE s.status = 'concluida'
     ORDER BY a.codfilial, a.codprod, a.aplicado_em DESC, a.id DESC
)
SELECT f.codfilial,
       f.codprod,
       u.solicitante      AS aberto_por,
       u.aplicado_em      AS aberto_em,
       u.motivo           AS aberto_motivo,
       u.solicitacao_id,
       (u.solicitante IS NULL) AS sem_dono
  FROM comercial.fato_margem_filial f
  /* só atribui dono se a ÚLTIMA coisa registrada naquele produto foi uma
     abertura; se foi um fechamento e ele está aberto, alguém mexeu por fora */
  LEFT JOIN ultima u ON u.codfilial = f.codfilial
                    AND u.codprod  = f.codprod
                    AND u.acao     = 'abrir'
 WHERE f.percmargemmin IS NULL;

COMMENT ON VIEW comercial.margem_estado IS
    'Produtos com a margem aberta agora, e de quem é a responsabilidade. '
    'sem_dono = aberto antes do sistema ou por fora dele.';

-- ---------------------------------------------------------------------------
-- A regra: quem abriu é quem fecha
-- ---------------------------------------------------------------------------
-- Devolve os produtos que a pessoa NÃO pode fechar, e de quem eles são.
CREATE OR REPLACE FUNCTION comercial.margem_bloqueios(
    p_solicitante text, p_filiais smallint[], p_produtos integer[])
RETURNS json
LANGUAGE sql
STABLE
AS $fn$
    SELECT coalesce(json_agg(json_build_array(codfilial, codprod, aberto_por)
                             ORDER BY codfilial, codprod), '[]'::json)
      FROM comercial.margem_estado
     WHERE codfilial = ANY (p_filiais)
       AND codprod  = ANY (p_produtos)
       AND aberto_por IS NOT NULL
       AND lower(btrim(aberto_por)) <> lower(btrim(coalesce(p_solicitante, '')));
$fn$;

COMMENT ON FUNCTION comercial.margem_bloqueios(text, smallint[], integer[]) IS
    'Produtos que este solicitante não pode fechar, porque quem abriu foi outra '
    'pessoa. Produto sem dono (aberto antes do sistema) não entra na lista.';

-- ---------------------------------------------------------------------------
-- Registrar um pedido, agora com a regra dentro
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION comercial.margem_registrar(
    p_solicitante text,
    p_motivo      text,
    p_acao        text,
    p_filiais     smallint[],
    p_produtos    integer[],
    p_margem      numeric DEFAULT NULL,
    p_origem      text    DEFAULT NULL)
RETURNS json
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_id        bigint;
    v_nome      text := btrim(coalesce(p_solicitante, ''));
    v_motivo    text := btrim(coalesce(p_motivo, ''));
    v_bloqueios json;
BEGIN
    IF length(v_nome) < 3 THEN
        RETURN json_build_object('erro', 'Diga quem está pedindo (nome com pelo menos 3 letras).');
    END IF;
    IF length(v_motivo) < 10 THEN
        RETURN json_build_object('erro', 'Escreva o motivo com pelo menos 10 letras — é o que fica no histórico.');
    END IF;
    IF p_acao NOT IN ('abrir', 'fechar') THEN
        RETURN json_build_object('erro', 'Ação inválida.');
    END IF;
    IF p_filiais IS NULL OR array_length(p_filiais, 1) IS NULL THEN
        RETURN json_build_object('erro', 'Escolha pelo menos uma filial.');
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_filiais) f WHERE f NOT IN (1, 7, 11, 12)) THEN
        RETURN json_build_object('erro', 'Filial fora das atendidas (1, 7, 11 e 12).');
    END IF;
    IF p_produtos IS NULL OR array_length(p_produtos, 1) IS NULL THEN
        RETURN json_build_object('erro', 'Informe pelo menos um código de produto.');
    END IF;
    IF array_length(p_produtos, 1) > 500 THEN
        RETURN json_build_object('erro', 'São no máximo 500 produtos por pedido.');
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_produtos) c WHERE c <= 0) THEN
        RETURN json_build_object('erro', 'Há código de produto inválido na lista.');
    END IF;
    IF p_acao = 'fechar' AND (p_margem IS NULL OR p_margem < 0 OR p_margem > 100) THEN
        RETURN json_build_object('erro', 'A margem a aplicar precisa estar entre 0 e 100.');
    END IF;

    /* quem abriu é quem fecha — sem exceção */
    IF p_acao = 'fechar' THEN
        v_bloqueios := comercial.margem_bloqueios(v_nome, p_filiais, p_produtos);
        IF json_array_length(v_bloqueios) > 0 THEN
            RETURN json_build_object(
                'erro', 'Há produto aberto por outra pessoa. Quem abriu é quem fecha.',
                'bloqueios', v_bloqueios);
        END IF;
    END IF;

    INSERT INTO comercial.margem_solicitacao
           (solicitante, motivo, acao, filiais, produtos, margem, origem)
    VALUES (v_nome, v_motivo, p_acao, p_filiais, p_produtos,
            CASE WHEN p_acao = 'fechar' THEN p_margem END, p_origem)
    RETURNING id INTO v_id;

    RETURN json_build_object('id', v_id, 'status', 'pendente',
                             'produtos', array_length(p_produtos, 1),
                             'filiais', array_length(p_filiais, 1));
END;
$fn$;

-- ---------------------------------------------------------------------------
-- O painel de uso
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION comercial.margem_painel(p_dias integer DEFAULT 90)
RETURNS json
LANGUAGE sql
STABLE
AS $fn$
WITH periodo AS (
    SELECT (current_date - least(greatest(coalesce(p_dias, 90), 1), 730))::date AS desde
),
pedidos AS (
    SELECT s.*, cardinality(s.produtos) AS qtd_produtos
      FROM comercial.margem_solicitacao s, periodo p
     WHERE s.criado_em >= p.desde AND s.status = 'concluida'
)
SELECT json_build_object(
  'gerado_em', now(),
  'dias', (SELECT current_date - desde FROM periodo),
  'carga', (SELECT max(data_carga) FROM comercial.fato_margem_filial),

  /* o que está aberto AGORA, direto da foto do WinThor */
  'abertos_por_filial', (
    SELECT coalesce(json_agg(json_build_array(codfilial, abertos, sem_dono) ORDER BY codfilial), '[]'::json)
      FROM (SELECT codfilial, count(*) AS abertos,
                   count(*) FILTER (WHERE sem_dono) AS sem_dono
              FROM comercial.margem_estado GROUP BY codfilial) x),
  'abertos_total', (SELECT count(*) FROM comercial.margem_estado),
  'abertos_sem_dono', (SELECT count(*) FROM comercial.margem_estado WHERE sem_dono),

  /* quem tem produto aberto na mão agora */
  'responsaveis', (
    SELECT coalesce(json_agg(json_build_array(quem, abertos, mais_antigo) ORDER BY abertos DESC), '[]'::json)
      FROM (SELECT coalesce(aberto_por, '(aberto antes do sistema)') AS quem,
                   count(*) AS abertos, min(aberto_em) AS mais_antigo
              FROM comercial.margem_estado GROUP BY 1) x),

  /* uso no período: quantas vezes abriu e fechou, por pessoa */
  'por_pessoa', (
    SELECT coalesce(json_agg(json_build_array(solicitante, aberturas, fechamentos,
                                              prod_abertos, prod_fechados) ORDER BY aberturas DESC), '[]'::json)
      FROM (SELECT solicitante,
                   count(*) FILTER (WHERE acao = 'abrir')  AS aberturas,
                   count(*) FILTER (WHERE acao = 'fechar') AS fechamentos,
                   coalesce(sum(qtd_produtos) FILTER (WHERE acao = 'abrir'), 0)  AS prod_abertos,
                   coalesce(sum(qtd_produtos) FILTER (WHERE acao = 'fechar'), 0) AS prod_fechados
              FROM pedidos GROUP BY solicitante) x),

  /* uso no período, por filial */
  'por_filial', (
    SELECT coalesce(json_agg(json_build_array(filial, aberturas, fechamentos) ORDER BY aberturas DESC), '[]'::json)
      FROM (SELECT f AS filial,
                   count(*) FILTER (WHERE acao = 'abrir')  AS aberturas,
                   count(*) FILTER (WHERE acao = 'fechar') AS fechamentos
              FROM pedidos, unnest(filiais) f GROUP BY f) x),

  /* série por dia */
  'serie', (
    SELECT coalesce(json_agg(json_build_array(dia, aberturas, fechamentos) ORDER BY dia), '[]'::json)
      FROM (SELECT criado_em::date AS dia,
                   count(*) FILTER (WHERE acao = 'abrir')  AS aberturas,
                   count(*) FILTER (WHERE acao = 'fechar') AS fechamentos
              FROM pedidos GROUP BY 1) x),

  'total_aberturas',   (SELECT count(*) FROM pedidos WHERE acao = 'abrir'),
  'total_fechamentos', (SELECT count(*) FROM pedidos WHERE acao = 'fechar')
);
$fn$;

COMMENT ON FUNCTION comercial.margem_painel(integer) IS
    'Números do uso da abertura de margem: o que está aberto agora, de quem é, '
    'quantas aberturas por pessoa e por filial, e a série por dia.';

-- Lista do que está aberto, para a tela (com um teto, porque pode crescer).
CREATE OR REPLACE FUNCTION comercial.margem_abertos(p_limite integer DEFAULT 3000)
RETURNS json
LANGUAGE sql
STABLE
AS $fn$
    SELECT coalesce(json_agg(json_build_array(
             e.codfilial, e.codprod, p.descricao, e.aberto_por, e.aberto_em, e.aberto_motivo)
           ORDER BY e.aberto_em DESC NULLS LAST, e.codfilial, e.codprod), '[]'::json)
      FROM (SELECT * FROM comercial.margem_estado
             ORDER BY aberto_em DESC NULLS LAST
             LIMIT least(greatest(coalesce(p_limite, 3000), 1), 20000)) e
      LEFT JOIN core.dim_produto p ON p.codprod = e.codprod;
$fn$;
