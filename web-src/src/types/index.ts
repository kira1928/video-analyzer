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
  description?: string;
  mp4Info?: Mp4SampleInfo;
  /** 是否包含 SEI NALU */
  hasSei?: boolean;
  /** 是否 SPS/PPS 与之前不同 */
  isSpsPpsChange?: boolean;
}

export interface Mp4SampleInfo {
  trackId: number;
  sampleIndex: number;
  /** Sample description index (1-based)，对应 stsd 中的 entry */
  sampleDescIndex?: number;
}


/** 时间线点 */
export interface TimelinePoint {
  index: number;
  timestamp: number;
  dts: number;
  pts: number;
  /** 帧持续时间（秒）- 仅 MP4/TS 有效 */
  duration?: number;
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
  // MP4/TS特定：视频初始化数据 (avcC/hvcC) - 第一个配置
  videoInitData?: number[];
  // MP4特定：多个视频初始化数据（当 stsd 中有多个 sample entry 时）
  // 索引对应 sample_desc_index - 1
  videoInitDataList?: number[][];
  // MP4/TS特定：音频初始化数据 (esds/AudioSpecificConfig)
  audioInitData?: number[];

  // 视频分段信息
  segments?: SegmentInfo;
}


/** 视频分段信息 */
export interface SegmentInfo {
  totalSegments: number;
  needsSplit: boolean;
  segments: VideoSegment[];
  warnings?: string[];
}

/** 视频分段详情 */
export interface VideoSegment {
  index: number;
  startTagIndex: number;
  endTagIndex: number;
  startTime: number;
  endTime: number;
  duration: number;
  frameCount: number;
  startsWithKeyframe: boolean;
  reason: string;
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

/** MP4 Box 节点 */
export interface Mp4BoxNode {
  /** Box 类型 (fourcc) */
  boxType: string;
  /** Box 起始位置（绝对偏移） */
  offset: number;
  /** Box 大小（包括头部） */
  size: number;
  /** Box 头部大小 (8 或 16) */
  headerSize: number;
  /** Box 说明文本 */
  description: string;
  /** 详细字段信息（如果已解析） */
  fields?: BoxField[];
  /** 子 Box 列表（容器 box） */
  children?: Mp4BoxNode[];
  childrenCount?: number;
  isContainer?: boolean;
}

/** Box 字段信息 */
export interface BoxField {
  /** 字段名称 */
  name: string;
  /** 字段值（字符串表示） */
  value: string;
  /** 字段说明 */
  description: string;
  /** 字段在 box 内的偏移 */
  offset?: number;
  /** 字段大小（字节） */
  size?: number;
}

/** MP4 Box 树 */
export interface Mp4BoxTree {
  /** 根级 box 列表 */
  boxes: Mp4BoxNode[];
  /** 总 box 数量 */
  totalCount: number;
}

/** MP4 Box Children Result */
export interface Mp4BoxChildrenResult {
  children: Mp4BoxNode[];
  totalCount: number;
}

export interface Mp4BoxFieldsResult {
  headerFields: BoxField[];
  entryCount?: number;
  entryStart?: number;
  entries: BoxField[];
}

export interface Mp4BoxSearchResult {
  tree: Mp4BoxTree;
  matchPaths: number[][];
  totalMatches: number;
}

/** MP4 Sample ?情 */
export interface Mp4SampleDetail {
  trackId: number;
  sampleIndex: number;
  fields: SampleDetailField[];
}

/** Sample 详情字段 */
export interface SampleDetailField {
  /** 字段名 */
  name: string;
  /** 字段值 */
  value: string;
  /** 简短说明 */
  description: string;
  /** 计算公式/来源说明 */
  formula: string;
}

/** VideoAnalyzer WASM 模块接口 */
export interface VideoAnalyzerModule {
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
  // 流式解析器
  StreamingMp4Parser: any;
  StreamingFlvParser: any;
  // 视频分段
  get_segment_info: (resultJson: string) => any;
  split_flv_segment: (fileData: Uint8Array, resultJson: string, segmentIndex: number) => Uint8Array;
  split_mp4_segment: (fileData: Uint8Array, resultJson: string, segmentIndex: number) => Uint8Array;
  // 流式模式分段
  splitMp4SegmentStreaming: (fileId: string, fileData: Uint8Array, segmentIndex: number) => Uint8Array;
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
