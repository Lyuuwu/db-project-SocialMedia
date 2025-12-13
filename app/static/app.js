// const BASE_URL = "https://snufflingly-subuncinate-rosario.ngrok-free.dev/"; // 後端 base
BASE_URL = location.origin
const AUTH_PAGE_URL = "/static/auth.html"; // Flask 靜態頁面路徑（需要就改）

const API = {
  ping: "/db_test",
  register: "/api/v1/auth/register",
  login: "/api/v1/auth/login",
  me: "/api/v1/users/me",
  users: "/api/v1/users",
  posts: "/api/v1/posts",
  upload: "/api/upload"
};

let postsCache = [];
const $ = (id) => document.getElementById(id);

// hover 顯示最多幾個人（改 5 / 10 都可以）
const LIKES_HOVER_LIMIT = 8;

// 如果你本來就有 tooltip 狀態，就把這兩個變數對應到你的即可
// ✅ 每篇貼文 likes 名單的版本號：避免舊 request 回來把舊資料塞回快取
const likesPreviewVer = new Map(); // postId -> integer

function bumpLikesPreviewVer(postId){
  likesPreviewVer.set(postId, (likesPreviewVer.get(postId) || 0) + 1);
}

// ✅ 核心：清掉某篇貼文的 hover 名單快取，避免顯示舊資料
function invalidateLikesPreview(postId){
  likesPreviewCache.delete(postId);
  bumpLikesPreviewVer(postId);

  // 如果 popover 正在顯示這篇貼文的名單，直接關掉（避免畫面顯示舊資料）
  if (typeof activeLikesPostId !== "undefined" && activeLikesPostId === postId){
    hideLikesPopover();
  }
}


function showMsg(el, type, text){
  if (!el) return;
  el.className = "msg " + (type || "");
  el.textContent = text || "";
  el.style.display = text ? "block" : "none";
}

function setApiStatus(ok, text){
  const dot = $("apiDot");
  const t = $("apiText");
  if (!dot || !t) return;
  dot.classList.remove("ok","err");
  dot.classList.add(ok ? "ok" : "err");
  t.textContent = text;
}

function escapeHtml(str){
  return String(str ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;");
}

function fmtTime(t){
  try{
    const d = new Date(t);
    if (isNaN(d)) return "";
    return d.toLocaleString();
  }catch{ return ""; }
}

/* ===== session ===== */
function getSession(){
  const raw = localStorage.getItem("miniig_session");
  return raw ? JSON.parse(raw) : null; // { accessToken, user }
}

function setSession(session){
  if (!session) localStorage.removeItem("miniig_session");
  else localStorage.setItem("miniig_session", JSON.stringify(session));

  syncWhoAmI();
  syncAccountUI();
}

function syncWhoAmI(){
  const el = $("whoami");
  if (!el) return;
  const s = getSession();
  const u = s?.user;
  el.textContent = u ? (u.userName || u.email || "已登入") : "未登入";
}

function initialsFromUser(u){
  const name = (u?.userName || "").trim();
  const email = (u?.email || "").trim();
  const base = name || email || "U";
  return base.slice(0, 1).toUpperCase();
}

function normalizeBackendUrl(p){
  const v = (p || "").trim();
  if (!v) return "";
  if (v.startsWith("http://") || v.startsWith("https://")) return v;
  return BASE_URL.replace(/\/$/,"") + (v.startsWith("/") ? v : ("/" + v));
}

function syncAccountUI(){
  const loginBtn = $("loginNavBtn");
  const avatarMenu = $("avatarMenu");
  if (!loginBtn || !avatarMenu) return;

  const s = getSession();
  const loggedIn = !!s?.accessToken;

  loginBtn.style.display = loggedIn ? "none" : "inline-flex";
  avatarMenu.style.display = loggedIn ? "flex" : "none";

  if (!loggedIn) return;

  const u = s.user || {};
  const nameEl = $("popName");
  const emailEl = $("popEmail");
  const bioEl = $("popBio");
  if (nameEl) nameEl.textContent = u.userName || "已登入";
  if (emailEl) emailEl.textContent = u.email || "";
  if (bioEl) bioEl.textContent = u.bio || "";

  const img = $("avatarImg");
  const fallback = $("avatarFallback");

  const pic = (u.profilePic || "").trim();
  if (pic && img && fallback){
    img.src = normalizeBackendUrl(pic);
    img.style.display = "block";
    fallback.style.display = "none";
  }else{
    if (img) img.style.display = "none";
    if (fallback){
      fallback.style.display = "grid";
      fallback.textContent = initialsFromUser(u);
    }
  }
}

/* ===== navigation to auth page ===== */
function safeNextUrl(){
  const params = new URLSearchParams(location.search);
  const next = params.get("next");
  if (!next) return "/";
  try{
    const u = new URL(next, location.origin);
    if (u.origin !== location.origin) return "/";
    return u.href;
  }catch{
    return "/";
  }
}

function goToAuth(){
  const next = encodeURIComponent(location.href);
  // 你若不是 Flask 靜態路徑，改成 "./auth.html" 或你的路由即可
  location.href = `${AUTH_PAGE_URL}?next=${next}`;
}

function goBackFromAuth(){
  const next = safeNextUrl();
  location.href = next;
}

/* ===== API helper ===== */
async function apiFetch(path, options={}){
  const url = BASE_URL.replace(/\/$/,"") + path;
  const headers = Object.assign({ "Content-Type":"application/json" }, options.headers || {});
  const opts = Object.assign({}, options, { headers });

  const s = getSession();
  if (s?.accessToken) headers.Authorization = `Bearer ${s.accessToken}`;

  const res = await fetch(url, opts);

  let data = null;
  try { data = await res.json(); } catch { data = null; }

  if (!res.ok){
    const msg = data?.error?.message || data?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

/* ===== backend ping ===== */
async function pingBackend(){
  try{
    const data = await apiFetch(API.ping, { method:"GET" });
    setApiStatus(true, `後端 OK：${data?.db ?? data?.db_name ?? "db"} / ${data?.login ?? data?.login_name ?? "login"}`);
  }catch(e){
    setApiStatus(false, `後端失敗：${e.message}`);
  }
}

/* ===== auth page UI ===== */
function uiSetAuthTab(tab){
  const isLogin = (tab === "login");
  const tabLogin = $("tabLogin");
  const tabRegister = $("tabRegister");
  const panelLogin = $("panelLogin");
  const panelRegister = $("panelRegister");

  if (tabLogin) tabLogin.classList.toggle("active", isLogin);
  if (tabRegister) tabRegister.classList.toggle("active", !isLogin);
  if (panelLogin) panelLogin.style.display = isLogin ? "block" : "none";
  if (panelRegister) panelRegister.style.display = isLogin ? "none" : "block";
}

/* ===== auth ===== */
async function register(){
  const msg = $("regMsg");
  showMsg(msg, "", "");

  const email = $("regEmail")?.value.trim();
  const password = $("regPwd")?.value;
  const userName = $("regUserName")?.value.trim();

  const bio = $("regBio")?.value.trim();
  const profilePic = $("regPic")?.value.trim();

  if (!email || !password || !userName){
    return showMsg(msg, "err", "必填：email / password / userName");
  }

  try{
    const data = await apiFetch(API.register, {
      method:"POST",
      body: JSON.stringify({ email, password, userName })
    });

    setSession({ accessToken: data.accessToken, user: data.user });

    if (bio || profilePic){
      const patchBody = {};
      if (bio) patchBody.bio = bio;
      if (profilePic) patchBody.profilePic = profilePic;

      const me = await apiFetch(API.me, {
        method:"PATCH",
        body: JSON.stringify(patchBody),
      });

      setSession({ accessToken: data.accessToken, user: me });
    }

    showMsg(msg, "ok", "註冊成功並已登入！");
    // ✅ 登入後回到上一頁
    setTimeout(()=> goBackFromAuth(), 350);

  }catch(e){
    showMsg(msg, "err", `註冊失敗：${e.message}`);
  }
}

async function login(){
  const msg = $("authMsg");
  showMsg(msg, "", "");

  const email = $("loginEmail")?.value.trim();
  const password = $("loginPwd")?.value;
  if (!email || !password) return showMsg(msg, "err", "請輸入 email + password");

  try{
    const data = await apiFetch(API.login, {
      method:"POST",
      body: JSON.stringify({ email, password })
    });

    setSession({ accessToken: data.accessToken, user: data.user });

    showMsg(msg, "ok", `登入成功：${data.user.userName || data.user.email}`);
    // ✅ 登入後回到上一頁
    setTimeout(()=> goBackFromAuth(), 350);

  }catch(e){
    showMsg(msg, "err", `登入失敗：${e.message}`);
  }
}

function logout(){
  setSession(null);
  showMsg($("postMsg"), "ok", "已登出");
  // 若你想登出就直接去登入頁，也可以改成 goToAuth()
  loadPosts?.().catch?.(()=>{});
}

/* ===== pages (home/create) ===== */
function showPage(which){
  const isHome = (which === "home");
  const pageHome = $("pageHome");
  const pageCreate = $("pageCreate");
  const navHome = $("navHome");
  const navCreate = $("navCreate");

  if (pageHome) pageHome.style.display = isHome ? "block" : "none";
  if (pageCreate) pageCreate.style.display = isHome ? "none" : "block";
  if (navHome) navHome.classList.toggle("active", isHome);
  if (navCreate) navCreate.classList.toggle("active", !isHome);

  const pageTitle = $("pageTitle");
  const pageDesc = $("pageDesc");
  if (pageTitle) pageTitle.textContent = isHome ? "首頁｜最新貼文" : "發文｜建立新貼文";
  if (pageDesc) pageDesc.textContent = isHome
    ? "顯示所有貼文，依 time/createdAt 由新到舊排序。"
    : "在這裡撰寫貼文，送出後回到 Home。";
}

/* ====== Image upload + preview ====== */
function clearPostImage(){
  const f = $("postFile");
  if (f) f.value = "";
  const previewBox = $("previewBox");
  const previewImg = $("previewImg");
  if (previewBox) previewBox.style.display = "none";
  if (previewImg) previewImg.src = "";
}

function bindFilePreview(){
  const input = $("postFile");
  if (!input) return;
  input.addEventListener("change", () => {
    const f = input.files?.[0];
    if (!f) return clearPostImage();
    const url = URL.createObjectURL(f);
    const previewImg = $("previewImg");
    const previewBox = $("previewBox");
    if (previewImg) previewImg.src = url;
    if (previewBox) previewBox.style.display = "block";
  });
}

async function uploadImageIfNeeded(){
  const s = getSession();
  const file = $("postFile")?.files?.[0];
  if (!file) return "";

  const fd = new FormData();
  fd.append("file", file);

  const url = BASE_URL.replace(/\/$/,"") + API.upload;
  const headers = {};
  if (s?.accessToken) headers.Authorization = `Bearer ${s.accessToken}`;

  const res = await fetch(url, { method:"POST", body: fd, headers });
  let data = null;
  try { data = await res.json(); } catch { data = null; }

  if (!res.ok){
    throw new Error(data?.error || data?.message || "圖片上傳失敗");
  }
  return data?.url || "";
}

/* posts */
async function loadPosts(){
  try{
    const data = await apiFetch(API.posts + "?page=1&pageSize=50", { method:"GET" });
    postsCache = Array.isArray(data) ? data : (data.items || []);

    postsCache.sort((a,b)=>{
      const ta = new Date(a.createdAt || a.time || 0).getTime();
      const tb = new Date(b.createdAt || b.time || 0).getTime();
      return tb - ta;
    });

    // ✅ 建議：整批更新後把 hover 快取清掉
    likesPreviewCache.clear();
    likesHoverState = { postId: null, isOpen: false };
    hideLikesPopover(); // ✅ 你有這個


    renderFeed();
    setApiStatus(true, "後端連線正常");
  }catch(e){
    setApiStatus(false, `抓貼文失敗：${e.message}`);
  }
}

async function createPost(){
  const msg = $("postMsg");
  showMsg(msg, "", "");

  const s = getSession();
  if (!s?.accessToken){
    showMsg(msg, "err", "請先登入（右上角登入 / 註冊）");
    goToAuth();
    return;
  }

  const content = $("postContent")?.value.trim();
  if (!content) return showMsg(msg, "err", "content 不能空");

  try{
    showMsg(msg, "", "正在上傳/送出...");
    const pictureUrl = await uploadImageIfNeeded();

    await apiFetch(API.posts, {
      method:"POST",
      body: JSON.stringify({ content, picture: pictureUrl })
    });

    showMsg(msg, "ok", "發佈成功！");
    $("postContent").value = "";
    clearPostImage();
    updateCharCount();
    showPage("home");
    await loadPosts();
  }catch(e){
    showMsg(msg, "err", `發文失敗：${e.message}`);
  }
}

// ===== likes preview / modal settings =====
const LIKES_PREVIEW_LIMIT = 5; // 想要 10 就改成 10
const LIKES_PAGE_SIZE = 200;   // modal 分頁一次拿幾個（後端有上限 200）

let likesPopoverEl = null;
let likesHideTimer = null;
let activeLikesAnchor = null;
let activeLikesPostId = null;

const likesPreviewCache = new Map();
const LIKES_PREVIEW_CACHE_MS = 15000;

function ensureLikesPopover(){
  if (likesPopoverEl) return likesPopoverEl;

  likesPopoverEl = document.createElement("div");
  likesPopoverEl.className = "likesPopover";
  likesPopoverEl.id = "likesPopover";
  likesPopoverEl.innerHTML = `
    <div class="likesPopoverTitle">載入中…</div>
    <div class="likesPopoverList"></div>
  `;
  document.body.appendChild(likesPopoverEl);

  likesPopoverEl.addEventListener("pointerenter", () => {
    if (likesHideTimer) clearTimeout(likesHideTimer);
    likesHideTimer = null;
  });
  likesPopoverEl.addEventListener("pointerleave", () => scheduleHideLikesPopover());

  window.addEventListener("scroll", () => {
    if (likesPopoverEl?.classList.contains("show") && activeLikesAnchor) positionLikesPopover(activeLikesAnchor);
  }, true);
  window.addEventListener("resize", () => {
    if (likesPopoverEl?.classList.contains("show") && activeLikesAnchor) positionLikesPopover(activeLikesAnchor);
  });

  return likesPopoverEl;
}

function scheduleHideLikesPopover(){
  if (likesHideTimer) clearTimeout(likesHideTimer);
  likesHideTimer = setTimeout(() => hideLikesPopover(), 120);
}

function hideLikesPopover(){
  if (!likesPopoverEl) return;
  likesPopoverEl.classList.remove("show");
  activeLikesAnchor = null;
  activeLikesPostId = null;
}

function positionLikesPopover(anchor){
  const pop = ensureLikesPopover();
  const rect = anchor.getBoundingClientRect();

  const gap = 8;
  let top = rect.bottom + gap;
  let left = rect.left;

  // 防止超出右邊
  const vw = window.innerWidth;
  const popW = Math.min(340, Math.max(260, pop.offsetWidth || 280));
  if (left + popW > vw - 10) left = vw - popW - 10;
  if (left < 10) left = 10;

  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
}

async function fetchLikesPreview(postId){
  const now = Date.now();
  const cached = likesPreviewCache.get(postId);
  if (cached && (now - cached.ts) < LIKES_PREVIEW_CACHE_MS) return cached.data;

  // 送出 request 前，先記住當下版本
  const ver = likesPreviewVer.get(postId) || 0;

  const qs = new URLSearchParams({ limit: String(LIKES_PREVIEW_LIMIT) });
  const data = await apiFetch(`${API.posts}/${postId}/likes?${qs.toString()}`);

  // 如果 request 飛行途中被 invalidate（ver 變了），就不要把舊資料寫進快取
  if ((likesPreviewVer.get(postId) || 0) !== ver){
    return data; // 仍回傳給呼叫者，但不快取
  }

  likesPreviewCache.set(postId, { ts: Date.now(), data });
  return data;
}


async function fetchLikesPage(postId, page){
  const qs = new URLSearchParams({
    page: String(page),
    pageSize: String(LIKES_PAGE_SIZE),
  });
  return await apiFetch(`${API.posts}/${postId}/likes?${qs.toString()}`);
}

function renderLikeUserRow(u){
  const name = escapeHtml(u.userName || "unknown");
  const pic = normalizeBackendUrl(u.profilePic || "");
  const avatar = pic
    ? `<img class="likeMiniAvatar" src="${escapeHtml(pic)}" alt="avatar" />`
    : `<div class="likeMiniFallback">${name.slice(0,1).toUpperCase()}</div>`;

  return `<div class="likeRow">${avatar}<div class="likeName">${name}</div></div>`;
}

let likesPreviewReqSeq = 0;

async function showLikesPreview(anchorEl){
  const postId = Number(anchorEl.dataset.postId);
  if (!postId) return;

  const pop = ensureLikesPopover();

  if (likesHideTimer) clearTimeout(likesHideTimer);
  likesHideTimer = null;

  activeLikesAnchor = anchorEl;
  activeLikesPostId = postId;

  positionLikesPopover(anchorEl);
  pop.classList.add("show");
  pop.querySelector(".likesPopoverTitle").textContent = "載入中…";
  pop.querySelector(".likesPopoverList").innerHTML = "";

  // ✅ 這次顯示的 request id
  const reqId = ++likesPreviewReqSeq;

  try{
    const data = await fetchLikesPreview(postId);

    // ✅ 如果途中又觸發其他 hover / 或 popover 已切到別篇，就不要用舊結果覆蓋 UI
    if (reqId !== likesPreviewReqSeq) return;
    if (activeLikesPostId !== postId) return;

    const items = data.items || [];
    const total = data.total ?? items.length;

    pop.querySelector(".likesPopoverTitle").textContent = `${total} 人按讚`;
    pop.querySelector(".likesPopoverList").innerHTML = items.length
      ? items.map(renderLikeUserRow).join("")
      : `<div class="msg" style="display:block; padding:6px 0;">目前還沒有人按讚</div>`;

    if (total > LIKES_PREVIEW_LIMIT){
      pop.querySelector(".likesPopoverList").insertAdjacentHTML(
        "beforeend",
        `<div style="opacity:.75; padding:4px 8px;">…以及其他 ${total - LIKES_PREVIEW_LIMIT} 人</div>`
      );
    }
  }catch(e){
    if (reqId !== likesPreviewReqSeq) return;
    if (activeLikesPostId !== postId) return;

    pop.querySelector(".likesPopoverTitle").textContent = "讀取失敗";
    pop.querySelector(".likesPopoverList").innerHTML =
      `<div class="msg" style="display:block;">${escapeHtml(e.message)}</div>`;
  }
}

// ===== likes modal =====
let likesUiInited = false;

function initLikesUi(){
  if (likesUiInited) return;
  likesUiInited = true;

  const feed = $("feed");
  if (feed){
    feed.addEventListener("pointerover", (e) => {
      const a = e.target.closest?.(".likesLink");
      if (!a) return;
      showLikesPreview(a);
    });

    feed.addEventListener("pointerout", (e) => {
      const a = e.target.closest?.(".likesLink");
      if (!a) return;

      // 若移動到 popover 本身，就不要立刻關
      const rt = e.relatedTarget;
      if (rt && likesPopoverEl && likesPopoverEl.contains(rt)) return;

      scheduleHideLikesPopover();
    });

    feed.addEventListener("click", (e) => {
      const a = e.target.closest?.(".likesLink");
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      hideLikesPopover();
      openLikesModal(Number(a.dataset.postId));
    });
  }

  const overlay = $("likesOverlay");
  const modal = $("likesModal");
  const closeBtn = $("likesCloseBtn");

  if (overlay){
    overlay.addEventListener("click", (e) => {
      // 點到 overlay 空白處才關
      if (e.target === overlay) closeLikesModal();
    });
  }
  if (modal){
    modal.addEventListener("click", (e) => e.stopPropagation());
  }
  if (closeBtn){
    closeBtn.addEventListener("click", closeLikesModal);
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLikesModal();
  });
}

function openLikesModal(postId){
  const overlay = $("likesOverlay");
  if (!overlay || !postId) return;

  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");

  $("likesModalHeader").textContent = "載入中…";
  $("likesModalList").innerHTML = "";

  loadAllLikesIntoModal(postId).catch(()=>{});
}

function closeLikesModal(){
  const overlay = $("likesOverlay");
  if (!overlay) return;
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");
}

async function loadAllLikesIntoModal(postId){
  const header = $("likesModalHeader");
  const listEl = $("likesModalList");

  let page = 1;
  let all = [];
  let total = 0;

  while (true){
    const data = await fetchLikesPage(postId, page);
    const items = data.items || [];
    total = data.total ?? total;

    all = all.concat(items);

    if (items.length === 0) break;
    if (total && all.length >= total) break;

    page += 1;
    if (page > 200) break; // 極端保護：避免無限迴圈
  }

  header.textContent = total ? `共 ${total} 人按讚` : "目前還沒有人按讚";
  listEl.innerHTML = all.length
    ? all.map(renderLikeUserRow).join("")
    : `<div class="msg" style="display:block;">目前還沒有人按讚</div>`;
}

function renderFeed(){
  const q = ($("search")?.value || "").trim().toLowerCase();
  const feed = $("feed");
  if (!feed) return;
  feed.innerHTML = "";

  const list = (postsCache || []).filter(p=>{
    if (!q) return true;
    const s = `${p.content||""} ${p.author?.userName||""} ${p.author?.email||""}`.toLowerCase();
    return s.includes(q);
  });

  if (list.length === 0){
    const empty = document.createElement("div");
    empty.className = "msg";
    empty.style.display = "block";
    empty.textContent = "目前沒有貼文（或搜尋結果為空）。";
    feed.appendChild(empty);
    return;
  }

  list.forEach(p=>{
    const card = document.createElement("div");
    card.className = "postCard";

    const t = fmtTime(p.createdAt || p.time);
    const likes = (p.likes ?? 0);

    const meta = document.createElement("div");
    meta.className = "postMeta";
    const author = p.author || {};
    const authorId = Number(author.userId || 0);
    const authorRawName = author.userName || p.user_name || "unknown";
    const authorName = escapeHtml(authorRawName);
    const authorEmail = escapeHtml(author.email || p.Email || ""); // 有的話才會顯示
    const authorPic = normalizeBackendUrl(author.profilePic || "");
    const authorInitial = firstLetter(authorRawName);

    const authorAvatarHtml = authorPic
    ? `<img class="authorAvatar" src="${escapeHtml(authorPic)}" alt="avatar" />`
    : `<div class="authorFallback">${escapeHtml(authorInitial)}</div>`;

    meta.innerHTML = `
    <div class="nameLine">
        <span class="authorChip" data-user-id="${authorId}" data-user-name="${escapeHtml(authorRawName)}">
        ${authorAvatarHtml}
        <b>${authorName}</b>
        </span>
        ${authorEmail ? `<span class="badge">${authorEmail}</span>` : ""}
    </div>
    <div class="time">${t}</div>
    `;

    const body = document.createElement("div");
    body.className = "postBody";
    body.innerHTML = escapeHtml(p.content || "");

    card.appendChild(meta);
    card.appendChild(body);

    const pic = normalizeBackendUrl(p.picture || "");
    if (pic){
      const imgWrap = document.createElement("div");
      imgWrap.className = "imgWrap";
      imgWrap.innerHTML = `<img src="${escapeHtml(pic)}" alt="post image" />`;
      card.appendChild(imgWrap);
    }

    const footer = document.createElement("div");
    footer.className = "footerBar";
    const postId = p.postId;
    const heart = p.likedByMe ? "♥" : "♡";
    footer.innerHTML = `
      <span class="likesLink" data-post-id="${postId}">likes: ${likes}</span>
      <span style="display:flex; gap:8px; align-items:center;">
        <button class="btn ghost" onclick="toggleLike(${postId})">${heart} Like</button>
        <span class="badge">from API</span>
      </span>
    `;

    card.appendChild(footer);
    feed.appendChild(card);
  });
}

async function toggleLike(postId){
    const s = getSession();
    if (!s?.accessToken){
        goToAuth();
        return;
    }


    const p = (postsCache || []).find(x => x.postId === postId);
    if (!p) return;

    const path = `${API.posts}/${postId}/like`;

    try{
    const data = await apiFetch(path, { method: p.likedByMe ? "DELETE" : "POST" });

    // 更新數字與愛心狀態
    p.likedByMe = !!data.liked;
    p.likes = data.likes ?? p.likes;

    // ✅ 關鍵：清掉 hover 名單快取，避免顯示舊資料
    invalidateLikesPreview(postId);

    // 重新渲染畫面
    renderFeed();
    }catch(e){
    setApiStatus(false, `更新 like 失敗：${e.message}`);
    }
}

/* =========================
   User popover (for post author)
   ========================= */
const USER_PREVIEW_CACHE_MS = 30000;
const userPreviewCache = new Map(); // userId -> {ts, data}

let userPopoverEl = null;
let userHideTimer = null;
let activeUserAnchor = null;
let activeUserId = null;
let userReqSeq = 0;

function firstLetter(str){
  const s = String(str || "").trim();
  return (s ? s[0] : "U").toUpperCase();
}

function ensureUserPopover(){
  if (userPopoverEl) return userPopoverEl;

  userPopoverEl = document.createElement("div");
  userPopoverEl.className = "userPopover";
  userPopoverEl.id = "userPopover";
  userPopoverEl.innerHTML = `
    <div class="userPopoverTop">
      <div class="userPopFallback">U</div>
      <div class="userPopMeta">
        <div class="name">載入中…</div>
        <div class="email"></div>
      </div>
    </div>
    <div class="userPopBio"></div>
    <div class="userPopHint"></div>
  `;
  document.body.appendChild(userPopoverEl);

  userPopoverEl.addEventListener("pointerenter", () => {
    if (userHideTimer) clearTimeout(userHideTimer);
    userHideTimer = null;
  });
  userPopoverEl.addEventListener("pointerleave", () => scheduleHideUserPopover());

  window.addEventListener("scroll", () => {
    if (userPopoverEl?.classList.contains("show") && activeUserAnchor){
      positionUserPopover(activeUserAnchor);
    }
  }, true);
  window.addEventListener("resize", () => {
    if (userPopoverEl?.classList.contains("show") && activeUserAnchor){
      positionUserPopover(activeUserAnchor);
    }
  });

  return userPopoverEl;
}

function scheduleHideUserPopover(){
  if (userHideTimer) clearTimeout(userHideTimer);
  userHideTimer = setTimeout(() => hideUserPopover(), 120);
}

function hideUserPopover(){
  if (!userPopoverEl) return;
  userPopoverEl.classList.remove("show");
  activeUserAnchor = null;
  activeUserId = null;
}

function positionUserPopover(anchor){
  const pop = ensureUserPopover();
  const rect = anchor.getBoundingClientRect();

  const gap = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const popW = 300;
  const popH = pop.offsetHeight || 160;

  // 預設放下方，不夠就放上方
  let top = rect.bottom + gap;
  if (top + popH > vh - 10){
    top = rect.top - gap - popH;
  }
  top = Math.max(10, Math.min(top, vh - popH - 10));

  let left = rect.left;
  if (left + popW > vw - 10) left = vw - popW - 10;
  if (left < 10) left = 10;

  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
}

async function fetchUserPreview(userId){
  const now = Date.now();
  const cached = userPreviewCache.get(userId);
  if (cached && (now - cached.ts) < USER_PREVIEW_CACHE_MS) return cached.data;

  const data = await apiFetch(`${API.users}/${userId}`, { method: "GET" });
  userPreviewCache.set(userId, { ts: now, data });
  return data;
}

function renderUserPopover(u){
  const pop = ensureUserPopover();

  const name = escapeHtml(u?.userName || "unknown");
  const email = escapeHtml(u?.email || "");
  const bio = escapeHtml(u?.bio || "");

  const pic = normalizeBackendUrl(u?.profilePic || "");
  const avatarHtml = pic
    ? `<img class="userPopAvatar" src="${escapeHtml(pic)}" alt="avatar" />`
    : `<div class="userPopFallback">${escapeHtml(firstLetter(u?.userName || u?.email || "U"))}</div>`;

  pop.querySelector(".userPopoverTop").innerHTML = `
    ${avatarHtml}
    <div class="userPopMeta">
      <div class="name">${name}</div>
      <div class="email">${email}</div>
    </div>
  `;

  pop.querySelector(".userPopBio").textContent = bio ? bio : "";
  pop.querySelector(".userPopHint").textContent = bio ? "" : "（沒有 bio）";
}

async function showUserPopover(anchorEl){
  const userId = Number(anchorEl.dataset.userId);
  if (!userId) return;

  const pop = ensureUserPopover();

  if (userHideTimer) clearTimeout(userHideTimer);
  userHideTimer = null;

  activeUserAnchor = anchorEl;
  activeUserId = userId;

  positionUserPopover(anchorEl);
  pop.classList.add("show");

  // loading
  pop.querySelector(".userPopoverTop").innerHTML = `
    <div class="userPopFallback">${escapeHtml(firstLetter(anchorEl.dataset.userName || "U"))}</div>
    <div class="userPopMeta">
      <div class="name">載入中…</div>
      <div class="email"></div>
    </div>
  `;
  pop.querySelector(".userPopBio").textContent = "";
  pop.querySelector(".userPopHint").textContent = "";

  const seq = ++userReqSeq;
  try{
    const data = await fetchUserPreview(userId);
    if (seq !== userReqSeq) return; // 避免 race condition
    renderUserPopover(data);
  }catch(e){
    if (seq !== userReqSeq) return;
    pop.querySelector(".userPopHint").textContent = `讀取失敗：${e.message}`;
  }
}

function initAuthorHoverUi(){
  const feed = $("feed");
  if (!feed) return;

  feed.addEventListener("pointerover", (e) => {
    const chip = e.target.closest?.(".authorChip");
    if (!chip) return;
    showUserPopover(chip);
  });

  feed.addEventListener("pointerout", (e) => {
    const chip = e.target.closest?.(".authorChip");
    if (!chip) return;

    const rt = e.relatedTarget;
    if (rt && userPopoverEl && userPopoverEl.contains(rt)) return;

    scheduleHideUserPopover();
  });
}

/* helpers */
function updateCharCount(){
  const v = $("postContent")?.value || "";
  const el = $("charCount");
  if (el) el.textContent = `${v.length} / 500`;
}

/* ===== init ===== */
function initHome(){
  syncWhoAmI();
  syncAccountUI();

  showPage("home");
  initLikesUi();
  initAuthorHoverUi();

  updateCharCount();
  bindFilePreview();

  const postContent = $("postContent");
  if (postContent) postContent.addEventListener("input", updateCharCount);

  pingBackend();
  loadPosts().catch(()=>{});
}

function initAuth(){
  uiSetAuthTab("login");
  pingBackend();
}

(function boot(){
  const page = document.body?.dataset?.page;
  if (page === "home") initHome();
  if (page === "auth") initAuth();
})();
