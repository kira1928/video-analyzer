import { useEffect, useRef, useState, useCallback } from 'react';
import { AnalysisResult, Gop, TagSummary } from '../types';
import { getWasmModule } from '../utils/wasm';
import { formatDuration } from '../utils/format';
import { saveFrame, loadFrame, loadCachedFrame, saveAudioBuffer, loadAudioBuffer } from '../utils/gopCache';
import '../styles/GopPlayer.css';

interface GopPlayerProps {
  fileId: string;
  gop: Gop;
  fileData: Uint8Array;
  analysisResult: AnalysisResult;
  onClose: () => void;
  onTagSelect?: (tagIndex: number) => void; // 点击帧时选择对应的 Tag
  initialTagIndex?: number; // 初始选中的 Tag
  autoPlayNext?: boolean;
  onAutoPlayChange?: (val: boolean) => void;
  onNextGop?: () => void;
  onPrevGop?: () => void;
}

interface FrameThumbnail {
  tagIndex: number;
  timestamp: number;
  isKeyframe: boolean;
  imageData: string; // base64 data URL
}

export function GopPlayer({
  fileId,
  gop,
  fileData,
  analysisResult,
  onClose,
  onTagSelect,
  initialTagIndex,
  autoPlayNext = false,
  onAutoPlayChange,
  onNextGop,
  onPrevGop
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

  // 自动滚动到选中的帧
  useEffect(() => {
    if (selectedThumbnail !== null && galleryRef.current) {
      const el = document.getElementById(`thumb-${selectedThumbnail}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    }
  }, [selectedThumbnail]);



  // 获取该 GOP 的视频 Tag 列表
  const gopVideoTags = analysisResult.tags.filter(
    t => t.index >= gop.startIndex && t.index <= gop.endIndex && t.type === 'video' && !t.isSeqHeader
  );

  // ESC 关闭
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  // 点击缩略图
  const handleThumbnailClick = useCallback(async (tagIndex: number, index: number) => {
    setSelectedThumbnail(index);

    // 停止自动播放循环
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    // 设置当前帧显示
    setCurrentFrame(index + 1);

    try {
      // 尝试从缓存加载高画质帧
      const blob = await loadFrame(fileId, tagIndex);
      if (blob && canvasRef.current) {
        const img = new Image();
        img.onload = () => {
          if (canvasRef.current) {
            const ctx = canvasRef.current.getContext('2d');
            if (ctx) {
              canvasRef.current.width = img.width;
              canvasRef.current.height = img.height;
              ctx.drawImage(img, 0, 0);
            }
          }
          URL.revokeObjectURL(img.src);
        };
        img.src = URL.createObjectURL(blob);
      }
    } catch (e) {
      console.error("加载缓存帧失败:", e);
    }
  }, [fileId]);

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

  // 切换播放/暂停
  const togglePlay = useCallback(() => {
    setIsPlaying(p => !p);
  }, []);

  // 键盘导航
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
        // 使用 setTimeout 确保 UI 响应
        setTimeout(() => handleThumbnailClick(initialTagIndex, idx), 0);
      }
    }
  }, [initialTagIndex, thumbnails, handleThumbnailClick]);

  // 播放控制循环
  useEffect(() => {
    if (!isPlaying || thumbnails.length === 0) {
      if (playTimerRef.current) {
        clearTimeout(playTimerRef.current);
        playTimerRef.current = null;
      }
      return;
    }

    let currentIndex = selectedThumbnail ?? 0;
    // 如果已经在最后，重头开始
    if (currentIndex >= thumbnails.length - 1) {
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

        const startTime = thumbnails[0].timestamp;
        const currentTime = thumbnails[currentIndex].timestamp;
        const offset = Math.max(0, (currentTime - startTime) / 1000);

        source.start(0, offset);
        audioSourceRef.current = source;
      } catch (e) {
        console.error("Audio play failed:", e);
      }
    }

    const playNext = async () => {
      if (currentIndex >= thumbnails.length) {
        setIsPlaying(false);
        if (autoPlayNext && onNextGop) {
          console.log("Auto-playing next GOP...");
          setTimeout(() => onNextGop(), 100);
        }
        return;
      }

      const thumb = thumbnails[currentIndex];
      // 2. 设置选中状态 & 绘制
      setSelectedThumbnail(currentIndex);
      setCurrentFrame(currentIndex + 1);

      try {
        const blob = await loadFrame(fileId, thumb.tagIndex);
        if (canvasRef.current && blob) {
          const img = new Image();
          img.onload = () => {
            if (canvasRef.current) {
              const ctx = canvasRef.current.getContext('2d');
              if (ctx) {
                canvasRef.current.width = img.width;
                canvasRef.current.height = img.height;
                ctx.drawImage(img, 0, 0);
              }
            }
            URL.revokeObjectURL(img.src);
          };
          img.src = URL.createObjectURL(blob);
        }
      } catch (e) { console.error(e); }

      // 3. 计算下一帧间隔
      let durationMs = 33; // default
      if (currentIndex < thumbnails.length - 1) {
        const nextThumb = thumbnails[currentIndex + 1];
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
  }, [isPlaying, thumbnails]); // selectedThumbnail 只在初始读取，循环内自己维护 currentIndex

  // 初始化解码器和数据
  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;

    // 重置状态
    setIsPlaying(false);
    setThumbnails([]);
    tagsRef.current = gopVideoTags;
    setTotalFrames(gopVideoTags.length);
    if (gopVideoTags.length === 0) {
      setError("该 GOP 没有视频帧");
      setIsDecoding(false);
      return;
    }

    const initDecoder = async () => {
      try {
        if (!('VideoDecoder' in window)) {
          throw new Error("浏览器不支持 WebCodecs API");
        }

        const wasm = getWasmModule();
        let skipVideoDecode = false;

        // 1. 尝试从缓存完全恢复
        try {
          const cachePromises = gopVideoTags.map(t => loadCachedFrame(fileId, t.index));
          const cachedFrames = await Promise.all(cachePromises);

          if (cachedFrames.every(f => f !== null)) {
            console.log("🔥 GOP 缓存命中，跳过视频解码");
            const loadedThumbs: FrameThumbnail[] = [];

            await Promise.all(cachedFrames.map(async (frame, i) => {
              if (!frame) return;
              const tag = gopVideoTags[i];
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
                setTimeout(() => handleThumbnailClick(initialTagIndex, idx), 50);
              }
            } else if (loadedThumbs.length > 0) {
              if (autoPlayNext) {
                setTimeout(() => {
                  handleThumbnailClick(loadedThumbs[0].tagIndex, 0);
                  setIsPlaying(true);
                }, 50);
              } else {
                setTimeout(() => handleThumbnailClick(loadedThumbs[0].tagIndex, 0), 50);
              }
            }
          }
        } catch (e) {
          console.warn("读取缓存失败:", e);
        }

        if (!skipVideoDecode) {
          // 清除之前的状态引用
          isAnnexBRef.current = false;

          // 找到 Sequence Header
          const seqHeaderTag = analysisResult.tags.find(t => t.type === 'video' && t.isSeqHeader);
          if (!seqHeaderTag) {
            throw new Error("未找到视频 Sequence Header");
          }

          const seqHeaderOffset = seqHeaderTag.offset + 11;
          const seqHeaderData = fileData.subarray(seqHeaderOffset, seqHeaderOffset + seqHeaderTag.size);
          const codecId = seqHeaderData[0] & 0x0f;
          const configData = seqHeaderData.subarray(5);

          let codec = 'avc1.64001f';
          let description: Uint8Array | undefined;

          if (codecId === 12) { // HEVC
            const isAnnexB = wasm.isAnnexBFormat(configData);

            if (isAnnexB) {
              console.log("检测到 HEVC Annex B 格式，从 Sequence Header 转换...");
              isAnnexBRef.current = true;
              try {
                const hvccData = wasm.convertAnnexBToHVCC(configData);
                codec = 'hvc1.1.6.L93.B0';
                description = hvccData;
                console.log(`生成 HEVC Codec String (FORCED): ${codec}`);
              } catch (e) {
                console.warn("HEVC 转换失败:", e);
                codec = 'hvc1.1.6.L93.B0';
                description = configData;
              }
            } else {
              try {
                codec = wasm.generateHEVCCodecString(configData, "raw", "concat");
                description = configData;
                console.log(`使用原生 HVCC, Codec String: ${codec}`);
              } catch (e) {
                console.warn("HVCC 解析失败:", e);
                codec = 'hvc1.1.6.L93.B0';
                description = configData;
              }
            }
          } else if (codecId === 7) { // AVC
            description = configData;
            codec = 'avc1.64001f';
          }

          if (signal.aborted) return;

          console.log(`配置解码器: codec=${codec}, description=${description?.length ?? 0} bytes`);

          // Reset refs
          thumbnailsRef.current = [];
          frameQueueRef.current = [];

          let frameCount = 0;
          const decoder = new VideoDecoder({
            output: (frame) => {
              // output 回调是同步序列化的
              // 每次 output 一个 frame，我们立即生成缩略图，并将其转交给渲染队列

              const frameIdx = thumbnailsRef.current.length;
              if (frameIdx === 0) {
                const isVert = frame.displayHeight > frame.displayWidth;
                console.log(`Decoder: First frame size ${frame.displayWidth}x${frame.displayHeight}. Vertical? ${isVert}`, frame);
                setIsVertical(isVert);
              }
              const tagIdx = gopVideoTags[frameIdx]?.index ?? -1;
              const tag = gopVideoTags[frameIdx];

              // 1. 同步生成缩略图 (轻量 Canvas 操作)
              // 不再存储 VideoFrame，极大降低显存压力
              const thumb = createThumbnail(frame, tagIdx, tag?.timestamp ?? 0, tag?.isKeyframe ?? false);
              thumbnailsRef.current.push(thumb);

              // 缓存高画质帧到 IndexedDB
              const cacheCanvas = document.createElement('canvas');
              // 限制最大宽度，避免存储过大
              const maxCacheWidth = 1280;
              const scale = Math.min(1, maxCacheWidth / frame.displayWidth);
              cacheCanvas.width = Math.round(frame.displayWidth * scale);
              cacheCanvas.height = Math.round(frame.displayHeight * scale);
              const ctx = cacheCanvas.getContext('2d');
              if (ctx) {
                ctx.drawImage(frame, 0, 0, cacheCanvas.width, cacheCanvas.height);
                cacheCanvas.toBlob(blob => {
                  if (blob) saveFrame(fileId, tagIdx, blob, thumb.imageData);
                }, 'image/jpeg', 0.8);
              }

              // 2. 将 Frame 所有权转交给 frameQueue，用于渲染循环
              // 渲染循环取出后负责 close()
              frameQueueRef.current.push(frame);

              if (frameIdx % 15 === 0) {
                console.log(`Frame ${frameIdx} output. Queue size: ${frameQueueRef.current.length}`);
              }
              frameCount++;
            },
            error: (e) => {
              console.error("解码错误:", e);
              setError(`解码错误: ${e.message}`);
            }
          });

          const config: VideoDecoderConfig = {
            codec: codec,
            description: description,
            codedWidth: 1280,
            codedHeight: 720,
            // codedWidth/codedHeight 是可选的。
            // 当提供了 description (AVCC/HVCC) 时，解码器会自动从 SPS/PPS 中解析分辨率。
          };

          const support = await VideoDecoder.isConfigSupported(config);

          if (signal.aborted) return;

          console.log(`配置支持检查: supported=${support.supported}`, support.config);

          if (!support.supported) {
            throw new Error(`不支持的视频配置: ${codec}`);
          }

          decoder.configure(config);
          decoderRef.current = decoder;

          // 解码所有帧
          await decodeGop(decoder, gopVideoTags, fileData, wasm, signal);
        }

        // === 音频解码逻辑 (始终尝试解码) ===
        const gopAudioTags = analysisResult.tags.filter(
          t => t.index >= gop.startIndex && t.index <= gop.endIndex && t.type === 'audio' && !t.isSeqHeader
        );

        if (gopAudioTags.length > 0 && 'AudioDecoder' in window) {
          try {
            if (!audioCtxRef.current) {
              audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
            }

            // Check Audio Cache
            const cachedAudio = loadAudioBuffer(fileId, gop.index);
            if (cachedAudio) {
              console.log("🔥 Audio Cache Hit");
              audioBufferRef.current = cachedAudio;
            } else {
              const audioCtx = audioCtxRef.current;

              // Simplified AAC handling: assuming AAC LC
              // Extract AudioSpecificConfig from Sequence Header
              let description: Uint8Array | undefined;
              const audioSeqHeader = analysisResult.tags.find(t => t.type === 'audio' && t.isSeqHeader);
              if (audioSeqHeader) {
                const offset = audioSeqHeader.offset + 11;
                const hData = fileData.subarray(offset, offset + audioSeqHeader.size);
                // FLV Audio: Byte0=Header(Format,Rate,Size,Type). If Format=10(AAC), Byte1=PacketType(0=SeqHead).
                if ((hData[0] >> 4) === 10) {
                  description = hData.subarray(2);
                }
              }

              const audioFrames: AudioData[] = [];
              const audioDecoder = new AudioDecoder({
                output: (f) => audioFrames.push(f),
                error: (e) => console.error("Audio Decode Error", e)
              });

              audioDecoder.configure({
                codec: 'mp4a.40.2',
                numberOfChannels: 2,
                sampleRate: 44100,
                description: description
              });

              for (const tag of gopAudioTags) {
                const offset = tag.offset + 11;
                const chunkData = fileData.subarray(offset, offset + tag.size);
                if ((chunkData[0] >> 4) === 10 && chunkData[1] === 1) { // AAC Raw
                  audioDecoder.decode(new EncodedAudioChunk({
                    type: 'key',
                    timestamp: tag.timestamp * 1000,
                    duration: 0,
                    data: chunkData.subarray(2)
                  }));
                }
              }

              await audioDecoder.flush();

              if (audioFrames.length > 0) {
                const totalFrames = audioFrames.reduce((acc, f) => acc + f.numberOfFrames, 0);
                const sampleRate = audioFrames[0].sampleRate;
                const channels = audioFrames[0].numberOfChannels;

                const buffer = audioCtx.createBuffer(channels, totalFrames, sampleRate);

                for (let ch = 0; ch < channels; ch++) {
                  const dest = buffer.getChannelData(ch);
                  let offset = 0;
                  for (const frame of audioFrames) {
                    frame.copyTo(dest.subarray(offset), { planeIndex: ch });
                    offset += frame.numberOfFrames;
                  }
                }
                audioFrames.forEach(f => f.close());
                audioBufferRef.current = buffer;
                saveAudioBuffer(fileId, gop.index, buffer);
                console.log(`Audio Decoded: ${buffer.duration.toFixed(3)}s`);
              }
            }
          } catch (e) {
            console.error("Audio logic failed", e);
          }
        }

        if (signal.aborted) return;

        // 设置缩略图状态
        setThumbnails(thumbnailsRef.current);


        // 如果有初始选中的 Tag，找到对应位置
        if (initialTagIndex !== undefined) {
          const idx = thumbnailsRef.current.findIndex(t => t.tagIndex === initialTagIndex);
          if (idx >= 0) {
            setSelectedThumbnail(idx);
          }
        } else if (autoPlayNext && thumbnailsRef.current.length > 0) {
          // 自动播放时，从第一帧开始
          setSelectedThumbnail(0);
          setCurrentFrame(1);
          setIsPlaying(true);
        }

        setIsDecoding(false);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gop.index]);

  // 解码 GOP
  const decodeGop = async (decoder: VideoDecoder, tags: TagSummary[], data: Uint8Array, wasm: any, signal: AbortSignal) => {
    let frameIndex = 0;
    let decodedCount = 0;
    let skippedCount = 0;

    console.log(`开始解码 GOP, 共 ${tags.length} 个视频 Tag`);

    // 1. 预计算所有帧的 PTS 和 Duration
    // 因为 B 帧的存在，解码顺序(DTS)和显示顺序(PTS)不一致
    // 我们需要按 PTS 排序来计算每一帧的持续时间 (Duration = NextPTS - CurrentPTS)
    const frameMetaMap = new Map<number, { pts: number, duration: number }>();

    // 临时列表用于排序
    const ptsList: { index: number; pts: number }[] = [];

    for (const tag of tags) {
      const offset = tag.offset + 11; // Tag Header 11 bytes
      if (offset + 5 > data.length) continue;

      // 读取 Video Tag Header (5 bytes)
      // [0]: FrameType(4) + CodecID(4)
      // [1]: AVCPacketType
      // [2-4]: CompositionTime
      const p = data.subarray(offset, offset + 5);
      if (p[1] !== 1) continue; // 只计算 NALU (skip seq header, end of seq)

      const cts = (p[2] << 16) | (p[3] << 8) | p[4];
      const pts = (tag.timestamp + cts) * 1000; // microseconds
      ptsList.push({ index: tag.index, pts });
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
        // 最后一帧，沿用上一帧的 duration
        duration = current.pts - ptsList[i - 1].pts;
      }

      // 修正异常 duration
      if (duration <= 0) duration = 33333;

      frameMetaMap.set(current.index, { pts: normalizedPts, duration });
    }

    // 2. 逐 Tag 解码
    for (const tag of tags) {
      if (signal.aborted) break;
      if (!decoderRef.current || decoderRef.current.state === 'closed') break;

      // === 流控逻辑 START ===
      const MAX_QUEUE_SIZE = 24;
      if (frameQueueRef.current.length > MAX_QUEUE_SIZE) {
        // 队列太长，稍微等一下，让 renderLoop 消费一点
        while (frameQueueRef.current.length > MAX_QUEUE_SIZE * 0.8) {
          if (signal.aborted) break;
          await new Promise(r => setTimeout(r, 10));
        }
      }
      // === 流控逻辑 END ===

      try {
        const tagDataOffset = tag.offset + 11;
        const videoTagData = data.subarray(tagDataOffset, tagDataOffset + tag.size);

        const codecId = videoTagData[0] & 0x0f;
        const avcPacketType = videoTagData[1];

        // 虽然我们在预计算时跳过了非 NALU，但这里为了逻辑完整再次检查
        if (avcPacketType !== 1) {
          skippedCount++;
          continue;
        }

        // 获取预计算的元数据
        const meta = frameMetaMap.get(tag.index);
        // 如果没有 meta (理应不会发生)，则降级计算
        const cts = (videoTagData[2] << 16) | (videoTagData[3] << 8) | videoTagData[4];
        const pts = meta ? meta.pts : (tag.timestamp + cts) * 1000;
        const duration = meta ? meta.duration : 33333;

        let naluData = videoTagData.subarray(5);

        if (codecId === 12 && isAnnexBRef.current) {
          if (wasm.isAnnexBFormat(naluData)) {
            naluData = wasm.convertAnnexBToAVCC(naluData);
          }
        }

        const isKey = frameIndex === 0 || tag.isKeyframe;

        const chunk = new EncodedVideoChunk({
          type: isKey ? 'key' : 'delta',
          timestamp: pts,
          duration: duration,
          data: naluData
        });

        if (frameIndex === 0) {
          console.log(`Feed Frame 0: type=${chunk.type}, pts=${chunk.timestamp / 1000}ms, dur=${chunk.duration! / 1000}ms`);
        }

        console.log(`Feed Frame frameIndex=${frameIndex}`, chunk);
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
    // 立即开始渲染
    renderLoop();

    // 必须 await flush，确保所有缓冲的帧都已输出，
    // 否则 initDecoder 中的缩略图生成步骤会拿不到最后几帧。
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
      <div className={`gop-player-modal ${isVertical ? 'vertical-layout' : ''}`}>
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
            <button className="close-btn" onClick={onClose}>×</button>
          </div>
        </div>

        <div className="player-content-wrapper">
          <div className="player-main">
            {/* 主画布区域 */}
            <div className="canvas-container">
              {error ? (
                <div className="player-error">{error}</div>
              ) : (
                <canvas ref={canvasRef} />
              )}
              {isDecoding && (
                <div className="decoding-overlay">
                  <div className="spinner" />
                  <span>解码中...</span>
                </div>
              )}
            </div>
          </div>

          <div className="player-sidebar">
            {/* 帧缩略图画廊 */}
            {thumbnails.length > 0 && (
              <div className="frame-gallery">
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
                  {thumbnails.map((thumb, idx) => (
                    <div
                      key={thumb.tagIndex}
                      id={`thumb-${idx}`}
                      className={`frame-thumb ${selectedThumbnail === idx ? 'selected' : ''} ${thumb.isKeyframe ? 'keyframe' : ''}`}
                      onClick={() => handleThumbnailClick(thumb.tagIndex, idx)}
                      title={`Tag #${thumb.tagIndex} @ ${formatDuration(thumb.timestamp / 1000)}`}
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
                <button className={`control-btn ${isPlaying ? 'active' : ''}`} onClick={togglePlay}>
                  {isPlaying ? '⏸ 暂停' : '▶ 播放'}
                </button>

                {/* Next/Prev GOP Controls */}
                <div className="gop-nav-controls" style={{ display: 'flex', gap: '4px' }}>
                  <button className="control-btn" onClick={onPrevGop} disabled={!onPrevGop} title="上一个 GOP">
                    ⏮
                  </button>
                  <button className="control-btn" onClick={onNextGop} disabled={!onNextGop} title="下一个 GOP">
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
              <div className="frame-info">
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
