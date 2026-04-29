/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  PIXELFORGE — Productivity Dashboard                         ║
 * ║  script.js — Core Application Logic                          ║
 * ║  Author: Soltani Seyf Eddine                                 ║
 * ║                                                              ║
 * ║  Architecture: Module pattern — no globals leaking.          ║
 * ║  Each system (XP, Tasks, Pomodoro, Notes) is self-contained. ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

/* ─────────────────────────────────────────
   CONFIG — single source of truth for game
   balance and timing constants
   ───────────────────────────────────────── */
const CONFIG = {
  // XP required to reach each level (index = level - 1)
  // Level N needs XP_PER_LEVEL[N-1] XP to level up
  XP_PER_LEVEL: 100,          // Base XP per level; scales with level
  XP_SCALE: 1.3,              // Each level costs 30% more XP

  // XP rewards by difficulty
  XP_REWARDS: {
    easy:   10,
    medium: 25,
    hard:   50,
    boss:   100,
  },

  // Pomodoro defaults (in seconds)
  TIMER_MODES: {
    work:  25 * 60,
    short:  5 * 60,
    long:  15 * 60,
  },

  // localStorage keys
  STORAGE_KEYS: {
    tasks:    'pf_tasks',
    xp:       'pf_xp',
    level:    'pf_level',
    sessions: 'pf_sessions',
    streak:   'pf_streak',
    lastDay:  'pf_last_day',
    notes:    'pf_notes',
    stats:    'pf_stats',
    ach:      'pf_achievements',
  },
};

/* ─────────────────────────────────────────
   STATE — runtime application state
   ───────────────────────────────────────── */
const STATE = {
  // Player
  xp:    0,
  level: 1,

  // Derived: XP needed for next level
  get xpForNextLevel() {
    return Math.floor(CONFIG.XP_PER_LEVEL * Math.pow(CONFIG.XP_SCALE, this.level - 1));
  },

  // Tasks
  tasks: [],
  selectedDiff: 'easy',

  // Pomodoro
  timerMode:     'work',
  timerDuration: CONFIG.TIMER_MODES.work,
  timerRemaining: CONFIG.TIMER_MODES.work,
  timerRunning:  false,
  timerInterval: null,
  sessionsToday: 0,

  // Stats & streaks
  stats: {
    completed: 0,
    totalXp:   0,
    bossSlain: 0,
    streak:    0,
    lastDay:   null,
  },

  // Achievements unlocked
  achievements: [],
};

/* ═══════════════════════════════════════════
   PERSISTENCE — localStorage helpers
   ═══════════════════════════════════════════ */
const Storage = {
  /** Save a value to localStorage as JSON */
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn('[PixelForge] Storage write failed:', e);
    }
  },

  /** Load a value from localStorage, with optional default */
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  },

  /** Persist the entire game state */
  saveAll() {
    const k = CONFIG.STORAGE_KEYS;
    Storage.set(k.tasks,    STATE.tasks);
    Storage.set(k.xp,       STATE.xp);
    Storage.set(k.level,    STATE.level);
    Storage.set(k.sessions, STATE.sessionsToday);
    Storage.set(k.stats,    STATE.stats);
    Storage.set(k.ach,      STATE.achievements);
  },

  /** Load the entire game state from storage */
  loadAll() {
    const k = CONFIG.STORAGE_KEYS;
    STATE.tasks         = Storage.get(k.tasks,    []);
    STATE.xp            = Storage.get(k.xp,       0);
    STATE.level         = Storage.get(k.level,    1);
    STATE.sessionsToday = Storage.get(k.sessions, 0);
    STATE.stats         = Storage.get(k.stats, {
      completed: 0, totalXp: 0, bossSlain: 0, streak: 0, lastDay: null,
    });
    STATE.achievements  = Storage.get(k.ach, []);

    // Streak logic: if last login was yesterday, streak continues
    const today    = new Date().toDateString();
    const lastDay  = STATE.stats.lastDay;
    if (lastDay && lastDay !== today) {
      const yesterday = new Date(Date.now() - 86400000).toDateString();
      if (lastDay !== yesterday) {
        // Streak broken
        STATE.stats.streak = 0;
      }
    }
    if (lastDay !== today) {
      STATE.stats.lastDay = today;
      STATE.stats.streak  = (STATE.stats.streak || 0) + 1;
      Storage.saveAll();
    }
  },
};

/* ═══════════════════════════════════════════
   XP SYSTEM
   ═══════════════════════════════════════════ */
const XPSystem = {
  /** Award XP and handle level-ups */
  award(amount, taskDiff) {
    STATE.xp           += amount;
    STATE.stats.totalXp += amount;
    if (taskDiff === 'boss') STATE.stats.bossSlain++;

    // Check for level-up loop (multiple levels at once)
    let leveled = false;
    while (STATE.xp >= STATE.xpForNextLevel) {
      STATE.xp   -= STATE.xpForNextLevel;
      STATE.level++;
      leveled = true;
    }

    if (leveled) {
      LevelUpOverlay.show(STATE.level);
      AchievementSystem.check();
    }

    XPSystem.render();
    StatsPanel.render();
    Storage.saveAll();

    // Flash the XP bar
    const track = document.querySelector('.xp-track');
    if (track) {
      track.classList.remove('xp-gained');
      void track.offsetWidth; // force reflow
      track.classList.add('xp-gained');
    }
  },

  /** Update XP bar and level display in the HUD */
  render() {
    const pct    = Math.min((STATE.xp / STATE.xpForNextLevel) * 100, 100);
    const bar    = document.getElementById('xp-bar');
    const disp   = document.getElementById('xp-display');
    const lvlEl  = document.getElementById('player-level');

    if (bar)   bar.style.width       = `${pct}%`;
    if (disp)  disp.textContent      = `${STATE.xp} / ${STATE.xpForNextLevel}`;
    if (lvlEl) lvlEl.textContent     = STATE.level;
  },
};

/* ═══════════════════════════════════════════
   TASK SYSTEM
   ═══════════════════════════════════════════ */
const TaskSystem = {
  /** Add a new task to state and DOM */
  add(name, diff) {
    const task = {
      id:        Date.now(),
      name:      name.trim(),
      diff,
      xp:        CONFIG.XP_REWARDS[diff],
      completed: false,
      createdAt: new Date().toISOString(),
    };
    STATE.tasks.unshift(task); // newest first
    Storage.saveAll();
    TaskSystem.renderAll();
  },

  /** Mark a task complete: award XP, update stats */
  complete(id) {
    const task = STATE.tasks.find(t => t.id === id);
    if (!task || task.completed) return;

    task.completed = true;
    STATE.stats.completed++;

    // Flash card
    const card = document.querySelector(`.task-card[data-id="${id}"]`);
    if (card) {
      card.classList.add('completing');
      setTimeout(() => card.classList.add('completed'), 300);
    }

    XPSystem.award(task.xp, task.diff);
    AchievementSystem.check();
    Storage.saveAll();

    // Re-render after animation
    setTimeout(() => TaskSystem.renderAll(), 350);
  },

  /** Remove a task from state */
  remove(id) {
    STATE.tasks = STATE.tasks.filter(t => t.id !== id);
    Storage.saveAll();
    TaskSystem.renderAll();
  },

  /** Re-render the entire task list */
  renderAll() {
    const list       = document.getElementById('task-list');
    const emptyState = document.getElementById('empty-state');

    // Separate active and completed tasks
    const active    = STATE.tasks.filter(t => !t.completed);
    const completed = STATE.tasks.filter(t => t.completed);
    const ordered   = [...active, ...completed];

    // Clear existing cards (preserve empty-state element)
    list.querySelectorAll('.task-card').forEach(el => el.remove());

    if (ordered.length === 0) {
      emptyState.style.display = 'flex';
      return;
    }

    emptyState.style.display = 'none';

    ordered.forEach(task => {
      const card = TaskSystem._buildCard(task);
      list.appendChild(card);
    });
  },

  /** Build a single task card DOM element */
  _buildCard(task) {
    const card = document.createElement('div');
    card.className = `task-card${task.completed ? ' completed' : ''}`;
    card.dataset.id   = task.id;
    card.dataset.diff = task.diff;

    // XP badge
    const badge = document.createElement('span');
    badge.className   = 'task-xp-badge';
    badge.textContent = `+${task.xp}XP`;

    // Task name
    const name = document.createElement('span');
    name.className   = 'task-name';
    name.textContent = task.name;

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'task-actions';

    if (!task.completed) {
      const completeBtn = document.createElement('button');
      completeBtn.className   = 'pixel-btn btn--complete';
      completeBtn.textContent = '✓';
      completeBtn.title       = 'Mark complete';
      completeBtn.addEventListener('click', () => TaskSystem.complete(task.id));
      actions.appendChild(completeBtn);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.className   = 'pixel-btn btn--delete';
    deleteBtn.textContent = '✕';
    deleteBtn.title       = 'Delete task';
    deleteBtn.addEventListener('click', () => TaskSystem.remove(task.id));
    actions.appendChild(deleteBtn);

    card.appendChild(badge);
    card.appendChild(name);
    card.appendChild(actions);
    return card;
  },
};

/* ═══════════════════════════════════════════
   POMODORO SYSTEM
   ═══════════════════════════════════════════ */
const PomodoroSystem = {
  /** Start the timer */
  start() {
    if (STATE.timerRunning) return;
    STATE.timerRunning = true;

    document.getElementById('timer-start').disabled = true;
    document.getElementById('timer-pause').disabled = false;

    // Tick every second
    STATE.timerInterval = setInterval(() => {
      STATE.timerRemaining--;

      if (STATE.timerRemaining <= 0) {
        PomodoroSystem._complete();
      } else {
        PomodoroSystem.render();
      }
    }, 1000);
  },

  /** Pause the timer */
  pause() {
    if (!STATE.timerRunning) return;
    STATE.timerRunning = false;
    clearInterval(STATE.timerInterval);

    document.getElementById('timer-start').disabled = false;
    document.getElementById('timer-pause').disabled = true;
  },

  /** Reset to current mode's default duration */
  reset() {
    PomodoroSystem.pause();
    STATE.timerRemaining = CONFIG.TIMER_MODES[STATE.timerMode];

    document.getElementById('timer-start').disabled = false;
    document.getElementById('timer-pause').disabled = true;

    PomodoroSystem.render();
    PomodoroSystem._resetDots();
  },

  /** Set timer mode (work / short / long) */
  setMode(mode, mins) {
    PomodoroSystem.pause();
    STATE.timerMode      = mode;
    STATE.timerDuration  = mins * 60;
    STATE.timerRemaining = mins * 60;

    document.getElementById('timer-mode').textContent =
      mode === 'work'  ? 'WORK SESSION' :
      mode === 'short' ? 'SHORT BREAK'  : 'LONG BREAK';

    PomodoroSystem.render();
    PomodoroSystem._resetDots();
  },

  /** Called when timer reaches zero */
  _complete() {
    clearInterval(STATE.timerInterval);
    STATE.timerRunning   = false;
    STATE.timerRemaining = 0;

    if (STATE.timerMode === 'work') {
      STATE.sessionsToday++;
      Storage.saveAll();
      PomodoroSystem._renderGems();
    }

    document.getElementById('timer-start').disabled = false;
    document.getElementById('timer-pause').disabled = true;

    // Flash all dots green
    PomodoroSystem._flashDots();
    PomodoroSystem.render();

    // Auto-reset after 2s
    setTimeout(() => PomodoroSystem.reset(), 2000);
  },

  /** Update the display */
  render() {
    const mins = Math.floor(STATE.timerRemaining / 60);
    const secs = STATE.timerRemaining % 60;
    const timeStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    document.getElementById('timer-display').textContent = timeStr;

    // Progress bar: how much time has elapsed
    const elapsed  = STATE.timerDuration - STATE.timerRemaining;
    const progress = (elapsed / STATE.timerDuration) * 100;
    const fill = document.getElementById('timer-progress');
    if (fill) fill.style.width = `${100 - progress}%`;

    // Animate loading dots based on remaining time
    PomodoroSystem._animateDots();
  },

  /** Animate the 8 loading dots based on progress */
  _animateDots() {
    const elapsed   = STATE.timerDuration - STATE.timerRemaining;
    const fraction  = elapsed / STATE.timerDuration;
    const activeDots = Math.round(fraction * 8);

    for (let i = 1; i <= 8; i++) {
      const dot = document.getElementById(`ld${i}`);
      if (dot) dot.classList.toggle('active', i <= activeDots);
    }
  },

  _resetDots() {
    for (let i = 1; i <= 8; i++) {
      const dot = document.getElementById(`ld${i}`);
      if (dot) dot.classList.remove('active');
    }
  },

  _flashDots() {
    for (let i = 1; i <= 8; i++) {
      const dot = document.getElementById(`ld${i}`);
      if (dot) dot.classList.add('active');
    }
  },

  /** Render session gem indicators */
  _renderGems() {
    const gems = document.getElementById('session-gems');
    const count = document.getElementById('session-count');
    if (!gems || !count) return;

    gems.innerHTML = '';
    for (let i = 0; i < STATE.sessionsToday; i++) {
      const gem = document.createElement('div');
      gem.className = 'session-gem';
      gems.appendChild(gem);
    }
    count.textContent = STATE.sessionsToday;
  },
};

/* ═══════════════════════════════════════════
   STATS PANEL
   ═══════════════════════════════════════════ */
const StatsPanel = {
  render() {
    const s = STATE.stats;
    const el = (id) => document.getElementById(id);

    el('stat-completed').textContent = s.completed   || 0;
    el('stat-total-xp').textContent  = s.totalXp     || 0;
    el('stat-streak').textContent    = s.streak      || 0;
    el('stat-boss').textContent      = s.bossSlain   || 0;
  },
};

/* ═══════════════════════════════════════════
   ACHIEVEMENT SYSTEM
   ═══════════════════════════════════════════ */
const AchievementSystem = {
  /** Definitions: each has an id, condition function, and DOM badge */
  definitions: [
    { id: 'first_quest', check: () => STATE.stats.completed >= 1 },
    { id: 'level5',      check: () => STATE.level >= 5 },
    { id: 'boss_slayer', check: () => STATE.stats.bossSlain >= 1 },
    { id: 'streak3',     check: () => STATE.stats.streak >= 3 },
    { id: 'ten_tasks',   check: () => STATE.stats.completed >= 10 },
    { id: 'level10',     check: () => STATE.level >= 10 },
  ],

  /** Check all conditions and unlock if met */
  check() {
    AchievementSystem.definitions.forEach(def => {
      if (!STATE.achievements.includes(def.id) && def.check()) {
        STATE.achievements.push(def.id);
        AchievementSystem._unlock(def.id);
      }
    });
    AchievementSystem.render();
    Storage.saveAll();
  },

  _unlock(id) {
    // Could trigger a notification here; for now badge glow suffices
    console.log(`[PixelForge] Achievement unlocked: ${id}`);
  },

  render() {
    document.querySelectorAll('.ach-badge').forEach(badge => {
      const id = badge.dataset.ach;
      if (STATE.achievements.includes(id)) {
        badge.classList.remove('locked');
      }
    });
  },
};

/* ═══════════════════════════════════════════
   LEVEL UP OVERLAY
   ═══════════════════════════════════════════ */
const LevelUpOverlay = {
  /** Show the level-up celebration overlay */
  show(newLevel) {
    const overlay = document.getElementById('levelup-overlay');
    const newEl   = document.getElementById('levelup-new');
    if (!overlay || !newEl) return;

    newEl.textContent = `LEVEL ${newLevel}`;
    overlay.classList.add('active');

    // Spawn pixel explosion particles
    LevelUpOverlay._explode();

    // Dismiss after 2.2 seconds
    setTimeout(() => {
      overlay.classList.remove('active');
    }, 2200);
  },

  _explode() {
    const container = document.getElementById('pixel-explosion');
    if (!container) return;

    container.innerHTML = '';
    const colors = ['#3df2a7', '#f2c43d', '#f27a3d', '#f23d6e', '#ffffff'];

    for (let i = 0; i < 32; i++) {
      const p   = document.createElement('div');
      p.className = 'exp-particle';

      // Random direction and distance
      const angle  = (i / 32) * 2 * Math.PI + (Math.random() - 0.5) * 0.5;
      const dist   = 60 + Math.random() * 80;
      const tx     = Math.cos(angle) * dist;
      const ty     = Math.sin(angle) * dist;
      const color  = colors[Math.floor(Math.random() * colors.length)];
      const dur    = 0.5 + Math.random() * 0.6;

      p.style.cssText = `
        left: 50%;
        top: 50%;
        background: ${color};
        --tx: ${tx}px;
        --ty: ${ty}px;
        --dur: ${dur}s;
        box-shadow: 0 0 4px ${color};
        width: ${4 + Math.floor(Math.random() * 6)}px;
        height: ${4 + Math.floor(Math.random() * 6)}px;
      `;

      container.appendChild(p);
    }
  },
};

/* ═══════════════════════════════════════════
   NOTES SYSTEM
   ═══════════════════════════════════════════ */
const NotesSystem = {
  init() {
    const textarea = document.getElementById('notes-area');
    const counter  = document.getElementById('notes-char-count');
    const saved    = document.getElementById('notes-saved');
    if (!textarea) return;

    // Load saved note
    textarea.value = Storage.get(CONFIG.STORAGE_KEYS.notes, '');
    counter.textContent = `${textarea.value.length} CHARS`;

    let debounceTimer;

    textarea.addEventListener('input', () => {
      counter.textContent = `${textarea.value.length} CHARS`;
      saved.textContent   = 'SAVING...';
      saved.style.opacity = '0.6';

      // Debounce save — write to storage 500ms after typing stops
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        Storage.set(CONFIG.STORAGE_KEYS.notes, textarea.value);
        saved.textContent   = 'SAVED ✓';
        saved.style.opacity = '1';
      }, 500);
    });
  },
};

/* ═══════════════════════════════════════════
   PIXEL FIELD — floating background particles
   ═══════════════════════════════════════════ */
const PixelField = {
  init() {
    const field = document.querySelector('.pixel-field');
    if (!field) return;

    const count = 40;
    for (let i = 0; i < count; i++) {
      const sprite = document.createElement('div');
      sprite.className = 'pixel-sprite';

      // Random position, size, duration, delay
      const size  = 2 + Math.floor(Math.random() * 4);
      const left  = Math.random() * 100;
      const delay = Math.random() * 12;
      const dur   = 6 + Math.random() * 10;

      sprite.style.cssText = `
        left: ${left}vw;
        bottom: -10px;
        width: ${size}px;
        height: ${size}px;
        --dur: ${dur}s;
        --delay: ${delay}s;
        opacity: 0;
      `;

      field.appendChild(sprite);
    }
  },
};

/* ═══════════════════════════════════════════
   HUD DATE — live clock
   ═══════════════════════════════════════════ */
const HUDClock = {
  init() {
    HUDClock.update();
    setInterval(HUDClock.update, 1000);
  },

  update() {
    const el = document.getElementById('hud-date');
    if (!el) return;

    const now = new Date();
    const date = now.toLocaleDateString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
    }).toUpperCase();
    const time = now.toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });

    el.innerHTML = `${date}<br>${time}`;
  },
};

/* ═══════════════════════════════════════════
   EVENT LISTENERS — wiring up the UI
   ═══════════════════════════════════════════ */
const EventListeners = {
  init() {
    // ── Task: difficulty buttons ──────────────
    document.querySelectorAll('.diff-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        STATE.selectedDiff = btn.dataset.diff;
      });
    });

    // ── Task: add on button click ─────────────
    document.getElementById('add-task-btn').addEventListener('click', () => {
      EventListeners._addTask();
    });

    // ── Task: add on Enter key ────────────────
    document.getElementById('task-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') EventListeners._addTask();
    });

    // ── Pomodoro: start ───────────────────────
    document.getElementById('timer-start').addEventListener('click', () => {
      PomodoroSystem.start();
    });

    // ── Pomodoro: pause ───────────────────────
    document.getElementById('timer-pause').addEventListener('click', () => {
      PomodoroSystem.pause();
    });

    // ── Pomodoro: reset ───────────────────────
    document.getElementById('timer-reset').addEventListener('click', () => {
      PomodoroSystem.reset();
    });

    // ── Pomodoro: mode buttons ────────────────
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        PomodoroSystem.setMode(btn.dataset.mode, parseInt(btn.dataset.mins));
      });
    });

    // ── Level-up overlay: click to dismiss ───
    document.getElementById('levelup-overlay').addEventListener('click', () => {
      document.getElementById('levelup-overlay').classList.remove('active');
    });
  },

  _addTask() {
    const input = document.getElementById('task-input');
    const name  = input.value.trim();
    if (!name) {
      // Shake the input to signal error
      input.style.borderColor = 'var(--diff-boss)';
      setTimeout(() => input.style.borderColor = '', 800);
      return;
    }
    TaskSystem.add(name, STATE.selectedDiff);
    input.value = '';
    input.focus();
  },
};

/* ═══════════════════════════════════════════
   INIT — bootstrap everything on DOMContentLoaded
   ═══════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  // 1. Load persisted data
  Storage.loadAll();

  // 2. Render initial state
  XPSystem.render();
  TaskSystem.renderAll();
  StatsPanel.render();
  AchievementSystem.render();
  PomodoroSystem.render();
  PomodoroSystem._renderGems();

  // 3. Boot subsystems
  NotesSystem.init();
  HUDClock.init();
  PixelField.init();
  EventListeners.init();

  console.log(
    '%c[PixelForge] SYSTEM ONLINE — v1.0\nBuilt by Soltani Seyf Eddine',
    'color: #3df2a7; font-family: monospace; font-size: 12px;'
  );
});
