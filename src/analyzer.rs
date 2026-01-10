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
        };

        let mut last_video_ts = 0u32;
        let mut last_audio_ts = 0u32;
        let mut current_gop: i32 = -1;
        let mut gop_start_idx = 0usize;
        let mut gop_start_time = 0.0f64;

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
                is_keyframe: false,
                is_seq_header: false,
                frame_type: None,
                codec_id: None,
                gop_index: None,
            };

            match tag.tag_type {
                TAG_TYPE_VIDEO => {
                    result.video_tag_count += 1;

                    if let Some(video_info) = tag.parse_video() {
                        summary.is_keyframe = video_info.is_keyframe;
                        summary.is_seq_header = video_info.is_seq_header;
                        summary.frame_type = Some(video_info.frame_type);
                        summary.codec_id = Some(video_info.codec_id);

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
pub fn parse_tag_fields(tag: &TagSummary, _data: &[u8]) -> Vec<TagField> {
    let mut fields = Vec::new();

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
        let frame_type = tag.frame_type.unwrap_or(if tag.is_keyframe { 1 } else { 2 });
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
        TagField::new("tag data()", format!("{} (bytes)", tag.size), 11, 11 + tag.size)
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
    fn collect_classes(
        fields: &[TagField],
        classes: &mut std::collections::HashMap<u32, String>,
    ) {
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
