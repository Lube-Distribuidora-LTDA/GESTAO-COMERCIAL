# BI COMERCIAL — Lube Distribuidora

Reconstrução do Power BI **comercial** (workspace `COMERCIAL`) em pipeline próprio:
extrai do Oracle/WinThor, grava no Supabase (projeto **DATA WAREHOUSE**, schema
`comercial`) e alimenta o painel web na Vercel.

O BI responde a quatro perguntas:

| Pergunta | Página |
|---|---|
| Quanto cada RCA recebe de comissão no período? | **Comissão por RCA** |
| Quais itens saíram abaixo da margem mínima? | **Margem por item** |
| Quais pedidos em aberto estão fora da margem? | **Pedidos em aberto** |
| Quanto foi devolvido, por qual motivo e por qual vendedor? | **Devoluções** |

> **Este repositório deve permanecer privado.** Ele não contém senhas — o `ENV`
> está no `.gitignore` e o `ENV.example` traz apenas espaços reservados — mas
> descreve a estrutura do banco e a regra de comissão da empresa.

---

## Estrutura

```
etl/     pipeline Python que roda na máquina dentro da rede do WinThor
web/     painel publicado na Vercel
web/db/  os objetos de banco que o painel usa (cópia versionada das migrações)
```

```
Oracle/WinThor  ──etl/──►  Supabase (DATA WAREHOUSE)  ──/api/dados──►  painel
   rede interna             schema comercial              Vercel
                            + 3 dimensões no core
```

---

## O coração do BI: a regra de comissão

Toda a cadeia, no grão escolhido (RCA ou RCA × filial), em um período:

```
VENDA (s/ ST)      = Σ  S : QT × (PUNIT − ST)
DEVOLUÇÃO (c/ ST)  = Σ ED : QT × PUNITCONT
TOTAL LÍQUIDO      = VENDA − DEVOLUÇÃO(c/ ST)          ← base do pagamento
TOTAL LÍQ. s/ ST   = VENDA − Σ ED : QT × (PUNITCONT − ST)  ← denominador do %

CMV LÍQUIDO        = CMV venda − CMV devolução + desconto financeiro
                     + CMV bonificação − ST
MASSA DE MARGEM    = TOTAL LÍQ. s/ ST − CMV LÍQUIDO
% LÍQUIDO          = MASSA DE MARGEM / TOTAL LÍQ. s/ ST
COMISSÃO           = TOTAL LÍQUIDO × faixa(% LÍQUIDO)
```

A faixa não está escrita em código: mora em **`comercial.dim_faixa_comissao`**,
com vigência (a atual vale desde 18/10/2023, data que dá nome à medida original
do Power BI). Para mudar a régua, insira as faixas novas com uma vigência nova —
o histórico fica.

| % líquido | Comissão |
|---|---:|
| abaixo de 20% (inclusive margem negativa) | 1,0% |
| 20% a 21% | 2,0% |
| 21% a 23% | 2,5% |
| 23% a 26% | 3,0% |
| 26% a 30% | 3,5% |
| 30% ou mais | 4,0% |

**A comissão não é somável.** A faixa se aplica ao percentual do *conjunto*, então
o total muda conforme o grão em que é calculada. No Power BI isso aparecia sem
aviso: em fevereiro/2026 o rodapé da tela mostrava R$ 180.531,96 (faixa única
sobre a empresa), a soma das linhas por RCA × filial dava R$ 187.664,93 e a soma
nota a nota, R$ 188.143,73. O painel novo mostra os três números lado a lado, no
bloco **Conferência da comissão**, e paga o que estiver selecionado em **Grão da
comissão** — hoje, por RCA.

---

## Diferenças conscientes em relação ao Power BI

1. **Desconto financeiro — corrigido.** O `VLDESCFIN` vem da capa da nota e era
   repetido em cada linha de operação (venda, devolução, bonificação), entrando
   mais de uma vez na soma. Agora é contado uma vez, na venda. A coluna
   `desc_financeiro_original` guarda o valor do jeito antigo, e o painel mostra
   os dois no bloco de conferência.
2. **Devolução — corrigida.** O original somava `PCNFENT.VLTOTAL`, o total da
   NOTA, e havia 81 notas aparecendo em mais de uma linha: o mesmo total entrava
   várias vezes. Agora o valor é o da linha (`QT × PUNITCONT`), que é somável. O
   total da nota continua ao lado, em `vltotal_nota`, para comparar.
3. **Card de devolução do RCA — corrigido.** A lista de 14 motivos
   "responsabilidade do vendedor" estava presa no filtro de um visual, e o
   cartão ao lado não tinha esse filtro (R$ 365.013,47 no cartão × R$ 156.347,65
   na tabela, no mesmo período). Agora é a coluna `responsabilidade_rca` da
   dimensão de motivos, e cartão e tabela leem a mesma coisa.
4. **Nome do RCA na devolução — corrigido.** Vinha da tabela de vendas por um
   relacionamento muitos-para-muitos bidirecional: RCA com devolução e sem venda
   nas filiais da comissão sumia da tela. Agora vem de `core.dim_rca`.
5. **Limites de margem — parametrizáveis.** As páginas "MARGEM X PRODUTO 5%" e
   "10%" eram idênticas e as duas usavam a mesma coluna, que testava 5%. Viraram
   uma página só com o limite em botão (5, 8, 10, 15, 20%).
6. **Grão da base de comissão — mudado de propósito.** O original separava uma
   linha por `CODOPER`; aqui cada nota vira uma linha, com venda, devolução e
   bonificação lado a lado. A contagem cai em relação às 205.503 linhas; os
   somatórios são os mesmos.
7. **Positivação (Consulta5) — não carregada.** Não alimentava nenhuma página e
   o grão já vinha errado (produtos distintos contados dentro de cada cliente).
   Clientes distintos por RCA saem da própria base de comissão.
8. **ST no CMV — mantido como está.** O CMV de venda vem com ST embutido
   (`CUSTOFIN`) e o ST de todas as operações é descontado depois, enquanto o CMV
   de devolução e o de bonificação seguem com ST. É estranho, mas é o que a tela
   antiga faz — mantido para os números baterem. **Pendente de validação com o
   financeiro.**
9. **Faixa para margem negativa — 1%.** O SQL original tinha uma segunda regra
   (0% para margem negativa) que nunca era usada. Vale a regra da tela.

---

## etl/ — o pipeline

| Arquivo | Função |
|---|---|
| `bi_comum.py` | Infraestrutura: conexões, carga, log. É o mesmo arquivo do BI COMPRAS, com uma adição: `definir_schema()`, para o `controle_carga` ir para o schema certo. |
| `consultas_comercial.py` | Catálogo: o SQL de cada consulta, destino, colunas e conferências. |
| `sync_bi_comercial.py` | Orquestrador — é ele que carrega de verdade. |
| `diagnostico_bi_comercial.py` | Testa tudo **sem gravar nada** e soma os valores de referência do Power BI. |
| `executar.py` | Chama o sync capturando falhas que aconteceriam sem log. |
| `_teste_agendador.py` | Cobaia de 2 segundos que prova se uma tarefa consegue disparar. |
| `instalar_e_agendar.ps1` | Instala em `C:\BI\COMERCIAL` e cria as tarefas. |
| `verificar_agendamento.ps1` | Mostra o estado das tarefas e o fim do log. Não altera nada. |

### Instalação

```
pip install -r etl/requirements.txt
copy etl\ENV.example etl\ENV
```

Preencha o `ENV` com as credenciais reais. A senha do Supabase vai **entre aspas
duplas**: senha com `#` fora das aspas é cortada pela metade, em silêncio.

### Primeiro uso — sempre o diagnóstico antes

```
python diagnostico_bi_comercial.py
```

Ele não grava nada. Além de testar cada consulta, ele soma no Oracle os mesmos
números lidos do Power BI em 28/09/2026 e imprime obtido × esperado:

```
Total vendas s/ ST [30] ................ R$ 9.297.704,78
TOTAL LÍQUIDO [44] ..................... R$ 9.026.598,25
MASSA DE MARGEM [46] ................... R$ 1.874.562,57
% LÍQUIDO [47] ......................... 20,7556%
RCAs com movimento ..................... 145
Devoluções 01/06/2025 a 28/09/2026 ..... R$ 6.125.108,84
```

Diferença acima de 0,01% que **não** esteja marcada como esperada deve ser
investigada antes da primeira carga.

### Carga

```
python sync_bi_comercial.py --grupo rapidas    # comissão, devolução, pedidos, dimensões
python sync_bi_comercial.py --grupo pesadas    # margem por item (3,3 mi de linhas)
python sync_bi_comercial.py --listar           # mostra o catálogo
```

Cada consulta roda isolada: se uma falhar, as outras seguem, e o resultado de
cada execução fica em `comercial.controle_carga` — é essa tabela, não o log da
tela, que responde "a carga entrou?".

### Agendamento

```
cd "P:\INTEGRAÇÃO BI\COMERCIAL"
powershell -ExecutionPolicy Bypass -File .\instalar_e_agendar.ps1
```

| Tarefa | Roda às | Dado pronto às |
|---|---|---|
| BI Comercial - Sync rapidas | 06:45, 07:45, 08:45, 09:45, 12:45, 14:45, 15:45, 16:45 | 07:00, 08:00, 09:00, 10:00, 13:00, 15:00, 16:00, 17:00 |
| BI Comercial - Sync margem | 03:45 | 04:00 |

São os **mesmos oito momentos em que o Power BI atualizava**. A regra da casa é
rodar 10 minutos antes; aqui são 15, por dois motivos:

- o **BI COMPRAS roda aos :50** (07:50, 11:50, 17:50, 23:50 e 02:50), e dois ETLs
  pesados na mesma hora disputam o mesmo Oracle — começando aos :45, o COMERCIAL
  termina antes de o COMPRAS começar;
- a carga rápida leva **40 segundos fora de pico**, mas de manhã o Oracle fica bem
  mais lento: no COMPRAS a mesma carga passou de 31s para 8min25s às 07:50. Os 15
  minutos são a folga para isso.

O instalador copia o ETL para `C:\BI\COMERCIAL`, confere as bibliotecas,
descobre qual modo de logon a máquina aceita (registrando uma tarefa-cobaia que
só escreve um arquivinho), cria as tarefas e dispara uma carga de teste.
**Rode-o de novo toda vez que mudar um script na pasta de rede** — é ele que
leva a alteração até a cópia local, que é o que a máquina executa.

Para conferir depois:

```
powershell -ExecutionPolicy Bypass -File .\verificar_agendamento.ps1
```

---

## web/ — o painel

Site estático mais duas funções serverless, sem framework.

| Caminho | O que é |
|---|---|
| `index.html` | A casca: menu, cabeçalho e o CSS do sistema. |
| `app.js` | As quatro páginas, os gráficos e as tabelas. |
| `planilha.js` | Gera o `.xlsx` da exportação, sem biblioteca externa. |
| `api/dados.js` | `/api/dados?de=&ate=` → `comercial.painel_dados()`. |
| `api/detalhe.js` | `/api/detalhe?tipo=…` → `comercial.painel_detalhe()`, para as listas grandes. |
| `api/_db.js` | A conexão com o banco, compartilhada pelas duas rotas. |
| `db/` | Os objetos de banco e por que existem. |

O navegador **nunca** fala com o banco: ele chama `/api/dados`, e é a função, no
servidor da Vercel, que consulta o Supabase com credencial de variável de
ambiente. A resposta fica no CDN por 10 minutos, então só o primeiro acesso de
cada janela toca o banco.

### Configuração na Vercel

**Root Directory: `web`** — em *Settings › General*. É a primeira coisa a fazer, antes
de qualquer deploy. Sem isso a Vercel faz o build na raiz do repositório, encontra os
scripts do `etl/`, conclui que o projeto é Python e o build morre com:

```
Error: No python entrypoint found. Set "tool.vercel.entrypoint" in pyproject.toml
or define an entrypoint in one of: app.py, index.py, server.py, main.py, ...
```

Com o Root Directory em `web`, o `index.html` vira o site, `api/dados.js` e
`api/detalhe.js` viram funções (é por estarem em `api/` **relativo à raiz do projeto**
que são reconhecidas), e o `vercel.json` daqui é o que vale. Framework Preset: **Other**
— não há build.

Em **Settings › Environment Variables**, para Production, Preview e Development:

| Variável | Valor |
|---|---|
| `SUPABASE_DB_HOST` | `aws-0-sa-east-1.pooler.supabase.com` |
| `SUPABASE_DB_PORT` | `5432` — *session pooler*; ver a nota abaixo |
| `SUPABASE_DB_NAME` | `postgres` |
| `SUPABASE_DB_USER` | `postgres.<id-do-projeto>` |
| `SUPABASE_DB_PASSWORD` | a senha do projeto DATA WAREHOUSE |

São os mesmos valores do `ENV` do pipeline, **inclusive a porta**. A skill
[[data-warehouse]] manda usar 6543 (*transaction pooler*) em função serverless, e é
o que o painel de Compras usa. Neste projeto, porém, mediu-se em 25/09/2026, da
própria Vercel: o 6543 conecta mas a consulta trava (*Query read timeout* em ~5s),
enquanto o 5432 responde em 0,95s. Por isso o padrão aqui é **5432**. Se o 6543
voltar ao normal, basta trocar a variável — o código lê a porta do ambiente.

**O primeiro acesso do dia demora.** A função e o pooler acordam juntos: a primeira
chamada depois de um tempo parado leva de 10 a 30 segundos; as seguintes respondem
em menos de 1s. Por isso `maxDuration` é 60s e o `_db.js` refaz a conexão quando o
erro é de conexão. Se o painel demorar às 7h da manhã, é isso — não é erro.

### A exportação

Toda tabela tem **Exportar Excel**, e o arquivo sai formatado: faixa de identidade
da Lube em azul-marinho e dourado, os **filtros aplicados escritos por extenso**
logo abaixo, cabeçalho congelado, **filtro automático** em todas as colunas,
linhas alternadas, valor negativo em vermelho e linha de total.

O que importa mais que o visual: **número vai como número**. Moeda com formato de
moeda, percentual com formato de percentual, data que o Excel entende como data.
Quem recebe consegue somar, ordenar e filtrar sem retrabalho — coisa que um CSV
de texto não permite.

O arquivo é montado em `web/planilha.js`, **sem biblioteca externa**: um `.xlsx` é
um ZIP com alguns XML dentro, e escrevê-lo à mão custa menos código do que o peso
do download de uma biblioteca de CDN — que ainda quebraria se a rede da empresa
bloqueasse o domínio.

### Acesso

Este painel mostra **comissão de vendedor**, nome a nome. Diferente do painel de
Compras, ele nasce com a proteção da Vercel **ligada** (*Settings › Deployment
Protection › Vercel Authentication*): só quem tem conta no time da Lube abre o
link. Se um dia essa proteção for desligada, **atualize este README na mesma
hora** — README que diz ser restrito quando está aberto é pior que nenhum.

---

## Abrir e fechar a margem das filiais

Um sistema separado, que roda **dentro da rede**, substitui oito arquivos `.bat`
que ficavam em `Z:\Alexandre TI\BATS`: quatro punham
`PCPRODFILIAL.PERCMARGEMMIN = 5` e quatro punham `NULL`, um par por filial.

- **Abrir** tira o piso de margem: o produto passa a poder ser vendido abaixo da
  margem naquela filial.
- **Fechar** devolve o piso (o padrao da casa e 5%, mas o valor vai no pedido).

### Onde ele mora

```
etl/servidor_margem.py     programa que fica no ar na maquina do BI
etl/painel_margem.html     a pagina que ele serve
```

Sobe sozinho com a maquina (tarefa **BI Comercial - Servidor de margem**, criada
pelo `instalar_e_agendar.ps1`). Para subir na mao e ver a janela:
`iniciar_servidor_margem.bat`.

Quem esta no comercial abre `http://<maquina-do-bi>:8080` no navegador.

### Por que um programa, e nao um `index.html` na pasta da rede

Um HTML aberto do disco nao executa `.bat` nem fala com o Oracle: o navegador
impede — e ainda bem, senao qualquer pagina da internet tambem conseguiria. A
pagina existe, mas quem executa e o programa, que roda numa maquina so.

E os `.bat` deixam de ser necessarios de proposito: chama-los de volta traria a
senha do WinThor escrita dentro do arquivo e perderia o registro, que era
justamente o que faltava.

### A regra: quem abriu e quem fecha

Quem abriu um produto e o unico que pode fechar **aquele** produto. Sem excecao.
O bloqueio mora em `comercial.margem_registrar`, no banco — nao na tela.

Produto que ja estava aberto **antes** deste sistema nao tem dono (os `.bat` nao
registravam ninguem), entao qualquer um fecha. Isso nao e excecao a regra: e a
ausencia de alguem a quem cobrar. A tela diz isso com todas as letras, e o
painel conta quantos sao.

A tela mostra os donos **antes** de executar: em vez de montar um pedido de 200
codigos e levar um "nao" no final, a pessoa ve, produto a produto, o que e dela
e o que nao e.

### O estado vem do WinThor, nao do nosso registro

A consulta `margem_filial` traz `PCPRODFILIAL.PERCMARGEMMIN` das quatro filiais
a cada carga (137 mil linhas, 6 segundos) para `comercial.fato_margem_filial`. E
dali que sai "o que esta aberto agora". Se alguem mexer por fora — no proprio
WinThor, ou num `.bat` que sobrou em algum lugar — a tela conta a verdade do
mesmo jeito.

Entre uma carga e outra, o proprio agente corrige as linhas que acabou de mudar:
sem isso, um produto aberto as 10h15 pareceria fechado (e portanto sem dono) ate
as 11h, e nesse intervalo qualquer um poderia fechar o que outra pessoa abriu.

### O que os `.bat` nao davam, e agora existe

| | `.bat` | sistema |
|---|---|---|
| Quem pediu, quando e por que | nada | obrigatorio, e fica no historico |
| Valor anterior de cada produto | perdido | gravado em `comercial.margem_alteracao` |
| Quantas linhas mudaram | nao dizia | registrado por pedido |
| Quem pode fechar | qualquer um | so quem abriu |
| Montagem do SQL | texto concatenado com o que foi digitado | *bind*, sempre |
| Senha do WinThor | escrita dentro do arquivo, numa pasta de rede | no `ENV` da maquina |
| Rodar em varias filiais | um arquivo por filial | uma caixa de selecao |
| Saber o que esta aberto | ninguem sabia | painel, com dono e ha quanto tempo |

### Ligando

1. No `ENV` da maquina do BI, `ORACLE_USER_ESCRITA` e `ORACLE_PASSWORD_ESCRITA`
   — um usuario com `UPDATE` em `PCPRODFILIAL`. O usuario do ETL e de leitura e
   continua sendo. Sem isso, o pedido fica com status **erro** e a mensagem
   dizendo o que falta.
2. Opcional, mas recomendado: `MARGEM_PESSOAS="Fulano;Beltrano;Sicrano"`. Com a
   lista, o nome vira uma escolha fechada e a regra de quem fecha vale de
   verdade; sem ela, o nome e digitado livre e vale pelo que a pessoa escreveu.
3. `instalar_e_agendar.ps1` (de novo), que copia o servidor e cria a tarefa que
   o sobe junto com a maquina.
4. Na Vercel, `MARGEM_ENDERECO=http://<maquina>:8080` para o painel apontar o
   caminho certo a quem procurar por la.

### No painel da Vercel: so consulta

A pagina **Operacao › Margem das filiais** mostra o que esta aberto, de quem e,
quem mais abre, quais filiais e o historico — e nao tem botao de executar. O
Oracle nao e alcancavel da Vercel, e um botao que muda o cadastro de produto da
empresa nao precisa existir num endereco publico.

### Para a TI, sem abrir a pagina

```
python agente_margem.py --acao abrir --filiais 1 7 --produtos 1234 5678 \
       --nome "Julio" --motivo "liberacao para a campanha de outubro" --agora
```

Passa pela mesma regra e pelo mesmo registro: nada acontece sem nome e motivo,
e um `fechar` de produto de outra pessoa e recusado igual.

## As consultas

| Página do Power BI | Consulta | Tabela no Supabase | Linhas (ref.) |
|---|---|---|---|
| MARGEM X PRODUTO 5% / 10% | Consulta2 | `comercial.fato_margem_item` | 3.288.372 |
| TABELA COMISSÃO POR RCA -ST · COMISSÃO ST NF | Consulta6 | `comercial.fato_comissao_nf` | 205.503 * |
| DEVOLUÇÕES · DEVOLUÇÕES POR RCA | Consulta3 | `comercial.fato_devolucao` | 12.803 |
| CONSULTA MARGEM 21 | Consulta4 | `comercial.fato_pedido_aberto` | 446 (foto) |
| (dimensão) | PCUSUARI | `core.dim_rca` | — |
| (dimensão) | PCSUPERV | `core.dim_supervisor` | — |
| (dimensão) | PCCLIENT + PCCIDADE | `core.dim_cliente` | — |
| (dimensão) | PCTABDEV | `comercial.dim_motivo_devolucao` | — |
| — | (regra de negócio) | `comercial.dim_faixa_comissao` | 6 |

\* a contagem cai de propósito: o grão mudou (ver diferença 6).

A Consulta1 do Power BI era só um carimbo de data/hora; virou a coluna
`data_carga` de cada tabela e o log em `comercial.controle_carga`.

---

## Segurança

Todas as tabelas estão com **Row Level Security habilitado e sem políticas**: as
chaves públicas (`anon`) do Supabase não leem nem escrevem nada. O ETL não é
afetado porque conecta como dono. Qualquer acesso do painel passa por credencial
de servidor.

As senhas vivem em exatamente dois lugares: o arquivo `ENV` da máquina que roda o
ETL e as variáveis de ambiente do projeto na Vercel. Nunca no repositório.
