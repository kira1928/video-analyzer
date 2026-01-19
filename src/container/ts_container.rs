//! TS (MPEG Transport Stream) 容器实现
//!
//! 支持标准 188 字节 TS 和 192 字节 M2TS

use super::{ContainerFormat, ContainerInfo, ContainerReader, MediaSample, SampleType, Codec, ContainerSpecificInfo};
use super::sample::FrameType;
use std::io::{Read, Seek, SeekFrom, Cursor};
use std::collections::HashMap;

/// TS 包大小
const TS_PACKET_SIZE: usize = 188;
const M2TS_PACKET_SIZE: usize = 192;

/// TS 同步字节
const TS_SYNC_BYTE: u8 = 0x47;

/// PES 起始码
const PES_START_CODE: [u8; 3] = [0x00, 0x00, 0x01];

/// 流类型
const STREAM_TYPE_H264: u8 = 0x1B;
const STREAM_TYPE_H265: u8 = 0x24;
const STREAM_TYPE_AAC: u8 = 0x0F;
const STREAM_TYPE_MP3: u8 = 0x03;
const STREAM_TYPE_AC3: u8 = 0x81;

/// PES 重组缓冲区
#[derive(Debug, Clone)]
struct PesBuffer {
    pid: u16,
    stream_type: u8,
    data: Vec<u8>,
    pts: Option<u64>,
    dts: Option<u64>,
    is_complete: bool,
    offset: u64, // 第一个包的偏移
}

/// 流信息
#[derive(Debug, Clone)]
struct StreamInfo {
    pid: u16,
    stream_type: u8,
    codec: Codec,
}

/// TS 容器读取器
pub struct TsContainer<R: Read + Seek> {
    reader: R,
    info: Option<ContainerInfo>,
    packet_size: usize,
    streams: HashMap<u16, StreamInfo>,
    pes_buffers: HashMap<u16, PesBuffer>,
    pat_parsed: bool,
    pmt_pid: Option<u16>,
    pmt_parsed: bool,
    current_offset: u64,
    pending_samples: Vec<MediaSample>,
}

impl<R: Read + Seek> TsContainer<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            info: None,
            packet_size: TS_PACKET_SIZE,
            streams: HashMap::new(),
            pes_buffers: HashMap::new(),
            pat_parsed: false,
            pmt_pid: None,
            pmt_parsed: false,
            current_offset: 0,
            pending_samples: Vec::new(),
        }
    }
    
    /// 检测包大小 (188 vs 192)
    fn detect_packet_size(&mut self) -> Result<(), String> {
        let pos = self.reader.stream_position().map_err(|e| e.to_string())?;
        
        // 读取足够的数据来检测
        let mut buf = [0u8; 200];
        if self.reader.read(&mut buf).map_err(|e| e.to_string())? < 192 {
            return Err("文件太小".to_string());
        }
        
        // 检查第一个同步字节位置
        if buf[0] == TS_SYNC_BYTE && buf[188] == TS_SYNC_BYTE {
            self.packet_size = TS_PACKET_SIZE;
        } else if buf[4] == TS_SYNC_BYTE && buf[196] == TS_SYNC_BYTE {
            self.packet_size = M2TS_PACKET_SIZE;
        } else if buf[0] == TS_SYNC_BYTE {
            self.packet_size = TS_PACKET_SIZE;
        } else if buf[4] == TS_SYNC_BYTE {
            self.packet_size = M2TS_PACKET_SIZE;
        } else {
            return Err("无法检测 TS 包大小".to_string());
        }
        
        self.reader.seek(SeekFrom::Start(pos)).map_err(|e| e.to_string())?;
        Ok(())
    }
    
    /// 读取一个 TS 包
    fn read_packet(&mut self) -> Result<Option<TsPacket>, String> {
        let packet_offset = self.current_offset;
        let mut buf = vec![0u8; self.packet_size];
        
        match self.reader.read_exact(&mut buf) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                return Ok(None);
            }
            Err(e) => return Err(e.to_string()),
        }
        
        self.current_offset += self.packet_size as u64;
        
        // M2TS 有 4 字节时间戳前缀
        let ts_start = if self.packet_size == M2TS_PACKET_SIZE { 4 } else { 0 };
        
        if buf[ts_start] != TS_SYNC_BYTE {
            return Err("同步字节不匹配".to_string());
        }
        
        let header = &buf[ts_start..ts_start + 4];
        
        let transport_error = (header[1] & 0x80) != 0;
        let payload_start = (header[1] & 0x40) != 0;
        let priority = (header[1] & 0x20) != 0;
        let pid = ((header[1] as u16 & 0x1F) << 8) | header[2] as u16;
        let scrambling = (header[3] >> 6) & 0x03;
        let adaptation_field = (header[3] >> 4) & 0x03;
        let continuity = header[3] & 0x0F;
        
        let mut payload_offset = ts_start + 4;
        
        // 跳过 adaptation field
        if adaptation_field & 0x02 != 0 {
            let af_length = buf[payload_offset] as usize;
            payload_offset += 1 + af_length;
        }
        
        let payload = if adaptation_field & 0x01 != 0 && payload_offset < buf.len() {
            Some(buf[payload_offset..].to_vec())
        } else {
            None
        };
        
        Ok(Some(TsPacket {
            offset: packet_offset,
            pid,
            payload_start,
            payload,
        }))
    }
    
    /// 解析 PAT (Program Association Table)
    fn parse_pat(&mut self, payload: &[u8]) -> Result<(), String> {
        if payload.len() < 8 {
            return Ok(());
        }
        
        // 跳过表头
        let pointer_field = payload[0] as usize;
        let table_start = 1 + pointer_field;
        
        if table_start + 8 > payload.len() {
            return Ok(());
        }
        
        let section = &payload[table_start..];
        if section[0] != 0x00 { // PAT table_id
            return Ok(());
        }
        
        let section_length = ((section[1] as usize & 0x0F) << 8) | section[2] as usize;
        
        // 跳过固定字段到程序列表
        let programs_start = 8;
        let programs_end = 3 + section_length.saturating_sub(4); // 减去 CRC
        
        if programs_start >= section.len() {
            return Ok(());
        }
        
        let mut i = programs_start;
        while i + 4 <= programs_end && i + 4 <= section.len() {
            let program_number = ((section[i] as u16) << 8) | section[i + 1] as u16;
            let pid = ((section[i + 2] as u16 & 0x1F) << 8) | section[i + 3] as u16;
            
            if program_number != 0 {
                self.pmt_pid = Some(pid);
                break;
            }
            
            i += 4;
        }
        
        self.pat_parsed = true;
        Ok(())
    }
    
    /// 解析 PMT (Program Map Table)
    fn parse_pmt(&mut self, payload: &[u8]) -> Result<(), String> {
        if payload.len() < 12 {
            return Ok(());
        }
        
        let pointer_field = payload[0] as usize;
        let table_start = 1 + pointer_field;
        
        if table_start + 12 > payload.len() {
            return Ok(());
        }
        
        let section = &payload[table_start..];
        if section[0] != 0x02 { // PMT table_id
            return Ok(());
        }
        
        let section_length = ((section[1] as usize & 0x0F) << 8) | section[2] as usize;
        let program_info_length = ((section[10] as usize & 0x0F) << 8) | section[11] as usize;
        
        let es_start = 12 + program_info_length;
        let es_end = 3 + section_length.saturating_sub(4);
        
        if es_start >= section.len() {
            return Ok(());
        }
        
        let mut i = es_start;
        while i + 5 <= es_end && i + 5 <= section.len() {
            let stream_type = section[i];
            let es_pid = ((section[i + 1] as u16 & 0x1F) << 8) | section[i + 2] as u16;
            let es_info_length = ((section[i + 3] as usize & 0x0F) << 8) | section[i + 4] as usize;
            
            let codec = match stream_type {
                STREAM_TYPE_H264 => Codec::H264,
                STREAM_TYPE_H265 => Codec::H265,
                STREAM_TYPE_AAC => Codec::Aac,
                STREAM_TYPE_MP3 => Codec::Mp3,
                _ => Codec::Unknown(format!("ts_{:02X}", stream_type)),
            };
            
            self.streams.insert(es_pid, StreamInfo {
                pid: es_pid,
                stream_type,
                codec,
            });
            
            i += 5 + es_info_length;
        }
        
        self.pmt_parsed = true;
        Ok(())
    }
    
    /// 处理 PES 数据
    fn process_pes(&mut self, pid: u16, payload: &[u8], payload_start: bool, offset: u64) {
        if payload_start {
            // 完成之前的 PES
            if let Some(mut buffer) = self.pes_buffers.remove(&pid) {
                if !buffer.data.is_empty() {
                    if let Some(sample) = self.create_sample_from_pes(&buffer) {
                        self.pending_samples.push(sample);
                    }
                }
            }
            
            // 开始新的 PES
            if payload.len() >= 9 && payload[0..3] == PES_START_CODE {
                let stream_id = payload[3];
                let pes_packet_length = ((payload[4] as u16) << 8) | payload[5] as u16;
                
                // 视频和音频流
                if stream_id >= 0xC0 || stream_id == 0xBD {
                    let pes_header_length = payload[8] as usize;
                    let pts_dts_flags = (payload[7] >> 6) & 0x03;
                    
                    let (pts, dts) = if pts_dts_flags >= 2 && payload.len() >= 14 {
                        let pts = self.parse_pts(&payload[9..14]);
                        
                        let dts = if pts_dts_flags == 3 && payload.len() >= 19 {
                            Some(self.parse_pts(&payload[14..19]))
                        } else {
                            Some(pts)
                        };
                        
                        (Some(pts), dts)
                    } else {
                        (None, None)
                    };
                    
                    let data_start = 9 + pes_header_length;
                    let data = if data_start < payload.len() {
                        payload[data_start..].to_vec()
                    } else {
                        Vec::new()
                    };
                    
                    self.pes_buffers.insert(pid, PesBuffer {
                        pid,
                        stream_type: self.streams.get(&pid).map(|s| s.stream_type).unwrap_or(0),
                        data,
                        pts,
                        dts,
                        is_complete: pes_packet_length > 0,
                        offset,
                    });
                }
            }
        } else {
            // 继续之前的 PES
            if let Some(buffer) = self.pes_buffers.get_mut(&pid) {
                buffer.data.extend_from_slice(payload);
            }
        }
    }
    
    /// 解析 PTS (5 字节)
    fn parse_pts(&self, data: &[u8]) -> u64 {
        if data.len() < 5 {
            return 0;
        }
        
        let pts = ((data[0] as u64 & 0x0E) << 29)
            | ((data[1] as u64) << 22)
            | ((data[2] as u64 & 0xFE) << 14)
            | ((data[3] as u64) << 7)
            | ((data[4] as u64) >> 1);
        
        pts
    }
    
    /// 从 PES 缓冲区创建 Sample
    fn create_sample_from_pes(&self, buffer: &PesBuffer) -> Option<MediaSample> {
        let stream_info = self.streams.get(&buffer.pid)?;
        
        let sample_type = if stream_info.codec.is_video() {
            SampleType::Video
        } else if stream_info.codec.is_audio() {
            SampleType::Audio
        } else {
            SampleType::Unknown
        };
        
        // PTS/DTS 单位是 90kHz
        let pts_ms = buffer.pts.map(|p| (p / 90) as u32).unwrap_or(0);
        let dts_ms = buffer.dts.map(|d| (d / 90) as u32).unwrap_or(pts_ms);
        
        let mut sample = MediaSample::new(sample_type);
        sample.codec = stream_info.codec.clone();
        sample.pts = pts_ms;
        sample.dts = dts_ms;
        sample.offset = buffer.offset;
        sample.size = buffer.data.len() as u32;
        sample.data = buffer.data.clone();
        
        sample.container_specific = Some(ContainerSpecificInfo::Ts {
            pid: buffer.pid,
            pes_packet_length: buffer.data.len() as u16,
        });
        
        // 检测关键帧 (H.264/H.265 的 NAL 类型)
        if stream_info.codec == Codec::H264 || stream_info.codec == Codec::H265 {
            sample.is_keyframe = self.detect_keyframe(&buffer.data, &stream_info.codec);
            if sample.is_keyframe {
                sample.frame_type = Some(FrameType::I);
            }
        }
        
        Some(sample)
    }
    
    /// 检测是否为关键帧
    fn detect_keyframe(&self, data: &[u8], codec: &Codec) -> bool {
        // 查找 NALU 起始码
        let mut i = 0;
        while i + 4 < data.len() {
            // 检查 0x00 0x00 0x01 或 0x00 0x00 0x00 0x01
            if (i + 3 < data.len() && data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1) ||
               (i + 4 < data.len() && data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 0 && data[i + 3] == 1) {
                
                let nal_offset = if data[i + 2] == 1 { i + 3 } else { i + 4 };
                if nal_offset < data.len() {
                    let nal_byte = data[nal_offset];
                    
                    match codec {
                        Codec::H264 => {
                            let nal_type = nal_byte & 0x1F;
                            // IDR slice (5) 或 SPS (7) 或 PPS (8)
                            if nal_type == 5 || nal_type == 7 || nal_type == 8 {
                                return true;
                            }
                        }
                        Codec::H265 => {
                            let nal_type = (nal_byte >> 1) & 0x3F;
                            // IDR_W_RADL (19), IDR_N_LP (20), CRA (21), VPS (32), SPS (33), PPS (34)
                            if nal_type == 19 || nal_type == 20 || nal_type == 21 ||
                               nal_type == 32 || nal_type == 33 || nal_type == 34 {
                                return true;
                            }
                        }
                        _ => {}
                    }
                }
            }
            i += 1;
        }
        
        false
    }
}

/// TS 包
struct TsPacket {
    offset: u64,
    pid: u16,
    payload_start: bool,
    payload: Option<Vec<u8>>,
}

impl<R: Read + Seek + 'static> ContainerReader for TsContainer<R> {
    fn read_info(&mut self) -> Result<ContainerInfo, String> {
        if let Some(ref info) = self.info {
            return Ok(info.clone());
        }
        
        self.detect_packet_size()?;
        
        // 解析 PAT 和 PMT
        while !self.pmt_parsed {
            let packet = match self.read_packet()? {
                Some(p) => p,
                None => break,
            };
            
            if let Some(ref payload) = packet.payload {
                if packet.pid == 0 && !self.pat_parsed {
                    self.parse_pat(payload)?;
                } else if Some(packet.pid) == self.pmt_pid && !self.pmt_parsed {
                    self.parse_pmt(payload)?;
                }
            }
            
            // 限制扫描范围
            if self.current_offset > 1024 * 1024 {
                break;
            }
        }
        
        // 构建容器信息
        let mut info = ContainerInfo {
            format: ContainerFormat::Ts,
            ..Default::default()
        };
        
        for stream_info in self.streams.values() {
            if stream_info.codec.is_video() {
                info.has_video = true;
                info.video_codec = Some(stream_info.codec.clone());
            } else if stream_info.codec.is_audio() {
                info.has_audio = true;
                info.audio_codec = Some(stream_info.codec.clone());
            }
        }
        
        // 重置到开头
        self.reader.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        self.current_offset = 0;
        
        self.info = Some(info.clone());
        Ok(info)
    }
    
    fn read_sample(&mut self) -> Result<Option<MediaSample>, String> {
        // 先返回已解析的 sample
        if !self.pending_samples.is_empty() {
            return Ok(Some(self.pending_samples.remove(0)));
        }
        
        // 读取更多包
        loop {
            let packet = match self.read_packet()? {
                Some(p) => p,
                None => {
                    // 文件结束，flush 剩余的 PES
                    // 先收集所有 buffers 避免借用冲突
                    let remaining_buffers: Vec<_> = self.pes_buffers.drain().map(|(_, b)| b).collect();
                    for buffer in remaining_buffers {
                        if !buffer.data.is_empty() {
                            if let Some(sample) = self.create_sample_from_pes(&buffer) {
                                self.pending_samples.push(sample);
                            }
                        }
                    }
                    
                    if !self.pending_samples.is_empty() {
                        return Ok(Some(self.pending_samples.remove(0)));
                    }
                    return Ok(None);
                }

            };
            
            if let Some(ref payload) = packet.payload {
                // 处理 PAT/PMT
                if packet.pid == 0 && !self.pat_parsed {
                    self.parse_pat(payload)?;
                } else if Some(packet.pid) == self.pmt_pid && !self.pmt_parsed {
                    self.parse_pmt(payload)?;
                } else if self.streams.contains_key(&packet.pid) {
                    // 处理 ES 数据
                    self.process_pes(packet.pid, payload, packet.payload_start, packet.offset);
                }
            }
            
            // 如果有 pending samples，返回
            if !self.pending_samples.is_empty() {
                return Ok(Some(self.pending_samples.remove(0)));
            }
        }
    }
    
    fn reset(&mut self) -> Result<(), String> {
        self.reader.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        self.current_offset = 0;
        self.pes_buffers.clear();
        self.pending_samples.clear();
        Ok(())
    }
    
    fn format(&self) -> ContainerFormat {
        ContainerFormat::Ts
    }
}

impl TsContainer<Cursor<Vec<u8>>> {
    pub fn from_bytes(data: Vec<u8>) -> Self {
        Self::new(Cursor::new(data))
    }
}
