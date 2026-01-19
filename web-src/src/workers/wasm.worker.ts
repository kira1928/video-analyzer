// WASM Worker - 在后台线程中执行 WASM 解析
// 支持流式解析：通过消息请求主线程读取文件片段

let wasmModule: any = null;
let fileReadResolvers = new Map<number, (data: Uint8Array) => void>();
let readRequestId = 0;
const parserCache = new Map<string, { parser: any, format: 'mp4' | 'flv' }>();

// 请求主线程读取文件片段
function requestFileRead(fileId: string, offset: number, length: number): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const reqId = readRequestId++;
    fileReadResolvers.set(reqId, resolve);
    self.postMessage({
      type: 'fileRead',
      fileId,
      reqId,
      offset,
      length
    });
  });
}

// 初始化 WASM
async function initWasm() {
  if (wasmModule) return;

  try {
    const module = await import('/pkg/video_analyzer.js');
    await module.default();
    wasmModule = module;

    self.postMessage({ type: 'init', status: 'ready', version: module.getVersion() });
  } catch (error) {
    self.postMessage({ type: 'init', status: 'error', error: String(error) });
  }
}

// 处理消息
self.onmessage = async (event: MessageEvent) => {
  const { id, action, payload, reqId, data } = event.data;

  // 处理文件读取响应
  if (action === 'fileReadResponse') {
    const resolver = fileReadResolvers.get(reqId);
    if (resolver) {
      resolver(new Uint8Array(data));
      fileReadResolvers.delete(reqId);
    }
    return;
  }

  try {
    switch (action) {
      case 'init':
        await initWasm();
        break;

      case 'parseMP4Streaming': {
        if (!wasmModule) throw new Error('WASM 未初始化');

        const { fileSize, fileId } = payload;

        // 创建流式解析器，使用基于消息的读取回调
        const readCallback = async (offset: number, length: number) => {
          return await requestFileRead(fileId, offset, length);
        };

        const parser = new wasmModule.StreamingMp4Parser(fileSize, readCallback);

        // 使用优化版本：直接在 WASM 端解析并缓存，只返回元数据
        // 避免将完整结果序列化到 JS 再反序列化回去（非常慢）
        const metadata = await parser.parseAndCache(fileId);
        parserCache.set(fileId, { parser, format: 'mp4' });

        console.log(`[Worker] 返回元数据：`, metadata);

        self.postMessage({ id, type: 'result', result: metadata });
        break;
      }

      case 'parseFLVStreaming': {
        if (!wasmModule) throw new Error('WASM 未初始化');

        const { fileSize, fileId } = payload;

        const readCallback = async (offset: number, length: number) => {
          return await requestFileRead(fileId, offset, length);
        };

        const parser = new wasmModule.StreamingFlvParser(fileSize, readCallback);

        // 使用优化版本：直接在 WASM 端解析并缓存
        const metadata = await parser.parseAndCache(fileId);
        parserCache.set(fileId, { parser, format: 'flv' });

        self.postMessage({ id, type: 'result', result: metadata });
        break;
      }

      case 'parseVideo': {
        if (!wasmModule) throw new Error('WASM 未初始化');

        const { fileData } = payload;


        const result = wasmModule.parseVideo(new Uint8Array(fileData));

        self.postMessage({ id, type: 'result', result });
        break;
      }

      case 'getSamplesBatch': {
        if (!wasmModule) throw new Error('WASM 未初始化');
        const { fileId, start, count } = payload;
        const samples = wasmModule.getSamplesBatch(fileId, start, count);
        self.postMessage({ id, type: 'result', result: samples });
        break;
      }

      case 'getGopsBatch': {
        if (!wasmModule) throw new Error('WASM 未初始化');
        const { fileId, start, count } = payload;
        const gops = wasmModule.getGopsBatch(fileId, start, count);
        self.postMessage({ id, type: 'result', result: gops });
        break;
      }

      case 'getSample': {
        if (!wasmModule) throw new Error('WASM 未初始化');
        const { fileId, index } = payload;
        const sample = wasmModule.getSample(fileId, index);
        self.postMessage({ id, type: 'result', result: sample });
        break;
      }

      case 'readSampleData': {
        if (!wasmModule) throw new Error('WASM 未初始化');
        const { fileId, index } = payload;

        const entry = parserCache.get(fileId);
        if (!entry) {
          throw new Error(`未找到 parser: ${fileId}`);
        }

        let data: Uint8Array;
        if (entry.format === 'mp4') {
          data = await entry.parser.read_sample_data(index);
        } else {
          data = await entry.parser.read_tag_data(index);
        }
        self.postMessage({ id, type: 'result', result: data });
        break;
      }

      default:
        if (action && !action.startsWith('fileRead')) {
          throw new Error(`未知操作: ${action}`);
        }
    }
  } catch (error) {
    self.postMessage({
      id,
      type: 'error',
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

// 通知主线程 Worker 已加载
self.postMessage({ type: 'loaded' });
