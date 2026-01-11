import { AnalysisResult, TagDetail, GopTagsResult, setWasmModule, getWasmModule } from '../types';
export { getWasmModule } from '../types';

/** WASM 加载状态 */
export type WasmStatus = 'loading' | 'ready' | 'error';

/** WASM 加载配置 */
interface WasmLoaderConfig {
  /** 加载状态回调 */
  onStatusChange?: (status: WasmStatus, message?: string) => void;
}

function base64ToUint8Array(base64: string) {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// wasm-pack 生成的模块类型
interface WasmModule {
  default: () => Promise<void>;
  parseFLV: (data: Uint8Array) => AnalysisResult;
  getGOPTags: (resultJson: string, gopIndex: number) => GopTagsResult;
  getTagDetail: (resultJson: string, tagIndex: number, fileData: Uint8Array) => TagDetail;
  isAnnexBFormat: (data: Uint8Array) => boolean;
  convertAnnexBToHVCC: (data: Uint8Array) => Uint8Array;
  convertAnnexBToAVCC: (data: Uint8Array) => Uint8Array;
  generateHEVCCodecString: (hvccData: Uint8Array, compatMode: string, constraintMode: string) => string;
  getVersion: () => string;
}

/**
 * 加载 WASM 模块 (使用 wasm-pack 生成的 ES 模块)
 */
export async function loadWasm(config: WasmLoaderConfig = {}): Promise<void> {
  const { onStatusChange } = config;

  onStatusChange?.('loading', '正在加载 WASM...');

  try {
    // 动态导入 wasm-pack 生成的模块

    if (import.meta.env.STANDALONE) {
      // Standalone 模式 (Vite): 使用内联 Base64 加载 WASM
      const jsModule = await import(/* @vite-ignore */ '/pkg/video_analyzer.js');
      const { default: wasmBase64 } = await import(/* @vite-ignore */ '/pkg/video_analyzer_bg.wasm?inline');

      await jsModule.default(base64ToUint8Array(wasmBase64));

      const module = jsModule as unknown as WasmModule;

      // 设置全局模块引用
      setWasmModule({
        parseFLV: module.parseFLV,
        getGOPTags: module.getGOPTags,
        getTagDetail: module.getTagDetail,
        isAnnexBFormat: module.isAnnexBFormat,
        convertAnnexBToHVCC: module.convertAnnexBToHVCC,
        convertAnnexBToAVCC: module.convertAnnexBToAVCC,
        generateHEVCCodecString: module.generateHEVCCodecString,
        getVersion: module.getVersion,
      });

      onStatusChange?.('ready', `WASM 已加载 (Standalone Vite)`);
      return;
    }

    // Standalone 模式 (旧版脚本): 如果已注入全局对象，直接使用
    if ((window as any).__videoAnalyzerWasm) {
      const module = (window as any).__videoAnalyzerWasm;
      setWasmModule(module); // 仍然需要设置 hook 里的引用

      // Standalone 模式下，init 可能已经变成了 no-op 或者需要手动调用的部分，
      // 但通常我们保持接口一致。如果 video_analyzer.js 的 init 是 Promise，这里也是。
      // 注意：standalone 脚本里把 default 映射为了 init。
      await module.default();

      onStatusChange?.('ready', `WASM 已加载 (Standalone)`);
      return;
    }

    // 动态导入 wasm-pack 生成的模块
    let modulePath = '/pkg/video_analyzer.js';

    // 生产构建时，脚本位于 assets/ 目录，需要向上查找 pkg/
    // 使用 import.meta.url 确保相对路径正确，支持任意 base URL (如 GitHub Pages)
    if (!import.meta.env.DEV) {
      modulePath = new URL('../pkg/video_analyzer.js', import.meta.url).href;
    }

    const module: WasmModule = await import(/* @vite-ignore */ modulePath);

    // 初始化 WASM
    await module.default();

    // 设置全局模块引用
    setWasmModule({
      parseFLV: module.parseFLV,
      getGOPTags: module.getGOPTags,
      getTagDetail: module.getTagDetail,
      isAnnexBFormat: module.isAnnexBFormat,
      convertAnnexBToHVCC: module.convertAnnexBToHVCC,
      convertAnnexBToAVCC: module.convertAnnexBToAVCC,
      generateHEVCCodecString: module.generateHEVCCodecString,
      getVersion: module.getVersion,
    });

    const version = module.getVersion();
    onStatusChange?.('ready', `WASM 已加载 (v${version})`);

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onStatusChange?.('error', `WASM 加载失败: ${message}`);
    throw error;
  }
}

/**
 * 解析 FLV 文件
 */
export function parseFLV(data: Uint8Array): AnalysisResult {
  return getWasmModule().parseFLV(data);
}

/**
 * 获取 GOP 中的标签
 */
export function getGOPTags(result: AnalysisResult, gopIndex: number): GopTagsResult {
  return getWasmModule().getGOPTags(JSON.stringify(result), gopIndex);
}

/**
 * 获取 Tag 详情（字段树 + Hex dump）
 * 注意：解析逻辑已移到 Rust 端，前端只需调用此接口
 */
export function getTagDetail(result: AnalysisResult, tagIndex: number, fileData: Uint8Array): TagDetail {
  return getWasmModule().getTagDetail(JSON.stringify(result), tagIndex, fileData);
}
