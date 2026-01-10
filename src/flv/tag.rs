//! FLV Tag 定义和解析

use serde::Serialize;

/// FLV Tag 类型常量
pub const TAG_TYPE_AUDIO: u8 = 8;
pub const TAG_TYPE_VIDEO: u8 = 9;
pub const TAG_TYPE_SCRIPT: u8 = 18;

/// 视频帧类型
pub const FRAME_TYPE_KEYFRAME: u8 = 1;
pub const FRAME_TYPE_INTERFRAME: u8 = 2;

/// 视频编码 ID
pub const CODEC_ID_AVC: u8 = 7;
pub const CODEC_ID_HEVC: u8 = 12;

/// AVC/HEVC 包类型
pub const AVC_PACKET_TYPE_SEQUENCE_HEADER: u8 = 0;
pub const AVC_PACKET_TYPE_NALU: u8 = 1;

/// FLV 文件头
#[derive(Debug, Clone, Serialize)]
pub struct FlvHeader {
    pub signature: String,
    pub version: u8,
    pub has_audio: bool,
    pub has_video: bool,
    pub header_size: u32,
}

/// FLV Tag
#[derive(Debug, Clone)]
pub struct FlvTag {
    /// 标签类型 (8=audio, 9=video, 18=script)
    pub tag_type: u8,
    /// 数据大小
    pub data_size: u32,
    /// 时间戳（毫秒）
    pub timestamp: u32,
    /// 流 ID
    pub stream_id: u32,
    /// 文件偏移
    pub offset: u64,
    /// 标签数据
    pub data: Vec<u8>,
}

/// 视频 Tag 详细信息
#[derive(Debug, Clone, Serialize)]
pub struct VideoInfo {
    pub frame_type: u8,
    pub codec_id: u8,
    pub avc_packet_type: u8,
    /// Composition Time Offset
    pub cts: i32,
    pub is_keyframe: bool,
    pub is_seq_header: bool,
}

/// 音频 Tag 详细信息
#[derive(Debug, Clone, Serialize)]
pub struct AudioInfo {
    pub format: u8,
    pub sample_rate: u8,
    pub sample_size: u8,
    pub channels: u8,
    pub is_seq_header: bool,
}

impl FlvTag {
    /// 获取 Tag 类型名称
    pub fn type_name(&self) -> &'static str {
        match self.tag_type {
            TAG_TYPE_AUDIO => "audio",
            TAG_TYPE_VIDEO => "video",
            TAG_TYPE_SCRIPT => "script",
            _ => "unknown",
        }
    }

    /// 解析视频 Tag
    pub fn parse_video(&self) -> Option<VideoInfo> {
        if self.tag_type != TAG_TYPE_VIDEO || self.data.is_empty() {
            return None;
        }

        let first_byte = self.data[0];
        let frame_type = (first_byte >> 4) & 0x0F;
        let codec_id = first_byte & 0x0F;
        let is_keyframe = frame_type == FRAME_TYPE_KEYFRAME;

        let mut avc_packet_type = 0u8;
        let mut cts = 0i32;
        let mut is_seq_header = false;

        // AVC/HEVC 特有字段
        if (codec_id == CODEC_ID_AVC || codec_id == CODEC_ID_HEVC) && self.data.len() >= 5 {
            avc_packet_type = self.data[1];
            is_seq_header = avc_packet_type == AVC_PACKET_TYPE_SEQUENCE_HEADER;

            // 解析 CTS (3 字节有符号整数)
            let cts_value = ((self.data[2] as i32) << 16)
                | ((self.data[3] as i32) << 8)
                | (self.data[4] as i32);
            // 符号扩展
            cts = if cts_value & 0x00800000 != 0 {
                cts_value | !0x00FFFFFF
            } else {
                cts_value
            };
        }

        Some(VideoInfo {
            frame_type,
            codec_id,
            avc_packet_type,
            cts,
            is_keyframe,
            is_seq_header,
        })
    }

    /// 解析音频 Tag
    pub fn parse_audio(&self) -> Option<AudioInfo> {
        if self.tag_type != TAG_TYPE_AUDIO || self.data.is_empty() {
            return None;
        }

        let first_byte = self.data[0];
        let format = (first_byte >> 4) & 0x0F;
        let sample_rate = (first_byte >> 2) & 0x03;
        let sample_size = (first_byte >> 1) & 0x01;
        let channels = first_byte & 0x01;

        // AAC 序列头检测
        let is_seq_header = format == 10 && self.data.len() >= 2 && self.data[1] == 0;

        Some(AudioInfo {
            format,
            sample_rate,
            sample_size,
            channels,
            is_seq_header,
        })
    }
}
