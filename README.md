# Video Analyzer

FLV 视频文件分析工具 - 基于 Rust + WASM + React

👉 **在线使用**: https://kira1928.github.io/video-analyzer/

## 功能

- 📊 FLV 文件解析和结构分析
- 🎬 GOP (Group of Pictures) 分析
- ⏱️ 时间戳分布可视化
- 🔍 Tag 详情查看（字段树 + Hex dump）
- ⚠️ 异常检测（时间戳回退、跳跃、音视频不同步）
- 🛠️ HEVC 工具（Annex B/HVCC 转换、codec string 生成）

## 快速开始

### 前置要求

- [Rust](https://rustup.rs/) (stable)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)
- [Node.js](https://nodejs.org/) >= 18

### 安装依赖

```bash
# 安装 wasm-pack (如果未安装)
npm install -g wasm-pack

# 安装前端依赖
make install-web
```

### 构建

```bash
# 完整构建 (WASM + 前端)
make all
```

### 开发

```bash
# 构建 WASM
make build-wasm

# 启动前端开发服务器
make dev
```

然后访问 http://localhost:5173

## 技术栈

- **核心逻辑**: Rust + wasm-bindgen
- **前端**: React 18 + TypeScript + Vite 5
- **WASM 构建**: wasm-pack

## 项目结构

```
video-analyzer/
├── src/                # Rust 源码
│   ├── lib.rs          # WASM 导出接口
│   ├── flv/            # FLV 解析模块
│   ├── analyzer.rs     # 分析器
│   ├── hevc.rs         # HEVC 工具
│   └── types.rs        # 类型定义
├── web-src/            # 前端 TypeScript 源码
└── web/                # 构建输出
```

## 许可证

MIT
