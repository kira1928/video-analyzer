//! HEVC (H.265) 工具模块

/// NAL Unit Types (HEVC)
pub mod nalu_types {
    pub const TRAIL_N: u8 = 0;
    pub const TRAIL_R: u8 = 1;
    pub const BLA_W_LP: u8 = 16;
    pub const BLA_W_RADL: u8 = 17;
    pub const BLA_N_LP: u8 = 18;
    pub const IDR_W_RADL: u8 = 19;
    pub const IDR_N_LP: u8 = 20;
    pub const CRA_NUT: u8 = 21;
    pub const VPS: u8 = 32;
    pub const SPS: u8 = 33;
    pub const PPS: u8 = 34;
    pub const AUD: u8 = 35;
    pub const EOS_NUT: u8 = 36;
    pub const EOB_NUT: u8 = 37;
    pub const FILLER_NUT: u8 = 38;
    pub const PREFIX_SEI: u8 = 39;
    pub const SUFFIX_SEI: u8 = 40;
}

/// 从 NAL Unit 头获取 NAL 类型
/// HEVC NAL Header: 2 bytes, NAL Type 在第一个字节的 bit 1-6
pub fn get_nalu_type(data: &[u8]) -> Option<u8> {
    if data.is_empty() {
        return None;
    }
    Some((data[0] >> 1) & 0x3F)
}

/// 判断是否为 VPS
pub fn is_vps(data: &[u8]) -> bool {
    get_nalu_type(data) == Some(nalu_types::VPS)
}

/// 判断是否为 SPS
pub fn is_sps(data: &[u8]) -> bool {
    get_nalu_type(data) == Some(nalu_types::SPS)
}

/// 判断是否为 PPS
pub fn is_pps(data: &[u8]) -> bool {
    get_nalu_type(data) == Some(nalu_types::PPS)
}

/// 判断是否为 IDR 帧
pub fn is_idr(data: &[u8]) -> bool {
    match get_nalu_type(data) {
        Some(t) => t == nalu_types::IDR_W_RADL || t == nalu_types::IDR_N_LP,
        None => false,
    }
}

/// 检测数据是否为 Annex B 格式
pub fn is_annex_b_format(data: &[u8]) -> bool {
    if data.len() < 4 {
        return false;
    }
    // 4 字节起始码
    if data[0] == 0 && data[1] == 0 && data[2] == 0 && data[3] == 1 {
        return true;
    }
    // 3 字节起始码
    if data[0] == 0 && data[1] == 0 && data[2] == 1 {
        return true;
    }
    false
}

/// 从 Annex B 格式数据中分割出所有 NAL Units
pub fn split_annex_b_nalus(data: &[u8]) -> Vec<Vec<u8>> {
    let mut nalus = Vec::new();
    let data_len = data.len();
    let mut i = 0;

    while i < data_len {
        // 查找起始码
        let start = if i + 4 <= data_len
            && data[i] == 0
            && data[i + 1] == 0
            && data[i + 2] == 0
            && data[i + 3] == 1
        {
            Some(i + 4)
        } else if i + 3 <= data_len && data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            Some(i + 3)
        } else {
            None
        };

        if let Some(start_pos) = start {
            // 查找下一个起始码
            let mut next = start_pos;
            while next < data_len {
                if (next + 4 <= data_len
                    && data[next] == 0
                    && data[next + 1] == 0
                    && data[next + 2] == 0
                    && data[next + 3] == 1)
                    || (next + 3 <= data_len
                        && data[next] == 0
                        && data[next + 1] == 0
                        && data[next + 2] == 1)
                {
                    break;
                }
                next += 1;
            }

            // 提取 NAL Unit
            nalus.push(data[start_pos..next].to_vec());
            i = next;
        } else {
            i += 1;
        }
    }

    nalus
}

/// 去除 NALU 中的 Emulation Prevention Bytes (00 00 03 -> 00 00)
pub fn unescape_nalu(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;

    while i < data.len() {
        if i + 2 < data.len() && data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 3 {
            out.push(0);
            out.push(0);
            i += 3;
        } else {
            out.push(data[i]);
            i += 1;
        }
    }

    out
}

/// 将 Annex B 格式的序列头转换为 HVCC 格式
pub fn convert_annex_b_to_hvcc(data: &[u8]) -> Result<Vec<u8>, String> {
    let nalus = split_annex_b_nalus(data);

    // 分类 NAL Units
    let mut vps_list = Vec::new();
    let mut sps_list = Vec::new();
    let mut pps_list = Vec::new();

    for nalu in nalus {
        if let Some(nalu_type) = get_nalu_type(&nalu) {
            match nalu_type {
                nalu_types::VPS => vps_list.push(nalu),
                nalu_types::SPS => sps_list.push(nalu),
                nalu_types::PPS => pps_list.push(nalu),
                _ => {}
            }
        }
    }

    if vps_list.is_empty() || sps_list.is_empty() || pps_list.is_empty() {
        return Err(format!(
            "Annex B 数据缺失关键参数集: VPS={}, SPS={}, PPS={}",
            vps_list.len(),
            sps_list.len(),
            pps_list.len()
        ));
    }

    build_hvcc(&vps_list, &sps_list, &pps_list)
}

/// 从 VPS/SPS/PPS 构建 HVCC
fn build_hvcc(vps: &[Vec<u8>], sps: &[Vec<u8>], pps: &[Vec<u8>]) -> Result<Vec<u8>, String> {
    // 计算数组大小
    fn calc_array_size(arr: &[Vec<u8>]) -> usize {
        if arr.is_empty() {
            return 0;
        }
        let mut size = 3; // Array Header (Type + Count)
        for n in arr {
            size += 2 + n.len(); // Length (2B) + Data
        }
        size
    }

    // 计算总长度: Header (23 bytes) + Arrays
    let total_len = 23 + calc_array_size(vps) + calc_array_size(sps) + calc_array_size(pps);
    let mut hvcc = vec![0u8; total_len];
    let mut offset = 0;

    // HVCC Header
    hvcc[0] = 1; // configurationVersion

    // 从 VPS 提取 Profile/Tier/Level 信息
    if !vps.is_empty() {
        let unescaped_vps = unescape_nalu(&vps[0]);
        if unescaped_vps.len() > 18 {
            // PTL 从 offset 6 开始，共 12 bytes
            for k in 0..12 {
                hvcc[1 + k] = unescaped_vps[6 + k];
            }
        } else {
            // 使用默认值
            hvcc[1] = 1; // general_profile_space(0) + general_tier_flag(0) + general_profile_idc(1)
            hvcc[2] = 0x60; // general_profile_compatibility_flags
            hvcc[12] = 93; // general_level_idc (Level 3.1)
        }
    }
    offset += 13;

    // 其他字段
    hvcc[offset] = 0xF0; // min_spatial_segmentation_idc (high 4 bits reserved)
    offset += 1;
    hvcc[offset] = 0x00;
    offset += 1;
    hvcc[offset] = 0xFC; // parallelismType
    offset += 1;
    hvcc[offset] = 0xFD; // chromaFormat
    offset += 1;
    hvcc[offset] = 0xF8; // bitDepthLumaMinus8
    offset += 1;
    hvcc[offset] = 0xF8; // bitDepthChromaMinus8
    offset += 1;
    hvcc[offset] = 0x00; // avgFrameRate (high)
    offset += 1;
    hvcc[offset] = 0x00; // avgFrameRate (low)
    offset += 1;
    hvcc[offset] = 0x0F; // constantFrameRate + numTemporalLayers + temporalIdNested + lengthSizeMinusOne
    offset += 1;
    hvcc[offset] = 3; // numOfArrays
    offset += 1;

    // 写入数组
    fn write_array(hvcc: &mut [u8], offset: &mut usize, nal_type: u8, nalus: &[Vec<u8>]) {
        if nalus.is_empty() {
            return;
        }
        // 第一个字节: array_completeness(1) + reserved(1) + NAL_unit_type(6)
        // array_completeness = 1 (0x80)
        hvcc[*offset] = 0x80 | (nal_type & 0x3F);
        *offset += 1;
        hvcc[*offset] = ((nalus.len() >> 8) & 0xFF) as u8;
        *offset += 1;
        hvcc[*offset] = (nalus.len() & 0xFF) as u8;
        *offset += 1;
        for n in nalus {
            hvcc[*offset] = ((n.len() >> 8) & 0xFF) as u8;
            *offset += 1;
            hvcc[*offset] = (n.len() & 0xFF) as u8;
            *offset += 1;
            hvcc[*offset..*offset + n.len()].copy_from_slice(n);
            *offset += n.len();
        }
    }

    write_array(&mut hvcc, &mut offset, nalu_types::VPS, vps);
    write_array(&mut hvcc, &mut offset, nalu_types::SPS, sps);
    write_array(&mut hvcc, &mut offset, nalu_types::PPS, pps);

    Ok(hvcc)
}

/// 将 Annex B 格式的帧数据转换为 AVCC/HVCC 格式（带长度前缀）
pub fn convert_annex_b_to_avcc(data: &[u8]) -> Vec<u8> {
    let nalus = split_annex_b_nalus(data);

    // 只过滤掉 SEI 和 AUD（这些会导致解码延迟）
    // 保留 VCL NALUs (0-31) 和其他必要类型
    let filtered_nalus: Vec<_> = nalus
        .into_iter()
        .filter(|nalu| {
            if let Some(nalu_type) = get_nalu_type(nalu) {
                // 排除 AUD(35) 和 SEI(39, 40)
                nalu_type != nalu_types::AUD
                    && nalu_type != nalu_types::PREFIX_SEI
                    && nalu_type != nalu_types::SUFFIX_SEI
            } else {
                false
            }
        })
        .collect();

    if filtered_nalus.is_empty() {
        return Vec::new();
    }

    // 计算总长度
    let total_len: usize = filtered_nalus.iter().map(|n| 4 + n.len()).sum();
    let mut avcc = vec![0u8; total_len];
    let mut offset = 0;

    for n in filtered_nalus {
        let length = n.len();
        // 写入长度（大端序）
        avcc[offset] = ((length >> 24) & 0xFF) as u8;
        avcc[offset + 1] = ((length >> 16) & 0xFF) as u8;
        avcc[offset + 2] = ((length >> 8) & 0xFF) as u8;
        avcc[offset + 3] = (length & 0xFF) as u8;
        offset += 4;
        // 写入数据
        avcc[offset..offset + length].copy_from_slice(&n);
        offset += length;
    }

    avcc
}

/// HEVC Codec String 生成选项
pub struct CodecStringOptions {
    /// "raw" 使用原始值, "reversed" 反转位顺序
    pub compat_mode: String,
    /// "concat" 连接十六进制, "dot" 点分隔
    pub constraint_mode: String,
}

impl Default for CodecStringOptions {
    fn default() -> Self {
        Self {
            compat_mode: "raw".to_string(),
            constraint_mode: "concat".to_string(),
        }
    }
}

/// 从 HVCC 数据生成 HEVC codec string
/// 格式: hvc1.<profile>.<compat>.<tier><level>.<constraints>
/// 例如: hvc1.1.6.L93.B0
pub fn generate_codec_string(hvcc: &[u8], options: &CodecStringOptions) -> String {
    if hvcc.len() < 23 {
        return "hvc1.1.6.L93.B0".to_string(); // 默认值
    }

    // Byte 1: general_profile_space(2) + general_tier_flag(1) + general_profile_idc(5)
    let profile_idc = hvcc[1] & 0x1F;
    let tier_flag = (hvcc[1] & 0x20) >> 5;
    let tier_char = if tier_flag == 1 { "H" } else { "L" };

    // Byte 12: general_level_idc
    let level_idc = hvcc[12];

    // Byte 2: general_profile_compatibility_flags[0]
    let mut profile_compat = hvcc[2];
    if options.compat_mode == "reversed" {
        // 反转位顺序
        let mut reversed = 0u8;
        let mut n = hvcc[2];
        for _ in 0..8 {
            reversed = (reversed << 1) | (n & 1);
            n >>= 1;
        }
        profile_compat = reversed;
    }

    // Bytes 6-11: general_constraint_indicator_flags
    let constraint_bytes = &hvcc[6..12];
    let constraint_string = if options.constraint_mode == "dot" {
        // 点分隔格式
        let mut last_non_zero = constraint_bytes.len() as i32 - 1;
        while last_non_zero >= 0 && constraint_bytes[last_non_zero as usize] == 0 {
            last_non_zero -= 1;
        }

        let mut s = String::new();
        for i in 0..=last_non_zero as usize {
            s.push('.');
            s.push_str(&format!("{:02X}", constraint_bytes[i]));
        }
        if s.is_empty() {
            ".0".to_string()
        } else {
            s
        }
    } else {
        // 连接格式
        let mut s = String::new();
        for b in constraint_bytes {
            s.push_str(&format!("{:02X}", b));
        }
        // 去除尾部 00
        while s.len() > 2 && s.ends_with("00") {
            s.truncate(s.len() - 2);
        }
        if s.is_empty() {
            String::new()
        } else {
            format!(".{}", s)
        }
    };

    format!(
        "hvc1.{}.{}.{}{}{}",
        profile_idc, profile_compat, tier_char, level_idc, constraint_string
    )
}
