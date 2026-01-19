//! 容器格式检测

use serde::{Deserialize, Serialize};

/// 容器格式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContainerFormat {
    /// FLV 格式
    Flv,
    /// MP4 格式 (包括 M4A, M4V)
    Mp4,
    /// MPEG Transport Stream
    Ts,
    /// 未知格式
    Unknown,
}

impl ContainerFormat {
    /// 转换为字符串
    pub fn as_str(&self) -> &'static str {
        match self {
            ContainerFormat::Flv => "flv",
            ContainerFormat::Mp4 => "mp4",
            ContainerFormat::Ts => "ts",
            ContainerFormat::Unknown => "unknown",
        }
    }
}

impl std::fmt::Display for ContainerFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// 检测容器格式
/// 
/// 通过检查文件头魔数来识别格式
pub fn detect_format(data: &[u8]) -> ContainerFormat {
    if data.len() < 12 {
        return ContainerFormat::Unknown;
    }
    
    // FLV: "FLV" 签名 (0x46 0x4C 0x56)
    if data[0] == 0x46 && data[1] == 0x4C && data[2] == 0x56 {
        return ContainerFormat::Flv;
    }
    
    // MP4: "ftyp" box 在偏移 4
    // Box size (4 bytes) + "ftyp" (4 bytes)
    if data.len() >= 8 && data[4] == b'f' && data[5] == b't' && data[6] == b'y' && data[7] == b'p' {
        return ContainerFormat::Mp4;
    }
    
    // MP4: 也可能以 "moov" 或 "mdat" 开头（某些流式 MP4）
    if data.len() >= 8 {
        let box_type = &data[4..8];
        if box_type == b"moov" || box_type == b"mdat" || box_type == b"free" || box_type == b"skip" {
            return ContainerFormat::Mp4;
        }
    }
    
    // TS: 同步字节 0x47，每 188 字节重复
    if data[0] == 0x47 {
        // 验证是否为真正的 TS（检查后续同步字节）
        if data.len() >= 188 * 2 {
            if data[188] == 0x47 || data[188] == 0x00 {
                return ContainerFormat::Ts;
            }
        } else if data.len() >= 188 {
            // 文件太短，但第一个字节匹配
            return ContainerFormat::Ts;
        }
    }
    
    // M2TS: 4 字节时间戳 + 0x47
    if data.len() >= 5 && data[4] == 0x47 {
        // 检查是否为 M2TS (192 字节包)
        if data.len() >= 192 * 2 && (data[196] == 0x47 || data[192 + 4] == 0x47) {
            return ContainerFormat::Ts;
        }
    }
    
    ContainerFormat::Unknown
}

/// 从文件扩展名推测格式
pub fn detect_format_from_extension(filename: &str) -> ContainerFormat {
    let ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_lowercase();
    
    match ext.as_str() {
        "flv" => ContainerFormat::Flv,
        "mp4" | "m4v" | "m4a" | "mov" => ContainerFormat::Mp4,
        "ts" | "mts" | "m2ts" | "mpe" | "mpeg" => ContainerFormat::Ts,
        _ => ContainerFormat::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_detect_flv() {
        let data = b"FLV\x01\x05\x00\x00\x00\x09\x00\x00\x00\x00";
        assert_eq!(detect_format(data), ContainerFormat::Flv);
    }
    
    #[test]
    fn test_detect_mp4() {
        let data = b"\x00\x00\x00\x1Cftypmp42\x00\x00\x00\x00";
        assert_eq!(detect_format(data), ContainerFormat::Mp4);
    }
    
    #[test]
    fn test_detect_ts() {
        let mut data = vec![0x47u8; 188 * 2];
        data[188] = 0x47;
        assert_eq!(detect_format(&data), ContainerFormat::Ts);
    }
}
