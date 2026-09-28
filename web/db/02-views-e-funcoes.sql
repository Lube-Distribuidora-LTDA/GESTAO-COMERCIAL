-- ===========================================================================
-- BI COMERCIAL — agregados e funções do painel
--
-- Cópia versionada da migração `comercial_views_e_painel`. A fonte de verdade
-- é o banco (projeto DATA WAREHOUSE, ivcnotrynogaljrvvyes).
--
-- O painel não consulta tabela: ele chama `comercial.painel_dados(de, ate)`,
-- que devolve TODO o conteúdo da tela num JSON só, e
-- `comercial.painel_detalhe(...)` para as listas grandes (notas de um RCA,
-- itens abaixo da margem além dos primeiros). A função serverless é
-- encanamento.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- A regra de comissão, num lugar só
-- ---------------------------------------------------------------------------
-- Recebe a margem líquida EM PORCENTAGEM (20.75, não 0.2075) e devolve a
-- comissão em FRAÇÃO (0.025), pronta para multiplicar pelo total líquido.
-- Margem nula (total líquido zero) cai na primeira faixa, igual ao DAX, em
-- que `BLANK() < 0.20` é verdadeiro.
CREATE OR REPLACE FUNCTION comercial.comissao_percentual(p_perc numeric, p_ref date DEFAULT NULL)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
    SELECT f.perc_comissao / 100.0
      FROM comercial.dim_faixa_comissao f
     WHERE f.vigencia_desde = (
             SELECT max(vigencia_desde) FROM comercial.dim_faixa_comissao
              WHERE vigencia_desde <= coalesce(p_ref, current_date))
       AND coalesce(p_perc, -999999) >= f.perc_min
       AND (f.perc_max IS NULL OR coalesce(p_perc, -999999) < f.perc_max)
     LIMIT 1
$$;

-- ---------------------------------------------------------------------------
-- Agregados mensais (atualizados pelo ETL, na mesma execução da carga)
-- ---------------------------------------------------------------------------

-- Margem por item: 3,3 milhões de linhas. Varrer tudo a cada acesso custaria
-- segundos; a série histórica sai daqui, e só o período escolhido é lido da
-- tabela crua (que tem índice por data).
DROP MATERIALIZED VIEW IF EXISTS comercial.mv_margem_mes;
CREATE MATERIALIZED VIEW comercial.mv_margem_mes AS
SELECT date_trunc('month', dtmov)::date          AS mes,
       codfilial,
       count(*) FILTER (WHERE codoper = 'S')     AS itens,
       count(*) FILTER (WHERE codoper = 'S' AND margem_perc <  5)  AS itens_abaixo_5,
       count(*) FILTER (WHERE codoper = 'S' AND margem_perc < 10)  AS itens_abaixo_10,
       count(*) FILTER (WHERE codoper = 'S' AND margem_perc < 20)  AS itens_abaixo_20,
       round(coalesce(sum(venda), 0), 2)          AS venda,
       round(coalesce(sum(cmv_venda), 0), 2)      AS cmv,
       round(coalesce(sum(margem_valor), 0), 2)   AS margem_valor,
       round(coalesce(sum(vl_devolucao), 0), 2)   AS devolucao,
       round(coalesce(sum(vl_bonificacao), 0), 2) AS bonificacao
  FROM comercial.fato_margem_item
 GROUP BY 1, 2;
CREATE UNIQUE INDEX ix_mv_margem_mes ON comercial.mv_margem_mes (mes, codfilial);

-- Comissão por RCA e mês — o grão recomendado para pagamento: a faixa é
-- aplicada UMA vez, sobre a margem do mês inteiro do vendedor.
DROP MATERIALIZED VIEW IF EXISTS comercial.mv_comissao_rca_mes;
CREATE MATERIALIZED VIEW comercial.mv_comissao_rca_mes AS
WITH base AS (
    SELECT date_trunc('month', dtmov)::date AS mes,
           codusur,
           count(*)                         AS notas,
           count(DISTINCT codcli)           AS clientes,
           count(DISTINCT numped)           AS pedidos,
           sum(venda)                       AS venda,
           sum(devolucao_com_st)            AS devolucao_com_st,
           sum(devolucao_sem_st)            AS devolucao_sem_st,
           sum(cmv_venda)                   AS cmv_venda,
           sum(cmv_devolucao)               AS cmv_devolucao,
           sum(cmv_bonificacao)             AS cmv_bonificacao,
           sum(desc_financeiro)             AS desc_financeiro,
           sum(st)                          AS st
      FROM comercial.fato_comissao_nf
     GROUP BY 1, 2
), calc AS (
    SELECT b.*,
           b.venda - b.devolucao_com_st AS total_liquido,
           b.venda - b.devolucao_sem_st AS total_liquido_sst,
           b.cmv_venda - b.cmv_devolucao + b.desc_financeiro + b.cmv_bonificacao - b.st AS cmv_liquido
      FROM base b
)
SELECT mes, codusur, notas, clientes, pedidos,
       round(venda, 2)              AS venda,
       round(devolucao_com_st, 2)   AS devolucao,
       round(st, 2)                 AS st,
       round(total_liquido, 2)      AS total_liquido,
       round(total_liquido_sst, 2)  AS total_liquido_sst,
       round(cmv_liquido, 2)        AS cmv_liquido,
       round(total_liquido_sst - cmv_liquido, 2) AS massa_margem,
       CASE WHEN total_liquido_sst <> 0
            THEN round((total_liquido_sst - cmv_liquido) / total_liquido_sst * 100, 4) END AS perc_liquido,
       comercial.comissao_percentual(
           CASE WHEN total_liquido_sst <> 0
                THEN (total_liquido_sst - cmv_liquido) / total_liquido_sst * 100 END, mes) AS perc_comissao,
       round(total_liquido * comercial.comissao_percentual(
           CASE WHEN total_liquido_sst <> 0
                THEN (total_liquido_sst - cmv_liquido) / total_liquido_sst * 100 END, mes), 2) AS comissao
  FROM calc;
CREATE UNIQUE INDEX ix_mv_comissao_rca_mes ON comercial.mv_comissao_rca_mes (mes, codusur);

-- Comissão da empresa por mês: serve ao gráfico de tendência. O valor da
-- comissão aqui é a SOMA das comissões dos RCAs — não a faixa aplicada sobre
-- a margem da empresa inteira, que é como o Power BI mostrava o total e é o
-- motivo de o rodapé da tela nunca bater com a soma das linhas.
DROP MATERIALIZED VIEW IF EXISTS comercial.mv_comissao_mes;
CREATE MATERIALIZED VIEW comercial.mv_comissao_mes AS
SELECT mes,
       count(*)                       AS rcas,
       sum(notas)                     AS notas,
       sum(venda)                     AS venda,
       sum(devolucao)                 AS devolucao,
       sum(st)                        AS st,
       sum(total_liquido)             AS total_liquido,
       sum(total_liquido_sst)         AS total_liquido_sst,
       sum(cmv_liquido)               AS cmv_liquido,
       sum(massa_margem)              AS massa_margem,
       CASE WHEN sum(total_liquido_sst) <> 0
            THEN round(sum(massa_margem) / sum(total_liquido_sst) * 100, 4) END AS perc_liquido,
       sum(comissao)                  AS comissao_soma_rca
  FROM comercial.mv_comissao_rca_mes
 GROUP BY mes;
CREATE UNIQUE INDEX ix_mv_comissao_mes ON comercial.mv_comissao_mes (mes);

-- Devolução por RCA e mês, já separando o que é responsabilidade do vendedor.
DROP MATERIALIZED VIEW IF EXISTS comercial.mv_devolucao_rca_mes;
CREATE MATERIALIZED VIEW comercial.mv_devolucao_rca_mes AS
SELECT date_trunc('month', d.dtmov)::date AS mes,
       d.codusur,
       count(DISTINCT d.numnota)                                                AS notas,
       round(coalesce(sum(d.valor_devolucao), 0), 2)                            AS valor,
       round(coalesce(sum(d.valor_devolucao) FILTER (WHERE m.responsabilidade_rca), 0), 2) AS valor_rca,
       round(coalesce(sum(d.vltotal_nota), 0), 2)                               AS vltotal_somado
  FROM comercial.fato_devolucao d
  LEFT JOIN comercial.dim_motivo_devolucao m ON m.coddevol = d.coddevol
 GROUP BY 1, 2;
CREATE UNIQUE INDEX ix_mv_devolucao_rca_mes ON comercial.mv_devolucao_rca_mes (mes, codusur);


-- ---------------------------------------------------------------------------
-- painel_dados(de, ate) — tudo que a tela mostra, num JSON só
-- ---------------------------------------------------------------------------
-- Os fatos vão em vetor de vetores (e não em objeto por linha) porque a
-- resposta fica ~3x menor — é o mesmo formato do painel de Compras.
CREATE OR REPLACE FUNCTION comercial.painel_dados(p_de date DEFAULT NULL, p_ate date DEFAULT NULL)
RETURNS json
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_ate  date := coalesce(p_ate, current_date);
    v_de   date := coalesce(p_de, date_trunc('month', coalesce(p_ate, current_date))::date);
    v_out  json;
BEGIN
    SELECT json_build_object(

      'gerado_em', now(),
      'periodo', json_build_object('de', v_de, 'ate', v_ate),

      -- quando cada consulta entrou pela última vez
      'carga', (
        SELECT json_build_object(
                 'ultima', max(executado_em),
                 'itens',  coalesce(json_agg(json_build_array(consulta, status, linhas, executado_em)
                                             ORDER BY consulta), '[]'::json))
          FROM (SELECT DISTINCT ON (consulta) consulta, status, linhas, executado_em
                  FROM comercial.controle_carga
                 ORDER BY consulta, executado_em DESC) u),

      -- a régua da comissão, para a tela poder mostrar e aplicar a faixa
      'faixas', (
        SELECT coalesce(json_agg(json_build_array(perc_min, perc_max, perc_comissao) ORDER BY perc_min), '[]'::json)
          FROM comercial.dim_faixa_comissao
         WHERE vigencia_desde = (SELECT max(vigencia_desde) FROM comercial.dim_faixa_comissao
                                  WHERE vigencia_desde <= v_ate)),

      'rcas', (
        SELECT coalesce(json_object_agg(codusur, json_build_array(nome, codsupervisor)), '{}'::json)
          FROM core.dim_rca),

      'supervisores', (
        SELECT coalesce(json_object_agg(codsupervisor, nome), '{}'::json)
          FROM core.dim_supervisor),

      'motivos', (
        SELECT coalesce(json_agg(json_build_array(coddevol, motivo, responsabilidade_rca) ORDER BY motivo), '[]'::json)
          FROM comercial.dim_motivo_devolucao),

      -- ---------------- comissão ----------------
      'comissao', json_build_object(
        'rca', (
          SELECT coalesce(json_agg(json_build_array(
                   codusur, codfilial, notas, clientes, pedidos, venda, devolucao_com_st,
                   devolucao_sem_st, cmv_venda, cmv_devolucao, cmv_bonificacao,
                   desc_financeiro, desc_financeiro_original, st, quantidade)), '[]'::json)
            FROM (SELECT codusur, codfilial,
                         count(*)                                   AS notas,
                         count(DISTINCT codcli)                     AS clientes,
                         count(DISTINCT numped)                     AS pedidos,
                         round(sum(venda), 2)                       AS venda,
                         round(sum(devolucao_com_st), 2)            AS devolucao_com_st,
                         round(sum(devolucao_sem_st), 2)            AS devolucao_sem_st,
                         round(sum(cmv_venda), 2)                   AS cmv_venda,
                         round(sum(cmv_devolucao), 2)               AS cmv_devolucao,
                         round(sum(cmv_bonificacao), 2)             AS cmv_bonificacao,
                         round(sum(desc_financeiro), 2)             AS desc_financeiro,
                         round(sum(desc_financeiro_original), 2)    AS desc_financeiro_original,
                         round(sum(st), 2)                          AS st,
                         round(sum(quantidade), 2)                  AS quantidade
                    FROM comercial.fato_comissao_nf
                   WHERE dtmov BETWEEN v_de AND v_ate
                   GROUP BY 1, 2) c),
        -- positivação: clientes distintos do RCA no período. Substitui a
        -- Consulta5 do Power BI, que não alimentava nenhuma página e contava
        -- produto distinto DENTRO de cada cliente.
        'clientes_por_rca', (
          SELECT coalesce(json_object_agg(codusur, clientes), '{}'::json)
            FROM (SELECT codusur, count(DISTINCT codcli) AS clientes
                    FROM comercial.fato_comissao_nf
                   WHERE dtmov BETWEEN v_de AND v_ate
                   GROUP BY 1) k),
        'mes', (
          SELECT coalesce(json_agg(json_build_array(
                   to_char(mes, 'YYYY-MM'), rcas, venda, devolucao, total_liquido,
                   total_liquido_sst, massa_margem, perc_liquido, comissao_soma_rca, st)
                 ORDER BY mes), '[]'::json)
            FROM comercial.mv_comissao_mes
           WHERE mes >= (date_trunc('month', v_ate) - interval '23 months')::date),
        'periodo_da_base', (
          SELECT json_build_array(min(dtmov), max(dtmov)) FROM comercial.fato_comissao_nf)
      ),

      -- ---------------- margem por item ----------------
      'margem', json_build_object(
        'resumo', (
          SELECT json_build_object(
                   'itens',        count(*),
                   'venda',        round(coalesce(sum(venda), 0), 2),
                   'cmv',          round(coalesce(sum(cmv_venda), 0), 2),
                   'margem_valor', round(coalesce(sum(margem_valor), 0), 2),
                   'abaixo_5',     count(*) FILTER (WHERE margem_perc <  5),
                   'abaixo_8',     count(*) FILTER (WHERE margem_perc <  8),
                   'abaixo_10',    count(*) FILTER (WHERE margem_perc < 10),
                   'abaixo_15',    count(*) FILTER (WHERE margem_perc < 15),
                   'abaixo_20',    count(*) FILTER (WHERE margem_perc < 20),
                   'negativa',     count(*) FILTER (WHERE margem_perc <  0))
            FROM comercial.fato_margem_item
           WHERE codoper = 'S' AND dtmov BETWEEN v_de AND v_ate),
        'rca', (
          SELECT coalesce(json_agg(json_build_array(codusur, itens, venda, margem_valor, abaixo)), '[]'::json)
            FROM (SELECT codusur, count(*) AS itens,
                         round(sum(venda), 2) AS venda,
                         round(sum(margem_valor), 2) AS margem_valor,
                         count(*) FILTER (WHERE margem_perc < 5) AS abaixo
                    FROM comercial.fato_margem_item
                   WHERE codoper = 'S' AND dtmov BETWEEN v_de AND v_ate
                   GROUP BY 1) m),
        'mes', (
          SELECT coalesce(json_agg(json_build_array(
                   to_char(mes, 'YYYY-MM'), itens, venda, margem_valor,
                   itens_abaixo_5, itens_abaixo_10, itens_abaixo_20) ORDER BY mes), '[]'::json)
            FROM (SELECT mes, sum(itens) itens, sum(venda) venda, sum(margem_valor) margem_valor,
                         sum(itens_abaixo_5) itens_abaixo_5, sum(itens_abaixo_10) itens_abaixo_10,
                         sum(itens_abaixo_20) itens_abaixo_20
                    FROM comercial.mv_margem_mes
                   WHERE mes >= (date_trunc('month', v_ate) - interval '23 months')::date
                   GROUP BY mes) x),
        -- os piores do período: é o que a página existe para resolver
        'piores', (
          SELECT coalesce(json_agg(json_build_array(
                   dtmov, numnota, numped, codusur, codprod, quantidade, punit,
                   venda, margem_perc, margem_valor)), '[]'::json)
            FROM (SELECT dtmov, numnota, numped, codusur, codprod,
                         round(quantidade, 2) quantidade, punit, venda, margem_perc,
                         round(margem_valor, 2) margem_valor
                    FROM comercial.fato_margem_item
                   WHERE codoper = 'S' AND dtmov BETWEEN v_de AND v_ate AND venda > 0
                   ORDER BY margem_perc NULLS LAST
                   LIMIT 1200) p),
        'periodo_da_base', (
          SELECT json_build_array(min(dtmov), max(dtmov)) FROM comercial.fato_margem_item)
      ),

      -- ---------------- devoluções ----------------
      'devolucao', json_build_object(
        'linhas', (
          SELECT coalesce(json_agg(json_build_array(
                   dtmov, numnota, codcli, codusur, coddevol, codfilial, qt,
                   valor_devolucao, vltotal_nota)), '[]'::json)
            FROM (SELECT dtmov, numnota, codcli, codusur, coddevol, codfilial,
                         round(qt, 2) qt, valor_devolucao, vltotal_nota
                    FROM comercial.fato_devolucao
                   WHERE dtmov BETWEEN v_de AND v_ate
                   ORDER BY valor_devolucao DESC
                   LIMIT 4000) d),
        'total_periodo', (
          SELECT json_build_object(
                   'linhas', count(*),
                   'notas',  count(DISTINCT numnota),
                   'valor',  round(coalesce(sum(valor_devolucao), 0), 2),
                   'valor_rca', round(coalesce(sum(d.valor_devolucao) FILTER (WHERE m.responsabilidade_rca), 0), 2),
                   'vltotal_somado', round(coalesce(sum(vltotal_nota), 0), 2))
            FROM comercial.fato_devolucao d
            LEFT JOIN comercial.dim_motivo_devolucao m ON m.coddevol = d.coddevol
           WHERE d.dtmov BETWEEN v_de AND v_ate),
        'mes', (
          SELECT coalesce(json_agg(json_build_array(to_char(mes, 'YYYY-MM'), valor, valor_rca, notas)
                 ORDER BY mes), '[]'::json)
            FROM (SELECT mes, sum(valor) valor, sum(valor_rca) valor_rca, sum(notas) notas
                    FROM comercial.mv_devolucao_rca_mes
                   WHERE mes >= (date_trunc('month', v_ate) - interval '23 months')::date
                   GROUP BY mes) x),
        'periodo_da_base', (
          SELECT json_build_array(min(dtmov), max(dtmov)) FROM comercial.fato_devolucao)
      ),

      -- ---------------- pedidos em aberto (foto de agora) ----------------
      'pedidos', (
        SELECT coalesce(json_agg(json_build_array(
                 data, numped, codcli, codusur, codsupervisor, tipo_pedido,
                 posicao, vltotal, quantidade, margem_perc) ORDER BY data DESC), '[]'::json)
          FROM comercial.fato_pedido_aberto),

      -- nomes só de quem aparece na tela (o cadastro de clientes é grande demais)
      'clientes', (
        SELECT coalesce(json_object_agg(codcli, cliente), '{}'::json)
          FROM core.dim_cliente
         WHERE codcli IN (SELECT codcli FROM comercial.fato_pedido_aberto
                          UNION
                          SELECT codcli FROM comercial.fato_devolucao WHERE dtmov BETWEEN v_de AND v_ate)),

      'produtos', (
        SELECT coalesce(json_object_agg(codprod, descricao), '{}'::json)
          FROM core.dim_produto
         WHERE codprod IN (SELECT codprod FROM comercial.fato_margem_item
                            WHERE codoper = 'S' AND dtmov BETWEEN v_de AND v_ate AND venda > 0
                            ORDER BY margem_perc NULLS LAST LIMIT 1200))

    ) INTO v_out;

    RETURN v_out;
END;
$$;

COMMENT ON FUNCTION comercial.painel_dados(date, date) IS
    'Todo o conteúdo do painel do BI COMERCIAL para um período. Sem parâmetro, '
    'devolve o mês corrente. Chamada por /api/dados na Vercel.';


-- ---------------------------------------------------------------------------
-- painel_detalhe(tipo, de, ate, chave, limite) — as listas grandes
-- ---------------------------------------------------------------------------
-- Existe porque duas listas não cabem no payload do painel: as notas de um RCA
-- (205 mil linhas na base) e os itens abaixo da margem além dos 1.200 piores
-- (3,3 milhões). Continuam sendo consulta de banco — a função serverless
-- apenas repassa.
CREATE OR REPLACE FUNCTION comercial.painel_detalhe(
    p_tipo   text,
    p_de     date,
    p_ate    date,
    p_chave  text DEFAULT NULL,
    p_limite integer DEFAULT 2000)
RETURNS json
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_limite integer := least(greatest(coalesce(p_limite, 2000), 1), 20000);
    v_out    json;
BEGIN
    IF p_tipo = 'comissao_nf' THEN
        -- notas de um RCA no período, com os componentes da comissão de cada
        -- uma. A faixa aplicada nota a nota NÃO soma a comissão do RCA — é
        -- justamente essa diferença que a tela mostra.
        SELECT json_build_object('tipo', p_tipo, 'linhas', coalesce(json_agg(l), '[]'::json)) INTO v_out
          FROM (SELECT json_build_array(
                         dtmov, numnota, numped, codcli, codfilial, quantidade,
                         venda, devolucao_com_st, devolucao_sem_st, cmv_venda,
                         cmv_devolucao, cmv_bonificacao, desc_financeiro, st) AS l
                  FROM comercial.fato_comissao_nf
                 WHERE dtmov BETWEEN p_de AND p_ate
                   AND (p_chave IS NULL OR codusur = p_chave::integer)
                 ORDER BY dtmov, numnota
                 LIMIT v_limite) x;

    ELSIF p_tipo = 'margem_item' THEN
        -- itens do período abaixo de um limite de margem (p_chave = limite em %)
        SELECT json_build_object('tipo', p_tipo, 'linhas', coalesce(json_agg(l), '[]'::json)) INTO v_out
          FROM (SELECT json_build_array(
                         i.dtmov, i.numnota, i.numped, i.codusur, i.codprod, p.descricao,
                         round(i.quantidade, 2), i.punit, i.venda, i.margem_perc,
                         round(i.margem_valor, 2)) AS l
                  FROM comercial.fato_margem_item i
                  LEFT JOIN core.dim_produto p ON p.codprod = i.codprod
                 WHERE i.codoper = 'S'
                   AND i.dtmov BETWEEN p_de AND p_ate
                   AND i.venda > 0
                   AND (p_chave IS NULL OR i.margem_perc < p_chave::numeric)
                 ORDER BY i.margem_perc NULLS LAST
                 LIMIT v_limite) x;

    ELSIF p_tipo = 'devolucao_rca' THEN
        SELECT json_build_object('tipo', p_tipo, 'linhas', coalesce(json_agg(l), '[]'::json)) INTO v_out
          FROM (SELECT json_build_array(
                         d.dtmov, d.numnota, d.codcli, d.coddevol, d.codfilial,
                         round(d.qt, 2), d.valor_devolucao, d.vltotal_nota) AS l
                  FROM comercial.fato_devolucao d
                 WHERE d.dtmov BETWEEN p_de AND p_ate
                   AND (p_chave IS NULL OR d.codusur = p_chave::integer)
                 ORDER BY d.valor_devolucao DESC
                 LIMIT v_limite) x;
    ELSE
        RETURN json_build_object('erro', 'tipo desconhecido: ' || coalesce(p_tipo, '(nulo)'));
    END IF;

    RETURN v_out;
END;
$$;

COMMENT ON FUNCTION comercial.painel_detalhe(text, date, date, text, integer) IS
    'Listas grandes do painel: notas de um RCA (comissao_nf), itens abaixo da '
    'margem (margem_item) e devoluções de um RCA (devolucao_rca).';
