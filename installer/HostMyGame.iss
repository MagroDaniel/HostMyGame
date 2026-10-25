; Inno Setup script for the Windows installer. Built by installer\build.ps1, which stages the files first.
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef Stage
  #define Stage "build\stage"
#endif
#define PanelUrl "http://localhost:8082"

[Setup]
AppId={{8F3C2A6E-5B1D-4E7A-9C2F-3D6B8E1A4F70}
AppName=Host My Game
AppVersion={#AppVersion}
AppVerName=Host My Game {#AppVersion}
AppPublisher=Host My Game
DefaultDirName={autopf}\HostMyGame
DefaultGroupName=Host My Game
DisableProgramGroupPage=yes
OutputBaseFilename=HostMyGame-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
WizardStyle=modern
CloseApplications=no
RestartApplications=no
UninstallDisplayName=Host My Game
UninstallDisplayIcon={app}\logo.ico
SetupIconFile=logo.ico
SetupLogging=yes

[Languages]
Name: "ptbr"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[InstallDelete]
; Old program files go away on update; the data folder lives elsewhere and is never touched.
Type: filesandordirs; Name: "{app}\app"

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Dirs]
Name: "{commonappdata}\HostMyGame"

[INI]
Filename: "{group}\Abrir o painel.url"; Section: "InternetShortcut"; Key: "URL"; String: "{#PanelUrl}"
Filename: "{group}\Abrir o painel.url"; Section: "InternetShortcut"; Key: "IconFile"; String: "{app}\logo.ico"
Filename: "{group}\Abrir o painel.url"; Section: "InternetShortcut"; Key: "IconIndex"; String: "0"

[Icons]
Name: "{group}\Pasta de dados"; Filename: "{commonappdata}\HostMyGame"
Name: "{group}\Desinstalar Host My Game"; Filename: "{uninstallexe}"

[Run]
; "install" fails harmlessly when the service already exists (updates).
Filename: "{app}\HostMyGameService.exe"; Parameters: "install"; Flags: runhidden waituntilterminated; StatusMsg: "Registrando o serviço do Windows..."
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Host My Game"""; Flags: runhidden waituntilterminated
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""Host My Game"" dir=in action=allow program=""{app}\node\node.exe"" enable=yes"; Flags: runhidden waituntilterminated
Filename: "{app}\HostMyGameService.exe"; Parameters: "start"; Flags: runhidden waituntilterminated; StatusMsg: "Iniciando o painel..."
Filename: "{#PanelUrl}"; Description: "Abrir o painel no navegador"; Flags: postinstall shellexec nowait skipifsilent

[UninstallRun]
Filename: "{app}\HostMyGameService.exe"; Parameters: "stopwait"; Flags: runhidden waituntilterminated; RunOnceId: "StopService"
Filename: "{app}\HostMyGameService.exe"; Parameters: "uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveService"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Host My Game"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveFirewall"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
// On update the running service must stop (it stops the game servers) before its files are replaced.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
  Service: String;
begin
  Result := '';
  Service := ExpandConstant('{app}\HostMyGameService.exe');
  if FileExists(Service) then
  begin
    Exec(Service, 'stopwait', '', SW_HIDE, ewWaitUntilTerminated, Code);
    Sleep(2000);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  DataDir := ExpandConstant('{commonappdata}\HostMyGame');
  if (CurUninstallStep = usPostUninstall) and not UninstallSilent and DirExists(DataDir) then
    if MsgBox('Apagar também os dados do painel (servidores, mundos, backups e contas) em ' + DataDir + '?' + #13#10#13#10 +
              'Escolha "Não" para manter tudo e poder reinstalar depois. Isso não pode ser desfeito.',
              mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      DelTree(DataDir, True, True, True);
end;
