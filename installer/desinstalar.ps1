# Desinstala BitChord (la app y sus accesos directos). Tus ajustes quedan en %APPDATA%\BitChord.
$ErrorActionPreference = 'SilentlyContinue'
Get-Process -Name 'BitChord' | Stop-Process -Force
Start-Sleep -Milliseconds 500
Remove-Item (Join-Path ([Environment]::GetFolderPath('Desktop')) 'BitChord.lnk') -Force
Remove-Item (Join-Path ([Environment]::GetFolderPath('Programs')) 'BitChord.lnk') -Force
Remove-Item (Join-Path $env:LOCALAPPDATA 'Programs\BitChord') -Recurse -Force
Write-Host 'BitChord se ha desinstalado.' -ForegroundColor Green
Start-Sleep -Seconds 2
