(function () {
  'use strict';

  const STORAGE_KEY = 'se_reader_user_data_v2';
  const LEGACY_STORAGE_KEY = 'se_reader_user_data_v1';
  const PAGE_SIZE = 24;
  const TIMER_FLUSH_SECONDS = 15;

  const SUBJECT_ZH = {
    adventure: '冒险 Adventure',
    autobiography: '自传 Autobiography',
    biography: '传记 Biography',
    childrens: "儿童文学 Children's",
    comedy: '喜剧 Comedy',
    drama: '戏剧 Drama',
    fantasy: '奇幻 Fantasy',
    fiction: '虚构小说 Fiction',
    horror: '恐怖小说 Horror',
    memoir: '回忆录 Memoir',
    mystery: '悬疑/侦探 Mystery',
    nonfiction: '非虚构 Non-fiction',
    philosophy: '哲学 Philosophy',
    poetry: '诗歌 Poetry',
    satire: '讽刺 Satire',
    'science-fiction': '科幻 Sci-Fi',
    shorts: '短篇合集 Shorts',
    spirituality: '灵性/宗教 Spirituality',
    travel: '游记 Travel'
  };

  const DEFAULT_PREFERENCES = Object.freeze({
    appTheme: 'system',
    readerTheme: 'auto',
    readerFont: 'serif',
    fontSize: 18,
    lineHeight: 1.8,
    contentWidth: 680
  });

  function createDefaultUserData() {
    return {
      version: 2,
      recent: [],
      bookProgress: {},
      totalReadingSeconds: 0,
      favorites: [],
      preferences: { ...DEFAULT_PREFERENCES }
    };
  }

  const state = {
    catalog: null,
    subjects: [],
    subjectCatalog: {},
    allBooks: [],
    visibleCount: PAGE_SIZE,
    activeView: 'library',
    filters: { query: '', subjects: [], sort: 'default', favoriteOnly: false },
    userData: createDefaultUserData(),
    currentDetailBook: null,
    lastDetailTrigger: null,
    reader: {
      active: false,
      book: null,
      subject: '',
      toc: [],
      chapterIndex: 0,
      sessionSeconds: 0,
      pendingSeconds: 0,
      timerHandle: null,
      loadToken: 0,
      chapterLoaded: false
    }
  };

  const dom = {};
  let saveTimer = null;
  let searchTimer = null;
  let toastTimer = null;
  let metadataController = null;

  function cacheDom() {
    [
      'searchInput', 'clearSearchBtn', 'themeToggle', 'continuePanel', 'welcomePanel',
      'continueCover', 'continueTitle', 'continueAuthor', 'continueProgressText',
      'continueChapterText', 'continueProgressBar', 'continueReadingBtn', 'libraryTab',
      'favoritesTab', 'recentTab', 'favoriteBadge', 'recentBadge', 'libraryView',
      'favoritesView', 'recentView', 'subjectCheckboxes', 'sortButtons', 'favoriteOnlyInput',
      'resultsCount', 'clearFiltersBtn', 'booksGrid', 'libraryEmpty', 'loadMoreBtn',
      'favoritesGrid', 'favoritesEmpty', 'favoritesCount', 'recentGrid', 'recentEmpty',
      'statBooks', 'statTime', 'statFavorites', 'mobileFilterBtn', 'filterDialog',
      'welcomeCatalogText', 'catalogLocalBooks', 'catalogOfficialBooks',
      'catalogSubjectCount', 'catalogSourceLink', 'catalogUpdated',
      'mobileSubjectCheckboxes', 'mobileSortButtons', 'mobileFavoriteOnlyInput',
      'mobileClearFiltersBtn', 'applyMobileFiltersBtn', 'bookDetailDialog',
      'closeDetailBtn', 'detailCoverButton', 'detailCoverImg', 'detailProgressText',
      'detailTimeText', 'detailDateText', 'detailLangText', 'detailSubjectsList',
      'detailBookTitle', 'detailAuthorName', 'detailDescriptionText', 'startReadingBtn',
      'detailFavoriteBtn', 'detailWebLink', 'coverDialog', 'closeCoverBtn',
      'coverPreviewImg', 'resetDataBtn', 'resetDialog', 'confirmResetBtn',
      'readerOverlay', 'closeReaderBtn', 'readerBookTitle', 'readerAuthorName',
      'readerProgressBar', 'toggleTocBtn', 'toggleSettingsBtn',
      'readerScrim', 'tocDrawer', 'closeTocBtn', 'tocNav', 'readerSettingsPanel',
      'closeSettingsBtn', 'readerThemeSelect', 'readerFontSelect', 'fontSizeInput',
      'fontSizeOutput', 'lineHeightInput', 'lineHeightOutput', 'contentWidthInput',
      'contentWidthOutput', 'readerCanvas', 'chapterContainer', 'prevChapterBtn',
      'nextChapterBtn', 'chapterProgressText', 'toastRegion'
    ].forEach(id => { dom[id] = document.getElementById(id); });
  }

  function finiteNumber(value, fallback, min = -Infinity, max = Infinity) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  function normalizePreferences(value) {
    const input = value && typeof value === 'object' ? value : {};
    const appThemes = ['system', 'light', 'dark'];
    const readerThemes = ['auto', 'paper', 'light', 'dark'];
    const fonts = ['serif', 'sans'];
    return {
      appTheme: appThemes.includes(input.appTheme) ? input.appTheme : DEFAULT_PREFERENCES.appTheme,
      readerTheme: readerThemes.includes(input.readerTheme) ? input.readerTheme : DEFAULT_PREFERENCES.readerTheme,
      readerFont: fonts.includes(input.readerFont) ? input.readerFont : DEFAULT_PREFERENCES.readerFont,
      fontSize: finiteNumber(input.fontSize, 18, 14, 32),
      lineHeight: finiteNumber(input.lineHeight, 1.8, 1.4, 2.2),
      contentWidth: finiteNumber(input.contentWidth, 680, 520, 840)
    };
  }

  function normalizeProgressMap(value) {
    const source = value && typeof value === 'object' ? value : {};
    const result = {};
    Object.entries(source).forEach(([repo, item]) => {
      if (!item || typeof item !== 'object') return;
      const scrollPercent = finiteNumber(item.scrollPercent, 0, 0, 1);
      result[repo] = {
        chapterIndex: Math.round(finiteNumber(item.chapterIndex, 0, 0)),
        scrollPercent,
        overallPercent: finiteNumber(item.overallPercent, scrollPercent, 0, 1),
        timeSpent: Math.round(finiteNumber(item.timeSpent, 0, 0))
      };
    });
    return result;
  }

  function normalizeUserData(value) {
    const input = value && typeof value === 'object' ? value : {};
    return {
      version: 2,
      recent: Array.isArray(input.recent) ? input.recent.filter(item => item && typeof item.repo_name === 'string').slice(0, 24) : [],
      bookProgress: normalizeProgressMap(input.bookProgress),
      totalReadingSeconds: Math.round(finiteNumber(input.totalReadingSeconds, 0, 0)),
      favorites: Array.isArray(input.favorites) ? [...new Set(input.favorites.filter(item => typeof item === 'string'))] : [],
      preferences: normalizePreferences(input.preferences)
    };
  }

  function loadUserData() {
    try {
      const current = localStorage.getItem(STORAGE_KEY);
      if (current) {
        state.userData = normalizeUserData(JSON.parse(current));
        return;
      }
    } catch (error) {
      console.warn('无法读取新版阅读数据，已使用默认状态。', error);
    }

    try {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy) {
        state.userData = normalizeUserData(JSON.parse(legacy));
        saveUserData();
        return;
      }
    } catch (error) {
      console.warn('旧版阅读数据迁移失败，已使用默认状态。', error);
    }

    state.userData = createDefaultUserData();
  }

  function saveUserData() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.userData));
    } catch (error) {
      console.warn('阅读数据保存失败。', error);
    }
  }

  function scheduleSave(delay = 800) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveUserData, delay);
  }

  function resolveAppTheme(choice) {
    if (choice === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return choice;
  }

  function applyAppTheme() {
    const choice = state.userData.preferences.appTheme;
    document.documentElement.dataset.theme = resolveAppTheme(choice);
    document.documentElement.dataset.themeChoice = choice;
    const labels = { system: '跟随系统', light: '浅色', dark: '深色' };
    dom.themeToggle.title = `主题：${labels[choice]}`;
    dom.themeToggle.setAttribute('aria-label', `当前主题：${labels[choice]}，点击切换`);
  }

  function cycleAppTheme() {
    const order = ['system', 'light', 'dark'];
    const current = state.userData.preferences.appTheme;
    state.userData.preferences.appTheme = order[(order.indexOf(current) + 1) % order.length];
    applyAppTheme();
    scheduleSave(0);
    showToast(`站点主题：${dom.themeToggle.title.replace('主题：', '')}`);
  }

  function assetUrl(book, relativePath) {
    const fallback = `${book.subject}/${book.repo_name}/src/epub`;
    const base = String(book.asset_path || fallback).replace(/^\.\//, '').replace(/\/+$/, '');
    return `./${base}/${String(relativePath).replace(/^\/+/, '')}`;
  }

  function coverUrl(book, extension = 'svg') {
    return assetUrl(book, `images/cover.${extension}`);
  }

  function setCoverFallback(img, book) {
    img.addEventListener('error', () => {
      if (!img.dataset.jpgTried) {
        img.dataset.jpgTried = 'true';
        img.src = coverUrl(book, 'jpg');
        return;
      }
      const fallback = document.createElement('div');
      fallback.className = 'cover-fallback';
      fallback.textContent = book.title;
      img.replaceWith(fallback);
    });
  }

  async function loadCatalog() {
    renderSkeletons();
    try {
      const response = await fetch('./subject_top.json');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const catalog = await response.json();
      if (catalog?.schema_version !== 2 || !Array.isArray(catalog.subjects) || !Array.isArray(catalog.books)) {
        throw new Error('不支持的书目数据格式');
      }
      state.catalog = catalog;
      state.subjects = catalog.subjects;
      state.subjectCatalog = Object.fromEntries(catalog.subjects.map(subject => [subject.slug, subject]));
      state.allBooks = catalog.books.map((book, index) => {
        const subjectLinks = Array.isArray(book.subjects) ? book.subjects : [];
        const allSubjects = subjectLinks.map(item => typeof item === 'string' ? item : item.slug).filter(Boolean);
        return {
          ...book,
          subject: allSubjects[0] || '',
          all_subjects: allSubjects,
          _index: index
        };
      });
      renderCatalogOverview();
      populateFilterOptions();
      renderAll();
    } catch (error) {
      console.error('书目载入失败。', error);
      dom.booksGrid.innerHTML = '';
      dom.libraryEmpty.classList.remove('hidden');
      dom.libraryEmpty.querySelector('h3').textContent = '书目数据载入失败';
      dom.libraryEmpty.querySelector('p').textContent = '请确认通过本地 HTTP 服务访问，并检查 subject_top.json。';
      dom.resultsCount.textContent = '无法读取馆藏';
    }
  }

  function renderCatalogOverview() {
    const sources = state.catalog?.sources || {};
    const localCount = state.allBooks.length;
    const officialCount = finiteNumber(sources.official_book_count, 0, 0);
    dom.catalogLocalBooks.textContent = localCount.toLocaleString('zh-CN');
    dom.catalogOfficialBooks.textContent = officialCount ? officialCount.toLocaleString('zh-CN') : '—';
    dom.catalogSubjectCount.textContent = state.subjects.length.toLocaleString('zh-CN');
    dom.welcomeCatalogText.textContent = `${localCount.toLocaleString('zh-CN')} 本精校公版名著，随时打开，安静阅读。`;
    dom.catalogSourceLink.href = sources.subjects_url || 'https://standardebooks.org/bulk-downloads/subjects';
    const generatedAt = state.catalog?.generated_at ? new Date(state.catalog.generated_at) : null;
    dom.catalogUpdated.textContent = generatedAt && !Number.isNaN(generatedAt.getTime())
      ? `更新于 ${generatedAt.toLocaleDateString('zh-CN')}`
      : '';
  }

  function populateFilterOptions() {
    [
      [dom.subjectCheckboxes, 'subject', dom.favoriteOnlyInput.closest('label'), dom.sortButtons.closest('.sort-filter-group')],
      [dom.mobileSubjectCheckboxes, 'mobile-subject', dom.mobileFavoriteOnlyInput.closest('label'), null]
    ].forEach(([container, prefix, favoriteOption, sortGroup]) => {
      const fragment = document.createDocumentFragment();
      fragment.appendChild(createSubjectCheckbox('all', '全部分类', '', prefix));
      fragment.appendChild(favoriteOption);
      state.subjects.forEach(subject => {
        const label = subject.name_zh ? `${subject.name_zh} ${subject.name}` : (SUBJECT_ZH[subject.slug] || subject.name || subject.slug);
        fragment.appendChild(createSubjectCheckbox(subject.slug, label, subject.local_book_count, prefix, subject.official_book_count));
      });
      if (sortGroup) fragment.appendChild(sortGroup);
      container.replaceChildren(fragment);
    });
    syncFilterControls();
  }

  function createSubjectCheckbox(value, label, count, prefix, officialCount = null) {
    const wrapper = document.createElement('label');
    wrapper.className = value === 'all' ? 'filter-check filter-special all-filter' : 'filter-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = value;
    input.id = `${prefix}-${value}`;
    input.dataset.subjectFilter = 'true';
    const text = document.createElement('span');
    text.textContent = count === '' ? label : `${label} (${count})`;
    if (Number.isFinite(Number(officialCount))) wrapper.title = `本站 ${count} 本 · 官网 ${Number(officialCount).toLocaleString('zh-CN')} 本`;
    wrapper.append(input, text);
    return wrapper;
  }

  function renderSkeletons() {
    dom.booksGrid.innerHTML = Array.from({ length: 12 }, () => '<div class="skeleton-card" aria-hidden="true"></div>').join('');
  }

  function getProgress(repoName) {
    const progress = state.userData.bookProgress[repoName];
    return progress ? finiteNumber(progress.overallPercent, progress.scrollPercent || 0, 0, 1) : 0;
  }

  function isFavorite(repoName) {
    return state.userData.favorites.includes(repoName);
  }

  function matchesSearch(book, query) {
    if (!query) return true;
    const haystack = `${book.title} ${book.author} ${book.repo_name}`.toLocaleLowerCase();
    return haystack.includes(query.toLocaleLowerCase());
  }

  function getFilteredBooks() {
    const { query, subjects, sort, favoriteOnly } = state.filters;
    let books = state.allBooks.filter(book => {
      if (subjects.length && !subjects.some(subject => book.all_subjects.includes(subject))) return false;
      if (favoriteOnly && !isFavorite(book.repo_name)) return false;
      return matchesSearch(book, query.trim());
    });

    if (sort === 'title') books.sort((a, b) => a.title.localeCompare(b.title, 'en'));
    if (sort === 'author') books.sort((a, b) => a.author.localeCompare(b.author, 'en'));
    if (sort === 'progress') books.sort((a, b) => getProgress(b.repo_name) - getProgress(a.repo_name) || a._index - b._index);
    return books;
  }

  function renderAll() {
    renderHeaderCounts();
    renderContinuePanel();
    renderLibrary();
    renderFavorites();
    renderRecent();
    renderStats();
  }

  function renderHeaderCounts() {
    dom.favoriteBadge.textContent = state.userData.favorites.length;
    dom.recentBadge.textContent = state.userData.recent.length;
  }

  function renderContinuePanel() {
    const entry = state.userData.recent[0];
    const book = entry && state.allBooks.find(item => item.repo_name === entry.repo_name);
    if (!book) {
      dom.continuePanel.classList.add('hidden');
      dom.welcomePanel.classList.remove('hidden');
      return;
    }

    const progress = state.userData.bookProgress[book.repo_name] || {};
    const percent = Math.round(getProgress(book.repo_name) * 100);
    delete dom.continueCover.dataset.jpgTried;
    dom.continueCover.src = coverUrl(book);
    dom.continueCover.alt = `${book.title} 封面`;
    dom.continueCover.onerror = () => {
      if (!dom.continueCover.dataset.jpgTried) {
        dom.continueCover.dataset.jpgTried = 'true';
        dom.continueCover.src = coverUrl(book, 'jpg');
      }
    };
    dom.continueTitle.textContent = book.title;
    dom.continueAuthor.textContent = book.author;
    dom.continueProgressText.textContent = `${percent}%`;
    dom.continueChapterText.textContent = `第 ${(progress.chapterIndex || 0) + 1} 章`;
    dom.continueProgressBar.style.width = `${percent}%`;
    dom.continueReadingBtn.dataset.repo = book.repo_name;
    dom.continuePanel.classList.remove('hidden');
    dom.welcomePanel.classList.add('hidden');
  }

  function createBookCard(book) {
    const card = document.createElement('article');
    card.className = 'book-card';
    card.dataset.repo = book.repo_name;
    const percent = Math.round(getProgress(book.repo_name) * 100);
    const favorite = isFavorite(book.repo_name);
    card.innerHTML = `
      <button class="card-favorite" type="button" title="${favorite ? '取消收藏' : '加入收藏'}" aria-label="${favorite ? '取消收藏' : '收藏'} ${escapeHtml(book.title)}" aria-pressed="${favorite}">
        <svg><use href="#icon-heart"></use></svg>
      </button>
      <button class="book-card-main" type="button" aria-label="查看《${escapeHtml(book.title)}》详情">
        <div class="book-card-cover"><img loading="lazy" src="${coverUrl(book)}" alt="${escapeHtml(book.title)}封面"></div>
        <div class="book-card-body">
          <h3 class="book-title" title="${escapeHtml(book.title)}">${escapeHtml(book.title)}</h3>
          <p class="book-author">${escapeHtml(book.author)}</p>
          ${percent > 0 ? `<div class="card-progress"><div class="card-progress-row"><span>阅读进度</span><span>${percent}%</span></div><div class="progress-track"><span style="width:${percent}%"></span></div></div>` : ''}
        </div>
      </button>
      ${percent > 0 ? '<button class="secondary-button card-continue" type="button">继续阅读</button>' : ''}
    `;

    const image = card.querySelector('img');
    setCoverFallback(image, book);
    card.querySelector('.book-card-main').addEventListener('click', event => openBookDetail(book, event.currentTarget));
    card.querySelector('.card-favorite').addEventListener('click', () => toggleFavorite(book.repo_name));
    const continueButton = card.querySelector('.card-continue');
    if (continueButton) continueButton.addEventListener('click', () => openReader(book));
    return card;
  }

  function replaceGrid(container, books) {
    const fragment = document.createDocumentFragment();
    books.forEach(book => fragment.appendChild(createBookCard(book)));
    container.replaceChildren(fragment);
  }

  function renderLibrary() {
    if (!state.allBooks.length) return;
    const filtered = getFilteredBooks();
    const visible = filtered.slice(0, state.visibleCount);
    replaceGrid(dom.booksGrid, visible);
    dom.libraryEmpty.classList.toggle('hidden', filtered.length > 0);
    dom.loadMoreBtn.classList.toggle('hidden', visible.length >= filtered.length || filtered.length === 0);
    dom.resultsCount.textContent = `显示 ${visible.length} / ${filtered.length} 本 · 全馆 ${state.allBooks.length} 本`;
    dom.clearFiltersBtn.classList.toggle('hidden', !hasActiveFilters());
  }

  function renderFavorites() {
    if (!state.allBooks.length) return;
    const books = state.allBooks.filter(book => isFavorite(book.repo_name) && matchesSearch(book, state.filters.query.trim()));
    replaceGrid(dom.favoritesGrid, books);
    dom.favoritesEmpty.classList.toggle('hidden', books.length > 0);
    dom.favoritesCount.textContent = books.length ? `${books.length} 本收藏` : '';
  }

  function renderRecent() {
    if (!state.allBooks.length) return;
    const entries = state.userData.recent.filter(entry => {
      const book = state.allBooks.find(item => item.repo_name === entry.repo_name);
      return book && matchesSearch(book, state.filters.query.trim());
    });
    dom.recentGrid.replaceChildren();

    entries.forEach(entry => {
      const book = state.allBooks.find(item => item.repo_name === entry.repo_name);
      const percent = Math.round(getProgress(book.repo_name) * 100);
      const item = document.createElement('article');
      item.className = 'recent-item';
      item.innerHTML = `
        <img loading="lazy" src="${coverUrl(book)}" alt="${escapeHtml(book.title)}封面">
        <div><h3>${escapeHtml(book.title)}</h3><p>${escapeHtml(book.author)} · ${formatRelativeDate(entry.lastReadAt)}</p></div>
        <div class="recent-progress"><span>${percent}%</span><div class="progress-track"><span style="width:${percent}%"></span></div></div>
        <div class="recent-actions"><button class="secondary-button" type="button">继续</button><button class="icon-button compact remove-recent" type="button" aria-label="从最近阅读移除 ${escapeHtml(book.title)}"><svg><use href="#icon-close"></use></svg></button></div>
      `;
      setCoverFallback(item.querySelector('img'), book);
      item.querySelector('.secondary-button').addEventListener('click', () => openReader(book));
      item.querySelector('.remove-recent').addEventListener('click', () => removeRecent(book.repo_name));
      dom.recentGrid.appendChild(item);
    });
    dom.recentEmpty.classList.toggle('hidden', entries.length > 0);
  }

  function renderStats() {
    dom.statBooks.textContent = Object.keys(state.userData.bookProgress).length;
    dom.statTime.textContent = formatMinutes(state.userData.totalReadingSeconds);
    dom.statFavorites.textContent = state.userData.favorites.length;
  }

  function formatMinutes(seconds) {
    const minutes = Math.floor((seconds || 0) / 60);
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder ? `${hours} 小时 ${remainder} 分` : `${hours} 小时`;
  }

  function formatRelativeDate(timestamp) {
    if (!timestamp) return '最近打开';
    const deltaDays = Math.floor((Date.now() - timestamp) / 86400000);
    if (deltaDays <= 0) return '今天';
    if (deltaDays === 1) return '昨天';
    if (deltaDays < 30) return `${deltaDays} 天前`;
    return new Date(timestamp).toLocaleDateString('zh-CN');
  }

  function toggleFavorite(repoName) {
    const index = state.userData.favorites.indexOf(repoName);
    const added = index < 0;
    if (added) state.userData.favorites.unshift(repoName);
    else state.userData.favorites.splice(index, 1);
    scheduleSave(0);
    renderHeaderCounts();
    renderLibrary();
    renderFavorites();
    renderStats();
    if (state.currentDetailBook && state.currentDetailBook.repo_name === repoName) updateDetailFavoriteButton();
    showToast(added ? '已加入收藏' : '已取消收藏');
  }

  function hasActiveFilters() {
    return Boolean(state.filters.query.trim() || state.filters.subjects.length || state.filters.sort !== 'default' || state.filters.favoriteOnly);
  }

  function clearFilters({ clearSearch = true } = {}) {
    if (clearSearch) {
      state.filters.query = '';
      dom.searchInput.value = '';
      dom.clearSearchBtn.classList.add('hidden');
    }
    state.filters.subjects = [];
    state.filters.sort = 'default';
    state.filters.favoriteOnly = false;
    state.visibleCount = PAGE_SIZE;
    syncFilterControls();
    renderLibrary();
    renderFavorites();
    renderRecent();
  }

  function syncFilterControls() {
    setSubjectGroup(dom.subjectCheckboxes, state.filters.subjects);
    setSubjectGroup(dom.mobileSubjectCheckboxes, state.filters.subjects);
    setSortGroup(dom.sortButtons, state.filters.sort);
    setSortGroup(dom.mobileSortButtons, state.filters.sort);
    dom.favoriteOnlyInput.checked = state.filters.favoriteOnly;
    dom.mobileFavoriteOnlyInput.checked = state.filters.favoriteOnly;
  }

  function setSubjectGroup(container, subjects) {
    container.querySelectorAll('input[data-subject-filter]').forEach(input => {
      input.checked = input.value === 'all' ? subjects.length === 0 : subjects.includes(input.value);
    });
  }

  function readSubjectGroup(container) {
    return [...container.querySelectorAll('input[data-subject-filter]:checked')]
      .map(input => input.value)
      .filter(value => value !== 'all');
  }

  function normalizeSubjectGroup(container, changedInput) {
    const allInput = container.querySelector('input[data-subject-filter][value="all"]');
    const subjectInputs = [...container.querySelectorAll('input[data-subject-filter]:not([value="all"])')];
    if (changedInput.value === 'all' && changedInput.checked) {
      subjectInputs.forEach(input => { input.checked = false; });
    } else if (changedInput.value !== 'all') {
      allInput.checked = !subjectInputs.some(input => input.checked);
    } else if (!subjectInputs.some(input => input.checked)) {
      allInput.checked = true;
    }
  }

  function setSortGroup(container, sort) {
    container.querySelectorAll('[data-sort]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.sort === sort));
    });
  }

  function readSortGroup(container) {
    return container.querySelector('[data-sort][aria-pressed="true"]')?.dataset.sort || 'default';
  }

  function updateDesktopFilters() {
    state.filters.subjects = readSubjectGroup(dom.subjectCheckboxes);
    state.filters.favoriteOnly = dom.favoriteOnlyInput.checked;
    state.visibleCount = PAGE_SIZE;
    renderLibrary();
  }

  function setActiveView(view) {
    state.activeView = view;
    const views = ['library', 'favorites', 'recent'];
    views.forEach(name => {
      const active = name === view;
      dom[`${name}Tab`].classList.toggle('active', active);
      dom[`${name}Tab`].setAttribute('aria-selected', String(active));
      dom[`${name}View`].classList.toggle('hidden', !active);
    });
    if (view === 'library') renderLibrary();
    if (view === 'favorites') renderFavorites();
    if (view === 'recent') renderRecent();
    history.replaceState(null, '', `#${view}`);
  }

  function openBookDetail(book, trigger) {
    state.currentDetailBook = book;
    state.lastDetailTrigger = trigger || document.activeElement;
    const progress = state.userData.bookProgress[book.repo_name] || {};
    const percent = Math.round(getProgress(book.repo_name) * 100);
    dom.detailBookTitle.textContent = book.title;
    dom.detailAuthorName.textContent = book.author;
    dom.detailProgressText.textContent = `${percent}%`;
    dom.detailTimeText.textContent = formatMinutes(progress.timeSpent || 0);
    dom.detailDateText.textContent = '—';
    dom.detailLangText.textContent = 'en-US';
    dom.detailCoverImg.src = coverUrl(book);
    dom.detailCoverImg.alt = `${book.title}封面`;
    dom.detailCoverImg.dataset.jpgTried = '';
    dom.detailCoverImg.onerror = () => {
      if (!dom.detailCoverImg.dataset.jpgTried) {
        dom.detailCoverImg.dataset.jpgTried = 'true';
        dom.detailCoverImg.src = coverUrl(book, 'jpg');
      }
    };
    dom.startReadingBtn.textContent = percent > 0 ? `继续阅读 · ${percent}%` : '开始阅读';
    dom.detailWebLink.href = book.web_url || `https://standardebooks.org${book.href || ''}`;
    renderDetailTags([SUBJECT_ZH[book.subject] || book.subject]);
    dom.detailDescriptionText.innerHTML = '<p>正在读取图书简介…</p>';
    updateDetailFavoriteButton();
    if (!dom.bookDetailDialog.open) dom.bookDetailDialog.showModal();
    syncBodyLock();
    fetchBookMetadata(book);
  }

  function updateDetailFavoriteButton() {
    if (!state.currentDetailBook) return;
    const favorite = isFavorite(state.currentDetailBook.repo_name);
    dom.detailFavoriteBtn.setAttribute('aria-pressed', String(favorite));
    dom.detailFavoriteBtn.querySelector('span').textContent = favorite ? '已收藏' : '收藏';
  }

  async function fetchBookMetadata(book) {
    if (metadataController) metadataController.abort();
    metadataController = new AbortController();
    const expectedRepo = book.repo_name;
    try {
      const response = await fetch(assetUrl(book, 'content.opf'), { signal: metadataController.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const doc = new DOMParser().parseFromString(await response.text(), 'application/xml');
      if (doc.querySelector('parsererror')) throw new Error('OPF XML 解析失败');
      if (!state.currentDetailBook || state.currentDetailBook.repo_name !== expectedRepo) return;

      const description = doc.querySelector('description, dc\\:description')?.textContent?.trim();
      renderSafeDescription(description || '暂无该图书的内容梗概。');
      const date = doc.querySelector('date, dc\\:date')?.textContent?.trim();
      const language = doc.querySelector('language, dc\\:language')?.textContent?.trim();
      if (date) dom.detailDateText.textContent = date.split('T')[0];
      if (language) dom.detailLangText.textContent = language;
      const tags = book.all_subjects.map(subject => SUBJECT_ZH[subject] || subject);
      doc.querySelectorAll('subject, dc\\:subject').forEach(node => {
        const text = node.textContent.trim();
        if (text && !tags.includes(text)) tags.push(text);
      });
      renderDetailTags(tags.slice(0, 8));
    } catch (error) {
      if (error.name === 'AbortError') return;
      console.warn('图书元数据读取失败。', error);
      renderSafeDescription('暂时无法读取这本书的完整简介，但仍可正常打开正文。');
    }
  }

  function renderSafeDescription(text) {
    dom.detailDescriptionText.replaceChildren();
    const source = String(text);
    const parsed = new DOMParser().parseFromString(source, 'text/html');
    const paragraphText = [...parsed.body.querySelectorAll('p')]
      .map(node => node.textContent.trim())
      .filter(Boolean);
    const plainText = parsed.body.textContent.trim() || source;
    const parts = paragraphText.length
      ? paragraphText
      : plainText.split(/\n\s*\n/).map(item => item.trim()).filter(Boolean);
    (parts.length ? parts : [plainText]).forEach(part => {
      const paragraph = document.createElement('p');
      paragraph.textContent = part;
      dom.detailDescriptionText.appendChild(paragraph);
    });
  }

  function renderDetailTags(tags) {
    dom.detailSubjectsList.replaceChildren();
    tags.forEach(text => {
      const span = document.createElement('span');
      span.className = 'tag';
      span.textContent = text;
      dom.detailSubjectsList.appendChild(span);
    });
  }

  function closeDetail() {
    if (metadataController) metadataController.abort();
    if (dom.bookDetailDialog.open) dom.bookDetailDialog.close();
  }

  function openCoverPreview() {
    if (!state.currentDetailBook) return;
    dom.coverPreviewImg.src = dom.detailCoverImg.src;
    dom.coverPreviewImg.alt = `${state.currentDetailBook.title}封面预览`;
    if (!dom.coverDialog.open) dom.coverDialog.showModal();
    syncBodyLock();
  }

  function getProgressItem(book) {
    if (!state.userData.bookProgress[book.repo_name]) {
      state.userData.bookProgress[book.repo_name] = { chapterIndex: 0, scrollPercent: 0, overallPercent: 0, timeSpent: 0 };
    }
    return state.userData.bookProgress[book.repo_name];
  }

  function touchRecent(book, moveToFront = true) {
    const progress = getProgressItem(book);
    const existingIndex = state.userData.recent.findIndex(item => item.repo_name === book.repo_name);
    const previous = existingIndex >= 0 ? state.userData.recent[existingIndex] : {};
    const entry = {
      ...previous,
      repo_name: book.repo_name,
      title: book.title,
      author: book.author,
      subject: book.subject,
      chapterIndex: progress.chapterIndex,
      scrollPercent: progress.scrollPercent,
      overallPercent: progress.overallPercent,
      timeSpent: progress.timeSpent,
      lastReadAt: moveToFront ? Date.now() : (previous.lastReadAt || Date.now())
    };
    if (existingIndex >= 0) state.userData.recent.splice(existingIndex, 1);
    if (moveToFront) state.userData.recent.unshift(entry);
    else state.userData.recent.splice(Math.max(existingIndex, 0), 0, entry);
    state.userData.recent = state.userData.recent.slice(0, 24);
  }

  function updateRecentSnapshot() {
    const book = state.reader.book;
    if (!book) return;
    const progress = getProgressItem(book);
    const entry = state.userData.recent.find(item => item.repo_name === book.repo_name);
    if (!entry) return;
    entry.chapterIndex = progress.chapterIndex;
    entry.scrollPercent = progress.scrollPercent;
    entry.overallPercent = progress.overallPercent;
    entry.timeSpent = progress.timeSpent;
  }

  async function openReader(book) {
    if (!book) return;
    if (dom.bookDetailDialog.open) dom.bookDetailDialog.close();
    state.reader.active = true;
    state.reader.book = book;
    state.reader.subject = book.subject;
    state.reader.sessionSeconds = 0;
    state.reader.pendingSeconds = 0;
    state.reader.loadToken += 1;
    state.reader.chapterLoaded = false;
    dom.readerBookTitle.textContent = book.title;
    dom.readerAuthorName.textContent = book.author;
    dom.readerOverlay.classList.remove('hidden');
    dom.readerOverlay.setAttribute('aria-hidden', 'false');
    syncBodyLock();
    applyReaderPreferences();
    closeReaderDrawers();
    touchRecent(book, true);
    saveUserData();
    renderHeaderCounts();
    renderContinuePanel();
    startReaderTimer();
    await loadBookToc(book, state.reader.loadToken);
  }

  function closeReader() {
    if (!state.reader.active) return;
    flushReaderSeconds();
    updateReaderProgress();
    stopReaderTimer();
    state.reader.active = false;
    state.reader.loadToken += 1;
    closeReaderDrawers();
    dom.readerOverlay.classList.add('hidden');
    dom.readerOverlay.setAttribute('aria-hidden', 'true');
    saveUserData();
    renderAll();
    syncBodyLock();
    state.lastDetailTrigger?.focus?.();
  }

  async function loadBookToc(book, token) {
    dom.tocNav.innerHTML = '<div class="reader-loading"><div class="spinner"></div><p>正在读取目录…</p></div>';
    dom.chapterContainer.innerHTML = '<div class="reader-loading"><div class="spinner"></div><p>正在打开图书…</p></div>';
    try {
      const response = await fetch(assetUrl(book, 'toc.xhtml'));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const doc = new DOMParser().parseFromString(await response.text(), 'application/xhtml+xml');
      if (doc.querySelector('parsererror')) throw new Error('目录 XML 解析失败');
      if (!state.reader.active || token !== state.reader.loadToken) return;
      const toc = [];
      doc.querySelectorAll('nav#toc a, nav[epub\\:type="toc"] a, ol a').forEach(anchor => {
        const href = anchor.getAttribute('href');
        const title = anchor.textContent.trim();
        if (href && title && !href.startsWith('#')) toc.push({ href, title });
      });
      state.reader.toc = toc.length ? toc : [{ title: '开始阅读', href: 'text/chapter-1.xhtml' }];
      renderToc();
      const savedIndex = getProgressItem(book).chapterIndex;
      await loadChapter(Math.min(savedIndex, state.reader.toc.length - 1));
    } catch (error) {
      console.warn('目录读取失败，尝试默认章节。', error);
      if (!state.reader.active || token !== state.reader.loadToken) return;
      state.reader.toc = [{ title: '开始阅读', href: 'text/chapter-1.xhtml' }];
      renderToc();
      await loadChapter(0);
    }
  }

  function renderToc() {
    const list = document.createElement('ol');
    state.reader.toc.forEach((item, index) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.title;
      button.dataset.index = index;
      button.classList.toggle('active', index === state.reader.chapterIndex);
      button.addEventListener('click', () => {
        loadChapter(index);
        closeReaderDrawers();
      });
      li.appendChild(button);
      list.appendChild(li);
    });
    dom.tocNav.replaceChildren(list);
  }

  async function loadChapter(index) {
    if (!state.reader.active || !state.reader.book || !state.reader.toc.length) return;
    if (state.reader.chapterLoaded) updateReaderProgress();
    flushReaderSeconds();
    state.reader.chapterLoaded = false;
    const token = ++state.reader.loadToken;
    const safeIndex = Math.max(0, Math.min(index, state.reader.toc.length - 1));
    state.reader.chapterIndex = safeIndex;
    dom.chapterContainer.innerHTML = '<div class="reader-loading"><div class="spinner"></div><p>正在读取章节…</p></div>';
    dom.tocNav.querySelectorAll('button').forEach((button, buttonIndex) => button.classList.toggle('active', buttonIndex === safeIndex));
    const item = state.reader.toc[safeIndex];
    const cleanHref = item.href.split('#')[0].replace(/^epub\//, '');
    const relativeUrl = assetUrl(state.reader.book, cleanHref);
    try {
      const response = await fetch(relativeUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const doc = new DOMParser().parseFromString(await response.text(), 'application/xhtml+xml');
      if (doc.querySelector('parsererror')) throw new Error('章节 XML 解析失败');
      if (!state.reader.active || token !== state.reader.loadToken) return;
      const body = doc.querySelector('body') || doc.documentElement;
      sanitizeChapter(body, new URL(relativeUrl, location.href));
      dom.chapterContainer.innerHTML = body.innerHTML;
      state.reader.chapterLoaded = true;
      dom.chapterContainer.dataset.font = state.userData.preferences.readerFont;
      dom.chapterProgressText.textContent = `章节 ${safeIndex + 1} / ${state.reader.toc.length}`;
      dom.prevChapterBtn.disabled = safeIndex === 0;
      dom.nextChapterBtn.disabled = safeIndex >= state.reader.toc.length - 1;
      const progress = getProgressItem(state.reader.book);
      const restore = progress.chapterIndex === safeIndex ? progress.scrollPercent : 0;
      progress.chapterIndex = safeIndex;
      requestAnimationFrame(() => {
        const maxScroll = Math.max(0, dom.readerCanvas.scrollHeight - dom.readerCanvas.clientHeight);
        dom.readerCanvas.scrollTop = maxScroll * restore;
        updateReaderProgress();
        dom.readerCanvas.focus({ preventScroll: true });
      });
      updateRecentSnapshot();
      scheduleSave();
    } catch (error) {
      console.error(`章节读取失败：${relativeUrl}`, error);
      if (!state.reader.active || token !== state.reader.loadToken) return;
      dom.chapterContainer.innerHTML = '<div class="reader-error"><h2>章节暂时无法打开</h2><p>文件可能缺失或路径不兼容，请从目录选择其他章节。</p></div>';
    }
  }

  function sanitizeChapter(root, chapterUrl) {
    root.querySelectorAll('script, iframe, object, embed, form, meta, link').forEach(node => node.remove());
    root.querySelectorAll('*').forEach(node => {
      [...node.attributes].forEach(attribute => {
        if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
      });
    });
    root.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src');
      if (src && !/^(data:|https?:)/i.test(src)) img.setAttribute('src', new URL(src, chapterUrl).href);
      img.setAttribute('loading', 'lazy');
    });
    root.querySelectorAll('image').forEach(image => {
      const href = image.getAttribute('href') || image.getAttribute('xlink:href');
      if (href && !/^(data:|https?:)/i.test(href)) {
        const resolved = new URL(href, chapterUrl).href;
        image.setAttribute('href', resolved);
        image.setAttribute('xlink:href', resolved);
      }
    });
    root.querySelectorAll('a[href]').forEach(anchor => {
      const href = anchor.getAttribute('href');
      if (/^https?:/i.test(href)) {
        anchor.target = '_blank';
        anchor.rel = 'noopener';
      }
    });
  }

  function updateReaderProgress() {
    if (!state.reader.active || !state.reader.chapterLoaded || !state.reader.book || !state.reader.toc.length) return;
    const maxScroll = Math.max(0, dom.readerCanvas.scrollHeight - dom.readerCanvas.clientHeight);
    const scrollPercent = maxScroll ? Math.min(1, Math.max(0, dom.readerCanvas.scrollTop / maxScroll)) : 0;
    const overall = Math.min(1, (state.reader.chapterIndex + scrollPercent) / state.reader.toc.length);
    const progress = getProgressItem(state.reader.book);
    progress.chapterIndex = state.reader.chapterIndex;
    progress.scrollPercent = scrollPercent;
    progress.overallPercent = overall;
    dom.readerProgressBar.style.width = `${overall * 100}%`;
    updateRecentSnapshot();
    scheduleSave(1200);
  }

  function startReaderTimer() {
    stopReaderTimer();
    state.reader.timerHandle = setInterval(() => {
      if (!state.reader.active || document.hidden) return;
      state.reader.sessionSeconds += 1;
      state.reader.pendingSeconds += 1;
      if (state.reader.pendingSeconds >= TIMER_FLUSH_SECONDS) flushReaderSeconds();
    }, 1000);
  }

  function stopReaderTimer() {
    if (state.reader.timerHandle) clearInterval(state.reader.timerHandle);
    state.reader.timerHandle = null;
  }

  function flushReaderSeconds() {
    if (!state.reader.book || state.reader.pendingSeconds <= 0) return;
    const progress = getProgressItem(state.reader.book);
    progress.timeSpent += state.reader.pendingSeconds;
    state.userData.totalReadingSeconds += state.reader.pendingSeconds;
    state.reader.pendingSeconds = 0;
    updateRecentSnapshot();
    saveUserData();
  }

  function applyReaderPreferences() {
    const preferences = state.userData.preferences;
    dom.readerOverlay.dataset.readerTheme = preferences.readerTheme;
    dom.readerThemeSelect.value = preferences.readerTheme;
    dom.readerFontSelect.value = preferences.readerFont;
    dom.chapterContainer.dataset.font = preferences.readerFont;
    dom.fontSizeInput.value = preferences.fontSize;
    dom.lineHeightInput.value = preferences.lineHeight;
    dom.contentWidthInput.value = preferences.contentWidth;
    dom.fontSizeOutput.textContent = `${preferences.fontSize}px`;
    dom.lineHeightOutput.textContent = Number(preferences.lineHeight).toFixed(1);
    dom.contentWidthOutput.textContent = `${preferences.contentWidth}px`;
    dom.readerOverlay.style.setProperty('--reader-font-size', `${preferences.fontSize}px`);
    dom.readerOverlay.style.setProperty('--reader-line-height', preferences.lineHeight);
    dom.readerOverlay.style.setProperty('--reader-width', `${preferences.contentWidth}px`);
  }

  function updateReaderPreferences() {
    state.userData.preferences.readerTheme = dom.readerThemeSelect.value;
    state.userData.preferences.readerFont = dom.readerFontSelect.value;
    state.userData.preferences.fontSize = finiteNumber(dom.fontSizeInput.value, 18, 14, 32);
    state.userData.preferences.lineHeight = finiteNumber(dom.lineHeightInput.value, 1.8, 1.4, 2.2);
    state.userData.preferences.contentWidth = finiteNumber(dom.contentWidthInput.value, 680, 520, 840);
    applyReaderPreferences();
    scheduleSave();
  }

  function openReaderDrawer(type) {
    const toc = type === 'toc';
    dom.tocDrawer.classList.toggle('open', toc);
    dom.readerSettingsPanel.classList.toggle('open', !toc);
    dom.tocDrawer.setAttribute('aria-hidden', String(!toc));
    dom.readerSettingsPanel.setAttribute('aria-hidden', String(toc));
    dom.toggleTocBtn.setAttribute('aria-expanded', String(toc));
    dom.toggleSettingsBtn.setAttribute('aria-expanded', String(!toc));
    dom.readerScrim.classList.remove('hidden');
  }

  function closeReaderDrawers() {
    dom.tocDrawer.classList.remove('open');
    dom.readerSettingsPanel.classList.remove('open');
    dom.tocDrawer.setAttribute('aria-hidden', 'true');
    dom.readerSettingsPanel.setAttribute('aria-hidden', 'true');
    dom.toggleTocBtn.setAttribute('aria-expanded', 'false');
    dom.toggleSettingsBtn.setAttribute('aria-expanded', 'false');
    dom.readerScrim.classList.add('hidden');
  }

  function removeRecent(repoName) {
    state.userData.recent = state.userData.recent.filter(item => item.repo_name !== repoName);
    scheduleSave(0);
    renderHeaderCounts();
    renderContinuePanel();
    renderRecent();
  }

  function resetReadingData() {
    const preferences = { ...state.userData.preferences };
    state.userData = createDefaultUserData();
    state.userData.preferences = preferences;
    saveUserData();
    renderAll();
    showToast('阅读数据已重置');
  }

  function syncBodyLock() {
    const dialogOpen = document.querySelector('dialog[open]');
    document.body.classList.toggle('dialog-open', Boolean(dialogOpen) || state.reader.active);
  }

  function closeOnBackdrop(dialog) {
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inside) dialog.close();
    });
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    dom.toastRegion.innerHTML = `<div class="toast">${escapeHtml(message)}</div>`;
    toastTimer = setTimeout(() => { dom.toastRegion.innerHTML = ''; }, 2200);
  }

  function setupEvents() {
    dom.themeToggle.addEventListener('click', cycleAppTheme);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (state.userData.preferences.appTheme === 'system') applyAppTheme();
    });

    dom.searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      dom.clearSearchBtn.classList.toggle('hidden', !dom.searchInput.value);
      searchTimer = setTimeout(() => {
        state.filters.query = dom.searchInput.value.trim();
        state.visibleCount = PAGE_SIZE;
        renderLibrary();
        renderFavorites();
        renderRecent();
      }, 120);
    });
    dom.clearSearchBtn.addEventListener('click', () => {
      state.filters.query = '';
      dom.searchInput.value = '';
      dom.clearSearchBtn.classList.add('hidden');
      state.visibleCount = PAGE_SIZE;
      renderLibrary();
      renderFavorites();
      renderRecent();
      dom.searchInput.focus();
    });

    ['library', 'favorites', 'recent'].forEach(view => dom[`${view}Tab`].addEventListener('click', () => setActiveView(view)));
    dom.subjectCheckboxes.addEventListener('change', event => {
      if (!event.target.matches('input[data-subject-filter]')) return;
      normalizeSubjectGroup(dom.subjectCheckboxes, event.target);
      updateDesktopFilters();
    });
    dom.sortButtons.addEventListener('click', event => {
      const button = event.target.closest('[data-sort]');
      if (!button) return;
      state.filters.sort = button.dataset.sort;
      state.visibleCount = PAGE_SIZE;
      setSortGroup(dom.sortButtons, state.filters.sort);
      renderLibrary();
    });
    dom.favoriteOnlyInput.addEventListener('change', updateDesktopFilters);
    dom.clearFiltersBtn.addEventListener('click', () => clearFilters());
    document.querySelectorAll('[data-clear-filters]').forEach(button => button.addEventListener('click', () => clearFilters()));
    document.querySelectorAll('[data-open-library]').forEach(button => button.addEventListener('click', () => setActiveView('library')));
    dom.loadMoreBtn.addEventListener('click', () => { state.visibleCount += PAGE_SIZE; renderLibrary(); });

    dom.mobileFilterBtn.addEventListener('click', () => {
      syncFilterControls();
      dom.filterDialog.showModal();
      syncBodyLock();
    });
    dom.mobileSubjectCheckboxes.addEventListener('change', event => {
      if (!event.target.matches('input[data-subject-filter]')) return;
      normalizeSubjectGroup(dom.mobileSubjectCheckboxes, event.target);
    });
    dom.mobileSortButtons.addEventListener('click', event => {
      const button = event.target.closest('[data-sort]');
      if (button) setSortGroup(dom.mobileSortButtons, button.dataset.sort);
    });
    dom.applyMobileFiltersBtn.addEventListener('click', () => {
      state.filters.subjects = readSubjectGroup(dom.mobileSubjectCheckboxes);
      state.filters.sort = readSortGroup(dom.mobileSortButtons);
      state.filters.favoriteOnly = dom.mobileFavoriteOnlyInput.checked;
      state.visibleCount = PAGE_SIZE;
      syncFilterControls();
      renderLibrary();
    });
    dom.mobileClearFiltersBtn.addEventListener('click', () => {
      setSubjectGroup(dom.mobileSubjectCheckboxes, []);
      setSortGroup(dom.mobileSortButtons, 'default');
      dom.mobileFavoriteOnlyInput.checked = false;
    });

    dom.continueReadingBtn.addEventListener('click', () => {
      const book = state.allBooks.find(item => item.repo_name === dom.continueReadingBtn.dataset.repo);
      if (book) openReader(book);
    });

    dom.closeDetailBtn.addEventListener('click', closeDetail);
    dom.bookDetailDialog.addEventListener('close', () => { syncBodyLock(); state.lastDetailTrigger?.focus?.(); });
    dom.detailCoverButton.addEventListener('click', openCoverPreview);
    dom.closeCoverBtn.addEventListener('click', () => dom.coverDialog.close());
    dom.coverDialog.addEventListener('close', syncBodyLock);
    dom.startReadingBtn.addEventListener('click', () => openReader(state.currentDetailBook));
    dom.detailFavoriteBtn.addEventListener('click', () => {
      if (state.currentDetailBook) toggleFavorite(state.currentDetailBook.repo_name);
    });
    closeOnBackdrop(dom.bookDetailDialog);
    closeOnBackdrop(dom.coverDialog);
    closeOnBackdrop(dom.filterDialog);
    [dom.filterDialog, dom.resetDialog].forEach(dialog => dialog.addEventListener('close', syncBodyLock));

    dom.resetDataBtn.addEventListener('click', () => { dom.resetDialog.showModal(); syncBodyLock(); });
    dom.confirmResetBtn.addEventListener('click', resetReadingData);

    dom.closeReaderBtn.addEventListener('click', closeReader);
    dom.toggleTocBtn.addEventListener('click', () => dom.tocDrawer.classList.contains('open') ? closeReaderDrawers() : openReaderDrawer('toc'));
    dom.toggleSettingsBtn.addEventListener('click', () => dom.readerSettingsPanel.classList.contains('open') ? closeReaderDrawers() : openReaderDrawer('settings'));
    dom.closeTocBtn.addEventListener('click', closeReaderDrawers);
    dom.closeSettingsBtn.addEventListener('click', closeReaderDrawers);
    dom.readerScrim.addEventListener('click', closeReaderDrawers);
    dom.prevChapterBtn.addEventListener('click', () => loadChapter(state.reader.chapterIndex - 1));
    dom.nextChapterBtn.addEventListener('click', () => loadChapter(state.reader.chapterIndex + 1));
    dom.readerCanvas.addEventListener('scroll', throttle(updateReaderProgress, 450), { passive: true });
    [dom.readerThemeSelect, dom.readerFontSelect].forEach(control => control.addEventListener('change', updateReaderPreferences));
    [dom.fontSizeInput, dom.lineHeightInput, dom.contentWidthInput].forEach(control => control.addEventListener('input', updateReaderPreferences));

    document.addEventListener('keydown', event => {
      if (state.reader.active) {
        if (event.key === 'Escape') {
          if (dom.tocDrawer.classList.contains('open') || dom.readerSettingsPanel.classList.contains('open')) {
            event.preventDefault();
            closeReaderDrawers();
          } else if (!document.querySelector('dialog[open]')) {
            event.preventDefault();
            closeReader();
          }
          return;
        }
        const tag = document.activeElement?.tagName;
        if (!['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(tag)) {
          if (event.key === 'ArrowLeft' && state.reader.chapterIndex > 0) loadChapter(state.reader.chapterIndex - 1);
          if (event.key === 'ArrowRight' && state.reader.chapterIndex < state.reader.toc.length - 1) loadChapter(state.reader.chapterIndex + 1);
        }
      } else if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
        event.preventDefault();
        dom.searchInput.focus();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state.reader.active) {
        flushReaderSeconds();
        updateReaderProgress();
        saveUserData();
      }
    });
    window.addEventListener('pagehide', () => {
      if (state.reader.active) {
        flushReaderSeconds();
        updateReaderProgress();
      }
      saveUserData();
    });
  }

  function throttle(callback, delay) {
    let timeout = null;
    let lastArgs;
    return function (...args) {
      lastArgs = args;
      if (timeout) return;
      timeout = setTimeout(() => {
        timeout = null;
        callback.apply(this, lastArgs);
      }, delay);
    };
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  document.addEventListener('DOMContentLoaded', () => {
    cacheDom();
    loadUserData();
    applyAppTheme();
    applyReaderPreferences();
    setupEvents();
    const initialView = ['library', 'favorites', 'recent'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'library';
    setActiveView(initialView);
    loadCatalog();
  });
})();
