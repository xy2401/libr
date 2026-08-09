import os
import sys
import json
import re
import urllib.request
import subprocess
from bs4 import BeautifulSoup

BASE_URL = "https://standardebooks.org"
TARGET_COUNT = 100

def get_html(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
    with urllib.request.urlopen(req) as resp:
        return resp.read().decode('utf-8')

def parse_top_books(limit=100):
    books = []
    page = 1
    
    print(f"Fetching Top {limit} popular books from Standard Ebooks...")
    while len(books) < limit:
        url = f"{BASE_URL}/ebooks?per-page=48&sort=popularity&page={page}"
        print(f"Fetching page {page}: {url}")
        try:
            html = get_html(url)
        except Exception as e:
            print(f"Error fetching page {page}: {e}")
            break
            
        soup = BeautifulSoup(html, 'html.parser')
        items = soup.select('ol.ebooks-list li')
        
        if not items:
            print("No more items found.")
            break
            
        for item in items:
            if len(books) >= limit:
                break
                
            link = item.find('a', property='schema:url')
            if not link or not link.get('href'):
                continue
                
            href = link['href'] # e.g. /ebooks/mary-shelley/frankenstein
            title_elem = item.find('span', property='schema:name')
            title = title_elem.text.strip() if title_elem else href.split('/')[-1]
            
            author_elem = item.find('p', property='schema:author') or item.find('a', property='schema:author')
            author = author_elem.text.strip() if author_elem else ""
            
            web_url = f"{BASE_URL}{href}"
            
            books.append({
                "rank": len(books) + 1,
                "title": title,
                "author": author,
                "web_url": web_url,
                "href": href,
                "repo_name": None,
                "github_url": None,
                "subject": None
            })
            
        page += 1
        
    return books

def fetch_book_details(books):
    print(f"\nFetching subjects and exact GitHub repos for {len(books)} books...")
    for idx, book in enumerate(books, 1):
        print(f"[{idx}/{len(books)}] Fetching detail for: {book['title']}...")
        try:
            html = get_html(book['web_url'])
            soup = BeautifulSoup(html, 'html.parser')
            
            # Find exact repo from github links on page
            gh_link = soup.find('a', href=lambda h: h and 'github.com/standardebooks' in h)
            repo_name = None
            if gh_link:
                m = re.search(r'github\.com/standardebooks/([^/#\?]+)', gh_link['href'])
                if m:
                    repo_name = m.group(1)
            
            # Fallback to URL path replacement if not found
            if not repo_name:
                parts = book['href'].strip('/').split('/')
                if len(parts) >= 3 and parts[0] == 'ebooks':
                    repo_name = "_".join(parts[1:])
            
            book['repo_name'] = repo_name
            book['github_url'] = f"https://github.com/standardebooks/{repo_name}.git"
            
            # Find subject links
            subject_links = soup.select('a[href^="/subjects/"]')
            subjects = []
            for slink in subject_links:
                sub_href = slink.get('href', '')
                if '/subjects/' in sub_href:
                    sub_slug = sub_href.split('/subjects/')[1].strip('/')
                    if sub_slug and sub_slug not in subjects:
                        subjects.append(sub_slug)
                        
            book['subject'] = subjects[0] if subjects else 'general'
            book['all_subjects'] = subjects
        except Exception as e:
            print(f"  Warning: failed to fetch detail for {book['title']}: {e}")
            if not book['repo_name']:
                parts = book['href'].strip('/').split('/')
                book['repo_name'] = "_".join(parts[1:])
                book['github_url'] = f"https://github.com/standardebooks/{book['repo_name']}.git"
            book['subject'] = 'general'
            book['all_subjects'] = ['general']

def init_git_repository():
    if not os.path.exists(".git"):
        print("\nInitializing git repository...")
        subprocess.run(["git", "init"], check=True)

def add_submodules(books):
    print("\nAdding Git submodules for Top 100 books...")
    init_git_repository()
    
    success_count = 0
    skipped_count = 0
    failed_count = 0
    
    for idx, book in enumerate(books, 1):
        subject_dir = book['subject']
        repo_name = book['repo_name']
        target_path = os.path.join(subject_dir, repo_name).replace("\\", "/")
        
        # Check if already added in gitmodules or exists
        if os.path.exists(target_path) and os.listdir(target_path):
            print(f"[{idx}/{len(books)}] Skipping (already added & populated): {target_path}")
            skipped_count += 1
            continue
            
        print(f"[{idx}/{len(books)}] Adding submodule: {book['github_url']} -> {target_path}")
        os.makedirs(subject_dir, exist_ok=True)
        
        cmd = ["git", "submodule", "add", "--depth", "1", book['github_url'], target_path]
        try:
            res = subprocess.run(cmd, capture_output=True, text=True)
            if res.returncode == 0:
                success_count += 1
            else:
                # If path exists in index or error, attempt update
                print(f"  Result output: {res.stderr.strip() or res.stdout.strip()}")
                if "already exists in the index" in res.stderr:
                    skipped_count += 1
                else:
                    failed_count += 1
        except Exception as e:
            print(f"  Exception adding {repo_name}: {e}")
            failed_count += 1

    print(f"\nSubmodule Summary: {success_count} added, {skipped_count} skipped/existing, {failed_count} failed.")

def main():
    books = parse_top_books(TARGET_COUNT)
    print(f"Total books parsed: {len(books)}")
    
    fetch_book_details(books)
    
    # Save top100_catalog.json
    catalog_file = "top100_catalog.json"
    with open(catalog_file, "w", encoding="utf-8") as f:
        json.dump(books, f, ensure_ascii=False, indent=2)
    print(f"\nSaved catalog metadata to {catalog_file}")
    
    # Add submodules
    add_submodules(books)
    
    print("\nAll done!")

if __name__ == "__main__":
    main()
