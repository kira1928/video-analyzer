import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { AnalysisResult, Gop, TagSummary } from '../types';
import { getWasmModule } from '../utils/wasm';
import { formatDuration } from '../utils/format';
import { saveFrame, loadFrame, loadCachedFrame, saveAudioBuffer, loadAudioBuffer } from '../utils/gopCache';
import { wasmWorker } from '../workers/wasmWorkerManager';
import '../styles/GopPlayer.css';

interface GopPlayerProps {
  fileId: string;
  gop: Gop;
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

  useEffect(() => {
    if (autoPlayStart) {
      autoPlayStartRef.current = true;
    }
  }, [autoPlayStart]);

  // 自动滚动到选中的帧
  useEffect(() => {
    if (selectedThumbnail !== null && galleryRef.current) {
      const el = document.getElementById(`thumb-${selectedThumbnail}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    }
  }, [selectedThumbnail]);

  // 加载当前 GOP 的 Tag 列表（流式模式从 WASM 缓存拉取）
  // 注意：依赖数组只使用稳定的原始类型（字符串、数字、布尔），避免对象引用变化导致无限循环
  useEffect(() => {
    let cancelled = false;

    const loadGopTags = async () => {
      setIsLoadingGopTags(true);
      setError(null);
      setIsDecoding(true);
      setThumbnails([]);
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
          // 非流式模式：从 analysisResult.tags 中筛选当前 GOP 的 tags
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
        }
      }
    };

    loadGopTags();

    return () => {
      cancelled = true;
    };
    // 重要：只依赖稳定的属性，不依赖 analysisResult.tags 数组本身（引用会变化）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, gop.startIndex, gop.endIndex, gop.index, isStreamingMode]);



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

    const thumb = thumbnails[index];
    if (thumb) {
      drawThumbnailToCanvas(thumb, tagIndex);
    }

    try {
      // 尝试从缓存加载高画质帧
      const blob = await loadFrame(fileId, tagIndex);
      if (blob) {
        drawBlobToCanvas(blob, tagIndex);
      }
    } catch (e) {
      console.error("加载缓存帧失败:", e);
    }
  }, [fileId, thumbnails, drawBlobToCanvas, drawThumbnailToCanvas]);


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
          setTimeout(() => onNextGop(true), 100);
        }
        return;
      }

      const thumb = thumbnails[currentIndex];
      // 2. 设置选中状态 & 绘制
      setSelectedThumbnail(currentIndex);
      setCurrentFrame(currentIndex + 1);

      drawThumbnailToCanvas(thumb, thumb.tagIndex);

      try {
        const blob = await loadFrame(fileId, thumb.tagIndex);
        if (blob) {
          drawBlobToCanvas(blob, thumb.tagIndex);
        }
      } catch (e) {
        console.error(e);
      }

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
  }, [isPlaying, thumbnails, fileId, drawBlobToCanvas, drawThumbnailToCanvas]); // selectedThumbnail 只在初始读取，循环内自己维护 currentIndex

  // 初始化解码器和数据
  useEffect(() => {
    if (isLoadingGopTags) {
      return;
    }

    const controller = new AbortController();
    const signal = controller.signal;

    // 重置状态
    setIsPlaying(false);
    setThumbnails([]);
    setIsFrameHiResReady(false);
    currentDisplayTagRef.current = null;
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
        // 注意：大文件流式模式下跳过缓存检查（避免为每个帧查询 IndexedDB）
        // GOP 通常只有几十帧，这里的缓存检查是可行的
        if (!isStreamingMode && gopVideoTags.length <= 300) {
          try {
            const { loadCachedFramesBatch } = await import('../utils/gopCache');
            const cachedFrames = await loadCachedFramesBatch(fileId, gopVideoTags.map(t => t.index));

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
                // 显示第一帧，但不自动播放（等待用户点击播放按钮）
                setTimeout(() => handleThumbnailClick(loadedThumbs[0].tagIndex, 0), 50);
              }
            }
          } catch (e) {
            console.warn("读取缓存失败:", e);
          }
        }

        if (!skipVideoDecode) {
          // 清除之前的状态引用
          isAnnexBRef.current = false;

          let codec = 'avc1.64001f';
          let description: Uint8Array | undefined;

          // 检查文件格式，决定如何获取解码配置
          const isMP4OrTS = formatLower === 'mp4' || formatLower === 'ts';

          if (!fileData && !isMP4OrTS) {
            throw new Error('流式模式暂不支持 FLV GOP 预览');
          }

          if (isMP4OrTS) {
            // MP4/TS 格式：使用 videoInitData (avcC/hvcC)
            // 检查是否有多个 sample description（多个 avcC/hvcC 配置）
            const firstVideoTag = gopVideoTags[0];
            const sampleDescIndex = firstVideoTag?.mp4Info?.sampleDescIndex ?? 1; // 默认为 1

            let initData: Uint8Array | undefined;

            // 尝试从 videoInitDataList 获取对应配置
            if (analysisResult.videoInitDataList &&
              analysisResult.videoInitDataList.length >= sampleDescIndex &&
              sampleDescIndex >= 1) {
              const configData = analysisResult.videoInitDataList[sampleDescIndex - 1];
              if (configData && configData.length > 0) {
                initData = new Uint8Array(configData);
                console.log(`MP4: 使用 sample_desc_index=${sampleDescIndex} 的配置 (${initData.length} bytes)`);
              }
            }

            // 回退到默认的 videoInitData
            if (!initData) {
              if (!analysisResult.videoInitData || analysisResult.videoInitData.length === 0) {
                throw new Error("MP4/TS 文件缺少视频初始化数据 (videoInitData)");
              }
              initData = new Uint8Array(analysisResult.videoInitData);
              console.log(`MP4: 使用默认 videoInitData (${initData.length} bytes)`);
            }

            description = initData;

            // 从第一个视频 tag 判断编码类型
            const codecId = firstVideoTag?.codecId;
            const isHEVC = codecId === 12;

            if (isHEVC) {
              // HEVC
              try {
                codec = wasm.generateHEVCCodecString(initData, "raw", "concat");
                console.log(`MP4 HEVC: 使用 hvcC, Codec String: ${codec}`);
              } catch (e) {
                console.warn("HEVC codec string 生成失败:", e);
                codec = 'hvc1.1.6.L93.B0';
              }
            } else {
              // H.264
              if (initData.length >= 4 && initData[0] === 0x01) {
                // 从 avcC 解析 profile/level
                const profile = initData[1];
                const compat = initData[2];
                const level = initData[3];
                codec = `avc1.${profile.toString(16).padStart(2, '0')}${compat.toString(16).padStart(2, '0')}${level.toString(16).padStart(2, '0')}`;
                console.log(`MP4 AVC: 从 avcC 解析 codec=${codec}`);
              } else {
                codec = 'avc1.64001f';  // 默认 High Profile
                console.log(`MP4 AVC: 使用默认 codec=${codec}`);
              }
            }
          }
          else {
            // FLV 格式：从 Sequence Header 获取配置
            // 注意：到达这里时 fileData 必定不为 null（前面已检查过）
            const seqHeaderTag = analysisResult.tags.find(t => t.type === 'video' && t.isSeqHeader);
            if (!seqHeaderTag) {
              throw new Error("未找到视频 Sequence Header");
            }

            const seqHeaderOffset = seqHeaderTag.offset + 11;
            const seqHeaderData = fileData!.subarray(seqHeaderOffset, seqHeaderOffset + seqHeaderTag.size);
            const codecId = seqHeaderData[0] & 0x0f;
            const configData = seqHeaderData.subarray(5);

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
              // 每次 output 一个 frame，我们立即生成缩略图并缓存

              const frameIdx = thumbnailsRef.current.length;
              if (frameIdx === 0) {
                const isVert = frame.displayHeight > frame.displayWidth;
                console.log(`Decoder: First frame size ${frame.displayWidth}x${frame.displayHeight}. Vertical? ${isVert}`, frame);
                setIsVertical(isVert);
              }
              const tagIdx = gopVideoTags[frameIdx]?.index ?? -1;
              const tag = gopVideoTags[frameIdx];
              const shouldRenderHiResNow = currentDisplayTagRef.current === tagIdx;

              // 1. 同步生成缩略图 (轻量 Canvas 操作)
              // 不再存储 VideoFrame，极大降低显存压力
              const thumb = createThumbnail(frame, tagIdx, tag?.timestamp ?? 0, tag?.isKeyframe ?? false);
              thumbnailsRef.current.push(thumb);

              if (shouldRenderHiResNow) {
                drawVideoFrameToCanvas(frame, tagIdx);
              }

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
                  if (!blob) return;
                  saveFrame(fileId, tagIdx, blob, thumb.imageData).catch(console.error);
                  if (!shouldRenderHiResNow && currentDisplayTagRef.current === tagIdx) {
                    drawBlobToCanvas(blob, tagIdx);
                  }
                }, 'image/jpeg', 0.8);
              }

              // 缩略图与缓存生成完成后释放帧资源
              frame.close();

              if (frameIdx % 15 === 0) {
                console.log(`Frame ${frameIdx} output.`);
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
          const sampleProvider = (!fileData && isStreamingMode)
            ? async (tag: TagSummary) => wasmWorker.readSampleData(fileId, tag.index)
            : undefined;
          await decodeGop(decoder, gopVideoTags, fileData, wasm, signal, sampleProvider);
        }

        // === 音频解码逻辑 (始终尝试解码) ===
        if (fileData && gopAudioTags.length > 0 && 'AudioDecoder' in window) {
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
            setCurrentFrame(idx + 1);
            drawThumbnailToCanvas(thumbnailsRef.current[idx], thumbnailsRef.current[idx].tagIndex);
          }
        } else if (thumbnailsRef.current.length > 0) {
          // 显示第一帧，但不自动播放（等待用户点击播放按钮）
          setSelectedThumbnail(0);
          setCurrentFrame(1);
          drawThumbnailToCanvas(thumbnailsRef.current[0], thumbnailsRef.current[0].tagIndex);
        }

        if (autoPlayStartRef.current && thumbnailsRef.current.length > 0) {
          autoPlayStartRef.current = false;
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
    // 使用 gopVideoTags 和 gopAudioTags 的长度作为依赖，避免数组引用变化导致无限循环
    // 重要：不依赖 analysisResult 对象本身，只依赖其内部的稳定属性
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    drawBlobToCanvas,
    drawThumbnailToCanvas,
    fileData,
    fileId,
    formatLower,
    gopAudioTags.length,  // 只依赖长度，避免对象引用变化
    gopVideoTags.length,  // 只依赖长度，避免对象引用变化
    handleThumbnailClick,
    initialTagIndex,
    isLoadingGopTags,
    isStreamingMode,
    gop.index  // 添加 gop.index 确保 GOP 切换时重新初始化
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
          await new Promise(r => setTimeout(r, 10));
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
              {!error && !isFrameHiResReady && !isPlaying && (
                <div className="decoding-overlay">
                  <div className="spinner" />
                  <span>{isLoadingGopTags ? '加载 GOP 数据...' : '解码中'}</span>
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
