import os
import sys
import json
import re
import urllib.request
import subprocess
from bs4 import BeautifulSoup

BASE_URL = "https://standardebooks.org"
MAX_PER_SUBJECT = 100

def get_html(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
    with urllib.request.urlopen(req) as resp:
        return resp.read().decode('utf-8')

def get_all_subjects():
    url = f"{BASE_URL}/bulk-downloads/subjects"
    print(f"Fetching list of subjects from {url}...")
    html = get_html(url)
    soup = BeautifulSoup(html, 'html.parser')
    
    subject_links = soup.find_all('a', href=lambda h: h and h.startswith('/subjects/'))
    subjects = []
    for a in subject_links:
        href = a.get('href', '')
        parts = href.strip('/').split('/')
        if len(parts) == 2 and parts[0] == 'subjects':
            slug = parts[1]
            if slug not in subjects:
                subjects.append(slug)
                
    print(f"Found {len(subjects)} subjects: {subjects}")
    return sorted(subjects)

book_detail_cache = {}

def get_book_repo_name(href, web_url):
    if href in book_detail_cache:
        return book_detail_cache[href]
        
    try:
        html = get_html(web_url)
        soup = BeautifulSoup(html, 'html.parser')
        gh_link = soup.find('a', href=lambda h: h and 'github.com/standardebooks' in h)
        if gh_link:
            m = re.search(r'github\.com/standardebooks/([^/#\?]+)', gh_link['href'])
            if m:
                repo_name = m.group(1)
                book_detail_cache[href] = repo_name
                return repo_name
    except Exception as e:
        print(f"  Warning: error fetching detail for {web_url}: {e}")
        
    parts = href.strip('/').split('/')
    if len(parts) >= 3 and parts[0] == 'ebooks':
        repo_name = "_".join(parts[1:])
    else:
        repo_name = href.strip('/').replace('/', '_')
        
    book_detail_cache[href] = repo_name
    return repo_name

def fetch_books_for_subject(subject_slug, limit=100):
    books = []
    page = 1
    
    print(f"\n--- Fetching Top {limit} popular books for Subject: '{subject_slug}' ---")
    while len(books) < limit:
        url = f"{BASE_URL}/subjects/{subject_slug}?sort=popularity&per-page=48&page={page}"
        print(f"[{subject_slug}] Fetching page {page}...")
        try:
            html = get_html(url)
        except Exception as e:
            print(f"[{subject_slug}] Error/End on page {page}: {e}")
            break
            
        soup = BeautifulSoup(html, 'html.parser')
        items = soup.select('ol.ebooks-list li')
        
        if not items:
            print(f"[{subject_slug}] No more books on page {page}.")
            break
            
        for item in items:
            if len(books) >= limit:
                break
                
            link = item.find('a', property='schema:url')
            if not link or not link.get('href'):
                continue
                
            href = link['href']
            title_elem = item.find('span', property='schema:name')
            title = title_elem.text.strip() if title_elem else href.split('/')[-1]
            
            author_elem = item.find('p', property='schema:author') or item.find('a', property='schema:author')
            author = author_elem.text.strip() if author_elem else ""
            
            web_url = f"{BASE_URL}{href}"
            repo_name = get_book_repo_name(href, web_url)
            github_url = f"https://github.com/standardebooks/{repo_name}.git"
            
            books.append({
                "rank": len(books) + 1,
                "title": title,
                "author": author,
                "href": href,
                "web_url": web_url,
                "repo_name": repo_name,
                "github_url": github_url
            })
            
        page += 1
        
    print(f"[{subject_slug}] Total books found: {len(books)}")
    return books

def init_git_repository():
    if not os.path.exists(".git"):
        print("\nInitializing git repository...")
        subprocess.run(["git", "init"], check=True)

def add_submodule(github_url, target_path):
    if os.path.exists(target_path) and os.listdir(target_path):
        return "skipped"
        
    parent_dir = os.path.dirname(target_path)
    if parent_dir:
        os.makedirs(parent_dir, exist_ok=True)
        
    cmd = ["git", "submodule", "add", "--depth", "1", github_url, target_path]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode == 0:
            return "success"
        elif "already exists in the index" in res.stderr:
            return "skipped"
        else:
            print(f"  Error adding {target_path}: {res.stderr.strip()}")
            return "failed"
    except Exception as e:
        print(f"  Exception adding {target_path}: {e}")
        return "failed"

def main():
    init_git_repository()
    subjects = get_all_subjects()
    
    subject_catalog = {}
    total_added = 0
    total_skipped = 0
    total_failed = 0
    
    for subject_slug in subjects:
        books = fetch_books_for_subject(subject_slug, MAX_PER_SUBJECT)
        subject_catalog[subject_slug] = books
        
        print(f"Adding submodules for subject '{subject_slug}' ({len(books)} books)...")
        sub_added = 0
        sub_skipped = 0
        sub_failed = 0
        
        for idx, book in enumerate(books, 1):
            target_path = f"{subject_slug}/{book['repo_name']}"
            result = add_submodule(book['github_url'], target_path)
            
            if result == "success":
                sub_added += 1
            elif result == "skipped":
                sub_skipped += 1
            else:
                sub_failed += 1
                
        print(f"[{subject_slug}] Submodules: {sub_added} added, {sub_skipped} skipped, {sub_failed} failed.")
        total_added += sub_added
        total_skipped += sub_skipped
        total_failed += sub_failed
        
    # Save subject_catalog.json
    catalog_file = "subject_catalog.json"
    with open(catalog_file, "w", encoding="utf-8") as f:
        json.dump(subject_catalog, f, ensure_ascii=False, indent=2)
        
    print("\n================ FINAL SUMMARY ================")
    print(f"Total Subjects Processed: {len(subjects)}")
    print(f"Total Submodules: {total_added} added, {total_skipped} skipped, {total_failed} failed.")
    print(f"Saved complete catalog metadata to '{catalog_file}'")
    print("===============================================")

if __name__ == "__main__":
    main()
