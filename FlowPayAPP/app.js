/*
 * FlowPay – Vanilla JS + Supabase sync + недельная логика
 *
 * Этот файл содержит логику приложения. Были внесены изменения
 * для удаления верхнего линейного индикатора прогресса, добавления
 * кругового индикатора выполнения текущего плана и отображения
 * конвертации зарплаты в VND серым текстом. Также текст у
 * линейного прогресс-бара плана изменён: вместо процента
 * отображается фактически внесённая сумма.
 */

/* ===== SUPABASE CONFIG (заполнены, не трогаем) ===== */

const SUPABASE_URL = 'https://eugdcrnwutybqtbcjzfa.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV1Z2Rjcm53dXR5YnF0YmNqemZhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI4MDU0NDEsImV4cCI6MjA3ODM4MTQ0MX0.IzyyOsCcfEoue6lwnbjOkf0guoF49xOZ8AdM7Z61tLk';

const SUPABASE_TABLE = 'flowpay_state';
const SUPABASE_ROW_ID = 1;

/* ===== SUPABASE HELPERS ===== */

function hasSupabaseConfig() {
  return (
    typeof SUPABASE_URL === 'string' &&
    SUPABASE_URL.startsWith('https://') &&
    typeof SUPABASE_ANON_KEY === 'string' &&
    SUPABASE_ANON_KEY.length > 0
  );
}

async function loadStateFromSupabase() {
  if (!hasSupabaseConfig()) return null;

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?id=eq.${SUPABASE_ROW_ID}&select=state`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
      },
    );

    if (!res.ok) {
      console.warn('Supabase load error status:', res.status);
      return null;
    }

    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0 || !data[0].state) {
      return null;
    }
    return data[0].state;
  } catch (e) {
    console.warn('Supabase load failed:', e);
    return null;
  }
}

async function saveStateToSupabase(state) {
  if (!hasSupabaseConfig()) return;

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        id: SUPABASE_ROW_ID,
        state,
      }),
    });
  } catch (e) {
    console.warn('Supabase save failed:', e);
  }
}

/* ===== APP LOGIC ===== */

(function () {
  'use strict';

  const STATE_KEY = 'flowpay-state';

  const defaultState = {
    settings: {
      baseSalary: 125,
      plan1: { max: 1800, rate: 2 },
      plan2: { max: 2070, rate: 5 },
      plan3: { max: 2340, rate: 5.5 },
      plan4Plus: { rate: 6 },
      teamBonusEnabled: false,
    },
    deposits: [], // { date: 'YYYY-MM-DD', count, amount }
    goals: [], // { id: string, name: string, targetVnd: number, savedVnd: number }
  };

  let state;
  let editingGoalId = null;

  /* ---------- Helpers ---------- */

  function normalizeState(raw) {
    try {
      if (!raw || typeof raw !== 'object') {
        return structuredClone(defaultState);
      }
      return {
        settings: {
          ...defaultState.settings,
          ...(raw.settings || {}),
        },
        deposits: Array.isArray(raw.deposits) ? raw.deposits : [],
        goals: Array.isArray(raw.goals) ? raw.goals : [],
      };
    } catch (e) {
      console.error('Failed to normalize state', e);
      return structuredClone(defaultState);
    }
  }

  function loadStateFromLocal() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (!raw) return structuredClone(defaultState);
      return normalizeState(JSON.parse(raw));
    } catch {
      return structuredClone(defaultState);
    }
  }

  function saveStateToLocal() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Failed to save state to localStorage', e);
    }
  }

  function persistState() {
    saveStateToLocal();
    if (hasSupabaseConfig()) {
      saveStateToSupabase(state);
    }
  }

  function formatCurrency(v) {
    return '$' + (Number(v) || 0).toFixed(2);
  }

  /**
   * Conversion rate from USD to Vietnamese dong. This constant approximates the
   * mid-market rate around mid-November 2025 (1 USD ≈ 26 350 VND)【665634502050038†L37-L74】. If a more
   * up-to-date rate is required, update this value accordingly.
   */
  const USD_TO_VND = 26350;

  /**
   * Format a number as VND with grouping separators. Does not include decimals,
   * since VND is a zero‑decimal currency.
   *
   * @param {number} amount
   * @returns {string}
   */
  function formatVND(amount) {
    const n = Number(amount) || 0;
    return n.toLocaleString('vi-VN');
  }

  /**
   * Format VND number with dots as thousands separators (e.g., "15.000.000")
   * @param {number} amount
   * @returns {string}
   */
  function formatVNDWithDots(amount) {
    const n = Number(amount) || 0;
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  /**
   * Calculates the progress within the currently active plan.
   * The returned value is between 0 and 1, where 0 means the current plan
   * has not started and 1 means the current plan is completed. If the user
   * exceeds the last defined plan (plan3), 1 is returned.
   *
   * @param {number} total - total deposits for this week
   * @returns {number}
   */
  function calculateCurrentPlanProgress(total) {
    const { plan1, plan2, plan3 } = state.settings;
    if (total < plan1.max) {
      return total / plan1.max;
    }
    if (total < plan2.max) {
      return (total - plan1.max) / (plan2.max - plan1.max);
    }
    if (total < plan3.max) {
      return (total - plan2.max) / (plan3.max - plan2.max);
    }
    // For Plan 4+, we consider progress complete
    return 1;
  }

  /* ---------- Week logic ---------- */

  // ISO week: Monday–Sunday
  function getWeekRange(date = new Date()) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = d.getUTCDay() || 7; // 1-7, Monday=1
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - (day - 1));
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    const toStr = (dt) => dt.toISOString().slice(0, 10);
    return { start: toStr(monday), end: toStr(sunday) };
  }

  function isThisWeek(dateStr) {
    const { start, end } = getWeekRange(new Date());
    return dateStr >= start && dateStr <= end;
  }

  function getDepositsThisWeek() {
    return state.deposits.filter((d) => isThisWeek(d.date));
  }

  function getTotalAmountThisWeek() {
    return getDepositsThisWeek().reduce(
      (s, d) => s + Number(d.amount || 0),
      0,
    );
  }

  /* ---------- Plan / salary calc (только текущая неделя) ---------- */

  function getActivePlan(total) {
    const { plan1, plan2, plan3, plan4Plus } = state.settings;
    if (total < plan1.max)
      return { name: 'План 1', rate: plan1.rate, max: plan1.max, min: 0, index: 1 };
    if (total < plan2.max)
      return { name: 'План 2', rate: plan2.rate, max: plan2.max, min: plan1.max, index: 2 };
    if (total < plan3.max)
      return { name: 'План 3', rate: plan3.rate, max: plan3.max, min: plan2.max, index: 3 };
    return { name: 'План 4+', rate: plan4Plus.rate, max: Infinity, min: plan3.max, index: 4 };
  }

  function getEffectiveRate(baseRate) {
    return baseRate + (state.settings.teamBonusEnabled ? 1 : 0);
  }

  function calculateCommission(total) {
    const plan = getActivePlan(total);
    const rate = getEffectiveRate(plan.rate);
    return (total * rate) / 100;
  }

  function calculatePlanCompletion(total) {
    const threshold = state.settings.plan3.max;
    return Math.min(total / threshold, 1);
  }

  /* ---------- UI helpers ---------- */

  function setTodayDate() {
    const el = document.getElementById('current-date');
    if (!el) return;
    const now = new Date();
    const options = {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    };
    el.textContent = now.toLocaleDateString('en-US', options);
  }

  function buildPlanCards(total) {
    const plans = [];
    const { plan1, plan2, plan3, plan4Plus } = state.settings;
    const active = getActivePlan(total);

    const defs = [
      { name: 'План 1', min: 0, max: plan1.max, rate: plan1.rate },
      { name: 'План 2', min: plan1.max, max: plan2.max, rate: plan2.rate },
      { name: 'План 3', min: plan2.max, max: plan3.max, rate: plan3.rate },
      { name: 'План 4+', min: plan3.max, max: Infinity, rate: plan4Plus.rate },
    ];

    defs.forEach((def) => {
      const card = document.createElement('div');
      card.className = 'plan-card card';
      if (def.name === active.name) {
        card.classList.add('current');
        const pill = document.createElement('div');
        pill.className = 'plan-card-pill';
        pill.textContent = 'Текущий';
        card.appendChild(pill);
      }

      const title = document.createElement('div');
      title.className = 'plan-card-title';
      title.textContent = def.name;
      card.appendChild(title);

      const range = document.createElement('div');
      range.className = 'plan-card-range';
      if (def.max === Infinity) {
        range.textContent = `≥ ${formatCurrency(def.min)} → ${def.rate}% от депозитов`;
      } else {
        range.textContent = `${formatCurrency(def.min)} – ${formatCurrency(
          def.max,
        )} → ${def.rate}% от депозитов`;
      }
      card.appendChild(range);

      let progress;
      if (def.max === Infinity) {
        progress = total >= def.min ? 1 : 0;
      } else if (total <= def.min) {
        progress = 0;
      } else if (total >= def.max) {
        progress = 1;
      } else {
        progress = (total - def.min) / (def.max - def.min);
      }
      progress = Math.max(0, Math.min(progress, 1));
      const progressPercent = Math.round(progress * 100);
      
      // Add completed class if plan is 100% complete
      if (progress === 1) {
        card.classList.add('plan-card--completed');
      }

      let remaining;
      if (def.max === Infinity) {
        remaining = total < def.min ? def.min - total : 0;
      } else {
        remaining = total < def.max ? def.max - total : 0;
      }

      let potential = null;
      if (def.max !== Infinity) {
        potential = ((def.max - def.min) * def.rate) / 100;
      }

      const info1 = document.createElement('div');
      info1.className = 'plan-card-info';
      info1.textContent = `% выполнения: ${progressPercent}%`;
      card.appendChild(info1);

      const info2 = document.createElement('div');
      info2.className = 'plan-card-info';
      if (def.max === Infinity) {
        info2.textContent =
          total < def.min
            ? `Осталось до плана: ${formatCurrency(remaining)}`
            : 'План выполнен';
      } else {
        info2.textContent =
          total >= def.max
            ? 'План выполнен'
            : `Осталось до плана: ${formatCurrency(remaining)}`;
      }
      card.appendChild(info2);

      const info3 = document.createElement('div');
      info3.className = 'plan-card-info';
      info3.textContent =
        potential == null
          ? `Доход: ${def.rate}% от депозитов`
          : `Заработок при выполнении: ${formatCurrency(potential)}`;
      card.appendChild(info3);

      plans.push(card);
    });

    return plans;
  }

  function renderDashboardSummary() {
    const totalWeek = getTotalAmountThisWeek();
    const active = getActivePlan(totalWeek);
    const commission = calculateCommission(totalWeek);
    const totalSalary = Number(state.settings.baseSalary) + commission;

    document.getElementById('base-salary-value').textContent =
      formatCurrency(state.settings.baseSalary);
    document.getElementById('commission-value').textContent =
      formatCurrency(commission);
    document.getElementById('active-plan-value').textContent =
      `${active.name} — ${active.rate}%`;
    document.getElementById('team-bonus-value').textContent =
      state.settings.teamBonusEnabled ? '1%' : '0%';
    document.getElementById('total-salary').textContent =
      formatCurrency(totalSalary);
    document.getElementById('team-bonus-toggle').checked =
      !!state.settings.teamBonusEnabled;

    // Show VND conversion below total salary. Multiply by a constant rate.
    const vndEl = document.getElementById('total-salary-vnd');
    if (vndEl) {
      const vndTotal = totalSalary * USD_TO_VND;
      // Display approximate VND amount with currency symbol
      vndEl.textContent = `≈ ${formatVND(vndTotal)} ₫`;
    }
  }

  function renderDashboardPlans() {
    const totalWeek = getTotalAmountThisWeek();
    const ratio = calculatePlanCompletion(totalWeek);
    const percent = Math.round(ratio * 100);
    const plan3Max = state.settings.plan3.max;

    // Update bottom progress bar width
    const progressFill = document.getElementById('plan-progress-fill');
    if (progressFill) progressFill.style.width = percent + '%';

    // Update bottom progress bar text to show deposited amount instead of percent
    const progressText = document.getElementById('plan-progress-text');
    if (progressText) {
      progressText.textContent =
        `Внесено ${formatCurrency(totalWeek)} из ${formatCurrency(plan3Max)}`;
    }

    // Update circular progress indicator for current plan
    const circle = document.getElementById('plan-progress-circle');
    const label = document.getElementById('plan-progress-circle-label');
    if (circle && label) {
      const currentProgress = calculateCurrentPlanProgress(totalWeek);
      const planPercent = Math.round(currentProgress * 100);
      label.textContent = planPercent + '%';
      const deg = planPercent * 3.6;
      // Green color scheme for progress circle
      const progressColor = '#22c55e';
      const trackColor = 'rgba(34, 197, 94, 0.15)';
      circle.style.background = `conic-gradient(${progressColor} 0deg ${deg}deg, ${trackColor} ${deg}deg 360deg)`;
    }

    const cont = document.getElementById('dashboard-plan-cards');
    if (cont) {
      cont.innerHTML = '';
      buildPlanCards(totalWeek).forEach((c) => cont.appendChild(c));
    }

    // Optionally update removed overall-progress elements safely
    const overallPercentEl = document.getElementById('overall-progress-percent');
    const overallFillEl = document.getElementById('overall-progress-fill');
    if (overallPercentEl) overallPercentEl.textContent = percent + '%';
    if (overallFillEl) overallFillEl.style.width = percent + '%';
  }

  function renderPlanDetail() {
    const totalWeek = getTotalAmountThisWeek();
    const ratio = calculatePlanCompletion(totalWeek);
    const percent = Math.round(ratio * 100);
    const plan3Max = state.settings.plan3.max;

    const fill = document.getElementById('plan-detail-fill');
    fill.style.width = percent + '%';

    document.getElementById('plan-detail-text').textContent =
      `Прогресс: ${formatCurrency(totalWeek)} из ${formatCurrency(
        plan3Max,
      )} (${percent}%)`;

    const markers = document.getElementById('plan-markers');
    markers.innerHTML = '';
    [state.settings.plan1.max, state.settings.plan2.max, state.settings.plan3.max]
      .forEach((value) => {
        const m = document.createElement('div');
        m.className = 'marker';
        const r = Math.min(value / plan3Max, 1);
        m.style.left = (r * 100) + '%';
        m.title = formatCurrency(value);
        markers.appendChild(m);
      });

    const detail = document.getElementById('detail-plan-cards');
    detail.innerHTML = '';
    buildPlanCards(totalWeek).forEach((c) =>
      detail.appendChild(c.cloneNode(true)),
    );
  }

  /* ---------- Savings / Goals ---------- */

  function renderSavingsGoals() {
    const container = document.getElementById('savings-goals-list');
    if (!container) return;

    container.innerHTML = '';

    if (!state.goals || state.goals.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'savings-empty';
      emptyMsg.textContent = 'No goals yet. Create your first goal to start saving!';
      container.appendChild(emptyMsg);
      return;
    }

    state.goals.forEach((goal) => {
      const card = document.createElement('div');
      card.className = 'goal-card card';

      const isCompleted = goal.savedVnd >= goal.targetVnd;
      const percent = Math.min((goal.savedVnd / goal.targetVnd) * 100, 100);
      const percentRounded = Math.round(percent);

      if (isCompleted) {
        card.classList.add('goal-card--completed');
      }

      const header = document.createElement('div');
      header.className = 'goal-card-header';

      const titleSection = document.createElement('div');
      titleSection.className = 'goal-card-title';

      const nameDiv = document.createElement('div');
      nameDiv.className = 'goal-name';
      nameDiv.textContent = goal.name;

      titleSection.appendChild(nameDiv);

      if (isCompleted) {
        const iconDiv = document.createElement('div');
        iconDiv.className = 'goal-completed-icon';
        iconDiv.textContent = '✅';
        titleSection.appendChild(iconDiv);
      }

      const editBtn = document.createElement('button');
      editBtn.className = 'goal-edit-btn';
      editBtn.setAttribute('data-goal-id', goal.id);
      editBtn.textContent = 'Edit';
      titleSection.appendChild(editBtn);

      header.appendChild(titleSection);

      const topRight = document.createElement('div');
      topRight.className = 'goal-card-top-right';

      const circle = document.createElement('div');
      circle.className = 'goal-progress-circle';
      const circleSpan = document.createElement('span');
      circleSpan.textContent = percentRounded + '%';
      circle.appendChild(circleSpan);
      const deg = percentRounded * 3.6;
      const progressColor = '#22c55e';
      const trackColor = 'rgba(34, 197, 94, 0.15)';
      circle.style.background = `conic-gradient(${progressColor} 0deg ${deg}deg, ${trackColor} ${deg}deg 360deg)`;

      topRight.appendChild(circle);

      const targetDiv = document.createElement('div');
      targetDiv.className = 'goal-target-amount';
      targetDiv.textContent = formatVNDWithDots(goal.targetVnd);
      topRight.appendChild(targetDiv);

      header.appendChild(topRight);
      card.appendChild(header);

      const progressBar = document.createElement('div');
      progressBar.className = 'goal-progress-bar';
      const progressFill = document.createElement('div');
      progressFill.className = 'goal-progress-fill';
      progressFill.style.width = percent + '%';
      progressBar.appendChild(progressFill);
      card.appendChild(progressBar);

      const progressText = document.createElement('div');
      progressText.className = 'goal-progress-text';
      progressText.textContent =
        `Внесено ${formatVNDWithDots(goal.savedVnd)} из ${formatVNDWithDots(goal.targetVnd)}`;
      card.appendChild(progressText);

      container.appendChild(card);
    });
  }

  function openGoalModal() {
    editingGoalId = null;
    document.getElementById('goal-name-input').value = '';
    document.getElementById('goal-target-input').value = '';
    const savedLabel = document.getElementById('goal-saved-label');
    const savedInput = document.getElementById('goal-saved-input');
    savedLabel.classList.add('hidden');
    savedInput.value = '';
    const modalTitle = document.querySelector('#goal-modal-overlay .modal-header h3');
    modalTitle.textContent = 'Add goal';
    const saveBtn = document.getElementById('save-goal');
    saveBtn.textContent = 'Save';
    document.getElementById('goal-modal-overlay').classList.remove('hidden');
  }

  function openEditGoalModal(goalId) {
    const goal = state.goals.find((g) => g.id === goalId);
    if (!goal) return;

    editingGoalId = goalId;
    document.getElementById('goal-name-input').value = goal.name;
    document.getElementById('goal-target-input').value = goal.targetVnd;
    const savedLabel = document.getElementById('goal-saved-label');
    const savedInput = document.getElementById('goal-saved-input');
    savedLabel.classList.remove('hidden');
    savedInput.value = goal.savedVnd || 0;
    const modalTitle = document.querySelector('#goal-modal-overlay .modal-header h3');
    modalTitle.textContent = 'Edit goal';
    const saveBtn = document.getElementById('save-goal');
    saveBtn.textContent = 'Save changes';
    document.getElementById('goal-modal-overlay').classList.remove('hidden');
  }

  function closeGoalModal() {
    editingGoalId = null;
    document.getElementById('goal-modal-overlay').classList.add('hidden');
  }

  function openMoneyModal() {
    if (!state.goals || state.goals.length === 0) return;

    const select = document.getElementById('money-goal-select');
    select.innerHTML = '';
    state.goals.forEach((goal) => {
      const option = document.createElement('option');
      option.value = goal.id;
      option.textContent = goal.name;
      select.appendChild(option);
    });

    document.getElementById('money-amount-input').value = '';
    document.getElementById('money-modal-overlay').classList.remove('hidden');
  }

  function closeMoneyModal() {
    document.getElementById('money-modal-overlay').classList.add('hidden');
  }

  function showToast(text) {
    const toast = document.getElementById('deposit-success-toast');
    if (!toast) return;
    const textEl = toast.querySelector('.deposit-toast-text');
    if (textEl) textEl.textContent = text;
    toast.classList.remove('hidden', 'show');
    void toast.offsetWidth;
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.classList.add('hidden'), 400);
    }, 1800);
  }

  function handleSaveGoal() {
    const name = document.getElementById('goal-name-input').value.trim();
    const targetVnd = parseFloat(document.getElementById('goal-target-input').value);

    if (!name || isNaN(targetVnd) || targetVnd <= 0) return;

    if (editingGoalId) {
      // Edit existing goal
      const goal = state.goals.find((g) => g.id === editingGoalId);
      if (!goal) return;

      const savedVnd = parseFloat(document.getElementById('goal-saved-input').value);
      if (isNaN(savedVnd) || savedVnd < 0) return;

      goal.name = name;
      goal.targetVnd = Number(targetVnd);
      goal.savedVnd = Number(savedVnd);

      persistState();
      renderSavingsGoals();
      closeGoalModal();
      showToast('Цель обновлена');
    } else {
      // Create new goal
      const newGoal = {
        id: 'goal-' + Date.now(),
        name,
        targetVnd: Number(targetVnd),
        savedVnd: 0,
      };

      if (!state.goals) state.goals = [];
      state.goals.push(newGoal);
      persistState();
      renderSavingsGoals();
      closeGoalModal();
      showToast('Цель добавлена');
    }
  }

  function handleSaveMoney() {
    const goalId = document.getElementById('money-goal-select').value;
    const amount = parseFloat(document.getElementById('money-amount-input').value);

    if (!goalId || isNaN(amount) || amount <= 0) return;

    const goal = state.goals.find((g) => g.id === goalId);
    if (!goal) return;

    goal.savedVnd = (goal.savedVnd || 0) + Number(amount);
    persistState();
    renderSavingsGoals();
    closeMoneyModal();
    showToast('Деньги добавлены');
  }

  /* ---------- History (all deposits) ---------- */

  function keyToLabel(key) {
    if (/^\d{4}-W\d{2}$/.test(key)) {
      const [year, week] = key.split('-W');
      return `Неделя ${week}, ${year}`;
    }
    if (/^\d{4}-\d{2}$/.test(key)) {
      const [y, m] = key.split('-');
      const d = new Date(Number(y), Number(m) - 1);
      const name = d.toLocaleString('ru-RU', { month: 'long' });
      return name.charAt(0).toUpperCase() + name.slice(1) + ` ${y}`;
    }
    const [yyyy, mm, dd] = key.split('-');
    return `${dd}.${mm}.${yyyy}`;
  }

  function getWeekKey(dateStr) {
    const d = new Date(dateStr);
    const dayNum = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dayNum + 3);
    const weekYear = d.getUTCFullYear();
    const jan4 = new Date(Date.UTC(weekYear, 0, 4));
    const diff = (d - jan4) / 86400000;
    const week = 1 + Math.floor(diff / 7);
    return `${weekYear}-W${String(week).padStart(2, '0')}`;
  }

  function getMonthKey(dateStr) {
    const [y, m] = dateStr.split('-');
    return `${y}-${m}`;
  }

  function aggregateBy(deposits, keyFn) {
    const map = {};
    deposits.forEach((d) => {
      const key = keyFn(d);
      if (!map[key]) map[key] = { raw: key, count: 0, amount: 0 };
      map[key].count += Number(d.count || 0);
      map[key].amount += Number(d.amount || 0);
    });

    const res = Object.keys(map).map((key) => {
      const e = map[key];
      const salary = calculateCommission(e.amount);
      return {
        raw: e.raw,
        label: keyToLabel(key),
        count: e.count,
        amount: e.amount,
        salary,
      };
    });

    return res.sort((a, b) => (a.raw < b.raw ? 1 : -1));
  }

  function createHistoryRow(label, count, amount, salary, onDelete) {
    const row = document.createElement('div');
    row.className = 'history-item';
    const span = document.createElement('span');
    const word = count === 1 ? 'депозит' : 'депозитов';
    span.textContent =
      `${label} — ${count} ${word} — Общая сумма: ${formatCurrency(amount)} — ЗП (по плану): ${formatCurrency(salary)}`;
    row.appendChild(span);

    if (onDelete) {
      const del = document.createElement('button');
      del.className = 'delete-btn';
      del.textContent = '×';
      del.title = 'Удалить записи';
      del.onclick = onDelete;
      row.appendChild(del);
    }

    return row;
  }

  function renderHistory() {
    const days = document.getElementById('history-days');
    const weeks = document.getElementById('history-weeks');
    const months = document.getElementById('history-months');
    days.innerHTML = '';
    weeks.innerHTML = '';
    months.innerHTML = '';

    // По дням + возможность удалить день
    const daily = aggregateBy(state.deposits, (d) => d.date);
    daily.forEach((item) => {
      const row = createHistoryRow(
        item.label,
        item.count,
        item.amount,
        item.salary,
        () => {
          state.deposits = state.deposits.filter((d) => d.date !== item.raw);
          persistState();
          updateAll();
        },
      );
      days.appendChild(row);
    });

    // По неделям
    const weekly = aggregateBy(state.deposits, (d) => getWeekKey(d.date));
    weekly.forEach((i) =>
      weeks.appendChild(
        createHistoryRow(i.label, i.count, i.amount, i.salary),
      ),
    );

    // По месяцам
    const monthly = aggregateBy(state.deposits, (d) => getMonthKey(d.date));
    monthly.forEach((i) =>
      months.appendChild(
        createHistoryRow(i.label, i.count, i.amount, i.salary),
      ),
    );
  }

  /* ---------- Modal ---------- */

  function openDepositModal() {
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('deposit-date').value = today;
    document.getElementById('deposit-count').value = 1;
    document.getElementById('deposit-amount').value = '';
    const btn = document.getElementById('save-deposit');
    btn.classList.remove('success');
    btn.textContent = 'Сохранить';
    document
      .getElementById('deposit-modal-overlay')
      .classList.remove('hidden');
  }

  function closeDepositModal() {
    document.getElementById('deposit-modal-overlay').classList.add('hidden');
  }

  function showDepositSuccessToast() {
    const toast = document.getElementById('deposit-success-toast');
    if (!toast) return;
    toast.classList.remove('hidden', 'show');
    void toast.offsetWidth;
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.classList.add('hidden'), 400);
    }, 1800);
  }

  function handleSaveDeposit() {
    const date = document.getElementById('deposit-date').value;
    const count = parseInt(
      document.getElementById('deposit-count').value,
      10,
    );
    const amount = parseFloat(
      document.getElementById('deposit-amount').value,
    );
    if (!date || isNaN(count) || isNaN(amount) || count <= 0 || amount < 0)
      return;

    state.deposits.push({ date, count, amount });
    persistState();
    updateAll();

    const btn = document.getElementById('save-deposit');
    btn.textContent = 'Успешно';
    btn.classList.add('success');

    setTimeout(() => {
      closeDepositModal();
      showDepositSuccessToast();
    }, 800);
  }

  /* ---------- Settings ---------- */

  function populateSettingsForm() {
    document.getElementById('base-salary-input').value =
      state.settings.baseSalary;
    document.querySelectorAll('.plan-max-input').forEach((input) => {
      const planKey = input.dataset.plan;
      input.value = state.settings[planKey].max ?? '';
    });
    document.querySelectorAll('.plan-rate-input').forEach((input) => {
      const planKey = input.dataset.plan;
      input.value = state.settings[planKey].rate;
    });
  }

  function handleSaveSettings() {
    const base = parseFloat(
      document.getElementById('base-salary-input').value,
    );
    if (isNaN(base) || base < 0) return;

    const next = structuredClone(state.settings);
    next.baseSalary = base;

    let ok = true;
    document.querySelectorAll('.plan-max-input').forEach((input) => {
      const key = input.dataset.plan;
      const v = parseFloat(input.value);
      if (isNaN(v) || v < 0) ok = false;
      next[key].max = v;
    });
    document.querySelectorAll('.plan-rate-input').forEach((input) => {
      const key = input.dataset.plan;
      const v = parseFloat(input.value);
      if (isNaN(v) || v < 0) ok = false;
      next[key].rate = v;
    });

    if (!(next.plan1.max < next.plan2.max && next.plan2.max < next.plan3.max)) {
      ok = false;
    }
    if (!ok) return;

    state.settings = next;
    persistState();
    updateAll();

    const btn = document.getElementById('save-settings');
    btn.textContent = 'Сохранено';
    btn.classList.add('success');
    setTimeout(() => {
      btn.textContent = 'Сохранить настройки';
      btn.classList.remove('success');
    }, 1200);
  }

  /* ---------- Navigation & listeners ---------- */

  function initEventListeners() {
    // Навигация
    document.querySelectorAll('.nav-item').forEach((item) => {
      item.addEventListener('click', () => {
        const section = item.dataset.section;

        document.querySelectorAll('.nav-item').forEach((b) => {
          b.classList.toggle('active', b === item);
        });

        document.querySelectorAll('.section').forEach((sec) => {
          sec.classList.toggle('active', sec.id === section);
        });

        if (section === 'history') renderHistory();
        if (section === 'plan') renderPlanDetail();
        if (section === 'settings') populateSettingsForm();
        if (section === 'savings') renderSavingsGoals();

        const sidebar = document.querySelector('.sidebar');
        if (sidebar && sidebar.classList.contains('sidebar-open')) {
          sidebar.classList.remove('sidebar-open');
          document.body.classList.remove('sidebar-open');
        }
      });
    });

    // Mobile sidebar
    const sidebar = document.querySelector('.sidebar');
    const mobileToggle = document.getElementById('mobile-sidebar-toggle');
    if (mobileToggle && sidebar) {
      mobileToggle.addEventListener('click', () => {
        const isOpen = sidebar.classList.toggle('sidebar-open');
        document.body.classList.toggle('sidebar-open', isOpen);
      });
    }

    // Modal
    const modalOverlay = document.getElementById('deposit-modal-overlay');
    document
      .getElementById('open-deposit-modal')
      .addEventListener('click', openDepositModal);
    document
      .getElementById('close-deposit-modal')
      .addEventListener('click', closeDepositModal);
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closeDepositModal();
    });
    document
      .getElementById('save-deposit')
      .addEventListener('click', handleSaveDeposit);

    // History tabs
    document.querySelectorAll('.history-tabs .tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const view = tab.dataset.view;
        document.querySelectorAll('.history-tabs .tab')
          .forEach((t) => t.classList.toggle('active', t === tab));
        document.querySelectorAll('.history-list')
          .forEach((list) =>
            list.classList.toggle('hidden', list.id !== 'history-' + view),
          );
      });
    });

    // Team bonus
    document
      .getElementById('team-bonus-toggle')
      .addEventListener('change', (e) => {
        state.settings.teamBonusEnabled = e.target.checked;
        persistState();
        updateAll();
      });

    // Save settings
    document
      .getElementById('save-settings')
      .addEventListener('click', handleSaveSettings);

    // Savings modals
    document
      .getElementById('open-goal-modal')
      .addEventListener('click', openGoalModal);
    document
      .getElementById('close-goal-modal')
      .addEventListener('click', closeGoalModal);
    document
      .getElementById('goal-modal-overlay')
      .addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeGoalModal();
      });
    document
      .getElementById('save-goal')
      .addEventListener('click', handleSaveGoal);

    document
      .getElementById('open-money-modal')
      .addEventListener('click', openMoneyModal);
    document
      .getElementById('close-money-modal')
      .addEventListener('click', closeMoneyModal);
    document
      .getElementById('money-modal-overlay')
      .addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeMoneyModal();
      });
    document
      .getElementById('save-money')
      .addEventListener('click', handleSaveMoney);

    // Goal edit buttons (delegated event listener)
    const savingsGoalsList = document.getElementById('savings-goals-list');
    if (savingsGoalsList) {
      savingsGoalsList.addEventListener('click', (e) => {
        if (e.target.classList.contains('goal-edit-btn')) {
          const goalId = e.target.getAttribute('data-goal-id');
          if (goalId) openEditGoalModal(goalId);
        }
      });
    }
  }

  /* ---------- Init ---------- */

  async function init() {
    state = loadStateFromLocal();

    if (hasSupabaseConfig()) {
      const remote = await loadStateFromSupabase();
      if (remote) {
        state = normalizeState(remote);
        saveStateToLocal();
      } else {
        await saveStateToSupabase(state);
      }
    }

    setTodayDate();
    initEventListeners();
    populateSettingsForm();
    updateAll();
  }

  function updateAll() {
    renderDashboardSummary();
    renderDashboardPlans();
    if (document.getElementById('plan').classList.contains('active')) {
      renderPlanDetail();
    }
    if (document.getElementById('history').classList.contains('active')) {
      renderHistory();
    }
    if (document.getElementById('savings') && document.getElementById('savings').classList.contains('active')) {
      renderSavingsGoals();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const splash = document.getElementById('splash');
    if (splash) {
      setTimeout(() => {
        splash.classList.add('splash-hidden');
        setTimeout(() => {
          if (splash.parentNode) splash.parentNode.removeChild(splash);
        }, 1000);
      }, 1500);
    }
    init();
  });
})();