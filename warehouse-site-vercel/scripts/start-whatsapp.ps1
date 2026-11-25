# Start the WhatsApp sender on the company PC, connected to the Vercel site.
# Uses the same WhatsApp data folder as the local site (same login, no new QR scan).
# (ASCII only: Windows PowerShell 5 misreads UTF-8 files without BOM.)
$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$engine  = Join-Path $root 'inovces'
$waData  = Join-Path $root 'warehouse-site\data\whatsapp'
$keyFile = Join-Path $waData 'vercel-key.txt'
$backups = Join-Path $root 'backups\whatsapp'

if (-not (Test-Path $keyFile)) { throw "Connection key not found: $keyFile" }

$env:ALWADY_HOSTED        = '1'
$env:ALWADY_NO_WINDOW     = '1'
# This PC has the "WhatsApp Sender" printer: capture what is printed on it directly.
$env:ALWADY_PRINT_CAPTURE = '1'
$env:PORT                 = '4100'
$env:ALWADY_LOCK_PORT     = '4101'
$env:ALWADY_DATA_DIR      = $waData
$env:INVOICES_DIR         = Join-Path $waData 'documents'
$env:WAREHOUSE_OUTBOX_DIR = Join-Path $waData 'warehouse-outbox'
$env:WAREHOUSE_SITE_URL   = 'https://alwadi-warehouse.vercel.app'
$env:WAREHOUSE_API_KEY    = (Get-Content $keyFile -Raw).Trim()
Remove-Item Env:DRY_RUN -ErrorAction SilentlyContinue

# Daily backup of the WhatsApp data (login, customers list, activity log, settings). Keeps 14 days.
# Same disk only: protects against a damaged file, not against losing the PC.
function Backup-WhatsAppData {
  try {
    $day = Join-Path $backups (Get-Date -Format 'yyyy-MM-dd')
    if (Test-Path $day) { return }
    New-Item -ItemType Directory -Force $day | Out-Null
    Get-ChildItem $waData -File -Filter *.json | Copy-Item -Destination $day -Force
    Copy-Item $keyFile -Destination $day -Force
    foreach ($d in '.baileys_auth', 'warehouse-outbox') {
      $src = Join-Path $waData $d
      if (Test-Path $src) { Copy-Item $src -Destination (Join-Path $day $d) -Recurse -Force }
    }
    Get-ChildItem $backups -Directory | Sort-Object Name -Descending | Select-Object -Skip 14 | Remove-Item -Recurse -Force -Confirm:$false
  } catch { }
}

# Use the bundled Node (a "node" folder next to the other folders) when present, otherwise the installed one.
$node = Join-Path (Join-Path $root 'node') 'node.exe'
if (-not (Test-Path $node)) { $node = 'node' }
Set-Location $engine
# Run through cmd: PowerShell 5 turns any stderr line into a terminating error and writes UTF-16 logs.
$ErrorActionPreference = 'Continue'
$log = Join-Path $waData 'engine-vercel.log'
# If it stops for any reason it starts again after 15 seconds.
# (A second copy exits by itself: the program holds a lock on port 4101.)
while ($true) {
  Backup-WhatsAppData
  # Keep the log from growing forever: start a new one above 20 MB (one old copy is kept).
  if ((Test-Path $log) -and ((Get-Item $log).Length -gt 20MB)) { Move-Item $log "$log.old" -Force }
  cmd.exe /c "`"$node`" index.js >> `"$log`" 2>&1"
  Start-Sleep -Seconds 15
}
