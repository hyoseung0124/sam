param(
  [string]$OutputDir = ".certs",
  [string[]]$ServerDnsNames = @("localhost"),
  [string[]]$ServerIpAddresses = @("127.0.0.1"),
  [string]$PfxPassword = "changeit"
)

$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $PSScriptRoot
$outputPath = Join-Path $workspace $OutputDir
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null

$hostname = [System.Net.Dns]::GetHostName()
if ($hostname -and -not ($ServerDnsNames -contains $hostname)) {
  $ServerDnsNames += $hostname
}

$localIpv4 = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -ne '127.0.0.1' } |
  Select-Object -ExpandProperty IPAddress -Unique

foreach ($ip in $localIpv4) {
  if (-not ($ServerIpAddresses -contains $ip)) {
    $ServerIpAddresses += $ip
  }
}

$rootSubject = "CN=SAM Internal Root CA"
$rootCert = New-SelfSignedCertificate `
  -Type Custom `
  -Subject $rootSubject `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -KeyUsage CertSign, CRLSign, DigitalSignature `
  -TextExtension @("2.5.29.19={text}CA=true&pathlength=1") `
  -NotAfter (Get-Date).AddYears(10)

$sanEntries = @()
foreach ($dns in $ServerDnsNames) {
  if ($dns) { $sanEntries += "dns=$dns" }
}
foreach ($ip in $ServerIpAddresses) {
  if ($ip) { $sanEntries += "ipaddress=$ip" }
}

if ($sanEntries.Count -eq 0) {
  throw "At least one DNS or IP SAN entry is required."
}

$sanText = "2.5.29.17={text}" + ($sanEntries -join "&")
$serverSubject = "CN=$($ServerDnsNames[0])"

$serverCert = New-SelfSignedCertificate `
  -Type Custom `
  -Subject $serverSubject `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -Signer $rootCert `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -TextExtension @(
    $sanText,
    "2.5.29.37={text}1.3.6.1.5.5.7.3.1"
  ) `
  -NotAfter (Get-Date).AddYears(3)

$rootCerPath = Join-Path $outputPath "sam-root-ca.cer"
$serverPfxPath = Join-Path $outputPath "sam-server.pfx"

$securePassword = ConvertTo-SecureString -String $PfxPassword -AsPlainText -Force
Export-Certificate -Cert $rootCert -FilePath $rootCerPath -Force | Out-Null
Export-PfxCertificate -Cert $serverCert -FilePath $serverPfxPath -Password $securePassword -Force | Out-Null

Write-Host "Generated internal HTTPS certificate files:"
Write-Host "- Root CA:  $rootCerPath"
Write-Host "- Server PFX: $serverPfxPath"
Write-Host ""
Write-Host "Next steps:"
Write-Host "1) On every client PC, install root CA cert to Trusted Root:"
Write-Host "   npm run cert:trust:internal"
Write-Host "2) Start HTTPS server:"
Write-Host "   npm run start:https"
