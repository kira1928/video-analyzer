/**
 * 内存调试工具
 * 
 * 提供内存使用情况的监控和显示
 */

export interface MemoryStats {
  /** JS Heap 已使用（MB） */
  jsHeapUsed: number;
  /** JS Heap 总量（MB） */
  jsHeapTotal: number;
  /** IndexedDB 缓存大小（MB） */
  indexedDBSize: number;
  /** 文件信息 */
  currentFileSize: number;
  /** 是否流式模式 */
  isStreamingMode: boolean;
  /** ArrayBuffer 估计大小（MB） */
  arrayBufferEstimate: number;
}

/**
 * 获取当前内存使用情况
 */
export async function getMemoryStats(options: {
  currentFileSize?: number;
  isStreamingMode?: boolean;
  fileDataSize?: number;
}): Promise<MemoryStats> {
  const stats: MemoryStats = {
    jsHeapUsed: 0,
    jsHeapTotal: 0,
    indexedDBSize: 0,
    currentFileSize: options.currentFileSize || 0,
    isStreamingMode: options.isStreamingMode || false,
    arrayBufferEstimate: options.fileDataSize ? options.fileDataSize / (1024 * 1024) : 0,
  };

  // 获取 JS Heap 信息（如果可用）
  if ('memory' in performance) {
    const memory = (performance as any).memory;
    stats.jsHeapUsed = memory.usedJSHeapSize / (1024 * 1024);
    stats.jsHeapTotal = memory.totalJSHeapSize / (1024 * 1024);
  }

  // 获取 IndexedDB 大小
  try {
    stats.indexedDBSize = await estimateIndexedDBSize();
  } catch (e) {
    console.warn('无法获取 IndexedDB 大小:', e);
  }

  return stats;
}

/**
 * 估计 IndexedDB 使用的存储空间
 */
async function estimateIndexedDBSize(): Promise<number> {
  if ('storage' in navigator && 'estimate' in navigator.storage) {
    const estimate = await navigator.storage.estimate();
    return (estimate.usage || 0) / (1024 * 1024);
  }
  return 0;
}

/**
 * 格式化内存大小
 */
export function formatMemorySize(mb: number): string {
  if (mb < 1) {
    return `${(mb * 1024).toFixed(0)} KB`;
  }
  if (mb < 1024) {
    return `${mb.toFixed(1)} MB`;
  }
  return `${(mb / 1024).toFixed(2)} GB`;
}

/**
 * 清除所有缓存
 * 包括 IndexedDB、OPFS、音频缓存等
 */
export async function clearAllCaches(): Promise<{
  indexedDB: boolean;
  opfs: boolean;
  caches: boolean;
}> {
  const results = {
    indexedDB: false,
    opfs: false,
    caches: false,
  };

  // 1. 清除 IndexedDB 数据库
  try {
    const databases = await indexedDB.databases();
    console.log('检测到的 IndexedDB 数据库:', databases.map(db => db.name));

    for (const db of databases) {
      if (db.name) {
        console.log(`正在删除数据库: ${db.name}`);
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(db.name!);

          request.onsuccess = () => {
            console.log(`成功删除数据库: ${db.name}`);
            resolve();
          };

          request.onerror = () => {
            console.error(`删除数据库失败: ${db.name}`, request.error);
            reject(request.error);
          };

          request.onblocked = () => {
            console.warn(`数据库删除被阻塞: ${db.name}，可能有打开的连接`);
            // 即使被阻塞，也尝试关闭所有连接后重试
            setTimeout(() => {
              console.log(`重试删除: ${db.name}`);
              const retryRequest = indexedDB.deleteDatabase(db.name!);
              retryRequest.onsuccess = () => resolve();
              retryRequest.onerror = () => reject(retryRequest.error);
            }, 100);
          };

          // 超时保护
          setTimeout(() => {
            console.warn(`删除数据库超时: ${db.name}`);
            resolve(); // 不阻塞其他清理操作
          }, 5000);
        });
      }
    }
    results.indexedDB = true;
    console.log('IndexedDB 缓存已清除');
  } catch (e) {
    console.error('清除 IndexedDB 失败:', e);
  }

  // 2. 清除 OPFS（Origin Private File System）
  try {
    if ('storage' in navigator && 'getDirectory' in navigator.storage) {
      const root = await navigator.storage.getDirectory();
      // 遍历并删除所有文件和目录
      for await (const [name] of (root as any).entries()) {
        await root.removeEntry(name, { recursive: true });
      }
      results.opfs = true;
      console.log('OPFS 缓存已清除');
    }
  } catch (e) {
    console.warn('清除 OPFS 失败:', e);
  }

  // 3. 清除 Cache Storage
  try {
    const cacheNames = await caches.keys();
    for (const name of cacheNames) {
      await caches.delete(name);
    }
    results.caches = true;
    console.log('Cache Storage 已清除');
  } catch (e) {
    console.warn('清除 Cache Storage 失败:', e);
  }

  return results;
}
