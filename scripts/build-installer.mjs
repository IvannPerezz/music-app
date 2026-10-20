// Builds BitChord-Instalar-<version>.exe in the project folder: a single installer that carries the whole
// app (Electron + app.asar) and installs it offline (see scripts/setup/Setup.cs). Compiled with the csc of
// .NET Framework 4 that ships with Windows, so nothing else needs to be installed.
// Usage: node scripts/build-installer.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { zipSync } from 'fflate';
import { root, pkg, changelogCRLF } from './stage-app.mjs';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bitchord-setup-'));
try {
  // The portable app, built by package-win.mjs in a temporary folder (it empties its output folder).
  execFileSync(process.execPath, [path.join(root, 'scripts', 'package-win.mjs'), path.join(work, 'pkg')], { stdio: 'inherit' });
  const appDir = path.join(work, 'pkg', 'BitChord');
  fs.copyFileSync(path.join(root, 'build', 'icon.ico'), path.join(appDir, 'BitChord.ico'));
  fs.copyFileSync(path.join(root, 'installer', 'desinstalar.ps1'), path.join(appDir, 'desinstalar.ps1'));
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(appDir, 'LICENSE.BitChord.txt'));
  fs.writeFileSync(path.join(appDir, 'CAMBIOS.txt'), changelogCRLF());
  fs.rmSync(path.join(appDir, 'LEEME.txt'), { force: true });

  const tree = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else tree[path.relative(appDir, p).split(path.sep).join('/')] = new Uint8Array(fs.readFileSync(p));
    }
  })(appDir);
  const payload = path.join(work, 'payload.zip');
  fs.writeFileSync(payload, zipSync(tree, { level: 9 }));

  const [ma, mi, pa, bu = 0] = pkg.version.split('.').map(Number);
  fs.writeFileSync(path.join(work, 'Version.cs'), [
    'using System.Reflection;',
    `[assembly: AssemblyVersion("${ma}.${mi}.${pa}.${bu}")]`,
    `[assembly: AssemblyFileVersion("${ma}.${mi}.${pa}.${bu}")]`,
    `static class Bitchord { public const string Version = "${pkg.version}"; }`,
  ].join('\r\n'));
  fs.writeFileSync(path.join(work, 'app.manifest'), `<?xml version="1.0" encoding="utf-8"?>
<assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1">
  <assemblyIdentity version="${ma}.${mi}.${pa}.${bu}" name="BitChord.Setup"/>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v2"><security><requestedPrivileges>
    <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
  </requestedPrivileges></security></trustInfo>
  <application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings>
    <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true</dpiAware>
  </windowsSettings></application>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1"><application>
    <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
  </application></compatibility>
</assembly>`);

  for (const f of fs.readdirSync(root)) if (/^BitChord-Instalar-.*\.exe$/.test(f)) fs.rmSync(path.join(root, f));
  const out = path.join(root, `BitChord-Instalar-${pkg.version}.exe`);
  const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  execFileSync(csc, [
    '/nologo', '/target:winexe', '/optimize+', `/out:${out}`,
    `/win32icon:${path.join(root, 'build', 'icon.ico')}`, `/win32manifest:${path.join(work, 'app.manifest')}`,
    `/resource:${payload},payload.zip`,
    '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    path.join(root, 'scripts', 'setup', 'Setup.cs'), path.join(work, 'Version.cs'),
  ], { stdio: 'inherit' });
  console.log('OK', out, `${(fs.statSync(out).size / 1048576).toFixed(1)} MB`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
