-- ===========================================================================
-- A comissão do painel sem arredondar linha a linha
--
-- Pedido do Júlio (2026-10-30), na conferência do Supervisor Lube contra o Central Comercial: a aba "Comissão RCA - ST"
-- mostrava R$ 15.178.118,21 de TOTAL LIQUIDO em outubro, e o banco, o Power BI e o app davam R$ 15.178.118,18. O bloco
-- comissao.rca mandava cada RCA × filial já arredondado a 2 casas (round(sum(...), 2)), e a soma escorregava 1 a 2
-- centavos em 8 regiões. A primeira correção foi a 4 casas, e setembro ainda caiu na borda do meio centavo (Comissão
-- por RCA: exato 13.566.351,195068, linhas somando 13.566.351,1949). As colunas da fato_comissao_nf têm no máximo 6
-- casas: com 6 a soma é exata. A tela continua mostrando 2.
--
-- Conferido antes de publicar (prévia com a cópia painel_dados_previa, já apagada): comissão de outubro igual
-- (R$ 461.713,40), nenhuma faixa muda; 25 RCAs pequenos mudam o % líquido na 3ª ou 4ª casa (mais exato). Depois de
-- aplicar, as 13 linhas do painel_cache foram refeitas e as 13 bateram com o banco sem diferença.
--
-- Junto (web/app.js): a aba ST abre com TODAS as filiais (antes abria com as do Power BI, 1, 7, 10 e 11, sem o RJ).
--
-- Cópia versionada das migrações `comercial_painel_dados_comissao_4_casas` e `comercial_painel_dados_comissao_6_casas`.
-- ===========================================================================

CREATE OR REPLACE FUNCTION comercial.painel_dados(p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date)
 RETURNS json
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_ate      date := coalesce(p_ate, current_date);
    v_de       date := coalesce(p_de, date_trunc('month', coalesce(p_ate, current_date))::date);
    v_piores   json;
    v_produtos json;
    v_out      json;
BEGIN
    -- os piores itens do período e os nomes dos produtos deles, de uma vez só
    WITH p AS (
        SELECT dtmov, numnota, numped, codusur, codprod,
               round(quantidade, 2) AS qt, punit, venda, margem_perc,
               round(margem_valor, 2) AS mv
          FROM comercial.fato_margem_item
         WHERE codoper = 'S' AND dtmov BETWEEN v_de AND v_ate AND venda > 0
         ORDER BY margem_perc NULLS LAST
         LIMIT 1200)
    SELECT coalesce(json_agg(json_build_array(dtmov, numnota, numped, codusur, codprod,
                                              qt, punit, venda, margem_perc, mv)), '[]'::json),
           coalesce((SELECT json_object_agg(d.codprod, d.descricao)
                       FROM core.dim_produto d
                      WHERE d.codprod IN (SELECT codprod FROM p)), '{}'::json)
      INTO v_piores, v_produtos
      FROM p;

    SELECT json_build_object(
      'gerado_em', now(),
      'periodo', json_build_object('de', v_de, 'ate', v_ate),
      'carga', (
        SELECT json_build_object(
                 'ultima', max(executado_em),
                 'itens',  coalesce(json_agg(json_build_array(consulta, status, linhas, executado_em)
                                             ORDER BY consulta), '[]'::json))
          FROM (SELECT DISTINCT ON (consulta) consulta, status, linhas, executado_em
                  FROM comercial.controle_carga
                 ORDER BY consulta, executado_em DESC) u),
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
      'comissao', json_build_object(
        'rca', (
          SELECT coalesce(json_agg(json_build_array(
                   codusur, codfilial, notas, clientes, pedidos, venda, devolucao_com_st,
                   devolucao_sem_st, cmv_venda, cmv_devolucao, cmv_bonificacao,
                   desc_financeiro, desc_financeiro_original, st, quantidade)), '[]'::json)
            FROM (SELECT codusur, codfilial,
                         count(*)                                AS notas,
                         count(DISTINCT codcli)                  AS clientes,
                         count(DISTINCT numped)                  AS pedidos,
                         round(sum(venda), 6)                    AS venda,
                         round(sum(devolucao_com_st), 6)         AS devolucao_com_st,
                         round(sum(devolucao_sem_st), 6)         AS devolucao_sem_st,
                         round(sum(cmv_venda), 6)                AS cmv_venda,
                         round(sum(cmv_devolucao), 6)            AS cmv_devolucao,
                         round(sum(cmv_bonificacao), 6)          AS cmv_bonificacao,
                         round(sum(desc_financeiro), 6)          AS desc_financeiro,
                         round(sum(desc_financeiro_original), 6) AS desc_financeiro_original,
                         round(sum(st), 6)                       AS st,
                         round(sum(quantidade), 2)               AS quantidade
                    FROM comercial.fato_comissao_nf
                   WHERE dtmov BETWEEN v_de AND v_ate
                   GROUP BY 1, 2) c),
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
      'margem', json_build_object(
        'resumo', (
          SELECT json_build_object(
                   'itens',        coalesce(sum(itens), 0),
                   'venda',        round(coalesce(sum(venda), 0), 2),
                   'cmv',          round(coalesce(sum(cmv), 0), 2),
                   'margem_valor', round(coalesce(sum(margem_valor), 0), 2),
                   'abaixo_5',     coalesce(sum(itens_abaixo_5), 0),
                   'abaixo_8',     coalesce(sum(itens_abaixo_8), 0),
                   'abaixo_10',    coalesce(sum(itens_abaixo_10), 0),
                   'abaixo_15',    coalesce(sum(itens_abaixo_15), 0),
                   'abaixo_20',    coalesce(sum(itens_abaixo_20), 0),
                   'negativa',     coalesce(sum(itens_negativa), 0))
            FROM comercial.mv_margem_dia
           WHERE dtmov BETWEEN v_de AND v_ate),
        'rca', (
          SELECT coalesce(json_agg(json_build_array(codusur, itens, venda, margem_valor, abaixo)), '[]'::json)
            FROM (SELECT codusur, sum(itens) AS itens,
                         round(sum(venda), 2) AS venda,
                         round(sum(margem_valor), 2) AS margem_valor,
                         sum(itens_abaixo_5) AS abaixo
                    FROM comercial.mv_margem_dia
                   WHERE dtmov BETWEEN v_de AND v_ate
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
        'piores', v_piores,
        'periodo_da_base', (
          SELECT json_build_array(min(dtmov), max(dtmov)) FROM comercial.mv_margem_dia)
      ),
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
                   'notas',  count(DISTINCT d.numnota),
                   'valor',  round(coalesce(sum(d.valor_devolucao), 0), 2),
                   'valor_rca', round(coalesce(sum(d.valor_devolucao) FILTER (WHERE m.responsabilidade_rca), 0), 2),
                   'vltotal_somado', round(coalesce(sum(d.vltotal_nota), 0), 2))
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
      'pedidos', (
        SELECT coalesce(json_agg(json_build_array(
                 data, numped, codcli, codusur, codsupervisor, tipo_pedido,
                 posicao, vltotal, quantidade, margem_perc) ORDER BY data DESC), '[]'::json)
          FROM comercial.fato_pedido_aberto),
      'clientes', (
        SELECT coalesce(json_object_agg(codcli, cliente), '{}'::json)
          FROM core.dim_cliente
         WHERE codcli IN (SELECT codcli FROM comercial.fato_pedido_aberto
                          UNION
                          SELECT codcli FROM comercial.fato_devolucao WHERE dtmov BETWEEN v_de AND v_ate)),
      'produtos', v_produtos
    ) INTO v_out;
    RETURN v_out;
END;
$function$;
