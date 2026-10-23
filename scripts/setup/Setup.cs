// Instalador de BitChord en un solo .exe (lo compila scripts/build-installer.mjs con el csc de .NET Framework,
// que viene con Windows). Lleva dentro la app completa (payload.zip) y la instala sin internet en
// %LOCALAPPDATA%\Programs\BitChord, como installer/instalar.ps1: accesos directos, entrada en
// "Aplicaciones instaladas" y abre BitChord al terminar. Los ajustes (%APPDATA%\BitChord) no se tocan.
// Con --auto (lo lanza el actualizador de BitChord) empieza solo y se cierra al acabar.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Instalador de BitChord")]
[assembly: AssemblyProduct("BitChord")]

static class Setup {
  static readonly string Dest = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\BitChord");

  static bool Auto;

  [STAThread]
  static void Main(string[] args) {
    Auto = Array.Exists(args, (a) => a.Equals("--auto", StringComparison.OrdinalIgnoreCase));
    Application.EnableVisualStyles();
    var version = Assembly.GetExecutingAssembly().GetName().Version;
    var form = new Form {
      Text = "Instalar BitChord", FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false,
      StartPosition = FormStartPosition.CenterScreen, ClientSize = new Size(420, 150), Font = new Font("Segoe UI", 9.5f),
      BackColor = Color.FromArgb(24, 24, 27), ForeColor = Color.White,
      Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath),
    };
    var title = new Label { Text = "BitChord " + Bitchord.Version, Font = new Font("Segoe UI Semibold", 14f), AutoSize = true, Location = new Point(20, 16) };
    var status = new Label { Text = "Se instalará en " + Dest, AutoSize = false, Size = new Size(380, 36), Location = new Point(20, 52), ForeColor = Color.FromArgb(190, 190, 195) };
    var bar = new ProgressBar { Location = new Point(20, 92), Size = new Size(280, 24), Maximum = 1000 };
    var btn = new Button { Text = "Instalar", Location = new Point(312, 90), Size = new Size(88, 28), FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(0x94, 0x08, 0x25), ForeColor = Color.White };
    btn.FlatAppearance.BorderSize = 0;
    form.Controls.AddRange(new Control[] { title, status, bar, btn });
    form.AcceptButton = btn;

    btn.Click += (s, e) => {
      btn.Enabled = false;
      new Thread(() => {
        try {
          Install((done, text) => form.BeginInvoke((Action)(() => { bar.Value = Math.Min(1000, done); status.Text = text; })));
          form.BeginInvoke((Action)(() => {
            status.Text = "Listo. BitChord está en el Escritorio y en el menú Inicio.";
            Process.Start(new ProcessStartInfo(Path.Combine(Dest, "BitChord.exe")) { WorkingDirectory = Dest });
            btn.Text = "Cerrar"; btn.Enabled = true; btn.Click += (s2, e2) => form.Close();
            if (Auto) { var t = new System.Windows.Forms.Timer { Interval = 1500 }; t.Tick += (s3, e3) => form.Close(); t.Start(); }
          }));
        } catch (Exception ex) {
          form.BeginInvoke((Action)(() => {
            MessageBox.Show(form, "No se pudo instalar BitChord:\n\n" + ex.Message, "Instalar BitChord", MessageBoxButtons.OK, MessageBoxIcon.Error);
            form.Close();
          }));
        }
      }) { IsBackground = true }.Start();
    };
    if (Auto) form.Shown += (s, e) => btn.PerformClick();
    Application.Run(form);
  }

  static void Install(Action<int, string> progress) {
    progress(0, "Cerrando BitChord si estaba abierto...");
    // (From the updater, BitChord is closing by itself: give it a moment to save before forcing it.)
    foreach (var p in Process.GetProcessesByName("BitChord")) { try { if (!Auto || !p.WaitForExit(10000)) { p.Kill(); p.WaitForExit(5000); } } catch { } }
    Thread.Sleep(500);

    progress(0, "Preparando la carpeta...");
    if (Directory.Exists(Dest)) {
      for (int i = 0; ; i++) {
        try { Directory.Delete(Dest, true); break; }
        catch (IOException) { if (i == 10) throw; Thread.Sleep(500); }
        catch (UnauthorizedAccessException) { if (i == 10) throw; Thread.Sleep(500); }
      }
    }
    Directory.CreateDirectory(Dest);

    using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
    using (var zip = new ZipArchive(stream, ZipArchiveMode.Read)) {
      long total = 0, done = 0;
      foreach (var e in zip.Entries) total += e.Length;
      foreach (var e in zip.Entries) {
        var path = Path.GetFullPath(Path.Combine(Dest, e.FullName));
        if (!path.StartsWith(Dest + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) continue;
        if (e.FullName.EndsWith("/")) { Directory.CreateDirectory(path); continue; }
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        e.ExtractToFile(path, true);
        done += e.Length;
        progress((int)(done * 1000 / Math.Max(1, total)), "Copiando archivos... " + (done * 100 / Math.Max(1, total)) + " %");
      }
    }

    progress(1000, "Creando accesos directos...");
    var exe = Path.Combine(Dest, "BitChord.exe");
    var ico = Path.Combine(Dest, "BitChord.ico");
    Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "BitChord.lnk"), exe, ico);
    Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "BitChord.lnk"), exe, ico);

    // Entrada en Configuración → Aplicaciones instaladas (solo para este usuario, sin permisos de administrador).
    using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\BitChord")) {
      k.SetValue("DisplayName", "BitChord");
      k.SetValue("DisplayVersion", Bitchord.Version);
      k.SetValue("Publisher", "BitChord Desktop");
      k.SetValue("DisplayIcon", ico);
      k.SetValue("InstallLocation", Dest);
      k.SetValue("UninstallString", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(Dest, "desinstalar.ps1") + "\"");
      k.SetValue("NoModify", 1, RegistryValueKind.DWord);
      k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
      k.SetValue("EstimatedSize", (int)(DirSize(new DirectoryInfo(Dest)) / 1024), RegistryValueKind.DWord);
    }
  }

  static void Shortcut(string lnkPath, string target, string icon) {
    var shellType = Type.GetTypeFromProgID("WScript.Shell");
    var shell = Activator.CreateInstance(shellType);
    var lnk = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
    var t = lnk.GetType();
    t.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { target });
    t.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { Path.GetDirectoryName(target) });
    t.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { icon + ",0" });
    t.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { "BitChord - cliente de YouTube Music" });
    t.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
  }

  static long DirSize(DirectoryInfo d) {
    long n = 0;
    foreach (var f in d.GetFiles("*", SearchOption.AllDirectories)) n += f.Length;
    return n;
  }
}
