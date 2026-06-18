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
let selectedAgentId = "main";
const expandedToolResults = new Set();
let alignmentFrame = null;

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

function getAgentMessageDomId(agentId, messageIndex) {
  return agentId === "main"
    ? `msg-${messageIndex}`
    : getSubagentMessageDomId(agentId, messageIndex);
}

function getActivityDomId(activityPath) {
  return `activity-${domId(activityPath)}`;
}

function getSpawnPromptDomId(subagentPath) {
  return `spawn-prompt-${domId(subagentPath)}`;
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

function getAgentTitle(track) {
  if (!track) return "Agent";
  if (track.id === "main") return "Main agent";
  return (
    track.transcript?.summary?.title ||
    track.transcript?.summary?.id ||
    "Subagent"
  );
}

function getAgentTracks() {
  if (!SESSION_DATA) return [];

  const tracks = [
    {
      id: "main",
      kind: "main",
      title: "Main agent",
      agent: "main",
      messages: SESSION_DATA.messages || [],
      subagents: SESSION_DATA.subagent_transcripts || [],
      parentIndex: null,
      parentAgentId: "",
      sourceMessageIndex: null,
      sourcePartIndex: null,
      sourcePartId: "",
      sourceTime: SESSION_DATA.messages?.[0]?.time_created || "",
      pathSegments: [],
      transcript: null,
      spawnPrompt: "",
    },
  ];
  const seenTranscriptKeys = new Set();
  const topSubagents = SESSION_DATA.subagent_transcripts || [];

  (SESSION_DATA.messages || []).forEach((msg, messageIndex) => {
    getMessageSubagentTranscriptRefs(msg, topSubagents).forEach(
      ({ part, partIndex, transcript }) => {
        collectAgentTrack(tracks, seenTranscriptKeys, transcript, {
          parentIndex: messageIndex,
          parentAgentId: "main",
          sourceMessageIndex: messageIndex,
          sourcePartIndex: partIndex,
          sourcePartId: part?.id || "",
          sourceTime: msg.time_created || "",
          pathSegments: [
            getSubagentOccurrenceSegment(part, transcript, partIndex),
          ],
          parentActivityPath: "",
          spawnPrompt: getTaskPrompt(part),
        });
      },
    );
  });

  topSubagents.forEach((transcript, index) => {
    const key =
      transcript.summary?.id || transcript.task_part_id || `orphan-${index}`;
    if (seenTranscriptKeys.has(key)) return;
    collectAgentTrack(tracks, seenTranscriptKeys, transcript, {
      parentIndex: SESSION_DATA.messages.length + index,
      parentAgentId: "main",
      sourceMessageIndex: null,
      sourcePartIndex: null,
      sourcePartId: transcript.task_part_id || "",
      sourceTime: transcript.messages?.[0]?.time_created || "",
      pathSegments: [`unlinked-${key}`],
      parentActivityPath: "",
      spawnPrompt: "",
      unlinked: true,
    });
  });

  return tracks;
}

function collectAgentTrack(tracks, seenTranscriptKeys, transcript, context) {
  const id = getSubagentOccurrencePath(
    context.parentIndex,
    context.pathSegments,
  );
  const transcriptKey =
    transcript.summary?.id ||
    transcript.task_part_id ||
    id ||
    `track-${tracks.length}`;
  seenTranscriptKeys.add(transcriptKey);

  const track = {
    id,
    kind: "subagent",
    title: transcript.summary?.title || transcript.summary?.id || "Subagent",
    agent: transcript.agent_type || transcript.summary?.model || "subagent",
    messages: transcript.messages || [],
    subagents: transcript.subagent_transcripts || [],
    parentIndex: context.parentIndex,
    parentAgentId: context.parentAgentId,
    parentActivityPath: context.parentActivityPath || "",
    sourceMessageIndex: context.sourceMessageIndex,
    sourcePartIndex: context.sourcePartIndex,
    sourcePartId: context.sourcePartId || "",
    sourceTime: context.sourceTime || "",
    pathSegments: context.pathSegments,
    transcript,
    spawnPrompt: context.spawnPrompt || "",
    unlinked: Boolean(context.unlinked),
  };
  tracks.push(track);

  (transcript.messages || []).forEach((msg, messageIndex) => {
    getMessageSubagentTranscriptRefs(
      msg,
      transcript.subagent_transcripts || [],
    ).forEach(({ part, partIndex, transcript: childTranscript }) => {
      collectAgentTrack(tracks, seenTranscriptKeys, childTranscript, {
        parentIndex: context.parentIndex,
        parentAgentId: id,
        parentActivityPath: id,
        sourceMessageIndex: messageIndex,
        sourcePartIndex: partIndex,
        sourcePartId: part?.id || "",
        sourceTime: msg.time_created || context.sourceTime || "",
        pathSegments: [
          ...context.pathSegments,
          `msg${messageIndex}`,
          getSubagentOccurrenceSegment(part, childTranscript, partIndex),
        ],
        spawnPrompt: getTaskPrompt(part),
      });
    });
  });
}

function getSelectedAgentTrack() {
  const tracks = getAgentTracks();
  return tracks.find((track) => track.id === selectedAgentId) || tracks[0];
}

function ensureSelectedAgentTrack(tracks = getAgentTracks()) {
  if (!tracks.length) return null;
  const selected = tracks.find((track) => track.id === selectedAgentId);
  if (selected) return selected;
  selectedAgentId = "main";
  return tracks.find((track) => track.id === "main") || tracks[0];
}

function getTaskPrompt(part) {
  const input = part?.state?.input || {};
  return input.prompt || input.description || part?.state?.title || "";
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

function setActiveSidebarAgentMessage(agentId, messageIndex) {
  document.querySelectorAll(".message-item").forEach((item) => {
    item.classList.toggle(
      "active",
      !item.dataset.activityPath &&
        item.dataset.agentId === agentId &&
        Number(item.dataset.messageIndex) === messageIndex,
    );
  });
}

// Scroll to message
function setActiveSidebarMessage(idx) {
  setActiveSidebarAgentMessage("main", idx);
}

function setActiveSidebarActivity(activityPath) {
  document.querySelectorAll(".message-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.activityPath === activityPath);
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

function scrollToDomId(targetId, lock = null) {
  const el = document.getElementById(targetId);
  if (!el) return;

  sidebarNavigationLock = lock;
  clearHighlightedTargets();

  el.scrollIntoView({ behavior: "smooth", block: "start", inline: "center" });
  el.classList.add("highlighted");

  setTimeout(() => {
    el.classList.remove("highlighted");
  }, 2000);
}

function scrollToAgentMessage(agentId, messageIndex) {
  const tracks = getAgentTracks();
  const track = tracks.find((candidate) => candidate.id === agentId);
  if (!track) return;

  if (selectedAgentId !== agentId) {
    selectedAgentId = agentId;
    sidebarNavigationLock = null;
    renderSidebar();
    renderTimeline();
    requestAnimationFrame(() => scrollToAgentMessage(agentId, messageIndex));
    return;
  }

  const el = document.getElementById(
    getAgentMessageDomId(agentId, messageIndex),
  );
  if (!el) return;

  scrollToDomId(getAgentMessageDomId(agentId, messageIndex), {
    kind: "agent-message",
    agentId,
    messageIndex,
  });
  highlightedId = track.id === "main" ? messageIndex : track.parentIndex;
  setActiveSidebarAgentMessage(agentId, messageIndex);
  updateViz(track.id === "main" ? messageIndex : track.parentIndex || 0);
}

function scrollToMessage(idx) {
  scrollToAgentMessage("main", idx);
}

function scrollToSubagentMessage(
  transcriptId,
  subagentIndex,
  parentIndex,
  subagentPath,
) {
  scrollToAgentMessage(subagentPath, subagentIndex);
}

function setToolResultExpanded(activityPath, expanded) {
  const card = document.getElementById(getActivityDomId(activityPath));
  if (!card) return null;

  card.classList.toggle("expanded", expanded);
  card.setAttribute("aria-hidden", expanded ? "false" : "true");
  document
    .querySelectorAll(`[data-tool-result-button="${CSS.escape(activityPath)}"]`)
    .forEach((button) => {
      button.setAttribute("aria-expanded", expanded ? "true" : "false");
      button.textContent = expanded ? "hide result" : "tool result";
    });

  if (expanded) {
    expandedToolResults.add(activityPath);
  } else {
    expandedToolResults.delete(activityPath);
  }

  scheduleSubagentAlignment();

  return card;
}

function showToolResult(activityPath, agentId = "", messageIndex = null) {
  if (agentId && selectedAgentId !== agentId) {
    selectedAgentId = agentId;
    sidebarNavigationLock = null;
    renderSidebar();
    renderTimeline();
    requestAnimationFrame(() =>
      showToolResult(activityPath, agentId, messageIndex),
    );
    return;
  }

  const el = setToolResultExpanded(activityPath, true);
  if (!el) return;

  sidebarNavigationLock = { kind: "activity", activityPath };
  clearHighlightedTargets();

  el.scrollIntoView({ behavior: "smooth", block: "start", inline: "center" });
  el.classList.add("highlighted");
  setActiveSidebarActivity(activityPath);

  if (agentId && Number.isFinite(messageIndex)) {
    const track = getAgentTracks().find(
      (candidate) => candidate.id === agentId,
    );
    updateViz(track?.id === "main" ? messageIndex : track?.parentIndex || 0);
  }

  setTimeout(() => {
    el.classList.remove("highlighted");
  }, 2000);
}

function toggleToolResult(activityPath) {
  const el = document.getElementById(getActivityDomId(activityPath));
  if (!el) return;

  if (el.classList.contains("expanded")) {
    setToolResultExpanded(activityPath, false);
    return;
  }

  showToolResult(activityPath);
}

function scrollToActivity(activityPath) {
  showToolResult(activityPath);
}

// Detect visible message on scroll
function detectVisibleMessage() {
  if (!SESSION_DATA) return;
  if (sidebarNavigationLock) return;

  const mainContent = document.getElementById("mainContent");
  const scrollTop = mainContent.scrollTop;
  const viewportHeight = mainContent.clientHeight;
  const viewportCenter = scrollTop + viewportHeight / 3;
  const track = getSelectedAgentTrack();
  if (!track) return;

  let closestIdx = currentMessageIndex;
  let closestDist = Infinity;

  document
    .querySelectorAll(
      `.agent-track[data-agent-id="${CSS.escape(track.id)}"] .agent-track-message`,
    )
    .forEach((el) => {
      const messageIndex = Number(el.dataset.messageIndex);
      const elTop = el.offsetTop;
      const dist = Math.abs(elTop - viewportCenter);
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = messageIndex;
      }
    });

  if (closestDist === Infinity) return;

  setActiveSidebarAgentMessage(track.id, closestIdx);
  if (track.id === "main" && closestIdx !== currentMessageIndex) {
    updateViz(closestIdx);
  } else if (track.id !== "main") {
    const parentIndex = track.parentIndex || 0;
    if (parentIndex !== currentMessageIndex) {
      updateViz(parentIndex);
    }
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
function renderAgentFilter(location) {
  const tracks = getAgentTracks();
  if (!tracks.length) return "";
  ensureSelectedAgentTrack(tracks);

  return `
        <div class="agent-filter" data-agent-filter-location="${escAttr(location)}" role="listbox" aria-label="Agent stream selector">
            ${tracks
              .map((track) => {
                const active = track.id === selectedAgentId;
                const count = track.messages.length;
                return `
                    <button type="button" class="agent-filter-option ${active ? "active" : ""}" role="option" aria-selected="${active ? "true" : "false"}" data-agent-id="${escAttr(track.id)}" data-track-kind="${escAttr(track.kind)}" onclick="selectAgentTrack(this.dataset.agentId)">
                        <span class="agent-filter-kind">${track.kind === "main" ? "main" : "subagent"}</span>
                        <span class="agent-filter-title">${esc(getAgentTitle(track))}</span>
                        <span class="agent-filter-count">${count}</span>
                    </button>
                `;
              })
              .join("")}
        </div>
    `;
}

function selectAgentTrack(agentId) {
  if (!agentId || selectedAgentId === agentId) return;
  selectedAgentId = agentId;
  sidebarNavigationLock = null;
  renderSidebar();
  renderTimeline();

  requestAnimationFrame(() => {
    const track = document.querySelector(
      `.agent-track[data-agent-id="${CSS.escape(agentId)}"]`,
    );
    track?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    });
  });
}

function renderSidebar() {
  if (!SESSION_DATA) return;

  // Determine which query to use for filtering (typed filter takes precedence over URL search)
  const activeSearch = filterQuery || urlSearchQuery;
  const items = buildSidebarItems(activeSearch);

  const list = document.getElementById("messageList");
  list.innerHTML =
    renderAgentFilter("sidebar") +
    items
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

        const isTool = item.kind === "tool";
        const itemClass = [
          "message-item",
          isTool ? "activity-entry tool-entry" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const clickHandler = isTool
          ? "showToolResult(this.dataset.activityPath, this.dataset.agentId, Number(this.dataset.messageIndex))"
          : "scrollToAgentMessage(this.dataset.agentId, Number(this.dataset.messageIndex))";
        const dataAttrs = isTool
          ? `data-agent-id="${escAttr(item.agentId)}" data-message-index="${item.messageIndex}" data-index="${item.parentIndex}" data-activity-path="${escAttr(item.activityPath)}" data-activity-kind="tool"`
          : `data-agent-id="${escAttr(item.agentId)}" data-message-index="${item.index}" data-index="${item.parentIndex}"`;

        return `
                <div class="${itemClass}" ${dataAttrs} onclick="${clickHandler}">
                    <div class="message-item-header">
                        <span class="role-badge ${item.role}">${item.role}</span>
                        ${isTool ? `<span class="activity-mini-badge tool">tool</span>` : ""}
                        <span class="message-time">${formatTime(item.time)}</span>
                    </div>
                    ${isTool ? `<div class="activity-context">${esc(item.context)}</div>` : ""}
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
  const track = ensureSelectedAgentTrack();
  if (!track) return items;
  const subagents = track.subagents || [];
  const agentTitle = getAgentTitle(track);

  track.messages.forEach((msg, index) => {
    const showMessage = shouldShowMessageInTranscriptList(
      msg,
      activeSearch,
      subagents,
    );
    if (showMessage) {
      items.push({
        kind: "message",
        agentId: track.id,
        role: msg.role,
        time: msg.time_created,
        preview: getPreview(msg),
        text: getMessageSearchText(msg, subagents) || getPreview(msg),
        index,
        parentIndex: track.id === "main" ? index : track.parentIndex || 0,
      });

      collectToolSidebarItems(
        msg,
        {
          parentIndex: track.id === "main" ? index : track.parentIndex || 0,
          agentId: track.id,
          messageIndex: index,
          subagents,
          subagentPathSegments:
            track.id === "main" ? [] : [...track.pathSegments, `msg${index}`],
          context: `${agentTitle} · Message ${index + 1}`,
        },
        activeSearch,
        items,
      );
    }
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
      agentId: context.agentId || "main",
      role: "tool",
      time: msg.time_created,
      preview: getToolPreview(part),
      text,
      parentIndex: context.parentIndex,
      messageIndex: context.messageIndex ?? context.parentIndex,
      activityPath,
      context: context.context,
    });
  });
}

function buildMessageToolActivities(msg, context) {
  const activities = [];

  (msg.parts || []).forEach((part, partIndex) => {
    if (part.type !== "tool") return;

    const transcript =
      part.tool === "task"
        ? getSubagentTranscriptForPart(part, context.subagents)
        : null;
    const activityPath = getToolActivityPath(part, {
      ...context,
      partIndex,
    });

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

  return activities;
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

function renderActivityLink(activityPath, label, options = {}) {
  if (!activityPath) return "";
  const action = options.action || "scrollToActivity";
  const expanded = expandedToolResults.has(activityPath);
  const ariaExpanded =
    action === "toggleToolResult"
      ? ` aria-expanded="${expanded ? "true" : "false"}" data-tool-result-button="${escAttr(activityPath)}"`
      : "";
  const buttonLabel =
    action === "toggleToolResult" && expanded ? "hide result" : label;
  return `<button type="button" class="activity-link" onclick="${action}('${escAttr(activityPath)}')"${ariaExpanded}>${esc(buttonLabel)}</button>`;
}

function renderToolActivityLink(activityPath) {
  return renderActivityLink(activityPath, "tool result", {
    action: "toggleToolResult",
  });
}

function renderSubagentActivityLink(activityPath) {
  if (!activityPath) return "";
  return `<button type="button" class="activity-link" onclick="scrollToAgentMessage('${escAttr(activityPath)}', 0)">subagent stream</button>`;
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
  const spawnAttrs = linkedSubagentPath
    ? ` id="${getSpawnPromptDomId(linkedSubagentPath)}" data-spawns-agent-id="${escAttr(linkedSubagentPath)}"`
    : "";

  return `
        <div class="part part-activity-ref tool-ref"${spawnAttrs} data-activity-path="${escAttr(activityPath)}" data-linked-subagent-path="${escAttr(linkedSubagentPath)}">
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

function renderToolActivity(activity) {
  const part = activity.part;
  const st = part.state || {};
  const title = st.title || getToolPreview(part);
  const linkedSubagent = activity.linkedSubagentPath
    ? renderSubagentActivityLink(activity.linkedSubagentPath)
    : "";
  const expanded = expandedToolResults.has(activity.activityPath);

  return `
        <section class="activity-card tool-activity inline-tool-result ${expanded ? "expanded" : ""}" id="${getActivityDomId(activity.activityPath)}" data-activity-kind="tool" data-activity-path="${escAttr(activity.activityPath)}" data-parent-message-index="${activity.parentIndex}" data-source-part-index="${activity.sourcePartIndex}" data-source-part-id="${escAttr(activity.sourcePartId)}" data-parent-activity-path="${escAttr(activity.parentActivityPath || "")}" data-linked-subagent-path="${escAttr(activity.linkedSubagentPath || "")}" aria-hidden="${expanded ? "false" : "true"}">
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

function renderInlineToolResults(activities) {
  if (!activities.length) return "";
  return `
        <div class="inline-tool-results">
            ${activities.map((activity) => renderToolActivity(activity)).join("")}
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

function renderAgentConnector(track) {
  if (track.kind !== "subagent" || track.unlinked) return "";
  if (
    track.sourceMessageIndex === null ||
    track.sourceMessageIndex === undefined
  ) {
    return "";
  }

  const parentAgentId = track.parentAgentId || "main";
  const sourceMessageId = getAgentMessageDomId(
    parentAgentId,
    track.sourceMessageIndex,
  );
  const spawnPromptId = getSpawnPromptDomId(track.id);
  const firstMessageId = track.messages.length
    ? getAgentMessageDomId(track.id, 0)
    : "";
  const prompt = compactText(track.spawnPrompt || "Task prompt", 140);

  return `
        <div class="agent-connector" data-source-agent-id="${escAttr(parentAgentId)}" data-source-message-id="${escAttr(sourceMessageId)}" data-spawn-prompt-id="${escAttr(spawnPromptId)}" data-first-message-id="${escAttr(firstMessageId)}" data-subagent-id="${escAttr(track.id)}">
            <button type="button" class="agent-connector-node" onclick="scrollToAgentMessage('${escAttr(parentAgentId)}', ${track.sourceMessageIndex})">
                <span class="agent-connector-label">parent message</span>
                <span class="agent-connector-value">${track.sourceMessageIndex + 1}</span>
            </button>
            <button type="button" class="agent-connector-node prompt" onclick="scrollToDomId('${escAttr(spawnPromptId)}', { kind: 'spawn-prompt', agentId: '${escAttr(track.id)}' })">
                <span class="agent-connector-label">spawn prompt</span>
                <span class="agent-connector-value">${esc(prompt)}</span>
            </button>
            <button type="button" class="agent-connector-node" onclick="scrollToAgentMessage('${escAttr(track.id)}', 0)">
                <span class="agent-connector-label">first message</span>
                <span class="agent-connector-value">${track.messages.length ? "1" : "none"}</span>
            </button>
        </div>
    `;
}

function renderAlignmentSpacer(track) {
  if (track.kind !== "subagent") return "";

  return `
        <div class="agent-alignment-spacer" data-align-agent-id="${escAttr(track.id)}" data-alignment-offset-px="0" style="height:0px"></div>
    `;
}

function renderAgentMessage(msg, track, messageIndex) {
  const messageId = getAgentMessageDomId(track.id, messageIndex);
  const parentIndex =
    track.id === "main" ? messageIndex : track.parentIndex || 0;
  const subagentPathSegments =
    track.id === "main" ? [] : [...track.pathSegments, `msg${messageIndex}`];
  const toolContext = {
    subagents: track.subagents || [],
    parentIndex,
    partIndex: null,
    subagentPathSegments,
    parentActivityPath: track.id === "main" ? "" : track.id,
  };
  const toolActivities = buildMessageToolActivities(msg, toolContext);
  const copyButton =
    track.id === "main"
      ? `
                        <button class="copy-btn" onclick="copyMarkdown(${messageIndex})" title="Copy markdown to clipboard">
                            <span>📋</span> Copy
                        </button>
        `
      : "";

  return `
                <div class="agent-message-group" data-agent-id="${escAttr(track.id)}" data-message-index="${messageIndex}">
                    <div class="message ${msg.role} agent-track-message" id="${messageId}" data-agent-id="${escAttr(track.id)}" data-message-index="${messageIndex}" data-parent-message-index="${parentIndex}">
                        <div class="message-header">
                            <div class="message-header-left">
                                <span class="role-badge ${msg.role}">${msg.role}</span>
                                <span class="message-meta">
                                    <span>${formatFullTime(msg.time_created)}</span>
                                    ${msg.modelID ? `<span>${esc(msg.modelID)}</span>` : ""}
                                    ${msg.agent ? `<span>${esc(msg.agent)}</span>` : ""}
                                </span>
                            </div>
                            ${copyButton}
                        </div>
                        <div class="message-body">
                            ${
                              (msg.parts || [])
                                .map((p, partIndex) =>
                                  renderPart(p, {
                                    ...toolContext,
                                    agentId: track.id,
                                    messageIndex,
                                    partIndex,
                                  }),
                                )
                                .join("") ||
                              '<span style="color:var(--text-tertiary)">(no content)</span>'
                            }
                        </div>
                    </div>
                    ${renderInlineToolResults(toolActivities)}
                </div>
            `;
}

function renderAgentTrack(track, activeSearch) {
  const subagents = track.subagents || [];
  const visibleMessages = track.messages
    .map((msg, index) => {
      if (!shouldShowMessageInTranscriptList(msg, activeSearch, subagents)) {
        return "";
      }

      return renderAgentMessage(msg, track, index);
    })
    .join("");
  const active = track.id === selectedAgentId;
  const title = getAgentTitle(track);

  return `
        <section class="agent-track ${active ? "active" : ""}" id="agent-track-${domId(track.id)}" data-agent-id="${escAttr(track.id)}" data-track-kind="${escAttr(track.kind)}">
            <div class="agent-track-header">
                <div>
                    <div class="agent-track-kicker">${track.kind === "main" ? "main agent" : track.unlinked ? "unlinked subagent" : "subagent"}</div>
                    <div class="agent-track-title">${esc(title)}</div>
                </div>
                <div class="agent-track-meta">${track.messages.length} message${track.messages.length === 1 ? "" : "s"}</div>
            </div>
            ${renderAgentConnector(track)}
            <div class="agent-track-body">
                ${visibleMessages ? renderAlignmentSpacer(track) + visibleMessages : '<div class="agent-track-empty">No messages match the current filters.</div>'}
            </div>
        </section>
    `;
}

function alignSubagentTracks() {
  const spacers = Array.from(
    document.querySelectorAll(".agent-alignment-spacer"),
  );
  spacers.forEach((spacer) => {
    spacer.style.height = "0px";
    spacer.style.marginTop = "0px";
    spacer.dataset.alignmentOffsetPx = "0";
    spacer.dataset.alignmentStatus = "pending";
    spacer.classList.remove("unlinked");
  });

  // Force layout after resetting heights so nested tracks measure parent
  // messages after their parent track has been aligned in DOM order.
  void document.body.offsetHeight;

  document
    .querySelectorAll('.agent-track[data-track-kind="subagent"]')
    .forEach((track) => {
      const spacer = track.querySelector(
        ":scope > .agent-track-body > .agent-alignment-spacer",
      );
      if (!spacer) return;

      const connector = track.querySelector(":scope > .agent-connector");
      const parentMessageId = connector?.dataset.sourceMessageId || "";
      const firstMessageId = connector?.dataset.firstMessageId || "";
      const parentMessage = document.getElementById(parentMessageId);
      const firstMessage = document.getElementById(firstMessageId);

      if (!connector || !parentMessage || !firstMessage) {
        spacer.dataset.alignmentStatus = "unlinked";
        spacer.classList.add("unlinked");
        return;
      }

      const parentTop = parentMessage.getBoundingClientRect().top;
      const firstTop = firstMessage.getBoundingClientRect().top;
      const offsetPx = parentTop - firstTop;
      const connectorHeight = connector.getBoundingClientRect().height;

      if (offsetPx >= 0) {
        spacer.style.height = `${offsetPx.toFixed(1)}px`;
        spacer.style.marginTop = "0px";
      } else {
        spacer.style.height = "0px";
        spacer.style.marginTop = `${offsetPx.toFixed(1)}px`;
      }
      spacer.dataset.alignmentOffsetPx = offsetPx.toFixed(1);
      spacer.dataset.alignmentStatus = "aligned";
      spacer.dataset.connectorHeightPx = connectorHeight.toFixed(1);
      spacer.dataset.parentMessageId = parentMessageId;
      spacer.dataset.firstMessageId = firstMessageId;
    });
}

function scheduleSubagentAlignment() {
  if (alignmentFrame !== null) {
    cancelAnimationFrame(alignmentFrame);
  }

  alignmentFrame = requestAnimationFrame(() => {
    alignmentFrame = null;
    alignSubagentTracks();
  });
}

// Render timeline
function renderTimeline() {
  if (!SESSION_DATA) return;

  const activeSearch = filterQuery || urlSearchQuery;
  const timeline = document.getElementById("timeline");
  const tracks = getAgentTracks();
  ensureSelectedAgentTrack(tracks);
  const tracksHtml = tracks
    .map((track) => renderAgentTrack(track, activeSearch))
    .join("");

  timeline.innerHTML = `
        <div class="agent-track-lanes" id="agentTrackLanes">
            ${tracksHtml}
        </div>
    `;

  // Apply syntax highlighting to all code blocks
  applySyntaxHighlighting();
  scheduleSubagentAlignment();
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
  const subagents = getAgentTracks().filter(
    (track) => track.kind === "subagent",
  ).length;
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
    scheduleSubagentAlignment();
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
