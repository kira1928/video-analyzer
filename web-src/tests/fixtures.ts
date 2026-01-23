import { Page, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

export class VideoAnalyzerPage {
    readonly page: Page;

    constructor(page: Page) {
        this.page = page;
    }

    async goto() {
        // 监听 alert 对话框，这对调试失败原因至关重要
        this.page.on('dialog', async dialog => {
            console.log(`[Browser Dialog] ${dialog.type()}: ${dialog.message()}`);
            await dialog.accept();
        });

        await this.page.goto('/');
        await this.waitForWasmReady();
    }

    async waitForWasmReady() {
        // 等待 status-dot 变绿 (class 包含 ready)
        // 或者简单的等待文字提示
        // 这里的 DOM 结构是 .status > .status-dot
        const statusDot = this.page.locator('[data-testid="wasm-status"] .status-dot');
        await expect(statusDot).toHaveClass(/ready/, { timeout: 30000 });
        console.log('WASM is ready');
    }

    async uploadVideo(fileName: string = 'test.mp4') {
        const configPath = path.resolve(process.cwd(), 'tests/test-config.local.json');
        let filePath = path.resolve(process.cwd(), 'tests/fixtures', fileName);

        if (fs.existsSync(configPath)) {
            try {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                if (config.videoPath) {
                    const resolvedPath = path.resolve(process.cwd(), config.videoPath);
                    const resolvedPathFromRoot = path.resolve(process.cwd(), '../', config.videoPath);

                    if (fs.existsSync(resolvedPath)) {
                        filePath = resolvedPath;
                    } else if (fs.existsSync(resolvedPathFromRoot)) {
                        filePath = resolvedPathFromRoot;
                    } else {
                        console.warn(`Configured video path not found: ${config.videoPath} (tried ${resolvedPath} and ${resolvedPathFromRoot})`);
                    }
                }
            } catch (e) {
                console.warn('Error reading local test config:', e);
            }
        }

        console.log(`Video file path resolved to: ${filePath}`);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Video file does not exist: ${filePath}`);
        }

        // 监听 file chooser 事件 (虽然我们直接设置 input files)
        const fileInput = this.page.getByTestId('file-input');
        await fileInput.setInputFiles(filePath);
    }

    async waitForAnalysisComplete() {
        console.log('Waiting for analysis to complete...');
        // 1. 等待加载指示器出现（可能非常快，所以超时设置短一点，也不在此处报错）
        try {
            await expect(this.page.getByTestId('loading-indicator')).toBeVisible({ timeout: 2000 });
            console.log('Loading indicator visible');
        } catch (e) {
            console.log('Loading indicator not caught (might be too fast)');
        }

        // 2. 等待加载指示器消失（这是真正的等待过程）
        // 增加超时时间到 60秒
        try {
            await expect(this.page.getByTestId('loading-indicator')).toBeHidden({ timeout: 60000 });
            console.log('Loading indicator hidden');
        } catch (e) {
            // 如果超时，可能是因为出错停在加载界面，或者真的很慢
            // 检查是否有错误信息
            if (await this.page.getByText('分析失败').isVisible()) {
                throw new Error('Analysis failed with error message on screen');
            }
            throw e;
        }

        // 3. 确认结果区域可见
        await expect(this.page.getByTestId('file-info')).toBeVisible({ timeout: 10000 });
        console.log('File info visible');
    }

    async getAnalysisResult() {
        return {
            sampleCount: await this.page.getByTestId('sample-count').innerText(),
            keyframeCount: await this.page.getByTestId('keyframe-count').innerText(),
            gopCount: await this.page.getByTestId('gop-count').innerText(),
        };
    }

    async openFirstGopPlayer() {
        // 确保列表可见
        await expect(this.page.getByTestId('gop-list')).toBeVisible();

        // 点击第一个播放按钮
        await this.page.getByTestId('gop-play-btn-0').click();

        // 等待播放器弹出
        await expect(this.page.getByTestId('gop-player-modal')).toBeVisible();
    }

    async waitForGopDecoding() {
        // 等待解码状态消失
        await expect(this.page.getByTestId('decoding-status')).toBeHidden({ timeout: 30000 });
        // 确保画廊可见
        await expect(this.page.getByTestId('frame-gallery')).toBeVisible();
    }

    async getFrameCount() {
        const text = await this.page.getByTestId('frame-count').innerText();
        // 格式 "帧: 1 / 150"
        const match = text.match(/\/ (\d+)/);
        return match ? parseInt(match[1]) : 0;
    }

    async playVideo() {
        const playBtn = this.page.getByTestId('play-btn');
        await expect(playBtn).toBeVisible();
        await playBtn.click();
    }

    async closePlayer() {
        await this.page.getByTestId('close-btn').click();
        await expect(this.page.getByTestId('gop-player-modal')).toBeHidden();
    }

    async openBoxTreeViewer() {
        // 只有 MP4 文件才会显示此按钮
        const btn = this.page.locator('.box-tree-btn');
        await expect(btn).toBeVisible();
        await btn.click();
        await expect(this.page.locator('.box-tree-modal')).toBeVisible();
    }

    async closeBoxTreeViewer() {
        const closeBtn = this.page.locator('.box-tree-close');
        await closeBtn.click();
        await expect(this.page.locator('.box-tree-modal')).toBeHidden();
    }

    async openDebugPanel() {
        const toggle = this.page.locator('.debug-panel-toggle');
        if (await toggle.isVisible()) {
            await toggle.click();
        }
        await expect(this.page.locator('.debug-panel')).toBeVisible();
    }

    async closeDebugPanel() {
        const closeBtn = this.page.locator('.debug-panel-header button');
        await closeBtn.click();
        await expect(this.page.locator('.debug-panel')).toBeHidden();
    }

    async getDebugInfo() {
        await expect(this.page.locator('.debug-panel')).toBeVisible();
        const memorySection = this.page.locator('.debug-section').filter({ hasText: '内存使用' });
        return await memorySection.innerText();
    }
}
