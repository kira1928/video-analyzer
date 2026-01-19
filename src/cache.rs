// WASM 端缓存解析结果并提供分页 API

use crate::types::{AnalysisResult, SegmentInfo};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use wasm_bindgen::prelude::*;

// 全局缓存：存储解析结果
static RESULT_CACHE: Lazy<Mutex<HashMap<String, Box<AnalysisResult>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// 内部函数：直接缓存 AnalysisResult（不经过 JS 反序列化）
/// 这是性能优化的关键 - 避免了昂贵的 serde_wasm_bindgen::from_value 调用
pub fn cache_result_internal(file_id: String, result: AnalysisResult) {
    let mut cache = RESULT_CACHE.lock().unwrap();
    cache.insert(file_id, Box::new(result));
}

/// 缓存解析结果（由 Worker 调用）
/// ⚠️ 已弃用：此函数需要反序列化整个对象，性能很差
/// 请使用流式解析器的 parse_and_cache 方法代替
#[wasm_bindgen(js_name = cacheParseResult)]
pub fn cache_parse_result(file_id: String, result: JsValue) -> Result<(), JsValue> {
    // 直接从 JsValue 反序列化
    let parsed: AnalysisResult = serde_wasm_bindgen::from_value(result)
        .map_err(|e| JsValue::from_str(&format!("Failed to deserialize result: {}", e)))?;

    let mut cache = RESULT_CACHE.lock().unwrap();
    cache.insert(file_id, Box::new(parsed));

    Ok(())
}

#[derive(Serialize)]
struct Metadata {
    format: String,
    #[serde(rename = "fileSize")]
    file_size: u64,
    duration: f64,
    #[serde(rename = "totalSamples")]
    total_samples: usize,
    #[serde(rename = "totalGops")]
    total_gops: usize,
    #[serde(rename = "videoTagCount")]
    video_tag_count: usize,
    #[serde(rename = "audioTagCount")]
    audio_tag_count: usize,
    #[serde(rename = "keyframeCount")]
    keyframe_count: usize,
    #[serde(rename = "hasSegments")]
    has_segments: bool,
    #[serde(rename = "segments", skip_serializing_if = "Option::is_none")]
    segments: Option<SegmentInfo>,
    #[serde(rename = "videoInitData", skip_serializing_if = "Option::is_none")]
    video_init_data: Option<Vec<u8>>,
    #[serde(rename = "audioInitData", skip_serializing_if = "Option::is_none")]
    audio_init_data: Option<Vec<u8>>,
}

/// 获取元数据（不包含所有 tags 和 gops）
#[wasm_bindgen(js_name = getMetadata)]
pub fn get_metadata(file_id: String) -> Result<JsValue, JsValue> {
    let cache = RESULT_CACHE.lock().unwrap();

    if let Some(result) = cache.get(&file_id) {
        let metadata = Metadata {
            format: result.format.clone(),
            file_size: result.file_size,
            duration: result.duration,
            total_samples: result.tags.len(),
            total_gops: result.gops.len(),
            video_tag_count: result.video_tag_count,
            audio_tag_count: result.audio_tag_count,
            keyframe_count: result.keyframe_count,
            has_segments: result.segments.is_some(),
            segments: result.segments.clone(),
            video_init_data: result.video_init_data.clone(),
            audio_init_data: result.audio_init_data.clone(),
        };

        serde_wasm_bindgen::to_value(&metadata)
            .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
    } else {
        Err(JsValue::from_str("File not found in cache"))
    }
}

/// 分页获取 samples
#[wasm_bindgen(js_name = getSamplesBatch)]
pub fn get_samples_batch(file_id: String, start: usize, count: usize) -> Result<JsValue, JsValue> {
    let cache = RESULT_CACHE.lock().unwrap();

    if let Some(result) = cache.get(&file_id) {
        let end = std::cmp::min(start + count, result.tags.len());

        if start >= result.tags.len() {
            return Err(JsValue::from_str("Start index out of bounds"));
        }

        let batch = &result.tags[start..end];
        serde_wasm_bindgen::to_value(batch)
            .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
    } else {
        Err(JsValue::from_str("File not found in cache"))
    }
}

/// 分页获取 GOPs
#[wasm_bindgen(js_name = getGopsBatch)]
pub fn get_gops_batch(file_id: String, start: usize, count: usize) -> Result<JsValue, JsValue> {
    let cache = RESULT_CACHE.lock().unwrap();

    if let Some(result) = cache.get(&file_id) {
        let end = std::cmp::min(start + count, result.gops.len());

        if start >= result.gops.len() {
            return Err(JsValue::from_str("Start index out of bounds"));
        }

        let batch = &result.gops[start..end];
        serde_wasm_bindgen::to_value(batch)
            .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
    } else {
        Err(JsValue::from_str("File not found in cache"))
    }
}

/// 获取单个 sample
#[wasm_bindgen(js_name = getSample)]
pub fn get_sample(file_id: String, index: usize) -> Result<JsValue, JsValue> {
    let cache = RESULT_CACHE.lock().unwrap();

    if let Some(result) = cache.get(&file_id) {
        if index < result.tags.len() {
            serde_wasm_bindgen::to_value(&result.tags[index])
                .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
        } else {
            Err(JsValue::from_str("Index out of bounds"))
        }
    } else {
        Err(JsValue::from_str("File not found in cache"))
    }
}

/// 清除缓存
#[wasm_bindgen(js_name = clearResultCache)]
pub fn clear_result_cache(file_id: Option<String>) -> Result<(), JsValue> {
    let mut cache = RESULT_CACHE.lock().unwrap();

    if let Some(id) = file_id {
        cache.remove(&id);
    } else {
        cache.clear();
    }

    Ok(())
}
