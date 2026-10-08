/**
 * Shared DOM primitives for VNCCS config-style widgets (VNCSS Config node and
 * future Control Center panels): a fluid container-query layout, collapsible
 * sections, toggle switches, connection status dots and paired slider+number
 * controls. Pure DOM APIs — no value is ever parsed as HTML.
 */

const STYLE_ID = "vnccs-config-ui-styles";

export function ensureConfigStyles(doc = document) {
  if (!doc?.head || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.vnccs-config-ui { container-type: inline-size; display:flex; flex-direction:column; gap:8px; padding:8px; color:#ece7f3; font:12px/1.35 Inter, system-ui, sans-serif; min-width:0; max-height:100%; overflow-y:auto; overscroll-behavior:contain; scrollbar-width:thin; scrollbar-color:#6b5a80 transparent; }
.vnccs-config-ui > * { flex:0 0 auto; }
.vnccs-config-ui, .vnccs-config-ui * { box-sizing:border-box; }
.vnccs-cfg-intro { display:flex; flex-direction:column; gap:6px; padding:8px 10px; border:1px solid #3a2f47; border-radius:10px; background:linear-gradient(180deg,#1d1726,#16121c); }
.vnccs-cfg-intro-title { display:flex; align-items:center; gap:6px; font-weight:700; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#ffb3c2; }
.vnccs-cfg-intro-title::before { content:""; width:3px; height:12px; border-radius:2px; background:#f08fa3; }
.vnccs-cfg-intro-text { color:#a79fb3; font-size:11px; }
.vnccs-cfg-section { border:1px solid #33283f; border-radius:10px; background:#17131d; overflow:hidden; min-width:0; }
.vnccs-cfg-section-head { display:flex; align-items:center; gap:8px; padding:8px 10px; cursor:pointer; user-select:none; min-width:0; }
.vnccs-cfg-section-head:hover { background:#201a29; }
.vnccs-cfg-chevron { width:12px; flex:0 0 auto; text-align:center; transition:transform .12s ease; color:#8f86a0; }
.vnccs-cfg-section.open .vnccs-cfg-chevron { transform:rotate(90deg); }
.vnccs-cfg-section-title { font-weight:700; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#e9dff2; flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vnccs-cfg-badge { color:#ffd45c; font-weight:600; white-space:nowrap; font-size:11px; }
.vnccs-cfg-section-body { display:none; padding:4px 10px 10px; }
.vnccs-cfg-section.open .vnccs-cfg-section-body { display:flex; flex-direction:column; gap:8px; }
.vnccs-cfg-row { display:flex; flex-wrap:wrap; align-items:center; gap:6px; min-width:0; }
.vnccs-cfg-grow { flex:1 1 120px; min-width:0; }
.vnccs-cfg-btn { border:1px solid #43374f; background:#221b2b; color:#e6ddf0; border-radius:999px; height:24px; padding:0 10px; cursor:pointer; font:600 11px Inter, system-ui, sans-serif; }
.vnccs-cfg-btn:hover { background:#2d2438; border-color:#f08fa3; }
.vnccs-cfg-btn.primary { background:linear-gradient(90deg,#f08fa3,#c79bf2); border-color:transparent; color:#1a1320; }
.vnccs-cfg-input { background:#110e16; border:1px solid #3a3045; color:#ece7f3; border-radius:7px; height:26px; padding:0 8px; font:12px Inter, system-ui, sans-serif; }
.vnccs-cfg-input:focus { outline:none; border-color:#f08fa3; }
.vnccs-cfg-pair { display:flex; align-items:center; gap:6px; flex:1 1 0; min-width:0; }
.vnccs-cfg-pair input[type="range"] { flex:1 1 auto; min-width:40px; width:auto; accent-color:#f08fa3; cursor:pointer; }
.vnccs-cfg-pair input[type="number"] { width:52px; flex:0 0 auto; cursor:text; background:#110e16; border:1px solid #3a3045; color:#ece7f3; border-radius:6px; height:22px; padding:0 4px; }
.vnccs-cfg-pair-label { flex:0 0 auto; color:#8f86a0; font-size:10px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; }
.vnccs-cfg-status { display:flex; flex-wrap:wrap; gap:6px; }
.vnccs-cfg-dot { display:inline-flex; align-items:center; gap:5px; white-space:nowrap; color:#8f86a0; padding:2px 8px; border:1px solid #33283f; border-radius:999px; background:#120f17; font-size:11px; }
.vnccs-cfg-dot::before { content:""; width:7px; height:7px; border-radius:50%; background:#4a4155; }
.vnccs-cfg-dot.on { color:#ece7f3; border-color:#3f5a3b; }
.vnccs-cfg-dot.on::before { background:#7ddb6f; box-shadow:0 0 6px #7ddb6f88; }
.vnccs-cfg-switch { width:36px; height:20px; flex:0 0 auto; border-radius:999px; border:1px solid #4a3d57; background:#221b2b; position:relative; cursor:pointer; }
.vnccs-cfg-switch::after { content:""; position:absolute; top:2px; left:3px; width:14px; height:14px; border-radius:50%; background:#8f86a0; transition:left .12s ease, background .12s ease; }
.vnccs-cfg-switch.on { border-color:#f08fa3; background:#f08fa333; }
.vnccs-cfg-switch.on::after { left:17px; background:#ffd45c; }
.vnccs-cfg-lora { display:grid; grid-template-columns:auto minmax(0,1fr) auto; grid-template-areas:"on name x" "str str str"; align-items:center; gap:6px 8px; padding:8px; border:1px solid #2e2538; border-radius:9px; background:#120f17; }
.vnccs-cfg-lora.off { opacity:.55; }
.vnccs-cfg-lora.drop-target { border-color:#f08fa3; }
.vnccs-cfg-lora > input[type="checkbox"] { grid-area:on; width:14px; height:14px; accent-color:#f08fa3; margin:0; cursor:pointer; }
.vnccs-cfg-lora > .vnccs-cfg-lora-name { grid-area:name; }
.vnccs-cfg-lora > .vnccs-cfg-x { grid-area:x; }
.vnccs-cfg-lora > .vnccs-cfg-lora-strengths { grid-area:str; display:flex; gap:10px; min-width:0; }
.vnccs-cfg-empty { color:#7d748a; font-size:11px; padding:6px 2px; }
.vnccs-cfg-refs { display:grid; grid-template-columns:repeat(auto-fill, minmax(120px, 1fr)); gap:6px; }
.vnccs-cfg-refchip { display:flex; align-items:center; gap:6px; border:1px dashed #3a3045; border-radius:8px; padding:4px 6px; min-width:0; background:#120f17; }
.vnccs-cfg-refchip.connected { border-style:solid; border-color:#4b3d5b; }
.vnccs-cfg-refchip img { width:34px; height:34px; object-fit:cover; border-radius:5px; background:#0c0a10; }
.vnccs-cfg-refchip .vnccs-cfg-reflabel { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#c9bfd6; }
.vnccs-cfg-refchip .vnccs-cfg-refindex { color:#ffd45c; font-weight:700; flex:0 0 auto; font-size:11px; }
.vnccs-cfg-refchip .vnccs-cfg-refindex.natural { color:#a79fb3; font-weight:600; font-style:italic; }
.vnccs-cfg-hint { color:#8f86a0; font-size:11px; }
.vnccs-cfg-x { border:0; background:transparent; color:#f08fa3; cursor:pointer; font:inherit; padding:0 2px; }
.vnccs-cfg-x:hover { color:#ffb3c2; }
@container (max-width: 269px) {
  .vnccs-cfg-lora > .vnccs-cfg-lora-strengths { flex-direction:column; gap:4px; }
  .vnccs-cfg-pair input[type="number"] { width:44px; }
}
`;
  doc.head.appendChild(style);
}

/** Collapsible section: returns { root, body, setOpen, setBadge }. */
export function createCollapsibleSection({ title, badge = "", open = true, onToggle } = {}) {
  const root = document.createElement("div");
  root.className = "vnccs-cfg-section" + (open ? " open" : "");
  const head = document.createElement("div");
  head.className = "vnccs-cfg-section-head";
  const chevron = document.createElement("span");
  chevron.className = "vnccs-cfg-chevron";
  chevron.textContent = "\u25b8";
  const titleEl = document.createElement("span");
  titleEl.className = "vnccs-cfg-section-title";
  titleEl.textContent = title;
  const badgeEl = document.createElement("span");
  badgeEl.className = "vnccs-cfg-badge";
  badgeEl.textContent = badge;
  const body = document.createElement("div");
  body.className = "vnccs-cfg-section-body";
  head.append(chevron, titleEl, badgeEl);
  root.append(head, body);
  head.addEventListener("click", () => {
    // Only the header toggles; interactive controls live in the body and are
    // never descendants of the header, so they keep their own gestures.
    const willOpen = !root.classList.contains("open");
    root.classList.toggle("open", willOpen);
    onToggle?.(willOpen);
  });
  return {
    root,
    body,
    setOpen(next) {
      root.classList.toggle("open", !!next);
    },
    setBadge(text) {
      badgeEl.textContent = text;
    },
  };
}

/** Toggle switch: returns { root, get, set }. onChange receives the new value. */
export function createSwitch(enabled = false, onChange) {
  const root = document.createElement("div");
  root.className = "vnccs-cfg-switch" + (enabled ? " on" : "");
  root.title = "Toggle";
  root.addEventListener("click", () => {
    const next = !root.classList.contains("on");
    root.classList.toggle("on", next);
    onChange?.(next);
  });
  return {
    root,
    get: () => root.classList.contains("on"),
    set(next) {
      root.classList.toggle("on", !!next);
    },
  };
}

/** Connection status dot: returns { root, set(connected) }. */
export function createStatusDot(label) {
  const root = document.createElement("span");
  root.className = "vnccs-cfg-dot";
  root.textContent = label;
  return {
    root,
    set(connected) {
      root.classList.toggle("on", !!connected);
    },
  };
}

/**
 * Paired slider + exact number that stay in sync from every "input" event
 * (repository realtime rule); "change" only reports the committed value and a
 * double-click resets to resetValue (default 1.0).
 * Returns { root, get, set }.
 */
export function createSliderNumber({ min = 0, max = 2, step = 0.05, value = 1, resetValue = 1, label = "", onInput, onChange, onReset } = {}) {
  const clamp = (v) => Math.min(max, Math.max(min, Number(v)));
  const range = document.createElement("input");
  range.type = "range";
  range.min = String(min);
  range.max = String(max);
  range.step = String(step);
  range.value = String(value);
  const number = document.createElement("input");
  number.type = "number";
  number.min = String(min);
  number.max = String(max);
  number.step = String(step);
  number.value = String(value);
  const pair = document.createElement("div");
  pair.className = "vnccs-cfg-pair";
  if (label) {
    const caption = document.createElement("span");
    caption.className = "vnccs-cfg-pair-label";
    caption.textContent = label;
    pair.appendChild(caption);
  }
  pair.append(range, number);
  const sync = (source) => {
    const current = clamp(source.value);
    range.value = String(current);
    number.value = String(current);
    return current;
  };
  for (const control of [range, number]) {
    control.addEventListener("input", () => {
      const current = sync(control);
      onInput?.(current);
    });
    // "change" is commit-only; it must never be the first event that updates
    // the visible value (AGENTS.md realtime rule).
    control.addEventListener("change", () => onChange?.(clamp(range.value)));
    control.addEventListener("dblclick", () => {
      range.value = String(resetValue);
      number.value = String(resetValue);
      onReset?.(resetValue);
      onChange?.(resetValue);
    });
  }
  return {
    root: pair,
    get: () => clamp(range.value),
    set(next) {
      range.value = String(clamp(next));
      number.value = String(clamp(next));
    },
  };
}
