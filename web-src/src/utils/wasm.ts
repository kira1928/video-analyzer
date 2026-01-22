import { AnalysisResult, TagDetail, GopTagsResult, Mp4BoxTree, Mp4BoxChildrenResult, Mp4BoxFieldsResult, Mp4BoxSearchResult, Mp4SampleDetail, setWasmModule, getWasmModule } from '../types';
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
// wasm-pack 生成的模块类型
interface WasmModule {
  default: () => Promise<void>;
  detectFormat: (data: Uint8Array) => string;
  parseVideo: (data: Uint8Array) => AnalysisResult;
  parseFLV: (data: Uint8Array) => AnalysisResult;
  parseMP4: (data: Uint8Array) => AnalysisResult;
  parseTS: (data: Uint8Array) => AnalysisResult;
  getGOPTags: (resultJson: string, gopIndex: number) => GopTagsResult;
  getTagDetail: (resultJson: string, tagIndex: number, fileData: Uint8Array) => TagDetail;
  getMp4BoxTree: (data: Uint8Array) => Mp4BoxTree;
  getMp4SampleDetail: (resultJson: string, tagIndex: number, fileData: Uint8Array) => Mp4SampleDetail;
  isAnnexBFormat: (data: Uint8Array) => boolean;
  convertAnnexBToHVCC: (data: Uint8Array) => Uint8Array;
  convertAnnexBToAVCC: (data: Uint8Array) => Uint8Array;
  generateHEVCCodecString: (hvccData: Uint8Array, compatMode: string, constraintMode: string) => string;
  getVersion: () => string;
  getSupportedFormats: () => string[];
  get_segment_info: (resultJson: string) => any;
  split_flv_segment: (fileData: Uint8Array, resultJson: string, segmentIndex: number) => Uint8Array;
  split_mp4_segment: (fileData: Uint8Array, resultJson: string, segmentIndex: number) => Uint8Array;
  splitMp4SegmentStreaming: (fileId: string, fileData: Uint8Array, segmentIndex: number) => Uint8Array;
  // 流式解析器类
  StreamingMp4Parser: new (fileSize: number, readCallback: (offset: number, length: number) => Promise<Uint8Array>) => StreamingMp4ParserInstance;
  StreamingFlvParser: new (fileSize: number, readCallback: (offset: number, length: number) => Promise<Uint8Array>) => StreamingFlvParserInstance;
}

/** 流式 MP4 解析器实例 */
export interface StreamingMp4ParserInstance {
  parse(): Promise<AnalysisResult>;
  sample_count: number;
  read_sample_data(sampleIndex: number): Promise<Uint8Array>;
  getMp4BoxTreeRoot(depth: number): Promise<Mp4BoxTree>;
  getMp4BoxChildren(offset: number, size: number, boxType: string): Promise<Mp4BoxChildrenResult>;
  getMp4BoxFields(offset: number, size: number, boxType: string, start: number, count: number): Promise<Mp4BoxFieldsResult>;
  searchMp4Boxes(query: string): Promise<Mp4BoxSearchResult>;
}

/** 流式 FLV 解析器实例 */
export interface StreamingFlvParserInstance {
  parse(): Promise<AnalysisResult>;
  tag_count: number;
  read_tag_data(tagIndex: number): Promise<Uint8Array>;
  read_video_init_data(): Promise<Uint8Array>;
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
        detectFormat: module.detectFormat,
        parseVideo: module.parseVideo,
        parseFLV: module.parseFLV,
        parseMP4: module.parseMP4,
        parseTS: module.parseTS,
        getGOPTags: module.getGOPTags,
        getTagDetail: module.getTagDetail,
        getMp4BoxTree: module.getMp4BoxTree,
        getMp4SampleDetail: module.getMp4SampleDetail,
        isAnnexBFormat: module.isAnnexBFormat,
        convertAnnexBToHVCC: module.convertAnnexBToHVCC,
        convertAnnexBToAVCC: module.convertAnnexBToAVCC,
        generateHEVCCodecString: module.generateHEVCCodecString,
        getVersion: module.getVersion,
        getSupportedFormats: module.getSupportedFormats,
        StreamingMp4Parser: module.StreamingMp4Parser,
        StreamingFlvParser: module.StreamingFlvParser,
        get_segment_info: module.get_segment_info,
        split_flv_segment: module.split_flv_segment,
        split_mp4_segment: module.split_mp4_segment,
        splitMp4SegmentStreaming: module.splitMp4SegmentStreaming,
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
      detectFormat: module.detectFormat,
      parseVideo: module.parseVideo,
      parseFLV: module.parseFLV,
      parseMP4: module.parseMP4,
      parseTS: module.parseTS,
      getGOPTags: module.getGOPTags,
      getTagDetail: module.getTagDetail,
      getMp4BoxTree: module.getMp4BoxTree,
      getMp4SampleDetail: module.getMp4SampleDetail,
      isAnnexBFormat: module.isAnnexBFormat,
      convertAnnexBToHVCC: module.convertAnnexBToHVCC,
      convertAnnexBToAVCC: module.convertAnnexBToAVCC,
      generateHEVCCodecString: module.generateHEVCCodecString,
      getVersion: module.getVersion,
      getSupportedFormats: module.getSupportedFormats,
      StreamingMp4Parser: module.StreamingMp4Parser,
      StreamingFlvParser: module.StreamingFlvParser,
      get_segment_info: module.get_segment_info,
      split_flv_segment: module.split_flv_segment,
      split_mp4_segment: module.split_mp4_segment,
      splitMp4SegmentStreaming: module.splitMp4SegmentStreaming,
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
 * 检测视频格式
 */
export function detectFormat(data: Uint8Array): string {
  return getWasmModule().detectFormat(data);
}

/**
 * 解析视频文件（自动检测格式）
 */
export function parseVideo(data: Uint8Array): AnalysisResult {
  return getWasmModule().parseVideo(data);
}

/**
 * 解析 FLV 文件
 */
export function parseFLV(data: Uint8Array): AnalysisResult {
  return getWasmModule().parseFLV(data);
}

/**
 * 解析 MP4 文件
 */
export function parseMP4(data: Uint8Array): AnalysisResult {
  return getWasmModule().parseMP4(data);
}

/**
 * 解析 TS 文件
 */
export function parseTS(data: Uint8Array): AnalysisResult {
  return getWasmModule().parseTS(data);
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

/**
 * 获取支持的格式列表
 */
export function getSupportedFormats(): string[] {
  return getWasmModule().getSupportedFormats();
}

/**
 * 获取 MP4 Box 树结构
 */
export function getMp4BoxTree(data: Uint8Array): Mp4BoxTree {
  return getWasmModule().getMp4BoxTree(data);
}

/**
 * 获取 MP4 Sample 详情（包含计算来源说明）
 */
export function getMp4SampleDetail(result: AnalysisResult, tagIndex: number, fileData: Uint8Array): Mp4SampleDetail {
  return getWasmModule().getMp4SampleDetail(JSON.stringify(result), tagIndex, fileData);
}



/**
 * 使用流式解析器解析 MP4 文件
 * 
 * @param file - 要解析的 File 对象
 * @returns 分析结果
 */
export async function parseMP4Streaming(file: File): Promise<AnalysisResult> {
  const parser = createStreamingMp4Parser(file);
  return await parser.parse();
}

/**
 * 创建流式 FLV 解析器
 * 
 * @param file - 要解析的 File 对象
 * @returns 流式解析器实例
 */
export function createStreamingFlvParser(file: File): StreamingFlvParserInstance {
  const readCallback = async (offset: number, length: number): Promise<Uint8Array> => {
    const blob = file.slice(offset, offset + length);
    const buffer = await blob.arrayBuffer();
    return new Uint8Array(buffer);
  };

  const module = getWasmModule() as unknown as WasmModule;
  console.log('WASM Module exports:', Object.keys(module));
  if (!module.StreamingFlvParser) {
    console.error('StreamingFlvParser not found in module!', module);
    throw new Error('StreamingFlvParser 未导出');
  }
  return new module.StreamingFlvParser(file.size, readCallback);
}

export function createStreamingMp4Parser(file: File): StreamingMp4ParserInstance {
  const readCallback = async (offset: number, length: number): Promise<Uint8Array> => {
    const blob = file.slice(offset, offset + length);
    const buffer = await blob.arrayBuffer();
    return new Uint8Array(buffer);
  };

  const module = getWasmModule() as unknown as WasmModule;
  console.log('WASM Module exports:', Object.keys(module));
  if (!module.StreamingMp4Parser) {
    console.error('StreamingMp4Parser not found in module!', module);
    throw new Error('StreamingMp4Parser 未导出');
  }
  return new module.StreamingMp4Parser(file.size, readCallback);
}

/**
 * 使用流式解析器解析 FLV 文件
 * 
 * @param file - 要解析的 File 对象
 * @returns 分析结果
 */
export async function parseFLVStreaming(file: File): Promise<AnalysisResult> {
  const parser = createStreamingFlvParser(file);
  return await parser.parse();
}

/**
 * 分割 FLV 文件段
 */
export function splitFlvSegment(
  fileData: Uint8Array,
  resultJson: string,
  segmentIndex: number
): Uint8Array {
  const module = getWasmModule() as unknown as WasmModule;
  return module.split_flv_segment(fileData, resultJson, segmentIndex);
}

/**
 * 分割 MP4 文件段
 */
export function splitMp4Segment(
  fileData: Uint8Array,
  resultJson: string,
  segmentIndex: number
): Uint8Array {
  const module = getWasmModule() as unknown as WasmModule;
  return module.split_mp4_segment(fileData, resultJson, segmentIndex);
}

/**
 * 手动计算分段信息
 */
export function getSegmentInfo(resultJson: string): any {
  const module = getWasmModule() as unknown as WasmModule;
  return module.get_segment_info(resultJson);
}

/**
 * 流式模式下分割 MP4 文件段（使用缓存的解析结果）
 */
export function splitMp4SegmentStreaming(
  fileId: string,
  fileData: Uint8Array,
  segmentIndex: number
): Uint8Array {
  const module = getWasmModule() as unknown as WasmModule;
  return module.splitMp4SegmentStreaming(fileId, fileData, segmentIndex);
}
