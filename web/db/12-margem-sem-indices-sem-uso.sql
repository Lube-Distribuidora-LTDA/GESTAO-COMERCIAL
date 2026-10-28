-- ===========================================================================
-- BI COMERCIAL — margem por item sem os 2 índices que ninguém usa (2026-10-28)
--
-- Decisão do Júlio em 2026-10-28 ("Tirar os 2 índices sem uso"), depois da
-- medição de custo e saúde dos bancos: a carga da margem das 03:45 apaga e
-- regrava as 3,37 milhões de linhas com todos os índices, e ela estava rodando
-- em 4 das 7 quedas do banco (22 a 28/10). Menos índice = carga mais leve.
--
-- ix_margem_prod (codprod, 30 MB) e ix_margem_rca (codusur, 24 MB): nenhuma
-- consulta do painel, da Abertura de margem, do AGENTE LUBE, do Guardião nem
-- das views filtra a margem só por produto ou só por RCA, e nenhum dos dois
-- sustenta chave ou constraint. Ficam: ix_margem_venda (o Guardião usa no
-- max(dtmov) da conferência), ix_margem_piores, ix_margem_item_dtmov e os da
-- Abertura de margem. Também saíram do 01-schema.sql.
--
-- Cópia versionada da migração `comercial_margem_sem_indices_sem_uso`.
-- Voltar: os dois CREATE INDEX do 01-schema.sql de antes (commit cf1762b).
-- ===========================================================================

SET lock_timeout = '3s';
DROP INDEX IF EXISTS comercial.ix_margem_prod;
DROP INDEX IF EXISTS comercial.ix_margem_rca;
