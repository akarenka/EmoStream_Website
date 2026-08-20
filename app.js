(() => {
  'use strict';

  const KEYS = {
    users: 'pinboard.users.v2',
    session: 'pinboard.session.v2',
    posts: 'pinboard.posts.v2',
    theme: 'pinboard.theme.v2'
  };
  const guestAvatar = makeAvatar('Guest');
  let users = read(KEYS.users, []);
  let allPosts = read(KEYS.posts, []);
  let session = read(KEYS.session, null);
  let currentUser = session ? users.find(u => u.id === session.userId) || null : null;
  let userProfile = currentUser ? profileOf(currentUser) : { nickname: 'Guest', avatar: guestAvatar };
  let currentFilter = 'all';
  let currentColorFilter = 'all';
  let searchQuery = '';
  let selectedFileDataUrl = null;

  const $ = id => document.getElementById(id);
  const pinboardGrid = $('pinboard-grid');
  const emptyState = $('empty-state');
  const addPostModal = $('add-post-modal');
  const addPostForm = $('add-post-form');
  const authModal = $('auth-modal');
  const profileModal = $('profile-modal');
  const lightboxModal = $('lightbox-modal');
  const postFileInput = $('post-file-input');
  const postImageUrl = $('post-image-url');
  const filePreviewContainer = $('file-preview-container');
  const postPreviewImg = $('post-preview-img');

  function read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { showNotification('Storage is full. Remove some large photos and try again.', 'error'); return false; }
  }
  function makeAvatar(seed) {
    const label = String(seed || 'U').trim().slice(0, 2).toUpperCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="100%" height="100%" rx="80" fill="#f59e0b"/><text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="Arial" font-size="60" font-weight="700" fill="white">${escapeHtml(label)}</text></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  function profileOf(user) { return { nickname: user.nickname || 'Friend', avatar: safeImage(user.avatar) || makeAvatar(user.nickname) }; }
  function safeImage(value) {
    const v = String(value || '').trim();
    return /^(https?:\/\/|data:image\/(png|jpe?g|gif|webp|svg\+xml);)/i.test(v) ? v : '';
  }
  function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
  function id() { return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)); }
  async function passwordDigest(email, password) {
    const bytes = new TextEncoder().encode(`pinboard-v2:${email}:${password}`);
    if (crypto.subtle) {
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
    }
    return btoa(unescape(encodeURIComponent(email + ':' + password)));
  }

  function updateUserUI() {
    userProfile = currentUser ? profileOf(currentUser) : { nickname: 'Guest', avatar: guestAvatar };
    $('header-user-name').textContent = userProfile.nickname;
    $('header-user-avatar').src = userProfile.avatar;
    $('post-author').value = userProfile.nickname;
    $('post-author').readOnly = !!currentUser;
    $('profile-nickname').value = userProfile.nickname;
    $('profile-avatar-preview').src = userProfile.avatar;
    $('profile-avatar-url').value = '';
  }

  async function register() {
    const email = normalizeEmail($('auth-email').value);
    const password = $('auth-password').value;
    const nickname = $('auth-nickname').value.trim();
    if (!nickname) return showNotification('Enter a nickname to register.', 'error');
    if (!/^\S+@\S+\.\S+$/.test(email)) return showNotification('Enter a valid email address.', 'error');
    if (password.length < 8) return showNotification('Password must be at least 8 characters.', 'error');
    if (users.some(u => u.email === email)) return showNotification('This email is already registered.', 'error');
    const user = { id: id(), email, passwordHash: await passwordDigest(email, password), nickname, avatar: makeAvatar(nickname), createdAt: Date.now() };
    users.push(user);
    if (!write(KEYS.users, users)) return;
    signInUser(user);
    authModal.classList.add('hidden');
    profileModal.classList.remove('hidden');
    showNotification('Account created. Add your avatar now!');
  }

  async function login() {
    const email = normalizeEmail($('auth-email').value);
    const password = $('auth-password').value;
    if (!email || !password) return showNotification('Enter your email and password.', 'error');
    const digest = await passwordDigest(email, password);
    const user = users.find(u => u.email === email && u.passwordHash === digest);
    if (!user) return showNotification('Email or password is incorrect.', 'error');
    signInUser(user);
    authModal.classList.add('hidden');
    showNotification(`Welcome back, ${user.nickname}!`);
  }

  function signInUser(user) {
    currentUser = user;
    session = { userId: user.id, signedInAt: Date.now() };
    write(KEYS.session, session);
    updateUserUI();
    renderPosts();
  }

  function signOutUser() {
    currentUser = null;
    session = null;
    localStorage.removeItem(KEYS.session);
    updateUserUI();
    renderPosts();
    profileModal.classList.add('hidden');
    showNotification('Signed out.');
  }

  function compressImageFile(file, maxWidth = 900, quality = 0.78) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type.startsWith('image/')) return reject(new Error('Not an image'));
      if (file.size > 12 * 1024 * 1024) return reject(new Error('Image exceeds 12 MB'));
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = event => {
        const image = new Image();
        image.onerror = reject;
        image.onload = () => {
          const ratio = Math.min(1, maxWidth / image.width);
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(image.width * ratio));
          canvas.height = Math.max(1, Math.round(image.height * ratio));
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        image.src = event.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function previewFile(file, avatar = false) {
    try {
      const value = await compressImageFile(file, avatar ? 320 : 1000, avatar ? 0.82 : 0.78);
      if (avatar) $('profile-avatar-preview').src = value;
      else {
        selectedFileDataUrl = value;
        postPreviewImg.src = value;
        filePreviewContainer.classList.remove('hidden');
      }
    } catch (error) { showNotification(error.message || 'Unable to process this image.', 'error'); }
  }

  addPostForm.onsubmit = event => {
    event.preventDefault();
    const content = $('post-content').value.trim();
    const author = currentUser ? userProfile.nickname : ($('post-author').value.trim() || 'Guest');
    if (!content && !selectedFileDataUrl) return showNotification('Write a message or attach a photo.', 'error');
    allPosts.unshift({
      id: id(), content, imageUrl: safeImage(selectedFileDataUrl), authorName: author,
      authorAvatar: currentUser ? userProfile.avatar : guestAvatar,
      authorId: currentUser ? currentUser.id : 'guest-' + id(), color: document.querySelector('input[name="card-color"]:checked')?.value || 'yellow',
      likedBy: [], starredBy: [], likes: 0, createdAt: Date.now()
    });
    if (!write(KEYS.posts, allPosts)) { allPosts.shift(); return; }
    resetAddForm(); close(addPostModal); renderPosts(); showNotification('Pinned to board!');
  };

  function renderPosts() {
    const q = searchQuery.trim().toLowerCase();
    const filtered = allPosts.filter(post => {
      if (currentFilter === 'photo' && !post.imageUrl) return false;
      if (currentFilter === 'note' && post.imageUrl) return false;
      if (currentFilter === 'starred' && (!currentUser || !(post.starredBy || []).includes(currentUser.id))) return false;
      if (currentColorFilter !== 'all' && post.color !== currentColorFilter) return false;
      return !q || String(post.content || '').toLowerCase().includes(q) || String(post.authorName || '').toLowerCase().includes(q);
    });
    pinboardGrid.innerHTML = '';
    emptyState.classList.toggle('hidden', filtered.length > 0);
    emptyState.classList.toggle('flex', filtered.length === 0);
    const colors = {
      yellow:'bg-amber-100/90 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800/50 text-amber-950 dark:text-amber-100',
      green:'bg-emerald-100/90 dark:bg-emerald-900/30 border-emerald-200 dark:border-emerald-800/50 text-emerald-950 dark:text-emerald-100',
      blue:'bg-sky-100/90 dark:bg-sky-900/30 border-sky-200 dark:border-sky-800/50 text-sky-950 dark:text-sky-100',
      pink:'bg-pink-100/90 dark:bg-pink-900/30 border-pink-200 dark:border-pink-800/50 text-pink-950 dark:text-pink-100',
      purple:'bg-purple-100/90 dark:bg-purple-900/30 border-purple-200 dark:border-purple-800/50 text-purple-950 dark:text-purple-100'
    };
    filtered.forEach(post => {
      const liked = currentUser && (post.likedBy || []).includes(currentUser.id);
      const starred = currentUser && (post.starredBy || []).includes(currentUser.id);
      const owner = currentUser && post.authorId === currentUser.id;
      const card = document.createElement('article');
      card.className = `pin-card relative rounded-3xl p-4 border shadow-sm flex flex-col justify-between space-y-3 ${colors[post.color] || colors.yellow}`;
      const avatar = safeImage(post.authorAvatar) || makeAvatar(post.authorName);
      const image = safeImage(post.imageUrl);
      card.innerHTML = `<div class="flex items-start justify-between gap-2"><div class="flex items-center gap-2"><img src="${escapeHtml(avatar)}" alt="" class="w-7 h-7 rounded-full object-cover border border-white/50"><div><h4 class="text-xs font-bold">${escapeHtml(post.authorName || 'Guest')}</h4><span class="text-[9px] opacity-60">${formatTime(post.createdAt)}</span></div></div><div><button data-action="star" class="p-1 ${starred ? 'text-amber-500' : 'opacity-40'}" aria-label="Star"><i class="${starred ? 'fa-solid':'fa-regular'} fa-star"></i></button>${owner ? '<button data-action="delete" class="p-1 opacity-50 hover:text-rose-600" aria-label="Delete"><i class="fa-solid fa-trash-can"></i></button>' : ''}</div></div>${image ? `<button data-action="view" class="rounded-2xl overflow-hidden"><img src="${escapeHtml(image)}" alt="Pinned photo" class="w-full h-44 object-cover"></button>` : ''}${post.content ? `<p class="text-sm leading-relaxed whitespace-pre-line font-medium">${escapeHtml(post.content)}</p>` : ''}<div class="flex items-center justify-between pt-2 border-t border-black/5"><button data-action="like" class="flex items-center gap-1.5 px-2 py-1 rounded-xl bg-white/40"><i class="${liked ? 'fa-solid text-rose-500':'fa-regular'} fa-heart"></i><span>${post.likes || 0}</span></button><button data-action="copy" class="p-1 opacity-50" aria-label="Copy"><i class="fa-regular fa-copy"></i></button></div>`;
      card.addEventListener('click', event => {
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action === 'like') toggleList(post, 'likedBy');
        if (action === 'star') toggleList(post, 'starredBy');
        if (action === 'delete') deletePost(post);
        if (action === 'view') openLightbox(image, post.content);
        if (action === 'copy') copyText(post.content);
      });
      pinboardGrid.appendChild(card);
    });
  }

  function requireAccount() { if (currentUser) return true; open(authModal); showNotification('Sign in to use this feature.', 'error'); return false; }
  function toggleList(post, field) {
    if (!requireAccount()) return;
    const list = post[field] || [];
    post[field] = list.includes(currentUser.id) ? list.filter(x => x !== currentUser.id) : [...list, currentUser.id];
    post.likes = (post.likedBy || []).length;
    write(KEYS.posts, allPosts); renderPosts();
  }
  function deletePost(post) {
    if (!currentUser || post.authorId !== currentUser.id) return;
    if (!confirm('Remove this pin?')) return;
    allPosts = allPosts.filter(p => p.id !== post.id); write(KEYS.posts, allPosts); renderPosts(); showNotification('Pin removed.');
  }
  function openLightbox(url, caption) { $('lightbox-img').src = url; $('lightbox-caption').textContent = caption || ''; open(lightboxModal); }
  async function copyText(text) {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); showNotification('Copied to clipboard!'); }
    catch { showNotification('Clipboard permission was blocked.', 'error'); }
  }
  function open(modal) { modal.classList.remove('hidden'); }
  function close(modal) { modal.classList.add('hidden'); }
  function closeAll() { [addPostModal, authModal, profileModal, lightboxModal].forEach(close); }

  $('email-login-btn').onclick = login;
  $('email-signup-btn').onclick = register;
  $('email-auth-form').onsubmit = event => { event.preventDefault(); login(); };
  $('google-signin-btn').onclick = () => showNotification('Google sign-in requires your own Firebase/Google OAuth configuration. Email registration works now.', 'error');
  $('guest-continue-btn').onclick = () => { close(authModal); currentUser = null; updateUserUI(); showNotification('Continuing as Guest.'); };
  $('sign-out-btn').onclick = signOutUser;
  $('profile-form').onsubmit = event => {
    event.preventDefault();
    if (!currentUser) return close(profileModal);
    const nickname = $('profile-nickname').value.trim();
    const url = safeImage($('profile-avatar-url').value);
    const avatar = url || safeImage($('profile-avatar-preview').src) || makeAvatar(nickname);
    if (!nickname) return showNotification('Nickname cannot be empty.', 'error');
    currentUser.nickname = nickname; currentUser.avatar = avatar;
    users = users.map(u => u.id === currentUser.id ? currentUser : u);
    allPosts.forEach(p => { if (p.authorId === currentUser.id) { p.authorName = nickname; p.authorAvatar = avatar; } });
    write(KEYS.users, users); write(KEYS.posts, allPosts); updateUserUI(); renderPosts(); close(profileModal); showNotification('Profile and avatar updated!');
  };

  postFileInput.onchange = event => event.target.files[0] && previewFile(event.target.files[0]);
  $('avatar-file-input').onchange = event => event.target.files[0] && previewFile(event.target.files[0], true);
  postImageUrl.oninput = event => { const url = safeImage(event.target.value); if (url) { selectedFileDataUrl = url; postPreviewImg.src = url; filePreviewContainer.classList.remove('hidden'); } };
  $('remove-preview-btn').onclick = () => { selectedFileDataUrl = null; postFileInput.value = ''; postImageUrl.value = ''; filePreviewContainer.classList.add('hidden'); };
  $('photo-tab-file').onclick = () => { $('file-upload-container').classList.remove('hidden'); $('url-upload-container').classList.add('hidden'); };
  $('photo-tab-url').onclick = () => { $('file-upload-container').classList.add('hidden'); $('url-upload-container').classList.remove('hidden'); };
  $('open-add-modal-btn').onclick = () => open(addPostModal);
  $('empty-add-btn').onclick = () => open(addPostModal);
  $('auth-profile-trigger').onclick = () => open(currentUser ? profileModal : authModal);
  $('close-add-modal-btn').onclick = $('cancel-add-modal-btn').onclick = () => close(addPostModal);
  $('close-auth-modal-btn').onclick = () => close(authModal);
  $('close-profile-modal-btn').onclick = $('cancel-profile-btn').onclick = () => close(profileModal);
  $('close-lightbox-btn').onclick = () => close(lightboxModal);
  [addPostModal, authModal, profileModal, lightboxModal].forEach(modal => modal.addEventListener('click', event => { if (event.target === modal) close(modal); }));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeAll(); });

  document.querySelectorAll('.filter-tab-btn').forEach(button => button.onclick = () => {
    document.querySelectorAll('.filter-tab-btn').forEach(b => b.classList.remove('bg-amber-500', 'text-white'));
    button.classList.add('bg-amber-500', 'text-white'); currentFilter = button.dataset.filter; renderPosts();
  });
  document.querySelectorAll('.color-filter-btn').forEach(button => button.onclick = () => {
    document.querySelectorAll('.color-filter-btn').forEach(b => b.classList.remove('border-2', 'border-amber-500'));
    button.classList.add('border-2', 'border-amber-500'); currentColorFilter = button.dataset.colorFilter; renderPosts();
  });
  const handleSearch = event => { searchQuery = event.target.value; $('search-input').value = searchQuery; $('mobile-search-input').value = searchQuery; renderPosts(); };
  $('search-input').oninput = $('mobile-search-input').oninput = handleSearch;
  $('theme-toggle-btn').onclick = () => { document.documentElement.classList.toggle('dark'); localStorage.setItem(KEYS.theme, document.documentElement.classList.contains('dark') ? 'dark' : 'light'); };
  window.addEventListener('storage', () => { users = read(KEYS.users, []); allPosts = read(KEYS.posts, []); session = read(KEYS.session, null); currentUser = session ? users.find(u => u.id === session.userId) || null : null; updateUserUI(); renderPosts(); });

  function resetAddForm() { addPostForm.reset(); selectedFileDataUrl = null; filePreviewContainer.classList.add('hidden'); }
  function escapeHtml(value) { return String(value || '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char])); }
  function formatTime(timestamp) { const diff = Math.max(0, Math.floor((Date.now() - Number(timestamp || Date.now())) / 1000)); return diff < 60 ? 'Just now' : diff < 3600 ? `${Math.floor(diff/60)}m ago` : diff < 86400 ? `${Math.floor(diff/3600)}h ago` : `${Math.floor(diff/86400)}d ago`; }
  function showNotification(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `fixed bottom-5 right-5 z-[70] max-w-sm px-4 py-3 rounded-2xl shadow-xl text-xs font-semibold text-white ${type === 'error' ? 'bg-rose-600' : 'bg-slate-900'}`;
    toast.textContent = message; document.body.appendChild(toast); setTimeout(() => toast.remove(), 3500);
  }

  if (localStorage.getItem(KEYS.theme) === 'dark') document.documentElement.classList.add('dark');
  updateUserUI(); renderPosts();
  if (!session) setTimeout(() => open(authModal), 250);
})();
