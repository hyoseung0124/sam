$Token = $env:VERCEL_TOKEN
if ([string]::IsNullOrWhiteSpace($Token)) {
    throw "VERCEL_TOKEN 환경 변수를 설정한 후 다시 실행하세요."
}
$DeploymentId = "dpl_9YYPaeg5UPdRGAeJgynTRDEt8iAz"

$Headers = @{
    Authorization = "Bearer $Token"
}

$Tree = Invoke-RestMethod `
    -Uri "https://api.vercel.com/v6/deployments/$DeploymentId/files" `
    -Headers $Headers `
    -Method Get

$Tree | Format-List * -Force