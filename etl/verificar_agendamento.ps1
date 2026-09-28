# verificar_agendamento.ps1
#
# Mostra se as tarefas do BI Comercial estao rodando: ultimo horario, resultado,
# proxima execucao e as ultimas linhas do log. Nao altera nada.
#
# Como rodar (nao precisa ser administrador):
#   cd "P:\INTEGRACAO BI\COMERCIAL"      <- o nome real da pasta tem acentos
#   powershell -ExecutionPolicy Bypass -File .\verificar_agendamento.ps1
#
# Salvo em UTF-8 com BOM, e a pasta vem do $PSScriptRoot em vez de caminho
# escrito a mao - o Windows PowerShell le .ps1 como ANSI quando nao ha BOM, e
# ai acento em caminho vira lixo.

$ErrorActionPreference = "Stop"

$pasta = $PSScriptRoot
if (-not $pasta) { $pasta = (Get-Location).Path }

function Traduzir-Resultado {
    param($Codigo)
    switch ($Codigo) {
        0          { "concluiu sem erro" }
        1          { "o script terminou com erro - veja o log" }
        267009     { "esta rodando agora" }
        267011     { "ainda nao rodou nenhuma vez" }
        267014     { "foi interrompida" }
        2147942401 { "nao encontrou o programa (pythonw.exe)" }
        2147943726 { "usuario ou senha incorretos no cadastro da tarefa" }
        default    { "codigo $Codigo - consulte o log" }
    }
}

Write-Host ""
Write-Host "==================== TAREFAS AGENDADAS ====================" -ForegroundColor Cyan
Write-Host "Pasta: $pasta"

$nomes = @("BI Comercial - Sync rapidas", "BI Comercial - Sync margem")
$achou = $false

foreach ($nome in $nomes) {
    $tarefa = $null
    $erro = $null
    try { $tarefa = Get-ScheduledTask -TaskName $nome -ErrorAction Stop }
    catch { $erro = $_.Exception.Message }

    if (-not $tarefa) {
        Write-Host ""
        Write-Host "  $nome" -ForegroundColor Yellow
        # "Acesso negado" NAO quer dizer que a tarefa nao existe: tarefa criada
        # com senha guardada so aparece para sessao com privilegio elevado.
        if ($erro -match "negad|denied|0x80070005") {
            Write-Host "    Nao consigo VER esta tarefa desta janela." -ForegroundColor Yellow
            Write-Host "    Isso nao quer dizer que ela nao existe: tarefa criada com senha"
            Write-Host "    guardada so e visivel para uma janela de administrador."
            Write-Host "    Abra o PowerShell como administrador e rode:"
            Write-Host ("      Get-ScheduledTask -TaskName `"" + $nome + "`" | Get-ScheduledTaskInfo") -ForegroundColor White
        } else {
            Write-Host "    NAO EXISTE - rode o instalar_e_agendar.ps1." -ForegroundColor Yellow
            if ($erro) { Write-Host "    ($erro)" -ForegroundColor DarkGray }
        }
        continue
    }
    $achou = $true
    $info = $tarefa | Get-ScheduledTaskInfo

    $estado = if ($tarefa.State -eq "Disabled") { "DESATIVADA" } else { "$($tarefa.State)" }
    $corEstado = if ($tarefa.State -eq "Disabled") { "Red" } else { "Green" }

    Write-Host ""
    Write-Host "  $nome" -ForegroundColor White
    Write-Host "    estado          : " -NoNewline
    Write-Host $estado -ForegroundColor $corEstado
    Write-Host "    ultima execucao : $($info.LastRunTime)"
    Write-Host "    resultado       : $(Traduzir-Resultado $info.LastTaskResult)"
    Write-Host "    proxima         : $($info.NextRunTime)"

    $horarios = ($tarefa.Triggers | ForEach-Object {
        if ($_.StartBoundary) { ([datetime]$_.StartBoundary).ToString("HH:mm") }
    }) -join ", "
    if ($horarios) { Write-Host "    horarios        : $horarios" }

    $acao = $tarefa.Actions | Select-Object -First 1
    if ($acao.Execute) {
        $semJanela = if ($acao.Execute -match "pythonw") { "sim (pythonw)" } else { "NAO - esta usando $($acao.Execute)" }
        Write-Host "    roda invisivel  : $semJanela"
    }
    if ($acao.Arguments) {
        # Se o caminho for um drive mapeado (P:\), a tarefa falha quando roda
        # com o usuario deslogado, porque o mapeamento nao existe nessa sessao.
        $alerta = if ($acao.Arguments -match '^"?[A-Za-z]:\\') { "  <-- ATENCAO: drive mapeado, deveria ser \\servidor\..." } else { "" }
        Write-Host "    script          : $($acao.Arguments)$alerta"
    }
}

if (-not $achou) {
    Write-Host ""
    Write-Host "Nenhuma tarefa encontrada." -ForegroundColor Red
    Write-Host ""
    exit 1
}

# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "==================== ULTIMAS LINHAS DO LOG ====================" -ForegroundColor Cyan

$log = Join-Path $pasta "sync_bi_comercial.log"
if (Test-Path -LiteralPath $log) {
    $arq = Get-Item -LiteralPath $log
    $tamanho = [math]::Round($arq.Length / 1KB, 1)
    Write-Host ""
    Write-Host "  $($arq.Name)  ($tamanho KB, modificado em $($arq.LastWriteTime))"
    Write-Host ""
    Get-Content -LiteralPath $log -Tail 25 | ForEach-Object {
        $cor = if ($_ -match "\[ERROR\]|FALHOU|Traceback") { "Red" }
               elseif ($_ -match "\[WARNING\]|ATENCAO") { "Yellow" }
               else { "Gray" }
        Write-Host "  $_" -ForegroundColor $cor
    }
} else {
    Write-Host ""
    Write-Host "  Ainda nao existe o arquivo sync_bi_comercial.log." -ForegroundColor Yellow
    Write-Host "  Ele aparece depois da primeira execucao."
}

Write-Host ""
Write-Host "Para forcar uma execucao agora, sem esperar o horario:" -ForegroundColor Cyan
Write-Host '  Start-ScheduledTask -TaskName "BI Comercial - Sync rapidas"'
Write-Host ""
