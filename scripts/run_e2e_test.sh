#!/bin/bash
set -e

# 获取项目根目录
PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"

# 添加本地 wasm-pack 到 PATH
# 优先使用 tests/e2e/node_modules/.bin 中的 wasm-pack
export PATH="$PROJECT_ROOT/tests/e2e/node_modules/.bin:$PATH"

echo "[Test] 检查环境..."
if ! command -v wasm-pack &> /dev/null; then
    echo "[Test] 错误: 未找到 wasm-pack。请先运行 scripts/setup_test_env.sh"
    exit 1
fi

echo "[Test] 启动开发服务器 (包含 WASM 构建)..."
# 后台启动 make dev
# 注意: make dev 会先运行 build-wasm-debug，这需要一些时间
make dev > dev_server.log 2>&1 &
SERVER_PID=$!

echo "[Test] 开发服务器 PID: $SERVER_PID"

# 等待端口 5173
echo "[Test] 等待端口 5173 就绪..."
# 最多等待 120 秒 (WASM 构建可能较慢)
timeout 120 bash -c 'until echo > /dev/tcp/localhost/5173 2>/dev/null; do sleep 2; done'
if [ $? -ne 0 ]; then
    echo "[Test] 服务器启动超时 (120s)。以下是日志最后 50 行:"
    tail -n 50 dev_server.log
    kill $SERVER_PID || true
    exit 1
fi
echo "[Test] 服务器已就绪，开始测试"

# 运行 Playwright 测试
echo "[Test] 开始运行 E2E 测试..."
cd "$PROJECT_ROOT/tests/e2e"
# 显式使用 npx playwright 确保使用项目依赖
npx playwright test

TEST_EXIT_CODE=$?

# 清理
echo "[Test] 停止开发服务器..."
kill $SERVER_PID || true
# wait $SERVER_PID 2>/dev/null || true

if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo "[Test] 测试通过 ✅"
else
    echo "[Test] 测试失败 ❌"
    echo "[Test] 服务器日志:"
    cat "$PROJECT_ROOT/dev_server.log"
fi

exit $TEST_EXIT_CODE
