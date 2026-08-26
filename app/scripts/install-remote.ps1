param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$Destination,
    [string]$InstallerArgumentsJson = '[]'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'install-common.ps1')

Write-OmniProgress -Percent 4 -Message 'Preparing official installer'
$parent = Split-Path -Parent $Destination
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$partial = "$Destination.partial"

try {
    Invoke-OmniTrackedDownload -Uri $Uri -Destination $partial -StartPercent 10 -EndPercent 68
    if (-not (Test-Path -LiteralPath $partial) -or (Get-Item -LiteralPath $partial).Length -eq 0) {
        throw 'The downloaded installer was empty.'
    }
    Move-Item -LiteralPath $partial -Destination $Destination -Force
    Write-OmniProgress -Percent 74 -Message 'Official installer verified'
}
finally {
    if (Test-Path -LiteralPath $partial) {
        Remove-Item -LiteralPath $partial -Force
    }
}

Write-OmniProgress -Percent 80 -Message 'Running official installer in isolated profile'
$parsedArguments = $InstallerArgumentsJson | ConvertFrom-Json
$installerArgs = @()
foreach ($argument in $parsedArguments) {
    $installerArgs += [string]$argument
}
& $Destination @installerArgs
if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
Write-OmniProgress -Percent 96 -Message 'Verifying local command'
