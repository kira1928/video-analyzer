/**
 * GOP 帧缓存服务
 * 
 * 用于缓存已解码的 GOP 帧信息，避免重复解析。
 * 页面刷新后自动清除。
 */

export interface CachedFrame {
  tagIndex: number;
  timestamp: number;
  isKeyframe: boolean;
  thumbnail: ImageBitmap | null; // 缩略图
  fullFrame: ImageBitmap | null; // 完整帧
}

export interface CachedGop {
  gopIndex: number;
  frames: CachedFrame[];
  decodedAt: number; // 解码时间戳
}

// 内存缓存 - 页面刷新后自动清除
const gopCache = new Map<number, CachedGop>();

/**
 * 获取缓存的 GOP 帧
 */
export function getCachedGop(gopIndex: number): CachedGop | null {
  return gopCache.get(gopIndex) ?? null;
}

/**
 * 设置 GOP 帧缓存
 */
export function setCachedGop(gopIndex: number, gop: CachedGop): void {
  gopCache.set(gopIndex, gop);
}

/**
 * 检查 GOP 是否已缓存
 */
export function isGopCached(gopIndex: number): boolean {
  return gopCache.has(gopIndex);
}

/**
 * 清除所有缓存
 */
export function clearGopCache(): void {
  // 释放所有 ImageBitmap
  gopCache.forEach(gop => {
    gop.frames.forEach(frame => {
      frame.thumbnail?.close();
      frame.fullFrame?.close();
    });
  });
  gopCache.clear();
}

/**
 * 获取缓存统计
 */
export function getGopCacheStats(): { count: number; frameCount: number } {
  let frameCount = 0;
  gopCache.forEach(gop => {
    frameCount += gop.frames.length;
  });
  return { count: gopCache.size, frameCount };
}

/**
 * 根据 Tag Index 查找对应的缓存帧
 */
export function getCachedFrameByTagIndex(tagIndex: number): { gopIndex: number; frame: CachedFrame } | null {
  for (const [gopIndex, gop] of gopCache) {
    const frame = gop.frames.find(f => f.tagIndex === tagIndex);
    if (frame) {
      return { gopIndex, frame };
    }
  }
  return null;
}
