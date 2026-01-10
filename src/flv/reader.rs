//! FLV 读取器

use super::{FlvHeader, FlvTag};
use std::io::{self, Read, Seek, SeekFrom};

/// FLV 读取器
pub struct FlvReader<R: Read + Seek> {
    reader: R,
    offset: u64,
}

impl<R: Read + Seek> FlvReader<R> {
    /// 创建新的 FLV 读取器
    pub fn new(reader: R) -> Self {
        Self { reader, offset: 0 }
    }

    /// 读取 FLV 文件头
    pub fn read_header(&mut self) -> io::Result<FlvHeader> {
        let mut buf = [0u8; 9];
        self.reader.read_exact(&mut buf)?;

        let signature = String::from_utf8_lossy(&buf[0..3]).to_string();
        if signature != "FLV" {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("无效的 FLV 签名: {}", signature),
            ));
        }

        let header = FlvHeader {
            signature,
            version: buf[3],
            has_audio: buf[4] & 0x04 != 0,
            has_video: buf[4] & 0x01 != 0,
            header_size: u32::from_be_bytes([buf[5], buf[6], buf[7], buf[8]]),
        };

        // 跳过第一个 PreviousTagSize
        let mut pts = [0u8; 4];
        self.reader.read_exact(&mut pts)?;

        self.offset = header.header_size as u64 + 4;
        Ok(header)
    }

    /// 读取下一个 Tag
    pub fn read_tag(&mut self) -> io::Result<FlvTag> {
        let tag_offset = self.offset;

        // 读取 tag 头 (11 字节)
        let mut header = [0u8; 11];
        match self.reader.read_exact(&mut header) {
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "已到达文件末尾"));
            }
            Err(e) => return Err(e),
        }

        let tag_type = header[0];
        let data_size =
            ((header[1] as u32) << 16) | ((header[2] as u32) << 8) | (header[3] as u32);

        // 时间戳 (3 字节 + 1 字节扩展)
        let ts = ((header[4] as u32) << 16) | ((header[5] as u32) << 8) | (header[6] as u32);
        let ts_ext = header[7] as u32;
        let timestamp = ts | (ts_ext << 24);

        // Stream ID
        let stream_id =
            ((header[8] as u32) << 16) | ((header[9] as u32) << 8) | (header[10] as u32);

        // 读取数据
        let mut data = vec![0u8; data_size as usize];
        self.reader.read_exact(&mut data)?;

        // 读取 PreviousTagSize
        let mut pts = [0u8; 4];
        let _ = self.reader.read_exact(&mut pts);

        self.offset += 11 + data_size as u64 + 4;

        Ok(FlvTag {
            tag_type,
            data_size,
            timestamp,
            stream_id,
            offset: tag_offset,
            data,
        })
    }

    /// 重置到文件开头
    pub fn reset(&mut self) -> io::Result<()> {
        self.reader.seek(SeekFrom::Start(0))?;
        self.offset = 0;
        Ok(())
    }
}
