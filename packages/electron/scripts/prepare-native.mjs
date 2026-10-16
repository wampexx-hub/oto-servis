// ---------------------------------------------------------------------------
// Electron için yerel (native) modülleri hazırlar.
// better-sqlite3 + bağımlılıklarını "native/node_modules" altına kopyalar ve
// Electron ABI'sine uygun önceden derlenmiş ikili dosyayı indirir.
// Böylece hedef bilgisayarda derleyici (Visual Studio) gerekmez.
// ---------------------------------------------------------------------------
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronPkgDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(electronPkgDir, '..', '..');
const rootNodeModules = path.join(repoRoot, 'node_modules');

const MODULES = ['better-sqlite3', 'bindings', 'file-uri-to-path'];

const nativeDir = path.join(electronPkgDir, 'native');
const nativeNM = path.join(nativeDir, 'node_modules');

function log(msg) {
  console.log(`[prepare-native] ${msg}`);
}

function electronVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(electronPkgDir, 'package.json'), 'utf8'));
  const dep = (pkg.devDependencies && pkg.devDependencies.electron) || (pkg.dependencies && pkg.dependencies.electron);
  if (!dep) throw new Error('package.json içinde electron sürümü bulunamadı.');
  return dep.replace(/^[^0-9]*/, '');
}

function main() {
  log('native/node_modules temizleniyor...');
  fs.rmSync(nativeDir, { recursive: true, force: true });
  fs.mkdirSync(nativeNM, { recursive: true });

  for (const name of MODULES) {
    const src = path.join(rootNodeModules, name);
    if (!fs.existsSync(src)) {
      throw new Error(`Kaynak modül bulunamadı: ${src}`);
    }
    const dest = path.join(nativeNM, name);
    log(`kopyalanıyor: ${name}`);
    fs.cpSync(src, dest, { recursive: true });
  }

  // Node ABI'li ikiliyi kaldır, Electron için tekrar indir.
  const bsDir = path.join(nativeNM, 'better-sqlite3');
  const bsBuild = path.join(bsDir, 'build');
  fs.rmSync(bsBuild, { recursive: true, force: true });

  const target = electronVersion();
  const prebuildBin = path.join(rootNodeModules, 'prebuild-install', 'bin.js');
  if (!fs.existsSync(prebuildBin)) {
    throw new Error('prebuild-install bulunamadı; önce "npm install" çalıştırın.');
  }

  log(`better-sqlite3 Electron ${target} (x64) için indiriliyor...`);
  const result = spawnSync(
    process.execPath,
    [prebuildBin, '-r', 'electron', '-t', target, '-a', 'x64', '--platform', 'win32', '--tag-prefix', 'v'],
    { cwd: bsDir, stdio: 'inherit' }
  );

  if (result.status !== 0) {
    throw new Error('Electron için native ikili indirilemedi (prebuild-install başarısız).');
  }

  const nodeFile = path.join(bsBuild, 'Release', 'better_sqlite3.node');
  if (!fs.existsSync(nodeFile)) {
    throw new Error(`Native ikili oluşmadı: ${nodeFile}`);
  }

  log('Tamamlandı: native/node_modules hazır.');
}

main();
