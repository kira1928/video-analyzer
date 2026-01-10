import { useRef, useEffect, useState, useCallback } from 'react';
import { TagSummary } from '../types';
import { formatTimestamp, formatOffset, formatBytes } from '../utils/format';

/** 图表状态 */
interface ChartState {
  offsetX: number;
  offsetY: number;
  zoom: number;
  isDragging: boolean;
  dragStartX: number;
  dragStartY: number;
  dragStartOffsetX: number;
  dragStartOffsetY: number;
  hoveredTagIndex: number | null;
  selectedTagIndex: number | null;
}

/** 图表 Hook 参数 */
interface UseTimelineChartParams {
  tags: TagSummary[];
  onTagSelect?: (tag: TagSummary) => void;
}

/**
 * 时间戳分布图表 Hook
 * 实现缩放、拖拽、悬停高亮等交互功能
 */
export function useTimelineChart({ tags, onTagSelect }: UseTimelineChartParams) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const [state, setState] = useState<ChartState>({
    offsetX: 60,
    offsetY: 60,
    zoom: 1,
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    dragStartOffsetX: 0,
    dragStartOffsetY: 0,
    hoveredTagIndex: null,
    selectedTagIndex: null,
  });

  // 重置视图
  const resetView = useCallback(() => {
    if (tags.length === 0 || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const width = canvas.offsetWidth;
    const height = canvas.offsetHeight;
    const padding = 60;

    const minX = Math.min(...tags.map(t => t.offset));
    const maxX = Math.max(...tags.map(t => t.offset + t.size));
    const minY = Math.min(...tags.map(t => t.timestamp));
    const maxY = Math.max(...tags.map(t => t.timestamp));

    const dataWidth = maxX - minX || 1;
    const dataHeight = maxY - minY || 1;

    const scaleX = (width - 2 * padding) / dataWidth;
    const scaleY = (height - 2 * padding) / dataHeight;
    const scale = Math.min(scaleX, scaleY);

    setState(prev => ({
      ...prev,
      zoom: scale,
      offsetX: padding - minX * scale,
      offsetY: padding - minY * scale,
    }));
  }, [tags]);

  // 缩放
  const zoomIn = useCallback(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const centerX = canvas.offsetWidth / 2;
    const centerY = canvas.offsetHeight / 2;

    setState(prev => {
      const newZoom = prev.zoom * 1.5;
      return {
        ...prev,
        zoom: newZoom,
        offsetX: centerX - (centerX - prev.offsetX) * (newZoom / prev.zoom),
        offsetY: centerY - (centerY - prev.offsetY) * (newZoom / prev.zoom),
      };
    });
  }, []);

  const zoomOut = useCallback(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const centerX = canvas.offsetWidth / 2;
    const centerY = canvas.offsetHeight / 2;

    setState(prev => {
      const newZoom = Math.max(0.001, prev.zoom / 1.5);
      return {
        ...prev,
        zoom: newZoom,
        offsetX: centerX - (centerX - prev.offsetX) * (newZoom / prev.zoom),
        offsetY: centerY - (centerY - prev.offsetY) * (newZoom / prev.zoom),
      };
    });
  }, []);

  // 绘制图表
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.offsetWidth;
    const height = canvas.offsetHeight;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // 背景
    ctx.fillStyle = '#334155';
    ctx.fillRect(0, 0, width, height);

    if (tags.length === 0) return;

    const { zoom, offsetX, offsetY, hoveredTagIndex, selectedTagIndex } = state;

    // 绘制网格
    drawGrid(ctx, width, height, zoom, offsetX, offsetY);

    // 计算标记大小
    const markerSize = Math.max(3, Math.min(8, zoom * 1000));
    const simplified = markerSize < 5;

    // 绘制标签点
    tags.forEach((tag, index) => {
      const screenX = tag.offset * zoom + offsetX;
      const screenY = tag.timestamp * zoom + offsetY;

      // 视口裁剪
      if (screenX < -20 || screenX > width + 20 || screenY < -20 || screenY > height + 20) {
        return;
      }

      const isHovered = hoveredTagIndex === index;
      const isSelected = selectedTagIndex === index;
      const size = isHovered || isSelected ? markerSize * 1.5 : markerSize;

      if (tag.type === 'video') {
        // 视频：橙色三角形
        ctx.fillStyle = isSelected ? '#fbbf24' : (isHovered ? '#fcd34d' : '#f59e0b');
        if (simplified) {
          ctx.beginPath();
          ctx.arc(screenX, screenY, size / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          drawTriangle(ctx, screenX, screenY, size);
        }
      } else if (tag.type === 'audio') {
        // 音频：蓝色十字
        ctx.strokeStyle = isSelected ? '#60a5fa' : (isHovered ? '#93c5fd' : '#3b82f6');
        ctx.lineWidth = simplified ? 1 : 2;
        if (simplified) {
          ctx.beginPath();
          ctx.arc(screenX, screenY, size / 2, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          drawCross(ctx, screenX, screenY, size);
        }
      } else {
        // 脚本：黄色方块
        ctx.fillStyle = '#eab308';
        ctx.fillRect(screenX - size / 2, screenY - size / 2, size, size);
      }
    });

    // 绘制选中高亮
    if (selectedTagIndex !== null && tags[selectedTagIndex]) {
      const tag = tags[selectedTagIndex];
      const screenX = tag.offset * zoom + offsetX;
      const screenY = tag.timestamp * zoom + offsetY;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(screenX, screenY, markerSize * 2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [tags, state]);

  // 初始化和更新图表
  useEffect(() => {
    resetView();
  }, [tags, resetView]);

  useEffect(() => {
    draw();
  }, [draw]);

  // 事件处理
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // 滚轮缩放
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;

      setState(prev => {
        const newZoom = Math.max(0.1, Math.min(50, prev.zoom * zoomFactor));
        const scaleChange = newZoom / prev.zoom;
        return {
          ...prev,
          zoom: newZoom,
          offsetX: mouseX - (mouseX - prev.offsetX) * scaleChange,
          offsetY: mouseY - (mouseY - prev.offsetY) * scaleChange,
        };
      });
    };

    // 鼠标按下
    const handleMouseDown = (e: MouseEvent) => {
      setState(prev => ({
        ...prev,
        isDragging: true,
        dragStartX: e.clientX,
        dragStartY: e.clientY,
        dragStartOffsetX: prev.offsetX,
        dragStartOffsetY: prev.offsetY,
      }));
      canvas.style.cursor = 'grabbing';
    };

    // 鼠标移动
    const handleMouseMove = (e: MouseEvent) => {
      setState(prev => {
        if (prev.isDragging) {
          return {
            ...prev,
            offsetX: prev.dragStartOffsetX + (e.clientX - prev.dragStartX),
            offsetY: prev.dragStartOffsetY + (e.clientY - prev.dragStartY),
          };
        }

        // 悬停检测
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        let nearestIndex: number | null = null;
        let nearestDist = 20;

        tags.forEach((tag, index) => {
          const screenX = tag.offset * prev.zoom + prev.offsetX;
          const screenY = tag.timestamp * prev.zoom + prev.offsetY;
          const dist = Math.sqrt(Math.pow(mouseX - screenX, 2) + Math.pow(mouseY - screenY, 2));

          if (dist < nearestDist) {
            nearestDist = dist;
            nearestIndex = index;
          }
        });

        // 更新 tooltip
        if (nearestIndex !== null && tooltipRef.current) {
          const tag = tags[nearestIndex];
          tooltipRef.current.innerHTML = `
            <div><strong>${tag.type === 'video' ? '视频' : tag.type === 'audio' ? '音频' : '脚本'} #${tag.index}</strong></div>
            <div>时间: ${formatTimestamp(tag.timestamp)}</div>
            <div>偏移: ${formatOffset(tag.offset)}</div>
            <div>大小: ${formatBytes(tag.size)}</div>
            ${tag.isKeyframe ? '<div style="color: #22c55e;">● 关键帧</div>' : ''}
          `;
          tooltipRef.current.style.left = `${e.clientX + 15}px`;
          tooltipRef.current.style.top = `${e.clientY + 15}px`;
          tooltipRef.current.classList.add('visible');
        } else if (tooltipRef.current) {
          tooltipRef.current.classList.remove('visible');
        }

        if (nearestIndex !== prev.hoveredTagIndex) {
          return { ...prev, hoveredTagIndex: nearestIndex };
        }
        return prev;
      });
    };

    // 鼠标松开
    const handleMouseUp = () => {
      setState(prev => ({ ...prev, isDragging: false }));
      canvas.style.cursor = 'grab';
    };

    // 鼠标离开
    const handleMouseLeave = () => {
      setState(prev => ({ ...prev, isDragging: false, hoveredTagIndex: null }));
      canvas.style.cursor = 'grab';
      if (tooltipRef.current) {
        tooltipRef.current.classList.remove('visible');
      }
    };

    // 点击选中
    const handleClick = () => {
      setState(prev => {
        if (prev.hoveredTagIndex !== null) {
          const tag = tags[prev.hoveredTagIndex];
          onTagSelect?.(tag);
          return { ...prev, selectedTagIndex: prev.hoveredTagIndex };
        }
        return prev;
      });
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('mouseleave', handleMouseLeave);
    canvas.addEventListener('click', handleClick);

    return () => {
      canvas.removeEventListener('wheel', handleWheel);
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseup', handleMouseUp);
      canvas.removeEventListener('mouseleave', handleMouseLeave);
      canvas.removeEventListener('click', handleClick);
    };
  }, [tags, onTagSelect]);

  return {
    canvasRef,
    tooltipRef,
    zoomIn,
    zoomOut,
    resetView,
    selectedTag: state.selectedTagIndex !== null ? tags[state.selectedTagIndex] : null,
  };
}

// 辅助绘制函数
function drawGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  zoom: number,
  offsetX: number,
  offsetY: number
) {
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 0.5;
  ctx.font = '10px Inter, sans-serif';
  ctx.fillStyle = '#94a3b8';

  const gridStepX = calculateGridStep(width / zoom);
  const gridStepY = calculateGridStep(height / zoom);

  // Y 轴网格
  const startY = Math.floor(-offsetY / zoom / gridStepY) * gridStepY;
  const endY = Math.ceil((height - offsetY) / zoom / gridStepY) * gridStepY;

  for (let y = startY; y <= endY; y += gridStepY) {
    const screenY = y * zoom + offsetY;
    if (screenY < 20 || screenY > height - 10) continue;

    ctx.beginPath();
    ctx.moveTo(50, screenY);
    ctx.lineTo(width, screenY);
    ctx.stroke();

    ctx.fillText(`${(y / 1000).toFixed(1)}s`, 5, screenY + 3);
  }

  // X 轴网格
  const startX = Math.floor(-offsetX / zoom / gridStepX) * gridStepX;
  const endX = Math.ceil((width - offsetX) / zoom / gridStepX) * gridStepX;

  for (let x = startX; x <= endX; x += gridStepX) {
    const screenX = x * zoom + offsetX;
    if (screenX < 50 || screenX > width - 10) continue;

    ctx.beginPath();
    ctx.moveTo(screenX, 0);
    ctx.lineTo(screenX, height - 20);
    ctx.stroke();

    ctx.fillText(formatOffset(x), screenX - 15, height - 5);
  }

  // 坐标轴标签
  ctx.fillStyle = '#f59e0b';
  ctx.fillText('(ms)', 5, 15);
  ctx.fillStyle = '#3b82f6';
  ctx.fillText('pos (offset)', width - 70, height - 5);
}

function calculateGridStep(range: number): number {
  const rawStep = range / 8;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;

  if (normalized < 1.5) return magnitude;
  if (normalized < 3) return 2 * magnitude;
  if (normalized < 7) return 5 * magnitude;
  return 10 * magnitude;
}

function drawTriangle(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.beginPath();
  ctx.moveTo(x, y - size);
  ctx.lineTo(x - size * 0.866, y + size * 0.5);
  ctx.lineTo(x + size * 0.866, y + size * 0.5);
  ctx.closePath();
  ctx.fill();
}

function drawCross(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.beginPath();
  ctx.moveTo(x - size, y);
  ctx.lineTo(x + size, y);
  ctx.moveTo(x, y - size);
  ctx.lineTo(x, y + size);
  ctx.stroke();
}
