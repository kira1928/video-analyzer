import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { AnalysisResult, Gop, TagSummary } from '../types';
import { getWasmModule } from '../utils/wasm';
import { formatDuration } from '../utils/format';
import { saveFrame, loadCachedFrame, saveAudioBuffer, loadAudioBuffer } from '../utils/gopCache';
import { wasmWorker } from '../workers/wasmWorkerManager';
import { yieldToMain } from '../utils/yieldToMain';
import '../styles/GopPlayer.css';

interface GopPlayerProps {
  fileId: string;
  gop: Gop;
  gops?: Gop[];
  currentGopListIndex?: number;
  preloadGopCount?: number;
  fileData: Uint8Array | null;
  analysisResult: AnalysisResult;
  onClose: () => void;
  onTagSelect?: (tagIndex: number) => void; // 点击帧时选择对应的 Tag
  initialTagIndex?: number; // 初始选中的 Tag
  autoPlayNext?: boolean;
  onAutoPlayChange?: (val: boolean) => void;
  onNextGop?: (autoPlay?: boolean) => void;
  onPrevGop?: () => void;
  autoPlayStart?: boolean;
  isStreamingMode?: boolean;
}

interface FrameThumbnail {
  tagIndex: number;
  timestamp: number;
  isKeyframe: boolean;
  imageData: string; // base64 data URL
}

interface DecodeChunk {
  data: ArrayBuffer;
  timestamp: number;
  duration: number;
  type: EncodedVideoChunkType;
  tagIndex: number;
  timestampMs: number;
  isKeyframe: boolean;
}

interface WorkerFrameMessage {
  type: 'frame';
  jobId: number;
  frameIndex: number;
  tagIndex: number;
  timestampMs: number;
  isKeyframe: boolean;
  thumbBlob: Blob;
  frameBlob: Blob;
}

interface WorkerDoneMessage {
  type: 'done';
  jobId: number;
}

interface WorkerErrorMessage {
  type: 'error';
  jobId: number;
  error: string;
}

const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
  16000, 12000, 11025, 8000, 7350
];

function parseAacConfig(description?: Uint8Array) {
  if (!description || description.length < 2) {
    return { codec: 'mp4a.40.2', sampleRate: 44100, channels: 2 };
  }
  const audioObjectType = (description[0] >> 3) & 0x1f;
  const sampleRateIndex = ((description[0] & 0x07) << 1) | (description[1] >> 7);
  const channelConfig = (description[1] >> 3) & 0x0f;
  const sampleRate = AAC_SAMPLE_RATES[sampleRateIndex] || 44100;
  const channels = channelConfig > 0 ? channelConfig : 2;
  return {
    codec: `mp4a.40.${audioObjectType || 2}`,
    sampleRate,
    channels
  };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function trimLeadingNonKeyframes(tags: TagSummary[]) {
  const firstKeyIndex = tags.findIndex(tag => tag.isKeyframe);
  if (firstKeyIndex === -1) {
    return { tags: [] as TagSummary[], skipped: tags.length };
  }
  if (firstKeyIndex === 0) {
    return { tags, skipped: 0 };
  }
  return { tags: tags.slice(firstKeyIndex), skipped: firstKeyIndex };
}

export function GopPlayer({
  fileId,
  gop,
  gops,
  currentGopListIndex,
  preloadGopCount = 2,
  fileData,
  analysisResult,
  onClose,
  onTagSelect,
  initialTagIndex,
  autoPlayNext = false,
  onAutoPlayChange,
  onNextGop,
  onPrevGop,
  autoPlayStart,
  isStreamingMode = false
}: GopPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [totalFrames, setTotalFrames] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [thumbnails, setThumbnails] = useState<FrameThumbnail[]>([]);
  const [selectedThumbnail, setSelectedThumbnail] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isDecoding, setIsDecoding] = useState(true);
  const [isVertical, setIsVertical] = useState(false);
  const [isFrameHiResReady, setIsFrameHiResReady] = useState(false);
  const [gopTags, setGopTags] = useState<TagSummary[]>([]);
  const [isLoadingGopTags, setIsLoadingGopTags] = useState(false);

  const gopVideoTags = useMemo(
    () => gopTags.filter(t => t.type === 'video' && !t.isSeqHeader),
    [gopTags]
  );
  const gopAudioTags = useMemo(
    () => gopTags.filter(t => t.type === 'audio' && !t.isSeqHeader),
    [gopTags]
  );


  const decoderRef = useRef<VideoDecoder | null>(null);
  const frameQueueRef = useRef<VideoFrame[]>([]);
  const thumbnailsRef = useRef<FrameThumbnail[]>([]);
  const animationFrameRef = useRef<number | null>(null);
  const playTimerRef = useRef<number | null>(null);
  const tagsRef = useRef<TagSummary[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const isAnnexBRef = useRef<boolean>(false);
  const galleryRef = useRef<HTMLDivElement>(null);
  const currentDisplayTagRef = useRef<number | null>(null);
  const autoPlayStartRef = useRef(false);
  const hasLoadedGopTagsRef = useRef(false);
  const decoderWorkerRef = useRef<Worker | null>(null);
  const decoderJobIdRef = useRef(0);
  const activeJobRef = useRef<number | null>(null);
  const workerJobIdRef = useRef<number | null>(null);
  const jobInfoRef = useRef<Map<number, { mode: 'active' | 'predecode' }>>(new Map());
  const predecodeQueueRef = useRef<Gop[]>([]);
  const startPredecodeRef = useRef<(gopTarget: Gop) => Promise<void>>(async () => { });
  const fileIdRef = useRef(fileId);
  const selectedThumbnailRef = useRef<number | null>(null);
  const initialTagIndexRef = useRef<number | undefined>(initialTagIndex);
  const formatLower = (analysisResult.format || '').toLowerCase();

  const drawImageToCanvas = useCallback((src: string, revoke: boolean = false) => {
    if (!canvasRef.current) return;
    const img = new Image();
    img.onload = () => {
      if (!canvasRef.current) return;
      const ctx = canvasRef.current.getContext('2d');
      if (ctx) {
        canvasRef.current.width = img.width;
        canvasRef.current.height = img.height;
        ctx.drawImage(img, 0, 0);
      }
      if (revoke) URL.revokeObjectURL(src);
    };
    img.src = src;
  }, []);

  const drawBlobToCanvas = useCallback((blob: Blob, tagIndex?: number) => {
    const url = URL.createObjectURL(blob);
    if (tagIndex !== undefined) {
      currentDisplayTagRef.current = tagIndex;
    }
    setIsFrameHiResReady(true);
    drawImageToCanvas(url, true);
  }, [drawImageToCanvas]);

  const drawThumbnailToCanvas = useCallback((thumb?: FrameThumbnail, tagIndex?: number) => {
    if (!thumb) return;
    if (tagIndex !== undefined) {
      currentDisplayTagRef.current = tagIndex;
    }
    setIsFrameHiResReady(false);
    drawImageToCanvas(thumb.imageData);
  }, [drawImageToCanvas]);

  const drawVideoFrameToCanvas = useCallback((frame: VideoFrame, tagIndex?: number) => {
    if (!canvasRef.current) return;
    if (tagIndex !== undefined) {
      currentDisplayTagRef.current = tagIndex;
    }
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;
    canvasRef.current.width = frame.displayWidth;
    canvasRef.current.height = frame.displayHeight;
    ctx.drawImage(frame, 0, 0);
    setIsFrameHiResReady(true);
  }, []);

  const drawCachedThumbnail = useCallback((thumbData: string, tagIndex: number) => {
    currentDisplayTagRef.current = tagIndex;
    setIsFrameHiResReady(false);
    drawImageToCanvas(thumbData);
  }, [drawImageToCanvas]);

  const updateThumbnailState = useCallback((frameIndex: number, thumb: FrameThumbnail) => {
    const next = thumbnailsRef.current.slice();
    next[frameIndex] = thumb;
    thumbnailsRef.current = next;
    setThumbnails(next);
  }, []);

  const drawFrameFromCache = useCallback(async (
    tagIndex: number,
    index: number,
    allowThumbFallback: boolean
  ) => {
    const cached = await loadCachedFrame(fileId, tagIndex);
    if (cached?.blob) {
      drawBlobToCanvas(cached.blob, tagIndex);
      return true;
    }
    if (!allowThumbFallback) return false;

    if (cached?.thumbnail) {
      drawCachedThumbnail(cached.thumbnail, tagIndex);
      return false;
    }
    const thumb = thumbnailsRef.current[index];
    if (thumb) {
      drawThumbnailToCanvas(thumb, tagIndex);
    }
    return false;
  }, [drawBlobToCanvas, drawCachedThumbnail, drawThumbnailToCanvas, fileId]);

  useEffect(() => {
    if (autoPlayStart) {
      autoPlayStartRef.current = true;
    }
  }, [autoPlayStart]);

  // 自动滚动到选中缩略图
  useEffect(() => {
    if (selectedThumbnail !== null && galleryRef.current) {
      const el = document.getElementById(`thumb-${selectedThumbnail}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    }
  }, [selectedThumbnail]);

  // 加载当前 GOP 的 Tag 列表（流式模式从 WASM 缓存拉取）
  // 注意：依赖数据使用稳定的原始类型，避免对象引用变化导致无限循环
  useEffect(() => {
    let cancelled = false;
    hasLoadedGopTagsRef.current = false;

    const loadGopTags = async () => {
      setIsLoadingGopTags(true);
      setError(null);
      setIsDecoding(true);
      setThumbnails([]);
      thumbnailsRef.current = [];
      setSelectedThumbnail(null);
      setCurrentFrame(0);
      setGopTags([]);

      try {
        let tags: TagSummary[];
        if (isStreamingMode) {
          if (!fileId) {
            throw new Error('缺少文件标识，无法加载 GOP 数据');
          }
          const count = Math.max(0, gop.endIndex - gop.startIndex + 1);
          tags = count > 0 ? await wasmWorker.getSamplesBatch(fileId, gop.startIndex, count) : [];
        } else {
          tags = analysisResult.tags.filter(
            t => t.index >= gop.startIndex && t.index <= gop.endIndex
          );
        }

        if (!cancelled) {
          setGopTags(tags);
        }
      } catch (e) {
        if (!cancelled) {
          setGopTags([]);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) {
          setIsLoadingGopTags(false);
          hasLoadedGopTagsRef.current = true;
        }
      }
    };

    loadGopTags();

    return () => {
      cancelled = true;
    };
    // 重要：只依赖稳定的属性，不依赖 analysisResult.tags 数组本身
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, gop.startIndex, gop.endIndex, gop.index, isStreamingMode]);

  // 点击缩略图
  const handleThumbnailClick = useCallback(async (tagIndex: number, index: number) => {
    setSelectedThumbnail(index);

    // 停止播放状态
    setIsPlaying(false);

    // 停止播放计时器
    if (playTimerRef.current) {
      clearTimeout(playTimerRef.current);
      playTimerRef.current = null;
    }

    // 停止动画帧循环
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    // 停止音频播放
    if (audioSourceRef.current) {
      try { audioSourceRef.current.stop(); } catch (e) { }
      audioSourceRef.current.disconnect();
      audioSourceRef.current = null;
    }

    // 设置当前帧显示
    setCurrentFrame(index + 1);
    const allowThumbFallback = !isPlaying || index === 0;
    try {
      await drawFrameFromCache(tagIndex, index, allowThumbFallback);
    } catch (e) {
      console.error("加载缓存帧失败:", e);
    }
  }, [drawFrameFromCache, isPlaying]);

  const buildVideoDecoderConfig = useCallback(async (tags: TagSummary[]) => {
    const wasm = getWasmModule();
    let codec = 'avc1.64001f';
    let description: Uint8Array | undefined;
    let isAnnexB = false;
    const isMP4OrTS = formatLower === 'mp4' || formatLower === 'ts';

    const isStreamingFlv = !isMP4OrTS && !fileData;

    if (isMP4OrTS) {
      const firstVideoTag = tags[0];
      const sampleDescIndex = firstVideoTag?.mp4Info?.sampleDescIndex ?? 1;
      let initData: Uint8Array | undefined;

      if (analysisResult.videoInitDataList &&
        analysisResult.videoInitDataList.length >= sampleDescIndex &&
        sampleDescIndex >= 1) {
        const configData = analysisResult.videoInitDataList[sampleDescIndex - 1];
        if (configData && configData.length > 0) {
          initData = new Uint8Array(configData);
        }
      }

      if (!initData) {
        if (!analysisResult.videoInitData || analysisResult.videoInitData.length === 0) {
          throw new Error('MP4/TS 文件缺少视频初始化数据 (videoInitData)');
        }
        initData = new Uint8Array(analysisResult.videoInitData);
      }

      description = initData;

      const codecId = firstVideoTag?.codecId;
      const isHEVC = codecId === 12;
      if (isHEVC) {
        try {
          codec = wasm.generateHEVCCodecString(initData, "raw", "concat");
        } catch {
          codec = 'hvc1.1.6.L93.B0';
        }
      } else {
        if (initData.length >= 4 && initData[0] === 0x01) {
          const profile = initData[1];
          const compat = initData[2];
          const level = initData[3];
          codec = `avc1.${profile.toString(16).padStart(2, '0')}${compat.toString(16).padStart(2, '0')}${level.toString(16).padStart(2, '0')}`;
        } else {
          codec = 'avc1.64001f';
        }
      }
    } else {
      let codecId = tags[0]?.codecId ?? 7;
      let configData: Uint8Array | undefined;

      if (isStreamingFlv) {
        if (!analysisResult.videoInitData || analysisResult.videoInitData.length === 0) {
          throw new Error('流式模式下缺少视频初始化数据');
        }
        configData = new Uint8Array(analysisResult.videoInitData);
      } else {
        const seqHeaderTag = analysisResult.tags.find(t => t.type === 'video' && t.isSeqHeader);
        if (!seqHeaderTag) {
          throw new Error('未找到视频 Sequence Header');
        }

        const seqHeaderOffset = seqHeaderTag.offset + 11;
        const seqHeaderData = fileData!.subarray(seqHeaderOffset, seqHeaderOffset + seqHeaderTag.size);
        codecId = seqHeaderData[0] & 0x0f;
        configData = seqHeaderData.subarray(5);
      }

      if (codecId === 12) {
        const isAnnexBConfig = wasm.isAnnexBFormat(configData!);
        if (isAnnexBConfig) {
          isAnnexB = true;
          try {
            const hvccData = wasm.convertAnnexBToHVCC(configData!);
            codec = 'hvc1.1.6.L93.B0';
            description = hvccData;
          } catch {
            codec = 'hvc1.1.6.L93.B0';
            description = configData;
          }
        } else {
          try {
            codec = wasm.generateHEVCCodecString(configData!, "raw", "concat");
            description = configData;
          } catch {
            codec = 'hvc1.1.6.L93.B0';
            description = configData;
          }
        }
      } else if (codecId === 7) {
        description = configData;
        codec = 'avc1.64001f';
      }
    }

    const config: VideoDecoderConfig = {
      codec,
      description,
    };

    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported) {
      throw new Error(`不支持的视频配置: ${codec}`);
    }

    return { config, isAnnexB };
  }, [analysisResult, fileData, formatLower]);

  const buildEncodedChunks = useCallback(async (
    tags: TagSummary[],
    isAnnexB: boolean,
    signal: AbortSignal
  ): Promise<DecodeChunk[]> => {
    const wasm = getWasmModule();
    const isMP4OrTS = formatLower === 'mp4' || formatLower === 'ts';
    const flvTagDataCache = new Map<number, Uint8Array>();
    const getFlvTagData = async (tag: TagSummary) => {
      const cached = flvTagDataCache.get(tag.index);
      if (cached) return cached;
      let data: Uint8Array;
      if (fileData) {
        const tagDataOffset = tag.offset + 11;
        data = fileData.subarray(tagDataOffset, tagDataOffset + tag.size);
      } else {
        data = await wasmWorker.readSampleData(fileId, tag.index);
      }
      flvTagDataCache.set(tag.index, data);
      return data;
    };
    const chunks: DecodeChunk[] = [];
    const timelineMap = new Map(analysisResult.videoTimeline.map(p => [p.index, p]));

    const defaultDurationUs = 33333;
    let frameMetaMap: Map<number, { pts: number; duration: number }> | null = null;
    if (!isMP4OrTS) {
      const ptsList: { index: number; pts: number }[] = [];
      for (const tag of tags) {
        const p = await getFlvTagData(tag);
        if (p.length < 5) continue;
        if (p[1] !== 1) continue;
        const cts = (p[2] << 16) | (p[3] << 8) | p[4];
        const pts = (tag.timestamp + cts) * 1000;
        ptsList.push({ index: tag.index, pts });
      }

      ptsList.sort((a, b) => a.pts - b.pts);
      const basePts = ptsList.length > 0 ? ptsList[0].pts : 0;
      frameMetaMap = new Map<number, { pts: number; duration: number }>();
      for (let i = 0; i < ptsList.length; i++) {
        const current = ptsList[i];
        const normalizedPts = current.pts - basePts;
        let duration = defaultDurationUs;
        if (i < ptsList.length - 1) {
          duration = ptsList[i + 1].pts - current.pts;
        } else if (i > 0) {
          duration = current.pts - ptsList[i - 1].pts;
        }
        if (duration <= 0) duration = defaultDurationUs;
        frameMetaMap.set(current.index, { pts: normalizedPts, duration });
      }
    }

    for (let frameIndex = 0; frameIndex < tags.length; frameIndex++) {
      if (signal.aborted) break;
      const tag = tags[frameIndex];
      let naluData: Uint8Array;
      let pts: number;
      let duration: number;

      if (isMP4OrTS) {
        if (fileData) {
          naluData = fileData.subarray(tag.offset, tag.offset + tag.size);
        } else {
          naluData = await wasmWorker.readSampleData(fileId, tag.index);
        }
        const timelinePoint = timelineMap.get(tag.index);
        pts = timelinePoint ? timelinePoint.pts * 1000 * 1000 : tag.timestamp * 1000;
        duration = defaultDurationUs;
        if (timelinePoint?.duration && timelinePoint.duration > 0) {
          duration = timelinePoint.duration * 1000 * 1000;
        } else if (frameIndex < tags.length - 1) {
          const deltaMs = tags[frameIndex + 1].timestamp - tag.timestamp;
          if (deltaMs > 0) {
            duration = deltaMs * 1000;
          }
        }
        if (duration <= 0) duration = defaultDurationUs;
      } else {
        const videoTagData = await getFlvTagData(tag);
        if (videoTagData.length < 5) continue;
        const codecId = videoTagData[0] & 0x0f;
        const avcPacketType = videoTagData[1];
        if (avcPacketType !== 1) {
          continue;
        }
        const meta = frameMetaMap?.get(tag.index);
        const cts = (videoTagData[2] << 16) | (videoTagData[3] << 8) | videoTagData[4];
        pts = meta ? meta.pts : (tag.timestamp + cts) * 1000;
        duration = meta ? meta.duration : defaultDurationUs;
        naluData = videoTagData.subarray(5);
        if (codecId === 12 && isAnnexB) {
          if (wasm.isAnnexBFormat(naluData)) {
            naluData = wasm.convertAnnexBToAVCC(naluData);
          }
        }
      }

      const isKey = tag.isKeyframe;
      const data = naluData.slice().buffer;
      chunks.push({
        data,
        timestamp: pts,
        duration,
        type: isKey ? 'key' : 'delta',
        tagIndex: tag.index,
        timestampMs: tag.timestamp,
        isKeyframe: tag.isKeyframe
      });
    }

    return chunks;
  }, [analysisResult.videoTimeline, fileData, fileId, formatLower]);

  const cancelWorkerJob = useCallback(() => {
    const worker = decoderWorkerRef.current;
    const jobId = workerJobIdRef.current;
    if (!worker || jobId === null) return;
    worker.postMessage({ action: 'cancel', payload: { jobId } });
    workerJobIdRef.current = null;
    if (activeJobRef.current === jobId) {
      activeJobRef.current = null;
    }
    jobInfoRef.current.delete(jobId);
  }, []);

  const startWorkerDecode = useCallback(async (
    mode: 'active' | 'predecode',
    tags: TagSummary[],
    config: VideoDecoderConfig,
    isAnnexB: boolean,
    signal: AbortSignal
  ) => {
    const worker = decoderWorkerRef.current;
    if (!worker || tags.length === 0) return;

    const chunks = await buildEncodedChunks(tags, isAnnexB, signal);
    if (signal.aborted || chunks.length === 0) return;

    const jobId = ++decoderJobIdRef.current;
    jobInfoRef.current.set(jobId, { mode });
    workerJobIdRef.current = jobId;
    if (mode === 'active') {
      activeJobRef.current = jobId;
      setIsDecoding(true);
    }

    const transferables = chunks.map(chunk => chunk.data);
    worker.postMessage({
      action: 'decode',
      payload: {
        jobId,
        config,
        chunks,
        thumbSize: 80,
        thumbQuality: 0.6,
        frameQuality: 0.8,
        maxCacheWidth: 1280
      }
    }, transferables);
  }, [buildEncodedChunks]);

  const loadGopTagsFor = useCallback(async (targetGop: Gop): Promise<TagSummary[]> => {
    if (isStreamingMode) {
      const count = Math.max(0, targetGop.endIndex - targetGop.startIndex + 1);
      return count > 0 ? await wasmWorker.getSamplesBatch(fileId, targetGop.startIndex, count) : [];
    }
    return analysisResult.tags.filter(
      t => t.index >= targetGop.startIndex && t.index <= targetGop.endIndex
    );
  }, [analysisResult.tags, fileId, isStreamingMode]);

  const startPredecode = useCallback(async (targetGop: Gop) => {
    try {
      const tags = await loadGopTagsFor(targetGop);
      if (tags.length === 0) return;
      const videoTags = tags.filter(t => t.type === 'video' && !t.isSeqHeader);
      const { tags: normalizedTags } = trimLeadingNonKeyframes(videoTags);
      if (normalizedTags.length === 0) return;
      const { config, isAnnexB } = await buildVideoDecoderConfig(normalizedTags);
      const controller = new AbortController();
      await startWorkerDecode('predecode', normalizedTags, config, isAnnexB, controller.signal);
    } catch (e) {
      console.warn('预解码失败:', e);
    }
  }, [buildVideoDecoderConfig, loadGopTagsFor, startWorkerDecode]);

  useEffect(() => {
    fileIdRef.current = fileId;
  }, [fileId]);

  useEffect(() => {
    selectedThumbnailRef.current = selectedThumbnail;
  }, [selectedThumbnail]);

  useEffect(() => {
    initialTagIndexRef.current = initialTagIndex;
  }, [initialTagIndex]);

  useEffect(() => {
    startPredecodeRef.current = startPredecode;
  }, [startPredecode]);

  useEffect(() => {
    const worker = new Worker(
      new URL('../workers/gopDecoder.worker.ts', import.meta.url),
      { type: 'module' }
    );
    decoderWorkerRef.current = worker;

    const handleMessage = async (event: MessageEvent) => {
      const data = event.data as WorkerFrameMessage | WorkerDoneMessage | WorkerErrorMessage;
      if (!data || !('type' in data)) return;

      if (data.type === 'frame') {
        const jobInfo = jobInfoRef.current.get(data.jobId);
        if (!jobInfo) return;

        try {
          const imageData = await blobToDataUrl(data.thumbBlob);
          if (jobInfo.mode === 'predecode') {
            void saveFrame(fileIdRef.current, data.tagIndex, data.frameBlob, imageData);
            return;
          }

          const thumb: FrameThumbnail = {
            tagIndex: data.tagIndex,
            timestamp: data.timestampMs,
            isKeyframe: data.isKeyframe,
            imageData
          };

          updateThumbnailState(data.frameIndex, thumb);

          void saveFrame(fileIdRef.current, data.tagIndex, data.frameBlob, imageData);

          if (data.frameIndex === 0) {
            try {
              const bmp = await createImageBitmap(data.frameBlob);
              setIsVertical(bmp.height > bmp.width);
              bmp.close();
            } catch { }
          }

          if (currentDisplayTagRef.current === null && data.frameIndex === 0) {
            drawThumbnailToCanvas(thumb, data.tagIndex);
            setSelectedThumbnail(0);
            setCurrentFrame(1);
          }
        } catch (e) {
          console.error('处理解码帧失败:', e);
        }
        return;
      }

      if (data.type === 'done') {
        const jobInfo = jobInfoRef.current.get(data.jobId);
        if (!jobInfo) return;
        jobInfoRef.current.delete(data.jobId);
        if (activeJobRef.current === data.jobId) {
          activeJobRef.current = null;
        }
        workerJobIdRef.current = null;
        if (jobInfo.mode === 'active') {
          setIsDecoding(false);
        }

        if (autoPlayStartRef.current && thumbnailsRef.current.length > 0) {
          autoPlayStartRef.current = false;
          setIsPlaying(true);
        }

        if (predecodeQueueRef.current.length > 0) {
          const next = predecodeQueueRef.current.shift();
          if (next) {
            void startPredecodeRef.current(next);
          }
        }
        return;
      }

      if (data.type === 'error') {
        console.error(`解码工作失败: ${data.error}`);
        setError(data.error);
        setIsDecoding(false);
      }
    };

    worker.addEventListener('message', handleMessage);
    return () => {
      worker.removeEventListener('message', handleMessage);
      worker.terminate();
      decoderWorkerRef.current = null;
    };
  }, [drawThumbnailToCanvas, updateThumbnailState]);


  // 创建缩略图
  const createThumbnail = useCallback((frame: VideoFrame, tagIndex: number, timestamp: number, isKeyframe: boolean): FrameThumbnail => {
    const thumbCanvas = document.createElement('canvas');
    const scale = 80 / Math.max(frame.displayWidth, frame.displayHeight);
    thumbCanvas.width = Math.round(frame.displayWidth * scale);
    thumbCanvas.height = Math.round(frame.displayHeight * scale);
    const ctx = thumbCanvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(frame, 0, 0, thumbCanvas.width, thumbCanvas.height);
    }
    return {
      tagIndex,
      timestamp,
      isKeyframe,
      imageData: thumbCanvas.toDataURL('image/jpeg', 0.6)
    };
  }, []);
  // 键盘导航
  // 切换播放/暂停
  const togglePlay = useCallback(() => {
    setIsPlaying(p => !p);
  }, []);

  const navigateFrame = useCallback((offset: number) => {
    if (thumbnails.length === 0) return;

    // 如果正在播放，按方向键则暂停
    setIsPlaying(false);

    setSelectedThumbnail(prev => {
      const current = prev ?? 0;
      let next = current + offset;
      if (next < 0) next = 0;
      if (next >= thumbnails.length) next = thumbnails.length - 1;

      const thumb = thumbnails[next];
      if (thumb) {
        handleThumbnailClick(thumb.tagIndex, next);
      }
      return next;
    });
  }, [thumbnails, handleThumbnailClick]);

  // 监听键盘事件
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        togglePlay();
        return;
      }
      if (e.key === 'ArrowLeft') {
        navigateFrame(-1);
        return;
      }
      if (e.key === 'ArrowRight') {
        navigateFrame(1);
        return;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, navigateFrame, togglePlay]);

  // 监听 initialTagIndex 变化并跳转 (支持热跳转)
  useEffect(() => {
    if (initialTagIndex !== undefined && thumbnails.length > 0) {
      const idx = thumbnails.findIndex(t => t.tagIndex === initialTagIndex);
      if (idx !== -1) {
        // 使用 yieldToMain 确保 UI 响应
        yieldToMain().then(() => handleThumbnailClick(initialTagIndex, idx));
      }
    }
  }, [initialTagIndex, thumbnails, handleThumbnailClick]);

  // 播放控制循环
  useEffect(() => {
    const playbackThumbs = thumbnails.filter(Boolean) as FrameThumbnail[];
    if (!isPlaying || playbackThumbs.length === 0) {
      if (playTimerRef.current) {
        clearTimeout(playTimerRef.current);
        playTimerRef.current = null;
      }
      return;
    }

    let currentIndex = 0;
    if (selectedThumbnail !== null) {
      const currentTagIndex = thumbnails[selectedThumbnail]?.tagIndex;
      const foundIndex = playbackThumbs.findIndex(t => t.tagIndex === currentTagIndex);
      currentIndex = foundIndex >= 0 ? foundIndex : 0;
    }
    if (currentIndex >= playbackThumbs.length - 1) {
      currentIndex = 0;
    }

    // 1. 启动音频
    if (audioCtxRef.current && audioBufferRef.current) {
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume();

      try {
        const source = ctx.createBufferSource();
        source.buffer = audioBufferRef.current;
        source.connect(ctx.destination);

        const startTime = playbackThumbs[0].timestamp;
        const currentTime = playbackThumbs[currentIndex].timestamp;
        const offset = Math.max(0, (currentTime - startTime) / 1000);

        source.start(0, offset);
        audioSourceRef.current = source;
      } catch (e) {
        console.error("Audio play failed:", e);
      }
    }

    const playNext = async () => {
      if (currentIndex >= playbackThumbs.length) {
        setIsPlaying(false);
        if (autoPlayNext && onNextGop) {
          console.log("Auto-playing next GOP...");
          yieldToMain().then(() => onNextGop(true));
        }
        return;
      }

      const thumb = playbackThumbs[currentIndex];
      if (!thumb) {
        currentIndex++;
        playNext();
        return;
      }
      // 2. 设置选中状态 & 绘制
      const originalIndex = thumbnails.findIndex(t => t?.tagIndex === thumb.tagIndex);
      setSelectedThumbnail(originalIndex >= 0 ? originalIndex : currentIndex);
      setCurrentFrame(currentIndex + 1);

      try {
        const allowThumbFallback = currentIndex === 0 && currentDisplayTagRef.current === null;
        await drawFrameFromCache(thumb.tagIndex, currentIndex, allowThumbFallback);
      } catch (e) {
        console.error(e);
      }

      // 3. 计算下一帧间隔
      let durationMs = 33; // default
      if (currentIndex < playbackThumbs.length - 1) {
        const nextThumb = playbackThumbs[currentIndex + 1];
        durationMs = (nextThumb.timestamp - thumb.timestamp);
      }

      if (durationMs <= 0) durationMs = 33;

      playTimerRef.current = window.setTimeout(() => {
        currentIndex++;
        playNext();
      }, durationMs);
    };

    playNext();

    return () => {
      if (playTimerRef.current) {
        clearTimeout(playTimerRef.current);
      }
      if (audioSourceRef.current) {
        try { audioSourceRef.current.stop(); } catch (e) { }
        audioSourceRef.current.disconnect();
        audioSourceRef.current = null;
      }
    };
  }, [isPlaying, thumbnails, drawFrameFromCache, selectedThumbnail]); // selectedThumbnail 只在初始读取，循环内自己维护 currentIndex

  // 初始化解码器和数据
  useEffect(() => {
    if (isLoadingGopTags) {
      return;
    }

    if (gopVideoTags.length > 0) {
      setError(null);
    }

    const controller = new AbortController();
    const signal = controller.signal;

    cancelWorkerJob();
    predecodeQueueRef.current = [];

    // 重置状态
    setIsPlaying(false);
    setThumbnails([]);
    thumbnailsRef.current = [];
    setIsFrameHiResReady(false);
    currentDisplayTagRef.current = null;
    const { tags: videoTagsForDecode, skipped: skippedFrames } = trimLeadingNonKeyframes(gopVideoTags);
    tagsRef.current = videoTagsForDecode;
    setTotalFrames(videoTagsForDecode.length);
    if (gopVideoTags.length === 0) {
      if (hasLoadedGopTagsRef.current) {
        setError("该 GOP 没有视频帧");
      }
      setIsDecoding(false);
      return;
    }
    if (videoTagsForDecode.length === 0) {
      setError("该 GOP 缺少关键帧，无法解码");
      setIsDecoding(false);
      return;
    }
    if (skippedFrames > 0) {
      console.warn(`Skipping ${skippedFrames} leading non-key frames for decode.`);
    }

    const initDecoder = async () => {
      try {
        if (!('VideoDecoder' in window)) {
          throw new Error("浏览器不支持 WebCodecs API");
        }

        const wasm = getWasmModule();
        let skipVideoDecode = false;

        // 1. 尝试从缓存完全恢复
        // 注意：大文件流式模式下跳过缓存检查（避免为每个帧查询 IndexedDB）
        // GOP 通常只有几十帧，这里的缓存检查是可行的
        if (videoTagsForDecode.length <= 300) {
          try {
            const { loadCachedFramesBatch } = await import('../utils/gopCache');
            const cachedFrames = await loadCachedFramesBatch(fileId, videoTagsForDecode.map(t => t.index));

            if (cachedFrames.every(f => f !== null)) {
              console.log("🔥 GOP 缓存命中，跳过视频解码");
              const loadedThumbs: FrameThumbnail[] = [];

              await Promise.all(cachedFrames.map(async (frame, i) => {
                if (!frame) return;
                const tag = videoTagsForDecode[i];
                let imageData = frame.thumbnail;

                if (!imageData) {
                  const bmp = await createImageBitmap(frame.blob);
                  if (i === 0) {
                    const isVert = bmp.height > bmp.width;
                    console.log(`Cache: First frame size ${bmp.width}x${bmp.height}. Vertical? ${isVert}`);
                    setIsVertical(isVert);
                  }
                  const thumbCanvas = document.createElement('canvas');
                  const scale = 80 / Math.max(bmp.width, bmp.height);
                  thumbCanvas.width = Math.round(bmp.width * scale);
                  thumbCanvas.height = Math.round(bmp.height * scale);
                  const ctx = thumbCanvas.getContext('2d');
                  if (ctx) ctx.drawImage(bmp, 0, 0, thumbCanvas.width, thumbCanvas.height);
                  imageData = thumbCanvas.toDataURL('image/jpeg', 0.6);
                  bmp.close();
                }

                loadedThumbs[i] = {
                  tagIndex: tag.index,
                  timestamp: tag.timestamp,
                  isKeyframe: tag.isKeyframe,
                  imageData: imageData!
                };
              }));

              thumbnailsRef.current = loadedThumbs;
              setThumbnails(loadedThumbs);
              setIsDecoding(false);
              skipVideoDecode = true;

              // Jump to initial tag
              if (initialTagIndex !== undefined) {
                const idx = loadedThumbs.findIndex(t => t.tagIndex === initialTagIndex);
                if (idx !== -1) {
                  yieldToMain().then(() => handleThumbnailClick(initialTagIndex, idx));
                }
              } else if (loadedThumbs.length > 0) {
                // 显示第一帧，但不自动播放（等待用户点击播放按钮）
                yieldToMain().then(() => handleThumbnailClick(loadedThumbs[0].tagIndex, 0));
              }
            }
          } catch (e) {
            console.warn("读取缓存失败:", e);
          }
        }

        if (gops && typeof currentGopListIndex === 'number' && preloadGopCount > 0) {
          predecodeQueueRef.current = gops.slice(
            currentGopListIndex + 1,
            currentGopListIndex + 1 + preloadGopCount
          );
        }

        if (!skipVideoDecode) {
          isAnnexBRef.current = false;
          const { config, isAnnexB } = await buildVideoDecoderConfig(videoTagsForDecode);
          if (signal.aborted) return;
          isAnnexBRef.current = isAnnexB;
          cancelWorkerJob();
          await startWorkerDecode('active', videoTagsForDecode, config, isAnnexB, signal);
        } else if (predecodeQueueRef.current.length > 0) {
          const nextGop = predecodeQueueRef.current.shift();
          if (nextGop) {
            void startPredecode(nextGop);
          }
        }

        // === Audio decode ===
        if (gopAudioTags.length > 0 && 'AudioDecoder' in window) {
          try {
            if (!audioCtxRef.current) {
              audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
            }

            const cachedAudio = await loadAudioBuffer(fileId, gop.index, audioCtxRef.current);
            if (cachedAudio) {
              console.log("🔥 Audio Cache Hit");
              audioBufferRef.current = cachedAudio;
            } else {
              const audioCtx = audioCtxRef.current;
              const isMP4OrTS = formatLower === 'mp4' || formatLower === 'ts';

              const buildAudioBuffer = (frames: AudioData[]) => {
                if (frames.length === 0) return null;
                const totalFrames = frames.reduce((acc, f) => acc + f.numberOfFrames, 0);
                const sampleRate = frames[0].sampleRate;
                const channels = frames[0].numberOfChannels;
                const buffer = audioCtx.createBuffer(channels, totalFrames, sampleRate);
                for (let ch = 0; ch < channels; ch++) {
                  const dest = buffer.getChannelData(ch);
                  let offset = 0;
                  for (const frame of frames) {
                    frame.copyTo(dest.subarray(offset), { planeIndex: ch });
                    offset += frame.numberOfFrames;
                  }
                }
                frames.forEach(f => f.close());
                return buffer;
              };

              if (isMP4OrTS) {
                const desc = analysisResult.audioInitData
                  ? new Uint8Array(analysisResult.audioInitData)
                  : undefined;
                if (!desc || desc.length === 0) {
                  // 缺少音频初始化数据时跳过音频解码
                } else {
                  const { codec, sampleRate, channels } = parseAacConfig(desc);
                  const audioFrames: AudioData[] = [];
                  const audioDecoder = new AudioDecoder({
                    output: (f) => audioFrames.push(f),
                    error: (e) => console.error("Audio Decode Error", e)
                  });
                  audioDecoder.configure({
                    codec,
                    numberOfChannels: channels,
                    sampleRate,
                    description: desc
                  });

                  for (const tag of gopAudioTags) {
                    let chunkData: Uint8Array | null = null;
                    if (fileData) {
                      chunkData = fileData.subarray(tag.offset, tag.offset + tag.size);
                    } else if (isStreamingMode) {
                      chunkData = await wasmWorker.readSampleData(fileId, tag.index);
                    }
                    if (!chunkData) continue;
                    audioDecoder.decode(new EncodedAudioChunk({
                      type: 'key',
                      timestamp: tag.timestamp * 1000,
                      duration: 0,
                      data: chunkData
                    }));
                  }

                  await audioDecoder.flush();
                  const buffer = buildAudioBuffer(audioFrames);
                  if (buffer) {
                    audioBufferRef.current = buffer;
                    await saveAudioBuffer(fileId, gop.index, buffer);
                    console.log(`Audio Decoded: ${buffer.duration.toFixed(3)}s`);
                  }
                }
              } else {
                // FLV AAC (支持流式读取)
                let description: Uint8Array | undefined;
                if (analysisResult.audioInitData && analysisResult.audioInitData.length > 0) {
                  description = new Uint8Array(analysisResult.audioInitData);
                } else if (fileData) {
                  const audioSeqHeader = analysisResult.tags.find(t => t.type === 'audio' && t.isSeqHeader);
                  if (audioSeqHeader) {
                    const offset = audioSeqHeader.offset + 11;
                    const hData = fileData.subarray(offset, offset + audioSeqHeader.size);
                    if ((hData[0] >> 4) === 10) {
                      description = hData.subarray(2);
                    }
                  }
                }

                const { codec, sampleRate, channels } = parseAacConfig(description);
                const audioFrames: AudioData[] = [];
                const audioDecoder = new AudioDecoder({
                  output: (f) => audioFrames.push(f),
                  error: (e) => console.error("Audio Decode Error", e)
                });

                audioDecoder.configure({
                  codec,
                  numberOfChannels: channels,
                  sampleRate,
                  description
                });

                for (const tag of gopAudioTags) {
                  let chunkData: Uint8Array | null = null;
                  if (fileData) {
                    const offset = tag.offset + 11;
                    chunkData = fileData.subarray(offset, offset + tag.size);
                  } else if (isStreamingMode) {
                    chunkData = await wasmWorker.readSampleData(fileId, tag.index);
                  }
                  if (!chunkData || chunkData.length < 2) continue;
                  if ((chunkData[0] >> 4) === 10 && chunkData[1] === 1) {
                    audioDecoder.decode(new EncodedAudioChunk({
                      type: 'key',
                      timestamp: tag.timestamp * 1000,
                      duration: 0,
                      data: chunkData.subarray(2)
                    }));
                  }
                }

                await audioDecoder.flush();
                const buffer = buildAudioBuffer(audioFrames);
                if (buffer) {
                  audioBufferRef.current = buffer;
                  await saveAudioBuffer(fileId, gop.index, buffer);
                  console.log(`Audio Decoded: ${buffer.duration.toFixed(3)}s`);
                }
              }
            }
          } catch (e) {
            console.error("Audio logic failed", e);
          }
        }

        if (signal.aborted) return;

        if (signal.aborted) return;

        if (skipVideoDecode) {
          setThumbnails(thumbnailsRef.current);

          if (initialTagIndex !== undefined) {
            const idx = thumbnailsRef.current.findIndex(t => t.tagIndex === initialTagIndex);
            if (idx >= 0) {
              setSelectedThumbnail(idx);
              setCurrentFrame(idx + 1);
              await drawFrameFromCache(thumbnailsRef.current[idx].tagIndex, idx, true);
            }
          } else if (thumbnailsRef.current.length > 0) {
            setSelectedThumbnail(0);
            setCurrentFrame(1);
            await drawFrameFromCache(thumbnailsRef.current[0].tagIndex, 0, true);
          }

          if (autoPlayStartRef.current && thumbnailsRef.current.length > 0) {
            autoPlayStartRef.current = false;
            setIsPlaying(true);
          }

          setIsDecoding(false);
        } else if (autoPlayStartRef.current && thumbnailsRef.current.length > 0) {
          autoPlayStartRef.current = false;
          setIsPlaying(true);
        }


      } catch (e) {
        if (!signal.aborted) {
          setError(`初始化失败: ${e instanceof Error ? e.message : String(e)}`);
          setIsDecoding(false);
        }
      }
    };

    initDecoder();

    return () => {
      controller.abort();
      cancelWorkerJob();

      if (decoderRef.current) {
        try {
          if (decoderRef.current.state !== 'closed') {
            decoderRef.current.close();
          }
        } catch { } // 忽略关闭错误
        decoderRef.current = null;
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      frameQueueRef.current.forEach(f => f.close());
      frameQueueRef.current = [];
    };
    // 使用 gopVideoTags 和 gopAudioTags 的长度作为依赖，避免数组引用变化导致无限循环
    // 重要：不依赖 analysisResult 对象本身，只依赖其内部的稳定属性
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    drawBlobToCanvas,
    drawFrameFromCache,
    fileData,
    fileId,
    formatLower,
    gopAudioTags.length,  // 只依赖长度，避免对象引用变化
    gopVideoTags.length,  // 只依赖长度，避免对象引用变化
    handleThumbnailClick,
    initialTagIndex,
    isLoadingGopTags,
    isStreamingMode,
    gop.index,  // 添加 gop.index, 确保 GOP 切换时重新初始化
    buildVideoDecoderConfig,
    cancelWorkerJob,
    startWorkerDecode,
    startPredecode,
    gops,
    currentGopListIndex,
    preloadGopCount
  ]);

  // 解码 GOP
  const decodeGop = async (
    decoder: VideoDecoder,
    tags: TagSummary[],
    data: Uint8Array | null,
    wasm: any,
    signal: AbortSignal,
    getSampleData?: (tag: TagSummary) => Promise<Uint8Array>
  ) => {
    let frameIndex = 0;
    let decodedCount = 0;
    let skippedCount = 0;

    console.log(`开始解码 GOP, 共 ${tags.length} 个视频 Tag`);

    // 检测格式
    const isMP4OrTS = formatLower === 'mp4' || formatLower === 'ts';
    console.log(`解码模式: ${isMP4OrTS ? 'MP4/TS' : 'FLV'}`);

    // 1. 预计算所有帧的 PTS 和 Duration
    const frameMetaMap = new Map<number, { pts: number, duration: number }>();
    const ptsList: { index: number; pts: number }[] = [];

    if (isMP4OrTS) {
      // MP4/TS: 直接使用 videoTimeline 中的时间信息
      for (const tag of tags) {
        const timelinePoint = analysisResult.videoTimeline.find(p => p.index === tag.index);
        if (timelinePoint) {
          // PTS 单位统一为 microseconds
          const pts = timelinePoint.pts * 1000 * 1000; // seconds -> microseconds
          ptsList.push({ index: tag.index, pts });
        } else {
          // 降级使用 timestamp
          const pts = tag.timestamp * 1000; // ms -> microseconds
          ptsList.push({ index: tag.index, pts });
        }
      }
    } else {
      // FLV: 从 tag 数据解析 CTS
      // 注意：data 在 FLV 模式下必定不为 null（函数调用前已检查）
      for (const tag of tags) {
        const offset = tag.offset + 11; // Tag Header 11 bytes
        if (offset + 5 > data!.length) continue;

        const p = data!.subarray(offset, offset + 5);
        if (p[1] !== 1) continue; // 只计算 NALU

        const cts = (p[2] << 16) | (p[3] << 8) | p[4];
        const pts = (tag.timestamp + cts) * 1000; // microseconds
        ptsList.push({ index: tag.index, pts });
      }
    }

    // 按 PTS 排序
    ptsList.sort((a, b) => a.pts - b.pts);
    const basePts = ptsList.length > 0 ? ptsList[0].pts : 0;

    // 计算 Duration 并归一化 PTS
    for (let i = 0; i < ptsList.length; i++) {
      const current = ptsList[i];
      const normalizedPts = current.pts - basePts;

      let duration = 33333; // 默认 33ms (approx 30fps)

      if (i < ptsList.length - 1) {
        const next = ptsList[i + 1];
        duration = next.pts - current.pts;
      } else if (i > 0) {
        duration = current.pts - ptsList[i - 1].pts;
      }

      if (duration <= 0) duration = 33333;
      frameMetaMap.set(current.index, { pts: normalizedPts, duration });
    }

    // 2. 逐 Tag/Sample 解码
    for (const tag of tags) {
      if (signal.aborted) break;
      if (!decoderRef.current || decoderRef.current.state === 'closed') break;

      // === 流控逻辑 ===
      const MAX_QUEUE_SIZE = 24;
      if (frameQueueRef.current.length > MAX_QUEUE_SIZE) {
        while (frameQueueRef.current.length > MAX_QUEUE_SIZE * 0.8) {
          if (signal.aborted) break;
          await Promise.race([
            yieldToMain(),
            new Promise<void>(resolve => setTimeout(resolve, 10)),
          ]);
        }
      }

      try {
        let naluData: Uint8Array;
        let pts: number;
        let duration: number;

        if (isMP4OrTS) {
          // MP4/TS: 数据直接在 offset 位置，已经是 AVCC/HVCC 格式
          if (data) {
            naluData = data.subarray(tag.offset, tag.offset + tag.size);
          } else if (getSampleData) {
            naluData = await getSampleData(tag);
          } else {
            throw new Error('无法读取 MP4 Sample 数据');
          }

          // 使用预计算的元数据
          const meta = frameMetaMap.get(tag.index);
          pts = meta ? meta.pts : tag.timestamp * 1000;
          duration = meta ? meta.duration : 33333;

          if (frameIndex === 0) {
            const hexStr = Array.from(naluData.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
            console.log(`MP4 Frame 0: size=${naluData.length}, first 16 bytes: ${hexStr}`);
          }
        } else {
          // FLV: 需要解析 tag header
          let videoTagData: Uint8Array;
          if (data) {
            const tagDataOffset = tag.offset + 11;
            videoTagData = data.subarray(tagDataOffset, tagDataOffset + tag.size);
          } else if (getSampleData) {
            videoTagData = await getSampleData(tag);
          } else {
            throw new Error('无法读取 FLV Tag 数据');
          }

          const codecId = videoTagData[0] & 0x0f;
          const avcPacketType = videoTagData[1];

          if (avcPacketType !== 1) {
            skippedCount++;
            continue;
          }

          const meta = frameMetaMap.get(tag.index);
          const cts = (videoTagData[2] << 16) | (videoTagData[3] << 8) | videoTagData[4];
          pts = meta ? meta.pts : (tag.timestamp + cts) * 1000;
          duration = meta ? meta.duration : 33333;

          naluData = videoTagData.subarray(5);

          // FLV HEVC Annex B 转换
          if (codecId === 12 && isAnnexBRef.current) {
            if (wasm.isAnnexBFormat(naluData)) {
              naluData = wasm.convertAnnexBToAVCC(naluData);
            }
          }
        }

        const isKey = tag.isKeyframe;

        const chunk = new EncodedVideoChunk({
          type: isKey ? 'key' : 'delta',
          timestamp: pts,
          duration: duration,
          data: naluData
        });

        if (frameIndex === 0) {
          console.log(`Feed Frame 0: type=${chunk.type}, pts=${chunk.timestamp / 1000}ms, dur=${chunk.duration! / 1000}ms`);
        }

        if (frameIndex < 3 || frameIndex % 30 === 0) {
          console.log(`Feed Frame ${frameIndex}: type=${chunk.type}, pts=${(chunk.timestamp / 1000).toFixed(1)}ms`);
        }
        decoder.decode(chunk);
        decodedCount++;
        frameIndex++;
      } catch (e) {
        console.error(`Frame ${frameIndex} decoding failed:`, e);
      }
    }

    if (signal.aborted) return;

    console.log(`解码完成: ${decodedCount} 帧已解码, ${skippedCount} 帧已跳过`);
    console.log(`decoder.state: ${decoder.state}, decodeQueueSize: ${decoder.decodeQueueSize}`);

    try {
      await decoder.flush();
      console.log(`Flush 完成, 帧队列长度: ${frameQueueRef.current.length}`);
    } catch (e) {
      if (!signal.aborted) {
        console.error('Flush 失败:', e);
      }
    }
  };


  // 渲染循环
  const renderLoop = () => {
    if (!canvasRef.current || !decoderRef.current) return;

    let emptyFrames = 0;
    const maxEmptyFrames = 180;

    const render = () => {
      if (frameQueueRef.current.length > 0) {
        const frame = frameQueueRef.current.shift();
        if (frame) {
          const ctx = canvasRef.current!.getContext('2d');
          if (ctx) {
            canvasRef.current!.width = frame.displayWidth;
            canvasRef.current!.height = frame.displayHeight;
            ctx.drawImage(frame, 0, 0);
            setCurrentFrame(prev => prev + 1);
          }
          frame.close();
          emptyFrames = 0;
        }
      } else {
        emptyFrames++;
      }

      const decoder = decoderRef.current;
      const shouldStop =
        !decoder ||
        decoder.state === 'closed' ||
        (frameQueueRef.current.length === 0 && decoder.decodeQueueSize === 0) ||
        emptyFrames >= maxEmptyFrames;

      if (shouldStop) {
        if (emptyFrames >= maxEmptyFrames) {
          console.log(`渲染超时，停止`);
        }
        return;
      }

      animationFrameRef.current = requestAnimationFrame(render);
    };

    animationFrameRef.current = requestAnimationFrame(render);
  };

  return (
    <div className="gop-player-overlay">
      <div className={`gop-player-modal ${isVertical ? 'vertical-layout' : ''}`} data-testid="gop-player-modal">
        <div className="player-header">
          <h3>GOP 预览: {formatDuration(gop.startTime)}</h3>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <button
              className="control-btn"
              onClick={() => setIsVertical(v => !v)}
              title="切换布局"
              style={{ padding: '4px 8px', fontSize: '12px', height: 'fit-content' }}
            >
              {isVertical ? '◫ 横向布局' : '⊟ 纵向布局'}
            </button>
            <button className="close-btn" onClick={onClose} data-testid="close-btn">×</button>
          </div>
        </div>

        <div className="player-content-wrapper">
          <div className="player-main">
            {/* 主画布区域 */}
            <div className="canvas-container">
              {error ? (
                <div className="player-error" data-testid="player-error">{error}</div>
              ) : (
                <canvas ref={canvasRef} />
              )}
              {!error && !isPlaying && thumbnails.length === 0 && isDecoding && (
                <div className="decoding-overlay" data-testid="decoding-status">
                  <div className="spinner" />
                  <span>{isLoadingGopTags ? '加载 GOP 数据...' : '解码中'}</span>
                </div>
              )}
            </div>
          </div>

          <div className="player-sidebar">
            {/* 帧缩略图画廊 */}
            {(gopVideoTags.length > 0 || isLoadingGopTags || isDecoding) && (
              <div className="frame-gallery" data-testid="frame-gallery">
                <div className="gallery-header">
                  <span>帧画廊 ({thumbnails.length} 帧)</span>
                </div>
                <div
                  className="gallery-scroll"
                  ref={galleryRef}
                  onWheel={(e) => {
                    if (!isVertical && e.deltaY !== 0) {
                      e.currentTarget.scrollLeft += e.deltaY;
                    }
                  }}
                >
                  {thumbnails.length === 0 && (
                    <div className="gallery-empty">正在解码帧...</div>
                  )}
                  {thumbnails.map((thumb, idx) => (
                    <div
                      key={thumb.tagIndex}
                      id={`thumb-${idx}`}
                      className={`frame-thumb ${selectedThumbnail === idx ? 'selected' : ''} ${thumb.isKeyframe ? 'keyframe' : ''}`}
                      onClick={() => handleThumbnailClick(thumb.tagIndex, idx)}
                      title={`Tag #${thumb.tagIndex} @ ${formatDuration(thumb.timestamp / 1000)}`}
                      data-testid={`frame-thumb-${idx}`}
                    >
                      <img src={thumb.imageData} alt={`Frame ${idx}`} />
                      <div className="thumb-info">
                        <span className="thumb-index">#{idx + 1}</span>
                        {thumb.isKeyframe && <span className="thumb-kf">KF</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="player-controls">
              <div className="player-actions" style={{ flexWrap: 'wrap', gap: '8px' }}>
                <button
                  className={`control-btn ${isPlaying ? 'active' : ''}`}
                  onClick={togglePlay}
                  data-testid={isPlaying ? "pause-btn" : "play-btn"}
                >
                  {isPlaying ? '⏸ 暂停' : '▶ 播放'}
                </button>

                {/* Next/Prev GOP Controls */}
                <div className="gop-nav-controls" style={{ display: 'flex', gap: '4px' }}>
                  <button className="control-btn" onClick={() => onPrevGop?.()} disabled={!onPrevGop} title="上一个 GOP">
                    ⏮
                  </button>
                  <button className="control-btn" onClick={() => onNextGop?.()} disabled={!onNextGop} title="下一个 GOP">
                    ⏭
                  </button>
                </div>

                {/* Auto Play Toggle */}
                {onAutoPlayChange && (
                  <label style={{ display: 'flex', alignItems: 'center', fontSize: '12px', gap: '4px', cursor: 'pointer', userSelect: 'none' }}>
                    <input
                      type="checkbox"
                      checked={autoPlayNext}
                      onChange={(e) => onAutoPlayChange(e.target.checked)}
                    />
                    自动播放下一个
                  </label>
                )}
              </div>
              <div className="frame-info" data-testid="frame-count">
                帧: {currentFrame} / {totalFrames}
              </div>
              {selectedThumbnail !== null && (
                <div className="selected-info">
                  <span>选中: Tag #{thumbnails[selectedThumbnail]?.tagIndex}</span>
                  {onTagSelect && (
                    <button
                      className="btn-link"
                      style={{ marginLeft: '10px', cursor: 'pointer', background: 'none', border: 'none', color: '#646cff', textDecoration: 'underline' }}
                      onClick={() => onTagSelect(thumbnails[selectedThumbnail].tagIndex)}
                    >
                      🔍 查看详情
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
