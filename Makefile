.PHONY: build build-wasm build-web dev clean help standalone

# 默认目标
all: build-wasm build-web

# 构建 Rust 库 (Release)
build:
	cargo build --release

# 构建 WASM 模块 (Release - 无调试信息)
build-wasm:
	node scripts/build.js wasm --release

# 构建 WASM 模块 (Debug - 包含 DWARF)
build-wasm-debug:
	node scripts/build.js wasm --dev

# 构建前端 (TypeScript)
build-web:
	node scripts/build.js web

# 启动开发服务器 (自动使用 Debug 模式)
dev: build-wasm-debug
	node scripts/build.js dev

# 启动开发服务器 (Release 模式测试)
dev-release: build-wasm
	node scripts/build.js dev

# 清理构建产物
clean:
	node scripts/build.js clean

# 安装前端依赖
install-web:
	cd web-src && npm install

# 帮助信息
help:
	node scripts/build.js help
