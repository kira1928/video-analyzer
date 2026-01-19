//! 流式 FLV 解析器
//!
//! 支持按需读取大文件，不需要将整个文件加载到内存

use crate::container::Codec;
use crate::types::*;
use js_sys::{Function, Promise, Uint8Array};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

/// FLV 文件头大小
const FLV_HEADER_SIZE: u64 = 9;
/// FLV Tag 头大小
const FLV_TAG_HEADER_SIZE: u64 = 11;
/// Previous Tag Size 字段大小
const PREV_TAG_SIZE: u64 = 4;

/// Tag 类型
const TAG_TYPE_AUDIO: u8 = 8;
const TAG_TYPE_VIDEO: u8 = 9;
const TAG_TYPE_SCRIPT: u8 = 18;

/// 轨道类型
#[derive(Debug, Clone, Copy, PartialEq)]
enum TrackType {
    Video,
    Audio,
}

/// Tag 元数据（不含数据）
#[derive(Debug, Clone)]
struct TagMetadata {
    tag_type: u8,
    data_size: u32,
    timestamp: u32,
    offset: u64,      // Tag 在文件中的偏移
    data_offset: u64, // Tag 数据在文件中的偏移
    is_keyframe: bool,
    is_seq_header: bool,
    codec_id: Option<u8>,
}

/// 流式 FLV 解析器
#[wasm_bindgen]
pub struct StreamingFlvParser {
    file_size: u64,
    read_callback: Function,
    tags: Vec<TagMetadata>,
    // 容器信息
    duration_ms: u64,
    has_video: bool,
    has_audio: bool,
    video_codec: Option<u8>,
    audio_codec: Option<u8>,
    width: Option<u32>,
    height: Option<u32>,
    // 初始化数据偏移
    video_init_offset: Option<u64>,
    video_init_size: Option<u32>,
}

#[wasm_bindgen]
impl StreamingFlvParser {
    /// 创建新的流式解析器
    #[wasm_bindgen(constructor)]
    pub fn new(file_size: f64, read_callback: Function) -> Self {
        Self {
            file_size: file_size as u64,
            read_callback,
            tags: Vec::new(),
            duration_ms: 0,
            has_video: false,
            has_audio: false,
            video_codec: None,
            audio_codec: None,
            width: None,
            height: None,
            video_init_offset: None,
            video_init_size: None,
        }
    }

    /// 解析文件结构（只读取元数据，不读取 tag 数据）
    #[wasm_bindgen]
    pub async fn parse(&mut self) -> Result<JsValue, JsError> {
        // 读取并验证 FLV 头部
        self.parse_header().await?;

        // 扫描所有 tag
        self.scan_tags().await?;

        // 返回分析结果
        self.build_result()
    }

    /// 获取 tag 总数
    #[wasm_bindgen(getter)]
    pub fn tag_count(&self) -> usize {
        self.tags.len()
    }

    /// 读取指定 tag 的数据
    #[wasm_bindgen]
    pub async fn read_tag_data(&self, tag_index: usize) -> Result<Uint8Array, JsError> {
        if tag_index >= self.tags.len() {
            return Err(JsError::new("Tag 索引超出范围"));
        }

        let tag = &self.tags[tag_index];
        let data = self
            .read_range(tag.data_offset, tag.data_size as usize)
            .await
            .map_err(|e| JsError::new(&e))?;

        Ok(Uint8Array::from(data.as_slice()))
    }

    /// 读取视频初始化数据 (Sequence Header)
    #[wasm_bindgen]
    pub async fn read_video_init_data(&self) -> Result<Uint8Array, JsError> {
        if let (Some(offset), Some(size)) = (self.video_init_offset, self.video_init_size) {
            let data = self
                .read_range(offset, size as usize)
                .await
                .map_err(|e| JsError::new(&e))?;
            Ok(Uint8Array::from(data.as_slice()))
        } else {
            Err(JsError::new("没有视频初始化数据"))
        }
    }
}

impl StreamingFlvParser {
    /// 读取指定范围的数据
    async fn read_range(&self, offset: u64, length: usize) -> Result<Vec<u8>, String> {
        let this = JsValue::NULL;
        let offset_js = JsValue::from(offset as f64);
        let length_js = JsValue::from(length as f64);

        let promise = self
            .read_callback
            .call2(&this, &offset_js, &length_js)
            .map_err(|e| format!("读取回调调用失败: {:?}", e))?;

        let promise = Promise::from(promise);
        let result = JsFuture::from(promise)
            .await
            .map_err(|e| format!("读取数据失败: {:?}", e))?;

        let array = Uint8Array::new(&result);
        Ok(array.to_vec())
    }

    /// 解析 FLV 头部
    async fn parse_header(&mut self) -> Result<(), JsError> {
        let header = self
            .read_range(0, FLV_HEADER_SIZE as usize)
            .await
            .map_err(|e| JsError::new(&e))?;

        if header.len() < 9 {
            return Err(JsError::new("文件太小"));
        }

        // 验证 FLV 签名
        if header[0] != b'F' || header[1] != b'L' || header[2] != b'V' {
            return Err(JsError::new("不是有效的 FLV 文件"));
        }

        // 检查流类型
        let flags = header[4];
        self.has_audio = (flags & 0x04) != 0;
        self.has_video = (flags & 0x01) != 0;

        Ok(())
    }

    /// 扫描所有 tag（只读取头部，不读取数据）
    async fn scan_tags(&mut self) -> Result<(), JsError> {
        // 跳过 FLV 头部和第一个 PreviousTagSize
        let mut pos = FLV_HEADER_SIZE + PREV_TAG_SIZE;
        let mut last_timestamp = 0u32;

        while pos + FLV_TAG_HEADER_SIZE <= self.file_size {
            // 读取 tag 头部
            let tag_header = self
                .read_range(pos, FLV_TAG_HEADER_SIZE as usize)
                .await
                .map_err(|e| JsError::new(&e))?;

            if tag_header.len() < 11 {
                break;
            }

            let tag_type = tag_header[0];
            let data_size = u32::from_be_bytes([0, tag_header[1], tag_header[2], tag_header[3]]);
            let timestamp = u32::from_be_bytes([
                tag_header[7], // 扩展时间戳高位
                tag_header[4],
                tag_header[5],
                tag_header[6],
            ]);

            // 更新最大时间戳
            if timestamp > last_timestamp {
                last_timestamp = timestamp;
            }

            let data_offset = pos + FLV_TAG_HEADER_SIZE;

            // 解析 tag 类型特定信息
            let mut is_keyframe = false;
            let mut is_seq_header = false;
            let mut codec_id = None;

            if data_size > 0 && (tag_type == TAG_TYPE_VIDEO || tag_type == TAG_TYPE_AUDIO) {
                // 读取第一个字节来获取更多信息
                let first_byte = self
                    .read_range(data_offset, 1)
                    .await
                    .map_err(|e| JsError::new(&e))?;

                if !first_byte.is_empty() {
                    if tag_type == TAG_TYPE_VIDEO {
                        let frame_type = (first_byte[0] >> 4) & 0x0F;
                        let video_codec = first_byte[0] & 0x0F;

                        is_keyframe = frame_type == 1;
                        codec_id = Some(video_codec);

                        // 检测是否为 Sequence Header
                        if data_size >= 2 {
                            let second_byte = self
                                .read_range(data_offset + 1, 1)
                                .await
                                .map_err(|e| JsError::new(&e))?;
                            if !second_byte.is_empty() && second_byte[0] == 0 {
                                is_seq_header = true;

                                // 记录视频初始化数据位置
                                if self.video_init_offset.is_none() {
                                    self.video_init_offset = Some(data_offset);
                                    self.video_init_size = Some(data_size);
                                }
                            }
                        }

                        if self.video_codec.is_none() {
                            self.video_codec = Some(video_codec);
                        }
                    } else if tag_type == TAG_TYPE_AUDIO {
                        let audio_format = (first_byte[0] >> 4) & 0x0F;
                        codec_id = Some(audio_format);

                        if self.audio_codec.is_none() {
                            self.audio_codec = Some(audio_format);
                        }
                    }
                }
            }

            self.tags.push(TagMetadata {
                tag_type,
                data_size,
                timestamp,
                offset: pos,
                data_offset,
                is_keyframe,
                is_seq_header,
                codec_id,
            });

            // 移动到下一个 tag
            pos += FLV_TAG_HEADER_SIZE + data_size as u64 + PREV_TAG_SIZE;
        }

        self.duration_ms = last_timestamp as u64;

        Ok(())
    }

    /// 构建分析结果
    fn build_result(&self) -> Result<JsValue, JsError> {
        let mut tags = Vec::new();
        let mut video_timeline = Vec::new();
        let mut audio_timeline = Vec::new();
        let mut gops = Vec::new();
        let mut video_tag_count = 0usize;
        let mut audio_tag_count = 0usize;
        let mut script_tag_count = 0usize;
        let mut keyframe_count = 0usize;
        let mut current_gop_start: Option<usize> = None;
        let mut gop_start_time = 0.0f64;

        for (idx, tag) in self.tags.iter().enumerate() {
            let is_video = tag.tag_type == TAG_TYPE_VIDEO;
            let is_audio = tag.tag_type == TAG_TYPE_AUDIO;
            let is_script = tag.tag_type == TAG_TYPE_SCRIPT;

            // GOP 检测（仅视频）
            let gop_index = if is_video {
                if tag.is_keyframe && !tag.is_seq_header && current_gop_start.is_some() {
                    // 保存上一个 GOP
                    let prev_gop_start = current_gop_start.unwrap();
                    let gop_frame_count = video_tag_count - prev_gop_start;
                    if !gops.is_empty() {
                        let last_gop: &mut Gop = gops.last_mut().unwrap();
                        last_gop.end_index = idx.saturating_sub(1);
                        last_gop.frame_count = gop_frame_count;
                        last_gop.duration = tag.timestamp as f64 / 1000.0 - gop_start_time;
                    }
                }

                if tag.is_keyframe && !tag.is_seq_header {
                    current_gop_start = Some(video_tag_count);
                    gop_start_time = tag.timestamp as f64 / 1000.0;

                    gops.push(Gop {
                        index: gops.len(),
                        start_index: idx,
                        end_index: idx,
                        start_time: gop_start_time,
                        duration: 0.0,
                        frame_count: 0,
                    });
                }

                if current_gop_start.is_some() {
                    Some(gops.len().saturating_sub(1) as i32)
                } else {
                    None
                }
            } else {
                None
            };

            // 更新计数器和时间线
            if is_video {
                video_tag_count += 1;
                if tag.is_keyframe && !tag.is_seq_header {
                    keyframe_count += 1;
                }

                video_timeline.push(TimelinePoint {
                    index: idx,
                    timestamp: tag.timestamp as f64 / 1000.0,
                    dts: tag.timestamp as f64 / 1000.0,
                    pts: tag.timestamp as f64 / 1000.0,
                    duration: None,
                });
            } else if is_audio {
                audio_tag_count += 1;

                audio_timeline.push(TimelinePoint {
                    index: idx,
                    timestamp: tag.timestamp as f64 / 1000.0,
                    dts: tag.timestamp as f64 / 1000.0,
                    pts: tag.timestamp as f64 / 1000.0,
                    duration: None,
                });
            } else if is_script {
                script_tag_count += 1;
            }

            let tag_type_str = match tag.tag_type {
                TAG_TYPE_VIDEO => "video",
                TAG_TYPE_AUDIO => "audio",
                TAG_TYPE_SCRIPT => "script",
                _ => "unknown",
            };

            let description = if is_video {
                let codec_name = match tag.codec_id {
                    Some(7) => "H.264",
                    Some(12) => "HEVC",
                    _ => "Video",
                };
                if tag.is_seq_header {
                    format!("{} Sequence Header", codec_name)
                } else if tag.is_keyframe {
                    format!("{} Keyframe", codec_name)
                } else {
                    format!("{} Frame", codec_name)
                }
            } else if is_audio {
                let codec_name = match tag.codec_id {
                    Some(10) => "AAC",
                    Some(2) => "MP3",
                    _ => "Audio",
                };
                format!("{}", codec_name)
            } else {
                "Script Data".to_string()
            };

            let tag_summary = TagSummary {
                index: idx,
                tag_type: tag_type_str.to_string(),
                timestamp: tag.timestamp,
                size: tag.data_size,
                offset: tag.offset,
                is_keyframe: tag.is_keyframe,
                is_seq_header: tag.is_seq_header,
                frame_type: if tag.is_keyframe { Some(1) } else { Some(2) },
                codec_id: tag.codec_id,
                gop_index,
                description: Some(description),
                mp4_info: None,
                has_sei: false,           // 流式模式暂不检测 SEI
                is_sps_pps_change: false, // 流式模式暂不检测
            };

            tags.push(tag_summary);
        }

        // 完成最后一个 GOP
        if let Some(last_gop) = gops.last_mut() {
            if let Some(last_tag) = tags.last() {
                last_gop.end_index = tags.len() - 1;
                last_gop.frame_count = video_tag_count - current_gop_start.unwrap_or(0);
                last_gop.duration = last_tag.timestamp as f64 / 1000.0 - gop_start_time;
            }
        }

        let video_codec_str = match self.video_codec {
            Some(7) => Some("H264".to_string()),
            Some(12) => Some("H265".to_string()),
            _ => None,
        };

        let audio_codec_str = match self.audio_codec {
            Some(10) => Some("AAC".to_string()),
            Some(2) => Some("MP3".to_string()),
            _ => None,
        };

        let result = AnalysisResult {
            format: "FLV".to_string(),
            file_size: self.file_size,
            duration: self.duration_ms as f64 / 1000.0,
            has_video: self.has_video,
            has_audio: self.has_audio,
            tags,
            video_timeline,
            audio_timeline,
            gops,
            video_tag_count,
            audio_tag_count,
            script_tag_count,
            keyframe_count,
            anomalies: Vec::new(),
            video_init_data: None,      // 流式模式下按需获取
            video_init_data_list: None, // FLV 不支持多配置
            audio_init_data: None,
            segments: None,
        };

        // 计算分段信息
        let mut result_mut = result;
        result_mut.segments = crate::splitter::compute_segments(&result_mut);

        serde_wasm_bindgen::to_value(&result_mut)
            .map_err(|e| JsError::new(&format!("序列化结果失败: {}", e)))
    }
}
