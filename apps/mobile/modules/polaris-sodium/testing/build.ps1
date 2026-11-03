param(
  [string]$Scratch = (Join-Path $env:TEMP 'polaris-sodium build with spaces'),
  [string]$AndroidSdk = (Join-Path $env:LOCALAPPDATA 'Android\Sdk'),
  [string]$NdkVersion = '27.1.12297006',
  [string]$CMakeVersion = '3.22.1',
  [string]$Zig = ''
)

$ErrorActionPreference = 'Stop'
$Scratch = [IO.Path]::GetFullPath($Scratch)
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../../..'))
if ($Scratch.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Keep build outputs outside the checkout'
}
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../android'))
$cmake = Join-Path $AndroidSdk "cmake/$CMakeVersion/bin/cmake.exe"
$ninja = Join-Path $AndroidSdk "cmake/$CMakeVersion/bin/ninja.exe"
$ndk = Join-Path $AndroidSdk "ndk/$NdkVersion"
foreach ($tool in @($cmake, $ninja, (Join-Path $ndk 'build/cmake/android.toolchain.cmake'))) {
  if (!(Test-Path -LiteralPath $tool)) { throw "Missing $tool" }
}
New-Item -ItemType Directory -Path $Scratch -Force | Out-Null

foreach ($abi in @('x86_64', 'arm64-v8a')) {
  $build = Join-Path $Scratch $abi
  & $cmake -S $source -B $build -G Ninja "-DCMAKE_MAKE_PROGRAM=$ninja" `
    "-DCMAKE_TOOLCHAIN_FILE=$ndk/build/cmake/android.toolchain.cmake" `
    "-DANDROID_ABI=$abi" -DANDROID_PLATFORM=android-24 -DANDROID_STL=none -DCMAKE_BUILD_TYPE=Release
  if ($LASTEXITCODE -ne 0) { throw "$abi configure failed" }
  & $cmake --build $build --parallel 4
  if ($LASTEXITCODE -ne 0) { throw "$abi build failed" }
  Write-Output "PASS Android $abi library at $build/libpolaris_sodium.so"
}

if ($Zig) {
  if (!(Test-Path -LiteralPath $Zig)) { throw "Missing $Zig" }
  $Zig = [IO.Path]::GetFullPath($Zig).Replace('\', '/')
  if (!$env:JAVA_HOME) { throw 'JAVA_HOME must point to JDK 17 or newer' }
  $javaHome = [IO.Path]::GetFullPath($env:JAVA_HOME).Replace('\', '/')
  $hostBuild = Join-Path $Scratch 'host-jni'
  $llvmBin = Join-Path $ndk 'toolchains/llvm/prebuilt/windows-x86_64/bin'
  & $cmake -S $source -B $hostBuild -G Ninja "-DCMAKE_MAKE_PROGRAM=$ninja" `
    "-DCMAKE_C_COMPILER=$Zig;cc" "-DCMAKE_AR=$llvmBin/llvm-ar.exe" `
    "-DCMAKE_RANLIB=$llvmBin/llvm-ranlib.exe" "-DJAVA_HOME=$javaHome" `
    "-DJAVA_INCLUDE_PATH=$javaHome/include" "-DJAVA_INCLUDE_PATH2=$javaHome/include/win32" `
    "-DJAVA_AWT_INCLUDE_PATH=$javaHome/include" "-DJAVA_AWT_LIBRARY=$javaHome/lib/jawt.lib" `
    "-DJAVA_JVM_LIBRARY=$javaHome/lib/jvm.lib" -DCMAKE_BUILD_TYPE=Release
  if ($LASTEXITCODE -ne 0) { throw 'Host JNI configure failed' }
  & $cmake --build $hostBuild --parallel 4
  if ($LASTEXITCODE -ne 0) { throw 'Host JNI build failed' }
  & bun (Join-Path $PSScriptRoot 'check.ts') $hostBuild (Join-Path $Scratch 'parity')
  if ($LASTEXITCODE -ne 0) { throw 'JNI parity check failed' }
}
