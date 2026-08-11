# Standard Ebooks 个人书库

一个纯静态、可离线托管的个人电子书架。书籍内容来自 Standard Ebooks，前端直接读取本地 EPUB 源文件，不需要数据库、账户系统或前端构建框架。

## 项目结构

```text
library/<repo_name>/        唯一书籍目录（Git 子模块）
subject_top.json            书目、分类、排名和官网统计
index.html                  页面结构
style.css                   界面样式
app.js                      书架与阅读器逻辑
site.py                     数据、构建、预览和部署工具
dist/                       Cloudflare Pages 发布产物
```

每本书只在 `library` 中保存一次。一本书属于多个分类时，关系记录在 `subject_top.json` 的 `books[].subjects` 中。

## 环境要求

- Python 3.10+
- `beautifulsoup4`：仅刷新官网数据时需要
- Node.js：仅使用命令行部署 Cloudflare Pages 时需要

```bash
python -m pip install beautifulsoup4
```

首次克隆项目时，推荐使用项目工具并发、浅层、稀疏检出书籍内容：

```bash
python site.py sync-library --jobs 16
```

该命令严格按照主仓库记录的子模块提交检出，只展开每本书的 `src/epub`。重复执行时会跳过已经匹配的书籍。

## 日常使用

刷新 Standard Ebooks 官网数据，每个分类最多收录 30 本：

```bash
python site.py refresh
```

生成并校验 `dist`：

```bash
python site.py build
```

构建后启动本地预览：

```bash
python site.py serve --port 8000
```

如果 `dist` 已经生成，可跳过重新构建：

```bash
python site.py serve --port 8000 --skip-build
```

## Cloudflare Pages

项目默认使用 Cloudflare Pages 的 Git 集成自动构建。连接 GitHub 仓库后填写：

- 生产分支：`main`
- 构建命令：`python site.py sync-library --jobs 16 && python site.py build`
- 构建输出目录：`dist`
- 根目录：项目根目录

构建时会并发浅层检出 402 个书籍仓库，并且只展开 `src/epub`，然后生成、校验并发布 `dist`。

`.github/workflows/deploy-pages.yml` 保留为手动备用部署，不会在推送时自动触发。如果以后需要使用它，在 GitHub Actions 页面手动运行，并配置：

- Secret `CLOUDFLARE_ACCOUNT_ID`
- Secret `CLOUDFLARE_API_TOKEN`
- Variable `CLOUDFLARE_PROJECT_NAME`

### 本地部署

直接从本地构建并部署：

```bash
python site.py deploy --project-name YOUR_PROJECT --branch main
```

构建过程只复制 `index.html`、`style.css`、`app.js`、`subject_top.json` 和入选书籍的 `src/epub`。产物不会包含 `.git`、书籍顶层 `images` 或制作源文件，并会自动检查 Pages 的文件数量与单文件大小限制。

官网元数据来自 [分类下载页](https://standardebooks.org/bulk-downloads/subjects)和[完整书目页](https://standardebooks.org/ebooks)。刷新失败时会保留当前 `subject_top.json`，不会破坏已有站点数据。
