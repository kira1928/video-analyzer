//! MP4 容器实现
//!
//! 支持标准 MP4/M4A/MOV 格式解析

use super::sample::FrameType;
use super::{
    Codec, ContainerFormat, ContainerInfo, ContainerReader, ContainerSpecificInfo, MediaSample,
    SampleType,
};
use std::io::{Cursor, Read, Seek, SeekFrom};

/// MP4 Box 类型
const BOX_FTYP: [u8; 4] = *b"ftyp";
const BOX_MOOV: [u8; 4] = *b"moov";
const BOX_MDAT: [u8; 4] = *b"mdat";
const BOX_TRAK: [u8; 4] = *b"trak";
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
const BOX_AVC1: [u8; 4] = *b"avc1";
const BOX_HVC1: [u8; 4] = *b"hvc1";
const BOX_HEV1: [u8; 4] = *b"hev1";
const BOX_MP4A: [u8; 4] = *b"mp4a";
const BOX_AVCC: [u8; 4] = *b"avcC";
const BOX_HVCC: [u8; 4] = *b"hvcC";

/// 轨道类型
#[derive(Debug, Clone, Copy, PartialEq)]
enum TrackType {
    Video,
    Audio,
    Other,
}

/// Sample 位置信息
#[derive(Debug, Clone)]
struct SampleInfo {
    offset: u64,
    size: u32,
    dts: u64,               // 以 timescale 为单位
    duration: u32,          // 以 timescale 为单位
    cts_offset: i32,        // composition time offset
    is_sync: bool,          // 是否为同步帧（关键帧）
    sample_desc_index: u32, // sample description index (1-based)
}

/// stsc entry (Sample To Chunk)
#[derive(Debug, Clone, Copy)]
struct StscEntry {
    first_chunk: u32,
    samples_per_chunk: u32,
    sample_desc_index: u32,
}

/// 轨道信息
#[derive(Debug, Clone)]
struct Track {
    track_type: TrackType,
    track_id: u32,
    timescale: u32,
    codec: Codec,
    samples: Vec<SampleInfo>,
    width: Option<u32>,
    height: Option<u32>,
    // 初始化数据列表（如 avcC, hvcC），索引对应 sample_desc_index - 1
    init_data_list: Vec<Vec<u8>>,
    // chunk offsets (用于延迟计算 sample offset)
    chunk_offsets: Vec<u64>,
    // Sample To Chunk 表
    stsc_entries: Vec<StscEntry>,
}

/// MP4 容器读取器
pub struct Mp4Container<R: Read + Seek> {
    reader: R,
    info: Option<ContainerInfo>,
    tracks: Vec<Track>,
    // 当前播放位置
    current_track_idx: usize,
    current_sample_idx: usize,
    // 合并后的 sample 列表（按时间排序）
    merged_samples: Vec<(usize, usize)>, // (track_idx, sample_idx)
    merged_idx: usize,
    // 是否已解析
    parsed: bool,
}

impl<R: Read + Seek> Mp4Container<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            info: None,
            tracks: Vec::new(),
            current_track_idx: 0,
            current_sample_idx: 0,
            merged_samples: Vec::new(),
            merged_idx: 0,
            parsed: false,
        }
    }

    /// 解析 MP4 结构
    fn parse(&mut self) -> Result<(), String> {
        if self.parsed {
            return Ok(());
        }

        self.reader
            .seek(SeekFrom::Start(0))
            .map_err(|e| e.to_string())?;

        // 获取文件大小
        let file_size = self
            .reader
            .seek(SeekFrom::End(0))
            .map_err(|e| e.to_string())?;
        self.reader
            .seek(SeekFrom::Start(0))
            .map_err(|e| e.to_string())?;

        // 解析顶层 boxes
        self.parse_boxes(0, file_size)?;

        // 根据 chunk offsets 和 sample sizes 计算每个 sample 的准确 offset
        self.finalize_sample_offsets();

        // 合并所有 tracks 的 samples 并按 DTS 排序
        self.merge_samples();

        self.parsed = true;
        Ok(())
    }

    /// 解析 boxes
    fn parse_boxes(&mut self, start: u64, end: u64) -> Result<(), String> {
        let mut pos = start;

        while pos < end {
            self.reader
                .seek(SeekFrom::Start(pos))
                .map_err(|e| e.to_string())?;

            // 读取 box 头
            let mut header = [0u8; 8];
            if self.reader.read_exact(&mut header).is_err() {
                break;
            }

            let size = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as u64;
            let box_type: [u8; 4] = [header[4], header[5], header[6], header[7]];

            // 处理扩展大小
            let (box_size, header_size) = if size == 1 {
                let mut ext = [0u8; 8];
                self.reader
                    .read_exact(&mut ext)
                    .map_err(|e| e.to_string())?;
                (u64::from_be_bytes(ext), 16u64)
            } else if size == 0 {
                (end - pos, 8u64)
            } else {
                (size, 8u64)
            };

            let box_start = pos;
            let box_end = pos + box_size;
            let content_start = pos + header_size;

            // 处理不同类型的 box
            match &box_type {
                b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl" => {
                    // 容器 box，递归解析
                    self.parse_boxes(content_start, box_end)?;
                }
                b"mdhd" => {
                    self.parse_mdhd(content_start)?;
                }
                b"hdlr" => {
                    self.parse_hdlr(content_start)?;
                }
                b"stsd" => {
                    self.parse_stsd(content_start, box_end)?;
                }
                b"stts" => {
                    self.parse_stts(content_start)?;
                }
                b"stsc" => {
                    self.parse_stsc(content_start)?;
                }
                b"stsz" => {
                    self.parse_stsz(content_start)?;
                }
                b"stco" => {
                    self.parse_stco(content_start, false)?;
                }
                b"co64" => {
                    self.parse_stco(content_start, true)?;
                }
                b"stss" => {
                    self.parse_stss(content_start)?;
                }
                b"ctts" => {
                    self.parse_ctts(content_start)?;
                }
                _ => {}
            }

            // 如果遇到 trak 结束，保存当前轨道
            if box_type == *b"trak" {
                // 轨道解析完成
            }

            pos = box_end;
        }

        Ok(())
    }

    fn parse_mdhd(&mut self, pos: u64) -> Result<(), String> {
        self.reader
            .seek(SeekFrom::Start(pos))
            .map_err(|e| e.to_string())?;

        let mut buf = [0u8; 4];
        self.reader
            .read_exact(&mut buf)
            .map_err(|e| e.to_string())?;
        let version = buf[0];

        let timescale = if version == 1 {
            // 64 位版本
            let mut skip = [0u8; 16]; // 跳过 creation/modification time
            self.reader.read_exact(&mut skip).ok();
            let mut ts = [0u8; 4];
            self.reader.read_exact(&mut ts).map_err(|e| e.to_string())?;
            u32::from_be_bytes(ts)
        } else {
            // 32 位版本
            let mut skip = [0u8; 8];
            self.reader.read_exact(&mut skip).ok();
            let mut ts = [0u8; 4];
            self.reader.read_exact(&mut ts).map_err(|e| e.to_string())?;
            u32::from_be_bytes(ts)
        };

        // 确保有当前轨道
        if self.tracks.is_empty() || self.tracks.last().unwrap().timescale > 0 {
            self.tracks.push(Track {
                track_type: TrackType::Other,
                track_id: self.tracks.len() as u32 + 1,
                timescale,
                codec: Codec::Unknown("unknown".to_string()),
                samples: Vec::new(),
                width: None,
                height: None,
                init_data_list: Vec::new(),
                chunk_offsets: Vec::new(),
                stsc_entries: Vec::new(),
            });
        } else {
            self.tracks.last_mut().unwrap().timescale = timescale;
        }

        Ok(())
    }

    fn parse_hdlr(&mut self, pos: u64) -> Result<(), String> {
        self.reader
            .seek(SeekFrom::Start(pos + 8))
            .map_err(|e| e.to_string())?;

        let mut handler_type = [0u8; 4];
        self.reader
            .read_exact(&mut handler_type)
            .map_err(|e| e.to_string())?;

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

    fn parse_stsd(&mut self, pos: u64, end: u64) -> Result<(), String> {
        self.reader
            .seek(SeekFrom::Start(pos))
            .map_err(|e| e.to_string())?;

        let mut header = [0u8; 8];
        self.reader
            .read_exact(&mut header)
            .map_err(|e| e.to_string())?;

        // version + flags (4 bytes) + entry_count (4 bytes)
        let entry_count = u32::from_be_bytes([header[4], header[5], header[6], header[7]]);

        #[cfg(target_arch = "wasm32")]
        web_sys::console::log_1(&format!("📦 stsd: entry_count={}", entry_count).into());

        if entry_count == 0 || pos + 8 >= end {
            return Ok(());
        }

        let track = match self.tracks.last_mut() {
            Some(t) => t,
            None => return Ok(()),
        };

        let mut cursor = pos + 8; // 跳过 stsd header (version+flags+count)

        // 解析所有 sample entries
        for entry_idx in 0..entry_count {
            if cursor + 8 > end {
                break;
            }

            self.reader
                .seek(SeekFrom::Start(cursor))
                .map_err(|e| e.to_string())?;

            let mut entry_header = [0u8; 8];
            if self.reader.read_exact(&mut entry_header).is_err() {
                break;
            }

            let entry_size = u32::from_be_bytes([
                entry_header[0],
                entry_header[1],
                entry_header[2],
                entry_header[3],
            ]) as u64;
            let entry_type: [u8; 4] = [
                entry_header[4],
                entry_header[5],
                entry_header[6],
                entry_header[7],
            ];

            if entry_size < 8 || cursor + entry_size > end {
                break;
            }

            let codec = Codec::from(&entry_type);

            // 第一个 entry 设置轨道的主 codec
            if entry_idx == 0 {
                track.codec = codec.clone();
            }

            #[cfg(target_arch = "wasm32")]
            {
                let type_str = String::from_utf8_lossy(&entry_type);
                web_sys::console::log_1(
                    &format!(
                        "  📀 sample entry {}: type='{}', size={}",
                        entry_idx + 1,
                        type_str,
                        entry_size
                    )
                    .into(),
                );
            }

            // 对于视频，解析宽高和 avcC/hvcC
            if matches!(codec, Codec::H264 | Codec::H265) {
                // 第一个 entry 设置宽高
                if entry_idx == 0 {
                    self.reader.seek(SeekFrom::Start(cursor + 24)).ok();
                    let mut dim = [0u8; 4];
                    if self.reader.read_exact(&mut dim).is_ok() {
                        track.width = Some(u16::from_be_bytes([dim[0], dim[1]]) as u32);
                        track.height = Some(u16::from_be_bytes([dim[2], dim[3]]) as u32);
                    }
                }

                // 查找 avcC 或 hvcC box
                let entry_start = cursor;
                let entry_end = cursor + entry_size;
                let mut current_pos = entry_start + 86; // 跳过 VisualSampleEntry 固定字段

                // 扫描内部 boxes
                let mut init_data: Option<Vec<u8>> = None;
                while current_pos + 8 < entry_end {
                    self.reader.seek(SeekFrom::Start(current_pos)).ok();
                    let mut box_header = [0u8; 8];
                    if self.reader.read_exact(&mut box_header).is_err() {
                        break;
                    }

                    let box_size = u32::from_be_bytes([
                        box_header[0],
                        box_header[1],
                        box_header[2],
                        box_header[3],
                    ]) as u64;
                    let box_type = [box_header[4], box_header[5], box_header[6], box_header[7]];

                    if box_size < 8 || current_pos + box_size > entry_end {
                        break;
                    }

                    // 检查是否是 avcC 或 hvcC
                    if box_type == BOX_AVCC || box_type == BOX_HVCC {
                        let data_size = (box_size - 8) as usize;
                        let mut config_data = vec![0u8; data_size];
                        if self.reader.read_exact(&mut config_data).is_ok() {
                            #[cfg(target_arch = "wasm32")]
                            {
                                let type_str = String::from_utf8_lossy(&box_type);
                                web_sys::console::log_1(
                                    &format!(
                                        "    ✅ 成功提取 {} 数据: {} bytes (entry {})",
                                        type_str,
                                        data_size,
                                        entry_idx + 1
                                    )
                                    .into(),
                                );
                            }
                            init_data = Some(config_data);
                            break;
                        }
                    }

                    current_pos += box_size;
                }

                // 将 init_data 添加到列表（即使为空也添加占位）
                track.init_data_list.push(init_data.unwrap_or_default());
            } else {
                // 非视频 entry，添加空数据占位
                track.init_data_list.push(Vec::new());
            }

            cursor += entry_size;
        }

        #[cfg(target_arch = "wasm32")]
        web_sys::console::log_1(
            &format!(
                "📦 stsd 解析完成: {} 个 init_data",
                track.init_data_list.len()
            )
            .into(),
        );

        Ok(())
    }

    fn parse_stts(&mut self, pos: u64) -> Result<(), String> {
        self.reader
            .seek(SeekFrom::Start(pos + 4))
            .map_err(|e| e.to_string())?;

        let mut count_buf = [0u8; 4];
        self.reader
            .read_exact(&mut count_buf)
            .map_err(|e| e.to_string())?;
        let entry_count = u32::from_be_bytes(count_buf);

        let track = match self.tracks.last_mut() {
            Some(t) => t,
            None => return Ok(()),
        };

        let mut dts: u64 = 0;
        for _ in 0..entry_count {
            let mut entry = [0u8; 8];
            if self.reader.read_exact(&mut entry).is_err() {
                break;
            }
            let sample_count = u32::from_be_bytes([entry[0], entry[1], entry[2], entry[3]]);
            let sample_delta = u32::from_be_bytes([entry[4], entry[5], entry[6], entry[7]]);

            for _ in 0..sample_count {
                track.samples.push(SampleInfo {
                    offset: 0,
                    size: 0,
                    dts,
                    duration: sample_delta,
                    cts_offset: 0,
                    is_sync: false,
                    sample_desc_index: 1, // 默认为 1，会在 finalize_sample_offsets 中更新
                });
                dts += sample_delta as u64;
            }
        }

        Ok(())
    }

    fn parse_stsc(&mut self, pos: u64) -> Result<(), String> {
        self.reader
            .seek(SeekFrom::Start(pos + 4))
            .map_err(|e| e.to_string())?;

        let mut count_buf = [0u8; 4];
        self.reader
            .read_exact(&mut count_buf)
            .map_err(|e| e.to_string())?;

        let entry_count = u32::from_be_bytes(count_buf);

        let track = match self.tracks.last_mut() {
            Some(t) => t,
            None => return Ok(()),
        };

        for _ in 0..entry_count {
            let mut entry = [0u8; 12];
            if self.reader.read_exact(&mut entry).is_err() {
                break;
            }

            let first_chunk = u32::from_be_bytes([entry[0], entry[1], entry[2], entry[3]]);
            let samples_per_chunk = u32::from_be_bytes([entry[4], entry[5], entry[6], entry[7]]);
            let sample_desc_index = u32::from_be_bytes([entry[8], entry[9], entry[10], entry[11]]);

            track.stsc_entries.push(StscEntry {
                first_chunk,
                samples_per_chunk,
                sample_desc_index,
            });
        }

        Ok(())
    }

    fn parse_stsz(&mut self, pos: u64) -> Result<(), String> {
        self.reader
            .seek(SeekFrom::Start(pos + 4))
            .map_err(|e| e.to_string())?;

        let mut header = [0u8; 8];
        self.reader
            .read_exact(&mut header)
            .map_err(|e| e.to_string())?;

        let sample_size = u32::from_be_bytes([header[0], header[1], header[2], header[3]]);
        let sample_count = u32::from_be_bytes([header[4], header[5], header[6], header[7]]);

        let track = match self.tracks.last_mut() {
            Some(t) => t,
            None => return Ok(()),
        };

        if sample_size > 0 {
            // 所有 sample 大小相同
            for sample in track.samples.iter_mut() {
                sample.size = sample_size;
            }
        } else {
            // 每个 sample 有独立大小
            for i in 0..sample_count as usize {
                let mut size_buf = [0u8; 4];
                if self.reader.read_exact(&mut size_buf).is_err() {
                    break;
                }
                if i < track.samples.len() {
                    track.samples[i].size = u32::from_be_bytes(size_buf);
                }
            }
        }

        Ok(())
    }

    fn parse_stco(&mut self, pos: u64, is_64bit: bool) -> Result<(), String> {
        self.reader
            .seek(SeekFrom::Start(pos + 4))
            .map_err(|e| e.to_string())?;

        let mut count_buf = [0u8; 4];
        self.reader
            .read_exact(&mut count_buf)
            .map_err(|e| e.to_string())?;
        let chunk_count = u32::from_be_bytes(count_buf);

        let track = match self.tracks.last_mut() {
            Some(t) => t,
            None => return Ok(()),
        };

        // 只存储 chunk offsets，稍后在 finalize_sample_offsets 中计算 sample offset
        for _ in 0..chunk_count {
            let offset = if is_64bit {
                let mut buf = [0u8; 8];
                if self.reader.read_exact(&mut buf).is_err() {
                    break;
                }
                u64::from_be_bytes(buf)
            } else {
                let mut buf = [0u8; 4];
                if self.reader.read_exact(&mut buf).is_err() {
                    break;
                }
                u32::from_be_bytes(buf) as u64
            };
            track.chunk_offsets.push(offset);
        }

        Ok(())
    }

    fn parse_stss(&mut self, pos: u64) -> Result<(), String> {
        self.reader
            .seek(SeekFrom::Start(pos + 4))
            .map_err(|e| e.to_string())?;

        let mut count_buf = [0u8; 4];
        self.reader
            .read_exact(&mut count_buf)
            .map_err(|e| e.to_string())?;
        let entry_count = u32::from_be_bytes(count_buf);

        let track = match self.tracks.last_mut() {
            Some(t) => t,
            None => return Ok(()),
        };

        for _ in 0..entry_count {
            let mut buf = [0u8; 4];
            if self.reader.read_exact(&mut buf).is_err() {
                break;
            }
            let sample_number = u32::from_be_bytes(buf) as usize;
            if sample_number > 0 && sample_number <= track.samples.len() {
                track.samples[sample_number - 1].is_sync = true;
            }
        }

        Ok(())
    }

    fn parse_ctts(&mut self, pos: u64) -> Result<(), String> {
        self.reader
            .seek(SeekFrom::Start(pos))
            .map_err(|e| e.to_string())?;

        let mut header = [0u8; 8];
        self.reader
            .read_exact(&mut header)
            .map_err(|e| e.to_string())?;

        let version = header[0];
        let entry_count = u32::from_be_bytes([header[4], header[5], header[6], header[7]]);

        let track = match self.tracks.last_mut() {
            Some(t) => t,
            None => return Ok(()),
        };

        let mut sample_idx = 0;
        for _ in 0..entry_count {
            let mut entry = [0u8; 8];
            if self.reader.read_exact(&mut entry).is_err() {
                break;
            }

            let sample_count = u32::from_be_bytes([entry[0], entry[1], entry[2], entry[3]]);
            let cts_offset = if version == 0 {
                u32::from_be_bytes([entry[4], entry[5], entry[6], entry[7]]) as i32
            } else {
                i32::from_be_bytes([entry[4], entry[5], entry[6], entry[7]])
            };

            for _ in 0..sample_count {
                if sample_idx < track.samples.len() {
                    track.samples[sample_idx].cts_offset = cts_offset;
                }
                sample_idx += 1;
            }
        }

        Ok(())
    }

    /// 根据 chunk offsets 和 sample sizes 计算每个 sample 的准确 offset
    fn finalize_sample_offsets(&mut self) {
        for track in self.tracks.iter_mut() {
            if track.chunk_offsets.is_empty() || track.samples.is_empty() {
                continue;
            }

            // 优先使用 stsc 表计算
            if !track.stsc_entries.is_empty() {
                let mut sample_idx = 0;
                let mut next_stsc_idx = 0;
                let mut samples_per_chunk = 0;
                let mut current_sample_desc_index: u32 = 1; // 默认为 1

                for (chunk_idx, &chunk_offset) in track.chunk_offsets.iter().enumerate() {
                    let chunk_num = chunk_idx as u32 + 1; // 1-based index

                    // 检查是否需要更新 samples_per_chunk 和 sample_desc_index
                    if next_stsc_idx < track.stsc_entries.len()
                        && chunk_num >= track.stsc_entries[next_stsc_idx].first_chunk
                    {
                        samples_per_chunk = track.stsc_entries[next_stsc_idx].samples_per_chunk;
                        current_sample_desc_index =
                            track.stsc_entries[next_stsc_idx].sample_desc_index;
                        next_stsc_idx += 1;

                        // 还要继续检查下一个 stsc entry 是否也是这个 chunk (虽然规范上 first_chunk 是递增)
                        while next_stsc_idx < track.stsc_entries.len()
                            && chunk_num >= track.stsc_entries[next_stsc_idx].first_chunk
                        {
                            samples_per_chunk = track.stsc_entries[next_stsc_idx].samples_per_chunk;
                            current_sample_desc_index =
                                track.stsc_entries[next_stsc_idx].sample_desc_index;
                            next_stsc_idx += 1;
                        }
                    }

                    let mut current_offset = chunk_offset;
                    for _ in 0..samples_per_chunk {
                        if sample_idx >= track.samples.len() {
                            break;
                        }

                        track.samples[sample_idx].offset = current_offset;
                        track.samples[sample_idx].sample_desc_index = current_sample_desc_index;
                        current_offset += track.samples[sample_idx].size as u64;
                        sample_idx += 1;
                    }
                }

                continue;
            }

            // Fallback: 如果没有 stsc 表 (不应该发生，但为了稳健性)
            // 如果只有一个 chunk 但有多个 samples，所有 samples 都在这个 chunk 中
            if track.chunk_offsets.len() == 1 {
                let mut current_offset = track.chunk_offsets[0];
                for sample in track.samples.iter_mut() {
                    sample.offset = current_offset;
                    current_offset += sample.size as u64;
                }
            } else if track.chunk_offsets.len() == track.samples.len() {
                // 每个 chunk 一个 sample
                for (i, offset) in track.chunk_offsets.iter().enumerate() {
                    track.samples[i].offset = *offset;
                }
            } else {
                // 多个 chunks，每个 chunk 有多个 samples
                // 假设 samples 均匀分布在 chunks 中
                let samples_per_chunk = (track.samples.len() + track.chunk_offsets.len() - 1)
                    / track.chunk_offsets.len();
                let mut sample_idx = 0;

                for chunk_offset in &track.chunk_offsets {
                    let mut current_offset = *chunk_offset;
                    for _ in 0..samples_per_chunk {
                        if sample_idx >= track.samples.len() {
                            break;
                        }
                        track.samples[sample_idx].offset = current_offset;
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
            for (sample_idx, _) in track.samples.iter().enumerate() {
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
}

impl<R: Read + Seek + 'static> ContainerReader for Mp4Container<R> {
    fn read_info(&mut self) -> Result<ContainerInfo, String> {
        self.parse()?;

        if let Some(ref info) = self.info {
            return Ok(info.clone());
        }

        let mut info = ContainerInfo {
            format: ContainerFormat::Mp4,
            ..Default::default()
        };

        for track in &self.tracks {
            match track.track_type {
                TrackType::Video => {
                    info.has_video = true;
                    info.video_codec = Some(track.codec.clone());
                    info.width = track.width;
                    info.height = track.height;

                    // 复制视频初始化数据 (avcC/hvcC)
                    // 如果有多个配置，设置 video_init_data_list
                    // video_init_data 设置为第一个非空配置（向后兼容）
                    if !track.init_data_list.is_empty() {
                        // 找到第一个非空配置
                        info.video_init_data =
                            track.init_data_list.iter().find(|d| !d.is_empty()).cloned();

                        // 如果有多个配置（不全为空），设置列表
                        let non_empty_count = track
                            .init_data_list
                            .iter()
                            .filter(|d| !d.is_empty())
                            .count();
                        if non_empty_count > 1 {
                            info.video_init_data_list = Some(track.init_data_list.clone());

                            #[cfg(target_arch = "wasm32")]
                            web_sys::console::log_1(
                                &format!(
                                    "📦 多配置模式: {} 个 init_data ({} 非空)",
                                    track.init_data_list.len(),
                                    non_empty_count
                                )
                                .into(),
                            );
                        }
                    }

                    #[cfg(target_arch = "wasm32")]
                    if let Some(ref data) = info.video_init_data {
                        web_sys::console::log_1(
                            &format!(
                                "✅ ContainerInfo.video_init_data 已设置: {} bytes",
                                data.len()
                            )
                            .into(),
                        );
                    } else {
                        web_sys::console::log_1(&"⚠️ ContainerInfo.video_init_data 为 None".into());
                    }

                    // 计算时长
                    if let Some(last) = track.samples.last() {
                        let duration_ts = last.dts;
                        if track.timescale > 0 {
                            info.duration_ms = duration_ts * 1000 / track.timescale as u64;
                        }
                    }
                }
                TrackType::Audio => {
                    info.has_audio = true;
                    info.audio_codec = Some(track.codec.clone());
                    // 复制音频初始化数据 (esds/AudioSpecificConfig)
                    // 对于音频，使用第一个非空配置
                    info.audio_init_data =
                        track.init_data_list.iter().find(|d| !d.is_empty()).cloned();
                }
                _ => {}
            }
        }

        self.info = Some(info.clone());
        Ok(info)
    }

    fn read_sample(&mut self) -> Result<Option<MediaSample>, String> {
        self.parse()?;

        if self.merged_idx >= self.merged_samples.len() {
            return Ok(None);
        }

        let (track_idx, sample_idx) = self.merged_samples[self.merged_idx];
        self.merged_idx += 1;

        let track = &self.tracks[track_idx];
        let sample_info = &track.samples[sample_idx];

        // 读取 sample 数据
        self.reader
            .seek(SeekFrom::Start(sample_info.offset))
            .map_err(|e| e.to_string())?;
        let mut data = vec![0u8; sample_info.size as usize];
        self.reader
            .read_exact(&mut data)
            .map_err(|e| e.to_string())?;

        // 转换时间戳到毫秒
        let dts_ms = if track.timescale > 0 {
            (sample_info.dts * 1000 / track.timescale as u64) as u32
        } else {
            sample_info.dts as u32
        };

        let pts_ms =
            dts_ms.wrapping_add((sample_info.cts_offset * 1000 / track.timescale as i32) as u32);

        // 计算duration（毫秒）
        let duration_ms = if track.timescale > 0 {
            Some((sample_info.duration as f64 * 1000.0) / track.timescale as f64)
        } else {
            None
        };

        let sample_type = match track.track_type {
            TrackType::Video => SampleType::Video,
            TrackType::Audio => SampleType::Audio,
            _ => SampleType::Unknown,
        };

        let mut sample = MediaSample::new(sample_type);
        sample.codec = track.codec.clone();
        sample.dts = dts_ms;
        sample.pts = pts_ms;
        sample.duration_ms = duration_ms;
        sample.offset = sample_info.offset;
        sample.size = sample_info.size;
        sample.is_keyframe = sample_info.is_sync;
        sample.is_init_data = false;
        sample.data = data;

        sample.container_specific = Some(ContainerSpecificInfo::Mp4 {
            track_id: track.track_id,
            sample_index: sample_idx as u32,
            sample_desc_index: sample_info.sample_desc_index,
        });

        if sample.is_keyframe {
            sample.frame_type = Some(FrameType::I);
        }

        Ok(Some(sample))
    }

    fn reset(&mut self) -> Result<(), String> {
        self.merged_idx = 0;
        Ok(())
    }

    fn format(&self) -> ContainerFormat {
        ContainerFormat::Mp4
    }
}

impl Mp4Container<Cursor<Vec<u8>>> {
    pub fn from_bytes(data: Vec<u8>) -> Self {
        Self::new(Cursor::new(data))
    }
}
