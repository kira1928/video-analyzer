# Video Analyzer

FLV/MP4/TS 视频文件分析工具 - 基于 Rust + WASM + React

👉 **在线使用**: https://kira1928.github.io/video-analyzer/

## 功能

- 📊 多格式支持：FLV, MP4, MPEG-TS
- 🎬 GOP (Group of Pictures) 分析
- ⏱️ 时间戳分布可视化
- 🔍 Tag/Sample 详情查看
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
│   ├── container/      # 容器格式解析（FLV/MP4/TS）
│   ├── flv/            # 旧版 FLV 模块（逐步迁移中）
│   ├── analyzer.rs     # 分析器
│   ├── hevc.rs         # HEVC 工具
│   └── types.rs        # 类型定义

├── web-src/            # 前端 TypeScript 源码
└── web/                # 构建输出
```

## 🐛 调试 Rust (WASM) 源码

本项目支持在 Chrome 浏览器中直接调试 Rust 源代码。

### 1. 安装 Chrome 扩展

安装官方扩展 [C/C++ DevTools Support (DWARF)](https://chromewebstore.google.com/detail/cc++-devtools-support-dwa/pdcpmagijalfljmkmjngeonclgbbannb)。

### 2. 启动调试模式

使用以下命令启动开发服务器，这会自动构建包含调试信息 (DWARF) 的 WASM：

```bash
make dev
```

### 3. 配置路径映射

1. 打开 Chrome DevTools (F12)。
2. 转到 **Settings** (齿轮图标) -> **Experiments**，确保勾选了 "WebAssembly Debugging: Enable DWARF support"。
3. 转到 **Extensions** 选项卡（或者搜索 "C/C++ DevTools Support Options"）。
4. 在 **Path substitutions** 中添加一条规则：

| Old prefix | New prefix |
|------------|------------|
| `/` | `http://localhost:5173/` |

*这就告诉 Chrome：当遇到 WASM 中的任何绝对路径（如 `/rust-root/...`）时，去开发服务器的对应 URL 寻找源码。*

### 4. 开始调试

1. 访问 http://localhost:5173
2. 打开 DevTools -> **Sources** 面板。
3. 按 `Ctrl+P` (Mac: `Cmd+P`)，输入 Rust 文件名（如 `lib.rs` 或 `analyzer.rs`）。
4. 你现在可以在 Rust 源码中设置断点并进行单步调试了！

> **注意**: Windows 环境下，项目构建脚本会自动将本地路径重映射为 `/rust-root`，确保跨平台开发体验一致。

## 许可证

MIT
