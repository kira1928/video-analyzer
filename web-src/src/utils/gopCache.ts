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
}

const DB_NAME = 'VideoAnalyzerCache';
const STORE_NAME = 'frames';
const MAX_CACHE_SIZE = 600; // ~100MB capacity

// === Audio Cache (In-Memory) ===
// Note: Audio cache is also cleared per file session in App usually, but for safely, we can key it by fileId too?
// For now, let's keep audio cache simple (GOP index collision possible if multiple files opened).
// Ideally audio cache should also be keyed.
const audioCache = new Map<string, AudioBuffer>(); // Key: "fileId_gopIndex"
const MAX_AUDIO_CACHE = 10;

export function saveAudioBuffer(fileId: string, gopIndex: number, buffer: AudioBuffer) {
  const key = `${fileId}_${gopIndex}`;
  if (audioCache.size >= MAX_AUDIO_CACHE) {
    const firstKey = audioCache.keys().next().value;
    if (firstKey !== undefined) audioCache.delete(firstKey);
  }
  audioCache.set(key, buffer);
}

export function loadAudioBuffer(fileId: string, gopIndex: number): AudioBuffer | undefined {
  return audioCache.get(`${fileId}_${gopIndex}`);
}

// === OPFS Helpers ===
async function getOpfsFrameDir() {
  const root = await navigator.storage.getDirectory();
  return await root.getDirectoryHandle('frames', { create: true });
}

function getOpfsFileName(fileId: string, tagIndex: number) {
  // Sanitize fileId for filename
  const safeFileId = fileId.replace(/[^a-z0-9.\-_]/gi, '_');
  return `${safeFileId}_${tagIndex}`;
}

function getOpfsThumbFileName(fileId: string, tagIndex: number) {
  return `${getOpfsFileName(fileId, tagIndex)}_thumb`;
}

async function saveToOpfs(fileId: string, tagIndex: number, blob: Blob, thumbnail?: string) {
  const dir = await getOpfsFrameDir();

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
    await thumbWritable.write(thumbnail); // write string safely
    await thumbWritable.close();
  }
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
      thumbnail = await thumbFile.text();
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

async function clearOpfs() {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('frames', { recursive: true });
  } catch (e) {
    // Ignore
  }
}

// === IndexedDB Helpers ===
let dbInstance: IDBDatabase | null = null;
let pendingOpenPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (pendingOpenPromise) return pendingOpenPromise;

  pendingOpenPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 4); // Bump version to 4 (Schema change: Meta no longer has thumbnail string)

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
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      db.createObjectStore(STORE_NAME, { keyPath: ['fileId', 'tagIndex'] });
    };
  });
  return pendingOpenPromise;
}

export async function clearCache(): Promise<void> {
  audioCache.clear();
  await clearOpfs();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function saveFrame(fileId: string, tagIndex: number, blob: Blob, thumbnail?: string): Promise<void> {
  try {
    // 1. Save Blob & Thumbnail to OPFS
    await saveToOpfs(fileId, tagIndex, blob, thumbnail);

    // 2. Save Meta to IDB
    const db = await openDB();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    const meta: CachedFrameMeta = {
      fileId,
      tagIndex,
      hasThumbnail: !!thumbnail,
      timestamp: Date.now()
    };
    store.put(meta);

    // 3. LRU Cleanup
    const countRequest = store.count();
    countRequest.onsuccess = () => {
      if (countRequest.result > MAX_CACHE_SIZE) {
        const allItemsRequest = store.getAll();
        allItemsRequest.onsuccess = () => {
          const items = allItemsRequest.result as CachedFrameMeta[];
          if (items.length > MAX_CACHE_SIZE) {
            items.sort((a, b) => a.timestamp - b.timestamp);
            const toDelete = items.slice(0, items.length - MAX_CACHE_SIZE);

            // Delete from IDB
            const deleteTx = db.transaction(STORE_NAME, 'readwrite');
            const deleteStore = deleteTx.objectStore(STORE_NAME);
            toDelete.forEach(item => {
              deleteStore.delete([item.fileId, item.tagIndex]);
              deleteFromOpfs(item.fileId, item.tagIndex).catch(console.error);
            });
          }
        };
      }
    };
  } catch (e) {
    console.warn('Failed to save frame to cache:', e);
  }
}

export async function loadCachedFrame(fileId: string, tagIndex: number): Promise<CachedFrame | null> {
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
