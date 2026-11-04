/*
 * Editor Enhancer 1.2.2 - by paipa, MIT License
 * https://github.com/Paipa03/obsidian-editor-enhancer
 *
 * Maintainer notes:
 * - Editor Enhancer and Expiring Blocks share one toggle / layout engine
 *   (toggle markers and expiry metadata, title caret guards, folding and scroll
 *   pinning, hierarchy layout CSS, block boundaries / drag / menus, toggleApi and
 *   the engine hand-over). Editor Enhancer's main.js is the source of that
 *   engine; Expiring Blocks ships a copy so it also works on its own.
 * - Any change to the shared engine goes into both plugins in the same release,
 *   tested with both installed and with each one installed alone.
 */

var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var main_exports = {};
__export(main_exports, { default: () => NotionStyleBlocksPlugin });
module.exports = __toCommonJS(main_exports);

var import_obsidian = require("obsidian");
var import_state    = require("@codemirror/state");
var import_view     = require("@codemirror/view");
// Optional: used to undo Obsidian's native heading folds on TL title lines so
// only the NSB triangle drives expand/collapse. Soft dependency.
var import_language = null;
try { import_language = require("@codemirror/language"); } catch (_) { import_language = null; }

function isMobileDevice() {
  if (typeof import_obsidian.Platform !== "undefined" && import_obsidian.Platform.isMobile) return true;
  if (window.matchMedia &&
      window.matchMedia("(pointer: coarse)").matches &&
      !window.matchMedia("(pointer: fine)").matches) return true;
  return false;
}

function isLivePreviewEditorView(editorView) {
  if (!editorView || !editorView.dom) return false;
  let el = editorView.dom;
  while (el && el !== document.body) {
    if (el.classList && el.classList.contains("is-source-mode")) return false;
    if (el.classList && el.classList.contains("is-live-preview")) return true;
    el = el.parentElement;
  }
  return false;
}

var DEFAULT_SETTINGS = {
  handleOpacity: 0.5,
  handleSize: 20,
  handleOffset: 4,
  dotSize: 3.5,
  dotGap: 2.5,
  dotGray: 55,
  toggleIconSize: 16,
  suppressRightClickLineSelection: true,
  lineHeight: 3,
  lineOpacity: 0.65,
  blockSpacingEnabled: true,
  blockSpacingPx: 8,
  lineSpacingPx: 0,
  developerMode: false,
  tlFeaturesEnabled: true,
  blockFeaturesEnabled: true,
  contextMenuFeaturesEnabled: true,
  restoreScrollOnReopen: true,
  mobileTableLinkNav: true,
  listMarkerFeaturesEnabled: true
};
var HANDLE_W = 28;
// Master switch mirrored from settings.tlFeaturesEnabled. Gating the two
// root analysis functions (scanToggleBlocks / getVacuumLineKind) neutralizes
// every TL feature and TL-compat behavior at once: decorations, key
// handling, drag grouping, hr/callout guard rows, hierarchy layout, guard
// filter — leaving only plain block dragging and deletion.
var NSB_TL_FEATURES_ENABLED = true;
var NSB_NORMAL_TL_FEATURES_ENABLED = true;
var NSB_EXPIRING_ADAPTER_ACTIVE = false;
var NSB_EXPIRING_FALLBACK_ONLY = false;
function setNsbTlFeaturesEnabled(value) {
  NSB_NORMAL_TL_FEATURES_ENABLED = value !== false;
  NSB_TL_FEATURES_ENABLED = NSB_NORMAL_TL_FEATURES_ENABLED || NSB_EXPIRING_ADAPTER_ACTIVE;
}
function isNsbExpiringOnlyMode() {
  return NSB_EXPIRING_FALLBACK_ONLY || !NSB_NORMAL_TL_FEATURES_ENABLED;
}
// Master switch for the "Notion blocks" group: drag handles + plus button
// (EditOverlay), the handle block menu, block drag, and block/line spacing.
// Gated at overlay construction and _applyBlockSpacingStyle; TL triangles,
// keyboard handling, and decorations are fully independent of it.
var NSB_BLOCK_FEATURES_ENABLED = true;
function setNsbBlockFeaturesEnabled(value) {
  NSB_BLOCK_FEATURES_ENABLED = value !== false;
}
// Master switch for the context-menu group: right-click line-selection
// suppression and the editor-menu modifications (native delete-item cleanup
// plus this plugin's own menu section). Off = Obsidian-native menus.
var NSB_CTXMENU_FEATURES_ENABLED = true;
function setNsbCtxMenuFeaturesEnabled(value) {
  NSB_CTXMENU_FEATURES_ENABLED = value !== false;
}
// Master switch for the list-marker group: in Live Preview the bullet /
// number / checkbox prefix of a list line is one unit — the caret never
// rests inside it, one Backspace removes it (a nested item first loses one
// indent level), Delete at the line end before it joins the item, and
// ArrowLeft from the text start goes to the previous line's end. Off =
// Obsidian's character-by-character behaviour.
var NSB_LIST_MARKER_FEATURES_ENABLED = true;
function setNsbListMarkerFeaturesEnabled(value) {
  NSB_LIST_MARKER_FEATURES_ENABLED = value !== false;
}
// 1: quote / indent prefix, 2: bullet or number with its spacing, 3: task box.
var NSB_LIST_MARKER_RE = /^((?:[ \t]*>)*[ \t]*)((?:[-*+]|\d+[.)])[ \t]+)(\[[ xX]\](?:[ \t]+|$))?/;
var NSB_RULE_LINE_RE = /^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/;
// Marker of a list line as offsets within the line, or null. quoteEnd ends
// the "> " prefixes, indentEnd the indentation, markerEnd the whole marker.
function listMarkerOf(lineText) {
  const m = NSB_LIST_MARKER_RE.exec(lineText);
  if (!m || NSB_RULE_LINE_RE.test(lineText)) return null;
  const indent = m[1].replace(/^(?:[ \t]*>[ \t]?)*/, "");
  return { quoteEnd: m[1].length - indent.length, indentEnd: m[1].length, markerEnd: m[0].length };
}
function listIndentColumns(state) {
  try {
    if (import_language && typeof import_language.getIndentUnit === "function") return import_language.getIndentUnit(state) || 4;
  } catch (_) {}
  return 4;
}
// Backspace with the caret right after the marker. Nested: drop one indent
// level. Top level: drop the marker; the line becomes plain text in place.
function listMarkerBackspaceSpec(state, pos) {
  const line = state.doc.lineAt(pos);
  const mk = listMarkerOf(line.text);
  if (!mk || pos !== line.from + mk.markerEnd) return null;
  if (mk.indentEnd > mk.quoteEnd) {
    const indent = line.text.slice(mk.quoteEnd, mk.indentEnd);
    let n = 1;
    if (!/\t$/.test(indent)) {
      const spaces = /( +)$/.exec(indent);
      n = Math.min(listIndentColumns(state), spaces ? spaces[1].length : 1);
    }
    const to = line.from + mk.indentEnd;
    return { changes: { from: to - n, to }, selection: { anchor: pos - n }, userEvent: "delete.nsb.list-outdent" };
  }
  const from = line.from + mk.quoteEnd;
  return { changes: { from, to: pos }, selection: { anchor: from }, userEvent: "delete.nsb.list-marker" };
}
// Delete at a line end whose next line is a list item: the newline and that
// item's whole prefix go, so the two texts join.
function listMarkerDeleteSpec(state, pos) {
  const line = state.doc.lineAt(pos);
  if (pos !== line.to || line.number >= state.doc.lines) return null;
  const next = state.doc.line(line.number + 1);
  const mk = listMarkerOf(next.text);
  if (!mk) return null;
  return { changes: { from: line.to, to: next.from + mk.markerEnd }, selection: { anchor: line.to }, userEvent: "delete.nsb.list-join" };
}
// ArrowLeft from right after the marker: the previous line's end (the marker
// has no inside to walk through). On the first line the caret stays.
function listMarkerLeftSpec(state, pos) {
  const line = state.doc.lineAt(pos);
  const mk = listMarkerOf(line.text);
  if (!mk || pos !== line.from + mk.markerEnd) return null;
  const anchor = line.number > 1 ? state.doc.line(line.number - 1).to : pos;
  return { selection: { anchor }, scrollIntoView: true, userEvent: "select.nsb.list-marker" };
}
// Built on first use: the Expiring Blocks bridge test loads this file with a
// stub @codemirror/view that has no Decoration at evaluation time.
var listMarkerAtomValue = null;
var NSB_TOGGLE_CLOSE_LINE = "%% /nsb-toggle %%";
var NSB_TOGGLE_OPEN_RE = /^\s*%%\s*nsb-toggle\s+({.*})\s*%%\s*$/;
// Inline format (v2): the opener marker sits at the END of the title line so
// the title row is one ordinary markdown line ("Title %% nsb-toggle {...} %%").
var NSB_TOGGLE_INLINE_OPEN_RE = /%%\s*nsb-toggle\s+({.*})\s*%%\s*$/;
var NSB_TOGGLE_CLOSE_RE = /^\s*%%\s*\/nsb-toggle\s*%%\s*$/;

function makeToggleId() {
  return "tgl-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}
// Keep unknown/malformed expiry values inert but intact. Expiring Blocks owns
// validation; a normal fold/unfold must never discard its stored metadata.
function toggleExpiryMeta(meta) {
  return meta && Object.prototype.hasOwnProperty.call(meta, "expiry") ? { expiry: meta.expiry } : {};
}
function parseToggleOpenLine(text) {
  const m = NSB_TOGGLE_OPEN_RE.exec(text || "");
  if (!m) return null;
  try {
    const meta = JSON.parse(m[1]);
    return {
      id: typeof meta.id === "string" && meta.id ? meta.id : makeToggleId(),
      open: meta.open === true,
      v: meta.v,
      ...toggleExpiryMeta(meta)
    };
  } catch (_) {
    return null;
  }
}
// Parses a line that may carry an inline (end-of-line) toggle opener marker.
// Returns null, or { meta, legacy, titleMarkerFrom } where legacy means the
// line is an old-format full-line opener (title lives on the next line) and
// titleMarkerFrom is the char offset where the hidden marker region begins
// (the visible title text ends there, trailing separator space included).
function parseToggleAnyOpenLine(text) {
  const m = NSB_TOGGLE_INLINE_OPEN_RE.exec(text || "");
  if (!m) return null;
  let meta = null;
  try { meta = JSON.parse(m[1]); } catch (_) { return null; }
  const before = (text || "").slice(0, m.index);
  const legacy = before.trim() === "" && meta.v !== 2;
  // Only the single separator space before the marker is part of the hidden
  // region. Trimming ALL trailing whitespace put every space typed at the
  // title end inside the fold, where it rendered as nothing and pushed the
  // caret into the protected marker — typing spaces appeared dead.
  const visible = before.replace(/[ \t]$/, "");
  return {
    meta: {
      id: typeof meta.id === "string" && meta.id ? meta.id : makeToggleId(),
      open: meta.open === true,
      v: meta.v,
      ...toggleExpiryMeta(meta)
    },
    legacy,
    titleMarkerFrom: legacy ? 0 : visible.length
  };
}
function serializeToggleOpenLine(meta) {
  return "%% nsb-toggle " + JSON.stringify({
    id: meta && meta.id ? meta.id : makeToggleId(),
    open: !!(meta && meta.open),
    v: 2,
    ...toggleExpiryMeta(meta)
  }) + " %%";
}
function isToggleOpenLineText(text) {
  return !!parseToggleOpenLine(text);
}
function isToggleCloseLineText(text) {
  return NSB_TOGGLE_CLOSE_RE.test(text || "");
}
function isToggleMarkerLineText(text) {
  return isToggleOpenLineText(text) || isToggleCloseLineText(text);
}
function scanToggleBlocks(doc) {
  if (!NSB_TL_FEATURES_ENABLED) return [];
  const total = doc.lines;
  const get = n => (n >= 0 && n < total) ? doc.line(n + 1).text : "";
  const stack = [];
  const blocks = [];
  for (let i = 0; i < total; i++) {
    const text = get(i);
    const open = parseToggleAnyOpenLine(text);
    if (open) {
      stack.push({
        id: open.meta.id,
        open: open.meta.open,
        meta: open.meta,
        startLine: i,
        depth: stack.length,
        inline: !open.legacy,
        titleMarkerFrom: open.titleMarkerFrom
      });
      continue;
    }
    if (!isToggleCloseLineText(text) || !stack.length) continue;
    const block = stack.pop();
    block.endLine = i;
    block.titleLine = block.inline
      ? block.startLine
      : (block.startLine + 1 <= block.endLine ? block.startLine + 1 : block.startLine);
    block.bodyStartLine = block.titleLine + 1;
    block.bodyEndLine = block.endLine - 1;
    blocks.push(block);
  }
  blocks.sort((a, b) => a.startLine - b.startLine);
  if (isNsbExpiringOnlyMode()) {
    const retained = [], ancestors = [];
    let timedEnd = -1;
    for (const block of blocks) {
      if (block.startLine > timedEnd) {
        if (!block.meta.expiry || block.meta.expiry.v !== 1) continue;
        timedEnd = block.endLine;
        ancestors.length = 0;
      }
      while (ancestors.length && ancestors[ancestors.length - 1] < block.startLine) ancestors.pop();
      block.depth = ancestors.length;
      ancestors.push(block.endLine);
      retained.push(block);
    }
    return retained;
  }
  return blocks;
}
// Position in the doc where the visible title text of an inline toggle ends
// (= where the hidden marker region begins). For legacy blocks this is the
// title line end, since legacy title lines carry no marker.
function toggleTitleVisibleEndPos(doc, toggle) {
  const title = doc.line(toggle.titleLine + 1);
  if (!toggle.inline) return title.to;
  return title.from + Math.min(toggle.titleMarkerFrom, title.length);
}
function toggleVisibleTitleText(doc, toggle) {
  const title = doc.line(toggle.titleLine + 1);
  if (!toggle.inline) return title.text || "";
  return (title.text || "").slice(0, toggle.titleMarkerFrom);
}
// End position for CLEARING a title: visible text plus the separator
// whitespace before the raw "%%" marker. Deleting up to here leaves the line
// byte-identical to a freshly created empty TL ("%% nsb-toggle ... %%").
function toggleTitleClearEndPos(doc, toggle) {
  const title = doc.line(toggle.titleLine + 1);
  if (!toggle.inline) return title.to;
  const hidden = (title.text || "").slice(toggle.titleMarkerFrom);
  const ws = hidden.length - hidden.replace(/^\s+/, "").length;
  return title.from + toggle.titleMarkerFrom + ws;
}
// Zero-width caret anchor for title lines whose visible title is empty. Such
// a line's content is otherwise just a folded replace range with no DOM, and
// CodeMirror's coordsAtPos then falls back to the line block's left edge —
// ignoring the title padding — which painted the caret in front of the
// toggle triangle. The empty inline span gives the caret a real DOM anchor
// at the padded content start.
var NsbTitleCaretAnchorWidget = class extends import_view.WidgetType {
  toDOM() {
    const span = document.createElement("span");
    span.className = "nsb-caret-anchor";
    return span;
  }
  eq() { return true; }
  ignoreEvent() { return false; }
};
// Marker lines that are NOT also visible title lines: close lines always,
// opener lines only for legacy blocks (inline openers ARE the title line).
function toggleHiddenMarkerLines(toggles) {
  const lines = new Set();
  for (const t of toggles) {
    lines.add(t.endLine);
    if (!t.inline) lines.add(t.startLine);
  }
  return lines;
}
// Visible end position for any line: title lines end before their inline
// marker, everything else ends at the physical line end.
function visibleLineEndPos(doc, toggles, lineNum0) {
  const t = toggles.find(x => x.titleLine === lineNum0 && x.inline);
  return t ? toggleTitleVisibleEndPos(doc, t) : doc.line(lineNum0 + 1).to;
}
function getToggleHeaderForLine(doc, lineNum0) {
  const toggles = scanToggleBlocks(doc);
  return toggles.find(t => t.startLine === lineNum0 || t.titleLine === lineNum0) || null;
}
function getToggleByStartLine(doc, startLine) {
  return scanToggleBlocks(doc).find(t => t.startLine === startLine) || null;
}
function isLineHiddenByCollapsedToggle(toggles, lineNum0) {
  return toggles.some(t => !t.open && lineNum0 >= t.bodyStartLine && lineNum0 <= t.endLine);
}
function isRangeHiddenByCollapsedToggle(toggles, startLine, endLine) {
  return toggles.some(t => !t.open && startLine <= t.endLine && endLine >= t.bodyStartLine);
}
function isLineToggleTitle(toggles, lineNum0) {
  return toggles.some(t => t.titleLine === lineNum0);
}
function getToggleBodyDepth(toggles, lineNum0) {
  let depth = 0;
  for (const t of toggles) {
    if (lineNum0 > t.titleLine && lineNum0 < t.endLine) depth = Math.max(depth, t.depth + 1);
  }
  return depth;
}
function getToggleInsertDepth(toggles, insertLine) {
  let depth = 0;
  for (const t of toggles) {
    if (insertLine > t.titleLine && insertLine <= t.endLine) depth = Math.max(depth, t.depth + 1);
  }
  return depth;
}
function toggleHasBodyContent(doc, toggle) {
  for (let i = toggle.bodyStartLine; i <= toggle.bodyEndLine; i++) {
    const text = doc.line(i + 1).text;
    if (!isToggleMarkerLineText(text) && text.trim() !== "") return true;
  }
  return false;
}
function toggleHasTitleContent(doc, toggle) {
  if (!toggle || toggle.titleLine < 0 || toggle.titleLine >= doc.lines) return false;
  return toggleVisibleTitleText(doc, toggle).trim() !== "";
}
function toggleIsEmpty(doc, toggle) {
  return !toggleHasTitleContent(doc, toggle) && !toggleHasBodyContent(doc, toggle);
}
function addReplaceLineDecoration(decos, doc, lineNum0) {
  if (lineNum0 < 0 || lineNum0 >= doc.lines) return;
  const line = doc.line(lineNum0 + 1);
  const to = lineNum0 + 1 < doc.lines ? doc.line(lineNum0 + 2).from : line.to;
  decos.push(import_view.Decoration.replace({ block: true }).range(line.from, to));
}
function addToggleMarkerLineDecoration(decos, doc, lineNum0) {
  if (lineNum0 < 0 || lineNum0 >= doc.lines) return;
  const line = doc.line(lineNum0 + 1);
  decos.push(import_view.Decoration.line({
    attributes: {
      class: "nsb-toggle-marker-line",
      "aria-hidden": "true"
    }
  }).range(line.from));
  if (line.from < line.to) {
    decos.push(import_view.Decoration.replace({}).range(line.from, line.to));
  }
}
function addToggleCloseLineDecoration(decos, doc, lineNum0) {
  if (lineNum0 < 0 || lineNum0 >= doc.lines) return;
  const nextIsBlank = lineNum0 + 1 < doc.lines && isBlankLineText(doc.line(lineNum0 + 2).text);
  if (nextIsBlank) addToggleMarkerLineDecoration(decos, doc, lineNum0);
  else addReplaceLineDecoration(decos, doc, lineNum0);
}
function addReplaceLineRangeDecoration(decos, doc, fromLine0, toLine0) {
  if (fromLine0 < 0 || fromLine0 >= doc.lines || toLine0 < fromLine0) return;
  const last = Math.min(toLine0, doc.lines - 1);
  const from = doc.line(fromLine0 + 1).from;
  const to = last + 1 < doc.lines ? doc.line(last + 2).from : doc.line(last + 1).to;
  decos.push(import_view.Decoration.replace({ block: true }).range(from, to));
}
function expandToggleRangeForLines(doc, startLine, endLine) {
  const header = getToggleHeaderForLine(doc, startLine);
  if (header) return { startLine: header.startLine, endLine: header.endLine };
  const byStart = getToggleByStartLine(doc, startLine);
  if (byStart) return { startLine: byStart.startLine, endLine: byStart.endLine };
  return { startLine, endLine };
}

function isOutlinerManaged(el) {
  return el.classList.contains("outliner-plugin-list-item") ||
    !!el.closest(".outliner-plugin-list-item") || !!el.closest("[data-outliner]");
}
function isTableElement(el) {
  if (!el) return false;
  if (el.closest(".cm-table-widget") || el.closest(".HyperMD-table-row")) return true;
  if (["TD","TH","TR","TABLE"].includes(el.tagName) || el.closest("table")) return true;
  return (el.textContent || "").trimStart().startsWith("|");
}
// Returns true for any embed block that is managed by the Web Bookmark plugin.
// NSB must skip these as drag origins to avoid double handles and conflicting
// drags. A .wb-container alone is only a bookmark marker; WB removes
// data-wb-drag-managed when its own drag feature is disabled, and NSB should
// take over in that state.
function isWbManaged(el) {
  if (!el) return false;
  // The embed's direct child container carries data-wb-drag-managed="true"
  if (el.querySelector && el.querySelector("[data-wb-drag-managed]")) return true;
  // Fallback: the container itself has the attribute (reading mode / edge cases)
  if (el.closest && el.closest("[data-wb-drag-managed]")) return true;
  return false;
}
function isWbBookmarkEmbed(el) {
  if (!el) return false;
  if (el.querySelector && el.querySelector(".wb-container")) return true;
  if (el.closest && el.closest(".wb-container")) return true;
  return false;
}
function isWbDragFeatureEnabled(app) {
  try {
    const wb = app && app.plugins && app.plugins.plugins && app.plugins.plugins["web-bookmark"];
    if (wb && wb.settings && Object.prototype.hasOwnProperty.call(wb.settings, "dragEnabled")) {
      return !!wb.settings.dragEnabled;
    }
  } catch (_) {}
  return true;
}
function isWbManagedByActivePlugin(el, app) {
  if (!isWbManaged(el)) return false;
  return isWbDragFeatureEnabled(app);
}
function getWbVisualElement(el) {
  if (!el) return null;
  if (el.matches && el.matches(".wb-container")) return el;
  if (el.querySelector) {
    const found = el.querySelector(".wb-container");
    if (found) return found;
  }
  return el.closest ? el.closest(".wb-container") : null;
}
function getWbBlockRoot(el) {
  if (!el) return null;
  if (el.closest) {
    const embed = el.closest(".cm-embed-block");
    if (embed) return embed;
    const preview = el.closest(".cm-preview-code-block");
    if (preview) return preview;
  }
  return el;
}
var BUILTIN_EMBED_SELECTOR = ".internal-embed,.file-embed,.markdown-embed,.media-embed,.image-embed,.audio-embed,.video-embed,.canvas-embed,.pdf-embed";
var NSB_EMBED_MUTATION_SELECTOR = BUILTIN_EMBED_SELECTOR + ",.cm-embed-block,.cm-preview-code-block,.wb-container,.gv-block,.callout,.canvas-wrapper,.canvas-node-container";
function getBuiltinEmbedVisualElement(el) {
  if (!el) return null;
  if (isWbBookmarkEmbed(el)) return null;
  if (el.matches && el.matches(BUILTIN_EMBED_SELECTOR)) return el;
  if (el.closest) {
    const closest = el.closest(BUILTIN_EMBED_SELECTOR);
    if (closest && !isWbBookmarkEmbed(closest)) return closest;
  }
  if (el.querySelector) {
    const found = el.querySelector(BUILTIN_EMBED_SELECTOR);
    if (found && !isWbBookmarkEmbed(found)) return found;
  }
  return null;
}
function getEmbedBlockRoot(el) {
  if (!el) return null;
  if (el.closest) {
    const embed = el.closest(".cm-embed-block");
    if (embed) return embed;
    const preview = el.closest(".cm-preview-code-block");
    if (preview) return preview;
  }
  return el;
}
function nodeHasNsbEmbedLikeContent(node) {
  if (!node || node.nodeType !== 1) return false;
  const el = node;
  try {
    return (el.matches && el.matches(NSB_EMBED_MUTATION_SELECTOR)) ||
      (el.querySelector && !!el.querySelector(NSB_EMBED_MUTATION_SELECTOR));
  } catch (_) {
    return false;
  }
}
function scanQuoteBlocks(doc) {
  const total = doc.lines;
  const ranges = [];
  let startLine = -1;
  for (let i = 0; i < total; i++) {
    const isQuote = /^\s*>/.test(doc.line(i + 1).text);
    if (isQuote && startLine < 0) startLine = i;
    else if (!isQuote && startLine >= 0) {
      ranges.push({ startLine, endLine: i - 1 });
      startLine = -1;
    }
  }
  if (startLine >= 0) ranges.push({ startLine, endLine: total - 1 });
  return ranges;
}
function isBlankLineText(text) {
  return !text || text.trim() === "";
}
function isQuoteLineText(text) {
  return /^\s*>/.test(text || "");
}
function isHrLineText(text) {
  return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(text || "");
}
function getOrderedListMatch(text) {
  return /^(\s*)(\d+)([.)])(\s+)/.exec(text || "");
}
function renumberOrderedListBlockText(doc, blockText, insertLine) {
  const lines = String(blockText || "").split("\n");
  const first = lines[0] || "";
  const m = getOrderedListMatch(first);
  if (!m) return blockText;
  let nextNum = 1;
  if (doc) {
    const targetLine = Math.max(0, Math.min(insertLine || 0, doc.lines));
    for (let i = targetLine - 1; i >= 0; i--) {
      const text = doc.line(i + 1).text;
      if (isToggleMarkerLineText(text) || isBlankLineText(text)) continue;
      const prev = getOrderedListMatch(text);
      if (prev && prev[1].length === m[1].length) nextNum = Number(prev[2]) + 1;
      break;
    }
  }
  lines[0] = m[1] + nextNum + m[3] + m[4] + first.slice(m[0].length);
  return lines.join("\n");
}
function getVacuumLineKind(doc, lineNum0) {
  if (!NSB_TL_FEATURES_ENABLED) return false;
  if (!doc || lineNum0 < 0 || lineNum0 >= doc.lines) return false;
  const text = doc.line(lineNum0 + 1).text;
  if (!isBlankLineText(text)) return false;
  if (isNsbExpiringOnlyMode() && !scanToggleBlocks(doc).some(t =>
      lineNum0 > t.titleLine && lineNum0 < t.endLine)) return false;
  const prev = lineNum0 > 0 ? doc.line(lineNum0).text : "";
  const next = lineNum0 + 1 < doc.lines ? doc.line(lineNum0 + 2).text : "";
  if (isHrLineText(prev)) return "hr-after";
  if (isHrLineText(next)) return "hr-before";
  if (isQuoteLineText(prev)) return "quote-after";
  return false;
}
function isVacuumLine(doc, lineNum0) {
  return !!getVacuumLineKind(doc, lineNum0);
}
function isHardVacuumLine(doc, lineNum0) {
  const kind = getVacuumLineKind(doc, lineNum0);
  return kind === "hr-before" || kind === "hr-after" || kind === "quote-after";
}
function normalizeInsertLineForVacuum(doc, insertLine) {
  if (!doc || insertLine <= 0 || insertLine >= doc.lines) return insertLine;
  const targetText = doc.line(insertLine + 1).text;
  if (isHrLineText(targetText) && isVacuumLine(doc, insertLine - 1)) return insertLine - 1;
  return insertLine;
}
function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function scanInternalEmbedLines(doc) {
  const total = doc.lines;
  const ranges = [];
  for (let i = 0; i < total; i++) {
    const tr = doc.line(i + 1).text.trim();
    if (/^!\[\[[^\]]+\]\]\s*$/.test(tr)) ranges.push({ startLine: i, endLine: i });
  }
  return ranges;
}
function matchRangesToElement(ranges, el, editorView, slop) {
  if (!ranges.length || !el) return null;
  const er = el.getBoundingClientRect();
  const extra = slop == null ? 50 : slop;
  let best = null, bestDist = Infinity;
  for (const range of ranges) {
    try {
      const doc = editorView.state.doc;
      const from = doc.line(range.startLine + 1).from;
      const coords = editorView.coordsAtPos(from);
      if (!coords) continue;
      const midY = (coords.top + coords.bottom) / 2;
      if (coords.top >= er.top - extra && coords.top <= er.bottom + extra) {
        const dist = Math.abs(midY - (er.top + er.height / 2));
        if (dist < bestDist) { bestDist = dist; best = range; }
      }
    } catch (_) {}
  }
  if (!best) {
    for (const range of ranges) {
      try {
        const doc = editorView.state.doc;
        const from = doc.line(range.startLine + 1).from;
        const coords = editorView.coordsAtPos(from);
        if (!coords) continue;
        const dist = Math.abs(coords.top - er.top);
        if (dist < bestDist) { bestDist = dist; best = range; }
      } catch (_) {}
    }
  }
  return best;
}
function resolveBuiltinEmbedRange(el, editorView, ranges) {
  const visual = getBuiltinEmbedVisualElement(el);
  if (!visual) return null;
  const allRanges = ranges || scanInternalEmbedLines(editorView.state.doc);
  const root = getEmbedBlockRoot(visual);
  return matchRangesToElement(allRanges, root, editorView, 80) ||
    matchRangesToElement(allRanges, visual, editorView, 80);
}
function domLineForNum(editorView, root, n0) {
  for (const cl of Array.from(root.querySelectorAll(".cm-line"))) {
    try {
      if (editorView.state.doc.lineAt(editorView.posAtDOM(cl,0)).number-1===n0) return cl;
    } catch(_) {}
  }
  return null;
}
function resolveElementRangeFallback(el, editorView) {
  if (!el || !editorView) return null;
  const doc = editorView.state.doc;
  try {
    const pos = editorView.posAtDOM(el, 0);
    const lineNum = doc.lineAt(pos).number - 1;
    return resolveBlockBoundary(doc, lineNum);
  } catch (_) {}
  try {
    const r = el.getBoundingClientRect();
    const pos = editorView.posAtCoords({ x: r.left + Math.max(4, r.width * 0.2), y: r.top + Math.max(4, r.height * 0.5) }, false);
    if (pos == null) return null;
    const lineNum = doc.lineAt(pos).number - 1;
    return resolveBlockBoundary(doc, lineNum);
  } catch (_) {}
  return null;
}
function makeHandleEl(extraClass) {
  const h = document.createElement("div");
  h.className = "nsb-handle" + (extraClass ? " " + extraClass : "");
  const d = document.createElement("div");
  d.className = "nsb-dots";
  for (let i = 0; i < 6; i++) d.appendChild(document.createElement("span"));
  h.appendChild(d);
  return h;
}
function makeAddLineButtonEl() {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "clickable-icon nsb-add-line-button";
  b.setAttribute("aria-label", "Insert blank line below");
  try { import_obsidian.setIcon(b, "plus"); } catch (_) { b.textContent = "+"; }
  return b;
}

// Web Bookmark embeds are CodeMirror widgets, so posAtCoords inside the card is
// not reliable. Use the Web Bookmark plugin's stable approach: scan the raw
// document for web-bookmark fences, then match each fence to its visible embed
// by comparing coordsAtPos with the embed's screen rect.
function scanWbFences(doc) {
  const total = doc.lines;
  const getText = n => (n >= 0 && n < total) ? doc.line(n + 1).text : "";
  const fences = [];
  let openLine = -1;
  for (let i = 0; i < total; i++) {
    const tr = getText(i).trim();
    if (openLine < 0 && /^```web-bookmark/i.test(tr)) {
      openLine = i;
    } else if (openLine >= 0 && tr === "```") {
      fences.push({ startLine: openLine, endLine: i });
      openLine = -1;
    }
  }
  return fences;
}

function matchFenceToEmbed(fences, embedEl, editorView) {
  if (!fences.length) return null;
  const er = embedEl.getBoundingClientRect();
  let best = null, bestDist = Infinity;
  for (const fence of fences) {
    try {
      const doc = editorView.state.doc;
      const from = doc.line(fence.startLine + 1).from;
      const coords = editorView.coordsAtPos(from);
      if (!coords) continue;
      const midY = (coords.top + coords.bottom) / 2;
      if (coords.top >= er.top - 40 && coords.top <= er.bottom + 40) {
        const dist = Math.abs(midY - (er.top + er.height / 2));
        if (dist < bestDist) { bestDist = dist; best = fence; }
      }
    } catch (_) {}
  }
  if (!best) {
    for (const fence of fences) {
      try {
        const doc = editorView.state.doc;
        const from = doc.line(fence.startLine + 1).from;
        const coords = editorView.coordsAtPos(from);
        if (!coords) continue;
        const dist = Math.abs(coords.top - er.top);
        if (dist < bestDist) { bestDist = dist; best = fence; }
      } catch (_) {}
    }
  }
  return best;
}

function resolveWbEmbedRange(embed, editorView, fences) {
  if (!isWbBookmarkEmbed(embed)) return null;
  const allFences = fences || scanWbFences(editorView.state.doc);
  const visual = getWbVisualElement(embed);
  const root = getWbBlockRoot(visual || embed);
  return matchFenceToEmbed(allFences, root, editorView) ||
    (visual ? matchFenceToEmbed(allFences, visual, editorView) : null);
}

function getBlockDragLabel(doc, startLine, fallbackEl) {
  let labelText = "";
  try {
    const opener = doc.line(startLine + 1).text.trim();
    const toggle = getToggleByStartLine(doc, startLine);
    if (toggle && toggle.titleLine < doc.lines) {
      labelText = toggleVisibleTitleText(doc, toggle).trim().substring(0, 60) || "Toggle list";
    } else if (/^```web-bookmark/i.test(opener) && startLine + 2 <= doc.lines) {
      const parsed = JSON.parse(doc.line(startLine + 2).text.trim());
      labelText = (parsed.title || parsed.url || "").substring(0, 60);
    } else {
      labelText = opener.substring(0, 60);
    }
  } catch (_) {}
  if (!labelText) labelText = (fallbackEl.textContent || "").trim().substring(0, 60) || "(empty)";
  return labelText;
}

// ─── Block boundary (pure markdown analysis) ──────────────────────────────────────────────
function resolveBlockBoundary(doc, lineNum0) {
  const total = doc.lines;
  const get = n => (n >= 0 && n < total) ? doc.line(n + 1).text : "";
  const t = get(lineNum0), tr = t.trim();
  const toggleHeader = getToggleHeaderForLine(doc, lineNum0);
  if (toggleHeader) return { startLine: toggleHeader.startLine, endLine: toggleHeader.endLine };

  // inside fence — walk back to find opening ```.
  // MUST run before the "opening line" check: a closing ``` also matches
  // /^```/.test() and would be misidentified as a new fence opener, causing
  // the closer to resolve to a wrong single-line block.
  {
    let inFence = false, fs = -1;
    for (let i = 0; i <= lineNum0; i++) {
      const tt = get(i).trim();
      if (!inFence && /^```/.test(tt)) { inFence = true; fs = i; }
      else if (inFence && tt === "```") { inFence = false; fs = -1; }
    }
    if (inFence && fs >= 0) {
      // lineNum0 is inside an open fence (or IS the opening line).
      for (let i = lineNum0 + 1; i < total; i++)
        if (get(i).trim() === "```") return { startLine: fs, endLine: i };
      return { startLine: fs, endLine: lineNum0 };
    }
    // !inFence: lineNum0 is either a closing ``` or plain text.
    // A bare closing ``` must find its opener by scanning backward.
    if (tr === "```") {
      for (let i = lineNum0 - 1; i >= 0; i--)
        if (/^```/.test(get(i).trim())) return { startLine: i, endLine: lineNum0 };
      return { startLine: lineNum0, endLine: lineNum0 };
    }
  }

  // fenced block opening line (has a language tag, e.g. ```web-bookmark or ```js)
  if (/^```/.test(tr)) {
    for (let i = lineNum0 + 1; i < total; i++)
      if (get(i).trim() === "```") return { startLine: lineNum0, endLine: i };
    return { startLine: lineNum0, endLine: lineNum0 };
  }

  // callout / blockquote
  if (/^\s*>/.test(t)) {
    let s = lineNum0, e = lineNum0;
    for (let i = lineNum0-1; i >= 0; i--) { if (/^\s*>/.test(get(i))) s=i; else break; }
    for (let i = lineNum0+1; i < total; i++) { if (/^\s*>/.test(get(i))) e=i; else break; }
    return { startLine: s, endLine: e };
  }

  // Native list rows are draggable as individual rows. This keeps mixed
  // unordered/ordered/task lists from pulling neighbouring rows along.
  const listRe = /^(\s*)([-*+]|\d+\.)\s/;
  const lm = listRe.exec(t);
  if (lm) {
    return { startLine: lineNum0, endLine: lineNum0 };
  }

  return { startLine: lineNum0, endLine: lineNum0 };
}

// ─── Edit overlay ─────────────────────────────────────────────────────────────
var EditOverlay = class {
  constructor(plugin, editorView, cmEditorEl) {
    this.currentTarget = null; this.pinnedTarget = null; this.selTarget = null; this.rafId = null;
    this.plugin = plugin; this.editorView = editorView; this.cmEditorEl = cmEditorEl;
    this.scroller = cmEditorEl.querySelector(".cm-scroller") || cmEditorEl;

    this.hoverHandle  = makeHandleEl("nsb-hover-handle");
    this.pinnedHandle = makeHandleEl("nsb-pinned-handle");
    this.selHandle    = makeHandleEl("nsb-sel-handle");
    this.hoverAddButton = makeAddLineButtonEl();
    for (const h of [this.hoverHandle, this.pinnedHandle, this.selHandle]) {
      h.style.display = "none"; this.scroller.appendChild(h);
    }
    this.hoverAddButton.style.display = "none";
    this.scroller.appendChild(this.hoverAddButton);
    this.attachHandleEvents(this.hoverHandle,  () => this.currentTarget);
    this.attachHandleEvents(this.pinnedHandle, () => this.pinnedTarget);
    this.attachHandleEvents(this.selHandle,    () => this.selTarget);
    this.attachAddButtonEvents();

    this.onDocMove       = this.handleDocMove.bind(this);
    this.onScrollerClick = this.handleScrollerClick.bind(this);
    this.onSelChange     = () => {};
    this.onBlur = () => {
      this.pinnedTarget=null; this.pinnedHandle.style.display="none";
      this.selTarget=null;    this.selHandle.style.display="none";
      this.currentTarget=null; this.hoverHandle.style.display="none"; this.hoverAddButton.style.display="none";
    };
    document.addEventListener("mousemove", this.onDocMove);
    this.scroller.addEventListener("click", this.onScrollerClick);
    cmEditorEl.addEventListener("focusout", this.onBlur);
  }

  positionHandle(handle, el) {
    const scrollerRect = this.scroller.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const s = this.plugin.settings;
    const pad = s.handleSize;
    const handleW = 2 * s.dotSize + s.dotGap + 2 * pad;
    const handleH = 3 * s.dotSize + 2 * s.dotGap + 2 * pad;

    // Align icon center to center of first visual line
    let firstLineCenterY;
    try {
      const cs = window.getComputedStyle(el);
      const paddingTop  = parseFloat(cs.paddingTop)  || 0;
      const lineHeightRaw = cs.lineHeight;
      const lineHeight = lineHeightRaw === "normal"
        ? parseFloat(cs.fontSize) * 1.2
        : parseFloat(lineHeightRaw);
      firstLineCenterY = elRect.top + paddingTop + lineHeight / 2;
    } catch(_) {
      firstLineCenterY = elRect.top + elRect.height / 2;
    }

    let anchorLeft = elRect.left;
    try {
      const isNativeListLine = el.classList && el.classList.contains("cm-line") && /\bHyperMD-list-line\b/.test(el.className || "");
      if (isNativeListLine) {
        const marginLeft = parseFloat(window.getComputedStyle(el).marginLeft || "") || 0;
        anchorLeft -= marginLeft;
      }
    } catch (_) {}

    const top  = firstLineCenterY - scrollerRect.top + this.scroller.scrollTop - handleH / 2;
    const left = anchorLeft - scrollerRect.left - handleW - 2 - (this.plugin.settings.handleOffset || 0);
    handle.style.top  = top + "px";
    handle.style.left = Math.max(0, left) + "px";
    return { top, left: Math.max(0, left), width: handleW, height: handleH };
  }

  positionAddButton(metrics) {
    if (!metrics) return;
    const size = 22;
    const gap = 5;
    const left = Math.max(0, metrics.left - size - gap);
    const top = metrics.top + Math.max(0, (metrics.height - size) / 2);
    this.hoverAddButton.style.left = left + "px";
    this.hoverAddButton.style.top = top + "px";
  }

  // Full leftward reach of the hover cluster (drag handle + add/plus button),
  // measured from a block's left edge. The hover hit-region must cover the
  // outer edge of the plus button plus a small margin, otherwise the pointer
  // leaves the region (and the icons vanish) before it can reach the plus.
  // Mirrors the geometry in positionHandle()/positionAddButton() so it stays
  // correct when the handle/dot settings change.
  hoverClusterPad() {
    const s = this.plugin.settings;
    const handleW = 2 * s.dotSize + s.dotGap + 2 * s.handleSize;
    const addButtonW = 22;
    const addGap = 5;
    const margin = 12;
    return handleW + 2 + (s.handleOffset || 0) + addButtonW + addGap + margin;
  }

  _updateSelHandle() {
    this.selTarget=null; this.selHandle.style.display="none"; return;
    const state = this.editorView.state, sel = state.selection.main;
    if (sel.empty) { this.selTarget=null; this.selHandle.style.display="none"; return; }
    const doc=state.doc, fromL=doc.lineAt(sel.from), toL=doc.lineAt(sel.to);
    // Show handle for any selection that spans at least 2 lines.
    // Previously required sel.from===fromL.from && sel.to===toL.to (full-line selection),
    // which excluded [[link]] selections that don't start at col 0.
    if (fromL.number === toL.number) {
      this.selTarget=null; this.selHandle.style.display="none"; return;
    }
    const s0=fromL.number-1, topEl=this._domLineForNum(s0);
    if (!topEl) { this.selTarget=null; this.selHandle.style.display="none"; return; }
    // Use actual selection line range (from's line to to's line).
    // endLine is the line containing sel.to (may be partial — that's fine for move).
    this.selTarget = { kind:"sel", el:topEl, startLine:s0, endLine:toL.number-1 };
    this.positionHandle(this.selHandle, topEl);
    this.selHandle.style.display = "flex";
  }

  attachHandleEvents(handle, getTarget) {
    handle.addEventListener("mousedown", e => {
      if (e.button!==0) return;
      e.preventDefault(); e.stopPropagation();
      const t = getTarget(); if (!t) return;

      const startX = e.clientX, startY = e.clientY;
      let dragging = false;

      const onMouseMove = mv => {
        if (dragging) return;
        const dx = mv.clientX - startX, dy = mv.clientY - startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
          dragging = true;
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);
          this.plugin.beginEditDrag(e, t, this.editorView, this);
        }
      };

      const onMouseUp = up => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        if (!dragging) {
          // Left-click (no drag): highlight block + show context menu
          const mv = this.plugin.getMdViewForEditor(this.editorView);
          if (mv) this.plugin.showBlockMenu(up, t.el, mv, "edit", t);
        }
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    handle.addEventListener("contextmenu", e => {
      e.preventDefault(); e.stopPropagation();
      const t = getTarget(); if (!t) return;
      const mv = this.plugin.getMdViewForEditor(this.editorView);
      if (mv) this.plugin.showBlockMenu(e, t.el, mv, "edit", t);
    });
  }

  attachAddButtonEvents() {
    this.hoverAddButton.addEventListener("mousedown", e => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
    });
    this.hoverAddButton.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      const target = this.currentTarget;
      if (!target) return;
      this.plugin.insertBlankLineAfterTargetCM(this.editorView, target);
      this.hoverAddButton.style.display = "none";
      this.hoverHandle.style.display = "none";
      this.currentTarget = null;
    });
    this.hoverAddButton.addEventListener("contextmenu", e => {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  findWbBlockAt(mx, my, wbFences) {
    const pad = this.hoverClusterPad();
    for (const visual of Array.from(this.scroller.querySelectorAll(".wb-container"))) {
      const root = getWbBlockRoot(visual);
      if (!root || isTableElement(root)) continue;
      const r = visual.getBoundingClientRect();
      if (mx>=r.left-pad && mx<=r.right && my>=r.top && my<=r.bottom) {
        const lines = resolveWbEmbedRange(visual, this.editorView, wbFences);
        if (lines) return { kind:"embed", el:visual, root, ...lines };
      }
    }
    return null;
  }

  findCalloutBlockAt(mx, my, quoteRanges) {
    const pad = this.hoverClusterPad();
    for (const visual of Array.from(this.scroller.querySelectorAll(".callout"))) {
      const root = getEmbedBlockRoot(visual);
      if (!root || isTableElement(root)) continue;
      const r = visual.getBoundingClientRect();
      if (mx>=r.left-pad && mx<=r.right && my>=r.top && my<=r.bottom) {
        const lines = matchRangesToElement(quoteRanges, root, this.editorView, 80) ||
          matchRangesToElement(quoteRanges, visual, this.editorView, 80);
        if (lines) return { kind:"quote", el:visual, root, ...lines };
      }
    }
    return null;
  }

  findBuiltinEmbedAt(mx, my, embedRanges) {
    const pad = this.hoverClusterPad();
    for (const visual of Array.from(this.scroller.querySelectorAll(BUILTIN_EMBED_SELECTOR))) {
      if (isWbBookmarkEmbed(visual)) continue;
      const root = getEmbedBlockRoot(visual);
      if (!root || isTableElement(root)) continue;
      const r = visual.getBoundingClientRect();
      if (mx>=r.left-pad && mx<=r.right && my>=r.top && my<=r.bottom) {
        const lines = resolveBuiltinEmbedRange(visual, this.editorView, embedRanges);
        if (lines) return { kind:"embed", el:visual, root, ...lines };
      }
    }
    return null;
  }

  findBlockAt(mx, my) {
    const pad = this.hoverClusterPad();
    // Block providers answer first. Rows inside their units are never plain
    // line targets: a locked unit (section title, section archive) simply
    // gets no handle at all.
    const providerUnits = [];
    for (const provider of this.plugin.blockProviders()) {
      const providerTarget = provider.nsbTargetAt?.(this.editorView, mx, my, pad);
      if (providerTarget) return providerTarget;
      for (const unit of provider.nsbUnits(this.editorView) || []) providerUnits.push(unit);
    }
    // First pass: scan embeds. WB-managed ones are NOT hover targets, but all
    // matched bookmark widget ranges are recorded so the cm-line pass below can
    // skip their hidden source lines.
    const wbFences = scanWbFences(this.editorView.state.doc);
    const wbSkipRanges = wbFences.slice();
    const quoteSkipRanges = [];
    const quoteRanges = scanQuoteBlocks(this.editorView.state.doc);
    const embedSkipRanges = [];
    const embedRanges = scanInternalEmbedLines(this.editorView.state.doc);
    const toggles = scanToggleBlocks(this.editorView.state.doc);
    const toggleMarkerLines = toggleHiddenMarkerLines(toggles);
    const wbHover = this.findWbBlockAt(mx, my, wbFences);
    if (wbHover) {
      wbSkipRanges.push({ startLine: wbHover.startLine, endLine: wbHover.endLine });
      if (!isWbManagedByActivePlugin(wbHover.el, this.plugin.app)) return wbHover;
    }
    const quoteHover = this.findCalloutBlockAt(mx, my, quoteRanges);
    if (quoteHover) {
      quoteSkipRanges.push({ startLine: quoteHover.startLine, endLine: quoteHover.endLine });
      return quoteHover;
    }
    const embedHover = this.findBuiltinEmbedAt(mx, my, embedRanges);
    if (embedHover) {
      embedSkipRanges.push({ startLine: embedHover.startLine, endLine: embedHover.endLine });
      return embedHover;
    }
    for (const embed of Array.from(this.scroller.querySelectorAll(".cm-embed-block"))) {
      if (isTableElement(embed)) continue;
      const wbRange = resolveWbEmbedRange(embed, this.editorView, wbFences);
      if (wbRange) wbSkipRanges.push(wbRange);
      const builtinRange = resolveBuiltinEmbedRange(embed, this.editorView, embedRanges);
      if (builtinRange) embedSkipRanges.push(builtinRange);
      if (isWbManagedByActivePlugin(embed, this.plugin.app)) {
        continue;
      }
      const r = embed.getBoundingClientRect();
      if (mx>=r.left-pad && mx<=r.right && my>=r.top && my<=r.bottom) {
        const lines = wbRange || builtinRange || this._resolveEmbedRange(embed);
        if (lines) return { kind:"embed", el:embed, ...lines };
      }
    }
    for (const line of Array.from(this.scroller.querySelectorAll(".cm-line"))) {
      if (isOutlinerManaged(line) || isTableElement(line)) continue;
      const r = line.getBoundingClientRect();
      if (mx>=r.left-pad && mx<=r.right && my>=r.top && my<=r.bottom) {
        const ln = this.lineNumFromDom(line);
        if (ln < 0) continue;
        if (isVacuumLine(this.editorView.state.doc, ln)) continue;
        if (toggleMarkerLines.has(ln) || isLineHiddenByCollapsedToggle(toggles, ln)) continue;
        if (providerUnits.some(u => ln >= u.startLine && ln <= u.endLine)) continue;
        // Skip cm-lines that live inside a wb-managed embed — they're the
        // hidden source of the bookmark fence, not a real hover target.
        if (wbSkipRanges.some(rng => ln >= rng.startLine && ln <= rng.endLine)) continue;
        if (quoteSkipRanges.some(rng => ln >= rng.startLine && ln <= rng.endLine)) continue;
        if (embedSkipRanges.some(rng => ln >= rng.startLine && ln <= rng.endLine)) continue;
        return { kind:"line", el:line, startLine:ln, endLine:ln };
      }
    }
    return null;
  }

  // Probe multiple Y positions across the embed to find the fence-opening line.
  // Prefer any result where startLine < endLine (genuine multi-line block).
  _resolveEmbedRange(embed) {
    const wbRange = resolveWbEmbedRange(embed, this.editorView);
    if (wbRange) return wbRange;
    const builtinRange = resolveBuiltinEmbedRange(embed, this.editorView);
    if (builtinRange) return builtinRange;
    const r = embed.getBoundingClientRect();
    const doc = this.editorView.state.doc;
    const h = r.bottom - r.top;
    // Sample at top, 1/4, 1/2, 3/4, near-bottom to maximise chance of hitting
    // a line inside the fence (not the invisible line above it).
    const probeYs = [
      r.top + 2,
      r.top + Math.max(4, h * 0.15),
      r.top + Math.max(8, h * 0.35),
      r.top + Math.max(12, h * 0.55),
      r.top + Math.max(16, h * 0.75),
    ];
    let fallback = null;
    for (const py of probeYs) {
      try {
        const pos = this.editorView.posAtCoords({ x: r.left + 4, y: py }, false);
        if (pos == null) continue;
        const lineNum = doc.lineAt(pos).number - 1;
        const bounds = resolveBlockBoundary(doc, lineNum);
        if (bounds.startLine < bounds.endLine) return bounds; // multi-line: confident
        if (!fallback) fallback = bounds;
      } catch(_) {}
    }
    return fallback;
  }

  lineNumFromDom(line) {
    try { return this.editorView.state.doc.lineAt(this.editorView.posAtDOM(line,0)).number-1; }
    catch(_) { return -1; }
  }
  _domLineForNum(n0) {
    for (const cl of Array.from(this.scroller.querySelectorAll(".cm-line"))) {
      try { if (this.editorView.state.doc.lineAt(this.editorView.posAtDOM(cl,0)).number-1===n0) return cl; }
      catch(_) {}
    }
    return null;
  }

  handleDocMove(e) {
    if (this.plugin.isDragging) return;
    if (e.target && e.target.closest && e.target.closest(".nsb-handle,.nsb-add-line-button")) return;
    if (this.rafId!==null) cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      if (this.plugin.isDragging) return;
      const mx=e.clientX, my=e.clientY, er=this.cmEditorEl.getBoundingClientRect();
      const pad=this.hoverClusterPad();
      if (mx<er.left-pad||mx>er.right||my<er.top||my>er.bottom) {
        this.hoverHandle.style.display="none"; this.hoverAddButton.style.display="none"; this.currentTarget=null; return;
      }
      const target=this.findBlockAt(mx,my);
      if (!target) { this.hoverHandle.style.display="none"; this.hoverAddButton.style.display="none"; this.currentTarget=null; return; }
      this.currentTarget=target;
      const metrics = this.positionHandle(this.hoverHandle, target.el);
      this.positionAddButton(metrics);
      // A provider target with noHandle (a section's closing divider) cannot be
      // dragged or opened as a menu: only the plus shows, where it always sits.
      this.hoverHandle.style.display=target.noHandle?"none":"flex";
      this.hoverAddButton.style.display="flex";
    });
  }

  handleScrollerClick(e) {
    this.pinnedTarget=null; this.pinnedHandle.style.display="none"; return;
    const dt=e.target;
    if (dt.closest(".nsb-handle")) return;
    if (isTableElement(dt)) { this.pinnedTarget=null; this.pinnedHandle.style.display="none"; return; }
    const wbFences = scanWbFences(this.editorView.state.doc);
    const quoteRanges = scanQuoteBlocks(this.editorView.state.doc);
    const embedRanges = scanInternalEmbedLines(this.editorView.state.doc);
    const toggles = scanToggleBlocks(this.editorView.state.doc);
    const toggleMarkerLines = toggleHiddenMarkerLines(toggles);
    const callout=dt.closest(".callout");
    if (callout&&!isTableElement(callout)) {
      const lines=matchRangesToElement(quoteRanges,getEmbedBlockRoot(callout),this.editorView,80)||
        matchRangesToElement(quoteRanges,callout,this.editorView,80);
      if (lines) {
        this.pinnedTarget={kind:"quote",el:callout,...lines};
        this.positionHandle(this.pinnedHandle,callout);
        this.pinnedHandle.style.display="flex"; return;
      }
    }
    const builtInVisual=getBuiltinEmbedVisualElement(dt);
    if (builtInVisual&&!isTableElement(builtInVisual)) {
      const lines=resolveBuiltinEmbedRange(builtInVisual,this.editorView,embedRanges);
      if (lines) {
        this.pinnedTarget={kind:"embed",el:builtInVisual,...lines};
        this.positionHandle(this.pinnedHandle,builtInVisual);
        this.pinnedHandle.style.display="flex"; return;
      }
    }
    const wbContainer=dt.closest(".wb-container");
    const embed=dt.closest(".cm-embed-block")||(wbContainer?getWbBlockRoot(wbContainer):null);
    if (embed&&!isTableElement(embed)&&!isWbManagedByActivePlugin(embed,this.plugin.app)) {
      const lines=resolveWbEmbedRange(wbContainer||embed,this.editorView,wbFences)||this._resolveEmbedRange(embed);
      if (lines) {
        const targetEl=wbContainer||embed;
        this.pinnedTarget={kind:"embed",el:targetEl,...lines};
        this.positionHandle(this.pinnedHandle,targetEl);
        this.pinnedHandle.style.display="flex"; return;
      }
    }
    // Click inside a wb-managed embed → wb plugin handles it; clear pin.
    if (embed && isWbManagedByActivePlugin(embed,this.plugin.app)) {
      this.pinnedTarget=null; this.pinnedHandle.style.display="none"; return;
    }
    const line=dt.closest(".cm-line");
    if (line&&!isOutlinerManaged(line)&&!isTableElement(line)) {
      const ln=this.lineNumFromDom(line);
      if (ln>=0) {
        if (isVacuumLine(this.editorView.state.doc, ln)) {
          this.pinnedTarget=null; this.pinnedHandle.style.display="none"; return;
        }
        if (toggleMarkerLines.has(ln) || isLineHiddenByCollapsedToggle(toggles, ln)) {
          this.pinnedTarget=null; this.pinnedHandle.style.display="none"; return;
        }
        // Same hidden-source-line defense as findBlockAt: a cm-line whose
        // line number lies inside any bookmark embed is not pinnable.
        const insideWb = Array.from(this.scroller.querySelectorAll(".cm-embed-block"))
          .some(em => {
            if (isTableElement(em)) return false;
            const rng = resolveWbEmbedRange(em,this.editorView,wbFences);
            return rng && ln >= rng.startLine && ln <= rng.endLine;
          });
        if (!insideWb) {
          this.pinnedTarget={kind:"line",el:line,startLine:ln,endLine:ln};
          this.positionHandle(this.pinnedHandle,line);
          this.pinnedHandle.style.display="flex"; return;
        }
      }
    }
    this.pinnedTarget=null; this.pinnedHandle.style.display="none";
  }

  hideAll() { this.hoverHandle.style.display="none"; this.hoverAddButton.style.display="none"; this.pinnedHandle.style.display="none"; }
  // After a drag completes, don't restore the old pinnedHandle — the block
  // has moved and the cursor is now elsewhere. Clear pinnedTarget instead.
  clearPinnedAfterDrag() {
    this.pinnedTarget = null;
    this.pinnedHandle.style.display = "none";
  }
  restorePinned() {
    if (this.pinnedTarget) { this.positionHandle(this.pinnedHandle,this.pinnedTarget.el); this.pinnedHandle.style.display="flex"; }
  }
  destroy() {
    if (this.rafId!==null) cancelAnimationFrame(this.rafId);
    document.removeEventListener("mousemove",this.onDocMove);
    this.scroller.removeEventListener("click",this.onScrollerClick);
    this.cmEditorEl.removeEventListener("focusout",this.onBlur);
    this.hoverHandle.remove(); this.hoverAddButton.remove(); this.pinnedHandle.remove(); this.selHandle.remove();
  }
};

// ─── Main plugin ──────────────────────────────────────────────────────────────
var NsbEditorViewPlugin = class {
  constructor(plugin, view, cmEl) {
    this.plugin = plugin;
    this.view = view;
    this.mobileViewOnly = isMobileDevice();
    this.cmEl = cmEl;
    this.overlay = (this.mobileViewOnly || !NSB_BLOCK_FEATURES_ENABLED) ? null : new EditOverlay(plugin, view, cmEl);
    this.livePreviewMode = isLivePreviewEditorView(view);
    this.livePreviewSyncRaf = null;
    this.legacyMigrationRaf = null;
    this.nativeFoldGuardRaf = null;
    this.scroller = view.scrollDOM;
    this.toggleButtons = [];
    this.toggleButtonRaf = null;
    this.hierarchyMutationRaf = null;
    this.hierarchyDirty = true;
    this.hierarchyMarked = false;
    this.toggleScanDoc = null;
    this.toggleScan = null;
    this.savedRightClickSelection = null;
    this.savedRightClickNativeRanges = null;
    this.onToggleRowMouseDown = this.handleToggleRowMouseDown.bind(this);
    this.onMouseDownCapture = this.handleMouseDownCapture.bind(this);
    this.onContextMenuCapture = this.handleContextMenuCapture.bind(this);
    this.onKeyDown = this.handleKeyDown.bind(this);
    this.onBeforeInputCapture = this.handleBeforeInputCapture.bind(this);
    this.onPasteCapture = this.handlePasteCapture.bind(this);
    this.onMobileBeforeInput = this.handleMobileBeforeInput.bind(this);
    // Scroll recording warms up shortly after the editor (re)initializes:
    // Obsidian swaps documents by recreating the CM state (and this plugin),
    // and the swap's own clamped scroll event must not be attributed to the
    // newly displayed file.
    this.scrollRecordReadyAt = Date.now() + 250;
    this.onScroll = () => {
      this.scheduleToggleButtons();
      if (Date.now() >= this.scrollRecordReadyAt) plugin.recordScrollPosition(view);
    };
    this.appliedGutterPad = 0;
    this.gutterRaf = null;
    view.scrollDOM.addEventListener("mousedown", this.onToggleRowMouseDown);
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    if (!this.mobileViewOnly) {
      document.addEventListener("pointerdown", this.onMouseDownCapture, true);
      document.addEventListener("mousedown", this.onMouseDownCapture, true);
      document.addEventListener("mouseup", this.onMouseDownCapture, true);
      document.addEventListener("auxclick", this.onMouseDownCapture, true);
      document.addEventListener("contextmenu", this.onContextMenuCapture, true);
      view.dom.addEventListener("keydown", this.onKeyDown, true);
      view.dom.addEventListener("beforeinput", this.onBeforeInputCapture, true);
      view.dom.addEventListener("paste", this.onPasteCapture, true);
    } else {
      // Mobile: soft keyboards rarely deliver real Enter/Backspace keydown
      // events (often keyCode 229), so TL key behaviour is driven from
      // beforeinput input types instead. A keydown listener is still
      // attached for hardware keyboards.
      view.dom.addEventListener("keydown", this.onKeyDown, true);
      view.dom.addEventListener("beforeinput", this.onMobileBeforeInput, true);
      // Mobile: taps on internal links inside table cells navigate instead
      // of entering cell edit (desktop behaviour parity).
      this.onMobileTableLinkTap = e => { this.plugin.handleMobileTableLinkTap(this.view, e); };
      view.dom.addEventListener("click", this.onMobileTableLinkTap, true);
    }
    this.hierarchyMutationObserver = new MutationObserver(mutations => {
      if (this.hierarchyMutationRaf !== null) return;
      const relevant = mutations.some(m => Array.from(m.addedNodes || []).some(nodeHasNsbEmbedLikeContent));
      if (!relevant) return;
      this.scheduleHierarchyLayout();
    });
    this.hierarchyMutationObserver.observe(this.scroller, { childList: true, subtree: true });
    // Window resizes (e.g. half-screen ⇄ full-screen) re-flow the note layout
    // after CodeMirror's own updates; re-sync the gutter and the triangle
    // overlay positions once the layout settles.
    this.onWindowResize = () => {
      this.scheduleGutterCheck();
      this.scheduleHierarchyLayout();
      if (this.resizeSettleTimer) clearTimeout(this.resizeSettleTimer);
      this.resizeSettleTimer = setTimeout(() => {
        this.resizeSettleTimer = null;
        this.scheduleGutterCheck();
        this.scheduleToggleButtons();
      }, 150);
    };
    this.resizeSettleTimer = null;
    window.addEventListener("resize", this.onWindowResize);
    this.scheduleLivePreviewStateSync();
    this.scheduleToggleButtons();
    this.scheduleGutterCheck();
  }
  update(update) {
    const livePreviewMode = isLivePreviewEditorView(this.view);
    if (livePreviewMode !== this.livePreviewMode) {
      this.livePreviewMode = livePreviewMode;
      this.hierarchyDirty = true;
      this.scheduleLivePreviewStateSync();
      if (!livePreviewMode) {
        this.clearToggleButtons();
        this.clearHierarchyVisualLayout();
      }
    }
    if (update.docChanged || update.viewportChanged || update.geometryChanged) this.scheduleHierarchyLayout();
    if (update.docChanged) this.scheduleLegacyMigration();
    if (update.docChanged || update.transactions.some(tr => tr.effects && tr.effects.length)) {
      this.scheduleNativeFoldGuard();
    }
    if (update.geometryChanged || update.viewportChanged) this.scheduleGutterCheck();
  }
  // Keeps enough left gutter inside the scroller for the drag handle + plus
  // button. When the window is narrow Obsidian protects the sidebar and the
  // note's own left margin can shrink below the icon cluster width, leaving
  // the icons squashed on top of each other at x=0. The note content area is
  // compressed instead, so both icons always render and stay clickable.
  scheduleGutterCheck() {
    if (this.mobileViewOnly || !this.overlay) return;
    if (this.gutterRaf != null) return;
    this.gutterRaf = requestAnimationFrame(() => {
      this.gutterRaf = null;
      this.ensureHandleGutter();
    });
  }
  ensureHandleGutter() {
    if (this.mobileViewOnly || !this.overlay) return;
    try {
      const scrollerRect = this.scroller.getBoundingClientRect();
      const contentRect = this.view.contentDOM.getBoundingClientRect();
      if (!scrollerRect.width || !contentRect.width) return;
      const applied = this.appliedGutterPad || 0;
      // Gutter the theme/layout provides on its own (our padding excluded).
      const baseGutter = (contentRect.left - scrollerRect.left) - applied;
      const needed = this.overlay.hoverClusterPad();
      const extra = Math.max(0, Math.ceil(needed - baseGutter));
      if (extra === applied) return;
      this.appliedGutterPad = extra;
      this.scroller.style.paddingLeft = extra > 0 ? extra + "px" : "";
      // The padding change just shifted the content: re-render the toggle
      // triangles (and re-check once more next frame) so they don't sit on
      // stale coordinates over the note text.
      this.scheduleToggleButtons();
      this.scheduleGutterCheck();
    } catch (_) {}
  }
  // Mobile soft keyboards drive editing through beforeinput rather than real
  // key events. Map the relevant input types onto the same TL handlers that
  // desktop keydown uses, so Enter/Backspace behave identically on mobile.
  handleMobileBeforeInput(e) {
    if (e.defaultPrevented || e.isComposing) return;
    const inputType = e.inputType || "";
    let key = null;
    if (inputType === "insertParagraph" || inputType === "insertLineBreak") key = "Enter";
    else if (inputType === "deleteContentBackward" || inputType === "deleteContent") key = "Backspace";
    else if (inputType === "deleteContentForward") key = "Delete";
    if (!key) return;
    const synthetic = {
      key,
      isComposing: false,
      preventDefault: () => e.preventDefault(),
      stopPropagation: () => e.stopPropagation(),
      stopImmediatePropagation: () => { if (e.stopImmediatePropagation) e.stopImmediatePropagation(); }
    };
    if (key === "Enter") {
      if (this.plugin.handleToggleEnter(this.view, synthetic)) this.scheduleToggleButtons();
      return;
    }
    if (this.plugin.handleToggleDelete(this.view, synthetic)) this.scheduleToggleButtons();
    else if (this.livePreviewMode) this.plugin.handleListMarkerKey(this.view, synthetic);
  }
  scheduleNativeFoldGuard() {
    if (!import_language || this.nativeFoldGuardRaf != null) return;
    this.nativeFoldGuardRaf = requestAnimationFrame(() => {
      this.nativeFoldGuardRaf = null;
      try { this.plugin.clearNativeFoldsOnToggleLines(this.view); } catch (_) {}
    });
  }
  scheduleLivePreviewStateSync() {
    if (this.livePreviewSyncRaf !== null) cancelAnimationFrame(this.livePreviewSyncRaf);
    this.livePreviewSyncRaf = requestAnimationFrame(() => {
      this.livePreviewSyncRaf = null;
      try {
        if (this.livePreviewMode) this.plugin.migrateLegacyTogglesCM(this.view);
      } catch (_) {}
      try {
        if (this.plugin.setLivePreviewModeEffect) {
          this.view.dispatch({ effects: this.plugin.setLivePreviewModeEffect.of(this.livePreviewMode) });
        }
      } catch (_) {}
    });
  }
  scheduleLegacyMigration() {
    if (this.legacyMigrationRaf != null) return;
    this.legacyMigrationRaf = requestAnimationFrame(() => {
      this.legacyMigrationRaf = null;
      if (!this.livePreviewMode) return;
      try { this.plugin.migrateLegacyTogglesCM(this.view); } catch (_) {}
    });
  }
  scheduleToggleButtons() {
    if (this.toggleButtonRaf !== null) cancelAnimationFrame(this.toggleButtonRaf);
    this.toggleButtonRaf = requestAnimationFrame(() => {
      this.toggleButtonRaf = null;
      this.renderToggleButtons();
    });
  }
  // Hierarchy layout only has to run when the document, the viewport or the
  // DOM changed; a plain scroll just repositions the triangles. Content-block
  // providers (Gallery View) call this after rendering a widget.
  scheduleHierarchyLayout() {
    this.hierarchyDirty = true;
    this.scheduleToggleButtons();
  }
  toggleBlocks() {
    const doc = this.view.state.doc;
    if (this.toggleScanDoc !== doc) {
      this.toggleScan = scanToggleBlocks(doc);
      this.toggleScanDoc = doc;
    }
    return this.toggleScan;
  }
  clearToggleButtons() {
    for (const btn of this.toggleButtons) btn.remove();
    this.toggleButtons = [];
  }
  renderToggleButtons() {
    this.clearToggleButtons();
    if (!this.livePreviewMode) {
      this.clearHierarchyVisualLayout();
      this.hierarchyMarked = false;
      this.hierarchyDirty = true;
      return;
    }
    const doc = this.view.state.doc;
    const toggles = this.toggleBlocks();
    if (this.hierarchyDirty) {
      this.hierarchyDirty = false;
      this.applyHierarchyVisualLayout(toggles);
    }
    if (!toggles.length) return;
    const scrollerRect = this.scroller.getBoundingClientRect();
    const titleLines = Array.from(this.scroller.querySelectorAll(".cm-line.nsb-toggle-title-line"));
    const seenTitleLines = new Set();
    for (const t of toggles) {
      if (isLineHiddenByCollapsedToggle(toggles, t.titleLine)) continue;
      if (seenTitleLines.has(t.titleLine)) continue;
      seenTitleLines.add(t.titleLine);
      const line = titleLines.find(el => el.getAttribute("data-nsb-toggle-id") === t.id) ||
        domLineForNum(this.view, this.scroller, t.titleLine);
      if (!line) continue;
      const r = line.getBoundingClientRect();
      if (r.bottom < scrollerRect.top || r.top > scrollerRect.bottom) continue;
      const size = this.plugin.settings.toggleIconSize || 16;
      const empty = !toggleHasTitleContent(doc, t);
      let firstRowTop = r.top, firstRowBottom = r.bottom;
      try {
        const titleDocLine = doc.line(t.titleLine + 1);
        // Empty titles render the row as a zero-width fold widget, so
        // coordsAtPos there returns a height-0 box; skip it and measure the
        // line rect (padding-aware) instead. Non-empty titles use the first
        // glyph's box from coordsAtPos.
        const coords = empty ? null : this.view.coordsAtPos(titleDocLine.from);
        if (coords && coords.bottom > coords.top) {
          firstRowTop = coords.top;
          firstRowBottom = coords.bottom;
        } else {
          const m = this._firstRowMetrics(line, r, size);
          firstRowTop = m.top;
          firstRowBottom = m.bottom;
        }
      } catch (_) {
        const m = this._firstRowMetrics(line, r, size);
        firstRowTop = m.top;
        firstRowBottom = m.bottom;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "nsb-toggle-triangle nsb-toggle-overlay-triangle" +
        (t.open ? " is-open" : " is-closed") +
        (empty ? " is-empty" : "") +
        (this.plugin.activeToggleId === t.id ? " is-active" : "");
      btn.setAttribute("aria-label", t.open ? "Collapse toggle list" : "Expand toggle list");
      btn.style.top = (firstRowTop - scrollerRect.top + this.scroller.scrollTop + Math.max(0, (firstRowBottom - firstRowTop - size) / 2)) + "px";
      btn.style.left = (r.left - scrollerRect.left + this.scroller.scrollLeft + 4 + t.depth * 22) + "px";
      btn.addEventListener("mousedown", e => {
        e.preventDefault();
        e.stopPropagation();
        this.plugin.activeToggleId = t.id;
        document.querySelectorAll(".nsb-toggle-triangle.is-active").forEach(el => el.classList.remove("is-active"));
        btn.classList.add("is-active");
      });
      btn.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        this.plugin.setToggleOpen(this.view, t.startLine, !t.open);
        this.scheduleToggleButtons();
      });
      this.scroller.appendChild(btn);
      this.toggleButtons.push(btn);
    }
  }
  // Top/bottom (client coords) of the first visual text row of a title line,
  // for triangle centering. Accounts for the line's padding-top — important
  // with Notion block-spacing on, otherwise the triangle sits too high. The
  // height is clamped to one text row so wrapped/heading titles don't center
  // the triangle across the whole block.
  _firstRowMetrics(line, rect, iconSize) {
    let padTop = 0, rowH = 0;
    try {
      const cs = window.getComputedStyle(line);
      padTop = parseFloat(cs.paddingTop) || 0;
      const parsedLineHeight = parseFloat(cs.lineHeight || "");
      if (Number.isFinite(parsedLineHeight) && parsedLineHeight > 0) {
        rowH = parsedLineHeight;
      } else {
        const fontSize = parseFloat(cs.fontSize || "") || 16;
        rowH = fontSize * 1.5;
      }
    } catch (_) {
      rowH = 24;
    }
    const top = rect.top + padTop;
    const avail = Math.max(0, rect.height - padTop);
    const h = Math.max(iconSize, Math.min(avail > 0 ? avail : rowH, rowH));
    return { top, bottom: top + h };
  }
  clearHierarchyVisualLayout() {
    if (this.plugin.expiringBlocks && this.plugin.expiringBlocks.clearVisual) {
      this.plugin.expiringBlocks.clearVisual(this.scroller);
    }
    this.scroller.querySelectorAll(".nsb-hierarchy-visual,.nsb-hierarchy-frame-clean").forEach(el => {
      el.classList.remove("nsb-hierarchy-visual");
      el.classList.remove("nsb-hierarchy-hidden");
      el.classList.remove("nsb-hierarchy-frame-clean");
      el.style.removeProperty("--nsb-hierarchy-offset");
      el.style.marginLeft = "";
      el.style.width = "";
      el.style.maxWidth = "";
      el.style.boxSizing = "";
      el.style.display = "";
    });
  }
  markHierarchyVisual(el, depth) {
    if (!el || depth <= 0) return;
    const offset = 18 + depth * 22;
    el.classList.add("nsb-hierarchy-visual");
    el.style.setProperty("--nsb-hierarchy-offset", offset + "px");
    el.style.marginLeft = offset + "px";
    el.style.width = "calc(100% - " + offset + "px)";
    el.style.maxWidth = "calc(100% - " + offset + "px)";
    el.style.boxSizing = "border-box";
  }
  markHierarchyFrameClean(el) {
    if (!el) return;
    el.classList.add("nsb-hierarchy-frame-clean");
  }
  applyHierarchyVisualLayout(toggles) {
    const any = !!(toggles && toggles.length);
    if (!any && !this.hierarchyMarked) return;
    this.clearHierarchyVisualLayout();
    this.hierarchyMarked = any;
    if (!any) return;
    const doc = this.view.state.doc;
    const wbFences = scanWbFences(doc);
    const quoteRanges = scanQuoteBlocks(doc);
    const embedRanges = scanInternalEmbedLines(doc);
    const handled = new Set();
    const markHidden = (el) => {
      if (!el || handled.has(el)) return;
      handled.add(el);
      el.classList.add("nsb-hierarchy-visual","nsb-hierarchy-hidden");
      el.style.setProperty("display", "none", "important");
    };
    const mark = (el, range) => {
      if (!el || !range || handled.has(el)) return;
      if (isRangeHiddenByCollapsedToggle(toggles, range.startLine, range.endLine)) {
        markHidden(el);
        return;
      }
      handled.add(el);
      this.markHierarchyVisual(el, getToggleBodyDepth(toggles, range.startLine));
      if (this.plugin.expiringBlocks && this.plugin.expiringBlocks.decorateVisual) {
        this.plugin.expiringBlocks.decorateVisual(el, range.startLine, range.endLine, toggles);
      }
    };
    const markVisualWithRoot = (visual, root, range) => {
      if (!visual || !range || handled.has(visual)) return;
      if (isRangeHiddenByCollapsedToggle(toggles, range.startLine, range.endLine)) {
        markHidden(root || visual);
        return;
      }
      handled.add(visual);
      if (root && root !== visual) this.markHierarchyFrameClean(root);
      this.markHierarchyVisual(visual, getToggleBodyDepth(toggles, range.startLine));
      if (this.plugin.expiringBlocks && this.plugin.expiringBlocks.decorateVisual) {
        this.plugin.expiringBlocks.decorateVisual(visual, range.startLine, range.endLine, toggles);
      }
    };
    for (const provider of this.plugin.blockProviders()) {
      for (const unit of provider.nsbUnits(this.view) || []) {
        // Ordinary rows (a section title line) already get the toggle-body
        // line layout; only widget-backed units need the visual offset.
        if (unit.el && unit.el.classList && unit.el.classList.contains("cm-line")) continue;
        mark(unit.el, unit);
      }
    }
    for (const visual of Array.from(this.scroller.querySelectorAll(".wb-container"))) {
      const root = getWbBlockRoot(visual) || visual;
      const range = resolveWbEmbedRange(visual, this.view, wbFences) || resolveElementRangeFallback(root, this.view);
      markVisualWithRoot(visual, root, range);
    }
    for (const visual of Array.from(this.scroller.querySelectorAll(".callout"))) {
      const root = getEmbedBlockRoot(visual);
      const range = matchRangesToElement(quoteRanges, root, this.view, 80) ||
        matchRangesToElement(quoteRanges, visual, this.view, 80) ||
        resolveElementRangeFallback(root || visual, this.view);
      markVisualWithRoot(visual, root || visual, range);
    }
    const genericEmbedRoots = Array.from(new Set(
      Array.from(this.scroller.querySelectorAll(".cm-embed-block,.cm-preview-code-block"))
        .map(root => getEmbedBlockRoot(root) || root)
    )).filter(root => !isWbBookmarkEmbed(root) && !root.querySelector(".callout"));
    genericEmbedRoots.forEach((root, index) => {
      const range = matchRangesToElement(embedRanges, root, this.view, 140) ||
        embedRanges[index] ||
        resolveElementRangeFallback(root, this.view);
      mark(root, range);
    });
    for (const visual of Array.from(this.scroller.querySelectorAll(BUILTIN_EMBED_SELECTOR))) {
      if (isWbBookmarkEmbed(visual)) continue;
      const root = getEmbedBlockRoot(visual) || visual;
      const range = resolveBuiltinEmbedRange(visual, this.view, embedRanges) || resolveElementRangeFallback(root, this.view);
      if (root && root !== visual) this.markHierarchyFrameClean(root);
      mark(root, range);
    }
    for (const root of genericEmbedRoots) {
      const range = matchRangesToElement(embedRanges, root, this.view, 140) || resolveElementRangeFallback(root, this.view);
      mark(root, range);
    }
  }
  handleMouseDownCapture(e) {
    if (e.target?.closest?.('.gv')) return;
    if (!NSB_CTXMENU_FEATURES_ENABLED || !this.plugin.settings.suppressRightClickLineSelection) {
      this.savedRightClickSelection = null;
      return;
    }
    if (e.button !== 2) return;
    if (!this.view.dom.contains(e.target)) return;
    const line = e.target && e.target.closest ? e.target.closest(".cm-line") : null;
    const embed = e.target && e.target.closest ? e.target.closest(".cm-embed-block,.cm-preview-code-block") : null;
    if ((!line && !embed) || e.target.closest(".nsb-handle") || e.target.closest(".nsb-toggle-triangle")) return;
    if (line && isTableElement(line)) return;
    if (e.type !== "mouseup" && !this.savedRightClickSelection) {
      this.savedRightClickSelection = this.view.state.selection;
      this.savedRightClickNativeRanges = this.captureNativeSelectionRanges();
    }
    if (e.type !== "mouseup") e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    this.restoreRightClickSelection(this.savedRightClickSelection);
  }
  handleContextMenuCapture(e) {
    if (e.target?.closest?.('.gv')) return;
    if (!NSB_CTXMENU_FEATURES_ENABLED) return;
    if (!this.view.dom.contains(e.target)) return;
    this.plugin.closeOpenContextMenus();
    if (!this.plugin.settings.suppressRightClickLineSelection) {
      this.savedRightClickSelection = null;
      this.savedRightClickNativeRanges = null;
      return;
    }
    // Spell-check exception: when the right-click landed on a word the browser
    // flagged as misspelled, Chromium auto-selects that single word so its
    // "correct spelling" menu items have a target. Keep that selection (and
    // sync the editor state to it) instead of restoring the pre-click cursor,
    // so applying a correction works without a manual pre-selection.
    if (this.nativeSelectionLooksLikeWord()) {
      this.savedRightClickSelection = null;
      this.savedRightClickNativeRanges = null;
      this.syncEditorSelectionToNative();
      return;
    }
    if (!this.savedRightClickSelection) return;
    const selection = this.savedRightClickSelection;
    const nativeRanges = this.savedRightClickNativeRanges || [];
    this.savedRightClickSelection = null;
    this.savedRightClickNativeRanges = null;
    this.restoreRightClickSelection(selection, nativeRanges);
  }
  captureNativeSelectionRanges() {
    try {
      const sel = window.getSelection && window.getSelection();
      if (!sel || !sel.rangeCount) return [];
      const ranges = [];
      for (let i = 0; i < sel.rangeCount; i++) {
        const range = sel.getRangeAt(i);
        if (this.view.dom.contains(range.commonAncestorContainer)) ranges.push(range.cloneRange());
      }
      return ranges;
    } catch (_) {
      return [];
    }
  }
  closestLineFromNode(node) {
    if (!node) return null;
    const el = node.nodeType === 1 ? node : node.parentElement;
    return el && el.closest ? el.closest(".cm-line") : null;
  }
  // True when the current native selection is a single, whitespace-free token
  // confined to one editor line — the shape of a word the browser auto-selects
  // for its spell-check correction menu (or an equivalent single-word selection
  // the user already had). Used to make a narrow exception to right-click line-
  // selection suppression so spelling corrections can apply on right-click.
  nativeSelectionLooksLikeWord() {
    try {
      const sel = window.getSelection && window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount !== 1) return false;
      const range = sel.getRangeAt(0);
      if (!this.view.dom.contains(range.commonAncestorContainer)) return false;
      const startLine = this.closestLineFromNode(range.startContainer);
      const endLine = this.closestLineFromNode(range.endContainer);
      if (!startLine || startLine !== endLine) return false;
      const text = range.toString();
      if (!text || /\s/.test(text)) return false;
      return true;
    } catch (_) {
      return false;
    }
  }
  // Aligns the CodeMirror selection with the current native word selection so a
  // correction driven through the editor state (not just Electron's
  // replaceMisspelling) targets the right range.
  syncEditorSelectionToNative() {
    try {
      const sel = window.getSelection && window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      const a = this.view.posAtDOM(range.startContainer, range.startOffset);
      const b = this.view.posAtDOM(range.endContainer, range.endOffset);
      if (typeof a !== "number" || typeof b !== "number" || a === b) return;
      this.view.dispatch({ selection: { anchor: Math.min(a, b), head: Math.max(a, b) } });
    } catch (_) {}
  }
  restoreRightClickSelection(selection, nativeRanges) {
    if (!NSB_CTXMENU_FEATURES_ENABLED) return;
    if (!selection) return;
    const restore = () => {
      // Spell-check exception: never clobber a browser word-selection (the
      // misspelled word Chromium highlighted for its correction menu), even if
      // it lands after this restore was scheduled.
      if (this.plugin.settings.suppressRightClickLineSelection && this.nativeSelectionLooksLikeWord()) return;
      try { this.view.dispatch({ selection }); } catch (_) {}
      try {
        const nativeSel = window.getSelection && window.getSelection();
        if (!nativeSel) return;
        if (nativeRanges && nativeRanges.length) {
          nativeSel.removeAllRanges();
          nativeRanges.forEach(range => nativeSel.addRange(range.cloneRange()));
          return;
        }
        const keepNative = selection && selection.main && !selection.main.empty;
        if (!keepNative && nativeSel.rangeCount) nativeSel.removeAllRanges();
      } catch (_) {}
    };
    setTimeout(restore, 0);
    requestAnimationFrame(restore);
    requestAnimationFrame(() => requestAnimationFrame(restore));
  }
  handleToggleRowMouseDown(e) {
    if (e.target && e.target.closest && e.target.closest(".nsb-toggle-triangle")) return;
    const line = e.target && e.target.closest ? e.target.closest(".cm-line.nsb-toggle-title-line") : null;
    if (!line) return;
    const id = line.getAttribute("data-nsb-toggle-id");
    if (!id) return;
    this.plugin.activeToggleId = id;
    document.querySelectorAll(".nsb-toggle-triangle.is-active").forEach(el => el.classList.remove("is-active"));
    this.scheduleToggleButtons();
  }
  getBoundaryLineContext() {
    const state = this.view.state;
    const sel = state.selection.main;
    if (!sel.empty) return null;
    const doc = state.doc;
    const line = doc.lineAt(sel.from);
    const lineNum = line.number - 1;
    const kind = getVacuumLineKind(doc, lineNum);
    if (!kind) return null;
    return { doc, line, lineNum, kind };
  }
  preserveCalloutBoundaryInsert(ctx, text, userEvent) {
    const normalized = String(text || "").replace(/\r\n?/g, "\n");
    const insert = "\n" + normalized;
    this.view.dispatch({
      changes: { from: ctx.line.from, to: ctx.line.to, insert },
      selection: { anchor: ctx.line.from + insert.length },
      userEvent
    });
  }
  handleBeforeInputCapture(e) {
    if (e.defaultPrevented) return;
    const inputType = e.inputType || "";
    if (!/^insert/.test(inputType)) return;
    const ctx = this.getBoundaryLineContext();
    if (!ctx) return;
    if (ctx.kind === "hr-before" || ctx.kind === "hr-after") {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      return;
    }
    if (ctx.kind !== "quote-after" || typeof e.data !== "string") return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    this.preserveCalloutBoundaryInsert(ctx, e.data, "input.nsb.callout-boundary");
  }
  handlePasteCapture(e) {
    const ctx = this.getBoundaryLineContext();
    if (!ctx) return;
    if (ctx.kind === "hr-before" || ctx.kind === "hr-after") {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      return;
    }
    if (ctx.kind !== "quote-after") return;
    const text = e.clipboardData && e.clipboardData.getData ? e.clipboardData.getData("text/plain") : "";
    if (!text) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    this.preserveCalloutBoundaryInsert(ctx, text, "input.nsb.callout-boundary.paste");
  }
  isBoundaryEditKey(e) {
    return e.key.length === 1 || e.key === "Enter" || e.key === "Tab" ||
      e.key === "Backspace" || e.key === "Delete";
  }
  selectionTouchesHardVacuum(doc, from, to) {
    const start = doc.lineAt(Math.min(from, to)).number - 1;
    const end = doc.lineAt(Math.max(from, to)).number - 1;
    for (let i = start; i <= end; i++) {
      if (isHardVacuumLine(doc, i)) return true;
    }
    return false;
  }
  handleBoundaryKeyDown(e) {
    if (e.isComposing) return false;
    const state = this.view.state;
    const sel = state.selection.main;
    const doc = state.doc;
    if (!this.isBoundaryEditKey(e)) return false;
    if (!sel.empty) {
      if ((e.key === "Backspace" || e.key === "Delete") && this.selectionTouchesHardVacuum(doc, sel.from, sel.to)) {
        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        return true;
      }
      return false;
    }
    const line = doc.lineAt(sel.from);
    const lineNum = line.number - 1;
    if (isHardVacuumLine(doc, lineNum)) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      return true;
    }
    if (e.key === "Backspace" && sel.from === line.from && lineNum > 0 && isHardVacuumLine(doc, lineNum - 1)) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      return true;
    }
    if (e.key === "Delete" && sel.from === line.to && lineNum + 1 < doc.lines && isHardVacuumLine(doc, lineNum + 1)) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      return true;
    }
    const ctx = this.getBoundaryLineContext();
    if (!ctx || !isHardVacuumLine(doc, ctx.lineNum)) return false;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    return true;
  }
  handleKeyDown(e) {
    if (this.handleBoundaryKeyDown(e)) return;
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
    if (e.key === "Enter" && this.plugin.handleToggleEnter(this.view, e)) {
      this.scheduleToggleButtons();
      return;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && this.livePreviewMode &&
        this.plugin.handleToggleArrowNav(this.view, e)) {
      return;
    }
    if ((e.key === "Backspace" || e.key === "Delete") && this.plugin.handleToggleDelete(this.view, e)) {
      this.scheduleToggleButtons();
      return;
    }
    if (this.livePreviewMode) this.plugin.handleListMarkerKey(this.view, e);
  }
  destroy() {
    if (this.livePreviewSyncRaf !== null) cancelAnimationFrame(this.livePreviewSyncRaf);
    if (this.legacyMigrationRaf != null) cancelAnimationFrame(this.legacyMigrationRaf);
    if (this.nativeFoldGuardRaf != null) cancelAnimationFrame(this.nativeFoldGuardRaf);
    if (this.toggleButtonRaf !== null) cancelAnimationFrame(this.toggleButtonRaf);
    if (this.hierarchyMutationRaf !== null) cancelAnimationFrame(this.hierarchyMutationRaf);
    if (this.hierarchyMutationObserver) this.hierarchyMutationObserver.disconnect();
    if (this.gutterRaf != null) cancelAnimationFrame(this.gutterRaf);
    if (this.resizeSettleTimer) clearTimeout(this.resizeSettleTimer);
    if (this.onWindowResize) window.removeEventListener("resize", this.onWindowResize);
    if (this.appliedGutterPad) { try { this.scroller.style.paddingLeft = ""; } catch (_) {} }
    this.view.scrollDOM.removeEventListener("mousedown", this.onToggleRowMouseDown);
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    if (!this.mobileViewOnly) {
      document.removeEventListener("pointerdown", this.onMouseDownCapture, true);
      document.removeEventListener("mousedown", this.onMouseDownCapture, true);
      document.removeEventListener("mouseup", this.onMouseDownCapture, true);
      document.removeEventListener("auxclick", this.onMouseDownCapture, true);
      document.removeEventListener("contextmenu", this.onContextMenuCapture, true);
      this.view.dom.removeEventListener("keydown", this.onKeyDown, true);
      this.view.dom.removeEventListener("beforeinput", this.onBeforeInputCapture, true);
      this.view.dom.removeEventListener("paste", this.onPasteCapture, true);
    } else {
      this.view.dom.removeEventListener("keydown", this.onKeyDown, true);
      this.view.dom.removeEventListener("beforeinput", this.onMobileBeforeInput, true);
      if (this.onMobileTableLinkTap) this.view.dom.removeEventListener("click", this.onMobileTableLinkTap, true);
    }
    this.clearHierarchyVisualLayout();
    this.clearToggleButtons();
    if (this.overlay) this.overlay.destroy();
  }
};

var NotionStyleBlocksPlugin = class extends import_obsidian.Plugin {
  constructor() { super(...arguments); this.isDragging=false; this.overlayMap=new Map(); this.activeToggleId=null; this.activeContextMenu=null; }

  closeOpenContextMenus() {
    try {
      if (this.activeContextMenu && typeof this.activeContextMenu.hide === "function") this.activeContextMenu.hide();
    } catch (_) {}
    this.activeContextMenu = null;
    try {
      document.querySelectorAll("body > .menu").forEach(el => el.remove());
    } catch (_) {}
  }

  isNativeDeleteLineSelectionTitle(title) {
    const normalized = String(title || "").toLowerCase().replace(/\s+/g, " ").trim();
    const compact = normalized.replace(/\s+/g, "");
    if (!normalized) return false;
    if (compact.includes("deleteline/selection")) return true;
    if (normalized.includes("delete") && normalized.includes("line") && normalized.includes("selection")) return true;
    if (normalized.includes("删除") && (normalized.includes("行") || normalized.includes("line")) && (normalized.includes("选") || normalized.includes("selection"))) return true;
    return false;
  }

  removeEditorMenuDeleteItems(menu) {
    try {
      if (!menu || !Array.isArray(menu.items)) return;
      menu.items = menu.items.filter(item => {
        const title = item && (item.title || item.text || item.itemEl && item.itemEl.textContent || item.dom && item.dom.textContent);
        return !this.isNativeDeleteLineSelectionTitle(title);
      });
    } catch (_) {}
  }

  removeEditorMenuDeleteDomItems() {
    try {
      document.querySelectorAll("body > .menu .menu-item").forEach(el => {
        if (this.isNativeDeleteLineSelectionTitle(el.textContent || "")) el.remove();
      });
    } catch (_) {}
  }

  // Web Bookmark, Gallery View and Expiring Blocks add to the shared section
  // before this handler runs (plugin load order); settle the group's order
  // here. Items added afterwards (Section Blocks) simply follow at the end.
  orderEditorMenuSection(menu) {
    try {
      if (!menu || !Array.isArray(menu.items)) return;
      const order = ["Web bookmark", "Gallery", "Expiring block", "Delete", "Toggle list"];
      const titleOf = item => String(item && (item.titleEl ? item.titleEl.textContent : item.title) || "").trim();
      const rank = item => { const k = order.indexOf(titleOf(item)); return k < 0 ? order.length : k; };
      const inSection = item => !!item && item.section === "editor-enhancer";
      const group = menu.items.filter(inSection).sort((a, b) => rank(a) - rank(b));
      menu.items = menu.items.filter(item => !inSection(item)).concat(group);
    } catch (_) {}
  }

  scheduleEditorMenuCleanup() {
    const cleanup = () => this.removeEditorMenuDeleteDomItems();
    setTimeout(cleanup, 0);
    setTimeout(cleanup, 30);
    setTimeout(cleanup, 90);
    setTimeout(cleanup, 180);
    requestAnimationFrame(cleanup);
    requestAnimationFrame(() => requestAnimationFrame(cleanup));
  }

  async onload() {
    await this.loadSettings();
    // A real NSB engine may take over while the copied engine awaits settings.
    // Component.unload() does not cancel an already-running async onload.
    if (this.isExpiringFallback && this.expiringEngineCancelled) return;
    NSB_EXPIRING_FALLBACK_ONLY = this.isExpiringFallback === true;
    setNsbTlFeaturesEnabled(this.settings.tlFeaturesEnabled);
    setNsbBlockFeaturesEnabled(this.settings.blockFeaturesEnabled);
    setNsbCtxMenuFeaturesEnabled(this.settings.contextMenuFeaturesEnabled);
    setNsbListMarkerFeaturesEnabled(this.settings.listMarkerFeaturesEnabled);
    this.addSettingTab(new SettingsTab(this.app, this));
    if (!this.isExpiringFallback) this.app.workspace.trigger("nsb:engine-loading", this);
    this.injectStyles();
    // Scroll-position memory (session-scoped): filePath -> {line, offset}.
    this.scrollMemory = new Map();
    this._scrollRestoreSuppress = new Set();
    this._viewLastFile = new WeakMap();
    this.registerEvent(this.app.workspace.on("file-open", file => this.restoreScrollPositionOnOpen(file)));
    this.addCommand({
      id: "insert-toggle-list",
      name: "Toggle list",
      editorCallback: (editor) => {
        if (this.settings.tlFeaturesEnabled === false) {
          new import_obsidian.Notice("Toggle List is disabled in settings");
          return;
        }
        this.makeToggleListFromEditorMenu(editor);
      }
    });
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor) => {
      if (!NSB_CTXMENU_FEATURES_ENABLED) return;
      this.removeEditorMenuDeleteItems(menu);
      // All paipa plugins put their editor-menu items in the "editor-enhancer"
      // section: Obsidian renders one group at the end of the menu with a
      // single divider in front and none inside.
      const asOwnSection = (i) => {
        try { if (typeof i.setSection === "function") i.setSection("editor-enhancer"); } catch (_) {}
        return i;
      };
      menu.addItem(i => asOwnSection(i)
        .setTitle("Delete")
        .setIcon("trash")
        .setDisabled(!this.canDeleteFromEditorMenu(editor))
        .onClick(() => this.deleteEditorSelectionFromMenu(editor)));
      if (this.settings.tlFeaturesEnabled !== false) {
        menu.addItem(i => asOwnSection(i)
          .setTitle("Toggle list")
          .setIcon("list-plus")
          .setDisabled(!this.canMakeToggleListFromEditor(editor))
          .onClick(() => this.makeToggleListFromEditorMenu(editor)));
      }
      this.orderEditorMenuSection(menu);
      this.scheduleEditorMenuCleanup();
    }));
    const self=this;
    this.setLivePreviewModeEffect = import_state.StateEffect.define();
    const toggleDecorationField = import_state.StateField.define({
      create() {
        return { live: false, decorations: import_view.Decoration.none, atomic: import_state.RangeSet.empty };
      },
      update(value, tr) {
        let live = value.live;
        let liveChanged = false;
        for (const effect of tr.effects) {
          if (effect.is(self.setLivePreviewModeEffect)) {
            live = effect.value === true;
            liveChanged = true;
          }
        }
        if (!live) {
          if (!value.live && !liveChanged && !tr.docChanged) return value;
          return { live, decorations: import_view.Decoration.none, atomic: import_state.RangeSet.empty };
        }
        if (liveChanged || tr.docChanged) {
          const built = self.buildToggleDecorationsFromDoc(tr.state.doc);
          return { live, decorations: built.decorations, atomic: built.atomic };
        }
        return value;
      },
      provide(field) {
        return [
          import_view.EditorView.decorations.from(field, value => value.decorations),
          import_view.EditorView.atomicRanges.of(view => {
            const value = view.state.field(field, false);
            return value && value.atomic ? value.atomic : import_state.RangeSet.empty;
          })
        ];
      }
    });
    this.toggleDecorationField = toggleDecorationField;
    // Document-level guard: protects hidden TL markers from every edit path
    // (typing, paste, drag-drop text, IME, other plugins). Edits that touch a
    // close-marker line are suppressed; edits inside/after a title's inline
    // marker are remapped to land before the marker. NSB's own transactions
    // (userEvent "*.nsb.*") and history pass through untouched.
    const toggleMarkerGuard = import_state.EditorState.transactionFilter.of(tr => {
      const fieldValue = tr.startState.field(toggleDecorationField, false);
      if (!fieldValue || !fieldValue.live) return tr;
      const ue = tr.annotation(import_state.Transaction.userEvent) || "";
      if (ue.indexOf("nsb") >= 0 || ue === "undo" || ue === "redo" ||
          /^undo|^redo/.test(ue)) return tr;
      if (!tr.docChanged) return self.guardToggleSelection(tr, fieldValue.atomic);
      return self.guardToggleMarkerChanges(tr, ue);
    });
    const ext=import_view.ViewPlugin.define(view=>{
      const cmEl=view.dom.closest(".cm-editor");
      if (!cmEl) return {update(){}, destroy(){}};
      const pluginView=new NsbEditorViewPlugin(self,view,cmEl);
      self.overlayMap.set(view,pluginView);
      return {
        update(update){pluginView.update(update);},
        destroy(){pluginView.destroy();self.overlayMap.delete(view);}
      };
    });
    // List markers (Live Preview): every list line's prefix is an atomic range,
    // so arrows, Home, mouse and selections step over it; a caret that still
    // lands in front of it (the range's start is a legal boundary) is moved
    // to the text start. Keys that need a different answer than "skip the
    // atom" — Backspace, Delete, ArrowLeft — are handled in handleListMarkerKey.
    const listMarkerAtomic = import_view.EditorView.atomicRanges.of(view => {
      if (!NSB_LIST_MARKER_FEATURES_ENABLED || !isLivePreviewEditorView(view)) return import_state.RangeSet.empty;
      if (!listMarkerAtomValue) listMarkerAtomValue = import_view.Decoration.mark({ class: "nsb-list-marker" });
      const builder = new import_state.RangeSetBuilder();
      const doc = view.state.doc;
      let last = -1;
      for (const range of view.visibleRanges) {
        for (let pos = range.from; pos <= range.to;) {
          const line = doc.lineAt(pos);
          if (line.number > last) {
            last = line.number;
            const mk = listMarkerOf(line.text);
            if (mk) builder.add(line.from, line.from + mk.markerEnd, listMarkerAtomValue);
          }
          pos = line.to + 1;
        }
      }
      return builder.finish();
    });
    const listMarkerSelectionGuard = import_state.EditorState.transactionFilter.of(tr => {
      if (!NSB_LIST_MARKER_FEATURES_ENABLED || tr.docChanged || !tr.selection) return tr;
      const fieldValue = tr.startState.field(toggleDecorationField, false);
      if (!fieldValue || !fieldValue.live) return tr;
      const ue = tr.annotation(import_state.Transaction.userEvent) || "";
      if (ue.indexOf("nsb") >= 0) return tr;
      const sel = tr.newSelection;
      let changed = false;
      const ranges = sel.ranges.map(r => {
        if (!r.empty) return r;
        const line = tr.newDoc.lineAt(r.head);
        const mk = listMarkerOf(line.text);
        if (!mk || r.head >= line.from + mk.markerEnd) return r;
        changed = true;
        return import_state.EditorSelection.cursor(line.from + mk.markerEnd);
      });
      if (!changed) return tr;
      return [tr, { selection: import_state.EditorSelection.create(ranges, sel.mainIndex), userEvent: "select.nsb.list-marker" }];
    });
    this.registerEditorExtension([toggleDecorationField, toggleMarkerGuard, ext]);
    if (!this.isExpiringFallback) this.registerEditorExtension([listMarkerAtomic, listMarkerSelectionGuard]);
    this.toggleApi = {
      scan: scanToggleBlocks,
      parse: parseToggleAnyOpenLine,
      serialize: serializeToggleOpenLine,
      refresh: () => this.refreshToggleDecorations()
    };
    if (!this.isExpiringFallback) {
      this.app.__nsbToggleEngine = this;
      this.app.workspace.trigger("nsb:engine-ready", this);
    }
  }

  // Content-block plugins that expose nsbUnits() take part in hover targets,
  // move slots, hierarchy layout, drops and the handle menu (Gallery View,
  // Section Blocks, …). Duck-typed, so no plugin id list to maintain.
  blockProviders() {
    const plugins = this.app.plugins && this.app.plugins.plugins ? Object.values(this.app.plugins.plugins) : [];
    return plugins.filter(p => p && typeof p.nsbUnits === "function");
  }

  setExpiringAdapter(adapter) {
    const previous = this.expiringBlocks;
    if (previous && previous !== adapter && previous.clearVisual) {
      for (const pv of this.overlayMap.values()) previous.clearVisual(pv.scroller);
    }
    this.expiringBlocks = adapter || null;
    NSB_EXPIRING_ADAPTER_ACTIVE = !!adapter;
    NSB_EXPIRING_FALLBACK_ONLY = this.isExpiringFallback === true;
    setNsbTlFeaturesEnabled(this.settings.tlFeaturesEnabled);
    this._applyFoldStyle();
    this.refreshToggleDecorations();
    for (const pv of this.overlayMap.values()) {
      pv.scheduleToggleButtons();
      pv.scheduleNativeFoldGuard();
    }
  }

  // Selection half of the toggle marker guard: an empty cursor placed
  // strictly inside any hidden fold range (mobile tap mapping past the
  // visible text, End key, DOM selection sync, ...) is normalized to the
  // fold start — i.e. the visible end of the row. Without this, Backspace
  // hits the protected marker and silently does nothing.
  //
  // NOTE: a CM6 Transaction exposes the resulting selection via newSelection,
  // not `.selection` (that earlier precondition made this guard a no-op in
  // production, which is why mobile taps still stranded the cursor). The
  // previous-head comparison both skips no-move transactions and lets a real
  // keyboard cross sit at the fold end without bouncing back.
  guardToggleSelection(tr, atomic) {
    if (!atomic) return tr;
    let sel = null, prev = null;
    try {
      sel = tr.newSelection && tr.newSelection.main;
      prev = tr.startState.selection.main;
    } catch (_) { return tr; }
    if (!sel || !prev) return tr;
    if (sel.empty && sel.head === prev.head) return tr;
    let docLength = null;
    try { docLength = tr.startState.doc.length; } catch (_) {}
    const pointer = tr.isUserEvent("select.pointer");
    // Non-empty selections are normalized as well: a mouse drag that starts
    // past a title's visible end anchors inside the marker fold (CodeMirror's
    // own skipAtoms then pushes that end to the fold end), and Shift+End lands
    // there too. Backspace / Delete / typing on such a selection "touched the
    // marker" and was cancelled, so the visible title text could not be
    // deleted. Both endpoints are pulled back to the visible row end.
    const fix = (pos, prevPos) => {
      let target = null;
      atomic.between(Math.max(0, pos - 1), pos, (from, to) => {
        // between() also visits a fold that merely ends at pos - 1; only a
        // position inside the fold or exactly on its end is invisible.
        if (pos <= from || pos > to) return;
        if (pos < to) { target = from; return; }
        // pos === to (fold end): an invisible position — for collapsed TLs it
        // is the protected close-marker end. Nothing may rest here: a keyboard
        // cross entering from the fold start (prevPos === from) carries
        // through to the first real position after the fold; any other
        // origin (tap/drag/jump) snaps back to the fold start.
        if (prevPos !== from || pointer) { target = from; return; }
        target = docLength != null && to < docLength ? to + 1 : from;
      });
      return target == null ? pos : target;
    };
    let head, anchor;
    try {
      head = fix(sel.head, prev.head);
      anchor = sel.empty ? head : fix(sel.anchor, prev.anchor);
    } catch (_) {
      return tr;
    }
    if (head === sel.head && anchor === sel.anchor) return tr;
    return [tr, { selection: { anchor, head } }];
  }

  // Core of the toggle marker guard (see toggleMarkerGuard in onload).
  // Returns the original transaction, a rebuilt spec with remapped changes,
  // or [] to cancel the transaction entirely.
  guardToggleMarkerChanges(tr, ue) {
    const doc = tr.startState.doc;
    const toggles = scanToggleBlocks(doc);
    if (!toggles.length) return tr;
    {
      const titleMarkers = [];
      const hardRegions = [];
      for (const t of toggles) {
        const close = doc.line(t.endLine + 1);
        // Visible anchor for text that lands on the folded close line: the
        // title's visible end when the fold starts there (collapsed or empty
        // body), otherwise the end of the last VISIBLE body row. Marker
        // lines and rows hidden inside collapsed inner TLs must be skipped:
        // when the body ends with a nested TL, the physical last body line
        // is the child's close marker, and anchoring text there un-closed
        // the child and broke the parent's pairing with it.
        let closeRemapTo = null;
        if (t.inline) {
          closeRemapTo = toggleTitleVisibleEndPos(doc, t);
          if (t.open && t.bodyStartLine <= t.bodyEndLine) {
            for (let ln = t.bodyEndLine; ln >= t.bodyStartLine; ln--) {
              if (isToggleMarkerLineText(doc.line(ln + 1).text)) continue;
              if (isLineHiddenByCollapsedToggle(toggles, ln)) continue;
              closeRemapTo = visibleLineEndPos(doc, toggles, ln);
              break;
            }
          }
        }
        // `to` is deliberately NOT clamped to doc.length: the +1 exists so
        // that insertions AT close.to are caught, and clamping disabled the
        // whole guard for a TL sitting at the end of the document.
        hardRegions.push({
          from: Math.max(0, close.from - 1),
          to: close.to + 1,
          innerFrom: close.from,
          innerTo: close.to,
          remapTo: closeRemapTo
        });
        if (t.inline) {
          const title = doc.line(t.titleLine + 1);
          titleMarkers.push({
            from: toggleTitleVisibleEndPos(doc, t),
            to: title.to,
            lineFrom: title.from,
            clearTo: toggleTitleClearEndPos(doc, t),
            text: doc.sliceString(toggleTitleVisibleEndPos(doc, t), title.to).trim()
          });
        } else {
          const opener = doc.line(t.startLine + 1);
          hardRegions.push({
            from: Math.max(0, opener.from - 1),
            to: opener.to + 1,
            innerFrom: opener.from,
            innerTo: opener.to
          });
        }
      }
      let blocked = false;
      let modified = false;
      const out = [];
      tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        if (blocked) return;
        const text = inserted.toString();
        // Faithful full-line rewrites that re-include the marker (e.g. native
        // heading/paragraph formatting using setLine) pass through untouched.
        const rewritten = titleMarkers.find(m =>
          fromA < m.to && toA > m.from && m.text && text.indexOf(m.text) >= 0);
        if (rewritten) { out.push({ from: fromA, to: toA, insert: text }); return; }
        const hard = hardRegions.find(r => fromA < r.to && toA > r.from);
        if (hard) {
          // Pure insertions hugging a marker line are safe as long as a
          // newline keeps the marker on its own line (e.g. inserting a new
          // row directly before or after the close marker).
          const pureInsert = fromA === toA;
          const safe = pureInsert && text.length > 0 && (
            (fromA === hard.innerTo && text.charAt(0) === "\n") ||
            (fromA === hard.innerFrom && text.charAt(text.length - 1) === "\n")
          );
          if (safe) { out.push({ from: fromA, to: toA, insert: text }); return; }
          // Single-line text typed while the caret sits on the folded close
          // line (its end is reachable by crossing the fold) belongs at the
          // fold's visible anchor; cancelling it made TL rows swallow input.
          if (pureInsert && text.length > 0 && text.indexOf("\n") < 0 && hard.remapTo != null) {
            out.push({ from: hard.remapTo, to: hard.remapTo, insert: text });
            modified = true;
            return;
          }
          blocked = true;
          return;
        }
        if (fromA === toA) {
          // Pure insertion: anything landing inside or just after a title
          // marker is remapped to just before the marker.
          const m = titleMarkers.find(m => fromA > m.from && fromA <= m.to);
          if (m) {
            out.push({ from: m.from, to: m.from, insert: text });
            modified = true;
            return;
          }
          out.push({ from: fromA, to: toA, insert: text });
          return;
        }
        const m = titleMarkers.find(m => fromA < m.to && toA > m.from);
        if (m) {
          if (toA > m.to) { blocked = true; return; }
          if (fromA >= m.from) {
            // Entirely inside the marker: drop the deletion, keep any
            // replacement text in front of the marker.
            if (text) out.push({ from: m.from, to: m.from, insert: text });
            modified = true;
            return;
          }
          // Deletion runs from visible title text into the marker: clamp it.
          // A whole-title deletion also takes the separator whitespace so the
          // emptied line matches a fresh empty TL.
          const clampTo = fromA === m.lineFrom ? m.clearTo : m.from;
          out.push({ from: fromA, to: clampTo, insert: text });
          modified = true;
          return;
        }
        out.push({ from: fromA, to: toA, insert: text });
      });
      if (blocked) return [];
      if (!modified) return tr;
      if (!out.length) return [];
      out.sort((a, b) => a.from - b.from || a.to - b.to);
      let delta = 0;
      let anchor = 0;
      for (const c of out) {
        anchor = c.from + delta + (c.insert ? c.insert.length : 0);
        delta += (c.insert ? c.insert.length : 0) - (c.to - c.from);
      }
      return {
        changes: out,
        selection: { anchor },
        scrollIntoView: true,
        userEvent: ue || undefined
      };
    }
  }

  onunload() {
    this.cancelEditDrag?.();
    var _a,_b,_c;
    document.querySelectorAll(".nsb-wrapper").forEach(w=>{
      const child=w.querySelector(":scope > :not(.nsb-handle)");
      if (child&&w.parentElement) w.parentElement.insertBefore(child,w);
      w.remove();
    });
    (_a=document.getElementById("nsb-styles"))==null?void 0:_a.remove();
    (_b=document.getElementById("nsb-spacing-style"))==null?void 0:_b.remove();
    (_c=document.getElementById("nsb-fold-style"))==null?void 0:_c.remove();
    if (!this.isExpiringFallback) {
      if (this.app.__nsbToggleEngine === this) delete this.app.__nsbToggleEngine;
      this.app.workspace.trigger("nsb:engine-unloaded", this);
    }
  }

  injectStyles() {
    var _a;
    (_a=document.getElementById("nsb-styles"))==null?void 0:_a.remove();
    const style=document.createElement("style");
    style.id="nsb-styles";
    style.textContent=`
      /* Editor Enhancer v1.2.0 */
      .cm-scroller{position:relative!important;}
      .cm-editor{overflow:visible!important;}
      .nsb-handle{
        position:absolute;
        width:var(--nsb-handle-w,20px);
        height:var(--nsb-handle-h,28px);
        display:flex;align-items:center;justify-content:center;
        cursor:grab;border-radius:4px;
        opacity:var(--nsb-opacity,.45);
        transition:opacity .1s ease,background-color .1s ease;
        z-index:100;user-select:none;pointer-events:auto;
        box-sizing:border-box;}
      .nsb-handle:hover{opacity:1!important;background-color:var(--background-modifier-hover);}
      .nsb-handle:active{cursor:grabbing;}
      .nsb-add-line-button{
        position:absolute;
        width:22px;height:22px;
        display:flex;align-items:center;justify-content:center;
        padding:0;border:0;border-radius:4px;
        background:transparent;color:var(--text-muted);
        opacity:var(--nsb-opacity,.45);
        cursor:pointer;z-index:101;pointer-events:auto;
        box-sizing:border-box;
      }
      .nsb-add-line-button:hover{
        opacity:1!important;
        background-color:var(--background-modifier-hover);
        color:var(--text-normal);
      }
      .nsb-add-line-button svg{width:16px;height:16px;}
      .nsb-pinned-handle{opacity:calc(var(--nsb-opacity,.45)*1.5);border:1px solid var(--background-modifier-border);}
      .nsb-pinned-handle:hover{opacity:1!important;}
      .nsb-sel-handle{opacity:calc(var(--nsb-opacity,.45)*1.4);border:1px dashed var(--interactive-accent);}
      .nsb-sel-handle:hover{opacity:1!important;}
      .nsb-dots{
        display:grid;
        grid-template-columns:var(--nsb-dot-size,3.5px) var(--nsb-dot-size,3.5px);
        grid-template-rows:var(--nsb-dot-size,3.5px) var(--nsb-dot-size,3.5px) var(--nsb-dot-size,3.5px);
        gap:var(--nsb-dot-gap,2.5px);
        pointer-events:none;
        line-height:0;font-size:0;}
      .nsb-dots span{
        display:block;
        width:var(--nsb-dot-size,3.5px);
        height:var(--nsb-dot-size,3.5px);
        border-radius:50%;
        background:var(--nsb-dot-color,#8c8c8c);
        margin:0;padding:0;flex-shrink:0;}
      .nsb-handle:hover .nsb-dots span{filter:brightness(0.6);}
      .markdown-reading-view .markdown-preview-section{padding-left:unset!important;}
      .nsb-reading-handle{display:none!important;}
      .nsb-ghost{position:fixed;pointer-events:none;z-index:9999;opacity:.72;
        background:var(--background-primary);border:1px solid var(--background-modifier-border);
        border-radius:4px;padding:2px 8px;box-shadow:0 2px 8px rgba(0,0,0,.10);
        transform:rotate(.5deg);max-width:480px;font-size:.91em;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-normal);}
      .nsb-drop-indicator{position:absolute;pointer-events:none;z-index:200;
        height:var(--nsb-line-height,3px);
        background:rgba(124,58,237,var(--nsb-line-opacity,.65));border-radius:2px;}
      .nsb-drop-indicator.is-segmented{background:transparent;}
      .nsb-drop-segment{position:absolute;top:0;height:100%;border-radius:2px;
        background:rgba(124,58,237,var(--nsb-line-opacity,.65));}
      .nsb-selected{background:rgba(124,58,237,.07)!important;border-radius:3px;}
      .cm-editor .cm-line.nsb-toggle-title-line{
        --nsb-toggle-title-offset:calc(var(--nsb-toggle-icon-size,16px) + 14px + (var(--nsb-toggle-depth,0) * 22px));
        padding-left:var(--nsb-toggle-title-offset)!important;
        padding-inline-start:var(--nsb-toggle-title-offset)!important;
        text-indent:0!important;
        min-height:1.4em;
        box-sizing:border-box;
        pointer-events:auto!important;
        user-select:text!important;
      }
      .cm-line.nsb-toggle-marker-line,
      .markdown-source-view.is-live-preview .cm-editor .cm-line.nsb-toggle-marker-line,
      .is-live-preview .cm-line.nsb-toggle-marker-line{
        display:none!important;
        height:0!important;
        min-height:0!important;
        padding-top:0!important;
        padding-bottom:0!important;
        margin-top:0!important;
        margin-bottom:0!important;
        line-height:0!important;
        font-size:0!important;
        overflow:hidden!important;
        opacity:0!important;
        color:transparent!important;
        pointer-events:none!important;
        user-select:none!important;
      }
      .cm-line.nsb-toggle-marker-line *,
      .markdown-source-view.is-live-preview .cm-editor .cm-line.nsb-toggle-marker-line *,
      .is-live-preview .cm-line.nsb-toggle-marker-line *{display:none!important;}
      .cm-editor .cm-line.nsb-toggle-body-line{
        pointer-events:auto!important;
        user-select:text!important;
      }
      /* Non-list rows keep the forced padding, so Obsidian's inline text-indent
         (it writes the same pair on "> quote" and space-indented rows) has to be
         neutralised as well, or the row's x follows the stale indent cache. */
      .cm-editor .cm-line.nsb-toggle-body-line:not([class*="HyperMD-list-line"]){
        padding-left:calc(18px + (var(--nsb-toggle-depth,0) * 22px))!important;
        text-indent:0!important;
      }
      /* List rows: offset by margin only. Obsidian writes an inline
         text-indent:-N / padding-inline-start:N pair; forcing padding here left
         text-indent unpaired, so the row's x followed Obsidian's per-line-number
         indent cache (stale after line shifts or a late body-line class). */
      .cm-editor .cm-line.nsb-toggle-body-line[class*="HyperMD-list-line"]{
        --nsb-native-list-offset:calc(18px - .44em + (var(--nsb-toggle-depth,0) * 22px));
        margin-left:var(--nsb-native-list-offset)!important;
        width:calc(100% - var(--nsb-native-list-offset))!important;
        max-width:calc(100% - var(--nsb-native-list-offset))!important;
        box-sizing:border-box;
      }
      .nsb-toggle-triangle{
        width:var(--nsb-toggle-icon-size,16px);height:var(--nsb-toggle-icon-size,16px);margin-left:calc(-1 * var(--nsb-toggle-icon-size,16px) - 4px);margin-right:4px;
        padding:0;border:0;background:transparent!important;box-shadow:none!important;
        appearance:none;-webkit-appearance:none;border-radius:0!important;
        display:inline-flex;align-items:center;justify-content:center;
        vertical-align:-3px;cursor:pointer;color:var(--text-muted);
      }
      .nsb-toggle-overlay-triangle{
        position:absolute;
        z-index:120;
        margin:0;
        pointer-events:auto;
      }
      .nsb-toggle-triangle::before{
        content:"";display:block;width:0;height:0;
        border-top:calc(var(--nsb-toggle-icon-size,16px) * .25) solid transparent;
        border-bottom:calc(var(--nsb-toggle-icon-size,16px) * .25) solid transparent;
        border-left:calc(var(--nsb-toggle-icon-size,16px) * .44) solid currentColor;opacity:.9;
        transform-origin:45% 50%;transition:transform .12s ease,opacity .12s ease;
      }
      .nsb-toggle-triangle.is-open::before{transform:rotate(90deg);}
      .nsb-toggle-triangle.is-empty::before{opacity:.24;}
      .nsb-toggle-triangle:not(.is-empty)::before{opacity:.95;}
      .nsb-toggle-triangle:not(.is-empty):hover::before{opacity:1;}
      .nsb-toggle-triangle.is-empty:hover::before,
      .nsb-toggle-triangle.is-empty.is-active::before{opacity:.24!important;}
      .cm-line.nsb-toggle-drop-target{background:rgba(124,58,237,.10)!important;border-radius:3px;}
      .nsb-caret-anchor{display:inline-block;width:0;padding:0;margin:0;}
      .nsb-hierarchy-visual{
        min-width:0!important;
        pointer-events:auto!important;
        user-select:auto!important;
      }
      .nsb-hierarchy-hidden{
        display:none!important;
        pointer-events:none!important;
        user-select:none!important;
      }
      .nsb-hierarchy-visual.nsb-hierarchy-hidden,
      .nsb-hierarchy-frame-clean.nsb-hierarchy-hidden,
      .wb-container.nsb-hierarchy-visual.nsb-hierarchy-hidden,
      .internal-embed.nsb-hierarchy-visual.nsb-hierarchy-hidden,
      .file-embed.nsb-hierarchy-visual.nsb-hierarchy-hidden,
      .markdown-embed.nsb-hierarchy-visual.nsb-hierarchy-hidden,
      .media-embed.nsb-hierarchy-visual.nsb-hierarchy-hidden,
      .image-embed.nsb-hierarchy-visual.nsb-hierarchy-hidden,
      .audio-embed.nsb-hierarchy-visual.nsb-hierarchy-hidden,
      .video-embed.nsb-hierarchy-visual.nsb-hierarchy-hidden,
      .canvas-embed.nsb-hierarchy-visual.nsb-hierarchy-hidden,
      .pdf-embed.nsb-hierarchy-visual.nsb-hierarchy-hidden,
      .cm-embed-block.nsb-hierarchy-visual.nsb-hierarchy-hidden,
      .cm-preview-code-block.nsb-hierarchy-visual.nsb-hierarchy-hidden{
        display:none!important;
        pointer-events:none!important;
        user-select:none!important;
      }
      .nsb-hierarchy-visual.cm-embed-block,
      .nsb-hierarchy-visual.cm-preview-code-block,
      .nsb-hierarchy-frame-clean,
      .nsb-hierarchy-frame-clean.cm-embed-block,
      .nsb-hierarchy-frame-clean.cm-preview-code-block{
        background:transparent!important;
        border-color:transparent!important;
        border-style:none!important;
        box-shadow:none!important;
        outline:none!important;
      }
      .nsb-hierarchy-frame-clean::before,
      .nsb-hierarchy-frame-clean::after{
        background:transparent!important;
        border-color:transparent!important;
        box-shadow:none!important;
        outline:none!important;
        pointer-events:none!important;
      }
      .callout.nsb-hierarchy-visual{
        outline:none!important;
        box-shadow:none!important;
      }
      .nsb-hierarchy-visual .wb-container{
        width:100%!important;
        max-width:100%!important;
        margin-left:0!important;
        margin-right:0!important;
      }
      .wb-container.nsb-hierarchy-visual,
      .internal-embed.nsb-hierarchy-visual,
      .file-embed.nsb-hierarchy-visual,
      .markdown-embed.nsb-hierarchy-visual,
      .media-embed.nsb-hierarchy-visual,
      .image-embed.nsb-hierarchy-visual,
      .audio-embed.nsb-hierarchy-visual,
      .video-embed.nsb-hierarchy-visual,
      .canvas-embed.nsb-hierarchy-visual,
      .pdf-embed.nsb-hierarchy-visual{
        display:block!important;
      }
      .nsb-hierarchy-visual .wb-card{width:100%;box-sizing:border-box;}
      .nsb-hierarchy-visual .internal-embed,
      .nsb-hierarchy-visual .file-embed,
      .nsb-hierarchy-visual .markdown-embed,
      .nsb-hierarchy-visual .media-embed,
      .nsb-hierarchy-visual .image-embed,
      .nsb-hierarchy-visual .audio-embed,
      .nsb-hierarchy-visual .video-embed,
      .nsb-hierarchy-visual .canvas-embed,
      .nsb-hierarchy-visual .pdf-embed{
        width:100%!important;
        max-width:100%!important;
        margin-left:0!important;
        margin-right:0!important;
        box-sizing:border-box!important;
      }
      .cm-line.nsb-vacuum-line{
        pointer-events:none!important;
        user-select:none!important;
      }
      .cm-line.nsb-callout-boundary-line{
        pointer-events:auto!important;
        user-select:auto!important;
      }
      .cm-editor .cm-content > .cm-line.HyperMD-quote + .cm-line:empty::before,
      .cm-editor .cm-content > .cm-line.HyperMD-quote + .cm-line:has(> br:only-child)::before{
        content:"";
        display:block;
        width:28px;
        height:0;
        margin-left:6px;
        margin-top:calc(var(--line-height-normal, 1.5em) * .5);
        border-top:1px dotted rgba(124,58,237,.35);
        pointer-events:none;
      }
    `;
    document.head.appendChild(style);
    this._applyBlockSpacingStyle();
    this._applyFoldStyle();
    this._applyCSSVars();
  }

  // NSB owns expand/collapse: hide Obsidian's native fold arrow on ALL
  // heading rows (and TL title rows). Removed entirely when the TL feature
  // switch is off, restoring native heading folding untouched.
  _applyFoldStyle() {
    var _a;
    (_a = document.getElementById("nsb-fold-style")) == null ? void 0 : _a.remove();
    if (!NSB_TL_FEATURES_ENABLED) return;
    const style = document.createElement("style");
    style.id = "nsb-fold-style";
    style.textContent = `
      ${isNsbExpiringOnlyMode() ? "" : `.markdown-source-view .cm-line[class*="HyperMD-header"] .cm-fold-indicator,
      .markdown-source-view .cm-line[class*="HyperMD-header"] .collapse-indicator,`}
      .cm-editor .cm-line.nsb-toggle-title-line .cm-fold-indicator,
      .cm-editor .cm-line.nsb-toggle-title-line .collapse-indicator,
      .cm-editor .cm-line.nsb-toggle-title-line .cm-foldPlaceholder{
        display:none!important;
        pointer-events:none!important;
      }
    `;
    document.head.appendChild(style);
  }

  _applyBlockSpacingStyle() {
    var _a;
    (_a=document.getElementById("nsb-spacing-style"))==null?void 0:_a.remove();
    if (!NSB_BLOCK_FEATURES_ENABLED) return;
    if (!this.settings.blockSpacingEnabled) return;
    const half = Math.round(this.settings.blockSpacingPx / 2);
    const lineExtra = this.settings.lineSpacingPx || 0;
    const style = document.createElement("style");
    style.id = "nsb-spacing-style";
    const lineHeightRule = lineExtra > 0
      ? `line-height: calc(var(--line-height-normal, 1.5) * 1em + ${lineExtra}px) !important;`
      : "";
    style.textContent = `
      .cm-editor .cm-content > .cm-line {
        padding-top: ${half}px !important;
        padding-bottom: ${half}px !important;
        ${lineHeightRule}
      }
      .cm-editor .cm-content > .cm-embed-block,
      .cm-editor .cm-content > .cm-preview-code-block {
        padding-top: ${half}px !important;
        padding-bottom: ${half}px !important;
        box-sizing: border-box !important;
      }
      .cm-editor .cm-content > .cm-embed-block > .cm-line,
      .cm-editor .cm-content > .cm-embed-block .cm-line {
        padding-top: 0 !important;
        padding-bottom: 0 !important;
        line-height: inherit !important;
      }
      .cm-editor .cm-content > .cm-line.nsb-toggle-marker-line {
        display: none !important;
        height: 0 !important;
        min-height: 0 !important;
        padding-top: 0 !important;
        padding-bottom: 0 !important;
        margin-top: 0 !important;
        margin-bottom: 0 !important;
        line-height: 0 !important;
        font-size: 0 !important;
        overflow: hidden !important;
        pointer-events: none !important;
        user-select: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  _applyCSSVars() {
    const r=document.documentElement;
    const s=this.settings;
    // Dot grid: 2 cols × 3 rows
    // Icon box width  = 2 * dotSize + 1 * dotGap + 2 * padding
    // Icon box height = 3 * dotSize + 2 * dotGap + 2 * padding
    // handleSize is repurposed as padding (px around the dot grid)
    const pad = s.handleSize;
    const w = 2 * s.dotSize + s.dotGap + 2 * pad;
    const h = 3 * s.dotSize + 2 * s.dotGap + 2 * pad;
    const gray = Math.round(255 * (1 - s.dotGray / 100));
    const grayHex = gray.toString(16).padStart(2,"0");
    const dotColor = `#${grayHex}${grayHex}${grayHex}`;
    r.style.setProperty("--nsb-opacity",      String(s.handleOpacity));
    r.style.setProperty("--nsb-handle-w",     w + "px");
    r.style.setProperty("--nsb-handle-h",     h + "px");
    r.style.setProperty("--nsb-dot-size",     s.dotSize + "px");
    r.style.setProperty("--nsb-dot-gap",      s.dotGap + "px");
    r.style.setProperty("--nsb-dot-color",    dotColor);
    r.style.setProperty("--nsb-line-height",  s.lineHeight + "px");
    r.style.setProperty("--nsb-line-opacity", String(s.lineOpacity));
    r.style.setProperty("--nsb-toggle-icon-size", (s.toggleIconSize || 16) + "px");
  }

  getMdViewForEditor(editorView) {
    let found=null;
    this.app.workspace.iterateAllLeaves(leaf=>{
      if (found) return;
      if (!(leaf.view instanceof import_obsidian.MarkdownView)) return;
      if (leaf.view.editor&&leaf.view.editor.cm===editorView) found=leaf.view;
    });
    return found;
  }

  buildToggleDecorationsFromDoc(doc) {
    const toggles = scanToggleBlocks(doc);
    const decos = [];
    const hiddenRanges = [];
    const titleLines = new Map();
    const markerLines = toggleHiddenMarkerLines(toggles);
    for (const t of toggles) {
      titleLines.set(t.titleLine, t);
    }
    // Ghost-line fix: hidden marker regions are folded CodeMirror-style.
    // Each hidden range starts at the END of the previous visible line and
    // consumes the leading newline, so no empty line boundary survives in the
    // visual/edit plane. The same ranges are registered as atomic ranges so
    // cursor motion skips over them entirely.
    const hideRange = (from, to, withAnchor) => {
      if (to <= from) return;
      // When the visible title is empty the fold is the row's only content;
      // the anchor widget (fold-placeholder pattern) gives coordsAtPos a real
      // DOM rect at the padded content start for BOTH look directions, so
      // the caret never falls back to the row's unpadded left edge.
      const deco = import_view.Decoration.replace(
        withAnchor ? { widget: new NsbTitleCaretAnchorWidget() } : {});
      decos.push(deco.range(from, to));
      hiddenRanges.push(deco.range(from, to));
    };
    for (const t of toggles) {
      if (isLineHiddenByCollapsedToggle(toggles, t.titleLine)) continue;
      const title = doc.line(t.titleLine + 1);
      decos.push(import_view.Decoration.line({
        attributes: {
          class: "nsb-toggle-title-line",
          "data-nsb-toggle-id": t.id,
          style: "--nsb-toggle-depth:" + t.depth
        }
      }).range(title.from));
      if (t.inline) {
        const markerFrom = toggleTitleVisibleEndPos(doc, t);
        const close = doc.line(t.endLine + 1);
        const emptyTitle = t.titleMarkerFrom === 0;
        if (!t.open || t.bodyStartLine > t.bodyEndLine) {
          // Collapsed (or open with an empty body): one fold from the visible
          // title end to the close marker end. The TL occupies exactly one
          // visual row and the cursor crosses it in a single step.
          hideRange(markerFrom, close.to, emptyTitle);
        } else {
          // Open with body: hide the inline title marker, then fold the
          // close-marker line into the end of the last body line.
          hideRange(markerFrom, title.to, emptyTitle);
          hideRange(doc.line(t.endLine).to, close.to);
        }
      } else {
        // Legacy 4-line block: keep the old rendering until migration runs.
        addToggleMarkerLineDecoration(decos, doc, t.startLine);
        if (!t.open) {
          if (t.bodyStartLine <= t.bodyEndLine) {
            if (t.endLine + 1 < doc.lines && isBlankLineText(doc.line(t.endLine + 2).text)) {
              addReplaceLineRangeDecoration(decos, doc, t.bodyStartLine, t.bodyEndLine);
              addToggleMarkerLineDecoration(decos, doc, t.endLine);
            } else {
              addReplaceLineRangeDecoration(decos, doc, t.bodyStartLine, t.endLine);
            }
          } else {
            addToggleCloseLineDecoration(decos, doc, t.endLine);
          }
        } else {
          addToggleCloseLineDecoration(decos, doc, t.endLine);
        }
      }
    }
    for (let i = 0; i < doc.lines; i++) {
      if (markerLines.has(i) || titleLines.has(i) || isLineHiddenByCollapsedToggle(toggles, i)) continue;
      if (isVacuumLine(doc, i)) {
        if (isHardVacuumLine(doc, i)) {
          addReplaceLineDecoration(decos, doc, i);
          continue;
        }
        const line = doc.line(i + 1);
        decos.push(import_view.Decoration.line({
          attributes: { class: "nsb-callout-boundary-line" }
        }).range(line.from));
        continue;
      }
      const depth = getToggleBodyDepth(toggles, i);
      if (depth <= 0) continue;
      const line = doc.line(i + 1);
      decos.push(import_view.Decoration.line({
        attributes: {
          class: "nsb-toggle-body-line",
          style: "--nsb-toggle-depth:" + depth
        }
      }).range(line.from));
    }
    if (this.expiringBlocks && this.expiringBlocks.decorate) this.expiringBlocks.decorate(doc, toggles, decos);
    return {
      decorations: decos.length ? import_view.Decoration.set(decos, true) : import_view.Decoration.none,
      atomic: hiddenRanges.length ? import_state.RangeSet.of(hiddenRanges, true) : import_state.RangeSet.empty
    };
  }

  buildToggleDecorations(editorView) {
    return this.buildToggleDecorationsFromDoc(editorView.state.doc);
  }

  setToggleOpen(editorView, startLine, open) {
    const doc = editorView.state.doc;
    if (startLine < 0 || startLine >= doc.lines) return;
    const line = doc.line(startLine + 1);
    const parsed = parseToggleAnyOpenLine(line.text);
    if (!parsed) return;
    const meta = parsed.meta;
    meta.open = !!open;
    this.activeToggleId = meta.id;
    // Pin the clicked title row to its viewport position across the fold
    // change. CM's scroll anchoring keeps the SELECTION stable instead, so
    // with the cursor sitting below the toggle a tall revealed body pushed
    // the whole view down and the expansion appeared to grow UPWARD past
    // the top of the screen. Pinning the title makes a TL always reveal
    // (and collapse) downward.
    const pin = this.captureToggleScrollPin(editorView, line.from);
    // The pin rides INSIDE the dispatch as an explicit scroll target:
    // an explicit target overrides CM's selection-based scroll anchoring in
    // the same update cycle, so the corrected position is what the browser
    // paints first — no one-frame flash of upward expansion followed by a
    // snap-back (the post-dispatch re-asserts below only mop up late height
    // refinement).
    const pinEffect = pin
      ? import_view.EditorView.scrollIntoView(line.from, { y: "start", yMargin: Math.max(0, pin.viewportY) })
      : null;
    if (parsed.legacy) {
      editorView.dispatch({
        changes: { from: line.from, to: line.to, insert: serializeToggleOpenLine(meta) },
        effects: pinEffect ? [pinEffect] : [],
        userEvent: "input.nsb.toggle"
      });
      this.restoreToggleScrollPin(editorView, pin);
      return;
    }
    // Inline format: rewrite only the end-of-line marker, keep the title text.
    const markerFrom = line.from + Math.min(parsed.titleMarkerFrom, line.length);
    const sep = parsed.titleMarkerFrom > 0 ? " " : "";
    const changes = [{ from: markerFrom, to: line.to, insert: sep + serializeToggleOpenLine(meta) }];
    if (open) {
      // Expanding a TL with no body rows seeds one blank body row, so the
      // opened toggle immediately offers an editable line (Enter on the
      // title then moves into it instead of creating another row).
      const block = getToggleByStartLine(doc, startLine);
      if (block && block.inline && block.bodyStartLine > block.bodyEndLine &&
          block.endLine >= 0 && block.endLine < doc.lines) {
        const close = doc.line(block.endLine + 1);
        changes.push({ from: close.from, to: close.from, insert: "\n" });
      }
    }
    editorView.dispatch({
      changes,
      effects: pinEffect ? [pinEffect] : [],
      userEvent: "input.nsb.toggle"
    });
    this.restoreToggleScrollPin(editorView, pin);
  }

  // VISUAL offset (px) of a document position's line top from the scroller's
  // top edge. documentTop converts CM's document-space heights to screen
  // coordinates, so content-top chrome (inline title, properties, padding)
  // cancels out — this is the number the eye sees, and the same geometry
  // scrollIntoView's yMargin aligns against. The previous doc-space capture
  // (blockTop - scrollTop) differed from this by that chrome height, so the
  // in-dispatch scroll effect first painted the title shifted UP by exactly
  // that constant and the after-measure fix snapped it back: a guaranteed
  // one-frame flash + jitter on every toggle. One coordinate convention,
  // everywhere, kills it.
  captureToggleScrollPin(editorView, pos) {
    try {
      const scroller = editorView.scrollDOM;
      const topEdge = scroller.getBoundingClientRect().top - editorView.documentTop;
      return { pos, viewportY: editorView.lineBlockAt(pos).top - topEdge };
    } catch (_) { return null; }
  }
  restoreToggleScrollPin(editorView, pin) {
    if (!pin) return;
    const scroller = editorView.scrollDOM;
    let cancelled = false;
    let settled = 0;
    const cancel = () => { cancelled = true; };
    const fix = () => {
      if (cancelled) return;
      try {
        const pos = Math.min(pin.pos, editorView.state.doc.length);
        const topEdge = scroller.getBoundingClientRect().top - editorView.documentTop;
        const delta = (editorView.lineBlockAt(pos).top - topEdge) - pin.viewportY;
        if (Math.abs(delta) > 1) { scroller.scrollTop += delta; settled = 0; }
        else settled++;
      } catch (_) {}
    };
    // Re-assert the pin inside CM's measure cycle EVERY frame until the
    // revealed body's real row heights settle (three quiet frames in a
    // row) or the user scrolls. requestMeasure writes run pre-paint in the
    // same flush as CM's own height corrections, so no intermediate wrong
    // position is ever painted — a single after-the-fact correction left
    // later height-estimate fixups visibly dragging the view.
    const win = (scroller.ownerDocument && scroller.ownerDocument.defaultView) || window;
    const opts = { passive: true, once: true };
    scroller.addEventListener("wheel", cancel, opts);
    scroller.addEventListener("touchmove", cancel, opts);
    let frames = 0;
    const stop = () => {
      scroller.removeEventListener("wheel", cancel);
      scroller.removeEventListener("touchmove", cancel);
    };
    const tick = () => {
      if (cancelled || settled >= 3 || ++frames > 20) { stop(); return; }
      try {
        editorView.requestMeasure({ read: () => null, write: fix });
      } catch (_) { fix(); }
      win.requestAnimationFrame(tick);
    };
    try {
      editorView.requestMeasure({ read: () => null, write: fix });
    } catch (_) { fix(); }
    win.requestAnimationFrame(tick);
  }

  // NSB owns expand/collapse: native folds anchored on ANY heading row (or a
  // TL title row) are dissolved immediately, so only NSB toggles fold
  // content. Folds on other foldable rows (list items etc.) are left alone.
  // Fully inactive when the TL feature switch is off.
  clearNativeFoldsOnToggleLines(editorView) {
    if (!NSB_TL_FEATURES_ENABLED) return false;
    if (!import_language || typeof import_language.foldedRanges !== "function" ||
        !import_language.unfoldEffect) return false;
    const state = editorView.state;
    const doc = state.doc;
    const toggles = scanToggleBlocks(doc);
    const titleLines = new Set(toggles.map(t => t.titleLine));
    const effects = [];
    try {
      const folded = import_language.foldedRanges(state);
      folded.between(0, doc.length, (from, to) => {
        const fromLine = doc.lineAt(from);
        if (titleLines.has(fromLine.number - 1) || (!isNsbExpiringOnlyMode() && /^#{1,6}\s/.test(fromLine.text || ""))) {
          effects.push(import_language.unfoldEffect.of({ from, to }));
        }
      });
    } catch (_) {
      return false;
    }
    if (!effects.length) return false;
    editorView.dispatch({ effects, userEvent: "select.nsb.toggle.unfold-native" });
    return true;
  }

  // Upgrades legacy 4-line toggle blocks (own-line opener above the title) to
  // the inline v2 format (opener marker at the end of the title line). Runs
  // once per editor when a note with legacy markers is opened in Live Preview.
  migrateLegacyTogglesCM(editorView) {
    try {
      const doc = editorView.state.doc;
      const legacy = scanToggleBlocks(doc).filter(t => !t.inline);
      if (!legacy.length) return false;
      const changes = [];
      for (const t of legacy) {
        const opener = doc.line(t.startLine + 1);
        const parsed = parseToggleAnyOpenLine(opener.text);
        if (!parsed) continue;
        if (t.titleLine > t.startLine && t.titleLine < t.endLine) {
          const title = doc.line(t.titleLine + 1);
          changes.push({ from: opener.from, to: title.from, insert: "" });
          const sep = (title.text || "").trim() === "" ? "" : " ";
          changes.push({ from: title.to, to: title.to, insert: sep + serializeToggleOpenLine(parsed.meta) });
        } else {
          // Degenerate legacy block without a separate title line: rewrite the
          // opener itself as an inline (v2) empty-title marker line.
          changes.push({ from: opener.from, to: opener.to, insert: serializeToggleOpenLine(parsed.meta) });
        }
      }
      if (!changes.length) return false;
      editorView.dispatch({ changes, userEvent: "input.nsb.toggle.migrate" });
      return true;
    } catch (_) {
      return false;
    }
  }

  deleteToggleBlockCM(editorView, toggle, leaveBlank) {
    const doc = editorView.state.doc;
    if (!toggle || toggle.startLine < 0 || toggle.endLine >= doc.lines) return false;
    let from = doc.line(toggle.startLine + 1).from;
    let to = doc.line(toggle.endLine + 1).to;
    let insert = leaveBlank ? "\n" : "";
    if (toggle.endLine + 1 < doc.lines) {
      to = doc.line(toggle.endLine + 2).from;
    } else if (toggle.startLine > 0) {
      from = doc.line(toggle.startLine).to;
      insert = leaveBlank ? "\n" : "";
    } else {
      insert = "";
    }
    editorView.dispatch({
      changes: { from, to, insert },
      selection: { anchor: Math.min(from + insert.length, from) },
      userEvent: "input.nsb.toggle.delete"
    });
    return true;
  }

  deleteLineRangeLeavingBlankCM(editorView, startLine, endLine) {
    const doc = editorView.state.doc;
    if (doc.lines <= 0) return false;
    const first = Math.max(0, Math.min(startLine, doc.lines - 1));
    const last = Math.max(first, Math.min(endLine, doc.lines - 1));
    let from = doc.line(first + 1).from;
    let to = doc.line(last + 1).to;
    let insert = "\n";
    if (last + 1 < doc.lines) {
      to = doc.line(last + 2).from;
    } else if (first > 0) {
      from = doc.line(first).to;
    } else {
      insert = "";
    }
    editorView.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from, head: from },
      userEvent: "input.nsb.block.delete"
    });
    editorView.focus();
    return true;
  }

  getMenuDeleteRange(doc, target) {
    if (!doc || !target || typeof target.startLine !== "number") return null;
    let startLine = target.startLine;
    let endLine = typeof target.endLine === "number" ? target.endLine : startLine;
    if (startLine < 0 || startLine >= doc.lines || endLine < startLine) return null;
    endLine = Math.min(endLine, doc.lines - 1);
    const toggleRange = expandToggleRangeForLines(doc, startLine, endLine);
    if (toggleRange.startLine !== startLine || toggleRange.endLine !== endLine) return toggleRange;
    if (target.kind === "line") {
      const block = resolveBlockBoundary(doc, startLine);
      return expandToggleRangeForLines(doc, block.startLine, block.endLine);
    }
    return { startLine, endLine };
  }

  deleteTargetBlockFromMenu(editor, target) {
    const editorView = editor && editor.cm;
    if (!editorView || !editorView.state || !editorView.state.doc) return false;
    for (const provider of this.blockProviders()) if (provider.releaseTarget?.(editorView, target)) return true;
    const doc = editorView.state.doc;
    const range = this.getMenuDeleteRange(doc, target);
    if (!range) return false;
    const toggle = scanToggleBlocks(doc).find(t => t.startLine === range.startLine && t.endLine === range.endLine);
    // TL: unwrap the whole block in place and remove the title row text.
    if (toggle) return this.unwrapToggleDeletingTitleLineCM(editorView, toggle);
    // Blank rows are removed outright — leaving a blank behind would make
    // deleting a blank row a no-op.
    let allBlank = true;
    for (let i = range.startLine; i <= Math.min(range.endLine, doc.lines - 1); i++) {
      if (!isBlankLineText(doc.line(i + 1).text)) { allBlank = false; break; }
    }
    if (allBlank) return this.deleteLineRangeCompletelyCM(editorView, range.startLine, range.endLine);
    return this.deleteLineRangeLeavingBlankCM(editorView, range.startLine, range.endLine);
  }

  // Removes the given rows entirely (no blank row left behind).
  deleteLineRangeCompletelyCM(editorView, startLine, endLine) {
    const doc = editorView.state.doc;
    if (doc.lines <= 0) return false;
    const first = Math.max(0, Math.min(startLine, doc.lines - 1));
    const last = Math.max(first, Math.min(endLine, doc.lines - 1));
    let from = doc.line(first + 1).from;
    let to = doc.line(last + 1).to;
    if (last + 1 < doc.lines) {
      to = doc.line(last + 2).from;
    } else if (first > 0) {
      from = doc.line(first).to;
    }
    editorView.dispatch({
      changes: { from, to, insert: "" },
      selection: { anchor: from, head: from },
      userEvent: "input.nsb.block.delete-line"
    });
    editorView.focus();
    return true;
  }

  editorHasTextSelection(editor) {
    try {
      if (!editor || !(editor.somethingSelected && editor.somethingSelected())) return false;
      const from = editor.getCursor("from");
      const to = editor.getCursor("to");
      if (!from || !to) return false;
      return from.line !== to.line || from.ch !== to.ch;
    } catch (_) {
      return false;
    }
  }

  // Right-click menu Delete is available with a text selection OR with the
  // cursor parked on an ordinary blank row.
  canDeleteFromEditorMenu(editor) {
    if (this.editorHasTextSelection(editor)) return true;
    return this.isCursorOnDeletableBlankLine(editor);
  }

  isCursorOnDeletableBlankLine(editor) {
    try {
      const editorView = editor && editor.cm;
      if (!editorView || !editorView.state || !editorView.state.doc) return false;
      const cursor = editor.getCursor();
      if (!cursor) return false;
      const doc = editorView.state.doc;
      if (cursor.line < 0 || cursor.line >= doc.lines) return false;
      if (!isBlankLineText(doc.line(cursor.line + 1).text)) return false;
      if (isHardVacuumLine(doc, cursor.line)) return false;
      const toggles = scanToggleBlocks(doc);
      if (toggleHiddenMarkerLines(toggles).has(cursor.line)) return false;
      if (isLineHiddenByCollapsedToggle(toggles, cursor.line)) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  deleteEditorSelectionFromMenu(editor) {
    const editorView = editor && editor.cm;
    if (!this.editorHasTextSelection(editor)) {
      // No selection: delete the blank row under the cursor.
      if (!editorView || !this.isCursorOnDeletableBlankLine(editor)) return false;
      const cursor = editor.getCursor();
      return this.deleteLineRangeCompletelyCM(editorView, cursor.line, cursor.line);
    }
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    if (editorView && editorView.state && editorView.state.doc) {
      const doc = editorView.state.doc;
      const toggle = scanToggleBlocks(doc).find(t =>
        t.inline && t.titleLine === from.line && t.titleLine === to.line);
      if (toggle) {
        // Selection inside a TL title: delete only the selected visible text
        // via an NSB transaction so the cursor lands at the title row's
        // normal edit start, never in front of the toggle triangle.
        const titleLine = doc.line(toggle.titleLine + 1);
        const visEnd = toggleTitleVisibleEndPos(doc, toggle);
        const a = Math.min(titleLine.from + from.ch, visEnd);
        // When the deletion empties the whole visible title, also take the
        // separator whitespace so the line matches a fresh empty TL.
        const b = a === titleLine.from && titleLine.from + to.ch >= visEnd
          ? toggleTitleClearEndPos(doc, toggle)
          : Math.min(titleLine.from + to.ch, visEnd);
        if (b > a) {
          editorView.dispatch({
            changes: { from: a, to: b, insert: "" },
            selection: { anchor: a, head: a },
            userEvent: "input.nsb.delete-selection"
          });
        }
        editorView.focus();
        return true;
      }
    }
    editor.replaceRange("", from, to);
    editor.focus();
    return true;
  }

  isPlainTextOrInternalLinkLine(text) {
    const s = (text || "").trim();
    if (s === "") return true;
    if (isToggleMarkerLineText(s)) return false;
    if (NSB_TOGGLE_INLINE_OPEN_RE.test(s)) return false;
    if (/^(```|~~~)/.test(s)) return false;
    // Headings (H1-H6) are valid toggle titles: the inline opener marker sits
    // at the end of the heading line and native heading/paragraph formatting
    // keeps working on it.
    if (/^>\s?/.test(s)) return false;
    if (/^[-*+]\s+/.test(s)) return false;
    if (/^\d+[.)]\s+/.test(s)) return false;
    if (/^\|.*\|$/.test(s)) return false;
    if (/^[-*_]{3,}\s*$/.test(s)) return false;
    if (/^!\[[^\]]*\]\([^)]+\)\s*$/.test(s)) return false;
    if (/^!?\[\[[^\]]+\]\]\s*$/.test(s)) return true;
    return true;
  }

  isPlainTextLineForTitleJoin(text) {
    const s = (text || "").trim();
    if (s === "") return false;
    if (isToggleMarkerLineText(s)) return false;
    if (NSB_TOGGLE_INLINE_OPEN_RE.test(s)) return false;
    if (/^(```|~~~)/.test(s)) return false;
    if (/^#{1,6}\s+/.test(s)) return false;
    if (/^>\s?/.test(s)) return false;
    if (/^[-*+]\s+/.test(s)) return false;
    if (/^\d+[.)]\s+/.test(s)) return false;
    if (/^\|.*\|$/.test(s)) return false;
    if (/^[-*_]{3,}\s*$/.test(s)) return false;
    if (/^!\[[^\]]*\]\([^)]+\)\s*$/.test(s)) return false;
    if (/\[\[|\]\]/.test(s)) return false;
    if (/\[[^\]]+\]\([^)]+\)/.test(s)) return false;
    return true;
  }

  isMakeToggleListAllowedForRange(doc, startLine, endLine) {
    if (!doc || startLine == null || endLine == null) return false;
    const first = Math.max(0, Math.min(startLine, doc.lines - 1));
    const last = Math.max(first, Math.min(endLine, doc.lines - 1));
    const toggles = scanToggleBlocks(doc);
    if (toggles.some(t =>
      (first <= t.startLine && last >= t.startLine) ||
      (first <= t.titleLine && last >= t.titleLine) ||
      (first <= t.endLine && last >= t.endLine)
    )) return false;
    for (let i = first; i <= last; i++) {
      if (isVacuumLine(doc, i)) return false;
      if (!this.isPlainTextOrInternalLinkLine(doc.line(i + 1).text)) return false;
    }
    return true;
  }

  getEditorMakeToggleRange(editor) {
    const editorView = editor && editor.cm;
    if (!editorView || !editorView.state || !editorView.state.doc) return null;
    if (this.editorHasTextSelection(editor)) {
      const from = editor.getCursor("from");
      const to = editor.getCursor("to");
      let endLine = to.line;
      if (to.ch === 0 && endLine > from.line) endLine -= 1;
      return { startLine: from.line, endLine };
    }
    const cursor = editor.getCursor();
    return cursor ? { startLine: cursor.line, endLine: cursor.line } : null;
  }

  canMakeToggleListFromEditor(editor) {
    const editorView = editor && editor.cm;
    const range = this.getEditorMakeToggleRange(editor);
    return !!(editorView && range &&
      this.isMakeToggleListAllowedForRange(editorView.state.doc, range.startLine, range.endLine));
  }

  canMakeToggleListFromTarget(editor, target) {
    const editorView = editor && editor.cm;
    if (!editorView || !target || typeof target.startLine !== "number") return false;
    const endLine = typeof target.endLine === "number" ? target.endLine : target.startLine;
    return this.isMakeToggleListAllowedForRange(editorView.state.doc, target.startLine, endLine);
  }

  makeToggleListFromEditorMenu(editor) {
    if (!this.canMakeToggleListFromEditor(editor)) return false;
    const range = this.getEditorMakeToggleRange(editor);
    const current = editor.getLine(range.startLine) || "";
    if (this.editorHasTextSelection(editor)) return this.wrapLinesInToggle(editor, range.startLine, range.endLine);
    if (current.trim() === "") return this.insertToggleList(editor);
    return this.wrapLinesInToggle(editor, range.startLine, range.endLine);
  }

  unwrapToggleBlockCM(editorView, toggle) {
    const doc = editorView.state.doc;
    if (!toggle || toggle.startLine < 0 || toggle.endLine >= doc.lines) return false;
    const titleLine = doc.line(toggle.titleLine + 1);
    const closeLine = doc.line(toggle.endLine + 1);
    // Opener removal: inline format strips the end-of-line marker from the
    // title line; legacy format removes the whole opener line.
    const openFrom = toggle.inline
      ? toggleTitleVisibleEndPos(doc, toggle)
      : doc.line(toggle.startLine + 1).from;
    const openTo = toggle.inline
      ? titleLine.to
      : (toggle.titleLine > toggle.startLine ? titleLine.from : doc.line(toggle.startLine + 1).to);
    let closeFrom = closeLine.from;
    let closeTo = closeLine.to;
    if (toggle.endLine + 1 < doc.lines) {
      closeTo = doc.line(toggle.endLine + 2).from;
    } else if (toggle.endLine > toggle.startLine) {
      closeFrom = doc.line(toggle.endLine).to;
    }
    const changes = openTo <= closeFrom
      ? [
          { from: openFrom, to: openTo, insert: "" },
          { from: closeFrom, to: closeTo, insert: "" }
        ]
      : [
          { from: closeFrom, to: closeTo, insert: "" },
          { from: openFrom, to: openTo, insert: "" }
        ];
    editorView.dispatch({
      changes,
      selection: { anchor: toggle.inline ? titleLine.from : openFrom },
      userEvent: "input.nsb.toggle.unwrap"
    });
    return true;
  }

  unwrapToggleDeletingTitleLineCM(editorView, toggle) {
    const doc = editorView.state.doc;
    if (!toggle || toggle.startLine < 0 || toggle.endLine >= doc.lines) return false;
    const hasBody = toggle.bodyStartLine <= toggle.bodyEndLine;
    if (!hasBody) return this.deleteToggleBlockCM(editorView, toggle, true);

    const openLine = doc.line(toggle.startLine + 1);
    const firstBody = doc.line(toggle.bodyStartLine + 1);
    const closeLine = doc.line(toggle.endLine + 1);
    const removeHead = { from: openLine.from, to: firstBody.from, insert: "" };
    let closeFrom = closeLine.from;
    let closeTo = closeLine.to;
    if (toggle.endLine + 1 < doc.lines) {
      closeTo = doc.line(toggle.endLine + 2).from;
    } else {
      closeFrom = doc.line(toggle.endLine).to;
    }
    const changes = [
      removeHead,
      { from: closeFrom, to: closeTo, insert: "" }
    ];
    editorView.dispatch({
      changes,
      selection: { anchor: openLine.from, head: openLine.from },
      userEvent: "input.nsb.toggle.unwrap-delete-title"
    });
    editorView.focus();
    return true;
  }

  clearToggleTitleCM(editorView, toggle) {
    const doc = editorView.state.doc;
    if (!toggle || toggle.titleLine < 0 || toggle.titleLine >= doc.lines) return false;
    const title = doc.line(toggle.titleLine + 1);
    // Clear through the separator whitespace so the emptied title line is
    // identical to a freshly created empty TL.
    const clearEnd = toggleTitleClearEndPos(doc, toggle);
    editorView.dispatch({
      changes: { from: title.from, to: clearEnd, insert: "" },
      selection: { anchor: title.from },
      userEvent: "input.nsb.toggle.clear-title"
    });
    return true;
  }

  deleteFollowingBlankAfterToggleCM(editorView, toggle, line) {
    const doc = editorView.state.doc;
    if (!toggle || !line || line.number - 1 !== toggle.endLine + 1) return false;
    if (!isBlankLineText(line.text)) return false;
    const close = doc.line(toggle.endLine + 1);
    editorView.dispatch({
      changes: { from: close.to, to: line.to, insert: "" },
      selection: { anchor: toggleTitleVisibleEndPos(doc, toggle) },
      userEvent: "input.nsb.toggle.after-blank"
    });
    return true;
  }

  deleteBlankBeforeToggleMarkerCM(editorView, markerLineNum, line) {
    const doc = editorView.state.doc;
    if (!line || !isBlankLineText(line.text)) return false;
    if (markerLineNum < 0 || markerLineNum >= doc.lines || line.number - 1 + 1 !== markerLineNum) return false;
    const marker = doc.line(markerLineNum + 1);
    editorView.dispatch({
      changes: { from: line.from, to: marker.from, insert: "" },
      selection: { anchor: line.from },
      userEvent: "input.nsb.toggle.before-marker-blank"
    });
    return true;
  }

  lastVisibleLineInsideOpenToggle(doc, toggle) {
    if (!toggle) return null;
    for (let i = toggle.bodyEndLine; i >= toggle.bodyStartLine; i--) {
      const text = doc.line(i + 1).text;
      if (!isToggleMarkerLineText(text) && !isBlankLineText(text)) return doc.line(i + 1);
    }
    return toggle.titleLine >= 0 && toggle.titleLine < doc.lines ? doc.line(toggle.titleLine + 1) : null;
  }

  firstEditableLineInsideOpenToggle(doc, toggle) {
    if (!toggle) return null;
    const toggles = scanToggleBlocks(doc);
    for (let i = toggle.bodyStartLine; i <= toggle.bodyEndLine; i++) {
      const text = doc.line(i + 1).text;
      if (isToggleMarkerLineText(text)) continue;
      if (isLineHiddenByCollapsedToggle(toggles, i)) continue;
      return doc.line(i + 1);
    }
    return null;
  }

  deleteLineAfterToggleRange(doc, toggle, line) {
    const lineNum = line.number - 1;
    if (lineNum + 1 < doc.lines) {
      return { from: line.from, to: doc.line(lineNum + 2).from };
    }
    const close = doc.line(toggle.endLine + 1);
    return { from: close.to, to: line.to };
  }

  backspaceLineAfterToggleCM(editorView, toggle, line) {
    const doc = editorView.state.doc;
    if (!toggle || !line || line.number - 1 !== toggle.endLine + 1) return false;
    const toggles = scanToggleBlocks(doc);
    const text = line.text || "";
    const isBlank = isBlankLineText(text);
    const deleteRange = this.deleteLineAfterToggleRange(doc, toggle, line);
    if (!toggle.open) {
      const titleEnd = toggleTitleVisibleEndPos(doc, toggle);
      if (!isBlank && !this.isPlainTextLineForTitleJoin(text)) {
        editorView.dispatch({
          changes: { from: deleteRange.from, to: deleteRange.to, insert: "" },
          selection: { anchor: titleEnd, head: titleEnd },
          userEvent: "input.nsb.toggle.delete-below-title"
        });
        return true;
      }
      const changes = isBlank
        ? [{ from: deleteRange.from, to: deleteRange.to, insert: "" }]
        : [
            { from: titleEnd, to: titleEnd, insert: text },
            { from: deleteRange.from, to: deleteRange.to, insert: "" }
          ];
      const anchor = titleEnd + (isBlank ? 0 : text.length);
      editorView.dispatch({
        changes,
        selection: { anchor, head: anchor },
        userEvent: "input.nsb.toggle.join-below-title"
      });
      return true;
    }

    const targetLine = this.lastVisibleLineInsideOpenToggle(doc, toggle);
    const fallbackAnchor = targetLine
      ? visibleLineEndPos(doc, toggles, targetLine.number - 1)
      : toggleTitleVisibleEndPos(doc, toggle);
    if (isBlank) {
      editorView.dispatch({
        changes: { from: deleteRange.from, to: deleteRange.to, insert: "" },
        selection: { anchor: fallbackAnchor, head: fallbackAnchor },
        userEvent: "input.nsb.toggle.join-below-body"
      });
      return true;
    }

    const insertPos = fallbackAnchor;
    editorView.dispatch({
      changes: [
        { from: insertPos, to: insertPos, insert: text },
        { from: deleteRange.from, to: deleteRange.to, insert: "" }
      ],
      selection: { anchor: insertPos + text.length, head: insertPos + text.length },
      userEvent: "input.nsb.toggle.join-below-body"
    });
    return true;
  }

  insertSiblingToggleAfterCM(editorView, toggle, userEvent, newTitleText, deleteTitleFrom) {
    const doc = editorView.state.doc;
    if (!toggle || toggle.endLine < 0 || toggle.endLine >= doc.lines) return false;
    // A timed block ends like plain text, rather than continuing a TL list.
    if (toggle.meta?.expiry?.v === 1 && !newTitleText && deleteTitleFrom == null) {
      const close = doc.line(toggle.endLine + 1);
      const hasNext = toggle.endLine + 1 < doc.lines;
      const from = hasNext ? doc.line(toggle.endLine + 2).from : close.to;
      editorView.dispatch({changes:{from,insert:"\n"},
        selection:{anchor:hasNext ? from : from + 1},userEvent:"input.nsb.expiring.exit"});
      editorView.focus();
      return true;
    }
    const id = makeToggleId();
    const opener = serializeToggleOpenLine({ id, open: false });
    const titleText = String(newTitleText || "");
    const titleLineText = titleText ? titleText + " " + opener : opener;
    const close = doc.line(toggle.endLine + 1);
    const hasLineAfterClose = toggle.endLine + 1 < doc.lines;
    const insertPos = hasLineAfterClose ? doc.line(toggle.endLine + 2).from : close.to;
    const insertText = hasLineAfterClose
      ? titleLineText + "\n" + NSB_TOGGLE_CLOSE_LINE + "\n"
      : "\n" + titleLineText + "\n" + NSB_TOGGLE_CLOSE_LINE;
    const changes = [];
    if (typeof deleteTitleFrom === "number") {
      const titleEnd = toggleTitleVisibleEndPos(doc, toggle);
      if (deleteTitleFrom < titleEnd) changes.push({ from: deleteTitleFrom, to: titleEnd, insert: "" });
    }
    changes.push({ from: insertPos, to: insertPos, insert: insertText });
    editorView.dispatch({
      changes,
      userEvent: userEvent || "input.nsb.toggle.new"
    });
    editorView.focus();
    requestAnimationFrame(() => {
      try {
        const created = scanToggleBlocks(editorView.state.doc).find(t => t.id === id);
        if (!created || created.titleLine < 0 || created.titleLine >= editorView.state.doc.lines) return;
        const title = editorView.state.doc.line(created.titleLine + 1);
        editorView.dispatch({
          selection: { anchor: title.from, head: title.from },
          userEvent: "select.nsb.toggle.new-title"
        });
      } catch (_) {}
    });
    return true;
  }

  enterOpenToggleBodyCM(editorView, toggle) {
    const doc = editorView.state.doc;
    if (!toggle || !toggle.open || toggle.endLine < 0 || toggle.endLine >= doc.lines) return false;
    const firstBody = this.firstEditableLineInsideOpenToggle(doc, toggle);
    if (firstBody && isBlankLineText(firstBody.text)) {
      // A blank first body row is reused: the cursor just moves into it and
      // no extra row is created. Pressing Enter again (now on the body row)
      // falls through to native behaviour and creates the next row.
      editorView.dispatch({
        selection: { anchor: firstBody.from, head: firstBody.from },
        userEvent: "select.nsb.toggle.body"
      });
      editorView.focus();
      return true;
    }
    if (firstBody) {
      // First body row already has content: insert a fresh blank row above
      // it, pushing the existing content down one row.
      editorView.dispatch({
        changes: { from: firstBody.from, to: firstBody.from, insert: "\n" },
        selection: { anchor: firstBody.from, head: firstBody.from },
        userEvent: "input.nsb.toggle.body-line"
      });
      editorView.focus();
      return true;
    }
    const close = doc.line(toggle.endLine + 1);
    editorView.dispatch({
      changes: { from: close.from, to: close.from, insert: "\n" },
      selection: { anchor: close.from, head: close.from },
      userEvent: "input.nsb.toggle.body-line"
    });
    editorView.focus();
    return true;
  }

  // Replaces an empty TL block with a single plain blank row and parks the
  // cursor on it (Enter-cancel of a never-filled toggle).
  cancelEmptyToggleToBlankLineCM(editorView, toggle) {
    const doc = editorView.state.doc;
    if (!toggle || toggle.startLine < 0 || toggle.endLine >= doc.lines) return false;
    let from = doc.line(toggle.startLine + 1).from;
    let to = doc.line(toggle.endLine + 1).to;
    let insert = "\n";
    let anchor = from;
    if (toggle.endLine + 1 < doc.lines) {
      to = doc.line(toggle.endLine + 2).from;
    } else if (toggle.startLine > 0) {
      from = doc.line(toggle.startLine).to;
      anchor = from + 1;
    } else {
      insert = "";
      anchor = 0;
    }
    editorView.dispatch({
      changes: { from, to, insert },
      selection: { anchor, head: anchor },
      userEvent: "input.nsb.toggle.cancel-empty"
    });
    editorView.focus();
    return true;
  }

  // Joins a line's text into the visible title of an open inline toggle,
  // keeping the end-of-line marker intact (used by Backspace at the start of
  // the first body line, where a native join would land after the marker).
  joinLineIntoTitleCM(editorView, toggle, line) {
    const doc = editorView.state.doc;
    const titleLine = doc.line(toggle.titleLine + 1);
    const markerFrom = toggleTitleVisibleEndPos(doc, toggle);
    const markerText = doc.sliceString(markerFrom, titleLine.to);
    const text = line.text || "";
    editorView.dispatch({
      changes: { from: markerFrom, to: line.to, insert: text + markerText },
      selection: { anchor: markerFrom, head: markerFrom },
      userEvent: "input.nsb.toggle.join-into-title"
    });
    editorView.focus();
    return true;
  }

  preventToggleBoundaryDelete(editorView, event, toggles, line, sel) {
    const doc = editorView.state.doc;
    const lineNum = line.number - 1;
    if (event.key === "Backspace" && sel.from === line.from && lineNum > 0) {
      const prevClose = toggles.find(t => t.endLine === lineNum - 1) || null;
      if (prevClose) {
        event.preventDefault();
        event.stopPropagation();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        return this.backspaceLineAfterToggleCM(editorView, prevClose, line);
      }
      const prevTitle = toggles.find(t => t.inline && t.titleLine === lineNum - 1) || null;
      if (prevTitle) {
        // Current line is the first body line of an open toggle. A native
        // join would append the text after the hidden marker, so join it
        // into the visible title instead. Nested toggle titles / marker
        // lines are never joined; the cursor just moves to the title end.
        event.preventDefault();
        event.stopPropagation();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        const lineIsToggleLine = toggles.some(t =>
          t.titleLine === lineNum || t.startLine === lineNum || t.endLine === lineNum);
        if (lineIsToggleLine || !prevTitle.open) {
          const anchor = toggleTitleVisibleEndPos(doc, prevTitle);
          editorView.dispatch({ selection: { anchor }, userEvent: "select.nsb.toggle.boundary" });
          return true;
        }
        return this.joinLineIntoTitleCM(editorView, prevTitle, line);
      }
      const prevLegacyOpener = toggles.find(t => !t.inline && t.startLine === lineNum - 1) || null;
      if (prevLegacyOpener) {
        event.preventDefault();
        event.stopPropagation();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        const anchor = toggleTitleVisibleEndPos(doc, prevLegacyOpener);
        editorView.dispatch({ selection: { anchor }, userEvent: "select.nsb.toggle.boundary" });
        return true;
      }
      return false;
    }
    if (event.key === "Delete" && sel.from === line.to && lineNum + 1 < doc.lines) {
      const nextToggle = toggles.find(t => t.endLine === lineNum + 1 || (!t.inline && t.startLine === lineNum + 1)) || null;
      if (!nextToggle) return false;
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      if (isBlankLineText(line.text) && nextToggle.endLine === lineNum + 1) {
        return this.deleteBlankBeforeToggleMarkerCM(editorView, lineNum + 1, line);
      }
      return true;
    }
    return false;
  }

  handleToggleEnter(editorView, event) {
    const state = editorView.state;
    const sel = state.selection.main;
    if (!sel.empty) return false;
    const doc = state.doc;
    const line = doc.lineAt(sel.from);
    const lineNum = line.number - 1;
    const toggles = scanToggleBlocks(doc);
    const titleToggle = toggles.find(t => t.titleLine === lineNum);
    if (titleToggle && !titleToggle.open && titleToggle.meta?.expiry?.v === 1 &&
        sel.from >= toggleTitleVisibleEndPos(doc, titleToggle)) {
      event.preventDefault();event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      return this.insertSiblingToggleAfterCM(editorView, titleToggle);
    }
    // Enter on an EMPTY collapsed TL (muted triangle) cancels it back into a
    // plain blank row ready for normal editing, instead of stacking another
    // empty sibling TL. Titled TLs keep the sibling-creation behaviour.
    if (titleToggle && !titleToggle.open && titleToggle.inline && toggleIsEmpty(doc, titleToggle)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      return this.cancelEmptyToggleToBlankLineCM(editorView, titleToggle);
    }
    const adjacentPreviousCollapsed = titleToggle && sel.from === line.from
      ? toggles.find(t => !t.open && t.endLine + 1 === titleToggle.startLine)
      : null;
    const collapsedMappedToggle = toggles.find(t => !t.open && lineNum > t.titleLine && lineNum <= t.endLine);
    if (adjacentPreviousCollapsed) {
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      return this.insertSiblingToggleAfterCM(editorView, adjacentPreviousCollapsed, "input.nsb.toggle.new-between-adjacent");
    }
    if (!titleToggle) {
      if (!collapsedMappedToggle) return false;
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      return this.insertSiblingToggleAfterCM(editorView, collapsedMappedToggle, "input.nsb.toggle.new-after-hidden");
    }
    const toggle = titleToggle;
    const visibleTitle = toggleVisibleTitleText(doc, toggle);
    const visLen = visibleTitle.length;
    // Cursor offsets inside the hidden marker region are normalized to the
    // visible title end (e.g. after pressing End).
    const cursorCh = Math.max(0, Math.min(visLen, sel.from - line.from));
    const restText = visibleTitle.slice(cursorCh);
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    if (toggle.open) {
      if (restText.trim() === "") return this.enterOpenToggleBodyCM(editorView, toggle);
      if (!toggle.inline) return this.enterOpenToggleBodyCM(editorView, toggle);
      // Split: text after the cursor leaves the title (keeping the marker at
      // the line end) and becomes the first body line.
      const markerFrom = toggleTitleVisibleEndPos(doc, toggle);
      const cursorAbs = line.from + cursorCh;
      editorView.dispatch({
        changes: [
          { from: cursorAbs, to: markerFrom, insert: "" },
          { from: line.to, to: line.to, insert: "\n" + restText }
        ],
        selection: { anchor: cursorAbs + (line.to - markerFrom) + 1 },
        userEvent: "input.nsb.toggle.split-title-to-body"
      });
      editorView.focus();
      return true;
    }
    const deleteFrom = cursorCh < visLen ? line.from + cursorCh : null;
    return this.insertSiblingToggleAfterCM(editorView, toggle, "input.nsb.toggle.new", restText, deleteFrom);
  }

  // Vertical cursor motion around collapsed TLs. CodeMirror's default
  // moveVertically can stall on rows that end in a folded marker region:
  // the cursor first detours to the visible title end (or does not move at
  // all) and only the second keypress reaches the neighbouring row. When the
  // default motion produces no visual row change, jump straight to the next
  // (previous) visible document line at the same visible column.
  handleToggleArrowNav(editorView, event) {
    const state = editorView.state;
    const sel = state.selection.main;
    if (!sel.empty) return false;
    const doc = state.doc;
    const toggles = scanToggleBlocks(doc);
    if (!toggles.length) return false;
    const forward = event.key === "ArrowDown";
    const line = doc.lineAt(sel.head);
    const lineNum = line.number - 1;
    // Let CodeMirror try first; accept its answer whenever it actually moved
    // to a different visual row (this keeps within-line wrapped-row motion
    // and all ordinary cases on the default path).
    let moved = false;
    try {
      const def = editorView.moveVertically(sel, forward);
      const curC = editorView.coordsAtPos(sel.head);
      const newC = editorView.coordsAtPos(def.head);
      if (curC && newC && Math.abs(newC.top - curC.top) > 2) moved = true;
    } catch (_) {
      moved = false;
    }
    if (moved) return false;
    const hiddenMarkers = toggleHiddenMarkerLines(toggles);
    const isHiddenLine = (n) =>
      hiddenMarkers.has(n) || isLineHiddenByCollapsedToggle(toggles, n);
    let target;
    if (forward) {
      const curCollapsed = toggles.find(t => t.titleLine === lineNum && !t.open);
      target = curCollapsed ? curCollapsed.endLine + 1 : lineNum + 1;
      while (target < doc.lines && isHiddenLine(target)) target++;
      if (target >= doc.lines) return false;
    } else {
      target = lineNum - 1;
      while (target >= 0 && isHiddenLine(target)) target--;
      if (target < 0) return false;
    }
    const targetLine = doc.line(target + 1);
    const curVisEnd = visibleLineEndPos(doc, toggles, lineNum);
    const col = Math.max(0, Math.min(sel.head, curVisEnd) - line.from);
    const anchor = Math.min(targetLine.from + col, visibleLineEndPos(doc, toggles, target));
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    editorView.dispatch({
      selection: { anchor, head: anchor },
      scrollIntoView: true,
      userEvent: "select.nsb.toggle.vertical"
    });
    return true;
  }

  // Backspace / Delete / ArrowLeft at a list marker edge (Live Preview). Runs
  // after the TL handlers; true when the key was consumed.
  handleListMarkerKey(editorView, event) {
    if (!NSB_LIST_MARKER_FEATURES_ENABLED || event.defaultPrevented) return false;
    const state = editorView.state;
    const sel = state.selection.main;
    if (!sel.empty || state.selection.ranges.length > 1) return false;
    let spec = null;
    if (event.key === "Backspace") spec = listMarkerBackspaceSpec(state, sel.head);
    else if (event.key === "Delete") spec = listMarkerDeleteSpec(state, sel.head);
    else if (event.key === "ArrowLeft") spec = listMarkerLeftSpec(state, sel.head);
    if (!spec) return false;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    editorView.dispatch(spec);
    return true;
  }
  handleToggleDelete(editorView, event) {
    const state = editorView.state;
    const sel = state.selection.main;
    const doc = state.doc;
    const toggles = scanToggleBlocks(doc);
    if (!sel.empty) {
      const fromLine = doc.lineAt(sel.from);
      const toLine = doc.lineAt(sel.to);
      const selectedToggle = toggles.find(t => {
        const title = doc.line(t.titleLine + 1);
        const visEnd = toggleTitleVisibleEndPos(doc, t);
        return sel.from <= title.from && sel.to >= visEnd &&
          fromLine.number - 1 <= t.titleLine && toLine.number - 1 >= t.titleLine;
      });
      const touchesMarker = toggles.some(t => {
        const title = doc.line(t.titleLine + 1);
        const close = doc.line(t.endLine + 1);
        const markerFrom = t.inline
          ? toggleTitleVisibleEndPos(doc, t)
          : doc.line(t.startLine + 1).from;
        const markerTo = t.inline ? title.to : doc.line(t.startLine + 1).to;
        return (sel.from < markerTo && sel.to > markerFrom) || (sel.from < close.to && sel.to > close.from);
      });
      if (!selectedToggle) {
        if (!touchesMarker) return false;
        event.preventDefault();
        event.stopPropagation();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        return true;
      }
      const titleText = toggleVisibleTitleText(doc, selectedToggle);
      const hasBody = toggleHasBodyContent(doc, selectedToggle);
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      if (titleText.trim() === "") {
        if (hasBody) return this.unwrapToggleDeletingTitleLineCM(editorView, selectedToggle);
        return this.deleteToggleBlockCM(editorView, selectedToggle, true);
      }
      return this.clearToggleTitleCM(editorView, selectedToggle);
    }
    const line = doc.lineAt(sel.from);
    const lineNum = line.number - 1;
    const toggle = toggles.find(t => t.titleLine === lineNum);
    if (!toggle) return this.preventToggleBoundaryDelete(editorView, event, toggles, line, sel);
    const visEnd = toggleTitleVisibleEndPos(doc, toggle);
    // Cursor positions inside the hidden marker region count as title end.
    const selPos = sel.from > visEnd ? visEnd : sel.from;
    const titleText = toggleVisibleTitleText(doc, toggle);
    const titleEmpty = titleText.trim() === "";
    const hasBody = toggleHasBodyContent(doc, toggle);
    if (!titleEmpty) {
      if (!((event.key === "Backspace" && selPos === line.from) ||
        (event.key === "Delete" && selPos === visEnd))) return false;
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      return this.unwrapToggleBlockCM(editorView, toggle);
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    if (hasBody) return this.unwrapToggleDeletingTitleLineCM(editorView, toggle);
    // Backspace/Delete on an empty (muted) TL behaves exactly like Enter:
    // the TL is cancelled into a plain blank row and the cursor stays on
    // that row instead of jumping back to the previous line.
    return this.cancelEmptyToggleToBlankLineCM(editorView, toggle);
  }

  insertToggleList(editor, options) {
    const opts = options || {};
    const id = makeToggleId();
    const closeLine = NSB_TOGGLE_CLOSE_LINE;
    const hasSelection = editor.somethingSelected && editor.somethingSelected();
    if (hasSelection) {
      const from = editor.getCursor("from");
      const to = editor.getCursor("to");
      let endLine = to.line;
      if (to.ch === 0 && endLine > from.line) endLine -= 1;
      return this.wrapLinesInToggle(editor, from.line, endLine);
    }

    const cursor = editor.getCursor();
    const current = editor.getLine(cursor.line) || "";
    let insertLine = typeof opts.insertLine === "number"
      ? opts.insertLine
      : (current.trim() === "" ? cursor.line : cursor.line + 1);
    // Inline format: the new TL is title-line-with-marker + close line. The
    // close line is folded away visually, so the TL occupies one row only.
    const snippet = serializeToggleOpenLine({ id, open: false }) + "\n" + closeLine;
    if (current.trim() === "" && insertLine === cursor.line && typeof opts.insertLine !== "number") {
      editor.replaceRange(snippet, { line: cursor.line, ch: 0 }, { line: cursor.line, ch: current.length });
      editor.setCursor({ line: cursor.line, ch: 0 });
      editor.focus();
      return;
    }
    if (insertLine >= editor.lineCount()) {
      const last = Math.max(0, editor.lineCount() - 1);
      const ch = (editor.getLine(last) || "").length;
      const prefix = last === 0 && ch === 0 ? "" : "\n";
      editor.replaceRange(prefix + snippet, { line: last, ch });
      editor.setCursor({ line: last + (prefix ? 1 : 0), ch: 0 });
    } else {
      editor.replaceRange(snippet + "\n", { line: insertLine, ch: 0 });
      editor.setCursor({ line: insertLine, ch: 0 });
    }
    editor.focus();
  }

  wrapLinesInToggle(editor, startLine, endLine) {
    if (startLine == null || endLine == null) return false;
    if (editor.cm && editor.cm.state && editor.cm.state.doc) {
      const doc = editor.cm.state.doc;
      const toggles = scanToggleBlocks(doc);
      if (toggles.some(t => startLine === t.startLine || startLine === t.titleLine || startLine === t.endLine)) {
        new import_obsidian.Notice("This row is already a toggle list");
        editor.focus();
        return true;
      }
    }
    const first = Math.max(0, Math.min(startLine, editor.lineCount() - 1));
    const last = Math.max(first, Math.min(endLine, editor.lineCount() - 1));
    const id = makeToggleId();
    const title = editor.getLine(first) || "";
    let hasBody = false;
    for (let i = first + 1; i <= last; i++) {
      if ((editor.getLine(i) || "").trim() !== "") {
        hasBody = true;
        break;
      }
    }
    // Inline format: append the opener marker to the end of the chosen row
    // (which becomes the title in place — headings included) and a hidden
    // close line after the last wrapped row. No extra visual row appears.
    // Both markers MUST leave in ONE transaction: with two replaceRange
    // calls, the intermediate doc's lone opener steals an ENCLOSING TL's
    // close marker on the scan stack, and the marker guard then remaps the
    // second call's close insertion to before the opener — permanently
    // unclosing the parent TL (raw markers exposed, collapse broken).
    const sep = title.trim() === "" ? "" : " ";
    const openerText = sep + serializeToggleOpenLine({ id, open: hasBody });
    const closeText = "\n" + NSB_TOGGLE_CLOSE_LINE;
    if (editor.cm && editor.cm.state && editor.cm.state.doc) {
      const doc = editor.cm.state.doc;
      const titleTo = doc.line(first + 1).to;
      const changes = first === last
        ? [{ from: titleTo, to: titleTo, insert: openerText + closeText }]
        : [
            { from: titleTo, to: titleTo, insert: openerText },
            { from: doc.line(last + 1).to, to: doc.line(last + 1).to, insert: closeText }
          ];
      editor.cm.dispatch({
        changes,
        selection: { anchor: titleTo, head: titleTo },
        userEvent: "input.nsb.toggle.wrap"
      });
    } else {
      editor.replaceRange(openerText, { line: first, ch: title.length });
      editor.replaceRange(closeText, { line: last, ch: (editor.getLine(last) || "").length });
      editor.setCursor({ line: first, ch: title.length });
    }
    editor.focus();
    return true;
  }

  insertToggleListAfterTarget(editor, target) {
    if (target && editor.cm && editor.cm.state && editor.cm.state.doc) {
      if (!this.canMakeToggleListFromTarget(editor, target)) return false;
      const range = expandToggleRangeForLines(editor.cm.state.doc, target.startLine, target.endLine);
      if (this.wrapLinesInToggle(editor, range.startLine, range.endLine)) return;
    }
    return this.insertToggleList(editor);
  }

  // Line span a handle-drag should carry when the grabbed block belongs to
  // the current multi-line editor selection. Returns null when the drag is a
  // plain single-block drag: no selection, a single-line selection, a grab
  // outside the selection, or a selection that equals the grabbed block.
  // The raw selection span is widened to whole logical blocks (fences,
  // callouts) and any partially-covered TL pulls in its complete block so
  // hidden markers can never be split by a move.
  getSelectionDragSpan(state, grabStart, grabEnd) {
    if (!state || !state.selection || !state.doc) return null;
    const doc = state.doc;
    let lo = Infinity, hi = -1;
    for (const r of (state.selection.ranges || [])) {
      if (!r || r.empty) continue;
      const fromLine = doc.lineAt(r.from);
      const toLine = doc.lineAt(r.to);
      let s = fromLine.number - 1;
      let e = toLine.number - 1;
      // A selection ending exactly at a line start does not include that line.
      if (e > s && r.to === toLine.from) e--;
      lo = Math.min(lo, s);
      hi = Math.max(hi, e);
    }
    if (hi < 0 || lo >= hi) return null;
    if (grabEnd < lo || grabStart > hi) return null;
    lo = Math.min(lo, resolveBlockBoundary(doc, lo).startLine);
    hi = Math.max(hi, resolveBlockBoundary(doc, hi).endLine);
    const toggles = scanToggleBlocks(doc);
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of toggles) {
        const touchesMarker =
          (t.startLine >= lo && t.startLine <= hi) ||
          (t.titleLine >= lo && t.titleLine <= hi) ||
          (t.endLine >= lo && t.endLine <= hi);
        if (!touchesMarker) continue;
        if (t.startLine < lo || t.endLine > hi) {
          lo = Math.min(lo, t.startLine);
          hi = Math.max(hi, t.endLine);
          changed = true;
        }
      }
    }
    // A span identical to the grabbed block still counts: the drag changes
    // nothing about what travels, but the mouse-up has to put the selection
    // back rather than collapse it.
    return { startLine: lo, endLine: hi };
  }

  // How a drag gesture ends. A move is delete+insert, so CM's own mapping
  // always loses the dragged rows: the deletion collapses the selection into
  // the gap it leaves and the freshly inserted text belongs to no selection.
  //   • drag that began from a selection → re-select the block where it
  //     landed, so the same rows stay highlighted and can be dragged again;
  //   • plain single-block drag → bare cursor on the block's first line.
  restoreSelectionAfterDrag(editorView, startLine, endLine, keepSelection) {
    if (!keepSelection) {
      this.collapseSelectionAfterDrag(editorView, startLine);
      return;
    }
    try {
      const doc = editorView.state.doc;
      const first = doc.line(clampNumber(startLine + 1, 1, doc.lines));
      const lastNum0 = clampNumber(endLine, startLine, doc.lines - 1);
      // Stop at the row's visible end so the selection never runs into a
      // hidden TL marker region.
      const head = visibleLineEndPos(doc, scanToggleBlocks(doc), lastNum0);
      editorView.dispatch({
        selection: { anchor: first.from, head: Math.max(first.from, head) },
        userEvent: "select.nsb.drag-end"
      });
      // CM only pushes a selection into the DOM while focused; without this
      // the rows would keep showing the stale pre-move highlight.
      editorView.focus();
    } catch (_) {
      this.collapseSelectionAfterDrag(editorView, startLine);
    }
  }

  // Ends a plain (non-selection) drag with a bare cursor on the dropped
  // block's first line. The native DOM selection is cleared too: its
  // highlight can outlive the CM selection while the view is unfocused.
  collapseSelectionAfterDrag(editorView, lineNum0) {
    try {
      const doc = editorView.state.doc;
      const line = doc.line(clampNumber(lineNum0 + 1, 1, doc.lines));
      editorView.dispatch({
        selection: { anchor: line.from, head: line.from },
        userEvent: "select.nsb.drag-end"
      });
    } catch (_) {}
    try {
      // Only when unfocused: a focused CM syncs the DOM selection from state
      // itself, and yanking the ranges out from under it fights that sync.
      if (!editorView.hasFocus) {
        const sel = window.getSelection && window.getSelection();
        if (sel && sel.rangeCount && !sel.isCollapsed &&
            editorView.dom.contains(sel.anchorNode)) sel.removeAllRanges();
      }
    } catch (_) {}
  }

  beginEditDrag(e, target, editorView, overlay) {
    if (!NSB_BLOCK_FEATURES_ENABLED) return;
    if (target && target.noHandle) return;
    this.cancelEditDrag?.();
    this.isDragging=true; overlay.hideAll();
    const doc=editorView.state.doc;

    // Expand logic:
    // • embed  → boundary already resolved by _resolveEmbedRange, use as-is
    // • sel    → multi-line selection; startLine/endLine ARE the full range, no expand
    //            (resolveBlockBoundary would collapse endLine to first block's end = bug 3)
    // • line   → single-block hover/pin; expand to logical block boundary
    let {startLine, endLine} = target;
    if (target.kind === "line") {
      const exp = resolveBlockBoundary(doc, startLine);
      startLine = exp.startLine; endLine = exp.endLine;
    }
    // embed and sel: use startLine/endLine as provided

    // Multi-block drag: when the grabbed block is part of the current
    // multi-line editor selection, the whole selection travels as one span
    // (expanded to block boundaries, selected blank lines included). A handle
    // grabbed OUTSIDE the selection drags only its own block, as before.
    const selSpan = this.getSelectionDragSpan(editorView.state, startLine, endLine);
    if (selSpan) { startLine = selSpan.startLine; endLine = selSpan.endLine; }
    // A drag that started from a selection ends with that selection intact.
    const keepSelection = !!selSpan;

    const allUnits=this.collectDraggableUnits(editorView);

    let labelText=getBlockDragLabel(doc,startLine,target.el);
    if (selSpan) {
      const unitCount = allUnits.filter(u => u.startLine >= startLine && u.endLine <= endLine).length;
      if (unitCount > 1) labelText += " ×" + unitCount;
    }

    const ghost=document.createElement("div");
    ghost.className="nsb-ghost"; ghost.textContent=labelText;
    document.body.appendChild(ghost);

    const indicator=document.createElement("div");
    indicator.className="nsb-drop-indicator"; indicator.style.display="none";
    const scroller=editorView.scrollDOM;
    scroller.appendChild(indicator);
    // A drag no longer freezes the scroller: the wheel pans the note while a
    // block is in flight (needed to reach a drop target off-screen). The drop
    // slots are recomputed from the last pointer position on every scroll, so
    // the indicator keeps tracking the content under the cursor.
    let lastMoveEvent=e;

    const dragRect=target.el.getBoundingClientRect();
    const ox=clampNumber(e.clientX-dragRect.left,0,Math.max(0,dragRect.width));
    const oy=clampNumber(e.clientY-dragRect.top,0,Math.max(0,dragRect.height));
    let targetInsertLine=-1;
    const dragToggles=scanToggleBlocks(doc);
    const draggedIsSingleBlankLine = startLine === endLine && isBlankLineText(doc.line(startLine + 1).text);
    let toggleDropEl=null;
    let toggleDropTarget=null;
    const clearToggleDropTarget=()=>{
      if (toggleDropEl) toggleDropEl.classList.remove("nsb-toggle-drop-target");
      toggleDropEl=null;
      toggleDropTarget=null;
    };
    const setDropIndicator=(refEl, indicatorClientY, insertLine)=>{
      const scrollerRect=scroller.getBoundingClientRect();
      const refR=refEl.getBoundingClientRect();
      const depth=getToggleInsertDepth(dragToggles, insertLine);
      const iTop=indicatorClientY-scrollerRect.top+scroller.scrollTop;
      indicator.style.display="block";
      indicator.style.top=(iTop-1)+"px";
      indicator.style.left=(refR.left-scrollerRect.left)+"px";
      indicator.style.width=refR.width+"px";
      indicator.textContent="";
      if (depth<=0) {
        indicator.classList.remove("is-segmented");
        return;
      }
      indicator.classList.add("is-segmented");
      const shortLen=Math.max(10,(this.settings.toggleIconSize||16)+2);
      const gap=6;
      let left=0;
      for (let i=0;i<depth;i++) {
        const s=document.createElement("span");
        s.className="nsb-drop-segment";
        s.style.left=left+"px";
        s.style.width=shortLen+"px";
        indicator.appendChild(s);
        left+=shortLen+gap;
      }
      const long=document.createElement("span");
      long.className="nsb-drop-segment";
      long.style.left=left+"px";
      long.style.width="max(0px, calc(100% - "+left+"px))";
      indicator.appendChild(long);
    };
    // Providers may veto insert lines for this drag (Section Blocks: a block that
    // carries a section never lands inside another section).
    const dropAllowed=(line)=>this.blockProviders().every(provider=>
      typeof provider.nsbAllowDrop!=="function" || provider.nsbAllowDrop(editorView,startLine,endLine,line,target)!==false);
    const findToggleTitleDrop=(me)=>{
      for (const t of dragToggles) {
        if (!(t.endLine < startLine || t.startLine > endLine)) continue;
        if (draggedIsSingleBlankLine) continue;
        if (t.open && toggleHasBodyContent(doc, t)) continue;
        if (!dropAllowed(t.endLine)) continue;
        const line=domLineForNum(editorView,scroller,t.titleLine);
        if (!line) continue;
        const r=line.getBoundingClientRect();
        // Hot zone = the vertical middle band of the title row only. The top
        // and bottom edges stay with the slot logic, so hovering near a TL's
        // edge shows the between-blocks insertion line (and drops there)
        // instead of swallowing the block into the TL.
        const edge=Math.max(4,(r.bottom-r.top)*0.28);
        if (me.clientX>=r.left-HANDLE_W && me.clientX<=r.right &&
            me.clientY>=r.top+edge && me.clientY<=r.bottom-edge) {
          return {toggle:t,el:line};
        }
      }
      return null;
    };

    const move=me=>{
      if (me.isTrusted && me.buttons === 0) { this.cancelEditDrag?.(); return; }
      lastMoveEvent=me;
      ghost.style.left=(me.clientX-ox)+"px"; ghost.style.top=(me.clientY-oy)+"px";
      clearToggleDropTarget();
      if (this.blockProviders().some(provider => provider.nsbDragHover?.(editorView, startLine, endLine, me, target))) {
        indicator.style.display="none";
        targetInsertLine=-1;
        return;
      }
      indicator.classList.remove("is-segmented");
      indicator.textContent="";
      const titleDropTarget=findToggleTitleDrop(me);
      if (titleDropTarget) {
        targetInsertLine=titleDropTarget.toggle.endLine;
        toggleDropTarget=titleDropTarget.toggle;
        toggleDropEl=titleDropTarget.el;
        toggleDropEl.classList.add("nsb-toggle-drop-target");
        indicator.style.display="none";
        return;
      }
      const others=allUnits.filter(u=>u.endLine<startLine||u.startLine>endLine);
      if (!others.length) { indicator.style.display="none"; return; }

      const scrollerRect=scroller.getBoundingClientRect();

      {
        const slots = [];
        for (let i = 0; i <= others.length; i++) {
          if (i === 0) {
            const r0 = others[0].el.getBoundingClientRect();
            slots.push({ triggerY: r0.top, indicatorY: r0.top, insertLine: others[0].startLine, refEl: others[0].el, noOp: false });
          } else if (i === others.length) {
            const rL = others[others.length - 1].el.getBoundingClientRect();
            slots.push({ triggerY: rL.bottom, indicatorY: rL.bottom, insertLine: others[others.length - 1].endLine + 1, refEl: others[others.length - 1].el, noOp: false });
          } else {
            const rA = others[i - 1].el.getBoundingClientRect();
            const rB = others[i].el.getBoundingClientRect();
            const isOriginalGap = others[i - 1].endLine < startLine && others[i].startLine > endLine;
            if (isOriginalGap) {
              slots.push({
                triggerY: rA.bottom,
                indicatorY: rA.top,
                insertLine: others[i - 1].startLine,
                refEl: others[i - 1].el,
                noOp: false
              });
              slots.push({
                triggerY: (rA.bottom + rB.top) / 2,
                indicatorY: rB.top,
                insertLine: startLine,
                refEl: others[i].el,
                noOp: true
              });
            } else {
              slots.push({
                triggerY: (rA.bottom + rB.top) / 2,
                indicatorY: rB.top,
                insertLine: others[i].startLine,
                refEl: others[i].el,
                noOp: false
              });
            }
          }
        }

        // Vetoed slots drop out before the nearest one is chosen, so the
        // indicator snaps to the closest legal boundary.
        const legal = slots.filter(s => s.noOp || dropAllowed(s.insertLine));
        if (!legal.length) { indicator.style.display = "none"; targetInsertLine = -1; return; }
        let best = legal[0], bestDist = Math.abs(legal[0].triggerY - me.clientY);
        for (let i = 1; i < legal.length; i++) {
          const d = Math.abs(legal[i].triggerY - me.clientY);
          if (d < bestDist) { bestDist = d; best = legal[i]; }
        }

        if (best.noOp) {
          indicator.style.display = "none";
          targetInsertLine = startLine;
          return;
        }

        const refEl = best.refEl || others[0].el;
        targetInsertLine = normalizeInsertLineForVacuum(doc,best.insertLine);
        setDropIndicator(refEl,best.indicatorY,targetInsertLine);
        return;
      }

      // Count how many units in `others` are above the dragged block
      const nBefore = others.filter(u=>u.endLine<startLine).length;

      // Original drag-rect (captured at mousedown, stable during drag)
      const origTop    = dragRect.top;
      const origBottom = dragRect.bottom;
      const origMid    = (origTop + origBottom) / 2;

      // Build gap list. Each entry: { clientY, insertIdx, noOp? }
      // We split the gap that spans the dragged block's original position into two:
      //   • upper split  (clientY = midpoint between row-above and origTop):
      //       → shows indicator between the row above and the block's old position
      //       → this IS a real move (block goes above its original place)
      //   • lower split  (clientY = origMid):
      //       → the "original slot" below the block — no-op, hide indicator
      //
      // All other gaps are built normally between adjacent others[].
      const gaps = [];

      for (let i = 0; i <= others.length; i++) {
        if (i === nBefore) {
          // This is where the dragged block used to sit.
          // Upper boundary of this slot:
          const slotTop = (nBefore > 0)
            ? others[nBefore-1].el.getBoundingClientRect().bottom
            : -Infinity;
          // The "insert above original position" gap lives halfway between
          // the row-above's bottom and the block's original top.
          const upperY = nBefore > 0 ? (slotTop + origTop) / 2 : origTop - 1;
          gaps.push({ clientY: upperY, insertIdx: i, noOp: false });
          // The "original slot / insert below" gap lives at the original mid-point
          // (covers the block body + gap between block and row below).
          gaps.push({ clientY: origMid, insertIdx: i, noOp: true });
        } else if (i < others.length) {
          if (i === 0) {
            gaps.push({ clientY: others[0].el.getBoundingClientRect().top, insertIdx: 0, noOp: false });
          } else {
            const rA = others[i-1].el.getBoundingClientRect();
            const rB = others[i].el.getBoundingClientRect();
            gaps.push({ clientY: (rA.bottom + rB.top) / 2, insertIdx: i, noOp: false });
          }
        } else {
          // After the last unit
          gaps.push({ clientY: others[others.length-1].el.getBoundingClientRect().bottom, insertIdx: others.length, noOp: false });
        }
      }

      // Find the gap with minimum distance to current mouse Y
      let best = gaps[0], bestDist = Math.abs(gaps[0].clientY - me.clientY);
      for (let i = 1; i < gaps.length; i++) {
        const d = Math.abs(gaps[i].clientY - me.clientY);
        if (d < bestDist) { bestDist = d; best = gaps[i]; }
      }

      // No-op slot → hide indicator
      if (best.noOp) {
        indicator.style.display = "none";
        targetInsertLine = startLine; // rejected by up() guard
        return;
      }

      let iClientY, iLeft, iWidth, candidateLine;

      // Special case: upper gap (insert before the block's original position).
      // others[nBefore] is the first row BELOW the block — its top is wrong.
      // The indicator should appear at dragRect.top (= the block's original top
      // = the underside of the row above), using geometry from the row above.
      if (best.insertIdx === nBefore && nBefore > 0) {
        const uAbove = others[nBefore - 1], urAbove = uAbove.el.getBoundingClientRect();
        candidateLine = startLine;          // insert at original position (above block)
        iClientY = origTop;                 // block's original top = row-above's bottom
        iLeft    = urAbove.left - scrollerRect.left;
        iWidth   = urAbove.width;
      } else if (best.insertIdx < others.length) {
        const u = others[best.insertIdx], ur = u.el.getBoundingClientRect();
        candidateLine = u.startLine; iClientY = ur.top; iLeft = ur.left - scrollerRect.left; iWidth = ur.width;
      } else {
        const u = others[others.length-1], ur = u.el.getBoundingClientRect();
        candidateLine = u.endLine + 1; iClientY = ur.bottom; iLeft = ur.left - scrollerRect.left; iWidth = ur.width;
      }

      targetInsertLine = candidateLine;
      const iTop = iClientY - scrollerRect.top + scroller.scrollTop;
      indicator.style.display = "block";
      indicator.style.top  = (iTop - 1) + "px";
      indicator.style.left = iLeft + "px";
      indicator.style.width = iWidth + "px";
    };

    move(e); // initial call: indicator hidden (original slot)

    // Wheel/trackpad scrolling during the drag: re-run the slot math with the
    // pointer where it still is, so the indicator follows the content.
    const onDragScroll=()=>{ if (lastMoveEvent) move(lastMoveEvent); };
    scroller.addEventListener("scroll",onDragScroll,{passive:true});

    let finished=false;
    const cleanup=()=>{
      if (finished) return;
      finished=true;
      document.removeEventListener("mousemove",move);
      document.removeEventListener("mouseup",up,true);
      document.removeEventListener("keydown",cancelKey,true);
      document.removeEventListener("dragstart",preventNative,true);
      document.removeEventListener("pointercancel",cancel,true);
      document.removeEventListener("visibilitychange",onVisibility);
      window.removeEventListener("blur",cancel);
      ghost.remove(); indicator.remove();
      scroller.removeEventListener("scroll",onDragScroll);
      this.isDragging=false; overlay.clearPinnedAfterDrag();
      if (this.cancelEditDrag === cancel) this.cancelEditDrag=null;
    };
    const cancel=()=>{
      cleanup(); clearToggleDropTarget();
      for (const provider of this.blockProviders()) provider.clearDrop?.();
    };
    const cancelKey=event=>{ if(event.key==='Escape') { event.preventDefault(); event.stopPropagation(); cancel(); } };
    const preventNative=event=>{ event.preventDefault(); event.stopPropagation(); };
    const onVisibility=()=>{ if(document.visibilityState==='hidden') cancel(); };
    const up=()=>{
      if (finished) return;
      const dropToggle=toggleDropTarget;
      cleanup(); clearToggleDropTarget();
      // Every line number in this drag was frozen against `doc` at
      // mousedown. If any edit slipped in mid-drag (the editor keeps
      // focus, so Enter/typing still lands), those numbers are stale and
      // the guard-bypassed move could delete a TL marker line one row
      // off. CM docs are immutable — a reference check detects any edit.
      if (editorView.state.doc !== doc) {
        for (const provider of this.blockProviders()) provider.clearDrop?.();
        return;
      }
      if (this.blockProviders().some(provider => provider.finishNsbDrop?.(editorView, startLine, endLine, doc))) return;
      const blockSize = endLine - startLine + 1;
      if (targetInsertLine>=0&&!(targetInsertLine>=startLine&&targetInsertLine<=endLine+1)) {
        // v2.9.4: dispatch directly on this editorView via moveBlockCM.
        // No MarkdownView lookup, no whole-document replaceRange — see the
        // header changelog for why both of those caused subtle bugs.
        const saved=scroller.scrollTop;
        const intoToggleStart = dropToggle
          ? this.moveBlockIntoToggleCM(editorView, startLine, endLine, dropToggle) : null;
        const newStart = intoToggleStart !== null
          ? intoToggleStart
          : this.moveBlockCM(editorView, startLine, endLine, targetInsertLine);
        requestAnimationFrame(()=>{
          scroller.scrollTop=saved;
          // The move is a delete+insert, so CM's mapped selection collapses
          // into the gap the deletion left. Restore the gesture's own
          // selection on the block where it actually landed.
          const landed = newStart === null ? startLine : newStart;
          this.restoreSelectionAfterDrag(editorView, landed, landed + blockSize - 1, keepSelection);
        });
      } else {
        // Dropped back where it started: nothing moved, but the mouse-up must
        // still leave the same rows highlighted (or a plain cursor for a
        // single-block drag).
        this.restoreSelectionAfterDrag(editorView, startLine, endLine, keepSelection);
      }
    };
    document.addEventListener("mousemove",move);
    document.addEventListener("mouseup",up,true);
    document.addEventListener("keydown",cancelKey,true);
    document.addEventListener("dragstart",preventNative,true);
    document.addEventListener("pointercancel",cancel,true);
    document.addEventListener("visibilitychange",onVisibility);
    window.addEventListener("blur",cancel);
    this.cancelEditDrag=cancel;
  }

  // collectDraggableUnits: uses the same proportional-Y probe as _resolveEmbedRange
  // so that embed startLine/endLine values are guaranteed consistent between the
  // two call sites (avoids off-by-one that caused bookmark moves to go wrong).
  // Web Bookmark embeds are handled first with scanWbFences/matchFenceToEmbed
  // because posAtCoords inside those widgets is not reliable.
  //
  // v2.9.4: wb-managed embeds are no longer skipped here. They are INCLUDED as
  // units so that when the user drags another block past a bookmark, the
  // bookmark serves as a valid slot target (correct indicator position above
  // and below it). Hover/click is still blocked for wb-managed embeds elsewhere,
  // so they remain non-draggable from NSB's side as long as wb plugin manages
  // them. When wb plugin's drag is OFF (no data-wb-drag-managed attribute),
  // isWbManaged returns false and the embed is fully draggable by NSB.
  collectDraggableUnits(editorView) {
    const units=[], doc=editorView.state.doc, seen=new Set();
    for (const provider of this.blockProviders()) for (const unit of provider.nsbUnits(editorView) || []) {
      units.push(unit);
      for (let i=unit.startLine; i<=unit.endLine; i++) seen.add(i);
    }
    const wbFences=scanWbFences(doc);
    const quoteRanges=scanQuoteBlocks(doc);
    const embedRanges=scanInternalEmbedLines(doc);
    const toggles=scanToggleBlocks(doc);
    const toggleTitleByLine=new Map();
    const toggleMarkerLines=toggleHiddenMarkerLines(toggles);
    for (const t of toggles) {
      toggleTitleByLine.set(t.titleLine,t);
    }

    for (const visual of Array.from(editorView.scrollDOM.querySelectorAll(".wb-container"))) {
      const root=getWbBlockRoot(visual);
      if (!root||isTableElement(root)) continue;
      const wbRange=resolveWbEmbedRange(visual,editorView,wbFences);
      if (!wbRange) continue;
      if (isRangeHiddenByCollapsedToggle(toggles,wbRange.startLine,wbRange.endLine)) continue;
      if (seen.has(wbRange.startLine)) continue;
      for (let i=wbRange.startLine;i<=wbRange.endLine;i++) seen.add(i);
      units.push({el:visual,startLine:wbRange.startLine,endLine:wbRange.endLine});
    }

    for (const visual of Array.from(editorView.scrollDOM.querySelectorAll(".callout"))) {
      const root=getEmbedBlockRoot(visual);
      if (!root||isTableElement(root)) continue;
      const quoteRange=matchRangesToElement(quoteRanges,root,editorView,80)||
        matchRangesToElement(quoteRanges,visual,editorView,80);
      if (!quoteRange) continue;
      if (isRangeHiddenByCollapsedToggle(toggles,quoteRange.startLine,quoteRange.endLine)) continue;
      if (seen.has(quoteRange.startLine)) continue;
      for (let i=quoteRange.startLine;i<=quoteRange.endLine;i++) seen.add(i);
      units.push({el:visual,startLine:quoteRange.startLine,endLine:quoteRange.endLine});
    }

    for (const visual of Array.from(editorView.scrollDOM.querySelectorAll(BUILTIN_EMBED_SELECTOR))) {
      if (isWbBookmarkEmbed(visual)) continue;
      const root=getEmbedBlockRoot(visual);
      if (!root||isTableElement(root)) continue;
      const embedRange=resolveBuiltinEmbedRange(visual,editorView,embedRanges);
      if (!embedRange) continue;
      if (isRangeHiddenByCollapsedToggle(toggles,embedRange.startLine,embedRange.endLine)) continue;
      if (seen.has(embedRange.startLine)) continue;
      for (let i=embedRange.startLine;i<=embedRange.endLine;i++) seen.add(i);
      units.push({el:visual,startLine:embedRange.startLine,endLine:embedRange.endLine});
    }

    for (const embed of Array.from(editorView.scrollDOM.querySelectorAll(".cm-embed-block"))) {
      if (isTableElement(embed)||isWbBookmarkEmbed(embed)) continue;
      const r=embed.getBoundingClientRect();
      const h=r.bottom-r.top;
      // Identical probe points to _resolveEmbedRange (proportional, not fixed px)
      const probeYs=[
        r.top+2,
        r.top+Math.max(4,h*0.15),
        r.top+Math.max(8,h*0.35),
        r.top+Math.max(12,h*0.55),
        r.top+Math.max(16,h*0.75),
      ];
      let bounds=null;
      for (const py of probeYs) {
        try {
          const pos=editorView.posAtCoords({x:r.left+4,y:py},false);
          if (pos==null) continue;
          const lineNum=doc.lineAt(pos).number-1;
          const b=resolveBlockBoundary(doc,lineNum);
          if (b.startLine<b.endLine) { bounds=b; break; }
          if (!bounds) bounds=b;
        } catch(_){}
      }
      if (!bounds) continue;
      if (isRangeHiddenByCollapsedToggle(toggles,bounds.startLine,bounds.endLine)) continue;
      if (seen.has(bounds.startLine)) continue;
      for (let i=bounds.startLine;i<=bounds.endLine;i++) seen.add(i);
      units.push({el:embed,startLine:bounds.startLine,endLine:bounds.endLine});
    }

    for (const line of Array.from(editorView.scrollDOM.querySelectorAll(".cm-line"))) {
      if (isOutlinerManaged(line)||isTableElement(line)) continue;
      try {
        const pos=editorView.posAtDOM(line,0);
        const ln=doc.lineAt(pos).number-1;
        if (seen.has(ln)) continue;
        if (isVacuumLine(doc, ln)) continue;
        if (toggleMarkerLines.has(ln) || isLineHiddenByCollapsedToggle(toggles,ln)) continue;
        const toggle=toggleTitleByLine.get(ln);
        if (toggle) {
          const unitEnd=toggle.open ? toggle.titleLine : toggle.endLine;
          if (seen.has(toggle.startLine)) continue;
          for (let i=toggle.startLine;i<=unitEnd;i++) seen.add(i);
          units.push({el:line,startLine:toggle.startLine,endLine:unitEnd,toggleEndLine:toggle.endLine});
          continue;
        }
        const bounds=resolveBlockBoundary(doc,ln);
        if (isRangeHiddenByCollapsedToggle(toggles,bounds.startLine,bounds.endLine)) continue;
        if (seen.has(bounds.startLine)) continue;
        for (let i=bounds.startLine;i<=bounds.endLine;i++) seen.add(i);
        const el=domLineForNum(editorView,editorView.scrollDOM,bounds.startLine)||line;
        units.push({el,startLine:bounds.startLine,endLine:bounds.endLine});
      } catch(_){}
    }
    units.sort((a,b)=>a.startLine-b.startLine);
    return units;
  }

  // CM6 atomic line-range move. Replaces the v2.9.3 moveEditorLines which
  // worked by stitching the entire document text back together and feeding
  // it to editor.replaceRange — that approach mis-diffed widget decorations
  // at the block boundary on bookmark moves (visual lag, surrounding lines
  // appeared to shift while the widget itself stayed put). Identical
  // technique to Web Bookmark v1.3.4's _moveBlock, generalized for NSB.
  // Returns the line the moved block starts on afterwards, or null when the
  // move did not happen. Callers need that line to re-select (or place the
  // cursor on) the block once it has landed — a move is delete+insert, so
  // nothing of the original selection survives the transaction.
  moveBlockIntoToggleCM(editorView, fromStart, fromEnd, toggle) {
    const doc=editorView.state.doc;
    const total=doc.lines;
    if (!toggle || fromStart<0 || fromEnd>=total || toggle.endLine<0 || toggle.endLine>=total) return null;
    if (toggle.endLine>=fromStart && toggle.endLine<=fromEnd+1) return null;
    const blockTextStart = doc.line(fromStart+1).from;
    const blockTextEnd   = doc.line(fromEnd+1).to;
    const rawBlockText   = doc.sliceString(blockTextStart, blockTextEnd);
    let delFrom, delTo;
    if (fromEnd+1 < total) {
      delFrom = blockTextStart;
      delTo   = doc.line(fromEnd+2).from;
    } else if (fromStart > 0) {
      delFrom = doc.line(fromStart).to;
      delTo   = blockTextEnd;
    } else {
      return null;
    }
    const insertPos = doc.line(toggle.endLine+1).from;
    if (insertPos > delFrom && insertPos < delTo) return null;
    const blockText = renumberOrderedListBlockText(doc, rawBlockText, toggle.endLine);
    const insertText = blockText + "\n";
    const changes = insertPos < delFrom
      ? [
          { from: insertPos, to: insertPos, insert: insertText },
          { from: delFrom,   to: delTo,    insert: "" }
        ]
      : [
          { from: delFrom,   to: delTo,    insert: "" },
          { from: insertPos, to: insertPos, insert: insertText }
        ];
    editorView.dispatch({ changes, userEvent: "input.nsb.move.into-toggle" });
    // Inserted before the deletion (block came from below the TL): the block
    // lands on the close-marker's old line. Otherwise the deletion above has
    // already pulled the close marker up by the block's height.
    const blockSize = fromEnd - fromStart + 1;
    return insertPos < delFrom ? toggle.endLine : toggle.endLine - blockSize;
  }

  // Returns the line the moved block starts on afterwards, or null for a
  // no-op (see moveBlockIntoToggleCM for why callers need it).
  moveBlockCM(editorView, fromStart, fromEnd, to) {
    const doc=editorView.state.doc;
    const total=doc.lines;
    to = this.normalizeCollapsedToggleInsertLine(doc, to);
    if (to>=fromStart && to<=fromEnd+1) return null;           // no-op
    if (fromStart<0 || fromEnd>=total || to<0 || to>total) return null;

    // Block character range (without surrounding newlines)
    const blockTextStart = doc.line(fromStart+1).from;
    const blockTextEnd   = doc.line(fromEnd+1).to;
    let blockText        = doc.sliceString(blockTextStart, blockTextEnd);
    if (getToggleInsertDepth(scanToggleBlocks(doc), to) > 0) {
      blockText = renumberOrderedListBlockText(doc, blockText, to);
    }
    const blockEndsQuote   = isQuoteLineText(doc.line(fromEnd+1).text);
    const prevText = to > 0 ? doc.line(to).text : "";
    const nextText = to < total ? doc.line(to+1).text : "";
    const needsBlankBefore = to > 0 && isQuoteLineText(prevText) && !isBlankLineText(prevText);
    const needsBlankAfter  = to < total && blockEndsQuote && !isBlankLineText(nextText);

    // Deletion range — block + exactly one adjacent newline (so removal does
    // not leave a stray empty line behind).
    let delFrom, delTo;
    if (fromEnd+1 < total) {
      // Has a line after — eat the trailing \n
      delFrom = blockTextStart;
      delTo   = doc.line(fromEnd+2).from;
    } else if (fromStart > 0) {
      // Block is at end of document — eat the leading \n
      delFrom = doc.line(fromStart).to;
      delTo   = blockTextEnd;
    } else {
      // Block is the entire document — nothing to move
      return null;
    }

    // Insertion position + text (with appropriate boundary newline)
    let insertPos, insertText;
    if (to >= total) {
      insertPos  = doc.length;
      insertText = (needsBlankBefore ? "\n\n" : "\n") + blockText;
    } else {
      insertPos  = doc.line(to+1).from;
      insertText = (needsBlankBefore ? "\n" : "") + blockText + (needsBlankAfter ? "\n\n" : "\n");
    }

    // Sanity (should already be caught by the top guard)
    if (insertPos > delFrom && insertPos < delTo) return null;

    // CM6 requires changes sorted ascending by `from`, non-overlapping. All
    // positions are in the ORIGINAL document — CM6 maps them internally.
    const changes = insertPos < delFrom
      ? [
          { from: insertPos, to: insertPos, insert: insertText },
          { from: delFrom,   to: delTo,    insert: "" }
        ]
      : [
          { from: delFrom,   to: delTo,    insert: "" },
          { from: insertPos, to: insertPos, insert: insertText }
        ];

    editorView.dispatch({ changes, userEvent: "input.nsb.move" });
    // Where the block ended up: moving down, everything above it shifted up by
    // its own height; moving up, the insert line is untouched by the later
    // deletion. A quote-boundary blank line pushes it one further down.
    const blockSize = fromEnd - fromStart + 1;
    const blankOffset = needsBlankBefore ? 1 : 0;
    if (to >= total) return (total - blockSize) + blankOffset;
    return (to > fromEnd ? to - blockSize : to) + blankOffset;
  }

  getLogicalTargetRange(doc, target) {
    if (!doc || !target || typeof target.startLine !== "number") return null;
    let startLine = target.startLine;
    let endLine = typeof target.endLine === "number" ? target.endLine : target.startLine;
    if (target.kind === "line") {
      const exp = resolveBlockBoundary(doc, startLine);
      startLine = exp.startLine;
      endLine = exp.endLine;
    }
    if (startLine < 0 || endLine < startLine || endLine >= doc.lines) return null;
    return { startLine, endLine };
  }

  insertBlankLineAtBoundaryCM(editorView, insertLine, userEvent) {
    if (!editorView || !editorView.state || !editorView.state.doc) return false;
    const doc = editorView.state.doc;
    const lineNum = Math.max(0, Math.min(insertLine, doc.lines));
    const atDocumentEnd = lineNum >= doc.lines;
    const insertPos = atDocumentEnd ? doc.length : doc.line(lineNum + 1).from;
    const selectionAnchor = atDocumentEnd ? insertPos + 1 : insertPos;
    editorView.dispatch({
      changes: { from: insertPos, to: insertPos, insert: "\n" },
      selection: { anchor: selectionAnchor, head: selectionAnchor },
      userEvent: userEvent || "input.nsb.insert-blank-line"
    });
    editorView.focus();
    return true;
  }

  insertBlankLineAroundTargetCM(editorView, target, dir) {
    if (!editorView || !target) return false;
    const doc = editorView.state.doc;
    const range = this.getLogicalTargetRange(doc, target);
    if (!range) return false;
    const insertLine = dir === "above" ? range.startLine : range.endLine + 1;
    return this.insertBlankLineAtBoundaryCM(editorView, insertLine, "input.nsb.insert-blank-line-" + (dir || "below"));
  }

  normalizeCollapsedToggleInsertLine(doc, insertLine) {
    if (!doc || insertLine == null) return insertLine;
    let line = Math.max(0, Math.min(insertLine, doc.lines));
    const toggles = scanToggleBlocks(doc);
    for (const t of toggles) {
      if (!t.open && line > t.titleLine && line <= t.endLine) line = t.endLine + 1;
    }
    return line;
  }

  insertBlankLineAfterTargetCM(editorView, target) {
    if (!editorView || !target) return false;
    return this.insertBlankLineAroundTargetCM(editorView, target, "below");
  }

  getLocalizedDeleteLabel() {
    const langs = [];
    try {
      if (navigator && Array.isArray(navigator.languages)) langs.push(...navigator.languages);
      if (navigator && navigator.language) langs.push(navigator.language);
    } catch (_) {}
    try {
      if (window && window.moment && typeof window.moment.locale === "function") langs.push(window.moment.locale());
    } catch (_) {}
    return langs.some(lang => /^zh\b|^zh[-_]/i.test(String(lang || ""))) ? "删除" : "Delete";
  }

  showBlockMenu(e, block, view, mode, target) {
    const editor=view.editor, isEdit=mode==="edit";
    const canMakeToggle = isEdit && this.canMakeToggleListFromTarget(editor, target);
    this.closeOpenContextMenus();
    block.classList.add("nsb-selected");
    setTimeout(()=>block.classList.remove("nsb-selected"),1200);
    const menu=new import_obsidian.Menu();
    this.activeContextMenu=menu;
    menu.addItem(i=>i.setTitle("Duplicate").setIcon("copy-plus").setDisabled(!isEdit).onClick(()=>{ if(isEdit) this.duplicate(block,editor,target); }));
    menu.addItem(i=>i.setTitle("Paste").setIcon("clipboard").setDisabled(!isEdit).onClick(()=>{ if(isEdit){this.selectInEditor(block,editor,target);document.execCommand("paste");} }));
    menu.addItem(i=>i.setTitle("Cut").setIcon("scissors").setDisabled(!isEdit).onClick(()=>{ if(isEdit){this.selectInEditor(block,editor,target);document.execCommand("cut");} }));
    menu.addItem(i=>i.setTitle("Delete").setIcon("trash").setDisabled(!isEdit).onClick(()=>{ if(isEdit) this.deleteTargetBlockFromMenu(editor,target); }));
    menu.addSeparator();
    menu.addItem(i=>i.setTitle("Insert line above").setIcon("arrow-up").setDisabled(!isEdit).onClick(()=>{ if(isEdit) this.insertLine(block,editor,"above",target); }));
    menu.addItem(i=>i.setTitle("Insert line below").setIcon("arrow-down").setDisabled(!isEdit).onClick(()=>{ if(isEdit) this.insertLine(block,editor,"below",target); }));
    if (this.settings.tlFeaturesEnabled !== false) {
      menu.addSeparator();
      menu.addItem(i=>i.setTitle("Toggle list").setIcon("list-plus").setDisabled(!canMakeToggle).onClick(()=>{ if(canMakeToggle) this.insertToggleListAfterTarget(editor,target); }));
    }
    // Provider items (Gallery, Section) close the menu, after this plugin's own.
    if (isEdit) for (const provider of this.blockProviders()) provider.addBlockMenu?.(menu, editor, target);

    // Smart positioning: prefer left of icon, fall back to below row, then default.
    // We need the icon's rect. Try to get it from the event target chain.
    const iconEl = e.target && e.target.closest ? e.target.closest(".nsb-handle") : null;
    if (!iconEl) { menu.showAtMouseEvent(e); return; }

    const iconRect = iconEl.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    // Estimated menu dimensions (Obsidian menus are typically ~180×220 px)
    const EST_W = 185, EST_H = 220;
    const MARGIN = 8;

    // Option A: left of icon, vertically aligned to icon top
    const leftX  = iconRect.left - EST_W - MARGIN;
    const topY   = iconRect.top;
    const fitsLeft  = leftX >= MARGIN;
    const fitsAbove = topY + EST_H <= vh - MARGIN;

    if (fitsLeft && fitsAbove) {
      menu.showAtPosition({ x: leftX, y: topY });
      // After render, clamp to actual width in case estimate was off
      requestAnimationFrame(() => {
        const dom = document.querySelector(".menu");
        if (!dom) return;
        const actual = dom.getBoundingClientRect();
        const adjX = iconRect.left - actual.width - MARGIN;
        if (adjX >= MARGIN) dom.style.left = adjX + "px";
      });
      return;
    }

    // Option B: below the current row, left-aligned to icon left
    const belowY = iconRect.bottom + MARGIN;
    const fitsBelow = belowY + EST_H <= vh - MARGIN;
    if (fitsBelow) {
      menu.showAtPosition({ x: Math.max(MARGIN, iconRect.left - EST_W), y: belowY });
      return;
    }

    // Fallback: let Obsidian decide
    menu.showAtMouseEvent(e);
  }

  lineInfo(block,editor,target) {
    if (target && typeof target.startLine === "number" && target.startLine >= 0 && target.startLine < editor.lineCount()) {
      let line = target.startLine;
      if (editor.cm && editor.cm.state && editor.cm.state.doc) {
        const toggle = getToggleHeaderForLine(editor.cm.state.doc, target.startLine);
        if (toggle) {
          // Toggle titles expose only the visible title text, so menu actions
          // (duplicate / cut / paste-over) never clone or clip the hidden
          // inline marker.
          return { line: toggle.titleLine, text: toggleVisibleTitleText(editor.cm.state.doc, toggle) };
        }
      }
      const text = editor.getLine(line) || "";
      return {line,text};
    }
    const raw=(block.textContent||"").trim(); if(!raw) return null;
    const key=raw.substring(0,25);
    for (let i=0;i<editor.lineCount();i++){
      const lt=editor.getLine(i);
      if(lt.includes(key)||lt.replace(/^[#>\-*\d.\s`]+/,"").trim().startsWith(key.substring(0,12)))
        return {line:i,text:lt};
    }
    return null;
  }
  selectInEditor(block,editor,target){const info=this.lineInfo(block,editor,target);if(!info)return;editor.setSelection({line:info.line,ch:0},{line:info.line,ch:info.text.length});}
  duplicate(block,editor,target){
    const info=this.lineInfo(block,editor,target);if(!info)return;
    if (editor.cm && editor.cm.state && editor.cm.state.doc) {
      const toggle = getToggleHeaderForLine(editor.cm.state.doc, info.line);
      if (toggle) {
        // Duplicate the visible title as a plain row after the whole TL so the
        // hidden inline marker is never split or cloned.
        const closeLen = (editor.getLine(toggle.endLine) || "").length;
        editor.replaceRange("\n"+info.text,{line:toggle.endLine,ch:closeLen});
        new import_obsidian.Notice("Duplicated below");
        return;
      }
    }
    editor.replaceRange("\n"+info.text,{line:info.line,ch:(editor.getLine(info.line)||"").length});
    new import_obsidian.Notice("Duplicated below");
  }
  insertLine(block,editor,dir,target){
    if (editor && editor.cm && this.insertBlankLineAroundTargetCM(editor.cm, target, dir)) return;
    const info=this.lineInfo(block,editor,target);if(!info)return;
    if(dir==="above"){editor.replaceRange("\n",{line:info.line,ch:0});editor.setCursor({line:info.line,ch:0});}
    else{editor.replaceRange("\n",{line:info.line,ch:info.text.length});editor.setCursor({line:info.line+1,ch:0});}
    editor.focus();
  }

  // Mobile: tapping an internal link inside a table cell places the cursor
  // into the link text (starts editing) instead of following the link the
  // way a desktop click does. Intercept the tap at capture, resolve the
  // link, and navigate. Taps on non-link cell content keep editing, and an
  // unresolvable link falls through to normal editing (never create a
  // wrongly named note from a mis-parsed alias).
  handleMobileTableLinkTap(editorView, e) {
    if (!this.settings || this.settings.mobileTableLinkNav === false) return false;
    const t = e.target;
    if (!t || !t.closest) return false;
    if (!t.closest(".cm-table-widget, table")) return false;
    let linktext = null;
    const a = t.closest("a.internal-link");
    if (a) linktext = a.getAttribute("data-href") || a.getAttribute("href");
    if (!linktext) {
      const span = t.closest(".cm-hmd-internal-link");
      if (span) linktext = (span.textContent || "").trim();
    }
    if (!linktext) return false;
    linktext = linktext.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0].trim();
    if (!linktext) return false;
    let sourcePath = "";
    try {
      const info = editorView.state.field(import_obsidian.editorInfoField, false);
      sourcePath = (info && info.file && info.file.path) || "";
    } catch (_) {}
    let dest = null;
    try {
      dest = this.app.metadataCache.getFirstLinkpathDest(linktext.split("#")[0], sourcePath);
    } catch (_) {}
    if (!dest) return false;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    this.app.workspace.openLinkText(linktext, sourcePath, false);
    return true;
  }

  // ── Scroll-position memory ──────────────────────────────────────────────
  // Continuously remembers, per file, which line sits at the top of the
  // editor viewport. When a file seen earlier this session is reopened
  // (e.g. following a link, then navigating back), the position is restored
  // AFTER NSB's fold decorations have collapsed the TLs: Obsidian's own
  // ephemeral restore runs before the decorations arrive, so on long notes
  // full of collapsed TLs the shrinking doc height clamped the view to the
  // bottom of the page.
  recordScrollPosition(editorView) {
    if (this.settings && this.settings.restoreScrollOnReopen === false) return;
    try {
      const infoField = import_obsidian.editorInfoField;
      if (!infoField || !this.scrollMemory) return;
      const info = editorView.state.field(infoField, false);
      // Only full markdown views may write the memory: canvas file-cards and
      // embeds of the same file would otherwise clobber the note's position.
      if (!info || !(info instanceof import_obsidian.MarkdownView)) return;
      const file = info.file;
      if (!file || !file.path) return;
      if (this._scrollRestoreSuppress && this._scrollRestoreSuppress.has(file.path)) return;
      const scroller = editorView.scrollDOM;
      // Doc-space height of the scroller's top edge (documentTop = doc top
      // in screen coords). Raw scrollTop is offset by the above-content
      // chrome (inline title, properties), which would anchor to a line a
      // few rows below the true top line and drift when layout changes.
      const topEdge = scroller.getBoundingClientRect().top - editorView.documentTop;
      const block = editorView.lineBlockAtHeight(topEdge);
      this.scrollMemory.set(file.path, {
        line: editorView.state.doc.lineAt(block.from).number - 1,
        offset: topEdge - block.top
      });
    } catch (_) {}
  }

  restoreScrollPositionOnOpen(file) {
    if (!file || !file.path || !this.scrollMemory) return;
    if (this.settings && this.settings.restoreScrollOnReopen === false) return;
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (!view || !view.file || view.file.path !== file.path) return;
    const editorView = view.editor && view.editor.cm;
    if (!editorView) return;
    // file-open also fires on pane/tab focus changes where this view was
    // ALREADY showing the file — restoring there would yank the pane to a
    // position another editor of the same file recorded. Only a real
    // navigation (this view's displayed file changed) restores.
    if (!this._viewLastFile) this._viewLastFile = new WeakMap();
    const prevPath = this._viewLastFile.get(view);
    this._viewLastFile.set(view, file.path);
    if (prevPath === file.path) return;
    const scroller = editorView.scrollDOM;
    const win = (scroller.ownerDocument && scroller.ownerDocument.defaultView) || window;
    const saved = this.scrollMemory.get(file.path);
    if (!saved) {
      // First visit this session: seed the memory once layout settles, so
      // leaving via a link and coming straight back restores even when the
      // user never scrolled here.
      win.setTimeout(() => {
        try {
          if (view.file && view.file.path === file.path) this.recordScrollPosition(editorView);
        } catch (_) {}
      }, 400);
      return;
    }
    this._scrollRestoreSuppress.add(file.path);
    const release = () => this._scrollRestoreSuppress.delete(file.path);
    // Hard release scheduled synchronously: the rAFs below stall while the
    // window is hidden, and suppression must never outlive the restore.
    win.setTimeout(release, 900);
    const startedAt = Date.now();
    let cancelled = false;
    const cancel = () => { cancelled = true; };
    const apply = () => {
      if (cancelled) return;
      // A stalled rAF can fire long after the user moved on (hidden or
      // occluded window) — a stale yank is worse than no restore.
      if (Date.now() - startedAt > 1500) return;
      try {
        if (!view.file || view.file.path !== file.path) return;
        const doc = editorView.state.doc;
        const line = doc.line(Math.min(saved.line, doc.lines - 1) + 1);
        const cur = scroller.getBoundingClientRect().top - editorView.documentTop;
        const want = editorView.lineBlockAt(line.from).top + saved.offset;
        scroller.scrollTop += (want - cur);
      } catch (_) {}
    };
    // First pass after Obsidian's own ephemeral restore and NSB's fold
    // decorations (double rAF on the editor's own window); a late pass
    // catches async height settling. A real user scroll gesture in between
    // cancels the late pass.
    const raf = win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : requestAnimationFrame;
    raf(() => raf(() => {
      apply();
      const winDoc = scroller.ownerDocument || document;
      const opts = { passive: true, once: true };
      scroller.addEventListener("wheel", cancel, opts);
      scroller.addEventListener("touchmove", cancel, opts);
      winDoc.addEventListener("keydown", cancel, opts);
      win.setTimeout(() => {
        apply();
        scroller.removeEventListener("wheel", cancel);
        scroller.removeEventListener("touchmove", cancel);
        winDoc.removeEventListener("keydown", cancel);
        release();
      }, 300);
    }));
  }

  async loadSettings(){this.settings=Object.assign({},DEFAULT_SETTINGS,await this.loadData());}
  async saveSettings(){
    await this.saveData(this.settings);
    setNsbTlFeaturesEnabled(this.settings.tlFeaturesEnabled);
    setNsbBlockFeaturesEnabled(this.settings.blockFeaturesEnabled);
    setNsbCtxMenuFeaturesEnabled(this.settings.contextMenuFeaturesEnabled);
    setNsbListMarkerFeaturesEnabled(this.settings.listMarkerFeaturesEnabled);
    this._applyCSSVars();
    this._applyBlockSpacingStyle();
    this._applyFoldStyle();
    this.refreshToggleDecorations();
    this.refreshBlockFeatures();
  }

  // Live-applies the "Notion blocks" master switch to every open editor.
  // The CM ViewPlugin is not rebuilt on settings changes, so this is done
  // imperatively: OFF destroys each view's handle overlay (listeners + DOM
  // nodes) and releases the reserved left gutter; ON re-creates the overlay
  // and re-runs the gutter check. overlayMap holds the NsbEditorViewPlugin
  // instances (nothing else reads it).
  refreshBlockFeatures() {
    try {
      for (const pv of this.overlayMap.values()) {
        if (!pv || typeof pv.scheduleGutterCheck !== "function") continue;
        if (!NSB_BLOCK_FEATURES_ENABLED) {
          if (pv.overlay) { try { pv.overlay.destroy(); } catch (_) {} }
          pv.overlay = null;
          try { pv.scroller.style.paddingLeft = ""; } catch (_) {}
          pv.appliedGutterPad = 0;
        } else if (!pv.overlay && !pv.mobileViewOnly) {
          try {
            pv.overlay = new EditOverlay(this, pv.view, pv.cmEl);
            pv.scheduleGutterCheck();
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  // Forces every open editor to rebuild NSB decorations (used when the TL
  // feature switch flips so markers show/hide without reopening notes).
  refreshToggleDecorations() {
    try {
      this.app.workspace.iterateAllLeaves(leaf => {
        const view = leaf.view;
        if (!(view instanceof import_obsidian.MarkdownView)) return;
        const cm = view.editor && view.editor.cm;
        if (!cm || !this.setLivePreviewModeEffect) return;
        try {
          cm.dispatch({ effects: this.setLivePreviewModeEffect.of(isLivePreviewEditorView(cm)) });
        } catch (_) {}
      });
    } catch (_) {}
  }
};

var SettingsTab=class extends import_obsidian.PluginSettingTab{
  constructor(app,plugin){super(app,plugin);this.plugin=plugin;}
  display(){
    const{containerEl}=this; containerEl.empty();
    containerEl.createEl("h2",{text:"Editor Enhancer（优化编辑器）"});

    new import_obsidian.Setting(containerEl)
      .setName("启用开发者模式")
      .setDesc("显示全部高级设置。")
      .addToggle(t=>t.setValue(this.plugin.settings.developerMode === true).onChange(async v=>{
        this.plugin.settings.developerMode=v;
        await this.plugin.saveSettings();
        this.display();
      }));

    containerEl.createEl("h3",{text:"功能模块（全部默认开启，可独立开关）"});

    new import_obsidian.Setting(containerEl)
      .setName("Notion 块功能")
      .setDesc("六点拖拽手柄、块菜单、加号插行、多选整体拖拽与块间距排版。关闭后恢复原生块交互，其他模块不受影响。")
      .addToggle(t=>t.setValue(this.plugin.settings.blockFeaturesEnabled !== false).onChange(async v=>{
        this.plugin.settings.blockFeaturesEnabled=v;
        await this.plugin.saveSettings();
      }));

    new import_obsidian.Setting(containerEl)
      .setName("Toggle List 功能")
      .setDesc("Notion 式可折叠列表及相关原生行为修改（heading 折叠接管、保护行等）。关闭后 TL 标记显示为原始文本，重新开启即恢复。")
      .addToggle(t=>t.setValue(this.plugin.settings.tlFeaturesEnabled !== false).onChange(async v=>{
        this.plugin.settings.tlFeaturesEnabled=v;
        await this.plugin.saveSettings();
      }));

    new import_obsidian.Setting(containerEl)
      .setName("列表标记整体化")
      .setDesc("实时预览里，列表行前的圆点 / 数字 / 复选框是一个整体：光标不会停在标记里，Backspace 一次删掉整个标记（嵌套项先退一级），行尾 Delete 一次并入下一项，← 从文字开头直接到上一行末尾。关闭后恢复 Obsidian 原生的逐字符删除。")
      .addToggle(t=>t.setValue(this.plugin.settings.listMarkerFeaturesEnabled !== false).onChange(async v=>{
        this.plugin.settings.listMarkerFeaturesEnabled=v;
        setNsbListMarkerFeaturesEnabled(v);
        await this.plugin.saveSettings();
      }));

    new import_obsidian.Setting(containerEl)
      .setName("右键菜单增强")
      .setDesc("整理右键菜单（本插件的菜单项集中为独立分组、替换原生删除项）以及「右键不选中整行」。关闭后右键菜单完全恢复 Obsidian 原生行为。")
      .addToggle(t=>t.setValue(this.plugin.settings.contextMenuFeaturesEnabled !== false).onChange(async v=>{
        this.plugin.settings.contextMenuFeaturesEnabled=v;
        await this.plugin.saveSettings();
      }));

    new import_obsidian.Setting(containerEl)
      .setName("表格链接跳转（手机端）")
      .setDesc("手机上点按表格中的内部链接直接跳转（与电脑端一致）；点按链接以外的位置仍进入编辑，无法解析的链接回落为编辑。")
      .addToggle(t=>t.setValue(this.plugin.settings.mobileTableLinkNav !== false).onChange(async v=>{this.plugin.settings.mobileTableLinkNav=v;await this.plugin.saveSettings();}));

    new import_obsidian.Setting(containerEl)
      .setName("返回页面时恢复滚动位置")
      .setDesc("重新打开本次会话看过的页面（如点击链接后返回）时，恢复离开时的滚动位置；长页面不再落到底端。")
      .addToggle(t=>t.setValue(this.plugin.settings.restoreScrollOnReopen !== false).onChange(async v=>{this.plugin.settings.restoreScrollOnReopen=v;await this.plugin.saveSettings();}));

    containerEl.createEl("h3",{text:"细项"});

    new import_obsidian.Setting(containerEl)
      .setName("右键不选中整行")
      .setDesc("右键只打开菜单，不先选中整行；已有选区会被保留。需开启「右键菜单增强」。")
      .addToggle(t=>t.setValue(this.plugin.settings.suppressRightClickLineSelection !== false).onChange(async v=>{this.plugin.settings.suppressRightClickLineSelection=v;await this.plugin.saveSettings();}));

    new import_obsidian.Setting(containerEl)
      .setName("启用段落间距")
      .setDesc("在内容块之间添加 Notion 风格的额外间距。需开启「Notion 块功能」。")
      .addToggle(t=>t.setValue(this.plugin.settings.blockSpacingEnabled).onChange(async v=>{
        this.plugin.settings.blockSpacingEnabled=v;
        await this.plugin.saveSettings();
        this.display();
      }));

    if (this.plugin.settings.developerMode !== true) {
      containerEl.createEl("p",{text: "Editor Enhancer | Author: paipa | v" + this.plugin.manifest.version,cls:"setting-item-description"});
      return;
    }

    containerEl.createEl("h3",{text:"拖拽图标"});
    new import_obsidian.Setting(containerEl).setName("图标透明度").setDesc("悬停前的透明度（0.1 – 1.0）。")
      .addSlider(s=>s.setLimits(0.1,1,0.05).setValue(this.plugin.settings.handleOpacity).setDynamicTooltip().onChange(async v=>{this.plugin.settings.handleOpacity=v;await this.plugin.saveSettings();}));
    new import_obsidian.Setting(containerEl).setName("图标距内容距离").setDesc("图标与内容左缘的间距（0 – 40 px）。")
      .addSlider(s=>s.setLimits(0,40,1).setValue(this.plugin.settings.handleOffset).setDynamicTooltip().onChange(async v=>{this.plugin.settings.handleOffset=v;await this.plugin.saveSettings();}));
    new import_obsidian.Setting(containerEl).setName("图标内边距").setDesc("圆点阵列到图标边框的距离（1 – 16 px）。")
      .addSlider(s=>s.setLimits(1,16,0.5).setValue(this.plugin.settings.handleSize).setDynamicTooltip().onChange(async v=>{this.plugin.settings.handleSize=v;await this.plugin.saveSettings();}));
    new import_obsidian.Setting(containerEl).setName("圆点直径").setDesc("1.5 – 8 px。")
      .addSlider(s=>s.setLimits(1.5,8,0.5).setValue(this.plugin.settings.dotSize).setDynamicTooltip().onChange(async v=>{this.plugin.settings.dotSize=v;await this.plugin.saveSettings();}));
    new import_obsidian.Setting(containerEl).setName("圆点间距").setDesc("1 – 6 px。")
      .addSlider(s=>s.setLimits(1,6,0.5).setValue(this.plugin.settings.dotGap).setDynamicTooltip().onChange(async v=>{this.plugin.settings.dotGap=v;await this.plugin.saveSettings();}));
    new import_obsidian.Setting(containerEl).setName("圆点灰度").setDesc("0 = 白，100 = 黑。")
      .addSlider(s=>s.setLimits(0,100,1).setValue(this.plugin.settings.dotGray).setDynamicTooltip().onChange(async v=>{this.plugin.settings.dotGray=v;await this.plugin.saveSettings();}));
    new import_obsidian.Setting(containerEl).setName("Toggle 三角图标大小").setDesc("10 – 28 px。")
      .addSlider(s=>s.setLimits(10,28,1).setValue(this.plugin.settings.toggleIconSize || 16).setDynamicTooltip().onChange(async v=>{this.plugin.settings.toggleIconSize=v;await this.plugin.saveSettings();}));

    containerEl.createEl("h3",{text:"拖拽插入位置横线"});
    new import_obsidian.Setting(containerEl).setName("横线粗细").setDesc("1 – 8 px。")
      .addSlider(s=>s.setLimits(1,8,0.5).setValue(this.plugin.settings.lineHeight).setDynamicTooltip().onChange(async v=>{this.plugin.settings.lineHeight=v;await this.plugin.saveSettings();}));
    new import_obsidian.Setting(containerEl).setName("横线不透明度").setDesc("0.1 – 1.0。")
      .addSlider(s=>s.setLimits(0.1,1,0.05).setValue(this.plugin.settings.lineOpacity).setDynamicTooltip().onChange(async v=>{this.plugin.settings.lineOpacity=v;await this.plugin.saveSettings();}));

    if (this.plugin.settings.blockSpacingEnabled) {
      containerEl.createEl("h3",{text:"Notion 风格行间距"});
      new import_obsidian.Setting(containerEl)
        .setName("Block 间距")
        .setDesc("相邻内容块之间的间距（2 – 32 px）。")
        .addSlider(s=>s.setLimits(2,32,1).setValue(this.plugin.settings.blockSpacingPx).setDynamicTooltip().onChange(async v=>{
          this.plugin.settings.blockSpacingPx=v;
          await this.plugin.saveSettings();
        }));
      new import_obsidian.Setting(containerEl)
        .setName("Block 内行间距")
        .setDesc("同一 block 内多行文字的额外行距（0 = 主题默认，最大 20 px）。")
        .addSlider(s=>s.setLimits(0,20,1).setValue(this.plugin.settings.lineSpacingPx).setDynamicTooltip().onChange(async v=>{
          this.plugin.settings.lineSpacingPx=v;
          await this.plugin.saveSettings();
        }));
    }

    containerEl.createEl("p",{text: "Editor Enhancer | Author: paipa | v" + this.plugin.manifest.version,cls:"setting-item-description"});
  }
};
