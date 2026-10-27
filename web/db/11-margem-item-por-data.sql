-- ===========================================================================
-- BI COMERCIAL — índice por data na margem por item (2026-10-27)
--
-- O AGENTE LUBE lê e troca a margem por item só de hoje (de 30 em 30 s) e de 2
-- dias (de 15 em 15 min): "WHERE dtmov >= X", sem filtro de codoper. Os dois
-- índices por data que já existiam são parciais (codoper = 'S') e não servem.
-- Sem este, cada leitura e cada DELETE da janela varriam a tabela inteira (3,3
-- milhões de linhas, ~600 MB): 2 a 3 s por vez. Com ele: menos de 1 ms.
--
-- Cópia versionada da migração `comercial_margem_item_por_data`.
-- ===========================================================================

CREATE INDEX IF NOT EXISTS ix_margem_item_dtmov ON comercial.fato_margem_item (dtmov);
