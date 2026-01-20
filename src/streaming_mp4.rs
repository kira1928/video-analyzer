//! 流式 MP4 解析器
//!
//! 支持按需读取大文件，不需要将整个文件加载到内存

use crate::container::{Codec, ContainerFormat};
use crate::mp4_box::{
    fourcc_to_string, get_box_description, is_container_box, is_sample_entry_box, is_stsd_box,
    parse_box_fields, BoxField, Mp4BoxNode, Mp4BoxTree,
};
use crate::types::*;
use async_recursion::async_recursion;
use js_sys::{Function, Promise, Uint8Array};
use wasm_bindgen::prelude::*;
use std::io::Cursor;
use wasm_bindgen_futures::JsFuture;

/// Box 类型常量
const BOX_FTYP: [u8; 4] = *b"ftyp";
const BOX_MOOV: [u8; 4] = *b"moov";
const BOX_MDAT: [u8; 4] = *b"mdat";
const BOX_MVHD: [u8; 4] = *b"mvhd";
const BOX_TRAK: [u8; 4] = *b"trak";
const BOX_TKHD: [u8; 4] = *b"tkhd";
const BOX_MDIA: [u8; 4] = *b"mdia";
const BOX_MINF: [u8; 4] = *b"minf";
const BOX_STBL: [u8; 4] = *b"stbl";
const BOX_STSD: [u8; 4] = *b"stsd";
const BOX_STTS: [u8; 4] = *b"stts";
const BOX_STSC: [u8; 4] = *b"stsc";
const BOX_STSZ: [u8; 4] = *b"stsz";
const BOX_STCO: [u8; 4] = *b"stco";
const BOX_CO64: [u8; 4] = *b"co64";
const BOX_STSS: [u8; 4] = *b"stss";
const BOX_CTTS: [u8; 4] = *b"ctts";
const BOX_MDHD: [u8; 4] = *b"mdhd";
const BOX_HDLR: [u8; 4] = *b"hdlr";
const BOX_AVCC: [u8; 4] = *b"avcC";
const BOX_HVCC: [u8; 4] = *b"hvcC";
const BOX_ESDS: [u8; 4] = *b"esds";

/// 轨道类型
#[derive(Debug, Clone, Copy, PartialEq)]
enum TrackType {
    Video,
    Audio,
    Other,
}

/// Sample 信息（不包含数据）
#[derive(Debug, Clone)]
pub struct StreamingSampleInfo {
    /// 在文件中的偏移
    pub offset: u64,
    /// 数据大小
    pub size: u32,
    /// DTS（毫秒）
    pub dts: u32,
    /// PTS（毫秒）
    pub pts: u32,
    /// 持续时间（毫秒）
    pub duration: Option<f64>,
    /// 是否为关键帧
    pub is_keyframe: bool,
    /// 轨道 ID
    pub track_id: u32,
    /// Sample 索引（在轨道内）
    pub sample_index: u32,
    /// 编解码器
    pub codec: Codec,
    /// Sample 类型
    pub sample_type: SampleType,
}

/// Sample 类型
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SampleType {
    Video,
    Audio,
    Unknown,
}

/// stsc entry
#[derive(Debug, Clone, Copy)]
struct StscEntry {
    first_chunk: u32,
    samples_per_chunk: u32,
    sample_desc_index: u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Mp4BoxChildrenResult {
    children: Vec<Mp4BoxNode>,
    total_count: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Mp4BoxSearchResult {
    tree: Mp4BoxTree,
    match_paths: Vec<Vec<u32>>,
    total_matches: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Mp4BoxFieldsResult {
    header_fields: Vec<BoxField>,
    entry_count: Option<u32>,
    entry_start: Option<u32>,
    entries: Vec<BoxField>,
}

struct StreamingBoxHeader {
    box_type_bytes: [u8; 4],
    box_type: String,
    size: u64,
    header_size: u8,
}

fn empty_fields() -> Mp4BoxFieldsResult {
    Mp4BoxFieldsResult {
        header_fields: Vec::new(),
        entry_count: None,
        entry_start: None,
        entries: Vec::new(),
    }
}

fn clamp_range(entry_count: u32, start: u32, count: u32) -> (u32, u32) {
    if entry_count == 0 {
        return (0, 0);
    }
    let start = start.min(entry_count);
    let max_count = entry_count.saturating_sub(start);
    let count = if count == 0 { 0 } else { count.min(max_count) };
    (start, count)
}

fn is_container_like(box_type: &[u8; 4]) -> bool {
    is_container_box(box_type) || is_stsd_box(box_type) || is_sample_entry_box(box_type)
}

fn box_type_to_bytes(box_type: &str) -> [u8; 4] {
    let mut out = [0u8; 4];
    for (i, ch) in box_type.chars().take(4).enumerate() {
        let code = ch as u32;
        out[i] = if code <= 0xFF { code as u8 } else { b'?' };
    }
    out
}

#[wasm_bindgen]
impl StreamingMp4Parser {
    #[wasm_bindgen(js_name = getMp4BoxTreeRoot)]
    pub async fn get_mp4_box_tree_root(&mut self, depth: u32) -> Result<JsValue, JsError> {
        let depth = depth.max(1);
        let (boxes, _count) = self
            .parse_boxes_recursive(0, self.file_size, depth)
            .await
            .map_err(|e| JsError::new(&e))?;

        let total_count = if let Some(total) = self.box_tree_total_count {
            total
        } else {
            let total = self
                .count_boxes_recursive(0, self.file_size)
                .await
                .map_err(|e| JsError::new(&e))?;
            self.box_tree_total_count = Some(total);
            total
        };

        let tree = Mp4BoxTree {
            boxes,
            total_count,
        };

        serde_wasm_bindgen::to_value(&tree).map_err(|e| JsError::new(&e.to_string()))
    }

    #[wasm_bindgen(js_name = getMp4BoxChildren)]
    pub async fn get_mp4_box_children(
        &self,
        offset: f64,
        size: f64,
        box_type: String,
    ) -> Result<JsValue, JsError> {
        let offset = offset as u64;
        let size = size as u64;
        let box_type_bytes = box_type_to_bytes(&box_type);

        if !is_container_like(&box_type_bytes) || size == 0 {
            let empty = Mp4BoxChildrenResult {
                children: Vec::new(),
                total_count: 0,
            };
            return serde_wasm_bindgen::to_value(&empty)
                .map_err(|e| JsError::new(&e.to_string()));
        }

        let header = self
            .read_box_header(offset, offset + size)
            .await
            .map_err(|e| JsError::new(&e))?
            .ok_or_else(|| JsError::new("无法读取 box header"))?;
        let (content_start, content_end) =
            self.child_content_range(offset, size, header.header_size, &box_type_bytes)?;
        let (children, total_count) = self
            .parse_boxes_recursive(content_start, content_end, 1)
            .await
            .map_err(|e| JsError::new(&e))?;

        let result = Mp4BoxChildrenResult {
            children,
            total_count,
        };
        serde_wasm_bindgen::to_value(&result).map_err(|e| JsError::new(&e.to_string()))
    }

    #[wasm_bindgen(js_name = getMp4BoxFields)]
    pub async fn get_mp4_box_fields(
        &self,
        offset: f64,
        size: f64,
        box_type: String,
        start: u32,
        count: u32,
    ) -> Result<JsValue, JsError> {
        let offset = offset as u64;
        let size = size as u64;
        let header = self
            .read_box_header(offset, offset + size)
            .await
            .map_err(|e| JsError::new(&e))?
            .ok_or_else(|| JsError::new("无法读取 box header"))?;

        let content_start = offset + header.header_size as u64;
        let content_size = size.saturating_sub(header.header_size as u64);

        let result = self
            .parse_box_fields_streaming(
                &box_type,
                content_start,
                content_size,
                start,
                count,
            )
            .await
            .map_err(|e| JsError::new(&e))?;

        serde_wasm_bindgen::to_value(&result).map_err(|e| JsError::new(&e.to_string()))
    }

    #[wasm_bindgen(js_name = readMp4Bytes)]
    pub async fn read_mp4_bytes(
        &self,
        offset: f64,
        length: u32,
    ) -> Result<Uint8Array, JsError> {
        const MAX_READ_BYTES: usize = 256 * 1024;

        let offset = offset as u64;
        if offset >= self.file_size {
            return Ok(Uint8Array::new_with_length(0));
        }

        let length = (length as usize).min(MAX_READ_BYTES);
        let available = (self.file_size - offset) as usize;
        let length = length.min(available);
        if length == 0 {
            return Ok(Uint8Array::new_with_length(0));
        }

        let data = self
            .read_range(offset, length)
            .await
            .map_err(|e| JsError::new(&e))?;

        Ok(Uint8Array::from(data.as_slice()))
    }

    #[wasm_bindgen(js_name = searchMp4Boxes)]
    pub async fn search_mp4_boxes(&self, query: String) -> Result<JsValue, JsError> {
        let query = query.trim().to_string();
        if query.is_empty() {
            let empty = Mp4BoxSearchResult {
                tree: Mp4BoxTree {
                    boxes: Vec::new(),
                    total_count: 0,
                },
                match_paths: Vec::new(),
                total_matches: 0,
            };
            return serde_wasm_bindgen::to_value(&empty)
                .map_err(|e| JsError::new(&e.to_string()));
        }

        let (boxes, match_paths, total_matches) = self
            .search_boxes_recursive(0, self.file_size, &query, &[])
            .await
            .map_err(|e| JsError::new(&e))?;

        let tree = Mp4BoxTree {
            boxes,
            total_count: total_matches,
        };
        let result = Mp4BoxSearchResult {
            tree,
            match_paths,
            total_matches,
        };
        serde_wasm_bindgen::to_value(&result).map_err(|e| JsError::new(&e.to_string()))
    }
}

impl StreamingMp4Parser {
    async fn read_box_header(
        &self,
        offset: u64,
        end: u64,
    ) -> Result<Option<StreamingBoxHeader>, String> {
        if offset + 8 > end {
            return Ok(None);
        }
        let header = self.read_range(offset, 8).await?;
        if header.len() < 8 {
            return Ok(None);
        }

        let size = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as u64;
        let box_type_bytes: [u8; 4] = [header[4], header[5], header[6], header[7]];
        let box_type = fourcc_to_string(box_type_bytes);

        let (box_size, header_size) = if size == 1 {
            let ext = self.read_range(offset + 8, 8).await?;
            if ext.len() < 8 {
                return Ok(None);
            }
            (
                u64::from_be_bytes([
                    ext[0], ext[1], ext[2], ext[3], ext[4], ext[5], ext[6], ext[7],
                ]),
                16u8,
            )
        } else if size == 0 {
            (end.saturating_sub(offset), 8u8)
        } else {
            (size, 8u8)
        };

        if box_size < header_size as u64 || offset + box_size > end + 8 {
            return Ok(None);
        }

        Ok(Some(StreamingBoxHeader {
            box_type_bytes,
            box_type,
            size: box_size,
            header_size,
        }))
    }

    fn child_content_range(
        &self,
        offset: u64,
        size: u64,
        header_size: u8,
        box_type: &[u8; 4],
    ) -> Result<(u64, u64), JsError> {
        let content_start = offset + header_size as u64;
        let content_end = offset + size;

        let child_start = if is_stsd_box(box_type) {
            content_start + 8
        } else if is_sample_entry_box(box_type) {
            content_start + 78
        } else if box_type == b"meta" {
            content_start + 4
        } else {
            content_start
        };

        if child_start > content_end {
            return Err(JsError::new("无效的 box 子范围"));
        }

        Ok((child_start, content_end))
    }

    #[async_recursion(?Send)]
    async fn parse_boxes_recursive(
        &self,
        start: u64,
        end: u64,
        depth: u32,
    ) -> Result<(Vec<Mp4BoxNode>, usize), String> {
        let mut boxes = Vec::new();
        let mut total_count = 0usize;
        let mut pos = start;

        while pos < end {
            let header = match self.read_box_header(pos, end).await? {
                Some(h) => h,
                None => break,
            };

            let box_end = pos + header.size;
            let description = get_box_description(&header.box_type).to_string();
            let is_container = is_container_like(&header.box_type_bytes);

            let mut children = None;
            if depth > 1 && is_container {
                let (child_start, child_end) =
                    self.child_content_range(pos, header.size, header.header_size, &header.box_type_bytes)
                        .map_err(|e| format!("{:?}", e))?;
                if child_start < child_end {
                    let (child_boxes, child_count) =
                        self.parse_boxes_recursive(child_start, child_end, depth - 1).await?;
                    total_count += child_count;
                    children = Some(child_boxes);
                }
            }

            let children_count = children.as_ref().map(|list| list.len());
            let node = Mp4BoxNode {
                box_type: header.box_type,
                offset: pos,
                size: header.size,
                header_size: header.header_size,
                description,
                fields: None,
                children,
                children_count,
                is_container: Some(is_container),
            };

            boxes.push(node);
            total_count += 1;
            pos = box_end;
        }

        Ok((boxes, total_count))
    }

    #[async_recursion(?Send)]
    async fn count_boxes_recursive(&self, start: u64, end: u64) -> Result<usize, String> {
        let mut total = 0usize;
        let mut pos = start;

        while pos < end {
            let header = match self.read_box_header(pos, end).await? {
                Some(h) => h,
                None => break,
            };

            let box_end = pos + header.size;
            total += 1;

            if is_container_like(&header.box_type_bytes) {
                if let Ok((child_start, child_end)) =
                    self.child_content_range(pos, header.size, header.header_size, &header.box_type_bytes)
                {
                    if child_start < child_end {
                        total += self.count_boxes_recursive(child_start, child_end).await?;
                    }
                }
            }

            pos = box_end;
        }

        Ok(total)
    }
}

impl StreamingMp4Parser {
    #[async_recursion(?Send)]
    async fn search_boxes_recursive(
        &self,
        start: u64,
        end: u64,
        query: &str,
        path_prefix: &[u32],
    ) -> Result<(Vec<Mp4BoxNode>, Vec<Vec<u32>>, usize), String> {
        let mut boxes = Vec::new();
        let mut match_paths: Vec<Vec<u32>> = Vec::new();
        let mut total_matches = 0usize;
        let mut pos = start;
        let q = query.to_lowercase();

        while pos < end {
            let header = match self.read_box_header(pos, end).await? {
                Some(h) => h,
                None => break,
            };

            let box_end = pos + header.size;
            let description = get_box_description(&header.box_type).to_string();
            let is_container = is_container_like(&header.box_type_bytes);

            let mut child_nodes = Vec::new();
            let mut child_paths = Vec::new();

            if is_container {
                if let Ok((child_start, child_end)) =
                    self.child_content_range(pos, header.size, header.header_size, &header.box_type_bytes)
                {
                    let (nodes, paths, matches) = self
                        .search_boxes_recursive(child_start, child_end, query, &[])
                        .await?;
                    child_nodes = nodes;
                    child_paths = paths;
                    total_matches += matches;
                }
            }

            let is_match = header.box_type.to_lowercase().contains(&q)
                || description.to_lowercase().contains(&q)
                || pos.to_string().contains(&q)
                || header.size.to_string().contains(&q);

            if is_match || !child_nodes.is_empty() {
                let idx = boxes.len() as u32;

                if is_match {
                    let mut path = path_prefix.to_vec();
                    path.push(idx);
                    match_paths.push(path);
                    total_matches += 1;
                }

                for child_path in child_paths {
                    let mut path = path_prefix.to_vec();
                    path.push(idx);
                    path.extend(child_path);
                    match_paths.push(path);
                }

                let has_children = !child_nodes.is_empty();
                let children_count = if has_children {
                    Some(child_nodes.len())
                } else {
                    None
                };
                let children = if has_children {
                    Some(child_nodes)
                } else {
                    None
                };

                let node = Mp4BoxNode {
                    box_type: header.box_type,
                    offset: pos,
                    size: header.size,
                    header_size: header.header_size,
                    description,
                    fields: None,
                    children,
                    children_count,
                    is_container: Some(is_container),
                };

                boxes.push(node);
            }

            pos = box_end;
        }

        Ok((boxes, match_paths, total_matches))
    }
}

impl StreamingMp4Parser {
    async fn parse_box_fields_streaming(
        &self,
        box_type: &str,
        content_start: u64,
        content_size: u64,
        start: u32,
        count: u32,
    ) -> Result<Mp4BoxFieldsResult, String> {
        const MAX_FIELD_PAYLOAD_BYTES: usize = 256 * 1024;

        match box_type {
            "stts" => self
                .parse_entries_stts(content_start, start, count)
                .await,
            "stsc" => self
                .parse_entries_stsc(content_start, start, count)
                .await,
            "stsz" => self
                .parse_entries_stsz(content_start, start, count)
                .await,
            "stco" => self
                .parse_entries_stco(content_start, start, count, false)
                .await,
            "co64" => self
                .parse_entries_stco(content_start, start, count, true)
                .await,
            "stss" => self
                .parse_entries_stss(content_start, start, count)
                .await,
            "ctts" => self
                .parse_entries_ctts(content_start, start, count)
                .await,
            "elst" => self
                .parse_entries_elst(content_start, start, count)
                .await,
            "mdat" => Ok(Mp4BoxFieldsResult {
                header_fields: vec![BoxField::new(
                    "data_size",
                    format!(
                        "{} bytes ({:.2} MB)",
                        content_size,
                        content_size as f64 / 1024.0 / 1024.0
                    ),
                    "媒体数据大小",
                )],
                entry_count: None,
                entry_start: None,
                entries: Vec::new(),
            }),
            _ => {
                if content_size as usize > MAX_FIELD_PAYLOAD_BYTES {
                    return Ok(empty_fields());
                }
                let payload = self.read_range(content_start, content_size as usize).await?;
                let mut cursor = Cursor::new(payload);
                let fields = parse_box_fields(&mut cursor, box_type, 0, content_size)
                    .unwrap_or_default();
                Ok(Mp4BoxFieldsResult {
                    header_fields: fields,
                    entry_count: None,
                    entry_start: None,
                    entries: Vec::new(),
                })
            }
        }
    }

    async fn parse_entries_stts(
        &self,
        content_start: u64,
        start: u32,
        count: u32,
    ) -> Result<Mp4BoxFieldsResult, String> {
        let header = self.read_range(content_start, 8).await?;
        if header.len() < 8 {
            return Ok(empty_fields());
        }
        let version = header[0];
        let entry_count =
            u32::from_be_bytes([header[4], header[5], header[6], header[7]]);
        let mut header_fields = Vec::new();
        header_fields.push(BoxField::new("version", version, "版本号"));
        header_fields.push(BoxField::new(
            "entry_count",
            entry_count,
            "条目数量，每条描述一组具有相同时长的采样",
        ));

        let (entries, entry_start) =
            self.read_stts_entries(content_start + 8, entry_count, start, count)
                .await?;

        Ok(Mp4BoxFieldsResult {
            header_fields,
            entry_count: Some(entry_count),
            entry_start,
            entries,
        })
    }

    async fn read_stts_entries(
        &self,
        entries_start: u64,
        entry_count: u32,
        start: u32,
        count: u32,
    ) -> Result<(Vec<BoxField>, Option<u32>), String> {
        let (start, count) = clamp_range(entry_count, start, count);
        if count == 0 {
            return Ok((Vec::new(), None));
        }
        let byte_start = entries_start + start as u64 * 8;
        let bytes = self.read_range(byte_start, count as usize * 8).await?;
        let mut fields = Vec::new();
        for i in 0..count as usize {
            let base = i * 8;
            if base + 8 > bytes.len() {
                break;
            }
            let sample_count = u32::from_be_bytes([
                bytes[base],
                bytes[base + 1],
                bytes[base + 2],
                bytes[base + 3],
            ]);
            let sample_delta = u32::from_be_bytes([
                bytes[base + 4],
                bytes[base + 5],
                bytes[base + 6],
                bytes[base + 7],
            ]);
            let idx = start as usize + i;
            fields.push(BoxField::new(
                &format!("entry[{}]", idx),
                format!("count={}, delta={}", sample_count, sample_delta),
                &format!(
                    "第 {} 条：{} 个采样，每个持续 {} timescale 单位",
                    idx + 1,
                    sample_count,
                    sample_delta
                ),
            ));
        }
        Ok((fields, Some(start)))
    }

    async fn parse_entries_stsc(
        &self,
        content_start: u64,
        start: u32,
        count: u32,
    ) -> Result<Mp4BoxFieldsResult, String> {
        let header = self.read_range(content_start, 8).await?;
        if header.len() < 8 {
            return Ok(empty_fields());
        }
        let version = header[0];
        let entry_count =
            u32::from_be_bytes([header[4], header[5], header[6], header[7]]);
        let mut header_fields = Vec::new();
        header_fields.push(BoxField::new("version", version, "版本号"));
        header_fields.push(BoxField::new(
            "entry_count",
            entry_count,
            "条目数量，定义 Sample 在 Chunk 中的分布规律",
        ));

        let (entries, entry_start) =
            self.read_stsc_entries(content_start + 8, entry_count, start, count)
                .await?;

        Ok(Mp4BoxFieldsResult {
            header_fields,
            entry_count: Some(entry_count),
            entry_start,
            entries,
        })
    }

    async fn read_stsc_entries(
        &self,
        entries_start: u64,
        entry_count: u32,
        start: u32,
        count: u32,
    ) -> Result<(Vec<BoxField>, Option<u32>), String> {
        let (start, count) = clamp_range(entry_count, start, count);
        if count == 0 {
            return Ok((Vec::new(), None));
        }
        let byte_start = entries_start + start as u64 * 12;
        let bytes = self.read_range(byte_start, count as usize * 12).await?;
        let mut fields = Vec::new();
        for i in 0..count as usize {
            let base = i * 12;
            if base + 12 > bytes.len() {
                break;
            }
            let first_chunk = u32::from_be_bytes([
                bytes[base],
                bytes[base + 1],
                bytes[base + 2],
                bytes[base + 3],
            ]);
            let samples_per_chunk = u32::from_be_bytes([
                bytes[base + 4],
                bytes[base + 5],
                bytes[base + 6],
                bytes[base + 7],
            ]);
            let sample_desc_idx = u32::from_be_bytes([
                bytes[base + 8],
                bytes[base + 9],
                bytes[base + 10],
                bytes[base + 11],
            ]);
            let idx = start as usize + i;
            fields.push(BoxField::new(
                &format!("entry[{}]", idx),
                format!(
                    "first_chunk={}, samples_per_chunk={}, desc_idx={}",
                    first_chunk, samples_per_chunk, sample_desc_idx
                ),
                &format!(
                    "第 {} 条：从第 {} 个 Chunk 开始，每个 Chunk 包含 {} 个采样",
                    idx + 1,
                    first_chunk,
                    samples_per_chunk
                ),
            ));
        }
        Ok((fields, Some(start)))
    }

    async fn parse_entries_stsz(
        &self,
        content_start: u64,
        start: u32,
        count: u32,
    ) -> Result<Mp4BoxFieldsResult, String> {
        let header = self.read_range(content_start, 12).await?;
        if header.len() < 12 {
            return Ok(empty_fields());
        }
        let version = header[0];
        let sample_size =
            u32::from_be_bytes([header[4], header[5], header[6], header[7]]);
        let sample_count =
            u32::from_be_bytes([header[8], header[9], header[10], header[11]]);

        let mut header_fields = Vec::new();
        header_fields.push(BoxField::new("version", version, "版本号"));
        if sample_size > 0 {
            header_fields.push(BoxField::new(
                "sample_size",
                format!("{} bytes", sample_size),
                "固定采样大小（所有采样大小相同）",
            ));
        } else {
            header_fields.push(BoxField::new(
                "sample_size",
                "0 (variable)",
                "可变大小，每个采样大小单独指定",
            ));
        }
        header_fields.push(BoxField::new("sample_count", sample_count, "采样总数"));

        if sample_size > 0 {
            return Ok(Mp4BoxFieldsResult {
                header_fields,
                entry_count: None,
                entry_start: None,
                entries: Vec::new(),
            });
        }

        let (entries, entry_start) =
            self.read_stsz_entries(content_start + 12, sample_count, start, count)
                .await?;

        Ok(Mp4BoxFieldsResult {
            header_fields,
            entry_count: Some(sample_count),
            entry_start,
            entries,
        })
    }

    async fn read_stsz_entries(
        &self,
        entries_start: u64,
        entry_count: u32,
        start: u32,
        count: u32,
    ) -> Result<(Vec<BoxField>, Option<u32>), String> {
        let (start, count) = clamp_range(entry_count, start, count);
        if count == 0 {
            return Ok((Vec::new(), None));
        }
        let byte_start = entries_start + start as u64 * 4;
        let bytes = self.read_range(byte_start, count as usize * 4).await?;
        let mut fields = Vec::new();
        for i in 0..count as usize {
            let base = i * 4;
            if base + 4 > bytes.len() {
                break;
            }
            let size = u32::from_be_bytes([
                bytes[base],
                bytes[base + 1],
                bytes[base + 2],
                bytes[base + 3],
            ]);
            let idx = start as usize + i;
            fields.push(BoxField::new(
                &format!("entry[{}]", idx),
                size,
                &format!("第 {} 个采样大小", idx + 1),
            ));
        }
        Ok((fields, Some(start)))
    }

    async fn parse_entries_stco(
        &self,
        content_start: u64,
        start: u32,
        count: u32,
        is_64bit: bool,
    ) -> Result<Mp4BoxFieldsResult, String> {
        let header = self.read_range(content_start, 8).await?;
        if header.len() < 8 {
            return Ok(empty_fields());
        }
        let version = header[0];
        let entry_count =
            u32::from_be_bytes([header[4], header[5], header[6], header[7]]);
        let mut header_fields = Vec::new();
        header_fields.push(BoxField::new("version", version, "版本号"));
        header_fields.push(BoxField::new("entry_count", entry_count, "Chunk 数量"));
        header_fields.push(BoxField::new(
            "offset_size",
            if is_64bit { "64-bit" } else { "32-bit" },
            if is_64bit {
                "使用 64 位偏移量（大文件支持）"
            } else {
                "使用 32 位偏移量"
            },
        ));

        let (entries, entry_start) = self
            .read_stco_entries(content_start + 8, entry_count, start, count, is_64bit)
            .await?;

        Ok(Mp4BoxFieldsResult {
            header_fields,
            entry_count: Some(entry_count),
            entry_start,
            entries,
        })
    }

    async fn read_stco_entries(
        &self,
        entries_start: u64,
        entry_count: u32,
        start: u32,
        count: u32,
        is_64bit: bool,
    ) -> Result<(Vec<BoxField>, Option<u32>), String> {
        let (start, count) = clamp_range(entry_count, start, count);
        if count == 0 {
            return Ok((Vec::new(), None));
        }
        let entry_size = if is_64bit { 8 } else { 4 };
        let byte_start = entries_start + start as u64 * entry_size;
        let bytes = self
            .read_range(byte_start, count as usize * entry_size as usize)
            .await?;
        let mut fields = Vec::new();
        for i in 0..count as usize {
            let base = i * entry_size as usize;
            if base + entry_size as usize > bytes.len() {
                break;
            }
            let offset = if is_64bit {
                u64::from_be_bytes([
                    bytes[base],
                    bytes[base + 1],
                    bytes[base + 2],
                    bytes[base + 3],
                    bytes[base + 4],
                    bytes[base + 5],
                    bytes[base + 6],
                    bytes[base + 7],
                ])
            } else {
                u32::from_be_bytes([
                    bytes[base],
                    bytes[base + 1],
                    bytes[base + 2],
                    bytes[base + 3],
                ]) as u64
            };
            let idx = start as usize + i;
            fields.push(BoxField::new(
                &format!("entry[{}]", idx),
                format!("0x{:X}", offset),
                &format!("第 {} 个 Chunk 偏移", idx + 1),
            ));
        }
        Ok((fields, Some(start)))
    }

    async fn parse_entries_stss(
        &self,
        content_start: u64,
        start: u32,
        count: u32,
    ) -> Result<Mp4BoxFieldsResult, String> {
        let header = self.read_range(content_start, 8).await?;
        if header.len() < 8 {
            return Ok(empty_fields());
        }
        let version = header[0];
        let entry_count =
            u32::from_be_bytes([header[4], header[5], header[6], header[7]]);
        let mut header_fields = Vec::new();
        header_fields.push(BoxField::new("version", version, "版本号"));
        header_fields.push(BoxField::new(
            "entry_count",
            entry_count,
            "同步采样（关键帧）数量",
        ));

        let (entries, entry_start) =
            self.read_stss_entries(content_start + 8, entry_count, start, count)
                .await?;

        Ok(Mp4BoxFieldsResult {
            header_fields,
            entry_count: Some(entry_count),
            entry_start,
            entries,
        })
    }

    async fn read_stss_entries(
        &self,
        entries_start: u64,
        entry_count: u32,
        start: u32,
        count: u32,
    ) -> Result<(Vec<BoxField>, Option<u32>), String> {
        let (start, count) = clamp_range(entry_count, start, count);
        if count == 0 {
            return Ok((Vec::new(), None));
        }
        let byte_start = entries_start + start as u64 * 4;
        let bytes = self.read_range(byte_start, count as usize * 4).await?;
        let mut fields = Vec::new();
        for i in 0..count as usize {
            let base = i * 4;
            if base + 4 > bytes.len() {
                break;
            }
            let sample_num = u32::from_be_bytes([
                bytes[base],
                bytes[base + 1],
                bytes[base + 2],
                bytes[base + 3],
            ]);
            let idx = start as usize + i;
            fields.push(BoxField::new(
                &format!("entry[{}]", idx),
                sample_num,
                &format!("第 {} 个关键帧采样编号", idx + 1),
            ));
        }
        Ok((fields, Some(start)))
    }

    async fn parse_entries_ctts(
        &self,
        content_start: u64,
        start: u32,
        count: u32,
    ) -> Result<Mp4BoxFieldsResult, String> {
        let header = self.read_range(content_start, 8).await?;
        if header.len() < 8 {
            return Ok(empty_fields());
        }
        let version = header[0];
        let entry_count =
            u32::from_be_bytes([header[4], header[5], header[6], header[7]]);
        let mut header_fields = Vec::new();
        header_fields.push(BoxField::new(
            "version",
            version,
            if version == 0 {
                "版本 0：offset 为无符号数"
            } else {
                "版本 1：offset 可为负数"
            },
        ));
        header_fields.push(BoxField::new(
            "entry_count",
            entry_count,
            "条目数量，每条描述一组 CTS 偏移",
        ));

        let (entries, entry_start) =
            self.read_ctts_entries(content_start + 8, entry_count, start, count, version)
                .await?;

        Ok(Mp4BoxFieldsResult {
            header_fields,
            entry_count: Some(entry_count),
            entry_start,
            entries,
        })
    }

    async fn read_ctts_entries(
        &self,
        entries_start: u64,
        entry_count: u32,
        start: u32,
        count: u32,
        version: u8,
    ) -> Result<(Vec<BoxField>, Option<u32>), String> {
        let (start, count) = clamp_range(entry_count, start, count);
        if count == 0 {
            return Ok((Vec::new(), None));
        }
        let byte_start = entries_start + start as u64 * 8;
        let bytes = self.read_range(byte_start, count as usize * 8).await?;
        let mut fields = Vec::new();
        for i in 0..count as usize {
            let base = i * 8;
            if base + 8 > bytes.len() {
                break;
            }
            let sample_count = u32::from_be_bytes([
                bytes[base],
                bytes[base + 1],
                bytes[base + 2],
                bytes[base + 3],
            ]);
            let offset = if version == 0 {
                u32::from_be_bytes([
                    bytes[base + 4],
                    bytes[base + 5],
                    bytes[base + 6],
                    bytes[base + 7],
                ]) as i64
            } else {
                i32::from_be_bytes([
                    bytes[base + 4],
                    bytes[base + 5],
                    bytes[base + 6],
                    bytes[base + 7],
                ]) as i64
            };
            let idx = start as usize + i;
            fields.push(BoxField::new(
                &format!("entry[{}]", idx),
                format!("count={}, offset={}", sample_count, offset),
                &format!("第 {} 条：{} 个采样，CTS = DTS + {}", idx + 1, sample_count, offset),
            ));
        }
        Ok((fields, Some(start)))
    }

    async fn parse_entries_elst(
        &self,
        content_start: u64,
        start: u32,
        count: u32,
    ) -> Result<Mp4BoxFieldsResult, String> {
        let header = self.read_range(content_start, 8).await?;
        if header.len() < 8 {
            return Ok(empty_fields());
        }
        let version = header[0];
        let entry_count =
            u32::from_be_bytes([header[4], header[5], header[6], header[7]]);
        let mut header_fields = Vec::new();
        header_fields.push(BoxField::new("version", version, "版本号，影响字段大小"));
        header_fields.push(BoxField::new(
            "entry_count",
            entry_count,
            "编辑列表条目数量",
        ));

        let (entries, entry_start) = self
            .read_elst_entries(content_start + 8, entry_count, start, count, version)
            .await?;

        Ok(Mp4BoxFieldsResult {
            header_fields,
            entry_count: Some(entry_count),
            entry_start,
            entries,
        })
    }

    async fn read_elst_entries(
        &self,
        entries_start: u64,
        entry_count: u32,
        start: u32,
        count: u32,
        version: u8,
    ) -> Result<(Vec<BoxField>, Option<u32>), String> {
        let (start, count) = clamp_range(entry_count, start, count);
        if count == 0 {
            return Ok((Vec::new(), None));
        }
        let entry_size = if version == 1 { 20 } else { 12 };
        let byte_start = entries_start + start as u64 * entry_size;
        let bytes = self.read_range(byte_start, count as usize * entry_size as usize).await?;
        let mut fields = Vec::new();
        for i in 0..count as usize {
            let base = i * entry_size as usize;
            if base + entry_size as usize > bytes.len() {
                break;
            }
            let (segment_duration, media_time, rate) = if version == 1 {
                let duration = u64::from_be_bytes([
                    bytes[base],
                    bytes[base + 1],
                    bytes[base + 2],
                    bytes[base + 3],
                    bytes[base + 4],
                    bytes[base + 5],
                    bytes[base + 6],
                    bytes[base + 7],
                ]);
                let time = i64::from_be_bytes([
                    bytes[base + 8],
                    bytes[base + 9],
                    bytes[base + 10],
                    bytes[base + 11],
                    bytes[base + 12],
                    bytes[base + 13],
                    bytes[base + 14],
                    bytes[base + 15],
                ]);
                let rate_raw = u32::from_be_bytes([
                    bytes[base + 16],
                    bytes[base + 17],
                    bytes[base + 18],
                    bytes[base + 19],
                ]);
                (duration, time, rate_raw as f64 / 65536.0)
            } else {
                let duration = u32::from_be_bytes([
                    bytes[base],
                    bytes[base + 1],
                    bytes[base + 2],
                    bytes[base + 3],
                ]) as u64;
                let time = i32::from_be_bytes([
                    bytes[base + 4],
                    bytes[base + 5],
                    bytes[base + 6],
                    bytes[base + 7],
                ]) as i64;
                let rate_raw = u32::from_be_bytes([
                    bytes[base + 8],
                    bytes[base + 9],
                    bytes[base + 10],
                    bytes[base + 11],
                ]);
                (duration, time, rate_raw as f64 / 65536.0)
            };
            let idx = start as usize + i;
            let desc = if media_time == -1 {
                format!("空白段：时长 {}", segment_duration)
            } else {
                format!(
                    "媒体段：时长 {}，起点 {}，速率 {:.2}x",
                    segment_duration, media_time, rate
                )
            };
            fields.push(BoxField::new(
                &format!("entry[{}]", idx),
                format!(
                    "duration={}, media_time={}, rate={:.2}",
                    segment_duration, media_time, rate
                ),
                &desc,
            ));
        }
        Ok((fields, Some(start)))
    }
}

/// 轨道信息
#[derive(Debug, Clone)]
struct StreamingTrack {
    track_type: TrackType,
    track_id: u32,
    timescale: u32,
    codec: Codec,
    // Sample 元数据（不含数据）
    samples: Vec<SampleMetadata>,
    width: Option<u32>,
    height: Option<u32>,
    // 初始化数据偏移和大小
    init_data_offset: Option<u64>,
    init_data_size: Option<u32>,
    // chunk offsets
    chunk_offsets: Vec<u64>,
    // stsc entries
    stsc_entries: Vec<StscEntry>,
}

/// Sample 元数据（不含实际数据）
#[derive(Debug, Clone)]
struct SampleMetadata {
    offset: u64,
    size: u32,
    dts: u64,      // timescale 单位
    duration: u32, // timescale 单位
    cts_offset: i32,
    is_sync: bool,
    sample_desc_index: u32,
}

/// 流式 MP4 解析器
#[wasm_bindgen]
pub struct StreamingMp4Parser {
    file_size: u64,
    read_callback: Function,
    tracks: Vec<StreamingTrack>,
    // 合并后的 sample 索引
    merged_samples: Vec<(usize, usize)>, // (track_idx, sample_idx)
    // 容器信息
    duration_ms: u64,
    has_video: bool,
    has_audio: bool,
    video_codec: Option<Codec>,
    audio_codec: Option<Codec>,
    width: Option<u32>,
    height: Option<u32>,
    // moov box 数据（缓存用于详情查看）
    moov_data: Option<Vec<u8>>,
    moov_offset: u64,
    moov_size: u64,
    // 初始化数据（avcC/hvcC）
    video_init_data: Option<Vec<u8>>,
    audio_init_data: Option<Vec<u8>>,
    box_tree_total_count: Option<usize>,
}

#[wasm_bindgen]
impl StreamingMp4Parser {
    /// 创建新的流式解析器
    #[wasm_bindgen(constructor)]
    pub fn new(file_size: f64, read_callback: Function) -> Self {
        Self {
            file_size: file_size as u64,
            read_callback,
            tracks: Vec::new(),
            merged_samples: Vec::new(),
            duration_ms: 0,
            has_video: false,
            has_audio: false,
            video_codec: None,
            audio_codec: None,
            width: None,
            height: None,
            moov_data: None,
            moov_offset: 0,
            moov_size: 0,
            video_init_data: None,
            audio_init_data: None,
            box_tree_total_count: None,
        }
    }

    /// 解析文件结构（只读取元数据，不读取 sample 数据）
    #[wasm_bindgen]
    pub async fn parse(&mut self) -> Result<JsValue, JsError> {
        // 查找并解析 moov box
        self.find_and_parse_moov().await?;

        // 计算 sample offsets
        self.finalize_sample_offsets();

        // 合并 samples
        self.merge_samples();

        // 返回分析结果
        self.build_result()
    }

    /// 解析并直接缓存结果到 WASM 端，只返回元数据
    /// 这是性能优化版本 - 避免将完整结果序列化到 JS 再反序列化回来
    #[wasm_bindgen(js_name = parseAndCache)]
    pub async fn parse_and_cache(&mut self, file_id: String) -> Result<JsValue, JsError> {
        // 查找并解析 moov box
        self.find_and_parse_moov().await?;

        // 计算 sample offsets
        self.finalize_sample_offsets();

        // 合并 samples
        self.merge_samples();

        // 构建结果并直接缓存到 Rust HashMap（不经过 JS）
        let result = self.build_result_internal()?;
        crate::cache::cache_result_internal(file_id.clone(), result);

        // 只返回元数据
        crate::cache::get_metadata(file_id)
            .map_err(|e| JsError::new(&format!("获取元数据失败: {:?}", e)))
    }

    /// 获取 sample 总数
    #[wasm_bindgen(getter)]
    pub fn sample_count(&self) -> usize {
        self.merged_samples.len()
    }

    /// 读取指定 sample 的数据
    #[wasm_bindgen]
    pub async fn read_sample_data(&self, sample_index: usize) -> Result<Uint8Array, JsError> {
        if sample_index >= self.merged_samples.len() {
            return Err(JsError::new("Sample 索引超出范围"));
        }

        let (track_idx, local_sample_idx) = self.merged_samples[sample_index];
        let track = &self.tracks[track_idx];
        let sample = &track.samples[local_sample_idx];

        let data = self
            .read_range(sample.offset, sample.size as usize)
            .await
            .map_err(|e| JsError::new(&e))?;

        Ok(Uint8Array::from(data.as_slice()))
    }
}

impl StreamingMp4Parser {
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

    /// 查找并解析 moov box
    async fn find_and_parse_moov(&mut self) -> Result<(), JsError> {
        let mut pos = 0u64;

        // 扫描顶层 boxes 查找 moov
        while pos < self.file_size {
            // 读取 box 头部
            let header = self
                .read_range(pos, 8)
                .await
                .map_err(|e| JsError::new(&e))?;

            if header.len() < 8 {
                break;
            }

            let size = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as u64;
            let box_type: [u8; 4] = [header[4], header[5], header[6], header[7]];

            // 处理扩展大小
            let (box_size, header_size) = if size == 1 {
                let ext = self
                    .read_range(pos + 8, 8)
                    .await
                    .map_err(|e| JsError::new(&e))?;
                if ext.len() < 8 {
                    break;
                }
                let ext_size = u64::from_be_bytes([
                    ext[0], ext[1], ext[2], ext[3], ext[4], ext[5], ext[6], ext[7],
                ]);
                (ext_size, 16u64)
            } else if size == 0 {
                (self.file_size - pos, 8u64)
            } else {
                (size, 8u64)
            };

            if box_size < header_size || pos + box_size > self.file_size {
                break;
            }

            // 找到 moov box
            if box_type == BOX_MOOV {
                self.moov_offset = pos;
                self.moov_size = box_size;

                // 读取整个 moov box（通常几 MB）
                let content_size = (box_size - header_size) as usize;
                let moov_content = self
                    .read_range(pos + header_size, content_size)
                    .await
                    .map_err(|e| JsError::new(&e))?;

                // 解析 moov 内容
                self.parse_moov(&moov_content, pos + header_size)?;
                self.moov_data = Some(moov_content);

                return Ok(());
            }

            pos += box_size;
        }

        Err(JsError::new("未找到 moov box"))
    }

    /// 解析 moov box 内容
    fn parse_moov(&mut self, data: &[u8], base_offset: u64) -> Result<(), JsError> {
        let mut pos = 0usize;

        while pos + 8 <= data.len() {
            let size = u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]])
                as usize;
            let box_type: [u8; 4] = [data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]];

            if size < 8 || pos + size > data.len() {
                break;
            }

            let content_start = pos + 8;
            let content_end = pos + size;
            let content = &data[content_start..content_end];

            match &box_type {
                b"mvhd" => {
                    // 可选：解析全局时间刻度
                }
                b"trak" => {
                    self.parse_trak(content)?;
                }
                _ => {}
            }

            pos += size;
        }

        Ok(())
    }

    /// 解析 trak box
    fn parse_trak(&mut self, data: &[u8]) -> Result<(), JsError> {
        // 创建新轨道
        self.tracks.push(StreamingTrack {
            track_type: TrackType::Other,
            track_id: self.tracks.len() as u32 + 1,
            timescale: 1000,
            codec: Codec::Unknown("unknown".to_string()),
            samples: Vec::new(),
            width: None,
            height: None,
            init_data_offset: None,
            init_data_size: None,
            chunk_offsets: Vec::new(),
            stsc_entries: Vec::new(),
        });

        self.parse_container_box(data)?;

        Ok(())
    }

    /// 递归解析容器 box
    fn parse_container_box(&mut self, data: &[u8]) -> Result<(), JsError> {
        let mut pos = 0usize;

        while pos + 8 <= data.len() {
            let size = u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]])
                as usize;
            let box_type: [u8; 4] = [data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]];

            if size < 8 || pos + size > data.len() {
                break;
            }

            let content = &data[pos + 8..pos + size];

            match &box_type {
                b"mdia" | b"minf" | b"stbl" => {
                    self.parse_container_box(content)?;
                }
                b"mdhd" => {
                    self.parse_mdhd(content)?;
                }
                b"hdlr" => {
                    self.parse_hdlr(content)?;
                }
                b"stsd" => {
                    self.parse_stsd(content)?;
                }
                b"stts" => {
                    self.parse_stts(content)?;
                }
                b"stsc" => {
                    self.parse_stsc(content)?;
                }
                b"stsz" => {
                    self.parse_stsz(content)?;
                }
                b"stco" => {
                    self.parse_stco(content, false)?;
                }
                b"co64" => {
                    self.parse_stco(content, true)?;
                }
                b"stss" => {
                    self.parse_stss(content)?;
                }
                b"ctts" => {
                    self.parse_ctts(content)?;
                }
                _ => {}
            }

            pos += size;
        }

        Ok(())
    }

    fn parse_mdhd(&mut self, data: &[u8]) -> Result<(), JsError> {
        if data.len() < 4 {
            return Ok(());
        }

        let version = data[0];
        let timescale = if version == 1 && data.len() >= 24 {
            u32::from_be_bytes([data[20], data[21], data[22], data[23]])
        } else if data.len() >= 16 {
            u32::from_be_bytes([data[12], data[13], data[14], data[15]])
        } else {
            1000
        };

        if let Some(track) = self.tracks.last_mut() {
            track.timescale = timescale;
        }

        Ok(())
    }

    fn parse_hdlr(&mut self, data: &[u8]) -> Result<(), JsError> {
        if data.len() < 12 {
            return Ok(());
        }

        let handler_type: [u8; 4] = [data[8], data[9], data[10], data[11]];
        let track_type = match &handler_type {
            b"vide" => TrackType::Video,
            b"soun" => TrackType::Audio,
            _ => TrackType::Other,
        };

        if let Some(track) = self.tracks.last_mut() {
            track.track_type = track_type;
        }

        Ok(())
    }

    fn extract_box_payload(data: &[u8], target: [u8; 4]) -> Option<Vec<u8>> {
        if data.len() < 8 {
            return None;
        }

        let mut pos = 0usize;
        while pos + 8 <= data.len() {
            let size = u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]])
                as usize;
            if size < 8 || pos + size > data.len() {
                pos += 1;
                continue;
            }
            let box_type = [data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]];
            if box_type == target {
                return Some(data[pos + 8..pos + size].to_vec());
            }
            pos += size;
        }

        None
    }

    fn parse_descriptor_size(data: &[u8], pos: &mut usize) -> Option<usize> {
        let mut size = 0usize;
        for _ in 0..4 {
            if *pos >= data.len() {
                return None;
            }
            let b = data[*pos];
            *pos += 1;
            size = (size << 7) | (b & 0x7F) as usize;
            if b & 0x80 == 0 {
                return Some(size);
            }
        }
        Some(size)
    }

    fn parse_esds_audio_config(data: &[u8]) -> Option<Vec<u8>> {
        if data.len() < 4 {
            return None;
        }
        let mut pos = 4usize; // version + flags
        while pos < data.len() {
            let tag = data[pos];
            pos += 1;
            let size = Self::parse_descriptor_size(data, &mut pos)?;
            if pos + size > data.len() {
                break;
            }
            if tag == 0x05 {
                return Some(data[pos..pos + size].to_vec());
            }
            pos += size;
        }
        None
    }

    fn extract_esds_audio_config(data: &[u8]) -> Option<Vec<u8>> {
        let payload = Self::extract_box_payload(data, BOX_ESDS)?;
        Self::parse_esds_audio_config(&payload)
    }

    fn parse_stsd(&mut self, data: &[u8]) -> Result<(), JsError> {
        if data.len() < 16 {
            return Ok(());
        }

        let entry_count = u32::from_be_bytes([data[4], data[5], data[6], data[7]]) as usize;
        let mut pos = 8usize;

        for entry_index in 0..entry_count {
            if pos + 8 > data.len() {
                break;
            }
            let entry_size =
                u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as usize;
            if entry_size < 8 || pos + entry_size > data.len() {
                break;
            }

            let entry_type: [u8; 4] =
                [data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]];
            let codec = Codec::from(&entry_type);

            if entry_index == 0 {
                if let Some(track) = self.tracks.last_mut() {
                    track.codec = codec.clone();

                    // 视频条目: 解析宽高
                    if matches!(codec, Codec::H264 | Codec::H265) && entry_size >= 36 {
                        track.width = Some(
                            u16::from_be_bytes([data[pos + 32], data[pos + 33]]) as u32,
                        );
                        track.height = Some(
                            u16::from_be_bytes([data[pos + 34], data[pos + 35]]) as u32,
                        );

                        self.has_video = true;
                        self.video_codec = Some(codec.clone());
                        self.width = track.width;
                        self.height = track.height;
                    }

                    if matches!(track.codec, Codec::Aac) {
                        self.has_audio = true;
                        self.audio_codec = Some(track.codec.clone());
                    }
                }
            }

            if matches!(codec, Codec::H264 | Codec::H265) && self.video_init_data.is_none() {
                let target = if matches!(codec, Codec::H265) {
                    BOX_HVCC
                } else {
                    BOX_AVCC
                };

                let entry_payload = &data[pos + 8..pos + entry_size];
                let mut config = None;
                if entry_payload.len() > 78 {
                    config = Self::extract_box_payload(&entry_payload[78..], target);
                }
                if config.is_none() {
                    config = Self::extract_box_payload(entry_payload, target);
                }
                if let Some(config) = config {
                    self.video_init_data = Some(config);
                }
            }

            if matches!(codec, Codec::Aac) && self.audio_init_data.is_none() {
                let entry_payload = &data[pos + 8..pos + entry_size];
                let mut config = None;
                if entry_payload.len() > 28 {
                    config = Self::extract_esds_audio_config(&entry_payload[28..]);
                }
                if config.is_none() {
                    config = Self::extract_esds_audio_config(entry_payload);
                }
                if let Some(config) = config {
                    self.audio_init_data = Some(config);
                }
            }

            pos += entry_size;
        }

        Ok(())
    }

    fn parse_stts(&mut self, data: &[u8]) -> Result<(), JsError> {
        if data.len() < 8 {
            return Ok(());
        }

        let entry_count = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);

        let track = match self.tracks.last_mut() {
            Some(t) => t,
            None => return Ok(()),
        };

        let mut dts: u64 = 0;
        let mut pos = 8;

        for _ in 0..entry_count {
            if pos + 8 > data.len() {
                break;
            }
            let sample_count =
                u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]);
            let sample_delta =
                u32::from_be_bytes([data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]]);
            pos += 8;

            for _ in 0..sample_count {
                track.samples.push(SampleMetadata {
                    offset: 0,
                    size: 0,
                    dts,
                    duration: sample_delta,
                    cts_offset: 0,
                    is_sync: false,
                    sample_desc_index: 1,
                });
                dts += sample_delta as u64;
            }
        }

        // 计算时长
        if let Some(track) = self.tracks.last() {
            if let Some(last) = track.samples.last() {
                if track.timescale > 0 {
                    let duration = last.dts * 1000 / track.timescale as u64;
                    if duration > self.duration_ms {
                        self.duration_ms = duration;
                    }
                }
            }
        }

        Ok(())
    }

    fn parse_stsc(&mut self, data: &[u8]) -> Result<(), JsError> {
        if data.len() < 8 {
            return Ok(());
        }

        let entry_count = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);

        let track = match self.tracks.last_mut() {
            Some(t) => t,
            None => return Ok(()),
        };

        let mut pos = 8;
        for _ in 0..entry_count {
            if pos + 12 > data.len() {
                break;
            }
            let first_chunk =
                u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]);
            let samples_per_chunk =
                u32::from_be_bytes([data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]]);
            let sample_desc_index =
                u32::from_be_bytes([data[pos + 8], data[pos + 9], data[pos + 10], data[pos + 11]]);
            pos += 12;

            track.stsc_entries.push(StscEntry {
                first_chunk,
                samples_per_chunk,
                sample_desc_index,
            });
        }

        Ok(())
    }

    fn parse_stsz(&mut self, data: &[u8]) -> Result<(), JsError> {
        if data.len() < 12 {
            return Ok(());
        }

        let sample_size = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
        let sample_count = u32::from_be_bytes([data[8], data[9], data[10], data[11]]);

        let track = match self.tracks.last_mut() {
            Some(t) => t,
            None => return Ok(()),
        };

        if sample_size > 0 {
            for sample in track.samples.iter_mut() {
                sample.size = sample_size;
            }
        } else {
            let mut pos = 12;
            for i in 0..sample_count as usize {
                if pos + 4 > data.len() || i >= track.samples.len() {
                    break;
                }
                track.samples[i].size =
                    u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]);
                pos += 4;
            }
        }

        Ok(())
    }

    fn parse_stco(&mut self, data: &[u8], is_64bit: bool) -> Result<(), JsError> {
        if data.len() < 8 {
            return Ok(());
        }

        let chunk_count = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);

        let track = match self.tracks.last_mut() {
            Some(t) => t,
            None => return Ok(()),
        };

        let mut pos = 8;
        let entry_size = if is_64bit { 8 } else { 4 };

        for _ in 0..chunk_count {
            if pos + entry_size > data.len() {
                break;
            }

            let offset = if is_64bit {
                u64::from_be_bytes([
                    data[pos],
                    data[pos + 1],
                    data[pos + 2],
                    data[pos + 3],
                    data[pos + 4],
                    data[pos + 5],
                    data[pos + 6],
                    data[pos + 7],
                ])
            } else {
                u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as u64
            };

            track.chunk_offsets.push(offset);
            pos += entry_size;
        }

        Ok(())
    }

    fn parse_stss(&mut self, data: &[u8]) -> Result<(), JsError> {
        if data.len() < 8 {
            return Ok(());
        }

        let entry_count = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);

        let track = match self.tracks.last_mut() {
            Some(t) => t,
            None => return Ok(()),
        };

        let mut pos = 8;
        for _ in 0..entry_count {
            if pos + 4 > data.len() {
                break;
            }
            let sample_number =
                u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]])
                    as usize;
            pos += 4;

            if sample_number > 0 && sample_number <= track.samples.len() {
                track.samples[sample_number - 1].is_sync = true;
            }
        }

        Ok(())
    }

    fn parse_ctts(&mut self, data: &[u8]) -> Result<(), JsError> {
        if data.len() < 8 {
            return Ok(());
        }

        let version = data[0];
        let entry_count = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);

        let track = match self.tracks.last_mut() {
            Some(t) => t,
            None => return Ok(()),
        };

        let mut sample_idx = 0;
        let mut pos = 8;

        for _ in 0..entry_count {
            if pos + 8 > data.len() {
                break;
            }

            let sample_count =
                u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]);
            let cts_offset = if version == 0 {
                u32::from_be_bytes([data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]])
                    as i32
            } else {
                i32::from_be_bytes([data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]])
            };
            pos += 8;

            for _ in 0..sample_count {
                if sample_idx < track.samples.len() {
                    track.samples[sample_idx].cts_offset = cts_offset;
                }
                sample_idx += 1;
            }
        }

        Ok(())
    }

    /// 计算每个 sample 的文件偏移
    fn finalize_sample_offsets(&mut self) {
        for track in self.tracks.iter_mut() {
            if track.chunk_offsets.is_empty() || track.samples.is_empty() {
                continue;
            }

            if !track.stsc_entries.is_empty() {
                let mut sample_idx = 0;
                let mut next_stsc_idx = 0;
                let mut samples_per_chunk = 0;
                let mut current_desc_index = 1;

                for (chunk_idx, &chunk_offset) in track.chunk_offsets.iter().enumerate() {
                    let chunk_num = chunk_idx as u32 + 1;

                    while next_stsc_idx < track.stsc_entries.len()
                        && chunk_num >= track.stsc_entries[next_stsc_idx].first_chunk
                    {
                        let entry = track.stsc_entries[next_stsc_idx];
                        samples_per_chunk = entry.samples_per_chunk;
                        current_desc_index = if entry.sample_desc_index == 0 {
                            1
                        } else {
                            entry.sample_desc_index
                        };
                        next_stsc_idx += 1;
                    }

                    let mut current_offset = chunk_offset;
                    for _ in 0..samples_per_chunk {
                        if sample_idx >= track.samples.len() {
                            break;
                        }
                        track.samples[sample_idx].offset = current_offset;
                        track.samples[sample_idx].sample_desc_index = current_desc_index;
                        current_offset += track.samples[sample_idx].size as u64;
                        sample_idx += 1;
                    }
                }
            }
        }
    }

    /// 合并所有轨道的 samples
    fn merge_samples(&mut self) {
        self.merged_samples.clear();

        for (track_idx, track) in self.tracks.iter().enumerate() {
            for sample_idx in 0..track.samples.len() {
                self.merged_samples.push((track_idx, sample_idx));
            }
        }

        // 按 DTS 排序
        let tracks = &self.tracks;
        self.merged_samples.sort_by(|a, b| {
            let dts_a = tracks[a.0].samples[a.1].dts;
            let dts_b = tracks[b.0].samples[b.1].dts;
            dts_a.cmp(&dts_b)
        });
    }

    /// 构建分析结果
    fn build_result(&self) -> Result<JsValue, JsError> {
        let mut tags = Vec::new();
        let mut video_timeline = Vec::new();
        let mut audio_timeline = Vec::new();
        let mut gops = Vec::new();
        let mut video_tag_count = 0usize;
        let mut audio_tag_count = 0usize;
        let mut keyframe_count = 0usize;
        let mut current_gop_start: Option<usize> = None;
        let mut gop_start_time = 0.0f64;

        for (idx, &(track_idx, sample_idx)) in self.merged_samples.iter().enumerate() {
            let track = &self.tracks[track_idx];
            let sample = &track.samples[sample_idx];

            let dts_ms = if track.timescale > 0 {
                (sample.dts * 1000 / track.timescale as u64) as u32
            } else {
                sample.dts as u32
            };

            let pts_ms = if track.timescale > 0 {
                dts_ms.wrapping_add((sample.cts_offset * 1000 / track.timescale as i32) as u32)
            } else {
                dts_ms
            };

            let duration_ms = if track.timescale > 0 {
                Some((sample.duration as f64 * 1000.0) / track.timescale as f64)
            } else {
                None
            };

            let is_video = track.track_type == TrackType::Video;
            let is_keyframe = sample.is_sync && is_video;

            // GOP 检测
            let gop_index = if is_video {
                if is_keyframe && current_gop_start.is_some() {
                    // 保存上一个 GOP
                    let prev_gop_start = current_gop_start.unwrap();
                    let gop_frame_count = video_tag_count - prev_gop_start;
                    if !gops.is_empty() {
                        let last_gop: &mut Gop = gops.last_mut().unwrap();
                        last_gop.end_index = idx.saturating_sub(1);
                        last_gop.frame_count = gop_frame_count;
                        last_gop.duration = dts_ms as f64 / 1000.0 - gop_start_time;
                    }
                }

                if is_keyframe {
                    current_gop_start = Some(video_tag_count);
                    gop_start_time = dts_ms as f64 / 1000.0;

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

            if is_video {
                video_tag_count += 1;
                if is_keyframe {
                    keyframe_count += 1;
                }

                video_timeline.push(TimelinePoint {
                    index: idx,
                    timestamp: dts_ms as f64 / 1000.0,
                    dts: dts_ms as f64 / 1000.0,
                    pts: pts_ms as f64 / 1000.0,
                    duration: duration_ms,
                });
            } else if track.track_type == TrackType::Audio {
                audio_tag_count += 1;

                audio_timeline.push(TimelinePoint {
                    index: idx,
                    timestamp: dts_ms as f64 / 1000.0,
                    dts: dts_ms as f64 / 1000.0,
                    pts: pts_ms as f64 / 1000.0,
                    duration: duration_ms,
                });
            }

            let tag_summary = TagSummary {
                index: idx,
                tag_type: if is_video {
                    "video".to_string()
                } else {
                    "audio".to_string()
                },
                timestamp: dts_ms,
                size: sample.size,
                offset: sample.offset,
                is_keyframe,
                is_seq_header: false,
                frame_type: if is_keyframe { Some(1) } else { Some(2) },
                codec_id: match track.codec {
                    Codec::H264 => Some(7),
                    Codec::H265 => Some(12),
                    _ => None,
                },
                gop_index,
                description: Some(format!(
                    "{} {}",
                    track.codec.as_str(),
                    if is_keyframe { "keyframe" } else { "frame" }
                )),
                mp4_info: Some(Mp4SampleInfo {
                    track_id: track.track_id,
                    sample_index: sample_idx as u32,
                    sample_desc_index: Some(sample.sample_desc_index),
                }),
                has_sei: false,
                is_sps_pps_change: false,
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

        let result = AnalysisResult {
            format: "mp4".to_string(),
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
            script_tag_count: 0,
            keyframe_count,
            anomalies: Vec::new(),
            video_init_data: self.video_init_data.clone(),
            video_init_data_list: None, // 流式解析暂不支持多配置
            audio_init_data: self.audio_init_data.clone(),
            segments: None,
        };

        // 计算分段信息
        let mut result_mut = result;
        result_mut.segments = crate::splitter::compute_segments(&result_mut);

        serde_wasm_bindgen::to_value(&result_mut)
            .map_err(|e| JsError::new(&format!("序列化结果失败: {}", e)))
    }

    /// 构建分析结果（内部版本，返回 Rust 结构体）
    /// 用于 parse_and_cache，避免序列化/反序列化开销
    fn build_result_internal(&self) -> Result<AnalysisResult, JsError> {
        let mut tags = Vec::new();
        let mut video_timeline = Vec::new();
        let mut audio_timeline = Vec::new();
        let mut gops = Vec::new();
        let mut video_tag_count = 0usize;
        let mut audio_tag_count = 0usize;
        let mut keyframe_count = 0usize;
        let mut current_gop_start: Option<usize> = None;
        let mut gop_start_time = 0.0f64;

        for (idx, &(track_idx, sample_idx)) in self.merged_samples.iter().enumerate() {
            let track = &self.tracks[track_idx];
            let sample = &track.samples[sample_idx];

            let dts_ms = if track.timescale > 0 {
                (sample.dts * 1000 / track.timescale as u64) as u32
            } else {
                sample.dts as u32
            };

            let pts_ms = if track.timescale > 0 {
                dts_ms.wrapping_add((sample.cts_offset * 1000 / track.timescale as i32) as u32)
            } else {
                dts_ms
            };

            let duration_ms = if track.timescale > 0 {
                Some((sample.duration as f64 * 1000.0) / track.timescale as f64)
            } else {
                None
            };

            let is_video = track.track_type == TrackType::Video;
            let is_keyframe = sample.is_sync && is_video;

            let gop_index = if is_video {
                if is_keyframe && current_gop_start.is_some() {
                    let prev_gop_start = current_gop_start.unwrap();
                    let gop_frame_count = video_tag_count - prev_gop_start;
                    if !gops.is_empty() {
                        let last_gop: &mut Gop = gops.last_mut().unwrap();
                        last_gop.end_index = idx.saturating_sub(1);
                        last_gop.frame_count = gop_frame_count;
                        last_gop.duration = dts_ms as f64 / 1000.0 - gop_start_time;
                    }
                }
                if is_keyframe {
                    current_gop_start = Some(video_tag_count);
                    gop_start_time = dts_ms as f64 / 1000.0;
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

            if is_video {
                video_tag_count += 1;
                if is_keyframe {
                    keyframe_count += 1;
                }
                video_timeline.push(TimelinePoint {
                    index: idx,
                    timestamp: dts_ms as f64 / 1000.0,
                    dts: dts_ms as f64 / 1000.0,
                    pts: pts_ms as f64 / 1000.0,
                    duration: duration_ms,
                });
            } else if track.track_type == TrackType::Audio {
                audio_tag_count += 1;
                audio_timeline.push(TimelinePoint {
                    index: idx,
                    timestamp: dts_ms as f64 / 1000.0,
                    dts: dts_ms as f64 / 1000.0,
                    pts: pts_ms as f64 / 1000.0,
                    duration: duration_ms,
                });
            }

            tags.push(TagSummary {
                index: idx,
                tag_type: if is_video { "video".to_string() } else { "audio".to_string() },
                timestamp: dts_ms,
                size: sample.size,
                offset: sample.offset,
                is_keyframe,
                is_seq_header: false,
                frame_type: if is_keyframe { Some(1) } else { Some(2) },
                codec_id: match track.codec {
                    Codec::H264 => Some(7),
                    Codec::H265 => Some(12),
                    _ => None,
                },
                gop_index,
                description: Some(format!(
                    "{} {}",
                    track.codec.as_str(),
                    if is_keyframe { "keyframe" } else { "frame" }
                )),
                mp4_info: Some(Mp4SampleInfo {
                    track_id: track.track_id,
                    sample_index: sample_idx as u32,
                    sample_desc_index: Some(sample.sample_desc_index),
                }),
                has_sei: false,
                is_sps_pps_change: false,
            });
        }

        if let Some(last_gop) = gops.last_mut() {
            if let Some(last_tag) = tags.last() {
                last_gop.end_index = tags.len() - 1;
                last_gop.frame_count = video_tag_count - current_gop_start.unwrap_or(0);
                last_gop.duration = last_tag.timestamp as f64 / 1000.0 - gop_start_time;
            }
        }

        let mut result = AnalysisResult {
            format: "mp4".to_string(),
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
            script_tag_count: 0,
            keyframe_count,
            anomalies: Vec::new(),
            video_init_data: self.video_init_data.clone(),
            video_init_data_list: None,
            audio_init_data: self.audio_init_data.clone(),
            segments: None,
        };

        result.segments = crate::splitter::compute_segments(&result);
        Ok(result)
    }
}
