-- ===========================================================================
-- COMISSAO: a escada de faixas estava errada, inclusive no Power BI
--
-- O Julio corrigiu em 2026-10-28 e disse que a regra SEMPRE foi esta: nao e
-- uma mudanca de politica, e um erro que o Power BI carregava. Por isso as
-- linhas da vigencia 2023-10-18 sao SUBSTITUIDAS, e nao versionadas: os meses
-- passados no painel passam a mostrar a comissao certa.
--
-- O QUE HAVIA (errado), 6 faixas:
--     ate 20%        1,0%
--     20% a 21%      2,0%
--     21% a 23%      2,5%
--     23% a 26%      3,0%
--     26% a 30%      3,5%
--     30% ou mais    4,0%
--
-- O QUE PASSA A VALER, 11 faixas, uma por ponto de margem:
--     ate 20,9999%   3,0%     <- o piso sobe de 1,0% para 3,0%
--     21% a 21,9999% 3,1%
--     ... um decimo a mais por ponto de margem ...
--     29% a 29,9999% 3,9%
--     30% ou mais    4,0%
--
-- MEDIDO em outubro/2026 (01 a 27, filiais 1, 7 e 11), 105 RCAs:
--     comissao pela regra antiga   R$ 221.531,32
--     comissao pela regra correta  R$ 343.968,48
--     diferenca                    R$ 122.437,16  (+55%)
--
-- Os intervalos sao fechados no inicio e abertos no fim ([21, 22) etc.), que e
-- como o painel ja le a tabela. "< 21,9999" do pedido e o mesmo que "< 22".
--
-- Depois de aplicar, atualizar mv_comissao_rca_mes e mv_comissao_mes (elas
-- gravam a faixa dentro) e reaquecer o comercial.painel_cache.
--
-- Copia versionada da migracao `comercial_faixas_comissao_corrigidas`.
-- ===========================================================================

DELETE FROM comercial.dim_faixa_comissao WHERE vigencia_desde = DATE '2023-10-18';

INSERT INTO comercial.dim_faixa_comissao (vigencia_desde, perc_min, perc_max, perc_comissao)
VALUES
    (DATE '2023-10-18', -999999, 21,   3.0),
    (DATE '2023-10-18',      21, 22,   3.1),
    (DATE '2023-10-18',      22, 23,   3.2),
    (DATE '2023-10-18',      23, 24,   3.3),
    (DATE '2023-10-18',      24, 25,   3.4),
    (DATE '2023-10-18',      25, 26,   3.5),
    (DATE '2023-10-18',      26, 27,   3.6),
    (DATE '2023-10-18',      27, 28,   3.7),
    (DATE '2023-10-18',      28, 29,   3.8),
    (DATE '2023-10-18',      29, 30,   3.9),
    (DATE '2023-10-18',      30, NULL, 4.0);
