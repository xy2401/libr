#!/usr/bin/env python3
"""Refresh, build, serve, and deploy the static ebook library."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
CATALOG_PATH = ROOT / "subject_top.json"
DEFAULT_OUTPUT = ROOT / "dist"
BASE_URL = "https://standardebooks.org"
SUBJECTS_URL = f"{BASE_URL}/bulk-downloads/subjects"
CATALOG_URL = f"{BASE_URL}/ebooks"
DEFAULT_PER_SUBJECT = 30
PAGES_FILE_LIMIT = 20_000
PAGES_FILE_SIZE_LIMIT = 25 * 1024 * 1024
STATIC_FILES = ("index.html", "style.css", "app.js")

SUBJECT_ZH = {
    "adventure": "冒险",
    "autobiography": "自传",
    "biography": "传记",
    "childrens": "儿童文学",
    "comedy": "喜剧",
    "drama": "戏剧",
    "fantasy": "奇幻",
    "fiction": "虚构小说",
    "horror": "恐怖小说",
    "memoir": "回忆录",
    "mystery": "悬疑/侦探",
    "nonfiction": "非虚构",
    "philosophy": "哲学",
    "poetry": "诗歌",
    "satire": "讽刺",
    "science-fiction": "科幻",
    "shorts": "短篇合集",
    "spirituality": "灵性/宗教",
    "travel": "游记",
}


class SiteError(RuntimeError):
    pass


def info(message: str) -> None:
    print(f"[site] {message}")


def warn(message: str) -> None:
    print(f"[site] 警告: {message}", file=sys.stderr)


def ensure_inside_root(path: Path) -> Path:
    resolved = path.resolve()
    if resolved == ROOT or ROOT not in resolved.parents:
        raise SiteError(f"拒绝操作项目目录以外的路径: {resolved}")
    return resolved


def get_html(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (compatible; SE-Demo-Library/2.0)"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8")


def absolute_url(url: str) -> str:
    return urllib.parse.urljoin(BASE_URL, url)


def parse_html(html: str):
    try:
        from bs4 import BeautifulSoup
    except ImportError as exc:  # pragma: no cover - environment guidance
        raise SiteError("刷新数据需要 beautifulsoup4，请先运行: python -m pip install beautifulsoup4") from exc
    return BeautifulSoup(html, "html.parser")


def parse_subject_metadata() -> list[dict]:
    soup = parse_html(get_html(SUBJECTS_URL))
    subjects: list[dict] = []
    for row in soup.select("table tbody tr"):
        cells = row.find_all("td", recursive=False)
        if len(cells) < 5:
            continue
        subject_link = cells[0].find("a", href=True)
        if not subject_link:
            continue
        slug = subject_link["href"].rstrip("/").split("/")[-1]
        count_text = cells[1].get_text(strip=True).replace(",", "")
        if not count_text.isdigit():
            continue
        downloads = []
        for index in range(3, len(cells), 2):
            link = cells[index].find("a", href=True)
            if not link:
                continue
            size = cells[index + 1].get_text(" ", strip=True).strip("()") if index + 1 < len(cells) else ""
            downloads.append(
                {
                    "format": link.get_text(" ", strip=True),
                    "url": absolute_url(link["href"]),
                    "size": size,
                }
            )
        subjects.append(
            {
                "slug": slug,
                "name": subject_link.get_text(" ", strip=True),
                "name_zh": SUBJECT_ZH.get(slug, ""),
                "browse_url": absolute_url(subject_link["href"]),
                "official_book_count": int(count_text),
                "local_book_count": 0,
                "updated": cells[2].get_text(" ", strip=True),
                "downloads": downloads,
            }
        )
    if not subjects:
        raise SiteError("未能从官网分类页解析到任何分类")
    return subjects


def count_official_books() -> int:
    per_page = 48
    first_url = f"{CATALOG_URL}?sort=newest&per-page={per_page}"
    first_soup = parse_html(get_html(first_url))
    page_numbers = []
    for link in first_soup.select('a[href*="page="]'):
        match = re.search(r"[?&]page=(\d+)", link.get("href", ""))
        if match:
            page_numbers.append(int(match.group(1)))
    last_page = max(page_numbers or [1])
    last_soup = first_soup
    if last_page > 1:
        last_soup = parse_html(get_html(f"{first_url}&page={last_page}"))
    last_count = len(last_soup.select("ol.ebooks-list > li"))
    if last_count <= 0:
        raise SiteError("未能从官网总书目页计算书籍数量")
    return (last_page - 1) * per_page + last_count


def repo_cache() -> dict[str, str]:
    cache: dict[str, str] = {}
    if CATALOG_PATH.exists():
        try:
            current = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
            for book in current.get("books", []):
                repo = book.get("repo_name")
                if not repo:
                    continue
                for key in (book.get("href"), book.get("web_url")):
                    if key:
                        cache[str(key)] = repo
        except (OSError, json.JSONDecodeError):
            pass
    return cache


def find_repo_name(href: str, web_url: str, cache: dict[str, str]) -> str:
    if href in cache:
        return cache[href]
    if web_url in cache:
        return cache[web_url]
    soup = parse_html(get_html(web_url))
    link = soup.find("a", href=lambda value: value and "github.com/standardebooks/" in value)
    if link:
        match = re.search(r"github\.com/standardebooks/([^/#?]+)", link.get("href", ""))
        if match:
            repo = match.group(1).removesuffix(".git")
            cache[href] = repo
            cache[web_url] = repo
            return repo
    parts = href.strip("/").split("/")
    repo = "_".join(parts[1:]) if len(parts) >= 3 and parts[0] == "ebooks" else href.strip("/").replace("/", "_")
    cache[href] = repo
    cache[web_url] = repo
    return repo


def fetch_subject_books(subject: dict, limit: int, repo_cache: dict[str, str]) -> list[dict]:
    target = min(limit, subject["official_book_count"])
    books: list[dict] = []
    seen_hrefs: set[str] = set()
    page = 1
    while len(books) < target:
        url = f"{BASE_URL}/subjects/{subject['slug']}?sort=popularity&per-page=48&page={page}"
        soup = parse_html(get_html(url))
        items = soup.select("ol.ebooks-list li")
        if not items:
            break
        added = 0
        for item in items:
            link = item.find("a", property="schema:url", href=True)
            if not link:
                continue
            href = link["href"]
            if href in seen_hrefs:
                continue
            seen_hrefs.add(href)
            title_node = item.find("span", property="schema:name")
            author_node = item.find("p", property="schema:author") or item.find("a", property="schema:author")
            web_url = absolute_url(href)
            repo = find_repo_name(href, web_url, repo_cache)
            books.append(
                {
                    "rank": len(books) + 1,
                    "title": title_node.get_text(" ", strip=True) if title_node else href.split("/")[-1],
                    "author": author_node.get_text(" ", strip=True) if author_node else "",
                    "href": href,
                    "web_url": web_url,
                    "repo_name": repo,
                    "github_url": f"https://github.com/standardebooks/{repo}.git",
                }
            )
            added += 1
            if len(books) >= target:
                break
        if added == 0:
            break
        page += 1
    return books


def refresh_catalog(per_subject: int) -> dict:
    info("读取 Standard Ebooks 官方分类元数据")
    subjects = parse_subject_metadata()
    official_count = count_official_books()
    cache = repo_cache()
    books_by_repo: dict[str, dict] = {}
    book_order: list[str] = []
    for subject in subjects:
        entries = fetch_subject_books(subject, per_subject, cache)
        subject["local_book_count"] = len(entries)
        info(f"{subject['name']}: 本站 {len(entries)} / 官网 {subject['official_book_count']}")
        for entry in entries:
            repo = entry["repo_name"]
            if repo not in books_by_repo:
                books_by_repo[repo] = {
                    "repo_name": repo,
                    "title": entry["title"],
                    "author": entry["author"],
                    "href": entry["href"],
                    "web_url": entry["web_url"],
                    "github_url": entry["github_url"],
                    "asset_path": f"library/{repo}/src/epub",
                    "subjects": [],
                }
                book_order.append(repo)
            links = books_by_repo[repo]["subjects"]
            if not any(item["slug"] == subject["slug"] for item in links):
                links.append({"slug": subject["slug"], "rank": entry["rank"]})
    catalog = {
        "schema_version": 2,
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "sources": {
            "subjects_url": SUBJECTS_URL,
            "catalog_url": CATALOG_URL,
            "official_book_count": official_count,
            "official_subject_memberships": sum(item["official_book_count"] for item in subjects),
        },
        "settings": {"per_subject_limit": per_subject},
        "subjects": subjects,
        "books": [books_by_repo[repo] for repo in book_order],
    }
    temporary = CATALOG_PATH.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, CATALOG_PATH)
    info(f"已写入 {CATALOG_PATH.name}: {len(catalog['books'])} 本唯一图书")
    return catalog


def load_catalog() -> dict:
    if not CATALOG_PATH.exists():
        raise SiteError(f"缺少 {CATALOG_PATH.name}，请先运行 python site.py refresh")
    try:
        catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SiteError(f"{CATALOG_PATH.name} 不是有效 JSON: {exc}") from exc
    if catalog.get("schema_version") != 2 or not isinstance(catalog.get("books"), list):
        raise SiteError(f"{CATALOG_PATH.name} 数据格式不受支持")
    return catalog


def find_book_source(book: dict) -> Path | None:
    canonical = ROOT / "library" / book["repo_name"] / "src" / "epub"
    return canonical if canonical.is_dir() else None


def remove_output(output: Path) -> None:
    output = ensure_inside_root(output)
    if output.exists():
        shutil.rmtree(output)


def validate_output(output: Path) -> dict:
    files = [path for path in output.rglob("*") if path.is_file()]
    largest = max(files, key=lambda path: path.stat().st_size, default=None)
    largest_size = largest.stat().st_size if largest else 0
    violations = []
    if len(files) >= PAGES_FILE_LIMIT:
        violations.append(f"文件数 {len(files):,}，必须少于 {PAGES_FILE_LIMIT:,}")
    if largest_size > PAGES_FILE_SIZE_LIMIT:
        violations.append(f"最大文件 {largest.relative_to(output)} 为 {largest_size / 1024 / 1024:.2f} MiB")
    forbidden = [path for path in files if ".git" in path.parts or "cover.source." in path.name]
    if forbidden:
        violations.append(f"包含不应发布的源文件: {forbidden[0].relative_to(output)}")
    if violations:
        raise SiteError("Cloudflare Pages 校验失败: " + "；".join(violations))
    return {
        "file_count": len(files),
        "total_bytes": sum(path.stat().st_size for path in files),
        "largest_file": str(largest.relative_to(output)) if largest else "",
        "largest_bytes": largest_size,
    }


def build_site(output: Path) -> dict:
    catalog = load_catalog()
    output = ensure_inside_root(output)
    remove_output(output)
    output.mkdir(parents=True)
    for name in STATIC_FILES:
        source = ROOT / name
        if not source.is_file():
            raise SiteError(f"缺少前端文件: {name}")
        shutil.copy2(source, output / name)
    shutil.copy2(CATALOG_PATH, output / CATALOG_PATH.name)
    missing = []
    for index, book in enumerate(catalog["books"], 1):
        source = find_book_source(book)
        if source is None:
            missing.append(book["repo_name"])
            continue
        destination = output / "library" / book["repo_name"] / "src" / "epub"
        shutil.copytree(source, destination, copy_function=shutil.copy2)
        if index % 50 == 0:
            info(f"已整理 {index}/{len(catalog['books'])} 本")
    if missing:
        remove_output(output)
        preview = ", ".join(missing[:8])
        raise SiteError(f"有 {len(missing)} 本书缺少 src/epub: {preview}")
    stats = validate_output(output)
    info(
        f"构建完成: {len(catalog['books'])} 本，{stats['file_count']:,} 个文件，"
        f"{stats['total_bytes'] / 1024 / 1024:.1f} MiB，最大 {stats['largest_bytes'] / 1024 / 1024:.2f} MiB"
    )
    return stats


def run_git(*args: str, cwd: Path = ROOT, check: bool = True) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        env=env,
        text=True,
        capture_output=True,
    )
    if check and result.returncode:
        detail = result.stderr.strip() or result.stdout.strip() or f"退出码 {result.returncode}"
        raise SiteError(f"git {' '.join(args)} 失败: {detail}")
    return result


def library_gitlinks() -> dict[str, str]:
    links: dict[str, str] = {}
    for line in run_git("ls-tree", "-r", "HEAD", "library").stdout.splitlines():
        metadata, separator, path = line.partition("\t")
        parts = metadata.split()
        if separator and len(parts) >= 3 and parts[0] == "160000":
            links[path.replace("\\", "/")] = parts[2]
    return links


def sync_one_book(book: dict, commit: str) -> str:
    repo = book["repo_name"]
    target = ensure_inside_root(ROOT / "library" / repo)
    asset_dir = target / "src" / "epub"
    if target.exists():
        if not target.is_dir():
            raise SiteError(f"library/{repo} 已存在但不是目录")
        current = run_git("rev-parse", "HEAD", cwd=target, check=False)
        if current.returncode:
            if any(target.iterdir()):
                raise SiteError(f"library/{repo} 已存在但不是有效的 Git 仓库")
            target.rmdir()
        elif current.stdout.strip() == commit and asset_dir.is_dir():
            return "cached"
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        run_git(
            "clone",
            "--depth", "1",
            "--filter=blob:none",
            "--no-checkout",
            book["github_url"],
            str(target),
        )

    run_git("sparse-checkout", "init", "--cone", cwd=target)
    run_git("sparse-checkout", "set", "src/epub", cwd=target)
    available = run_git("cat-file", "-e", f"{commit}^{{commit}}", cwd=target, check=False)
    if available.returncode:
        run_git("fetch", "--depth", "1", "origin", commit, cwd=target)
    run_git("checkout", "--detach", commit, cwd=target)
    if not asset_dir.is_dir():
        raise SiteError(f"library/{repo} 检出后缺少 src/epub")
    return "updated"


def sync_library(jobs: int) -> None:
    catalog = load_catalog()
    gitlinks = library_gitlinks()
    tasks = []
    missing_links = []
    for book in catalog["books"]:
        path = f"library/{book['repo_name']}"
        commit = gitlinks.get(path)
        if not commit:
            missing_links.append(path)
        else:
            tasks.append((book, commit))
    if missing_links:
        preview = ", ".join(missing_links[:8])
        raise SiteError(f"有 {len(missing_links)} 本书缺少 Git 子模块记录: {preview}")

    cached = 0
    updated = 0
    errors = []
    info(f"同步 {len(tasks)} 本书，最大并发数 {jobs}")
    with ThreadPoolExecutor(max_workers=jobs) as executor:
        futures = {executor.submit(sync_one_book, book, commit): book["repo_name"] for book, commit in tasks}
        for index, future in enumerate(as_completed(futures), 1):
            repo = futures[future]
            try:
                result = future.result()
                cached += result == "cached"
                updated += result == "updated"
            except Exception as exc:
                errors.append(f"{repo}: {exc}")
            if index % 50 == 0:
                info(f"已检查 {index}/{len(tasks)} 本")
    if errors:
        raise SiteError(f"书库同步失败 {len(errors)} 本；" + "；".join(errors[:5]))
    info(f"书库同步完成: 缓存命中 {cached} 本，新检出或更新 {updated} 本")


def serve_site(output: Path, port: int, skip_build: bool) -> None:
    if not skip_build:
        build_site(output)
    else:
        validate_output(output)
    handler = lambda *args, **kwargs: SimpleHTTPRequestHandler(*args, directory=str(output), **kwargs)
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    info(f"本地预览: http://127.0.0.1:{port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        info("服务已停止")
    finally:
        server.server_close()


def deploy_site(output: Path, project_name: str, branch: str) -> None:
    build_site(output)
    npx = shutil.which("npx") or shutil.which("npx.cmd")
    if not npx:
        raise SiteError("未找到 npx，请先安装 Node.js")
    command = [npx, "wrangler@latest", "pages", "deploy", str(output), "--project-name", project_name, "--branch", branch]
    info("执行 Cloudflare Pages 部署")
    subprocess.run(command, cwd=ROOT, check=True)


def output_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Standard Ebooks 个人书库工具")
    subparsers = parser.add_subparsers(dest="command", required=True)

    refresh = subparsers.add_parser("refresh", help="刷新官网元数据和精选书目")
    refresh.add_argument("--per-subject", type=int, default=DEFAULT_PER_SUBJECT)

    sync = subparsers.add_parser("sync-library", help="并发浅层稀疏检出书籍子模块")
    sync.add_argument("--jobs", type=int, default=16)

    build = subparsers.add_parser("build", help="生成 Cloudflare Pages 发布目录")
    build.add_argument("--output", default="dist")

    serve = subparsers.add_parser("serve", help="构建并启动本地静态服务")
    serve.add_argument("--output", default="dist")
    serve.add_argument("--port", type=int, default=8000)
    serve.add_argument("--skip-build", action="store_true")

    deploy = subparsers.add_parser("deploy", help="构建并部署到 Cloudflare Pages")
    deploy.add_argument("--output", default="dist")
    deploy.add_argument("--project-name", required=True)
    deploy.add_argument("--branch", default="main")
    return parser


def main() -> int:
    args = create_parser().parse_args()
    try:
        if args.command == "refresh":
            if args.per_subject < 1:
                raise SiteError("--per-subject 必须大于 0")
            try:
                refresh_catalog(args.per_subject)
            except Exception as exc:
                if CATALOG_PATH.exists():
                    warn(f"官网刷新失败，保留上次成功数据: {exc}")
                else:
                    raise
        elif args.command == "sync-library":
            if args.jobs < 1:
                raise SiteError("--jobs 必须大于 0")
            sync_library(args.jobs)
        elif args.command == "build":
            build_site(output_path(args.output))
        elif args.command == "serve":
            serve_site(output_path(args.output), args.port, args.skip_build)
        elif args.command == "deploy":
            deploy_site(output_path(args.output), args.project_name, args.branch)
        return 0
    except (SiteError, OSError, subprocess.CalledProcessError) as exc:
        print(f"[site] 错误: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
