/** ========= 必改：後端網址 ========= */
const BASE_URL = "https://snufflingly-subuncinate-rosario.ngrok-free.dev/"; // 後端 base
const AUTH_PAGE_URL = "/static/auth.html"; // Flask 靜態頁面路徑（需要就改）

const API = {
  ping: "/db_test",
  register: "/api/v1/auth/register",
  login: "/api/v1/auth/login",
  me: "/api/v1/users/me",
  posts: "/api/v1/posts",
  upload: "/api/upload"
};

let postsCache = [];
const $ = (id) => document.getElementById(id);

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

    const authorName = escapeHtml(p.author?.userName || p.user_name || "unknown");
    const authorEmail = escapeHtml(p.author?.email || p.Email || "");
    const t = fmtTime(p.createdAt || p.time);
    const likes = (p.likes ?? 0);

    const meta = document.createElement("div");
    meta.className = "postMeta";
    meta.innerHTML = `
      <div class="nameLine">
        <b>${authorName}</b>
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
      <span>likes: ${likes}</span>
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
    p.likedByMe = !!data.liked;
    p.likes = data.likes ?? p.likes;
    renderFeed();
  }catch(e){
    setApiStatus(false, `更新 like 失敗：${e.message}`);
  }
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
