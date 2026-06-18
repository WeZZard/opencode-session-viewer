// Conversation Viewer JavaScript
// This file contains all the client-side logic for the conversation detail page

let SESSION_DATA = null;
let currentFilter = "all";
let filterQuery = "";
let showThinkingSteps = false;
let highlightedId = null;
let tokenData = [];
let maxTokens = { input: 1, output: 1, cache: 1 };
let currentMessageIndex = 0;
let urlSearchQuery = ""; // Search query from URL (for highlighting)
let sidebarNavigationLock = null;

// Configure marked for GitHub Flavored Markdown
marked.setOptions({
  breaks: false,
  gfm: true,
});

// Get search query from URL parameters
function getUrlSearchQuery() {
  const params = new URLSearchParams(window.location.search);
  return params.get("q") || "";
}

// Theme — toggleTheme() is provided by base.js; override it here to also
// re-render the sparkline when the colour scheme changes.
function toggleTheme() {
  document.body.classList.toggle("dark");
  localStorage.setItem(
    "theme",
    document.body.classList.contains("dark") ? "dark" : "light",
  );
  renderSparkline();
}

// Sidebar resize functionality
function initSidebarResize() {
  const sidebar = document.getElementById("sidebar");
  const handle = document.getElementById("sidebarResizeHandle");
  let isResizing = false;

  handle.addEventListener("mousedown", (e) => {
    isResizing = true;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isResizing) return;

    const newWidth = e.clientX;
    const minWidth = 280;
    const maxWidth = 800;

    if (newWidth >= minWidth && newWidth <= maxWidth) {
      sidebar.style.width = newWidth + "px";
      localStorage.setItem("sidebarWidth", newWidth);
    }
  });

  document.addEventListener("mouseup", () => {
    if (isResizing) {
      isResizing = false;
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
  });

  // Restore saved width
  const savedWidth = localStorage.getItem("sidebarWidth");
  if (savedWidth) {
    sidebar.style.width = savedWidth + "px";
  }
}

// Viz panel toggle functionality
function setVizWidth(isCollapsed) {
  document.documentElement.style.setProperty(
    "--viz-width",
    isCollapsed ? "44px" : "240px",
  );
}

function toggleVizPanel() {
  const panel = document.getElementById("vizPanel");
  const toggle = document.getElementById("vizPanelToggle");

  panel.classList.toggle("collapsed");
  const isCollapsed = panel.classList.contains("collapsed");

  toggle.title = isCollapsed ? "Expand stats panel" : "Hide stats panel";
  localStorage.setItem("vizPanelCollapsed", isCollapsed);
  setVizWidth(isCollapsed);

  // Re-render sparkline after transition
  setTimeout(renderSparkline, 250);
}

// Restore viz panel state
function initVizPanel() {
  const savedState = localStorage.getItem("vizPanelCollapsed");
  const panel = document.getElementById("vizPanel");
  const toggle = document.getElementById("vizPanelToggle");

  // Default to collapsed, but check localStorage
  if (savedState === "false") {
    panel.classList.remove("collapsed");
    toggle.title = "Hide stats panel";
    setVizWidth(false);
  } else {
    setVizWidth(true);
  }
}

// Format time
function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatFullTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return (
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) +
    " · " +
    d.toLocaleDateString()
  );
}

// Escape HTML
function esc(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function escAttr(text) {
  return esc(text).replace(/"/g, "&quot;");
}

function domId(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "-");
}

function getTranscriptKey(transcript) {
  return transcript?.summary?.id || transcript?.task_part_id || "";
}

function getSubagentOccurrenceSegment(part, transcript, partIndex) {
  const key =
    getTranscriptKey(transcript) ||
    getSubagentSessionId(part) ||
    part?.id ||
    "subagent";
  return `p${partIndex}-${key}`;
}

function getSubagentOccurrencePath(parentIndex, pathSegments = []) {
  return [`msg${parentIndex}`, ...pathSegments].map(domId).join("__");
}

function getSubagentMessageDomId(subagentPath, subagentIndex) {
  return `submsg-${domId(subagentPath)}-${subagentIndex}`;
}

function getActivityDomId(activityPath) {
  return `activity-${domId(activityPath)}`;
}

function getToolOccurrenceSegment(part, partIndex) {
  return `tool${partIndex}-${part?.id || part?.tool || "tool"}`;
}

function getToolActivityPath(part, context = {}) {
  return getSubagentOccurrencePath(context.parentIndex, [
    ...(context.subagentPathSegments || []),
    getToolOccurrenceSegment(part, context.partIndex || 0),
  ]);
}

function getLinkedSubagentPath(part, transcript, context = {}) {
  if (!transcript) return "";
  return getSubagentOccurrencePath(context.parentIndex, [
    ...(context.subagentPathSegments || []),
    getSubagentOccurrenceSegment(part, transcript, context.partIndex || 0),
  ]);
}

function stringifyValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function compactText(text, maxLength = 300) {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > maxLength
    ? normalized.substring(0, maxLength) + "..."
    : normalized;
}

function getSubagentSessionId(part) {
  return (
    part?.state?.metadata?.sessionId || part?.state?.metadata?.session_id || ""
  );
}

function getSubagentTranscriptForPart(
  part,
  subagents = SESSION_DATA?.subagent_transcripts || [],
) {
  const sessionId = getSubagentSessionId(part);
  return (subagents || []).find((transcript) => {
    return (
      (part?.id && transcript.task_part_id === part.id) ||
      (sessionId && transcript.summary?.id === sessionId)
    );
  });
}

function getMessageSubagentTranscriptRefs(
  msg,
  subagents = SESSION_DATA?.subagent_transcripts || [],
) {
  const refs = [];
  (msg.parts || []).forEach((part, partIndex) => {
    const transcript = getSubagentTranscriptForPart(part, subagents);
    if (transcript) refs.push({ part, partIndex, transcript });
  });
  return refs;
}

function getMessageSubagentTranscripts(
  msg,
  subagents = SESSION_DATA?.subagent_transcripts || [],
) {
  const transcripts = [];
  getMessageSubagentTranscriptRefs(msg, subagents).forEach(({ transcript }) => {
    transcripts.push(transcript);
  });
  return transcripts;
}

function messageHasSubagentTranscript(
  msg,
  subagents = SESSION_DATA?.subagent_transcripts || [],
) {
  return getMessageSubagentTranscripts(msg, subagents).length > 0;
}

function getTranscriptText(transcript) {
  let text = [
    transcript.summary?.title || "",
    transcript.summary?.id || "",
    transcript.agent_type || "",
  ].join(" ");

  (transcript.messages || []).forEach((msg) => {
    text +=
      " " + getMessageSearchText(msg, transcript.subagent_transcripts || []);
  });

  return text;
}

function getToolText(part) {
  if (part?.type !== "tool") return "";
  const state = part.state || {};
  return [
    part.tool,
    state.title,
    state.status,
    stringifyValue(state.input),
    stringifyValue(state.output),
    stringifyValue(state.error),
  ]
    .filter(Boolean)
    .join(" ");
}

function getToolPreview(part) {
  const state = part.state || {};
  const output = stringifyValue(state.output);
  const input = stringifyValue(state.input);
  const detail = [state.title, output || input || state.status]
    .filter(Boolean)
    .join(" - ");
  const toolName = part.tool || "tool";
  return compactText(`Tool (${toolName})${detail ? `: ${detail}` : ""}`);
}

// Determine if a message is a "thinking step" (agentic tool-calling loop message)
// vs a final/substantive assistant response.
// A thinking step is an assistant message that either:
//   - has finish == "tool-calls" (stopped to invoke tools), or
//   - has no "text" parts and no finish=="stop" (pure step-start/step-finish/tool sequences)
function isThinkingStep(msg) {
  if (msg.role !== "assistant") return false;
  if (msg.finish === "stop") return false;
  const hasText = (msg.parts || []).some(
    (part) => part.type === "text" && part.text && !part.synthetic,
  );
  if (hasText && msg.finish !== "tool-calls") return false;
  return true;
}

// Get preview
function getPreview(msg) {
  const textPart = msg.parts?.find((p) => p.type === "text");
  if (textPart?.text) {
    // Return first paragraph (split by double newline or newline)
    const text = textPart.text.trim();
    const firstPara = text.split(/\n\s*\n/)[0];
    return compactText(firstPara);
  }
  const taskPart = msg.parts?.find(
    (p) => p.type === "tool" && p.tool === "task",
  );
  if (taskPart) {
    const transcript = getSubagentTranscriptForPart(taskPart);
    const state = taskPart.state || {};
    const input = state.input || {};
    const agent = input.subagent_type || transcript?.agent_type || "subagent";
    const title =
      transcript?.summary?.title || input.description || input.prompt;
    if (title) return `Subagent (${agent}): ${title}`;
  }
  const toolPart = msg.parts?.find((p) => p.type === "tool");
  if (toolPart) return getToolPreview(toolPart);
  return msg.summary?.title || "";
}

function getMessageSearchText(
  msg,
  subagents = SESSION_DATA?.subagent_transcripts || [],
) {
  let text = "";
  (msg.parts || []).forEach((p) => {
    if (p.type === "text" && p.text) {
      text += p.text + " ";
    }
    if (p.type === "tool") {
      text += getToolText(p) + " ";
    }
    if (p.type === "tool" && p.tool === "task") {
      const state = p.state || {};
      const input = state.input || {};
      text += [input.description, input.prompt, state.output]
        .filter(Boolean)
        .join(" ");

      const transcript = getSubagentTranscriptForPart(p, subagents);
      if (transcript) {
        text += " " + getTranscriptText(transcript);
      }
    }
  });
  return text;
}

// Get full text content of a message for filtering
function getFullText(msg) {
  const text = getMessageSearchText(msg);
  return text.toLowerCase();
}

// Highlight filter terms in text
function highlightText(text, query) {
  if (!query) return esc(text);

  // Escape the text first
  const escaped = esc(text);

  // Create a case-insensitive regex for the filter term
  // Escape regex special characters in the query
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escapedQuery})`, "gi");

  return escaped.replace(regex, "<mark>$1</mark>");
}

// Get a snippet around the filter match
function getMatchSnippet(msg, query) {
  if (!query) return null;

  const text = getMessageSearchText(msg).trim();
  if (!text) return null;

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerText.indexOf(lowerQuery);

  if (matchIndex === -1) return null;

  // Get context around the match
  const contextSize = 100;
  const start = Math.max(0, matchIndex - contextSize);
  const end = Math.min(text.length, matchIndex + query.length + contextSize);

  let snippet = text.substring(start, end);
  if (start > 0) snippet = "..." + snippet;
  if (end < text.length) snippet = snippet + "...";

  return snippet;
}

// Extract token data from message
function getMessageTokens(msg) {
  let input = 0,
    output = 0,
    cache = 0;
  (msg.parts || []).forEach((p) => {
    if (p.type === "step-finish" && p.tokens) {
      input += p.tokens.input || 0;
      output += p.tokens.output || 0;
      cache += p.tokens.cache?.read || 0;
    }
  });
  return { input, output, cache };
}

// Build token data array
function buildTokenData() {
  if (!SESSION_DATA) return;
  tokenData = SESSION_DATA.messages.map((m) => getMessageTokens(m));
  maxTokens = {
    input: Math.max(1, ...tokenData.map((t) => t.input)),
    output: Math.max(1, ...tokenData.map((t) => t.output)),
    cache: Math.max(1, ...tokenData.map((t) => t.cache)),
  };
}

// Update visualization for current message
function updateViz(index) {
  if (!SESSION_DATA || tokenData.length === 0) return;

  currentMessageIndex = index;
  const t = tokenData[index] || { input: 0, output: 0, cache: 0 };

  // Update bars
  document.getElementById("inputBar").style.width =
    (t.input / maxTokens.input) * 100 + "%";
  document.getElementById("outputBar").style.width =
    (t.output / maxTokens.output) * 100 + "%";
  document.getElementById("cacheBar").style.width =
    (t.cache / maxTokens.cache) * 100 + "%";

  // Update values
  document.getElementById("inputValue").textContent = t.input.toLocaleString();
  document.getElementById("outputValue").textContent =
    t.output.toLocaleString();
  document.getElementById("cacheValue").textContent = t.cache.toLocaleString();

  // Update progress
  const progress = ((index + 1) / SESSION_DATA.messages.length) * 100;
  document.getElementById("progressBar").style.width = progress + "%";
  document.getElementById("progressLabel").textContent =
    `Message ${index + 1} / ${SESSION_DATA.messages.length}`;

  // Update sparkline marker
  renderSparkline();
}

// Render sparkline
function renderSparkline() {
  if (!SESSION_DATA || tokenData.length === 0) return;

  const svg = document.getElementById("sparkline");
  const width = svg.clientWidth || 200;
  const height = svg.clientHeight || 80;
  const padding = { top: 10, right: 10, bottom: 10, left: 10 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const maxCache = Math.max(1, ...tokenData.map((t) => t.cache));

  // Generate points
  const points = tokenData.map((t, i) => {
    const x = padding.left + (i / (tokenData.length - 1 || 1)) * chartWidth;
    const y = padding.top + chartHeight - (t.cache / maxCache) * chartHeight;
    return { x, y };
  });

  // Create path
  const pathD = points
    .map((p, i) => (i === 0 ? "M" : "L") + p.x + "," + p.y)
    .join(" ");
  const areaD =
    pathD +
    ` L${points[points.length - 1].x},${padding.top + chartHeight} L${padding.left},${padding.top + chartHeight} Z`;

  // Current position
  const currentX =
    padding.left +
    (currentMessageIndex / (tokenData.length - 1 || 1)) * chartWidth;
  const currentY = points[currentMessageIndex]?.y || padding.top + chartHeight;

  svg.innerHTML = `
        <path class="sparkline-area" d="${areaD}"/>
        <path class="sparkline-path" d="${pathD}"/>
        <line class="sparkline-position-line" x1="${currentX}" y1="${padding.top}" x2="${currentX}" y2="${padding.top + chartHeight}"/>
        <circle class="sparkline-marker" cx="${currentX}" cy="${currentY}" r="5"/>
    `;
}

// Scroll to message
function setActiveSidebarMessage(idx) {
  document.querySelectorAll(".message-item").forEach((item) => {
    item.classList.toggle(
      "active",
      !item.dataset.subagentId &&
        !item.dataset.activityPath &&
        Number(item.dataset.index) === idx,
    );
  });
}

function setActiveSidebarSubagent(
  transcriptId,
  subagentIndex,
  parentIndex,
  subagentPath,
) {
  document.querySelectorAll(".message-item").forEach((item) => {
    item.classList.toggle(
      "active",
      item.dataset.subagentId === transcriptId &&
        Number(item.dataset.subagentIndex) === subagentIndex &&
        Number(item.dataset.index) === parentIndex &&
        item.dataset.subagentPath === subagentPath,
    );
  });
}

function setActiveSidebarActivity(activityPath) {
  document.querySelectorAll(".message-item").forEach((item) => {
    item.classList.toggle(
      "active",
      item.dataset.activityPath === activityPath && !item.dataset.subagentId,
    );
  });
}

function clearSidebarNavigationLock() {
  sidebarNavigationLock = null;
}

function clearHighlightedTargets() {
  document
    .querySelectorAll(".highlighted")
    .forEach((el) => el.classList.remove("highlighted"));
}

function scrollToMessage(idx) {
  const el = document.getElementById("msg-" + idx);
  if (el) {
    sidebarNavigationLock = { kind: "message", index: idx };

    clearHighlightedTargets();

    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.add("highlighted");
    highlightedId = idx;

    setActiveSidebarMessage(idx);

    updateViz(idx);

    setTimeout(() => {
      el.classList.remove("highlighted");
    }, 2000);
  }
}

function scrollToSubagentMessage(
  transcriptId,
  subagentIndex,
  parentIndex,
  subagentPath,
) {
  const parentEl = document.getElementById("msg-" + parentIndex);
  const activityEl = document.getElementById(getActivityDomId(subagentPath));
  if (!parentEl && !activityEl) return;

  sidebarNavigationLock = {
    kind: "subagent",
    transcriptId,
    subagentIndex,
    parentIndex,
    subagentPath,
  };

  const childEl = document.getElementById(
    getSubagentMessageDomId(subagentPath, subagentIndex),
  );
  const targetEl = childEl || activityEl || parentEl;

  clearHighlightedTargets();

  targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
  targetEl.classList.add("highlighted");
  highlightedId = parentIndex;

  setActiveSidebarSubagent(
    transcriptId,
    subagentIndex,
    parentIndex,
    subagentPath,
  );

  updateViz(parentIndex);

  setTimeout(() => {
    targetEl.classList.remove("highlighted");
  }, 2000);
}

function scrollToActivity(activityPath) {
  const el = document.getElementById(getActivityDomId(activityPath));
  if (!el) return;

  sidebarNavigationLock = { kind: "activity", activityPath };
  clearHighlightedTargets();

  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.classList.add("highlighted");
  setActiveSidebarActivity(activityPath);

  setTimeout(() => {
    el.classList.remove("highlighted");
  }, 2000);
}

// Detect visible message on scroll
function detectVisibleMessage() {
  if (!SESSION_DATA) return;
  if (sidebarNavigationLock) return;

  const mainContent = document.getElementById("mainContent");
  const scrollTop = mainContent.scrollTop;
  const viewportHeight = mainContent.clientHeight;
  const viewportCenter = scrollTop + viewportHeight / 3;

  let closestIdx = 0;
  let closestDist = Infinity;

  SESSION_DATA.messages.forEach((_, i) => {
    const el = document.getElementById("msg-" + i);
    if (el) {
      const elTop = el.offsetTop;
      const dist = Math.abs(elTop - viewportCenter);
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = i;
      }
    }
  });

  if (closestIdx !== currentMessageIndex) {
    updateViz(closestIdx);
    setActiveSidebarMessage(closestIdx);
  }
}

// Format markdown tables from "machine view" (compact) to "human view" (padded columns)
function formatMarkdownTables(text) {
  const lines = text.split("\n");
  const result = [];
  let i = 0;

  while (i < lines.length) {
    // Detect a table block: a line that starts and ends with | (ignoring whitespace)
    if (/^\s*\|.*\|\s*$/.test(lines[i])) {
      // Collect all consecutive table lines
      const tableLines = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        tableLines.push(lines[i].trim());
        i++;
      }

      // Parse each row into cells
      const rows = tableLines.map((line) => {
        // Strip leading/trailing pipes then split
        const inner = line.replace(/^\||\|$/g, "");
        return inner.split("|").map((cell) => cell.trim());
      });

      // Identify the separator row (all cells match /^:?-+:?$/)
      const sepIdx = rows.findIndex((row) =>
        row.every((cell) => /^:?-+:?$/.test(cell)),
      );

      if (sepIdx === -1 || rows.length < 2) {
        // Not a real table — emit as-is
        tableLines.forEach((l) => result.push(l));
        continue;
      }

      // Determine column count from the widest row
      const colCount = Math.max(...rows.map((r) => r.length));

      // Compute max width per column
      const colWidths = Array(colCount).fill(1);
      rows.forEach((row, ri) => {
        if (ri === sepIdx) return; // Skip separator row for width calc
        row.forEach((cell, ci) => {
          if (ci < colCount) {
            colWidths[ci] = Math.max(colWidths[ci], cell.length);
          }
        });
      });
      // Ensure separator dashes fill the column width
      colWidths.forEach((w, ci) => {
        colWidths[ci] = Math.max(w, 3); // At minimum "---"
      });

      // Rebuild rows
      rows.forEach((row, ri) => {
        const cells = Array(colCount)
          .fill("")
          .map((_, ci) => row[ci] ?? "");

        let formatted;
        if (ri === sepIdx) {
          // Separator row: pipes and dashes only, no spaces.
          // Each data cell is padEnd(w) surrounded by " | ", so each separator
          // segment must be w+2 dashes wide to match the visual column width.
          formatted =
            "|" +
            cells
              .map((cell, ci) => {
                const w = colWidths[ci] + 2;
                if (/^:-+:$/.test(cell))
                  return ":" + "-".repeat(w - 2) + ":" + "|";
                if (/^:-+$/.test(cell)) return ":" + "-".repeat(w - 1) + "|";
                if (/^-+:$/.test(cell)) return "-".repeat(w - 1) + ":" + "|";
                return "-".repeat(w) + "|";
              })
              .join("");
        } else {
          formatted =
            "| " +
            cells.map((cell, ci) => cell.padEnd(colWidths[ci])).join(" | ") +
            " |";
        }
        result.push(formatted);
      });
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join("\n");
}

// Copy markdown to clipboard
function copyMarkdown(idx) {
  const msg = SESSION_DATA.messages[idx];
  if (!msg) return;

  let markdown = "";
  (msg.parts || []).forEach((p) => {
    if (p.type === "text" && p.text) {
      markdown += p.text + "\n\n";
    } else if (p.type === "tool") {
      const st = p.state || {};
      markdown += `> **Tool: ${p.tool}**\n`;
      if (st.title) markdown += `> ${st.title}\n`;
      if (st.input)
        markdown += "```json\n" + JSON.stringify(st.input, null, 2) + "\n```\n";
      if (st.output) {
        markdown += "#### Output\n";
        markdown +=
          "```\n" +
          (typeof st.output === "string"
            ? st.output
            : JSON.stringify(st.output, null, 2)) +
          "\n```\n";
      }
      markdown += "\n";
    }
  });

  navigator.clipboard
    .writeText(formatMarkdownTables(markdown.trim()))
    .then(() => {
      const btn = document.querySelector(`#msg-${idx} .copy-btn`);
      const originalHtml = btn.innerHTML;
      btn.innerHTML = "<span>✅</span> Copied";
      btn.style.borderColor = "var(--accent-green)";
      btn.style.color = "var(--accent-green)";
      setTimeout(() => {
        btn.innerHTML = originalHtml;
        btn.style.borderColor = "";
        btn.style.color = "";
      }, 2000);
    })
    .catch((err) => {
      console.error("Failed to copy: ", err);
    });
}

// Render sidebar list
function renderSidebar() {
  if (!SESSION_DATA) return;

  // Determine which query to use for filtering (typed filter takes precedence over URL search)
  const activeSearch = filterQuery || urlSearchQuery;
  const items = buildSidebarItems(activeSearch);

  const list = document.getElementById("messageList");
  list.innerHTML = items
    .map((item) => {
      let previewHtml;
      if (activeSearch) {
        previewHtml = highlightText(
          getSidebarMatchSnippet(item, activeSearch),
          activeSearch,
        );
      } else {
        previewHtml = esc(item.preview);
      }

      const isSubagent = item.kind === "subagent";
      const isTool = item.kind === "tool";
      const itemClass = [
        "message-item",
        isSubagent ? "activity-entry subagent-entry" : "",
        isTool ? "activity-entry tool-entry" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const clickHandler = isSubagent
        ? "scrollToSubagentMessage(this.dataset.subagentId, Number(this.dataset.subagentIndex), Number(this.dataset.index), this.dataset.subagentPath)"
        : isTool
          ? "scrollToActivity(this.dataset.activityPath)"
          : `scrollToMessage(${item.index})`;
      const dataAttrs = isSubagent
        ? `data-index="${item.parentIndex}" data-subagent-id="${escAttr(item.transcriptId)}" data-subagent-index="${item.subagentIndex}" data-subagent-path="${escAttr(item.subagentPath)}"`
        : isTool
          ? `data-index="${item.parentIndex}" data-activity-path="${escAttr(item.activityPath)}" data-activity-kind="tool"`
          : `data-index="${item.index}"`;

      return `
                <div class="${itemClass}" ${dataAttrs} onclick="${clickHandler}">
                    <div class="message-item-header">
                        <span class="role-badge ${item.role}">${item.role}</span>
                        ${isSubagent ? `<span class="activity-mini-badge subagent">subagent</span>` : ""}
                        ${isTool ? `<span class="activity-mini-badge tool">tool</span>` : ""}
                        <span class="message-time">${formatTime(item.time)}</span>
                    </div>
                    ${isSubagent || isTool ? `<div class="activity-context">${esc(item.context)}</div>` : ""}
                    <div class="message-preview">${previewHtml}</div>
                </div>
            `;
    })
    .join("");
}

// Update the filter clear button and label state
function renderFilterIndicator() {
  const label = document.getElementById("filterLabel");
  const clearBtn = document.getElementById("filterClear");
  const hasFilter = filterQuery || urlSearchQuery;

  clearBtn.disabled = !hasFilter;

  if (urlSearchQuery && !filterQuery) {
    label.textContent = `Filtered by: "${esc(urlSearchQuery)}"`;
    label.style.display = "block";
  } else {
    label.style.display = "none";
  }
}

// Clear all active filters (typed input and URL-driven)
function clearFilter() {
  filterQuery = "";
  document.getElementById("filterBox").value = "";

  if (urlSearchQuery) {
    urlSearchQuery = "";
    const url = new URL(window.location);
    url.searchParams.delete("q");
    window.history.replaceState({}, "", url);
  }

  renderFilterIndicator();
  renderSidebar();
  renderTimeline();
}

function messageMatchesSearch(msg, activeSearch, subagents) {
  if (!activeSearch) return false;
  return getMessageSearchText(msg, subagents)
    .toLowerCase()
    .includes(activeSearch.toLowerCase());
}

function shouldShowMessageInTranscriptList(msg, activeSearch, subagents) {
  const hasSubagent = messageHasSubagentTranscript(msg, subagents);
  const matchesSearch = messageMatchesSearch(msg, activeSearch, subagents);
  if (currentFilter !== "all" && msg.role !== currentFilter) return false;

  if (
    !showThinkingSteps &&
    isThinkingStep(msg) &&
    !hasSubagent &&
    !matchesSearch
  ) {
    return false;
  }

  const preview = getPreview(msg);
  if (/^\[.*?\]$/.test(preview.trim()) && !hasSubagent && !matchesSearch) {
    return false;
  }

  if (activeSearch && !matchesSearch) return false;
  return true;
}

function buildSidebarItems(activeSearch) {
  const items = [];
  const subagents = SESSION_DATA.subagent_transcripts || [];

  SESSION_DATA.messages.forEach((msg, index) => {
    if (shouldShowMessageInTranscriptList(msg, activeSearch, subagents)) {
      items.push({
        kind: "message",
        role: msg.role,
        time: msg.time_created,
        preview: getPreview(msg),
        text: getMessageSearchText(msg, subagents) || getPreview(msg),
        index,
      });
    }

    collectToolSidebarItems(
      msg,
      {
        parentIndex: index,
        subagents,
        subagentPathSegments: [],
        context: `Message ${index + 1}`,
      },
      activeSearch,
      items,
    );

    getMessageSubagentTranscriptRefs(msg, subagents).forEach(
      ({ part, partIndex, transcript }) => {
        collectSubagentSidebarItems(transcript, index, activeSearch, items, [
          getSubagentOccurrenceSegment(part, transcript, partIndex),
        ]);
      },
    );
  });

  return items;
}

function collectToolSidebarItems(msg, context, activeSearch, items) {
  (msg.parts || []).forEach((part, partIndex) => {
    if (part.type !== "tool") return;

    const activityPath = getToolActivityPath(part, {
      ...context,
      partIndex,
    });
    const text = getToolText(part);
    if (
      activeSearch &&
      !text.toLowerCase().includes(activeSearch.toLowerCase())
    ) {
      return;
    }

    items.push({
      kind: "tool",
      role: "tool",
      time: msg.time_created,
      preview: getToolPreview(part),
      text,
      parentIndex: context.parentIndex,
      activityPath,
      context: context.context,
    });
  });
}

function collectSubagentSidebarItems(
  transcript,
  parentIndex,
  activeSearch,
  items,
  pathSegments = [],
) {
  const subagents = transcript.subagent_transcripts || [];
  const transcriptId = transcript.summary?.id || "";
  const subagentPath = getSubagentOccurrencePath(parentIndex, pathSegments);
  const context =
    transcript.summary?.title || transcript.agent_type || "Subagent transcript";

  (transcript.messages || []).forEach((msg, subagentIndex) => {
    if (!shouldShowMessageInTranscriptList(msg, activeSearch, subagents)) {
      return;
    }

    items.push({
      kind: "subagent",
      role: msg.role,
      time: msg.time_created,
      preview: getPreview(msg),
      text: getMessageSearchText(msg, subagents) || getPreview(msg),
      parentIndex,
      transcriptId,
      subagentIndex,
      subagentPath,
      context,
    });

    getMessageSubagentTranscriptRefs(msg, subagents).forEach(
      ({ part, partIndex, transcript: childTranscript }) => {
        collectSubagentSidebarItems(
          childTranscript,
          parentIndex,
          activeSearch,
          items,
          [
            ...pathSegments,
            `msg${subagentIndex}`,
            getSubagentOccurrenceSegment(part, childTranscript, partIndex),
          ],
        );
      },
    );

    collectToolSidebarItems(
      msg,
      {
        parentIndex,
        subagents,
        subagentPathSegments: [...pathSegments, `msg${subagentIndex}`],
        context,
      },
      activeSearch,
      items,
    );
  });
}

function buildActivityItems(activeSearch) {
  const activities = [];
  const subagents = SESSION_DATA.subagent_transcripts || [];

  SESSION_DATA.messages.forEach((msg, parentIndex) => {
    collectToolActivities(
      msg,
      {
        parentIndex,
        subagents,
        subagentPathSegments: [],
        parentActivityPath: "",
      },
      activeSearch,
      activities,
    );

    getMessageSubagentTranscriptRefs(msg, subagents).forEach(
      ({ part, partIndex, transcript }) => {
        collectSubagentActivity(
          transcript,
          {
            parentIndex,
            sourcePartIndex: partIndex,
            sourcePartId: part?.id || "",
            pathSegments: [
              getSubagentOccurrenceSegment(part, transcript, partIndex),
            ],
            parentActivityPath: "",
          },
          activeSearch,
          activities,
        );
      },
    );
  });

  return activities;
}

function collectToolActivities(msg, context, activeSearch, activities) {
  (msg.parts || []).forEach((part, partIndex) => {
    if (part.type !== "tool") return;

    const activityPath = getToolActivityPath(part, {
      ...context,
      partIndex,
    });
    const text = getToolText(part);
    if (
      activeSearch &&
      !text.toLowerCase().includes(activeSearch.toLowerCase())
    ) {
      return;
    }

    const transcript =
      part.tool === "task"
        ? getSubagentTranscriptForPart(part, context.subagents)
        : null;

    activities.push({
      kind: "tool",
      activityPath,
      parentIndex: context.parentIndex,
      parentActivityPath: context.parentActivityPath || "",
      sourcePartIndex: partIndex,
      sourcePartId: part?.id || "",
      linkedSubagentPath: getLinkedSubagentPath(part, transcript, {
        ...context,
        partIndex,
      }),
      part,
    });
  });
}

function collectSubagentActivity(
  transcript,
  context,
  activeSearch,
  activities,
) {
  const activityPath = getSubagentOccurrencePath(
    context.parentIndex,
    context.pathSegments,
  );
  const subagents = transcript.subagent_transcripts || [];
  const transcriptText = getTranscriptText(transcript);
  const hasMatch =
    !activeSearch ||
    transcriptText.toLowerCase().includes(activeSearch.toLowerCase());

  if (hasMatch) {
    activities.push({
      kind: "subagent",
      activityPath,
      transcript,
      parentIndex: context.parentIndex,
      parentActivityPath: context.parentActivityPath || "",
      sourcePartIndex: context.sourcePartIndex,
      sourcePartId: context.sourcePartId || "",
      pathSegments: context.pathSegments,
    });
  }

  (transcript.messages || []).forEach((msg, subagentIndex) => {
    const messagePathSegments = [
      ...context.pathSegments,
      `msg${subagentIndex}`,
    ];

    collectToolActivities(
      msg,
      {
        parentIndex: context.parentIndex,
        subagents,
        subagentPathSegments: messagePathSegments,
        parentActivityPath: activityPath,
      },
      activeSearch,
      activities,
    );

    getMessageSubagentTranscriptRefs(msg, subagents).forEach(
      ({ part, partIndex, transcript: childTranscript }) => {
        collectSubagentActivity(
          childTranscript,
          {
            parentIndex: context.parentIndex,
            sourcePartIndex: partIndex,
            sourcePartId: part?.id || "",
            pathSegments: [
              ...messagePathSegments,
              getSubagentOccurrenceSegment(part, childTranscript, partIndex),
            ],
            parentActivityPath: activityPath,
          },
          activeSearch,
          activities,
        );
      },
    );
  });
}

function renderActivityStream(activeSearch) {
  const activities = buildActivityItems(activeSearch);
  if (activities.length === 0) return "";

  return `
        <section class="activity-stream" id="activityStream">
            <div class="activity-stream-header">
                <div>
                    <div class="activity-stream-title">Activity Stream</div>
                    <div class="activity-stream-subtitle">${activities.length} related ${activities.length === 1 ? "activity" : "activities"}</div>
                </div>
            </div>
            <div class="activity-stream-body">
                ${activities
                  .map((activity) =>
                    activity.kind === "tool"
                      ? renderToolActivity(activity)
                      : renderSubagentActivity(activity),
                  )
                  .join("")}
            </div>
        </section>
    `;
}

function getSidebarMatchSnippet(item, query) {
  const text = item.text || item.preview || "";
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerText.indexOf(lowerQuery);
  if (matchIndex === -1) return item.preview;

  const contextSize = 100;
  const start = Math.max(0, matchIndex - contextSize);
  const end = Math.min(text.length, matchIndex + query.length + contextSize);

  let snippet = text.substring(start, end);
  if (start > 0) snippet = "..." + snippet;
  if (end < text.length) snippet += "...";
  return snippet;
}

function transcriptMatchesQuery(transcript, query) {
  if (!query) return false;
  return getTranscriptText(transcript)
    .toLowerCase()
    .includes(query.toLowerCase());
}

function renderActivityLink(activityPath, label) {
  if (!activityPath) return "";
  return `<button type="button" class="activity-link" onclick="scrollToActivity('${escAttr(activityPath)}')">${esc(label)}</button>`;
}

function renderToolActivityLink(activityPath) {
  return renderActivityLink(activityPath, "tool result");
}

function renderSubagentActivityLink(activityPath) {
  return renderActivityLink(activityPath, "subagent run");
}

function renderToolReference(part, context = {}) {
  const st = part.state || {};
  const transcript =
    part.tool === "task"
      ? getSubagentTranscriptForPart(part, context.subagents)
      : null;
  const activityPath = getToolActivityPath(part, context);
  const linkedSubagentPath = getLinkedSubagentPath(part, transcript, context);
  const summary =
    st.title || getToolPreview(part).replace(/^Tool \([^)]+\):?\s*/, "");
  const status =
    st.status || (st.error ? "error" : st.output ? "completed" : "");

  return `
        <div class="part part-activity-ref tool-ref" data-activity-path="${escAttr(activityPath)}" data-linked-subagent-path="${escAttr(linkedSubagentPath)}">
            <div class="activity-ref-main">
                <span class="activity-ref-kind">tool</span>
                <span class="activity-ref-title">${esc(part.tool || "tool")}</span>
                ${summary ? `<span class="activity-ref-summary">${esc(compactText(summary, 160))}</span>` : ""}
                ${status ? `<span class="activity-ref-status">${esc(status)}</span>` : ""}
            </div>
            <div class="activity-ref-actions">
                ${renderToolActivityLink(activityPath)}
                ${linkedSubagentPath ? renderSubagentActivityLink(linkedSubagentPath) : ""}
            </div>
        </div>
    `;
}

function renderToolSections(part) {
  const st = part.state || {};
  const inputText = st.input ? JSON.stringify(st.input, null, 2) : "";
  const outputText = stringifyValue(st.output);
  const errorText = stringifyValue(st.error);
  const toolName = (part.tool || "").toLowerCase();
  const noHighlightTools = [
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "mcp_read",
    "mcp_write",
    "mcp_edit",
    "mcp_glob",
    "mcp_grep",
  ];
  const skipHighlight = noHighlightTools.some((t) => toolName.includes(t));
  const inputLangClass = skipHighlight ? "" : "language-json";

  return `
        ${
          inputText
            ? `
            <div class="tool-section">
                <div class="tool-section-label">Input</div>
                <pre class="tool-code"><code class="${inputLangClass}">${esc(inputText)}</code></pre>
            </div>
        `
            : ""
        }
        ${
          outputText
            ? `
            <div class="tool-section">
                <div class="tool-section-label">Output</div>
                <pre class="tool-code"><code>${esc(outputText)}</code></pre>
            </div>
        `
            : ""
        }
        ${
          errorText
            ? `
            <div class="tool-section">
                <div class="tool-section-label">Error</div>
                <pre class="tool-code"><code>${esc(errorText)}</code></pre>
            </div>
        `
            : ""
        }
    `;
}

function renderSubagentActivity(activity) {
  const transcript = activity.transcript;
  const messages = transcript.messages || [];
  const activeSearch = filterQuery || urlSearchQuery;
  const title =
    transcript.summary?.title || transcript.summary?.id || "Subagent";
  const agent =
    transcript.agent_type || transcript.summary?.model || "subagent";
  const transcriptId = transcript.summary?.id || "";

  const messagesHtml = messages
    .map((msg, index) =>
      renderSubagentMessage(
        msg,
        transcript,
        index,
        activity.parentIndex,
        activity.pathSegments,
      ),
    )
    .join("");

  return `
        <section class="activity-card subagent-transcript" id="${getActivityDomId(activity.activityPath)}" data-activity-kind="subagent" data-subagent-path="${escAttr(activity.activityPath)}" data-transcript-id="${escAttr(transcriptId)}" data-parent-message-index="${activity.parentIndex}" data-source-part-index="${activity.sourcePartIndex}" data-source-part-id="${escAttr(activity.sourcePartId)}" data-parent-activity-path="${escAttr(activity.parentActivityPath || "")}">
            <div class="activity-card-header">
                <div class="activity-title-row">
                    <span class="activity-kind subagent">subagent</span>
                    <span class="subagent-agent">${esc(agent)}</span>
                    <span class="activity-title">${esc(title)}</span>
                </div>
                <span class="subagent-count">${messages.length} message${messages.length === 1 ? "" : "s"}</span>
            </div>
            <div class="activity-relation">
                <span>spawned by message ${activity.parentIndex + 1}</span>
                <span>part ${activity.sourcePartIndex + 1}</span>
                ${activity.parentActivityPath ? `<span>parent ${esc(activity.parentActivityPath)}</span>` : ""}
            </div>
            <div class="activity-card-body subagent-transcript-body">
                ${messagesHtml || '<div class="subagent-empty">No transcript messages recorded.</div>'}
            </div>
        </section>
    `;
}

function renderToolActivity(activity) {
  const part = activity.part;
  const st = part.state || {};
  const title = st.title || getToolPreview(part);
  const linkedSubagent = activity.linkedSubagentPath
    ? renderSubagentActivityLink(activity.linkedSubagentPath)
    : "";

  return `
        <section class="activity-card tool-activity" id="${getActivityDomId(activity.activityPath)}" data-activity-kind="tool" data-activity-path="${escAttr(activity.activityPath)}" data-parent-message-index="${activity.parentIndex}" data-source-part-index="${activity.sourcePartIndex}" data-source-part-id="${escAttr(activity.sourcePartId)}" data-parent-activity-path="${escAttr(activity.parentActivityPath || "")}" data-linked-subagent-path="${escAttr(activity.linkedSubagentPath || "")}">
            <div class="activity-card-header">
                <div class="activity-title-row">
                    <span class="activity-kind tool">tool</span>
                    <span class="activity-title">${esc(part.tool || "tool")}</span>
                    ${st.status ? `<span class="tool-status">${esc(st.status)}</span>` : ""}
                </div>
                ${linkedSubagent}
            </div>
            <div class="activity-relation">
                <span>result for message ${activity.parentIndex + 1}</span>
                <span>part ${activity.sourcePartIndex + 1}</span>
                ${activity.parentActivityPath ? `<span>inside ${esc(activity.parentActivityPath)}</span>` : ""}
            </div>
            ${title ? `<div class="activity-summary">${esc(compactText(title, 240))}</div>` : ""}
            <div class="activity-card-body tool-body expanded" id="tool-body-${domId(activity.activityPath)}">
                ${renderToolSections(part) || '<div class="subagent-empty">No tool result recorded.</div>'}
            </div>
        </section>
    `;
}

function renderSubagentMessage(
  msg,
  transcript,
  index,
  parentIndex,
  pathSegments,
) {
  const transcriptId = transcript.summary?.id || "";
  const subagentPath = getSubagentOccurrencePath(parentIndex, pathSegments);
  return `
        <div class="subagent-message ${msg.role}" id="${getSubagentMessageDomId(subagentPath, index)}" data-transcript-id="${esc(transcriptId)}" data-subagent-index="${index}" data-parent-index="${parentIndex}" data-subagent-path="${esc(subagentPath)}">
            <div class="subagent-message-header">
                <span class="role-badge ${msg.role}">${msg.role}</span>
                <span class="message-meta">
                    <span>${formatFullTime(msg.time_created)}</span>
                    ${msg.modelID ? `<span>${esc(msg.modelID)}</span>` : ""}
                    ${msg.agent ? `<span>${esc(msg.agent)}</span>` : ""}
                </span>
            </div>
            <div class="subagent-message-body">
                ${
                  (msg.parts || [])
                    .map((p, partIndex) =>
                      renderPart(p, {
                        embedded: true,
                        subagents: transcript.subagent_transcripts || [],
                        parentIndex,
                        partIndex,
                        subagentPathSegments: [...pathSegments, `msg${index}`],
                      }),
                    )
                    .join("") ||
                  '<span style="color:var(--text-tertiary)">(no content)</span>'
                }
            </div>
        </div>
    `;
}

// Render part
function renderPart(part, context = {}) {
  if (part.type === "reasoning" && part.text) {
    const content = DOMPurify.sanitize(marked.parse(part.text));
    return `
            <div class="part part-reasoning">
                <div class="reasoning-label"><span>🧠</span> Thinking Process</div>
                <div class="part-text">${content}</div>
            </div>
        `;
  }

  if (part.type === "text" && part.text) {
    // Skip synthetic text parts (these are tool call echoes that shouldn't be rendered as text)
    if (part.synthetic) {
      return "";
    }
    // Parse markdown and sanitize HTML
    const cleanHtml = DOMPurify.sanitize(marked.parse(part.text));
    return `<div class="part"><div class="part-text">${cleanHtml}</div></div>`;
  }

  if (part.type === "tool") {
    return renderToolReference(part, context);
  }

  if (part.type === "step-start") {
    return `<div class="part part-step">▶ Step started</div>`;
  }

  if (part.type === "step-finish") {
    const t = part.tokens || {};
    return `
            <div class="part part-step">
                ✓ Step finished (${part.reason || ""})
                ${t.input ? `<span class="token-badge">In: ${t.input.toLocaleString()}</span>` : ""}
                ${t.output ? `<span class="token-badge">Out: ${t.output.toLocaleString()}</span>` : ""}
                ${t.cache?.read ? `<span class="token-badge">Cache: ${t.cache.read.toLocaleString()}</span>` : ""}
            </div>
        `;
  }

  return "";
}

// Render timeline
function renderTimeline() {
  if (!SESSION_DATA) return;

  const activeSearch = filterQuery || urlSearchQuery;
  const timeline = document.getElementById("timeline");
  const messagesHtml = SESSION_DATA.messages
    .filter((m) => {
      const subagents = SESSION_DATA.subagent_transcripts || [];
      const hasSubagent = messageHasSubagentTranscript(m, subagents);
      const matchesSearch = messageMatchesSearch(m, activeSearch, subagents);
      if (
        !showThinkingSteps &&
        isThinkingStep(m) &&
        !hasSubagent &&
        !matchesSearch
      ) {
        return false;
      }
      return (
        !/^\[.*?\]$/.test(getPreview(m).trim()) || hasSubagent || matchesSearch
      );
    })
    .map((m, i) => {
      // We need to use the original index to keep links working
      const originalIdx = SESSION_DATA.messages.indexOf(m);
      return `
                <div class="message ${m.role}" id="msg-${originalIdx}">
                    <div class="message-header">
                        <div class="message-header-left">
                            <span class="role-badge ${m.role}">${m.role}</span>
                            <span class="message-meta">
                                <span>${formatFullTime(m.time_created)}</span>
                                ${m.modelID ? `<span>${m.modelID}</span>` : ""}
                                ${m.agent ? `<span>${m.agent}</span>` : ""}
                            </span>
                        </div>
                        <button class="copy-btn" onclick="copyMarkdown(${originalIdx})" title="Copy markdown to clipboard">
                            <span>📋</span> Copy
                        </button>
                    </div>
                    <div class="message-body">
                        ${(m.parts || []).map((p, partIndex) => renderPart(p, { subagents: SESSION_DATA.subagent_transcripts || [], parentIndex: originalIdx, partIndex, subagentPathSegments: [] })).join("") || '<span style="color:var(--text-tertiary)">(no content)</span>'}
                    </div>
                </div>
            `;
    })
    .join("");
  timeline.innerHTML = messagesHtml + renderActivityStream(activeSearch);

  // Apply syntax highlighting to all code blocks
  applySyntaxHighlighting();
}

// Apply syntax highlighting to code blocks
function applySyntaxHighlighting() {
  // Find all code blocks inside pre elements that haven't been highlighted yet
  // Only highlight blocks that have a language class specified (e.g., language-javascript)
  document.querySelectorAll("pre code:not(.hljs)").forEach((block) => {
    // Check if the block has a language class
    const langClass = Array.from(block.classList).find((cls) =>
      cls.startsWith("language-"),
    );

    if (langClass) {
      const lang = langClass.replace("language-", "");
      // Only highlight if we have a valid language (not empty)
      if (lang && hljs.getLanguage(lang)) {
        hljs.highlightElement(block);
      }
    }
  });
}

// Update stats
function updateStats() {
  if (!SESSION_DATA) return;
  const total = SESSION_DATA.messages.length;
  const user = SESSION_DATA.messages.filter((m) => m.role === "user").length;
  const asst = SESSION_DATA.messages.filter(
    (m) => m.role === "assistant",
  ).length;
  const subagents = SESSION_DATA.subagent_transcripts?.length || 0;
  document.getElementById("stats").innerHTML = `
        <span>${total} total</span>
        <span>${user} user</span>
        <span>${asst} assistant</span>
        ${subagents ? `<span>${subagents} subagents</span>` : ""}
    `;
}

// Load data
function loadData(data) {
  SESSION_DATA = data;

  // Initialize URL search query (passed in from dashboard search)
  urlSearchQuery = getUrlSearchQuery();
  if (urlSearchQuery) {
    // Pre-populate the filter box with the incoming query
    document.getElementById("filterBox").value = urlSearchQuery;
  }

  buildTokenData();
  updateStats();
  renderFilterIndicator();
  renderSidebar();
  renderTimeline();
  updateViz(0);

  // Add scroll listener
  const mainContent = document.getElementById("mainContent");
  mainContent.addEventListener("scroll", detectVisibleMessage);
  ["wheel", "touchstart", "pointerdown"].forEach((eventName) => {
    mainContent.addEventListener(eventName, clearSidebarNavigationLock, {
      passive: true,
    });
  });
  document.addEventListener("keydown", (event) => {
    if (
      [
        "ArrowUp",
        "ArrowDown",
        "PageUp",
        "PageDown",
        "Home",
        "End",
        " ",
      ].includes(event.key)
    ) {
      clearSidebarNavigationLock();
    }
  });

  // Navbar hide/show on scroll
  const navbar = document.getElementById("topNavbar");
  const container = document.querySelector(".container");
  let lastScrollTop = 0;
  mainContent.addEventListener("scroll", () => {
    const st = mainContent.scrollTop;
    if (st > lastScrollTop && st > 60) {
      // scrolling down — hide navbar, reclaim space
      navbar.classList.add("navbar-hidden");
      container.classList.add("navbar-hidden");
    } else {
      // scrolling up — show navbar
      navbar.classList.remove("navbar-hidden");
      container.classList.remove("navbar-hidden");
    }
    lastScrollTop = st;
  });

  // If there's a URL search query, scroll to first matching message
  if (urlSearchQuery) {
    const firstMatch = SESSION_DATA.messages.findIndex((m) => {
      const fullText = getFullText(m);
      return fullText.includes(urlSearchQuery.toLowerCase());
    });
    if (firstMatch !== -1) {
      setTimeout(() => scrollToMessage(firstMatch), 100);
    }
  }
}

// Archive functionality
let isArchived = false;

async function checkArchiveStatus() {
  if (!SESSION_DATA) return;
  try {
    const response = await fetch(
      `/api/conversation/${SESSION_DATA.summary.id}/archived`,
    );
    const data = await response.json();
    isArchived = data.archived;
    updateArchiveButton();
  } catch (e) {
    console.error("Failed to check archive status:", e);
  }
}

function updateArchiveButton() {
  const btn = document.getElementById("archiveBtn");
  if (isArchived) {
    btn.textContent = "Archived";
    btn.classList.add("archived");
    btn.title = "Unarchive this conversation";
  } else {
    btn.textContent = "Archive";
    btn.classList.remove("archived");
    btn.title = "Archive this conversation";
  }
}

async function toggleArchive() {
  if (!SESSION_DATA) return;

  const btn = document.getElementById("archiveBtn");
  btn.disabled = true;

  try {
    const action = isArchived ? "unarchive" : "archive";
    const response = await fetch(
      `/api/conversation/${SESSION_DATA.summary.id}/${action}`,
      {
        method: "POST",
      },
    );

    if (response.ok) {
      isArchived = !isArchived;
      updateArchiveButton();

      // If archiving, redirect to dashboard after a short delay
      if (isArchived) {
        btn.textContent = "Redirecting...";
        setTimeout(() => {
          window.location.href = "/";
        }, 500);
      }
    } else {
      console.error("Failed to toggle archive status");
    }
  } catch (e) {
    console.error("Failed to toggle archive:", e);
  } finally {
    btn.disabled = false;
  }
}

// Initialize everything when DOM is ready
function initConversation() {
  // Initialize sidebar resize
  initSidebarResize();

  // Initialize viz panel state
  initVizPanel();

  // Set up filter buttons
  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".filter-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentFilter = btn.dataset.filter;
      renderSidebar();
    });
  });

  // Set up filter input
  document.getElementById("filterBox").addEventListener("input", (e) => {
    filterQuery = e.target.value.toLowerCase();
    renderFilterIndicator();
    renderSidebar();
    renderTimeline();
  });

  // Set up thinking steps toggle
  document
    .getElementById("showThinkingSteps")
    .addEventListener("change", (e) => {
      showThinkingSteps = e.target.checked;
      renderSidebar();
      renderTimeline();
    });

  // Resize handler for sparkline
  window.addEventListener("resize", () => {
    renderSparkline();
  });

  // Load data from script tag
  try {
    const jsonText = document.getElementById("conversation-data").textContent;
    const INITIAL_DATA = JSON.parse(jsonText);
    if (INITIAL_DATA) {
      loadData(INITIAL_DATA);
      // Check archive status after loading
      checkArchiveStatus();
    }
  } catch (e) {
    console.error("Failed to parse conversation data:", e);
  }
}

// Run initialization when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initConversation);
} else {
  initConversation();
}
