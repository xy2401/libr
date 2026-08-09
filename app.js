/**
 * Standard Ebooks - Bookshelf & Static Reader App Engine
 */

(function () {
  'use strict';

  // State Store
  const state = {
    subjectCatalog: {},   // Raw subject_top100.json
    allBooks: [],         // All deduplicated book records
    displayedBooks: [],   // Currently filtered books
    activeSubject: 'all',
    searchQuery: '',
    currentPage: 1,
    
    // Active Reader State
    reader: {
      active: false,
      book: None,
      subject: '',
      toc: [],
      chapterIndex: 0,
      fontStyle: 'serif',
      fontSize: 18,
      theme: 'dark',
      timerSeconds: 0,
      timerHandle: null
    },
    
    // User Reading History Storage
    userData: {
      recent: [],          // Last read books list
      bookProgress: {},    // repo_name -> { chapterIndex, scrollPercent, timeSpent }
      totalReadingSeconds: 0
    }
  };

  // Helper for Python None -> JS null compatibility
  function fixStateBook(val) {
    return val === None ? null : val;
  }
  var None = null;

  // Local Storage Key
  const STORAGE_KEY = 'se_reader_user_data_v1';

  /* ==========================================================
     Storage Controller
     ========================================================== */
  function loadUserData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        state.userData.recent = parsed.recent || [];
        state.userData.bookProgress = parsed.bookProgress || {};
        state.userData.totalReadingSeconds = parsed.totalReadingSeconds || 0;
      }
    } catch (e) {
      console.warn('Failed to load user data from localStorage', e);
    }
  }

  function saveUserData() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.userData));
    } catch (e) {
      console.warn('Failed to save user data to localStorage', e);
    }
    updateHeaderStats();
  }

  function updateBookProgress(repoName, bookMeta, chapterIdx, scrollPct, secondsDelta) {
    if (!state.userData.bookProgress[repoName]) {
      state.userData.bookProgress[repoName] = {
        chapterIndex: 0,
        scrollPercent: 0,
        timeSpent: 0
      };
    }

    const item = state.userData.bookProgress[repoName];
    if (chapterIdx !== undefined) item.chapterIndex = chapterIdx;
    if (scrollPct !== undefined) item.scrollPercent = scrollPct;
    if (secondsDelta) {
      item.timeSpent = (item.timeSpent || 0) + secondsDelta;
      state.userData.totalReadingSeconds += secondsDelta;
    }

    // Update Recent list
    const existingIndex = state.userData.recent.findIndex(b => b.repo_name === repoName);
    const recentEntry = {
      repo_name: repoName,
      title: bookMeta.title,
      author: bookMeta.author,
      subject: bookMeta.subject || state.reader.subject,
      chapterIndex: item.chapterIndex,
      scrollPercent: item.scrollPercent,
      timeSpent: item.timeSpent,
      lastReadAt: Date.now()
    };

    if (existingIndex >= 0) {
      state.userData.recent.splice(existingIndex, 1);
    }
    state.userData.recent.unshift(recentEntry);
    
    // Keep max 12 recent items
    if (state.userData.recent.length > 12) {
      state.userData.recent.pop();
    }

    saveUserData();
    renderRecentSection();
  }

  /* ==========================================================
     Catalog Data Loader & Aggregator
     ========================================================== */
  async function loadSubjectCatalog() {
    const counterElem = document.getElementById('booksCounter');
    try {
      const resp = await fetch('./subject_top100.json');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      state.subjectCatalog = await resp.json();

      // Flatten & Deduplicate books while preserving subject tags
      const bookMap = new Map();
      Object.keys(state.subjectCatalog).forEach(subject => {
        const booksInSubject = state.subjectCatalog[subject] || [];
        booksInSubject.forEach(b => {
          if (!bookMap.has(b.repo_name)) {
            bookMap.set(b.repo_name, {
              ...b,
              subject: subject,
              all_subjects: [subject]
            });
          } else {
            const existing = bookMap.get(b.repo_name);
            if (!existing.all_subjects.includes(subject)) {
              existing.all_subjects.push(subject);
            }
          }
        });
      });

      state.allBooks = Array.from(bookMap.values());
      counterElem.textContent = `共收录 ${state.allBooks.length} 本名著`;

      renderSubjectPills();
      filterAndRenderBooks();

    } catch (err) {
      console.error('Failed to load subject_top100.json:', err);
      counterElem.textContent = '载入全站图书数据失败';
      document.getElementById('booksGrid').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">⚠️</div>
          <h3>数据文件载入失败</h3>
          <p>请确保通过本地 HTTP 服务器访问 index.html (例如运行 python -m http.server)</p>
        </div>
      `;
    }
  }

  // Subject Chinese Translations Map
  const SUBJECT_ZH = {
    'adventure': '冒险 Adventure',
    'autobiography': '自传 Autobiography',
    'biography': '传记 Biography',
    'childrens': '儿童文学 Children\'s',
    'comedy': '喜剧 Comedy',
    'drama': '戏剧 Drama',
    'fantasy': '奇幻 Fantasy',
    'fiction': '虚构小说 Fiction',
    'horror': '恐怖小说 Horror',
    'memoir': '回忆录 Memoir',
    'mystery': '悬疑/侦探 Mystery',
    'nonfiction': '非虚构 Non-fiction',
    'philosophy': '哲学 Philosophy',
    'poetry': '诗歌 Poetry',
    'satire': '讽刺 Satire',
    'science-fiction': '科幻 Sci-Fi',
    'shorts': '短篇合集 Shorts',
    'spirituality': '灵性/宗教 Spirituality',
    'travel': '游记 Travel'
  };

  /* ==========================================================
     Bookshelf UI Rendering
     ========================================================== */
  function renderSubjectPills() {
    const container = document.getElementById('subjectPills');
    const subjects = Object.keys(state.subjectCatalog).sort();

    let html = `<button class="pill active" data-subject="all">🌟 全部集合 (${state.allBooks.length})</button>`;
    subjects.forEach(sub => {
      const count = (state.subjectCatalog[sub] || []).length;
      const label = SUBJECT_ZH[sub] || sub;
      html += `<button class="pill" data-subject="${sub}">${label} (${count})</button>`;
    });

    container.innerHTML = html;

    container.querySelectorAll('.pill').forEach(btn => {
      btn.addEventListener('click', (e) => {
        container.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        state.activeSubject = btn.getAttribute('data-subject');
        filterAndRenderBooks(true);
      });
    });
  }

  function filterAndRenderBooks(resetPage = false) {
    if (resetPage || !state.currentPage || typeof state.currentPage !== 'number') {
      state.currentPage = 1;
    }

    let result = state.allBooks;

    // Filter by subject
    if (state.activeSubject !== 'all') {
      result = result.filter(b => b.all_subjects.includes(state.activeSubject));
    }

    // Filter by search query
    if (state.searchQuery.trim()) {
      const q = state.searchQuery.toLowerCase().trim();
      result = result.filter(b => 
        b.title.toLowerCase().includes(q) || 
        b.author.toLowerCase().includes(q) ||
        b.repo_name.toLowerCase().includes(q)
      );
    }

    state.displayedBooks = result;

    // Calculate pagination bounds
    const pageSize = 24;
    const totalPages = Math.ceil(result.length / pageSize) || 1;
    if (state.currentPage > totalPages) state.currentPage = totalPages;
    if (state.currentPage < 1) state.currentPage = 1;

    const startIdx = (state.currentPage - 1) * pageSize;
    const endIdx = startIdx + pageSize;
    const pageBooks = result.slice(startIdx, endIdx);

    renderBooksGrid(pageBooks, result.length);
    renderPaginationBar(totalPages);
  }

  function renderBooksGrid(books, totalFilteredCount) {
    const grid = document.getElementById('booksGrid');
    const emptyState = document.getElementById('emptyState');

    if (!books || books.length === 0) {
      grid.innerHTML = '';
      emptyState.classList.remove('hidden');
      document.getElementById('paginationBar').classList.add('hidden');
      return;
    }

    emptyState.classList.add('hidden');
    
    // Hash function to choose gradient theme
    function getThemeClass(str) {
      let hash = 0;
      for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
      const themeIdx = (Math.abs(hash) % 5) + 1;
      return themeIdx === 1 ? '' : `theme-${themeIdx}`;
    }

    let html = '';
    books.forEach(b => {
      const prog = state.userData.bookProgress[b.repo_name];
      const pct = prog && prog.scrollPercent ? Math.round(prog.scrollPercent * 100) : 0;
      const coverUrl = `./${b.subject}/${b.repo_name}/src/epub/images/cover.svg`;

      html += `
        <div class="book-card" data-repo="${b.repo_name}" data-subject="${b.subject}">
          <div class="book-info">
            <h3 title="${escapeHtml(b.title)}">${escapeHtml(b.title)}</h3>
            <p class="author" title="${escapeHtml(b.author)}">${escapeHtml(b.author)}</p>
          </div>
          <div class="book-cover-container">
            <img class="book-cover-img" loading="lazy" src="${coverUrl}" alt="${escapeHtml(b.title)}" onerror="this.onerror=null; this.src='./${b.subject}/${b.repo_name}/src/epub/images/cover.jpg';">
            <span class="cover-subject-tag">${SUBJECT_ZH[b.subject] || b.subject}</span>
          </div>
          <div class="book-meta-footer">
            <div class="footer-progress-bar">
              <div class="footer-progress-fill" style="width: ${pct}%;"></div>
            </div>
          </div>
        </div>
      `;
    });

    grid.innerHTML = html;

    grid.querySelectorAll('.book-card').forEach(card => {
      card.addEventListener('click', () => {
        const repo = card.getAttribute('data-repo');
        const subject = card.getAttribute('data-subject');
        const bookObj = state.allBooks.find(b => b.repo_name === repo);
        if (bookObj) {
          openBookDetailModal(bookObj, subject);
        }
      });
    });
  }

  async function openBookDetailModal(bookObj, subjectSlug) {
    const modal = document.getElementById('bookDetailModal');
    if (!modal) return;

    const repoName = bookObj.repo_name;
    const subject = subjectSlug || bookObj.subject || 'fiction';
    const coverUrl = `./${subject}/${repoName}/src/epub/images/cover.svg`;

    const img = document.getElementById('detailCoverImg');
    if (img) {
      img.src = coverUrl;
      img.onerror = function() {
        this.onerror = null;
        this.src = `./${subject}/${repoName}/src/epub/images/cover.jpg`;
      };
      
      const coverContainer = img.closest('.book-detail-cover');
      if (coverContainer) {
        coverContainer.onclick = function() {
          openCoverLightbox(img.src);
        };
      }
    }

    const subjectsContainer = document.getElementById('detailSubjectsList');
    if (subjectsContainer) {
      subjectsContainer.innerHTML = `<span class="detail-subject-badge">${SUBJECT_ZH[subject] || subject}</span>`;
    }

    const titleElem = document.getElementById('detailBookTitle');
    if (titleElem) titleElem.textContent = bookObj.title;

    const authorElem = document.getElementById('detailAuthorName');
    if (authorElem) authorElem.textContent = bookObj.author;

    // Progress & Time
    const prog = state.userData.bookProgress[repoName];
    const pct = prog && prog.scrollPercent ? Math.round(prog.scrollPercent * 100) : 0;
    const mins = prog && prog.timeSpent ? Math.round(prog.timeSpent / 60) : 0;

    const progElem = document.getElementById('detailProgressText');
    if (progElem) progElem.textContent = `${pct}%`;

    const timeElem = document.getElementById('detailTimeText');
    if (timeElem) timeElem.textContent = `${mins} 分钟`;

    // Links
    const githubUrl = bookObj.github_url || `https://github.com/standardebooks/${repoName}.git`;
    const webUrl = bookObj.web_url || `https://standardebooks.org/ebooks/${repoName.replace('_', '/', 1)}`;
    
    const githubLink = document.getElementById('detailGithubLink');
    if (githubLink) githubLink.href = githubUrl;

    const webLink = document.getElementById('detailWebLink');
    if (webLink) webLink.href = webUrl;

    // Default loading text for description
    const descElem = document.getElementById('detailDescriptionText');
    const dateElem = document.getElementById('detailDateText');
    const langElem = document.getElementById('detailLangText');

    if (descElem) descElem.innerHTML = '<p class="desc-loading">正在载入图书完整梗概与元数据...</p>';
    if (dateElem) dateElem.textContent = '-';
    if (langElem) langElem.textContent = 'en-US';

    // Start Reading button handler
    const startBtn = document.getElementById('startReadingBtn');
    startBtn.innerHTML = pct > 0 ? `<span>📖 继续阅读 (${pct}%)</span>` : `<span>📖 开始阅读</span>`;
    startBtn.onclick = function() {
      closeBookDetailModal();
      openReader(bookObj, subject);
    };

    modal.classList.remove('hidden');

    // Dynamically fetch & parse OPF metadata
    const opfUrl = `./${subject}/${repoName}/src/epub/content.opf`;
    try {
      const resp = await fetch(opfUrl);
      if (resp.ok) {
        const xmlText = await resp.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlText, 'application/xml');

        // Extract description
        const descNode = doc.querySelector('description, dc\\:description');
        if (descNode && descNode.textContent.trim()) {
          descElem.innerHTML = descNode.textContent.trim();
        } else {
          descElem.innerHTML = '<p>暂无该图书英文梗概信息。</p>';
        }

        // Extract release date
        const dateNode = doc.querySelector('date, dc\\:date');
        if (dateNode && dateNode.textContent) {
          dateElem.textContent = dateNode.textContent.split('T')[0];
        }

        // Extract language
        const langNode = doc.querySelector('language, dc\\:language');
        if (langNode && langNode.textContent) {
          langElem.textContent = langNode.textContent.trim();
        }

        // Extract subjects
        const subjectNodes = doc.querySelectorAll('subject, dc\\:subject');
        if (subjectNodes && subjectNodes.length > 0) {
          let tagsHtml = `<span class="detail-subject-badge">${SUBJECT_ZH[subject] || subject}</span>`;
          subjectNodes.forEach(node => {
            const text = node.textContent.trim();
            if (text) {
              tagsHtml += `<span class="detail-tag-badge">${escapeHtml(text)}</span>`;
            }
          });
          subjectsContainer.innerHTML = tagsHtml;
        }
      } else {
        descElem.innerHTML = '<p>无法调取 OPF 文件元数据。</p>';
      }
    } catch (e) {
      console.warn('OPF metadata parse warning:', e);
      descElem.innerHTML = '<p>无全量 OPF 元数据简介。</p>';
    }
  }

  function closeBookDetailModal() {
    document.getElementById('bookDetailModal').classList.add('hidden');
  }

  function openCoverLightbox(imgSrc) {
    const modal = document.getElementById('coverLightboxModal');
    const img = document.getElementById('lightboxCoverImg');
    if (modal && img) {
      img.src = imgSrc;
      modal.classList.remove('hidden');
    }
  }

  function closeCoverLightbox() {
    const modal = document.getElementById('coverLightboxModal');
    if (modal) {
      modal.classList.add('hidden');
    }
  }

  function renderPaginationBar(totalPages) {
    const container = document.getElementById('paginationBar');
    if (totalPages <= 1) {
      container.classList.add('hidden');
      return;
    }

    container.classList.remove('hidden');
    container.innerHTML = `
      <button id="prevPageBtn" class="page-nav-btn" ${state.currentPage === 1 ? 'disabled' : ''}>← 上一页</button>
      <span class="page-indicator">第 ${state.currentPage} / ${totalPages} 页</span>
      <button id="nextPageBtn" class="page-nav-btn" ${state.currentPage === totalPages ? 'disabled' : ''}>下一页 →</button>
    `;

    document.getElementById('prevPageBtn').addEventListener('click', () => {
      if (state.currentPage > 1) {
        state.currentPage--;
        filterAndRenderBooks(false);
        window.scrollTo({ top: 300, behavior: 'smooth' });
      }
    });

    document.getElementById('nextPageBtn').addEventListener('click', () => {
      if (state.currentPage < totalPages) {
        state.currentPage++;
        filterAndRenderBooks(false);
        window.scrollTo({ top: 300, behavior: 'smooth' });
      }
    });
  }

  function removeRecentBook(repoName) {
    const idx = state.userData.recent.findIndex(b => b.repo_name === repoName);
    if (idx >= 0) {
      state.userData.recent.splice(idx, 1);
      saveUserData();
      renderRecentSection();
    }
  }

  function renderRecentSection() {
    const grid = document.getElementById('recentGrid');
    const emptyState = document.getElementById('recentEmptyState');
    const badge = document.getElementById('recentTabBadge');

    const recentList = state.userData.recent || [];
    badge.textContent = recentList.length;

    if (recentList.length === 0) {
      grid.innerHTML = '';
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');

    let html = '';
    recentList.forEach(item => {
      const pct = Math.round((item.scrollPercent || 0) * 100);
      const timeMin = Math.round((item.timeSpent || 0) / 60);
      const coverUrl = `./${item.subject}/${item.repo_name}/src/epub/images/cover.svg`;

      html += `
        <div class="book-card recent-card-item" data-repo="${item.repo_name}" data-subject="${item.subject}">
          <button class="delete-recent-btn" data-repo="${item.repo_name}" title="从最近阅读彻底删除">✕</button>
          <div class="book-info">
            <h3 title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</h3>
            <p class="author" title="${escapeHtml(item.author)}">${escapeHtml(item.author)}</p>
          </div>
          <div class="book-cover-container">
            <img class="book-cover-img" loading="lazy" src="${coverUrl}" alt="${escapeHtml(item.title)}" onerror="this.onerror=null; this.src='./${item.subject}/${item.repo_name}/src/epub/images/cover.jpg';">
            <span class="cover-subject-tag">${SUBJECT_ZH[item.subject] || item.subject}</span>
          </div>
          <div class="book-meta-footer">
            <div class="footer-progress-bar">
              <div class="footer-progress-fill" style="width: ${pct}%;"></div>
            </div>
          </div>
        </div>
      `;
    });

    grid.innerHTML = html;

    // Delete buttons event listener
    grid.querySelectorAll('.delete-recent-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const repo = btn.getAttribute('data-repo');
        removeRecentBook(repo);
      });
    });

    // Card click event listener to open reader
    grid.querySelectorAll('.recent-card-item').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.classList.contains('delete-recent-btn')) return;
        const repo = card.getAttribute('data-repo');
        const subject = card.getAttribute('data-subject');
        let bookObj = state.allBooks.find(b => b.repo_name === repo);
        if (!bookObj) {
          bookObj = { repo_name: repo, title: card.querySelector('h3').textContent, author: card.querySelector('p').textContent, subject: subject };
        }
        openBookDetailModal(bookObj, subject);
      });
    });
  }

  /* ==========================================================
     Reader Controller (TOC & Chapter Fetching)
     ========================================================== */
  async function openReader(bookObj, subjectSlug) {
    state.reader.active = true;
    state.reader.book = bookObj;
    state.reader.subject = subjectSlug || bookObj.subject;
    state.reader.timerSeconds = 0;

    // Set Header titles
    document.getElementById('readerBookTitle').textContent = bookObj.title;
    document.getElementById('readerAuthorName').textContent = bookObj.author;

    // Show Reader Overlay
    const overlay = document.getElementById('readerOverlay');
    overlay.classList.remove('hidden');

    // Restore user progress if available
    const saved = state.userData.bookProgress[bookObj.repo_name];
    const targetChapterIdx = saved ? (saved.chapterIndex || 0) : 0;

    startReaderTimer();

    // Load TOC
    await loadBookToc(bookObj.repo_name, state.reader.subject, targetChapterIdx);
  }

  function closeReader() {
    stopReaderTimer();
    state.reader.active = false;
    document.getElementById('readerOverlay').classList.add('hidden');
    renderRecentSection();
    filterAndRenderBooks();
  }

  async function loadBookToc(repoName, subjectSlug, defaultChapterIdx = 0) {
    const nav = document.getElementById('tocNav');
    nav.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>读取目录中...</p></div>';

    const tocUrl = `./${subjectSlug}/${repoName}/src/epub/toc.xhtml`;
    try {
      const resp = await fetch(tocUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const xmlText = await resp.text();

      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, 'application/xhtml+xml');
      
      const tocLinks = doc.querySelectorAll('nav#toc a, ol a, nav a');
      const tocList = [];

      tocLinks.forEach(a => {
        const href = a.getAttribute('href');
        const title = a.textContent.trim();
        if (href && title && !href.startsWith('#')) {
          tocList.push({ title: title, href: href });
        }
      });

      if (tocList.length === 0) {
        // Fallback default chapter
        tocList.push({ title: '开始阅读', href: 'text/chapter-1.xhtml' });
      }

      state.reader.toc = tocList;
      renderTocNav(tocList, defaultChapterIdx);

      // Load target chapter
      const validIdx = (defaultChapterIdx >= 0 && defaultChapterIdx < tocList.length) ? defaultChapterIdx : 0;
      loadChapter(validIdx);

    } catch (err) {
      console.error('Failed to load TOC:', err);
      nav.innerHTML = '<p style="padding:1rem; color:var(--text-sub);">无法载入本书目录，尝试默认第一章...</p>';
      state.reader.toc = [{ title: '第一章', href: 'text/chapter-1.xhtml' }];
      loadChapter(0);
    }
  }

  function renderTocNav(tocList, activeIdx) {
    const nav = document.getElementById('tocNav');
    let html = '<ol>';
    tocList.forEach((item, idx) => {
      const activeClass = idx === activeIdx ? 'active-chapter' : '';
      html += `<li><a href="#" class="${activeClass}" data-idx="${idx}">${escapeHtml(item.title)}</a></li>`;
    });
    html += '</ol>';
    nav.innerHTML = html;

    nav.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const idx = parseInt(a.getAttribute('data-idx'), 10);
        loadChapter(idx);
        // Collapse TOC on mobile
        document.getElementById('tocSidebar').classList.add('collapsed');
      });
    });
  }

  async function loadChapter(chapterIdx) {
    const container = document.getElementById('chapterContainer');
    container.innerHTML = `
      <div class="loading-spinner">
        <div class="spinner"></div>
        <p>正在载入章节内容...</p>
      </div>
    `;

    if (!state.reader.toc || state.reader.toc.length === 0) return;

    state.reader.chapterIndex = chapterIdx;

    // Highlight TOC active chapter
    const nav = document.getElementById('tocNav');
    nav.querySelectorAll('a').forEach(a => a.classList.remove('active-chapter'));
    const activeLink = nav.querySelector(`a[data-idx="${chapterIdx}"]`);
    if (activeLink) activeLink.classList.add('active-chapter');

    const chapterItem = state.reader.toc[chapterIdx];
    const repoName = state.reader.book.repo_name;
    const subjectSlug = state.reader.subject;
    
    // Resolve clean chapter relative path
    let relPath = chapterItem.href;
    if (relPath.startsWith('epub/')) relPath = relPath.replace('epub/', '');
    const chapterUrl = `./${subjectSlug}/${repoName}/src/epub/${relPath}`;

    try {
      const resp = await fetch(chapterUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const rawText = await resp.text();

      const parser = new DOMParser();
      const doc = parser.parseFromString(rawText, 'application/xhtml+xml');

      // Extract body or section HTML
      const body = doc.querySelector('body') || doc.documentElement;

      // Fix image paths to relative submodule images folder
      const images = body.querySelectorAll('img, image');
      images.forEach(img => {
        let src = img.getAttribute('src') || img.getAttribute('href') || img.getAttribute('xlink:href');
        if (src && !src.startsWith('http') && !src.startsWith('data:')) {
          if (src.startsWith('../')) src = src.replace('../', '');
          const newSrc = `./${subjectSlug}/${repoName}/src/epub/${src}`;
          img.setAttribute('src', newSrc);
          if (img.hasAttribute('xlink:href')) img.setAttribute('xlink:href', newSrc);
        }
      });

      container.innerHTML = body.innerHTML;

      // Update Nav Buttons & Progress text
      document.getElementById('chapterProgressText').textContent = `章节 ${chapterIdx + 1} / ${state.reader.toc.length}`;
      document.getElementById('prevChapterBtn').disabled = (chapterIdx === 0);
      document.getElementById('nextChapterBtn').disabled = (chapterIdx >= state.reader.toc.length - 1);

      // Restore scroll position if opening current saved chapter
      const saved = state.userData.bookProgress[repoName];
      const canvas = document.getElementById('readerCanvas');
      if (saved && saved.chapterIndex === chapterIdx && saved.scrollPercent) {
        setTimeout(() => {
          const maxScroll = canvas.scrollHeight - canvas.clientHeight;
          canvas.scrollTop = maxScroll * saved.scrollPercent;
        }, 100);
      } else {
        canvas.scrollTop = 0;
      }

      updateReaderProgress();

    } catch (err) {
      console.error(`Failed to load chapter ${chapterUrl}:`, err);
      container.innerHTML = `
        <div class="empty-state">
          <h3>章节载入失败</h3>
          <p>无法获取文件路径: ${escapeHtml(chapterUrl)}</p>
        </div>
      `;
    }
  }

  /* ==========================================================
     Reading Progress & Timer Controller
     ========================================================== */
  function updateReaderProgress() {
    const canvas = document.getElementById('readerCanvas');
    const maxScroll = canvas.scrollHeight - canvas.clientHeight;
    let scrollPct = maxScroll > 0 ? (canvas.scrollTop / maxScroll) : 0;
    if (scrollPct > 1) scrollPct = 1;
    if (scrollPct < 0) scrollPct = 0;

    // Overall progress (combine chapter index + scroll pct within chapter)
    const totalChapters = state.reader.toc.length || 1;
    const overallPct = ((state.reader.chapterIndex + scrollPct) / totalChapters) * 100;
    
    document.getElementById('readerProgressBar').style.width = `${Math.min(overallPct, 100)}%`;

    if (state.reader.active && state.reader.book) {
      updateBookProgress(state.reader.book.repo_name, state.reader.book, state.reader.chapterIndex, scrollPct, 0);
    }
  }

  function startReaderTimer() {
    stopReaderTimer();
    state.reader.timerHandle = setInterval(() => {
      if (state.reader.active && !document.hidden) {
        state.reader.timerSeconds++;
        updateTimerDisplay(state.reader.timerSeconds);
        // Accumulate 1 second to book and total
        if (state.reader.book) {
          updateBookProgress(state.reader.book.repo_name, state.reader.book, undefined, undefined, 1);
        }
      }
    }, 1000);
  }

  function stopReaderTimer() {
    if (state.reader.timerHandle) {
      clearInterval(state.reader.timerHandle);
      state.reader.timerHandle = null;
    }
  }

  function updateTimerDisplay(totalSecs) {
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    const fmt = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    document.getElementById('readerTimerText').textContent = fmt;
  }

  function updateHeaderStats() {
    const totalSecs = state.userData.totalReadingSeconds || 0;
    const totalMins = Math.round(totalSecs / 60);
    document.getElementById('headerTotalTime').textContent = `${totalMins} 分钟`;
  }

  /* ==========================================================
     Modal & Toolbar Controls
     ========================================================== */
  function setupEventListeners() {
    // Main Navigation Mode Tabs
    const tabBrowseBtn = document.getElementById('tabBrowseBtn');
    const tabRecentBtn = document.getElementById('tabRecentBtn');
    const viewBrowse = document.getElementById('viewBrowse');
    const viewRecent = document.getElementById('viewRecent');

    tabBrowseBtn.addEventListener('click', () => {
      tabBrowseBtn.classList.add('active');
      tabRecentBtn.classList.remove('active');
      viewBrowse.classList.remove('hidden');
      viewRecent.classList.add('hidden');
    });

    tabRecentBtn.addEventListener('click', () => {
      tabRecentBtn.classList.add('active');
      tabBrowseBtn.classList.remove('active');
      viewRecent.classList.remove('hidden');
      viewBrowse.classList.add('hidden');
      renderRecentSection();
    });

    // Search input
    const searchInput = document.getElementById('searchInput');
    const clearBtn = document.getElementById('clearSearchBtn');
    searchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      if (state.searchQuery) {
        clearBtn.classList.remove('hidden');
      } else {
        clearBtn.classList.add('hidden');
      }
      filterAndRenderBooks();
    });

    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      state.searchQuery = '';
      clearBtn.classList.add('hidden');
      filterAndRenderBooks();
    });

    // Global Theme Toggle
    const themeBtn = document.getElementById('globalThemeToggle');
    themeBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      themeBtn.querySelector('.theme-icon').textContent = next === 'dark' ? '🌙' : '☀️';
    });

    // Reader Close
    document.getElementById('closeReaderBtn').addEventListener('click', closeReader);

    // TOC Drawer Toggle
    document.getElementById('toggleTocBtn').addEventListener('click', () => {
      document.getElementById('tocSidebar').classList.toggle('collapsed');
    });
    document.getElementById('closeTocBtn').addEventListener('click', () => {
      document.getElementById('tocSidebar').classList.add('collapsed');
    });

    // Reader Settings Drawer Toggle
    document.getElementById('toggleSettingsBtn').addEventListener('click', () => {
      document.getElementById('readerSettingsDrawer').classList.toggle('hidden');
    });

    // Reader Themes
    document.querySelectorAll('.theme-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.theme-opt').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const theme = btn.getAttribute('data-reader-theme');
        document.getElementById('readerOverlay').setAttribute('data-reader-theme', theme);
      });
    });

    // Reader Fonts
    document.querySelectorAll('.font-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.font-opt').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const font = btn.getAttribute('data-font');
        const container = document.getElementById('chapterContainer');
        if (font === 'serif') {
          container.classList.remove('sans-mode');
          container.classList.add('serif-mode');
        } else {
          container.classList.remove('serif-mode');
          container.classList.add('sans-mode');
        }
      });
    });

    // Reader Font Sizes
    document.getElementById('fontIncBtn').addEventListener('click', () => {
      if (state.reader.fontSize < 32) {
        state.reader.fontSize += 2;
        document.getElementById('fontSizeDisplay').textContent = `${state.reader.fontSize}px`;
        document.getElementById('chapterContainer').style.fontSize = `${state.reader.fontSize}px`;
      }
    });

    document.getElementById('fontDecBtn').addEventListener('click', () => {
      if (state.reader.fontSize > 12) {
        state.reader.fontSize -= 2;
        document.getElementById('fontSizeDisplay').textContent = `${state.reader.fontSize}px`;
        document.getElementById('chapterContainer').style.fontSize = `${state.reader.fontSize}px`;
      }
    });

    // Chapter Navigation Buttons
    document.getElementById('prevChapterBtn').addEventListener('click', () => {
      if (state.reader.chapterIndex > 0) {
        loadChapter(state.reader.chapterIndex - 1);
      }
    });

    document.getElementById('nextChapterBtn').addEventListener('click', () => {
      if (state.reader.chapterIndex < state.reader.toc.length - 1) {
        loadChapter(state.reader.chapterIndex + 1);
      }
    });

    // Canvas Scroll Event for Reading Progress
    const canvas = document.getElementById('readerCanvas');
    canvas.addEventListener('scroll', throttle(updateReaderProgress, 200));

    // Stats & Detail Modal Controls
    document.getElementById('statsModalBtn').addEventListener('click', openStatsModal);
    document.getElementById('closeStatsBtn').addEventListener('click', closeStatsModal);
    document.getElementById('closeBookDetailBtn').addEventListener('click', closeBookDetailModal);
    
    // Backdrop Clicks to close modals
    const detailModal = document.getElementById('bookDetailModal');
    if (detailModal) {
      detailModal.addEventListener('click', (e) => {
        if (e.target === detailModal) closeBookDetailModal();
      });
    }

    const statsModal = document.getElementById('statsModal');
    if (statsModal) {
      statsModal.addEventListener('click', (e) => {
        if (e.target === statsModal) closeStatsModal();
      });
    }

    // Cover Lightbox Controls
    const closeLightboxBtn = document.getElementById('closeCoverLightboxBtn');
    if (closeLightboxBtn) closeLightboxBtn.addEventListener('click', closeCoverLightbox);

    const lightboxModal = document.getElementById('coverLightboxModal');
    if (lightboxModal) {
      lightboxModal.addEventListener('click', (e) => {
        if (e.target === lightboxModal) closeCoverLightbox();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeCoverLightbox();
        closeBookDetailModal();
        closeStatsModal();
      }
    });

    document.getElementById('resetStatsBtn').addEventListener('click', () => {
      if (confirm('确认重置所有最近阅读与时间统计数据？此操作不可撤销。')) {
        localStorage.removeItem(STORAGE_KEY);
        state.userData = { recent: [], bookProgress: {}, totalReadingSeconds: 0 };
        saveUserData();
        closeStatsModal();
        renderRecentSection();
        filterAndRenderBooks();
      }
    });
  }

  function openStatsModal() {
    const modal = document.getElementById('statsModal');
    modal.classList.remove('hidden');

    const totalBooks = Object.keys(state.userData.bookProgress).length;
    const totalSecs = state.userData.totalReadingSeconds || 0;
    const totalMins = Math.round(totalSecs / 60);

    document.getElementById('statTotalBooks').textContent = totalBooks;
    document.getElementById('statTotalTime').textContent = `${totalMins} 分钟`;

    const list = document.getElementById('bookTimeList');
    let html = '';
    const progressMap = state.userData.bookProgress;
    Object.keys(progressMap).forEach(repo => {
      const item = progressMap[repo];
      const bookObj = state.allBooks.find(b => b.repo_name === repo);
      const title = bookObj ? bookObj.title : repo;
      const mins = Math.round((item.timeSpent || 0) / 60);
      html += `
        <div class="book-time-item">
          <span>${escapeHtml(title)}</span>
          <span>${mins} 分钟</span>
        </div>
      `;
    });

    list.innerHTML = html || '<p style="color:var(--text-sub); text-align:center;">暂无记录</p>';
  }

  function closeStatsModal() {
    document.getElementById('statsModal').classList.add('hidden');
  }

  /* Utilities */
  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function throttle(func, limit) {
    let inThrottle;
    return function() {
      const args = arguments;
      const context = this;
      if (!inThrottle) {
        func.apply(context, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  }

  /* Application Entry Point */
  document.addEventListener('DOMContentLoaded', () => {
    loadUserData();
    setupEventListeners();
    loadSubjectCatalog();
    renderRecentSection();
  });

})();
