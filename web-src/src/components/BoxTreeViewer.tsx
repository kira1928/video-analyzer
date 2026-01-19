import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Mp4BoxTree, Mp4BoxNode, BoxField } from '../types';
import './BoxTreeViewer.css';

interface BoxTreeViewerProps {
  boxTree: Mp4BoxTree;
  fileData: Uint8Array;
  onClose: () => void;
}

/** 说明显示模式 */
type DescriptionMode = 'always' | 'hover' | 'hidden';

/** Hex 行数据 */
interface HexLine {
  offset: number;
  bytes: number[];
  ascii: string;
}

/** 高亮区域 */
interface HighlightRange {
  start: number;  // 绝对偏移
  end: number;    // 绝对偏移
  type: 'header' | 'content' | 'field';
}

export function BoxTreeViewer({ boxTree, fileData, onClose }: BoxTreeViewerProps) {
  // 展开状态管理
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => {
    // 默认展开第一层和 moov
    const expanded = new Set<string>();
    boxTree.boxes.forEach((box, i) => {
      expanded.add(String(i));
      if (box.boxType === 'moov' && box.children) {
        box.children.forEach((_child, j) => {
          expanded.add(`${i}-${j}`);
        });
      }
    });
    return expanded;
  });

  // 说明显示模式
  const [descriptionMode, setDescriptionMode] = useState<DescriptionMode>('hover');

  // 搜索过滤
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);

  // 选中的节点
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  // 选中的字段（用于高亮）
  const [selectedField, setSelectedField] = useState<BoxField | null>(null);

  // Hex viewer 引用（用于滚动）
  const hexContainerRef = useRef<HTMLDivElement>(null);

  // 当前选中的 Box 信息（用于 Hex 高亮）
  const selectedBox = useMemo(() => {
    if (!selectedNode) return null;
    const indices = selectedNode.split('-').map(Number);
    let current: Mp4BoxNode | undefined = boxTree.boxes[indices[0]];
    for (let i = 1; i < indices.length && current; i++) {
      current = current.children?.[indices[i]];
    }
    return current || null;
  }, [boxTree, selectedNode]);

  // 生成 Hex 数据（限制显示范围以提高性能）
  const hexData = useMemo(() => {
    if (!selectedBox) return { lines: [], startOffset: 0, endOffset: 0 };

    // 限制最大显示 4KB 的 hex dump
    const maxBytes = 4096;
    const boxStart = Number(selectedBox.offset);
    const boxEnd = Math.min(boxStart + Number(selectedBox.size), boxStart + maxBytes);

    // 对齐到 16 字节边界
    const alignedStart = Math.floor(boxStart / 16) * 16;
    const alignedEnd = Math.ceil(boxEnd / 16) * 16;

    const lines: HexLine[] = [];
    for (let offset = alignedStart; offset < alignedEnd && offset < fileData.length; offset += 16) {
      const bytes: number[] = [];
      let ascii = '';
      for (let i = 0; i < 16 && offset + i < fileData.length; i++) {
        const byte = fileData[offset + i];
        bytes.push(byte);
        ascii += byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.';
      }
      lines.push({ offset, bytes, ascii });
    }

    return { lines, startOffset: boxStart, endOffset: boxEnd };
  }, [selectedBox, fileData]);

  // 计算高亮区域
  const highlightRanges = useMemo<HighlightRange[]>(() => {
    if (!selectedBox) return [];

    const ranges: HighlightRange[] = [];
    const boxStart = Number(selectedBox.offset);
    const boxEnd = boxStart + Number(selectedBox.size);
    const headerEnd = boxStart + selectedBox.headerSize;

    // 如果选中了字段，高亮该字段
    if (selectedField && selectedField.offset !== undefined && selectedField.size !== undefined) {
      // 字段偏移是相对于 box 内容的，需要加上 box 起始位置和头部大小
      const fieldStart = boxStart + selectedBox.headerSize + selectedField.offset;
      const fieldEnd = fieldStart + selectedField.size;

      // 头部
      ranges.push({ start: boxStart, end: headerEnd, type: 'header' });
      // 字段（高亮）
      ranges.push({ start: fieldStart, end: fieldEnd, type: 'field' });
      // 其余内容
      if (fieldStart > headerEnd) {
        ranges.push({ start: headerEnd, end: fieldStart, type: 'content' });
      }
      if (fieldEnd < boxEnd) {
        ranges.push({ start: fieldEnd, end: boxEnd, type: 'content' });
      }
    } else {
      // 默认高亮整个 box
      ranges.push({ start: boxStart, end: headerEnd, type: 'header' });
      ranges.push({ start: headerEnd, end: boxEnd, type: 'content' });
    }

    return ranges;
  }, [selectedBox, selectedField]);

  // 点击字段时滚动到对应位置
  useEffect(() => {
    if (selectedField && selectedField.offset !== undefined && selectedBox && hexContainerRef.current) {
      const fieldAbsoluteOffset = Number(selectedBox.offset) + selectedBox.headerSize + selectedField.offset;
      const lineIndex = Math.floor((fieldAbsoluteOffset - hexData.startOffset) / 16);
      const lineElement = hexContainerRef.current.querySelector(`.hex-line:nth-child(${lineIndex + 1})`);
      lineElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [selectedField, selectedBox, hexData.startOffset]);

  // 选中节点时重置字段选择
  useEffect(() => {
    setSelectedField(null);
  }, [selectedNode]);

  // 选中节点时滚动 Hex viewer 到顶部
  useEffect(() => {
    if (selectedBox && hexContainerRef.current && !selectedField) {
      hexContainerRef.current.scrollTop = 0;
    }
  }, [selectedBox, selectedField]);

  // 一键展开/收起所有
  const expandAll = useCallback(() => {
    const allPaths = new Set<string>();
    const collectPaths = (nodes: Mp4BoxNode[], prefix: string) => {
      nodes.forEach((node, i) => {
        const path = prefix ? `${prefix}-${i}` : String(i);
        allPaths.add(path);
        if (node.children) {
          collectPaths(node.children, path);
        }
      });
    };
    collectPaths(boxTree.boxes, '');
    setExpandedNodes(allPaths);
  }, [boxTree]);

  const collapseAll = useCallback(() => {
    setExpandedNodes(new Set());
  }, []);

  // 切换节点展开状态
  const toggleNode = useCallback((path: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // 过滤后的 box 树 & 搜索匹配列表
  const { filteredBoxes, matchPaths, searchResults } = useMemo(() => {
    if (!searchQuery.trim()) {
      return { filteredBoxes: boxTree.boxes, matchPaths: new Set<string>(), searchResults: [] as { path: string; node: Mp4BoxNode }[] };
    }

    const query = searchQuery.toLowerCase();
    const matchPaths = new Set<string>();
    const results: { path: string; node: Mp4BoxNode }[] = [];

    const filterNode = (node: Mp4BoxNode, path: string): Mp4BoxNode | null => {
      const matches = node.boxType.toLowerCase().includes(query) ||
        node.description.toLowerCase().includes(query) ||
        String(node.offset).includes(query) ||
        String(node.size).includes(query);

      if (matches) {
        matchPaths.add(path);
        results.push({ path, node });
      }

      const filteredChildren = node.children
        ? node.children
            .map((child, idx) => filterNode(child, `${path}-${idx}`))
            .filter((n): n is Mp4BoxNode => n !== null)
        : undefined;

      if (matches || (filteredChildren && filteredChildren.length > 0)) {
        return {
          ...node,
          children: filteredChildren && filteredChildren.length > 0 ? filteredChildren : node.children,
        };
      }
      return null;
    };

    const filtered = boxTree.boxes
      .map((node, idx) => filterNode(node, String(idx)))
      .filter((n): n is Mp4BoxNode => n !== null);

    return { filteredBoxes: filtered, matchPaths, searchResults: results };
  }, [boxTree, searchQuery]);

  // 搜索重置匹配索引
  useEffect(() => {
    setActiveMatchIndex(0);
  }, [searchQuery]);

  // 匹配高亮与自动展开
  useEffect(() => {
    if (!searchQuery.trim() || matchPaths.size === 0) return;
    setExpandedNodes(prev => {
      const next = new Set(prev);
      matchPaths.forEach(path => {
        const parts = path.split('-');
        let acc = '';
        parts.forEach((p, idx) => {
          acc = idx === 0 ? p : `${acc}-${p}`;
          next.add(acc);
        });
      });
      return next;
    });
  }, [searchQuery, matchPaths]);

  // 当前匹配节点
  const currentMatchPath = useMemo(() => {
    if (!searchQuery.trim() || searchResults.length === 0) return null;
    const safeIndex = Math.min(activeMatchIndex, searchResults.length - 1);
    return searchResults[safeIndex]?.path ?? null;
  }, [activeMatchIndex, searchQuery, searchResults]);

  // 跳转到匹配节点
  useEffect(() => {
    if (!currentMatchPath) return;
    setSelectedNode(currentMatchPath);
  }, [currentMatchPath]);

  const gotoMatch = useCallback((delta: number) => {
    setActiveMatchIndex(idx => {
      if (searchResults.length === 0) return 0;
      const next = (idx + delta + searchResults.length) % searchResults.length;
      return next;
    });
  }, [searchResults]);

  return (
    <div className="box-tree-backdrop" onClick={onClose}>
      <div className="box-tree-modal box-tree-modal-with-hex" onClick={e => e.stopPropagation()}>
        <div className="box-tree-header">
          <h3>📦 MP4 Box 结构</h3>
          <span className="box-tree-count">共 {boxTree.totalCount} 个 Box</span>
          <button className="box-tree-close" onClick={onClose}>×</button>
        </div>

        <div className="box-tree-toolbar">
          <div className="box-tree-search">
            <input
              type="text"
              placeholder="搜索 Box 类型或说明..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
          <div className="box-tree-search-meta">
            <button
              onClick={() => gotoMatch(-1)}
              disabled={searchResults.length === 0}
              title="上一个匹配"
            >↑</button>
            <span className="box-tree-match-count">
              {searchResults.length === 0 ? '0/0' : `${Math.min(activeMatchIndex + 1, searchResults.length)}/${searchResults.length}`}
            </span>
            <button
              onClick={() => gotoMatch(1)}
              disabled={searchResults.length === 0}
              title="下一个匹配"
            >↓</button>
          </div>

          <div className="box-tree-actions">
            <button onClick={expandAll} title="展开全部">📂 全部展开</button>
            <button onClick={collapseAll} title="收起全部">📁 全部收起</button>
          </div>

          <div className="box-tree-desc-mode">
            <label>说明文本:</label>
            <select
              value={descriptionMode}
              onChange={e => setDescriptionMode(e.target.value as DescriptionMode)}
            >
              <option value="always">始终显示</option>
              <option value="hover">悬浮显示</option>
              <option value="hidden">隐藏</option>
            </select>
          </div>
        </div>

        <div className="box-tree-main">
          {/* 左侧: Box 树 */}
          <div className="box-tree-left">
            <div className="box-tree-content">
              <BoxNodeList
                nodes={filteredBoxes}
                expandedNodes={expandedNodes}
                selectedNode={selectedNode}
                matchedPaths={matchPaths}
                currentMatchPath={currentMatchPath}
                descriptionMode={descriptionMode}
                onToggle={toggleNode}
                onSelect={setSelectedNode}
                parentPath=""
              />
            </div>
          </div>

          {/* 右侧: Hex Viewer + 详情 */}
          <div className="box-tree-right">
            {selectedBox ? (
              <>
                {/* Hex Viewer */}
                <div className="box-hex-panel">
                  <div className="box-hex-header">
                    <span>🔢 二进制内容</span>
                    <span className="box-hex-info">
                      {selectedBox.boxType} @ 0x{selectedBox.offset.toString(16).toUpperCase()}
                      ({formatSize(selectedBox.size)})
                      {selectedBox.size > 4096 && <span className="hex-truncated"> - 仅显示前 4KB</span>}
                    </span>
                    {selectedField && (
                      <button
                        className="hex-clear-selection"
                        onClick={() => setSelectedField(null)}
                        title="清除字段选择"
                      >
                        ✕ 清除选择
                      </button>
                    )}
                  </div>
                  <div className="box-hex-content" ref={hexContainerRef}>
                    <HexView
                      lines={hexData.lines}
                      boxStart={Number(selectedBox.offset)}
                      highlightRanges={highlightRanges}
                    />
                  </div>
                </div>

                {/* 详情面板 */}
                <BoxDetailPanel
                  node={selectedBox}
                  descriptionMode={descriptionMode}
                  selectedField={selectedField}
                  onFieldSelect={setSelectedField}
                />
              </>
            ) : (
              <div className="box-tree-placeholder">
                <div className="placeholder-icon">👈</div>
                <div className="placeholder-text">点击左侧 Box 查看详情和二进制内容</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Hex 视图组件 */
interface HexViewProps {
  lines: HexLine[];
  boxStart: number;
  highlightRanges: HighlightRange[];
}

function HexView({ lines, boxStart, highlightRanges }: HexViewProps) {
  // 获取字节的高亮类型
  const getByteHighlight = (globalOffset: number): string => {
    for (const range of highlightRanges) {
      if (globalOffset >= range.start && globalOffset < range.end) {
        switch (range.type) {
          case 'header': return 'hex-highlight-header';
          case 'field': return 'hex-highlight-field';
          case 'content': return 'hex-highlight-content';
        }
      }
    }
    return '';
  };

  return (
    <div className="hex-view">
      {lines.map((line, lineIndex) => (
        <div key={lineIndex} className="hex-line">
          <span className="hex-offset">
            {line.offset.toString(16).toUpperCase().padStart(8, '0')}
          </span>
          <span className="hex-bytes">
            {line.bytes.map((byte, byteIndex) => {
              const globalOffset = line.offset + byteIndex;
              const highlightClass = getByteHighlight(globalOffset);

              return (
                <span key={byteIndex} className={`hex-byte ${highlightClass}`}>
                  {byte.toString(16).toUpperCase().padStart(2, '0')}
                </span>
              );
            })}
            {/* 填充空白以对齐 */}
            {line.bytes.length < 16 && (
              <span className="hex-padding">
                {'   '.repeat(16 - line.bytes.length)}
              </span>
            )}
          </span>
          <span className="hex-ascii">
            {line.ascii.split('').map((char, i) => {
              const globalOffset = line.offset + i;
              const highlightClass = getByteHighlight(globalOffset);
              const asciiClass = highlightClass.replace('hex-', 'ascii-');

              return <span key={i} className={asciiClass}>{char}</span>;
            })}
          </span>
        </div>
      ))}
    </div>
  );
}

interface BoxNodeListProps {
  nodes: Mp4BoxNode[];
  expandedNodes: Set<string>;
  selectedNode: string | null;
  matchedPaths?: Set<string>;
  currentMatchPath?: string | null;
  descriptionMode: DescriptionMode;
  onToggle: (path: string) => void;
  onSelect: (path: string | null) => void;
  parentPath: string;
}

function BoxNodeList({
  nodes,
  expandedNodes,
  selectedNode,
  matchedPaths,
  currentMatchPath,
  descriptionMode,
  onToggle,
  onSelect,
  parentPath,
}: BoxNodeListProps) {
  return (
    <ul className="box-node-list">
      {nodes.map((node, index) => {
        const path = parentPath ? `${parentPath}-${index}` : String(index);
        const isExpanded = expandedNodes.has(path);
        const isSelected = selectedNode === path;
        const isMatched = matchedPaths?.has(path);
        const isCurrentMatch = currentMatchPath === path;
        const hasChildren = node.children && node.children.length > 0;

        return (
          <li key={path} className="box-node">
            <div
              className={`box-node-row ${isSelected ? 'selected' : ''} ${isMatched ? 'matched' : ''} ${isCurrentMatch ? 'current-match' : ''}`}
              onClick={() => onSelect(path)}
            >
              {hasChildren ? (
                <span
                  className="box-node-toggle"
                  onClick={e => { e.stopPropagation(); onToggle(path); }}
                >
                  {isExpanded ? '▼' : '▶'}
                </span>
              ) : (
                <span className="box-node-toggle empty">◦</span>
              )}

              <span className="box-node-type">{node.boxType}</span>
              <span className="box-node-size">({formatSize(node.size)})</span>
              <span className="box-node-offset">@ 0x{node.offset.toString(16).toUpperCase()}</span>

              {descriptionMode === 'always' && (
                <span className="box-node-desc">{node.description}</span>
              )}
              {descriptionMode === 'hover' && (
                <span className="box-node-desc hover-only" title={node.description}>
                  ℹ️
                </span>
              )}
            </div>

            {hasChildren && isExpanded && (
              <BoxNodeList
                nodes={node.children!}
                expandedNodes={expandedNodes}
                selectedNode={selectedNode}
                matchedPaths={matchedPaths}
                currentMatchPath={currentMatchPath}
                descriptionMode={descriptionMode}
                onToggle={onToggle}
                onSelect={onSelect}
                parentPath={path}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

interface BoxDetailPanelProps {
  node: Mp4BoxNode;
  descriptionMode: DescriptionMode;
  selectedField: BoxField | null;
  onFieldSelect: (field: BoxField | null) => void;
}

/** 每组显示的最大条目数 */
const ITEMS_PER_GROUP = 100;

function BoxDetailPanel({ node, descriptionMode, selectedField, onFieldSelect }: BoxDetailPanelProps) {
  // 分组展开状态
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set([0])); // 默认展开第一组

  const handleFieldClick = (field: BoxField) => {
    // 只有有 offset 信息的字段才能高亮
    if (field.offset !== undefined && field.size !== undefined) {
      if (selectedField === field) {
        onFieldSelect(null);  // 取消选择
      } else {
        onFieldSelect(field);
      }
    }
  };

  const toggleGroup = (groupIndex: number) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupIndex)) {
        next.delete(groupIndex);
      } else {
        next.add(groupIndex);
      }
      return next;
    });
  };

  // 计算字段分组
  const fieldGroups = useMemo(() => {
    if (!node.fields || node.fields.length <= ITEMS_PER_GROUP) {
      return null; // 不需要分组
    }

    const groups: { startIndex: number; endIndex: number; fields: BoxField[] }[] = [];
    for (let i = 0; i < node.fields.length; i += ITEMS_PER_GROUP) {
      const end = Math.min(i + ITEMS_PER_GROUP, node.fields.length);
      groups.push({
        startIndex: i,
        endIndex: end - 1,
        fields: node.fields.slice(i, end),
      });
    }
    return groups;
  }, [node.fields]);

  // 渲染字段表格
  const renderFieldsTable = (fields: BoxField[], keyPrefix: string = '') => (
    <table>
      <thead>
        <tr>
          <th>字段名</th>
          <th>值</th>
          <th>位置</th>
          {descriptionMode !== 'hidden' && <th>说明</th>}
        </tr>
      </thead>
      <tbody>
        {fields.map((field, i) => {
          const hasOffset = field.offset !== undefined && field.size !== undefined;
          const isSelected = selectedField === field;

          return (
            <tr
              key={`${keyPrefix}${i}`}
              className={`${hasOffset ? 'clickable' : ''} ${isSelected ? 'selected' : ''}`}
              onClick={() => handleFieldClick(field)}
              title={descriptionMode === 'hover' ? field.description : undefined}
            >
              <td className="field-name">{field.name}</td>
              <td className="field-value">{field.value}</td>
              <td className="field-offset">
                {hasOffset ? (
                  <span className="offset-badge">
                    +{field.offset} ({field.size}B)
                  </span>
                ) : (
                  <span className="offset-na">-</span>
                )}
              </td>
              {descriptionMode === 'always' && (
                <td className="field-desc">{field.description}</td>
              )}
              {descriptionMode === 'hover' && (
                <td className="field-desc-hint">ℹ️</td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <div className="box-detail-panel">
      <h4>
        <span className="box-type-badge">{node.boxType}</span>
        {node.description}
      </h4>

      <div className="box-detail-info">
        <div className="box-detail-row">
          <span className="label">偏移位置:</span>
          <span className="value">0x{node.offset.toString(16).toUpperCase()} ({node.offset})</span>
        </div>
        <div className="box-detail-row">
          <span className="label">大小:</span>
          <span className="value">{formatSize(node.size)} ({node.size} 字节)</span>
        </div>
        <div className="box-detail-row">
          <span className="label">头部大小:</span>
          <span className="value">{node.headerSize} 字节</span>
        </div>
      </div>

      {node.fields && node.fields.length > 0 && (
        <div className="box-detail-fields">
          <h5>
            📋 字段详情 ({node.fields.length} 项)
            <span className="field-hint">(点击可高亮)</span>
          </h5>

          {fieldGroups ? (
            // 分组显示
            <div className="field-groups">
              {fieldGroups.map((group, groupIndex) => {
                const isExpanded = expandedGroups.has(groupIndex);
                return (
                  <div key={groupIndex} className="field-group">
                    <div
                      className="field-group-header"
                      onClick={() => toggleGroup(groupIndex)}
                    >
                      <span className="group-toggle">{isExpanded ? '▼' : '▶'}</span>
                      <span className="group-range">
                        [{group.startIndex} - {group.endIndex}]
                      </span>
                      <span className="group-count">
                        ({group.fields.length} 项)
                      </span>
                    </div>
                    {isExpanded && (
                      <div className="field-group-content">
                        {renderFieldsTable(group.fields, `group-${groupIndex}-`)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            // 不需要分组，直接显示
            renderFieldsTable(node.fields)
          )}
        </div>
      )}

      {node.children && node.children.length > 0 && (
        <div className="box-detail-children">
          <h5>📁 子 Box ({node.children.length})</h5>
          <div className="children-summary">
            {node.children.length <= 20
              ? node.children.map(c => c.boxType).join(', ')
              : `${node.children.slice(0, 20).map(c => c.boxType).join(', ')}... (共 ${node.children.length} 个)`
            }
          </div>
        </div>
      )}
    </div>
  );
}

/** 格式化文件大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
