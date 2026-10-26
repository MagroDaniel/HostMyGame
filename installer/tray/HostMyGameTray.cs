// Host My Game tray icon: shows whether the panel service is running and lets the user open, start, stop or
// restart it. The panel itself runs as a Windows service, which can't draw in the notification area, so this
// small program runs in each user's session (started from the Startup folder). Written for the C# 5 compiler
// that ships with Windows (.NET Framework 4.x), so the build needs nothing extra.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.ServiceProcess;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace HostMyGame
{
    static class Tray
    {
        const string ServiceName = "HostMyGame";
        static NotifyIcon icon;
        static ToolStripMenuItem startItem, stopItem, restartItem, stateItem;
        static ServiceControllerStatus? lastStatus;
        static bool busy;

        [STAThread]
        static void Main()
        {
            // The installer replaces files in Program Files on updates, so the icon runs from a per-user copy
            // and never locks the installed exe.
            if (RelaunchFromCopy()) return;

            bool created;
            using (new Mutex(true, "HostMyGameTrayIcon", out created))
            {
                if (!created) return;
                Application.EnableVisualStyles();
                BuildIcon();
                var timer = new System.Windows.Forms.Timer { Interval = 3000 };
                timer.Tick += delegate { Refresh(); };
                timer.Start();
                Refresh();
                Application.Run();
                icon.Visible = false;
            }
        }

        static bool RelaunchFromCopy()
        {
            try
            {
                string exe = Application.ExecutablePath;
                string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "HostMyGame", "tray");
                if (exe.StartsWith(dir, StringComparison.OrdinalIgnoreCase)) return false;
                Directory.CreateDirectory(dir);
                string copy = Path.Combine(dir, Path.GetFileName(exe));
                var src = new FileInfo(exe);
                var dst = new FileInfo(copy);
                if (!dst.Exists || dst.Length != src.Length || dst.LastWriteTimeUtc != src.LastWriteTimeUtc)
                {
                    try { File.Copy(exe, copy, true); File.SetLastWriteTimeUtc(copy, src.LastWriteTimeUtc); }
                    catch (IOException) { /* the old copy is running; it keeps working until the next login */ }
                }
                Process.Start(new ProcessStartInfo(copy) { UseShellExecute = false, WorkingDirectory = dir });
                return true;
            }
            catch (Exception)
            {
                return false; // can't copy: just run from where we are
            }
        }

        static void BuildIcon()
        {
            var menu = new ContextMenuStrip();
            stateItem = new ToolStripMenuItem("Host My Game") { Enabled = false };
            var open = new ToolStripMenuItem("Abrir o painel", null, delegate { OpenPanel(); });
            open.Font = new Font(open.Font, FontStyle.Bold);
            startItem = new ToolStripMenuItem("Iniciar o painel", null, delegate { Control("start"); });
            stopItem = new ToolStripMenuItem("Parar o painel", null, delegate { Control("stop"); });
            restartItem = new ToolStripMenuItem("Reiniciar o painel", null, delegate { Control("restart"); });
            var quit = new ToolStripMenuItem("Fechar este ícone", null, delegate { Application.Exit(); });
            menu.Items.AddRange(new ToolStripItem[] { stateItem, new ToolStripSeparator(), open, startItem, stopItem, restartItem, new ToolStripSeparator(), quit });

            icon = new NotifyIcon
            {
                Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application,
                Text = "Host My Game",
                ContextMenuStrip = menu,
                Visible = true,
            };
            icon.DoubleClick += delegate { OpenPanel(); };
        }

        static ServiceControllerStatus? Status()
        {
            try { using (var sc = new ServiceController(ServiceName)) return sc.Status; }
            catch (Exception) { return null; } // not installed
        }

        static void Refresh()
        {
            if (busy) return;
            var status = Status();
            string text;
            if (status == null) text = "não instalado";
            else if (status == ServiceControllerStatus.Running) text = "rodando";
            else if (status == ServiceControllerStatus.Stopped) text = "parado";
            else if (status == ServiceControllerStatus.StartPending) text = "iniciando...";
            else if (status == ServiceControllerStatus.StopPending) text = "parando...";
            else text = status.ToString();
            stateItem.Text = "Host My Game: " + text;
            icon.Text = "Host My Game — " + text;
            startItem.Enabled = status == ServiceControllerStatus.Stopped;
            stopItem.Enabled = restartItem.Enabled = status == ServiceControllerStatus.Running;
            if (lastStatus == ServiceControllerStatus.Running && status == ServiceControllerStatus.Stopped)
                icon.ShowBalloonTip(5000, "Host My Game", "O painel parou. Clique com o botão direito no ícone para iniciar de novo.", ToolTipIcon.Warning);
            lastStatus = status;
        }

        static void Control(string action)
        {
            if (action != "start")
            {
                var answer = MessageBox.Show(
                    "Todos os servidores de jogo serão desligados (com salvamento, quando o jogo permite). Continuar?",
                    action == "stop" ? "Parar o Host My Game" : "Reiniciar o Host My Game",
                    MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
                if (answer != DialogResult.OK) return;
            }
            busy = true;
            stateItem.Text = action == "start" ? "Host My Game: iniciando..." : "Host My Game: parando...";
            startItem.Enabled = stopItem.Enabled = restartItem.Enabled = false;
            var worker = new Thread(delegate ()
            {
                string error = null;
                try
                {
                    using (var sc = new ServiceController(ServiceName))
                    {
                        // Stopping waits for the game servers to save and shut down (up to two minutes).
                        if (action != "start" && sc.Status != ServiceControllerStatus.Stopped)
                        {
                            sc.Stop();
                            sc.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromMinutes(3));
                        }
                        if (action != "stop")
                        {
                            sc.Start();
                            sc.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromMinutes(1));
                        }
                    }
                }
                catch (Exception e)
                {
                    error = e is InvalidOperationException && e.InnerException != null ? e.InnerException.Message : e.Message;
                }
                icon.ContextMenuStrip.BeginInvoke((MethodInvoker)delegate
                {
                    busy = false;
                    lastStatus = null; // our own stop shouldn't show the "stopped by itself" balloon
                    Refresh();
                    if (error != null)
                        MessageBox.Show("Não foi possível " + (action == "start" ? "iniciar" : action == "stop" ? "parar" : "reiniciar") + " o painel:\n\n" + error +
                            "\n\nSe for falta de permissão, reinstale o Host My Game ou use services.msc como administrador.", "Host My Game", MessageBoxButtons.OK, MessageBoxIcon.Error);
                });
            });
            worker.IsBackground = true;
            worker.Start();
        }

        // The panel's port lives in its settings file; 8082 is the default.
        static void OpenPanel()
        {
            int port = 8082;
            try
            {
                string data = Environment.GetEnvironmentVariable("ProgramData") ?? @"C:\ProgramData";
                string json = File.ReadAllText(Path.Combine(data, "HostMyGame", "panel.json"));
                var m = Regex.Match(json, "\"port\"\\s*:\\s*(\\d+)");
                if (m.Success) port = int.Parse(m.Groups[1].Value);
            }
            catch (Exception) { }
            try { Process.Start("http://localhost:" + port); }
            catch (Exception e) { MessageBox.Show("Não foi possível abrir o navegador: " + e.Message, "Host My Game"); }
        }
    }
}
