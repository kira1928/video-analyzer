import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Mp4BoxTree, Mp4BoxNode, BoxField, Mp4BoxChildrenResult, Mp4BoxFieldsResult, Mp4BoxSearchResult } from '../types';
import { wasmWorker } from '../workers/wasmWorkerManager';
import './BoxTreeViewer.css';

interface BoxTreeViewerProps {
  boxTree: Mp4BoxTree;
  fileData?: Uint8Array;
  isStreamingMode?: boolean;
  fileId?: string;
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

interface StreamingFieldState {
  headerFields: BoxField[];
  entryCount?: number;
  entryGroups: Map<number, BoxField[]>;
  loadingGroups: Set<number>;
  isLoading?: boolean;
}

const HEX_BYTES_PER_LINE = 16;
const STREAMING_HEX_CHUNK_BYTES = 4096;
const STREAMING_HEX_LINE_HEIGHT = 20;
// const STREAMING_HEX_OVERSCAN_LINES = 40;
// const STREAMING_HEX_MAX_CHUNKS = 24;


export function BoxTreeViewer({ boxTree, fileData, isStreamingMode = false, fileId, onClose }: BoxTreeViewerProps) {
  const [treeState, setTreeState] = useState<Mp4BoxTree>(boxTree);
  const [streamingSearchTree, setStreamingSearchTree] = useState<Mp4BoxTree | null>(null);
  const [streamingMatchPaths, setStreamingMatchPaths] = useState<Set<string>>(new Set());
  const [streamingSearchResults, setStreamingSearchResults] = useState<string[]>([]);
  const [loadingNodes, setLoadingNodes] = useState<Set<string>>(new Set());

  const [streamingFieldsMap, setStreamingFieldsMap] = useState<Map<string, StreamingFieldState>>(new Map());
  const [streamingHexData, setStreamingHexData] = useState<Uint8Array | null>(null);
  const [streamingHexBaseOffset, setStreamingHexBaseOffset] = useState<number>(0);
  const [streamingHexLoading, setStreamingHexLoading] = useState(false);
  const [streamingHexError, setStreamingHexError] = useState<string | null>(null);

  const getNodeKey = useCallback((node: Mp4BoxNode) => `${node.offset}-${node.size}`, []);
  // 展开状态管理
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => {
    // 默认展开第一层和 moov
    const expanded = new Set<string>();
    treeState.boxes.forEach((box, i) => {
      expanded.add(String(i));
      if (box.boxType === 'moov' && box.children) {
        box.children.forEach((_child, j) => {
          expanded.add(`${i}-${j}`);
        });
      }
    });
    return expanded;
  });

  useEffect(() => {
    setTreeState(boxTree);
    const expanded = new Set<string>();
    boxTree.boxes.forEach((box, i) => {
      expanded.add(String(i));
      if (box.boxType === 'moov' && box.children) {
        box.children.forEach((_child, j) => {
          expanded.add(`${i}-${j}`);
        });
      }
    });
    setExpandedNodes(expanded);
    setStreamingSearchTree(null);
    setStreamingMatchPaths(new Set());
    setStreamingSearchResults([]);
    setStreamingFieldsMap(new Map());
    setLoadingNodes(new Set());
    setStreamingHexData(null);
    setStreamingHexBaseOffset(0);
    setStreamingHexLoading(false);
    setStreamingHexError(null);
    setSelectedNode(null);
    setSelectedField(null);
  }, [boxTree]);

  // 说明显示模式
  const [descriptionMode, setDescriptionMode] = useState<DescriptionMode>('hover');

  // 搜索过滤
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);

  useEffect(() => {
    if (!isStreamingMode || !fileId) return;
    const query = searchQuery.trim();
    if (!query) {
      setStreamingSearchTree(null);
      setStreamingMatchPaths(new Set());
      setStreamingSearchResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const result = await wasmWorker.searchMp4Boxes(fileId, query) as Mp4BoxSearchResult;
        if (cancelled) return;
        const paths = result.matchPaths.map(path => path.join('-'));
        setStreamingSearchTree(result.tree);
        setStreamingMatchPaths(new Set(paths));
        setStreamingSearchResults(paths);
      } catch (e) {
        if (!cancelled) {
          setStreamingSearchTree(null);
          setStreamingMatchPaths(new Set());
          setStreamingSearchResults([]);
        }
      }
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [searchQuery, isStreamingMode, fileId]);

  // 选中的节点
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  // 选中的字段（用于高亮）
  const [selectedField, setSelectedField] = useState<BoxField | null>(null);

  // Hex viewer 引用（用于滚动）
  const hexContainerRef = useRef<HTMLDivElement>(null);

  const displayTree = useMemo(
    () => (isStreamingMode && streamingSearchTree ? streamingSearchTree : treeState),
    [isStreamingMode, streamingSearchTree, treeState]
  );

  // 当前选中的 Box 信息（用于 Hex 高亮）
  const selectedBox = useMemo(() => {
    if (!selectedNode) return null;
    const indices = selectedNode.split('-').map(Number);
    let current: Mp4BoxNode | undefined = displayTree.boxes[indices[0]];
    for (let i = 1; i < indices.length && current; i++) {
      current = current.children?.[indices[i]];
    }
    return current || null;
  }, [displayTree, selectedNode]);

  // 流式模式：加载选中 Box 的前 4KB 作为 Hex 预览
  useEffect(() => {
    if (!isStreamingMode || !fileId || !selectedBox) {
      setStreamingHexData(null);
      setStreamingHexBaseOffset(0);
      setStreamingHexLoading(false);
      setStreamingHexError(null);
      return;
    }

    let cancelled = false;
    setStreamingHexLoading(true);
    setStreamingHexError(null);
    const baseOffset = Number(selectedBox.offset);
    const maxBytes = Math.min(Number(selectedBox.size), STREAMING_HEX_CHUNK_BYTES);

    (async () => {
      try {
        const data = await wasmWorker.readMp4Bytes(fileId, baseOffset, maxBytes);
        if (cancelled) return;
        setStreamingHexData(data);
        setStreamingHexBaseOffset(baseOffset);
      } catch (e) {
        if (cancelled) return;
        setStreamingHexData(null);
        setStreamingHexError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setStreamingHexLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fileId, isStreamingMode, selectedBox]);

  const findNodeByPath = useCallback((nodes: Mp4BoxNode[], path: string): Mp4BoxNode | null => {
    const indices = path.split('-').map(Number);
    let current: Mp4BoxNode | undefined;
    let currentList = nodes;
    for (const idx of indices) {
      current = currentList[idx];
      if (!current) return null;
      currentList = current.children ?? [];
    }
    return current ?? null;
  }, []);

  const updateNodeAtPath = useCallback((tree: Mp4BoxTree, path: string, updater: (node: Mp4BoxNode) => Mp4BoxNode): Mp4BoxTree => {
    const indices = path.split('-').map(Number);
    const updateLevel = (nodes: Mp4BoxNode[], depth: number): Mp4BoxNode[] => {
      const idx = indices[depth];
      return nodes.map((node, i) => {
        if (i != idx) return node;
        if (depth == indices.length - 1) {
          return updater(node);
        }
        const childNodes = node.children ?? [];
        return { ...node, children: updateLevel(childNodes, depth + 1) };
      });
    };
    return { ...tree, boxes: updateLevel(tree.boxes, 0) };
  }, []);

  const applyTreeUpdate = useCallback((updater: (tree: Mp4BoxTree) => Mp4BoxTree) => {
    if (isStreamingMode && streamingSearchTree) {
      setStreamingSearchTree(prev => (prev ? updater(prev) : prev));
    } else {
      setTreeState(prev => updater(prev));
    }
  }, [isStreamingMode, streamingSearchTree]);

  const loadChildrenIfNeeded = useCallback(async (path: string) => {
    if (!isStreamingMode || !fileId) return;
    const node = findNodeByPath(displayTree.boxes, path);
    if (!node || node.children || !node.isContainer) return;
    if (loadingNodes.has(path)) return;
    setLoadingNodes(prev => {
      const next = new Set(prev);
      next.add(path);
      return next;
    });
    try {
      const result = await wasmWorker.getMp4BoxChildren(fileId, node.offset, node.size, node.boxType) as Mp4BoxChildrenResult;
      applyTreeUpdate(tree => updateNodeAtPath(tree, path, target => ({
        ...target,
        children: result.children,
        childrenCount: result.totalCount
      })));
    } finally {
      setLoadingNodes(prev => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  }, [applyTreeUpdate, displayTree, fileId, findNodeByPath, isStreamingMode, loadingNodes, updateNodeAtPath]);

  // 生成 Hex 数据（限制显示范围以提高性能）
  const hexData = useMemo(() => {
    if (!selectedBox || !fileData) return { lines: [], startOffset: 0, endOffset: 0 };

    // 限制最大显示 4KB 的 hex dump
    const maxBytes = STREAMING_HEX_CHUNK_BYTES;
    const boxStart = Number(selectedBox.offset);
    const boxEnd = Math.min(boxStart + Number(selectedBox.size), boxStart + maxBytes);

    // 对齐到 16 字节边界
    const alignedStart = Math.floor(boxStart / HEX_BYTES_PER_LINE) * HEX_BYTES_PER_LINE;
    const alignedEnd = Math.ceil(boxEnd / HEX_BYTES_PER_LINE) * HEX_BYTES_PER_LINE;

    const lines: HexLine[] = [];
    for (let offset = alignedStart; offset < alignedEnd && offset < fileData.length; offset += HEX_BYTES_PER_LINE) {
      const bytes: number[] = [];
      let ascii = '';
      for (let i = 0; i < HEX_BYTES_PER_LINE && offset + i < fileData.length; i++) {
        const byte = fileData[offset + i];
        bytes.push(byte);
        ascii += byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.';
      }
      lines.push({ offset, bytes, ascii });
    }

    return { lines, startOffset: boxStart, endOffset: boxEnd };
  }, [selectedBox, fileData]);

  const streamingHexPreview = useMemo(() => {
    if (!selectedBox || !streamingHexData) return { lines: [], startOffset: 0, endOffset: 0 };

    const maxBytes = STREAMING_HEX_CHUNK_BYTES;
    const boxEnd = Math.min(streamingHexBaseOffset + Number(selectedBox.size), streamingHexBaseOffset + maxBytes);

    const alignedStart = Math.floor(streamingHexBaseOffset / HEX_BYTES_PER_LINE) * HEX_BYTES_PER_LINE;
    const alignedEnd = Math.ceil(boxEnd / HEX_BYTES_PER_LINE) * HEX_BYTES_PER_LINE;

    const lines: HexLine[] = [];
    const buffer = streamingHexData;
    for (let offset = alignedStart; offset < alignedEnd && offset < streamingHexBaseOffset + buffer.length; offset += HEX_BYTES_PER_LINE) {
      const bytes: number[] = [];
      let ascii = '';
      for (let i = 0; i < HEX_BYTES_PER_LINE; i++) {
        const globalOffset = offset + i;
        if (globalOffset < streamingHexBaseOffset || globalOffset >= streamingHexBaseOffset + buffer.length) {
          bytes.push(0);
          ascii += ' ';
          continue;
        }
        const byte = buffer[globalOffset - streamingHexBaseOffset];
        bytes.push(byte);
        ascii += byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.';
      }
      lines.push({ offset, bytes, ascii });
    }

    return { lines, startOffset: streamingHexBaseOffset, endOffset: boxEnd };
  }, [selectedBox, streamingHexBaseOffset, streamingHexData]);

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
      const baseOffset = fileData ? hexData.startOffset : Number(selectedBox.offset);
      const lineIndex = Math.floor((fieldAbsoluteOffset - baseOffset) / HEX_BYTES_PER_LINE);
      if (fileData) {
        const lineElement = hexContainerRef.current.querySelector(`.hex-line:nth-child(${lineIndex + 1})`);
        lineElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        hexContainerRef.current.scrollTo({
          top: lineIndex * STREAMING_HEX_LINE_HEIGHT,
          behavior: 'smooth',
        });
      }
    }
  }, [fileData, selectedField, selectedBox, hexData.startOffset]);

  // 选中节点时重置字段选择
  useEffect(() => {
    setSelectedField(null);
  }, [selectedNode]);

  useEffect(() => {
    if (!isStreamingMode || !fileId || !selectedBox) return;
    const key = getNodeKey(selectedBox);
    console.log(`[BoxTreeViewer] useEffect triggered for ${selectedBox.boxType}, key=${key}`);

    // 检查是否已经在缓存中
    const existing = streamingFieldsMap.get(key);
    if (existing) {
      console.log(`[BoxTreeViewer] Already have fields for ${key}, isLoading=${existing.isLoading}, headerFields.length=${existing.headerFields?.length || 0}`);
      return;
    }

    let cancelled = false;
    console.log(`[BoxTreeViewer] Setting isLoading=true for ${key}`);
    setStreamingFieldsMap(prev => {
      const next = new Map(prev);
      next.set(key, {
        headerFields: [],
        entryGroups: new Map(),
        loadingGroups: new Set(),
        isLoading: true,
      });
      return next;
    });

    (async () => {
      try {
        console.log(`[BoxTreeViewer] Loading fields for ${selectedBox.boxType} at offset ${selectedBox.offset}, size ${selectedBox.size}`);
        const result = await wasmWorker.getMp4BoxFields(
          fileId,
          selectedBox.offset,
          selectedBox.size,
          selectedBox.boxType,
          0,
          ITEMS_PER_GROUP
        ) as Mp4BoxFieldsResult;
        console.log(`[BoxTreeViewer] Got fields for ${selectedBox.boxType}:`, result);
        if (cancelled) {
          console.log(`[BoxTreeViewer] Cancelled for ${key}`);
          return;
        }
        console.log(`[BoxTreeViewer] Setting isLoading=false for ${key}, headerFields.length=${result.headerFields?.length || 0}`);
        setStreamingFieldsMap(prev => {
          const next = new Map(prev);
          const existing = next.get(key);
          const entryGroups = new Map(existing?.entryGroups ?? []);
          if (result.entries && result.entries.length > 0) {
            entryGroups.set(0, result.entries);
          }
          next.set(key, {
            headerFields: result.headerFields ?? [],
            entryCount: result.entryCount,
            entryGroups,
            loadingGroups: existing?.loadingGroups ?? new Set(),
            isLoading: false,
          });
          return next;
        });
      } catch (err) {
        console.error(`[BoxTreeViewer] Failed to load fields for ${selectedBox.boxType}:`, err);
        if (!cancelled) {
          // 不删除条目，而是设置为加载失败状态
          setStreamingFieldsMap(prev => {
            const next = new Map(prev);
            next.set(key, {
              headerFields: [],
              entryGroups: new Map(),
              loadingGroups: new Set(),
              isLoading: false, // 设为 false 以停止显示"加载中"
            });
            return next;
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // 移除 streamingFieldsMap 依赖，只在 selectedBox 变化时重新加载
  }, [fileId, getNodeKey, isStreamingMode, selectedBox]);

  const selectedBoxKey = selectedBox ? getNodeKey(selectedBox) : null;
  const streamingFieldState = selectedBoxKey ? streamingFieldsMap.get(selectedBoxKey) : undefined;

  const loadFieldGroup = useCallback((node: Mp4BoxNode, groupIndex: number) => {
    if (!isStreamingMode || !fileId) return;
    const key = getNodeKey(node);
    const state = streamingFieldsMap.get(key);
    if (!state || state.entryGroups.has(groupIndex) || state.loadingGroups.has(groupIndex)) return;

    setStreamingFieldsMap(prev => {
      const next = new Map(prev);
      const current = next.get(key);
      if (!current) return prev;
      const loadingGroups = new Set(current.loadingGroups);
      loadingGroups.add(groupIndex);
      next.set(key, { ...current, loadingGroups });
      return next;
    });

    const start = groupIndex * ITEMS_PER_GROUP;
    const count = ITEMS_PER_GROUP;

    (async () => {
      try {
        const result = await wasmWorker.getMp4BoxFields(
          fileId,
          node.offset,
          node.size,
          node.boxType,
          start,
          count
        ) as Mp4BoxFieldsResult;
        setStreamingFieldsMap(prev => {
          const next = new Map(prev);
          const current = next.get(key);
          if (!current) return prev;
          const entryGroups = new Map(current.entryGroups);
          entryGroups.set(groupIndex, result.entries);
          const loadingGroups = new Set(current.loadingGroups);
          loadingGroups.delete(groupIndex);
          next.set(key, { ...current, entryGroups, loadingGroups });
          return next;
        });
      } catch {
        setStreamingFieldsMap(prev => {
          const next = new Map(prev);
          const current = next.get(key);
          if (!current) return prev;
          const loadingGroups = new Set(current.loadingGroups);
          loadingGroups.delete(groupIndex);
          next.set(key, { ...current, loadingGroups });
          return next;
        });
      }
    })();
  }, [fileId, getNodeKey, isStreamingMode, streamingFieldsMap]);

  // 选中节点时滚动 Hex viewer 到顶部
  useEffect(() => {
    if (selectedBox && hexContainerRef.current && !selectedField) {
      hexContainerRef.current.scrollTop = 0;
    }
  }, [selectedBox, selectedField]);

  // 一键展开/收起所有
  const expandAll = useCallback(() => {
    if (isStreamingMode) return;
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
    collectPaths(treeState.boxes, '');
    setExpandedNodes(allPaths);
  }, [isStreamingMode, treeState]);

  const collapseAll = useCallback(() => {
    setExpandedNodes(new Set());
  }, []);

  // 切换节点展开状态
  const toggleNode = useCallback((path: string) => {
    const isExpanding = !expandedNodes.has(path);
    if (isExpanding) {
      void loadChildrenIfNeeded(path);
    }
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, [expandedNodes, loadChildrenIfNeeded]);

  useEffect(() => {
    if (!isStreamingMode || !fileId) return;
    expandedNodes.forEach(path => {
      const node = findNodeByPath(displayTree.boxes, path);
      if (!node || !node.isContainer) return;
      if (node.children !== undefined) return;
      if (node.childrenCount === 0) return;
      if (loadingNodes.has(path)) return;
      void loadChildrenIfNeeded(path);
    });
  }, [displayTree, expandedNodes, fileId, findNodeByPath, isStreamingMode, loadChildrenIfNeeded, loadingNodes]);

  // 过滤后的 box 树 & 搜索匹配列表
  const { filteredBoxes, matchPaths, searchResults } = useMemo(() => {
    if (isStreamingMode) {
      const activeTree = streamingSearchTree ?? treeState;
      const hasQuery = searchQuery.trim().length > 0;
      return {
        filteredBoxes: activeTree.boxes,
        matchPaths: hasQuery ? streamingMatchPaths : new Set<string>(),
        searchResults: hasQuery
          ? streamingSearchResults.map(path => ({ path }))
          : [] as { path: string; node?: Mp4BoxNode }[],
      };
    }

    if (!searchQuery.trim()) {
      return { filteredBoxes: treeState.boxes, matchPaths: new Set<string>(), searchResults: [] as { path: string; node?: Mp4BoxNode }[] };
    }

    const query = searchQuery.toLowerCase();
    const matchPaths = new Set<string>();
    const results: { path: string; node?: Mp4BoxNode }[] = [];

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

    const filtered = treeState.boxes
      .map((node, idx) => filterNode(node, String(idx)))
      .filter((n): n is Mp4BoxNode => n !== null);

    return { filteredBoxes: filtered, matchPaths, searchResults: results };
  }, [isStreamingMode, streamingSearchTree, streamingMatchPaths, streamingSearchResults, treeState, searchQuery]);

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
          <span className="box-tree-count">共 {displayTree.totalCount} 个 Box</span>
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
            <button
              onClick={expandAll}
              disabled={isStreamingMode}
              title={isStreamingMode ? '流式模式请使用搜索定位' : '展开全部'}
            >
              展开全部
            </button>
            <button onClick={collapseAll} title="收起全部">全部收起</button>
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
                loadingPaths={loadingNodes}
                parentPath=""
              />
            </div>
          </div>

          {/* 右侧: Hex Viewer + 详情 */}
          <div className="box-tree-right">
            {selectedBox ? (
              <>
                {/* Hex Viewer */}
                {fileData ? (
                  <div className="box-hex-panel">
                    <div className="box-hex-header">
                      <span>原始二进制内容</span>
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
                          × 清除选择
                        </button>
                      )}
                    </div>
                    <div className="box-hex-content" ref={hexContainerRef}>
                      <HexView
                        lines={hexData.lines}
                        highlightRanges={highlightRanges}
                      />
                    </div>
                  </div>
                ) : (isStreamingMode && fileId ? (
                  <div className="box-hex-panel">
                    <div className="box-hex-header">
                      <span>原始二进制内容</span>
                      <span className="box-hex-info">
                        {selectedBox.boxType} @ 0x{selectedBox.offset.toString(16).toUpperCase()}
                        ({formatSize(selectedBox.size)}) - 流式按需加载
                      </span>
                      {streamingHexLoading && (
                        <span className="box-hex-info">读取中...</span>
                      )}
                      {streamingHexError && (
                        <span className="box-hex-info">读取失败: {streamingHexError}</span>
                      )}
                      {selectedField && (
                        <button
                          className="hex-clear-selection"
                          onClick={() => setSelectedField(null)}
                          title="清除字段选择"
                        >
                          × 清除选择
                        </button>
                      )}
                    </div>
                    <div className="box-hex-content" ref={hexContainerRef}>
                      {streamingHexData ? (
                        <HexView
                          lines={streamingHexPreview.lines}
                          highlightRanges={highlightRanges}
                        />
                      ) : (
                        <div className="box-hex-placeholder" />
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="box-hex-panel box-hex-panel-disabled">
                    <div className="box-hex-header">
                      <span>原始二进制内容</span>
                      <span className="box-hex-info">流式模式暂不支持 Hex 预览</span>
                    </div>
                    <div className="box-hex-content">
                      <div className="box-hex-placeholder" />
                    </div>
                  </div>
                ))}

                {/* ?情面板 */}
                <BoxDetailPanel
                  node={selectedBox}
                  descriptionMode={descriptionMode}
                  selectedField={selectedField}
                  onFieldSelect={setSelectedField}
                  streamingFieldState={streamingFieldState}
                  onLoadFieldGroup={(groupIndex) => loadFieldGroup(selectedBox, groupIndex)}
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
  highlightRanges: HighlightRange[];
}

function HexView({ lines, highlightRanges }: HexViewProps) {
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
            {line.bytes.length < HEX_BYTES_PER_LINE && (
              <span className="hex-padding">
                {'   '.repeat(HEX_BYTES_PER_LINE - line.bytes.length)}
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
  loadingPaths: Set<string>;
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
  loadingPaths,
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
        const knownChildCount = node.childrenCount;
        const hasChildren = (node.children && node.children.length > 0)
          || (knownChildCount !== undefined ? knownChildCount > 0 : !!node.isContainer);
        const isLoading = loadingPaths.has(path);
        const childrenLoaded = node.children !== undefined;
        const hasLoadedChildren = node.children && node.children.length > 0;
        const isKnownEmpty = knownChildCount === 0;
        const showEmptyState = isKnownEmpty || (childrenLoaded && !hasLoadedChildren);

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
              node.children && node.children.length > 0 ? (
                <BoxNodeList
                  nodes={node.children!}
                  expandedNodes={expandedNodes}
                  selectedNode={selectedNode}
                  matchedPaths={matchedPaths}
                  currentMatchPath={currentMatchPath}
                  descriptionMode={descriptionMode}
                  onToggle={onToggle}
                  onSelect={onSelect}
                  loadingPaths={loadingPaths}
                  parentPath={path}
                />
              ) : (
                <div className="box-node-loading">
                  {isLoading ? '加载中...' : (showEmptyState ? '暂无子节点' : '等待加载...')}
                </div>
              )
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
  streamingFieldState?: StreamingFieldState;
  onLoadFieldGroup?: (groupIndex: number) => void;
}

/** 每组显示的最大条目数 */
const ITEMS_PER_GROUP = 100;

function parseArrayValue(value: string): unknown[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function ArrayValueViewer({ items }: { items: unknown[] }) {
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  const groups: { start: number; end: number; values: unknown[]; index: number }[] = [];
  for (let i = 0; i < items.length; i += ITEMS_PER_GROUP) {
    groups.push({
      start: i,
      end: Math.min(items.length, i + ITEMS_PER_GROUP) - 1,
      values: items.slice(i, i + ITEMS_PER_GROUP),
      index: Math.floor(i / ITEMS_PER_GROUP),
    });
  }

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

  if (items.length <= ITEMS_PER_GROUP) {
    return <span>{JSON.stringify(items)}</span>;
  }

  return (
    <div className="field-groups">
      {groups.map(group => {
        const isExpanded = expandedGroups.has(group.index);
        return (
          <div key={group.index} className="field-group">
            <div
              className="field-group-header"
              onClick={() => toggleGroup(group.index)}
            >
              <span className="group-toggle">{isExpanded ? '▼' : '▶'}</span>
              <span className="group-range">
                [{group.start} - {group.end}]
              </span>
              <span className="group-count">
                ({group.values.length} 条)
              </span>
            </div>
            {isExpanded && (
              <div className="field-group-content">
                {group.values.map((value, idx) => (
                  <div key={idx} className="field-value-item">
                    {Array.isArray(value)
                      ? <ArrayValueViewer items={value} />
                      : <span>{typeof value === 'string' ? value : JSON.stringify(value)}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function BoxDetailPanel({
  node,
  descriptionMode,
  selectedField,
  onFieldSelect,
  streamingFieldState,
  onLoadFieldGroup
}: BoxDetailPanelProps) {
  // 多级分组展开状态 - 使用 group ID 而不是索引
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setExpandedGroupIds(new Set()); // 重置展开状态
  }, [node.boxType, node.offset, node.size]);

  const handleFieldClick = (field: BoxField) => {
    if (field.offset !== undefined && field.size !== undefined) {
      if (selectedField === field) {
        onFieldSelect(null);
      } else {
        onFieldSelect(field);
      }
    }
  };

  const toggleGroupNode = (groupId: string, group?: GroupNode) => {
    setExpandedGroupIds(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
        // 如果是流式模式的叶子节点，触发数据加载
        if (group?.isLeaf && streamingFieldState && onLoadFieldGroup) {
          const [start] = group.range;
          const groupIndex = Math.floor(start / ITEMS_PER_GROUP);
          if (!streamingFieldState.entryGroups.has(groupIndex)) {
            onLoadFieldGroup(groupIndex);
          }
        }
      }
      return next;
    });
  };

  const headerFields = streamingFieldState?.headerFields ?? node.fields;

  // 调试日志
  if (streamingFieldState) {
    console.log(`[BoxDetailPanel] Rendering ${node.boxType}:`, {
      isLoading: streamingFieldState.isLoading,
      headerFieldsLength: streamingFieldState.headerFields?.length || 0,
      nodeFieldsLength: node.fields?.length || 0,
      finalHeaderFieldsLength: headerFields?.length || 0
    });
  }

  // 动态多级分组数据结构
  interface GroupNode {
    id: string;
    range: [number, number];
    level: number;
    isLeaf: boolean;
    children?: GroupNode[];
    entries?: BoxField[];
    loaded?: boolean;
  }

  // 计算需要的层级深度
  const calculateDepth = (totalItems: number, itemsPerGroup: number = ITEMS_PER_GROUP): number => {
    if (totalItems <= itemsPerGroup) return 0;
    return Math.ceil(Math.log(totalItems) / Math.log(itemsPerGroup));
  };

  // 递归生成分组树
  const buildGroupTree = useCallback((
    startIndex: number,
    endIndex: number,
    level: number,
    parentId: string = ''
  ): GroupNode[] => {
    const totalItems = endIndex - startIndex + 1;

    // 如果项目数小于等于阈值，这是叶子节点
    if (totalItems <= ITEMS_PER_GROUP) {
      return [{
        id: `${parentId}-leaf-${startIndex}`,
        range: [startIndex, endIndex],
        level,
        isLeaf: true,
        loaded: false,
      }];
    }

    // 需要分组
    const groups: GroupNode[] = [];
    const itemsPerSubGroup = Math.pow(ITEMS_PER_GROUP, level);

    for (let i = startIndex; i <= endIndex; i += itemsPerSubGroup) {
      const subEnd = Math.min(i + itemsPerSubGroup - 1, endIndex);
      const groupId = `${parentId}-${level}-${i}`;

      groups.push({
        id: groupId,
        range: [i, subEnd],
        level,
        isLeaf: false,
        children: buildGroupTree(i, subEnd, level - 1, groupId),
      });
    }

    return groups;
  }, []);

  // 为流式模式生成分组树
  const streamingGroupTree = useMemo(() => {
    if (!streamingFieldState?.entryCount || streamingFieldState.entryCount <= ITEMS_PER_GROUP) {
      return null;
    }

    const depth = calculateDepth(streamingFieldState.entryCount);
    return buildGroupTree(0, streamingFieldState.entryCount - 1, depth);
  }, [buildGroupTree, streamingFieldState?.entryCount]);

  // 为非流式模式生成分组树
  const fieldGroupTree = useMemo(() => {
    if (!node.fields || node.fields.length <= ITEMS_PER_GROUP) {
      return null;
    }

    const depth = calculateDepth(node.fields.length);
    const tree = buildGroupTree(0, node.fields.length - 1, depth);

    // 预加载所有叶子节点的数据（非流式模式）
    const loadLeafData = (nodes: GroupNode[]) => {
      nodes.forEach(node => {
        if (node.isLeaf && !node.loaded) {
          const [start, end] = node.range;
          node.entries = (headerFields || []).slice(start, end + 1);
          node.loaded = true;
        } else if (node.children) {
          loadLeafData(node.children);
        }
      });
    };

    loadLeafData(tree);
    return tree;
  }, [buildGroupTree, headerFields, node.fields]);

  // 渲染字段表格（需要在 renderGroupTree 之前定义）
  const renderFieldsTable = useCallback((fields: BoxField[], keyPrefix: string = '') => (
    <table>
      <thead>
        <tr>
          <th>字段名</th>
          <th>值</th>
          <th>偏移</th>
          {descriptionMode === 'always' && <th>说明</th>}
          {descriptionMode === 'hover' && <th></th>}
        </tr>
      </thead>
      <tbody>
        {fields.map((field, index) => {
          const isClickable = field.offset !== undefined && field.size !== undefined;
          const isSelected = selectedField === field;
          const arrayValue = parseArrayValue(field.value);

          return (
            <tr
              key={keyPrefix + index}
              className={`${isClickable ? 'clickable' : ''} ${isSelected ? 'selected' : ''}`}
              onClick={() => isClickable && handleFieldClick(field)}
              title={descriptionMode === 'hover' ? field.description : undefined}
            >
              <td className="field-name">{field.name}</td>
              <td className="field-value">
                {arrayValue ? <ArrayValueViewer items={arrayValue} /> : field.value}
              </td>
              <td className="field-offset">
                {field.offset !== undefined && field.size !== undefined ? (
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
  ), [descriptionMode, handleFieldClick, selectedField]);

  // 递归渲染分组树
  const renderGroupTree = useCallback((
    groups: GroupNode[],
    depth: number = 0
  ): React.ReactNode => {
    return groups.map(group => {
      const isExpanded = expandedGroupIds.has(group.id);
      const [start, end] = group.range;
      const itemCount = end - start + 1;

      // 渲染叶子节点（实际数据）
      if (group.isLeaf) {
        // 获取条目数据
        let entries: BoxField[] | undefined;

        if (group.entries) {
          // 非流式模式：已预加载
          entries = group.entries;
        } else if (streamingFieldState) {
          // 流式模式：从缓存获取
          const groupIndex = Math.floor(start / ITEMS_PER_GROUP);
          entries = streamingFieldState.entryGroups.get(groupIndex);
        }

        const isLoading = streamingFieldState?.loadingGroups.has(Math.floor(start / ITEMS_PER_GROUP));

        return (
          <div key={group.id} className="field-group" style={{ marginLeft: `${depth * 20}px` }}>
            <div
              className="field-group-header"
              onClick={() => toggleGroupNode(group.id, group)}
              style={{ cursor: 'pointer' }}
            >
              <span className="group-toggle">{isExpanded ? '▼' : '▶︎'}</span>
              <span className="group-title">
                条目 [{start.toLocaleString()} - {end.toLocaleString()}]
                <span className="group-count">({itemCount} 项)</span>
              </span>
              {isLoading && <span className="group-loading">加载中...</span>}
            </div>
            {isExpanded && entries && entries.length > 0 && (
              <div className="field-group-content">
                {renderFieldsTable(entries, `${group.id}-`)}
              </div>
            )}
            {isExpanded && (!entries || entries.length === 0) && !isLoading && (
              <div className="field-group-empty">暂无数据</div>
            )}
          </div>
        );
      }

      // 渲染中间节点（分组）
      return (
        <div key={group.id} className="field-supergroup" style={{ marginLeft: `${depth * 20}px` }}>
          <div
            className="field-supergroup-header"
            onClick={() => toggleGroupNode(group.id)}
            style={{ cursor: 'pointer', fontWeight: 600 - depth * 100 }}
          >
            <span className="group-toggle">{isExpanded ? '▼' : '▶︎'}</span>
            <span className="group-title">
              范围 [{start.toLocaleString()} - {end.toLocaleString()}]
              <span className="group-count">({itemCount.toLocaleString()} 项)</span>
            </span>
          </div>
          {isExpanded && group.children && (
            <div className="field-supergroup-content">
              {renderGroupTree(group.children, depth + 1)}
            </div>
          )}
        </div>
      );
    });
  }, [expandedGroupIds, renderFieldsTable, streamingFieldState, toggleGroupNode]);

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

      {!streamingFieldState && node.fields && node.fields.length > 0 && (
        <div className="box-detail-fields">
          <h5>
            字段详情 ({node.fields.length} 条)
            <span className="field-hint">(点击可高亮)</span>
          </h5>

          {fieldGroupTree ? (
            // 多级分组显示
            <div className="field-groups">
              {renderGroupTree(fieldGroupTree)}
            </div>
          ) : (
            // 不需要分组，直接显示
            renderFieldsTable(node.fields)
          )}
        </div>
      )}

      {streamingFieldState && (
        <>
          {streamingFieldState.isLoading && headerFields && headerFields.length === 0 && (
            <div className="box-detail-fields">
              <div className="field-loading">字段加载中...</div>
            </div>
          )}
          {headerFields && headerFields.length > 0 && (
            <div className="box-detail-fields">
              <h5>
                字段详情 ({headerFields.length} 条)
                <span className="field-hint">(点击可高亮)</span>
              </h5>
              {renderFieldsTable(headerFields)}
            </div>
          )}
          {streamingGroupTree && (
            <div className="box-detail-fields">
              <h5>
                条目列表 ({streamingFieldState.entryCount?.toLocaleString() || 0} 条)
                <span className="field-hint">(多级分组)</span>
              </h5>
              <div className="field-groups">
                {renderGroupTree(streamingGroupTree)}
              </div>
            </div>
          )}
          {!streamingFieldState.isLoading
            && (!headerFields || headerFields.length === 0)
            && !streamingGroupTree && (
              <div className="box-detail-fields">
                <div className="field-group-empty">暂无可显示的字段信息</div>
              </div>
            )}
        </>
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
