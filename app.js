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
  tabCategoriesClassified: 'Categorias Classificadas',
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
  categoriesClassified: { roots: {} }, // { roots: { 'Categoria Raiz': { 'Sub1': { 'Sub2': {} } } } }
  transactions: [],   // all loaded transactions [{ rowIndex, date, description, value, category, account }]
  transactionsSheetId: null, // numeric sheetId for batchUpdate
  ui: {
    month: today.getMonth() + 1,  // 1-12
    year: today.getFullYear(),
    selectedAccounts: new Set(),
    showPreviousBalance: true,   // toggle para exibir saldo anterior
    accountFilterOpen: false,
    lastNewTransactionDate: formatDateInput(today),
    searchMode: false,           // true quando em modo de pesquisa
    searchTerm: '',              // termo de busca atual
    backNavInitialized: false,
    allowNextBackExit: false,
  },
  pendingConfirm: null,        // fn to call on confirm
  pendingInstallmentEdit: null, // { transaction, mode: 'single'|'forward' }
  editingTransaction: null,    // transaction being edited
  editInstallmentMode: null,   // 'single' | 'forward' | null
  categoryPicker: {
    selectedRoot: null,
    selectedSub1: null,
    selectedSub2: null,
    currentStep: 1, // 1, 2, or 3
    hasSub2Options: false,
  },
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

function getMonthStartInput(year, month) {
  return formatDateInput(new Date(year, month - 1, 1));
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

function formatInputCurrencyFromCents(cents) {
  const value = Math.max(0, Number(cents || 0)) / 100;
  return value.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function setAmountInputFromNumber(amount) {
  const input = document.getElementById('f-amount');
  const cents = Math.max(0, Math.round(Math.abs(Number(amount || 0)) * 100));
  input.dataset.cents = String(cents);
  input.value = formatInputCurrencyFromCents(cents);
}

function getAmountInputValue() {
  const input = document.getElementById('f-amount');
  const dataCents = parseInt(input.dataset.cents || '', 10);
  if (!Number.isNaN(dataCents)) {
    return dataCents / 100;
  }
  const digits = (input.value || '').replace(/\D/g, '');
  const cents = parseInt(digits || '0', 10);
  return cents / 100;
}

function setupAmountInputMask() {
  const input = document.getElementById('f-amount');
  if (!input) return;

  const readCents = () => {
    const fromData = parseInt(input.dataset.cents || '', 10);
    if (!Number.isNaN(fromData)) return Math.max(0, fromData);
    const digits = (input.value || '').replace(/\D/g, '');
    return parseInt(digits || '0', 10);
  };

  const writeCents = cents => {
    const safe = Math.max(0, cents);
    input.dataset.cents = String(safe);
    input.value = formatInputCurrencyFromCents(safe);
  };

  input.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (/^\d$/.test(e.key)) {
      e.preventDefault();
      writeCents(readCents() * 10 + Number(e.key));
      return;
    }

    if (e.key === 'Backspace') {
      e.preventDefault();
      writeCents(Math.floor(readCents() / 10));
      return;
    }

    if (e.key === 'Delete') {
      e.preventDefault();
      writeCents(0);
      return;
    }

    if (['Tab', 'Enter', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      return;
    }

    e.preventDefault();
  });

  input.addEventListener('paste', e => {
    e.preventDefault();
    const text = e.clipboardData ? e.clipboardData.getData('text') : '';
    const digits = text.replace(/\D/g, '');
    writeCents(parseInt(digits || '0', 10));
  });
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
// UTILITY: Classified categories helpers
// =============================================
function getLeafCategories() {
  // Retorna um array com todas as categorias folha (mais profundas)
  // Cada item tem: { path: "Raiz->Sub1->Sub2", leaf: "Sub2", root: "Raiz", level: 2 }
  const result = [];
  const { roots } = state.categoriesClassified;
  
  Object.entries(roots).forEach(([rootName, sub1Obj]) => {
    if (!sub1Obj || typeof sub1Obj !== 'object') return;
    
    Object.entries(sub1Obj).forEach(([sub1Name, sub2Obj]) => {
      // Se sub2Obj está vazio ou não tem filhos, sub1 é uma folha
      if (!sub2Obj || Object.keys(sub2Obj).length === 0) {
        result.push({
          path: `${rootName}->${sub1Name}`,
          leaf: sub1Name,
          root: rootName,
          level: 1,
        });
      } else {
        // Caso contrário, procura por sub2
        Object.entries(sub2Obj).forEach(([sub2Name]) => {
          result.push({
            path: `${rootName}->${sub1Name}->${sub2Name}`,
            leaf: sub2Name,
            root: rootName,
            level: 2,
          });
        });
      }
    });
  });
  
  return result;
}

function getCategoryPath(leafValue) {
  // Encontra o caminho completo na árvore.
  // Ex: "Academia" -> "Despesas Fixas->Despesas Pessoais->Academia"
  // Ex: "Despesas Pessoais" -> "Despesas Fixas->Despesas Pessoais"
  if (!leafValue) return leafValue;
  
  // Se já é um caminho (contém "->"), retorna como está
  if (leafValue.includes('->')) {
    return leafValue;
  }

  const target = normalizeText(leafValue);
  const roots = getCategoryPickerRoots();

  for (const [rootName, sub1Obj] of Object.entries(roots)) {
    if (normalizeText(rootName) === target) {
      return rootName;
    }

    if (!sub1Obj || typeof sub1Obj !== 'object') continue;

    for (const [sub1Name, sub2Obj] of Object.entries(sub1Obj)) {
      if (normalizeText(sub1Name) === target) {
        return `${rootName}->${sub1Name}`;
      }

      if (!sub2Obj || typeof sub2Obj !== 'object') continue;

      for (const sub2Name of Object.keys(sub2Obj)) {
        if (normalizeText(sub2Name) === target) {
          return `${rootName}->${sub1Name}->${sub2Name}`;
        }
      }
    }
  }

  return leafValue;
}

function findMostRecentCategoryByDescription(description) {
  const normalizedDescription = String(description || '').trim().toLowerCase();
  if (!normalizedDescription) return '';

  let mostRecentMatch = null;

  state.transactions.forEach(tx => {
    const txDescription = String(tx.description || '').trim().toLowerCase();
    if (txDescription !== normalizedDescription) return;
    if (!tx.category || isTransferCategory(tx.category)) return;

    if (!mostRecentMatch) {
      mostRecentMatch = tx;
      return;
    }

    const txDate = parseDate(tx.date);
    const currentDate = parseDate(mostRecentMatch.date);
    const txTime = txDate ? txDate.getTime() : -1;
    const currentTime = currentDate ? currentDate.getTime() : -1;

    if (txTime > currentTime || (txTime === currentTime && tx.rowIndex > mostRecentMatch.rowIndex)) {
      mostRecentMatch = tx;
    }
  });

  return mostRecentMatch ? mostRecentMatch.category : '';
}

function autoSelectCategoryFromDescription() {
  if (state.editingTransaction) return;
  if (getCurrentType() === 'transferencia') return;

  const description = document.getElementById('f-description').value;
  const matchedCategory = findMostRecentCategoryByDescription(description);
  if (!matchedCategory) return;

  document.getElementById('f-category').value = matchedCategory;
  updateCategoryDisplay();
}

function hideDescriptionSuggestions() {
  const container = document.getElementById('description-suggestions');
  if (!container) return;
  container.innerHTML = '';
  container.style.display = 'none';
}

function getRecentDescriptionMatches(query) {
  const normalizedQuery = normalizeText(query);
  if (normalizedQuery.length < 4) return [];

  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setMonth(cutoff.getMonth() - 2);

  const sortedRecent = state.transactions
    .filter(tx => {
      if (!tx.description || !tx.account || !tx.category) return false;
      if (isTransferCategory(tx.category)) return false;
      const txDate = parseDate(tx.date);
      if (!txDate || txDate < cutoff) return false;
      return normalizeText(tx.description).includes(normalizedQuery);
    })
    .sort((a, b) => {
      const da = parseDate(a.date);
      const db = parseDate(b.date);
      const ta = da ? da.getTime() : -1;
      const tb = db ? db.getTime() : -1;
      if (tb !== ta) return tb - ta;
      return b.rowIndex - a.rowIndex;
    });

  const unique = [];
  const seen = new Set();
  for (const tx of sortedRecent) {
    const key = `${normalizeText(tx.description)}|${normalizeText(tx.account)}|${normalizeText(tx.category)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(tx);
    if (unique.length >= 8) break;
  }

  return unique;
}

function applyDescriptionSuggestion(tx) {
  if (!tx) return;

  const descriptionInput = document.getElementById('f-description');
  descriptionInput.value = tx.description;
  document.getElementById('desc-count').textContent = `${descriptionInput.value.length}/30`;

  const accountSelect = document.getElementById('f-account');
  const hasAccount = Array.from(accountSelect.options).some(opt => opt.value === tx.account);
  if (hasAccount) {
    accountSelect.value = tx.account;
  }

  document.getElementById('f-category').value = tx.category;
  updateCategoryDisplay();
  hideDescriptionSuggestions();
}

function renderDescriptionSuggestions(query) {
  const container = document.getElementById('description-suggestions');
  if (!container) return;

  if (state.editingTransaction || getCurrentType() === 'transferencia') {
    hideDescriptionSuggestions();
    return;
  }

  const cleanQuery = String(query || '').trim();
  if (cleanQuery.length < 4) {
    hideDescriptionSuggestions();
    return;
  }

  const matches = getRecentDescriptionMatches(cleanQuery);
  container.innerHTML = '';
  container.style.display = 'block';

  if (matches.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'description-suggestion-empty';
    empty.textContent = 'Nenhuma sugestão nos últimos 2 meses';
    container.appendChild(empty);
    return;
  }

  matches.forEach(tx => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'description-suggestion-option';

    const title = document.createElement('div');
    title.className = 'description-suggestion-title';
    title.textContent = tx.description;

    const meta = document.createElement('div');
    meta.className = 'description-suggestion-meta';
    meta.textContent = `${tx.account} · ${tx.category} · ${formatDateDisplay(tx.date)}`;

    btn.appendChild(title);
    btn.appendChild(meta);
    btn.addEventListener('mousedown', e => {
      e.preventDefault();
      applyDescriptionSuggestion(tx);
    });

    container.appendChild(btn);
  });
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

async function loadCategoriesClassified() {
  const { tabCategoriesClassified } = state.config;
  try {
    const result = await sheetsGet(`${tabCategoriesClassified}!A:C`);
    const rows = (result.values || []).slice(1);
    const roots = {};
    
    rows.forEach(row => {
      const rootName = (row[0] || '').trim();
      const sub1Name = (row[1] || '').trim();
      const sub2Name = (row[2] || '').trim();
      
      if (!rootName) return; // skip empty root
      
      if (!roots[rootName]) {
        roots[rootName] = {};
      }
      
      if (sub1Name && !roots[rootName][sub1Name]) {
        roots[rootName][sub1Name] = {};
      }
      
      if (sub1Name && sub2Name && !roots[rootName][sub1Name][sub2Name]) {
        roots[rootName][sub1Name][sub2Name] = {};
      }
    });
    
    state.categoriesClassified = { roots };
  } catch (err) {
    // If Categorias Classificadas doesn't exist, just use empty structure
    console.warn('Aba Categorias Classificadas não encontrada:', err.message);
    state.categoriesClassified = { roots: {} };
  }
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
  const isFirstLoad = state.ui.selectedAccounts.size === 0 && state.accounts.length === 0;
  showLoading(showLoadingMsg);
  try {
    await Promise.all([
      loadSpreadsheetMeta(),
      loadAccounts(),
      loadCategories(),
      loadCategoriesClassified(),
    ]);
    if (isFirstLoad) {
      const itau = state.accounts.find(a =>
        normalizeText(a.name) === 'itau'  && isActiveStatus(a.status)
      );
      if (itau) {
        state.ui.selectedAccounts.add(itau.name);
      }
    }
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
  const { month, year, selectedAccounts, searchMode, searchTerm } = state.ui;
  return state.transactions.filter(t => {
    const d = parseDate(t.date);
    if (!d) return false;
    if (d.getMonth() + 1 !== month || d.getFullYear() !== year) return false;
    if (selectedAccounts.size > 0 && !selectedAccounts.has(t.account)) return false;
    
    // Se está em modo de pesquisa, filtra pela descrição
    if (searchMode && searchTerm.trim()) {
      const searchNormalized = normalizeText(searchTerm);
      const descriptionNormalized = normalizeText(t.description);
      if (!descriptionNormalized.includes(searchNormalized)) return false;
    }
    
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
  
  if (state.ui.showPreviousBalance && !state.ui.searchMode) {
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

  const showOpeningBalance = state.ui.showPreviousBalance && !state.ui.searchMode;
  let runningBalance = showOpeningBalance ? previousBalance : 0;

  container.innerHTML = '';
  if (showOpeningBalance) {
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
  
  // Build category display path
  const categoryDisplay = tx.category ? escHtml(getCategoryPath(tx.category)) : '';
  
  el.innerHTML = `
    <div class="transaction-icon">${isIncome ? '↑' : '↓'}</div>
    <div class="transaction-info">
      <div class="transaction-description">${escHtml(tx.description)}</div>
      <div class="transaction-meta">${escHtml(tx.account)}${categoryDisplay ? ' · ' + categoryDisplay : ''}</div>
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

  updateCategoryDisplay();
}

function resetTransactionForm() {
  document.getElementById('form-transaction').reset();
  document.getElementById('f-amount').value = '';
  delete document.getElementById('f-amount').dataset.cents;
  document.getElementById('f-date').value = formatDateInput(today);
  document.getElementById('f-installment-type').value = 'none';
  document.getElementById('installment-fields').style.display = 'none';
  document.getElementById('f-installment-start').value = '1';
  document.getElementById('f-installment-total').value = '12';
  document.getElementById('f-category').value = 'Sem Categoria';
  updateCategoryDisplay();
  document.getElementById('form-error').style.display = 'none';
  document.getElementById('btn-delete-transaction').style.display = 'none';
  document.getElementById('btn-save-and-new').style.display = 'inline-flex';
  document.getElementById('desc-count').textContent = '0/30';
  const transferPreviewEl = document.getElementById('transfer-preview');
  if (transferPreviewEl) {
    transferPreviewEl.style.display = 'none';
    transferPreviewEl.textContent = '';
  }
  setTransactionType('despesa');
  hideDescriptionSuggestions();
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

  if (isTransfer) {
    hideDescriptionSuggestions();
  }

  if (!isTransfer) {
    const transferPreviewEl = document.getElementById('transfer-preview');
    if (transferPreviewEl) {
      transferPreviewEl.style.display = 'none';
    }
    return;
  }

  const selectedAccounts = Array.from(state.ui.selectedAccounts || []);
  if (selectedAccounts.length === 1) {
    const sourceSelect = document.getElementById('f-source-account');
    const selected = selectedAccounts[0];
    const exists = Array.from(sourceSelect.options).some(opt => opt.value === selected);
    if (exists && !sourceSelect.value) {
      sourceSelect.value = selected;
    }
  }
}

function openAddTransaction() {
  resetTransactionForm();

  const selectedAccounts = Array.from(state.ui.selectedAccounts || []);
  if (selectedAccounts.length === 1) {
    const selected = selectedAccounts[0];

    const accountSelect = document.getElementById('f-account');
    const sourceSelect = document.getElementById('f-source-account');
    const existsInAccount = Array.from(accountSelect.options).some(opt => opt.value === selected);
    const existsInSource = Array.from(sourceSelect.options).some(opt => opt.value === selected);

    if (existsInAccount) {
      accountSelect.value = selected;
    }
    if (existsInSource) {
      sourceSelect.value = selected;
    }
  }

  document.getElementById('f-date').value =
    state.ui.lastNewTransactionDate || getMonthStartInput(state.ui.year, state.ui.month);

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
  document.getElementById('btn-save-and-new').style.display = 'none';

  const isTransfer = isTransferCategory(tx.category);
  const isIncome = tx.value > 0;
  const typeValue = isTransfer ? 'transferencia' : (isIncome ? 'receita' : 'despesa');
  setTransactionType(typeValue);

  // Fill common fields
  const installment = parseInstallment(tx.description);
  const baseDesc = installment ? installment.base : tx.description;
  document.getElementById('f-description').value = baseDesc;
  document.getElementById('desc-count').textContent = `${baseDesc.length}/30`;
  setAmountInputFromNumber(Math.abs(tx.value));

  // Convert date DD/MM/YYYY → YYYY-MM-DD for input
  const d = parseDate(tx.date);
  if (d) document.getElementById('f-date').value = formatDateInput(d);

  if (!isTransfer) {
    document.getElementById('f-account').value = tx.account || '';
    document.getElementById('f-category').value = tx.category || '';
    updateCategoryDisplay();
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
  document.getElementById('btn-save-and-new').style.display = 'none';

  setTransactionType('transferencia');

  const installment = parseInstallment(source.description);
  const baseDesc = installment ? installment.base : source.description;
  document.getElementById('f-description').value = baseDesc;
  document.getElementById('desc-count').textContent = `${baseDesc.length}/30`;
  setAmountInputFromNumber(Math.abs(source.value));

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
  hideDescriptionSuggestions();
  state.editingTransaction = null;
  state.editInstallmentMode = null;
}

// =============================================
// CATEGORY PICKER
// =============================================
function openCategoryPicker() {
  // Reset state
  state.categoryPicker = {
    selectedRoot: null,
    selectedSub1: null,
    selectedSub2: null,
    currentStep: 1,
    hasSub2Options: false,
  };
  
  // Show modal and render step 1
  document.getElementById('modal-category-picker').style.display = 'flex';
  clearCategoryPickerSearch();
  renderCategoryPickerStep1();
  updatePickerButtons();
}

function closeCategoryPicker() {
  document.getElementById('modal-category-picker').style.display = 'none';
  clearCategoryPickerSearch();
  state.categoryPicker = {
    selectedRoot: null,
    selectedSub1: null,
    selectedSub2: null,
    currentStep: 1,
    hasSub2Options: false,
  };
}

function getCategoryPickerRoots() {
  const { roots } = state.categoriesClassified;
  if (roots && Object.keys(roots).length > 0) {
    return roots;
  }

  const activeCategories = state.categories.filter(c => isActiveStatus(c.status));
  if (activeCategories.length === 0) {
    return {};
  }

  return activeCategories.reduce((acc, c) => {
    acc['Categorias'] = acc['Categorias'] || {};
    acc['Categorias'][c.name] = {};
    return acc;
  }, {});
}

function clearCategoryPickerSearch() {
  const input = document.getElementById('category-picker-search');
  const results = document.getElementById('category-search-results');
  if (input) {
    input.value = '';
  }
  if (results) {
    results.innerHTML = '';
    results.style.display = 'none';
  }
}

function hideCategoryPickerSearchResults() {
  const results = document.getElementById('category-search-results');
  if (!results) return;
  results.innerHTML = '';
  results.style.display = 'none';
}

function getCategoryPickerSearchEntries() {
  const roots = getCategoryPickerRoots();
  const entries = [
    {
      type: 'none',
      label: 'Sem Categoria',
      path: 'Sem Categoria',
    }
  ];

  Object.entries(roots).forEach(([rootName, sub1Obj]) => {
    if (rootName !== 'Sem Categoria') {
      const hasSub1 = !!sub1Obj && Object.keys(sub1Obj).length > 0;
      entries.push({
        type: 'root',
        label: rootName,
        path: rootName,
        root: rootName,
        hasSub1,
      });
    }

    if (!sub1Obj || typeof sub1Obj !== 'object') {
      return;
    }

    Object.entries(sub1Obj).forEach(([sub1Name, sub2Obj]) => {
      const hasSub2 = !!sub2Obj && Object.keys(sub2Obj).length > 0;
      entries.push({
        type: 'sub1',
        label: sub1Name,
        path: `${rootName} -> ${sub1Name}`,
        root: rootName,
        sub1: sub1Name,
        hasSub2,
      });

      if (!hasSub2) {
        return;
      }

      Object.keys(sub2Obj).forEach(sub2Name => {
        entries.push({
          type: 'sub2',
          label: sub2Name,
          path: `${rootName} -> ${sub1Name} -> ${sub2Name}`,
          root: rootName,
          sub1: sub1Name,
          sub2: sub2Name,
        });
      });
    });
  });

  return entries;
}

function applyCategoryPickerSearchSelection(entry) {
  if (!entry) return;

  if (entry.type === 'none') {
    document.getElementById('f-category').value = 'Sem Categoria';
    updateCategoryDisplay();
    closeCategoryPicker();
    return;
  }

  if (entry.type === 'root') {
    state.categoryPicker.selectedRoot = entry.root;
    state.categoryPicker.selectedSub1 = null;
    state.categoryPicker.selectedSub2 = null;
    state.categoryPicker.hasSub2Options = false;

    if (!entry.hasSub1) {
      document.getElementById('f-category').value = entry.root;
      updateCategoryDisplay();
      closeCategoryPicker();
      return;
    }

    hideCategoryPickerSearchResults();
    renderCategoryPickerStep2();
    updatePickerButtons();
    return;
  }

  if (entry.type === 'sub1') {
    state.categoryPicker.selectedRoot = entry.root;
    state.categoryPicker.selectedSub1 = entry.sub1;
    state.categoryPicker.selectedSub2 = null;
    state.categoryPicker.hasSub2Options = entry.hasSub2;

    if (!entry.hasSub2) {
      document.getElementById('f-category').value = entry.sub1;
      updateCategoryDisplay();
      closeCategoryPicker();
      return;
    }

    hideCategoryPickerSearchResults();
    renderCategoryPickerStep3();
    updatePickerButtons();
    return;
  }

  if (entry.type === 'sub2') {
    state.categoryPicker.selectedRoot = entry.root;
    state.categoryPicker.selectedSub1 = entry.sub1;
    state.categoryPicker.selectedSub2 = entry.sub2;
    document.getElementById('f-category').value = entry.sub2;
    updateCategoryDisplay();
    closeCategoryPicker();
  }
}

function renderCategoryPickerSearchResults(query) {
  const results = document.getElementById('category-search-results');
  if (!results) return;

  const normalized = normalizeText(query);
  if (!normalized) {
    results.innerHTML = '';
    results.style.display = 'none';
    return;
  }

  const matches = getCategoryPickerSearchEntries()
    .filter(entry => {
      const label = normalizeText(entry.label);
      return label.includes(normalized);
    })
    .slice(0, 30);

  results.innerHTML = '';
  results.style.display = 'grid';

  if (matches.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'picker-option disabled';
    empty.textContent = 'Nenhuma categoria encontrada';
    results.appendChild(empty);
    return;
  }

  matches.forEach(entry => {
    const option = document.createElement('div');
    option.className = 'picker-option';

    const title = document.createElement('div');
    title.textContent = entry.label;

    const path = document.createElement('div');
    path.className = 'picker-search-path';
    path.textContent = entry.path;

    option.appendChild(title);
    option.appendChild(path);
    option.addEventListener('click', () => applyCategoryPickerSearchSelection(entry));
    results.appendChild(option);
  });
}

function renderCategoryPickerStep1() {
  const roots = getCategoryPickerRoots();
  const container = document.getElementById('root-options');
  container.innerHTML = '';
  state.categoryPicker.currentStep = 1;
  state.categoryPicker.hasSub2Options = false;

  // Add "Sem Categoria" option
  const semCatBtn = document.createElement('div');
  semCatBtn.className = 'picker-option';
  semCatBtn.textContent = 'Sem Categoria';
  semCatBtn.addEventListener('click', () => {
    document.getElementById('f-category').value = 'Sem Categoria';
    updateCategoryDisplay();
    closeCategoryPicker();
  });
  container.appendChild(semCatBtn);

  // Add root categories
  Object.keys(roots).forEach(rootName => {
    if (rootName === 'Sem Categoria') {
      return;
    }

    const btn = document.createElement('div');
    btn.className = `picker-option ${state.categoryPicker.selectedRoot === rootName ? 'selected' : ''}`;
    btn.textContent = rootName;
    btn.addEventListener('click', () => {
      const selectedRootNode = roots[rootName] || {};
      const hasSub1 = Object.keys(selectedRootNode).length > 0;

      state.categoryPicker.selectedRoot = rootName;
      state.categoryPicker.selectedSub1 = null;
      state.categoryPicker.selectedSub2 = null;

      if (!hasSub1) {
        // Root without children is a valid leaf selection.
        state.categoryPicker.hasSub2Options = false;
        document.getElementById('f-category').value = rootName;
        updateCategoryDisplay();
        closeCategoryPicker();
        return;
      }

      state.categoryPicker.currentStep = 2;
      renderCategoryPickerStep2();
      updatePickerButtons();
    });
    container.appendChild(btn);
  });

  // Show step 1, hide others
  document.getElementById('step-root').classList.add('active');
  document.getElementById('step-sub1').classList.remove('active');
  document.getElementById('step-sub2').classList.remove('active');
  document.getElementById('step-sub2').style.display = '';
}

function renderCategoryPickerStep2() {
  const roots = getCategoryPickerRoots();
  const root = roots[state.categoryPicker.selectedRoot];
  const container = document.getElementById('sub1-options');
  container.innerHTML = '';
  state.categoryPicker.currentStep = 2;
  state.categoryPicker.hasSub2Options = false;

  if (!root) {
    renderCategoryPickerStep1();
    return;
  }

  Object.entries(root).forEach(([sub1Name, sub2Obj]) => {
    const btn = document.createElement('div');
    btn.className = `picker-option ${state.categoryPicker.selectedSub1 === sub1Name ? 'selected' : ''}`;
    btn.textContent = sub1Name;
    
    // Check if has Sub2 options
    const hasSub2 = sub2Obj && Object.keys(sub2Obj).length > 0;
    
    btn.addEventListener('click', () => {
      state.categoryPicker.selectedSub1 = sub1Name;
      state.categoryPicker.selectedSub2 = null;
      state.categoryPicker.hasSub2Options = hasSub2;
      
      if (hasSub2) {
        state.categoryPicker.currentStep = 3;
        renderCategoryPickerStep3();
      } else {
        // No sub2, so sub1 is the leaf
        document.getElementById('f-category').value = sub1Name;
        updateCategoryDisplay();
        closeCategoryPicker();
        return;
      }
      updatePickerButtons();
    });
    container.appendChild(btn);
  });

  // Show step 2
  document.getElementById('step-root').classList.remove('active');
  document.getElementById('step-sub1').classList.add('active');
  document.getElementById('step-sub2').classList.remove('active');
  document.getElementById('step-sub2').style.display = '';
}

function renderCategoryPickerStep3() {
  const roots = getCategoryPickerRoots();
  const root = roots[state.categoryPicker.selectedRoot];
  const sub2Obj = root && root[state.categoryPicker.selectedSub1];
  const container = document.getElementById('sub2-options');
  container.innerHTML = '';
  state.categoryPicker.currentStep = 3;

  if (!sub2Obj) {
    renderCategoryPickerStep2();
    return;
  }

  Object.keys(sub2Obj).forEach(sub2Name => {
    const btn = document.createElement('div');
    btn.className = `picker-option ${state.categoryPicker.selectedSub2 === sub2Name ? 'selected' : ''}`;
    btn.textContent = sub2Name;
    btn.addEventListener('click', () => {
      state.categoryPicker.selectedSub2 = sub2Name;
      document.getElementById('f-category').value = sub2Name;
      updateCategoryDisplay();
      closeCategoryPicker();
    });
    container.appendChild(btn);
  });

  // Show step 3
  document.getElementById('step-root').classList.remove('active');
  document.getElementById('step-sub1').classList.remove('active');
  document.getElementById('step-sub2').classList.add('active');
  document.getElementById('step-sub2').style.display = '';
}

function updatePickerButtons() {
  const backBtn = document.getElementById('btn-picker-back');
  const okBtn = document.getElementById('btn-picker-ok');
  
  // Show/hide back button based on current step
  if (state.categoryPicker.currentStep > 1) {
    backBtn.style.display = 'inline-flex';
  } else {
    backBtn.style.display = 'none';
  }
  
  // Enable/disable OK button
  if (state.categoryPicker.currentStep === 2) {
    okBtn.disabled = !state.categoryPicker.selectedSub1;
  } else if (state.categoryPicker.currentStep === 3) {
    // Step 3 is optional: allow confirming Sub1 or a selected Sub2.
    okBtn.disabled = !state.categoryPicker.selectedSub1;
  } else {
    okBtn.disabled = true;
  }
}

function handleCategoryPickerOK() {
  if (state.categoryPicker.currentStep === 2 && state.categoryPicker.hasSub2Options && state.categoryPicker.selectedSub1) {
    state.categoryPicker.currentStep = 3;
    renderCategoryPickerStep3();
    updatePickerButtons();
    return;
  }
  
  // Finalize selection
  let selected = '';
  if (state.categoryPicker.selectedSub2) {
    selected = state.categoryPicker.selectedSub2;
  } else if (state.categoryPicker.selectedSub1) {
    selected = state.categoryPicker.selectedSub1;
  }
  
  if (selected) {
    document.getElementById('f-category').value = selected;
    updateCategoryDisplay();
  }
  closeCategoryPicker();
}

function handleCategoryPickerBack() {
  if (state.categoryPicker.currentStep === 3) {
    state.categoryPicker.currentStep = 2;
    state.categoryPicker.selectedSub2 = null;
    renderCategoryPickerStep2();
  } else if (state.categoryPicker.currentStep === 2) {
    state.categoryPicker.currentStep = 1;
    state.categoryPicker.selectedSub1 = null;
    renderCategoryPickerStep1();
  }
  updatePickerButtons();
}

function updateCategoryDisplay() {
  const categoryValue = document.getElementById('f-category').value;
  const display = document.getElementById('category-picker-display');
  if (display) {
    display.textContent = categoryValue ? getCategoryPath(categoryValue) : 'Selecionar...';
  }
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
  const amount = getAmountInputValue();
  const date = document.getElementById('f-date').value;

  if (!desc) return 'Informe a descrição.';
  if (amount <= 0) return 'Informe um valor válido.';
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
  const amount = getAmountInputValue();
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
      state.ui.lastNewTransactionDate = dateInput;
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

async function handleSaveAndNewTransaction() {
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
  const amount = getAmountInputValue();
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
      closeTransactionModal();
    } else {
      await handleCreate(type, desc, amount, dateSheet, installmentType, installX, installY, tabTransactions);
      state.ui.lastNewTransactionDate = dateInput;
      // Instead of closing, open new transaction modal
      openAddTransaction();
    }

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

function changeMonth(delta) {
  let { month, year } = state.ui;
  month += delta;

  if (month < 1) {
    month = 12;
    year--;
  } else if (month > 12) {
    month = 1;
    year++;
  }

  state.ui.month = month;
  state.ui.year = year;
  state.ui.lastNewTransactionDate = getMonthStartInput(year, month);
  renderApp();
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
// SEARCH
// =============================================
function openSearchModal() {
  document.getElementById('modal-search').style.display = 'flex';
  const searchInput = document.getElementById('search-input');
  // Se já está em modo de pesquisa, mostra o termo anterior
  if (state.ui.searchMode) {
    searchInput.value = state.ui.searchTerm;
  } else {
    searchInput.value = '';
  }
  searchInput.focus();
}

function closeSearchModal() {
  document.getElementById('modal-search').style.display = 'none';
  state.ui.searchMode = false;
  state.ui.searchTerm = '';
  renderApp();
}

function performSearch() {
  const searchInput = document.getElementById('search-input');
  const term = searchInput.value.trim();
  
  if (!term) {
    showToast('Digite um termo para pesquisar', 'warning');
    return;
  }
  
  state.ui.searchMode = true;
  state.ui.searchTerm = term;
  document.getElementById('modal-search').style.display = 'none';
  renderApp();
}

function cancelSearch() {
  closeSearchModal();
}

function isModalOpen(modalId) {
  const modal = document.getElementById(modalId);
  return !!modal && modal.style.display === 'flex';
}

function isMainScreenActive() {
  const main = document.getElementById('screen-main');
  return !!main && main.classList.contains('active');
}

function pushBackGuardState() {
  if (!window.history || typeof window.history.pushState !== 'function') return;
  window.history.pushState({ backGuard: true }, '', window.location.href);
}

function closeTopModalForBack() {
  if (isModalOpen('modal-confirm')) {
    closeConfirmModal();
    return true;
  }

  if (isModalOpen('modal-category-picker')) {
    closeCategoryPicker();
    return true;
  }

  if (isModalOpen('modal-installment-edit')) {
    document.getElementById('modal-installment-edit').style.display = 'none';
    state.pendingInstallmentEdit = null;
    return true;
  }

  if (isModalOpen('modal-search')) {
    closeSearchModal();
    return true;
  }

  if (isModalOpen('modal-transaction')) {
    closeTransactionModal();
    return true;
  }

  return false;
}

function confirmExitApplication() {
  if (isModalOpen('modal-confirm')) return;

  showConfirmModal(
    'Sair do aplicativo?',
    'Deseja realmente sair do Minhas Economias?',
    () => {
      closeConfirmModal();
      state.ui.allowNextBackExit = true;
      if (window.history && typeof window.history.go === 'function') {
        window.history.go(-2);
      }
    },
    {
      okText: 'Sair',
      cancelText: 'Ficar',
    }
  );
}

function handleAppBackNavigation() {
  if (!isMainScreenActive()) return;

  if (state.ui.allowNextBackExit) {
    state.ui.allowNextBackExit = false;
    return;
  }

  if (closeTopModalForBack()) {
    pushBackGuardState();
    return;
  }

  confirmExitApplication();
  pushBackGuardState();
}

function setupMobileBackBehavior() {
  if (state.ui.backNavInitialized) return;
  if (!window.history || typeof window.history.pushState !== 'function') return;

  state.ui.backNavInitialized = true;
  pushBackGuardState();
  window.addEventListener('popstate', handleAppBackNavigation);
}

// =============================================
// EVENT LISTENERS
// =============================================
function bindEvents() {
  setupAmountInputMask();

  // Auth screen
  document.getElementById('btn-signin').addEventListener('click', signIn);

  // Main screen
  document.getElementById('btn-prev-month').addEventListener('click', () => {
    changeMonth(-1);
  });

  document.getElementById('btn-next-month').addEventListener('click', () => {
    changeMonth(1);
  });

  const mainScreen = document.getElementById('screen-main');
  if (mainScreen) {
    let touchStartX = 0;
    let touchStartY = 0;

    mainScreen.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    mainScreen.addEventListener('touchend', (e) => {
      if (e.changedTouches.length !== 1) return;
      if (document.getElementById('modal-transaction').style.display === 'flex') return;
      if (document.getElementById('modal-category-picker').style.display === 'flex') return;
      if (document.getElementById('modal-confirm').style.display === 'flex') return;

      const touchEndX = e.changedTouches[0].clientX;
      const touchEndY = e.changedTouches[0].clientY;
      const deltaX = touchEndX - touchStartX;
      const deltaY = touchEndY - touchStartY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      // Only trigger on deliberate horizontal swipes.
      if (absX < 50 || absX < absY * 1.2) return;

      if (deltaX < 0) {
        changeMonth(1);
      } else {
        changeMonth(-1);
      }
    }, { passive: true });
  }

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

  document.getElementById('btn-search').addEventListener('click', () => {
    openSearchModal();
  });

  // Search modal
  document.getElementById('btn-search-cancel').addEventListener('click', cancelSearch);
  document.getElementById('btn-search-submit').addEventListener('click', performSearch);
  
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        performSearch();
      }
    });
  }

  document.getElementById('btn-add').addEventListener('click', () => {
    populateSelects();
    openAddTransaction();
  });

  // Transaction modal
  document.getElementById('btn-modal-close').addEventListener('click', closeTransactionModal);
  document.getElementById('btn-cancel-transaction').addEventListener('click', closeTransactionModal);
  document.getElementById('form-transaction').addEventListener('submit', handleSaveTransaction);
  document.getElementById('btn-save-and-new').addEventListener('click', handleSaveAndNewTransaction);
  document.getElementById('btn-delete-transaction').addEventListener('click', handleDeleteTransaction);

  // Category picker modal
  document.getElementById('btn-picker-cancel').addEventListener('click', closeCategoryPicker);
  document.getElementById('btn-picker-ok').addEventListener('click', handleCategoryPickerOK);
  document.getElementById('btn-picker-back').addEventListener('click', handleCategoryPickerBack);

  const categoryPickerSearchInput = document.getElementById('category-picker-search');
  if (categoryPickerSearchInput) {
    categoryPickerSearchInput.addEventListener('input', e => {
      renderCategoryPickerSearchResults(e.target.value);
    });
  }

  // Category picker button
  const btnOpenCategoryPicker = document.getElementById('btn-open-category-picker');
  if (btnOpenCategoryPicker) {
    btnOpenCategoryPicker.addEventListener('click', (e) => {
      e.preventDefault();
      openCategoryPicker();
    });
  }

  // Type selector
  document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setTransactionType(btn.dataset.type);
    });
  });

  // Description char count
  document.getElementById('f-description').addEventListener('input', function () {
    document.getElementById('desc-count').textContent = `${this.value.length}/30`;
    renderDescriptionSuggestions(this.value);
  });

  document.getElementById('f-description').addEventListener('focus', function () {
    renderDescriptionSuggestions(this.value);
  });

  document.getElementById('f-amount').addEventListener('focus', () => {
    autoSelectCategoryFromDescription();
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
  setupMobileBackBehavior();

  showScreen('auth');
  initAuth();
}

document.addEventListener('DOMContentLoaded', init);
