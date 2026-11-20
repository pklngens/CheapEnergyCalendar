$ErrorActionPreference = 'Stop'

$apiKeySecure = Read-Host 'Fox ESS API key' -AsSecureString
if ($null -eq $apiKeySecure -or $apiKeySecure.Length -eq 0) {
  throw 'An API key is required.'
}

$deviceSN = Read-Host 'Fox ESS device serial number'
if ([string]::IsNullOrWhiteSpace($deviceSN)) {
  $apiKeySecure.Dispose()
  throw 'A device serial number is required.'
}

$apiKeyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($apiKeySecure)
$apiKey = $null
$headers = $null
$body = $null

try {
  $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($apiKeyPointer)
  $path = '/op/v3/device/scheduler/get'
  $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
  $signatureInput = "$path`r`n$apiKey`r`n$timestamp"
  $md5 = [Security.Cryptography.MD5]::Create()
  try {
    $signatureBytes = $md5.ComputeHash([Text.Encoding]::UTF8.GetBytes($signatureInput))
    $signature = -join ($signatureBytes | ForEach-Object { $_.ToString('x2') })
  } finally {
    $md5.Dispose()
  }

  $headers = @{
    token     = $apiKey
    timestamp = $timestamp
    signature = $signature
    lang      = 'en'
  }
  $body = @{ deviceSN = $deviceSN } | ConvertTo-Json -Compress

  try {
    $envelope = Invoke-RestMethod `
      -Uri "https://www.foxesscloud.com$path" `
      -Method Post `
      -Headers $headers `
      -ContentType 'application/json' `
      -Body $body `
      -TimeoutSec 30
  } catch {
    $statusCode = $null
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      $statusCode = [int]$_.Exception.Response.StatusCode
    }
    $details = $_.ErrorDetails.Message
    if ([string]::IsNullOrWhiteSpace($details)) {
      $details = $_.Exception.Message
    }
    if ($statusCode) {
      throw "Fox ESS request failed (HTTP $statusCode): $details"
    }
    throw "Fox ESS request failed: $details"
  }
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($apiKeyPointer)
  $apiKeySecure.Dispose()
  $apiKey = $null
  $signatureInput = $null
  $signatureBytes = $null
  $signature = $null
  $headers = $null
  $body = $null
}

if ($envelope.errno -ne 0) {
  throw "Fox ESS API error $($envelope.errno): $($envelope.msg)"
}
if ($null -eq $envelope.result) {
  throw 'Fox ESS returned no scheduler configuration.'
}

$scheduler = $envelope.result
$groups = @(
  foreach ($group in $scheduler.groups) {
    [ordered]@{
      startHour   = $group.startHour
      startMinute = $group.startMinute
      endHour     = $group.endHour
      endMinute   = $group.endMinute
      workMode    = $group.workMode
      extraParam  = $group.extraParam
    }
  }
)

[ordered]@{
  schedulerEnabled = $scheduler.enable
  maxGroupCount    = $scheduler.maxGroupCount
  properties       = $scheduler.properties
  groups           = $groups
} | ConvertTo-Json -Depth 12
