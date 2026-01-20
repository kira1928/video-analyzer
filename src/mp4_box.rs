//! MP4 Box 树解析模块
//!
//! 解析 MP4 文件的 box 结构，生成用于前端显示的树形数据

use serde::Serialize;
use std::collections::HashMap;
use std::io::{Cursor, Read, Seek, SeekFrom};

/// MP4 Box 节点 - 用于前端树形展示
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mp4BoxNode {
    /// Box 类型 (fourcc)
    pub box_type: String,
    /// Box 起始位置（绝对偏移）
    pub offset: u64,
    /// Box 大小（包括头部）
    pub size: u64,
    /// Box 头部大小 (8 或 16)
    pub header_size: u8,
    /// Box 说明文本
    pub description: String,
    /// 详细字段信息（如果已解析）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<BoxField>>,
    /// 子 Box 列表（容器 box）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<Mp4BoxNode>>,
    /// 子 Box 数量（流式模式用于懒加载）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children_count: Option<usize>,
    /// 是否为容器类 Box（流式模式用于展示折叠开关）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_container: Option<bool>,
}

/// Box 字段信息
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxField {
    /// 字段名称
    pub name: String,
    /// 字段值（字符串表示）
    pub value: String,
    /// 字段说明
    pub description: String,
    /// 字段在 box 内的偏移
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
    /// 字段大小（字节）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u32>,
}

impl BoxField {
    pub fn new(name: &str, value: impl ToString, desc: &str) -> Self {
        Self {
            name: name.to_string(),
            value: value.to_string(),
            description: desc.to_string(),
            offset: None,
            size: None,
        }
    }

    pub fn with_offset(mut self, offset: u32, size: u32) -> Self {
        self.offset = Some(offset);
        self.size = Some(size);
        self
    }
}

/// MP4 Box 树 - 完整的 box 结构
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mp4BoxTree {
    /// 根级 box 列表
    pub boxes: Vec<Mp4BoxNode>,
    /// 总 box 数量
    pub total_count: usize,
}

/// 容器类型 Box（包含子 box）
const CONTAINER_BOXES: &[&[u8; 4]] = &[
    b"moov", b"trak", b"mdia", b"minf", b"stbl", b"dinf", b"edts", b"sinf", b"schi", b"mvex",
    b"moof", b"traf", b"mfra", b"udta", b"meta", b"ilst",
];

/// 判断是否为容器 box
pub(crate) fn is_container_box(box_type: &[u8; 4]) -> bool {
    CONTAINER_BOXES.iter().any(|t| *t == box_type)
}

/// 判断是否为 stsd box（需要特殊处理）
pub(crate) fn is_stsd_box(box_type: &[u8; 4]) -> bool {
    box_type == b"stsd"
}

/// 判断是否为 sample entry box（包含子 box 如 avcC/hvcC）
pub(crate) fn is_sample_entry_box(box_type: &[u8; 4]) -> bool {
    // 视频/音频 sample entry types
    matches!(
        &box_type[..],
        b"avc1" | b"avc2" | b"avc3" | b"avc4" |  // H.264
        b"hvc1" | b"hev1" |                        // H.265
        b"vp08" | b"vp09" |                        // VP8/VP9  
        b"av01" |                                  // AV1
        b"mp4a" |                                  // AAC
        b"encv" | b"enca" // Encrypted
    )
}

pub(crate) fn fourcc_to_string(box_type: [u8; 4]) -> String {
    box_type
        .iter()
        .map(|b| {
            if b.is_ascii_graphic() || *b == b' ' {
                *b as char
            } else if *b >= 0x80 {
                char::from(*b)
            } else {
                '.'
            }
        })
        .collect()
}

/// Box 类型说明映射
pub(crate) fn get_box_description(box_type: &str) -> &'static str {
    match box_type {
        // 顶层 Boxes
        "ftyp" => "文件类型声明，标识 MP4 品牌和兼容性",
        "moov" => "影片容器，包含所有元数据（时长、轨道等）",
        "mdat" => "媒体数据容器，存储实际的音视频采样数据",
        "free" => "空闲空间，可被编辑器用于原地修改文件",
        "skip" => "跳过数据，与 free 类似的占位符",
        "wide" => "64位扩展占位符，用于大文件支持",
        "pdin" => "渐进式下载信息",
        "uuid" => "用户自定义扩展 Box",

        // moov 下的 Boxes
        "mvhd" => "影片头，包含时间刻度、时长等全局信息",
        "trak" => "轨道容器，每个音/视频/字幕流一个",
        "mvex" => "影片扩展，用于分片 MP4",
        "ipmc" => "IPMP 控制信息",
        "udta" => "用户数据，可包含自定义元数据",
        "meta" => "元数据容器，iTunes/苹果设备常用",

        // trak 下的 Boxes
        "tkhd" => "轨道头，包含轨道 ID、时长、宽高等信息",
        "tref" => "轨道引用，指向其他关联轨道",
        "edts" => "编辑列表容器",
        "elst" => "编辑列表，定义时间映射和空隙",
        "mdia" => "媒体容器",

        // mdia 下的 Boxes
        "mdhd" => "媒体头，包含时间刻度等轨道级信息",
        "hdlr" => "处理器描述，标识轨道类型（vide/soun/text）",
        "minf" => "媒体信息容器",

        // minf 下的 Boxes
        "vmhd" => "视频媒体头，视频轨道特有",
        "smhd" => "音频媒体头，音频轨道特有",
        "hmhd" => "提示媒体头，用于流媒体提示轨",
        "nmhd" => "空媒体头，用于元数据轨道",
        "dinf" => "数据信息容器",
        "dref" => "数据引用，指定媒体数据位置",
        "stbl" => "采样表容器，包含时间和位置信息",

        // stbl 下的 Boxes（采样表）
        "stsd" => "采样描述表，定义编解码器和配置",
        "stts" => "解码时间表，Sample → DTS 映射（通过 delta 累加）",
        "ctts" => "合成时间偏移表，CTS = DTS + CTTS_offset",
        "cslg" => "合成时间转显示时间，用于负 CTS",
        "stsc" => "Sample-to-Chunk 表，Sample 在 Chunk 中的分组",
        "stsz" => "采样大小表，每个 Sample 的字节数",
        "stz2" => "压缩采样大小表",
        "stco" => "Chunk 偏移表（32位），Chunk 在文件中的位置",
        "co64" => "Chunk 偏移表（64位），大文件版本",
        "stss" => "同步采样表，标记关键帧（Sync Sample）",
        "stsh" => "阴影同步表，用于随机访问",
        "padb" => "填充位",
        "stdp" => "采样优先级",
        "sdtp" => "采样依赖类型，标记帧间依赖关系",
        "sbgp" => "采样分组",
        "sgpd" => "采样分组描述",
        "subs" => "子采样信息",
        "saiz" => "辅助信息大小",
        "saio" => "辅助信息偏移",

        // 编解码器相关（stsd 子 box）
        "avc1" => "H.264/AVC 视频采样条目",
        "avc2" => "H.264/AVC 视频采样条目（变体）",
        "avc3" => "H.264/AVC 视频采样条目（分片）",
        "avc4" => "H.264/AVC 视频采样条目（分片变体）",
        "hvc1" => "H.265/HEVC 视频采样条目（参数集在 hvcC）",
        "hev1" => "H.265/HEVC 视频采样条目（参数集在流内）",
        "vp08" => "VP8 视频采样条目",
        "vp09" => "VP9 视频采样条目",
        "av01" => "AV1 视频采样条目",
        "mp4v" => "MPEG-4 Part 2 视频",
        "mp4a" => "AAC/MPEG-4 音频采样条目",
        "ac-3" => "Dolby AC-3 音频",
        "ec-3" => "Dolby E-AC-3 (DD+) 音频",
        "Opus" => "Opus 音频采样条目",
        "fLaC" => "FLAC 音频采样条目",
        "avcC" => "AVC 解码配置记录，包含 SPS/PPS",
        "hvcC" => "HEVC 解码配置记录，包含 VPS/SPS/PPS",
        "vpcC" => "VP 编解码器配置",
        "av1C" => "AV1 编解码器配置",
        "esds" => "ES 描述符，包含 AAC 配置（AudioSpecificConfig）",
        "dac3" => "AC-3 特定配置",
        "dec3" => "E-AC-3 特定配置",
        "dOps" => "Opus 特定配置",
        "dfLa" => "FLAC 特定配置",
        "btrt" => "比特率信息",
        "pasp" => "像素宽高比",
        "colr" => "色彩信息（色域、传递函数等）",
        "clap" => "清洁光圈（裁剪信息）",

        // 分片 MP4（Fragmented MP4）
        "moof" => "分片容器（用于流媒体）",
        "mfhd" => "分片头",
        "traf" => "轨道分片容器",
        "tfhd" => "轨道分片头",
        "tfdt" => "轨道分片解码时间",
        "trun" => "轨道运行表，分片内的 Sample 信息",
        "mfra" => "分片随机访问",
        "tfra" => "轨道分片随机访问",
        "mfro" => "分片随机访问偏移",

        // DRM/保护
        "sinf" => "保护方案信息容器",
        "frma" => "原始格式",
        "schm" => "方案类型",
        "schi" => "方案信息容器",
        "tenc" => "轨道加密默认值",
        "pssh" => "保护系统特定头（DRM 许可证）",
        "senc" => "采样加密",

        // iTunes/苹果元数据
        "ilst" => "iTunes 元数据列表",
        "----" => "自定义 iTunes 元数据",
        "©nam" => "标题",
        "©ART" => "艺术家",
        "©alb" => "专辑",
        "©day" => "年份",
        "©cmt" => "评论",
        "©gen" => "类型",
        "trkn" => "曲目号",
        "covr" => "封面图片",

        // 其他
        "sidx" => "片段索引（DASH）",
        "ssix" => "子片段索引",
        "prft" => "生产者参考时间",
        "emsg" => "事件消息（用于 DASH 带内事件）",

        _ => "未知 Box 类型",
    }
}

/// 解析 MP4 Box 树
pub fn parse_mp4_box_tree(data: &[u8]) -> Result<Mp4BoxTree, String> {
    let mut cursor = Cursor::new(data);
    let file_size = data.len() as u64;

    let (boxes, count) = parse_boxes_recursive(&mut cursor, 0, file_size)?;

    Ok(Mp4BoxTree {
        boxes,
        total_count: count,
    })
}

/// 递归解析 Box（返回 box 列表和总计数）
fn parse_boxes_recursive<R: Read + Seek>(
    reader: &mut R,
    start: u64,
    end: u64,
) -> Result<(Vec<Mp4BoxNode>, usize), String> {
    let mut boxes = Vec::new();
    let mut total_count = 0;
    let mut pos = start;

    while pos < end {
        reader
            .seek(SeekFrom::Start(pos))
            .map_err(|e| e.to_string())?;

        // 读取 box 头
        let mut header = [0u8; 8];
        if reader.read_exact(&mut header).is_err() {
            break;
        }

        let size = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as u64;
        let box_type_bytes: [u8; 4] = [header[4], header[5], header[6], header[7]];
        let box_type = fourcc_to_string(box_type_bytes);

        // 处理扩展大小
        let (box_size, header_size) = if size == 1 {
            let mut ext = [0u8; 8];
            reader.read_exact(&mut ext).map_err(|e| e.to_string())?;
            (u64::from_be_bytes(ext), 16u8)
        } else if size == 0 {
            (end - pos, 8u8)
        } else {
            (size, 8u8)
        };

        if box_size < header_size as u64 || pos + box_size > end + 8 {
            // 无效大小，跳过
            break;
        }

        let content_start = pos + header_size as u64;
        let box_end = pos + box_size;

        // 获取描述
        let description = get_box_description(&box_type).to_string();

        // 解析子 box 或字段
        let (children, fields) = if is_container_box(&box_type_bytes) {
            let (child_boxes, child_count) = parse_boxes_recursive(reader, content_start, box_end)?;
            total_count += child_count;
            (Some(child_boxes), None)
        } else if is_stsd_box(&box_type_bytes) {
            // stsd 特殊处理：跳过 version/flags (4字节) 和 entry_count (4字节)
            let (child_boxes, child_count) =
                parse_boxes_recursive(reader, content_start + 8, box_end)?;
            total_count += child_count;
            (Some(child_boxes), None)
        } else if is_sample_entry_box(&box_type_bytes) {
            // Sample entry (avc1/hvc1 等) 特殊处理：
            // 跳过 reserved (6), data_ref_index (2), 视频专用字段 (70字节) = 78字节
            // 之后的内容是子 box (如 avcC/hvcC)
            let skip_size = 78u64; // 视频 sample entry 的基本大小
            if box_size > header_size as u64 + skip_size {
                let (child_boxes, child_count) =
                    parse_boxes_recursive(reader, content_start + skip_size, box_end)?;
                total_count += child_count;
                (Some(child_boxes), None)
            } else {
                (None, None)
            }
        } else {
            // 尝试解析特定 box 的字段
            let fields = parse_box_fields(
                reader,
                &box_type,
                content_start,
                box_size - header_size as u64,
            );
            (None, fields)
        };

        let children_count = children.as_ref().map(|list| list.len());
        let node = Mp4BoxNode {
            box_type,
            offset: pos,
            size: box_size,
            header_size,
            description,
            fields,
            children,
            children_count,
            is_container: Some(
                is_container_box(&box_type_bytes)
                    || is_stsd_box(&box_type_bytes)
                    || is_sample_entry_box(&box_type_bytes),
            ),
        };

        boxes.push(node);
        total_count += 1;
        pos = box_end;
    }

    Ok((boxes, total_count))
}

/// 解析特定 Box 的字段详情
pub(crate) fn parse_box_fields<R: Read + Seek>(
    reader: &mut R,
    box_type: &str,
    content_start: u64,
    content_size: u64,
) -> Option<Vec<BoxField>> {
    let _ = reader.seek(SeekFrom::Start(content_start));

    match box_type {
        "ftyp" => parse_ftyp_fields(reader, content_size),
        "mvhd" => parse_mvhd_fields(reader),
        "tkhd" => parse_tkhd_fields(reader),
        "mdhd" => parse_mdhd_fields(reader),
        "hdlr" => parse_hdlr_fields(reader),
        "stts" => parse_stts_fields(reader),
        "stsc" => parse_stsc_fields(reader),
        "stsz" => parse_stsz_fields(reader),
        "stco" | "co64" => parse_stco_fields(reader, box_type == "co64"),
        "stss" => parse_stss_fields(reader),
        "ctts" => parse_ctts_fields(reader),
        "elst" => parse_elst_fields(reader),
        "mdat" => parse_mdat_fields(reader, content_start, content_size),
        "avcC" => parse_avcc_fields(reader, content_size),
        "hvcC" => parse_hvcc_fields(reader, content_size),
        _ => None,
    }
}

/// 解析 ftyp box
fn parse_ftyp_fields<R: Read>(reader: &mut R, size: u64) -> Option<Vec<BoxField>> {
    let mut fields = Vec::new();

    let mut brand = [0u8; 4];
    if reader.read_exact(&mut brand).is_err() {
        return None;
    }
    fields.push(
        BoxField::new(
            "major_brand",
            String::from_utf8_lossy(&brand),
            "主品牌标识，表示文件最接近的规范",
        )
        .with_offset(0, 4),
    );

    let mut version = [0u8; 4];
    if reader.read_exact(&mut version).is_err() {
        return None;
    }
    let ver_num = u32::from_be_bytes(version);
    fields.push(
        BoxField::new("minor_version", ver_num, "次版本号，品牌特定的版本信息").with_offset(4, 4),
    );

    // 兼容品牌列表
    let compat_count = ((size - 8) / 4) as usize;
    let mut compat_brands = Vec::new();
    for i in 0..compat_count {
        let mut compat = [0u8; 4];
        if reader.read_exact(&mut compat).is_err() {
            break;
        }
        compat_brands.push(String::from_utf8_lossy(&compat).to_string());
    }
    fields.push(
        BoxField::new(
            "compatible_brands",
            compat_brands.join(", "),
            "兼容品牌列表，表示文件兼容的其他规范",
        )
        .with_offset(8, (size - 8) as u32),
    );

    Some(fields)
}

/// 解析 mvhd box
fn parse_mvhd_fields<R: Read>(reader: &mut R) -> Option<Vec<BoxField>> {
    let mut fields = Vec::new();

    let mut header = [0u8; 4];
    if reader.read_exact(&mut header).is_err() {
        return None;
    }
    let version = header[0];
    fields.push(BoxField::new(
        "version",
        version,
        "版本号，0 为 32 位时间戳，1 为 64 位",
    ));
    fields.push(BoxField::new(
        "flags",
        format!("0x{:02X}{:02X}{:02X}", header[1], header[2], header[3]),
        "标志位（通常为 0）",
    ));

    if version == 1 {
        // 64 位版本
        let mut buf = [0u8; 8];
        reader.read_exact(&mut buf).ok()?;
        fields.push(BoxField::new(
            "creation_time",
            u64::from_be_bytes(buf),
            "创建时间（从 1904-01-01 起的秒数）",
        ));
        reader.read_exact(&mut buf).ok()?;
        fields.push(BoxField::new(
            "modification_time",
            u64::from_be_bytes(buf),
            "修改时间（从 1904-01-01 起的秒数）",
        ));
        let mut buf4 = [0u8; 4];
        reader.read_exact(&mut buf4).ok()?;
        fields.push(BoxField::new(
            "timescale",
            u32::from_be_bytes(buf4),
            "时间刻度（每秒的单位数），用于计算真实时间",
        ));
        reader.read_exact(&mut buf).ok()?;
        let duration = u64::from_be_bytes(buf);
        let timescale = u32::from_be_bytes(buf4);
        let duration_secs = if timescale > 0 {
            duration as f64 / timescale as f64
        } else {
            0.0
        };
        fields.push(BoxField::new(
            "duration",
            format!("{} ({:.3}s)", duration, duration_secs),
            "总时长（timescale 单位）",
        ));
    } else {
        // 32 位版本
        let mut buf = [0u8; 4];
        reader.read_exact(&mut buf).ok()?;
        fields.push(BoxField::new(
            "creation_time",
            u32::from_be_bytes(buf),
            "创建时间（从 1904-01-01 起的秒数）",
        ));
        reader.read_exact(&mut buf).ok()?;
        fields.push(BoxField::new(
            "modification_time",
            u32::from_be_bytes(buf),
            "修改时间（从 1904-01-01 起的秒数）",
        ));
        reader.read_exact(&mut buf).ok()?;
        let timescale = u32::from_be_bytes(buf);
        fields.push(BoxField::new(
            "timescale",
            timescale,
            "时间刻度（每秒的单位数），用于计算真实时间",
        ));
        reader.read_exact(&mut buf).ok()?;
        let duration = u32::from_be_bytes(buf);
        let duration_secs = if timescale > 0 {
            duration as f64 / timescale as f64
        } else {
            0.0
        };
        fields.push(BoxField::new(
            "duration",
            format!("{} ({:.3}s)", duration, duration_secs),
            "总时长（timescale 单位）",
        ));
    }

    // 其他字段（简化处理）
    let mut buf = [0u8; 4];
    reader.read_exact(&mut buf).ok()?;
    let rate = u32::from_be_bytes(buf) as f64 / 65536.0;
    fields.push(BoxField::new(
        "rate",
        format!("{:.2}x", rate),
        "播放速率（16.16 定点数），1.0 为正常速度",
    ));

    let mut buf2 = [0u8; 2];
    reader.read_exact(&mut buf2).ok()?;
    let volume = u16::from_be_bytes(buf2) as f64 / 256.0;
    fields.push(BoxField::new(
        "volume",
        format!("{:.2}", volume),
        "音量（8.8 定点数），1.0 为最大音量",
    ));

    Some(fields)
}

/// 解析 tkhd box
fn parse_tkhd_fields<R: Read>(reader: &mut R) -> Option<Vec<BoxField>> {
    let mut fields = Vec::new();

    let mut header = [0u8; 4];
    if reader.read_exact(&mut header).is_err() {
        return None;
    }
    let version = header[0];
    let flags = ((header[1] as u32) << 16) | ((header[2] as u32) << 8) | (header[3] as u32);
    fields.push(BoxField::new(
        "version",
        version,
        "版本号，0 为 32 位，1 为 64 位",
    ));

    let mut flag_desc = Vec::new();
    if flags & 0x01 != 0 {
        flag_desc.push("enabled");
    }
    if flags & 0x02 != 0 {
        flag_desc.push("in_movie");
    }
    if flags & 0x04 != 0 {
        flag_desc.push("in_preview");
    }
    if flags & 0x08 != 0 {
        flag_desc.push("size_is_aspect_ratio");
    }
    fields.push(BoxField::new(
        "flags",
        format!("0x{:06X} ({})", flags, flag_desc.join(", ")),
        "标志位：enabled=轨道启用, in_movie=包含在播放中, in_preview=包含在预览中",
    ));

    if version == 1 {
        let mut buf = [0u8; 8];
        reader.read_exact(&mut buf).ok()?;
        fields.push(BoxField::new(
            "creation_time",
            u64::from_be_bytes(buf),
            "轨道创建时间",
        ));
        reader.read_exact(&mut buf).ok()?;
        fields.push(BoxField::new(
            "modification_time",
            u64::from_be_bytes(buf),
            "轨道修改时间",
        ));
        let mut buf4 = [0u8; 4];
        reader.read_exact(&mut buf4).ok()?;
        fields.push(BoxField::new(
            "track_id",
            u32::from_be_bytes(buf4),
            "轨道唯一标识符，用于在文件中引用此轨道",
        ));
        reader.read_exact(&mut buf4).ok()?; // reserved
        reader.read_exact(&mut buf).ok()?;
        fields.push(BoxField::new(
            "duration",
            u64::from_be_bytes(buf),
            "轨道时长（影片时间刻度单位）",
        ));
    } else {
        let mut buf = [0u8; 4];
        reader.read_exact(&mut buf).ok()?;
        fields.push(BoxField::new(
            "creation_time",
            u32::from_be_bytes(buf),
            "轨道创建时间",
        ));
        reader.read_exact(&mut buf).ok()?;
        fields.push(BoxField::new(
            "modification_time",
            u32::from_be_bytes(buf),
            "轨道修改时间",
        ));
        reader.read_exact(&mut buf).ok()?;
        fields.push(BoxField::new(
            "track_id",
            u32::from_be_bytes(buf),
            "轨道唯一标识符，用于在文件中引用此轨道",
        ));
        reader.read_exact(&mut buf).ok()?; // reserved
        reader.read_exact(&mut buf).ok()?;
        fields.push(BoxField::new(
            "duration",
            u32::from_be_bytes(buf),
            "轨道时长（影片时间刻度单位）",
        ));
    }

    // 跳过一些字段，读取宽高
    let mut skip = [0u8; 52]; // reserved + layer + alt_group + volume + reserved + matrix
    reader.read_exact(&mut skip).ok()?;

    let mut buf = [0u8; 4];
    reader.read_exact(&mut buf).ok()?;
    let width = u32::from_be_bytes(buf) as f64 / 65536.0;
    reader.read_exact(&mut buf).ok()?;
    let height = u32::from_be_bytes(buf) as f64 / 65536.0;
    fields.push(BoxField::new(
        "width",
        format!("{:.2}", width),
        "轨道宽度（16.16 定点数，视频轨道有效）",
    ));
    fields.push(BoxField::new(
        "height",
        format!("{:.2}", height),
        "轨道高度（16.16 定点数，视频轨道有效）",
    ));

    Some(fields)
}

/// 解析 mdhd box
fn parse_mdhd_fields<R: Read>(reader: &mut R) -> Option<Vec<BoxField>> {
    let mut fields = Vec::new();

    let mut header = [0u8; 4];
    if reader.read_exact(&mut header).is_err() {
        return None;
    }
    let version = header[0];
    fields.push(BoxField::new(
        "version",
        version,
        "版本号，0 为 32 位，1 为 64 位",
    ));

    if version == 1 {
        let mut buf = [0u8; 8];
        reader.read_exact(&mut buf).ok()?;
        fields.push(BoxField::new(
            "creation_time",
            u64::from_be_bytes(buf),
            "媒体创建时间",
        ));
        reader.read_exact(&mut buf).ok()?;
        fields.push(BoxField::new(
            "modification_time",
            u64::from_be_bytes(buf),
            "媒体修改时间",
        ));
        let mut buf4 = [0u8; 4];
        reader.read_exact(&mut buf4).ok()?;
        let timescale = u32::from_be_bytes(buf4);
        fields.push(BoxField::new(
            "timescale",
            timescale,
            "媒体时间刻度（每秒的单位数），计算采样时间的基准",
        ));
        reader.read_exact(&mut buf).ok()?;
        let duration = u64::from_be_bytes(buf);
        let duration_secs = if timescale > 0 {
            duration as f64 / timescale as f64
        } else {
            0.0
        };
        fields.push(BoxField::new(
            "duration",
            format!("{} ({:.3}s)", duration, duration_secs),
            "媒体时长（timescale 单位）",
        ));
    } else {
        let mut buf = [0u8; 4];
        reader.read_exact(&mut buf).ok()?;
        fields.push(BoxField::new(
            "creation_time",
            u32::from_be_bytes(buf),
            "媒体创建时间",
        ));
        reader.read_exact(&mut buf).ok()?;
        fields.push(BoxField::new(
            "modification_time",
            u32::from_be_bytes(buf),
            "媒体修改时间",
        ));
        reader.read_exact(&mut buf).ok()?;
        let timescale = u32::from_be_bytes(buf);
        fields.push(BoxField::new(
            "timescale",
            timescale,
            "媒体时间刻度（每秒的单位数），计算采样时间的基准",
        ));
        reader.read_exact(&mut buf).ok()?;
        let duration = u32::from_be_bytes(buf);
        let duration_secs = if timescale > 0 {
            duration as f64 / timescale as f64
        } else {
            0.0
        };
        fields.push(BoxField::new(
            "duration",
            format!("{} ({:.3}s)", duration, duration_secs),
            "媒体时长（timescale 单位）",
        ));
    }

    // 语言
    let mut lang = [0u8; 2];
    reader.read_exact(&mut lang).ok()?;
    let lang_code = u16::from_be_bytes(lang);
    // ISO-639-2 编码：5位字符 * 3
    let c1 = ((lang_code >> 10) & 0x1F) as u8 + 0x60;
    let c2 = ((lang_code >> 5) & 0x1F) as u8 + 0x60;
    let c3 = (lang_code & 0x1F) as u8 + 0x60;
    let lang_str = format!("{}{}{}", c1 as char, c2 as char, c3 as char);
    fields.push(BoxField::new(
        "language",
        lang_str,
        "ISO-639-2 语言代码（如 und=未定义, eng=英语, zho=中文）",
    ));

    Some(fields)
}

/// 解析 hdlr box
fn parse_hdlr_fields<R: Read>(reader: &mut R) -> Option<Vec<BoxField>> {
    let mut fields = Vec::new();

    let mut header = [0u8; 4];
    if reader.read_exact(&mut header).is_err() {
        return None;
    }
    fields.push(BoxField::new("version", header[0], "版本号"));

    let mut pre_defined = [0u8; 4];
    reader.read_exact(&mut pre_defined).ok()?;

    let mut handler_type = [0u8; 4];
    reader.read_exact(&mut handler_type).ok()?;
    let handler_str = String::from_utf8_lossy(&handler_type).to_string();
    let handler_desc = match handler_str.as_str() {
        "vide" => "视频轨道",
        "soun" => "音频轨道",
        "text" => "文本/字幕轨道",
        "subt" => "字幕轨道",
        "hint" => "提示轨道（用于流媒体）",
        "meta" => "元数据轨道",
        "auxv" => "辅助视频",
        _ => "未知类型",
    };
    fields.push(BoxField::new(
        "handler_type",
        format!("{} ({})", handler_str, handler_desc),
        "处理器类型：vide=视频, soun=音频, text=文本, hint=提示",
    ));

    // 跳过 reserved (12 bytes)
    let mut reserved = [0u8; 12];
    reader.read_exact(&mut reserved).ok()?;

    // 读取 name (剩余字节，以 null 结尾的字符串)
    let mut name = Vec::new();
    loop {
        let mut byte = [0u8; 1];
        if reader.read_exact(&mut byte).is_err() {
            break;
        }
        if byte[0] == 0 {
            break;
        }
        name.push(byte[0]);
    }
    if !name.is_empty() {
        fields.push(BoxField::new(
            "name",
            String::from_utf8_lossy(&name),
            "处理器名称（人类可读的描述）",
        ));
    }

    Some(fields)
}

/// 解析 stts box
fn parse_stts_fields<R: Read>(reader: &mut R) -> Option<Vec<BoxField>> {
    let mut fields = Vec::new();

    let mut header = [0u8; 8];
    if reader.read_exact(&mut header).is_err() {
        return None;
    }
    fields.push(BoxField::new("version", header[0], "版本号"));

    let entry_count = u32::from_be_bytes([header[4], header[5], header[6], header[7]]);
    fields.push(BoxField::new(
        "entry_count",
        entry_count,
        "条目数量，每条描述一组具有相同时长的采样",
    ));

    // 读取所有条目（前端会进行分组显示）
    for i in 0..entry_count as usize {
        let mut entry = [0u8; 8];
        if reader.read_exact(&mut entry).is_err() {
            break;
        }
        let sample_count = u32::from_be_bytes([entry[0], entry[1], entry[2], entry[3]]);
        let sample_delta = u32::from_be_bytes([entry[4], entry[5], entry[6], entry[7]]);
        fields.push(BoxField::new(
            &format!("entry[{}]", i),
            format!("count={}, delta={}", sample_count, sample_delta),
            &format!(
                "第 {} 组：{} 个采样，每个持续 {} timescale 单位",
                i + 1,
                sample_count,
                sample_delta
            ),
        ));
    }

    Some(fields)
}

/// 解析 stsc box
fn parse_stsc_fields<R: Read>(reader: &mut R) -> Option<Vec<BoxField>> {
    let mut fields = Vec::new();

    let mut header = [0u8; 8];
    if reader.read_exact(&mut header).is_err() {
        return None;
    }
    fields.push(BoxField::new("version", header[0], "版本号"));

    let entry_count = u32::from_be_bytes([header[4], header[5], header[6], header[7]]);
    fields.push(BoxField::new(
        "entry_count",
        entry_count,
        "条目数量，定义 Sample 在 Chunk 中的分布规则",
    ));

    // 读取所有条目（前端会进行分组显示）
    for i in 0..entry_count as usize {
        let mut entry = [0u8; 12];
        if reader.read_exact(&mut entry).is_err() {
            break;
        }
        let first_chunk = u32::from_be_bytes([entry[0], entry[1], entry[2], entry[3]]);
        let samples_per_chunk = u32::from_be_bytes([entry[4], entry[5], entry[6], entry[7]]);
        let sample_desc_idx = u32::from_be_bytes([entry[8], entry[9], entry[10], entry[11]]);
        fields.push(BoxField::new(
            &format!("entry[{}]", i),
            format!(
                "first_chunk={}, samples_per_chunk={}, desc_idx={}",
                first_chunk, samples_per_chunk, sample_desc_idx
            ),
            &format!(
                "从第 {} 个 Chunk 开始，每个 Chunk 包含 {} 个采样",
                first_chunk, samples_per_chunk
            ),
        ));
    }

    Some(fields)
}

/// 解析 stsz box
fn parse_stsz_fields<R: Read>(reader: &mut R) -> Option<Vec<BoxField>> {
    let mut fields = Vec::new();

    let mut header = [0u8; 12];
    if reader.read_exact(&mut header).is_err() {
        return None;
    }
    fields.push(BoxField::new("version", header[0], "版本号"));

    let sample_size = u32::from_be_bytes([header[4], header[5], header[6], header[7]]);
    let sample_count = u32::from_be_bytes([header[8], header[9], header[10], header[11]]);

    if sample_size > 0 {
        fields.push(BoxField::new(
            "sample_size",
            format!("{} bytes", sample_size),
            "固定采样大小（所有采样大小相同）",
        ));
    } else {
        fields.push(BoxField::new(
            "sample_size",
            "0 (variable)",
            "可变大小，每个采样大小单独指定",
        ));
    }
    fields.push(BoxField::new("sample_count", sample_count, "采样总数"));

    // 如果是可变大小，显示前几个
    if sample_size == 0 {
        let show_count = sample_count.min(10) as usize;
        let mut sizes = Vec::new();
        for _ in 0..show_count {
            let mut buf = [0u8; 4];
            if reader.read_exact(&mut buf).is_err() {
                break;
            }
            sizes.push(u32::from_be_bytes(buf));
        }
        if !sizes.is_empty() {
            fields.push(BoxField::new(
                "sample_sizes",
                sizes
                    .iter()
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
                    + if sample_count > 10 { "..." } else { "" },
                "各采样的字节大小（前 10 个）",
            ));
        }
    }

    Some(fields)
}

/// 解析 stco/co64 box
fn parse_stco_fields<R: Read>(reader: &mut R, is_64bit: bool) -> Option<Vec<BoxField>> {
    let mut fields = Vec::new();

    let mut header = [0u8; 8];
    if reader.read_exact(&mut header).is_err() {
        return None;
    }
    fields.push(BoxField::new("version", header[0], "版本号"));

    let entry_count = u32::from_be_bytes([header[4], header[5], header[6], header[7]]);
    fields.push(BoxField::new("entry_count", entry_count, "Chunk 数量"));
    fields.push(BoxField::new(
        "offset_size",
        if is_64bit { "64-bit" } else { "32-bit" },
        if is_64bit {
            "使用 64 位偏移量（大文件支持）"
        } else {
            "使用 32 位偏移量"
        },
    ));

    // 显示前几个偏移
    let show_count = entry_count.min(5) as usize;
    let mut offsets = Vec::new();
    for _ in 0..show_count {
        let offset = if is_64bit {
            let mut buf = [0u8; 8];
            if reader.read_exact(&mut buf).is_err() {
                break;
            }
            u64::from_be_bytes(buf)
        } else {
            let mut buf = [0u8; 4];
            if reader.read_exact(&mut buf).is_err() {
                break;
            }
            u32::from_be_bytes(buf) as u64
        };
        offsets.push(format!("0x{:X}", offset));
    }
    if !offsets.is_empty() {
        fields.push(BoxField::new(
            "chunk_offsets",
            offsets.join(", ") + if entry_count > 5 { "..." } else { "" },
            "Chunk 在文件中的字节偏移（用于定位 mdat 中的数据）",
        ));
    }

    Some(fields)
}

/// 解析 stss box
fn parse_stss_fields<R: Read>(reader: &mut R) -> Option<Vec<BoxField>> {
    let mut fields = Vec::new();

    let mut header = [0u8; 8];
    if reader.read_exact(&mut header).is_err() {
        return None;
    }
    fields.push(BoxField::new("version", header[0], "版本号"));

    let entry_count = u32::from_be_bytes([header[4], header[5], header[6], header[7]]);
    fields.push(BoxField::new(
        "entry_count",
        entry_count,
        "同步采样（关键帧）数量",
    ));

    // 显示前几个
    let show_count = entry_count.min(10) as usize;
    let mut sync_samples = Vec::new();
    for _ in 0..show_count {
        let mut buf = [0u8; 4];
        if reader.read_exact(&mut buf).is_err() {
            break;
        }
        sync_samples.push(u32::from_be_bytes(buf));
    }
    if !sync_samples.is_empty() {
        fields.push(BoxField::new(
            "sync_samples",
            sync_samples
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
                .join(", ")
                + if entry_count > 10 { "..." } else { "" },
            "关键帧的采样编号（1-based，用于 seek 定位）",
        ));
    }

    Some(fields)
}

/// 解析 ctts box
fn parse_ctts_fields<R: Read>(reader: &mut R) -> Option<Vec<BoxField>> {
    let mut fields = Vec::new();

    let mut header = [0u8; 8];
    if reader.read_exact(&mut header).is_err() {
        return None;
    }
    let version = header[0];
    fields.push(BoxField::new(
        "version",
        version,
        if version == 0 {
            "版本 0：offset 为无符号数"
        } else {
            "版本 1：offset 可为负数"
        },
    ));

    let entry_count = u32::from_be_bytes([header[4], header[5], header[6], header[7]]);
    fields.push(BoxField::new(
        "entry_count",
        entry_count,
        "条目数量，每条描述一组采样的 CTS 偏移",
    ));

    // 读取所有条目（前端会进行分组显示）
    for i in 0..entry_count as usize {
        let mut entry = [0u8; 8];
        if reader.read_exact(&mut entry).is_err() {
            break;
        }
        let sample_count = u32::from_be_bytes([entry[0], entry[1], entry[2], entry[3]]);
        let offset = if version == 0 {
            u32::from_be_bytes([entry[4], entry[5], entry[6], entry[7]]) as i64
        } else {
            i32::from_be_bytes([entry[4], entry[5], entry[6], entry[7]]) as i64
        };
        fields.push(BoxField::new(
            &format!("entry[{}]", i),
            format!("count={}, offset={}", sample_count, offset),
            &format!(
                "第 {} 组：{} 个采样，CTS = DTS + {}",
                i + 1,
                sample_count,
                offset
            ),
        ));
    }

    Some(fields)
}

/// 解析 elst box
fn parse_elst_fields<R: Read>(reader: &mut R) -> Option<Vec<BoxField>> {
    let mut fields = Vec::new();

    let mut header = [0u8; 8];
    if reader.read_exact(&mut header).is_err() {
        return None;
    }
    let version = header[0];
    fields.push(BoxField::new(
        "version",
        version,
        "版本号，影响时间字段大小",
    ));

    let entry_count = u32::from_be_bytes([header[4], header[5], header[6], header[7]]);
    fields.push(BoxField::new(
        "entry_count",
        entry_count,
        "编辑条目数量，定义时间线的编辑/裁剪",
    ));

    for i in 0..entry_count.min(5) as usize {
        let (segment_duration, media_time) = if version == 1 {
            let mut buf = [0u8; 8];
            reader.read_exact(&mut buf).ok()?;
            let duration = u64::from_be_bytes(buf);
            reader.read_exact(&mut buf).ok()?;
            let time = i64::from_be_bytes(buf);
            (duration, time)
        } else {
            let mut buf = [0u8; 4];
            reader.read_exact(&mut buf).ok()?;
            let duration = u32::from_be_bytes(buf) as u64;
            reader.read_exact(&mut buf).ok()?;
            let time = i32::from_be_bytes(buf) as i64;
            (duration, time)
        };

        // 读取 rate
        let mut rate_buf = [0u8; 4];
        reader.read_exact(&mut rate_buf).ok()?;
        let media_rate = u32::from_be_bytes(rate_buf) as f64 / 65536.0;

        let desc = if media_time == -1 {
            format!("空白段：时长 {}", segment_duration)
        } else {
            format!(
                "媒体段：时长 {}，起点 {}，速率 {:.2}x",
                segment_duration, media_time, media_rate
            )
        };

        fields.push(BoxField::new(
            &format!("entry[{}]", i),
            format!(
                "duration={}, media_time={}, rate={:.2}",
                segment_duration, media_time, media_rate
            ),
            &desc,
        ));
    }

    Some(fields)
}

/// 解析 mdat box - 扫描 NALU 结构
fn parse_mdat_fields<R: Read + Seek>(
    reader: &mut R,
    content_start: u64,
    content_size: u64,
) -> Option<Vec<BoxField>> {
    let mut fields = Vec::new();

    fields.push(BoxField::new(
        "data_size",
        format!(
            "{} bytes ({:.2} MB)",
            content_size,
            content_size as f64 / 1024.0 / 1024.0
        ),
        "媒体数据总大小",
    ));

    // 尝试扫描 NALU 结构（假设使用 4 字节长度前缀，即 AVCC/HVCC 格式）
    // 只扫描前 1MB 或前 20 个 NALU
    let max_scan_size = (1024 * 1024).min(content_size as usize);
    let mut pos = 0u64;
    let mut nalu_count = 0;
    let mut nalu_list: Vec<(u64, u32, String, String)> = Vec::new(); // (offset, size, type, desc)

    let _ = reader.seek(SeekFrom::Start(content_start));

    while pos < max_scan_size as u64 && nalu_count < 20 {
        // 读取 4 字节长度
        let mut len_buf = [0u8; 4];
        if reader.read_exact(&mut len_buf).is_err() {
            break;
        }

        let nalu_len = u32::from_be_bytes(len_buf);

        // 验证长度是否合理
        if nalu_len == 0 || nalu_len > 10 * 1024 * 1024 {
            // 长度不合理，可能不是 AVCC 格式或已经超出边界
            break;
        }

        // 读取第一个字节来判断 NALU 类型
        let mut header = [0u8; 2];
        if reader.read_exact(&mut header).is_err() {
            break;
        }

        // 尝试判断是 AVC 还是 HEVC
        // HEVC: 第一字节的 bit 7 (forbidden_zero_bit) 应该为 0
        // 如果 (header[0] >> 1) & 0x3F 在合理范围内，可能是 HEVC
        let (nalu_type, type_name) = if header[0] & 0x80 == 0 {
            // 可能是 HEVC (forbidden_zero_bit = 0)
            let hevc_type = (header[0] >> 1) & 0x3F;
            if hevc_type <= 47 {
                // HEVC
                let name = match hevc_type {
                    0..=9 => "VCL (TRAIL)",
                    10..=15 => "VCL (TSA/STSA)",
                    16..=21 => "VCL (BLA/IDR/CRA)",
                    19 => "IDR_W_RADL",
                    20 => "IDR_N_LP",
                    21 => "CRA_NUT",
                    32 => "VPS",
                    33 => "SPS",
                    34 => "PPS",
                    35 => "AUD",
                    36 => "EOS",
                    37 => "EOB",
                    38 => "FILLER",
                    39 => "PREFIX_SEI",
                    40 => "SUFFIX_SEI",
                    _ => "HEVC NAL",
                };
                (format!("HEVC:{}", hevc_type), name.to_string())
            } else {
                // 回退到 AVC
                let avc_type = header[0] & 0x1F;
                let name = match avc_type {
                    1 => "Slice (Non-IDR)",
                    5 => "IDR Slice",
                    6 => "SEI",
                    7 => "SPS",
                    8 => "PPS",
                    9 => "AUD",
                    _ => "AVC NAL",
                };
                (format!("AVC:{}", avc_type), name.to_string())
            }
        } else {
            // AVC (forbidden_zero_bit 可能被设置，或者不是 NAL)
            let avc_type = header[0] & 0x1F;
            let name = match avc_type {
                1 => "Slice (Non-IDR)",
                5 => "IDR Slice",
                6 => "SEI",
                7 => "SPS",
                8 => "PPS",
                9 => "AUD",
                _ => "NAL",
            };
            (format!("AVC:{}", avc_type), name.to_string())
        };

        nalu_list.push((content_start + pos, nalu_len, nalu_type, type_name));
        nalu_count += 1;

        // 跳过该 NALU 的剩余部分
        pos += 4 + nalu_len as u64;
        if reader.seek(SeekFrom::Start(content_start + pos)).is_err() {
            break;
        }
    }

    // 统计结果
    if !nalu_list.is_empty() {
        fields.push(BoxField::new(
            "format",
            "AVCC/HVCC (4字节长度前缀)",
            "检测到的数据格式",
        ));

        fields.push(BoxField::new(
            "nalu_count",
            format!("{}+ (扫描了前 {} 个)", nalu_list.len(), nalu_list.len()),
            "扫描到的 NALU 数量（仅扫描前 1MB 或前 20 个）",
        ));

        // 添加每个 NALU 的信息
        for (i, (offset, size, type_code, type_name)) in nalu_list.iter().enumerate() {
            let relative_offset = offset - content_start;
            fields.push(
                BoxField::new(
                    &format!("nalu[{}]", i),
                    format!("{} [{}]", type_name, type_code),
                    &format!(
                        "偏移: +{} (0x{:X}), 大小: {} bytes",
                        relative_offset, offset, size
                    ),
                )
                .with_offset(relative_offset as u32, 4 + *size),
            );
        }
    } else {
        fields.push(BoxField::new(
            "format",
            "未知或 Annex-B",
            "无法识别的格式，可能是 Annex-B 格式或其他编码",
        ));
    }

    Some(fields)
}

/// 解析 avcC (AVC Decoder Configuration Record) box
fn parse_avcc_fields<R: Read>(reader: &mut R, size: u64) -> Option<Vec<BoxField>> {
    let mut fields = Vec::new();

    // 读取整个 avcC 数据
    let mut data = vec![0u8; size as usize];
    if reader.read_exact(&mut data).is_err() {
        return None;
    }

    if data.len() < 7 {
        return None;
    }

    // 基本字段
    let config_version = data[0];
    let avc_profile = data[1];
    let profile_compat = data[2];
    let avc_level = data[3];
    let length_size_minus1 = data[4] & 0x03;

    let profile_name = match avc_profile {
        66 => "Baseline",
        77 => "Main",
        88 => "Extended",
        100 => "High",
        110 => "High 10",
        122 => "High 4:2:2",
        244 => "High 4:4:4 Predictive",
        _ => "Unknown",
    };

    fields.push(BoxField::new(
        "configurationVersion",
        config_version,
        "配置记录版本",
    ));
    fields.push(BoxField::new(
        "AVCProfileIndication",
        format!("{} ({})", avc_profile, profile_name),
        "H.264 Profile",
    ));
    fields.push(BoxField::new(
        "profile_compatibility",
        format!("0x{:02X}", profile_compat),
        "Profile 兼容性标志",
    ));
    fields.push(BoxField::new(
        "AVCLevelIndication",
        format!(
            "{} (Level {}.{})",
            avc_level,
            avc_level / 10,
            avc_level % 10
        ),
        "H.264 Level",
    ));
    fields.push(BoxField::new(
        "lengthSizeMinusOne",
        length_size_minus1,
        "NALU 长度字段大小 - 1（通常为 3，即 4 字节）",
    ));

    // SPS 数量
    let num_sps = data[5] & 0x1F;
    fields.push(BoxField::new(
        "numOfSequenceParameterSets",
        num_sps,
        "SPS 数量",
    ));

    let mut offset = 6usize;

    // 解析 SPS
    for i in 0..num_sps {
        if offset + 2 > data.len() {
            break;
        }
        let sps_len = u16::from_be_bytes([data[offset], data[offset + 1]]) as usize;
        offset += 2;

        if offset + sps_len > data.len() {
            break;
        }
        let sps_data = &data[offset..offset + sps_len];
        offset += sps_len;

        // 解析 SPS 内容
        let mut sps_fields = Vec::new();
        sps_fields.push(BoxField::new(
            "size",
            format!("{} bytes", sps_len),
            "SPS 数据长度",
        ));

        // 调用 SPS 解析
        if sps_len >= 4 {
            // 解析 SPS 参数
            let profile_idc = sps_data.get(1).copied().unwrap_or(0);
            let constraint_flags = sps_data.get(2).copied().unwrap_or(0);
            let level_idc = sps_data.get(3).copied().unwrap_or(0);

            let profile_name = match profile_idc {
                66 => "Baseline",
                77 => "Main",
                88 => "Extended",
                100 => "High",
                110 => "High 10",
                122 => "High 4:2:2",
                244 => "High 4:4:4 Predictive",
                _ => "Unknown",
            };

            sps_fields.push(BoxField::new(
                "profile_idc",
                format!("{} ({})", profile_idc, profile_name),
                "Profile",
            ));
            sps_fields.push(BoxField::new(
                "constraint_set_flags",
                format!("0x{:02X}", constraint_flags),
                "约束标志",
            ));
            sps_fields.push(BoxField::new(
                "level_idc",
                format!(
                    "{} (Level {}.{})",
                    level_idc,
                    level_idc / 10,
                    level_idc % 10
                ),
                "Level",
            ));
        }

        // Hex 预览
        let hex_preview: String = sps_data
            .iter()
            .take(32)
            .map(|b| format!("{:02X}", b))
            .collect::<Vec<_>>()
            .join(" ");
        sps_fields.push(BoxField::new(
            "data_preview",
            format!("{}{}", hex_preview, if sps_len > 32 { " ..." } else { "" }),
            "SPS 原始数据",
        ));

        fields.push(BoxField::new(
            &format!("SPS[{}]", i),
            format!("{} bytes", sps_len),
            &sps_fields
                .iter()
                .map(|f| format!("{}: {}", f.name, f.value))
                .collect::<Vec<_>>()
                .join(" | "),
        ));
    }

    // PPS 数量
    if offset < data.len() {
        let num_pps = data[offset];
        offset += 1;
        fields.push(BoxField::new(
            "numOfPictureParameterSets",
            num_pps,
            "PPS 数量",
        ));

        // 解析 PPS
        for i in 0..num_pps {
            if offset + 2 > data.len() {
                break;
            }
            let pps_len = u16::from_be_bytes([data[offset], data[offset + 1]]) as usize;
            offset += 2;

            if offset + pps_len > data.len() {
                break;
            }
            let pps_data = &data[offset..offset + pps_len];
            offset += pps_len;

            // Hex 预览
            let hex_preview: String = pps_data
                .iter()
                .take(32)
                .map(|b| format!("{:02X}", b))
                .collect::<Vec<_>>()
                .join(" ");

            fields.push(BoxField::new(
                &format!("PPS[{}]", i),
                format!(
                    "{} bytes: {}{}",
                    pps_len,
                    hex_preview,
                    if pps_len > 32 { " ..." } else { "" }
                ),
                "Picture Parameter Set 数据",
            ));
        }
    }

    Some(fields)
}

/// 解析 hvcC (HEVC Decoder Configuration Record) box
fn parse_hvcc_fields<R: Read>(reader: &mut R, size: u64) -> Option<Vec<BoxField>> {
    let mut fields = Vec::new();

    // 读取整个 hvcC 数据
    let mut data = vec![0u8; size as usize];
    if reader.read_exact(&mut data).is_err() {
        return None;
    }

    if data.len() < 23 {
        return None;
    }

    // 基本字段
    let config_version = data[0];
    let general_profile_space = (data[1] >> 6) & 0x03;
    let general_tier_flag = (data[1] >> 5) & 0x01;
    let general_profile_idc = data[1] & 0x1F;
    let general_level_idc = data[12];

    let profile_name = match general_profile_idc {
        1 => "Main",
        2 => "Main 10",
        3 => "Main Still Picture",
        4 => "Range Extensions",
        5 => "High Throughput",
        _ => "Unknown",
    };

    fields.push(BoxField::new(
        "configurationVersion",
        config_version,
        "配置记录版本",
    ));
    fields.push(BoxField::new(
        "general_profile_space",
        general_profile_space,
        "Profile 空间",
    ));
    fields.push(BoxField::new(
        "general_tier_flag",
        if general_tier_flag == 0 {
            "Main Tier"
        } else {
            "High Tier"
        },
        "Tier 标志",
    ));
    fields.push(BoxField::new(
        "general_profile_idc",
        format!("{} ({})", general_profile_idc, profile_name),
        "HEVC Profile",
    ));
    fields.push(BoxField::new(
        "general_level_idc",
        format!(
            "{} (Level {:.1})",
            general_level_idc,
            general_level_idc as f32 / 30.0
        ),
        "HEVC Level",
    ));

    // NALU 长度大小
    let length_size_minus1 = data[21] & 0x03;
    fields.push(BoxField::new(
        "lengthSizeMinusOne",
        length_size_minus1,
        "NALU 长度字段大小 - 1",
    ));

    // 参数集数量
    let num_of_arrays = data[22];
    fields.push(BoxField::new(
        "numOfArrays",
        num_of_arrays,
        "参数集数组数量",
    ));

    let mut offset = 23usize;

    // 解析参数集数组
    for array_idx in 0..num_of_arrays {
        if offset + 3 > data.len() {
            break;
        }

        let array_completeness = (data[offset] >> 7) & 0x01;
        let nal_unit_type = data[offset] & 0x3F;
        offset += 1;

        let num_nalus = u16::from_be_bytes([data[offset], data[offset + 1]]) as usize;
        offset += 2;

        let type_name = match nal_unit_type {
            32 => "VPS",
            33 => "SPS",
            34 => "PPS",
            39 => "PREFIX_SEI",
            40 => "SUFFIX_SEI",
            _ => "Unknown",
        };

        for nalu_idx in 0..num_nalus {
            if offset + 2 > data.len() {
                break;
            }
            let nalu_len = u16::from_be_bytes([data[offset], data[offset + 1]]) as usize;
            offset += 2;

            if offset + nalu_len > data.len() {
                break;
            }
            let nalu_data = &data[offset..offset + nalu_len];
            offset += nalu_len;

            // Hex 预览
            let hex_preview: String = nalu_data
                .iter()
                .take(32)
                .map(|b| format!("{:02X}", b))
                .collect::<Vec<_>>()
                .join(" ");

            fields.push(BoxField::new(
                &format!("{}[{}]", type_name, nalu_idx),
                format!(
                    "{} bytes: {}{}",
                    nalu_len,
                    hex_preview,
                    if nalu_len > 32 { " ..." } else { "" }
                ),
                &format!("{} Parameter Set", type_name),
            ));
        }
    }

    Some(fields)
}
