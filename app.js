// ── 설정 ────────────────────────────────────────────────────
// 데이터는 GitHub 저장소에 있지만, 브라우저는 GitHub에 직접 가지 않고
// Cloudflare Worker(worker/worker.js)를 경유한다. GitHub 토큰은 Worker에만 있다.
const CONFIG = {
  workerUrl: "https://ediya-ledger.gmldyd031.workers.dev",
  branch: "main",
  path: "data.json",
  backupDir: "backups", // 백업 파일을 모아두는 폴더 (원본과 구분)
  archiveDir: "archives", // 이월 정리된 과거 로그를 보관하는 폴더
};
const PIN_KEY = "ediya-ledger-pin";
const PIN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 저장된 PIN 유효기간 (7일)
const API_BASE = CONFIG.workerUrl;
const API_URL = `${API_BASE}/contents/${CONFIG.path}`;
const BACKUP_NAME_RE = /^data_\d{4}-\d{2}-\d{2}\.json$/;
const ARCHIVE_NAME_RE = /^logs_\d{4}-\d{2}-\d{2}_\d{4}\.json$/;

const HISTORY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>';

// PIN은 저장 시각과 함께 보관하고, 유효기간이 지나면 자동 삭제
let pinExpired = false;

function loadSavedPin() {
  localStorage.removeItem("ediya-ledger-token"); // 예전 GitHub 토큰 저장분 정리
  const raw = localStorage.getItem(PIN_KEY);
  if (!raw) return "";
  try {
    const saved = JSON.parse(raw);
    if (!saved.value || Date.now() - saved.savedAt > PIN_TTL_MS) {
      localStorage.removeItem(PIN_KEY);
      pinExpired = !!saved.value;
      return "";
    }
    return saved.value;
  } catch {
    localStorage.removeItem(PIN_KEY);
    return "";
  }
}

function savePin(value) {
  localStorage.setItem(PIN_KEY, JSON.stringify({ value, savedAt: Date.now() }));
}

let pin = loadSavedPin();
let ledger = null;
let fileSha = null; // 저장 시 충돌 감지에 쓰는 GitHub contents sha
let currentCustomerId = null;
let editingLogId = null;
let entryType = "deduct"; // 상세 화면 신규 기록의 종류 (deduct | charge)
let sortKey = null; // 목록 정렬 기준 (name | balance), null이면 장부 순서 그대로
let sortDir = 1; // 1 오름차순, -1 내림차순

const $ = (id) => document.getElementById(id);
const won = (n) => Number(n || 0).toLocaleString("ko-KR") + "원";

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = String(text ?? "");
  return div.innerHTML;
}

function uid(prefix) {
  // crypto.randomUUID는 구형 iOS 사파리(15.4 미만)에 없음
  const rand = crypto.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(16).slice(2, 10);
  return prefix + "-" + rand;
}

function nowStamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function parseAmount(text) {
  return Number(String(text).replace(/[^\d]/g, ""));
}

// ── 잔액 계산: 잔액은 저장하지 않고 항상 로그에서 파생 ──────
function findCustomer(id) {
  return (ledger?.customers || []).find((c) => String(c.id) === String(id));
}

// 삭제는 소프트 삭제: deleted 플래그만 세우고 로그는 보존
function activeCustomers() {
  return (ledger?.customers || []).filter((c) => !c.deleted);
}

function deletedCustomers() {
  return (ledger?.customers || []).filter((c) => c.deleted);
}

function sortedLogs(customer) {
  return [...(customer.logs || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function signedAmount(log) {
  return (log.type === "charge" ? 1 : -1) * Number(log.amount || 0);
}

function balanceOf(customer) {
  return (customer.logs || []).reduce((sum, log) => sum + signedAmount(log), 0);
}

// 로그 id → 그 시점의 잔액
function balanceTimeline(customer) {
  const map = new Map();
  let balance = 0;
  for (const log of sortedLogs(customer)) {
    balance += signedAmount(log);
    map.set(log.id, balance);
  }
  return map;
}

// 시간순으로 훑어 잔액이 음수가 되는 시점이 있는지 검사
function wouldGoNegative(customer) {
  let balance = 0;
  for (const log of sortedLogs(customer)) {
    balance += signedAmount(log);
    if (balance < 0) return true;
  }
  return false;
}

// ── GitHub API ──────────────────────────────────────────────
function apiHeaders() {
  return { "X-Store-Pin": pin };
}

function decodeContent(base64) {
  const bin = atob(base64.replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function encodeContent(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function loadLedger() {
  const res = await fetch(`${API_URL}?ref=${CONFIG.branch}`, {
    headers: apiHeaders(),
    cache: "no-store",
  });
  if (!res.ok) {
    const messages = {
      401: "PIN이 올바르지 않습니다.",
      403: "허용되지 않은 요청입니다. 관리자에게 문의해주세요.",
      404: "장부 데이터를 찾을 수 없습니다. 관리자에게 문의해주세요.",
    };
    const err = new Error(messages[res.status] || `서버 응답 오류 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const parsed = JSON.parse(decodeContent(data.content));
  if (!Array.isArray(parsed.customers)) throw new Error("장부 형식이 올바르지 않습니다.");
  ledger = parsed;
  fileSha = data.sha;
}

async function saveLedger(message) {
  setSaveStatus("saving");
  const res = await fetch(API_URL, {
    method: "PUT",
    headers: apiHeaders(),
    body: JSON.stringify({
      message,
      branch: CONFIG.branch,
      sha: fileSha,
      content: encodeContent(JSON.stringify(ledger, null, 2)),
    }),
  });
  if (res.status === 409) {
    setSaveStatus("error");
    const err = new Error("conflict");
    err.conflict = true;
    throw err;
  }
  if (!res.ok) {
    setSaveStatus("error");
    throw new Error(`저장 실패 (${res.status})`);
  }
  fileSha = (await res.json()).content.sha;
  setSaveStatus("saved");
}

async function reloadLedger() {
  try {
    await loadLedger();
    render();
  } catch (err) {
    alert("장부를 다시 불러오지 못했습니다. 페이지를 새로고침해주세요.");
  }
}

// 헤더의 갱신 버튼: 다른 기기에서 수정된 내용을 수동으로 반영
async function handleRefresh() {
  const btn = $("refreshBtn");
  btn.disabled = true;
  setSaveStatus("saving", "갱신 중…");
  try {
    await loadLedger();
    render();
    setSaveStatus("saved", `갱신됨 ${new Date().toTimeString().slice(0, 5)}`);
  } catch (err) {
    setSaveStatus("error", "갱신 실패");
  } finally {
    btn.disabled = false;
  }
}

// ── 화면 전환 / 상태 표시 ───────────────────────────────────
function showScreen(name) {
  $("gateView").classList.toggle("hidden", name !== "gate");
  $("loadingView").classList.toggle("hidden", name !== "loading");
  $("appView").classList.toggle("hidden", name !== "app");
  if (name === "gate") $("pinInput").focus();
}

function setSaveStatus(state, label) {
  const pill = $("saveStatus");
  pill.className = "status-pill";
  const time = new Date().toTimeString().slice(0, 5);
  if (state === "saving") {
    pill.classList.add("is-saving");
    pill.textContent = label || "저장 중…";
  } else if (state === "saved") {
    pill.classList.add("is-saved");
    pill.textContent = label || `저장됨 ${time}`;
  } else if (state === "error") {
    pill.classList.add("is-error");
    pill.textContent = label || "저장 실패";
  } else {
    pill.classList.add("is-saved");
    pill.textContent = "최신 상태";
  }
}

// ── 모달 공통 ───────────────────────────────────────────────
const MODAL_IDS = ["logModal", "backupModal", "archiveModal", "customerModal"];

function openModal(id) {
  $(id).classList.remove("hidden");
  document.body.classList.add("modal-open");
}

function closeModal(id) {
  $(id).classList.add("hidden");
  const anyOpen = MODAL_IDS.some((m) => !$(m).classList.contains("hidden"));
  if (!anyOpen) document.body.classList.remove("modal-open");
}

function closeAllModals() {
  MODAL_IDS.forEach(closeModal);
}

// ── 라우팅: #/ 목록, #/c/{id} 상세, #/c/{id}/edit/{logId} 수정,
//            #/deleted 삭제된 고객 ─────────────────────────────
function parseHash() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "deleted") return { view: "deleted" };
  if (parts[0] === "c" && parts[1]) {
    if (parts[2] === "edit" && parts[3]) return { view: "edit", customerId: parts[1], logId: parts[3] };
    return { view: "detail", customerId: parts[1] };
  }
  return { view: "list" };
}

function render() {
  if (!ledger) return;
  closeAllModals();

  const route = parseHash();
  const show = (name) => {
    $("listView").classList.toggle("hidden", name !== "list");
    $("detailView").classList.toggle("hidden", name !== "detail");
    $("deletedView").classList.toggle("hidden", name !== "deleted");
  };

  if (route.view === "list") {
    show("list");
    renderList();
    return;
  }
  if (route.view === "deleted") {
    show("deleted");
    renderDeleted();
    return;
  }

  const customer = findCustomer(route.customerId);
  const log = route.view === "edit"
    ? (customer?.logs || []).find((l) => l.id === route.logId)
    : null;
  if (!customer || customer.deleted || (route.view === "edit" && !log)) {
    location.hash = "#/";
    return;
  }

  show("detail");
  renderDetail(customer, log);
}

// ── 목록 ────────────────────────────────────────────────────
function updateSortMarks() {
  document.querySelectorAll("th.sortable").forEach((th) => {
    th.querySelector(".sort-mark").textContent =
      th.dataset.sort === sortKey ? (sortDir === 1 ? "▲" : "▼") : "";
  });
}

function renderList() {
  const customers = activeCustomers();
  $("customerCount").textContent = `고객 ${customers.length}명`;

  const deletedTotal = deletedCustomers().length;
  $("deletedLink").classList.toggle("hidden", deletedTotal === 0);
  $("deletedLink").textContent = `삭제된 고객 ${deletedTotal}명 보기`;
  const total = customers.reduce((sum, c) => sum + balanceOf(c), 0);
  $("totalBalance").innerHTML = `잔액 합계 <strong>${won(total)}</strong>`;

  const tbody = $("customerRows");
  const keyword = $("searchInput").value.trim().toLowerCase();
  const visible = customers.filter((c) =>
    String(c.name || "").toLowerCase().includes(keyword)
  );

  if (sortKey === "name") {
    visible.sort((a, b) => sortDir * String(a.name || "").localeCompare(String(b.name || ""), "ko"));
  } else if (sortKey === "balance") {
    visible.sort((a, b) => sortDir * (balanceOf(a) - balanceOf(b)));
  }
  updateSortMarks();

  if (visible.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="empty">${
      customers.length ? "검색 결과가 없습니다." : "고객 데이터가 없습니다."
    }</td></tr>`;
    return;
  }

  tbody.innerHTML = visible.map((c) => {
    const balance = balanceOf(c);
    return `
      <tr class="customer-row" data-id="${escapeHtml(c.id)}">
        <td><span class="name">${escapeHtml(c.name)}</span></td>
        <td class="money${balance <= 0 ? " zero" : ""}">${won(balance)}</td>
        <td class="log-cell">
          <button class="icon-btn log-btn" data-id="${escapeHtml(c.id)}" title="사용 내역">${HISTORY_ICON}</button>
        </td>
      </tr>`;
  }).join("");

  tbody.querySelectorAll(".customer-row").forEach((tr) => {
    tr.addEventListener("click", () => { location.hash = `#/c/${tr.dataset.id}`; });
  });
  tbody.querySelectorAll(".log-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openLogModal(btn.dataset.id);
    });
  });
}

// ── 삭제된 고객 ─────────────────────────────────────────────
function renderDeleted() {
  const customers = deletedCustomers();
  $("deletedCount").textContent = `삭제된 고객 ${customers.length}명`;

  const tbody = $("deletedRows");
  if (customers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">삭제된 고객이 없습니다.</td></tr>';
    return;
  }

  tbody.innerHTML = customers.map((c) => {
    const balance = balanceOf(c);
    return `
      <tr>
        <td>
          <span class="name">${escapeHtml(c.name)}</span>
          <div class="deleted-at">${escapeHtml(c.deletedAt || "")} 삭제</div>
        </td>
        <td class="money${balance <= 0 ? " zero" : ""}">${won(balance)}</td>
        <td class="log-cell">
          <button class="icon-btn log-btn" data-id="${escapeHtml(c.id)}" title="사용 내역">${HISTORY_ICON}</button>
        </td>
        <td class="log-cell">
          <button class="restore-btn" data-id="${escapeHtml(c.id)}">복구</button>
        </td>
      </tr>`;
  }).join("");

  tbody.querySelectorAll(".log-btn").forEach((btn) => {
    btn.addEventListener("click", () => openLogModal(btn.dataset.id));
  });
  tbody.querySelectorAll(".restore-btn").forEach((btn) => {
    btn.addEventListener("click", () => restoreCustomer(btn));
  });
}

async function deleteCustomer() {
  const customer = findCustomer(currentCustomerId);
  if (!customer) return;

  const balance = balanceOf(customer);
  const question = balance > 0
    ? `"${customer.name}" 고객의 잔액이 ${won(balance)} 남아 있습니다.\n그래도 삭제할까요? (삭제된 고객 목록에서 복구할 수 있습니다)`
    : `"${customer.name}" 고객을 삭제할까요?\n삭제된 고객 목록에서 복구할 수 있습니다.`;
  if (!confirm(question)) return;

  customer.deleted = true;
  customer.deletedAt = nowStamp();
  const rollback = () => { delete customer.deleted; delete customer.deletedAt; };

  const btn = $("deleteCustomerBtn");
  btn.disabled = true;
  try {
    await saveLedger(`고객 삭제: ${customer.name}`);
    location.hash = "#/";
  } catch (err) {
    rollback();
    if (err.conflict) {
      alert("다른 기기에서 장부가 먼저 수정되었습니다. 최신 장부를 다시 불러옵니다.");
      await reloadLedger();
    } else {
      alert("삭제에 실패했습니다. 네트워크 확인 후 다시 시도해주세요.");
    }
  } finally {
    btn.disabled = false;
  }
}

async function restoreCustomer(btn) {
  const customer = findCustomer(btn.dataset.id);
  if (!customer) return;
  if (!confirm(`"${customer.name}" 고객을 복구할까요?`)) return;

  const deletedAt = customer.deletedAt;
  delete customer.deleted;
  delete customer.deletedAt;
  const rollback = () => { customer.deleted = true; customer.deletedAt = deletedAt; };

  btn.disabled = true;
  try {
    await saveLedger(`고객 복구: ${customer.name}`);
    renderDeleted();
  } catch (err) {
    rollback();
    btn.disabled = false;
    if (err.conflict) {
      alert("다른 기기에서 장부가 먼저 수정되었습니다. 최신 장부를 다시 불러옵니다.");
      await reloadLedger();
    } else {
      alert("복구에 실패했습니다. 네트워크 확인 후 다시 시도해주세요.");
    }
  }
}

// ── 상세 (신규 차감·충전 / 로그 수정 겸용) ──────────────────
function renderDetail(customer, log) {
  currentCustomerId = customer.id;
  editingLogId = log ? log.id : null;

  $("detailName").textContent = customer.name;
  $("detailBalance").textContent = won(balanceOf(customer));
  $("formError").textContent = "";
  $("editBadge").classList.toggle("hidden", !log);
  $("cancelEditBtn").classList.toggle("hidden", !log);
  $("editInfo").classList.toggle("hidden", !log);
  $("typeToggle").classList.toggle("hidden", !!log); // 수정 시엔 종류 변경 불가
  $("deleteCustomerBtn").classList.toggle("hidden", !!log);

  if (log) {
    $("editInfo").textContent =
      `${log.date} · ${log.type === "charge" ? "충전" : "차감"} 기록을 수정하고 있습니다.`;
    $("orderLabel").textContent = log.type === "charge" ? "충전 내용" : "주문 내용";
    $("orderInput").value = log.order || "";
    $("amountInput").value = Number(log.amount || 0).toLocaleString("ko-KR");
  } else {
    $("orderInput").value = "";
    $("amountInput").value = "";
    setEntryType("deduct");
  }
  $("submitBtn").textContent = submitLabel();
}

function submitLabel() {
  if (editingLogId) return "수정 저장";
  return entryType === "charge" ? "충전하고 저장" : "차감하고 저장";
}

function setEntryType(type) {
  entryType = type;
  $("typeToggle").querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.type === type);
  });
  const isCharge = type === "charge";
  $("orderLabel").textContent = isCharge ? "충전 내용" : "주문 내용";
  $("orderInput").placeholder = isCharge ? "예: 5만원 선결제 충전" : "예: 아이스 아메리카노 2잔";
  $("submitBtn").textContent = submitLabel();
}

function setSubmitting(on) {
  const btn = $("submitBtn");
  btn.disabled = on;
  btn.textContent = on ? "저장 중…" : submitLabel();
}

async function handleDetailSubmit(e) {
  e.preventDefault();
  const customer = findCustomer(currentCustomerId);
  if (!customer) return;

  const showError = (msg) => { $("formError").textContent = msg; };
  const order = $("orderInput").value.trim();
  const amount = parseAmount($("amountInput").value);
  if (!order) return showError(entryType === "charge" && !editingLogId
    ? "충전 내용을 입력해주세요."
    : "주문 내용을 입력해주세요.");
  if (!Number.isFinite(amount) || amount <= 0) return showError("금액을 올바르게 입력해주세요.");

  customer.logs = Array.isArray(customer.logs) ? customer.logs : [];

  let rollback, message;
  if (editingLogId) {
    const log = customer.logs.find((l) => l.id === editingLogId);
    if (!log) return;
    const before = { order: log.order, amount: log.amount };
    log.order = order;
    log.amount = amount;
    rollback = () => Object.assign(log, before);
    message = `${customer.name} 기록 수정: ${order} ${won(amount)}`;
  } else {
    customer.logs.push({ id: uid("l"), type: entryType, date: nowStamp(), order, amount });
    rollback = () => customer.logs.pop();
    message = entryType === "charge"
      ? `${customer.name} ${won(amount)} 충전: ${order}`
      : `${customer.name} ${won(amount)} 차감: ${order}`;
  }

  if (wouldGoNegative(customer)) {
    rollback();
    return showError(editingLogId
      ? "이 금액으로 수정하면 잔액이 음수가 되는 시점이 생깁니다."
      : `잔액(${won(balanceOf(customer))})보다 큰 금액은 차감할 수 없습니다.`);
  }

  setSubmitting(true);
  try {
    await saveLedger(message);
    location.hash = "#/";
  } catch (err) {
    rollback();
    if (err.conflict) {
      alert("다른 기기에서 장부가 먼저 수정되었습니다. 최신 장부를 다시 불러옵니다.");
      await reloadLedger();
    } else {
      showError("저장에 실패했습니다. 네트워크 확인 후 다시 시도해주세요.");
    }
  } finally {
    setSubmitting(false);
  }
}

// ── 고객 등록 ───────────────────────────────────────────────
function openCustomerModal() {
  $("customerForm").reset();
  $("customerError").textContent = "";
  openModal("customerModal");
  $("customerNameInput").focus();
}

async function handleCustomerSubmit(e) {
  e.preventDefault();
  const showError = (msg) => { $("customerError").textContent = msg; };
  const name = $("customerNameInput").value.trim();
  const amount = parseAmount($("customerAmountInput").value);
  if (!name) return showError("고객 이름을 입력해주세요.");
  if (!Number.isFinite(amount) || amount <= 0) return showError("충전 금액을 올바르게 입력해주세요.");

  const duplicated = (ledger.customers || []).some((c) => c.name === name);
  if (duplicated && !confirm(`"${name}" 고객이 이미 있습니다. 같은 이름으로 등록할까요?`)) return;

  const customer = {
    id: uid("c"),
    name,
    logs: [{ id: uid("l"), type: "charge", date: nowStamp(), order: "선결제 충전", amount }],
  };
  ledger.customers = Array.isArray(ledger.customers) ? ledger.customers : [];
  ledger.customers.push(customer);

  const btn = $("customerSubmitBtn");
  btn.disabled = true;
  btn.textContent = "저장 중…";
  try {
    await saveLedger(`고객 등록: ${name} (${won(amount)} 충전)`);
    closeModal("customerModal");
    render();
  } catch (err) {
    ledger.customers.pop();
    if (err.conflict) {
      alert("다른 기기에서 장부가 먼저 수정되었습니다. 최신 장부를 다시 불러옵니다.");
      closeModal("customerModal");
      await reloadLedger();
    } else {
      showError("저장에 실패했습니다. 네트워크 확인 후 다시 시도해주세요.");
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "등록";
  }
}

// ── 백업·아카이브: 생성 / 이월 / 목록 / CSV 다운로드 ────────
// 현재 장부를 지정 경로에 커밋 (이미 있으면 덮어씀)
async function commitLedgerFile(path, message) {
  const url = `${API_BASE}/contents/${path}`;
  // 이미 있는 파일이면 sha가 필요하므로 먼저 조회
  const existing = await fetch(`${url}?ref=${CONFIG.branch}`, {
    headers: apiHeaders(),
    cache: "no-store",
  });
  const sha = existing.ok ? (await existing.json()).sha : undefined;

  const res = await fetch(url, {
    method: "PUT",
    headers: apiHeaders(),
    body: JSON.stringify({
      message,
      branch: CONFIG.branch,
      content: encodeContent(JSON.stringify(ledger, null, 2)),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) throw new Error(`커밋 실패 (${res.status})`);
}

async function createBackup() {
  if (!ledger) return;
  const backupPath = `${CONFIG.backupDir}/data_${nowStamp().slice(0, 10)}.json`;
  if (!confirm(`현재 장부를 ${backupPath} 파일로 백업할까요?\n오늘 백업한 파일이 이미 있으면 덮어씁니다.`)) return;

  setSaveStatus("saving", "백업 중…");
  try {
    await commitLedgerFile(backupPath, `장부 백업 (${backupPath})`);
    setSaveStatus("saved", `백업 완료 ${new Date().toTimeString().slice(0, 5)}`);
    // 백업 목록 팝업이 열려 있을 때만 목록 갱신 (불필요한 조회 방지)
    if (!$("backupModal").classList.contains("hidden")) renderBackupList();
  } catch (err) {
    setSaveStatus("error", "백업 실패");
    alert("백업에 실패했습니다. 네트워크와 PIN을 확인해주세요.");
  }
}

// 로그 이월 정리: 현재 로그 전체를 아카이브 파일로 보관한 뒤,
// 각 고객의 로그를 "이월 잔액" 충전 1건으로 압축해 data.json을 작게 유지
async function archiveLogs() {
  if (!ledger) return;
  const stampStr = nowStamp();
  const archiveName = `logs_${stampStr.slice(0, 10)}_${stampStr.slice(11).replace(":", "")}.json`;
  const archivePath = `${CONFIG.archiveDir}/${archiveName}`;
  const logCount = (ledger.customers || []).reduce((sum, c) => sum + (c.logs || []).length, 0);

  if (!confirm(
    `로그 이월 정리를 실행할까요?\n\n` +
    `· 현재 로그 ${logCount}건을 ${archivePath}에 보관합니다.\n` +
    `· 각 고객의 로그는 "이월 잔액" 1건으로 압축됩니다.\n` +
    `· 잔액은 그대로 유지되며, 과거 내역은 아카이브 목록에서 볼 수 있습니다.`
  )) return;

  setSaveStatus("saving", "이월 정리 중…");
  try {
    // 아카이브 저장이 성공한 뒤에만 원본을 압축 (중간 실패 시 데이터 손실 없음)
    await commitLedgerFile(archivePath, `로그 아카이브 (${archiveName})`);
  } catch (err) {
    setSaveStatus("error", "이월 실패");
    alert("아카이브 저장에 실패했습니다. 네트워크와 PIN을 확인해주세요.");
    return;
  }

  const before = ledger.customers;
  ledger.customers = before.map((c) => {
    const balance = balanceOf(c);
    return {
      ...c,
      logs: balance > 0
        ? [{ id: uid("l"), type: "charge", date: stampStr, order: "이월 잔액", amount: balance }]
        : [],
    };
  });

  try {
    await saveLedger(`로그 이월 정리 (${archiveName})`);
    render();
    alert(`이월 정리가 완료되었습니다.\n과거 로그는 아카이브 목록의 ${archiveName}에서 볼 수 있습니다.`);
  } catch (err) {
    ledger.customers = before;
    if (err.conflict) {
      alert("다른 기기에서 장부가 먼저 수정되었습니다. 최신 장부를 다시 불러온 뒤 이월을 다시 실행해주세요.");
      await reloadLedger();
    } else {
      alert("이월 저장에 실패했습니다. 장부는 변경되지 않았으니 다시 시도해주세요.");
    }
  }
}

function openBackupModal() {
  openModal("backupModal");
  renderBackupList();
}

// 파일별 최근 커밋 시각 조회 (실패해도 목록은 그대로 노출)
async function fetchFileTime(path) {
  try {
    const res = await fetch(
      `${API_BASE}/commits?path=${encodeURIComponent(path)}&sha=${CONFIG.branch}&per_page=1`,
      { headers: apiHeaders(), cache: "no-store" }
    );
    if (!res.ok) return null;
    const [commit] = await res.json();
    return commit ? new Date(commit.commit.committer.date) : null;
  } catch {
    return null;
  }
}

function formatTime(date) {
  if (!date) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())} 저장`;
}

// 폴더 안의 장부 JSON 파일들을 커밋 시각과 함께 표시 (백업/아카이브 공용)
async function renderFileList(dir, nameRe, container, emptyMsg) {
  container.innerHTML = '<div class="empty">목록을 불러오는 중…</div>';

  try {
    const res = await fetch(`${API_BASE}/contents/${dir}?ref=${CONFIG.branch}`, {
      headers: apiHeaders(),
      cache: "no-store",
    });
    // 폴더는 첫 파일 커밋 때 만들어지므로, 없으면(404) 빈 목록으로 처리
    if (res.status === 404) {
      container.innerHTML = `<div class="empty">${emptyMsg}</div>`;
      return;
    }
    if (!res.ok) throw new Error();
    const files = (await res.json())
      .filter((f) => f.type === "file" && nameRe.test(f.name))
      .sort((a, b) => b.name.localeCompare(a.name)); // 최신 날짜 먼저

    if (files.length === 0) {
      container.innerHTML = `<div class="empty">${emptyMsg}</div>`;
      return;
    }

    const times = await Promise.all(files.map((f) => fetchFileTime(`${dir}/${f.name}`)));
    container.innerHTML = files.map((f, i) => `
      <div class="backup-row">
        <div>
          <div class="backup-name">${escapeHtml(f.name)}</div>
          <div class="backup-time">${escapeHtml(formatTime(times[i]))}</div>
        </div>
        <button class="csv-btn" data-dir="${escapeHtml(dir)}" data-name="${escapeHtml(f.name)}">CSV 다운로드</button>
      </div>`).join("");

    container.querySelectorAll(".csv-btn").forEach((btn) => {
      btn.addEventListener("click", () => downloadFileCsv(btn));
    });
  } catch {
    container.innerHTML = '<div class="empty">목록을 불러오지 못했습니다.</div>';
  }
}

function renderBackupList() {
  renderFileList(CONFIG.backupDir, BACKUP_NAME_RE, $("backupContent"), "아직 백업 파일이 없습니다.");
}

function renderArchiveList() {
  renderFileList(CONFIG.archiveDir, ARCHIVE_NAME_RE, $("archiveContent"), "아직 아카이브 파일이 없습니다.");
}

async function downloadFileCsv(btn) {
  const { dir, name } = btn.dataset;
  btn.disabled = true;
  btn.textContent = "변환 중…";
  try {
    const res = await fetch(`${API_BASE}/contents/${dir}/${name}?ref=${CONFIG.branch}`, {
      headers: apiHeaders(),
      cache: "no-store",
    });
    if (!res.ok) throw new Error();
    const data = JSON.parse(decodeContent((await res.json()).content));
    downloadText(ledgerToCsv(data), name.replace(/\.json$/, ".csv"));
  } catch {
    alert("파일을 내려받지 못했습니다. 잠시 후 다시 시도해주세요.");
  } finally {
    btn.disabled = false;
    btn.textContent = "CSV 다운로드";
  }
}

// 장부 → CSV. 잔액은 로그 시간순 누적값 (엑셀 한글 호환을 위해 UTF-8 BOM 포함)
function ledgerToCsv(ledgerObj) {
  const BOM = String.fromCharCode(0xFEFF);
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["고객명", "날짜", "구분", "내용", "금액", "잔액"]];
  for (const customer of ledgerObj.customers || []) {
    let balance = 0;
    for (const log of sortedLogs(customer)) {
      balance += signedAmount(log);
      rows.push([
        customer.name,
        log.date,
        log.type === "charge" ? "충전" : "차감",
        log.order,
        signedAmount(log),
        balance,
      ]);
    }
  }
  return BOM + rows.map((r) => r.map(cell).join(",")).join("\r\n");
}

function downloadText(text, filename) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  // 사파리에서 즉시 해제하면 다운로드가 취소될 수 있어 지연 해제
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ── 로그 팝업 ───────────────────────────────────────────────
function openLogModal(customerId) {
  const customer = findCustomer(customerId);
  if (!customer) return;

  $("logTitle").textContent = `${customer.name} 사용 내역`;
  const logs = sortedLogs(customer);

  // 삭제된 고객의 로그는 조회만 가능 (수정 진입 차단)
  const readOnly = !!customer.deleted;

  if (logs.length === 0) {
    $("logContent").innerHTML = '<div class="empty">아직 기록이 없습니다.</div>';
  } else {
    const timeline = balanceTimeline(customer);
    const rows = [...logs].reverse().map((log) => {
      const isCharge = log.type === "charge";
      return `
        <div class="log-row${readOnly ? " readonly" : ""}" data-log-id="${escapeHtml(log.id)}">
          <span class="log-order">${escapeHtml(log.order)}</span>
          <span class="log-amt ${isCharge ? "amt-charge" : "amt-deduct"}">${isCharge ? "+" : "−"}${won(log.amount)}</span>
          <span class="log-date">${escapeHtml(log.date)}</span>
          <span class="log-bal">잔액 ${won(timeline.get(log.id))}</span>
        </div>`;
    }).join("");
    $("logContent").innerHTML = readOnly
      ? rows
      : `<p class="modal-hint">기록을 누르면 내용을 수정할 수 있어요.</p>${rows}`;

    if (!readOnly) {
      $("logContent").querySelectorAll(".log-row").forEach((row) => {
        row.addEventListener("click", () => {
          const logId = row.dataset.logId;
          closeModal("logModal");
          location.hash = `#/c/${customerId}/edit/${logId}`;
        });
      });
    }
  }

  openModal("logModal");
}

// ── 토큰 게이트 / 시작 ──────────────────────────────────────
async function handleGateSubmit(e) {
  e.preventDefault();
  const value = $("pinInput").value.trim();
  if (!value) return;

  pin = value;
  const btn = $("gateBtn");
  btn.disabled = true;
  btn.textContent = "확인 중…";
  $("gateError").textContent = "";

  try {
    await loadLedger();
    savePin(pin);
    $("pinInput").value = "";
    $("saveStatus").classList.remove("hidden");
    setSaveStatus("synced");
    showScreen("app");
    render();
  } catch (err) {
    pin = "";
    $("gateError").textContent = err.message || "장부를 불러오지 못했습니다.";
  } finally {
    btn.disabled = false;
    btn.textContent = "로그인";
  }
}

function logout() {
  if (!confirm("로그아웃할까요? 다시 이용하려면 PIN을 입력해야 합니다.")) return;
  localStorage.removeItem(PIN_KEY);
  pin = "";
  ledger = null;
  fileSha = null;
  location.hash = "#/";
  showScreen("gate");
}

async function init() {
  if (!pin) {
    showScreen("gate");
    if (pinExpired) {
      $("gateError").textContent = "보안을 위해 저장된 PIN이 만료되었습니다. 다시 입력해주세요.";
    }
    return;
  }
  showScreen("loading");
  try {
    await loadLedger();
    $("saveStatus").classList.remove("hidden");
    setSaveStatus("synced");
    showScreen("app");
    render();
  } catch (err) {
    showScreen("gate");
    $("gateError").textContent = err.status === 401
      ? "저장된 PIN이 올바르지 않습니다. 다시 입력해주세요."
      : (err.message || "장부를 불러오지 못했습니다.");
  }
}

// ── 이벤트 연결 ─────────────────────────────────────────────
$("gateForm").addEventListener("submit", handleGateSubmit);
$("refreshBtn").addEventListener("click", handleRefresh);
$("logoutBtn").addEventListener("click", logout);
$("searchInput").addEventListener("input", renderList);
document.querySelectorAll("th.sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (sortKey === key) {
      sortDir = -sortDir;
    } else {
      sortKey = key;
      sortDir = key === "balance" ? -1 : 1; // 잔액은 많은 순이 먼저 보이도록
    }
    renderList();
  });
});
$("backBtn").addEventListener("click", () => { location.hash = "#/"; });
$("cancelEditBtn").addEventListener("click", () => { location.hash = "#/"; });
$("deleteCustomerBtn").addEventListener("click", deleteCustomer);
$("deletedLink").addEventListener("click", () => { location.hash = "#/deleted"; });
$("deletedBackBtn").addEventListener("click", () => { location.hash = "#/"; });
$("detailForm").addEventListener("submit", handleDetailSubmit);
$("typeToggle").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-type]");
  if (btn) setEntryType(btn.dataset.type);
});

$("addCustomerBtn").addEventListener("click", openCustomerModal);
$("customerForm").addEventListener("submit", handleCustomerSubmit);
$("closeCustomerBtn").addEventListener("click", () => closeModal("customerModal"));

// 백업 드롭다운: 생성은 목록 조회 없이 바로 실행
$("backupBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("backupMenu").classList.toggle("hidden");
});
$("menuCreateBackup").addEventListener("click", () => {
  $("backupMenu").classList.add("hidden");
  createBackup();
});
$("menuBackupList").addEventListener("click", () => {
  $("backupMenu").classList.add("hidden");
  openBackupModal();
});
$("menuArchive").addEventListener("click", () => {
  $("backupMenu").classList.add("hidden");
  archiveLogs();
});
$("menuArchiveList").addEventListener("click", () => {
  $("backupMenu").classList.add("hidden");
  openModal("archiveModal");
  renderArchiveList();
});
document.addEventListener("click", () => $("backupMenu").classList.add("hidden"));

$("closeBackupBtn").addEventListener("click", () => closeModal("backupModal"));
$("closeArchiveBtn").addEventListener("click", () => closeModal("archiveModal"));
$("closeLogBtn").addEventListener("click", () => closeModal("logModal"));

MODAL_IDS.forEach((id) => {
  $(id).addEventListener("click", (e) => {
    if (e.target === $(id)) closeModal(id);
  });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeAllModals();
    $("backupMenu").classList.add("hidden");
  }
});

const formatAmountInput = (input) => {
  const digits = input.value.replace(/[^\d]/g, "");
  input.value = digits ? Number(digits).toLocaleString("ko-KR") : "";
};
$("amountInput").addEventListener("input", () => formatAmountInput($("amountInput")));
$("customerAmountInput").addEventListener("input", () => formatAmountInput($("customerAmountInput")));

window.addEventListener("hashchange", render);

init();
