import { test, expect } from '@playwright/test';
import { VideoAnalyzerPage } from './fixtures';

test.describe('Video Analyzer E2E', () => {
    let videoPage: VideoAnalyzerPage;

    test.beforeEach(async ({ page }) => {
        videoPage = new VideoAnalyzerPage(page);
        await videoPage.goto();
    });

    test('should analyze video file successfully', async ({ page }) => {
        // 1. 上传文件
        console.log('Testing file upload...');
        await videoPage.uploadVideo('test.mp4');

        // 2. 等待解析
        console.log('Waiting for analysis...');
        await videoPage.waitForAnalysisComplete();

        // 3. 验证基本信息
        console.log('Verifying analysis results...');
        const result = await videoPage.getAnalysisResult();
        console.log('Analysis Result:', result);

        expect(parseInt(result.gopCount)).toBeGreaterThan(0);
        expect(parseInt(result.sampleCount)).toBeGreaterThan(0);
        expect(parseInt(result.keyframeCount)).toBeGreaterThan(0);
    });

    test('should play GOP correctly', async ({ page }) => {
        // 1. 上传并等待
        await videoPage.uploadVideo('test.mp4');
        await videoPage.waitForAnalysisComplete();

        // 2. 打开 GOP 播放器
        console.log('Opening GOP player...');
        await videoPage.openFirstGopPlayer();

        // 3. 等待解码
        console.log('Waiting for decoding...');
        await videoPage.waitForGopDecoding();

        // 4. 验证帧数量
        const frameCount = await videoPage.getFrameCount();
        console.log(`GOP frame count: ${frameCount}`);
        expect(frameCount).toBeGreaterThan(0);

        // 验证画廊缩略图数量是否匹配
        await expect(page.getByTestId(/^frame-thumb-/)).toHaveCount(frameCount);

        // 5. 播放
        console.log('Starting playback...');
        await videoPage.playVideo();

        // 验证变为暂停按钮
        await expect(page.getByTestId('pause-btn')).toBeVisible();

        // 等待几秒观察是否报错
        await page.waitForTimeout(2000);

        // 检查是否有错误信息
        const errorMsg = await page.getByTestId('player-error');
        await expect(errorMsg).toBeHidden();

        // 6. 关闭
        await videoPage.closePlayer();
    });

    test('should show MP4 Box Tree', async ({ page }) => {
        await videoPage.uploadVideo('test.mp4');
        await videoPage.waitForAnalysisComplete();

        console.log('Opening Box Tree Viewer...');
        await videoPage.openBoxTreeViewer();

        // 验证是否存在 moov box (MP4 必须有)
        const moovNode = page.locator('.box-node-type', { hasText: 'moov' });
        await expect(moovNode).toBeVisible();

        // 验证是否存在 mdat box
        const mdatNode = page.locator('.box-node-type', { hasText: 'mdat' });
        await expect(mdatNode).toBeVisible();

        console.log('Closing Box Tree Viewer...');
        await videoPage.closeBoxTreeViewer();
    });

    test('should show Debug Panel', async ({ page }) => {
        await videoPage.uploadVideo('test.mp4');
        await videoPage.waitForAnalysisComplete();

        console.log('Opening Debug Panel...');
        await videoPage.openDebugPanel();

        const info = await videoPage.getDebugInfo();
        console.log('Debug Info:', info);
        expect(info).toContain('JS Heap');
        expect(info).toContain('ArrayBuffer');

        await videoPage.closeDebugPanel();
    });
});
