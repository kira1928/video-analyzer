#!/bin/bash
set -e

echo "[Setup] 正在设置测试环境..."

# 2. 安装前端依赖
echo "[Setup] 安装前端依赖..."
cd web-src
npm install
cd ..

# 3. 安装 E2E 测试依赖
echo "[Setup] 安装 E2E 测试依赖..."
cd tests/e2e
npm install
# 安装 wasm-pack 到本地 node_modules
npm install --save-dev wasm-pack
cd ../..

# 4. 安装 Playwright 浏览器
echo "[Setup] 安装 Playwright 浏览器..."
cd tests/e2e
npx playwright install chromium
cd ../..

# 5. 下载测试视频
echo "[Setup] 下载测试视频..."
mkdir -p tests/e2e/fixtures
# 使用更可靠的下载源，或者如果下载失败可以使用生成的文件（如果能生成）
# 这里使用 Big Buck Bunny 1MB sample
SAMPLE_URL="https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4"

if [ ! -f tests/e2e/fixtures/sample.mp4 ]; then
    echo "[Setup] Downloading from $SAMPLE_URL"
    curl -L "$SAMPLE_URL" -o tests/e2e/fixtures/sample.mp4 || {
        echo "[Setup] 下载失败，尝试备用源..."
        # 备用源 (如果第一个失败)
        curl -L "https://github.com/bower-media-samples/big-buck-bunny-1080p-60fps-30s/raw/master/video.mp4" -o tests/e2e/fixtures/sample.mp4
    }
    echo "[Setup] 测试视频下载完成"
else
    echo "[Setup] 测试视频已存在"
fi

echo "[Setup] 环境设置完成"
