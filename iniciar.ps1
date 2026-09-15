$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$presenciaConfig = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
$presenciaUri = [Uri]$presenciaConfig.backend_url
if ($presenciaUri.Host -in @('localhost', '127.0.0.1') -and $presenciaUri.Port -eq 5000) {
    $presenciaSocket = New-Object System.Net.Sockets.TcpClient
    try { $presenciaSocket.Connect($presenciaUri.Host, 5000); $presenciaActivo = $true }
    catch { $presenciaActivo = $false }
    finally { $presenciaSocket.Dispose() }
    if (-not $presenciaActivo) {
        $presenciaBackend = Join-Path (Split-Path $PSScriptRoot -Parent) 'backend'
        $presenciaPython = Join-Path $presenciaBackend 'venv\Scripts\python.exe'
        $presenciaApi = Join-Path $presenciaBackend 'run_presencia.py'
        if (-not (Test-Path -LiteralPath $presenciaPython) -or -not (Test-Path -LiteralPath $presenciaApi)) {
            throw 'No se encontro el backend local. Configura backend_url con la direccion del sistema en config.json.'
        }
        Write-Host 'Iniciando consulta local de asistencia...'
        Start-Process -FilePath $presenciaPython -ArgumentList @('run_presencia.py') -WorkingDirectory $presenciaBackend -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'api.out.log') -RedirectStandardError (Join-Path $PSScriptRoot 'api.err.log')
        Start-Sleep -Seconds 2
    }
}
Write-Host "Abrir http://localhost:$($presenciaConfig.port)"
python server.py
