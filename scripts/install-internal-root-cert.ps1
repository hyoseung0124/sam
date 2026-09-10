param(
  [string]$RootCertPath = ".certs/sam-root-ca.cer"
)

$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $PSScriptRoot
$fullPath = if ([System.IO.Path]::IsPathRooted($RootCertPath)) {
  $RootCertPath
} else {
  Join-Path $workspace $RootCertPath
}

if (-not (Test-Path $fullPath)) {
  throw "Root certificate file not found: $fullPath"
}

Import-Certificate -FilePath $fullPath -CertStoreLocation "Cert:\CurrentUser\Root" | Out-Null
Write-Host "Installed root CA to CurrentUser Trusted Root store: $fullPath"
