// static/app.js

/** ========= 必改：後端網址 =========
 * 你現在這行 location.origin 在 GitHub Pages 會變成「前端自己的網域」→ 一定連不到你同學後端
 * 請改成像這樣：
 *   const BASE_URL = "https://abc123.ngrok-free.app";
 */
const BASE_URL = "https://snufflingly-subuncinate-rosario.ngrok-free.dev/"; // ← 改成你同學後端（ngrok / 公網 IP）

const API = {
  ping: "/db_test",                  // GET
  register: "/api/v1/auth/register", // POST
  login: "/api/v1/auth/login",       // POST
  me: "/api/v1/users/me",            // GET/PATCH
  posts: "/api/v1/posts",            // GET/POST
  upload: "/api/upload"              // POST (multipart/form-data) -> { url }
};

let postsCache = [];
const $ = (id) => document.getElementById(id);

function showMsg(el, type, text){
  el.className = "msg " + (type || "");
  el.textContent = text || "";
  el.style.display = text ? "block" : "none";
}

function setApiStatus(ok, text){
  const dot = $("apiDot");
  const t = $("apiText");
  dot.classList.remove("ok","err");
  dot.classList.add(ok ? "ok" : "err");
  t.textContent = text;
}

function setLoginDot(){
  const s = getSession();
  const dot = $("loginDot");
  dot.classList.remove("ok","err");
  dot.classList.add(s?.accessToken ? "ok" : "err");
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

/* session */
function getSession(){
  const raw = localStorage.getItem("miniig_session");
  return raw ? JSON.parse(raw) : null; // { accessToken, user }
}

function setSession(session){
  if (!session) localStorage.removeItem("miniig_session");
  else localStorage.setItem("miniig_session", JSON.stringify(session));
  syncWhoAmI();
}

function syncWhoAmI(){
  const s = getSession();
  const u = s?.user;
  $("whoami").textContent = u ? (u.userName || u.email || "已登入") : "未登入（點左上角頭像登入）";
  setLoginDot();
}

/* modal */
function openAuth(){ $("overlay").classList.add("open"); }
function closeAuth(){
  $("overlay").classList.remove("open");
  showMsg($("authMsg"), "", "");
  showMsg($("regMsg"), "", "");
}
function overlayClick(e){ if (e.target.id === "overlay") closeAuth(); }
window.addEventListener("keydown", (e)=>{ if (e.key === "Escape") closeAuth(); });

function uiSetTab(tab){
  const isLogin = (tab === "login");
  $("tabLogin").classList.toggle("active", isLogin);
  $("tabRegister").classList.toggle("active", !isLogin);
  $("panelLogin").style.display = isLogin ? "block" : "none";
  $("panelRegister").style.display = isLogin ? "none" : "block";
}

/* page switch */
function showPage(which){
  const isHome = (which === "home");
  $("pageHome").style.display = isHome ? "block" : "none";
  $("pageCreate").style.display = isHome ? "none" : "block";
  $("navHome").classList.toggle("active", isHome);
  $("navCreate").classList.toggle("active", !isHome);

  $("pageTitle").textContent = isHome ? "首頁｜最新貼文" : "發文｜建立新貼文";
  $("pageDesc").textContent = isHome
    ? "顯示所有貼文，依 time/createdAt 由新到舊排序。"
    : "在這裡撰寫貼文，送出後回到 Home。";
}

/* API helper */
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

/* backend ping */
async function pingBackend(){
  try{
    const data = await apiFetch(API.ping, { method:"GET" });
    setApiStatus(true, `後端 OK：${data?.db ?? data?.db_name ?? "db"} / ${data?.login ?? data?.login_name ?? "login"}`);
  }catch(e){
    setApiStatus(false, `後端失敗：${e.message}`);
  }
}

/* auth */
async function register(){
  const msg = $("regMsg");
  showMsg(msg, "", "");

  const email = $("regEmail").value.trim();
  const password = $("regPwd").value;
  const userName = $("regUserName").value.trim();

  const bio = $("regBio").value.trim();
  const profilePic = $("regPic").value.trim();

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
    await loadPosts().catch(()=>{});
    setTimeout(()=> closeAuth(), 450);

  }catch(e){
    showMsg(msg, "err", `註冊失敗：${e.message}`);
  }
}

async function login(){
  const msg = $("authMsg");
  showMsg(msg, "", "");

  const email = $("loginEmail").value.trim();
  const password = $("loginPwd").value;
  if (!email || !password) return showMsg(msg, "err", "請輸入 email + password");

  try{
    const data = await apiFetch(API.login, {
      method:"POST",
      body: JSON.stringify({ email, password })
    });

    setSession({ accessToken: data.accessToken, user: data.user });

    showMsg(msg, "ok", `登入成功：${data.user.userName || data.user.email}`);
    await loadPosts().catch(()=>{});
    setTimeout(()=> closeAuth(), 450);

  }catch(e){
    showMsg(msg, "err", `登入失敗：${e.message}`);
  }
}

function logout(){
  setSession(null);
  showMsg($("postMsg"), "ok", "已登出");
}

/* ====== Image upload + preview ====== */
function clearPostImage(){
  const f = $("postFile");
  if (f) f.value = "";
  $("previewBox").style.display = "none";
  $("previewImg").src = "";
}

$("postFile")?.addEventListener("change", () => {
  const f = $("postFile").files?.[0];
  if (!f) return clearPostImage();
  const url = URL.createObjectURL(f);
  $("previewImg").src = url;
  $("previewBox").style.display = "block";
});

/* posts */
async function loadPosts(){
  try{
    const data = await apiFetch(API.posts + "?page=1&pageSize=50", { method:"GET" });
    postsCache = Array.isArray(data) ? data : (data.items || []);

    // ✅ 最新在最上面（createdAt 優先，其次 time）
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

async function uploadImageIfNeeded(){
  const s = getSession();
  const file = $("postFile")?.files?.[0];
  if (!file) return ""; // 沒選圖片

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

  // 期待回：{ url: "/uploads/xxx.jpg" } 或 { url: "https://.../uploads/xxx.jpg" }
  return data?.url || "";
}

function normalizeImageUrl(pic){
  const p = (pic || "").trim();
  if (!p) return "";
  if (p.startsWith("http://") || p.startsWith("https://")) return p;
  // 相對路徑 → 補成後端可讀
  return BASE_URL.replace(/\/$/,"") + (p.startsWith("/") ? p : ("/" + p));
}

async function createPost(){
  const msg = $("postMsg");
  showMsg(msg, "", "");

  const s = getSession();
  if (!s?.accessToken) return showMsg(msg, "err", "請先登入（點左上角頭像）");

  const content = $("postContent").value.trim();
  if (!content) return showMsg(msg, "err", "content 不能空");

  try{
    // ① 先上傳圖片（如果有選）
    showMsg(msg, "", "正在上傳/送出...");
    const pictureUrl = await uploadImageIfNeeded();

    // ② 建立貼文
    await apiFetch(API.posts, {
      method:"POST",
      body: JSON.stringify({
        content,
        picture: pictureUrl
      })
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

/* render */
function renderFeed(){
  const q = $("search").value.trim().toLowerCase();
  const feed = $("feed");
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

    const pic = normalizeImageUrl(p.picture || "");
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
    openAuth();
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
  const v = $("postContent").value || "";
  $("charCount").textContent = `${v.length} / 500`;
}

/* init bindings */
document.getElementById("authBtn").addEventListener("click", openAuth);
document.getElementById("postContent").addEventListener("input", updateCharCount);

syncWhoAmI();
uiSetTab("login");
showPage("home");
updateCharCount();
pingBackend();
loadPosts().catch(()=>{});
