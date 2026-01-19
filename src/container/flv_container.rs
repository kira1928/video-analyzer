//! FLV 容器实现

use super::sample::FrameType;
use super::{
    Codec, ContainerFormat, ContainerInfo, ContainerReader, ContainerSpecificInfo, MediaSample,
    SampleType,
};
use crate::flv::{FlvReader, FlvTag, TAG_TYPE_AUDIO, TAG_TYPE_SCRIPT, TAG_TYPE_VIDEO};
use crate::flv::{
    AVC_PACKET_TYPE_SEQUENCE_HEADER, CODEC_ID_AVC, CODEC_ID_HEVC, FRAME_TYPE_KEYFRAME,
};
use std::io::{Cursor, Read, Seek};

/// FLV 容器读取器
pub struct FlvContainer<R: Read + Seek> {
    reader: FlvReader<R>,
    info: Option<ContainerInfo>,
}

impl<R: Read + Seek> FlvContainer<R> {
    /// 创建新的 FLV 容器读取器
    pub fn new(reader: R) -> Self {
        Self {
            reader: FlvReader::new(reader),
            info: None,
        }
    }
}

impl<R: Read + Seek + 'static> ContainerReader for FlvContainer<R> {
    fn read_info(&mut self) -> Result<ContainerInfo, String> {
        if let Some(ref info) = self.info {
            return Ok(info.clone());
        }

        let header = self.reader.read_header().map_err(|e| e.to_string())?;

        let info = ContainerInfo {
            format: ContainerFormat::Flv,
            duration_ms: 0, // FLV 需要扫描全部才能知道时长
            has_video: header.has_video,
            has_audio: header.has_audio,
            video_codec: None, // 需要从第一个视频 tag 获取
            audio_codec: None,
            width: None,
            height: None,
            frame_rate: None,
            video_init_data: None, // FLV 初始化数据在 Sequence Header tag 中
            video_init_data_list: None,
            audio_init_data: None,
        };

        self.info = Some(info.clone());
        Ok(info)
    }

    fn read_sample(&mut self) -> Result<Option<MediaSample>, String> {
        let tag = match self.reader.read_tag() {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                return Ok(None);
            }
            Err(e) => return Err(e.to_string()),
        };

        Ok(Some(flv_tag_to_sample(tag)))
    }

    fn reset(&mut self) -> Result<(), String> {
        self.reader.reset().map_err(|e| e.to_string())?;
        self.info = None;
        Ok(())
    }

    fn format(&self) -> ContainerFormat {
        ContainerFormat::Flv
    }
}

/// 从 Cursor<&[u8]> 创建 FlvContainer
impl FlvContainer<Cursor<Vec<u8>>> {
    pub fn from_bytes(data: Vec<u8>) -> Self {
        Self::new(Cursor::new(data))
    }
}

/// 将 FLV Tag 转换为通用 MediaSample
fn flv_tag_to_sample(tag: FlvTag) -> MediaSample {
    let sample_type = match tag.tag_type {
        TAG_TYPE_VIDEO => SampleType::Video,
        TAG_TYPE_AUDIO => SampleType::Audio,
        TAG_TYPE_SCRIPT => SampleType::Metadata,
        _ => SampleType::Unknown,
    };

    let mut sample = MediaSample::new(sample_type);
    sample.dts = tag.timestamp;
    sample.pts = tag.timestamp; // FLV 的 pts 需要从 CTS 计算
    sample.offset = tag.offset;
    sample.size = tag.data_size;
    sample.data = tag.data.clone();

    sample.container_specific = Some(ContainerSpecificInfo::Flv {
        tag_type: tag.tag_type,
        stream_id: tag.stream_id,
    });

    // 解析视频信息
    if tag.tag_type == TAG_TYPE_VIDEO && !tag.data.is_empty() {
        let first_byte = tag.data[0];
        let frame_type_raw = (first_byte >> 4) & 0x0F;
        let codec_id = first_byte & 0x0F;

        sample.is_keyframe = frame_type_raw == FRAME_TYPE_KEYFRAME;
        sample.frame_type = Some(match frame_type_raw {
            1 => FrameType::I,
            2 => FrameType::P,
            3 => FrameType::B,
            _ => FrameType::Unknown,
        });

        sample.codec = match codec_id {
            CODEC_ID_AVC => Codec::H264,
            CODEC_ID_HEVC => Codec::H265,
            _ => Codec::Unknown(format!("video_{}", codec_id)),
        };

        // 检查 AVC/HEVC 包类型
        if (codec_id == CODEC_ID_AVC || codec_id == CODEC_ID_HEVC) && tag.data.len() >= 5 {
            let avc_packet_type = tag.data[1];
            sample.is_init_data = avc_packet_type == AVC_PACKET_TYPE_SEQUENCE_HEADER;

            // 计算 CTS 并更新 PTS
            let cts =
                ((tag.data[2] as i32) << 16) | ((tag.data[3] as i32) << 8) | (tag.data[4] as i32);
            // 符号扩展
            let cts = if cts & 0x00800000 != 0 {
                cts | !0x00FFFFFF
            } else {
                cts
            };
            sample.pts = (tag.timestamp as i32 + cts) as u32;
        }
    }

    // 解析音频信息
    if tag.tag_type == TAG_TYPE_AUDIO && !tag.data.is_empty() {
        let first_byte = tag.data[0];
        let format = (first_byte >> 4) & 0x0F;

        sample.codec = match format {
            10 => Codec::Aac,
            2 => Codec::Mp3,
            _ => Codec::Unknown(format!("audio_{}", format)),
        };

        // AAC 序列头检测
        if format == 10 && tag.data.len() >= 2 {
            sample.is_init_data = tag.data[1] == 0;
        }
    }

    sample
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_flv_container() {
        // FLV 文件头 + 一个空 tag
        let data = vec![
            b'F', b'L', b'V', 0x01, 0x05, // 签名 + 版本 + 标志
            0x00, 0x00, 0x00, 0x09, // 头大小
            0x00, 0x00, 0x00, 0x00, // PreviousTagSize0
        ];

        let mut container = FlvContainer::from_bytes(data);
        let info = container.read_info().unwrap();

        assert_eq!(info.format, ContainerFormat::Flv);
        assert!(info.has_video);
        assert!(info.has_audio);
    }
}
