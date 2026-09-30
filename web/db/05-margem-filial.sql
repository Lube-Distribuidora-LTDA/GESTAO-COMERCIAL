-- ===========================================================================
-- BI COMERCIAL — abrir e fechar a margem mínima das filiais pelo painel
--
-- O QUE ISTO SUBSTITUI
-- Oito arquivos .bat em Z:\Alexandre TI\BATS que mudavam PCPRODFILIAL.
-- PERCMARGEMMIN: quatro punham 5 (fecha) e quatro punham NULL (abre), um par
-- por filial (1, 7, 11 e 12). Rodavam na mão, sem registro de quem fez, quando
-- e por quê, montando SQL por concatenação de texto e com usuário e senha do
-- WinThor escritos dentro do arquivo, numa pasta de rede compartilhada.
--
-- POR QUE UMA FILA, E NÃO UM COMANDO DIRETO
-- O painel roda na Vercel; o Oracle do WinThor vive em 192.168.0.5, dentro da
-- rede da empresa, e não é alcançável de fora. Então o painel **registra um
-- pedido** aqui, e o `agente_margem.py`, que roda na mesma máquina do ETL,
-- pega o pedido, executa no Oracle e devolve o resultado para esta mesma
-- tabela. Quem está na tela acompanha o estado.
--
-- O que a fila dá de brinde, e os .bat não davam:
--   · quem pediu, quando e por quê — obrigatórios;
--   · o valor ANTERIOR de cada produto, gravado antes de mudar: dá para
--     auditar e para desfazer;
--   · quantas linhas cada pedido mudou de verdade;
--   · SQL com bind, em vez de código montado com texto.
--
-- Cópia versionada da migração `comercial_margem_filial`.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS comercial.margem_solicitacao (
    id               bigserial PRIMARY KEY,
    criado_em        timestamptz NOT NULL DEFAULT now(),
    solicitante      text        NOT NULL,
    motivo           text        NOT NULL,
    acao             text        NOT NULL CHECK (acao IN ('abrir', 'fechar')),
    filiais          smallint[]  NOT NULL,
    produtos         integer[]   NOT NULL,
    margem           numeric,                 -- só faz sentido em 'fechar'
    status           text        NOT NULL DEFAULT 'pendente'
                     CHECK (status IN ('pendente', 'executando', 'concluida', 'erro', 'cancelada')),
    tentativas       integer     NOT NULL DEFAULT 0,
    iniciado_em      timestamptz,
    concluido_em     timestamptz,
    linhas_afetadas  integer,
    mensagem         text,
    origem           text
);
COMMENT ON TABLE comercial.margem_solicitacao IS
    'Fila de pedidos para abrir (PERCMARGEMMIN = NULL) ou fechar (= margem) a '
    'margem mínima de produtos por filial no WinThor. O painel escreve aqui; o '
    'agente_margem.py, dentro da rede, executa e devolve o resultado.';

CREATE INDEX IF NOT EXISTS ix_margem_sol_status ON comercial.margem_solicitacao (status, id)
    WHERE status IN ('pendente', 'executando');
CREATE INDEX IF NOT EXISTS ix_margem_sol_data   ON comercial.margem_solicitacao (criado_em DESC);

-- O "antes" de cada produto. É o que torna a operação reversível — coisa que
-- os .bat não permitiam: depois de rodar, ninguém sabia o valor anterior.
CREATE TABLE IF NOT EXISTS comercial.margem_alteracao (
    id              bigserial PRIMARY KEY,
    solicitacao_id  bigint    NOT NULL REFERENCES comercial.margem_solicitacao(id) ON DELETE CASCADE,
    codfilial       smallint  NOT NULL,
    codprod         integer   NOT NULL,
    valor_anterior  numeric,
    valor_novo      numeric,
    aplicado_em     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_margem_alt_sol ON comercial.margem_alteracao (solicitacao_id);

ALTER TABLE comercial.margem_solicitacao ENABLE ROW LEVEL SECURITY;
ALTER TABLE comercial.margem_alteracao   ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Registrar um pedido (chamada pela função /api/margem)
-- ---------------------------------------------------------------------------
-- Toda validação mora aqui, e não na tela: tela é conveniência, banco é regra.
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
    v_id     bigint;
    v_nome   text := btrim(coalesce(p_solicitante, ''));
    v_motivo text := btrim(coalesce(p_motivo, ''));
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
-- O histórico que a tela mostra
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION comercial.margem_historico(p_limite integer DEFAULT 40)
RETURNS json
LANGUAGE sql
STABLE
AS $fn$
    SELECT coalesce(json_agg(json_build_array(
             id, criado_em, solicitante, motivo, acao, filiais, array_length(produtos, 1),
             margem, status, linhas_afetadas, mensagem, concluido_em, produtos)
           ORDER BY id DESC), '[]'::json)
      FROM (SELECT * FROM comercial.margem_solicitacao
             ORDER BY id DESC LIMIT least(greatest(coalesce(p_limite, 40), 1), 200)) s;
$fn$;

COMMENT ON FUNCTION comercial.margem_historico(integer) IS
    'Últimos pedidos de margem, do mais novo para o mais velho, para a tela do painel.';
