//! 通用媒体 Sample 定义

use serde::{Deserialize, Serialize};

/// 媒体 Sample 类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SampleType {
    /// 视频
    Video,
    /// 音频
    Audio,
    /// 元数据/脚本数据
    Metadata,
    /// 未知
    Unknown,
}

impl SampleType {
    pub fn as_str(&self) -> &'static str {
        match self {
            SampleType::Video => "video",
            SampleType::Audio => "audio",
            SampleType::Metadata => "metadata",
            SampleType::Unknown => "unknown",
        }
    }
}

/// 编码格式
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Codec {
    // 视频编码
    H264,
    H265,
    Vp8,
    Vp9,
    Av1,

    // 音频编码
    Aac,
    Mp3,
    Opus,
    Flac,
    Pcm,

    // 未知
    Unknown(String),
}

impl Codec {
    pub fn as_str(&self) -> &str {
        match self {
            Codec::H264 => "h264",
            Codec::H265 => "h265",
            Codec::Vp8 => "vp8",
            Codec::Vp9 => "vp9",
            Codec::Av1 => "av1",
            Codec::Aac => "aac",
            Codec::Mp3 => "mp3",
            Codec::Opus => "opus",
            Codec::Flac => "flac",
            Codec::Pcm => "pcm",
            Codec::Unknown(s) => s.as_str(),
        }
    }

    /// 是否为视频编码
    pub fn is_video(&self) -> bool {
        matches!(
            self,
            Codec::H264 | Codec::H265 | Codec::Vp8 | Codec::Vp9 | Codec::Av1
        )
    }

    /// 是否为音频编码
    pub fn is_audio(&self) -> bool {
        matches!(
            self,
            Codec::Aac | Codec::Mp3 | Codec::Opus | Codec::Flac | Codec::Pcm
        )
    }
}

impl Default for Codec {
    fn default() -> Self {
        Codec::Unknown("unknown".to_string())
    }
}

/// 通用媒体 Sample
///
/// 统一表示 FLV Tag、MP4 Sample、TS PES 等
#[derive(Debug, Clone)]
pub struct MediaSample {
    /// 样本类型
    pub sample_type: SampleType,

    /// 编码格式
    pub codec: Codec,

    /// 解码时间戳（毫秒）
    pub dts: u32,

    /// 显示时间戳（毫秒）
    pub pts: u32,

    /// 文件偏移
    pub offset: u64,

    /// 数据大小
    pub size: u32,

    /// 是否为关键帧
    pub is_keyframe: bool,

    /// 是否为序列头/初始化数据
    pub is_init_data: bool,

    /// 帧类型（视频）
    pub frame_type: Option<FrameType>,

    /// 帧持续时间（毫秒）- 仅 MP4/TS 有效
    pub duration_ms: Option<f64>,

    /// 原始数据
    pub data: Vec<u8>,

    /// 原始容器特定信息（可选）
    pub container_specific: Option<ContainerSpecificInfo>,
}

/// 帧类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FrameType {
    /// I 帧（关键帧）
    I,
    /// P 帧
    P,
    /// B 帧
    B,
    /// 未知
    Unknown,
}

/// 容器特定信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContainerSpecificInfo {
    /// FLV 特定信息
    Flv { tag_type: u8, stream_id: u32 },
    /// MP4 特定信息
    Mp4 {
        track_id: u32,
        sample_index: u32,
        /// Sample description index (1-based, 映射到 stsd 中的 entry)
        sample_desc_index: u32,
    },
    /// TS 特定信息
    Ts { pid: u16, pes_packet_length: u16 },
}

impl MediaSample {
    /// 创建新的 Sample
    pub fn new(sample_type: SampleType) -> Self {
        Self {
            sample_type,
            codec: Codec::default(),
            dts: 0,
            pts: 0,
            offset: 0,
            size: 0,
            is_keyframe: false,
            is_init_data: false,
            frame_type: None,
            duration_ms: None,
            data: Vec::new(),
            container_specific: None,
        }
    }

    /// 获取时间戳（优先返回 DTS）
    pub fn timestamp(&self) -> u32 {
        self.dts
    }

    /// 是否为视频 Sample
    pub fn is_video(&self) -> bool {
        self.sample_type == SampleType::Video
    }

    /// 是否为音频 Sample
    pub fn is_audio(&self) -> bool {
        self.sample_type == SampleType::Audio
    }

    /// 计算 CTS (Composition Time Offset)
    pub fn cts(&self) -> i32 {
        self.pts as i32 - self.dts as i32
    }
}

/// 从 FLV codec ID 转换
impl From<u8> for Codec {
    fn from(codec_id: u8) -> Self {
        match codec_id {
            7 => Codec::H264,
            12 => Codec::H265,
            _ => Codec::Unknown(format!("flv_codec_{}", codec_id)),
        }
    }
}

/// 从 MP4 fourcc 转换
impl From<&[u8; 4]> for Codec {
    fn from(fourcc: &[u8; 4]) -> Self {
        match fourcc {
            b"avc1" | b"avc3" => Codec::H264,
            b"hvc1" | b"hev1" => Codec::H265,
            b"vp08" => Codec::Vp8,
            b"vp09" => Codec::Vp9,
            b"av01" => Codec::Av1,
            b"mp4a" => Codec::Aac,
            b".mp3" => Codec::Mp3,
            b"opus" | b"Opus" => Codec::Opus,
            b"fLaC" => Codec::Flac,
            _ => Codec::Unknown(String::from_utf8_lossy(fourcc).to_string()),
        }
    }
}
