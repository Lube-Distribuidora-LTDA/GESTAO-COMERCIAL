# Objetos de banco — schema `comercial`

O painel não consulta tabela: ele chama **`comercial.painel_dados(de, ate)`**, que
monta todo o conteúdo da tela num JSON só, e **`comercial.painel_detalhe(...)`**
para as listas que não cabem nesse payload. As funções serverless em `api/` são
apenas encanamento.

Os arquivos `01-schema.sql` e `02-views-e-funcoes.sql` são a **cópia versionada
das migrações** aplicadas no projeto **DATA WAREHOUSE** (`ivcnotrynogaljrvvyes`).
A fonte de verdade é o banco, que guarda o histórico; estes arquivos existem para
revisão e para recriar o schema do zero.

## Por que duas funções, e não uma

O padrão da casa é uma função só por painel. Aqui são duas porque duas listas não
cabem numa resposta: a base de margem tem **3,3 milhões** de linhas e a de
comissão, **205 mil**. `painel_dados` manda os agregados e os 1.200 piores itens
do período; `painel_detalhe` busca, sob demanda, as notas de um RCA, a lista
completa de itens abaixo de um limite e as devoluções de um vendedor. As duas são
funções do banco — nenhuma regra desceu para o JavaScript.

A única coisa que o navegador calcula é a **aplicação da faixa** de comissão, e
mesmo assim a régua vem no payload, lida de `comercial.dim_faixa_comissao`. Isso
existe para que trocar o grão (RCA ou RCA × filial) e filtrar filial/supervisor
seja instantâneo: recalcular no servidor a cada clique custaria uma ida ao banco
por interação. Os componentes (venda, devolução, CMV, ST, desconto) vêm somados
do banco; o navegador só escolhe a faixa.

## Tabelas

| Tabela | Grão | Carga |
|---|---|---|
| `comercial.fato_margem_item` | item de nota (venda, devolução ou bonificação) | full refresh em lotes, 1x/dia |
| `comercial.fato_comissao_nf` | nota × pedido × cliente × RCA × filial | full refresh, 5x/dia |
| `comercial.fato_devolucao` | nota de entrada × motivo × RCA | full refresh, 5x/dia |
| `comercial.fato_pedido_aberto` | pedido × condição de venda | full refresh, 5x/dia (é uma foto) |
| `comercial.dim_motivo_devolucao` | motivo | upsert |
| `comercial.dim_faixa_comissao` | faixa × vigência | **não vem do ETL** — é regra de negócio, editada por migração |
| `core.dim_rca`, `core.dim_supervisor`, `core.dim_cliente` | código | upsert (dono: ETL do COMERCIAL) |

Dimensão carrega por **upsert**, nunca `TRUNCATE`: um RCA que não vendeu nesta
rodada não pode sumir do cadastro e deixar as devoluções dele sem nome.

## Views materializadas

Atualizadas pelo ETL logo depois da carga (`sync_bi_comercial.py`, lista
`VIEWS_DO_PAINEL`):

```
comercial.mv_margem_dia          margem por dia, filial e RCA — é dela que o painel lê
comercial.mv_margem_mes          venda, CMV, margem e contagens por mês e filial
comercial.mv_comissao_rca_mes    a cadeia inteira da comissão por RCA e mês
comercial.mv_comissao_mes        o mesmo, somado por mês (soma das comissões dos RCAs)
comercial.mv_devolucao_rca_mes   devolvido e devolvido-do-vendedor por RCA e mês
```

Por que elas existem: a `fato_margem_item` tem 3,3 milhões de linhas e 594 MB.
Na primeira versão o painel lia dela três vezes por acesso (resumo do período,
ranking por RCA e lista dos piores). Com o cache do Postgres quente isso
respondia em 2,4 s; **com ele frio passou de 60 s** — o limite da função da
Vercel — e ainda deixou o pooler do projeto sem fôlego.

Hoje só a **lista dos piores itens** toca a tabela grande, e mesmo assim pelo
índice `ix_margem_piores`, que já carrega o filtro `codoper='S' AND venda > 0`:
a varredura acontece no índice e o heap é lido apenas nas 1.200 linhas que
aparecem na tela. Resumo e ranking saem da `mv_margem_dia`, que tem grão de
**dia** justamente para responder qualquer intervalo de datas (mês fechado não
responderia "01 a 17 de setembro").

`mv_comissao_mes` merece uma nota: a comissão do mês ali é a **soma das comissões
dos RCAs**, não a faixa aplicada sobre a margem da empresa inteira. É essa
diferença que fazia o rodapé da tela do Power BI nunca bater com a soma das
linhas.

## Como exportar o DDL atual

Preferimos apontar o comando a manter uma cópia colada que envelhece em silêncio:

```sql
SELECT pg_get_functiondef(p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'comercial';

SELECT 'CREATE MATERIALIZED VIEW ' || schemaname || '.' || matviewname || ' AS' || E'\n' || definition
  FROM pg_matviews WHERE schemaname = 'comercial';
```

## Segurança

Todas as tabelas com **Row Level Security habilitado e sem políticas**: a chave
pública (`anon`) não lê nem escreve nada. O acesso acontece só por credencial de
servidor — o ETL, que roda na rede interna, e as funções `/api/*` da Vercel.
