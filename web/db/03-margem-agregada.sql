-- ===========================================================================
-- BI COMERCIAL — tira a fato_margem_item do caminho de cada acesso ao painel
--
-- POR QUE ISTO EXISTE
-- A `comercial.fato_margem_item` tem 3,3 milhões de linhas e 594 MB. A função
-- `painel_dados` lia dela três vezes por chamada (o resumo do período, o
-- ranking por RCA e a lista dos piores itens). Com o cache do Postgres quente
-- isso respondia em 2,4 s; com ele frio, passou de 60 s — o limite da função da
-- Vercel — e ainda deixou o pooler do projeto sem fôlego.
--
-- A correção é não varrer a tabela grande para responder pergunta agregada:
-- uma view materializada por DIA × RCA responde o resumo e o ranking de
-- qualquer intervalo de datas somando poucos milhares de linhas estreitas. A
-- lista dos piores itens continua vindo do fato — mas ela lê 1.200 linhas pelo
-- índice, não a tabela inteira.
--
-- Cópia versionada da migração `comercial_margem_agregada`.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Agregado por dia × RCA × filial
-- ---------------------------------------------------------------------------
-- O grão é DIA (e não mês) de propósito: o painel filtra por intervalo livre de
-- datas, e mês fechado não responderia "01 a 17 de setembro".
DROP MATERIALIZED VIEW IF EXISTS comercial.mv_margem_dia;
CREATE MATERIALIZED VIEW comercial.mv_margem_dia AS
SELECT dtmov,
       codfilial,
       codusur,
       count(*)                                        AS itens,
       count(*) FILTER (WHERE margem_perc <  0)        AS itens_negativa,
       count(*) FILTER (WHERE margem_perc <  5)        AS itens_abaixo_5,
       count(*) FILTER (WHERE margem_perc <  8)        AS itens_abaixo_8,
       count(*) FILTER (WHERE margem_perc < 10)        AS itens_abaixo_10,
       count(*) FILTER (WHERE margem_perc < 15)        AS itens_abaixo_15,
       count(*) FILTER (WHERE margem_perc < 20)        AS itens_abaixo_20,
       round(coalesce(sum(venda), 0), 2)               AS venda,
       round(coalesce(sum(cmv_venda), 0), 2)           AS cmv,
       round(coalesce(sum(margem_valor), 0), 2)        AS margem_valor
  FROM comercial.fato_margem_item
 WHERE codoper = 'S'
 GROUP BY dtmov, codfilial, codusur;

CREATE UNIQUE INDEX ix_mv_margem_dia ON comercial.mv_margem_dia (dtmov, codfilial, codusur);
CREATE INDEX ix_mv_margem_dia_rca    ON comercial.mv_margem_dia (codusur, dtmov);

COMMENT ON MATERIALIZED VIEW comercial.mv_margem_dia IS
    'Margem por dia, filial e RCA. Existe para que o painel responda resumo e '
    'ranking sem varrer os 594 MB da fato_margem_item a cada acesso.';

-- ---------------------------------------------------------------------------
-- Índice que faz a lista dos piores itens ser lida pelo índice, não pela tabela
-- ---------------------------------------------------------------------------
-- O índice anterior (dtmov, margem_perc) obrigava a ir ao heap para saber se
-- `venda > 0`. Com o filtro dentro do próprio índice, a varredura do intervalo
-- de datas acontece só no índice e o heap é tocado apenas nas 1.200 linhas que
-- realmente aparecem na tela.
DROP INDEX IF EXISTS comercial.ix_margem_piores;
CREATE INDEX ix_margem_piores ON comercial.fato_margem_item (dtmov, margem_perc)
    WHERE codoper = 'S' AND venda > 0;
