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
    pub is_keyframe: bool,
    pub is_seq_header: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub frame_type: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub codec_id: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub gop_index: Option<i32>,
}

/// 时间线数据点
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePoint {
    pub index: usize,
    pub timestamp: f64,
    pub dts: f64,
    pub pts: f64,
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
