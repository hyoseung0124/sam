param(
  [int]$Port = 4173
)

$ErrorActionPreference = 'Stop'

$workspace = Split-Path -Parent $PSScriptRoot

& powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'stop-server.ps1') -Port $Port

$pfxPath = Join-Path $workspace '.certs/sam-server.pfx'
if (-not (Test-Path $pfxPath)) {
  throw "HTTPS certificate file not found: $pfxPath"
}

Push-Location $workspace
try {
  & node local-file-server.mjs --https --host 0.0.0.0 --port $Port --pfx $pfxPath --pfx-pass changeit
} finally {
  Pop-Location
}
