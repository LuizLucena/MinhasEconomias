/* =============================================================
   MINHAS ECONOMIAS — app.js
   Personal Finance Manager using Google Sheets as backend
============================================================= */

'use strict';

// =============================================
// CONSTANTS
// =============================================
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const MONTHS_PT = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

const APP_CONFIG = {
  clientId: '26952004489-ab704ng6jaavo3g4nphtm1d05oddjs6u.apps.googleusercontent.com',
  spreadsheetId: '1fqlpjC5rJFQwSlxjsL0nXLngBG19aK9ywkWqT_gaId4',
  tabTransactions: 'Transações',
  tabAccounts: 'Contas',
  tabCategories: 'Categorias',
};

// =============================================
// STATE
// =============================================
const today = new Date();

const state = {
  config: APP_CONFIG,
  accessToken: null,
  tokenExpiry: null,
  tokenClient: null,
  accounts: [],       // [{ name, total, status }]
  categories: [],     // [{ name, total, status }]
  transactions: [],   // all loaded transactions [{ rowIndex, date, description, value, category, account }]
  transactionsSheetId: null, // numeric sheetId for batchUpdate
  ui: {
    month: today.getMonth() + 1,  // 1-12
    year: today.getFullYear(),
    selectedAccounts: new Set(),
    showPreviousBalance: true,   // toggle para exibir saldo anterior
    accountFilterOpen: false,
  },
  pendingConfirm: null,        // fn to call on confirm
  pendingInstallmentEdit: null, // { transaction, mode: 'single'|'forward' }
  editingTransaction: null,    // transaction being edited
  editInstallmentMode: null,   // 'single' | 'forward' | null
};

// =============================================
// UTILITY: Date helpers
// =============================================
function parseDate(str) {
  // Expects DD/MM/YYYY
  if (!str) return null;
  const parts = str.split('/');
  if (parts.length !== 3) return null;
  const [d, m, y] = parts.map(Number);
  return new Date(y, m - 1, d);
}

function formatDateDisplay(str) {
  // DD/MM/YYYY → DD/MM
  if (!str || str.length < 5) return str;
  return str.substring(0, 5);
}

function formatDateInput(dateObj) {
  // Date → YYYY-MM-DD (for <input type="date">)
  const d = dateObj.getDate().toString().padStart(2, '0');
  const m = (dateObj.getMonth() + 1).toString().padStart(2, '0');
  return `${dateObj.getFullYear()}-${m}-${d}`;
}

function inputDateToSheet(inputVal) {
  // YYYY-MM-DD → DD/MM/YYYY
  if (!inputVal) return '';
  const [y, m, d] = inputVal.split('-');
  return `${d}/${m}/${y}`;
}

function addMonths(dateStr, n) {
  // DD/MM/YYYY → add n months → DD/MM/YYYY
  const d = parseDate(dateStr);
  if (!d) return dateStr;
  d.setMonth(d.getMonth() + n);
  const day = d.getDate().toString().padStart(2, '0');
  const mon = (d.getMonth() + 1).toString().padStart(2, '0');
  return `${day}/${mon}/${d.getFullYear()}`;
}

// =============================================
// UTILITY: Value helpers
// =============================================
function parseValue(val) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return val;
  const str = String(val).trim();
  const isNeg = str.includes('(') && str.includes(')');
  // Remove $, R$, spaces, parentheses
  let clean = str.replace(/[$R\s()]/g, '');
  // Remove thousand separators and fix decimal
  clean = clean.replace(/\./g, '').replace(',', '.');
  const num = parseFloat(clean);
  if (isNaN(num)) return 0;
  return isNeg ? -Math.abs(num) : num;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function isActiveStatus(value) {
  const status = normalizeText(value);
  return status === 'ativo' || status.startsWith('ativo ');
}

function formatCurrency(num) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(num);
}

function formatCurrencyShort(num) {
  const abs = Math.abs(num);
  const sign = num < 0 ? '-' : '+';
  return sign + ' ' + new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(abs);
}

// =============================================
// UTILITY: Installment helpers
// =============================================
function parseInstallment(description) {
  // "Carro (1 / 60)" → { base: 'Carro', current: 1, total: 60 }
  const match = description.match(/^(.+?)\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\)\s*$/);
  if (match) {
    return {
      base: match[1].trim(),
      current: parseInt(match[2], 10),
      total: parseInt(match[3], 10),
    };
  }
  return null;
}

function installmentDescription(base, current, total) {
  return `${base} (${current} / ${total})`;
}

// =============================================
// UTILITY: Transfer detection
// =============================================
function isTransferCategory(cat) {
  return cat && cat.toLowerCase().includes('transfer');
}

function findTransferPair(tx, allTx) {
  // Find the counterpart of a transfer row
  return allTx.find(t =>
    t.rowIndex !== tx.rowIndex &&
    isTransferCategory(t.category) &&
    t.date === tx.date &&
    t.description === tx.description &&
    tx.value * t.value < 0 &&
    t.account !== tx.account &&
    Math.abs(Math.abs(parseValue(t.value)) - Math.abs(parseValue(tx.value))) < 0.005
  );
}

// =============================================
// GOOGLE SHEETS API
// =============================================
async function apiRequest(url, options = {}) {
  const opts = {
    ...options,
    headers: {
      'Authorization': `Bearer ${state.accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  };
  const response = await fetch(url, opts);
  if (response.status === 401) {
    // Token expired
    state.accessToken = null;
    showScreen('auth');
    throw new Error('Sessão expirada. Faça login novamente.');
  }
  if (!response.ok) {
    let msg = `Erro na API (${response.status})`;
    try {
      const err = await response.json();
      msg = err.error?.message || msg;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  // 204 No Content
  if (response.status === 204) return null;
  return response.json();
}

async function sheetsGet(range) {
  const { spreadsheetId } = state.config;
  const url = `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;
  return apiRequest(url);
}

async function sheetsAppend(range, values) {
  const { spreadsheetId } = state.config;
  const url = `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  return apiRequest(url, {
    method: 'POST',
    body: JSON.stringify({ values }),
  });
}

async function sheetsUpdate(range, values) {
  const { spreadsheetId } = state.config;
  const url = `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  return apiRequest(url, {
    method: 'PUT',
    body: JSON.stringify({ values }),
  });
}

async function sheetsDeleteRows(rowIndices) {
  // rowIndices: 1-based row numbers in the spreadsheet
  if (!rowIndices || rowIndices.length === 0) return;
  const sheetId = state.transactionsSheetId;
  if (sheetId === null || sheetId === undefined) {
    throw new Error('Sheet ID não carregado. Recarregue a página.');
  }
  // Sort descending so we delete from bottom up (indices don't shift)
  const sorted = [...rowIndices].sort((a, b) => b - a);
  const requests = sorted.map(rowIdx => ({
    deleteDimension: {
      range: {
        sheetId,
        dimension: 'ROWS',
        startIndex: rowIdx - 1, // 0-based
        endIndex: rowIdx,       // exclusive
      },
    },
  }));
  const { spreadsheetId } = state.config;
  return apiRequest(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });
}

async function loadSpreadsheetMeta() {
  const { spreadsheetId, tabTransactions } = state.config;
  const url = `${SHEETS_API}/${spreadsheetId}?fields=sheets.properties`;
  const data = await apiRequest(url);
  const sheet = data.sheets.find(s => s.properties.title === tabTransactions);
  if (sheet) {
    state.transactionsSheetId = sheet.properties.sheetId;
  } else {
    // Fallback: use first sheet or gid 0
    state.transactionsSheetId = data.sheets[0]?.properties?.sheetId ?? 0;
  }
}

// =============================================
// DATA LOADING
// =============================================
async function loadAccounts() {
  const { tabAccounts } = state.config;
  const result = await sheetsGet(`${tabAccounts}!A:C`);
  const rows = (result.values || []).slice(1); // skip header
  state.accounts = rows
    .filter(r => isActiveStatus(r[2]))
    .map(r => ({
      name: (r[0] || '').trim(),
      total: parseValue(r[1]),
      status: (r[2] || '').trim(),
    }))
    .filter(a => a.name);
}

async function loadCategories() {
  const { tabCategories } = state.config;
  const result = await sheetsGet(`${tabCategories}!A:C`);
  const rows = (result.values || []).slice(1);
  state.categories = rows
    .filter(r => isActiveStatus(r[2]))
    .map(r => ({
      name: (r[0] || '').trim(),
      total: parseValue(r[1]),
      status: (r[2] || '').trim(),
    }))
    .filter(c => c.name);
}

async function loadAllTransactions() {
  const { tabTransactions } = state.config;
  const result = await sheetsGet(`${tabTransactions}!A:E`);
  const rows = (result.values || []).slice(1); // skip header row
  state.transactions = rows.map((r, i) => ({
    rowIndex: i + 2, // 1-based, row 1 is header
    date: (r[0] || '').trim(),
    description: (r[1] || '').trim(),
    value: parseValue(r[2]),
    category: (r[3] || '').trim(),
    account: (r[4] || '').trim(),
  })).filter(t => t.date && t.description);
}

async function loadAll(showLoadingMsg = 'Carregando dados...') {
  showLoading(showLoadingMsg);
  try {
    await Promise.all([
      loadSpreadsheetMeta(),
      loadAccounts(),
      loadCategories(),
    ]);
    await loadAllTransactions();
    renderApp();
  } finally {
    hideLoading();
  }
}

// =============================================
// FILTERED VIEW
// =============================================
function getFilteredTransactions() {
  const { month, year, selectedAccounts } = state.ui;
  return state.transactions.filter(t => {
    const d = parseDate(t.date);
    if (!d) return false;
    if (d.getMonth() + 1 !== month || d.getFullYear() !== year) return false;
    if (selectedAccounts.size > 0 && !selectedAccounts.has(t.account)) return false;
    return true;
  });
}

function getPreviousBalance() {
  // Calcula saldo até o fim do mês anterior, respeitando filtros de contas
  const { month, year, selectedAccounts } = state.ui;
  
  // Mês anterior
  let prevMonth = month - 1;
  let prevYear = year;
  if (prevMonth < 1) {
    prevMonth = 12;
    prevYear--;
  }
  
  // Filtra todas as transações até fim do mês anterior
  let previousBalance = 0;
  state.transactions.forEach(t => {
    const d = parseDate(t.date);
    if (!d) return;
    
    // Verifica se é antes do mês atual
    const isBeforeCurrent = d.getFullYear() < year || 
      (d.getFullYear() === year && d.getMonth() + 1 < month);
    
    if (!isBeforeCurrent) return;
    
    // Aplica filtro de contas
    if (selectedAccounts.size > 0 && !selectedAccounts.has(t.account)) return;
    
    previousBalance += t.value;
  });
  
  return previousBalance;
}

function calculateSummary(transactions) {
  let income = 0, expenses = 0;
  transactions.forEach(t => {
    if (t.value > 0) income += t.value;
    else expenses += Math.abs(t.value);
  });
  return { income, expenses, balance: income - expenses };
}

// =============================================
// RENDERING
// =============================================
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(`screen-${name}`);
  if (el) el.classList.add('active');
}

function showLoading(msg = 'Carregando...') {
  document.getElementById('loading-message').textContent = msg;
  document.getElementById('loading-overlay').style.display = 'flex';
}

function hideLoading() {
  document.getElementById('loading-overlay').style.display = 'none';
}

function showToast(msg, type = '', duration = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.style.display = 'block';
  clearTimeout(el._timeout);
  el._timeout = setTimeout(() => { el.style.display = 'none'; }, duration);
}

function renderApp() {
  renderMonthLabel();
  renderAccountChips();
  renderTransactionList();
  renderSummary();
}

function renderMonthLabel() {
  const { month, year } = state.ui;
  document.getElementById('month-label').textContent =
    `${MONTHS_PT[month - 1]} ${year}`;
}

function renderAccountChips() {
  const container = document.getElementById('account-chips');
  const { selectedAccounts, accountFilterOpen } = state.ui;
  const activeAccounts = state.accounts.filter(acc => isActiveStatus(acc.status));
  container.innerHTML = '';

  if (activeAccounts.length === 0) {
    container.innerHTML = '<span class="account-chip-label">Sem contas ativas</span>';
    return;
  }

  const selectedNames = activeAccounts
    .filter(acc => selectedAccounts.has(acc.name))
    .map(acc => acc.name);

  const headerEl = document.createElement('div');
  headerEl.className = 'account-filter-header';

  const titleEl = document.createElement('span');
  titleEl.className = 'account-filter-title';
  titleEl.textContent = 'Filtro de contas';

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'account-filter-toggle';
  toggleBtn.setAttribute('type', 'button');
  toggleBtn.textContent = accountFilterOpen ? 'Ocultar' : 'Selecionar';
  toggleBtn.addEventListener('click', () => {
    state.ui.accountFilterOpen = !state.ui.accountFilterOpen;
    renderAccountChips();
  });

  headerEl.appendChild(titleEl);
  headerEl.appendChild(toggleBtn);
  container.appendChild(headerEl);

  const statusEl = document.createElement('div');
  statusEl.className = 'account-filter-status';
  if (selectedAccounts.size === 0) {
    statusEl.textContent = 'Filtrando: todas as contas';
  } else {
    statusEl.textContent = `Filtrando (${selectedNames.length}): ${selectedNames.join(', ')}`;
  }
  container.appendChild(statusEl);

  if (!accountFilterOpen) {
    return;
  }

  const actionsEl = document.createElement('div');
  actionsEl.className = 'account-filter-actions';

  const clearBtn = document.createElement('button');
  clearBtn.className = 'account-filter-clear';
  clearBtn.setAttribute('type', 'button');
  clearBtn.textContent = 'Mostrar todas';
  clearBtn.disabled = selectedAccounts.size === 0;
  clearBtn.addEventListener('click', () => {
    selectedAccounts.clear();
    renderAccountChips();
    renderTransactionList();
    renderSummary();
  });

  actionsEl.appendChild(clearBtn);
  container.appendChild(actionsEl);

  const listEl = document.createElement('div');
  listEl.className = 'account-list';

  activeAccounts.forEach(acc => {
    const item = document.createElement('button');
    const isActiveFilter = selectedAccounts.has(acc.name);
    item.className = 'account-list-item' + (isActiveFilter ? ' active' : '');
    item.dataset.account = acc.name;
    item.setAttribute('type', 'button');
    item.setAttribute('aria-pressed', isActiveFilter ? 'true' : 'false');

    const checkEl = document.createElement('span');
    checkEl.className = 'account-list-check';
    checkEl.textContent = isActiveFilter ? '✓' : '';

    const nameEl = document.createElement('span');
    nameEl.className = 'account-list-name';
    nameEl.textContent = acc.name;

    item.appendChild(checkEl);
    item.appendChild(nameEl);

    item.addEventListener('click', () => {
      if (selectedAccounts.has(acc.name)) {
        selectedAccounts.delete(acc.name);
      } else {
        selectedAccounts.add(acc.name);
      }
      renderAccountChips();
      renderTransactionList();
      renderSummary();
    });

    listEl.appendChild(item);
  });

  container.appendChild(listEl);
}

function renderSummary() {
  const txs = getFilteredTransactions();
  const { income, expenses, balance } = calculateSummary(txs);
  document.getElementById('summary-income').textContent = formatCurrency(income);
  document.getElementById('summary-expenses').textContent = formatCurrency(expenses);
  
  const balanceEl = document.getElementById('summary-balance');
  let displayBalance = balance;
  
  if (state.ui.showPreviousBalance) {
    const prevBalance = getPreviousBalance();
    displayBalance = prevBalance + balance;
  }
  
  balanceEl.textContent = formatCurrency(displayBalance);
  balanceEl.style.color = displayBalance >= 0 ? 'var(--income)' : 'var(--expense)';
}

function renderTransactionList() {
  const container = document.getElementById('transaction-list');
  const txs = getFilteredTransactions();
  const previousBalance = getPreviousBalance();

  if (txs.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <p>Nenhuma transação encontrada<br>para este período.</p>
      </div>`;
    return;
  }

  // Group by date
  const groups = {};
  txs.forEach(t => {
    if (!groups[t.date]) groups[t.date] = [];
    groups[t.date].push(t);
  });

  // Sort dates
  const sortedDates = Object.keys(groups).sort((a, b) => {
    const da = parseDate(a), db = parseDate(b);
    if (!da || !db) return 0;
    return da - db;
  });

  // Pair transfers for display
  const pairedSet = new Set();
  const displayItems = []; // { date, items: [{type, data}] }

  sortedDates.forEach(dateStr => {
    const items = [];
    groups[dateStr].forEach(tx => {
      if (pairedSet.has(tx.rowIndex)) return;
      if (isTransferCategory(tx.category)) {
        const pair = findTransferPair(tx, txs);
        if (pair && !pairedSet.has(pair.rowIndex)) {
          pairedSet.add(tx.rowIndex);
          pairedSet.add(pair.rowIndex);
          const source = tx.value < 0 ? tx : pair;
          const dest = tx.value > 0 ? tx : pair;
          items.push({ type: 'transfer', source, dest });
        } else {
          pairedSet.add(tx.rowIndex);
          items.push({ type: 'single', tx });
        }
      } else {
        items.push({ type: 'single', tx });
      }
    });
    if (items.length > 0) displayItems.push({ date: dateStr, items });
  });

  let runningBalance = state.ui.showPreviousBalance ? previousBalance : 0;

  container.innerHTML = '';
  if (state.ui.showPreviousBalance) {
    container.appendChild(renderOpeningBalanceItem(previousBalance));
  }

  displayItems.forEach(({ date, items }) => {
    const group = document.createElement('div');
    group.className = 'transaction-date-group';

    const header = document.createElement('div');
    header.className = 'transaction-date-header';
    const d = parseDate(date);
    const dayName = d ? d.toLocaleDateString('pt-BR', { weekday: 'short' }) : '';
    header.textContent = `${date.substring(0, 5)}${dayName ? ' · ' + dayName : ''}`;
    group.appendChild(header);

    items.forEach(item => {
      if (item.type === 'transfer') {
        group.appendChild(renderTransferItem(item.source, item.dest));
      } else {
        group.appendChild(renderTransactionItem(item.tx));
      }
    });

    const dayNet = items.reduce((sum, item) => {
      if (item.type === 'transfer') {
        // Transfer pair net effect should be zero in overall balance.
        return sum + item.source.value + item.dest.value;
      }
      return sum + item.tx.value;
    }, 0);

    runningBalance += dayNet;
    group.appendChild(renderDailyBalanceItem(runningBalance, dayNet));

    container.appendChild(group);
  });
}

function renderOpeningBalanceItem(previousBalance) {
  const el = document.createElement('div');
  const balanceClass = previousBalance >= 0 ? 'positive' : 'negative';
  el.className = 'opening-balance-item';
  el.innerHTML = `
    <div class="opening-balance-label">Saldo anterior</div>
    <div class="opening-balance-value ${balanceClass}">${formatCurrency(previousBalance)}</div>
  `;
  return el;
}

function renderDailyBalanceItem(runningBalance, dayNet) {
  const el = document.createElement('div');
  const netClass = dayNet >= 0 ? 'positive' : 'negative';
  const balanceClass = runningBalance >= 0 ? 'positive' : 'negative';
  el.className = 'daily-balance-item';
  el.innerHTML = `
    <div class="daily-balance-label">Saldo acumulado</div>
    <div class="daily-balance-values">
      <span class="daily-net ${netClass}">${formatCurrencyShort(dayNet)}</span>
      <span class="daily-total ${balanceClass}">${formatCurrency(runningBalance)}</span>
    </div>
  `;
  return el;
}

function renderTransactionItem(tx) {
  const el = document.createElement('div');
  const isIncome = tx.value > 0;
  el.className = `transaction-item ${isIncome ? 'income' : 'expense'}`;
  el.innerHTML = `
    <div class="transaction-icon">${isIncome ? '↑' : '↓'}</div>
    <div class="transaction-info">
      <div class="transaction-description">${escHtml(tx.description)}</div>
      <div class="transaction-meta">${escHtml(tx.account)}${tx.category ? ' · ' + escHtml(tx.category) : ''}</div>
    </div>
    <div class="transaction-amount">${formatCurrencyShort(tx.value)}</div>
  `;
  el.addEventListener('click', () => openEditTransaction(tx));
  return el;
}

function renderTransferItem(source, dest) {
  const el = document.createElement('div');
  el.className = 'transaction-item transfer';
  el.innerHTML = `
    <div class="transaction-icon">⇄</div>
    <div class="transaction-info">
      <div class="transaction-description">${escHtml(source.description)}</div>
      <div class="transaction-meta">${escHtml(source.account)} → ${escHtml(dest.account)}</div>
    </div>
    <div class="transaction-amount">${formatCurrencyShort(Math.abs(source.value))}</div>
  `;
  el.addEventListener('click', () => openEditTransfer(source, dest));
  return el;
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// =============================================
// MODAL: TRANSACTION FORM
// =============================================
function populateSelects() {
  const activeAccounts = state.accounts.filter(a => isActiveStatus(a.status));
  const activeCategories = state.categories.filter(c => isActiveStatus(c.status));

  const accountSelects = ['f-account', 'f-source-account', 'f-dest-account'];
  accountSelects.forEach(id => {
    const sel = document.getElementById(id);
    const current = sel.value;
    sel.innerHTML = '<option value="">Selecionar...</option>';
    activeAccounts.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.name;
      opt.textContent = a.name;
      sel.appendChild(opt);
    });
    if (current) sel.value = current;
  });

  const catSel = document.getElementById('f-category');
  const currentCat = catSel.value;
  catSel.innerHTML = '<option value="">Selecionar...</option>';
  activeCategories.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.name;
    opt.textContent = c.name;
    catSel.appendChild(opt);
  });
  if (currentCat) catSel.value = currentCat;
}

function resetTransactionForm() {
  document.getElementById('form-transaction').reset();
  document.getElementById('f-date').value = formatDateInput(today);
  document.getElementById('f-installment-type').value = 'none';
  document.getElementById('installment-fields').style.display = 'none';
  document.getElementById('f-installment-start').value = '1';
  document.getElementById('f-installment-total').value = '12';
  document.getElementById('form-error').style.display = 'none';
  document.getElementById('btn-delete-transaction').style.display = 'none';
  document.getElementById('desc-count').textContent = '0/30';
  const transferPreviewEl = document.getElementById('transfer-preview');
  if (transferPreviewEl) {
    transferPreviewEl.style.display = 'none';
    transferPreviewEl.textContent = '';
  }
  setTransactionType('despesa');
  state.editingTransaction = null;
  state.editInstallmentMode = null;
}

function setTransactionType(type) {
  document.querySelectorAll('.type-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === type);
  });
  const isTransfer = type === 'transferencia';
  document.getElementById('fields-normal').style.display = isTransfer ? 'none' : 'block';
  document.getElementById('fields-transfer').style.display = isTransfer ? 'block' : 'none';

  if (!isTransfer) {
    const transferPreviewEl = document.getElementById('transfer-preview');
    if (transferPreviewEl) {
      transferPreviewEl.style.display = 'none';
    }
  }
}

function openAddTransaction() {
  resetTransactionForm();
  document.getElementById('modal-transaction-title').textContent = 'Nova Transação';
  document.getElementById('modal-transaction').style.display = 'flex';
}

function openEditTransaction(tx) {
  if (isTransferCategory(tx.category)) {
    // Resolve pair from all loaded transactions so edit works even with account filters applied.
    const pair = findTransferPair(tx, state.transactions);
    if (pair) {
      const source = tx.value < 0 ? tx : pair;
      const dest = tx.value > 0 ? tx : pair;
      openEditTransfer(source, dest);
      return;
    }
  }

  const installment = parseInstallment(tx.description);

  if (installment) {
    // Ask if editing single or all forward
    state.pendingInstallmentEdit = { tx, installment };
    document.getElementById('modal-installment-edit').style.display = 'flex';
    return;
  }

  _openEditForm(tx, null);
}

function _openEditForm(tx, installmentMode) {
  resetTransactionForm();
  populateSelects();

  state.editingTransaction = tx;
  state.editInstallmentMode = installmentMode; // 'single' | 'forward' | null

  document.getElementById('modal-transaction-title').textContent = 'Editar Transação';
  document.getElementById('btn-delete-transaction').style.display = 'inline-flex';

  const isTransfer = isTransferCategory(tx.category);
  const isIncome = tx.value > 0;
  const typeValue = isTransfer ? 'transferencia' : (isIncome ? 'receita' : 'despesa');
  setTransactionType(typeValue);

  // Fill common fields
  const installment = parseInstallment(tx.description);
  const baseDesc = installment ? installment.base : tx.description;
  document.getElementById('f-description').value = baseDesc;
  document.getElementById('desc-count').textContent = `${baseDesc.length}/30`;
  document.getElementById('f-amount').value = Math.abs(tx.value).toFixed(2);

  // Convert date DD/MM/YYYY → YYYY-MM-DD for input
  const d = parseDate(tx.date);
  if (d) document.getElementById('f-date').value = formatDateInput(d);

  if (!isTransfer) {
    document.getElementById('f-account').value = tx.account || '';
    document.getElementById('f-category').value = tx.category || '';
  }

  // Installment fields
  if (installment && installmentMode === 'forward') {
    document.getElementById('f-installment-type').value = 'monthly';
    document.getElementById('installment-fields').style.display = 'block';
    document.getElementById('f-installment-start').value = installment.current;
    document.getElementById('f-installment-total').value = installment.total;
  }

  document.getElementById('modal-transaction').style.display = 'flex';
}

function openEditTransfer(source, dest) {
  const installment = parseInstallment(source.description);
  if (installment) {
    // Ask if editing single or all forward
    state.pendingInstallmentEdit = { _isTransfer: true, source, dest, installment };
    document.getElementById('modal-installment-edit').style.display = 'flex';
    return;
  }
  _openEditTransferForm(source, dest, null);
}

function _openEditTransferForm(source, dest, installmentMode) {
  resetTransactionForm();
  populateSelects();

  // Store both rows as a combined editing object
  state.editingTransaction = {
    _isTransferPair: true,
    _installmentMode: installmentMode,
    sourceRow: source,
    destRow: dest,
    date: source.date,
    description: source.description,
    value: Math.abs(source.value),
    category: 'Transferência',
    account: source.account,
  };

  document.getElementById('modal-transaction-title').textContent = 'Editar Transferência';
  document.getElementById('btn-delete-transaction').style.display = 'inline-flex';

  setTransactionType('transferencia');

  const installment = parseInstallment(source.description);
  const baseDesc = installment ? installment.base : source.description;
  document.getElementById('f-description').value = baseDesc;
  document.getElementById('desc-count').textContent = `${baseDesc.length}/30`;
  document.getElementById('f-amount').value = Math.abs(source.value).toFixed(2);

  const d = parseDate(source.date);
  if (d) document.getElementById('f-date').value = formatDateInput(d);

  document.getElementById('f-source-account').value = source.account || '';
  document.getElementById('f-dest-account').value = dest.account || '';

  const transferPreviewEl = document.getElementById('transfer-preview');
  if (transferPreviewEl) {
    transferPreviewEl.textContent = `Origem: ${source.account || '-'} -> Destino: ${dest.account || '-'}`;
    transferPreviewEl.style.display = 'block';
  }

  if (installment && installmentMode === 'forward') {
    document.getElementById('f-installment-type').value = 'monthly';
    document.getElementById('installment-fields').style.display = 'block';
    document.getElementById('f-installment-start').value = installment.current;
    document.getElementById('f-installment-total').value = installment.total;
  }

  document.getElementById('modal-transaction').style.display = 'flex';
}

function closeTransactionModal() {
  document.getElementById('modal-transaction').style.display = 'none';
  state.editingTransaction = null;
  state.editInstallmentMode = null;
}

// =============================================
// TRANSACTION SAVE
// =============================================
function getCurrentType() {
  const active = document.querySelector('.type-btn.active');
  return active ? active.dataset.type : 'despesa';
}

function validateForm(type) {
  const desc = document.getElementById('f-description').value.trim();
  const amountRaw = document.getElementById('f-amount').value;
  const date = document.getElementById('f-date').value;

  if (!desc) return 'Informe a descrição.';
  if (!amountRaw || parseFloat(amountRaw) <= 0) return 'Informe um valor válido.';
  if (!date) return 'Informe a data.';

  if (type === 'transferencia') {
    const src = document.getElementById('f-source-account').value;
    const dst = document.getElementById('f-dest-account').value;
    if (!src) return 'Selecione a conta de origem.';
    if (!dst) return 'Selecione a conta de destino.';
    if (src === dst) return 'A conta de origem e destino devem ser diferentes.';
  } else {
    const acct = document.getElementById('f-account').value;
    const cat = document.getElementById('f-category').value;
    if (!acct) return 'Selecione a conta.';
    if (!cat) return 'Selecione a categoria.';
  }

  const installmentType = document.getElementById('f-installment-type').value;
  if (installmentType === 'monthly') {
    const x = parseInt(document.getElementById('f-installment-start').value, 10);
    const y = parseInt(document.getElementById('f-installment-total').value, 10);
    if (isNaN(x) || x < 1 || x > 99) return 'Parcela inicial deve ser entre 1 e 99.';
    if (isNaN(y) || y < 1 || y > 99) return 'Total de parcelas deve ser entre 1 e 99.';
    if (x > y) return 'A parcela inicial não pode ser maior que o total.';
  }

  return null;
}

async function handleSaveTransaction(e) {
  e.preventDefault();

  const type = getCurrentType();
  const errorMsg = validateForm(type);
  const errorEl = document.getElementById('form-error');

  if (errorMsg) {
    errorEl.textContent = errorMsg;
    errorEl.style.display = 'block';
    return;
  }
  errorEl.style.display = 'none';

  const desc = document.getElementById('f-description').value.trim();
  const amount = parseFloat(document.getElementById('f-amount').value);
  const dateInput = document.getElementById('f-date').value;
  const dateSheet = inputDateToSheet(dateInput);
  const installmentType = document.getElementById('f-installment-type').value;
  const installX = parseInt(document.getElementById('f-installment-start').value, 10);
  const installY = parseInt(document.getElementById('f-installment-total').value, 10);

  const { tabTransactions } = state.config;

  try {
    showLoading('Salvando...');

    if (state.editingTransaction) {
      await handleUpdate(type, desc, amount, dateSheet, installmentType, installX, installY, tabTransactions);
    } else {
      await handleCreate(type, desc, amount, dateSheet, installmentType, installX, installY, tabTransactions);
    }

    closeTransactionModal();
    await loadAll('Atualizando...');
    showToast('Salvo com sucesso!', 'success');
  } catch (err) {
    hideLoading();
    errorEl.textContent = err.message || 'Erro ao salvar.';
    errorEl.style.display = 'block';
  }
}

async function handleCreate(type, desc, amount, dateSheet, installType, installX, installY, tab) {
  const rows = buildRows(type, desc, amount, dateSheet, installType, installX, installY);
  // Append all rows
  for (const row of rows) {
    await sheetsAppend(`${tab}!A:E`, [row]);
  }
}

async function handleUpdate(type, desc, amount, dateSheet, installType, installX, installY, tab) {
  const editing = state.editingTransaction;
  const mode = state.editInstallmentMode;

  if (editing._isTransferPair) {
    if (editing._installmentMode === 'forward') {
      await updateTransferPairsForward(editing, desc, amount, dateSheet, installType, installX, installY, tab);
    } else {
      await updateTransferPair(editing, desc, amount, dateSheet, installType, installX, installY, tab);
    }
    return;
  }

  if (mode === 'forward') {
    // Edit this and all future installments
    await updateInstallmentsForward(editing, type, desc, amount, dateSheet, installType, installX, installY, tab);
    return;
  }

  // Single edit — preserve existing installment notation if present
  const origInst = parseInstallment(editing.description);
  const finalDesc = origInst ? installmentDescription(desc, origInst.current, origInst.total) : desc;
  const account = type !== 'transferencia' ? document.getElementById('f-account').value : editing.account;
  const category = type !== 'transferencia' ? document.getElementById('f-category').value : editing.category;
  const row = buildSingleRow(type, finalDesc, amount, dateSheet, account, category);
  await sheetsUpdate(`${tab}!A${editing.rowIndex}:E${editing.rowIndex}`, [row]);
}

async function updateTransferPair(editing, desc, amount, dateSheet, installType, installX, installY, tab) {
  // Single pair update — preserve installment notation if present
  const origInst = parseInstallment(editing.description);
  let finalDesc;
  if (installType === 'monthly') {
    finalDesc = installmentDescription(desc, installX, installY);
  } else if (origInst) {
    // editing mode 'single': preserve the notation from the original
    finalDesc = installmentDescription(desc, origInst.current, origInst.total);
  } else {
    finalDesc = desc;
  }

  const sourceAccount = document.getElementById('f-source-account').value;
  const destAccount = document.getElementById('f-dest-account').value;

  const srcRow = [dateSheet, finalDesc, -amount, 'Transferência', sourceAccount];
  const dstRow = [dateSheet, finalDesc, amount, 'Transferência', destAccount];

  await sheetsUpdate(`${tab}!A${editing.sourceRow.rowIndex}:E${editing.sourceRow.rowIndex}`, [srcRow]);
  await sheetsUpdate(`${tab}!A${editing.destRow.rowIndex}:E${editing.destRow.rowIndex}`, [dstRow]);
}

async function updateTransferPairsForward(editing, desc, amount, dateSheet, installType, installX, installY, tab) {
  // Edit this and all future transfer pairs with the same installment pattern
  const origInstall = parseInstallment(editing.description);
  if (!origInstall) {
    await updateTransferPair(editing, desc, amount, dateSheet, installType, installX, installY, tab);
    return;
  }

  const { base: origBase, current: origCurrent, total: origTotal } = origInstall;
  const newTotal = installType === 'monthly' ? installY : origTotal;
  const sourceAccount = document.getElementById('f-source-account').value;
  const destAccount = document.getElementById('f-dest-account').value;

  // Find all source-side rows (negative) of this transfer installment pattern
  const forwardSources = state.transactions.filter(t => {
    if (!isTransferCategory(t.category)) return false;
    if (t.value >= 0) return false; // only source rows
    const inst = parseInstallment(t.description);
    if (!inst) return false;
    return inst.base === origBase && inst.total === origTotal && inst.current >= origCurrent;
  });

  for (const srcTx of forwardSources) {
    const inst = parseInstallment(srcTx.description);
    const offset = inst.current - origCurrent;
    const newDate = addMonths(dateSheet, offset);
    const newDesc = installmentDescription(desc, inst.current, newTotal);
    const pair = findTransferPair(srcTx, state.transactions);

    await sheetsUpdate(`${tab}!A${srcTx.rowIndex}:E${srcTx.rowIndex}`, [[newDate, newDesc, -amount, 'Transferência', sourceAccount]]);
    if (pair) {
      await sheetsUpdate(`${tab}!A${pair.rowIndex}:E${pair.rowIndex}`, [[newDate, newDesc, amount, 'Transferência', destAccount]]);
    }
  }
}

async function updateInstallmentsForward(editing, type, desc, amount, dateSheet, installType, installX, installY, tab) {
  // Find all matching future installments
  const origInstall = parseInstallment(editing.description);
  if (!origInstall) {
    // No installment pattern; just update single row
    const row = buildSingleRow(type, desc, amount, dateSheet, editing.account, editing.category);
    await sheetsUpdate(`${tab}!A${editing.rowIndex}:E${editing.rowIndex}`, [row]);
    return;
  }

  const { base: origBase, current: origCurrent, total: origTotal } = origInstall;

  // Find all transactions with same base description and same total, installment >= origCurrent
  const forwardTxs = state.transactions.filter(t => {
    const inst = parseInstallment(t.description);
    if (!inst) return false;
    return inst.base === origBase && inst.total === origTotal && inst.current >= origCurrent;
  }).sort((a, b) => {
    const ia = parseInstallment(a.description);
    const ib = parseInstallment(b.description);
    return ia.current - ib.current;
  });

  const newTotal = installType === 'monthly' ? installY : origTotal;
  const account = type !== 'transferencia' ? document.getElementById('f-account').value : editing.account;
  const category = type !== 'transferencia' ? document.getElementById('f-category').value : editing.category;
  const sign = type === 'despesa' ? -1 : 1;

  for (const t of forwardTxs) {
    const inst = parseInstallment(t.description);
    const installNum = inst.current;
    const offset = installNum - origCurrent;
    const newDate = addMonths(dateSheet, offset);
    const newDesc = installmentDescription(desc, installNum, newTotal);
    const row = [newDate, newDesc, sign * amount, category, account];
    await sheetsUpdate(`${tab}!A${t.rowIndex}:E${t.rowIndex}`, [row]);
  }
}

function buildRows(type, desc, amount, dateSheet, installType, installX, installY) {
  const isTransfer = type === 'transferencia';
  const account = isTransfer ? null : document.getElementById('f-account').value;
  const category = isTransfer ? 'Transferência' : document.getElementById('f-category').value;
  const sourceAccount = isTransfer ? document.getElementById('f-source-account').value : null;
  const destAccount = isTransfer ? document.getElementById('f-dest-account').value : null;
  const sign = type === 'despesa' ? -1 : 1;

  if (installType !== 'monthly') {
    if (isTransfer) {
      return [
        [dateSheet, desc, -amount, 'Transferência', sourceAccount],
        [dateSheet, desc, amount, 'Transferência', destAccount],
      ];
    }
    return [[dateSheet, desc, sign * amount, category, account]];
  }

  // Monthly installments
  const rows = [];
  for (let i = installX; i <= installY; i++) {
    const installDate = addMonths(dateSheet, i - installX);
    const installDesc = installmentDescription(desc, i, installY);
    if (isTransfer) {
      rows.push([installDate, installDesc, -amount, 'Transferência', sourceAccount]);
      rows.push([installDate, installDesc, amount, 'Transferência', destAccount]);
    } else {
      rows.push([installDate, installDesc, sign * amount, category, account]);
    }
  }
  return rows;
}

function buildSingleRow(type, desc, amount, dateSheet, account, category) {
  const sign = type === 'despesa' ? -1 : 1;
  return [dateSheet, desc, sign * amount, category, account];
}

// =============================================
// TRANSACTION DELETE
// =============================================
async function handleDeleteTransaction() {
  const editing = state.editingTransaction;
  if (!editing) return;

  // Check if transfer pair
  if (editing._isTransferPair) {
    const txInstallment = parseInstallment(editing.description);
    if (txInstallment) {
      showConfirmModal(
        'Excluir Transferência Parcelada',
        `Excluir apenas a parcela ${txInstallment.current}/${txInstallment.total} de "${txInstallment.base}", ou esta e todas as futuras?`,
        async () => {
          closeTransactionModal();
          await deleteRows([editing.sourceRow.rowIndex, editing.destRow.rowIndex]);
        },
        {
          okLabel: 'Apenas esta',
          extraBtn: {
            label: 'Esta e futuras',
            action: async () => {
              closeTransactionModal();
              await deleteTransferInstallmentsForward(editing.sourceRow, editing.destRow, txInstallment);
            }
          }
        }
      );
    } else {
      showConfirmModal(
        'Excluir Transferência',
        `Excluir a transferência "${editing.description}" de ${editing.sourceRow.account} para ${editing.destRow.account}?`,
        async () => {
          closeTransactionModal();
          await deleteRows([editing.sourceRow.rowIndex, editing.destRow.rowIndex]);
        }
      );
    }
    return;
  }

  // Check if installment
  const installment = parseInstallment(editing.description);
  if (installment) {
    showConfirmModal(
      'Excluir Parcela',
      `Excluir apenas a parcela ${installment.current}/${installment.total} de "${installment.base}", ou esta e todas as futuras?`,
      async () => {
        closeTransactionModal();
        await deleteSingleTransaction(editing);
      },
      {
        okLabel: 'Apenas esta',
        extraBtn: {
          label: 'Esta e futuras',
          action: async () => {
            closeTransactionModal();
            await deleteInstallmentsForward(editing, installment);
          }
        }
      }
    );
    return;
  }

  showConfirmModal(
    'Excluir Transação',
    `Excluir "${editing.description}" de ${formatCurrency(editing.value)}?`,
    async () => {
      closeTransactionModal();
      await deleteSingleTransaction(editing);
    }
  );
}

async function deleteSingleTransaction(tx) {
  try {
    showLoading('Excluindo...');
    await sheetsDeleteRows([tx.rowIndex]);
    await loadAll('Atualizando...');
    showToast('Excluído com sucesso!', 'success');
  } catch (err) {
    hideLoading();
    showToast('Erro ao excluir: ' + err.message, 'error');
  }
}

async function deleteInstallmentsForward(tx, installment) {
  try {
    showLoading('Excluindo parcelas...');
    const { base: origBase, current: origCurrent, total: origTotal } = installment;
    const rowsToDelete = state.transactions
      .filter(t => {
        const inst = parseInstallment(t.description);
        if (!inst) return false;
        return inst.base === origBase && inst.total === origTotal && inst.current >= origCurrent;
      })
      .map(t => t.rowIndex);

    await sheetsDeleteRows(rowsToDelete);
    await loadAll('Atualizando...');
    showToast('Parcelas excluídas!', 'success');
  } catch (err) {
    hideLoading();
    showToast('Erro ao excluir: ' + err.message, 'error');
  }
}

async function deleteTransferInstallmentsForward(sourceRow, destRow, installment) {
  try {
    showLoading('Excluindo parcelas...');
    const { base: origBase, current: origCurrent, total: origTotal } = installment;
    const rowsToDelete = state.transactions
      .filter(t => {
        if (!isTransferCategory(t.category)) return false;
        const inst = parseInstallment(t.description);
        if (!inst) return false;
        return inst.base === origBase && inst.total === origTotal && inst.current >= origCurrent;
      })
      .map(t => t.rowIndex);
    await sheetsDeleteRows(rowsToDelete);
    await loadAll('Atualizando...');
    showToast('Parcelas excluídas!', 'success');
  } catch (err) {
    hideLoading();
    showToast('Erro ao excluir: ' + err.message, 'error');
  }
}

async function deleteRows(rowIndices) {
  try {
    showLoading('Excluindo...');
    await sheetsDeleteRows(rowIndices);
    await loadAll('Atualizando...');
    showToast('Excluído com sucesso!', 'success');
  } catch (err) {
    hideLoading();
    showToast('Erro ao excluir: ' + err.message, 'error');
  }
}

// =============================================
// CONFIRM MODAL
// =============================================
function showConfirmModal(title, message, onOk, opts = {}) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;

  const okBtn = document.getElementById('btn-confirm-ok');
  okBtn.textContent = opts.okLabel || 'Excluir';

  // Remove old extra button if any
  const existingExtra = document.getElementById('btn-confirm-extra');
  if (existingExtra) existingExtra.remove();

  if (opts.extraBtn) {
    const extraBtn = document.createElement('button');
    extraBtn.id = 'btn-confirm-extra';
    extraBtn.className = 'btn btn-danger';
    extraBtn.textContent = opts.extraBtn.label;
    extraBtn.addEventListener('click', () => {
      closeConfirmModal();
      opts.extraBtn.action();
    });
    okBtn.parentElement.insertBefore(extraBtn, okBtn);
  }

  state.pendingConfirm = () => {
    closeConfirmModal();
    onOk();
  };

  document.getElementById('modal-confirm').style.display = 'flex';
}

function closeConfirmModal() {
  document.getElementById('modal-confirm').style.display = 'none';
  state.pendingConfirm = null;
}

// =============================================
// AUTH
// =============================================
function initAuth() {
  if (!window.google || !window.google.accounts) {
    setTimeout(initAuth, 200);
    return;
  }

  state.tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: state.config.clientId,
    scope: SCOPE,
    callback: handleTokenResponse,
  });
}

function handleTokenResponse(response) {
  if (response.error) {
    showToast('Erro na autenticação: ' + response.error, 'error');
    return;
  }
  state.accessToken = response.access_token;
  state.tokenExpiry = Date.now() + (response.expires_in - 60) * 1000;
  showScreen('main');
  loadAll();
}

function signIn() {
  if (!state.tokenClient) {
    showToast('Aguarde, inicializando autenticação...', '');
    initAuth();
    setTimeout(signIn, 500);
    return;
  }
  state.tokenClient.requestAccessToken({ prompt: '' });
}

// =============================================
// EVENT LISTENERS
// =============================================
function bindEvents() {
  // Auth screen
  document.getElementById('btn-signin').addEventListener('click', signIn);

  // Main screen
  document.getElementById('btn-prev-month').addEventListener('click', () => {
    let { month, year } = state.ui;
    month--;
    if (month < 1) { month = 12; year--; }
    state.ui.month = month;
    state.ui.year = year;
    renderApp();
  });

  document.getElementById('btn-next-month').addEventListener('click', () => {
    let { month, year } = state.ui;
    month++;
    if (month > 12) { month = 1; year++; }
    state.ui.month = month;
    state.ui.year = year;
    renderApp();
  });

  document.getElementById('btn-reload').addEventListener('click', () => {
    loadAll('Atualizando dados...');
  });

  document.getElementById('btn-toggle-prev-balance').addEventListener('click', () => {
    state.ui.showPreviousBalance = !state.ui.showPreviousBalance;
    renderTransactionList();
    renderSummary();
    const btn = document.getElementById('btn-toggle-prev-balance');
    btn.style.opacity = state.ui.showPreviousBalance ? '1' : '0.5';
  });

  document.getElementById('btn-add').addEventListener('click', () => {
    populateSelects();
    openAddTransaction();
  });

  // Transaction modal
  document.getElementById('btn-modal-close').addEventListener('click', closeTransactionModal);
  document.getElementById('btn-cancel-transaction').addEventListener('click', closeTransactionModal);
  document.getElementById('form-transaction').addEventListener('submit', handleSaveTransaction);
  document.getElementById('btn-delete-transaction').addEventListener('click', handleDeleteTransaction);

  // Type selector
  document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setTransactionType(btn.dataset.type);
    });
  });

  // Description char count
  document.getElementById('f-description').addEventListener('input', function () {
    document.getElementById('desc-count').textContent = `${this.value.length}/30`;
  });

  // Installment type toggle
  document.getElementById('f-installment-type').addEventListener('change', function () {
    document.getElementById('installment-fields').style.display =
      this.value === 'monthly' ? 'block' : 'none';
  });

  // Confirm modal
  document.getElementById('btn-confirm-ok').addEventListener('click', () => {
    if (state.pendingConfirm) state.pendingConfirm();
  });
  document.getElementById('btn-confirm-cancel').addEventListener('click', closeConfirmModal);

  // Installment edit modal
  document.getElementById('btn-edit-single').addEventListener('click', () => {
    document.getElementById('modal-installment-edit').style.display = 'none';
    if (state.pendingInstallmentEdit) {
      const pending = state.pendingInstallmentEdit;
      state.pendingInstallmentEdit = null;
      populateSelects();
      if (pending._isTransfer) {
        _openEditTransferForm(pending.source, pending.dest, 'single');
      } else {
        _openEditForm(pending.tx, 'single');
      }
    }
  });

  document.getElementById('btn-edit-forward').addEventListener('click', () => {
    document.getElementById('modal-installment-edit').style.display = 'none';
    if (state.pendingInstallmentEdit) {
      const pending = state.pendingInstallmentEdit;
      state.pendingInstallmentEdit = null;
      populateSelects();
      if (pending._isTransfer) {
        _openEditTransferForm(pending.source, pending.dest, 'forward');
      } else {
        _openEditForm(pending.tx, 'forward');
      }
    }
  });

  document.getElementById('btn-edit-cancel').addEventListener('click', () => {
    document.getElementById('modal-installment-edit').style.display = 'none';
    state.pendingInstallmentEdit = null;
  });

  // Close modals on overlay click
  document.getElementById('modal-transaction').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeTransactionModal();
  });
  document.getElementById('modal-confirm').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeConfirmModal();
  });

  // Number inputs: prevent non-numeric in installment fields
  ['f-installment-start', 'f-installment-total'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
      el.value = el.value.replace(/[^0-9]/g, '').substring(0, 2);
    });
  });

  // Initialize previous balance button style
  const btnPrevBalance = document.getElementById('btn-toggle-prev-balance');
  if (btnPrevBalance) {
    btnPrevBalance.style.opacity = state.ui.showPreviousBalance ? '1' : '0.5';
  }
}

// =============================================
// INIT
// =============================================
function init() {
  bindEvents();

  showScreen('auth');
  initAuth();
}

document.addEventListener('DOMContentLoaded', init);
