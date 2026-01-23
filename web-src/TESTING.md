# Video Analyzer E2E 测试指南

此文档介绍了 Video Analyzer Web 前端项目的 Playwright E2E 测试框架。

## 目录
1. [环境准备](#环境准备)
2. [运行测试](#运行测试)
3. [测试结构](#测试结构)
4. [编写新测试](#编写新测试)
5. [常见问题](#常见问题)

## 环境准备

测试依赖于 Node.js 和 Playwright。
首次运行前，请确保已安装依赖：

```bash
cd web-src
npm install
npx playwright install --with-deps chromium
```

确保 `tests/fixtures/test.mp4` 文件存在。如果不小心删除了，可以使用以下命令下载：

```bash
# Windows (PowerShell)
curl -L -o tests/fixtures/test.mp4 https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4
```

### 使用自定义本地视频

默认情况下，测试使用 `tests/fixtures/test.mp4`。你可以通过创建一个被 git 忽略的配置文件来指定使用本地的其他视频文件进行测试。

1.  在 `web-src/tests/` 目录下创建 `test-config.local.json` 文件。
2.  添加如下配置（支持绝对路径或相对于 `web-src` 的相对路径）：

```json
{
  "videoPath": "../.local/my-special-video.mp4"
}
```

这对于测试包含特殊格式、错误或大文件的视频非常有用，而无需将这些文件提交到 git 仓库中。

## 运行测试

### 1. 命令行运行 (无头模式)
这是 CI/CD 中的标准运行方式。

```bash
npm test
# 或者
npx playwright test
```

### 2. 有头模式 (调试)
会弹出浏览器窗口，方便观察操作过程。

```bash
npm run test:headed
# 或者
npx playwright test --headed
```

### 3. UI 模式
提供带时间轴、DOM 快照和日志的交互式调试界面。

```bash
npm run test:ui
# 或者
npx playwright test --ui
```

### 4. 运行特定文件或测试
```bash
npx playwright test tests/video-analyzer.spec.ts
npx playwright test -g "should show Debug Panel"
```

## 测试结构

- **配置文件**: `playwright.config.ts` - 定义了测试目录、超时、浏览器配置和 WebServer (Vite) 启动命令。
- **Fixture**: `tests/fixtures.ts` - 封装了页面对象模型 (`VideoAnalyzerPage`)，提供常用的操作方法（如 `uploadVideo`, `waitForAnalysisComplete`, `openBoxTreeViewer` 等）。
- **测试用例**: `tests/video-analyzer.spec.ts` - 包含具体的测试场景。

## 编写新测试

推荐在 `tests/fixtures.ts` 的 `VideoAnalyzerPage` 类中添加新的页面操作方法，然后在 `.spec.ts` 中调用。

**步骤：**
1.  在 **fixtures.ts** 中添加方法：
    ```typescript
    async clickMyHeader() {
        await this.page.getByTestId('my-header').click();
    }
    ```
2.  在 **spec.ts** 中编写测试：
    ```typescript
    test('should click header', async ({ page }) => {
        await videoPage.clickMyHeader();
        await expect(page.getByText('Clicked')).toBeVisible();
    });
    ```

**UI 约定：**
为了测试稳定性，建议在组件 (`.tsx`) 中使用 `data-testid` 属性定位元素，而不是依赖类名或文本。

## 常见问题

### 1. "Loading indicator hidden" 但 "File info visible" 失败
这通常意味着解析虽然结束了，但并没有成功显示结果界面（可能出错了）。检查控制台是否有 `[Browser Dialog]` 相关的报错日志。

### 2. 超时 (Timeout)
视频解析可能较慢，特别是初次加载 WASM。我们在 `playwright.config.ts` 中设置了较长的 `test` 和 `action` 超时。但如果网络极慢（如下载测试视频），仍可能超时。

### 3. 视频文件
测试默认使用 `tests/fixtures/test.mp4`。确保该文件是有效的 MP4 视频。如果更换文件，可能需要调整测试中的断言（如 GOP 数量、帧数等）。
