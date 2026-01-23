//! Video Analyzer - 视频文件分析工具
//!
//! 这是一个用于分析视频文件的 WASM 库。
//! 支持格式：FLV、MP4、TS
//! 功能包括：
//! - 多格式容器解析
//! - GOP 分析
//! - 时间戳异常检测
//! - HEVC 工具（Annex B/HVCC 转换、codec string 生成）
//! - Sample/Tag 详情解析（字段树、Hex dump）

use std::io::Cursor;
use wasm_bindgen::prelude::*;

pub mod analyzer;
pub mod cache;
pub mod container;
pub mod flv;
pub mod hevc;
pub mod mp4_box;
pub mod splitter;
pub mod streaming;
pub mod streaming_flv;
pub mod streaming_mp4;
pub mod types;

use analyzer::{generate_hex_dump, parse_tag_fields, Analyzer};
use container::{detect_format, ContainerFormat};
use types::*;

// 初始化 panic hook（更好的错误信息）
#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
    web_sys::console::log_1(&"Video Analyzer WASM initialized (v0.7.0 patched)".into());
}

// ==================== 通用分析接口 ====================

/// 检测视频格式
#[wasm_bindgen(js_name = detectFormat)]
pub fn detect_video_format(data: &[u8]) -> String {
    detect_format(data).as_str().to_string()
}

/// 解析视频文件（自动检测格式）
#[wasm_bindgen(js_name = parseVideo)]
pub fn parse_video(data: &[u8]) -> Result<JsValue, JsError> {
    let format = detect_format(data);

    match format {
        ContainerFormat::Flv => parse_flv(data),
        ContainerFormat::Mp4 => parse_mp4(data),
        ContainerFormat::Ts => parse_ts(data),
        ContainerFormat::Unknown => Err(JsError::new("无法识别的视频格式")),
    }
}

// ==================== FLV 分析接口 ====================

/// 解析 FLV 文件
#[wasm_bindgen(js_name = parseFLV)]
pub fn parse_flv(data: &[u8]) -> Result<JsValue, JsError> {
    let mut result = Analyzer::analyze(data).map_err(|e| JsError::new(&e))?;

    // 计算分段信息
    result.segments = splitter::compute_segments(&result);

    serde_wasm_bindgen::to_value(&result).map_err(|e| JsError::new(&e.to_string()))
}

/// 获取 GOP 中的标签
#[wasm_bindgen(js_name = getGOPTags)]
pub fn get_gop_tags(result_json: &str, gop_index: usize) -> Result<JsValue, JsError> {
    let result: AnalysisResult =
        serde_json::from_str(result_json).map_err(|e| JsError::new(&e.to_string()))?;

    let (start_idx, end_idx, tags) =
        Analyzer::get_gop_tags(&result, gop_index).map_err(|e| JsError::new(&e))?;

    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct GopTagsResult {
        start_index: usize,
        end_index: usize,
        tags: Vec<TagSummary>,
    }

    let response = GopTagsResult {
        start_index: start_idx,
        end_index: end_idx,
        tags,
    };

    serde_wasm_bindgen::to_value(&response).map_err(|e| JsError::new(&e.to_string()))
}

// ==================== MP4 分析接口 ====================

/// 解析 MP4 文件
#[wasm_bindgen(js_name = parseMP4)]
pub fn parse_mp4(data: &[u8]) -> Result<JsValue, JsError> {
    use container::{ContainerReader, Mp4Container};

    let file_size = data.len() as u64;
    let mut container = Mp4Container::from_slice(data);

    // 读取容器信息
    let info = container.read_info().map_err(|e| JsError::new(&e))?;

    // 读取所有 samples
    let mut samples: Vec<TagSummary> = Vec::new();
    let mut gops: Vec<Gop> = Vec::new();
    let mut video_timeline: Vec<TimelinePoint> = Vec::new();
    let mut audio_timeline: Vec<TimelinePoint> = Vec::new();
    let mut current_gop_start: Option<usize> = None;
    let mut gop_frame_count = 0usize;
    let mut gop_start_time = 0.0f64;
    let mut last_video_ts = 0u32;
    let mut video_tag_count = 0usize;
    let mut audio_tag_count = 0usize;
    let mut script_tag_count = 0usize;
    let mut keyframe_count = 0usize;

    // 用于追踪 SPS/PPS 变化
    let mut last_sps_data: Option<Vec<u8>> = None;
    let mut last_pps_data: Option<Vec<u8>> = None;

    while let Some(sample) = container.read_sample().map_err(|e| JsError::new(&e))? {
        let tag_type = match sample.sample_type {
            container::SampleType::Video => "video".to_string(),
            container::SampleType::Audio => "audio".to_string(),
            container::SampleType::Metadata => "script".to_string(),
            _ => "unknown".to_string(),
        };

        let is_keyframe = sample.is_keyframe && !sample.is_init_data;
        let is_seq_header = sample.is_init_data;

        let mp4_info = match &sample.container_specific {
            Some(container::ContainerSpecificInfo::Mp4 {
                track_id,
                sample_index,
                sample_desc_index,
            }) => Some(Mp4SampleInfo {
                track_id: *track_id,
                sample_index: *sample_index,
                sample_desc_index: Some(*sample_desc_index),
            }),
            _ => None,
        };

        // 检测是否包含 SEI NALU
        let has_sei = if sample.sample_type == container::SampleType::Video && !sample.is_init_data
        {
            let is_hevc = sample.codec == container::Codec::H265;
            let sample_offset = sample.offset as usize;
            let sample_size = sample.size as usize;
            if sample_offset + sample_size <= data.len() {
                let sample_data = &data[sample_offset..sample_offset + sample_size];
                analyzer::contains_sei_nalu(sample_data, is_hevc)
            } else {
                false
            }
        } else {
            false
        };

        if samples.len() < 3 {
            web_sys::console::log_1(
                &format!(
                    "Sample {}: Specific: {:?}, Mp4Info: {:?}",
                    samples.len(),
                    sample.container_specific,
                    mp4_info
                )
                .into(),
            );
        }

        let tag_summary = TagSummary {
            index: samples.len(),
            tag_type: tag_type.clone(),
            timestamp: sample.dts,
            size: sample.size,
            offset: sample.offset,
            is_keyframe,
            is_seq_header,
            frame_type: if sample.is_keyframe { Some(1) } else { Some(2) },
            codec_id: match sample.codec {
                container::Codec::H264 => Some(7),
                container::Codec::H265 => Some(12),
                _ => None,
            },
            gop_index: if current_gop_start.is_some() {
                Some(gops.len() as i32)
            } else {
                None
            },
            description: Some(format!(
                "{} {}",
                sample.codec.as_str(),
                if is_keyframe {
                    "keyframe"
                } else if is_seq_header {
                    "init"
                } else {
                    "frame"
                }
            )),
            mp4_info,
            has_sei,
            is_sps_pps_change: false, // 将在下面检测后更新
        };

        // SPS/PPS 变化检测（只对视频 init data 进行）
        let mut is_sps_pps_change = false;
        if sample.sample_type == container::SampleType::Video && sample.is_init_data {
            let is_hevc = sample.codec == container::Codec::H265;
            let sample_offset = sample.offset as usize;
            let sample_size = sample.size as usize;
            if sample_offset + sample_size <= data.len() {
                let sample_data = &data[sample_offset..sample_offset + sample_size];
                let (current_sps, current_pps) =
                    analyzer::extract_sps_pps_from_data(sample_data, is_hevc);

                // 检测是否有变化
                let sps_changed = match (&last_sps_data, &current_sps) {
                    (Some(prev), Some(curr)) => prev != curr,
                    (None, Some(_)) => false, // 第一次不算变化
                    _ => false,
                };

                let pps_changed = match (&last_pps_data, &current_pps) {
                    (Some(prev), Some(curr)) => prev != curr,
                    (None, Some(_)) => false,
                    _ => false,
                };

                if sps_changed || pps_changed {
                    is_sps_pps_change = true;
                }

                // 更新存储
                if current_sps.is_some() {
                    last_sps_data = current_sps;
                }
                if current_pps.is_some() {
                    last_pps_data = current_pps;
                }
            }
        }

        // 更新 is_sps_pps_change
        let tag_summary = TagSummary {
            is_sps_pps_change,
            ..tag_summary
        };

        // 统计和时间线
        match sample.sample_type {
            container::SampleType::Video => {
                video_tag_count += 1;
                if is_keyframe {
                    keyframe_count += 1;
                }

                let ts = sample.dts as f64 / 1000.0;
                let pts = sample.pts as f64 / 1000.0;
                let duration_secs = sample.duration_ms.map(|d| d / 1000.0);
                video_timeline.push(TimelinePoint {
                    index: samples.len(),
                    timestamp: ts,
                    dts: ts,
                    pts,
                    duration: duration_secs,
                });

                // GOP 分析
                if is_keyframe {
                    // 完成上一个 GOP
                    if let Some(start) = current_gop_start {
                        gops.push(Gop {
                            index: gops.len(),
                            start_index: start,
                            end_index: samples.len() - 1,
                            start_time: gop_start_time,
                            duration: last_video_ts as f64 / 1000.0 - gop_start_time,
                            frame_count: gop_frame_count,
                        });
                    }
                    current_gop_start = Some(samples.len());
                    gop_start_time = sample.dts as f64 / 1000.0;
                    gop_frame_count = 0;
                }

                if !is_seq_header {
                    gop_frame_count += 1;
                    last_video_ts = sample.dts;
                }
            }
            container::SampleType::Audio => {
                audio_tag_count += 1;
                let ts = sample.dts as f64 / 1000.0;
                audio_timeline.push(TimelinePoint {
                    index: samples.len(),
                    timestamp: ts,
                    dts: ts,
                    pts: ts,
                    duration: None,
                });
            }
            container::SampleType::Metadata => {
                script_tag_count += 1;
            }
            _ => {}
        }

        samples.push(tag_summary);
    }

    // 完成最后一个 GOP
    if let Some(start) = current_gop_start {
        if start < samples.len() {
            gops.push(Gop {
                index: gops.len(),
                start_index: start,
                end_index: samples.len() - 1,
                start_time: gop_start_time,
                duration: last_video_ts as f64 / 1000.0 - gop_start_time,
                frame_count: gop_frame_count,
            });
        }
    }

    let mut result = AnalysisResult {
        file_size,
        format: "MP4".to_string(),
        duration: info.duration_ms as f64 / 1000.0,
        has_audio: info.has_audio,
        has_video: info.has_video,
        tags: samples,
        video_timeline,
        audio_timeline,
        gops,
        video_tag_count,
        audio_tag_count,
        script_tag_count,
        keyframe_count,
        anomalies: Vec::new(),
        video_init_data: info.video_init_data,
        video_init_data_list: info.video_init_data_list,
        audio_init_data: info.audio_init_data,
        segments: None,
    };

    // 计算分段信息
    result.segments = splitter::compute_segments(&result);

    serde_wasm_bindgen::to_value(&result).map_err(|e| JsError::new(&e.to_string()))
}

/// 获取 MP4 Box 树结构
#[wasm_bindgen(js_name = getMp4BoxTree)]
pub fn get_mp4_box_tree(data: &[u8]) -> Result<JsValue, JsError> {
    let tree = mp4_box::parse_mp4_box_tree(data).map_err(|e| JsError::new(&e))?;
    serde_wasm_bindgen::to_value(&tree).map_err(|e| JsError::new(&e.to_string()))
}

/// 获取 MP4 Sample 的详细信息（包括计算来源说明）
#[wasm_bindgen(js_name = getMp4SampleDetail)]
pub fn get_mp4_sample_detail(
    result_json: &str,
    tag_index: usize,
    file_data: &[u8],
) -> Result<JsValue, JsError> {
    use container::{ContainerReader, Mp4Container};

    let result: AnalysisResult =
        serde_json::from_str(result_json).map_err(|e| JsError::new(&e.to_string()))?;

    if tag_index >= result.tags.len() {
        return Err(JsError::new(&format!("无效的 Tag 索引: {}", tag_index)));
    }

    let tag = &result.tags[tag_index];

    // 如果不是 MP4 sample，返回空
    let mp4_info = tag
        .mp4_info
        .as_ref()
        .ok_or_else(|| JsError::new("不是 MP4 Sample"))?;

    // 重新解析 MP4 以获取详细信息
    let mut container = Mp4Container::from_slice(file_data);
    let _info = container.read_info().map_err(|e| JsError::new(&e))?;

    // 收集 sample 的详细信息
    let mut sample_detail = Mp4SampleDetail {
        track_id: mp4_info.track_id,
        sample_index: mp4_info.sample_index,
        fields: Vec::new(),
    };

    // 基本信息
    sample_detail.fields.push(SampleDetailField::new(
        "Track ID",
        mp4_info.track_id.to_string(),
        "轨道编号，在 tkhd box 中定义",
        "tkhd.track_id",
    ));

    sample_detail.fields.push(SampleDetailField::new(
        "Sample Index",
        mp4_info.sample_index.to_string(),
        "采样在轨道中的索引（0-based）",
        "从 stts/stsz 表的顺序确定",
    ));

    // 从 timeline 获取时间信息
    let timeline_point = result
        .video_timeline
        .iter()
        .chain(result.audio_timeline.iter())
        .find(|p| p.index == tag_index);

    if let Some(tp) = timeline_point {
        sample_detail.fields.push(SampleDetailField::new(
            "DTS (ms)",
            format!("{:.3}", tp.dts * 1000.0),
            "解码时间戳（Decode Time Stamp），采样应该被解码的时间",
            "∑ stts.sample_delta[0..sample_index] × 1000 / mdhd.timescale",
        ));

        sample_detail.fields.push(SampleDetailField::new(
            "PTS (ms)",
            format!("{:.3}", tp.pts * 1000.0),
            "显示时间戳（Presentation Time Stamp），采样应该被显示的时间",
            "DTS + ctts.sample_offset × 1000 / mdhd.timescale",
        ));

        let cts_offset = (tp.pts - tp.dts) * 1000.0;
        sample_detail.fields.push(SampleDetailField::new(
            "CTS Offset (ms)",
            format!("{:.3}", cts_offset),
            "合成时间偏移，PTS 与 DTS 之差（B 帧时非零）",
            "ctts.sample_offset × 1000 / mdhd.timescale",
        ));

        if let Some(duration) = tp.duration {
            sample_detail.fields.push(SampleDetailField::new(
                "Duration (ms)",
                format!("{:.3}", duration * 1000.0),
                "采样持续时间",
                "stts.sample_delta × 1000 / mdhd.timescale",
            ));
        }
    }

    // 位置和大小信息
    sample_detail.fields.push(SampleDetailField::new(
        "Offset (bytes)",
        format!("0x{:X} ({})", tag.offset, tag.offset),
        "采样数据在文件中的字节偏移",
        "stco/co64.chunk_offset + Σ stsz.sample_size[chunk_start..sample_index]",
    ));

    sample_detail.fields.push(SampleDetailField::new(
        "Size (bytes)",
        tag.size.to_string(),
        "采样数据的字节大小",
        "stsz.entry_size[sample_index] 或 stsz.sample_size（固定大小时）",
    ));

    // 关键帧信息
    sample_detail.fields.push(SampleDetailField::new(
        "Is Keyframe",
        if tag.is_keyframe { "是" } else { "否" }.to_string(),
        "是否为同步采样（关键帧），可作为随机访问点",
        "sample_index + 1 ∈ stss.sample_number[] 则为关键帧；无 stss 表时全部为关键帧",
    ));

    serde_wasm_bindgen::to_value(&sample_detail).map_err(|e| JsError::new(&e.to_string()))
}

/// MP4 Sample 详情
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mp4SampleDetail {
    pub track_id: u32,
    pub sample_index: u32,
    pub fields: Vec<SampleDetailField>,
}

/// Sample 详情字段
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleDetailField {
    /// 字段名
    pub name: String,
    /// 字段值
    pub value: String,
    /// 简短说明
    pub description: String,
    /// 计算公式/来源说明
    pub formula: String,
}

impl SampleDetailField {
    fn new(name: &str, value: String, desc: &str, formula: &str) -> Self {
        Self {
            name: name.to_string(),
            value,
            description: desc.to_string(),
            formula: formula.to_string(),
        }
    }
}

// ==================== TS 分析接口 ====================

/// 解析 TS 文件
#[wasm_bindgen(js_name = parseTS)]
pub fn parse_ts(data: &[u8]) -> Result<JsValue, JsError> {
    use container::{ContainerReader, TsContainer};

    let data_vec = data.to_vec();
    let file_size = data_vec.len() as u64;
    let mut container = TsContainer::from_bytes(data_vec);

    // 读取容器信息
    let info = container.read_info().map_err(|e| JsError::new(&e))?;

    // 读取所有 samples
    let mut samples: Vec<TagSummary> = Vec::new();
    let mut gops: Vec<Gop> = Vec::new();
    let mut video_timeline: Vec<TimelinePoint> = Vec::new();
    let mut audio_timeline: Vec<TimelinePoint> = Vec::new();
    let mut current_gop_start: Option<usize> = None;
    let mut gop_frame_count = 0usize;
    let mut gop_start_time = 0.0f64;
    let mut last_video_ts = 0u32;
    let mut video_tag_count = 0usize;
    let mut audio_tag_count = 0usize;
    let mut script_tag_count = 0usize;
    let mut keyframe_count = 0usize;

    while let Some(sample) = container.read_sample().map_err(|e| JsError::new(&e))? {
        let tag_type = match sample.sample_type {
            container::SampleType::Video => "video".to_string(),
            container::SampleType::Audio => "audio".to_string(),
            container::SampleType::Metadata => "script".to_string(),
            _ => "unknown".to_string(),
        };

        let is_keyframe = sample.is_keyframe;
        let is_seq_header = sample.is_init_data;

        // 检测是否包含 SEI NALU
        let has_sei = if sample.sample_type == container::SampleType::Video && !sample.is_init_data
        {
            let is_hevc = sample.codec == container::Codec::H265;
            let sample_offset = sample.offset as usize;
            let sample_size = sample.size as usize;
            if sample_offset + sample_size <= data.len() {
                let sample_data = &data[sample_offset..sample_offset + sample_size];
                analyzer::contains_sei_nalu(sample_data, is_hevc)
            } else {
                false
            }
        } else {
            false
        };

        let tag_summary = TagSummary {
            index: samples.len(),
            tag_type: tag_type.clone(),
            timestamp: sample.dts,
            size: sample.size,
            offset: sample.offset,
            is_keyframe,
            is_seq_header,
            frame_type: if is_keyframe { Some(1) } else { Some(2) },
            codec_id: match sample.codec {
                container::Codec::H264 => Some(7),
                container::Codec::H265 => Some(12),
                _ => None,
            },
            gop_index: if current_gop_start.is_some() {
                Some(gops.len() as i32)
            } else {
                None
            },
            description: Some(format!(
                "{} {}",
                sample.codec.as_str(),
                if is_keyframe { "keyframe" } else { "frame" }
            )),
            mp4_info: match &sample.container_specific {
                Some(container::ContainerSpecificInfo::Mp4 {
                    track_id,
                    sample_index,
                    sample_desc_index,
                }) => Some(Mp4SampleInfo {
                    track_id: *track_id,
                    sample_index: *sample_index,
                    sample_desc_index: Some(*sample_desc_index),
                }),
                _ => None,
            },

            has_sei,
            is_sps_pps_change: false, // TS 容器暂不检测
        };

        // 统计和时间线
        match sample.sample_type {
            container::SampleType::Video => {
                video_tag_count += 1;
                if is_keyframe {
                    keyframe_count += 1;
                }

                let ts = sample.dts as f64 / 1000.0;
                let pts = sample.pts as f64 / 1000.0;
                video_timeline.push(TimelinePoint {
                    index: samples.len(),
                    timestamp: ts,
                    dts: ts,
                    pts,
                    duration: None,
                });

                // GOP 分析
                if is_keyframe {
                    // 完成上一个 GOP
                    if let Some(start) = current_gop_start {
                        gops.push(Gop {
                            index: gops.len(),
                            start_index: start,
                            end_index: samples.len() - 1,
                            start_time: gop_start_time,
                            duration: last_video_ts as f64 / 1000.0 - gop_start_time,
                            frame_count: gop_frame_count,
                        });
                    }
                    current_gop_start = Some(samples.len());
                    gop_start_time = sample.dts as f64 / 1000.0;
                    gop_frame_count = 0;
                }

                gop_frame_count += 1;
                last_video_ts = sample.dts;
            }
            container::SampleType::Audio => {
                audio_tag_count += 1;
                let ts = sample.dts as f64 / 1000.0;
                audio_timeline.push(TimelinePoint {
                    index: samples.len(),
                    timestamp: ts,
                    dts: ts,
                    pts: ts,
                    duration: None,
                });
            }
            container::SampleType::Metadata => {
                script_tag_count += 1;
            }
            _ => {}
        }

        samples.push(tag_summary);
    }

    // 完成最后一个 GOP
    if let Some(start) = current_gop_start {
        if start < samples.len() {
            gops.push(Gop {
                index: gops.len(),
                start_index: start,
                end_index: samples.len() - 1,
                start_time: gop_start_time,
                duration: last_video_ts as f64 / 1000.0 - gop_start_time,
                frame_count: gop_frame_count,
            });
        }
    }

    let result = AnalysisResult {
        file_size,
        format: "TS".to_string(),
        duration: info.duration_ms as f64 / 1000.0,
        has_audio: info.has_audio,
        has_video: info.has_video,
        tags: samples,
        video_timeline,
        audio_timeline,
        gops,
        video_tag_count,
        audio_tag_count,
        script_tag_count,
        keyframe_count,
        anomalies: Vec::new(),
        video_init_data: info.video_init_data,
        video_init_data_list: None, // TS 暂不支持多配置
        audio_init_data: info.audio_init_data,
        segments: None,
    };

    // 尝试计算分段信息 (虽然目前只支持 FLV/MP4，但为将来扩展准备)
    // result.segments = splitter::compute_segments(&result);

    serde_wasm_bindgen::to_value(&result).map_err(|e| JsError::new(&e.to_string()))
}

// ==================== Tag 详情接口 ====================

/// 获取 Tag 详情（字段树 + Hex dump）
#[wasm_bindgen(js_name = getTagDetail)]
pub fn get_tag_detail(
    result_json: &str,
    tag_index: usize,
    file_data: &[u8],
) -> Result<JsValue, JsError> {
    let result: AnalysisResult =
        serde_json::from_str(result_json).map_err(|e| JsError::new(&e.to_string()))?;

    if tag_index >= result.tags.len() {
        return Err(JsError::new(&format!("无效的 Tag 索引: {}", tag_index)));
    }

    let tag = &result.tags[tag_index];
    let tag_offset = tag.offset as usize;

    // FLV 和其他格式的 header 大小不同
    let header_size = if result.format == "flv" { 11 } else { 0 };
    let total_size = tag.size + header_size;
    let max_bytes = 256.min(total_size as usize);

    // 提取 tag 数据 (用于 Hex dump)
    let end_offset = (tag_offset + max_bytes).min(file_data.len());
    if tag_offset >= file_data.len() {
        return Err(JsError::new(&format!("偏移超出文件范围: {}", tag_offset)));
    }
    let tag_data = &file_data[tag_offset..end_offset];

    // 解析字段 - MP4 需要完整文件数据来解析 NALU
    let fields = if tag.mp4_info.is_some() {
        parse_tag_fields(tag, file_data) // MP4: 传递完整文件数据
    } else {
        parse_tag_fields(tag, tag_data) // FLV: 使用截断数据即可
    };

    // 生成 Hex dump (仍然使用截断数据)
    let hex_lines = generate_hex_dump(tag_data, tag.offset, max_bytes, &fields);

    let detail = TagDetail {
        tag_index,
        tag_type: tag.tag_type.clone(),
        timestamp: tag.timestamp,
        size: tag.size,
        offset: tag.offset,
        total_size,
        fields,
        hex_lines,
    };

    serde_wasm_bindgen::to_value(&detail).map_err(|e| JsError::new(&e.to_string()))
}

// ==================== HEVC 工具接口 ====================

/// 检测是否为 Annex B 格式
#[wasm_bindgen(js_name = isAnnexBFormat)]
pub fn is_annex_b_format(data: &[u8]) -> bool {
    hevc::is_annex_b_format(data)
}

/// 将 Annex B 格式转换为 HVCC
#[wasm_bindgen(js_name = convertAnnexBToHVCC)]
pub fn convert_annex_b_to_hvcc(data: &[u8]) -> Result<Vec<u8>, JsError> {
    hevc::convert_annex_b_to_hvcc(data).map_err(|e| JsError::new(&e))
}

/// 将 Annex B 格式转换为 AVCC（带长度前缀）
#[wasm_bindgen(js_name = convertAnnexBToAVCC)]
pub fn convert_annex_b_to_avcc(data: &[u8]) -> Vec<u8> {
    hevc::convert_annex_b_to_avcc(data)
}

/// 生成 HEVC codec string
#[wasm_bindgen(js_name = generateHEVCCodecString)]
pub fn generate_hevc_codec_string(
    hvcc_data: &[u8],
    compat_mode: &str,
    constraint_mode: &str,
) -> String {
    let options = hevc::CodecStringOptions {
        compat_mode: compat_mode.to_string(),
        constraint_mode: constraint_mode.to_string(),
    };
    hevc::generate_codec_string(hvcc_data, &options)
}

// ==================== 工具函数 ====================

/// 获取库版本
#[wasm_bindgen(js_name = getVersion)]
pub fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 获取支持的格式列表
#[wasm_bindgen(js_name = getSupportedFormats)]
pub fn get_supported_formats() -> Vec<JsValue> {
    vec![
        JsValue::from_str("flv"),
        JsValue::from_str("mp4"),
        JsValue::from_str("ts"),
    ]
}
