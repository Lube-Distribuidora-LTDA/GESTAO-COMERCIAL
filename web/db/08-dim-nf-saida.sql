-- 08-dim-nf-saida.sql — capa das notas fiscais de saída (PCNFSAID) em core.dim_nf_saida (2026-10-09)
--
-- Quem pediu: o SAC (tela de chamado do RCA). Ao digitar a NF, o SAC confere no
-- WinThor quando ela foi emitida e só aceita nota emitida até 1 mês atrás. A
-- Vercel não alcança o Oracle (rede interna), então a capa da nota vem para cá.
--
-- Dono: ETL do BI COMERCIAL (consulta dim_nf_saida, grupo "rapidas", 8 vezes por
-- dia). Carga por upsert pela chave NUMTRANSVENDA, janela dos últimos 45 dias:
-- nota antiga não é apagada (regra das dimensões do core), só deixa de ser
-- atualizada.
--
-- O NÚMERO DA NOTA NÃO É ÚNICO: o mesmo NUMNOTA aparece em filiais diferentes
-- (4.668 números repetidos em 400 dias, conferido em 2026-10-09). Quem consulta
-- por número precisa escolher entre as candidatas (o SAC prefere a não cancelada,
-- do próprio RCA, mais recente).

CREATE TABLE IF NOT EXISTS core.dim_nf_saida (
    numtransvenda bigint PRIMARY KEY,         -- PCNFSAID.NUMTRANSVENDA (único por nota)
    numnota       bigint NOT NULL,
    serie         text,
    especie       text,                       -- NF, CO, CE, NS...
    codfilial     integer,
    dtsaida       date   NOT NULL,            -- data de emissão (sem hora no WinThor)
    dtcancel      date,                       -- preenchida = nota cancelada
    codcli        integer,
    codusur       integer,
    vltotal       numeric(14,2),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE core.dim_nf_saida IS
  'Capa das NFs de saída (PCNFSAID), últimos 45 dias a cada carga, upsert por numtransvenda. Dono: ETL do BI COMERCIAL. NUMNOTA se repete entre filiais.';

CREATE INDEX IF NOT EXISTS dim_nf_saida_numnota_idx ON core.dim_nf_saida (numnota);

ALTER TABLE core.dim_nf_saida ENABLE ROW LEVEL SECURITY;
