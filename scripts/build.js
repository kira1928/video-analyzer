const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 获取当前任务和参数
const task = process.argv[2];
const args = process.argv.slice(3);

const projectRoot = path.resolve(__dirname, '..');
const webSrcDir = path.join(projectRoot, 'web-src');
const webDistDir = path.join(projectRoot, 'web');

// 工具函数：执行命令
function run(command, args, options = {}) {
  console.log(`[Build] Running: ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: true, // 启用 Shell 以支持 npm.cmd, cargo 等跨平台执行
    cwd: projectRoot,
    env: { ...process.env, ...options.env },
    ...options
  });
  if (result.status !== 0) {
    console.error(`[Build] Command failed with code ${result.status}`);
    process.exit(result.status || 1);
  }
}

// 任务分发
switch (task) {
  case 'web':
    buildWeb();
    break;
  case 'dev':
    runDev();
    break;
  case 'wasm':
    buildWasm(args);
    break;
  case 'clean':
    clean();
    break;
  case 'help':
    printHelp();
    break;
  default:
    console.error(`Unknown task: ${task}`);
    printHelp();
    process.exit(1);
}

function buildWasm(extraArgs) {
  console.log(`[Build] Building WASM Module...`);

  // 处理 Windows 路径分隔符，转换为 Rust 友好的格式
  // 将反斜杠替换为正斜杠
  const remapRoot = projectRoot.split(path.sep).join('/');
  console.log(`[WASM-Builder] Project Root: ${projectRoot}`);
  console.log(`[WASM-Builder] Remapping to:  /rust-root`);

  // 构建 RUSTFLAGS
  // --remap-path-prefix OLD=NEW
  const remapFlag = `--remap-path-prefix ${remapRoot}=/rust-root`;

  // 合并环境变量
  const env = { ...process.env };
  env.RUSTFLAGS = (env.RUSTFLAGS || '') + ' ' + remapFlag;

  // 执行 wasm-pack
  // Windows 下需要 shell: true 来查找可执行文件 (run 函数已默认开启 shell: true)
  // 注意：wasm-pack 实际上是调用 cargo，所以也需要正确的环境

  // 构建参数
  const wasmArgs = ['build', '--target', 'web', '--out-dir', 'web/pkg', '--out-name', 'video_analyzer', ...extraArgs];

  const cmd = os.platform() === 'win32' ? 'wasm-pack.cmd' : 'wasm-pack';

  run(cmd, wasmArgs, { env: env });
  console.log("[Build] WASM build complete: web/pkg/");
}

function buildWeb() {
  console.log('[Build] Building Web Frontend...');
  run('npm', ['run', 'build'], { cwd: webSrcDir });
}

function runDev() {
  console.log('[Build] Starting Dev Server...');
  run('npm', ['run', 'dev'], { cwd: webSrcDir });
}

function clean() {
  console.log('[Build] Cleaning up...');

  // 清理 Cargo
  run('cargo', ['clean']);

  // 清理 Web 产物
  const pathsToRemove = [
    path.join(webDistDir, 'pkg'),
    path.join(webDistDir, 'assets'),
    path.join(webDistDir, 'index.html')
  ];

  pathsToRemove.forEach(p => {
    if (fs.existsSync(p)) {
      console.log(`[Build] Removing ${p}`);
      fs.rmSync(p, { recursive: true, force: true });
    }
  });

  console.log('[Build] Clean complete.');
}

function printHelp() {
  console.log(`
Video Analyzer Build Script

Usage: node scripts/build.js [task] [args]

Tasks:
  wasm [--dev|--release] Build wasm module
  web                  Build TypeScript frontend
  dev                  Start Vite dev server
  clean                Clean all build artifacts
  help                 Show this help message
`);
}
