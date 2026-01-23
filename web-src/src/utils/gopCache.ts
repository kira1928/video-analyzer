// GOP Cache Utils (OPFS + IndexedDB + Memory)

export interface CachedFrame {
  fileId: string;
  tagIndex: number;
  blob: Blob;
  thumbnail?: string; // Base64 DataURL or Blob URL
  timestamp: number;  // For LRU
}

interface CachedFrameMeta {
  fileId: string;
  tagIndex: number;
  hasThumbnail: boolean;
  timestamp: number;
  frameBytes?: number;
  thumbBytes?: number;
}

interface CachedAudioMeta {
  fileId: string;
  gopIndex: number;
  timestamp: number;
  sampleRate: number;
  channels: number;
  length: number;
  bytes: number;
}

const DB_NAME = 'VideoAnalyzerCache';
const STORE_NAME = 'frames';
const AUDIO_STORE_NAME = 'audio';
const MAX_OPFS_BYTES = 500 * 1024 * 1024;
const ESTIMATED_FRAME_BYTES = 180 * 1024;
const ESTIMATED_THUMB_BYTES = 12 * 1024;
const AUDIO_HEADER_BYTES = 16;

// === 缓存开关 ===
let cacheEnabled = true;
const CACHE_ENABLED_KEY = 'videoAnalyzer_cacheEnabled';

// 初始化时从 localStorage 读取设置
try {
  const saved = localStorage.getItem(CACHE_ENABLED_KEY);
  if (saved !== null) {
    cacheEnabled = saved === 'true';
  }
} catch (e) {
  // localStorage 不可用
}

export function isCacheEnabled(): boolean {
  return cacheEnabled;
}

export function setCacheEnabled(enabled: boolean): void {
  cacheEnabled = enabled;
  try {
    localStorage.setItem(CACHE_ENABLED_KEY, String(enabled));
  } catch (e) {
    // localStorage 不可用
  }
}

function estimateMetaBytes(meta: CachedFrameMeta): number {
  const frameBytes = meta.frameBytes ?? ESTIMATED_FRAME_BYTES;
  const thumbBytes = meta.hasThumbnail
    ? (meta.thumbBytes ?? ESTIMATED_THUMB_BYTES)
    : 0;
  return frameBytes + thumbBytes;
}

// === 缓存统计 ===
export interface CacheStats {
  indexedDBCount: number;
  audioBufferCount: number;
  estimatedSize: string;
}

export async function getCacheStats(): Promise<CacheStats> {
  let indexedDBCount = 0;
  let audioDbCount = 0;
  let totalBytes = 0;

  try {
    const db = await openDB();
    const metas = await new Promise<CachedFrameMeta[]>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result as CachedFrameMeta[]);
      request.onerror = () => reject(request.error);
    });
    indexedDBCount = metas.length;
    totalBytes = metas.reduce((sum, meta) => sum + estimateMetaBytes(meta), 0);

    const audioMetas = await new Promise<CachedAudioMeta[]>((resolve, reject) => {
      const transaction = db.transaction(AUDIO_STORE_NAME, 'readonly');
      const store = transaction.objectStore(AUDIO_STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result as CachedAudioMeta[]);
      request.onerror = () => reject(request.error);
    });
    audioDbCount = audioMetas.length;
    totalBytes += audioMetas.reduce((sum, meta) => sum + meta.bytes, 0);
  } catch (e) {
    // 忽略错误
  }

  const audioBufferCount = audioCache.size + audioDbCount;

  const estimatedBytes = totalBytes;
  let estimatedSize = '0 B';
  if (estimatedBytes < 1024) {
    estimatedSize = `${estimatedBytes} B`;
  } else if (estimatedBytes < 1024 * 1024) {
    estimatedSize = `${(estimatedBytes / 1024).toFixed(1)} KB`;
  } else {
    estimatedSize = `${(estimatedBytes / 1024 / 1024).toFixed(1)} MB`;
  }

  return { indexedDBCount, audioBufferCount, estimatedSize };
}

// === Audio Cache (In-Memory) ===
// Note: Audio cache is also cleared per file session in App usually, but for safety, we key it by fileId.
const audioCache = new Map<string, AudioBuffer>(); // Key: "fileId_gopIndex"
const MAX_AUDIO_CACHE = 10;

// === OPFS Helpers ===
async function getOpfsFrameDir() {
  const root = await navigator.storage.getDirectory();
  return await root.getDirectoryHandle('frames', { create: true });
}

async function getOpfsAudioDir() {
  const root = await navigator.storage.getDirectory();
  return await root.getDirectoryHandle('audio', { create: true });
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return await response.blob();
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function getOpfsFileName(fileId: string, tagIndex: number) {
  // Sanitize fileId for filename
  const safeFileId = fileId.replace(/[^a-z0-9.\-_]/gi, '_');
  return `${safeFileId}_${tagIndex}`;
}

function getOpfsThumbFileName(fileId: string, tagIndex: number) {
  return `${getOpfsFileName(fileId, tagIndex)}_thumb`;
}

function getOpfsAudioFileName(fileId: string, gopIndex: number) {
  const safeFileId = fileId.replace(/[^a-z0-9.\-_]/gi, '_');
  return `${safeFileId}_${gopIndex}_audio`;
}

async function saveToOpfs(
  fileId: string,
  tagIndex: number,
  blob: Blob,
  thumbnail?: string
): Promise<{ frameBytes: number; thumbBytes: number }> {
  const dir = await getOpfsFrameDir();
  let thumbBytes = 0;

  // 1. Save Video Blob
  const fileName = getOpfsFileName(fileId, tagIndex);
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();

  // 2. Save Thumbnail (if exists)
  if (thumbnail) {
    const thumbName = getOpfsThumbFileName(fileId, tagIndex);
    const thumbHandle = await dir.getFileHandle(thumbName, { create: true });
    const thumbWritable = await thumbHandle.createWritable();
    const thumbBlob = await dataUrlToBlob(thumbnail);
    thumbBytes = thumbBlob.size;
    await thumbWritable.write(thumbBlob);
    await thumbWritable.close();
  }

  return { frameBytes: blob.size, thumbBytes };
}

async function loadFromOpfs(fileId: string, tagIndex: number, hasThumbnail: boolean): Promise<{ blob: Blob, thumbnail?: string }> {
  const dir = await getOpfsFrameDir();

  // 1. Load Video Blob
  const fileName = getOpfsFileName(fileId, tagIndex);
  const fileHandle = await dir.getFileHandle(fileName);
  const blob = await fileHandle.getFile();

  // 2. Load Thumbnail
  let thumbnail: string | undefined;
  if (hasThumbnail) {
    try {
      const thumbName = getOpfsThumbFileName(fileId, tagIndex);
      const thumbHandle = await dir.getFileHandle(thumbName);
      const thumbFile = await thumbHandle.getFile();
      thumbnail = await blobToDataUrl(thumbFile);
    } catch (e) {
      console.warn("Missing thumbnail file", e);
    }
  }

  return { blob, thumbnail };
}

async function deleteFromOpfs(fileId: string, tagIndex: number) {
  try {
    const dir = await getOpfsFrameDir();
    const fileName = getOpfsFileName(fileId, tagIndex);
    await dir.removeEntry(fileName);

    // Try delete thumb
    try {
      const thumbName = getOpfsThumbFileName(fileId, tagIndex);
      await dir.removeEntry(thumbName);
    } catch (e) { }
  } catch (e) {
    // Ignore if not found
  }
}

// async function deleteAudioFromOpfs(fileId: string, gopIndex: number) {
//   try {
//     const dir = await getOpfsAudioDir();
//     const fileName = getOpfsAudioFileName(fileId, gopIndex);
//     await dir.removeEntry(fileName);
//   } catch (e) {
//     // Ignore if not found
//   }
// }

async function clearOpfs() {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('frames', { recursive: true });
    await root.removeEntry('audio', { recursive: true });
  } catch (e) {
    // Ignore
  }
}

async function getAllMetas(db: IDBDatabase): Promise<CachedFrameMeta[]> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as CachedFrameMeta[]);
    request.onerror = () => reject(request.error);
  });
}

async function enforceCacheLimit(db: IDBDatabase): Promise<void> {
  const metas = await getAllMetas(db);
  if (metas.length === 0) return;

  let totalBytes = metas.reduce((sum, meta) => sum + estimateMetaBytes(meta), 0);
  if (totalBytes <= MAX_OPFS_BYTES) return;

  metas.sort((a, b) => a.timestamp - b.timestamp);
  const toDelete: CachedFrameMeta[] = [];
  for (const meta of metas) {
    if (totalBytes <= MAX_OPFS_BYTES) break;
    totalBytes -= estimateMetaBytes(meta);
    toDelete.push(meta);
  }

  if (toDelete.length === 0) return;

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    toDelete.forEach(meta => {
      store.delete([meta.fileId, meta.tagIndex]);
    });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });

  await Promise.all(
    toDelete.map(meta => deleteFromOpfs(meta.fileId, meta.tagIndex))
  );
}

// === IndexedDB Helpers ===
let dbInstance: IDBDatabase | null = null;
let pendingOpenPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (pendingOpenPromise) return pendingOpenPromise;

  pendingOpenPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 5); // Add audio store

    request.onerror = () => {
      pendingOpenPromise = null;
      reject(request.error);
    };

    request.onsuccess = () => {
      const db = request.result;

      db.onversionchange = () => {
        db.close();
        dbInstance = null;
      };
      db.onclose = () => {
        dbInstance = null;
      };

      dbInstance = db;
      pendingOpenPromise = null;
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: ['fileId', 'tagIndex'] });
      }
      if (!db.objectStoreNames.contains(AUDIO_STORE_NAME)) {
        db.createObjectStore(AUDIO_STORE_NAME, { keyPath: ['fileId', 'gopIndex'] });
      }
    };
  });
  return pendingOpenPromise;
}

export async function clearCache(): Promise<void> {
  audioCache.clear();
  await clearOpfs();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME, AUDIO_STORE_NAME], 'readwrite');
    const frameStore = transaction.objectStore(STORE_NAME);
    const audioStore = transaction.objectStore(AUDIO_STORE_NAME);
    frameStore.clear();
    audioStore.clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function saveFrame(fileId: string, tagIndex: number, blob: Blob, thumbnail?: string): Promise<void> {
  // 如果缓存被禁用，直接返回
  if (!cacheEnabled) return;

  try {
    // 1. Save Blob & Thumbnail to OPFS
    const { frameBytes, thumbBytes } = await saveToOpfs(fileId, tagIndex, blob, thumbnail);

    // 2. Save Meta to IDB
    const db = await openDB();
    const meta: CachedFrameMeta = {
      fileId,
      tagIndex,
      hasThumbnail: !!thumbnail,
      timestamp: Date.now(),
      frameBytes,
      thumbBytes
    };

    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.put(meta);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });

    // 3. LRU Cleanup by total size
    await enforceCacheLimit(db);
  } catch (e) {
    console.warn('Failed to save frame to cache:', e);
  }
}

export async function loadCachedFrame(fileId: string, tagIndex: number): Promise<CachedFrame | null> {
  // 如果缓存被禁用，直接返回 null
  if (!cacheEnabled) return null;

  try {
    const db = await openDB();
    // 1. Get Meta
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get([fileId, tagIndex]);

      request.onsuccess = async () => {
        const meta = request.result as CachedFrameMeta | undefined;
        if (meta) {
          // Update timestamp
          meta.timestamp = Date.now();
          store.put(meta);

          try {
            // 2. Load Blob & Thumbnail from OPFS
            const { blob, thumbnail } = await loadFromOpfs(fileId, tagIndex, meta.hasThumbnail);
            if (meta.frameBytes === undefined || meta.thumbBytes === undefined) {
              const updatedMeta: CachedFrameMeta = {
                ...meta,
                frameBytes: meta.frameBytes ?? blob.size,
                thumbBytes: meta.thumbBytes ?? (meta.hasThumbnail ? ESTIMATED_THUMB_BYTES : 0)
              };
              const updateTx = db.transaction(STORE_NAME, 'readwrite');
              const updateStore = updateTx.objectStore(STORE_NAME);
              updateStore.put(updatedMeta);
            }
            resolve({
              fileId: meta.fileId,
              tagIndex: meta.tagIndex,
              blob,
              thumbnail,
              timestamp: meta.timestamp
            });
          } catch (e) {
            console.warn("OPFS file missing for tag", tagIndex);
            resolve(null);
          }
        } else {
          resolve(null);
        }
      };
      request.onerror = () => reject(request.error);
    });
  } catch (e) {
    return null;
  }
}

export async function loadFrame(fileId: string, tagIndex: number): Promise<Blob | null> {
  const frame = await loadCachedFrame(fileId, tagIndex);
  return frame ? frame.blob : null;
}

function encodeAudioBuffer(buffer: AudioBuffer): ArrayBuffer {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const totalSamples = channels * length;
  const data = new ArrayBuffer(AUDIO_HEADER_BYTES + totalSamples * 4);
  const view = new DataView(data);
  view.setUint32(0, buffer.sampleRate, true);
  view.setUint32(4, length, true);
  view.setUint16(8, channels, true);
  const floatView = new Float32Array(data, AUDIO_HEADER_BYTES, totalSamples);
  for (let ch = 0; ch < channels; ch++) {
    floatView.set(buffer.getChannelData(ch), ch * length);
  }
  return data;
}

function decodeAudioBuffer(
  audioCtx: AudioContext,
  data: ArrayBuffer
): AudioBuffer | null {
  if (data.byteLength < AUDIO_HEADER_BYTES) return null;
  const view = new DataView(data);
  const sampleRate = view.getUint32(0, true);
  const length = view.getUint32(4, true);
  const channels = view.getUint16(8, true);
  if (!sampleRate || !length || !channels) return null;
  const expectedBytes = AUDIO_HEADER_BYTES + channels * length * 4;
  if (data.byteLength < expectedBytes) return null;
  const buffer = audioCtx.createBuffer(channels, length, sampleRate);
  const floatView = new Float32Array(data, AUDIO_HEADER_BYTES, channels * length);
  for (let ch = 0; ch < channels; ch++) {
    buffer.getChannelData(ch).set(
      floatView.subarray(ch * length, (ch + 1) * length)
    );
  }
  return buffer;
}

async function saveAudioToOpfs(fileId: string, gopIndex: number, buffer: AudioBuffer): Promise<number> {
  const dir = await getOpfsAudioDir();
  const fileName = getOpfsAudioFileName(fileId, gopIndex);
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  const data = encodeAudioBuffer(buffer);
  await writable.write(data);
  await writable.close();
  return data.byteLength;
}

async function loadAudioFromOpfs(fileId: string, gopIndex: number): Promise<ArrayBuffer> {
  const dir = await getOpfsAudioDir();
  const fileName = getOpfsAudioFileName(fileId, gopIndex);
  const fileHandle = await dir.getFileHandle(fileName);
  const blob = await fileHandle.getFile();
  return await blob.arrayBuffer();
}

export async function saveAudioBuffer(
  fileId: string,
  gopIndex: number,
  buffer: AudioBuffer
): Promise<void> {
  if (!cacheEnabled) return;

  const key = `${fileId}_${gopIndex}`;
  if (audioCache.size >= MAX_AUDIO_CACHE) {
    const firstKey = audioCache.keys().next().value;
    if (firstKey !== undefined) audioCache.delete(firstKey);
  }
  audioCache.set(key, buffer);

  try {
    const bytes = await saveAudioToOpfs(fileId, gopIndex, buffer);
    const db = await openDB();
    const meta: CachedAudioMeta = {
      fileId,
      gopIndex,
      timestamp: Date.now(),
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
      length: buffer.length,
      bytes
    };
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(AUDIO_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(AUDIO_STORE_NAME);
      store.put(meta);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } catch (e) {
    console.warn('Failed to save audio buffer to cache:', e);
  }
}

export async function loadAudioBuffer(
  fileId: string,
  gopIndex: number,
  audioCtx: AudioContext
): Promise<AudioBuffer | null> {
  if (!cacheEnabled) return null;
  const key = `${fileId}_${gopIndex}`;
  const cached = audioCache.get(key);
  if (cached) return cached;

  try {
    const db = await openDB();
    const meta = await new Promise<CachedAudioMeta | undefined>((resolve, reject) => {
      const transaction = db.transaction(AUDIO_STORE_NAME, 'readonly');
      const store = transaction.objectStore(AUDIO_STORE_NAME);
      const request = store.get([fileId, gopIndex]);
      request.onsuccess = () => resolve(request.result as CachedAudioMeta | undefined);
      request.onerror = () => reject(request.error);
    });
    if (!meta) return null;
    const data = await loadAudioFromOpfs(fileId, gopIndex);
    const buffer = decodeAudioBuffer(audioCtx, data);
    if (!buffer) return null;
    audioCache.set(key, buffer);
    return buffer;
  } catch (e) {
    console.warn('Failed to load audio buffer from cache:', e);
    return null;
  }
}

/**
 * 批量查询缓存帧 - 使用单个 IndexedDB 事务批量查询多个帧
 * 这对于大文件（如 30GB MP4）非常重要，避免为每个帧单独打开事务
 * 
 * @param fileId 文件唯一标识
 * @param tagIndices 要查询的 tag 索引数组
 * @returns 与 tagIndices 对应的 CachedFrame 数组（未找到的为 null）
 */
export async function loadCachedFramesBatch(
  fileId: string,
  tagIndices: number[]
): Promise<(CachedFrame | null)[]> {
  // 如果缓存被禁用，直接返回全 null 数组
  if (!cacheEnabled) {
    return tagIndices.map(() => null);
  }

  if (tagIndices.length === 0) {
    return [];
  }

  try {
    const db = await openDB();

    // 使用单个事务批量查询所有元数据
    const metas = await new Promise<(CachedFrameMeta | null)[]>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const results: (CachedFrameMeta | null)[] = new Array(tagIndices.length).fill(null);
      let completed = 0;
      let hasError = false;

      transaction.onerror = () => {
        if (!hasError) {
          hasError = true;
          reject(transaction.error);
        }
      };

      tagIndices.forEach((tagIndex, i) => {
        const request = store.get([fileId, tagIndex]);
        request.onsuccess = () => {
          const meta = request.result as CachedFrameMeta | undefined;
          if (meta) {
            // 更新时间戳
            meta.timestamp = Date.now();
            store.put(meta);
            results[i] = meta;
          }
          completed++;
          if (completed === tagIndices.length) {
            resolve(results);
          }
        };
        request.onerror = () => {
          completed++;
          if (completed === tagIndices.length) {
            resolve(results);
          }
        };
      });
    });

    // 批量从 OPFS 加载 Blob 和缩略图
    const frames = await Promise.all(
      metas.map(async (meta, i): Promise<CachedFrame | null> => {
        if (!meta) return null;
        try {
          const { blob, thumbnail } = await loadFromOpfs(
            fileId, 
            tagIndices[i], 
            meta.hasThumbnail
          );
          return {
            fileId: meta.fileId,
            tagIndex: meta.tagIndex,
            blob,
            thumbnail,
            timestamp: meta.timestamp
          };
        } catch (e) {
          // OPFS 文件丢失，返回 null
          return null;
        }
      })
    );

    return frames;
  } catch (e) {
    console.warn('批量加载缓存失败:', e);
    return tagIndices.map(() => null);
  }
}
