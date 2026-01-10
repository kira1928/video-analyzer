#!/usr/bin/env node
/**
 * 构建单文件 HTML (Standalone)
 * 
 * 将 index.html、CSS、JS 和 WASM 打包成一个独立的 HTML 文件
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '../..');
const WEB_DIR = join(ROOT_DIR, 'web');
const PKG_DIR = join(WEB_DIR, 'pkg');
const ASSETS_DIR = join(WEB_DIR, 'assets');

console.log('📦 构建单文件 HTML...');

// 1. 读取 WASM 并转换为 Base64
const wasmPath = join(PKG_DIR, 'video_analyzer_bg.wasm');
const wasmBytes = readFileSync(wasmPath);
const wasmBase64 = wasmBytes.toString('base64');
console.log(`   WASM 大小: ${(wasmBytes.length / 1024).toFixed(1)} KB`);
console.log(`   Base64 后: ${(wasmBase64.length / 1024).toFixed(1)} KB`);

// 2. 读取 wasm-pack 生成的 JS 并修改 WASM 加载方式
let wasmLoaderJs = readFileSync(join(PKG_DIR, 'video_analyzer.js'), 'utf-8');

// 替换 __wbg_init 函数，使用内联的 Base64 WASM 数据
const newInitFunction = `
async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;
    
    // STANDALONE MODE: 从内联 Base64 加载 WASM
    const WASM_BASE64 = "${wasmBase64}";
    
    function base64ToArrayBuffer(base64) {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    }
    
    const wasmBuffer = base64ToArrayBuffer(WASM_BASE64);
    const imports = __wbg_get_imports();
    const module = await WebAssembly.compile(wasmBuffer);
    const instance = await WebAssembly.instantiate(module, imports);
    
    return __wbg_finalize_init(instance, module);
}
`;

// 使用更精确的替换 - 匹配从函数声明到 export { initSync } 之前
wasmLoaderJs = wasmLoaderJs.replace(
  /async function __wbg_init\(module_or_path\) \{[\s\S]*?\n\}\n\nexport \{ initSync \}/,
  newInitFunction.trim() + '\n\nexport { initSync }'
);

// 3. 构建最终 HTML
let html = readFileSync(join(WEB_DIR, 'index.html'), 'utf-8');

// 4. 内联 CSS
const cssFiles = readdirSync(ASSETS_DIR).filter(f => f.endsWith('.css'));
for (const cssFile of cssFiles) {
  const cssContent = readFileSync(join(ASSETS_DIR, cssFile), 'utf-8');
  const cssLink = new RegExp(`<link[^>]*href="[./]*assets/${cssFile}"[^>]*>`, 'g');
  html = html.replace(cssLink, `<style>\n${cssContent}\n</style>`);
}

// 5. 读取主 JS 并内联
const jsFiles = readdirSync(ASSETS_DIR).filter(f => f.endsWith('.js'));
let mainJsContent = '';
for (const jsFile of jsFiles) {
  mainJsContent = readFileSync(join(ASSETS_DIR, jsFile), 'utf-8');
  const jsScript = new RegExp(`<script[^>]*src="[./]*assets/${jsFile}"[^>]*></script>`, 'g');
  html = html.replace(jsScript, ''); // 先移除，稍后统一添加
}

// 6. 在主 JS 中替换动态导入
// 原始: import("/pkg/video_analyzer.js")
// 替换为: Promise.resolve(window.__videoAnalyzerWasm)
// [Modified] 也不再需要替换 import，因为 wasm.ts 现在会检查 window.__videoAnalyzerWasm
/* 
mainJsContent = mainJsContent.replace(
  /import\s*\(\s*["']\/pkg\/video_analyzer\.js["']\s*\)/g,
  'Promise.resolve(window.__videoAnalyzerWasm)'
);
*/

// 7. 转义 JS 中的 </script> 防止 HTML 解析器提前关闭标签
wasmLoaderJs = wasmLoaderJs.replace(/<\/script>/gi, '<\\/script>');
mainJsContent = mainJsContent.replace(/<\/script>/gi, '<\\/script>');

// 8. 组合最终 HTML
const finalScript = `
<script type="module">
// === WASM Loader (video_analyzer.js) ===
${wasmLoaderJs}

// 导出到全局
window.__videoAnalyzerWasm = {
  default: __wbg_init,
  parseFLV,
  getGOPTags,
  getTagDetail,
  isAnnexBFormat,
  convertAnnexBToHVCC,
  convertAnnexBToAVCC,
  generateHEVCCodecString,
  getVersion,
  init
};
</script>

<script type="module">
// === Main Application ===
${mainJsContent}
</script>
`;

// 在 </body> 前插入脚本
html = html.replace('</body>', `${finalScript}\n</body>`);

// 9. 写入输出文件
const outputPath = join(WEB_DIR, 'video-analyzer-standalone.html');
writeFileSync(outputPath, html);

const outputSize = readFileSync(outputPath).length;
console.log(`\n✅ 已生成: ${outputPath}`);
console.log(`   文件大小: ${(outputSize / 1024).toFixed(1)} KB`);
