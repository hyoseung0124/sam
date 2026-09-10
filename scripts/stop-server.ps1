param(
  [int]$Port = 4173
)

$ErrorActionPreference = 'Stop'

$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $listeners) {
  Write-Host "No server is listening on port $Port."
  exit 0
}

$pids = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
$stopped = @()

foreach ($id in $pids) {
  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
    Stop-Process -Id $id -Force -ErrorAction Stop
    $name = if ($proc) { $proc.Name } else { 'unknown' }
    $cmd = if ($proc) { $proc.CommandLine } else { '' }
    $stopped += [PSCustomObject]@{
      PID = $id
      Name = $name
      CommandLine = $cmd
    }
  } catch {
    Write-Warning "Failed to stop process PID=${id}: $($_.Exception.Message)"
  }
}

if ($stopped.Count -eq 0) {
  Write-Host "No processes were stopped on port $Port."
  exit 1
}

Write-Host "Stopped processes on port ${Port}:"
$stopped | Format-Table -AutoSize
