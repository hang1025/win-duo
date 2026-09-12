'use strict';

/**
 * PowerShell snippets.
 *
 * They are piped to `powershell.exe -EncodedCommand`, never written to disk and
 * never run with `-File`, because the default Windows execution policy is
 * `Restricted` and would refuse a script file. Inline commands are not covered
 * by the execution policy, so these run on a stock machine with no changes.
 *
 * Windows PowerShell 5.1 is used rather than PowerShell 7 because .NET
 * Framework has first-class WinRT projection, which is what exposes
 * `Windows.Devices.Sensors`.
 *
 * Every line printed is ASCII so that the console code page cannot corrupt it.
 */

/**
 * Shared prelude.
 *
 * `IsSensor` exists because the obvious way to probe these classes is wrong in a
 * way that produces confident false positives: every sensor class returns
 * `IAsyncOperation<T>` from `GetDefaultAsync`, and that operation object is not
 * null even when the machine has no such sensor. Treating it as a sensor reports
 * hardware that is not there. A real sensor always has a `DeviceId`, and its
 * type name never mentions an async operation.
 */
const PRELUDE = `
$out = [Console]::Out
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
function IsSensor($o) {
  if ($null -eq $o) { return $false }
  $typeName = ''
  try { $typeName = $o.GetType().Name } catch { }
  if ($typeName -like '*AsyncOperation*') { return $false }
  try { if ($null -ne $o.DeviceId) { return $true } } catch { }
  return $false
}
`;

/** Which Windows sensor classes actually have a device on this machine. */
const SENSOR_INVENTORY = `${PRELUDE}
$names = @(
  'Accelerometer','ActivitySensor','Altimeter','Barometer','Compass','Gyrometer',
  'Inclinometer','LightSensor','Magnetometer','OrientationSensor','Pedometer',
  'ProximitySensor','SimpleOrientationSensor','HingeAngleSensor'
)
foreach ($n in $names) {
  $literal = "[Windows.Devices.Sensors.$n, Windows.Devices.Sensors, ContentType=WindowsRuntime]"
  try { $null = Invoke-Expression $literal } catch {
    $out.WriteLine("$n|NOCLASS")
    continue
  }

  $sensor = $null
  $how = ''

  try {
    $candidate = Invoke-Expression "$literal::GetDefault()"
    if (IsSensor $candidate) { $sensor = $candidate; $how = 'GetDefault' }
  } catch { }

  if ($null -eq $sensor) {
    try {
      $operation = Invoke-Expression "$literal::GetDefaultAsync()"
      if ($null -ne $operation -and $null -ne $operation.PSObject.Properties['Status']) {
        $deadline = (Get-Date).AddSeconds(4)
        while ("$($operation.Status)" -eq 'Started' -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 20 }
        if ("$($operation.Status)" -eq 'Completed') {
          $result = $operation.GetResults()
          if (IsSensor $result) { $sensor = $result; $how = 'GetDefaultAsync' }
        }
      }
    } catch { }
  }

  if ($null -eq $sensor) {
    $out.WriteLine("$n|ABSENT")
  } else {
    $device = ''
    try { $device = [string]$sensor.DeviceId } catch { }
    if ([string]::IsNullOrWhiteSpace($device)) { $device = '(no id)' }
    $out.WriteLine("$n|PRESENT|$how|$device")
  }
}
$out.Flush()
`;

/** Streams ambient light, or says why it cannot. */
const LIGHT_STREAM = `${PRELUDE}
$literal = "[Windows.Devices.Sensors.LightSensor, Windows.Devices.Sensors, ContentType=WindowsRuntime]"
$sensor = $null
try {
  $candidate = Invoke-Expression "$literal::GetDefault()"
  if (IsSensor $candidate) { $sensor = $candidate }
} catch { }
if ($null -eq $sensor) {
  try {
    $operation = Invoke-Expression "$literal::GetDefaultAsync()"
    if ($null -ne $operation -and $null -ne $operation.PSObject.Properties['Status']) {
      $deadline = (Get-Date).AddSeconds(4)
      while ("$($operation.Status)" -eq 'Started' -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 20 }
      if ("$($operation.Status)" -eq 'Completed') {
        $result = $operation.GetResults()
        if (IsSensor $result) { $sensor = $result }
      }
    }
  } catch { }
}
if ($null -eq $sensor) {
  $out.WriteLine('ABSENT')
  $out.Flush()
  exit 0
}
$out.WriteLine('OK')
$out.Flush()
while ($true) {
  try {
    $r = $sensor.GetCurrentReading()
    $out.WriteLine(("{0:0.####}" -f $r.IlluminanceInLux))
    $out.Flush()
  } catch {
    $out.WriteLine('ERR')
    $out.Flush()
  }
  Start-Sleep -Milliseconds 100
}
`;

/** Encodes a script for `powershell.exe -EncodedCommand` (UTF-16LE base64). */
function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

module.exports = { SENSOR_INVENTORY, LIGHT_STREAM, encodeCommand };
