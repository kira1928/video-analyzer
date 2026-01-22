import { useState } from 'react';
import { AnalysisResult, SegmentInfo } from '../types';
import { formatDuration } from '../utils/format';
import { splitFlvSegment, splitMp4Segment, splitMp4SegmentStreaming } from '../utils/wasm';
import './SegmentPanel.css';

interface SegmentPanelProps {
  result: AnalysisResult;
  fileData: Uint8Array | null;
  currentFile?: File | null;
  fileId?: string;  // 流式模式需要
  isStreamingMode?: boolean;  // 是否为流式模式
  onExportSegment?: (segmentIndex: number) => void;
}

export function SegmentPanel({ result, fileData, currentFile, fileId, isStreamingMode, onExportSegment }: SegmentPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [exportingIndex, setExportingIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const segments = result.segments;
  if (!segments || !segments.needsSplit) {
    return null;
  }

  const format = (result.format || '').toLowerCase();
  const isFlv = format === 'flv';
  const isMp4 = format === 'mp4';

  const handleExport = async (e: React.MouseEvent, index: number) => {
    e.stopPropagation();

    let data = fileData;
    if (!data) {
      if (!currentFile) {
        setError('无法导出：需要完整文件数据');
        return;
      }
      const buffer = await currentFile.arrayBuffer();
      data = new Uint8Array(buffer);
    }

    try {
      setExportingIndex(index);
      setError(null);

      // 给 UI 渲染时间
      await new Promise(resolve => setTimeout(resolve, 50));

      let outputData: Uint8Array;
      if (!isFlv && !isMp4) {
        throw new Error('暂不支持当前格式导出');
      }

      if (isFlv) {
        const resultJson = JSON.stringify(result);
        outputData = splitFlvSegment(data, resultJson, index);
      } else {
        // MP4: 流式模式下使用 splitMp4SegmentStreaming
        if (isStreamingMode && fileId) {
          console.log(`[SegmentPanel] 使用流式导出: fileId=${fileId}, dataSize=${data.length}, segmentIndex=${index}`);
          console.log(`[SegmentPanel] result.segments:`, result.segments);
          outputData = splitMp4SegmentStreaming(fileId, data, index);
        } else {
          console.log(`[SegmentPanel] 使用标准导出: dataSize=${data.length}, segmentIndex=${index}, tagsCount=${result.tags?.length || 0}`);
          const resultJson = JSON.stringify(result);
          outputData = splitMp4Segment(data, resultJson, index);
        }
      }

      // 创建下载
      // @ts-ignore
      const blob = new Blob([outputData], { type: isFlv ? 'video/x-flv' : 'video/mp4' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `segment_${index + 1}.${isFlv ? 'flv' : 'mp4'}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (onExportSegment) onExportSegment(index);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExportingIndex(null);
    }
  };

  return (
    <div className={`segment-panel ${isExpanded ? 'expanded' : ''}`}>
      <div
        className="segment-header"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="segment-title">
          <span className="warning-icon">⚠️</span>
          <span>检测到编码参数变化，建议分割为 {segments.totalSegments} 个文件</span>
        </div>
        <button className="toggle-btn">
          {isExpanded ? '收起' : '详细'}
        </button>
      </div>

      {isExpanded && (
        <div className="segment-content">
          {error && <div className="segment-error">{error}</div>}

          <div className="segment-list">
            {segments.segments.map((seg) => (
              <div key={seg.index} className="segment-item">
                <div className="segment-info">
                  <div className="segment-main-info">
                    <span className="segment-index">分段 #{seg.index + 1}</span>
                    <span className="segment-duration">{formatDuration(seg.duration)}</span>
                  </div>
                  <div className="segment-details">
                    <span>Tag {seg.startTagIndex} - {seg.endTagIndex}</span>
                    <span className="segment-reason">({seg.reason})</span>
                  </div>
                  {!seg.startsWithKeyframe && (
                    <div className="segment-warning">
                      ⚠️ 非关键帧开始，可能会花屏
                    </div>
                  )}
                </div>

                <button
                  className="export-btn"
                  onClick={(e) => handleExport(e, seg.index)}
                  disabled={exportingIndex !== null || (!fileData && !currentFile) || (!isFlv && !isMp4)}
                  title={(!isFlv && !isMp4) ? '目前只支持 FLV/MP4 导出' : '导出该分段'}
                >
                  {!isFlv && !isMp4 ? '不支持导出' : (exportingIndex === seg.index ? '正在导出...' : (isMp4 ? '导出 MP4' : '导出 FLV'))}
                </button>
              </div>
            ))}
          </div>

          {segments.warnings && segments.warnings.length > 0 && (
            <div className="segment-global-warnings">
              <h4>注意事项：</h4>
              <ul>
                {segments.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
