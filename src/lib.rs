//! Video Analyzer - FLV 视频文件分析工具
//!
//! 这是一个用于分析 FLV 视频文件的 WASM 库。
//! 功能包括：
//! - FLV 文件解析
//! - GOP 分析
//! - 时间戳异常检测
//! - HEVC 工具（Annex B/HVCC 转换、codec string 生成）
//! - Tag 详情解析（字段树、Hex dump）

use wasm_bindgen::prelude::*;

pub mod analyzer;
pub mod flv;
pub mod hevc;
pub mod types;

use analyzer::{generate_hex_dump, parse_tag_fields, Analyzer};
use types::*;

// 初始化 panic hook（更好的错误信息）
#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

// ==================== FLV 分析接口 ====================

/// 解析 FLV 文件
#[wasm_bindgen(js_name = parseFLV)]
pub fn parse_flv(data: &[u8]) -> Result<JsValue, JsError> {
    let result = Analyzer::analyze(data).map_err(|e| JsError::new(&e))?;
    serde_wasm_bindgen::to_value(&result).map_err(|e| JsError::new(&e.to_string()))
}

/// 获取 GOP 中的标签
#[wasm_bindgen(js_name = getGOPTags)]
pub fn get_gop_tags(result_json: &str, gop_index: usize) -> Result<JsValue, JsError> {
    let result: AnalysisResult =
        serde_json::from_str(result_json).map_err(|e| JsError::new(&e.to_string()))?;

    let (start_idx, end_idx, tags) =
        Analyzer::get_gop_tags(&result, gop_index).map_err(|e| JsError::new(&e))?;

    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct GopTagsResult {
        start_index: usize,
        end_index: usize,
        tags: Vec<TagSummary>,
    }

    let response = GopTagsResult {
        start_index: start_idx,
        end_index: end_idx,
        tags,
    };

    serde_wasm_bindgen::to_value(&response).map_err(|e| JsError::new(&e.to_string()))
}

// ==================== Tag 详情接口 ====================

/// 获取 Tag 详情（字段树 + Hex dump）
#[wasm_bindgen(js_name = getTagDetail)]
pub fn get_tag_detail(
    result_json: &str,
    tag_index: usize,
    file_data: &[u8],
) -> Result<JsValue, JsError> {
    let result: AnalysisResult =
        serde_json::from_str(result_json).map_err(|e| JsError::new(&e.to_string()))?;

    if tag_index >= result.tags.len() {
        return Err(JsError::new(&format!("无效的 Tag 索引: {}", tag_index)));
    }

    let tag = &result.tags[tag_index];
    let tag_offset = tag.offset as usize;
    let total_size = tag.size + 11;
    let max_bytes = 256.min(total_size as usize);

    // 提取 tag 数据
    let end_offset = (tag_offset + max_bytes).min(file_data.len());
    let tag_data = &file_data[tag_offset..end_offset];

    // 解析字段
    let fields = parse_tag_fields(tag, tag_data);

    // 生成 Hex dump
    let hex_lines = generate_hex_dump(tag_data, tag.offset, max_bytes, &fields);

    let detail = TagDetail {
        tag_index,
        tag_type: tag.tag_type.clone(),
        timestamp: tag.timestamp,
        size: tag.size,
        offset: tag.offset,
        total_size,
        fields,
        hex_lines,
    };

    serde_wasm_bindgen::to_value(&detail).map_err(|e| JsError::new(&e.to_string()))
}

// ==================== HEVC 工具接口 ====================

/// 检测是否为 Annex B 格式
#[wasm_bindgen(js_name = isAnnexBFormat)]
pub fn is_annex_b_format(data: &[u8]) -> bool {
    hevc::is_annex_b_format(data)
}

/// 将 Annex B 格式转换为 HVCC
#[wasm_bindgen(js_name = convertAnnexBToHVCC)]
pub fn convert_annex_b_to_hvcc(data: &[u8]) -> Result<Vec<u8>, JsError> {
    hevc::convert_annex_b_to_hvcc(data).map_err(|e| JsError::new(&e))
}

/// 将 Annex B 格式转换为 AVCC（带长度前缀）
#[wasm_bindgen(js_name = convertAnnexBToAVCC)]
pub fn convert_annex_b_to_avcc(data: &[u8]) -> Vec<u8> {
    hevc::convert_annex_b_to_avcc(data)
}

/// 生成 HEVC codec string
#[wasm_bindgen(js_name = generateHEVCCodecString)]
pub fn generate_hevc_codec_string(
    hvcc_data: &[u8],
    compat_mode: &str,
    constraint_mode: &str,
) -> String {
    let options = hevc::CodecStringOptions {
        compat_mode: compat_mode.to_string(),
        constraint_mode: constraint_mode.to_string(),
    };
    hevc::generate_codec_string(hvcc_data, &options)
}

// ==================== 工具函数 ====================

/// 获取库版本
#[wasm_bindgen(js_name = getVersion)]
pub fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
