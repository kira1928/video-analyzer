// GOP decode worker using WebCodecs for video frames.

interface DecodeChunk {
  data: ArrayBuffer;
  timestamp: number;
  duration: number;
  type: EncodedVideoChunkType;
  tagIndex: number;
  timestampMs: number;
  isKeyframe: boolean;
}

interface DecodeRequest {
  jobId: number;
  config: VideoDecoderConfig;
  chunks: DecodeChunk[];
  thumbSize: number;
  thumbQuality: number;
  frameQuality: number;
  maxCacheWidth: number;
}

let activeJobId = 0;
let decoder: VideoDecoder | null = null;
let pendingFrameTasks: Promise<void>[] = [];

function closeDecoder() {
  if (!decoder) return;
  try {
    if (decoder.state !== 'closed') {
      decoder.close();
    }
  } catch {
    // ignore
  }
  decoder = null;
}

async function frameToBlob(
  frame: VideoFrame,
  maxSize: number,
  quality: number
): Promise<Blob> {
  const scale = maxSize / Math.max(frame.displayWidth, frame.displayHeight);
  const width = Math.max(1, Math.round(frame.displayWidth * Math.min(1, scale)));
  const height = Math.max(1, Math.round(frame.displayHeight * Math.min(1, scale)));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.drawImage(frame, 0, 0, width, height);
  }
  return await canvas.convertToBlob({ type: 'image/jpeg', quality });
}

self.onmessage = async (event: MessageEvent) => {
  const { action, payload } = event.data ?? {};
  if (action === 'cancel') {
    const { jobId } = payload ?? {};
    if (jobId === activeJobId) {
      activeJobId = 0;
      closeDecoder();
    }
    return;
  }

  if (action !== 'decode') return;
  const request = payload as DecodeRequest;
  const { jobId, config, chunks, thumbSize, thumbQuality, frameQuality, maxCacheWidth } = request;

  activeJobId = jobId;
  closeDecoder();
  pendingFrameTasks = [];

  let frameIndex = 0;
  decoder = new VideoDecoder({
    output: async (frame) => {
      const currentJob = activeJobId;
      const outputIndex = frameIndex;
      frameIndex += 1;
      const meta = chunks[outputIndex];
      if (!meta || currentJob !== jobId) {
        frame.close();
        return;
      }

      const task = (async () => {
        try {
          const thumbBlob = await frameToBlob(frame, thumbSize, thumbQuality);
          const frameBlob = await frameToBlob(frame, maxCacheWidth, frameQuality);
          if (activeJobId !== jobId) {
            return;
          }

          self.postMessage({
            type: 'frame',
            jobId,
            frameIndex: outputIndex,
            tagIndex: meta.tagIndex,
            timestampMs: meta.timestampMs,
            isKeyframe: meta.isKeyframe,
            thumbBlob,
            frameBlob
          });
        } catch (e) {
          self.postMessage({
            type: 'error',
            jobId,
            error: e instanceof Error ? e.message : String(e)
          });
        } finally {
          frame.close();
        }
      })();

      pendingFrameTasks.push(task);
    },
    error: (e) => {
      self.postMessage({
        type: 'error',
        jobId,
        error: e instanceof Error ? e.message : String(e)
      });
    }
  });

  decoder.configure(config);

  let decodeError: string | null = null;
  for (let i = 0; i < chunks.length; i++) {
    if (activeJobId !== jobId) break;
    const chunk = chunks[i];
    try {
      decoder.decode(new EncodedVideoChunk({
        type: chunk.type,
        timestamp: chunk.timestamp,
        duration: chunk.duration,
        data: new Uint8Array(chunk.data)
      }));
    } catch (e) {
      decodeError = e instanceof Error ? e.message : String(e);
      break;
    }

    if (i % 30 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  if (decodeError) {
    self.postMessage({
      type: 'error',
      jobId,
      error: decodeError
    });
    return;
  }

  if (activeJobId !== jobId) {
    return;
  }

  try {
    await decoder.flush();
  } catch {
    // ignore flush failures on cancel
  }

  if (pendingFrameTasks.length > 0) {
    await Promise.allSettled(pendingFrameTasks);
    pendingFrameTasks = [];
  }

  if (activeJobId === jobId) {
    self.postMessage({ type: 'done', jobId });
  }
};
