const $ = (id) => document.getElementById(id);
let mode = "login";
let currentUser = null;

function formatCredits(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function showMessage(id, message, type = "") {
  const element = $(id);
  element.textContent = message || "";
  element.className = "message " + type;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

function setMode(nextMode) {
  mode = nextMode;
  document.querySelectorAll(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.tab === mode));
  $("auth-submit").innerHTML = mode === "login" ? 'Sign in <span>→</span>' : 'Create account <span>→</span>';
  $("password").autocomplete = mode === "login" ? "current-password" : "new-password";
  showMessage("auth-message", "");
}

document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => setMode(tab.dataset.tab)));

$("auth-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("auth-submit");
  button.disabled = true;
  showMessage("auth-message", "Please wait…");
  try {
    const data = await api("/api/" + (mode === "login" ? "login" : "register"), {
      method: "POST",
      body: JSON.stringify({ username: $("username").value, password: $("password").value })
    });
    currentUser = data.user;
    await loadDashboard();
  } catch (error) {
    showMessage("auth-message", error.message, "error");
  } finally {
    button.disabled = false;
  }
});

async function loadDashboard() {
  const data = await api("/api/me");
  currentUser = data.user;
  $("auth-view").classList.add("hidden");
  $("dashboard-view").classList.remove("hidden");
  $("top-actions").innerHTML = '<span id="nav-user"></span><button id="logout-button" class="secondary-button">Sign out</button>';
  $("nav-user").textContent = currentUser.username;
  $("logout-button").addEventListener("click", logout);
  $("welcome-name").textContent = currentUser.username;
  $("role-pill").textContent = currentUser.role.toUpperCase();
  $("admin-panel").classList.toggle("hidden", currentUser.role !== "admin");
  renderBalance(currentUser);
  await loadTransactions();
  if (currentUser.role === "admin") await loadAdmin();
}

function renderBalance(user) {
  $("balance").textContent = formatCredits(user.balance);
  const countdown = new Date(user.next_bonus_at).getTime() - Date.now();
  if (user.role === "admin") {
    $("bonus-countdown").textContent = "Admin account · no player bonus";
  } else if (countdown <= 0) {
    $("bonus-countdown").textContent = "Your next reward is ready";
  } else {
    const hours = Math.floor(countdown / 3600000);
    const minutes = Math.floor((countdown % 3600000) / 60000);
    $("bonus-countdown").textContent = "Next +500,000 in " + hours + "h " + minutes + "m";
  }
}

async function refreshBalance() {
  const data = await api("/api/me");
  currentUser = data.user;
  renderBalance(currentUser);
}

async function loadTransactions() {
  const data = await api("/api/transactions");
  const container = $("transactions");
  if (!data.transactions.length) {
    container.innerHTML = '<div class="empty-state">No transactions yet. Your account activity will appear here.</div>';
    return;
  }
  container.innerHTML = data.transactions.map(item => {
    const amount = Number(item.amount);
    const date = new Date(item.created_at).toLocaleString();
    return '<div class="transaction"><div><div class="transaction-title">' + escapeHtml(item.description) + '</div><div class="transaction-date">' + escapeHtml(date) + '</div></div><div class="transaction-type">' + escapeHtml(item.type.replaceAll("_", " ")) + '</div><div class="transaction-amount ' + (amount < 0 ? "negative" : "") + '">' + (amount > 0 ? "+" : "") + formatCredits(amount) + '</div></div>';
  }).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

$("deposit-form").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const data = await api("/api/deposits", { method: "POST", body: JSON.stringify({ amount: $("deposit-amount").value }) });
    showMessage("deposit-message", data.message, "success");
    $("deposit-amount").value = "";
    if (currentUser.role === "admin") await loadAdmin();
  } catch (error) {
    showMessage("deposit-message", error.message, "error");
  }
});

$("withdraw-form").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const data = await api("/api/withdraw", { method: "POST", body: JSON.stringify({ amount: $("withdraw-amount").value }) });
    currentUser = data.user;
    renderBalance(currentUser);
    $("withdraw-amount").value = "";
    showMessage("withdraw-message", data.message, "success");
    await loadTransactions();
  } catch (error) {
    showMessage("withdraw-message", error.message, "error");
  }
});

$("adjust-form").addEventListener("submit", async event => {
  event.preventDefault();
  const action = event.submitter ? event.submitter.value : "add";
  try {
    await api("/api/admin/adjust", {
      method: "POST",
      body: JSON.stringify({ username: $("adjust-username").value, amount: $("adjust-amount").value, action })
    });
    showMessage("adjust-message", "Player balance updated.", "success");
    $("adjust-amount").value = "";
    await loadAdmin();
  } catch (error) {
    showMessage("adjust-message", error.message, "error");
  }
});

async function loadAdmin() {
  const [usersData, depositsData] = await Promise.all([api("/api/admin/users"), api("/api/admin/deposits")]);
  $("user-list").innerHTML = usersData.users.map(user =>
    '<div class="user-item"><span>' + escapeHtml(user.username) + '<small>' + escapeHtml(user.role) + '</small></span><strong>' + formatCredits(user.balance) + '</strong></div>'
  ).join("") || '<div class="empty-state">No accounts yet.</div>';

  const pending = depositsData.requests.filter(item => item.status === "pending");
  $("deposit-requests").innerHTML = pending.map(item =>
    '<div class="request-item"><span>' + escapeHtml(item.username) + '<small>' + formatCredits(item.amount) + ' credits</small></span><span class="mini-actions"><button data-approve="' + item.id + '">Approve</button><button class="reject" data-reject="' + item.id + '">Reject</button></span></div>'
  ).join("") || '<div class="empty-state">No pending requests.</div>';

  document.querySelectorAll("[data-approve]").forEach(button => button.addEventListener("click", () => reviewDeposit(button.dataset.approve, "approve")));
  document.querySelectorAll("[data-reject]").forEach(button => button.addEventListener("click", () => reviewDeposit(button.dataset.reject, "reject")));
}

async function reviewDeposit(id, decision) {
  try {
    await api("/api/admin/deposits/" + id + "/" + decision, { method: "POST", body: "{}" });
    await loadAdmin();
    await loadTransactions();
    await refreshBalance();
  } catch (error) {
    alert(error.message);
  }
}

async function logout() {
  try { await api("/api/logout", { method: "POST", body: "{}" }); } catch (_) {}
  currentUser = null;
  $("dashboard-view").classList.add("hidden");
  $("auth-view").classList.remove("hidden");
  $("top-actions").innerHTML = "";
  $("auth-form").reset();
  setMode("login");
}

(async function init() {
  try {
    await loadDashboard();
  } catch (_) {
    $("auth-view").classList.remove("hidden");
    $("dashboard-view").classList.add("hidden");
  }
})();