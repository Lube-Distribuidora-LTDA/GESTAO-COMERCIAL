-- 07-dim-rca-email.sql — e-mail e situação do RCA em core.dim_rca (2026-10-07)
--
-- Quem pediu: o SAC (tela de chamado do RCA para o SAC). O SAC fica aberto na
-- tela de login do Painel Lube, sem login, e manda o comprovante para o e-mail
-- do RCA. Para não virar um disparador de e-mail para qualquer endereço, ele só
-- aceita e-mail que esteja no cadastro do RCA no WinThor (PCUSUARI.EMAIL/EMAIL2)
-- e de RCA sem data de término e sem bloqueio.
--
-- Regra do manual (data-warehouse, seção 1): dimensão do core tem um dono só —
-- aqui, o ETL do BI COMERCIAL. Campo novo entra estendendo a consulta do dono,
-- nunca numa segunda lista de RCAs noutro schema.
--
-- O painel do COMERCIAL lê só nome e codsupervisor desta tabela: o e-mail não
-- vai para a tela dele. RLS continua ligado e sem políticas (anon não lê nada).

ALTER TABLE core.dim_rca
  ADD COLUMN IF NOT EXISTS email     text,
  ADD COLUMN IF NOT EXISTS email2    text,
  ADD COLUMN IF NOT EXISTS bloqueio  text,
  ADD COLUMN IF NOT EXISTS dttermino date;

COMMENT ON COLUMN core.dim_rca.email     IS 'PCUSUARI.EMAIL, sem espaços nas pontas. Usado pelo SAC para conferir o RCA.';
COMMENT ON COLUMN core.dim_rca.email2    IS 'PCUSUARI.EMAIL2, idem.';
COMMENT ON COLUMN core.dim_rca.bloqueio  IS 'PCUSUARI.BLOQUEIO (S/N).';
COMMENT ON COLUMN core.dim_rca.dttermino IS 'PCUSUARI.DTTERMINO — preenchida = RCA desligado.';

-- busca do SAC: por e-mail, sem diferença de maiúscula
CREATE INDEX IF NOT EXISTS dim_rca_email_idx  ON core.dim_rca (lower(email));
CREATE INDEX IF NOT EXISTS dim_rca_email2_idx ON core.dim_rca (lower(email2));
