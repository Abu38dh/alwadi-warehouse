# Run once on the PC that will run the WhatsApp sender (double-click install-startup.cmd):
#  1) closes the OLD program if it is running, and moves its shortcuts out of Windows Startup
#     (kept in backups\old-startup-shortcuts - nothing is deleted)
#  2) makes sure the "WhatsApp Sender" printer exists (asks for administrator approval if it must add it)
#  3) adds the new WhatsApp sender to Windows Startup and starts it now (hidden)
# (ASCII only: Windows PowerShell 5 misreads UTF-8 files without BOM.)
$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$engine  = Join-Path $root 'inovces'
$waData  = Join-Path $root 'warehouse-site\data\whatsapp'
$startup = [Environment]::GetFolderPath('Startup')
$keep    = Join-Path $root 'backups\old-startup-shortcuts'
$vbs     = Join-Path $PSScriptRoot 'start-whatsapp-hidden.vbs'
$name    = 'Alwadi WhatsApp.lnk'
$node    = Join-Path (Join-Path $root 'node') 'node.exe'
if (-not (Test-Path $node)) { $node = 'node' }

if (-not (Test-Path (Join-Path $waData 'vercel-key.txt'))) { Write-Host 'ERROR: vercel-key.txt is missing in warehouse-site\data\whatsapp'; Start-Sleep 8; exit 1 }
if (-not (Test-Path (Join-Path $engine 'index.js')))       { Write-Host 'ERROR: the inovces folder is missing'; Start-Sleep 8; exit 1 }

# 1) old program: close it and take it out of Startup
$old = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*AlwadyInvoiceServer*' -or $_.Path -like '*AlwadyInvoiceClient*' }
foreach ($p in $old) { try { Stop-Process -Id $p.Id -Force -Confirm:$false; Write-Host "Closed old program: $($p.ProcessName)" } catch { } }

New-Item -ItemType Directory -Force $keep | Out-Null
$ws = New-Object -ComObject WScript.Shell
foreach ($lnk in Get-ChildItem $startup -Filter *.lnk) {
  if ($lnk.Name -eq $name) { continue }
  $t = $ws.CreateShortcut($lnk.FullName).TargetPath
  if ($t -like '*AlwadyInvoiceServer*' -or $t -like '*AlwadyInvoiceClient*') {
    Move-Item $lnk.FullName -Destination $keep -Force
    Write-Host "Moved old shortcut out of Startup: $($lnk.Name)"
  }
}

# 2) the printer
if (-not (Get-Printer -Name 'WhatsApp Sender' -ErrorAction SilentlyContinue)) {
  Write-Host 'Adding the "WhatsApp Sender" printer (approve the Windows prompt)...'
  try { Push-Location $engine; & $node printer-setup.js install; Pop-Location } catch { Write-Host "Printer setup failed: $_" }
} else {
  Write-Host 'Printer "WhatsApp Sender" is already installed.'
}

# 3) Startup + start now
$s = $ws.CreateShortcut((Join-Path $startup $name))
$s.TargetPath = 'wscript.exe'
$s.Arguments = '"' + $vbs + '"'
$s.WorkingDirectory = $PSScriptRoot
$s.Save()
Write-Host "Added to Windows Startup: $name"

$busy = $false
try { $busy = [bool](Get-NetTCPConnection -LocalPort 4101 -State Listen -ErrorAction SilentlyContinue) } catch { }
if (-not $busy) {
  Start-Process wscript.exe -ArgumentList ('"' + $vbs + '"')
  Write-Host 'Started the WhatsApp sender.'
} else {
  Write-Host 'The WhatsApp sender is already running.'
}
Write-Host ''
Write-Host 'Done. Open the site > WhatsApp page to check the connection (scan the QR code if it asks).'
Start-Sleep -Seconds 6
