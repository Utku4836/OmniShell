$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$gacRoot = "C:\Windows\Microsoft.NET\assembly"

function Resolve-GacAssembly([string]$name) {
    foreach ($gac in @("GAC_64", "GAC_MSIL", "GAC_32")) {
        $dir = Join-Path $gacRoot "$gac\$name"
        if (Test-Path $dir) {
            $dll = Get-ChildItem -Path $dir -Recurse -Filter "$name.dll" |
                Select-Object -First 1
            if ($dll) { return $dll.FullName }
        }
    }
    return $null
}

$wpfNames = @("WindowsBase", "PresentationCore", "PresentationFramework", "System.Xaml")
$refs = @("/r:System.dll", "/r:System.Core.dll", "/r:System.Windows.Forms.dll", "/r:System.Drawing.dll")

foreach ($n in $wpfNames) {
    $path = Resolve-GacAssembly $n
    if ($path) {
        $refs += "/r:`"$path`""
    } else {
        Write-Host "BULUNAMADI: $n"
        exit 1
    }
}

New-Item -ItemType Directory -Force -Path "bin" | Out-Null

$sources = Get-ChildItem -Path "src" -Filter "*.cs" | ForEach-Object { $_.FullName }

& $csc /nologo /target:winexe /optimize+ /out:"bin\BlackApp.exe" $refs $sources

if ($LASTEXITCODE -eq 0) {
    Write-Host "Build succeeded: bin\BlackApp.exe"
} else {
    Write-Host "Build FAILED"
}


