
//! 视频分段模块
//!
//! 检测视频中的编码参数变化，并提供分割功能

use crate::flv::{TAG_TYPE_AUDIO, TAG_TYPE_SCRIPT, TAG_TYPE_VIDEO};
use crate::types::*;
use js_sys::Uint8Array;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

/// 从分析结果中计算分段信息
///
/// FLV: 根据 is_sps_pps_change 标记分段
/// MP4: 根据 sample_description_index 变化分段
pub fn compute_segments(result: &AnalysisResult) -> Option<SegmentInfo> {
    match result.format.as_str() {
        "FLV" => compute_flv_segments(result),
        "MP4" => compute_mp4_segments(result),
        _ => None,
    }
}

/// 计算 FLV 文件的分段信息
fn compute_flv_segments(result: &AnalysisResult) -> Option<SegmentInfo> {
    let mut change_points: Vec<usize> = Vec::new();

    for tag in &result.tags {
        if tag.is_sps_pps_change {
            change_points.push(tag.index);
        }
    }

    if change_points.is_empty() {
        return None;
    }

    let mut segments = Vec::new();
    let mut warnings = Vec::new();

    let first_video_idx = result
        .tags
        .iter()
        .position(|t| t.tag_type == "video" && !t.is_seq_header)
        .unwrap_or(0);

    let mut segment_start = first_video_idx;

    for (seg_idx, &change_idx) in change_points.iter().enumerate() {
        let segment_end = change_idx.saturating_sub(1);

        if segment_end >= segment_start {
            let segment = create_segment_from_tags(
                result,
                seg_idx,
                segment_start,
                segment_end,
                if seg_idx == 0 {
                    "初始编码参数".to_string()
                } else {
                    "SPS/PPS 变化".to_string()
                },
            );

            if !segment.starts_with_keyframe && seg_idx > 0 {
                warnings.push(format!(
                    "分段 {} 不是以关键帧开始，可能无法正常播放",
                    seg_idx + 1
                ));
            }

            segments.push(segment);
        }

        segment_start = change_idx;
    }

    let last_video_idx = result
        .tags
        .iter()
        .rposition(|t| t.tag_type == "video" && !t.is_seq_header)
        .unwrap_or(result.tags.len().saturating_sub(1));

    if segment_start <= last_video_idx {
        let segment = create_segment_from_tags(
            result,
            segments.len(),
            segment_start,
            last_video_idx,
            "SPS/PPS 变化".to_string(),
        );

        if !segment.starts_with_keyframe && !segments.is_empty() {
            warnings.push(format!(
                "分段 {} 不是以关键帧开始，可能无法正常播放",
                segments.len() + 1
            ));
        }

        segments.push(segment);
    }

    let total_segments = segments.len();
    let needs_split = total_segments > 1;

    Some(SegmentInfo {
        total_segments,
        needs_split,
        segments,
        warnings,
    })
}

/// 计算 MP4 文件的分段信息
fn compute_mp4_segments(result: &AnalysisResult) -> Option<SegmentInfo> {
    let mut change_points: Vec<usize> = Vec::new();
    let mut last_desc: Option<u32> = None;

    for tag in &result.tags {
        if tag.tag_type != "video" {
            continue;
        }

        let desc_idx = tag
            .mp4_info
            .as_ref()
            .and_then(|info| info.sample_desc_index)
            .unwrap_or(1);

        if let Some(last) = last_desc {
            if desc_idx != last {
                change_points.push(tag.index);
            }
        }
        last_desc = Some(desc_idx);
    }

    if change_points.is_empty() {
        return None;
    }

    let mut segments = Vec::new();
    let mut warnings = Vec::new();

    let first_video_idx = result
        .tags
        .iter()
        .position(|t| t.tag_type == "video")
        .unwrap_or(0);

    let mut segment_start = first_video_idx;

    for (seg_idx, &change_idx) in change_points.iter().enumerate() {
        let segment_end = change_idx.saturating_sub(1);

        if segment_end >= segment_start {
            let segment = create_segment_from_tags(
                result,
                seg_idx,
                segment_start,
                segment_end,
                if seg_idx == 0 {
                    "初始 sample 描述".to_string()
                } else {
                    "sample 描述变化".to_string()
                },
            );

            if !segment.starts_with_keyframe && seg_idx > 0 {
                warnings.push(format!(
                    "分段 {} 不是以关键帧开始，可能无法正常播放",
                    seg_idx + 1
                ));
            }

            segments.push(segment);
        }

        segment_start = change_idx;
    }

    let last_video_idx = result
        .tags
        .iter()
        .rposition(|t| t.tag_type == "video")
        .unwrap_or(result.tags.len().saturating_sub(1));

    if segment_start <= last_video_idx {
        let segment = create_segment_from_tags(
            result,
            segments.len(),
            segment_start,
            last_video_idx,
            "sample 描述变化".to_string(),
        );

        if !segment.starts_with_keyframe && !segments.is_empty() {
            warnings.push(format!(
                "分段 {} 不是以关键帧开始，可能无法正常播放",
                segments.len() + 1
            ));
        }

        segments.push(segment);
    }

    let total_segments = segments.len();
    let needs_split = total_segments > 1;

    Some(SegmentInfo {
        total_segments,
        needs_split,
        segments,
        warnings,
    })
}

/// 从 tag 范围构建分段
fn create_segment_from_tags(
    result: &AnalysisResult,
    index: usize,
    start_idx: usize,
    end_idx: usize,
    reason: String,
) -> VideoSegment {
    let start_tag = result.tags.get(start_idx);
    let end_tag = result.tags.get(end_idx);

    let start_time = start_tag
        .map(|t| t.timestamp as f64 / 1000.0)
        .unwrap_or(0.0);
    let end_time = end_tag.map(|t| t.timestamp as f64 / 1000.0).unwrap_or(0.0);

    let frame_count = result.tags[start_idx..=end_idx.min(result.tags.len().saturating_sub(1))]
        .iter()
        .filter(|t| t.tag_type == "video" && !t.is_seq_header)
        .count();

    let starts_with_keyframe = start_tag.map(|t| t.is_keyframe).unwrap_or(false);

    VideoSegment {
        index,
        start_tag_index: start_idx,
        end_tag_index: end_idx,
        start_time,
        end_time,
        duration: end_time - start_time,
        frame_count,
        starts_with_keyframe,
        reason,
    }
}
/// FLV 分割 - 导出指定分段
#[wasm_bindgen]
pub fn split_flv_segment(
    file_data: &[u8],
    result_json: &str,
    segment_index: usize,
) -> Result<Uint8Array, JsError> {
    let result: AnalysisResult = serde_json::from_str(result_json)
        .map_err(|e| JsError::new(&format!("解析结果失败: {}", e)))?;

    let segments = result
        .segments
        .as_ref()
        .ok_or_else(|| JsError::new("文件没有分段信息"))?;

    let segment = segments
        .segments
        .get(segment_index)
        .ok_or_else(|| JsError::new(&format!("分段索引 {} 超出范围", segment_index)))?;

    let mut output = Vec::new();

    output.extend_from_slice(b"FLV");
    output.push(0x01);
    output.push(0x05);
    output.extend_from_slice(&9u32.to_be_bytes());
    output.extend_from_slice(&0u32.to_be_bytes());

    let seq_header_idx = find_sequence_header_for_segment(&result, segment_index);
    let time_offset = segment.start_time * 1000.0;

    if let Some(sh_idx) = seq_header_idx {
        if sh_idx < segment.start_tag_index {
            if let Some(sh_tag) = result.tags.get(sh_idx) {
                write_flv_tag(&mut output, file_data, sh_tag, 0)?;
            }
        }
    }

    if let Some(audio_seq) = result
        .tags
        .iter()
        .find(|t| t.tag_type == "audio" && t.is_seq_header)
    {
        if audio_seq.index < segment.start_tag_index {
            write_flv_tag(&mut output, file_data, audio_seq, 0)?;
        }
    }

    for tag in &result.tags {
        if tag.index < segment.start_tag_index || tag.index > segment.end_tag_index {
            continue;
        }
        let adjusted_ts = (tag.timestamp as f64 - time_offset).max(0.0).round() as u32;
        write_flv_tag(&mut output, file_data, tag, adjusted_ts)?;
    }

    Ok(Uint8Array::from(output.as_slice()))
}

fn find_sequence_header_for_segment(result: &AnalysisResult, segment_index: usize) -> Option<usize> {
    let segments = result.segments.as_ref()?;
    let segment = segments.segments.get(segment_index)?;

    if segment_index == 0 {
        return result
            .tags
            .iter()
            .position(|t| t.tag_type == "video" && t.is_seq_header);
    }

    let start_idx = segment.start_tag_index.min(result.tags.len().saturating_sub(1));
    result.tags[..=start_idx]
        .iter()
        .rposition(|t| t.tag_type == "video" && t.is_seq_header)
}

fn write_flv_tag(
    output: &mut Vec<u8>,
    file_data: &[u8],
    tag: &TagSummary,
    timestamp: u32,
) -> Result<(), JsError> {
    let tag_type = match tag.tag_type.as_str() {
        "audio" => TAG_TYPE_AUDIO,
        "video" => TAG_TYPE_VIDEO,
        "script" => TAG_TYPE_SCRIPT,
        _ => TAG_TYPE_SCRIPT,
    };

    let data_size = tag.size;

    output.push(tag_type);
    output.push(((data_size >> 16) & 0xFF) as u8);
    output.push(((data_size >> 8) & 0xFF) as u8);
    output.push((data_size & 0xFF) as u8);

    output.push(((timestamp >> 16) & 0xFF) as u8);
    output.push(((timestamp >> 8) & 0xFF) as u8);
    output.push((timestamp & 0xFF) as u8);
    output.push(((timestamp >> 24) & 0xFF) as u8);

    output.extend_from_slice(&[0, 0, 0]);

    let data_start = tag.offset as usize + 11;
    let data_end = data_start + data_size as usize;

    if data_end > file_data.len() {
        return Err(JsError::new("Tag 数据超出文件范围"));
    }

    output.extend_from_slice(&file_data[data_start..data_end]);

    let prev_tag_size = 11 + data_size;
    output.extend_from_slice(&prev_tag_size.to_be_bytes());

    Ok(())
}
#[derive(Debug, Clone)]
struct Mp4BoxInfo {
    box_type: [u8; 4],
    offset: usize,
    size: usize,
    header_size: usize,
}

#[derive(Debug, Clone)]
struct Mp4TrackInfo {
    track_id: u32,
    handler_type: [u8; 4],
    width: u32,
    height: u32,
    stsd_entries: Vec<Vec<u8>>,
}

#[derive(Debug, Clone)]
struct Mp4SegmentSample {
    data: Vec<u8>,
    duration: u32,
    cts_offset: i32,
    is_sync: bool,
}

#[derive(Debug, Clone)]
struct Mp4SegmentTrack {
    track_id: u32,
    handler_type: [u8; 4],
    width: u32,
    height: u32,
    stsd_entry: Vec<u8>,
    samples: Vec<Mp4SegmentSample>,
    offsets: Vec<u64>,
}

fn read_mp4_box_header(data: &[u8], offset: usize) -> Option<Mp4BoxInfo> {
    if offset + 8 > data.len() {
        return None;
    }

    let size = u32::from_be_bytes([data[offset], data[offset + 1], data[offset + 2], data[offset + 3]]) as u64;
    let box_type = [data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]];
    let mut header_size = 8usize;
    let mut box_size = size;

    if size == 1 {
        if offset + 16 > data.len() {
            return None;
        }
        box_size = u64::from_be_bytes([
            data[offset + 8],
            data[offset + 9],
            data[offset + 10],
            data[offset + 11],
            data[offset + 12],
            data[offset + 13],
            data[offset + 14],
            data[offset + 15],
        ]);
        header_size = 16;
    } else if size == 0 {
        box_size = (data.len().saturating_sub(offset)) as u64;
    }

    if box_size < header_size as u64 {
        return None;
    }

    let end = offset.saturating_add(box_size as usize);
    if end > data.len() {
        return None;
    }

    Some(Mp4BoxInfo {
        box_type,
        offset,
        size: box_size as usize,
        header_size,
    })
}

fn iter_mp4_boxes(data: &[u8], start: usize, end: usize) -> Vec<Mp4BoxInfo> {
    let mut boxes = Vec::new();
    let mut pos = start;

    while pos + 8 <= end {
        if let Some(info) = read_mp4_box_header(data, pos) {
            let next = info.offset + info.size;
            boxes.push(info);
            if next <= pos {
                break;
            }
            pos = next;
        } else {
            break;
        }
    }

    boxes
}

fn parse_tkhd_track_info(data: &[u8]) -> Option<(u32, u32, u32)> {
    if data.len() < 20 {
        return None;
    }
    let version = data[0];
    let mut pos = 4usize;

    let (track_id, width, height) = if version == 1 {
        if data.len() < pos + 8 * 2 + 4 + 4 + 8 {
            return None;
        }
        pos += 8;
        pos += 8;
        let track_id = u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]);
        pos += 4;
        pos += 4;
        pos += 8;
        pos += 8;
        pos += 2;
        pos += 2;
        pos += 2;
        pos += 2;
        pos += 36;
        if data.len() < pos + 8 {
            return None;
        }
        let width_fixed = u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]);
        let height_fixed = u32::from_be_bytes([data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]]);
        let width = width_fixed >> 16;
        let height = height_fixed >> 16;
        (track_id, width, height)
    } else {
        if data.len() < pos + 4 * 5 {
            return None;
        }
        pos += 4;
        pos += 4;
        let track_id = u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]);
        pos += 4;
        pos += 4;
        pos += 4;
        pos += 8;
        pos += 2;
        pos += 2;
        pos += 2;
        pos += 2;
        pos += 36;
        if data.len() < pos + 8 {
            return None;
        }
        let width_fixed = u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]);
        let height_fixed = u32::from_be_bytes([data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]]);
        let width = width_fixed >> 16;
        let height = height_fixed >> 16;
        (track_id, width, height)
    };

    Some((track_id, width, height))
}

fn parse_hdlr_type(data: &[u8]) -> Option<[u8; 4]> {
    if data.len() < 12 {
        return None;
    }
    Some([data[8], data[9], data[10], data[11]])
}

fn parse_stsd_entries(data: &[u8]) -> Vec<Vec<u8>> {
    if data.len() < 8 {
        return Vec::new();
    }
    let entry_count = u32::from_be_bytes([data[4], data[5], data[6], data[7]]) as usize;
    let mut entries = Vec::new();
    let mut pos = 8usize;

    for _ in 0..entry_count {
        if pos + 8 > data.len() {
            break;
        }
        let size = u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as usize;
        if size < 8 || pos + size > data.len() {
            break;
        }
        entries.push(data[pos..pos + size].to_vec());
        pos += size;
    }

    entries
}

fn extract_mp4_track_infos(file_data: &[u8]) -> Result<Vec<Mp4TrackInfo>, JsError> {
    let top_boxes = iter_mp4_boxes(file_data, 0, file_data.len());
    let moov = top_boxes
        .into_iter()
        .find(|b| &b.box_type == b"moov")
        .ok_or_else(|| JsError::new("未找到 moov box"))?;

    let moov_start = moov.offset + moov.header_size;
    let moov_end = moov.offset + moov.size;
    let mut tracks = Vec::new();

    for trak in iter_mp4_boxes(file_data, moov_start, moov_end)
        .into_iter()
        .filter(|b| &b.box_type == b"trak")
    {
        let trak_start = trak.offset + trak.header_size;
        let trak_end = trak.offset + trak.size;
        let mut track_id: Option<u32> = None;
        let mut width: u32 = 0;
        let mut height: u32 = 0;
        let mut handler_type: Option<[u8; 4]> = None;
        let mut stsd_entries: Vec<Vec<u8>> = Vec::new();

        for child in iter_mp4_boxes(file_data, trak_start, trak_end) {
            if &child.box_type == b"tkhd" {
                let payload_start = child.offset + child.header_size;
                let payload_end = child.offset + child.size;
                if payload_end <= file_data.len() {
                    if let Some((tid, w, h)) = parse_tkhd_track_info(&file_data[payload_start..payload_end]) {
                        track_id = Some(tid);
                        width = w;
                        height = h;
                    }
                }
            } else if &child.box_type == b"mdia" {
                let mdia_start = child.offset + child.header_size;
                let mdia_end = child.offset + child.size;
                for mdia_child in iter_mp4_boxes(file_data, mdia_start, mdia_end) {
                    if &mdia_child.box_type == b"hdlr" {
                        let payload_start = mdia_child.offset + mdia_child.header_size;
                        let payload_end = mdia_child.offset + mdia_child.size;
                        if payload_end <= file_data.len() {
                            handler_type = parse_hdlr_type(&file_data[payload_start..payload_end]);
                        }
                    } else if &mdia_child.box_type == b"minf" {
                        let minf_start = mdia_child.offset + mdia_child.header_size;
                        let minf_end = mdia_child.offset + mdia_child.size;
                        for minf_child in iter_mp4_boxes(file_data, minf_start, minf_end) {
                            if &minf_child.box_type == b"stbl" {
                                let stbl_start = minf_child.offset + minf_child.header_size;
                                let stbl_end = minf_child.offset + minf_child.size;
                                for stbl_child in iter_mp4_boxes(file_data, stbl_start, stbl_end) {
                                    if &stbl_child.box_type == b"stsd" {
                                        let payload_start = stbl_child.offset + stbl_child.header_size;
                                        let payload_end = stbl_child.offset + stbl_child.size;
                                        if payload_end <= file_data.len() {
                                            stsd_entries = parse_stsd_entries(&file_data[payload_start..payload_end]);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        if let (Some(tid), Some(handler)) = (track_id, handler_type) {
            tracks.push(Mp4TrackInfo {
                track_id: tid,
                handler_type: handler,
                width,
                height,
                stsd_entries,
            });
        }
    }

    Ok(tracks)
}
fn push_u16(buf: &mut Vec<u8>, value: u16) {
    buf.extend_from_slice(&value.to_be_bytes());
}

fn push_u32(buf: &mut Vec<u8>, value: u32) {
    buf.extend_from_slice(&value.to_be_bytes());
}

fn push_u64(buf: &mut Vec<u8>, value: u64) {
    buf.extend_from_slice(&value.to_be_bytes());
}

fn push_i32(buf: &mut Vec<u8>, value: i32) {
    buf.extend_from_slice(&value.to_be_bytes());
}

fn make_mp4_box(box_type: &[u8; 4], payload: Vec<u8>) -> Vec<u8> {
    let size = (payload.len() + 8) as u32;
    let mut out = Vec::with_capacity(payload.len() + 8);
    out.extend_from_slice(&size.to_be_bytes());
    out.extend_from_slice(box_type);
    out.extend_from_slice(&payload);
    out
}

fn build_mvhd(timescale: u32, duration: u32, next_track_id: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0, 0, 0, 0]);
    push_u32(&mut payload, 0);
    push_u32(&mut payload, 0);
    push_u32(&mut payload, timescale);
    push_u32(&mut payload, duration);
    push_u32(&mut payload, 0x0001_0000);
    push_u16(&mut payload, 0x0100);
    payload.extend_from_slice(&[0u8; 10]);
    payload.extend_from_slice(&[
        0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00,
    ]);
    payload.extend_from_slice(&[0u8; 24]);
    push_u32(&mut payload, next_track_id);
    make_mp4_box(b"mvhd", payload)
}

fn build_tkhd(track_id: u32, duration: u32, width: u32, height: u32, is_audio: bool) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0x00, 0x00, 0x00, 0x07]);
    push_u32(&mut payload, 0);
    push_u32(&mut payload, 0);
    push_u32(&mut payload, track_id);
    push_u32(&mut payload, 0);
    push_u32(&mut payload, duration);
    payload.extend_from_slice(&[0u8; 8]);
    push_u16(&mut payload, 0);
    push_u16(&mut payload, 0);
    push_u16(&mut payload, if is_audio { 0x0100 } else { 0x0000 });
    push_u16(&mut payload, 0);
    payload.extend_from_slice(&[
        0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00,
    ]);
    push_u32(&mut payload, width << 16);
    push_u32(&mut payload, height << 16);
    make_mp4_box(b"tkhd", payload)
}

fn build_mdhd(timescale: u32, duration: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0, 0, 0, 0]);
    push_u32(&mut payload, 0);
    push_u32(&mut payload, 0);
    push_u32(&mut payload, timescale);
    push_u32(&mut payload, duration);
    push_u16(&mut payload, 0x55c4);
    push_u16(&mut payload, 0);
    make_mp4_box(b"mdhd", payload)
}

fn build_hdlr(handler_type: [u8; 4]) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0, 0, 0, 0]);
    push_u32(&mut payload, 0);
    payload.extend_from_slice(&handler_type);
    payload.extend_from_slice(&[0u8; 12]);
    payload.extend_from_slice(match &handler_type {
        b"vide" => b"VideoHandler\0",
        b"soun" => b"SoundHandler\0",
        _ => b"Handler\0",
    });
    make_mp4_box(b"hdlr", payload)
}

fn build_vmhd() -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
    push_u16(&mut payload, 0);
    push_u16(&mut payload, 0);
    push_u16(&mut payload, 0);
    push_u16(&mut payload, 0);
    make_mp4_box(b"vmhd", payload)
}

fn build_smhd() -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0, 0, 0, 0]);
    push_u16(&mut payload, 0);
    push_u16(&mut payload, 0);
    make_mp4_box(b"smhd", payload)
}

fn build_dinf() -> Vec<u8> {
    let mut url_payload = Vec::new();
    url_payload.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
    let url_box = make_mp4_box(b"url ", url_payload);

    let mut dref_payload = Vec::new();
    dref_payload.extend_from_slice(&[0, 0, 0, 0]);
    push_u32(&mut dref_payload, 1);
    dref_payload.extend_from_slice(&url_box);
    let dref_box = make_mp4_box(b"dref", dref_payload);

    make_mp4_box(b"dinf", dref_box)
}

fn build_stsd(entry: Vec<u8>) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0, 0, 0, 0]);
    push_u32(&mut payload, 1);
    payload.extend_from_slice(&entry);
    make_mp4_box(b"stsd", payload)
}

fn build_stts(samples: &[Mp4SegmentSample]) -> Vec<u8> {
    let mut entries: Vec<(u32, u32)> = Vec::new();
    for sample in samples {
        if let Some(last) = entries.last_mut() {
            if last.1 == sample.duration {
                last.0 += 1;
                continue;
            }
        }
        entries.push((1, sample.duration));
    }

    let mut payload = Vec::new();
    payload.extend_from_slice(&[0, 0, 0, 0]);
    push_u32(&mut payload, entries.len() as u32);
    for (count, delta) in entries {
        push_u32(&mut payload, count);
        push_u32(&mut payload, delta);
    }
    make_mp4_box(b"stts", payload)
}

fn build_ctts(samples: &[Mp4SegmentSample]) -> Option<Vec<u8>> {
    if samples.iter().all(|s| s.cts_offset == 0) {
        return None;
    }

    let version = if samples.iter().any(|s| s.cts_offset < 0) { 1u8 } else { 0u8 };
    let mut entries: Vec<(u32, i32)> = Vec::new();

    for sample in samples {
        if let Some(last) = entries.last_mut() {
            if last.1 == sample.cts_offset {
                last.0 += 1;
                continue;
            }
        }
        entries.push((1, sample.cts_offset));
    }

    let mut payload = Vec::new();
    payload.extend_from_slice(&[version, 0, 0, 0]);
    push_u32(&mut payload, entries.len() as u32);
    for (count, offset) in entries {
        push_u32(&mut payload, count);
        if version == 0 {
            push_u32(&mut payload, offset as u32);
        } else {
            push_i32(&mut payload, offset);
        }
    }

    Some(make_mp4_box(b"ctts", payload))
}

fn build_stsc() -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0, 0, 0, 0]);
    push_u32(&mut payload, 1);
    push_u32(&mut payload, 1);
    push_u32(&mut payload, 1);
    push_u32(&mut payload, 1);
    make_mp4_box(b"stsc", payload)
}

fn build_stsz(samples: &[Mp4SegmentSample]) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0, 0, 0, 0]);
    push_u32(&mut payload, 0);
    push_u32(&mut payload, samples.len() as u32);
    for sample in samples {
        push_u32(&mut payload, sample.data.len() as u32);
    }
    make_mp4_box(b"stsz", payload)
}

fn build_co64(offsets: &[u64], mdat_start: u64) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0, 0, 0, 0]);
    push_u32(&mut payload, offsets.len() as u32);
    for offset in offsets {
        push_u64(&mut payload, mdat_start + *offset);
    }
    make_mp4_box(b"co64", payload)
}

fn build_stss(samples: &[Mp4SegmentSample]) -> Option<Vec<u8>> {
    if samples.iter().all(|s| s.is_sync) {
        return None;
    }

    let mut sync_samples = Vec::new();
    for (idx, sample) in samples.iter().enumerate() {
        if sample.is_sync {
            sync_samples.push((idx + 1) as u32);
        }
    }

    let mut payload = Vec::new();
    payload.extend_from_slice(&[0, 0, 0, 0]);
    push_u32(&mut payload, sync_samples.len() as u32);
    for sample_num in sync_samples {
        push_u32(&mut payload, sample_num);
    }

    Some(make_mp4_box(b"stss", payload))
}

fn build_stbl(track: &Mp4SegmentTrack, mdat_start: u64) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&build_stsd(track.stsd_entry.clone()));
    payload.extend_from_slice(&build_stts(&track.samples));
    if let Some(ctts) = build_ctts(&track.samples) {
        payload.extend_from_slice(&ctts);
    }
    payload.extend_from_slice(&build_stsc());
    payload.extend_from_slice(&build_stsz(&track.samples));
    payload.extend_from_slice(&build_co64(&track.offsets, mdat_start));
    if track.handler_type == *b"vide" {
        if let Some(stss) = build_stss(&track.samples) {
            payload.extend_from_slice(&stss);
        }
    }
    make_mp4_box(b"stbl", payload)
}

fn build_minf(track: &Mp4SegmentTrack, mdat_start: u64) -> Vec<u8> {
    let mut payload = Vec::new();
    if track.handler_type == *b"vide" {
        payload.extend_from_slice(&build_vmhd());
    } else {
        payload.extend_from_slice(&build_smhd());
    }
    payload.extend_from_slice(&build_dinf());
    payload.extend_from_slice(&build_stbl(track, mdat_start));
    make_mp4_box(b"minf", payload)
}

fn build_mdia(track: &Mp4SegmentTrack, timescale: u32, duration: u32, mdat_start: u64) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&build_mdhd(timescale, duration));
    payload.extend_from_slice(&build_hdlr(track.handler_type));
    payload.extend_from_slice(&build_minf(track, mdat_start));
    make_mp4_box(b"mdia", payload)
}

fn build_trak(track: &Mp4SegmentTrack, timescale: u32, duration: u32, mdat_start: u64) -> Vec<u8> {
    let mut payload = Vec::new();
    let is_audio = track.handler_type == *b"soun";
    payload.extend_from_slice(&build_tkhd(track.track_id, duration, track.width, track.height, is_audio));
    payload.extend_from_slice(&build_mdia(track, timescale, duration, mdat_start));
    make_mp4_box(b"trak", payload)
}

fn build_moov(tracks: &[Mp4SegmentTrack], timescale: u32, mdat_start: u64) -> Vec<u8> {
    let mut payload = Vec::new();
    let mut max_duration = 0u32;
    let mut max_track_id = 0u32;

    for track in tracks {
        let duration = track.samples.iter().map(|s| s.duration).sum::<u32>();
        if duration > max_duration {
            max_duration = duration;
        }
        if track.track_id > max_track_id {
            max_track_id = track.track_id;
        }
    }

    payload.extend_from_slice(&build_mvhd(timescale, max_duration, max_track_id + 1));

    for track in tracks {
        let duration = track.samples.iter().map(|s| s.duration).sum::<u32>();
        payload.extend_from_slice(&build_trak(track, timescale, duration, mdat_start));
    }

    make_mp4_box(b"moov", payload)
}
fn extract_ftyp_box(file_data: &[u8]) -> Option<Vec<u8>> {
    for b in iter_mp4_boxes(file_data, 0, file_data.len()) {
        if &b.box_type == b"ftyp" {
            let end = b.offset + b.size;
            if end <= file_data.len() {
                return Some(file_data[b.offset..end].to_vec());
            }
        }
    }
    None
}

fn build_default_ftyp() -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(b"isom");
    push_u32(&mut payload, 0x200);
    payload.extend_from_slice(b"isom");
    payload.extend_from_slice(b"iso2");
    payload.extend_from_slice(b"avc1");
    payload.extend_from_slice(b"mp41");
    make_mp4_box(b"ftyp", payload)
}

fn write_mdat_box(data: &[u8]) -> Vec<u8> {
    let size = data.len() as u64 + 8;
    let mut out = Vec::new();
    if size <= u32::MAX as u64 {
        out.extend_from_slice(&(size as u32).to_be_bytes());
        out.extend_from_slice(b"mdat");
    } else {
        let large_size = data.len() as u64 + 16;
        out.extend_from_slice(&1u32.to_be_bytes());
        out.extend_from_slice(b"mdat");
        out.extend_from_slice(&large_size.to_be_bytes());
    }
    out.extend_from_slice(data);
    out
}

/// MP4 分割 - 导出指定分段
#[wasm_bindgen]
pub fn split_mp4_segment(
    file_data: &[u8],
    result_json: &str,
    segment_index: usize,
) -> Result<Uint8Array, JsError> {
    let result: AnalysisResult = serde_json::from_str(result_json)
        .map_err(|e| JsError::new(&format!("解析结果失败: {}", e)))?;

    let segments = result
        .segments
        .as_ref()
        .ok_or_else(|| JsError::new("文件没有分段信息"))?;

    let segment = segments
        .segments
        .get(segment_index)
        .ok_or_else(|| JsError::new(&format!("分段索引 {} 超出范围", segment_index)))?;

    let track_infos = extract_mp4_track_infos(file_data)?;
    let mut track_info_map: HashMap<u32, Mp4TrackInfo> = HashMap::new();
    for info in track_infos {
        track_info_map.insert(info.track_id, info);
    }

    let mut timeline_map: HashMap<usize, (i64, i64, Option<u32>)> = HashMap::new();
    for tp in result.video_timeline.iter().chain(result.audio_timeline.iter()) {
        let dts_ms = (tp.dts * 1000.0).round() as i64;
        let pts_ms = (tp.pts * 1000.0).round() as i64;
        let duration_ms = tp.duration.map(|d| (d * 1000.0).round() as u32);
        timeline_map.insert(tp.index, (dts_ms, pts_ms, duration_ms));
    }

    #[derive(Clone)]
    struct SampleMeta {
        sample_index: u32,
        offset: u64,
        size: u32,
        dts_ms: i64,
        pts_ms: i64,
        duration_ms: Option<u32>,
        is_sync: bool,
        sample_desc_index: u32,
    }

    let mut track_samples: HashMap<u32, Vec<SampleMeta>> = HashMap::new();
    let mut track_desc: HashMap<u32, u32> = HashMap::new();

    for tag in &result.tags {
        if tag.index < segment.start_tag_index || tag.index > segment.end_tag_index {
            continue;
        }
        if tag.tag_type != "video" && tag.tag_type != "audio" {
            continue;
        }
        let mp4_info = match &tag.mp4_info {
            Some(info) => info,
            None => continue,
        };

        let desc_idx = mp4_info.sample_desc_index.unwrap_or(1);
        track_desc.entry(mp4_info.track_id).or_insert(desc_idx);

        let (dts_ms, pts_ms, duration_ms) = timeline_map
            .get(&tag.index)
            .cloned()
            .unwrap_or_else(|| {
                let ts_ms = tag.timestamp as i64;
                (ts_ms, ts_ms, None)
            });

        track_samples
            .entry(mp4_info.track_id)
            .or_default()
            .push(SampleMeta {
                sample_index: mp4_info.sample_index,
                offset: tag.offset,
                size: tag.size,
                dts_ms,
                pts_ms,
                duration_ms,
                is_sync: tag.is_keyframe,
                sample_desc_index: desc_idx,
            });
    }

    if track_samples.is_empty() {
        return Err(JsError::new("分段内没有可导出的采样"));
    }

    let mut tracks: Vec<Mp4SegmentTrack> = Vec::new();

    for (track_id, mut samples) in track_samples {
        let info = track_info_map
            .get(&track_id)
            .ok_or_else(|| JsError::new(&format!("缺少轨道 {} 的 stsd 信息", track_id)))?;

        samples.sort_by_key(|s| s.sample_index);

        for i in 0..samples.len() {
            if samples[i].duration_ms.is_some() {
                continue;
            }

            let mut duration = if i + 1 < samples.len() {
                samples[i + 1].dts_ms - samples[i].dts_ms
            } else if i > 0 {
                samples[i - 1].duration_ms.unwrap_or(33) as i64
            } else {
                33
            };

            if duration <= 0 {
                duration = 33;
            }

            samples[i].duration_ms = Some(duration as u32);
        }

        let desc_idx = track_desc.get(&track_id).copied().unwrap_or(1);
        let entry_idx = desc_idx.saturating_sub(1) as usize;
        let stsd_entry = info
            .stsd_entries
            .get(entry_idx)
            .or_else(|| info.stsd_entries.first())
            .cloned()
            .ok_or_else(|| JsError::new("stsd entry 缺失"))?;

        let mut segment_samples = Vec::new();
        for sample in samples {
            let start = sample.offset as usize;
            let end = start.saturating_add(sample.size as usize);
            if end > file_data.len() {
                return Err(JsError::new("采样数据超出文件范围"));
            }
            let data = file_data[start..end].to_vec();
            let duration = sample.duration_ms.unwrap_or(33);
            let cts_offset = (sample.pts_ms - sample.dts_ms) as i32;
            segment_samples.push(Mp4SegmentSample {
                data,
                duration,
                cts_offset,
                is_sync: sample.is_sync,
            });
        }

        if segment_samples.is_empty() {
            continue;
        }

        tracks.push(Mp4SegmentTrack {
            track_id,
            handler_type: info.handler_type,
            width: info.width,
            height: info.height,
            stsd_entry,
            samples: segment_samples,
            offsets: Vec::new(),
        });
    }

    if tracks.is_empty() {
        return Err(JsError::new("没有可导出的轨道"));
    }

    tracks.sort_by_key(|t| {
        if t.handler_type == *b"vide" {
            0
        } else if t.handler_type == *b"soun" {
            1
        } else {
            2
        }
    });

    let mut mdat_data = Vec::new();
    for track in &mut tracks {
        let mut offsets = Vec::with_capacity(track.samples.len());
        for sample in &track.samples {
            offsets.push(mdat_data.len() as u64);
            mdat_data.extend_from_slice(&sample.data);
        }
        track.offsets = offsets;
    }

    let ftyp = extract_ftyp_box(file_data).unwrap_or_else(build_default_ftyp);
    let timescale = 1000u32;

    let moov_placeholder = build_moov(&tracks, timescale, 0);
    let mdat_header_size = if (mdat_data.len() as u64 + 8) <= u32::MAX as u64 { 8 } else { 16 };
    let mdat_start = (ftyp.len() + moov_placeholder.len() + mdat_header_size) as u64;
    let moov = build_moov(&tracks, timescale, mdat_start);

    let mut output = Vec::new();
    output.extend_from_slice(&ftyp);
    output.extend_from_slice(&moov);
    output.extend_from_slice(&write_mdat_box(&mdat_data));

    Ok(Uint8Array::from(output.as_slice()))
}

/// 获取分段信息的 WASM 接口
#[wasm_bindgen]
pub fn get_segment_info(result_json: &str) -> Result<JsValue, JsError> {
    let result: AnalysisResult = serde_json::from_str(result_json)
        .map_err(|e| JsError::new(&format!("解析结果失败: {}", e)))?;

    let segments = compute_segments(&result);

    serde_wasm_bindgen::to_value(&segments).map_err(|e| JsError::new(&format!("序列化失败: {}", e)))
}
