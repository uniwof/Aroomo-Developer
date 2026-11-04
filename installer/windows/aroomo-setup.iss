; Aroomo Windows 本地版安装包（Inno Setup 6）。CI 在 windows-latest 上编译：
;   iscc /DAppVersion=0.1.0 installer\windows\aroomo-setup.iss
; 安装包只负责把文件放到 %LOCALAPPDATA%\Aroomo\app，然后运行 Install-Aroomo.ps1（PowerShell 安装器）完成全部配置。
; 不需要管理员权限安装；启用 WSL2、安装 Docker Desktop 时由 PowerShell 单独请求管理员确认。
; 本文件保存为 UTF-8 带 BOM。

#ifndef AppVersion
  #define AppVersion "0.1.0-dev"
#endif
#define PS "{sys}\WindowsPowerShell\v1.0\powershell.exe"

[Setup]
AppId={{6B0F3C1E-9A4D-4B7E-8C2A-A2D0F5E1A001}
AppName=Aroomo
AppVersion={#AppVersion}
AppVerName=Aroomo 本地版 {#AppVersion}（测试版）
AppPublisher=Aroomo
DefaultDirName={localappdata}\Aroomo\app
DisableDirPage=yes
DisableProgramGroupPage=yes
DefaultGroupName=Aroomo
PrivilegesRequired=lowest
MinVersion=10.0.19045
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SourceDir=..\..
OutputDir=installer\windows\Output
OutputBaseFilename=AroomoSetup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Aroomo 本地版
; 主人设计的 Aroomo 图标（assets\brand，独立版共用）
SetupIconFile=assets\brand\aroomo.ico
UninstallDisplayIcon={app}\aroomo.ico
CloseApplications=no

[Languages]
; 简体中文界面：installer\windows\languages\ChineseSimplified.isl 取自 Inno Setup 官方仓库
; jrsoftware/issrc 标签 is-6_7_1 的 Files/Languages/Unofficial/ChineseSimplified.isl（适用 6.5.0+）
Name: "zh"; MessagesFile: "installer\windows\languages\ChineseSimplified.isl"

[Files]
Source: "deploy\*"; DestDir: "{app}\deploy"; Excludes: ".env,.restore,data,local-backups,test,drill-reports,*.log"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "scripts\*"; DestDir: "{app}\scripts"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "core\*"; DestDir: "{app}\core"; Excludes: "node_modules,dist,coverage,*.log,.env*"; Flags: recursesubdirs createallsubdirs ignoreversion
; Aroomo Shell（界面薄层；在本机构建，不含 LobeHub 代码，D71）
Source: "shell\*"; DestDir: "{app}\shell"; Excludes: "node_modules,dist,coverage,*.log,.env*"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "installer\windows\*.ps1"; DestDir: "{app}\installer\windows"; Flags: ignoreversion
Source: "installer\windows\*.psm1"; DestDir: "{app}\installer\windows"; Flags: ignoreversion
; 主密钥离线生成（D64）：官方 age-keygen，构建前由 installer\windows\Get-AgeKeygen.ps1 下载并核对 SHA-256
Source: "installer\windows\bin\age-keygen.exe"; DestDir: "{app}\installer\windows\bin"; Flags: ignoreversion
Source: "installer\windows\bin\age-LICENSE.txt"; DestDir: "{app}\installer\windows\bin"; Flags: ignoreversion
Source: "assets\brand\aroomo.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "docs\ops\WINDOWS.md"; DestDir: "{app}\docs"; Flags: ignoreversion
Source: "docs\ops\BACKUP.md"; DestDir: "{app}\docs"; Flags: ignoreversion

[Icons]
Name: "{group}\Aroomo 安装与修复"; Filename: "{#PS}"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\windows\Install-Aroomo.ps1"" -AppDir ""{app}"""; WorkingDir: "{app}"; IconFilename: "{app}\aroomo.ico"; Comment: "重新运行 Aroomo 安装（不会删除数据）"

[Run]
Filename: "{#PS}"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\windows\Install-Aroomo.ps1"" -AppDir ""{app}"""; WorkingDir: "{app}"; Description: "继续完成 Aroomo 安装（检查环境、安装 Docker Desktop、第一次启动）"; Flags: postinstall nowait

[Code]
var
  RemoveData: Boolean;

function InitializeUninstall(): Boolean;
begin
  RemoveData := False;
  if not UninstallSilent() then
    RemoveData := MsgBox('是否同时删除 Aroomo 的全部数据？' + #13#10 + #13#10 +
      '选「否」（推荐）：保留对话、成员、上传的文件和备份，重新安装后接着用。' + #13#10 +
      '选「是」：全部删除，无法恢复。', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Params: String;
  Code: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    Params := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}') +
      '\installer\windows\Uninstall-Aroomo.ps1" -AppDir "' + ExpandConstant('{app}') + '" -Unattended';
    if RemoveData then
      Params := Params + ' -RemoveData -Confirmed';
    Exec(ExpandConstant('{#PS}'), Params, ExpandConstant('{app}'), SW_SHOW, ewWaitUntilTerminated, Code);
  end;
end;
