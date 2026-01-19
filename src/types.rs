//! 类型定义模块 - 包含所有可序列化的数据结构

use serde::{Deserialize, Serialize};

/// 标签摘要 - 前端展示用
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSummary {
    pub index: usize,
    #[serde(rename = "type")]
    pub tag_type: String,
    pub timestamp: u32,
    pub size: u32,
    pub offset: u64,
    #[serde(default)]
    pub is_keyframe: bool,
    #[serde(default)]
    pub is_seq_header: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub frame_type: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub codec_id: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub gop_index: Option<i32>,
    /// 描述信息（用于非 FLV 格式）
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
    /// MP4 特有信息
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub mp4_info: Option<Mp4SampleInfo>,
    /// 是否包含 SEI NALU
    #[serde(default)]
    pub has_sei: bool,
    /// 是否 SPS/PPS 与之前不同（用于检测编码参数变化）
    #[serde(default)]
    pub is_sps_pps_change: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mp4SampleInfo {
    pub track_id: u32,
    pub sample_index: u32,
    /// Sample description index (1-based), 对应 stsd 中的 entry
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sample_desc_index: Option<u32>,
}

/// 时间线数据点
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePoint {
    pub index: usize,
    pub timestamp: f64,
    pub dts: f64,
    pub pts: f64,
    /// 帧持续时间（秒）- 仅 MP4/TS 有效
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub duration: Option<f64>,
}

/// GOP 结构
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gop {
    pub index: usize,
    pub start_index: usize,
    pub end_index: usize,
    pub start_time: f64,
    pub duration: f64,
    pub frame_count: usize,
}

/// 异常信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anomaly {
    #[serde(rename = "type")]
    pub anomaly_type: String,
    pub tag_index: usize,
    pub timestamp: f64,
    pub description: String,
    pub severity: String,
}

/// 分析结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisResult {
    pub file_size: u64,
    pub format: String,
    pub has_video: bool,
    pub has_audio: bool,
    pub duration: f64,

    pub tags: Vec<TagSummary>,
    pub video_timeline: Vec<TimelinePoint>,
    pub audio_timeline: Vec<TimelinePoint>,
    pub gops: Vec<Gop>,

    pub video_tag_count: usize,
    pub audio_tag_count: usize,
    pub script_tag_count: usize,
    pub keyframe_count: usize,

    pub anomalies: Vec<Anomaly>,

    /// 视频初始化数据 (MP4: avcC/hvcC, TS: inline SPS/PPS) - 第一个配置
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_init_data: Option<Vec<u8>>,
    /// 视频初始化数据列表 (MP4: 多个 avcC/hvcC)
    /// 当 stsd 中有多个 sample entry 时使用
    /// 索引对应 sample_desc_index - 1
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_init_data_list: Option<Vec<Vec<u8>>>,
    /// 音频初始化数据 (MP4: esds/AudioSpecificConfig)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_init_data: Option<Vec<u8>>,

    /// 视频分段信息（当检测到编码参数变化时）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segments: Option<SegmentInfo>,
}

/// 视频分段信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentInfo {
    /// 总分段数
    pub total_segments: usize,
    /// 是否需要分割（分段数 > 1）
    pub needs_split: bool,
    /// 各分段详情
    pub segments: Vec<VideoSegment>,
    /// 警告信息
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub warnings: Vec<String>,
}

/// 视频分段
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSegment {
    /// 分段索引（从 0 开始）
    pub index: usize,
    /// 起始 tag/sample 索引
    pub start_tag_index: usize,
    /// 结束 tag/sample 索引（包含）
    pub end_tag_index: usize,
    /// 起始时间（秒）
    pub start_time: f64,
    /// 结束时间（秒）
    pub end_time: f64,
    /// 持续时长（秒）
    pub duration: f64,
    /// 视频帧数
    pub frame_count: usize,
    /// 该分段是否以关键帧开始
    pub starts_with_keyframe: bool,
    /// 触发分段的原因
    pub reason: String,
}

/// Tag 字段信息 - 用于详情视图的属性树
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagField {
    pub name: String,
    pub value: String,
    pub start: u32,
    pub end: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub css_class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub virtual_field: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expanded: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TagField>>,
}

impl TagField {
    /// 创建一个新的字段节点
    pub fn new(name: &str, value: impl ToString, start: u32, end: u32) -> Self {
        Self {
            name: name.to_string(),
            value: value.to_string(),
            start,
            end,
            css_class: None,
            virtual_field: None,
            expanded: None,
            children: None,
        }
    }

    /// 设置 CSS 类
    pub fn with_css_class(mut self, class: &str) -> Self {
        self.css_class = Some(class.to_string());
        self
    }

    /// 设置为虚拟字段
    pub fn as_virtual(mut self) -> Self {
        self.virtual_field = Some(true);
        self
    }

    /// 设置为展开状态
    pub fn expanded(mut self) -> Self {
        self.expanded = Some(true);
        self
    }

    /// 添加子节点
    pub fn with_children(mut self, children: Vec<TagField>) -> Self {
        self.children = Some(children);
        self
    }
}

/// Hex Dump 行
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HexLine {
    pub offset: String,
    pub bytes: Vec<HexByte>,
    pub ascii: String,
}

/// Hex 字节
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HexByte {
    pub hex: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub css_class: Option<String>,
}

/// Tag 详情 - 包含字段树和 Hex dump
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagDetail {
    pub tag_index: usize,
    pub tag_type: String,
    pub timestamp: u32,
    pub size: u32,
    pub offset: u64,
    pub total_size: u32,
    pub fields: Vec<TagField>,
    pub hex_lines: Vec<HexLine>,
}
