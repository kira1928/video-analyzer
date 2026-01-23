import { defineConfig, devices } from '@playwright/test';

/**
 * Video Analyzer E2E 测试配置
 * 
 * 运行方式：
 * - npm run test        无头模式（CI/CD 环境）
 * - npm run test:headed 有头模式（调试）
 * - npm run test:ui     UI 模式（交互式调试）
 */
export default defineConfig({
    // 测试文件目录
    testDir: './tests',

    // 测试结果输出目录（视频、截图、trace 等）
    // 放在项目根目录，避免与源码混淆
    outputDir: '../.playwright-output/test-results',

    // 完全并行运行测试
    fullyParallel: true,

    // 禁止 test.only 在 CI 中运行
    forbidOnly: !!process.env.CI,

    // CI 中重试失败的测试
    retries: process.env.CI ? 2 : 0,

    // 并行 worker 数量
    workers: process.env.CI ? 1 : undefined,

    // 测试报告
    reporter: [
        // HTML 报告输出到项目根目录
        ['html', { open: 'never', outputFolder: '../.playwright-output/report' }],
        ['list']
    ],

    // 全局设置
    use: {
        // 基础 URL - 使用 IPv4
        baseURL: 'http://127.0.0.1:3500',

        // 失败时截图
        screenshot: 'only-on-failure',

        // 失败时录制视频
        video: 'retain-on-failure',

        // 追踪信息（用于调试）
        trace: 'retain-on-failure',

        // 超时设置
        actionTimeout: 30000,
        navigationTimeout: 30000,
    },

    // 测试超时（视频解析可能需要较长时间）
    timeout: 120000,

    // 断言超时
    expect: {
        timeout: 30000
    },

    // 项目配置（只使用 Chromium）
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],

    // 开发服务器配置
    webServer: {
        // 强制使用 IPv4 和 3500 端口
        command: 'npm run dev -- --host 127.0.0.1 --port 3500',
        url: 'http://127.0.0.1:3500',
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
        stdout: 'pipe',
        stderr: 'pipe',
    },
});
