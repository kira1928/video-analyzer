import { useState, useCallback, useEffect } from 'react';
import { AnalysisResult, TagDetail, TagField, HexLine } from '../types';
import { getTagDetail } from '../utils/wasm';
import { loadFrame } from '../utils/gopCache';
import './DetailModal.css';

interface DetailModalProps {
  fileId: string;
  tagIndex: number;
  result: AnalysisResult;
  fileData: Uint8Array;
  onClose: () => void;
  onPreviewFrame?: (gopIndex: number, tagIndex: number) => void;
}

export function DetailModal({
  fileId,
  tagIndex,
  result,
  fileData,
  onClose,
  onPreviewFrame
}: DetailModalProps) {
  const [detail, setDetail] = useState<TagDetail | null>(null);
  const [highlightRange, setHighlightRange] = useState<{ start: number; end: number } | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [cachedImageUrl, setCachedImageUrl] = useState<string | null>(null);

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
  const currentTag = result.tags[tagIndex];
  const belongingGop = currentTag?.type === 'video' && !currentTag.isSeqHeader
    ? result.gops.find(g => tagIndex >= g.startIndex && tagIndex <= g.endIndex)
    : null;

  // 加载详情数据（从 WASM）
  useEffect(() => {
    try {
      const tagDetail = getTagDetail(result, tagIndex, fileData);
      setDetail(tagDetail);

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
      collectExpanded(tagDetail.fields);
      setExpandedNodes(expanded);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [result, tagIndex, fileData]);

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

  if (!detail) {
    return (
      <div className="detail-modal-backdrop" onClick={onClose}>
        <div className="detail-modal" onClick={e => e.stopPropagation()}>
          <div className="detail-modal-header">
            <h3>加载中...</h3>
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
            {detail.tagType === 'video' ? '视频' : detail.tagType === 'audio' ? '音频' : '脚本'} 标签 #{detail.tagIndex}
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

          {/* 右侧: 属性树 */}
          <div className="linked-view-panel">
            <div className="linked-view-header">📋 字段解析</div>
            <div className="linked-view-content property-tree">
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
            <button className="btn btn-success" onClick={() => saveTagData(detail, fileData, false)}>
              💾 保存二进制数据
            </button>
            <button className="btn btn-secondary" onClick={() => saveTagData(detail, fileData, true)}>
              📦 保存完整 Tag
            </button>
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
function saveTagData(detail: TagDetail, fileData: Uint8Array, includeHeader: boolean) {
  const tagOffset = Number(detail.offset);
  const start = includeHeader ? tagOffset : tagOffset + 11;
  const end = includeHeader ? tagOffset + 11 + detail.size + 4 : tagOffset + 11 + detail.size;
  const data = fileData.slice(start, end);

  const filename = includeHeader
    ? `tag_${detail.tagIndex}_${detail.tagType}_full.flv_tag`
    : `tag_${detail.tagIndex}_${detail.tagType}_data.bin`;

  const blob = new Blob([data], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
