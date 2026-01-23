//! 分析器模块

use crate::flv::{FlvReader, TAG_TYPE_AUDIO, TAG_TYPE_SCRIPT, TAG_TYPE_VIDEO};
use crate::types::*;
use std::io::Cursor;

/// FLV 分析器
pub struct Analyzer;

impl Analyzer {
    /// 分析 FLV 文件
    pub fn analyze(data: &[u8]) -> Result<AnalysisResult, String> {
        let mut reader = FlvReader::new(Cursor::new(data));

        let header = reader
            .read_header()
            .map_err(|e| format!("读取 FLV 头失败: {}", e))?;

        let mut result = AnalysisResult {
            file_size: data.len() as u64,
            format: "FLV".to_string(),
            has_video: header.has_video,
            has_audio: header.has_audio,
            duration: 0.0,
            tags: Vec::new(),
            video_timeline: Vec::new(),
            audio_timeline: Vec::new(),
            gops: Vec::new(),
            video_tag_count: 0,
            audio_tag_count: 0,
            script_tag_count: 0,
            keyframe_count: 0,
            anomalies: Vec::new(),
            video_init_data: None,      // FLV 从 Sequence Header tag 获取
            video_init_data_list: None, // FLV 不支持多配置
            audio_init_data: None,
            segments: None,
        };

        let mut last_video_ts = 0u32;
        let mut last_audio_ts = 0u32;
        let mut current_gop: i32 = -1;
        let mut gop_start_idx = 0usize;
        let mut gop_start_time = 0.0f64;

        // 用于追踪 SPS/PPS 变化
        let mut last_sps_data: Option<Vec<u8>> = None;
        let mut last_pps_data: Option<Vec<u8>> = None;

        let mut tag_index = 0usize;

        loop {
            let tag = match reader.read_tag() {
                Ok(t) => t,
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(e) => return Err(format!("读取 Tag 失败: {}", e)),
            };

            let mut summary = TagSummary {
                index: tag_index,
                tag_type: tag.type_name().to_string(),
                timestamp: tag.timestamp,
                size: tag.data_size,
                offset: tag.offset,
                mp4_info: None,
                is_keyframe: false,
                is_seq_header: false,
                frame_type: None,
                codec_id: None,
                gop_index: None,
                description: None,
                has_sei: false,
                is_sps_pps_change: false,
            };

            match tag.tag_type {
                TAG_TYPE_VIDEO => {
                    result.video_tag_count += 1;

                    if let Some(video_info) = tag.parse_video() {
                        summary.is_keyframe = video_info.is_keyframe;
                        summary.is_seq_header = video_info.is_seq_header;
                        summary.frame_type = Some(video_info.frame_type);
                        summary.codec_id = Some(video_info.codec_id);

                        // 判断是否为 HEVC
                        let is_hevc = video_info.codec_id == 12; // 12 = HEVC

                        // 获取视频数据（跳过 FLV 视频 tag 头部：1字节 frame_type+codec_id + 1字节 avc_packet_type + 3字节 CTS）
                        let video_data = if tag.data.len() > 5 {
                            &tag.data[5..]
                        } else {
                            &[][..]
                        };

                        // SEI 检测（仅对非序列头的帧）
                        if !video_info.is_seq_header && !video_data.is_empty() {
                            if contains_sei_nalu(video_data, is_hevc) {
                                summary.has_sei = true;
                            }
                        }

                        // 对于 Sequence Header，检测 SPS/PPS 变化
                        if video_info.is_seq_header && !video_data.is_empty() {
                            // 对于 FLV 中的 Sequence Header，数据格式是 AVCDecoderConfigurationRecord
                            // 需要解析 DCR 来提取 SPS/PPS
                            let (current_sps, current_pps) = extract_sps_pps_from_avcc(video_data);

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
                                summary.is_sps_pps_change = true;
                            }

                            // 更新存储
                            if current_sps.is_some() {
                                last_sps_data = current_sps;
                            }
                            if current_pps.is_some() {
                                last_pps_data = current_pps;
                            }

                            // 保存初始化数据
                            if result.video_init_data.is_none() {
                                result.video_init_data = Some(video_data.to_vec());
                            }
                        }

                        if video_info.is_keyframe {
                            result.keyframe_count += 1;

                            // 新 GOP 检测
                            if !video_info.is_seq_header {
                                // 保存上一个 GOP
                                if current_gop >= 0 && !result.gops.is_empty() {
                                    let last_idx = result.gops.len() - 1;
                                    result.gops[last_idx].end_index = tag_index - 1;
                                    result.gops[last_idx].frame_count = tag_index - gop_start_idx;
                                    if last_video_ts > (gop_start_time * 1000.0) as u32 {
                                        result.gops[last_idx].duration =
                                            last_video_ts as f64 / 1000.0 - gop_start_time;
                                    }
                                }

                                // 开始新 GOP
                                current_gop += 1;
                                gop_start_idx = tag_index;
                                gop_start_time = tag.timestamp as f64 / 1000.0;

                                result.gops.push(Gop {
                                    index: current_gop as usize,
                                    start_index: tag_index,
                                    end_index: tag_index,
                                    start_time: gop_start_time,
                                    duration: 0.0,
                                    frame_count: 0,
                                });
                            }
                        }

                        summary.gop_index = if current_gop >= 0 {
                            Some(current_gop)
                        } else {
                            None
                        };

                        // 时间线数据
                        let ts = tag.timestamp as f64 / 1000.0;
                        let pts = ts + video_info.cts as f64 / 1000.0;
                        result.video_timeline.push(TimelinePoint {
                            index: tag_index,
                            timestamp: ts,
                            dts: ts,
                            pts,
                            duration: None,
                        });

                        // 异常检测
                        Self::detect_video_anomalies(
                            &mut result.anomalies,
                            tag_index,
                            tag.timestamp,
                            last_video_ts,
                        );
                    }

                    last_video_ts = tag.timestamp;
                }
                TAG_TYPE_AUDIO => {
                    result.audio_tag_count += 1;

                    if let Some(audio_info) = tag.parse_audio() {
                        summary.is_seq_header = audio_info.is_seq_header;
                    }

                    let ts = tag.timestamp as f64 / 1000.0;
                    result.audio_timeline.push(TimelinePoint {
                        index: tag_index,
                        timestamp: ts,
                        dts: ts,
                        pts: ts,
                        duration: None,
                    });

                    // 音视频同步检测
                    if result.video_tag_count > 0 && last_video_ts > 0 {
                        let diff = tag.timestamp as i32 - last_video_ts as i32;
                        if diff > 5000 || diff < -5000 {
                            result.anomalies.push(Anomaly {
                                anomaly_type: "av_desync".to_string(),
                                tag_index,
                                timestamp: ts,
                                description: format!(
                                    "音视频时间戳差异过大: 音频 {}, 视频 {} (差 {:.1} 秒)",
                                    tag.timestamp,
                                    last_video_ts,
                                    diff as f64 / 1000.0
                                ),
                                severity: "warning".to_string(),
                            });
                        }
                    }

                    last_audio_ts = tag.timestamp;
                }
                TAG_TYPE_SCRIPT => {
                    result.script_tag_count += 1;
                }
                _ => {}
            }

            result.tags.push(summary);
            tag_index += 1;
        }

        // 结束最后一个 GOP
        if current_gop >= 0 && !result.gops.is_empty() {
            let last_idx = result.gops.len() - 1;
            result.gops[last_idx].end_index = tag_index.saturating_sub(1);
            result.gops[last_idx].frame_count = tag_index - gop_start_idx;
            if last_video_ts > (gop_start_time * 1000.0) as u32 {
                result.gops[last_idx].duration = last_video_ts as f64 / 1000.0 - gop_start_time;
            }
        }

        // 计算时长
        result.duration = last_video_ts.max(last_audio_ts) as f64 / 1000.0;

        Ok(result)
    }

    /// 检测视频时间戳异常
    fn detect_video_anomalies(
        anomalies: &mut Vec<Anomaly>,
        tag_index: usize,
        timestamp: u32,
        last_timestamp: u32,
    ) {
        let ts = timestamp as f64 / 1000.0;

        // 时间戳回退
        if timestamp < last_timestamp && last_timestamp - timestamp > 1000 {
            anomalies.push(Anomaly {
                anomaly_type: "timestamp_backward".to_string(),
                tag_index,
                timestamp: ts,
                description: format!("视频时间戳回退: {} -> {}", last_timestamp, timestamp),
                severity: "warning".to_string(),
            });
        }

        // 时间戳跳跃
        if last_timestamp > 0 && timestamp > last_timestamp + 5000 {
            anomalies.push(Anomaly {
                anomaly_type: "timestamp_jump".to_string(),
                tag_index,
                timestamp: ts,
                description: format!(
                    "视频时间戳跳跃: {} -> {} (跳跃 {:.1} 秒)",
                    last_timestamp,
                    timestamp,
                    (timestamp - last_timestamp) as f64 / 1000.0
                ),
                severity: "warning".to_string(),
            });
        }
    }

    /// 获取 GOP 中的标签范围
    pub fn get_gop_tags(
        result: &AnalysisResult,
        gop_index: usize,
    ) -> Result<(usize, usize, Vec<TagSummary>), String> {
        if gop_index >= result.gops.len() {
            return Err(format!("无效的 GOP 索引: {}", gop_index));
        }

        let gop = &result.gops[gop_index];
        let tags: Vec<TagSummary> = result
            .tags
            .iter()
            .filter(|t| t.index >= gop.start_index && t.index <= gop.end_index)
            .cloned()
            .collect();

        Ok((gop.start_index, gop.end_index, tags))
    }
}

/// 解析单个 Tag 的字段结构 - 供详情视图使用
pub fn parse_tag_fields(tag: &TagSummary, data: &[u8]) -> Vec<TagField> {
    let mut fields = Vec::new();

    // 如果是 MP4 Sample
    if let Some(_mp4_info) = &tag.mp4_info {
        // MP4 没有 Tag Header，直接从数据开始
        let mut data_children = Vec::new();

        if tag.tag_type == "video" {
            // 解析 NALU 结构 (AVCC/HVCC: 4字节长度前缀)
            let offset = tag.offset as usize;
            let size = tag.size as usize;

            if offset + size <= data.len() {
                let sample_data = &data[offset..offset + size];

                // 检测编解码器类型（从 description 或 codec_id 推断）
                // FLV codec_id: 7 = AVC, 12 = HEVC
                // MP4: 从 description 字段检测 (description 格式为 "h265 keyframe" 等)
                let is_hevc = tag.description.as_ref().map_or(false, |d| {
                    let d_lower = d.to_lowercase();
                    d_lower.contains("h265")
                        || d_lower.contains("hevc")
                        || d_lower.contains("hvc")
                        || d_lower.contains("hev")
                }) || tag.codec_id == Some(12);

                let nalus = parse_nalus(sample_data, is_hevc);

                for (idx, nalu) in nalus.iter().enumerate() {
                    let mut nalu_children = Vec::new();

                    // 长度字段
                    nalu_children.push(
                        TagField::new(
                            "length_prefix",
                            format!("{} bytes", nalu.length),
                            nalu.start as u32,
                            (nalu.start + 4) as u32,
                        )
                        .with_css_class("hex-highlight-size"),
                    );

                    // NALU Header
                    if is_hevc {
                        // HEVC: 2 byte header
                        nalu_children.push(
                            TagField::new(
                                "nal_unit_header",
                                format!(
                                    "type={}, layer_id={}, tid={}",
                                    nalu.nal_type, nalu.layer_id, nalu.temporal_id
                                ),
                                (nalu.start + 4) as u32,
                                (nalu.start + 6) as u32,
                            )
                            .with_css_class("hex-highlight-type"),
                        );
                    } else {
                        // AVC: 1 byte header
                        let forbidden = (nalu.header_byte >> 7) & 1;
                        let ref_idc = (nalu.header_byte >> 5) & 3;
                        nalu_children.push(
                            TagField::new(
                                "nal_unit_header",
                                format!(
                                    "forbidden_zero_bit={}, nal_ref_idc={}, nal_unit_type={}",
                                    forbidden, ref_idc, nalu.nal_type
                                ),
                                (nalu.start + 4) as u32,
                                (nalu.start + 5) as u32,
                            )
                            .with_css_class("hex-highlight-type"),
                        );
                    }

                    // NALU 负载大小
                    let header_size = if is_hevc { 2 } else { 1 };
                    let payload_size = nalu.length.saturating_sub(header_size);
                    nalu_children.push(
                        TagField::new(
                            "payload",
                            format!("{} bytes", payload_size),
                            (nalu.start + 4 + header_size) as u32,
                            nalu.end as u32,
                        )
                        .with_css_class("hex-highlight-data"),
                    );

                    // 解析特殊 NALU 类型的 payload
                    if nalu.end <= sample_data.len() {
                        let nalu_data = &sample_data[nalu.start + 4..nalu.end];

                        if is_hevc {
                            match nalu.nal_type {
                                39 | 40 => {
                                    // PREFIX_SEI or SUFFIX_SEI
                                    let sei_fields = parse_sei_payload(nalu_data, true);
                                    for sei_field in sei_fields {
                                        nalu_children.push(sei_field);
                                    }
                                }
                                33 => {
                                    // HEVC SPS
                                    let sps_fields = parse_hevc_sps(nalu_data);
                                    if !sps_fields.is_empty() {
                                        nalu_children.push(
                                            TagField::new("SPS 参数", "", 0, 0)
                                                .expanded()
                                                .with_children(sps_fields),
                                        );
                                    }
                                }
                                34 => {
                                    // HEVC PPS
                                    let pps_fields = parse_hevc_pps(nalu_data);
                                    if !pps_fields.is_empty() {
                                        nalu_children.push(
                                            TagField::new("PPS 参数", "", 0, 0)
                                                .expanded()
                                                .with_children(pps_fields),
                                        );
                                    }
                                }
                                _ => {}
                            }
                        } else {
                            match nalu.nal_type {
                                6 => {
                                    // AVC SEI
                                    let sei_fields = parse_sei_payload(nalu_data, false);
                                    for sei_field in sei_fields {
                                        nalu_children.push(sei_field);
                                    }
                                }
                                7 => {
                                    // AVC SPS
                                    let sps_fields = parse_avc_sps(nalu_data);
                                    if !sps_fields.is_empty() {
                                        nalu_children.push(
                                            TagField::new("SPS 参数", "", 0, 0)
                                                .expanded()
                                                .with_children(sps_fields),
                                        );
                                    }
                                }
                                8 => {
                                    // AVC PPS
                                    let pps_fields = parse_avc_pps(nalu_data);
                                    if !pps_fields.is_empty() {
                                        nalu_children.push(
                                            TagField::new("PPS 参数", "", 0, 0)
                                                .expanded()
                                                .with_children(pps_fields),
                                        );
                                    }
                                }
                                _ => {}
                            }
                        }
                    }

                    // 主 NALU 节点
                    let nalu_label = format!("NALU #{} [{}]", idx, nalu.type_name);
                    data_children.push(
                        TagField::new(
                            &nalu_label,
                            format!("{} bytes @ 0x{:X}", nalu.length, nalu.start),
                            nalu.start as u32,
                            nalu.end as u32,
                        )
                        .with_css_class(nalu.css_class)
                        .expanded()
                        .with_children(nalu_children),
                    );
                }

                // 如果没有找到有效的 NALU
                if nalus.is_empty() {
                    data_children.push(
                        TagField::new("raw_data", format!("{} bytes", size), 0, size as u32)
                            .with_css_class("hex-highlight-data"),
                    );
                }
            }
        }

        fields.push(
            TagField::new("Sample Data", format!("{} bytes", tag.size), 0, tag.size)
                .expanded()
                .with_children(data_children),
        );

        return fields;
    }

    // FLV Tag Header (11 bytes)
    let tag_type_value = match tag.tag_type.as_str() {
        "video" => 9,
        "audio" => 8,
        _ => 18,
    };

    let header_children = vec![
        TagField::new(
            "tag type",
            format!("{} ({})", tag_type_value, tag.tag_type),
            0,
            1,
        )
        .with_css_class("hex-highlight-type"),
        TagField::new("data size", tag.size, 1, 4).with_css_class("hex-highlight-size"),
        TagField::new("timestamp", tag.timestamp, 4, 7).with_css_class("hex-highlight-timestamp"),
        TagField::new("timestamp ext", 0, 7, 8).with_css_class("hex-highlight-timestamp"),
        TagField::new("[whole pts]", tag.timestamp, 4, 8).as_virtual(),
        TagField::new("stream id", 0, 8, 11),
    ];

    fields.push(
        TagField::new("tag header()", "11 (bytes)", 0, 11)
            .expanded()
            .with_children(header_children),
    );

    // Tag Data
    let mut data_children = Vec::new();

    if tag.tag_type == "video" {
        let codec_id = tag.codec_id.unwrap_or(7);
        let frame_type = tag
            .frame_type
            .unwrap_or(if tag.is_keyframe { 1 } else { 2 });
        let is_seq_header = tag.is_seq_header;

        let codec_name = match codec_id {
            7 => "avc",
            12 => "hevc",
            _ => "unknown",
        };

        data_children.push(TagField::new("IsExHeader", "0 (u(1:b7))", 11, 12));
        data_children.push(TagField::new(
            "frame type",
            format!(
                "{} ({}) u(3:b6-4)",
                frame_type,
                if tag.is_keyframe {
                    "key frame"
                } else {
                    "inter frame"
                }
            ),
            11,
            12,
        ));
        data_children.push(
            TagField::new(
                "video codec",
                format!("0x{:02x} ({}) u(4:b3-0)", codec_id, codec_name),
                11,
                12,
            )
            .with_css_class("hex-highlight-type"),
        );
        data_children.push(TagField::new(
            "packet type",
            format!(
                "{} ({})",
                if is_seq_header { 0 } else { 1 },
                if is_seq_header {
                    "SequenceHeader"
                } else {
                    "CodedFrames"
                }
            ),
            12,
            13,
        ));

        if !is_seq_header {
            data_children.push(TagField::new("composition time", "0", 13, 16));
        }

        let nalu_start = if is_seq_header { 13 } else { 16 };
        data_children.push(TagField::new(
            if codec_id == 12 {
                "hevc Nalus()"
            } else {
                "avc Nalus()"
            },
            "",
            nalu_start,
            11 + tag.size,
        ));
        data_children.push(TagField::new("...", "", 11 + tag.size - 5, 11 + tag.size).as_virtual());
    } else if tag.tag_type == "audio" {
        data_children.push(
            TagField::new("sound format", "10 (AAC)", 11, 12).with_css_class("hex-highlight-type"),
        );
        data_children.push(TagField::new(
            "AAC packet type",
            if tag.is_seq_header {
                "0 (AAC sequence header)"
            } else {
                "1 (AAC raw)"
            },
            12,
            13,
        ));
    }

    fields.push(
        TagField::new(
            "tag data()",
            format!("{} (bytes)", tag.size),
            11,
            11 + tag.size,
        )
        .expanded()
        .with_css_class("hex-highlight-data")
        .with_children(data_children),
    );

    fields
}

/// 生成 Hex dump
pub fn generate_hex_dump(
    data: &[u8],
    base_offset: u64,
    max_bytes: usize,
    fields: &[TagField],
) -> Vec<HexLine> {
    const BYTES_PER_LINE: usize = 8;

    // 构建字节到 CSS 类的映射
    let mut byte_classes = std::collections::HashMap::new();
    fn collect_classes(fields: &[TagField], classes: &mut std::collections::HashMap<u32, String>) {
        for field in fields {
            if let Some(ref css_class) = field.css_class {
                if field.virtual_field.is_none() || field.virtual_field == Some(false) {
                    for i in field.start..field.end {
                        classes.insert(i, css_class.clone());
                    }
                }
            }
            if let Some(ref children) = field.children {
                collect_classes(children, classes);
            }
        }
    }
    collect_classes(fields, &mut byte_classes);

    let bytes_to_show = data.len().min(max_bytes);
    let mut lines = Vec::new();

    for chunk_start in (0..bytes_to_show).step_by(BYTES_PER_LINE) {
        let offset = format!("{:07X}", base_offset + chunk_start as u64);
        let mut bytes = Vec::new();
        let mut ascii = String::new();

        for j in 0..BYTES_PER_LINE {
            let byte_index = chunk_start + j;
            if byte_index < bytes_to_show {
                let byte = data[byte_index];
                let hex = format!("{:02X}", byte);
                let css_class = byte_classes.get(&(byte_index as u32)).cloned();

                bytes.push(HexByte { hex, css_class });

                // ASCII
                if byte >= 32 && byte <= 126 {
                    ascii.push(byte as char);
                } else {
                    ascii.push('.');
                }
            } else {
                bytes.push(HexByte {
                    hex: "  ".to_string(),
                    css_class: None,
                });
                ascii.push(' ');
            }
        }

        lines.push(HexLine {
            offset,
            bytes,
            ascii,
        });
    }

    lines
}

// ==================== NALU 解析 ====================

/// 解析后的 NALU 信息
struct NaluInfo {
    /// NALU 在数据中的起始位置
    start: usize,
    /// NALU 结束位置
    end: usize,
    /// NALU 长度（不含长度前缀）
    length: usize,
    /// NALU 类型编号
    nal_type: u8,
    /// NALU 类型名称
    type_name: &'static str,
    /// 原始 header 字节（用于显示详情）
    header_byte: u8,
    /// HEVC: layer_id
    layer_id: u8,
    /// HEVC: temporal_id
    temporal_id: u8,
    /// CSS 高亮类
    css_class: &'static str,
}

/// 解析 AVCC/HVCC 格式的 NALU 列表
fn parse_nalus(data: &[u8], is_hevc: bool) -> Vec<NaluInfo> {
    let mut nalus = Vec::new();
    let mut pos = 0;

    while pos + 4 <= data.len() {
        // 读取 4 字节长度前缀
        let length =
            u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as usize;

        let start = pos;
        let end = pos + 4 + length;

        // 检查边界
        if end > data.len() || length == 0 {
            break;
        }

        // 确保有 header 数据
        if pos + 4 >= data.len() {
            break;
        }

        let (nal_type, type_name, css_class, layer_id, temporal_id, header_byte) = if is_hevc {
            parse_hevc_nalu_header(&data[pos + 4..])
        } else {
            parse_avc_nalu_header(&data[pos + 4..])
        };

        nalus.push(NaluInfo {
            start,
            end,
            length,
            nal_type,
            type_name,
            header_byte,
            layer_id,
            temporal_id,
            css_class,
        });

        pos = end;
    }

    nalus
}

/// 解析 AVC (H.264) NALU header
fn parse_avc_nalu_header(data: &[u8]) -> (u8, &'static str, &'static str, u8, u8, u8) {
    if data.is_empty() {
        return (0, "Unknown", "hex-highlight-data", 0, 0, 0);
    }

    let header_byte = data[0];
    let nal_type = header_byte & 0x1F;

    let (type_name, css_class) = match nal_type {
        0 => ("Unspecified", "hex-highlight-data"),
        1 => ("Slice (Non-IDR)", "hex-highlight-data"),
        2 => ("Slice Part A", "hex-highlight-data"),
        3 => ("Slice Part B", "hex-highlight-data"),
        4 => ("Slice Part C", "hex-highlight-data"),
        5 => ("IDR Slice", "hex-highlight-keyframe"),
        6 => ("SEI", "hex-highlight-metadata"),
        7 => ("SPS", "hex-highlight-config"),
        8 => ("PPS", "hex-highlight-config"),
        9 => ("AUD", "hex-highlight-metadata"),
        10 => ("End of Sequence", "hex-highlight-metadata"),
        11 => ("End of Stream", "hex-highlight-metadata"),
        12 => ("Filler Data", "hex-highlight-data"),
        13 => ("SPS Extension", "hex-highlight-config"),
        14 => ("Prefix NAL Unit", "hex-highlight-data"),
        15 => ("Subset SPS", "hex-highlight-config"),
        16 => ("DPS", "hex-highlight-config"),
        19 => ("Auxiliary Slice", "hex-highlight-data"),
        20 => ("Slice Extension", "hex-highlight-data"),
        21 => ("Slice Extension (Depth)", "hex-highlight-data"),
        _ => ("Reserved/Unknown", "hex-highlight-data"),
    };

    (nal_type, type_name, css_class, 0, 0, header_byte)
}

/// 解析 HEVC (H.265) NALU header
fn parse_hevc_nalu_header(data: &[u8]) -> (u8, &'static str, &'static str, u8, u8, u8) {
    if data.len() < 2 {
        return (0, "Unknown", "hex-highlight-data", 0, 0, 0);
    }

    let header_byte = data[0];
    // HEVC NAL header: forbidden_zero_bit(1) + nal_unit_type(6) + nuh_layer_id(6) + nuh_temporal_id_plus1(3)
    let nal_type = (header_byte >> 1) & 0x3F;
    let layer_id = ((data[0] & 0x01) << 5) | ((data[1] >> 3) & 0x1F);
    let temporal_id = (data[1] & 0x07).saturating_sub(1);

    let (type_name, css_class) = match nal_type {
        0 => ("TRAIL_N", "hex-highlight-data"),
        1 => ("TRAIL_R", "hex-highlight-data"),
        2 => ("TSA_N", "hex-highlight-data"),
        3 => ("TSA_R", "hex-highlight-data"),
        4 => ("STSA_N", "hex-highlight-data"),
        5 => ("STSA_R", "hex-highlight-data"),
        6 => ("RADL_N", "hex-highlight-data"),
        7 => ("RADL_R", "hex-highlight-data"),
        8 => ("RASL_N", "hex-highlight-data"),
        9 => ("RASL_R", "hex-highlight-data"),
        16 => ("BLA_W_LP", "hex-highlight-keyframe"),
        17 => ("BLA_W_RADL", "hex-highlight-keyframe"),
        18 => ("BLA_N_LP", "hex-highlight-keyframe"),
        19 => ("IDR_W_RADL", "hex-highlight-keyframe"),
        20 => ("IDR_N_LP", "hex-highlight-keyframe"),
        21 => ("CRA_NUT", "hex-highlight-keyframe"),
        32 => ("VPS", "hex-highlight-config"),
        33 => ("SPS", "hex-highlight-config"),
        34 => ("PPS", "hex-highlight-config"),
        35 => ("AUD", "hex-highlight-metadata"),
        36 => ("EOS_NUT", "hex-highlight-metadata"),
        37 => ("EOB_NUT", "hex-highlight-metadata"),
        38 => ("Filler", "hex-highlight-data"),
        39 => ("PREFIX_SEI", "hex-highlight-metadata"),
        40 => ("SUFFIX_SEI", "hex-highlight-metadata"),
        _ => {
            if nal_type >= 10 && nal_type <= 15 {
                ("Reserved (VCL)", "hex-highlight-data")
            } else if nal_type >= 22 && nal_type <= 31 {
                ("Reserved (IRAP)", "hex-highlight-data")
            } else if nal_type >= 41 && nal_type <= 47 {
                ("Reserved (Non-VCL)", "hex-highlight-data")
            } else if nal_type >= 48 && nal_type <= 63 {
                ("Unspecified", "hex-highlight-data")
            } else {
                ("Unknown", "hex-highlight-data")
            }
        }
    };

    (
        nal_type,
        type_name,
        css_class,
        layer_id,
        temporal_id,
        header_byte,
    )
}

// ==================== SEI 解析 ====================

/// 检测 sample 数据中是否包含 SEI NALU
pub fn contains_sei_nalu(data: &[u8], is_hevc: bool) -> bool {
    let nalus = parse_nalus(data, is_hevc);
    for nalu in &nalus {
        if is_hevc {
            // HEVC: PREFIX_SEI = 39, SUFFIX_SEI = 40
            if nalu.nal_type == 39 || nalu.nal_type == 40 {
                return true;
            }
        } else {
            // AVC: SEI = 6
            if nalu.nal_type == 6 {
                return true;
            }
        }
    }
    false
}

/// 从 NALU 列表中提取 SPS 和 PPS 数据
pub fn extract_sps_pps_from_nalus(
    nalus: &[Vec<u8>],
    is_hevc: bool,
) -> (Option<Vec<u8>>, Option<Vec<u8>>) {
    let mut sps_data: Option<Vec<u8>> = None;
    let mut pps_data: Option<Vec<u8>> = None;

    for nalu in nalus {
        if nalu.is_empty() {
            continue;
        }

        let nalu_type = if is_hevc {
            // HEVC: NAL type 在第一个字节的低 6 位的高 6 位（实际上是 (byte >> 1) & 0x3F）
            (nalu[0] >> 1) & 0x3F
        } else {
            // AVC: NAL type 在第一个字节的低 5 位
            nalu[0] & 0x1F
        };

        if is_hevc {
            // HEVC: SPS = 33, PPS = 34
            if nalu_type == 33 && sps_data.is_none() {
                sps_data = Some(nalu.clone());
            } else if nalu_type == 34 && pps_data.is_none() {
                pps_data = Some(nalu.clone());
            }
        } else {
            // AVC: SPS = 7, PPS = 8
            if nalu_type == 7 && sps_data.is_none() {
                sps_data = Some(nalu.clone());
            } else if nalu_type == 8 && pps_data.is_none() {
                pps_data = Some(nalu.clone());
            }
        }
    }

    (sps_data, pps_data)
}

/// 从原始数据中提取 SPS 和 PPS（用于 AVCC/HVCC 格式）
pub fn extract_sps_pps_from_data(data: &[u8], is_hevc: bool) -> (Option<Vec<u8>>, Option<Vec<u8>>) {
    let nalus = parse_nalus(data, is_hevc);
    let nalu_vecs: Vec<Vec<u8>> = nalus
        .iter()
        .map(|n| {
            if n.end <= data.len() && n.start + 4 < n.end {
                data[n.start + 4..n.end].to_vec()
            } else {
                Vec::new()
            }
        })
        .collect();
    extract_sps_pps_from_nalus(&nalu_vecs, is_hevc)
}

/// 从 AVCDecoderConfigurationRecord (AVCC) 或 HEVCDecoderConfigurationRecord 中提取 SPS/PPS
pub fn extract_sps_pps_from_avcc(data: &[u8]) -> (Option<Vec<u8>>, Option<Vec<u8>>) {
    // AVC: 最小需要 7 个字节
    // 格式: configurationVersion(1) + AVCProfileIndication(1) + profile_compatibility(1)
    //       + AVCLevelIndication(1) + reserved+lengthSizeMinusOne(1)
    //       + reserved+numOfSequenceParameterSets(1) + ...
    if data.len() < 7 {
        return (None, None);
    }

    let mut sps_data: Option<Vec<u8>> = None;
    let mut pps_data: Option<Vec<u8>> = None;

    // 跳过前 5 个字节 (config version, profile, compat, level, length_size)
    let num_sps = data[5] & 0x1F;
    let mut offset = 6usize;

    // 解析 SPS
    for _ in 0..num_sps {
        if offset + 2 > data.len() {
            break;
        }
        let sps_len = u16::from_be_bytes([data[offset], data[offset + 1]]) as usize;
        offset += 2;

        if offset + sps_len > data.len() {
            break;
        }
        if sps_data.is_none() {
            sps_data = Some(data[offset..offset + sps_len].to_vec());
        }
        offset += sps_len;
    }

    // 解析 PPS
    if offset < data.len() {
        let num_pps = data[offset];
        offset += 1;

        for _ in 0..num_pps {
            if offset + 2 > data.len() {
                break;
            }
            let pps_len = u16::from_be_bytes([data[offset], data[offset + 1]]) as usize;
            offset += 2;

            if offset + pps_len > data.len() {
                break;
            }
            if pps_data.is_none() {
                pps_data = Some(data[offset..offset + pps_len].to_vec());
            }
            offset += pps_len;
        }
    }

    (sps_data, pps_data)
}

/// SEI 消息类型
fn get_sei_payload_type_name(payload_type: u32) -> &'static str {
    match payload_type {
        0 => "buffering_period",
        1 => "pic_timing",
        4 => "user_data_registered_itu_t_t35",
        5 => "user_data_unregistered",
        6 => "recovery_point",
        7 => "dec_ref_pic_marking_repetition",
        10 => "spare_pic",
        11 => "scene_info",
        12 => "sub_seq_info",
        13 => "sub_seq_layer_characteristics",
        14 => "sub_seq_characteristics",
        15 => "full_frame_freeze",
        16 => "full_frame_freeze_release",
        17 => "full_frame_snapshot",
        18 => "progressive_refinement_segment_start",
        19 => "progressive_refinement_segment_end",
        20 => "motion_constrained_slice_group_set",
        21 => "film_grain_characteristics",
        22 => "deblocking_filter_display_preference",
        23 => "stereo_video_info",
        24 => "post_filter_hint",
        25 => "tone_mapping_info",
        45 => "frame_packing_arrangement",
        47 => "display_orientation",
        129 => "afd_metadata",
        130 => "picture_property",
        137 => "mastering_display_colour_volume",
        144 => "content_light_level_info",
        147 => "alternative_transfer_characteristics",
        190 => "frame_field_info",
        _ => "unknown",
    }
}

/// 解析 SEI payload 并返回字段列表
pub fn parse_sei_payload(nalu_data: &[u8], is_hevc: bool) -> Vec<TagField> {
    let mut fields = Vec::new();

    // 跳过 NAL header
    let header_size = if is_hevc { 2 } else { 1 };
    if nalu_data.len() <= header_size {
        return fields;
    }

    let payload = &nalu_data[header_size..];
    let mut pos = 0;
    let mut sei_message_index = 0;

    while pos < payload.len() {
        // 读取 payload_type (可能多字节)
        let mut payload_type: u32 = 0;
        while pos < payload.len() && payload[pos] == 0xFF {
            payload_type += 255;
            pos += 1;
        }
        if pos >= payload.len() {
            break;
        }
        payload_type += payload[pos] as u32;
        pos += 1;

        // 读取 payload_size (可能多字节)
        let mut payload_size: u32 = 0;
        while pos < payload.len() && payload[pos] == 0xFF {
            payload_size += 255;
            pos += 1;
        }
        if pos >= payload.len() {
            break;
        }
        payload_size += payload[pos] as u32;
        pos += 1;

        let type_name = get_sei_payload_type_name(payload_type);

        // 创建 SEI message 字段
        let mut sei_children = vec![
            TagField::new(
                "payload_type",
                format!("{} ({})", payload_type, type_name),
                0,
                0,
            ),
            TagField::new("payload_size", format!("{} bytes", payload_size), 0, 0),
        ];

        // 解析特定类型的 payload
        let payload_end = (pos + payload_size as usize).min(payload.len());
        if payload_end > pos {
            let sei_payload = &payload[pos..payload_end];

            match payload_type {
                5 => {
                    // user_data_unregistered: 16 bytes UUID + data
                    if sei_payload.len() >= 16 {
                        let uuid = format!("{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
                            sei_payload[0], sei_payload[1], sei_payload[2], sei_payload[3],
                            sei_payload[4], sei_payload[5], sei_payload[6], sei_payload[7],
                            sei_payload[8], sei_payload[9], sei_payload[10], sei_payload[11],
                            sei_payload[12], sei_payload[13], sei_payload[14], sei_payload[15]);
                        sei_children.push(TagField::new("uuid", uuid, 0, 0));

                        if sei_payload.len() > 16 {
                            let user_data = &sei_payload[16..];
                            // 尝试解析为 UTF-8 字符串
                            if let Ok(text) = std::str::from_utf8(user_data) {
                                let clean_text: String = text
                                    .chars()
                                    .filter(|c| !c.is_control() || *c == '\n')
                                    .take(200)
                                    .collect();
                                if !clean_text.is_empty() {
                                    sei_children.push(TagField::new(
                                        "user_data",
                                        format!("\"{}\"", clean_text),
                                        0,
                                        0,
                                    ));
                                }
                            } else {
                                sei_children.push(TagField::new(
                                    "user_data",
                                    format!("{} bytes (binary)", user_data.len()),
                                    0,
                                    0,
                                ));
                            }
                        }
                    }
                }
                137 => {
                    // mastering_display_colour_volume (HDR metadata)
                    if sei_payload.len() >= 24 {
                        sei_children.push(TagField::new("info", "HDR 主显示器色彩信息", 0, 0));
                    }
                }
                144 => {
                    // content_light_level_info (HDR)
                    if sei_payload.len() >= 4 {
                        let max_cll = u16::from_be_bytes([sei_payload[0], sei_payload[1]]);
                        let max_fall = u16::from_be_bytes([sei_payload[2], sei_payload[3]]);
                        sei_children.push(TagField::new(
                            "max_content_light_level",
                            format!("{} cd/m²", max_cll),
                            0,
                            0,
                        ));
                        sei_children.push(TagField::new(
                            "max_frame_avg_light_level",
                            format!("{} cd/m²", max_fall),
                            0,
                            0,
                        ));
                    }
                }
                1 => {
                    // pic_timing
                    sei_children.push(TagField::new("info", "图像时序信息", 0, 0));
                }
                0 => {
                    // buffering_period
                    sei_children.push(TagField::new("info", "缓冲周期信息", 0, 0));
                }
                6 => {
                    // recovery_point
                    sei_children.push(TagField::new("info", "恢复点信息", 0, 0));
                }
                _ => {
                    // 通用处理: 显示前几个字节的 hex
                    if payload_size > 0 {
                        let preview_len = (payload_size as usize).min(16);
                        let hex_preview: String = sei_payload[..preview_len]
                            .iter()
                            .map(|b| format!("{:02X}", b))
                            .collect::<Vec<_>>()
                            .join(" ");
                        sei_children.push(TagField::new("data_preview", hex_preview, 0, 0));
                    }
                }
            }
        }

        fields.push(
            TagField::new(
                &format!("SEI Message #{}", sei_message_index),
                type_name,
                0,
                0,
            )
            .expanded()
            .with_children(sei_children),
        );

        pos = payload_end;
        sei_message_index += 1;

        // 检查 RBSP trailing bits
        if pos < payload.len() && payload[pos] == 0x80 {
            break;
        }
    }

    fields
}

// ==================== SPS/PPS 解析 ====================

/// 读取 Exp-Golomb 编码的无符号整数 (ue(v))
fn read_exp_golomb(data: &[u8], bit_offset: &mut usize) -> Option<u32> {
    let mut leading_zeros = 0u32;

    // 计算前导零的个数
    loop {
        let byte_idx = *bit_offset / 8;
        let bit_idx = 7 - (*bit_offset % 8);

        if byte_idx >= data.len() {
            return None;
        }

        let bit = (data[byte_idx] >> bit_idx) & 1;
        *bit_offset += 1;

        if bit == 1 {
            break;
        }
        leading_zeros += 1;

        if leading_zeros > 32 {
            return None;
        }
    }

    if leading_zeros == 0 {
        return Some(0);
    }

    // 读取后续的 leading_zeros 位
    let mut value = 1u32;
    for _ in 0..leading_zeros {
        let byte_idx = *bit_offset / 8;
        let bit_idx = 7 - (*bit_offset % 8);

        if byte_idx >= data.len() {
            return None;
        }

        let bit = (data[byte_idx] >> bit_idx) & 1;
        value = (value << 1) | (bit as u32);
        *bit_offset += 1;
    }

    Some(value - 1)
}

/// 读取指定位数
fn read_bits(data: &[u8], bit_offset: &mut usize, count: usize) -> Option<u32> {
    let mut value = 0u32;

    for _ in 0..count {
        let byte_idx = *bit_offset / 8;
        let bit_idx = 7 - (*bit_offset % 8);

        if byte_idx >= data.len() {
            return None;
        }

        let bit = (data[byte_idx] >> bit_idx) & 1;
        value = (value << 1) | (bit as u32);
        *bit_offset += 1;
    }

    Some(value)
}

/// 解析 AVC (H.264) SPS
pub fn parse_avc_sps(nalu_data: &[u8]) -> Vec<TagField> {
    let mut fields = Vec::new();

    // 跳过 NAL header (1 byte)
    if nalu_data.len() < 5 {
        return fields;
    }

    let profile_idc = nalu_data[1];
    let constraint_flags = nalu_data[2];
    let level_idc = nalu_data[3];

    // Profile 名称
    let profile_name = match profile_idc {
        66 => "Baseline",
        77 => "Main",
        88 => "Extended",
        100 => "High",
        110 => "High 10",
        122 => "High 4:2:2",
        244 => "High 4:4:4 Predictive",
        44 => "CAVLC 4:4:4 Intra",
        _ => "Unknown",
    };

    fields.push(TagField::new(
        "profile_idc",
        format!("{} ({})", profile_idc, profile_name),
        0,
        0,
    ));
    fields.push(TagField::new(
        "constraint_flags",
        format!("0x{:02X}", constraint_flags),
        0,
        0,
    ));
    fields.push(TagField::new(
        "level_idc",
        format!(
            "{} (Level {}.{})",
            level_idc,
            level_idc / 10,
            level_idc % 10
        ),
        0,
        0,
    ));

    // 解析 seq_parameter_set_id 和后续参数
    let mut bit_offset = 32; // 跳过前 4 字节

    if let Some(sps_id) = read_exp_golomb(nalu_data, &mut bit_offset) {
        fields.push(TagField::new(
            "seq_parameter_set_id",
            sps_id.to_string(),
            0,
            0,
        ));
    }

    // 对于 High Profile，需要解析额外参数
    if profile_idc == 100
        || profile_idc == 110
        || profile_idc == 122
        || profile_idc == 244
        || profile_idc == 44
        || profile_idc == 83
        || profile_idc == 86
        || profile_idc == 118
        || profile_idc == 128
    {
        if let Some(chroma_format) = read_exp_golomb(nalu_data, &mut bit_offset) {
            let chroma_name = match chroma_format {
                0 => "Monochrome",
                1 => "4:2:0",
                2 => "4:2:2",
                3 => "4:4:4",
                _ => "Unknown",
            };
            fields.push(TagField::new(
                "chroma_format_idc",
                format!("{} ({})", chroma_format, chroma_name),
                0,
                0,
            ));

            if chroma_format == 3 {
                // separate_colour_plane_flag
                bit_offset += 1;
            }
        }

        if let Some(bit_depth_luma) = read_exp_golomb(nalu_data, &mut bit_offset) {
            fields.push(TagField::new(
                "bit_depth_luma",
                format!("{}-bit", bit_depth_luma + 8),
                0,
                0,
            ));
        }

        if let Some(bit_depth_chroma) = read_exp_golomb(nalu_data, &mut bit_offset) {
            fields.push(TagField::new(
                "bit_depth_chroma",
                format!("{}-bit", bit_depth_chroma + 8),
                0,
                0,
            ));
        }

        // qpprime_y_zero_transform_bypass_flag + seq_scaling_matrix_present_flag
        bit_offset += 2;
    }

    // log2_max_frame_num_minus4
    if let Some(log2_max_frame_num) = read_exp_golomb(nalu_data, &mut bit_offset) {
        fields.push(TagField::new(
            "log2_max_frame_num",
            format!(
                "{} (max={})",
                log2_max_frame_num + 4,
                1 << (log2_max_frame_num + 4)
            ),
            0,
            0,
        ));
    }

    // pic_order_cnt_type
    if let Some(poc_type) = read_exp_golomb(nalu_data, &mut bit_offset) {
        fields.push(TagField::new(
            "pic_order_cnt_type",
            poc_type.to_string(),
            0,
            0,
        ));

        if poc_type == 0 {
            let _ = read_exp_golomb(nalu_data, &mut bit_offset); // log2_max_pic_order_cnt_lsb
        } else if poc_type == 1 {
            bit_offset += 1; // delta_pic_order_always_zero_flag
            let _ = read_exp_golomb(nalu_data, &mut bit_offset); // offset_for_non_ref_pic
            let _ = read_exp_golomb(nalu_data, &mut bit_offset); // offset_for_top_to_bottom_field
            if let Some(num_ref) = read_exp_golomb(nalu_data, &mut bit_offset) {
                for _ in 0..num_ref {
                    let _ = read_exp_golomb(nalu_data, &mut bit_offset);
                }
            }
        }
    }

    // max_num_ref_frames
    if let Some(max_ref_frames) = read_exp_golomb(nalu_data, &mut bit_offset) {
        fields.push(TagField::new(
            "max_num_ref_frames",
            max_ref_frames.to_string(),
            0,
            0,
        ));
    }

    // gaps_in_frame_num_value_allowed_flag
    bit_offset += 1;

    // pic_width_in_mbs_minus1, pic_height_in_map_units_minus1
    if let (Some(width_mbs), Some(height_mbs)) = (
        read_exp_golomb(nalu_data, &mut bit_offset),
        read_exp_golomb(nalu_data, &mut bit_offset),
    ) {
        let width = (width_mbs + 1) * 16;
        let height = (height_mbs + 1) * 16;
        fields.push(TagField::new(
            "pic_size_in_mbs",
            format!("{}x{} MBs", width_mbs + 1, height_mbs + 1),
            0,
            0,
        ));
        fields.push(TagField::new(
            "resolution (raw)",
            format!("{}x{}", width, height),
            0,
            0,
        ));
    }

    fields
}

/// 解析 AVC (H.264) PPS
pub fn parse_avc_pps(nalu_data: &[u8]) -> Vec<TagField> {
    let mut fields = Vec::new();

    if nalu_data.len() < 2 {
        return fields;
    }

    let mut bit_offset = 8; // 跳过 NAL header

    if let Some(pps_id) = read_exp_golomb(nalu_data, &mut bit_offset) {
        fields.push(TagField::new(
            "pic_parameter_set_id",
            pps_id.to_string(),
            0,
            0,
        ));
    }

    if let Some(sps_id) = read_exp_golomb(nalu_data, &mut bit_offset) {
        fields.push(TagField::new(
            "seq_parameter_set_id",
            sps_id.to_string(),
            0,
            0,
        ));
    }

    // entropy_coding_mode_flag
    if let Some(entropy_mode) = read_bits(nalu_data, &mut bit_offset, 1) {
        fields.push(TagField::new(
            "entropy_coding_mode",
            if entropy_mode == 0 { "CAVLC" } else { "CABAC" },
            0,
            0,
        ));
    }

    // bottom_field_pic_order_in_frame_present_flag
    bit_offset += 1;

    // num_slice_groups_minus1
    if let Some(num_slice_groups) = read_exp_golomb(nalu_data, &mut bit_offset) {
        fields.push(TagField::new(
            "num_slice_groups",
            (num_slice_groups + 1).to_string(),
            0,
            0,
        ));
    }

    // num_ref_idx_l0/l1_default_active_minus1
    if let Some(ref_l0) = read_exp_golomb(nalu_data, &mut bit_offset) {
        fields.push(TagField::new(
            "num_ref_idx_l0_default",
            (ref_l0 + 1).to_string(),
            0,
            0,
        ));
    }
    if let Some(ref_l1) = read_exp_golomb(nalu_data, &mut bit_offset) {
        fields.push(TagField::new(
            "num_ref_idx_l1_default",
            (ref_l1 + 1).to_string(),
            0,
            0,
        ));
    }

    // weighted_pred_flag
    if let Some(weighted_pred) = read_bits(nalu_data, &mut bit_offset, 1) {
        fields.push(TagField::new(
            "weighted_pred_flag",
            weighted_pred.to_string(),
            0,
            0,
        ));
    }

    // weighted_bipred_idc
    if let Some(weighted_bipred) = read_bits(nalu_data, &mut bit_offset, 2) {
        fields.push(TagField::new(
            "weighted_bipred_idc",
            weighted_bipred.to_string(),
            0,
            0,
        ));
    }

    // pic_init_qp_minus26
    if let Some(init_qp) = read_exp_golomb(nalu_data, &mut bit_offset) {
        fields.push(TagField::new(
            "pic_init_qp",
            format!("{}", init_qp as i32 - 26 + 26),
            0,
            0,
        ));
    }

    fields
}

/// 解析 HEVC (H.265) SPS 基本信息
pub fn parse_hevc_sps(nalu_data: &[u8]) -> Vec<TagField> {
    let mut fields = Vec::new();

    // 跳过 NAL header (2 bytes)
    if nalu_data.len() < 6 {
        return fields;
    }

    let mut bit_offset = 16; // 跳过 NAL header

    // sps_video_parameter_set_id (4 bits)
    if let Some(vps_id) = read_bits(nalu_data, &mut bit_offset, 4) {
        fields.push(TagField::new(
            "sps_video_parameter_set_id",
            vps_id.to_string(),
            0,
            0,
        ));
    }

    // sps_max_sub_layers_minus1 (3 bits)
    let max_sub_layers = read_bits(nalu_data, &mut bit_offset, 3).unwrap_or(0) as usize;
    fields.push(TagField::new(
        "sps_max_sub_layers",
        (max_sub_layers + 1).to_string(),
        0,
        0,
    ));

    // sps_temporal_id_nesting_flag (1 bit)
    bit_offset += 1;

    // profile_tier_level
    // general_profile_space (2 bits)
    let _profile_space = read_bits(nalu_data, &mut bit_offset, 2).unwrap_or(0);
    // general_tier_flag (1 bit)
    let tier_flag = read_bits(nalu_data, &mut bit_offset, 1).unwrap_or(0);
    // general_profile_idc (5 bits)
    let profile_idc = read_bits(nalu_data, &mut bit_offset, 5).unwrap_or(0);

    let profile_name = match profile_idc {
        1 => "Main",
        2 => "Main 10",
        3 => "Main Still Picture",
        4 => "Range Extensions",
        5 => "High Throughput",
        9 => "Screen Content Coding",
        _ => "Unknown",
    };

    fields.push(TagField::new(
        "general_profile_idc",
        format!("{} ({})", profile_idc, profile_name),
        0,
        0,
    ));
    fields.push(TagField::new(
        "general_tier_flag",
        if tier_flag == 0 { "Main" } else { "High" },
        0,
        0,
    ));

    // general_profile_compatibility_flags (32 bits)
    bit_offset += 32;

    // general_progressive_source_flag, etc (48 bits total)
    bit_offset += 48;

    // general_level_idc (8 bits)
    if let Some(level_idc) = read_bits(nalu_data, &mut bit_offset, 8) {
        fields.push(TagField::new(
            "general_level_idc",
            format!("{} (Level {:.1})", level_idc, level_idc as f32 / 30.0),
            0,
            0,
        ));
    }

    // sub_layer_profile_present_flag[i], sub_layer_level_present_flag[i]
    for _ in 0..max_sub_layers {
        bit_offset += 2;
    }

    // Padding if max_sub_layers < 8
    if max_sub_layers < 8 {
        bit_offset += 2 * (8 - max_sub_layers - 1);
    }

    // sps_seq_parameter_set_id
    if let Some(sps_id) = read_exp_golomb(nalu_data, &mut bit_offset) {
        fields.push(TagField::new(
            "sps_seq_parameter_set_id",
            sps_id.to_string(),
            0,
            0,
        ));
    }

    // chroma_format_idc
    if let Some(chroma_format) = read_exp_golomb(nalu_data, &mut bit_offset) {
        let chroma_name = match chroma_format {
            0 => "Monochrome",
            1 => "4:2:0",
            2 => "4:2:2",
            3 => "4:4:4",
            _ => "Unknown",
        };
        fields.push(TagField::new(
            "chroma_format_idc",
            format!("{} ({})", chroma_format, chroma_name),
            0,
            0,
        ));

        if chroma_format == 3 {
            bit_offset += 1; // separate_colour_plane_flag
        }
    }

    // pic_width_in_luma_samples, pic_height_in_luma_samples
    if let (Some(width), Some(height)) = (
        read_exp_golomb(nalu_data, &mut bit_offset),
        read_exp_golomb(nalu_data, &mut bit_offset),
    ) {
        fields.push(TagField::new(
            "resolution",
            format!("{}x{}", width, height),
            0,
            0,
        ));
    }

    // conformance_window_flag
    if let Some(conf_win) = read_bits(nalu_data, &mut bit_offset, 1) {
        if conf_win == 1 {
            // 跳过 conformance window 参数
            let _ = read_exp_golomb(nalu_data, &mut bit_offset);
            let _ = read_exp_golomb(nalu_data, &mut bit_offset);
            let _ = read_exp_golomb(nalu_data, &mut bit_offset);
            let _ = read_exp_golomb(nalu_data, &mut bit_offset);
        }
    }

    // bit_depth_luma_minus8, bit_depth_chroma_minus8
    if let Some(bit_depth_luma) = read_exp_golomb(nalu_data, &mut bit_offset) {
        fields.push(TagField::new(
            "bit_depth_luma",
            format!("{}-bit", bit_depth_luma + 8),
            0,
            0,
        ));
    }
    if let Some(bit_depth_chroma) = read_exp_golomb(nalu_data, &mut bit_offset) {
        fields.push(TagField::new(
            "bit_depth_chroma",
            format!("{}-bit", bit_depth_chroma + 8),
            0,
            0,
        ));
    }

    fields
}

/// 解析 HEVC (H.265) PPS 基本信息
pub fn parse_hevc_pps(nalu_data: &[u8]) -> Vec<TagField> {
    let mut fields = Vec::new();

    if nalu_data.len() < 4 {
        return fields;
    }

    let mut bit_offset = 16; // 跳过 NAL header

    if let Some(pps_id) = read_exp_golomb(nalu_data, &mut bit_offset) {
        fields.push(TagField::new(
            "pps_pic_parameter_set_id",
            pps_id.to_string(),
            0,
            0,
        ));
    }

    if let Some(sps_id) = read_exp_golomb(nalu_data, &mut bit_offset) {
        fields.push(TagField::new(
            "pps_seq_parameter_set_id",
            sps_id.to_string(),
            0,
            0,
        ));
    }

    // dependent_slice_segments_enabled_flag
    if let Some(dep_slice) = read_bits(nalu_data, &mut bit_offset, 1) {
        fields.push(TagField::new(
            "dependent_slice_segments",
            if dep_slice == 1 {
                "enabled"
            } else {
                "disabled"
            },
            0,
            0,
        ));
    }

    // output_flag_present_flag
    if let Some(output_flag) = read_bits(nalu_data, &mut bit_offset, 1) {
        fields.push(TagField::new(
            "output_flag_present",
            if output_flag == 1 { "yes" } else { "no" },
            0,
            0,
        ));
    }

    // num_extra_slice_header_bits (3 bits)
    if let Some(extra_bits) = read_bits(nalu_data, &mut bit_offset, 3) {
        fields.push(TagField::new(
            "num_extra_slice_header_bits",
            extra_bits.to_string(),
            0,
            0,
        ));
    }

    // sign_data_hiding_enabled_flag, cabac_init_present_flag
    bit_offset += 2;

    // num_ref_idx_l0/l1_default_active_minus1
    if let Some(ref_l0) = read_exp_golomb(nalu_data, &mut bit_offset) {
        fields.push(TagField::new(
            "num_ref_idx_l0_default",
            (ref_l0 + 1).to_string(),
            0,
            0,
        ));
    }
    if let Some(ref_l1) = read_exp_golomb(nalu_data, &mut bit_offset) {
        fields.push(TagField::new(
            "num_ref_idx_l1_default",
            (ref_l1 + 1).to_string(),
            0,
            0,
        ));
    }

    // init_qp_minus26
    if let Some(init_qp) = read_exp_golomb(nalu_data, &mut bit_offset) {
        fields.push(TagField::new(
            "init_qp",
            format!("{}", init_qp as i32 - 26 + 26),
            0,
            0,
        ));
    }

    fields
}
