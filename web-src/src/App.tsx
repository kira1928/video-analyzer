import { useState, useEffect, useCallback, useMemo } from 'react';
import { AnalysisResult, TagSummary, Mp4BoxTree, Gop } from './types';
import { loadWasm, parseVideo, getMp4BoxTree, WasmStatus } from './utils/wasm';
import { formatBytes, formatDuration } from './utils/format';
import { clearCache, getCacheStats, isCacheEnabled, setCacheEnabled, CacheStats } from './utils/gopCache';
import { detectFileFormat, STREAMING_THRESHOLD, formatFileSize } from './utils/streamingReader';
import { clearAllCaches } from './utils/memoryDebug';
import { wasmWorker } from './workers/wasmWorkerManager';
import { TimelineChart } from './components/TimelineChart';
import { DetailModal } from './components/DetailModal';
import { GopPlayer } from './components/GopPlayer';
import { BoxTreeViewer } from './components/BoxTreeViewer';
import { DebugPanel } from './components/DebugPanel';
import { SegmentPanel } from './components/SegmentPanel';
import './styles/App.css';

function App() {
  // WASM 状态
  const [wasmStatus, setWasmStatus] = useState<WasmStatus>('loading');
  const [wasmMessage, setWasmMessage] = useState('正在加载 WASM...');

  // 文件数据
  const [fileData, setFileData] = useState<Uint8Array | null>(null);
  const [currentFile, setCurrentFile] = useState<File | null>(null);  // 用于大文件流式读取
  const [isStreamingMode, setIsStreamingMode] = useState(false);  // 是否使用流式解析模式
  const [forceStreaming, setForceStreaming] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('forceStreaming') === '1';
  });
  const [fileId, setFileId] = useState<string>('');
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<string>('');  // 解析进度提示
  const [analysisProgressPercent, setAnalysisProgressPercent] = useState<number>(0);  // 解析进度百分比
  const [isCancelling, setIsCancelling] = useState(false);  // 是否正在取消

  // UI 状态
  const [activeTab, setActiveTab] = useState<'gop' | 'tag'>('gop');
  const [selectedTagIndex, setSelectedTagIndex] = useState<number | null>(null);
  const [selectedTag, setSelectedTag] = useState<TagSummary | null>(null);

  const [playingGop, setPlayingGop] = useState<any | null>(null);
  const [initialTagForGop, setInitialTagForGop] = useState<number | undefined>(undefined);
  const [autoPlayNext, setAutoPlayNext] = useState(false);
  const [autoPlayOnNextGop, setAutoPlayOnNextGop] = useState(false);

  // Box 树状态（MP4 专用）
  const [boxTree, setBoxTree] = useState<Mp4BoxTree | null>(null);
  const [showBoxTree, setShowBoxTree] = useState(false);
  const [isBoxTreeLoading, setIsBoxTreeLoading] = useState(false);

  // Sample/Tag 列表分页状态
  const [tagPage, setTagPage] = useState(0);
  const [jumpToIndex, setJumpToIndex] = useState('');
  const TAGS_PER_PAGE = 100;

  // 流式模式专用状态（分页加载）
  const [totalSamples, setTotalSamples] = useState(0);
  const [totalGops, setTotalGops] = useState(0);
  const [loadedTags, setLoadedTags] = useState<Map<number, TagSummary>>(new Map());  // 已加载的 samples
  const [loadedGops, setLoadedGops] = useState<Gop[]>([]);  // 已加载的 GOPs
  const [isLoadingPage, setIsLoadingPage] = useState(false);  // 是否正在加载页面数据

  const gopsForPlayer = analysisResult
    ? (isStreamingMode ? loadedGops : analysisResult.gops)
    : [];
  const playingGopListIndex = playingGop
    ? gopsForPlayer.findIndex(g => g.index === playingGop.index)
    : -1;

  // Sample/Tag 列表筛选状态
  const [tagTypeFilter, setTagTypeFilter] = useState<'all' | 'video' | 'audio'>('all');
  const [seiOnly, setSeiOnly] = useState(false);
  const [spsPpsChangeOnly, setSpsPpsChangeOnly] = useState(false);

  // 筛选后的标签列表
  const filteredTags = useMemo(() => {
    if (!analysisResult) return [];
    return analysisResult.tags.filter(tag => {
      if (tagTypeFilter !== 'all' && tag.type !== tagTypeFilter) return false;
      if (seiOnly && !tag.hasSei) return false;
      if (spsPpsChangeOnly && !tag.isSpsPpsChange) return false;
      return true;
    });
  }, [analysisResult, tagTypeFilter, seiOnly, spsPpsChangeOnly]);

  // 缓存管理状态
  const [cacheEnabled, setCacheEnabledState] = useState(isCacheEnabled());
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [isClearing, setIsClearing] = useState(false);

  const handleNextGop = useCallback((autoPlay?: boolean) => {
    if (!playingGop || !analysisResult) return;
    const gopsSource = isStreamingMode ? loadedGops : analysisResult.gops;
    const idx = gopsSource.findIndex((g: any) => g.index === playingGop.index);
    if (idx !== -1 && idx < gopsSource.length - 1) {
      setAutoPlayOnNextGop(!!autoPlay);
      setPlayingGop(gopsSource[idx + 1]);
    }
  }, [analysisResult, isStreamingMode, loadedGops, playingGop]);

  const handlePrevGop = useCallback(() => {
    if (!playingGop || !analysisResult) return;
    const gopsSource = isStreamingMode ? loadedGops : analysisResult.gops;
    const idx = gopsSource.findIndex((g: any) => g.index === playingGop.index);
    if (idx > 0) {
      setPlayingGop(gopsSource[idx - 1]);
    }
  }, [analysisResult, isStreamingMode, loadedGops, playingGop]);

  useEffect(() => {
    if (!autoPlayOnNextGop || !playingGop) return;
    const timer = window.setTimeout(() => setAutoPlayOnNextGop(false), 0);
    return () => window.clearTimeout(timer);
  }, [autoPlayOnNextGop, playingGop]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('forceStreaming', forceStreaming ? '1' : '0');
  }, [forceStreaming]);

  // 加载 WASM（主线程 + Worker）
  useEffect(() => {
    const init = async () => {
      try {
        // 主线程 WASM（用于小文件和同步操作）
        await loadWasm({
          onStatusChange: (status, message) => {
            setWasmStatus(status);
            setWasmMessage(message || '');
          },
        });

        // Worker WASM（用于大文件流式解析）
        await wasmWorker.init((msg) => {
          console.log('Worker:', msg);
        });

      } catch (error) {
        console.error('WASM 初始化失败:', error);
      }
    };

    init();
  }, []);

  // 加载缓存统计
  useEffect(() => {
    getCacheStats().then(setCacheStats);
  }, []);

  // 刷新缓存统计
  const refreshCacheStats = useCallback(() => {
    getCacheStats().then(setCacheStats);
  }, []);

  // 流式模式：当切换到 Sample 列表时，加载当前页的 samples
  useEffect(() => {
    if (!isStreamingMode || !fileId || activeTab !== 'tag' || totalSamples === 0) return;

    // 计算需要加载的范围
    const start = tagPage * TAGS_PER_PAGE;
    const count = Math.min(TAGS_PER_PAGE, totalSamples - start);

    if (count <= 0) return;

    // 检查是否已加载
    let allLoaded = true;
    for (let i = start; i < start + count; i++) {
      if (!loadedTags.has(i)) {
        allLoaded = false;
        break;
      }
    }

    if (allLoaded) return;

    setIsLoadingPage(true);
    console.log(`[App] 加载 samples: start=${start}, count=${count}`);

    wasmWorker.getSamplesBatch(fileId, start, count)
      .then(samples => {
        console.log(`[App] 已加载 ${samples.length} 个 samples`);
        setLoadedTags(prev => {
          const newMap = new Map(prev);
          samples.forEach((sample: TagSummary, idx: number) => {
            newMap.set(start + idx, sample);
          });

          // 仅保留当前页附近的数据，避免 JS 端缓存过多 samples
          const keepStart = Math.max(0, start - TAGS_PER_PAGE);
          const keepEnd = Math.min(totalSamples, start + count + TAGS_PER_PAGE);
          for (const key of Array.from(newMap.keys())) {
            if (key < keepStart || key >= keepEnd) {
              newMap.delete(key);
            }
          }
          return newMap;
        });
      })
      .catch(err => {
        console.error('加载 samples 失败:', err);
      })
      .finally(() => {
        setIsLoadingPage(false);
      });
  }, [isStreamingMode, fileId, activeTab, tagPage, totalSamples, loadedTags, TAGS_PER_PAGE]);

  // 切换缓存开关
  const handleToggleCache = useCallback(() => {
    const newValue = !cacheEnabled;
    setCacheEnabledState(newValue);
    setCacheEnabled(newValue);
  }, [cacheEnabled]);

  // 清除缓存
  const handleClearCache = useCallback(async () => {
    if (!confirm('确定要清除所有缓存吗？包括帧缓存、音频缓存和 IndexedDB 数据。')) return;

    setIsClearing(true);
    try {
      // 清除 GOP 缓存
      await clearCache();
      // 清除所有存储（IndexedDB, OPFS, Cache Storage）
      await clearAllCaches();
      await refreshCacheStats();
      alert('所有缓存已清除');
    } catch (e) {
      alert('清除缓存失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setIsClearing(false);
    }
  }, [refreshCacheStats]);

  // 取消解析
  const handleCancelAnalysis = useCallback(() => {
    setIsCancelling(true);
    setAnalysisProgress('正在取消...');
    wasmWorker.terminate();
    // 重新初始化 Worker
    wasmWorker.init((msg) => {
      console.log('Worker:', msg);
    }).then(() => {
      setIsAnalyzing(false);
      setIsCancelling(false);
      setAnalysisProgress('');
    });
  }, []);

  // 处理文件上传
  const handleFile = useCallback(async (file: File) => {
    if (wasmStatus !== 'ready') {
      alert('WASM 尚未加载完成');
      return;
    }

    setIsAnalyzing(true);
    setIsCancelling(false);
    setAnalysisProgress('准备解析...');
    setSelectedTagIndex(null);
    setSelectedTag(null);
    setBoxTree(null);
    setShowBoxTree(false);
    setIsBoxTreeLoading(false);
    setTagPage(0);  // 重置分页
    setJumpToIndex('');
    setCurrentFile(file);

    const fid = `${file.name}-${file.size}-${file.lastModified}`;
    console.log(`[App] 生成 fileId: '${fid}' (name='${file.name}', size=${file.size}, lastModified=${file.lastModified})`);
    setFileId(fid);

    try {
      // 检测文件格式
      setAnalysisProgress('检测文件格式...');
      const format = await detectFileFormat(file);

      // 大文件使用流式解析（Worker 模式）
      const canStream = format === 'mp4' || format === 'flv';
      const useStreaming = canStream && (forceStreaming || file.size >= STREAMING_THRESHOLD);
      setIsStreamingMode(useStreaming);

      if (useStreaming) {
        // 使用 Worker 进行流式解析（不阻塞 UI）
        setAnalysisProgress(`流式解析 ${format.toUpperCase()} 文件 (${formatFileSize(file.size)})...`);
        console.log(`使用 Worker 流式解析模式 (文件大小: ${formatFileSize(file.size)}, 格式: ${format})`);

        // 强制让 UI 有时间渲染进度条
        await new Promise(r => setTimeout(r, 100));

        let metadata: any;  // 元数据（不包含全部 tags/gops）
        if (format === 'mp4') {
          metadata = await wasmWorker.parseMP4Streaming(file, fid, (msg, percent) => {
            console.log(`[App] 收到进度: ${msg}, 百分比: ${percent}`);
            setAnalysisProgress(msg);
            if (percent !== undefined) {
              setAnalysisProgressPercent(percent);
            }
          });
        } else {
          metadata = await wasmWorker.parseFLVStreaming(file, fid, (msg, percent) => {
            setAnalysisProgress(msg);
            if (percent !== undefined) {
              setAnalysisProgressPercent(percent);
            }
          });
        }

        console.log(`[App] 收到元数据:`, metadata);
        console.log(`[App] metadata.fileSize:`, metadata.fileSize);
        console.log(`[App] metadata.totalSamples:`, metadata.totalSamples);
        console.log(`[App] metadata.totalGops:`, metadata.totalGops);

        setAnalysisProgress(`解析完成！共 ${metadata.totalSamples?.toLocaleString() || '???'} 个 samples`);

        // 设置流式模式的总数
        setTotalSamples(metadata.totalSamples || 0);
        setTotalGops(metadata.totalGops || 0);
        setLoadedTags(new Map());  // 清空已加载的 tags
        setLoadedGops([]);  // 清空已加载的 GOPs

        // 构造一个临时的 AnalysisResult，只包含元数据，tags/gops 为空
          const mockResult: AnalysisResult = {
            format: metadata.format || 'mp4',
            fileSize: metadata.fileSize || 0,
            duration: metadata.duration || 0,
            videoTagCount: metadata.videoTagCount || 0,
            audioTagCount: metadata.audioTagCount || 0,
            hasVideo: (metadata.videoTagCount || 0) > 0,
            hasAudio: (metadata.audioTagCount || 0) > 0,
            tags: [],  // 空的，按需加载
            gops: [],  // 空的，按需加载
            videoTimeline: [],
            audioTimeline: [],
            scriptTagCount: 0,
            keyframeCount: metadata.keyframeCount || 0,
            anomalies: [],
            videoInitData: metadata.videoInitData,
            videoInitDataList: metadata.videoInitDataList,
            audioInitData: metadata.audioInitData,
            segments: metadata.segments || undefined,
          };

        console.log(`[App] mockResult:`, mockResult);

        setAnalysisResult(mockResult);
        setFileData(null);
        setIsAnalyzing(false);
        console.log('[E2E] 解析任务完成');

        console.log(`数据已缓存在 WASM 端，fileId: ${fid}`);
        console.log(`元数据: ${metadata.totalSamples} samples, ${metadata.totalGops} GOPs`);

        // 自动加载第一批 GOPs（如果有的话）
        if (metadata.totalGops > 0) {
          try {
            const firstBatchSize = Math.min(100, metadata.totalGops);
            const gops = await wasmWorker.getGopsBatch(fid, 0, firstBatchSize);
            console.log(`[App] 已加载前 ${gops.length} 个 GOPs`);
            setLoadedGops(gops);
            // 更新 mockResult 的 gops（仅用于兼容现有代码）
            setAnalysisResult(prev => prev ? { ...prev, gops } : prev);
          } catch (e) {
            console.error('加载 GOPs 失败:', e);
          }
        }
      } else {
        // 小文件：加载到内存解析
        setAnalysisProgress('读取文件...');
        setAnalysisProgressPercent(10);

        const buffer = await file.arrayBuffer();
        const data = new Uint8Array(buffer);
        setFileData(data);

        setAnalysisProgress('解析视频结构...');
        setAnalysisProgressPercent(30);

        const result = parseVideo(data);
        setAnalysisResult(result);

        setAnalysisProgressPercent(80);

        // 如果是 MP4 格式，解析 Box 树
        if (result.format?.toLowerCase() === 'mp4') {
          setAnalysisProgress('解析 Box 树...');
          try {
            const tree = getMp4BoxTree(data);
            setBoxTree(tree);
          } catch (e) {
            console.warn('无法解析 MP4 Box 树:', e);
          }
        }

        // 小文件模式解析完成
        setAnalysisProgress(`解析完成！共 ${result.tags.length.toLocaleString()} 个 ${result.format?.toLowerCase() === 'mp4' ? 'sample' : '标签'}`);
        setAnalysisProgressPercent(100);
        setIsAnalyzing(false);
        console.log('[E2E] 解析任务完成');
      }
    } catch (error) {
      alert(`分析失败: ${error instanceof Error ? error.message : String(error)}`);
      setIsAnalyzing(false);  // 只在错误时关闭
    }
    // 注意：成功时的 setIsAnalyzing(false) 在增量渲染完成后调用
  }, [wasmStatus]);

  // 拖放处理
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) {
      handleFile(e.dataTransfer.files[0]);
    }
  }, [handleFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  // 标签选择（自动翻页到对应页）
  const handleTagSelect = useCallback((tag: TagSummary) => {
    setSelectedTagIndex(tag.index);
    setSelectedTag(tag);
    // 切换到 Sample 列表并翻页到对应页
    setActiveTab('tag');

    // 需要根据 tag 在筛选后列表中的位置来计算页码
    // 如果 tag 不在当前筛选结果中，则使用原始索引
    const indexInFiltered = filteredTags.findIndex(t => t.index === tag.index);
    if (indexInFiltered >= 0) {
      setTagPage(Math.floor(indexInFiltered / TAGS_PER_PAGE));
    } else {
      // tag 不在筛选结果中，重置筛选并跳转到原始位置
      setTagTypeFilter('all');
      setSeiOnly(false);
      setSpsPpsChangeOnly(false);
      setTagPage(Math.floor(tag.index / TAGS_PER_PAGE));
    }
  }, [TAGS_PER_PAGE, filteredTags]);

  return (
    <div className="container">
      <header>
        <h1>🎬 Video Analyzer</h1>
        <div className="header-controls">
          {/* 缓存管理 */}
          <div className="cache-controls">
            <label className="cache-toggle" title={cacheEnabled ? '点击禁用缓存' : '点击启用缓存'}>
              <input
                type="checkbox"
                checked={cacheEnabled}
                onChange={handleToggleCache}
              />
              <span className="cache-toggle-label">
                {cacheEnabled ? '🔵 缓存已启用' : '⚪ 缓存已禁用'}
              </span>
            </label>
            {cacheStats && (
              <span className="cache-stats" title={`${cacheStats.indexedDBCount} 帧, ${cacheStats.audioBufferCount} 音频缓冲`}>
                ({cacheStats.estimatedSize})
              </span>
            )}
            <button
              className="cache-clear-btn"
              onClick={handleClearCache}
              disabled={isClearing}
              title="清除所有缓存的帧和缩略图"
            >
              {isClearing ? '⏳' : '🗑️'} 清除缓存
            </button>
          </div>
          <div className="streaming-controls">
            <label
              className="streaming-toggle"
              title="无论大小都使用流式解析（仅 MP4/FLV）"
            >
              <input
                type="checkbox"
                checked={forceStreaming}
                onChange={(e) => setForceStreaming(e.target.checked)}
              />
              <span className="streaming-toggle-label">
                {forceStreaming ? '🌊 强制流式解析' : '⛵ 仅大文件流式解析'}
              </span>
            </label>
          </div>
          {/* WASM 状态 */}
          <div className="status">
            <div className={`status-dot ${wasmStatus === 'ready' ? 'ready' : ''}`} />
            <span>{wasmMessage}</span>
          </div>
        </div>
      </header>

      {/* 文件上传区 */}
      <div
        className="upload-zone"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={() => document.getElementById('file-input')?.click()}
      >
        <h3>拖放视频文件到此处</h3>
        <p>或点击选择文件 (支持 FLV/MP4/TS 格式)</p>
        <input
          type="file"
          id="file-input"
          accept=".flv,.mp4,.ts,.mts,.m2ts,.m4v,.m4a"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
      </div>

      {/* 加载中 */}
      {isAnalyzing && (
        <div className="loading">
          <div className="spinner" />
          <p>{analysisProgress || '正在分析文件...'}</p>
          <div className="progress-bar">
            <div
              className="progress-bar-inner"
              style={{
                width: `${analysisProgressPercent}%`,
                animation: analysisProgressPercent > 0 ? 'none' : undefined
              }}
            />
          </div>
          <div className="progress-text">{isAnalyzing ? `${analysisProgressPercent}%` : ''}</div>
          <button
            className="btn btn-danger cancel-btn"
            onClick={handleCancelAnalysis}
            disabled={isCancelling}
          >
            {isCancelling ? '取消中...' : '取消解析'}
          </button>
        </div>
      )}

      {/* 分析结果 */}
      {analysisResult && (
        <>
          {/* 文件信息 */}
          <div className="file-info">
            <div className="file-info-grid">
              <InfoItem label="文件格式" value={analysisResult.format} />
              <InfoItem label="文件大小" value={formatBytes(Number(analysisResult.fileSize))} />
              <InfoItem label="时长" value={formatDuration(analysisResult.duration)} />
              <InfoItem label={`视频${analysisResult.format?.toLowerCase() === 'mp4' ? 'Sample' : '标签'}`} value={analysisResult.videoTagCount} />
              <InfoItem label={`音频${analysisResult.format?.toLowerCase() === 'mp4' ? 'Sample' : '标签'}`} value={analysisResult.audioTagCount} />
              <InfoItem label="关键帧" value={analysisResult.keyframeCount} />
              <InfoItem label="GOP 数量" value={isStreamingMode ? totalGops : analysisResult.gops.length} />
            </div>

            {/* MP4 Box 树按钮 */}
            {analysisResult.format?.toLowerCase() === 'mp4' && (
              <button
                className="box-tree-btn"
                onClick={async () => {
                  if (isStreamingMode) {
                    if (!fileId) {
                      alert('缺少文件 ID，无法加载 Box 树');
                      return;
                    }
                    if (isBoxTreeLoading) {
                      return;
                    }
                    setIsBoxTreeLoading(true);
                    try {
                      const tree = await wasmWorker.getMp4BoxTreeRoot(fileId, 2);
                      setBoxTree(tree);
                      setShowBoxTree(true);
                    } catch (e) {
                      alert('加载 Box 树失败：' + (e instanceof Error ? e.message : String(e)));
                    } finally {
                      setIsBoxTreeLoading(false);
                    }
                    return;
                  }

                  if (!boxTree || !fileData) {
                    alert('Box 树尚未加载完成');
                    return;
                  }
                  setShowBoxTree(true);
                }}
                disabled={isBoxTreeLoading}
                title={
                  isStreamingMode
                    ? '流式模式：按需加载 Box 树'
                    : (!boxTree || !fileData ? 'Box 树尚未加载完成' : undefined)
                }
              >
                {isBoxTreeLoading ? '正在加载 Box 树...' : '📦 查看 Box 结构'}
                {boxTree ? ` (${boxTree.totalCount} 个 Box)` : ''}
              </button>
            )}
          </div>

          {/* 视频分段面板 - 仅在需要分割时显示 */}
          <SegmentPanel
            result={analysisResult}
            fileData={fileData}
            currentFile={currentFile}
            fileId={fileId}
            isStreamingMode={isStreamingMode}
          />

          {/* 主内容区 */}
          <div className="main-content">
            <div>
              {/* 时间戳图表 - 暂时禁用以提升性能 */}
              {/* <TimelineChart
                tags={analysisResult.tags}
                onTagSelect={handleTagSelect}
              /> */}

              {/* 异常列表 */}
              {analysisResult.anomalies.length > 0 && (
                <div className="anomalies-container">
                  <h3>⚠️ 检测到的异常</h3>
                  {analysisResult.anomalies.map((a, i) => (
                    <div key={i} className={`anomaly-item ${a.severity}`}>
                      <span className="anomaly-icon">
                        {a.severity === 'error' ? '❌' : a.severity === 'warning' ? '⚠️' : 'ℹ️'}
                      </span>
                      <div className="anomaly-content">
                        <div className="anomaly-type">{a.type} @ {formatDuration(a.timestamp)}</div>
                        <div className="anomaly-desc">{a.description}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 标签/GOP 列表 */}
            <div className="tag-list-container">
              <div className="tag-list-header">
                <div className="tab-buttons">
                  <h3
                    className={activeTab === 'gop' ? 'active' : ''}
                    onClick={() => setActiveTab('gop')}
                  >
                    🎥 GOP 列表
                  </h3>
                  <h3
                    className={activeTab === 'tag' ? 'active' : ''}
                    onClick={() => setActiveTab('tag')}
                  >
                    📋 {analysisResult.format?.toLowerCase() === 'mp4' ? 'Sample' : '标签'}列表
                  </h3>
                </div>
                <span className="list-status">
                  {activeTab === 'gop'
                    ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span>共 {isStreamingMode ? totalGops.toLocaleString() : analysisResult.gops.length} 个 GOP {isStreamingMode && analysisResult.gops.length < totalGops ? `(已加载 ${analysisResult.gops.length})` : ''}</span>
                        <button
                          disabled={isStreamingMode || analysisResult.gops.length === 0}
                          onClick={() => {
                            if (isStreamingMode) {
                              alert('流式模式暂不支持自动播放 GOP（需要按需提取数据）');
                              return;
                            }
                            if (analysisResult.gops.length > 0) {
                              setPlayingGop(analysisResult.gops[0]);
                              setAutoPlayNext(true);
                            }
                          }}
                          style={{
                            padding: '4px 10px',
                            fontSize: '12px',
                            cursor: 'pointer',
                            background: 'var(--accent)',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px'
                          }}
                          title={isStreamingMode ? '流式模式暂不支持自动播放' : '播放全部 GOP'}
                        >
                          <span style={{ fontSize: '10px' }}>▶</span> 播放全部
                        </button>
                      </div>
                    )
                    : (
                      <div className="tag-list-controls">
                        <span>
                          {isStreamingMode
                            ? `共 ${totalSamples.toLocaleString()} 个`
                            : (tagTypeFilter !== 'all' || seiOnly
                              ? `筛选 ${filteredTags.length}/${analysisResult.tags.length}`
                              : `共 ${analysisResult.tags.length} 个`
                            )
                          }
                          {analysisResult.format?.toLowerCase() === 'mp4' ? 'Sample' : '标签'}
                          {isStreamingMode && isLoadingPage && ' (加载中...)'}
                        </span>
                        {/* 分页控件 */}
                        <div className="pagination">
                          <button
                            onClick={() => setTagPage(0)}
                            disabled={tagPage === 0}
                            title="第一页"
                          >⏮</button>
                          <button
                            onClick={() => setTagPage(p => Math.max(0, p - 1))}
                            disabled={tagPage === 0}
                            title="上一页"
                          >◀</button>
                          <span className="page-info">
                            {(() => {
                              const total = isStreamingMode ? totalSamples : filteredTags.length;
                              if (total === 0) return '0-0';
                              const start = tagPage * TAGS_PER_PAGE + 1;
                              const end = Math.min((tagPage + 1) * TAGS_PER_PAGE, total);
                              return `${start.toLocaleString()}-${end.toLocaleString()}`;
                            })()}
                          </span>
                          <button
                            onClick={() => {
                              const total = isStreamingMode ? totalSamples : filteredTags.length;
                              setTagPage(p => Math.min(Math.floor((total - 1) / TAGS_PER_PAGE), p + 1));
                            }}
                            disabled={(tagPage + 1) * TAGS_PER_PAGE >= (isStreamingMode ? totalSamples : filteredTags.length)}
                            title="下一页"
                          >▶</button>
                          <button
                            onClick={() => {
                              const total = isStreamingMode ? totalSamples : filteredTags.length;
                              setTagPage(Math.floor((total - 1) / TAGS_PER_PAGE));
                            }}
                            disabled={(tagPage + 1) * TAGS_PER_PAGE >= (isStreamingMode ? totalSamples : filteredTags.length)}
                            title="最后一页"
                          >⏭</button>
                        </div>
                        {/* 跳转 */}
                        <div className="jump-to">
                          <input
                            type="number"
                            placeholder="跳转到..."
                            value={jumpToIndex}
                            onChange={e => setJumpToIndex(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                const idx = parseInt(jumpToIndex);
                                const total = isStreamingMode ? totalSamples : analysisResult.tags.length;
                                if (!isNaN(idx) && idx >= 0 && idx < total) {
                                  setTagPage(Math.floor(idx / TAGS_PER_PAGE));
                                  setJumpToIndex('');
                                }
                              }
                            }}
                            min={0}
                            max={(isStreamingMode ? totalSamples : analysisResult.tags.length) - 1}
                          />
                          <button
                            onClick={() => {
                              const idx = parseInt(jumpToIndex);
                              const total = isStreamingMode ? totalSamples : analysisResult.tags.length;
                              if (!isNaN(idx) && idx >= 0 && idx < total) {
                                setTagPage(Math.floor(idx / TAGS_PER_PAGE));
                                setJumpToIndex('');
                              }
                            }}
                          >GO</button>
                        </div>
                        {/* 筛选控件 */}
                        <div className="filter-controls">
                          <select
                            value={tagTypeFilter}
                            onChange={e => {
                              setTagTypeFilter(e.target.value as any);
                              setTagPage(0);
                            }}
                            title="类型筛选"
                          >
                            <option value="all">全部类型</option>
                            <option value="video">仅视频</option>
                            <option value="audio">仅音频</option>
                          </select>
                          <label className="sei-filter" title="仅显示包含 SEI NALU 的 Sample">
                            <input
                              type="checkbox"
                              checked={seiOnly}
                              onChange={e => {
                                setSeiOnly(e.target.checked);
                                setTagPage(0);
                              }}
                            />
                            <span>🏷️ 仅 SEI</span>
                          </label>
                          <label className="sei-filter" title="仅显示 SPS/PPS 发生变化的 Sample（编码参数变化）">
                            <input
                              type="checkbox"
                              checked={spsPpsChangeOnly}
                              onChange={e => {
                                setSpsPpsChangeOnly(e.target.checked);
                                setTagPage(0);
                              }}
                            />
                            <span>🔄 SPS/PPS变更</span>
                          </label>
                        </div>
                      </div>
                    )
                  }
                </span>
              </div>

              <div className="tag-list">
                {activeTab === 'gop' ? (
                  (() => {
                    const gopsToRender = isStreamingMode ? loadedGops : analysisResult.gops;
                    if (gopsToRender.length === 0) {
                      return (
                        <div className="empty-message">
                          {isStreamingMode && totalGops > 0 ? '尚未加载 GOP 数据' : '暂无 GOP 数据'}
                        </div>
                      );
                    }

                    return gopsToRender.map(gop => {
                      // 计算实际视频帧数：流式模式用 frameCount，否则从 tags 计算
                      const actualFrameCount = isStreamingMode
                        ? gop.frameCount
                        : analysisResult.tags.filter(
                          t => t.index >= gop.startIndex && t.index <= gop.endIndex && t.type === 'video' && !t.isSeqHeader
                        ).length;
                      return (
                        <div key={gop.index} className="gop-item">
                          <div className="gop-content">
                            <div className="gop-title">GOP #{gop.index + 1}</div>
                            <div className="gop-info">
                              <span className="gop-time" title="视频中的开始时间">📍 {formatDuration(gop.startTime)}</span>
                              <span className="gop-meta">|</span>
                              <span className="gop-frames" title="帧数">{actualFrameCount} 帧</span>
                              <span className="gop-meta">|</span>
                              <span className="gop-duration" title="GOP 时长">⏱️ {gop.duration.toFixed(2)}s</span>
                            </div>
                          </div>
                          <div className="gop-actions">
                            <button
                              className="gop-btn"
                              onClick={() => setPlayingGop(gop)}
                              title="播放 GOP"
                            >
                              ▶️
                            </button>
                            <button
                              className="gop-btn"
                              onClick={async () => {
                                if (isStreamingMode) {
                                  // 流式模式：从 WASM 缓存获取 tag 信息
                                  try {
                                    const tag = await wasmWorker.getSample(fileId, gop.startIndex);
                                    if (tag) {
                                      setSelectedTagIndex(tag.index);
                                      setSelectedTag(tag);
                                    }
                                  } catch (e) {
                                    alert('⚠️ 获取详情失败\n\n' + (e instanceof Error ? e.message : String(e)));
                                  }
                                  return;
                                }
                                const firstTag = analysisResult.tags.find(t => t.index === gop.startIndex);
                                if (firstTag) {
                                  setSelectedTagIndex(firstTag.index);
                                  setSelectedTag(firstTag);
                                }
                              }}
                              title="查看详情"
                            >
                              🔍
                            </button>
                          </div>
                        </div>
                      )
                    })
                  })()
                ) : (
                  // Sample/Tag 列表
                  isStreamingMode ? (
                    // 流式模式：从 loadedTags 获取数据
                    isLoadingPage ? (
                      <div className="loading-message">正在加载数据...</div>
                    ) : (
                      (() => {
                        const start = tagPage * TAGS_PER_PAGE;
                        const end = Math.min(start + TAGS_PER_PAGE, totalSamples);
                        const tagsToRender: TagSummary[] = [];
                        for (let i = start; i < end; i++) {
                          const tag = loadedTags.get(i);
                          if (tag) tagsToRender.push(tag);
                        }
                        if (tagsToRender.length === 0) {
                          return <div className="empty-message">数据尚未加载</div>;
                        }
                        return tagsToRender.map(tag => (
                          <div
                            key={tag.index}
                            className={`tag-item ${tag.type} ${tag.isKeyframe ? 'keyframe' : ''} ${tag.hasSei ? 'has-sei' : ''}`}
                            onClick={() => handleTagSelect(tag)}
                          >
                            <span className="tag-index">#{tag.index}</span>
                            <span className="tag-type">
                              {tag.mp4Info
                                ? `Track ${tag.mp4Info.trackId} #${tag.mp4Info.sampleIndex} (${tag.description || tag.type})`
                                : (tag.description || tag.type)
                              }
                            </span>
                            <span className="tag-timestamp" title="视频中的时间戳">📍 {formatDuration(tag.timestamp / 1000)}</span>
                            <span className="tag-size">{formatBytes(tag.size)}</span>
                            {!tag.description && tag.isKeyframe && <span className="tag-badge">KF</span>}
                            {!tag.description && tag.isSeqHeader && <span className="tag-badge seq">SH</span>}
                            {tag.hasSei && <span className="tag-badge sei" title="包含 SEI NALU">SEI</span>}
                            {tag.isSpsPpsChange && <span className="tag-badge sps-pps" title="SPS/PPS 发生变化">SPS/PPS</span>}
                          </div>
                        ));
                      })()
                    )
                  ) : (
                    // 非流式模式：使用 filteredTags
                    filteredTags.length === 0 ? (
                      <div className="empty-message">没有符合筛选条件的 Sample</div>
                    ) : (
                      filteredTags
                        .slice(tagPage * TAGS_PER_PAGE, (tagPage + 1) * TAGS_PER_PAGE)
                        .map(tag => (
                          <div
                            key={tag.index}
                            className={`tag-item ${tag.type} ${tag.isKeyframe ? 'keyframe' : ''} ${tag.hasSei ? 'has-sei' : ''}`}
                            onClick={() => handleTagSelect(tag)}
                          >
                            <span className="tag-index">#{tag.index}</span>
                            <span className="tag-type">
                              {tag.mp4Info
                                ? `Track ${tag.mp4Info.trackId} #${tag.mp4Info.sampleIndex} (${tag.description || tag.type})`
                                : (tag.description || tag.type)
                              }
                            </span>
                            <span className="tag-timestamp" title="视频中的时间戳">📍 {formatDuration(tag.timestamp / 1000)}</span>
                            <span className="tag-size">{formatBytes(tag.size)}</span>
                            {!tag.description && tag.isKeyframe && <span className="tag-badge">KF</span>}
                            {!tag.description && tag.isSeqHeader && <span className="tag-badge seq">SH</span>}
                            {tag.hasSei && <span className="tag-badge sei" title="包含 SEI NALU">SEI</span>}
                            {tag.isSpsPpsChange && <span className="tag-badge sps-pps" title="SPS/PPS 发生变化">SPS/PPS</span>}
                          </div>
                        ))
                    )
                  )
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* GOP 播放器 */}
      {playingGop && analysisResult && (
        <GopPlayer
          fileId={fileId}
          gop={playingGop}
          gops={gopsForPlayer}
          currentGopListIndex={playingGopListIndex >= 0 ? playingGopListIndex : undefined}
          fileData={fileData}
          analysisResult={analysisResult}
          autoPlayNext={autoPlayNext}
          onAutoPlayChange={setAutoPlayNext}
          onNextGop={handleNextGop}
          onPrevGop={handlePrevGop}
          autoPlayStart={autoPlayOnNextGop}
          isStreamingMode={isStreamingMode}
          onClose={() => {
            setPlayingGop(null);
            setInitialTagForGop(undefined);
            setAutoPlayNext(false);
            setAutoPlayOnNextGop(false);
          }}
          onTagSelect={(tagIndex) => {
            // 不关闭播放器，直接打开详情遮罩
            // setPlayingGop(null); 
            setInitialTagForGop(undefined);
            setSelectedTagIndex(tagIndex);
            const tagFromState = isStreamingMode ? loadedTags.get(tagIndex) : analysisResult.tags[tagIndex];
            setSelectedTag(tagFromState ?? null);
          }}
          initialTagIndex={initialTagForGop}
        />
      )}

      {/* 详情弹窗 (Z-Index likely higher, renders on top) */}
      {selectedTagIndex !== null && analysisResult && (fileData || currentFile) && (
        <DetailModal
          fileId={fileId}
          result={analysisResult}
          tagIndex={selectedTagIndex}
          tagSummary={selectedTag ?? undefined}
          fileData={fileData}
          currentFile={currentFile ?? undefined}
          isStreamingMode={isStreamingMode}
          onClose={() => {
            setSelectedTagIndex(null);
            setSelectedTag(null);
          }}
          onPreviewFrame={(gopIndex, tagIdx) => {
            // 找到对应的 GOP 并打开播放器 (如果已打开则保持)
            const gop = (isStreamingMode ? loadedGops : analysisResult.gops)[gopIndex];
            if (gop) {
              setSelectedTagIndex(null); // 关闭详情弹窗
              setInitialTagForGop(tagIdx); // 设置跳转目标
              setPlayingGop(gop); // 确保播放器显示
            }
          }}
        />
      )}

      {/* Box 树查看器 (MP4 专用) */}
      {showBoxTree && boxTree && (fileData || isStreamingMode) && (
        <BoxTreeViewer
          boxTree={boxTree}
          fileData={fileData ?? undefined}
          isStreamingMode={isStreamingMode}
          fileId={fileId}
          onClose={() => setShowBoxTree(false)}
        />
      )}

      {/* 调试面板 */}
      <DebugPanel
        currentFileSize={currentFile?.size}
        isStreamingMode={isStreamingMode}
        fileDataSize={fileData?.length}
        onCacheCleared={refreshCacheStats}
      />
    </div>
  );
}

// 信息项组件
function InfoItem({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="info-item">
      <label>{label}</label>
      <div className="value">{value}</div>
    </div>
  );
}

export default App;
