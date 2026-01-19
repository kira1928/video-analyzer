/**
 * 内存调试面板组件
 * 
 * 显示当前内存使用情况，帮助优化性能
 */

import React, { useState, useEffect, useCallback } from 'react';
import { getMemoryStats, formatMemorySize, clearAllCaches, MemoryStats } from '../utils/memoryDebug';
import './DebugPanel.css';

interface DebugPanelProps {
  /** 当前文件大小（字节） */
  currentFileSize?: number;
  /** 是否流式模式 */
  isStreamingMode?: boolean;
  /** fileData 大小（字节） */
  fileDataSize?: number;
  /** 缓存清除后的回调 */
  onCacheCleared?: () => void;
}

export const DebugPanel: React.FC<DebugPanelProps> = ({
  currentFileSize,
  isStreamingMode,
  fileDataSize,
  onCacheCleared,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [isClearing, setIsClearing] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  // 获取内存统计
  const refreshStats = useCallback(async () => {
    const newStats = await getMemoryStats({
      currentFileSize,
      isStreamingMode,
      fileDataSize,
    });
    setStats(newStats);
    setLastUpdate(new Date());
  }, [currentFileSize, isStreamingMode, fileDataSize]);

  // 自动刷新
  useEffect(() => {
    if (isExpanded) {
      refreshStats();
      const interval = setInterval(refreshStats, 2000); // 每2秒刷新
      return () => clearInterval(interval);
    }
  }, [isExpanded, refreshStats]);

  // 清除所有缓存
  const handleClearAll = async () => {
    if (!confirm('确定要清除所有缓存吗？包括 IndexedDB、OPFS 和浏览器缓存。')) {
      return;
    }

    setIsClearing(true);
    try {
      const results = await clearAllCaches();
      console.log('缓存清除结果:', results);

      await refreshStats();
      onCacheCleared?.();

      alert('缓存已清除！');
    } catch (e) {
      alert('清除缓存失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setIsClearing(false);
    }
  };

  // 强制 GC（如果可用）
  const handleForceGC = () => {
    if ((window as any).gc) {
      (window as any).gc();
      alert('GC 已执行（需要 Chrome --js-flags="--expose-gc"）');
      refreshStats();
    } else {
      alert('GC 不可用。需要使用 Chrome --js-flags="--expose-gc" 启动。');
    }
  };

  if (!isExpanded) {
    return (
      <button
        className="debug-panel-toggle"
        onClick={() => setIsExpanded(true)}
        title="打开调试面板"
      >
        🔧
      </button>
    );
  }

  return (
    <div className="debug-panel">
      <div className="debug-panel-header">
        <span>🔧 调试面板</span>
        <button onClick={() => setIsExpanded(false)} title="关闭">×</button>
      </div>

      <div className="debug-panel-content">
        {stats ? (
          <>
            <div className="debug-section">
              <h4>内存使用</h4>
              <div className="debug-row">
                <span>JS Heap:</span>
                <span className={stats.jsHeapUsed > 500 ? 'warning' : ''}>
                  {formatMemorySize(stats.jsHeapUsed)} / {formatMemorySize(stats.jsHeapTotal)}
                </span>
              </div>
              <div className="debug-row">
                <span>ArrayBuffer 估计:</span>
                <span>{formatMemorySize(stats.arrayBufferEstimate)}</span>
              </div>
            </div>

            <div className="debug-section">
              <h4>存储</h4>
              <div className="debug-row">
                <span>IndexedDB:</span>
                <span>{formatMemorySize(stats.indexedDBSize)}</span>
              </div>
            </div>

            <div className="debug-section">
              <h4>当前文件</h4>
              <div className="debug-row">
                <span>文件大小:</span>
                <span>{stats.currentFileSize ? formatMemorySize(stats.currentFileSize / (1024 * 1024)) : 'N/A'}</span>
              </div>
              <div className="debug-row">
                <span>解析模式:</span>
                <span className={stats.isStreamingMode ? 'streaming' : ''}>
                  {stats.isStreamingMode ? '🌊 流式' : '📦 完整加载'}
                </span>
              </div>
            </div>

            <div className="debug-section">
              <div className="debug-row">
                <span>最后更新:</span>
                <span>{lastUpdate?.toLocaleTimeString()}</span>
              </div>
            </div>
          </>
        ) : (
          <div className="debug-loading">加载中...</div>
        )}

        <div className="debug-actions">
          <button onClick={refreshStats} disabled={isClearing}>
            🔄 刷新
          </button>
          <button onClick={handleClearAll} disabled={isClearing}>
            {isClearing ? '清除中...' : '🗑️ 清除所有缓存'}
          </button>
          <button onClick={handleForceGC} disabled={isClearing}>
            🧹 强制 GC
          </button>
        </div>
      </div>
    </div>
  );
};
