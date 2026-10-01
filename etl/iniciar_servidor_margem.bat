@echo off
rem ===========================================================================
rem  Sobe o sistema de abertura de margem das filiais.
rem
rem  Este e o UNICO .bat que sobrou desta historia. Ele nao mexe em nada no
rem  WinThor: so liga o programa que serve a pagina. Os oito .bat antigos
rem  (Definir_margen_5_filial_*.bat e zera_margem_filial*.bat) foram
rem  substituidos pelo sistema, que registra quem fez, quando e por que - e nao
rem  carrega a senha do WinThor escrita dentro do arquivo.
rem
rem  Normalmente ele nem precisa ser usado: o instalador cria uma tarefa que
rem  sobe o servidor sozinho quando a maquina liga. Use isto para subir na mao,
rem  ou para ver o que esta acontecendo numa janela.
rem ===========================================================================
setlocal
cd /d "%~dp0"

rem Na pasta de rede este arquivo fica numa subpasta, longe dos outros scripts.
rem O programa so roda onde esta instalado de verdade, porque precisa dos
rem vizinhos (agente_margem.py, bi_comum.py) e do ENV. Entao: se os vizinhos
rem nao estiverem aqui, vai para a instalacao.
if not exist "bi_comum.py" (
    if exist "C:\BI\COMERCIAL\servidor_margem.py" (
        echo.
        echo   Rodando a partir da instalacao em C:\BI\COMERCIAL
        cd /d "C:\BI\COMERCIAL"
    ) else (
        echo.
        echo   Nao achei a instalacao em C:\BI\COMERCIAL.
        echo.
        echo   Este atalho so funciona na maquina onde o BI esta instalado.
        echo   Se e esta a maquina, rode antes o "INSTALAR TUDO.bat" que esta
        echo   na raiz da pasta de rede.
        echo.
        pause
        exit /b 1
    )
)

echo.
echo   Abertura de margem - Lube Distribuidora
echo   ---------------------------------------
echo   Subindo o servidor. O endereco aparece abaixo; e ele que o pessoal do
echo   comercial abre no navegador.
echo.

python servidor_margem.py %*

echo.
echo   O servidor parou. Se nao foi voce que fechou, veja o servidor_margem.log
echo   nesta pasta - o motivo esta escrito la.
echo.
pause
