# ============================================
# Vercel Deployment Source Downloader
# ============================================



# ============================================================
# Vercel Deployment 전체 소스 복구
# ============================================================

$OutputDir = "C:\dev\vercel-recovery"

# Vercel Token / Deployment ID
# 실행 전에 VERCEL_TOKEN 환경 변수를 설정하세요.
$Token = $env:VERCEL_TOKEN
if ([string]::IsNullOrWhiteSpace($Token)) {
    throw "VERCEL_TOKEN 환경 변수를 설정한 후 다시 실행하세요."
}
$DeploymentId = "dpl_9YYPaeg5UPdRGAeJgynTRDEt8iAz"
# ============================================================
# Vercel Deployment 전체 소스 복구
# - 병렬 다운로드 10개
# - 실패 파일 재시도
# - 진행률 표시
# - 기존 파일 건너뛰기
# ============================================================
# ============================================================
# Vercel Deployment Source Recovery
# Windows PowerShell 5.1 / PowerShell 7
# ============================================================


# Team 프로젝트가 아니면 $null
$TeamId = $null

# ------------------------------------------------------------
# 다운로드 설정
# ------------------------------------------------------------

$MaxParallel = 10
$MaxRetry = 3

# ============================================================
# 기본 설정
# ============================================================

$Headers = @{
    Authorization = "Bearer $Token"
    "Content-Type" = "application/json"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

# ============================================================
# 입력값 검사
# ============================================================

if ([string]::IsNullOrWhiteSpace($Token) -or $Token -eq "YOUR_VERCEL_TOKEN") {
    Write-Host "ERROR: Vercel Token을 입력하세요." -ForegroundColor Red
    exit 1
}

if ([string]::IsNullOrWhiteSpace($DeploymentId) -or $DeploymentId -eq "dpl_YOUR_DEPLOYMENT_ID") {
    Write-Host "ERROR: DeploymentId를 입력하세요." -ForegroundColor Red
    exit 1
}

# ============================================================
# 파일 목록 재귀 처리
# ============================================================

function Get-VercelFiles {
    param(
        $Item,
        [string]$ParentPath = ""
    )

    $Result = @()

    if ($Item.type -eq "directory") {

        $CurrentPath = $Item.name

        if ($ParentPath -ne "") {
            $CurrentPath = "$ParentPath/$($Item.name)"
        }

        if ($null -ne $Item.children) {
            foreach ($Child in $Item.children) {
                $Result += Get-VercelFiles -Item $Child -ParentPath $CurrentPath
            }
        }
    }
    elseif ($Item.type -eq "file") {

        $FilePath = $Item.name

        if ($ParentPath -ne "") {
            $FilePath = "$ParentPath/$($Item.name)"
        }

        $Result += [PSCustomObject]@{
            Name = $Item.name
            Uid = $Item.uid
            RelativePath = $FilePath
        }
    }

    return $Result
}

# ============================================================
# 파일 내용 → Byte[]
# ============================================================

function Convert-ResponseToBytes {
    param(
        $Response
    )

    $ContentType = ""

    if ($null -ne $Response.Headers["Content-Type"]) {
        $ContentType = [string]$Response.Headers["Content-Type"]
    }

    # JSON
    if ($ContentType -match "application/json") {

        $Data = $Response.Content | ConvertFrom-Json

        if ($null -ne $Data.content) {

            if ([string]::IsNullOrWhiteSpace([string]$Data.content)) {
                throw "content is empty"
            }

            return [System.Convert]::FromBase64String([string]$Data.content)
        }

        if ($null -ne $Data.data) {

            if ($Data.data -is [string]) {
                return [System.Convert]::FromBase64String([string]$Data.data)
            }
        }

        throw "JSON content/data not found"
    }

    # 일반 텍스트
    if ($null -ne $Response.Content) {

        $Text = [string]$Response.Content

        if ($Text.Length -gt 0) {
            return [System.Text.Encoding]::UTF8.GetBytes($Text)
        }
    }

    throw "Empty response"
}

# ============================================================
# 단일 파일 다운로드
# ============================================================

function Download-OneFile {
    param(
        [string]$Uid,
        [string]$RelativePath,
        [string]$LocalPath,
        [string]$TokenValue,
        [string]$DeploymentValue,
        [string]$TeamValue,
        [int]$Retry
    )

    $LocalHeaders = @{
        Authorization = "Bearer $TokenValue"
        "Content-Type" = "application/json"
    }

    $EncodedPath = [System.Uri]::EscapeDataString($RelativePath)

    $LastError = ""

    for ($Attempt = 1; $Attempt -le $Retry; $Attempt++) {

        # ====================================================
        # 방법 1 - v8 fileId
        # ====================================================

        try {

            $Url = "https://api.vercel.com/v8/deployments/$DeploymentValue/files/$Uid"

            if (-not [string]::IsNullOrWhiteSpace($TeamValue)) {
                $Url += "?teamId=$TeamValue"
            }

            $Response = Invoke-WebRequest -Uri $Url -Headers $LocalHeaders -Method Get -ErrorAction Stop

            $Bytes = Convert-ResponseToBytes -Response $Response

            if ($Bytes.Length -gt 0) {

                $Parent = Split-Path -Parent $LocalPath

                New-Item -ItemType Directory -Force -Path $Parent | Out-Null

                [System.IO.File]::WriteAllBytes($LocalPath, $Bytes)

                return [PSCustomObject]@{
                    Success = $true
                    Path = $RelativePath
                    Size = $Bytes.Length
                    Error = ""
                }
            }
        }
        catch {
            $LastError = $_.Exception.Message
        }

        # ====================================================
        # 방법 2 - v8 path
        # ====================================================

        try {

            $Url = "https://api.vercel.com/v8/deployments/$DeploymentValue/files/get?path=$EncodedPath"

            if (-not [string]::IsNullOrWhiteSpace($TeamValue)) {
                $Url += "&teamId=$TeamValue"
            }

            $Response = Invoke-WebRequest -Uri $Url -Headers $LocalHeaders -Method Get -ErrorAction Stop

            $Bytes = Convert-ResponseToBytes -Response $Response

            if ($Bytes.Length -gt 0) {

                $Parent = Split-Path -Parent $LocalPath

                New-Item -ItemType Directory -Force -Path $Parent | Out-Null

                [System.IO.File]::WriteAllBytes($LocalPath, $Bytes)

                return [PSCustomObject]@{
                    Success = $true
                    Path = $RelativePath
                    Size = $Bytes.Length
                    Error = ""
                }
            }
        }
        catch {
            $LastError = $_.Exception.Message
        }

        # ====================================================
        # 방법 3 - v6 outputs
        # ====================================================

        try {

            $Url = "https://api.vercel.com/v6/deployments/$DeploymentValue/files/outputs?file=$EncodedPath"

            if (-not [string]::IsNullOrWhiteSpace($TeamValue)) {
                $Url += "&teamId=$TeamValue"
            }

            $Response = Invoke-WebRequest -Uri $Url -Headers $LocalHeaders -Method Get -ErrorAction Stop

            $Bytes = Convert-ResponseToBytes -Response $Response

            if ($Bytes.Length -gt 0) {

                $Parent = Split-Path -Parent $LocalPath

                New-Item -ItemType Directory -Force -Path $Parent | Out-Null

                [System.IO.File]::WriteAllBytes($LocalPath, $Bytes)

                return [PSCustomObject]@{
                    Success = $true
                    Path = $RelativePath
                    Size = $Bytes.Length
                    Error = ""
                }
            }
        }
        catch {
            $LastError = $_.Exception.Message
        }

        # ====================================================
        # 재시도 대기
        # ====================================================

        if ($Attempt -lt $Retry) {
            Start-Sleep -Seconds $Attempt
        }
    }

    return [PSCustomObject]@{
        Success = $false
        Path = $RelativePath
        Size = 0
        Error = $LastError
    }
}

# ============================================================
# 시작
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host " Vercel Deployment Source Recovery"
Write-Host "============================================================"
Write-Host ""

Write-Host "Deployment : $DeploymentId"
Write-Host "Output     : $OutputDir"
Write-Host "Parallel   : $MaxParallel"
Write-Host "Retry      : $MaxRetry"
Write-Host ""

# ============================================================
# 파일 목록 조회
# ============================================================

$TreeUrl = "https://api.vercel.com/v6/deployments/$DeploymentId/files"

if (-not [string]::IsNullOrWhiteSpace($TeamId)) {
    $TreeUrl += "?teamId=$TeamId"
}

try {

    Write-Host "파일 목록 조회 중..."

    $TreeResponse = Invoke-RestMethod `
        -Uri $TreeUrl `
        -Headers $Headers `
        -Method Get `
        -ErrorAction Stop

    Write-Host "파일 목록 조회 완료" -ForegroundColor Green
}
catch {

    Write-Host ""
    Write-Host "파일 목록 조회 실패" -ForegroundColor Red
    Write-Host $_.Exception.Message
    exit 1
}

# ============================================================
# 전체 파일 목록 생성
# ============================================================

$AllFiles = @()

if ($null -ne $TreeResponse.children) {

    foreach ($Item in $TreeResponse.children) {
        $AllFiles += Get-VercelFiles -Item $Item
    }
}
elseif ($TreeResponse -is [System.Array]) {

    foreach ($Item in $TreeResponse) {
        $AllFiles += Get-VercelFiles -Item $Item
    }
}
else {

    $AllFiles += Get-VercelFiles -Item $TreeResponse
}

$TotalFiles = $AllFiles.Count

Write-Host ""
Write-Host "전체 파일 : $TotalFiles"
Write-Host ""

# ============================================================
# 기존 파일 검사
# ============================================================

$DownloadQueue = @()

foreach ($File in $AllFiles) {

    $LocalPath = Join-Path $OutputDir ($File.RelativePath -replace "/", "\")

    $Skip = $false

    if (Test-Path -LiteralPath $LocalPath) {

        try {

            $Existing = Get-Item -LiteralPath $LocalPath

            if ($Existing.Length -gt 0) {
                $Skip = $true
            }
        }
        catch {
        }
    }

    if ($Skip) {
        continue
    }

    $DownloadQueue += [PSCustomObject]@{
        Name = $File.Name
        Uid = $File.Uid
        RelativePath = $File.RelativePath
        LocalPath = $LocalPath
    }
}

$SkippedFiles = $TotalFiles - $DownloadQueue.Count

Write-Host "기존 파일 건너뜀 : $SkippedFiles"
Write-Host "다운로드 대상     : $($DownloadQueue.Count)"
Write-Host ""

if ($DownloadQueue.Count -eq 0) {

    Write-Host "모든 파일이 이미 존재합니다." -ForegroundColor Green
    exit 0
}

# ============================================================
# PowerShell 버전 확인
# ============================================================

if ($PSVersionTable.PSVersion.Major -lt 7) {

    Write-Host ""
    Write-Host "이 병렬 버전은 PowerShell 7 이상이 필요합니다." -ForegroundColor Red
    Write-Host ""
    Write-Host "현재 버전:"
    Write-Host $PSVersionTable.PSVersion
    Write-Host ""
    Write-Host "PowerShell 7에서 다시 실행하세요."
    exit 1
}

# ============================================================
# 병렬 다운로드
# ============================================================

$StartTime = Get-Date

$Results = $DownloadQueue | ForEach-Object -Parallel {

    $File = $_

    $Result = Download-OneFile `
        -Uid $File.Uid `
        -RelativePath $File.RelativePath `
        -LocalPath $File.LocalPath `
        -TokenValue $using:Token `
        -DeploymentValue $using:DeploymentId `
        -TeamValue $using:TeamId `
        -Retry $using:MaxRetry

    return $Result

} -ThrottleLimit $MaxParallel

# ============================================================
# 결과 출력
# ============================================================

$SuccessFiles = 0
$FailedFiles = 0
$TotalBytes = [Int64]0

$Processed = 0

foreach ($Result in $Results) {

    $Processed++

    if ($Result.Success) {

        $SuccessFiles++
        $TotalBytes += [Int64]$Result.Size

        Write-Host "[OK] $($Result.Path)  ($($Result.Size) bytes)" -ForegroundColor Green
    }
    else {

        $FailedFiles++

        Write-Host "[FAILED] $($Result.Path)" -ForegroundColor Red

        if (-not [string]::IsNullOrWhiteSpace($Result.Error)) {
            Write-Host "         $($Result.Error)" -ForegroundColor Yellow
        }
    }

    $Finished = $SkippedFiles + $Processed

    $Percent = [int](($Finished / $TotalFiles) * 100)

    Write-Progress `
        -Activity "Vercel Source Recovery" `
        -Status "$Finished / $TotalFiles" `
        -PercentComplete $Percent
}

Write-Progress `
    -Activity "Vercel Source Recovery" `
    -Completed

# ============================================================
# 완료
# ============================================================

$Elapsed = (Get-Date) - $StartTime

Write-Host ""
Write-Host "============================================================"
Write-Host " 복구 완료"
Write-Host "============================================================"
Write-Host ""

Write-Host "전체 파일 : $TotalFiles"
Write-Host "다운로드  : $SuccessFiles"
Write-Host "실패      : $FailedFiles"
Write-Host "건너뜀    : $SkippedFiles"
Write-Host ("전체 크기 : {0:N0} bytes" -f $TotalBytes)
Write-Host ("소요 시간 : {0:hh\:mm\:ss}" -f $Elapsed)
Write-Host ""
Write-Host "저장 위치 : $OutputDir"
Write-Host ""

if ($FailedFiles -eq 0) {

    Write-Host "모든 파일 복구 성공" -ForegroundColor Green
}
else {

    Write-Host "일부 파일 복구 실패" -ForegroundColor Red
}

Write-Host ""