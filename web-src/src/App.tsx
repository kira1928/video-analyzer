import { useState, useEffect, useCallback } from 'react';
import { AnalysisResult, TagSummary } from './types';
import { loadWasm, parseFLV, WasmStatus } from './utils/wasm';
import { formatBytes, formatDuration } from './utils/format';
import { TimelineChart } from './components/TimelineChart';
import { DetailModal } from './components/DetailModal';
import { GopPlayer } from './components/GopPlayer';
import './styles/App.css';

function App() {
  // WASM 状态
  const [wasmStatus, setWasmStatus] = useState<WasmStatus>('loading');
  const [wasmMessage, setWasmMessage] = useState('正在加载 WASM...');

  // 文件数据
  const [fileData, setFileData] = useState<Uint8Array | null>(null);
  const [fileId, setFileId] = useState<string>('');
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  // UI 状态
  const [activeTab, setActiveTab] = useState<'gop' | 'tag'>('gop');
  const [selectedTagIndex, setSelectedTagIndex] = useState<number | null>(null);
  const [playingGop, setPlayingGop] = useState<any | null>(null);
  const [initialTagForGop, setInitialTagForGop] = useState<number | undefined>(undefined);
  const [autoPlayNext, setAutoPlayNext] = useState(false);

  const handleNextGop = useCallback(() => {
    if (!playingGop || !analysisResult) return;
    const idx = analysisResult.gops.findIndex((g: any) => g.index === playingGop.index);
    if (idx !== -1 && idx < analysisResult.gops.length - 1) {
      setPlayingGop(analysisResult.gops[idx + 1]);
    }
  }, [playingGop, analysisResult]);

  const handlePrevGop = useCallback(() => {
    if (!playingGop || !analysisResult) return;
    const idx = analysisResult.gops.findIndex((g: any) => g.index === playingGop.index);
    if (idx > 0) {
      setPlayingGop(analysisResult.gops[idx - 1]);
    }
  }, [playingGop, analysisResult]);

  // 加载 WASM
  useEffect(() => {
    loadWasm({
      onStatusChange: (status, message) => {
        setWasmStatus(status);
        setWasmMessage(message || '');
      },
    }).catch(console.error);
  }, []);

  // 处理文件上传
  const handleFile = useCallback(async (file: File) => {
    if (wasmStatus !== 'ready') {
      alert('WASM 尚未加载完成');
      return;
    }

    setIsAnalyzing(true);
    setSelectedTagIndex(null);

    try {
      const buffer = await file.arrayBuffer();
      const data = new Uint8Array(buffer);
      setFileData(data);
      const fid = `${file.name}-${file.size}-${file.lastModified}`;
      setFileId(fid);

      const result = parseFLV(data);
      setAnalysisResult(result);
    } catch (error) {
      alert(`分析失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsAnalyzing(false);
    }
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

  // 标签选择
  const handleTagSelect = useCallback((tag: TagSummary) => {
    setSelectedTagIndex(tag.index);
  }, []);

  return (
    <div className="container">
      <header>
        <h1>🎬 Video Analyzer</h1>
        <div className="status">
          <div className={`status-dot ${wasmStatus === 'ready' ? 'ready' : ''}`} />
          <span>{wasmMessage}</span>
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
        <p>或点击选择文件 (支持 FLV 格式)</p>
        <input
          type="file"
          id="file-input"
          accept=".flv"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
      </div>

      {/* 加载中 */}
      {isAnalyzing && (
        <div className="loading">
          <div className="spinner" />
          <p>正在分析文件...</p>
        </div>
      )}

      {/* 分析结果 */}
      {analysisResult && (
        <>
          {/* 文件信息 */}
          <div className="file-info">
            <div className="file-info-grid">
              <InfoItem label="文件大小" value={formatBytes(Number(analysisResult.fileSize))} />
              <InfoItem label="时长" value={formatDuration(analysisResult.duration)} />
              <InfoItem label="视频标签" value={analysisResult.videoTagCount} />
              <InfoItem label="音频标签" value={analysisResult.audioTagCount} />
              <InfoItem label="关键帧" value={analysisResult.keyframeCount} />
              <InfoItem label="GOP 数量" value={analysisResult.gops.length} />
            </div>
          </div>

          {/* 主内容区 */}
          <div className="main-content">
            <div>
              {/* 时间戳图表 */}
              <TimelineChart
                tags={analysisResult.tags}
                onTagSelect={handleTagSelect}
              />

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
                    📋 标签列表
                  </h3>
                </div>
                <span className="list-status">
                  {activeTab === 'gop'
                    ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span>共 {analysisResult.gops.length} 个 GOP</span>
                        <button
                          onClick={() => {
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
                        >
                          <span style={{ fontSize: '10px' }}>▶</span> 播放全部
                        </button>
                      </div>
                    )
                    : `共 ${analysisResult.tags.length} 个标签`
                  }
                </span>
              </div>

              <div className="tag-list">
                {activeTab === 'gop' ? (
                  analysisResult.gops.map(gop => {
                    // 计算实际视频帧数（排除 Sequence Header）
                    const actualFrameCount = analysisResult.tags.filter(
                      t => t.index >= gop.startIndex && t.index <= gop.endIndex && t.type === 'video' && !t.isSeqHeader
                    ).length;
                    return (
                      <div key={gop.index} className="gop-item">
                        <div className="gop-content">
                          <div className="gop-title">GOP #{gop.index + 1}</div>
                          <div className="gop-info">
                            {formatDuration(gop.startTime)} ({actualFrameCount} 帧, {gop.duration.toFixed(2)}s)
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
                            onClick={() => {
                              const firstTag = analysisResult.tags.find(t => t.index === gop.startIndex);
                              if (firstTag) {
                                setSelectedTagIndex(firstTag.index);
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
                ) : (
                  analysisResult.tags.slice(0, 500).map(tag => (
                    <div
                      key={tag.index}
                      className={`tag-item ${tag.type} ${tag.isKeyframe ? 'keyframe' : ''}`}
                      onClick={() => handleTagSelect(tag)}
                    >
                      <span className="tag-type">{tag.type}</span>
                      <span className="tag-timestamp">{formatDuration(tag.timestamp / 1000)}</span>
                      <span className="tag-size">{formatBytes(tag.size)}</span>
                      {tag.isKeyframe && <span className="tag-badge">KF</span>}
                      {tag.isSeqHeader && <span className="tag-badge seq">SH</span>}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* GOP 播放器 */}
      {playingGop && analysisResult && fileData && (
        <GopPlayer
          fileId={fileId}
          gop={playingGop}
          fileData={fileData}
          analysisResult={analysisResult}
          autoPlayNext={autoPlayNext}
          onAutoPlayChange={setAutoPlayNext}
          onNextGop={handleNextGop}
          onPrevGop={handlePrevGop}
          onClose={() => {
            setPlayingGop(null);
            setInitialTagForGop(undefined);
            setAutoPlayNext(false);
          }}
          onTagSelect={(tagIndex) => {
            // 不关闭播放器，直接打开详情遮罩
            // setPlayingGop(null); 
            setInitialTagForGop(undefined);
            setSelectedTagIndex(tagIndex);
          }}
          initialTagIndex={initialTagForGop}
        />
      )}

      {/* 详情弹窗 (Z-Index likely higher, renders on top) */}
      {selectedTagIndex !== null && analysisResult && fileData && (
        <DetailModal
          fileId={fileId}
          result={analysisResult}
          tagIndex={selectedTagIndex}
          fileData={fileData}
          onClose={() => setSelectedTagIndex(null)}
          onPreviewFrame={(gopIndex, tagIdx) => {
            // 找到对应的 GOP 并打开播放器 (如果已打开则保持)
            const gop = analysisResult.gops[gopIndex];
            if (gop) {
              setSelectedTagIndex(null); // 关闭详情弹窗
              setInitialTagForGop(tagIdx); // 设置跳转目标
              setPlayingGop(gop); // 确保播放器显示
            }
          }}
        />
      )}
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
