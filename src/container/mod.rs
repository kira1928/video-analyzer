//! 容器格式模块
//!
//! 提供统一的容器格式抽象，支持 FLV、MP4、TS 等格式

pub mod flv_container;
pub mod format;
pub mod mp4_container;
pub mod sample;
pub mod ts_container;

pub use format::{detect_format, ContainerFormat};
pub use sample::{Codec, ContainerSpecificInfo, FrameType, MediaSample, SampleType};

pub use flv_container::FlvContainer;
pub use mp4_container::Mp4Container;
pub use ts_container::TsContainer;

use std::io::{Read, Seek};

/// 容器信息
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    /// 格式
    pub format: ContainerFormat,
    /// 时长（毫秒）
    pub duration_ms: u64,
    /// 是否有视频
    pub has_video: bool,
    /// 是否有音频
    pub has_audio: bool,
    /// 视频编码
    pub video_codec: Option<Codec>,
    /// 音频编码
    pub audio_codec: Option<Codec>,
    /// 视频宽度
    pub width: Option<u32>,
    /// 视频高度
    pub height: Option<u32>,
    /// 帧率
    pub frame_rate: Option<f64>,
    /// 视频初始化数据 (MP4: avcC/hvcC, TS: inline SPS/PPS)
    /// 当只有一个 sample description 时使用此字段
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_init_data: Option<Vec<u8>>,
    /// 视频初始化数据列表 (MP4: 多个 avcC/hvcC)
    /// 当 stsd 中有多个 sample entry 时使用此字段
    /// 索引与 sample_desc_index 对应 (1-based，所以 index 0 = sample_desc_index 1)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_init_data_list: Option<Vec<Vec<u8>>>,
    /// 音频初始化数据 (MP4: esds/AudioSpecificConfig)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_init_data: Option<Vec<u8>>,
}

impl Default for ContainerInfo {
    fn default() -> Self {
        Self {
            format: ContainerFormat::Unknown,
            duration_ms: 0,
            has_video: false,
            has_audio: false,
            video_codec: None,
            audio_codec: None,
            width: None,
            height: None,
            frame_rate: None,
            video_init_data: None,
            video_init_data_list: None,
            audio_init_data: None,
        }
    }
}

/// 容器读取器 trait
pub trait ContainerReader {
    /// 读取容器信息
    fn read_info(&mut self) -> Result<ContainerInfo, String>;

    /// 读取下一个 Sample
    fn read_sample(&mut self) -> Result<Option<MediaSample>, String>;

    /// 重置到开头
    fn reset(&mut self) -> Result<(), String>;

    /// 获取容器格式
    fn format(&self) -> ContainerFormat;
}

/// 创建合适的容器读取器
pub fn create_reader<R: Read + Seek + 'static>(
    data: R,
    format: ContainerFormat,
) -> Result<Box<dyn ContainerReader>, String> {
    match format {
        ContainerFormat::Flv => Ok(Box::new(FlvContainer::new(data))),
        ContainerFormat::Mp4 => Ok(Box::new(Mp4Container::new(data))),
        ContainerFormat::Ts => Ok(Box::new(TsContainer::new(data))),
        ContainerFormat::Unknown => Err("未知的容器格式".to_string()),
    }
}
