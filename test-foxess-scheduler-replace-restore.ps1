$ErrorActionPreference = 'Stop'

$baseUrl = 'https://www.foxesscloud.com'
$apiKeySecure = Read-Host 'Fox ESS API key' -AsSecureString
if ($null -eq $apiKeySecure -or $apiKeySecure.Length -eq 0) {
  if ($null -ne $apiKeySecure) {
    $apiKeySecure.Dispose()
  }
  throw 'An API key is required.'
}

$deviceSN = Read-Host 'Fox ESS device serial number'
if ([string]::IsNullOrWhiteSpace($deviceSN)) {
  $apiKeySecure.Dispose()
  throw 'A device serial number is required.'
}

$apiKeyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($apiKeySecure)
$apiKey = $null

try {
  $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($apiKeyPointer)

  function Get-FoxEssSignature {
    param([string]$Path, [string]$Token, [string]$Timestamp)
    $signatureInput = "$Path`r`n$Token`r`n$Timestamp"
    $md5 = [Security.Cryptography.MD5]::Create()
    try {
      $bytes = $md5.ComputeHash([Text.Encoding]::UTF8.GetBytes($signatureInput))
      return -join ($bytes | ForEach-Object { $_.ToString('x2') })
    } finally {
      $md5.Dispose()
      $signatureInput = $null
      $bytes = $null
    }
  }

  function Invoke-FoxEssPost {
    param([string]$Path, [hashtable]$Payload)
    $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
    $signature = Get-FoxEssSignature -Path $Path -Token $apiKey -Timestamp $timestamp
    $headers = @{
      token     = $apiKey
      timestamp = $timestamp
      signature = $signature
      lang      = 'en'
    }
    $body = $Payload | ConvertTo-Json -Depth 20 -Compress

    try {
      $envelope = Invoke-RestMethod `
        -Uri "$baseUrl$Path" `
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
    } finally {
      $headers = $null
      $body = $null
    }

    if ($envelope.errno -ne 0) {
      throw "Fox ESS API error $($envelope.errno): $($envelope.msg)"
    }
    return $envelope.result
  }

  function Read-TestTime {
    param([string]$Prompt)
    $text = Read-Host $Prompt
    if ($text -notmatch '^(?:[01]\d|2[0-3]):[0-5]\d$') {
      throw "Enter a time in HH:mm format, for example 18:30."
    }
    $parts = $text.Split(':')
    return [TimeSpan]::new(0, [int]$parts[0], [int]$parts[1], 0)
  }

  function ConvertTo-FoxSchedulerGroup {
    param($Group)
    $copy = [ordered]@{
      startHour   = [int]$group.startHour
      startMinute = [int]$group.startMinute
      endHour     = [int]$group.endHour
      endMinute   = [int]$group.endMinute
      workMode    = [string]$group.workMode
    }
    if ($null -ne $group.extraParam) {
      $copy.extraParam = $group.extraParam
    }
    return $copy
  }

  function Assert-FoxFieldInRange {
    param($Properties, [string]$FieldName, [double]$Value)
    $property = $Properties.PSObject.Properties[$FieldName.ToLowerInvariant()]
    if ($null -eq $property -or $null -eq $property.Value.range) {
      return
    }

    $range = $property.Value.range
    if (($null -ne $range.min -and $Value -lt [double]$range.min) -or
        ($null -ne $range.max -and $Value -gt [double]$range.max)) {
      throw "$FieldName value $Value is outside the device range $($range.min)-$($range.max)."
    }
  }

  $scheduler = Invoke-FoxEssPost -Path '/op/v3/device/scheduler/get' -Payload @{ deviceSN = $deviceSN }
  if ($null -eq $scheduler -or $null -eq $scheduler.groups) {
    throw 'Fox ESS returned no scheduler groups; cannot safely restore the original plan.'
  }

  $originalGroups = @(
    foreach ($group in $scheduler.groups) {
      ConvertTo-FoxSchedulerGroup -Group $group
    }
  )
  if ($originalGroups.Count -eq 0) {
    throw 'The current schedule is empty; refusing a write test without a restorable plan.'
  }

  $properties = $scheduler.properties
  $workModeProperty = $properties.PSObject.Properties['workmode']
  $supportedModes = @()
  if ($null -ne $workModeProperty -and $null -ne $workModeProperty.Value.enumList) {
    $supportedModes = @($workModeProperty.Value.enumList)
  }
  if ($supportedModes -notcontains 'ForceCharge(BAT)') {
    throw 'The device does not report ForceCharge(BAT) as a supported scheduler mode.'
  }

  $maxGroupCount = [int]$scheduler.maxGroupCount
  if ($maxGroupCount -lt 1) {
    throw 'The device did not report a valid maxGroupCount.'
  }

  $powerWatts = 1200
  $extraParam = [ordered]@{
    minSocOnGrid = 10
    fdSoc        = 100
    fdPwr        = $powerWatts
    maxSoc       = 100
  }
  foreach ($field in $extraParam.Keys) {
    Assert-FoxFieldInRange -Properties $properties -FieldName $field -Value $extraParam[$field]
  }

  $start = Read-TestTime -Prompt 'Test block start time (device local time, HH:mm)'
  $end = Read-TestTime -Prompt 'Test block end time (same day, HH:mm)'
  if ($end -le $start) {
    throw 'The end time must be later than the start time; overnight blocks are not supported by this test.'
  }

  $testGroup = [ordered]@{
    startHour   = $start.Hours
    startMinute = $start.Minutes
    endHour     = $end.Hours
    endMinute   = $end.Minutes
    workMode    = 'ForceCharge(BAT)'
    extraParam  = $extraParam
  }
  Write-Host ''
  Write-Host "Current schedule groups: $($originalGroups.Count)"
  Write-Host "Test: ForceCharge(BAT) $($start.ToString('hh\:mm'))-$($end.ToString('hh\:mm')) at $powerWatts W."
  Write-Host 'This replaces the complete current schedule, then attempts to restore it immediately.'
  Write-Host 'The test window may cause the battery to charge if it remains active long enough.'
  $confirmation = Read-Host 'Type REPLACE to continue'
  if ($confirmation -cne 'REPLACE') {
    Write-Host 'No schedule was changed.'
    return
  }

  $writeError = $null
  $restoreError = $null
  try {
    Invoke-FoxEssPost -Path '/op/v3/device/scheduler/enable' -Payload @{
      deviceSN = $deviceSN
      isDefault = $false
      groups = @($testGroup)
    } | Out-Null
    Write-Host 'Test schedule accepted by Fox ESS.'
  } catch {
    $writeError = $_.Exception.Message
  }

  try {
    Start-Sleep -Seconds 2
    Invoke-FoxEssPost -Path '/op/v3/device/scheduler/enable' -Payload @{
      deviceSN = $deviceSN
      isDefault = $false
      groups = $originalGroups
    } | Out-Null
    Write-Host 'Original schedule restored.'
  } catch {
    $restoreError = $_.Exception.Message
  }

  if ($restoreError) {
    throw "CRITICAL: Could not restore the original schedule. Reapply it in Fox ESS Cloud. Error: $restoreError"
  }
  if ($writeError) {
    throw "Test write failed; the original schedule was restored. Error: $writeError"
  }
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($apiKeyPointer)
  $apiKeySecure.Dispose()
  $apiKey = $null
}
