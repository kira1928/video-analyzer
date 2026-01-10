import { useTimelineChart } from '../hooks/useTimelineChart';
import { TagSummary } from '../types';
import './TimelineChart.css';

interface TimelineChartProps {
  tags: TagSummary[];
  onTagSelect?: (tag: TagSummary) => void;
}

/**
 * 时间戳分布图表组件
 * X 轴：文件偏移 (offset)
 * Y 轴：时间戳 (ms)
 */
export function TimelineChart({ tags, onTagSelect }: TimelineChartProps) {
  const { canvasRef, tooltipRef, zoomIn, zoomOut, resetView } = useTimelineChart({
    tags,
    onTagSelect,
  });

  return (
    <div className="chart-container">
      <div className="chart-header">
        <h3>📊 时间戳分布</h3>
        <div className="chart-legend">
          <div className="chart-legend-item chart-legend-video">▲ 视频 DTS</div>
          <div className="chart-legend-item chart-legend-audio">+ 音频 DTS</div>
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
