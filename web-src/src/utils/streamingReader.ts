/**
 * 流式文件读取器
 * 
 * 用于大文件的按需读取，避免将整个文件加载到内存
 */

/**
 * 创建一个文件读取回调函数
 * 该函数可以传递给 WASM 的 StreamingMp4Parser
 * 
 * @param file - 要读取的 File 对象
 * @returns 读取回调函数 (offset: number, length: number) => Promise<Uint8Array>
 */
export function createFileReader(file: File): (offset: number, length: number) => Promise<Uint8Array> {
  return async (offset: number, length: number): Promise<Uint8Array> => {
    // 使用 File.slice() 只读取需要的部分
    const blob = file.slice(offset, offset + length);
    const buffer = await blob.arrayBuffer();
    return new Uint8Array(buffer);
  };
}

/**
 * 检测文件格式
 * 通过读取文件头部来判断格式
 */
export async function detectFileFormat(file: File): Promise<'flv' | 'mp4' | 'ts' | 'unknown'> {
  const header = await readFileRange(file, 0, 12);

  // FLV: 开头是 "FLV"
  if (header[0] === 0x46 && header[1] === 0x4C && header[2] === 0x56) {
    return 'flv';
  }

  // MP4: 检查 ftyp box
  // 格式: [4字节 size][4字节 "ftyp"]
  const boxType = String.fromCharCode(header[4], header[5], header[6], header[7]);
  if (boxType === 'ftyp') {
    return 'mp4';
  }

  // 也可能是 moov 开头的 MP4（无 ftyp）
  if (boxType === 'moov' || boxType === 'mdat' || boxType === 'free' || boxType === 'skip') {
    return 'mp4';
  }

  // TS: 检查同步字节 0x47
  if (header[0] === 0x47) {
    // 进一步验证：每 188 字节应该有一个 0x47
    if (file.size >= 376) {
      const check = await readFileRange(file, 188, 1);
      if (check[0] === 0x47) {
        return 'ts';
      }
    }
    return 'ts';
  }

  return 'unknown';
}

/**
 * 读取文件指定范围的数据
 */
export async function readFileRange(file: File, offset: number, length: number): Promise<Uint8Array> {
  const blob = file.slice(offset, offset + length);
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * 文件大小阈值（字节）
 * 超过此大小的文件将使用流式解析
 */
export const STREAMING_THRESHOLD = 500 * 1024 * 1024; // 500MB

/**
 * 判断是否应该使用流式解析
 */
export function shouldUseStreaming(file: File): boolean {
  return file.size > STREAMING_THRESHOLD;
}

/**
 * 格式化文件大小
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
