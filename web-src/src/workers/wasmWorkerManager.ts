// WASM Worker 管理器
// 封装与 Worker 的通信，支持流式解析

import { AnalysisResult } from '../types';

type ProgressCallback = (message: string, percent?: number) => void;

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  onProgress?: ProgressCallback;
  file?: File;  // 用于流式读取
  totalBytes?: number;  // 总字节数
  readBytes?: number;  // 已读字节数
  fileId?: string;
  maxOffset?: number;
  lastProgressAt?: number;
  lastProgressMb?: number;
}

class WasmWorkerManager {
  private worker: Worker | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private requestId = 0;
  private initPromise: Promise<void> | null = null;
  private isReady = false;
  private streamingFiles = new Map<string, File>();

  async init(onProgress?: ProgressCallback): Promise<void> {
    if (this.isReady) return;

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = new Promise((resolve, reject) => {
      try {
        // 创建 Worker
        this.worker = new Worker(
          new URL('./wasm.worker.ts', import.meta.url),
          { type: 'module' }
        );

        this.worker.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.worker.onerror = (error) => {
          console.error('Worker error:', error);
          reject(new Error('Worker 初始化失败'));
        };

        // 等待 Worker 加载和 WASM 初始化
        const initHandler = (event: MessageEvent) => {
          const data = event.data;

          if (data.type === 'loaded') {
            onProgress?.('Worker 已加载，正在初始化 WASM...');
            this.worker?.postMessage({ action: 'init' });
          } else if (data.type === 'init') {
            if (data.status === 'ready') {
              this.isReady = true;
              onProgress?.(`WASM 已加载 (v${data.version})`);
              resolve();
            } else {
              reject(new Error(data.error || 'WASM 初始化失败'));
            }
          }
        };

        this.worker.addEventListener('message', initHandler);

      } catch (error) {
        reject(error);
      }
    });

    return this.initPromise;
  }

  private async handleMessage(data: any) {
    const { id, type, result, error, message, reqId, offset, length, fileId } = data;

    // 处理文件读取请求
    if (type === 'fileRead') {
      const pendingForFile = fileId
        ? Array.from(this.pendingRequests.values()).find(p => p.file && p.fileId === fileId)
        : undefined;
      const fallbackPending = pendingForFile ?? Array.from(this.pendingRequests.values()).find(p => p.file);
      const file = pendingForFile?.file
        ?? (fileId ? this.streamingFiles.get(fileId) : undefined)
        ?? fallbackPending?.file;

      if (!file) {
        console.error('文件读取失败: 未找到对应的文件句柄');
        return;
      }

      try {
        const blob = file.slice(offset, offset + length);
        const buffer = await blob.arrayBuffer();

        const progressOwner = pendingForFile ?? fallbackPending;
        if (progressOwner) {
          if (progressOwner.totalBytes === undefined) {
            progressOwner.totalBytes = file.size;
            progressOwner.readBytes = 0;
            progressOwner.maxOffset = 0;
          }
          progressOwner.readBytes = (progressOwner.readBytes || 0) + length;
          const scannedBytes = Math.max(progressOwner.maxOffset || 0, offset + length);
          progressOwner.maxOffset = scannedBytes;

          // 计算进度百分比（保留一位小数）
          const percent = Math.min(100, Math.round((scannedBytes / progressOwner.totalBytes!) * 1000) / 10);

          // 报告进度（节流以避免 UI 刷新过于频繁）
          const mb = Math.round(scannedBytes / 1024 / 1024);
          const totalMb = Math.round(progressOwner.totalBytes! / 1024 / 1024);
          const now = Date.now();
          const shouldReport =
            progressOwner.lastProgressAt === undefined ||
            now - progressOwner.lastProgressAt > 200 ||
            progressOwner.lastProgressMb !== mb;

          if (shouldReport) {
            progressOwner.lastProgressAt = now;
            progressOwner.lastProgressMb = mb;
            console.log(`[Worker] 进度: ${mb}MB / ${totalMb}MB (${percent}%)`);
            progressOwner.onProgress?.(`正在读取数据 (${mb}MB / ${totalMb}MB)`, percent);
          }
        }

        this.worker?.postMessage(
          { action: 'fileReadResponse', reqId, data: buffer },
          [buffer]
        );
      } catch (err) {
        console.error('文件读取失败:', err);
      }
      return;
    }

    if (!id) return;

    const pending = this.pendingRequests.get(id);
    if (!pending) return;

    switch (type) {
      case 'progress':
        // Worker 发来的进度消息
        pending.onProgress?.(message, data.percent);
        break;

      case 'result':
        pending.onProgress?.('解析完成', 100);
        pending.resolve(result);
        this.pendingRequests.delete(id);
        break;

      case 'error':
        pending.reject(new Error(error));
        this.pendingRequests.delete(id);
        break;
    }
  }

  private async sendRequest(
    action: string,
    payload: any,
    onProgress?: ProgressCallback,
    file?: File,
    fileId?: string,
    transferables?: Transferable[]
  ): Promise<any> {
    if (!this.worker || !this.isReady) {
      throw new Error('Worker 未初始化');
    }

    const id = `req_${this.requestId++}`;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, onProgress, file, fileId });

      if (transferables) {
        this.worker!.postMessage({ id, action, payload }, transferables);
      } else {
        this.worker!.postMessage({ id, action, payload });
      }
    });
  }

  async parseVideo(
    fileData: Uint8Array,
    onProgress?: ProgressCallback
  ): Promise<AnalysisResult> {
    onProgress?.('正在传输文件到解析线程...');

    const buffer = fileData.buffer.slice(
      fileData.byteOffset,
      fileData.byteOffset + fileData.byteLength
    );

    return this.sendRequest(
      'parseVideo',
      { fileData: buffer },
      onProgress,
      undefined,
      undefined,
      [buffer]
    );
  }

  async parseMP4Streaming(
    file: File,
    fileId: string,
    onProgress?: ProgressCallback
  ): Promise<any> {
    onProgress?.('初始化流式解析器...');

    this.streamingFiles.set(fileId, file);

    return this.sendRequest(
      'parseMP4Streaming',
      { fileSize: file.size, fileId },
      onProgress,
      file,
      fileId
    );
  }

  async parseFLVStreaming(
    file: File,
    fileId: string,
    onProgress?: ProgressCallback
  ): Promise<AnalysisResult> {
    onProgress?.('初始化流式解析器...');

    this.streamingFiles.set(fileId, file);

    return this.sendRequest(
      'parseFLVStreaming',
      { fileSize: file.size, fileId },
      onProgress,
      file,
      fileId
    );
  }

  /**
   * 分页获取 samples
   * @param fileId 文件标识符
   * @param start 起始索引
   * @param count 获取数量
   */
  async getSamplesBatch(
    fileId: string,
    start: number,
    count: number
  ): Promise<any[]> {
    return this.sendRequest('getSamplesBatch', { fileId, start, count });
  }

  /**
   * 分页获取 GOPs
   * @param fileId 文件标识符
   * @param start 起始索引
   * @param count 获取数量
   */
  async getGopsBatch(
    fileId: string,
    start: number,
    count: number
  ): Promise<any[]> {
    return this.sendRequest('getGopsBatch', { fileId, start, count });
  }

  /**
   * 获取单个 sample
   * @param fileId 文件标识符
   * @param index sample 索引
   */
  async getSample(
    fileId: string,
    index: number
  ): Promise<any> {
    return this.sendRequest('getSample', { fileId, index });
  }

  /**
   * 读取指定 sample 的原始数据
   * @param fileId 文件标识符
   * @param index sample 索引
   * @returns Uint8Array 原始数据
   */
  async readSampleData(
    fileId: string,
    index: number
  ): Promise<Uint8Array> {
    return this.sendRequest('readSampleData', { fileId, index });
  }

  terminate() {
    this.worker?.terminate();
    this.worker = null;
    this.isReady = false;
    this.initPromise = null;
    this.pendingRequests.clear();
    this.streamingFiles.clear();
  }
}

// 单例
export const wasmWorker = new WasmWorkerManager();
