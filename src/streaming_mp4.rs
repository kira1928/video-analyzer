//! 流式 MP4 解析器
//!
//! 支持按需读取大文件，不需要将整个文件加载到内存

use crate::container::{Codec, ContainerFormat};
use crate::types::*;
use js_sys::{Function, Promise, Uint8Array};
use wasm_bindgen::prelude::*;
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

    fn parse_stsd(&mut self, data: &[u8]) -> Result<(), JsError> {
        if data.len() < 16 {
            return Ok(());
        }

        // 跳过 version + flags + entry_count
        let entry_type: [u8; 4] = [data[12], data[13], data[14], data[15]];
        let codec = Codec::from(&entry_type);

        if let Some(track) = self.tracks.last_mut() {
            track.codec = codec.clone();

            // 对于视频，解析宽高
            if matches!(codec, Codec::H264 | Codec::H265) && data.len() >= 40 {
                track.width = Some(u16::from_be_bytes([data[32], data[33]]) as u32);
                track.height = Some(u16::from_be_bytes([data[34], data[35]]) as u32);

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

        if matches!(codec, Codec::H264 | Codec::H265) && self.video_init_data.is_none() {
            let target = if matches!(codec, Codec::H265) {
                BOX_HVCC
            } else {
                BOX_AVCC
            };
            if let Some(config) = Self::extract_box_payload(data, target) {
                self.video_init_data = Some(config);
            }
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
}
