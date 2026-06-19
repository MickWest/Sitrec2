# Sitrec management script for Windows PowerShell
# Usage: .\sitrec.cmd [command]
#
# Commands:
#   start       Start the container
#   stop        Stop the container
#   restart     Stop and recreate the container (picks up .env changes)
#   pull        Pull the latest image and recreate the container
#   versions    List available versions and switch to one
#   bake        Bake a .env file into a new, self-configured image
#   update      Update this script and shared.env.example from GitHub
#   logs        Follow container logs
#   status      Show container status

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$Image = "ghcr.io/mickwest/sitrec2"
$RepoUrl = "https://raw.githubusercontent.com/MickWest/Sitrec2/main"

function Test-NativeCommand {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Test-DockerCompose {
    if (-not (Test-NativeCommand "docker")) { return $false }
    & docker compose version *> $null
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

function Set-Runtime {
    param([string]$RuntimeName, [string]$ComposeText)
    $script:Runtime = $RuntimeName
    $script:ComposeText = $ComposeText
    $script:ComposeCommand = @($ComposeText -split ' ')
}

function Detect-Runtime {
    if (Test-Path -LiteralPath ".runtime") {
        $runtimeText = (Get-Content -LiteralPath ".runtime" -Raw).Trim()
        if ($runtimeText -eq "docker compose") {
            Set-Runtime "docker" $runtimeText
            return
        }
        if ($runtimeText -eq "podman compose") {
            Set-Runtime "podman" $runtimeText
            return
        }
        if ($runtimeText -eq "podman-compose") {
            Set-Runtime "podman" $runtimeText
            return
        }
    }

    if (Test-DockerCompose) {
        Set-Runtime "docker" "docker compose"
        Write-Host "[sitrec] Note: .runtime not found, auto-detected: docker compose"
        return
    }

    $podmanCompose = Test-PodmanCompose
    if ($podmanCompose) {
        Set-Runtime "podman" $podmanCompose
        Write-Host "[sitrec] Note: .runtime not found, auto-detected: $podmanCompose"
        return
    }

    throw "[sitrec] ERROR: Neither Docker Desktop nor Podman compose was found."
}

function Invoke-Native {
    param([string]$File, [string[]]$Arguments)
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) {
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

function Print-Running {
    param([string]$Prefix)
    $version = ""
    for ($i = 0; $i -lt 10; $i++) {
        try {
            $version = (Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:8080/build-version.txt" -TimeoutSec 2).Content.Trim()
            if (-not [string]::IsNullOrEmpty($version)) { break }
        } catch {
            Start-Sleep -Seconds 1
        }
    }

    if (-not [string]::IsNullOrEmpty($version)) {
        Write-Host "[sitrec] $Prefix at http://localhost:8080 - $version"
    } else {
        Write-Host "[sitrec] $Prefix at http://localhost:8080 (version probe timed out)"
    }
}

function Set-OfficialImageTag {
    param([string]$Tag)
    if (-not (Test-Path -LiteralPath "docker-compose.yml")) {
        throw "[sitrec] ERROR: docker-compose.yml not found."
    }

    $lines = Get-Content -LiteralPath "docker-compose.yml"
    $changed = $false
    $escapedImage = [regex]::Escape($Image)
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^(\s*image:\s*)${escapedImage}:[^\s]+") {
            $lines[$i] = $Matches[1] + "${Image}:${Tag}"
            $changed = $true
            break
        }
    }

    if ($changed) {
        Set-Content -LiteralPath "docker-compose.yml" -Encoding UTF8 -Value $lines
    } else {
        Write-Host "[sitrec] Image is not $Image; leaving docker-compose.yml image unchanged."
    }
}

function Get-CurrentImage {
    if (-not (Test-Path -LiteralPath "docker-compose.yml")) { return "" }
    foreach ($line in Get-Content -LiteralPath "docker-compose.yml") {
        if ($line -match "^\s*image:\s*(\S+)") { return $Matches[1] }
    }
    return ""
}

function Download-TextFile {
    param([string]$Uri, [string]$OutFile)
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri
    Set-Content -LiteralPath $OutFile -Value $response.Content -Encoding UTF8
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
    param([string[]]$BakeArgs)

    $envFile = ".env"
    $baseTag = "latest"
    $push = $false
    $tarball = $false
    $tarballPath = ""
    $target = ""

    for ($i = 0; $i -lt $BakeArgs.Count; $i++) {
        $arg = $BakeArgs[$i]
        switch -Regex ($arg.ToLowerInvariant()) {
            '^--?env-file$|^--?envfile$' {
                if ($i + 1 -ge $BakeArgs.Count -or $BakeArgs[$i + 1].StartsWith("-")) {
                    throw "[sitrec] ERROR: -EnvFile requires a path."
                }
                $envFile = $BakeArgs[++$i]
            }
            '^--?base$' {
                if ($i + 1 -ge $BakeArgs.Count -or $BakeArgs[$i + 1].StartsWith("-")) {
                    throw "[sitrec] ERROR: -Base requires a tag."
                }
                $baseTag = $BakeArgs[++$i]
            }
            '^--?push$' {
                $push = $true
            }
            '^--?tarball$|^--?save-tarball$' {
                $tarball = $true
                if (-not [string]::IsNullOrEmpty($target) -and $i + 1 -lt $BakeArgs.Count -and -not $BakeArgs[$i + 1].StartsWith("-")) {
                    $tarballPath = $BakeArgs[++$i]
                }
            }
            default {
                if ($arg.StartsWith("-")) {
                    throw "[sitrec] Unknown bake option: $arg"
                }
                $target = $arg
            }
        }
    }

    if ([string]::IsNullOrEmpty($target)) {
        Write-Host "[sitrec] ERROR: bake requires a target image name." -ForegroundColor Red
        Write-Host ""
        Write-Host "  Usage: .\sitrec.cmd bake [-EnvFile <file>] [-Base <tag>] [-Push] <target-image> [-Tarball [file]]"
        exit 1
    }

    if (-not (Test-Path -LiteralPath $envFile)) {
        throw "[sitrec] ERROR: env file '$envFile' not found."
    }

    $baseImage = "${Image}:${baseTag}"
    Write-Host "[sitrec] Baking '$envFile' into $baseImage  ->  $target"
    Write-Host "[sitrec] WARNING: every value in '$envFile' is embedded in the image as"
    Write-Host "          build-time ENV layers. Anyone who can pull '$target' or read its"
    Write-Host "          docker history / inspect can recover these values, including secrets."
    Write-Host "          Only push baked images to a PRIVATE registry you trust."
    Write-Host ""

    $buildDir = Join-Path ([System.IO.Path]::GetTempPath()) ("sitrec-bake-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $buildDir | Out-Null
    try {
        $dockerfile = Join-Path $buildDir "Dockerfile"
        Set-Content -LiteralPath $dockerfile -Encoding UTF8 -Value @(
            "# Auto-generated by .\sitrec.cmd bake - do not edit.",
            "# Bakes '$envFile' into $baseImage so the image is self-configured.",
            "FROM $baseImage"
        )

        $bakedCount = 0
        foreach ($rawLine in Get-Content -LiteralPath $envFile) {
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
            throw "[sitrec] ERROR: no usable KEY=value lines found in '$envFile'."
        }

        Write-Host "[sitrec] Generated Dockerfile with $bakedCount baked env var(s)."
        Invoke-Runtime @("build", "--pull", "-f", $dockerfile, "-t", $target, $buildDir)
        Write-Host "[sitrec] Built $target"

        if ($tarball) {
            if ([string]::IsNullOrEmpty($tarballPath)) {
                $tarballPath = ([regex]::Replace($target, "[^A-Za-z0-9_.-]", "_")) + ".tar"
            }
            Write-Host "[sitrec] Saving $target to $tarballPath ..."
            Invoke-Runtime @("save", "-o", $tarballPath, $target)
            Write-Host "[sitrec] Saved $tarballPath"
        }

        if ($push) {
            Write-Host "[sitrec] Pushing $target ..."
            Invoke-Runtime @("push", $target)
            Write-Host "[sitrec] Pushed $target"
        } else {
            Write-Host "[sitrec] Not pushed (no -Push). To push it yourself:"
            Write-Host "           $Runtime push $target"
        }
    } finally {
        Remove-Item -LiteralPath $buildDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Show-Versions {
    Write-Host "[sitrec] Fetching available versions from GHCR..."
    $tokenResponse = Invoke-RestMethod -Uri "https://ghcr.io/token?scope=repository:mickwest/sitrec2:pull"
    $headers = @{ Authorization = "Bearer $($tokenResponse.token)" }
    $tagResponse = Invoke-RestMethod -Headers $headers -Uri "https://ghcr.io/v2/mickwest/sitrec2/tags/list?n=1000"
    $tags = @($tagResponse.tags | Where-Object { $_ -notlike "build-*" -and $_ -ne "latest" })
    $tags = @($tags | Sort-Object -Descending -Property {
        try { [version]$_ } catch { [version]"0.0.0" }
    })

    if ($tags.Count -eq 0) {
        throw "[sitrec] ERROR: could not fetch version list."
    }

    $currentImage = Get-CurrentImage
    $current = $currentImage
    if ($currentImage.StartsWith("${Image}:")) {
        $current = $currentImage.Substring($Image.Length + 1)
    }

    Write-Host ""
    Write-Host "  Current: $current"
    Write-Host ""

    for ($i = 0; $i -lt $tags.Count; $i++) {
        $label = $tags[$i]
        if ($label -eq $current) {
            "{0,4}) {1}  <-- installed" -f ($i + 1), $label | Write-Host
        } else {
            "{0,4}) {1}" -f ($i + 1), $label | Write-Host
        }
    }

    Write-Host ""
    $choice = Read-Host "Enter number to switch (or press Enter to cancel)"
    if ([string]::IsNullOrWhiteSpace($choice)) {
        Write-Host "[sitrec] Cancelled."
        return
    }

    $index = 0
    if (-not [int]::TryParse($choice, [ref]$index) -or $index -lt 1 -or $index -gt $tags.Count) {
        throw "[sitrec] Invalid selection."
    }

    $selected = $tags[$index - 1]
    if ($selected -eq $current) {
        Write-Host "[sitrec] Already running $current."
        return
    }

    Set-OfficialImageTag $selected
    Write-Host "[sitrec] Switched to ${Image}:${selected}"
    Invoke-Compose @("pull")
    Invoke-Compose @("down")
    Invoke-Compose @("up", "-d")
    Print-Running "Running"
}

function Show-Help {
    Write-Host "Usage: .\sitrec.cmd [command]"
    Write-Host ""
    Write-Host "Commands:"
    Write-Host "  start     Start (or restart) the container"
    Write-Host "  stop      Stop the container"
    Write-Host "  pull      Pull latest image and recreate"
    Write-Host "  versions  List available versions and switch"
    Write-Host "  bake      Bake a .env file into a new, self-configured image"
    Write-Host "            (.\sitrec.cmd bake [-EnvFile <f>] [-Base <tag>] [-Push] <target-image> [-Tarball [file]])"
    Write-Host "  update    Update this script from GitHub"
    Write-Host "  logs      Follow container logs"
    Write-Host "  status    Show container status"
    Write-Host ""
    Write-Host "PowerShell users can run .\sitrec.cmd to avoid script execution-policy blocks."
}

$command = "help"
$commandArgs = @()
if ($args.Count -gt 0) {
    $command = $args[0].ToLowerInvariant()
    if ($args.Count -gt 1) {
        $commandArgs = $args[1..($args.Count - 1)]
    }
}

if ($command -eq "help" -or $command -eq "--help" -or $command -eq "-h") {
    Show-Help
    exit 0
}

Detect-Runtime

switch ($command) {
    "start" {
        Write-Host "[sitrec] Starting (recreating container to pick up any .env changes)..."
        try { Invoke-Compose @("down") } catch {}
        Invoke-Compose @("up", "-d")
        Print-Running "Running"
    }
    "restart" {
        Write-Host "[sitrec] Starting (recreating container to pick up any .env changes)..."
        try { Invoke-Compose @("down") } catch {}
        Invoke-Compose @("up", "-d")
        Print-Running "Running"
    }
    "stop" {
        Write-Host "[sitrec] Stopping..."
        Invoke-Compose @("down")
    }
    "pull" {
        Write-Host "[sitrec] Pulling latest image and restarting..."
        Set-OfficialImageTag "latest"
        Invoke-Compose @("pull")
        Invoke-Compose @("down")
        Invoke-Compose @("up", "-d")
        Print-Running "Updated and running"
    }
    "versions" {
        Show-Versions
    }
    "bake" {
        Bake-Image $commandArgs
    }
    "update" {
        Write-Host "[sitrec] Updating sitrec.ps1 from GitHub..."
        Download-TextFile "$RepoUrl/sitrec.ps1" "sitrec.ps1.tmp"
        Move-Item -LiteralPath "sitrec.ps1.tmp" -Destination "sitrec.ps1" -Force
        Write-Host "[sitrec] Updated sitrec.ps1"

        Write-Host "[sitrec] Updating sitrec.cmd..."
        try {
            Download-TextFile "$RepoUrl/sitrec.cmd" "sitrec.cmd.tmp"
            Move-Item -LiteralPath "sitrec.cmd.tmp" -Destination "sitrec.cmd" -Force
            Write-Host "[sitrec] Updated sitrec.cmd"
        } catch {
            Remove-Item -LiteralPath "sitrec.cmd.tmp" -Force -ErrorAction SilentlyContinue
            Write-CommandWrapper
            Write-Host "[sitrec] Recreated sitrec.cmd"
        }

        Write-Host "[sitrec] Updating shared.env.example..."
        try {
            Download-TextFile "$RepoUrl/config/shared.env.example" "shared.env.example.tmp"
            Move-Item -LiteralPath "shared.env.example.tmp" -Destination "shared.env.example" -Force
            Write-Host "[sitrec] Updated shared.env.example"
        } catch {
            Remove-Item -LiteralPath "shared.env.example.tmp" -Force -ErrorAction SilentlyContinue
            Write-Host "[sitrec] WARNING: Could not update shared.env.example" -ForegroundColor Yellow
        }

        Write-Host "[sitrec] Done. Run .\sitrec.cmd pull to also update the Sitrec image."
    }
    "logs" {
        Invoke-Compose @("logs", "-f")
    }
    "status" {
        Invoke-Compose @("ps")
    }
    default {
        Write-Host "[sitrec] Unknown command: $command" -ForegroundColor Red
        Write-Host "Run .\sitrec.cmd help for usage."
        exit 1
    }
}
