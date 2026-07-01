$ErrorActionPreference = "Stop"

function Fail {
    param([string]$Message)
    Write-Error $Message
    exit 1
}

Write-Host "Sitrec Local Compute dependency check"

$PythonCommand = $null
$PythonBaseArgs = @()

if ($env:SITREC_LOCAL_COMPUTE_PYTHON) {
    $PythonCommand = $env:SITREC_LOCAL_COMPUTE_PYTHON
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
    $PythonCommand = "py"
    $PythonBaseArgs = @("-3")
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    $PythonCommand = "python"
} elseif (Get-Command python3 -ErrorAction SilentlyContinue) {
    $PythonCommand = "python3"
} else {
    Fail "Missing Python 3. Install it from https://www.python.org/downloads/windows/ or run: winget install --id Python.Python.3.12"
}

$PythonVersion = & $PythonCommand @PythonBaseArgs --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Fail "Could not run Python command '$PythonCommand'. Set SITREC_LOCAL_COMPUTE_PYTHON to a working Python 3 executable."
}
Write-Host "Python: $PythonVersion"

$FfmpegCommand = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $FfmpegCommand) {
    Fail "Missing ffmpeg. Install it with: winget install --id Gyan.FFmpeg, then restart the app that starts SitrecBridge."
}

$FfprobeCommand = Get-Command ffprobe -ErrorAction SilentlyContinue
if (-not $FfprobeCommand) {
    Fail "Missing ffprobe. Install ffmpeg with: winget install --id Gyan.FFmpeg, then restart the app that starts SitrecBridge."
}

& $PythonCommand @PythonBaseArgs -m pip install --upgrade --disable-pip-version-check opencv-python-headless numpy
if ($LASTEXITCODE -ne 0) {
    Fail "Python dependency install failed. Check the pip output above, or set SITREC_LOCAL_COMPUTE_PYTHON to a Python environment with pip."
}

& $PythonCommand @PythonBaseArgs -c "import cv2, numpy; print('OpenCV:', cv2.__version__); print('NumPy:', numpy.__version__)"
if ($LASTEXITCODE -ne 0) {
    Fail "Python dependency verification failed. Local Compute needs cv2 and numpy importable by the selected Python."
}

Write-Host "ffmpeg: $($FfmpegCommand.Source)"
Write-Host "ffprobe: $($FfprobeCommand.Source)"
Write-Host "Local Compute dependencies are ready."
