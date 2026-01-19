import { useState, useCallback, useEffect } from 'react';
import { AnalysisResult, TagDetail, TagField, HexLine, Mp4SampleDetail, TagSummary } from '../types';
import { getTagDetail, getMp4SampleDetail } from '../utils/wasm';
import { loadFrame } from '../utils/gopCache';
import { formatDuration } from '../utils/format';
import { wasmWorker } from '../workers/wasmWorkerManager';
import './DetailModal.css';

interface DetailModalProps {
  fileId: string;
  tagIndex: number;
  tagSummary?: TagSummary | null;
  result: AnalysisResult;
  fileData: Uint8Array | null;  // 可能为 null（流式模式）
  currentFile?: File;           // 流式模式下提供
  isStreamingMode?: boolean;
  onClose: () => void;
  onPreviewFrame?: (gopIndex: number, tagIndex: number) => void;
}

/**
 * 构造最小化的 FLV Tag 数据：11 字节头 + 数据 + PreviousTagSize
 * 只用于详情展示，避免按原始偏移分配巨大缓冲区
 */
function buildFlvTagBuffer(tag: TagSummary, sampleData: Uint8Array): Uint8Array {
  const header = new Uint8Array(11);
  const typeByte = tag.type === 'audio' ? 8 : tag.type === 'video' ? 9 : 18;
  const dataSize = tag.size ?? sampleData.length;
  const ts = Math.max(0, Math.floor(tag.timestamp));

  header[0] = typeByte;
  header[1] = (dataSize >> 16) & 0xff;
  header[2] = (dataSize >> 8) & 0xff;
  header[3] = dataSize & 0xff;
  header[4] = (ts >> 16) & 0xff;
  header[5] = (ts >> 8) & 0xff;
  header[6] = ts & 0xff;
  header[7] = (ts >> 24) & 0xff;
  header[8] = 0;
  header[9] = 0;
  header[10] = 0;

  const prevTagSize = header.length + sampleData.length;
  const buffer = new Uint8Array(header.length + sampleData.length + 4);
  buffer.set(header, 0);
  buffer.set(sampleData, header.length);
  buffer.set(
    new Uint8Array([
      (prevTagSize >>> 24) & 0xff,
      (prevTagSize >>> 16) & 0xff,
      (prevTagSize >>> 8) & 0xff,
      prevTagSize & 0xff,
    ]),
    header.length + sampleData.length,
  );
  return buffer;
}

export function DetailModal({
  fileId,
  tagIndex,
  tagSummary,
  result,
  fileData,
  currentFile: _currentFile,
  isStreamingMode,
  onClose,
  onPreviewFrame
}: DetailModalProps) {
  const [resolvedTag, setResolvedTag] = useState<TagSummary | null>(tagSummary ?? null);
  const [detail, setDetail] = useState<TagDetail | null>(null);
  const [mp4SampleDetail, setMp4SampleDetail] = useState<Mp4SampleDetail | null>(null);
  const [highlightRange, setHighlightRange] = useState<{ start: number; end: number } | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [cachedImageUrl, setCachedImageUrl] = useState<string | null>(null);

  useEffect(() => {
    setResolvedTag(tagSummary ?? null);
  }, [tagSummary, tagIndex]);

  // 加载缓存的预览图
  useEffect(() => {
    let url: string | null = null;
    let active = true;

    loadFrame(fileId, tagIndex).then(blob => {
      if (!active) return;
      if (blob) {
        url = URL.createObjectURL(blob);
        setCachedImageUrl(url);
      } else {
        setCachedImageUrl(null);
      }
    });

    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [fileId, tagIndex]);

  // 查找当前 Tag 所属的 GOP
  const currentTag = resolvedTag ?? result.tags[tagIndex];
  const belongingGop = currentTag
    ? result.gops.find(g => tagIndex >= g.startIndex && tagIndex <= g.endIndex)
    : null;

  // 存储本地读取的数据（流式模式用）
  const [localFileData, setLocalFileData] = useState<Uint8Array | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // 加载详情数据（从 WASM）- 支持流式模式
  useEffect(() => {
    let cancelled = false;

    const loadDetail = async () => {
      try {
        setIsLoading(true);
        setError(null);
        setDetail(null);
        setExpandedNodes(new Set());
        setMp4SampleDetail(null);
        setHighlightRange(null);

        let tag = resolvedTag ?? null;
        if (!tag) {
          if (isStreamingMode) {
            try {
              const fetched = await wasmWorker.getSample(fileId, tagIndex);
              if (cancelled) return;
              setResolvedTag(fetched);
              tag = fetched;
            } catch (e) {
              if (!cancelled) {
                setError(e instanceof Error ? e.message : String(e));
              }
              return;
            }
          } else {
            tag = result.tags[tagIndex];
          }
        }

        if (!tag) {
          setError('找不到指定的标签');
          return;
        }

        let dataToUse: Uint8Array | null = null;
        const format = (result.format || '').toLowerCase();
        const hasFullData = !!fileData;

        if (!hasFullData) {
          try {
            const sampleData = await wasmWorker.readSampleData(fileId, tagIndex);
            if (cancelled) return;

            dataToUse = format === 'flv'
              ? buildFlvTagBuffer(tag, sampleData)
              : sampleData;
            setLocalFileData(dataToUse);
          } catch (e) {
            throw new Error(`读取数据失败: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else {
          dataToUse = fileData;
          setLocalFileData(null);
        }

        if (cancelled || !dataToUse) return;

        let detailForExpand: TagDetail | null = null;

        if (hasFullData) {
          const tagDetail = getTagDetail(result, tagIndex, dataToUse);
          setDetail(tagDetail);
          detailForExpand = tagDetail;

          if (tag.mp4Info) {
            try {
              const sampleDetail = getMp4SampleDetail(result, tagIndex, dataToUse);
              setMp4SampleDetail(sampleDetail);
            } catch (e) {
              console.warn('无法加载 MP4 Sample 详情:', e);
            }
          }
        } else {
          // 构造只包含当前 sample 的精简结果，避免把完整结果传给 WASM
          const normalizedTag: TagSummary = {
            ...tag,
            index: 0,
            offset: 0,
            size: tag.size ?? dataToUse.length,
          };
          const detailResult: AnalysisResult = {
            ...result,
            tags: [normalizedTag],
            gops: result.gops ?? [],
            videoTimeline: result.videoTimeline ?? [],
            audioTimeline: result.audioTimeline ?? [],
          };

          const tagDetail = getTagDetail(detailResult, 0, dataToUse);
          const adjustedDetail: TagDetail = {
            ...tagDetail,
            tagIndex: tag.index,
            offset: tag.offset,
          };
          setDetail(adjustedDetail);
          detailForExpand = adjustedDetail;

          if (tag.mp4Info) {
            try {
              const sampleDetail = getMp4SampleDetail(detailResult, 0, dataToUse);
              setMp4SampleDetail(sampleDetail);
            } catch (e) {
              console.warn('无法加载 MP4 Sample 详情:', e);
            }
          }
        }

        // 默认展开有 expanded 标记的节点
        const expanded = new Set<string>();
        const collectExpanded = (fields: TagField[], path = '') => {
          fields.forEach(f => {
            const fieldPath = `${path}${f.name}`;
            if (f.expanded) {
              expanded.add(fieldPath);
            }
            if (f.children) {
              collectExpanded(f.children, `${fieldPath}/`);
            }
          });
        };
        if (detailForExpand) {
          collectExpanded(detailForExpand.fields);
        }
        setExpandedNodes(expanded);

      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    loadDetail();

    return () => {
      cancelled = true;
    };
  }, [fileId, tagIndex, isStreamingMode, fileData, result, resolvedTag]);

  const handleFieldClick = useCallback((field: TagField, path: string) => {
    // 高亮对应字节
    if (!field.virtualField) {
      setHighlightRange({ start: field.start, end: field.end });
    }

    // 切换展开/折叠
    if (field.children && field.children.length > 0) {
      setExpandedNodes(prev => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });
    }
  }, []);

  if (error) {
    return (
      <div className="detail-modal-backdrop" onClick={onClose}>
        <div className="detail-modal" onClick={e => e.stopPropagation()}>
          <div className="detail-modal-header">
            <h3>错误</h3>
            <button className="detail-modal-close" onClick={onClose}>×</button>
          </div>
          <p style={{ color: 'var(--error)', padding: '20px' }}>{error}</p>
        </div>
      </div>
    );
  }

  if (!detail || isLoading) {
    return (
      <div className="detail-modal-backdrop" onClick={onClose}>
        <div className="detail-modal" onClick={e => e.stopPropagation()}>
          <div className="detail-modal-header">
            <h3>{isStreamingMode ? '正在读取数据...' : '加载中...'}</h3>
            <button className="detail-modal-close" onClick={onClose}>×</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="detail-modal-backdrop" onClick={onClose}>
      <div className="detail-modal" onClick={e => e.stopPropagation()}>
        <div className="detail-modal-header">
          <h3>
            {currentTag?.mp4Info
              ? `${detail.tagType === 'video' ? '视频' : detail.tagType === 'audio' ? '音频' : '脚本'} Sample (Track ${currentTag.mp4Info.trackId} #${currentTag.mp4Info.sampleIndex})`
              : `${detail.tagType === 'video' ? '视频' : detail.tagType === 'audio' ? '音频' : '脚本'} 标签 #${detail.tagIndex}`
            }
            {currentTag && (
              <span className="detail-timestamp" style={{ marginLeft: '12px', fontSize: '14px', color: '#aaa', fontWeight: 'normal' }}>
                @ {formatDuration(currentTag.timestamp / 1000)}
              </span>
            )}
          </h3>
          <button className="detail-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="linked-view">
          {/* 左侧: Hex 视图 */}
          <div className="linked-view-panel">
            <div className="linked-view-header">🔢 二进制内容 ({detail.totalSize} 字节)</div>
            <div className="linked-view-content hex-content">
              <HexView hexLines={detail.hexLines} highlightRange={highlightRange} />
            </div>
          </div>

          {/* 右侧: 属性树 + MP4 详情 */}
          <div className="linked-view-panel">
            <div className="linked-view-header">📋 字段解析</div>
            <div className="linked-view-content property-tree">
              {/* MP4 Sample 详情 */}
              {mp4SampleDetail && (
                <div className="mp4-sample-detail">
                  <div className="mp4-sample-detail-header">📊 Sample 信息</div>
                  <table className="mp4-sample-table">
                    <tbody>
                      {mp4SampleDetail.fields.map((field, i) => (
                        <tr key={i} className="mp4-sample-row">
                          <td className="mp4-sample-name">{field.name}</td>
                          <td className="mp4-sample-value">{field.value}</td>
                          <td className="mp4-sample-help" title={`${field.description}\n\n计算方式: ${field.formula}`}>
                            ℹ️
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* 字段树 */}
              <PropertyTree
                fields={detail.fields}
                expandedNodes={expandedNodes}
                highlightRange={highlightRange}
                onFieldClick={handleFieldClick}
              />
            </div>
          </div>
        </div>



        <div className="detail-actions">
          {belongingGop && (
            <div className="preview-section" style={{ marginBottom: '10px', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              {cachedImageUrl ? (
                <div className="cached-preview">
                  <img src={cachedImageUrl} alt="Frame Preview" style={{ maxWidth: '100%', maxHeight: '300px', border: '1px solid #444' }} />
                  <div style={{ marginTop: '5px', fontSize: '12px', color: '#888' }}>
                    (已缓存画面 - <span className="link-btn" onClick={() => onPreviewFrame && onPreviewFrame(belongingGop.index, tagIndex)} style={{ cursor: 'pointer', textDecoration: 'underline' }}>在播放器中打开</span>)
                  </div>
                </div>
              ) : (
                onPreviewFrame && (
                  <button
                    className="btn btn-primary"
                    onClick={() => onPreviewFrame(belongingGop.index, tagIndex)}
                  >
                    🎬 预览帧画面
                  </button>
                )
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              className="btn btn-success"
              onClick={() => {
                const dataToSave = fileData || localFileData;
                if (dataToSave) {
                  saveTagData(detail, dataToSave, false, currentTag?.mp4Info);
                }
              }}
              disabled={!fileData && !localFileData}
            >
              💾 保存{currentTag?.mp4Info ? ' Sample 数据' : '二进制数据'}
            </button>
            {!currentTag?.mp4Info && (
              <button
                className="btn btn-secondary"
                onClick={() => {
                  const dataToSave = fileData || localFileData;
                  if (dataToSave) {
                    saveTagData(detail, dataToSave, true);
                  }
                }}
                disabled={!fileData && !localFileData}
              >
                📦 保存完整 Tag
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Hex 视图组件 - 渲染 WASM 返回的数据
interface HexViewProps {
  hexLines: HexLine[];
  highlightRange: { start: number; end: number } | null;
}

function HexView({ hexLines, highlightRange }: HexViewProps) {
  return (
    <>
      {hexLines.map((line, i) => (
        <div key={i} className="hex-line">
          <span className="hex-offset">{line.offset}</span>
          <span className="hex-bytes">
            {line.bytes.map((byte, j) => {
              // 计算当前字节的绝对位置
              const byteIndex = i * 8 + j;
              const isHighlighted = highlightRange &&
                byteIndex >= highlightRange.start &&
                byteIndex < highlightRange.end;

              const cssClass = isHighlighted ? 'hex-highlight-selected' : (byte.cssClass || '');

              return (
                <span key={j} className={`hex-byte ${cssClass}`}>{byte.hex}</span>
              );
            })}
          </span>
          <span className="hex-ascii">{line.ascii}</span>
        </div>
      ))}
    </>
  );
}

// 属性树组件
interface PropertyTreeProps {
  fields: TagField[];
  expandedNodes: Set<string>;
  highlightRange: { start: number; end: number } | null;
  onFieldClick: (field: TagField, path: string) => void;
  parentPath?: string;
}

function PropertyTree({ fields, expandedNodes, highlightRange, onFieldClick, parentPath = '' }: PropertyTreeProps) {
  return (
    <>
      {fields.map((field, index) => {
        const path = `${parentPath}${field.name}`;
        const hasChildren = field.children && field.children.length > 0;
        const isExpanded = expandedNodes.has(path);
        const isHighlighted = highlightRange &&
          field.start === highlightRange.start &&
          field.end === highlightRange.end;

        return (
          <div key={index} className={`property-node ${isExpanded ? 'expanded' : ''}`}>
            <div
              className={`property-row ${hasChildren ? 'property-expandable' : ''} ${isHighlighted ? 'selected' : ''}`}
              onClick={() => onFieldClick(field, path)}
            >
              <span className="property-name">{field.name}</span>
              <span className="property-value">{field.value}</span>
            </div>
            {hasChildren && isExpanded && (
              <div className="property-children">
                <PropertyTree
                  fields={field.children!}
                  expandedNodes={expandedNodes}
                  highlightRange={highlightRange}
                  onFieldClick={onFieldClick}
                  parentPath={`${path}/`}
                />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

// 保存标签数据
function saveTagData(detail: TagDetail, fileData: Uint8Array, includeHeader: boolean, mp4Info?: any) {
  let start = 0;
  let end = 0;
  let filename = '';

  if (mp4Info) {
    // MP4 模式：直接保存 Sample 数据
    start = Number(detail.offset);
    end = start + detail.size;
    filename = `track_${mp4Info.trackId}_sample_${mp4Info.sampleIndex}.bin`;
  } else {
    // FLV 模式
    const tagOffset = Number(detail.offset);
    start = includeHeader ? tagOffset : tagOffset + 11;
    end = includeHeader ? tagOffset + 11 + detail.size + 4 : tagOffset + 11 + detail.size;

    filename = includeHeader
      ? `tag_${detail.tagIndex}_${detail.tagType}_full.flv_tag`
      : `tag_${detail.tagIndex}_${detail.tagType}_data.bin`;
  }

  const data = fileData.slice(start, end);
  const blob = new Blob([data], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
