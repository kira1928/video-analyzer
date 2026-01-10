import { useEffect, useRef, useState, useCallback } from 'react';
import { AnalysisResult, Gop, TagSummary } from '../types';
import { getWasmModule } from '../utils/wasm';
import { formatDuration } from '../utils/format';
import { getCachedGop, setCachedGop, CachedFrame } from '../utils/gopCache';
import '../styles/GopPlayer.css';

interface GopPlayerProps {
  gop: Gop;
  fileData: Uint8Array;
  analysisResult: AnalysisResult;
  onClose: () => void;
  onTagSelect?: (tagIndex: number) => void; // 点击帧时选择对应的 Tag
  initialTagIndex?: number; // 初始选中的 Tag
}

interface FrameThumbnail {
  tagIndex: number;
  timestamp: number;
  isKeyframe: boolean;
  imageData: string; // base64 data URL
}

export function GopPlayer({
  gop,
  fileData,
  analysisResult,
  onClose,
  onTagSelect,
  initialTagIndex
}: GopPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [totalFrames, setTotalFrames] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [thumbnails, setThumbnails] = useState<FrameThumbnail[]>([]);
  const [selectedThumbnail, setSelectedThumbnail] = useState<number | null>(null);
  const [isDecoding, setIsDecoding] = useState(true);

  const decoderRef = useRef<VideoDecoder | null>(null);
  const frameQueueRef = useRef<VideoFrame[]>([]);
  const animationFrameRef = useRef<number | null>(null);
  const tagsRef = useRef<TagSummary[]>([]);
  const isAnnexBRef = useRef<boolean>(false);
  const initCalledRef = useRef<boolean>(false);
  const allFramesRef = useRef<{ tagIndex: number; frame: VideoFrame }[]>([]);

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
  const handleThumbnailClick = useCallback((tagIndex: number, index: number) => {
    setSelectedThumbnail(index);
    if (onTagSelect) {
      onTagSelect(tagIndex);
    }
  }, [onTagSelect]);

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

  // 初始化解码器和数据
  useEffect(() => {
    if (initCalledRef.current) {
      console.log("跳过重复初始化");
      return;
    }
    initCalledRef.current = true;

    tagsRef.current = gopVideoTags;
    setTotalFrames(gopVideoTags.length);

    if (gopVideoTags.length === 0) {
      setError("该 GOP 没有视频帧");
      setIsDecoding(false);
      return;
    }

    // 检查缓存
    const cached = getCachedGop(gop.index);
    if (cached) {
      console.log(`使用缓存的 GOP #${gop.index}, ${cached.frames.length} 帧`);
      const thumbs: FrameThumbnail[] = cached.frames.map(f => ({
        tagIndex: f.tagIndex,
        timestamp: f.timestamp,
        isKeyframe: f.isKeyframe,
        imageData: '' // 缓存的是 ImageBitmap，需要转换
      }));
      // TODO: 从 ImageBitmap 转换为 data URL
      setThumbnails(thumbs);
      setIsDecoding(false);
      return;
    }

    const initDecoder = async () => {
      try {
        if (!('VideoDecoder' in window)) {
          throw new Error("浏览器不支持 WebCodecs API");
        }

        const wasm = getWasmModule();
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

        console.log(`配置解码器: codec=${codec}, description=${description?.length ?? 0} bytes`);

        const collectedFrames: { tagIndex: number; frame: VideoFrame }[] = [];

        const decoder = new VideoDecoder({
          output: (frame) => {
            // 收集帧用于生成缩略图
            const tagIdx = gopVideoTags[collectedFrames.length]?.index ?? -1;
            collectedFrames.push({ tagIndex: tagIdx, frame: frame.clone() });
            frameQueueRef.current.push(frame);
          },
          error: (e) => {
            console.error("解码错误:", e);
            setError(`解码错误: ${e.message}`);
          }
        });

        const config = {
          codec: codec,
          description: description,
        };

        const support = await VideoDecoder.isConfigSupported(config);
        console.log(`配置支持检查: supported=${support.supported}`, support.config);

        if (!support.supported) {
          throw new Error(`不支持的视频配置: ${codec}`);
        }

        decoder.configure(config);
        decoderRef.current = decoder;

        // 解码所有帧
        await decodeGop(decoder, gopVideoTags, fileData, wasm);

        // 生成缩略图
        allFramesRef.current = collectedFrames;
        const thumbs: FrameThumbnail[] = [];
        for (let i = 0; i < collectedFrames.length; i++) {
          const { tagIndex, frame } = collectedFrames[i];
          const tag = gopVideoTags.find(t => t.index === tagIndex);
          thumbs.push(createThumbnail(frame, tagIndex, tag?.timestamp ?? 0, tag?.isKeyframe ?? false));
          frame.close(); // 释放克隆的帧
        }
        setThumbnails(thumbs);

        // 缓存到内存
        const cachedFrames: CachedFrame[] = thumbs.map(t => ({
          tagIndex: t.tagIndex,
          timestamp: t.timestamp,
          isKeyframe: t.isKeyframe,
          thumbnail: null, // 简化：只存元数据
          fullFrame: null
        }));
        setCachedGop(gop.index, {
          gopIndex: gop.index,
          frames: cachedFrames,
          decodedAt: Date.now()
        });

        // 如果有初始选中的 Tag，找到对应位置
        if (initialTagIndex !== undefined) {
          const idx = thumbs.findIndex(t => t.tagIndex === initialTagIndex);
          if (idx >= 0) {
            setSelectedThumbnail(idx);
          }
        }

        setIsDecoding(false);

      } catch (e) {
        setError(`初始化失败: ${e instanceof Error ? e.message : String(e)}`);
        setIsDecoding(false);
      }
    };

    initDecoder();

    return () => {
      if (decoderRef.current) {
        try {
          decoderRef.current.close();
        } catch { }
        decoderRef.current = null;
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      frameQueueRef.current.forEach(f => f.close());
      frameQueueRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gop, fileData, analysisResult]);

  // 解码 GOP
  const decodeGop = async (decoder: VideoDecoder, tags: TagSummary[], data: Uint8Array, wasm: any) => {
    let frameIndex = 0;
    let decodedCount = 0;
    let skippedCount = 0;

    console.log(`开始解码 GOP, 共 ${tags.length} 个视频 Tag`);

    for (const tag of tags) {
      if (!decoderRef.current || decoderRef.current.state === 'closed') break;

      try {
        const tagDataOffset = tag.offset + 11;
        const videoTagData = data.subarray(tagDataOffset, tagDataOffset + tag.size);

        const codecId = videoTagData[0] & 0x0f;
        const avcPacketType = videoTagData[1];
        const cts = (videoTagData[2] << 16) | (videoTagData[3] << 8) | videoTagData[4];
        const pts = (tag.timestamp + cts) * 1000;

        if (avcPacketType !== 1) {
          skippedCount++;
          continue;
        }

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
          data: naluData
        });

        if (frameIndex === 0) {
          console.log(`Feed Frame 0: type=${chunk.type}, pts=${chunk.timestamp}`);
        }

        decoder.decode(chunk);
        decodedCount++;
        frameIndex++;
      } catch (e) {
        console.error(`Frame ${frameIndex} decoding failed:`, e);
      }
    }

    console.log(`解码完成: ${decodedCount} 帧已解码, ${skippedCount} 帧已跳过`);
    console.log(`decoder.state: ${decoder.state}, decodeQueueSize: ${decoder.decodeQueueSize}`);

    // 立即开始渲染
    renderLoop();

    // 异步 flush
    decoder.flush().then(() => {
      console.log(`Flush 完成, 帧队列长度: ${frameQueueRef.current.length}`);
    }).catch((e) => {
      console.error('Flush 失败:', e);
    });
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
      <div className="gop-player-modal">
        <div className="player-header">
          <h3>GOP 预览: {formatDuration(gop.startTime)}</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

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

          {/* 帧缩略图画廊 */}
          {thumbnails.length > 0 && (
            <div className="frame-gallery">
              <div className="gallery-header">
                <span>帧画廊 ({thumbnails.length} 帧)</span>
              </div>
              <div className="gallery-scroll">
                {thumbnails.map((thumb, idx) => (
                  <div
                    key={thumb.tagIndex}
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
        </div>

        <div className="player-controls">
          <div className="frame-info">
            帧: {currentFrame} / {totalFrames}
          </div>
          {selectedThumbnail !== null && (
            <div className="selected-info">
              选中: Tag #{thumbnails[selectedThumbnail]?.tagIndex}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
