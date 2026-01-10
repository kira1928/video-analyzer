.PHONY: build build-wasm build-web dev clean help standalone

# 默认目标
all: build-wasm build-web

# 构建 Rust 库
build:
	cargo build --release

# 构建 WASM 模块 (使用 wasm-pack)
build-wasm:
	wasm-pack build --target web --out-dir web/pkg --out-name video_analyzer
	@echo "WASM 构建完成: web/pkg/"

# 构建前端 (TypeScript)
build-web:
	cd web-src && npm run build

# 启动开发服务器
dev: build-wasm
	cd web-src && npm run dev

# 构建单文件 HTML
standalone: build-wasm build-web
	node web-src/scripts/build-standalone.mjs

# 清理构建产物
clean:
	cargo clean
	rm -rf web/pkg web/assets web/index.html

# 帮助信息
help:
	@echo "Video Analyzer 构建命令"
	@echo ""
	@echo "  make build      - 构建 Rust 库"
	@echo "  make build-wasm - 构建 WASM 模块"
	@echo "  make build-web  - 构建前端"
	@echo "  make all        - 完整构建"
	@echo "  make dev        - 启动开发服务器"
	@echo "  make clean      - 清理构建产物"

# 安装前端依赖
install-web:
	cd web-src && npm install

# 前端开发服务器
dev-web:
	cd web-src && npm run dev
