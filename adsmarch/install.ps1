param(
  [switch]$ConfigureOnly
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$script:SourceDir = $PSScriptRoot
$script:InstallDir = Join-Path $env:LOCALAPPDATA "Adsmarch"
$script:EnvPath = Join-Path $script:InstallDir ".env"
$script:NodeExe = ""
$script:NpmCmd = ""

function Write-Banner {
  Write-Host ""
  Write-Host "  ==========================================" -ForegroundColor DarkCyan
  Write-Host "        Adsmarch  对话式广告投放助手" -ForegroundColor Cyan
  Write-Host "        Windows 一键安装 / 配置向导" -ForegroundColor Cyan
  Write-Host "  ==========================================" -ForegroundColor DarkCyan
  Write-Host ""
}

function Write-Step([string]$Text) {
  Write-Host ""
  Write-Host "==> $Text" -ForegroundColor Cyan
}

function Write-Ok([string]$Text) {
  Write-Host "  [OK] $Text" -ForegroundColor Green
}

function Write-Warn([string]$Text) {
  Write-Host "  [!] $Text" -ForegroundColor Yellow
}

function Ask-Text {
  param(
    [string]$Prompt,
    [string]$Default = "",
    [switch]$AllowEmpty
  )
  while ($true) {
    if ($Default -ne "") {
      $answer = Read-Host "$Prompt [$Default]"
    } else {
      $answer = Read-Host $Prompt
    }
    if ([string]::IsNullOrWhiteSpace($answer)) { $answer = $Default }
    if ($AllowEmpty -or -not [string]::IsNullOrWhiteSpace($answer)) { return $answer }
    Write-Warn "该项不能为空，请重新输入。"
  }
}

function Ask-YesNo {
  param([string]$Prompt, [bool]$Default = $false)
  $suffix = "[y/N]"
  if ($Default) { $suffix = "[Y/n]" }
  while ($true) {
    $answer = Read-Host "$Prompt $suffix"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    switch ($answer.Trim().ToLowerInvariant()) {
      "y" { return $true }
      "yes" { return $true }
      "n" { return $false }
      "no" { return $false }
      default { Write-Warn "请输入 y 或 n。" }
    }
  }
}

function Ask-SecretOptional {
  param([string]$Prompt, [string]$Existing = "")
  $label = "$Prompt（回车跳过）"
  if (-not [string]::IsNullOrEmpty($Existing)) { $label = "$Prompt（已配置，回车保留）" }
  $secure = Read-Host -AsSecureString -Prompt $label
  if ($null -eq $secure) { return $Existing }
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
  if ([string]::IsNullOrWhiteSpace($plain)) { return $Existing }
  return $plain
}

function New-RandomHex([int]$Bytes = 24) {
  $buffer = New-Object System.Byte[] $Bytes
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
  return -join ($buffer | ForEach-Object { $_.ToString("x2") })
}

function New-RandomBase64([int]$Bytes = 32) {
  $buffer = New-Object System.Byte[] $Bytes
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($buffer)
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

function Read-EnvFile([string]$Path) {
  $map = @{}
  if (-not (Test-Path $Path)) { return $map }
  $lines = [IO.File]::ReadAllLines($Path, [Text.Encoding]::UTF8)
  foreach ($line in $lines) {
    $trimmed = $line.Trim()
    if ($trimmed -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
      $key = $matches[1]
      $value = $matches[2].Trim()
      if ($value.Length -ge 2) {
        $first = $value.Substring(0, 1)
        $last = $value.Substring($value.Length - 1, 1)
        if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
          $value = $value.Substring(1, $value.Length - 2)
        }
      }
      $map[$key] = $value
    }
  }
  return $map
}

function Format-EnvValue([string]$Value) {
  if ($null -eq $Value) { return "" }
  if ($Value -match '[ #"]') {
    return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
  }
  return $Value
}

function To-BatchPath([string]$Path) {
  return $Path.Replace("%", "%%")
}

function Test-NodeOk([string]$Path) {
  if (-not (Test-Path $Path)) { return $false }
  try {
    $version = & $Path -p "process.versions.node" 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$version)) { return $false }
    $parts = ([string]$version).Trim().Split(".")
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    return ($major -ge 22 -and ($major -gt 22 -or $minor -ge 5))
  } catch {
    return $false
  }
}

function Install-PortableNode {
  New-Item -ItemType Directory -Force -Path $script:InstallDir | Out-Null
  $arch = "x64"
  if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { $arch = "arm64" }

  $version = "v22.14.0"
  try {
    $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -UseBasicParsing -TimeoutSec 30
    $lts = $index | Where-Object { $_.lts -ne $false } | Select-Object -First 1
    if ($lts -and $lts.version) { $version = [string]$lts.version }
  } catch {
    Write-Warn "无法获取 Node.js 最新版本，使用内置版本 $version。"
  }

  $runtime = Join-Path $script:InstallDir "runtime\node"
  $nodeExe = Join-Path $runtime "node.exe"
  if ((Test-Path $nodeExe) -and (Test-NodeOk $nodeExe)) {
    $script:NodeExe = $nodeExe
    Write-Ok "使用 Adsmarch 自带 Node.js"
    return
  }

  $zip = Join-Path $env:TEMP "adsmarch-node.zip"
  $extract = Join-Path $env:TEMP "adsmarch-node-extract"
  $fileName = "node-$version-win-$arch.zip"
  $urls = @(
    "https://nodejs.org/dist/$version/$fileName",
    "https://npmmirror.com/mirrors/node/$version/$fileName"
  )

  $downloaded = $false
  foreach ($url in $urls) {
    try {
      Write-Host "  正在下载 Node.js（约 30MB）：$url"
      Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 600
      $downloaded = $true
      break
    } catch {
      Write-Warn "下载失败：$($_.Exception.Message)"
    }
  }
  if (-not $downloaded) {
    throw "Node.js 下载失败。请检查网络后重新运行 install.bat，或手动安装 Node.js 22.5+（https://nodejs.org）。"
  }

  Write-Host "  正在解压..."
  if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($zip, $extract)
  $folder = Get-ChildItem -Path $extract -Directory | Select-Object -First 1
  if (-not $folder) { throw "Node.js 压缩包内容异常。" }
  if (Test-Path (Join-Path $script:InstallDir "runtime")) {
    Remove-Item -Recurse -Force (Join-Path $script:InstallDir "runtime")
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $script:InstallDir "runtime") | Out-Null
  Move-Item -Path $folder.FullName -Destination $runtime
  Remove-Item -Recurse -Force $extract -ErrorAction SilentlyContinue
  Remove-Item -Force $zip -ErrorAction SilentlyContinue

  if (-not (Test-NodeOk $nodeExe)) { throw "Node.js 安装后校验失败。" }
  $script:NodeExe = $nodeExe
  Write-Ok "Node.js 已安装到 $runtime"
}

function Ensure-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and (Test-NodeOk $cmd.Source)) {
    $script:NodeExe = $cmd.Source
    Write-Ok "使用已安装的 Node.js $(& $script:NodeExe -v)"
    return
  }
  if ($cmd) { Write-Warn "已安装的 Node.js 版本低于 22.5，改用 Adsmarch 自带版本。" }
  Write-Step "准备 Node.js 运行时（仅首次需要）"
  Install-PortableNode
}

function Resolve-ExistingNode {
  $runtimeNode = Join-Path $script:InstallDir "runtime\node\node.exe"
  if (Test-Path $runtimeNode) {
    $script:NodeExe = $runtimeNode
  } else {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and (Test-NodeOk $cmd.Source)) {
      $script:NodeExe = $cmd.Source
    } else {
      throw "未找到可用的 Node.js，请先运行 install.bat 完成安装。"
    }
  }
  $script:NpmCmd = Join-Path (Split-Path $script:NodeExe -Parent) "npm.cmd"
  if (-not (Test-Path $script:NpmCmd)) {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($npm) { $script:NpmCmd = $npm.Source }
  }
}

function Copy-AppFiles {
  $src = (Resolve-Path $script:SourceDir).Path.TrimEnd("\")
  $dst = $script:InstallDir.TrimEnd("\")
  if ($src -eq $dst) {
    Write-Ok "已在安装目录中运行，跳过文件复制。"
    return
  }
  Write-Step "复制程序文件到 $dst"
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  $roboArgs = @(
    $src, $dst, "/E",
    "/XD", "node_modules", "dist", "data", ".git", ".uploads",
    "/XF", ".env", "*.zip",
    "/NFL", "/NDL", "/NJH", "/NJS", "/NP"
  )
  & robocopy @roboArgs | Out-Null
  if ($LASTEXITCODE -ge 8) {
    throw "复制文件失败（robocopy 退出码 $LASTEXITCODE）。请关闭占用文件的程序后重试。"
  }
  $global:LASTEXITCODE = 0
  Write-Ok "文件复制完成"
}

function Install-Dependencies {
  $nodeDir = Split-Path $script:NodeExe -Parent
  $script:NpmCmd = Join-Path $nodeDir "npm.cmd"
  if (-not (Test-Path $script:NpmCmd)) {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($npm) { $script:NpmCmd = $npm.Source }
  }
  if (-not (Test-Path $script:NpmCmd)) {
    throw "找不到 npm.cmd，Node.js 安装可能不完整。"
  }

  $env:PATH = "$nodeDir;" + $env:PATH
  Push-Location $script:InstallDir
  try {
    Write-Step "安装依赖（首次约 1-3 分钟，请保持网络畅通）"
    & $script:NpmCmd install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
      Write-Warn "官方源下载失败，改用国内镜像重试..."
      & $script:NpmCmd install --no-audit --no-fund --registry=https://registry.npmmirror.com
    }
    if ($LASTEXITCODE -ne 0) { throw "npm install 失败，请检查网络或代理后重试。" }

    Write-Step "构建程序"
    & $script:NpmCmd run build
    if ($LASTEXITCODE -ne 0) { throw "构建失败（npm run build）。" }
  } finally {
    Pop-Location
  }

  if (-not (Test-Path (Join-Path $script:InstallDir "dist\server\mcp.js"))) {
    throw "构建产物缺失：dist\server\mcp.js"
  }
  Write-Ok "依赖安装与构建完成"
}

function Invoke-Wizard {
  $ex = Read-EnvFile $script:EnvPath
  $cfg = @{}

  Write-Step "第 1 步 / 运行模式"
  Write-Host "  Live：连接真实的 Google / Meta / TikTok 广告账户，会真实花费。"
  Write-Host "  Mock：本地演示，不花一分钱，适合先熟悉流程。"
  $liveDefault = $true
  if ($ex["ADS_MODE"] -eq "mock") { $liveDefault = $false }
  $live = Ask-YesNo "是否使用真实广告账户（Live 模式）？" $liveDefault
  if ($live) { $cfg["ADS_MODE"] = "live" } else { $cfg["ADS_MODE"] = "mock" }

  Write-Step "第 2 步 / 管理台地址"
  $portDefault = $ex["ADS_HTTP_PORT"]
  if ([string]::IsNullOrWhiteSpace($portDefault)) { $portDefault = "8787" }
  while ($true) {
    $port = Ask-Text "管理台端口" $portDefault
    $portNumber = 0
    if ([int]::TryParse($port, [ref]$portNumber) -and $portNumber -ge 1 -and $portNumber -le 65535) { break }
    Write-Warn "端口必须是 1-65535 的数字。"
  }
  $cfg["ADS_HTTP_PORT"] = [string]$portNumber

  $baseDefault = "http://localhost:$portNumber"
  $oldBase = $ex["ADS_PUBLIC_BASE_URL"]
  if ($oldBase -and ($oldBase -notmatch "localhost") -and ($oldBase -notmatch "127.0.0.1")) {
    $baseDefault = $oldBase
  }
  $base = Ask-Text "OAuth 回调对外地址（本机使用默认即可）" $baseDefault
  if ($base -notmatch '^https?://') { $base = "http://" + $base }
  $base = $base.TrimEnd("/")
  $cfg["ADS_PUBLIC_BASE_URL"] = $base

  Write-Step "第 3 步 / 平台凭证"
  Write-Host "  OAuth 回调地址（必须在平台后台登记，必须完全一致）："
  Write-Host "    Google : $base/auth/google/callback"
  Write-Host "    Meta   : $base/auth/meta/callback"
  Write-Host "    TikTok : $base/auth/tiktok/callback"
  Write-Host "  不清楚怎么申请？打开安装目录 docs 文件夹，或先跳过，稍后用「配置账户.bat」补全。"
  Write-Host ""

  $cfg["GOOGLE_CLIENT_ID"] = $ex["GOOGLE_CLIENT_ID"]
  $cfg["GOOGLE_CLIENT_SECRET"] = $ex["GOOGLE_CLIENT_SECRET"]
  $cfg["GOOGLE_DEVELOPER_TOKEN"] = $ex["GOOGLE_DEVELOPER_TOKEN"]
  $cfg["GOOGLE_LOGIN_CUSTOMER_ID"] = $ex["GOOGLE_LOGIN_CUSTOMER_ID"]
  $cfg["GOOGLE_ADS_API_VERSION"] = $ex["GOOGLE_ADS_API_VERSION"]
  if ([string]::IsNullOrWhiteSpace($cfg["GOOGLE_ADS_API_VERSION"])) { $cfg["GOOGLE_ADS_API_VERSION"] = "v21" }

  $cfg["META_APP_ID"] = $ex["META_APP_ID"]
  $cfg["META_APP_SECRET"] = $ex["META_APP_SECRET"]
  $cfg["META_PAGE_ID"] = $ex["META_PAGE_ID"]
  $cfg["META_API_VERSION"] = $ex["META_API_VERSION"]
  if ([string]::IsNullOrWhiteSpace($cfg["META_API_VERSION"])) { $cfg["META_API_VERSION"] = "v23.0" }

  $cfg["TIKTOK_APP_ID"] = $ex["TIKTOK_APP_ID"]
  $cfg["TIKTOK_APP_SECRET"] = $ex["TIKTOK_APP_SECRET"]
  $cfg["TIKTOK_API_VERSION"] = $ex["TIKTOK_API_VERSION"]
  if ([string]::IsNullOrWhiteSpace($cfg["TIKTOK_API_VERSION"])) { $cfg["TIKTOK_API_VERSION"] = "v1.3" }

  if ($live) {
    Write-Host "--- Google Ads ---"
    if (Ask-YesNo "现在配置 Google Ads？" $true) {
      $cfg["GOOGLE_CLIENT_ID"] = Ask-Text "Google OAuth 客户端 ID（回车跳过）" $cfg["GOOGLE_CLIENT_ID"] -AllowEmpty
      $cfg["GOOGLE_CLIENT_SECRET"] = Ask-SecretOptional "Google OAuth 客户端密钥" $cfg["GOOGLE_CLIENT_SECRET"]
      $cfg["GOOGLE_DEVELOPER_TOKEN"] = Ask-SecretOptional "Google Ads Developer Token" $cfg["GOOGLE_DEVELOPER_TOKEN"]
      $cfg["GOOGLE_LOGIN_CUSTOMER_ID"] = Ask-Text "MCC 管理账户 ID（没有可直接回车）" $cfg["GOOGLE_LOGIN_CUSTOMER_ID"] -AllowEmpty
    }

    Write-Host ""
    Write-Host "--- Meta ---"
    if (Ask-YesNo "现在配置 Meta（Facebook / Instagram）？" $true) {
      $cfg["META_APP_ID"] = Ask-Text "Meta App ID（回车跳过）" $cfg["META_APP_ID"] -AllowEmpty
      $cfg["META_APP_SECRET"] = Ask-SecretOptional "Meta App Secret" $cfg["META_APP_SECRET"]
      $cfg["META_PAGE_ID"] = Ask-Text "Facebook 主页 ID（可选，回车跳过）" $cfg["META_PAGE_ID"] -AllowEmpty
    }

    Write-Host ""
    Write-Host "--- TikTok ---"
    if (Ask-YesNo "现在配置 TikTok？" $true) {
      $cfg["TIKTOK_APP_ID"] = Ask-Text "TikTok App ID（回车跳过）" $cfg["TIKTOK_APP_ID"] -AllowEmpty
      $cfg["TIKTOK_APP_SECRET"] = Ask-SecretOptional "TikTok App Secret" $cfg["TIKTOK_APP_SECRET"]
    }

    $hasAny = ($cfg["GOOGLE_CLIENT_ID"] -ne "") -or ($cfg["META_APP_ID"] -ne "") -or ($cfg["TIKTOK_APP_ID"] -ne "")
    if (-not $hasAny) {
      Write-Warn "还没有填写任何平台凭证。管理台仍会打开，但连接账户前需要补全。"
      Write-Warn "稍后双击安装目录里的「配置账户.bat」即可继续填写。"
    }
  } else {
    Write-Ok "演示模式：不会调用任何广告平台，也不会产生真实花费。"
  }

  Write-Step "第 4 步 / 安全与网络"
  $cfg["ADS_APPROVAL_MODE"] = "required"
  $cfg["ADS_ENCRYPTION_KEY"] = $ex["ADS_ENCRYPTION_KEY"]
  if ([string]::IsNullOrWhiteSpace($cfg["ADS_ENCRYPTION_KEY"])) {
    $cfg["ADS_ENCRYPTION_KEY"] = New-RandomBase64 32
    Write-Ok "已生成凭据加密密钥（保存在 .env，请勿删除或外传）。"
  }
  $cfg["ADS_ADMIN_TOKEN"] = $ex["ADS_ADMIN_TOKEN"]
  if ([string]::IsNullOrWhiteSpace($cfg["ADS_ADMIN_TOKEN"])) {
    $cfg["ADS_ADMIN_TOKEN"] = New-RandomHex 24
    Write-Ok "已生成管理台访问令牌，桌面快捷方式会自动带上它。"
  }

  $budgetDefault = $ex["ADS_MAX_DAILY_BUDGET"]
  if ([string]::IsNullOrWhiteSpace($budgetDefault)) { $budgetDefault = "2000" }
  while ($true) {
    $budget = Ask-Text "单个账户日预算安全上限（账户币种，超过会被拒绝）" $budgetDefault
    $budgetNumber = 0.0
    if ([double]::TryParse($budget, [ref]$budgetNumber) -and $budgetNumber -gt 0) { break }
    Write-Warn "请输入大于 0 的数字。"
  }
  $cfg["ADS_MAX_DAILY_BUDGET"] = [string]$budgetNumber

  $proxyDefault = $ex["HTTPS_PROXY"]
  if ([string]::IsNullOrWhiteSpace($proxyDefault)) { $proxyDefault = "" }
  $proxy = Ask-Text "HTTPS 代理（没有请直接回车）" $proxyDefault -AllowEmpty
  $cfg["HTTPS_PROXY"] = $proxy

  return $cfg
}

function Write-EnvFile($cfg) {
  $dataDir = (Join-Path $script:InstallDir "data") -replace "\\", "/"
  $dbPath = $dataDir + "/adsmarch.db"

  $lines = @()
  $lines += "# Adsmarch configuration generated by the Windows installer on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  $lines += "# Keep this file private. Do not commit or share it."
  $lines += "ADS_MODE=" + (Format-EnvValue $cfg["ADS_MODE"])
  $lines += "ADS_APPROVAL_MODE=" + (Format-EnvValue $cfg["ADS_APPROVAL_MODE"])
  $lines += "ADS_HTTP_PORT=" + (Format-EnvValue $cfg["ADS_HTTP_PORT"])
  $lines += "ADS_PUBLIC_BASE_URL=" + (Format-EnvValue $cfg["ADS_PUBLIC_BASE_URL"])
  $lines += "ADS_ADMIN_TOKEN=" + (Format-EnvValue $cfg["ADS_ADMIN_TOKEN"])
  $lines += "ADS_DATA_DIR=" + (Format-EnvValue $dataDir)
  $lines += "ADS_DB_PATH=" + (Format-EnvValue $dbPath)
  $lines += "ADS_ENCRYPTION_KEY=" + (Format-EnvValue $cfg["ADS_ENCRYPTION_KEY"])
  $lines += "ADS_MAX_DAILY_BUDGET=" + (Format-EnvValue $cfg["ADS_MAX_DAILY_BUDGET"])
  $lines += "ADS_INSIGHTS_CACHE_TTL_SECONDS=600"
  $lines += "GOOGLE_CLIENT_ID=" + (Format-EnvValue $cfg["GOOGLE_CLIENT_ID"])
  $lines += "GOOGLE_CLIENT_SECRET=" + (Format-EnvValue $cfg["GOOGLE_CLIENT_SECRET"])
  $lines += "GOOGLE_DEVELOPER_TOKEN=" + (Format-EnvValue $cfg["GOOGLE_DEVELOPER_TOKEN"])
  $lines += "GOOGLE_LOGIN_CUSTOMER_ID=" + (Format-EnvValue $cfg["GOOGLE_LOGIN_CUSTOMER_ID"])
  $lines += "GOOGLE_ADS_API_VERSION=" + (Format-EnvValue $cfg["GOOGLE_ADS_API_VERSION"])
  $lines += "META_APP_ID=" + (Format-EnvValue $cfg["META_APP_ID"])
  $lines += "META_APP_SECRET=" + (Format-EnvValue $cfg["META_APP_SECRET"])
  $lines += "META_API_VERSION=" + (Format-EnvValue $cfg["META_API_VERSION"])
  $lines += "META_PAGE_ID=" + (Format-EnvValue $cfg["META_PAGE_ID"])
  $lines += "TIKTOK_APP_ID=" + (Format-EnvValue $cfg["TIKTOK_APP_ID"])
  $lines += "TIKTOK_APP_SECRET=" + (Format-EnvValue $cfg["TIKTOK_APP_SECRET"])
  $lines += "TIKTOK_API_VERSION=" + (Format-EnvValue $cfg["TIKTOK_API_VERSION"])
  if ($cfg["HTTPS_PROXY"] -ne "") {
    $lines += "HTTPS_PROXY=" + (Format-EnvValue $cfg["HTTPS_PROXY"])
  }

  Write-Utf8NoBom $script:EnvPath (($lines -join "`r`n") + "`r`n")
  try {
    & icacls $script:EnvPath /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
  } catch {}
  Write-Ok "配置已写入 $script:EnvPath"
}

function New-Launchers($cfg) {
  $dir = To-BatchPath $script:InstallDir
  $node = To-BatchPath $script:NodeExe

  $runMcp = @'
@echo off
chcp 65001 >nul
cd /d "__DIR__"
"__NODE__" "__DIR__\dist\server\mcp.js"
'@
  $runMcp = $runMcp.Replace("__DIR__", $dir).Replace("__NODE__", $node)
  Write-Utf8NoBom (Join-Path $script:InstallDir "run-mcp.cmd") $runMcp

  $startAdmin = @'
@echo off
chcp 65001 >nul
cd /d "__DIR__"
"__NODE__" "dist\server\http.js"
echo.
echo 管理台已停止。按任意键关闭窗口。
pause >nul
'@
  $startAdmin = $startAdmin.Replace("__DIR__", $dir).Replace("__NODE__", $node)
  Write-Utf8NoBom (Join-Path $script:InstallDir "start-admin.cmd") $startAdmin

  $silent = @'
@echo off
chcp 65001 >nul
cd /d "__DIR__"
"__NODE__" "dist\server\http.js"
'@
  $silent = $silent.Replace("__DIR__", $dir).Replace("__NODE__", $node)
  $silentPath = Join-Path $script:InstallDir "start-admin-silent.cmd"
  Write-Utf8NoBom $silentPath $silent

  $configure = @'
@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -ConfigureOnly
echo.
pause
'@
  Write-Utf8NoBom (Join-Path $script:InstallDir "配置账户.bat") $configure

  $stopPs1 = @'
$dir = Split-Path -Parent $PSCommandPath
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($dir) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host "Adsmarch 管理台已停止。"
'@
  Write-Utf8NoBom (Join-Path $script:InstallDir "stop-admin.ps1") $stopPs1

  $stopBat = @'
@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-admin.ps1"
pause
'@
  Write-Utf8NoBom (Join-Path $script:InstallDir "停止管理台.bat") $stopBat

  $vbs = @'
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd.exe /c ""__SILENT__""", 0, False
'@
  $vbs = $vbs.Replace("__SILENT__", (To-BatchPath $silentPath))
  [IO.File]::WriteAllText((Join-Path $script:InstallDir "run-admin-hidden.vbs"), $vbs, [Text.Encoding]::Unicode)

  $port = $cfg["ADS_HTTP_PORT"]
  $help = @"
Adsmarch 使用说明
=================

管理台：http://localhost:$port/admin
（桌面上的「打开 Adsmarch 管理台」快捷方式已自动带上访问令牌）

第一次使用：
1. 双击桌面「打开 Adsmarch 管理台」。
2. 在页面里点击 Google / Meta / TikTok 的「连接账户」，按提示在浏览器完成授权。
3. 打开 Codex，新建对话，说：「打开 Adsmarch，先看看接入进度，然后带我连广告账户。」

修改平台凭证：
双击安装目录里的「配置账户.bat」，按提示重新填写；完成后会自动重启管理台。

停止管理台：
双击「停止管理台.bat」，或重启电脑（未勾选开机自启时）。

完全卸载：
双击项目目录里的 uninstall.bat。

文档：
安装目录 docs 文件夹中的 02/03/04 是三个平台的申请与对接步骤，05 是 Codex 使用说明。

重要：
- .env 保存了平台密钥和加密密钥，不要发给别人。
- 更换电脑或重装系统前，请备份整个 data 文件夹和 .env。
"@
  [IO.File]::WriteAllText((Join-Path $script:InstallDir "使用说明.txt"), $help, (New-Object Text.UTF8Encoding($true)))
}

function New-DesktopShortcuts($cfg, [bool]$AutoStart) {
  $port = $cfg["ADS_HTTP_PORT"]
  $adminUrl = "http://localhost:$port/admin"
  if ($cfg["ADS_ADMIN_TOKEN"] -ne "") {
    $adminUrl = $adminUrl + "?token=" + $cfg["ADS_ADMIN_TOKEN"]
  }

  $desktop = [Environment]::GetFolderPath("Desktop")
  if (-not [string]::IsNullOrEmpty($desktop)) {
    $urlPath = Join-Path $desktop "打开 Adsmarch 管理台.url"
    $urlContent = "[InternetShortcut]`r`nURL=$adminUrl`r`n"
    try {
      [IO.File]::WriteAllText($urlPath, $urlContent, [Text.Encoding]::ASCII)
    } catch {
      Write-Warn "创建桌面快捷方式失败：$($_.Exception.Message)"
    }
  }

  $startup = [Environment]::GetFolderPath("Startup")
  if (-not [string]::IsNullOrEmpty($startup)) {
    $lnkPath = Join-Path $startup "Adsmarch 管理台.lnk"
    if ($AutoStart) {
      try {
        $shell = New-Object -ComObject WScript.Shell
        $lnk = $shell.CreateShortcut($lnkPath)
        $lnk.TargetPath = "$env:SystemRoot\System32\wscript.exe"
        $lnk.Arguments = "`"$(Join-Path $script:InstallDir 'run-admin-hidden.vbs')`""
        $lnk.WorkingDirectory = $script:InstallDir
        $lnk.WindowStyle = 7
        $lnk.Save()
        Write-Ok "已设置开机自动启动管理台"
      } catch {
        Write-Warn "创建开机启动项失败：$($_.Exception.Message)"
      }
    } else {
      if (Test-Path $lnkPath) { Remove-Item -Force $lnkPath -ErrorAction SilentlyContinue }
      Write-Ok "未启用开机自启，可随时双击「打开 Adsmarch 管理台」"
    }
  }

  return $adminUrl
}

function Install-CodexIfRequested {
  $existing = Get-Command codex -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Ok "检测到 Codex：$($existing.Source)"
    return $existing.Source
  }

  $prefix = Join-Path $script:InstallDir "codex"
  $local = Join-Path $prefix "codex.cmd"
  if (Test-Path $local) { return $local }

  if (-not (Ask-YesNo "未检测到 Codex CLI，是否现在安装？（需要 OpenAI 账号）" $true)) {
    return $null
  }

  Write-Step "安装 Codex CLI"
  & $script:NpmCmd install -g @openai/codex --prefix $prefix --no-audit --no-fund --loglevel=error | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Warn "Codex CLI 安装失败。可稍后手动执行：npm install -g @openai/codex"
    return $null
  }

  if (Test-Path $local) { return $local }
  $bin = Join-Path $prefix "node_modules\.bin\codex.cmd"
  if (Test-Path $bin) { return $bin }
  Write-Warn "Codex 已安装，但未找到启动入口，请重新打开终端执行 codex。"
  return $null
}

function New-CodexLauncher([string]$CodexCmd) {
  if ($null -eq $CodexCmd -or $CodexCmd -eq "") { return }
  $dir = To-BatchPath $script:InstallDir
  $nodeDir = To-BatchPath (Split-Path $script:NodeExe -Parent)
  $codex = To-BatchPath $CodexCmd

  $launcher = @'
@echo off
chcp 65001 >nul
cd /d "__DIR__"
set "PATH=__NODEDIR__;__DIR__\codex;__DIR__\codex\node_modules\.bin;%PATH%"
call "__CODEX__"
echo.
pause
'@
  $launcher = $launcher.Replace("__DIR__", $dir).Replace("__NODEDIR__", $nodeDir).Replace("__CODEX__", $codex)
  $path = Join-Path $script:InstallDir "启动 Codex.cmd"
  Write-Utf8NoBom $path $launcher

  $desktop = [Environment]::GetFolderPath("Desktop")
  try {
    Copy-Item $path (Join-Path $desktop "与 Codex 对话.cmd") -Force
    Write-Ok "已创建「与 Codex 对话」桌面快捷方式"
  } catch {
    Write-Warn "创建桌面快捷方式失败：$($_.Exception.Message)"
  }
}

function Register-CodexConfig {
  try {
    $codexHome = Join-Path $env:USERPROFILE ".codex"
    New-Item -ItemType Directory -Force -Path $codexHome | Out-Null
    $config = Join-Path $codexHome "config.toml"
    $runMcp = Join-Path $script:InstallDir "run-mcp.cmd"
    $tomlPath = '"' + $runMcp.Replace('\', '\\').Replace('"', '\"') + '"'

    if (Test-Path $config) {
      $content = [IO.File]::ReadAllText($config, [Text.Encoding]::UTF8)
      if ($content -match '(?m)^\[mcp_servers\.adsmarch\]') {
        Write-Ok "Codex 已存在 Adsmarch 配置，未重复写入。"
        return
      }
      Copy-Item $config ($config + ".bak-" + (Get-Date -Format "yyyyMMddHHmmss")) -Force
    } else {
      $content = ""
    }

    $block = "`r`n[mcp_servers.adsmarch]`r`ncommand = `"cmd`"`r`nargs = [`"/c`", $tomlPath]`r`nstartup_timeout_sec = 30`r`n"
    [IO.File]::WriteAllText($config, $content + $block, (New-Object Text.UTF8Encoding($false)))
    Write-Ok "已写入 Codex 配置：$config"
  } catch {
    Write-Warn "写入 Codex 配置失败：$($_.Exception.Message)"
    Write-Warn "稍后可手动在 %USERPROFILE%\.codex\config.toml 中添加 [mcp_servers.adsmarch]。"
  }
}

function Stop-AdminProcesses {
  try {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains($script:InstallDir) } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch {}
}

function Start-AdminServer($cfg) {
  Stop-AdminProcesses
  Start-Sleep -Milliseconds 600

  Write-Step "启动管理台"
  $serverScript = Join-Path $script:InstallDir "dist\server\http.js"
  $startArgs = @{
    FilePath = $script:NodeExe
    ArgumentList = ('"' + $serverScript + '"')
    WorkingDirectory = $script:InstallDir
  }
  if ($env:OS -eq "Windows_NT") { $startArgs["WindowStyle"] = "Hidden" }
  Start-Process @startArgs | Out-Null
  $port = $cfg["ADS_HTTP_PORT"]
  $healthy = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -UseBasicParsing -TimeoutSec 2
      if ($health.ok) { $healthy = $true; break }
    } catch {}
  }

  if (-not $healthy) {
    Write-Warn "管理台启动失败。请双击安装目录里的 start-admin.cmd 查看错误信息。"
    Write-Warn "常见原因：端口被占用、.env 格式错误、杀毒软件拦截。"
    return $false
  }
  Write-Ok "管理台已启动：http://localhost:$port/admin"
  return $true
}

function Show-Summary($cfg, [bool]$Healthy, [string]$AdminUrl) {
  $port = $cfg["ADS_HTTP_PORT"]
  Write-Host ""
  Write-Host "  ==========================================" -ForegroundColor Green
  Write-Host "        安装完成！Adsmarch 已就绪" -ForegroundColor Green
  Write-Host "  ==========================================" -ForegroundColor Green
  Write-Host ""
  Write-Host "  安装目录：$script:InstallDir"
  Write-Host "  运行模式：$($cfg['ADS_MODE'])（审批模式：$($cfg['ADS_APPROVAL_MODE'])）"
  Write-Host "  管理台：http://localhost:$port/admin"
  Write-Host ""
  Write-Host "  下一步："
  Write-Host "   1. 双击桌面「打开 Adsmarch 管理台」"
  Write-Host "   2. 在管理台点击平台的「连接账户」，在浏览器完成授权"
  Write-Host "   3. 打开 Codex，说：「打开 Adsmarch，先看看接入进度，然后带我连广告账户」"
  Write-Host ""
  Write-Host "  修改凭证：双击安装目录里的「配置账户.bat」"
  Write-Host "  停止服务：双击「停止管理台.bat」"
  Write-Host "  完全卸载：双击项目目录里的 uninstall.bat"
  Write-Host "  详细文档：安装目录 docs 文件夹"
  Write-Host ""

  if ($cfg["ADS_MODE"] -eq "live") {
    Write-Host "  真实账户提示：" -ForegroundColor Yellow
    Write-Host "   - 平台后台的 OAuth 回调地址必须与下面一致："
    Write-Host "     $($cfg['ADS_PUBLIC_BASE_URL'])/auth/google/callback"
    Write-Host "     $($cfg['ADS_PUBLIC_BASE_URL'])/auth/meta/callback"
    Write-Host "     $($cfg['ADS_PUBLIC_BASE_URL'])/auth/tiktok/callback"
    Write-Host "   - 创建广告默认是暂停状态，确认后再恢复投放。"
    Write-Host ""
  } else {
    Write-Host "  当前是演示模式：所有数据本地模拟，不会产生真实花费。" -ForegroundColor Yellow
    Write-Host ""
  }

  if ($Healthy) {
    if (Ask-YesNo "现在打开管理台浏览器页面？" $true) {
      try { Start-Process $AdminUrl } catch {}
    }
  }
}

trap {
  Write-Host ""
  Write-Host "安装失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host "请检查网络/代理后重新运行 install.bat；若仍失败，请截图错误信息。"
  Write-Host ""
  exit 1
}

Write-Banner
try { $Host.UI.RawUI.WindowTitle = "Adsmarch 安装向导" } catch {}

if ($ConfigureOnly) {
  if (-not (Test-Path $script:InstallDir)) {
    throw "还没有安装 Adsmarch。请先双击 install.bat。"
  }
  Write-Step "更新配置"
  Resolve-ExistingNode
  $cfg = Invoke-Wizard
  Write-EnvFile $cfg
  New-Launchers $cfg | Out-Null
  Register-CodexConfig
  $codexCmd = Install-CodexIfRequested
  New-CodexLauncher $codexCmd
  $autoStart = Ask-YesNo "是否开机自动启动管理台？" $true
  $adminUrl = New-DesktopShortcuts $cfg $autoStart
  $healthy = Start-AdminServer $cfg
  Show-Summary $cfg $healthy $adminUrl
  exit 0
}

Copy-AppFiles
Ensure-Node
Install-Dependencies

Write-Step "第 5 步 / 生成启动项"
$cfg = Invoke-Wizard
Write-EnvFile $cfg
New-Launchers $cfg | Out-Null

$codexCmd = Install-CodexIfRequested
Register-CodexConfig
New-CodexLauncher $codexCmd

$autoStart = Ask-YesNo "是否开机自动启动管理台（推荐）？" $true
$adminUrl = New-DesktopShortcuts $cfg $autoStart

$healthy = Start-AdminServer $cfg
Show-Summary $cfg $healthy $adminUrl
