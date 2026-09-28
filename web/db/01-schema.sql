-- ===========================================================================
-- BI COMERCIAL — schema `comercial` no projeto DATA WAREHOUSE
--
-- Este arquivo é a cópia versionada da migração `comercial_schema_inicial`,
-- aplicada no Supabase (projeto ivcnotrynogaljrvvyes). A fonte de verdade é o
-- banco; este arquivo existe para revisão e para recriar o schema do zero.
--
-- Regras da casa (skill data-warehouse):
--   · um schema por sistema, nada no `public`;
--   · dimensões compartilhadas no `core`, com um dono único — aqui o dono das
--     dimensões de RCA, supervisor e cliente é o ETL do COMERCIAL;
--   · toda tabela nasce com RLS habilitado e SEM políticas: a chave pública
--     `anon` não lê nem escreve nada. Quem lê é o ETL (dono) e a função
--     serverless do painel, com credencial de servidor.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS comercial;

-- ---------------------------------------------------------------------------
-- Dimensões compartilhadas (core) — dono: ETL do COMERCIAL
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS core.dim_rca (
    codusur        integer PRIMARY KEY,
    nome           text,
    codsupervisor  integer,
    codequipe      integer,
    updated_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE core.dim_rca IS
    'RCAs (PCUSUARI). Dono: ETL do BI COMERCIAL. Existe para que o nome do '
    'vendedor não dependa de ele ter vendido — no Power BI, um RCA com '
    'devolução e sem venda nas filiais da comissão sumia da tela.';

CREATE TABLE IF NOT EXISTS core.dim_supervisor (
    codsupervisor  integer PRIMARY KEY,
    nome           text,
    updated_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE core.dim_supervisor IS 'Supervisores (PCSUPERV). Dono: ETL do BI COMERCIAL.';

CREATE TABLE IF NOT EXISTS core.dim_cliente (
    codcli         integer PRIMARY KEY,
    cliente        text,
    codcidade      integer,
    cidade         text,
    uf             text,
    perc_descfin   numeric(10,4),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE core.dim_cliente IS 'Clientes (PCCLIENT + PCCIDADE). Dono: ETL do BI COMERCIAL.';

-- ---------------------------------------------------------------------------
-- Controle de carga do sistema
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS comercial.controle_carga (
    id                bigserial PRIMARY KEY,
    consulta          text NOT NULL,
    tabela_destino    text,
    status            text NOT NULL,
    linhas            integer,
    linhas_esperadas  integer,
    segundos          numeric,
    mensagem          text,
    executado_em      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_comercial_carga_data ON comercial.controle_carga (executado_em DESC);

-- ---------------------------------------------------------------------------
-- Dimensões do sistema
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS comercial.dim_motivo_devolucao (
    coddevol              integer PRIMARY KEY,
    motivo                text,
    responsabilidade_rca  boolean NOT NULL DEFAULT false,
    updated_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN comercial.dim_motivo_devolucao.responsabilidade_rca IS
    'Motivo comercial, atribuível ao vendedor. No Power BI esta lista estava '
    'presa dentro do filtro de UM visual, e o cartão ao lado não tinha o '
    'filtro — cartão e tabela mostravam números diferentes na mesma tela. '
    'A lista vive em etl/consultas_comercial.py (MOTIVOS_DO_RCA).';

-- Faixas de comissão sobre a margem líquida. O Power BI tinha isso escrito
-- dentro de um IF aninhado numa medida DAX, e uma SEGUNDA regra, diferente,
-- dentro do SQL (essa pagava 0% para margem negativa e nunca foi usada).
-- Aqui é tabela: dá para ver, conferir e mudar sem mexer em código.
CREATE TABLE IF NOT EXISTS comercial.dim_faixa_comissao (
    id              smallserial PRIMARY KEY,
    vigencia_desde  date    NOT NULL,
    perc_min        numeric NOT NULL,   -- margem líquida em %, inclusive
    perc_max        numeric,            -- exclusivo; NULL = sem teto
    perc_comissao   numeric NOT NULL,   -- comissão em %
    UNIQUE (vigencia_desde, perc_min)
);
COMMENT ON TABLE comercial.dim_faixa_comissao IS
    'Faixa de comissão por margem líquida. A vigência 2023-10-18 vem do nome '
    'da medida do Power BI ("NOVO 18/10/2023 ST"). Para mudar a regra, '
    'insira as faixas novas com uma vigência nova — o histórico fica.';

INSERT INTO comercial.dim_faixa_comissao (vigencia_desde, perc_min, perc_max, perc_comissao)
VALUES ('2023-10-18',  -999999,   20,  1.0),   -- inclui margem negativa: 1% (regra DAX, a que vale)
       ('2023-10-18',       20,   21,  2.0),
       ('2023-10-18',       21,   23,  2.5),
       ('2023-10-18',       23,   26,  3.0),
       ('2023-10-18',       26,   30,  3.5),
       ('2023-10-18',       30, NULL,  4.0)
ON CONFLICT (vigencia_desde, perc_min) DO UPDATE
   SET perc_max = EXCLUDED.perc_max, perc_comissao = EXCLUDED.perc_comissao;

-- ---------------------------------------------------------------------------
-- Fatos
-- ---------------------------------------------------------------------------

-- Consulta2 — margem de cada item vendido (linha de nota).
CREATE TABLE IF NOT EXISTS comercial.fato_margem_item (
    dtmov             date NOT NULL,
    numnota           bigint,
    numped            bigint,
    codoper           text,
    codusur           integer,
    codprod           integer,
    codfilial         smallint,
    quantidade        numeric,
    venda             numeric,
    vl_devolucao      numeric,
    vl_bonificacao    numeric,
    cmv_venda         numeric,
    cmv_devolucao     numeric,
    vl_bonific_custo  numeric,
    st                numeric,
    punit             numeric,
    margem_perc       numeric,
    margem_valor      numeric,
    data_carga        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN comercial.fato_margem_item.margem_valor IS
    'venda − CMV da venda. É o mesmo que venda × margem% / 100, mas somável — '
    'o percentual não é.';
CREATE INDEX IF NOT EXISTS ix_margem_venda ON comercial.fato_margem_item (dtmov, margem_perc)
    WHERE codoper = 'S';
CREATE INDEX IF NOT EXISTS ix_margem_prod  ON comercial.fato_margem_item (codprod);
CREATE INDEX IF NOT EXISTS ix_margem_rca   ON comercial.fato_margem_item (codusur);

-- Consulta6 — base da comissão. Uma linha por nota × pedido × cliente × RCA × filial.
CREATE TABLE IF NOT EXISTS comercial.fato_comissao_nf (
    dtmov                     date NOT NULL,
    numnota                   bigint,
    numped                    bigint,
    codcli                    integer,
    codusur                   integer,
    codsupervisor             integer,
    codfilial                 smallint,
    quantidade                numeric,
    venda                     numeric,   -- S: QT × (PUNIT − ST)
    devolucao_com_st          numeric,   -- ED: QT × PUNITCONT          → base da comissão
    devolucao_sem_st          numeric,   -- ED: QT × (PUNITCONT − ST)   → denominador do %
    cmv_venda                 numeric,
    cmv_devolucao             numeric,
    cmv_bonificacao           numeric,
    vl_bonificacao            numeric,
    st                        numeric,
    desc_financeiro           numeric,   -- CORRIGIDO: contado uma vez por nota
    desc_financeiro_original  numeric,   -- como o Power BI somava, para conferir
    data_carga                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_comissao_data ON comercial.fato_comissao_nf (dtmov);
CREATE INDEX IF NOT EXISTS ix_comissao_rca  ON comercial.fato_comissao_nf (codusur, dtmov);

-- Consulta3 — devoluções de cliente com motivo.
CREATE TABLE IF NOT EXISTS comercial.fato_devolucao (
    dtmov            date NOT NULL,
    numnota          bigint,
    numtransent      bigint,
    codcli           integer,
    codusur          integer,
    codfilial        smallint,
    numnotadev       bigint,
    coddevol         integer,
    qt               numeric,
    valor_devolucao  numeric,   -- CORRIGIDO: valor da linha (QT × PUNITCONT), somável
    st               numeric,
    vltotal_nota     numeric,   -- total da NF de entrada, como o Power BI somava
    data_carga       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_devolucao_data ON comercial.fato_devolucao (dtmov);
CREATE INDEX IF NOT EXISTS ix_devolucao_rca  ON comercial.fato_devolucao (codusur);

-- Consulta4 — foto dos pedidos em aberto (full refresh a cada carga).
CREATE TABLE IF NOT EXISTS comercial.fato_pedido_aberto (
    data           date,
    numped         bigint,
    codcli         integer,
    codusur        integer,
    codsupervisor  integer,
    codfilial      smallint,
    condvenda      text,
    tipo_pedido    text,
    posicao        text,
    vltotal        numeric,
    quantidade     numeric,
    margem_perc    numeric,
    data_carga     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_pedido_data ON comercial.fato_pedido_aberto (data);

-- ---------------------------------------------------------------------------
-- Segurança: RLS ligado, sem políticas
-- ---------------------------------------------------------------------------
ALTER TABLE core.dim_rca                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.dim_supervisor              ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.dim_cliente                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE comercial.controle_carga         ENABLE ROW LEVEL SECURITY;
ALTER TABLE comercial.dim_motivo_devolucao   ENABLE ROW LEVEL SECURITY;
ALTER TABLE comercial.dim_faixa_comissao     ENABLE ROW LEVEL SECURITY;
ALTER TABLE comercial.fato_margem_item       ENABLE ROW LEVEL SECURITY;
ALTER TABLE comercial.fato_comissao_nf       ENABLE ROW LEVEL SECURITY;
ALTER TABLE comercial.fato_devolucao         ENABLE ROW LEVEL SECURITY;
ALTER TABLE comercial.fato_pedido_aberto     ENABLE ROW LEVEL SECURITY;
