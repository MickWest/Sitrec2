# Sitrec one-liner installer for Windows PowerShell
# Usage: irm https://raw.githubusercontent.com/MickWest/Sitrec2/main/install.ps1 | iex
#   or:  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/MickWest/Sitrec2/main/install.ps1))) -Podman
#   or:  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Tarball sitrec-image.tar
#   or:  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Offline -Image sitrec-configured:latest

$ErrorActionPreference = "Stop"

$Dir = "sitrec"
$Image = "ghcr.io/mickwest/sitrec2"
$InstallImage = "${Image}:latest"
$ForceRuntime = ""
$Offline = $false
$UseTarball = $false
$TarballPath = ""
$MountVideos = $true
$BakeMode = $false
$BakeTarget = ""
$BakeEnvFile = ".env"
$BakeBaseTag = "latest"
$BakePush = $false
$BakeTarball = $false
$BakeTarballPath = ""

function Show-Usage {
    Write-Host "Usage: powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 [options]"
    Write-Host ""
    Write-Host "Install options:"
    Write-Host "  -Docker              Force Docker Desktop"
    Write-Host "  -Podman              Force Podman"
    Write-Host "  -Image <image>       Install/run a specific image"
    Write-Host "  -Tarball [path]      Load image from a .tar file"
    Write-Host "  -Offline             Skip image pull; image must already be loaded"
    Write-Host "  -Videos              Mount sitrec-videos/ for legacy sitches (default)"
    Write-Host "  -NoVideos            Do not mount sitrec-videos/"
    Write-Host ""
    Write-Host "Bake options:"
    Write-Host "  -Bake <image>        Build a pre-configured image and exit"
    Write-Host "  -EnvFile <file>      Env file to bake in (default: .env)"
    Write-Host "  -Base <tag>          Base Sitrec image tag (default: latest)"
    Write-Host "  -Push                Push the baked image"
    Write-Host "  -Tarball [path]      In bake mode, save the baked image to a tarball"
}

for ($i = 0; $i -lt $args.Count; $i++) {
    $arg = $args[$i]
    switch -Regex ($arg.ToLowerInvariant()) {
        '^--?help$|^/\?$' {
            Show-Usage
            exit 0
        }
        '^--?podman$' { $ForceRuntime = "podman" }
        '^--?docker$' { $ForceRuntime = "docker" }
        '^--?offline$' { $Offline = $true }
        '^--?videos$' { $MountVideos = $true }
        '^--?no-videos$|^--?novideos$' { $MountVideos = $false }
        '^--?push$' { $BakePush = $true }
        '^--?image$' {
            if ($i + 1 -ge $args.Count -or $args[$i + 1].StartsWith("-")) {
                throw "[sitrec] ERROR: -Image requires an image name."
            }
            $InstallImage = $args[++$i]
        }
        '^--?bake$' {
            $BakeMode = $true
            if ($i + 1 -lt $args.Count -and -not $args[$i + 1].StartsWith("-")) {
                $BakeTarget = $args[++$i]
            }
        }
        '^--?env-file$|^--?envfile$' {
            if ($i + 1 -ge $args.Count -or $args[$i + 1].StartsWith("-")) {
                throw "[sitrec] ERROR: -EnvFile requires a path."
            }
            $BakeEnvFile = $args[++$i]
        }
        '^--?base$' {
            if ($i + 1 -ge $args.Count -or $args[$i + 1].StartsWith("-")) {
                throw "[sitrec] ERROR: -Base requires a tag."
            }
            $BakeBaseTag = $args[++$i]
        }
        '^--?tarball$' {
            if ($BakeMode) {
                $BakeTarball = $true
                if ($i + 1 -lt $args.Count -and -not $args[$i + 1].StartsWith("-")) {
                    $BakeTarballPath = $args[++$i]
                }
            } else {
                $UseTarball = $true
                if ($i + 1 -lt $args.Count -and -not $args[$i + 1].StartsWith("-")) {
                    $TarballPath = $args[++$i]
                }
            }
        }
        '^--?bake-tarball$|^--?save-tarball$' {
            $BakeTarball = $true
            if ($i + 1 -lt $args.Count -and -not $args[$i + 1].StartsWith("-")) {
                $BakeTarballPath = $args[++$i]
            }
        }
        default {
            if ($BakeMode -and [string]::IsNullOrEmpty($BakeTarget)) {
                $BakeTarget = $arg
            } else {
                throw "[sitrec] ERROR: unknown option: $arg"
            }
        }
    }
}

if ($BakeMode -and $UseTarball -and -not $BakeTarball) {
    $BakeTarball = $true
    $BakeTarballPath = $TarballPath
    $UseTarball = $false
}

function Test-NativeCommand {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Test-DockerCompose {
    if (-not (Test-NativeCommand "docker")) { return $false }
    & docker compose version *> $null
    return $LASTEXITCODE -eq 0
}

function Test-DockerReady {
    if (-not (Test-NativeCommand "docker")) { return $false }
    & docker info *> $null
    return $LASTEXITCODE -eq 0
}

function Test-PodmanCompose {
    if (Test-NativeCommand "podman-compose") { return "podman-compose" }
    if (Test-NativeCommand "podman") {
        & podman compose --help *> $null
        if ($LASTEXITCODE -eq 0) { return "podman compose" }
    }
    return ""
}

function Test-PodmanReady {
    if (-not (Test-NativeCommand "podman")) { return $false }
    & podman info *> $null
    return $LASTEXITCODE -eq 0
}

function Set-Runtime {
    param([string]$RuntimeName, [string]$ComposeText)
    $script:Runtime = $RuntimeName
    $script:ComposeText = $ComposeText
    $script:ComposeCommand = @($ComposeText -split ' ')
}

function Get-RuntimeNotReadyMessage {
    param([string]$Context)

    if ($script:Runtime -eq "docker") {
        $rerun = "irm https://raw.githubusercontent.com/MickWest/Sitrec2/main/install.ps1 | iex"
        if ($Context -ne "install") { $rerun = ".\sitrec.cmd start" }
        return @"
[sitrec] ERROR: Docker Desktop is installed, but the Docker engine is not running.

Start Docker Desktop from the Start menu, wait until it says it is running, then run:
  $rerun

If Docker Desktop is open but this keeps failing, check Docker Desktop Settings -> General
and make sure the WSL 2 based engine is enabled.
"@
    }

    return @"
[sitrec] ERROR: Podman is installed, but the Podman machine/service is not running.

Start Podman Desktop or run:
  podman machine start

Then rerun the Sitrec command.
"@
}

function Assert-RuntimeReady {
    param([string]$Context)

    if ($script:Runtime -eq "docker") {
        if (-not (Test-DockerReady)) {
            throw (Get-RuntimeNotReadyMessage $Context)
        }
        return
    }

    if ($script:Runtime -eq "podman") {
        if (-not (Test-PodmanReady)) {
            throw (Get-RuntimeNotReadyMessage $Context)
        }
    }
}

function Detect-Runtime {
    if ($ForceRuntime -eq "docker") {
        if (-not (Test-DockerCompose)) {
            throw "[sitrec] ERROR: -Docker specified but docker compose is not available."
        }
        Set-Runtime "docker" "docker compose"
        return
    }

    if ($ForceRuntime -eq "podman") {
        $podmanCompose = Test-PodmanCompose
        if (-not $podmanCompose) {
            throw "[sitrec] ERROR: -Podman specified but podman compose is not available."
        }
        Set-Runtime "podman" $podmanCompose
        return
    }

    if (Test-DockerCompose) {
        Set-Runtime "docker" "docker compose"
        return
    }

    $detectedPodman = Test-PodmanCompose
    if ($detectedPodman) {
        Set-Runtime "podman" $detectedPodman
        return
    }

    throw "[sitrec] ERROR: Neither Docker Desktop nor Podman compose was found. Install Docker Desktop or Podman Desktop, then re-run this script."
}

function Invoke-Native {
    param([string]$File, [string[]]$Arguments)
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) {
        if (($script:Runtime -eq "docker" -and -not (Test-DockerReady)) -or
            ($script:Runtime -eq "podman" -and -not (Test-PodmanReady))) {
            throw (Get-RuntimeNotReadyMessage "command")
        }
        throw "[sitrec] Command failed: $File $($Arguments -join ' ')"
    }
}

function Invoke-Compose {
    param([string[]]$Arguments)
    $exe = $script:ComposeCommand[0]
    $prefix = @()
    if ($script:ComposeCommand.Count -gt 1) {
        $prefix = $script:ComposeCommand[1..($script:ComposeCommand.Count - 1)]
    }
    Invoke-Native $exe ($prefix + $Arguments)
}

function Invoke-Runtime {
    param([string[]]$Arguments)
    Invoke-Native $script:Runtime $Arguments
}

function Download-TextFile {
    param([string]$Uri, [string]$OutFile)
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri
    Set-Content -LiteralPath $OutFile -Value $response.Content -Encoding UTF8
}

function Copy-FromImage {
    param([string]$ContainerId, [string]$Source, [string]$Destination)
    & $script:Runtime cp "${ContainerId}:$Source" $Destination *> $null
    return $LASTEXITCODE -eq 0
}

function Write-CommandWrapper {
    Set-Content -LiteralPath "sitrec.cmd" -Encoding ASCII -Value @"
@echo off
setlocal
where pwsh.exe >nul 2>nul
if %ERRORLEVEL%==0 (
    pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0sitrec.ps1" %*
) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0sitrec.ps1" %*
)
exit /b %ERRORLEVEL%
"@
}

function Bake-Image {
    if ([string]::IsNullOrEmpty($BakeTarget)) {
        Write-Host "[sitrec] ERROR: -Bake requires a target image name." -ForegroundColor Red
        Write-Host ""
        Write-Host "  Examples:"
        Write-Host "    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Bake registry.example.com/sitrec:configured -EnvFile prod.env"
        Write-Host "    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Bake sitrec-configured:latest -EnvFile prod.env -Tarball sitrec-configured.tar"
        exit 1
    }

    if (-not (Test-Path -LiteralPath $BakeEnvFile)) {
        throw "[sitrec] ERROR: env file '$BakeEnvFile' not found."
    }

    $baseImage = "${Image}:${BakeBaseTag}"
    Write-Host "[sitrec] Baking '$BakeEnvFile' into $baseImage  ->  $BakeTarget"
    Write-Host "[sitrec] WARNING: every value in '$BakeEnvFile' is embedded in the image as"
    Write-Host "          build-time ENV layers. Anyone who can pull '$BakeTarget' or read its"
    Write-Host "          docker history / inspect can recover these values, including secrets."
    Write-Host "          Only push baked images to a PRIVATE registry you trust."
    Write-Host ""

    $buildDir = Join-Path ([System.IO.Path]::GetTempPath()) ("sitrec-bake-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $buildDir | Out-Null
    try {
        $dockerfile = Join-Path $buildDir "Dockerfile"
        Set-Content -LiteralPath $dockerfile -Encoding UTF8 -Value @(
            "# Auto-generated by install.ps1 -Bake - do not edit.",
            "# Bakes '$BakeEnvFile' into $baseImage so the image is self-configured.",
            "FROM $baseImage"
        )

        $bakedCount = 0
        foreach ($rawLine in Get-Content -LiteralPath $BakeEnvFile) {
            $line = $rawLine.TrimStart(" ", "`t")
            if ([string]::IsNullOrEmpty($line) -or $line.StartsWith("#")) { continue }
            if ($line.StartsWith("export ")) { $line = $line.Substring(7) }
            $eq = $line.IndexOf("=")
            if ($eq -lt 0) { continue }
            $key = $line.Substring(0, $eq)
            $val = $line.Substring($eq + 1)
            if (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'"))) {
                $val = $val.Substring(1, $val.Length - 2)
            }
            if ([string]::IsNullOrEmpty($val)) { continue }
            $esc = $val.Replace("\", "\\").Replace('"', '\"').Replace('$', '\$')
            Add-Content -LiteralPath $dockerfile -Encoding UTF8 -Value "ENV $key=`"$esc`""
            $bakedCount++
        }

        if ($bakedCount -eq 0) {
            throw "[sitrec] ERROR: no usable KEY=value lines found in '$BakeEnvFile'."
        }

        Write-Host "[sitrec] Generated Dockerfile with $bakedCount baked env var(s)."
        Invoke-Runtime @("build", "--pull", "-f", $dockerfile, "-t", $BakeTarget, $buildDir)
        Write-Host "[sitrec] Built $BakeTarget"

        if ($BakeTarball) {
            if ([string]::IsNullOrEmpty($BakeTarballPath)) {
                $BakeTarballPath = ([regex]::Replace($BakeTarget, "[^A-Za-z0-9_.-]", "_")) + ".tar"
            }
            Write-Host "[sitrec] Saving $BakeTarget to $BakeTarballPath ..."
            Invoke-Runtime @("save", "-o", $BakeTarballPath, $BakeTarget)
            Write-Host "[sitrec] Saved $BakeTarballPath"
        }

        if ($BakePush) {
            Write-Host "[sitrec] Pushing $BakeTarget ..."
            Invoke-Runtime @("push", $BakeTarget)
            Write-Host "[sitrec] Pushed $BakeTarget"
        } else {
            Write-Host "[sitrec] Not pushed (no -Push). To push it yourself:"
            Write-Host "           $Runtime push $BakeTarget"
        }
    } finally {
        Remove-Item -LiteralPath $buildDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Detect-Runtime
Write-Host "[sitrec] Using $Runtime ($ComposeText)"
Assert-RuntimeReady "install"

if ($BakeMode) {
    Bake-Image
    exit 0
}

if (Test-Path -LiteralPath $Dir) {
    Write-Host "[sitrec] Directory '$Dir' already exists. To reinstall, remove it first." -ForegroundColor Red
    exit 1
}

Write-Host "[sitrec] Creating $Dir/"
New-Item -ItemType Directory -Path $Dir | Out-Null

$haveExistingEnv = $false
if (Test-Path -LiteralPath ".env") {
    Copy-Item -LiteralPath ".env" -Destination (Join-Path $Dir ".env")
    $haveExistingEnv = $true
    Write-Host "[sitrec] Copied existing .env into $Dir/"
}

Set-Location $Dir

$volumesBlock = ""
if ($MountVideos) {
    New-Item -ItemType Directory -Path "sitrec-videos" -Force | Out-Null
    $volumesBlock = @"
    volumes:
      - ./sitrec-videos:/var/www/html/sitrec-videos
"@
}

@"
services:
  sitrec:
    image: $InstallImage
    ports:
      - '8080:80'
    env_file:
      - .env
$volumesBlock
"@ | Set-Content -LiteralPath "docker-compose.yml" -Encoding UTF8

if (-not $haveExistingEnv) {
@"
# Sitrec configuration - uncomment and edit as needed.
# After changes, run: .\sitrec.cmd restart

# === Banners (optional) ===
#BANNER_ACTIVE=true
#BANNER_TOP_TEXT=Welcome to Sitrec
#BANNER_BOTTOM_TEXT=
#BANNER_COLOR="#FFFFFF"
#BANNER_BACKGROUND_COLOR="#377e22"
#BANNER_HEIGHT=20

# === Maps (optional - enables higher quality imagery) ===
#MAPBOX_TOKEN=pk.your_token_here
#MAPTILER_KEY=your_key_here

# === 3D Buildings (optional) ===
#CESIUM_ION_TOKEN=your_token_here
#GOOGLE_MAPS_API_KEY=your_key_here

# === AI Chat (optional) ===
#CHATBOT_ENABLED=true
#OPENAI_API=sk-your_key_here

# === Cloud Storage (optional - enables server-side saves) ===
#SAVE_TO_S3=true
#S3_ACCESS_KEY_ID=your_key_here
#S3_SECRET_ACCESS_KEY=your_secret_here
#S3_BUCKET=your-bucket
#S3_REGION=us-west-2
"@ | Set-Content -LiteralPath ".env" -Encoding UTF8
}

Set-Content -LiteralPath ".runtime" -Encoding ASCII -Value $ComposeText

$tarball = ""
if (-not [string]::IsNullOrEmpty($TarballPath)) {
    if ([System.IO.Path]::IsPathRooted($TarballPath)) {
        $tarball = $TarballPath
    } else {
        $tarball = Join-Path ".." $TarballPath
    }
} elseif ($UseTarball -or -not $Offline) {
    $foundTar = Get-ChildItem -Path ".." -Filter "*.tar" -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($foundTar) { $tarball = $foundTar.FullName }
}

if ($UseTarball) {
    if ([string]::IsNullOrEmpty($tarball) -or -not (Test-Path -LiteralPath $tarball)) {
        throw "[sitrec] ERROR: -Tarball specified but no .tar file found."
    }
    Write-Host "[sitrec] Loading image from $tarball..."
    Invoke-Runtime @("load", "-i", $tarball)
    $Offline = $true
} elseif (-not $Offline -and -not [string]::IsNullOrEmpty($tarball)) {
    Write-Host "[sitrec] Found local image tarball: $tarball"
    $answer = Read-Host "[sitrec] Load image from this file instead of pulling? [y/N]"
    if ($answer -eq "y" -or $answer -eq "Y") {
        Write-Host "[sitrec] Loading image from $tarball..."
        Invoke-Runtime @("load", "-i", $tarball)
        $Offline = $true
    }
}

if ($Offline) {
    Write-Host "[sitrec] Offline mode - skipping image pull"
} else {
    Write-Host "[sitrec] Pulling image..."
    Invoke-Compose @("pull")
}

Write-Host "[sitrec] Extracting support files from image..."
$cid = ""
try {
    $cid = (& $Runtime create --entrypoint /bin/true $InstallImage 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($cid)) {
        $cid = (& $Runtime create $InstallImage 2>$null | Select-Object -First 1)
    }
    if ([string]::IsNullOrWhiteSpace($cid)) {
        throw "[sitrec] ERROR: could not create support-file extraction container from $InstallImage."
    }

    [void](Copy-FromImage $cid "/usr/local/share/sitrec/sitrec.sh" "sitrec.sh")
    if (-not (Copy-FromImage $cid "/usr/local/share/sitrec/sitrec.ps1" "sitrec.ps1")) {
        if ($Offline) {
            throw "[sitrec] ERROR: sitrec.ps1 was not bundled in this image. Use a newer Sitrec image or transfer sitrec.ps1 alongside install.ps1."
        } else {
            Write-Host "[sitrec] Downloading sitrec.ps1..."
            Download-TextFile "https://raw.githubusercontent.com/MickWest/Sitrec2/main/sitrec.ps1" "sitrec.ps1"
        }
    }
    if (-not (Copy-FromImage $cid "/usr/local/share/sitrec/sitrec.cmd" "sitrec.cmd")) {
        Write-CommandWrapper
    }
    if (-not (Copy-FromImage $cid "/usr/local/share/sitrec/shared.env.example" "shared.env.example")) {
        if (-not $Offline) {
            Write-Host "[sitrec] Downloading shared.env.example..."
            Download-TextFile "https://raw.githubusercontent.com/MickWest/Sitrec2/main/config/shared.env.example" "shared.env.example"
        }
    }
} finally {
    if (-not [string]::IsNullOrWhiteSpace($cid)) {
        & $Runtime rm $cid *> $null
    }
}

Write-Host ""
Write-Host "============================================"
Write-Host "  Sitrec installed in .\$Dir\"
Write-Host "  "
Write-Host "  Start:     .\sitrec.cmd start"
Write-Host "  Stop:      .\sitrec.cmd stop"
Write-Host "  Restart:   .\sitrec.cmd restart  (after .env changes)"
Write-Host "  Update:    .\sitrec.cmd pull"
Write-Host "  Open:      http://localhost:8080"
Write-Host "  Config:    edit .env"
Write-Host "============================================"
Write-Host ""

try { Invoke-Compose @("down") } catch {}
Write-Host "[sitrec] Starting in the background..."
Invoke-Compose @("up", "-d")
Write-Host "[sitrec] Running. Open http://localhost:8080"
