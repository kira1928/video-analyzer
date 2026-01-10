# Video Analyzer - 项目级 AI 规则

> **⚠️ AI 注意事项**：如果你修改了项目结构（添加/删除/移动文件或目录），请同步更新本文档中的「目录结构」章节，以及 `README.md` 中的相应部分。

> **📝 文档同步要求**：以下修改需要同步更新本文档：
> - **修改项目结构**：更新「目录结构」章节和 `README.md`
> - **修改 `Makefile`**：更新「构建命令」章节
> - **修改 WASM 导出接口** (`src/lib.rs`)：更新「WASM 导出接口」章节
> - **添加新功能或重大变更**：更新「版本历史」章节

## 项目概述

这是一个用于分析 FLV 视频文件的 Web 工具，使用 **Rust + WASM** 实现核心分析逻辑，前端使用 React + TypeScript。

**技术栈**：
- **后端/核心逻辑**: Rust + wasm-bindgen
- **前端**: React 18 + TypeScript + Vite 5
- **WASM 构建**: wasm-pack

## 目录结构

```
video-analyzer/
├── Cargo.toml          # Rust 项目配置
├── src/                # Rust 源码
│   ├── lib.rs          # WASM 导出接口
│   ├── flv/            # FLV 解析模块
│   │   ├── mod.rs
│   │   ├── reader.rs   # FLV 读取器
│   │   └── tag.rs      # Tag 定义和解析
│   ├── analyzer.rs     # 分析器（GOP 分析、Tag 详情、Hex dump）
│   ├── hevc.rs         # HEVC 工具（Annex B/HVCC 转换）
│   └── types.rs        # 共享类型定义
├── web-src/            # 前端 TypeScript 源码
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── types/      # TypeScript 类型定义
│   │   ├── utils/      # 工具函数（WASM 加载器）
│   │   ├── hooks/      # React Hooks
│   │   ├── components/ # React 组件
│   │   └── styles/     # CSS 样式
│   ├── index.html
│   ├── vite.config.ts
│   └── package.json
├── web/                # 构建输出目录
│   ├── pkg/            # wasm-pack 输出
│   │   ├── video_analyzer.js
│   │   ├── video_analyzer.d.ts
│   │   └── video_analyzer_bg.wasm
│   ├── index.html
│   └── assets/
└── Makefile
```

## 构建命令

```bash
# 构建 WASM 模块 (使用 wasm-pack)
make build-wasm

# 安装前端依赖
make install-web

# 构建前端
make build-web

# 完整构建 (WASM + 前端)
make all

# 启动前端开发服务器 (需先 build-wasm)
make dev

# 清理构建产物
make clean
```

## 开发工作流

### 前端开发

```bash
# 1. 安装依赖 (首次)
make install-web

# 2. 构建 WASM
make build-wasm

# 3. 启动前端开发服务器
make dev
```

开发模式下，前端运行在 `http://localhost:5173`，直接访问 `web/pkg/` 中的 WASM 模块。

## WASM 导出接口

JavaScript 通过动态导入 `video_analyzer.js` 调用以下接口：

### FLV 分析
```javascript
import init, { parseFLV, getGOPTags, getTagDetail } from '/pkg/video_analyzer.js';

// 初始化 WASM
await init();

// 解析 FLV 文件
const result = parseFLV(uint8Array);  // => AnalysisResult

// 获取 GOP 中的标签
const gopTags = getGOPTags(resultJson, gopIndex);  // => { startIndex, endIndex, tags }

// 获取 Tag 详情（字段树 + Hex dump）
const detail = getTagDetail(resultJson, tagIndex, fileData);  // => TagDetail
```

### HEVC 工具
```javascript
import { isAnnexBFormat, convertAnnexBToHVCC, generateHEVCCodecString } from '/pkg/video_analyzer.js';

// 检测是否为 Annex B 格式
const isAnnexB = isAnnexBFormat(data);  // => boolean

// Annex B -> HVCC
const hvcc = convertAnnexBToHVCC(annexBData);  // => Uint8Array

// 生成 HEVC codec string
const codecString = generateHEVCCodecString(hvccData, "raw", "concat");
// => "hvc1.1.6.L93.B0"
```

## 设计原则

### 前端职责最小化

**Rust 端负责**：
- FLV 文件解析
- Tag 字段解析（`parse_tag_fields`）- 返回完整的字段树结构
- Hex dump 生成（包括字节到 CSS 类的映射）
- GOP 分析
- 异常检测
- HEVC 工具

**前端只负责**：
- UI 渲染和交互逻辑
- WebCodecs API 处理（视频解码/播放）
- 调用 WASM 接口获取数据

这种设计使得 Rust 代码可以在其他项目中复用，前端无需了解 FLV 格式细节。

## 代码规范

- Rust 代码注释使用中文
- TypeScript 使用严格模式
- 所有视频解析逻辑放在 Rust 端
- 前端不包含任何视频格式相关的硬编码知识

## 版本历史

- **v0.5.1**: HEVC Annex B 修复 + GOP 播放器增强
  - 修复 HEVC Annex B 格式 FLV 的 WebCodecs 播放问题
  - 添加 `convertAnnexBToAVCC` 帧数据转换
  - GOP 播放器添加帧缩略图画廊
  - 点击帧缩略图可查看对应 Tag 详情
  - Tag 详情添加"预览帧画面"按钮
  - 添加 GOP 帧缓存（`utils/gopCache.ts`）
  - 修复 GOP 列表帧数显示不正确的问题
- **v0.5.0**: Go → Rust 迁移
  - 核心逻辑从 Go 迁移到 Rust
  - 使用 wasm-pack + wasm-bindgen 构建 WASM
  - WASM 体积从 2.9MB 减少到 165KB
  - Tag 详情解析（字段树 + Hex dump）移到 Rust 端
  - 前端移除所有视频格式解析逻辑
  - 删除 Go 相关文件（pkg/, wasm/, cmd/, build.go）
- **v0.4.0**: 时间戳分布图与详情弹窗重构
- **v0.3.0**: 添加标签/GOP 详情查看功能
- **v0.2.0**: 添加 HEVC 工具包
- **v0.1.0**: 初始版本
