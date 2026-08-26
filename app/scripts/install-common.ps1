function Write-OmniProgress {
    param(
        [Parameter(Mandatory = $true)][ValidateRange(0, 100)][int]$Percent,
        [Parameter(Mandatory = $true)][string]$Message
    )
    [Console]::Out.WriteLine(("OMNISHELL_PROGRESS:{0}:{1}" -f $Percent, $Message))
}

function Invoke-OmniTrackedDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$Destination,
        [ValidateRange(0, 100)][int]$StartPercent = 10,
        [ValidateRange(0, 100)][int]$EndPercent = 75,
        [System.Collections.IDictionary]$Headers = @{}
    )

    Add-Type -AssemblyName System.Net.Http
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $handler = [System.Net.Http.HttpClientHandler]::new()
    $client = [System.Net.Http.HttpClient]::new($handler)
    $response = $null
    $inputStream = $null
    $outputStream = $null

    try {
        foreach ($key in $Headers.Keys) {
            [void]$client.DefaultRequestHeaders.TryAddWithoutValidation([string]$key, [string]$Headers[$key])
        }
        if (-not $client.DefaultRequestHeaders.UserAgent.Count) {
            $client.DefaultRequestHeaders.UserAgent.ParseAdd('OmniShell-Installer/1.0')
        }

        $response = $client.GetAsync(
            $Uri,
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead
        ).GetAwaiter().GetResult()
        [void]$response.EnsureSuccessStatusCode()

        $totalBytes = $response.Content.Headers.ContentLength
        $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $outputStream = [System.IO.FileStream]::new(
            $Destination,
            [System.IO.FileMode]::Create,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None,
            65536,
            [System.IO.FileOptions]::SequentialScan
        )
        $buffer = New-Object byte[] 65536
        [long]$downloaded = 0
        $lastReported = $StartPercent - 1
        Write-OmniProgress -Percent $StartPercent -Message 'Download started'

        while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $outputStream.Write($buffer, 0, $read)
            $downloaded += $read
            if ($totalBytes -and $totalBytes -gt 0) {
                $ratio = [Math]::Min(1.0, $downloaded / [double]$totalBytes)
                $percent = $StartPercent + [Math]::Floor($ratio * ($EndPercent - $StartPercent))
                if ($percent -gt $lastReported) {
                    $lastReported = $percent
                    $megabytes = [Math]::Round($downloaded / 1MB, 1)
                    $totalMegabytes = [Math]::Round($totalBytes / 1MB, 1)
                    Write-OmniProgress -Percent $percent -Message ("Downloading {0} / {1} MB" -f $megabytes, $totalMegabytes)
                }
            }
        }
        $outputStream.Flush()
        Write-OmniProgress -Percent $EndPercent -Message 'Download complete'
    }
    finally {
        if ($outputStream) { $outputStream.Dispose() }
        if ($inputStream) { $inputStream.Dispose() }
        if ($response) { $response.Dispose() }
        $client.Dispose()
        $handler.Dispose()
    }
}
