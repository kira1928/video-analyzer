// WASM 分析结果类型定义 - 与 Rust 端对应

/** 标签摘要 */
export interface TagSummary {
  index: number;
  type: string;
  timestamp: number;
  size: number;
  offset: number;
  isKeyframe: boolean;
  isSeqHeader: boolean;
  frameType?: number;
  codecId?: number;
  gopIndex?: number;
}

/** 时间线点 */
export interface TimelinePoint {
  index: number;
  timestamp: number;
  dts: number;
  pts: number;
}

/** GOP 信息 */
export interface Gop {
  index: number;
  startIndex: number;
  endIndex: number;
  startTime: number;
  duration: number;
  frameCount: number;
}

/** 异常信息 */
export interface Anomaly {
  type: string;
  severity: string;
  description: string;
  timestamp: number;
  tagIndex?: number;
}

/** 分析结果 */
export interface AnalysisResult {
  fileSize: number;
  format: string;
  hasVideo: boolean;
  hasAudio: boolean;
  duration: number;
  tags: TagSummary[];
  gops: Gop[];
  videoTimeline: TimelinePoint[];
  audioTimeline: TimelinePoint[];
  videoTagCount: number;
  audioTagCount: number;
  scriptTagCount: number;
  keyframeCount: number;
  anomalies: Anomaly[];
}

/** Tag 字段 - 用于属性树 */
export interface TagField {
  name: string;
  value: string;
  start: number;
  end: number;
  cssClass?: string;
  virtualField?: boolean;
  expanded?: boolean;
  children?: TagField[];
}

/** Hex 字节 */
export interface HexByte {
  hex: string;
  cssClass?: string;
}

/** Hex 行 */
export interface HexLine {
  offset: string;
  bytes: HexByte[];
  ascii: string;
}

/** Tag 详情 - 由 WASM 返回 */
export interface TagDetail {
  tagIndex: number;
  tagType: string;
  timestamp: number;
  size: number;
  offset: number;
  totalSize: number;
  fields: TagField[];
  hexLines: HexLine[];
}

/** GOP 标签查询结果 */
export interface GopTagsResult {
  startIndex: number;
  endIndex: number;
  tags: TagSummary[];
}

/** VideoAnalyzer WASM 模块接口 */
export interface VideoAnalyzerModule {
  parseFLV: (data: Uint8Array) => AnalysisResult;
  getGOPTags: (resultJson: string, gopIndex: number) => GopTagsResult;
  getTagDetail: (resultJson: string, tagIndex: number, fileData: Uint8Array) => TagDetail;
  isAnnexBFormat: (data: Uint8Array) => boolean;
  convertAnnexBToHVCC: (data: Uint8Array) => Uint8Array;
  convertAnnexBToAVCC: (data: Uint8Array) => Uint8Array;
  generateHEVCCodecString: (hvccData: Uint8Array, compatMode: string, constraintMode: string) => string;
  getVersion: () => string;
}

// 全局模块引用
let wasmModule: VideoAnalyzerModule | null = null;

export function setWasmModule(module: VideoAnalyzerModule) {
  wasmModule = module;
}

export function getWasmModule(): VideoAnalyzerModule {
  if (!wasmModule) {
    throw new Error('WASM 模块尚未加载');
  }
  return wasmModule;
}
