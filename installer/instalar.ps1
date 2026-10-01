# Instalador de BitChord para Windows.
# Descarga el motor (Electron) desde GitHub, lo verifica y monta la app en %LOCALAPPDATA%\Programs\BitChord.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ElectronVersion = '44.4.5'
$ElectronSha256  = '11c395820a5aaa8ebcc0686b476d0ac98a730274ebfbdc8cf5538a7c2815cb5d'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:LOCALAPPDATA 'Programs\BitChord'
$zip  = Join-Path $env:TEMP "electron-v$ElectronVersion-win32-x64.zip"

function Paso($t) { Write-Host "`n> $t" -ForegroundColor Magenta }

try {
  Write-Host '=============================================' -ForegroundColor DarkMagenta
  Write-Host '        Instalador de BitChord (Windows)      ' -ForegroundColor White
  Write-Host '=============================================' -ForegroundColor DarkMagenta

  if (-not (Test-Path (Join-Path $here 'app.asar'))) { throw 'No encuentro app.asar. Descomprime el ZIP completo antes de instalar.' }

  Paso 'Cerrando BitChord si estaba abierto...'
  Get-Process -Name 'BitChord' -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 500

  $needDownload = $true
  if (Test-Path $zip) {
    if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -eq $ElectronSha256) { $needDownload = $false }
  }
  if ($needDownload) {
    Paso "Descargando el motor de la app (Electron $ElectronVersion, ~150 MB). Puede tardar unos minutos..."
    $url = "https://github.com/electron/electron/releases/download/v$ElectronVersion/electron-v$ElectronVersion-win32-x64.zip"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    Paso 'Verificando la descarga...'
    $hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($hash -ne $ElectronSha256) { Remove-Item $zip -Force; throw "La descarga está corrupta (SHA256 $hash). Vuelve a intentarlo." }
  } else {
    Paso 'Motor ya descargado y verificado.'
  }

  Paso "Instalando en $dest ..."
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  New-Item -ItemType Directory -Path $dest | Out-Null
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path $tar) { & $tar -xf $zip -C $dest; if ($LASTEXITCODE -ne 0) { throw 'No se pudo descomprimir el motor.' } }
  else { Expand-Archive -Path $zip -DestinationPath $dest -Force }
  Rename-Item (Join-Path $dest 'electron.exe') 'BitChord.exe'
  Remove-Item (Join-Path $dest 'resources\default_app.asar') -Force -ErrorAction SilentlyContinue
  Get-ChildItem (Join-Path $dest 'locales') | Where-Object { $_.Name -notmatch '^(es|es-419|en-US|en-GB)\.pak$' } | Remove-Item -Force
  Remove-Item (Join-Path $dest 'resources\app.asar.new') -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $dest 'resources\current.txt'), (Join-Path $dest 'resources\update.bin') -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $here 'app.asar') (Join-Path $dest 'resources\app.asar') -Force
  Copy-Item (Join-Path $here 'icon.ico') (Join-Path $dest 'BitChord.ico') -Force
  Copy-Item (Join-Path $here 'desinstalar.ps1') (Join-Path $dest 'desinstalar.ps1') -Force
  Copy-Item (Join-Path $here 'LICENSE') (Join-Path $dest 'LICENSE.BitChord.txt') -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $here 'CAMBIOS.txt') (Join-Path $dest 'CAMBIOS.txt') -Force -ErrorAction SilentlyContinue

  Paso 'Creando accesos directos (Escritorio y menú Inicio)...'
  $shell = New-Object -ComObject WScript.Shell
  $targets = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'BitChord.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'BitChord.lnk')
  )
  foreach ($lnkPath in $targets) {
    $lnk = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath = Join-Path $dest 'BitChord.exe'
    $lnk.WorkingDirectory = $dest
    $lnk.IconLocation = (Join-Path $dest 'BitChord.ico') + ',0'
    $lnk.Description = 'BitChord - cliente de YouTube Music'
    $lnk.Save()
  }

  Write-Host "`nListo. BitChord está instalado." -ForegroundColor Green
  Write-Host 'Lo tienes en el Escritorio y en el menú Inicio. Abriéndolo ahora...'
  Start-Process (Join-Path $dest 'BitChord.exe')
  Start-Sleep -Seconds 3
}
catch {
  Write-Host "`nERROR: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Pulsa una tecla para cerrar.'
  [void][System.Console]::ReadKey($true)
  exit 1
}
