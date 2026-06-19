# Download public video files for Sitrec legacy sitches (Gimbal, GoFast, etc.)
# Usage: irm https://raw.githubusercontent.com/MickWest/Sitrec2/main/download-videos.ps1 | iex
#
# These videos are only needed to run legacy analysis sitches locally.
# They can also be viewed online at https://www.metabunk.org/sitrec

$ErrorActionPreference = "Stop"

$DropboxUrl = "https://www.dropbox.com/scl/fo/biko4zk689lgh5m5ojgzw/h?rlkey=stuaqfig0f369jzujgizsicyn&dl=1"
$Dest = "sitrec-videos\public"
$ZipFile = "sitrec-videos-public.zip"

if (Test-Path -LiteralPath "docker-compose.yml") {
    # Already in the install folder.
} elseif (Test-Path -LiteralPath (Join-Path "sitrec" "docker-compose.yml")) {
    Set-Location -LiteralPath "sitrec"
} else {
    throw "[sitrec] ERROR: run this from your Sitrec install folder, or from the folder that contains it. Expected docker-compose.yml or sitrec\docker-compose.yml."
}

if (-not (Select-String -LiteralPath "docker-compose.yml" -Pattern "sitrec-videos" -Quiet)) {
    Write-Host "[sitrec] WARNING: docker-compose.yml does not mount sitrec-videos/." -ForegroundColor Yellow
    Write-Host "[sitrec] The current installer adds this by default; older installs may need reinstalling or manual compose edits." -ForegroundColor Yellow
}

if ((Test-Path $Dest) -and (Get-ChildItem $Dest -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0) {
    Write-Host "[sitrec] $Dest already exists and is not empty. Skipping download." -ForegroundColor Yellow
    Write-Host "[sitrec] To re-download, remove the folder first: Remove-Item -Recurse sitrec-videos"
    exit 0
}

New-Item -ItemType Directory -Path $Dest -Force | Out-Null

Write-Host "[sitrec] Downloading public video files (~1.3 GB)..."
Write-Host "[sitrec] This may take a few minutes depending on your connection."
Write-Host ""

Invoke-WebRequest -Uri $DropboxUrl -OutFile $ZipFile

Write-Host "[sitrec] Extracting..."
Expand-Archive -Path $ZipFile -DestinationPath $Dest -Force
Remove-Item $ZipFile -Force

Write-Host ""
Write-Host "[sitrec] Videos downloaded to $Dest\"
Write-Host "[sitrec] Restart the container to pick them up:"
if (Test-Path -LiteralPath "sitrec.cmd") {
    Write-Host "  .\sitrec.cmd restart"
} elseif (Test-Path -LiteralPath "sitrec.ps1") {
    Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File .\sitrec.ps1 restart"
} else {
    Write-Host "  docker compose down && docker compose up"
}
