@echo off
rem ===========================================================================
rem  Diz, numa tela so, se o sistema de abertura de margem esta no ar nesta
rem  maquina - e qual endereco o pessoal do comercial deve usar.
rem
rem  Rode na maquina onde o servidor deveria estar rodando. Nao muda nada:
rem  so olha e conta.
rem ===========================================================================
setlocal
powershell -ExecutionPolicy Bypass -NoProfile -Command ^
  "$ErrorActionPreference='SilentlyContinue';" ^
  "Write-Host '';" ^
  "Write-Host '==============================================================' -ForegroundColor Cyan;" ^
  "Write-Host ' ABERTURA DE MARGEM - como esta esta maquina' -ForegroundColor Cyan;" ^
  "Write-Host '==============================================================' -ForegroundColor Cyan;" ^
  "Write-Host '';" ^
  "Write-Host ('Maquina : ' + $env:COMPUTERNAME);" ^
  "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { Write-Host ('IP      : ' + $_.IPAddress + '  (' + $_.PrefixOrigin + ')') };" ^
  "Write-Host '';" ^
  "$t = Get-ScheduledTask -TaskName 'BI Comercial - Servidor de margem';" ^
  "if ($t) { $i = Get-ScheduledTaskInfo -TaskName 'BI Comercial - Servidor de margem';" ^
  "  Write-Host ('Tarefa  : existe, modo ' + $t.Principal.LogonType) -ForegroundColor Green;" ^
  "  Write-Host ('Ultima  : ' + $i.LastRunTime);" ^
  "  if ($i.LastTaskResult -eq 267009) { Write-Host 'Situacao: RODANDO' -ForegroundColor Green }" ^
  "  else { Write-Host ('Situacao: PARADA (codigo ' + $i.LastTaskResult + ')') -ForegroundColor Red } }" ^
  "else { Write-Host 'Tarefa  : NAO EXISTE nesta maquina' -ForegroundColor Red };" ^
  "Write-Host '';" ^
  "$p = Get-NetTCPConnection -LocalPort 8080 -State Listen;" ^
  "if ($p) { Write-Host ('Porta   : 8080 escutando em ' + ($p[0].LocalAddress)) -ForegroundColor Green }" ^
  "else { Write-Host 'Porta   : NADA escutando na 8080' -ForegroundColor Red };" ^
  "$fw = Get-NetFirewallRule | Where-Object { $_.DisplayName -like '*Abertura de margem*' -and $_.Enabled -eq 'True' };" ^
  "if ($fw) { Write-Host 'Firewall: liberado' -ForegroundColor Green }" ^
  "else { Write-Host 'Firewall: SEM a regra da porta 8080' -ForegroundColor Red };" ^
  "Write-Host '';" ^
  "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/api/saude' -UseBasicParsing -TimeoutSec 8;" ^
  "  Write-Host 'Resposta: o servidor respondeu' -ForegroundColor Green;" ^
  "  Write-Host '';" ^
  "  Write-Host '  ENDERECO PARA O COMERCIAL:' -ForegroundColor Yellow;" ^
  "  Write-Host ('     http://' + $env:COMPUTERNAME + ':8080') -ForegroundColor Yellow }" ^
  "catch { Write-Host ('Resposta: NAO respondeu - ' + $_.Exception.Message) -ForegroundColor Red };" ^
  "Write-Host '';" ^
  "Write-Host '--- ultimas linhas dos registros --------------------------' -ForegroundColor DarkGray;" ^
  "foreach ($n in @('servidor_margem.log','agente_margem.log')) {" ^
  "  $c = Join-Path 'C:\BI\COMERCIAL' $n;" ^
  "  Write-Host '';" ^
  "  if (Test-Path -LiteralPath $c) {" ^
  "    $linhas = Get-Content -LiteralPath $c -Tail 12;" ^
  "    if ($linhas) { Write-Host ($n + ':') -ForegroundColor DarkGray; $linhas | ForEach-Object { Write-Host ('  ' + $_) } }" ^
  "    else { Write-Host ($n + ': vazio') -ForegroundColor DarkGray } }" ^
  "  else { Write-Host ($n + ': nao existe') -ForegroundColor DarkGray } };" ^
  "Write-Host ''"
echo.
pause
