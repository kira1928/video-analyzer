import { useMemo } from 'react';
import { useTimelineChart } from '../hooks/useTimelineChart';
import { TagSummary } from '../types';
import './TimelineChart.css';

interface TimelineChartProps {
  tags: TagSummary[];
  onTagSelect?: (tag: TagSummary) => void;
}

// 最大渲染点数，超过则采样
const MAX_RENDER_POINTS = 50000;

/**
 * 时间戳分布图表组件
 * X 轴：文件偏移 (offset)
 * Y 轴：时间戳 (ms)
 */
export function TimelineChart({ tags, onTagSelect }: TimelineChartProps) {
  // 如果数据量太大，进行采样
  const { sampledTags, isSampled, sampleRate } = useMemo(() => {
    if (tags.length <= MAX_RENDER_POINTS) {
      return { sampledTags: tags, isSampled: false, sampleRate: 1 };
    }

    // 计算采样率
    const rate = Math.ceil(tags.length / MAX_RENDER_POINTS);
    const sampled: TagSummary[] = [];

    // 均匀采样，但保留所有关键帧
    for (let i = 0; i < tags.length; i++) {
      if (tags[i].isKeyframe || i % rate === 0) {
        sampled.push(tags[i]);
      }
    }

    console.log(`TimelineChart: 采样 ${tags.length} -> ${sampled.length} 点 (rate: 1/${rate})`);
    return { sampledTags: sampled, isSampled: true, sampleRate: rate };
  }, [tags]);

  const { canvasRef, tooltipRef, zoomIn, zoomOut, resetView } = useTimelineChart({
    tags: sampledTags,
    onTagSelect,
  });

  return (
    <div className="chart-container">
      <div className="chart-header">
        <h3>📊 时间戳分布</h3>
        <div className="chart-legend">
          <div className="chart-legend-item chart-legend-video">▲ 视频 DTS</div>
          <div className="chart-legend-item chart-legend-audio">+ 音频 DTS</div>
          {isSampled && (
            <div className="chart-legend-item chart-sampled" title={`原始 ${tags.length} 点，采样后 ${sampledTags.length} 点`}>
              ⚡ 已采样 (1/{sampleRate})
            </div>
          )}
        </div>
        <div className="chart-controls">
          <button className="btn btn-secondary" onClick={zoomIn}>🔍+</button>
          <button className="btn btn-secondary" onClick={zoomOut}>🔍-</button>
          <button className="btn btn-secondary" onClick={resetView}>⟲ 重置</button>
        </div>
      </div>
      <div className="chart-wrapper">
        <canvas ref={canvasRef} className="timeline-canvas" />
        <div ref={tooltipRef} className="chart-tooltip" />
      </div>
      <div className="chart-hint">💡 鼠标滚轮缩放，拖拽移动，点击选中标签</div>
    </div>
  );
}
