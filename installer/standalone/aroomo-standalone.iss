; Aroomo 独立版（不需要 Docker / WSL）离线安装包（Inno Setup 6）。D76–D79，设计见 docs/architecture/STANDALONE.md。
; CI 编译：iscc /DAppVersion=0.2.0-test.N /DStageDir=<build-windows.ps1 输出>\app installer\standalone\aroomo-standalone.iss
; 用户只需双击：不问任何问题、不需要管理员（D78），装到 %LOCALAPPDATA%\Programs\AroomoStandalone，装完自动打开。
; 含 LobeHub（LobeHub Community License）：仓库公开期间只能放在 GitHub 草稿发布里，不得公开发布。
; 本文件保存为 UTF-8 带 BOM。

#ifndef AppVersion
  #define AppVersion "0.2.0-dev"
#endif
#ifndef StageDir
  #define StageDir "..\..\build-stage\app"
#endif
#define PS "{sys}\WindowsPowerShell\v1.0\powershell.exe"

[Setup]
AppId={{6B0F3C1E-9A4D-4B7E-8C2A-A2D0F5E1A076}
AppName=Aroomo
AppVersion={#AppVersion}
AppVerName=Aroomo 独立版 {#AppVersion}（测试版）
AppPublisher=Aroomo
DefaultDirName={localappdata}\Programs\AroomoStandalone
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableWelcomePage=yes
DisableReadyPage=yes
DisableFinishedPage=yes
PrivilegesRequired=lowest
; 文件时间按 UTC 保存和还原：默认按「本地时间」，在 UTC+8 的电脑上会让所有文件的时间差 8 小时，
; Python 认为预编译的 .pyc 过期，每次启动都重新编译 LiteLLM（D77-3）
TimeStampsInUTC=yes
MinVersion=10.0.17763
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=Output
OutputBaseFilename=AroomoStandalone-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
LZMANumBlockThreads=4
LZMAUseSeparateProcess=yes
DiskSpanning=no
WizardStyle=modern
SetupIconFile=aroomo.ico
WizardSizePercent=130
UninstallDisplayName=Aroomo 独立版
UninstallDisplayIcon={app}\aroomo.ico
CloseApplications=no
ShowLanguageDialog=no

[Languages]
Name: "zh"; MessagesFile: "..\windows\languages\ChineseSimplified.isl"

[Messages]
zh.WizardInstalling=正在安装 Aroomo
zh.InstallingLabel=正在安装 Aroomo，大约需要几分钟。装好后会自动打开，不需要做任何选择。

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[InstallDelete]
; 升级：旧版本解开的对话界面由启动器按新的 lobe.tar.gz 重新解开
Type: files; Name: "{app}\lobe\.aroomo-lobe-sha256"

[Run]
; 装完自动打开（D78）：生成配置、快捷方式、登录自启，立刻显示「正在准备」窗口，后台在托盘里启动
Filename: "{sys}\wscript.exe"; Parameters: """{app}\installer\standalone\aroomo-launch.vbs"" firstrun"; WorkingDir: "{app}"; Flags: nowait

[UninstallRun]
; 停止服务、取消自启、删快捷方式；数据文件夹保留（D78）
Filename: "{#PS}"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\installer\standalone\aroomo-standalone.ps1"" -Action uninstall"; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; RunOnceId: "AroomoStop"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\lobe"
Type: filesandordirs; Name: "{app}\python\__pycache__"

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
  Script: String;
begin
  Result := '';
  // 升级时先停掉正在运行的旧版本（数据不动）
  Script := ExpandConstant('{app}\installer\standalone\aroomo-standalone.ps1');
  if FileExists(Script) then
    Exec(ExpandConstant('{#PS}'), '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + Script + '" -Action uninstall',
      ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code);
end;
