# Runs an installed Windows app with This PC on and its Daemon in a throwaway Polaris home
# (windowsConnect.ts), then uninstalls that home with --purge and checks no sign-in task is left:
#
#   ./apps/desktop/scripts/packaging/windows-connect.ps1 -Application <app-x.y.z\Polaris.exe> -Daemon <bundled polaris.exe> [-Scratch <dir>]
#
# The home is never the profile's .polaris, so its task gets a hashed name (ADR 0060) and the
# real install's task is never touched. Run it from a checkout with dependencies installed.
param(
  [Parameter(Mandatory = $true)][string]$Application,
  # The package's polaris.exe, which uninstalls the home: never the copy installed inside it.
  [Parameter(Mandatory = $true)][string]$Daemon,
  [string]$Scratch = $env:TEMP,
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
$throwaway = Join-Path $Scratch "polaris-app-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$polarisHome = Join-Path $throwaway '.polaris'
New-Item -ItemType Directory $throwaway | Out-Null
$plainTask = "dev.lux.polaris.$($env:USERNAME -replace '[^A-Za-z0-9._-]', '_')"

function Get-PolarisTasks {
  @(Get-ScheduledTask -TaskName 'dev.lux.polaris.*' -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskName })
}

function Get-PlainTaskFacts {
  $task = Get-ScheduledTask -TaskName $plainTask -ErrorAction SilentlyContinue
  if ($task) { "$($task.Actions[0].Execute) $($task.Actions[0].Arguments) in $($task.Actions[0].WorkingDirectory)" } else { 'none' }
}

$tasksBefore = Get-PolarisTasks
$plainBefore = Get-PlainTaskFacts
$checkFailed = $null
$previousScriptedInstall = $env:POLARIS_DESKTOP_SCRIPTED_LOCAL_INSTALL
try {
  $env:POLARIS_DESKTOP_SCRIPTED_LOCAL_INSTALL = '1'
  & node (Join-Path $PSScriptRoot 'windowsConnect.ts') $Application $throwaway $TimeoutSeconds
  if ($LASTEXITCODE -ne 0) { throw "The app did not connect to This PC: $LASTEXITCODE" }

  $added = @(Get-PolarisTasks | Where-Object { $tasksBefore -notcontains $_ })
  if ($added.Count -ne 1) { throw "Expected the app to register one sign-in task, found: $($added -join ', ')" }
  if ($added[0] -notmatch "^$([regex]::Escape($plainTask))\.[0-9a-f]{8}$") {
    throw "The throwaway home's task is $($added[0]), not $plainTask.<hash>"
  }
  Write-Output "SIGN-IN TASK: $($added[0]) for $polarisHome"
} catch {
  $checkFailed = $_
  Get-ChildItem (Join-Path $polarisHome 'logs') -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Output "--- $($_.FullName)"; Get-Content $_.FullName -Tail 40
  }
} finally {
  $env:POLARIS_DESKTOP_SCRIPTED_LOCAL_INSTALL = $previousScriptedInstall
  $previousHome = $env:POLARIS_HOME
  $env:POLARIS_HOME = $polarisHome
  try {
    & $Daemon uninstall --purge --json
    $uninstalled = $LASTEXITCODE
  } finally {
    $env:POLARIS_HOME = $previousHome
  }

  $left = @(Get-PolarisTasks | Where-Object { $tasksBefore -notcontains $_ })
  $plainAfter = Get-PlainTaskFacts
  $teardown = @()
  if ($uninstalled -ne 0) { $teardown += "polaris uninstall --purge exited $uninstalled" }
  if ($left.Count -gt 0) { $teardown += "left sign-in tasks: $($left -join ', ')" }
  if ($plainAfter -ne $plainBefore) { $teardown += "$plainTask changed: $plainBefore -> $plainAfter" }
  $serving = @(Get-Process -Name polaris -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith("$throwaway\", [System.StringComparison]::OrdinalIgnoreCase) })
  if ($serving.Count -gt 0) { $teardown += "Daemons still running from ${throwaway}: $($serving.Id -join ', ')" }
  for ($try = 1; ; $try++) {
    try { Remove-Item $throwaway -Recurse -Force -ErrorAction Stop; break }
    catch { if ($try -ge 10) { $teardown += "could not remove ${throwaway}: $_"; break }; Start-Sleep -Milliseconds 500 }
  }
  if ($teardown.Count -gt 0) {
    $before = if ($checkFailed) { "$checkFailed; and teardown failed" } else { 'Teardown failed' }
    throw "${before}: $($teardown -join '; ')"
  }
  Write-Output "TORN DOWN: $polarisHome purged; sign-in tasks as before ($($tasksBefore.Count)); $plainTask $plainAfter"
}
if ($checkFailed) { throw $checkFailed }
