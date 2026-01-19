//! 流式文件读取接口
//!
//! 提供 WASM 和 JS 之间的数据读取桥接

use js_sys::{Function, Promise, Uint8Array};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

/// JS 端文件读取器的封装
/// 通过 JS 回调按需读取文件数据
#[wasm_bindgen]
pub struct StreamingFileReader {
    /// 文件总大小
    file_size: u64,
    /// JS 端的读取回调函数
    /// 签名: (offset: number, length: number) => Promise<Uint8Array>
    read_callback: Function,
    /// 缓存的数据块（用于减少 JS 调用开销）
    cache: Option<CachedChunk>,
}

struct CachedChunk {
    offset: u64,
    data: Vec<u8>,
}

#[wasm_bindgen]
impl StreamingFileReader {
    #[wasm_bindgen(constructor)]
    pub fn new(file_size: f64, read_callback: Function) -> Self {
        Self {
            file_size: file_size as u64,
            read_callback,
            cache: None,
        }
    }

    /// 获取文件大小
    #[wasm_bindgen(getter)]
    pub fn size(&self) -> f64 {
        self.file_size as f64
    }
}

impl StreamingFileReader {
    /// 读取指定范围的数据（内部使用，同步等待 JS Promise）
    pub async fn read_range(&mut self, offset: u64, length: usize) -> Result<Vec<u8>, String> {
        // 检查缓存
        if let Some(ref cache) = self.cache {
            if offset >= cache.offset
                && offset + length as u64 <= cache.offset + cache.data.len() as u64
            {
                let start = (offset - cache.offset) as usize;
                return Ok(cache.data[start..start + length].to_vec());
            }
        }

        // 调用 JS 回调
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
        let data = array.to_vec();

        // 更新缓存（如果数据块较小则缓存）
        if length <= 1024 * 1024 {
            // 小于 1MB 则缓存
            self.cache = Some(CachedChunk {
                offset,
                data: data.clone(),
            });
        }

        Ok(data)
    }

    /// 读取指定范围并返回切片的数据
    pub async fn read_exact(&mut self, offset: u64, length: usize) -> Result<Vec<u8>, String> {
        if offset + length as u64 > self.file_size {
            return Err(format!(
                "读取范围超出文件大小: offset={}, length={}, file_size={}",
                offset, length, self.file_size
            ));
        }
        self.read_range(offset, length).await
    }

    /// 获取文件大小
    pub fn file_size(&self) -> u64 {
        self.file_size
    }
}

/// 用于解析头部的小型缓冲读取器
pub struct BufferedReader {
    data: Vec<u8>,
    position: usize,
}

impl BufferedReader {
    pub fn new(data: Vec<u8>) -> Self {
        Self { data, position: 0 }
    }

    pub fn read_u8(&mut self) -> Option<u8> {
        if self.position < self.data.len() {
            let value = self.data[self.position];
            self.position += 1;
            Some(value)
        } else {
            None
        }
    }

    pub fn read_u16_be(&mut self) -> Option<u16> {
        if self.position + 2 <= self.data.len() {
            let value =
                u16::from_be_bytes([self.data[self.position], self.data[self.position + 1]]);
            self.position += 2;
            Some(value)
        } else {
            None
        }
    }

    pub fn read_u32_be(&mut self) -> Option<u32> {
        if self.position + 4 <= self.data.len() {
            let value = u32::from_be_bytes([
                self.data[self.position],
                self.data[self.position + 1],
                self.data[self.position + 2],
                self.data[self.position + 3],
            ]);
            self.position += 4;
            Some(value)
        } else {
            None
        }
    }

    pub fn read_u64_be(&mut self) -> Option<u64> {
        if self.position + 8 <= self.data.len() {
            let mut bytes = [0u8; 8];
            bytes.copy_from_slice(&self.data[self.position..self.position + 8]);
            self.position += 8;
            Some(u64::from_be_bytes(bytes))
        } else {
            None
        }
    }

    pub fn read_bytes(&mut self, len: usize) -> Option<&[u8]> {
        if self.position + len <= self.data.len() {
            let slice = &self.data[self.position..self.position + len];
            self.position += len;
            Some(slice)
        } else {
            None
        }
    }

    pub fn skip(&mut self, len: usize) -> bool {
        if self.position + len <= self.data.len() {
            self.position += len;
            true
        } else {
            false
        }
    }

    pub fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.position)
    }

    pub fn position(&self) -> usize {
        self.position
    }

    pub fn set_position(&mut self, pos: usize) {
        self.position = pos.min(self.data.len());
    }
}
