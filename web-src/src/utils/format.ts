/** 格式化字节数为人类可读的字符串 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/** 格式化时长为 HH:MM:SS 格式 */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** 格式化时间戳（毫秒）为秒 */
export function formatTimestamp(ms: number): string {
  return (ms / 1000).toFixed(3) + 's';
}

/** 格式化文件偏移量 */
export function formatOffset(offset: number): string {
  if (offset >= 1024 * 1024) return (offset / 1024 / 1024).toFixed(1) + 'MB';
  if (offset >= 1024) return (offset / 1024).toFixed(1) + 'KB';
  return offset + 'B';
}

/** 获取编解码器名称 */
export function getCodecName(codecId: number | undefined): string {
  const names: Record<number, string> = {
    2: 'Sorenson H.263',
    3: 'Screen Video',
    4: 'VP6',
    5: 'VP6 Alpha',
    6: 'Screen Video 2',
    7: 'AVC (H.264)',
    12: 'HEVC (H.265)',
  };
  return codecId !== undefined ? (names[codecId] || `Unknown (${codecId})`) : 'Unknown';
}

/** 下载 Blob 文件 */
export function downloadBlob(data: BlobPart, filename: string): void {
  const blob = new Blob([data], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
