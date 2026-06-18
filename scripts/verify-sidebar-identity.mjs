import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const conversationJs = fs.readFileSync(
  path.join(repoRoot, "app/static/js/conversation.js"),
  "utf8",
);
const conversationCss = fs.readFileSync(
  path.join(repoRoot, "app/static/css/conversation.css"),
  "utf8",
);

function assert(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function harnessHtml() {
  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>${conversationCss}</style>
        <style>
          #mainContent { height: 720px; overflow: auto; }
          #messageList { width: 320px; }
          .agent-filter-option { flex: 0 0 auto; min-width: 180px; }
        </style>
        <script>
          window.marked = { setOptions() {}, parse(value) { return String(value || ""); } };
          window.DOMPurify = { sanitize(value) { return String(value || ""); } };
          window.hljs = { getLanguage() { return false; }, highlightElement() {} };
          window.localStorage = window.localStorage || { getItem() {}, setItem() {} };
        </script>
      </head>
      <body>
        <div id="topNavbar"></div>
        <div class="container">
          <aside id="sidebar"><div id="sidebarResizeHandle"></div></aside>
          <div id="messageList"></div>
          <div id="mainContent"><div id="timeline"></div></div>
          <div id="vizPanel"><button id="vizPanelToggle"></button></div>
        </div>
        <div id="stats"></div>
        <button class="filter-btn active" data-filter="all"></button>
        <button class="filter-btn" data-filter="user"></button>
        <button class="filter-btn" data-filter="assistant"></button>
        <input id="filterBox" />
        <input id="showThinkingSteps" type="checkbox" />
        <button id="filterClear"></button>
        <div id="filterLabel"></div>
        <div id="inputBar"></div>
        <div id="outputBar"></div>
        <div id="cacheBar"></div>
        <div id="inputValue"></div>
        <div id="outputValue"></div>
        <div id="cacheValue"></div>
        <div id="progressBar"></div>
        <div id="progressLabel"></div>
        <svg id="sparkline"></svg>
        <button id="archiveBtn"></button>
        <script id="conversation-data" type="application/json">null</script>
      </body>
    </html>`;
}

async function setupPage(browser) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.setContent(harnessHtml(), { waitUntil: "domcontentloaded" });
  await page.addScriptTag({ content: conversationJs });
  return page;
}

async function runSyntheticSession(page, data) {
  return page.evaluate(async (sessionData) => {
    showThinkingSteps = true;
    currentFilter = "all";
    filterQuery = "";
    urlSearchQuery = "";
    loadData(sessionData);
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  }, data);
}

function duplicateIdsFrom(ids) {
  return Array.from(
    new Set(ids.filter((id, index) => ids.indexOf(id) !== index)),
  );
}

function hasAlignedConnector(connector) {
  return (
    connector.sourceMessageExists &&
    connector.spawnPromptExists &&
    connector.firstMessageExists &&
    connector.alignmentStatus === "aligned" &&
    connector.connectorHeight > 0 &&
    connector.alignmentConnectorHeight > 0 &&
    Math.abs(connector.firstMessageTopDelta) < 1
  );
}

async function readIdentityState(page, selector) {
  return page.evaluate((rowSelector) => {
    const ids = Array.from(document.querySelectorAll("[id]")).map(
      (el) => el.id,
    );
    const rows = Array.from(document.querySelectorAll(rowSelector));
    const activeRows = Array.from(
      document.querySelectorAll(".message-item.active"),
    );
    return {
      duplicateIds: Array.from(
        new Set(ids.filter((id, index) => ids.indexOf(id) !== index)),
      ),
      rows: rows.map((el) => ({
        index: el.dataset.index || null,
        agentId: el.dataset.agentId || null,
        messageIndex: el.dataset.messageIndex || null,
        subagentId: el.dataset.subagentId || null,
        subagentIndex: el.dataset.subagentIndex || null,
        subagentPath: el.dataset.subagentPath || null,
        activityPath: el.dataset.activityPath || null,
        active: el.classList.contains("active"),
        text: el.textContent.replace(/\\s+/g, " ").trim(),
      })),
      activeRows: activeRows.map((el) => ({
        index: el.dataset.index || null,
        agentId: el.dataset.agentId || null,
        messageIndex: el.dataset.messageIndex || null,
        subagentId: el.dataset.subagentId || null,
        subagentIndex: el.dataset.subagentIndex || null,
        subagentPath: el.dataset.subagentPath || null,
        activityPath: el.dataset.activityPath || null,
      })),
      selectedAgentId:
        document.querySelector(
          '.agent-filter[data-agent-filter-location="sidebar"] .agent-filter-option.active',
        )?.dataset.agentId || null,
      workspace: {
        openPanelCount: Number(
          document.getElementById("agentWorkspace")?.dataset.openPanelCount ||
            0,
        ),
        mainStreamCount: document.querySelectorAll(".agent-main-stream").length,
        panelRackCount: document.querySelectorAll(".subagent-panel-rack")
          .length,
        subagentPanelCount: document.querySelectorAll(".subagent-panel").length,
        mainTrackIds: Array.from(
          document.querySelectorAll(".agent-main-stream"),
        ).map((track) => track.dataset.agentId || null),
        panelTrackIds: Array.from(
          document.querySelectorAll(".subagent-panel"),
        ).map((track) => track.dataset.agentId || null),
      },
      selectedAgentChips: Array.from(
        document.querySelectorAll(".selected-agent-chip"),
      ).map((chip) => ({
        agentId: chip.dataset.agentId || null,
        active: chip.classList.contains("active"),
        text: chip.textContent.replace(/\s+/g, " ").trim(),
      })),
      agentFilters: Array.from(document.querySelectorAll(".agent-filter")).map(
        (filter) => ({
          location: filter.dataset.agentFilterLocation || null,
          scrollLeft: filter.scrollLeft,
          maxScrollLeft: Math.max(0, filter.scrollWidth - filter.clientWidth),
          options: Array.from(
            filter.querySelectorAll(".agent-filter-option"),
          ).map((option) => ({
            agentId: option.dataset.agentId || null,
            kind: option.dataset.trackKind || null,
            active: option.classList.contains("active"),
            panelOpen: option.dataset.panelOpen === "true",
            ariaPressed: option.getAttribute("aria-pressed"),
            text: option.textContent.replace(/\s+/g, " ").trim(),
          })),
        }),
      ),
      tracks: Array.from(document.querySelectorAll(".agent-track")).map(
        (el) => ({
          agentId: el.dataset.agentId || null,
          kind: el.dataset.trackKind || null,
          panelOpen: el.dataset.panelOpen === "true",
          active: el.classList.contains("active"),
          model:
            el.querySelector(".agent-track-model")?.dataset.trackModel || null,
          messageIds: Array.from(
            el.querySelectorAll(".agent-track-message"),
          ).map((message) => message.id),
        }),
      ),
      connectors: Array.from(document.querySelectorAll(".agent-connector")).map(
        (el) => {
          const sourceMessageId = el.dataset.sourceMessageId || "";
          const spawnPromptId = el.dataset.spawnPromptId || "";
          const firstMessageId = el.dataset.firstMessageId || "";
          const sourceMessage = document.getElementById(sourceMessageId);
          const firstMessage = document.getElementById(firstMessageId);
          const spacer = el
            .closest(".agent-track")
            ?.querySelector(".agent-alignment-spacer");
          const sourceTop = sourceMessage?.getBoundingClientRect().top ?? null;
          const firstTop = firstMessage?.getBoundingClientRect().top ?? null;
          return {
            subagentId: el.dataset.subagentId || null,
            sourceAgentId: el.dataset.sourceAgentId || null,
            sourceMessageId,
            spawnPromptId,
            firstMessageId,
            sourceMessageExists: Boolean(sourceMessage),
            spawnPromptExists: Boolean(document.getElementById(spawnPromptId)),
            firstMessageExists: Boolean(firstMessage),
            sourceTop,
            firstTop,
            firstMessageTopDelta:
              sourceTop !== null && firstTop !== null
                ? firstTop - sourceTop
                : null,
            connectorHeight: el.getBoundingClientRect().height,
            alignmentOffset: Number(spacer?.dataset.alignmentOffsetPx || 0),
            alignmentStatus: spacer?.dataset.alignmentStatus || null,
            alignmentConnectorHeight: Number(
              spacer?.dataset.connectorHeightPx || 0,
            ),
          };
        },
      ),
      activityStreamCount: document.querySelectorAll("#activityStream").length,
      mainContentAgentFilters: document.querySelectorAll(
        '.timeline > .agent-filter, .agent-filter[data-agent-filter-location="main"]',
      ).length,
      timelineSpacers: Array.from(
        document.querySelectorAll(".timeline-spacer"),
      ).map((el) => ({
        minutes: Number(el.dataset.offsetMinutes || 0),
        text: el.textContent.replace(/\s+/g, " ").trim(),
        height: Number.parseFloat(el.style.height || "0"),
        trackKind: el.closest(".agent-track")?.dataset.trackKind || null,
        trackId: el.closest(".agent-track")?.dataset.agentId || null,
      })),
      timelineIdleBreaks: Array.from(
        document.querySelectorAll(".timeline-idle-break"),
      ).map((el) => ({
        minutes: Number(el.dataset.idleMinutes || 0),
        text: el.textContent.replace(/\s+/g, " ").trim(),
        height: Number.parseFloat(el.style.height || "0"),
        trackKind: el.closest(".agent-track")?.dataset.trackKind || null,
        trackId: el.closest(".agent-track")?.dataset.agentId || null,
      })),
      alignmentSpacers: Array.from(
        document.querySelectorAll(".agent-alignment-spacer"),
      ).map((el) => ({
        trackKind: el.closest(".agent-track")?.dataset.trackKind || null,
        trackId: el.closest(".agent-track")?.dataset.agentId || null,
        height: Number.parseFloat(el.style.height || "0"),
        status: el.dataset.alignmentStatus || null,
        connectorHeight: Number(el.dataset.connectorHeightPx || 0),
        parentMessageId: el.dataset.parentMessageId || null,
        firstMessageId: el.dataset.firstMessageId || null,
      })),
      toolBodyIds: Array.from(document.querySelectorAll(".tool-body")).map(
        (el) => el.id,
      ),
      nestedActivityCards: document.querySelectorAll(".message .activity-card")
        .length,
      nestedSubagentCards: document.querySelectorAll(
        ".message .subagent-transcript",
      ).length,
      subagentActivityCards: document.querySelectorAll(
        ".activity-card.subagent-transcript",
      ).length,
      activityCards: Array.from(
        document.querySelectorAll(".activity-card"),
      ).map((el) => ({
        id: el.id,
        kind: el.dataset.activityKind || null,
        path: el.dataset.activityPath || el.dataset.subagentPath || null,
        parentMessageIndex: el.dataset.parentMessageIndex || null,
        sourcePartIndex: el.dataset.sourcePartIndex || null,
        sourcePartId: el.dataset.sourcePartId || null,
        parentActivityPath: el.dataset.parentActivityPath || null,
        linkedSubagentPath: el.dataset.linkedSubagentPath || null,
        text: el.textContent.replace(/\s+/g, " ").trim(),
      })),
      toolActivities: Array.from(
        document.querySelectorAll(".tool-activity"),
      ).map((el) => ({
        id: el.id,
        path: el.dataset.activityPath || null,
        linkedSubagentPath: el.dataset.linkedSubagentPath || null,
        visible:
          window.getComputedStyle(el).display !== "none" &&
          el.getAttribute("aria-hidden") !== "true",
        insideMessageGroup: Boolean(el.closest(".agent-message-group")),
        text: el.textContent.replace(/\s+/g, " ").trim(),
      })),
      toolRefs: Array.from(document.querySelectorAll(".part-activity-ref")).map(
        (el) => ({
          path: el.dataset.activityPath || null,
          linkedSubagentPath: el.dataset.linkedSubagentPath || null,
          hasButton: Boolean(el.querySelector("[data-tool-result-button]")),
          text: el.textContent.replace(/\s+/g, " ").trim(),
        }),
      ),
      reasoningBlocks: Array.from(
        document.querySelectorAll(".part-reasoning"),
      ).map((el) => ({
        tagName: el.tagName,
        open: el.hasAttribute("open"),
        collapsed: el.dataset.reasoningCollapsed || null,
        text: el.textContent.replace(/\s+/g, " ").trim(),
      })),
      claudeCodeBlocks: Array.from(
        document.querySelectorAll(".claude-code-block"),
      ).map((el) => ({
        kind: el.dataset.claudeCodeBlock || null,
        text: el.textContent.replace(/\s+/g, " ").trim(),
      })),
      customClaudeElements: Array.from(
        document.querySelectorAll(
          ".part-text task, .part-text task_result, .part-text path, .part-text content, .part-text shell_metadata",
        ),
      ).map((el) => el.tagName.toLowerCase()),
    };
  }, selector);
}

function baseMessage(
  parts,
  finish = "tool-calls",
  time = "2026-06-18T00:00:00Z",
) {
  return {
    role: "assistant",
    time_created: time,
    finish,
    parts,
  };
}

function taskPart(id, sessionId, prompt) {
  return {
    type: "tool",
    tool: "task",
    id,
    state: {
      input: { subagent_type: "general", prompt },
      metadata: { sessionId },
      output: `${prompt} done`,
    },
  };
}

async function verifyAgentStreamPresentation(browser) {
  const page = await setupPage(browser);
  const claudeText = [
    "Before block.",
    '<task id="abc" state="completed">',
    "<task_result>",
    "Claude task output",
    "</task_result>",
    "</task>",
    "After block.",
  ].join("\n");
  const firstTranscript = {
    task_part_id: "first-task",
    agent_type: "general",
    summary: {
      id: "first-session",
      title: "First model panel",
      model: "claude-sonnet-4",
    },
    messages: [
      {
        role: "assistant",
        modelID: "claude-sonnet-4",
        time_created: "2026-06-18T00:01:00Z",
        finish: "stop",
        parts: [
          { type: "reasoning", text: "Internal chain of action." },
          { type: "text", text: claudeText },
        ],
      },
    ],
    subagent_transcripts: [],
  };
  const secondTranscript = {
    task_part_id: "second-task",
    agent_type: "general",
    summary: {
      id: "second-session",
      title: "Second model panel",
      model: "deepseek-v4-pro",
    },
    messages: [
      {
        role: "assistant",
        modelID: "deepseek-v4-pro",
        time_created: "2026-06-18T00:02:00Z",
        finish: "stop",
        parts: [{ type: "text", text: "second answer" }],
      },
    ],
    subagent_transcripts: [],
  };
  const extraTranscripts = Array.from({ length: 6 }, (_, index) => ({
    task_part_id: `extra-task-${index}`,
    agent_type: "general",
    summary: {
      id: `extra-session-${index}`,
      title: `Extra long titled panel ${index + 1} that must not overlap neighboring panel close controls`,
      model: "k2p7",
    },
    messages: [
      {
        role: "assistant",
        modelID: "k2p7",
        time_created: `2026-06-18T00:${String(index + 3).padStart(2, "0")}:00Z`,
        finish: "stop",
        parts: [{ type: "text", text: `extra answer ${index + 1}` }],
      },
    ],
    subagent_transcripts: [],
  }));

  await runSyntheticSession(page, {
    id: "agent-stream-presentation",
    messages: [
      {
        role: "assistant",
        modelID: "main-model-a",
        time_created: "2026-06-18T00:00:00Z",
        finish: "tool-calls",
        parts: [
          { type: "reasoning", text: "Main stream thinking." },
          taskPart("first-task", "first-session", "first"),
          taskPart("second-task", "second-session", "second"),
          ...extraTranscripts.map((transcript, index) =>
            taskPart(
              `extra-task-${index}`,
              transcript.summary.id,
              `extra ${index + 1}`,
            ),
          ),
        ],
      },
    ],
    subagent_transcripts: [
      firstTranscript,
      secondTranscript,
      ...extraTranscripts,
    ],
  });

  const firstOption = page
    .locator(
      '.agent-filter[data-agent-filter-location="sidebar"] .agent-filter-option[data-track-kind="subagent"]',
    )
    .nth(0);
  const secondOption = page
    .locator(
      '.agent-filter[data-agent-filter-location="sidebar"] .agent-filter-option[data-track-kind="subagent"]',
    )
    .nth(1);
  const firstAgentId = await firstOption.getAttribute("data-agent-id");
  const secondAgentId = await secondOption.getAttribute("data-agent-id");
  await firstOption.click();
  await secondOption.click();
  await page.waitForTimeout(100);

  const openedState = await readIdentityState(page, ".message-item");
  assert(
    openedState.workspace.mainStreamCount === 1 &&
      openedState.workspace.subagentPanelCount === 2 &&
      openedState.workspace.openPanelCount === 2 &&
      openedState.workspace.mainTrackIds[0] === "main" &&
      openedState.workspace.panelTrackIds.includes(firstAgentId) &&
      openedState.workspace.panelTrackIds.includes(secondAgentId),
    "clicking multiple subagents should keep main stream and open multiple right panels",
    openedState,
  );
  assert(
    openedState.tracks.some(
      (track) =>
        track.agentId === firstAgentId && track.model === "claude-sonnet-4",
    ) &&
      openedState.tracks.some(
        (track) =>
          track.agentId === secondAgentId && track.model === "deepseek-v4-pro",
      ),
    "subagent panels should display their fixed model in the stream header",
    openedState,
  );
  assert(
    openedState.reasoningBlocks.length === 2 &&
      openedState.reasoningBlocks.every(
        (block) =>
          block.tagName === "DETAILS" &&
          !block.open &&
          block.collapsed === "true",
      ),
    "reasoning blocks should render as collapsed details by default",
    openedState,
  );
  assert(
    openedState.claudeCodeBlocks.length === 1 &&
      openedState.claudeCodeBlocks[0].kind === "task" &&
      openedState.claudeCodeBlocks[0].text.includes("<task") &&
      openedState.claudeCodeBlocks[0].text.includes("<task_result>") &&
      openedState.customClaudeElements.length === 0,
    "assistant Claude Code block should render as escaped code, not custom HTML elements",
    openedState,
  );

  await page.locator(".part-reasoning summary").first().click();
  await page.waitForTimeout(50);
  const expandedReasoning = await readIdentityState(page, ".message-item");
  assert(
    expandedReasoning.reasoningBlocks.some((block) => block.open),
    "reasoning details should expand when clicked",
    expandedReasoning,
  );

  for (let index = 2; index < 8; index += 1) {
    await page
      .locator(
        '.agent-filter[data-agent-filter-location="sidebar"] .agent-filter-option[data-track-kind="subagent"]',
      )
      .nth(index)
      .click();
    await page.waitForTimeout(50);
  }
  const manyPanelsState = await readIdentityState(page, ".message-item");
  assert(
    manyPanelsState.workspace.subagentPanelCount === 8 &&
      manyPanelsState.workspace.openPanelCount === 8,
    "opening many long-titled subagent panels should keep every panel mounted",
    manyPanelsState,
  );

  await page
    .locator(
      `.subagent-panel[data-agent-id="${firstAgentId}"] .agent-panel-close`,
    )
    .click();
  await page.waitForTimeout(100);
  const afterClose = await readIdentityState(page, ".message-item");
  assert(
    afterClose.workspace.subagentPanelCount === 7 &&
      !afterClose.workspace.panelTrackIds.includes(firstAgentId) &&
      afterClose.workspace.panelTrackIds.includes(secondAgentId) &&
      !afterClose.agentFilters[0].options.find(
        (option) => option.agentId === firstAgentId,
      )?.panelOpen,
    "closing a subagent panel should deselect it without closing other panels",
    afterClose,
  );

  await page.close();
  return { openedState, expandedReasoning, manyPanelsState, afterClose };
}

async function verifyRepeatedTopLevelTranscript(browser) {
  const page = await setupPage(browser);
  const sharedTranscript = {
    task_part_id: "unused-shared-task",
    agent_type: "general",
    summary: { id: "shared-session", title: "Shared transcript" },
    messages: [
      baseMessage(
        [{ type: "text", text: "shared answer" }],
        "stop",
        "2026-06-18T00:01:00Z",
      ),
    ],
    subagent_transcripts: [],
  };

  await runSyntheticSession(page, {
    id: "top-level-repeat",
    messages: [
      baseMessage(
        [taskPart("main-a", "shared-session", "main A")],
        "tool-calls",
        "2026-06-18T00:00:00Z",
      ),
      baseMessage(
        [taskPart("main-b", "shared-session", "main B")],
        "tool-calls",
        "2026-06-18T00:02:00Z",
      ),
    ],
    subagent_transcripts: [sharedTranscript],
  });

  const secondSubagentOption = page
    .locator(
      '.agent-filter[data-agent-filter-location="sidebar"] .agent-filter-option[data-track-kind="subagent"]',
    )
    .nth(1);
  await secondSubagentOption.click();
  const selectedAgentId =
    await secondSubagentOption.getAttribute("data-agent-id");
  await page
    .locator(`.message-item[data-agent-id="${selectedAgentId}"]`)
    .click();
  await page.waitForTimeout(100);
  const state = await readIdentityState(page, ".message-item");
  const subagentTrackIds = state.tracks
    .filter((track) => track.kind === "subagent")
    .map((track) => track.agentId);
  const navSubagentIds = state.agentFilters[0].options
    .filter((option) => option.kind === "subagent")
    .map((option) => option.agentId);
  assert(
    state.duplicateIds.length === 0,
    "top-level repeat created duplicate DOM ids",
    state,
  );
  assert(
    state.nestedActivityCards === 0,
    "top-level activities are nested in messages",
    state,
  );
  assert(
    state.nestedSubagentCards === 0,
    "top-level subagent cards are nested in messages",
    state,
  );
  assert(
    state.subagentActivityCards === 0,
    "top-level subagent transcripts should render as tracks, not activity cards",
    state,
  );
  assert(
    state.agentFilters.length === 1 &&
      navSubagentIds.length === 2 &&
      new Set(navSubagentIds).size === 2,
    "top-level repeat did not expose distinct subagent navigation options",
    state,
  );
  assert(
    state.tracks.length === 2 &&
      state.workspace.mainStreamCount === 1 &&
      state.workspace.subagentPanelCount === 1 &&
      subagentTrackIds.length === 1 &&
      subagentTrackIds[0] === selectedAgentId &&
      state.workspace.panelTrackIds[0] === selectedAgentId,
    "top-level repeat should render the main stream plus only the opened subagent panel",
    state,
  );
  assert(
    state.agentFilters[0].options.length === 3 &&
      state.agentFilters.every(
        (filter) =>
          filter.options.filter((option) => option.active).length === 1,
      ),
    "top-level sidebar agent filter did not expose exactly one selected track",
    state,
  );
  assert(
    state.mainContentAgentFilters === 0,
    "top-level main content should not render an agent selector",
    state,
  );
  assert(
    state.activityStreamCount === 0,
    "top-level tool results should not render in a bottom activity stream",
    state,
  );
  assert(
    state.workspace.openPanelCount === 1 &&
      state.selectedAgentChips.length === 1 &&
      state.selectedAgentChips[0].agentId === selectedAgentId &&
      state.agentFilters[0].options.some(
        (option) =>
          option.agentId === selectedAgentId &&
          option.panelOpen &&
          option.ariaPressed === "true",
      ),
    "top-level opened subagent panel state is not reflected in the sidebar",
    state,
  );
  assert(
    state.connectors.length === 1 &&
      state.connectors.every(hasAlignedConnector),
    "top-level opened panel connector does not align first message to parent message",
    state,
  );
  assert(
    state.rows.length === 1 &&
      state.rows[0].agentId === selectedAgentId &&
      state.rows[0].messageIndex === "0",
    "top-level sidebar is not scoped to the selected subagent stream",
    state,
  );
  assert(
    state.activeRows.length === 1 &&
      state.activeRows[0].agentId === selectedAgentId &&
      state.activeRows[0].messageIndex === "0",
    "top-level repeat click did not activate exactly the clicked row",
    state,
  );
  assert(
    state.toolActivities.length === 2 &&
      state.toolActivities.every(
        (activity) =>
          activity.linkedSubagentPath &&
          activity.insideMessageGroup &&
          !activity.visible,
      ),
    "task tool results were not hidden inline cards with subagent links",
    state,
  );
  assert(
    state.toolRefs.length === 2 && state.toolRefs.every((ref) => ref.hasButton),
    "task tool references are missing inline result buttons",
    state,
  );
  assert(
    state.toolActivities.some((activity) =>
      activity.text.includes("main A done"),
    ) &&
      state.toolActivities.some((activity) =>
        activity.text.includes("main B done"),
      ),
    "task tool outputs are missing from inline result cards",
    state,
  );
  assert(
    state.timelineSpacers.length === 0 && state.timelineIdleBreaks.length === 0,
    "top-level tracks should not render timestamp-based timeline spacers",
    state,
  );
  assert(
    state.alignmentSpacers.length === 1 &&
      state.alignmentSpacers.every(
        (spacer) => spacer.status === "aligned" && spacer.connectorHeight > 0,
      ),
    "top-level opened subagent panel did not record connector-aware alignment spacers",
    state,
  );
  await page.close();
  return state;
}

async function verifyRepeatedNestedTranscript(browser) {
  const page = await setupPage(browser);
  const childTranscript = {
    task_part_id: "unused-child-task",
    agent_type: "general",
    summary: { id: "child-session", title: "Repeated child transcript" },
    messages: [
      baseMessage(
        [{ type: "text", text: "child answer" }],
        "stop",
        "2026-06-18T00:03:00Z",
      ),
    ],
    subagent_transcripts: [],
  };
  const parentTranscript = {
    task_part_id: "parent-task",
    agent_type: "general",
    summary: { id: "parent-session", title: "Parent transcript" },
    messages: [
      baseMessage(
        [taskPart("child-a", "child-session", "child A")],
        "tool-calls",
        "2026-06-18T00:01:00Z",
      ),
      baseMessage(
        [taskPart("child-b", "child-session", "child B")],
        "tool-calls",
        "2026-06-18T00:02:00Z",
      ),
    ],
    subagent_transcripts: [childTranscript],
  };

  await runSyntheticSession(page, {
    id: "nested-repeat",
    messages: [
      baseMessage(
        [taskPart("parent-task", "parent-session", "parent")],
        "tool-calls",
        "2026-06-18T00:00:00Z",
      ),
    ],
    subagent_transcripts: [parentTranscript],
  });

  const secondChildOption = page
    .locator(
      '.agent-filter[data-agent-filter-location="sidebar"] .agent-filter-option[data-agent-id*="child-session"]',
    )
    .nth(1);
  await secondChildOption.click();
  const selectedAgentId = await secondChildOption.getAttribute("data-agent-id");
  await page
    .locator(`.message-item[data-agent-id="${selectedAgentId}"]`)
    .click();
  await page.waitForTimeout(100);
  const state = await readIdentityState(page, ".message-item");
  const childTrackIds = state.tracks
    .filter((track) => track.agentId?.includes("child-session"))
    .map((track) => track.agentId);
  const navChildIds = state.agentFilters[0].options
    .filter((option) => option.agentId?.includes("child-session"))
    .map((option) => option.agentId);
  assert(
    state.duplicateIds.length === 0,
    "nested repeat created duplicate DOM ids",
    state,
  );
  assert(
    state.nestedActivityCards === 0,
    "nested activities are rendered inside messages",
    state,
  );
  assert(
    state.nestedSubagentCards === 0,
    "nested subagent cards are rendered inside messages",
    state,
  );
  assert(
    state.subagentActivityCards === 0,
    "nested subagent transcripts should render as tracks, not activity cards",
    state,
  );
  assert(
    navChildIds.length === 2 && new Set(navChildIds).size === 2,
    "nested repeat did not expose distinct child subagent navigation options",
    state,
  );
  assert(
    state.tracks.length === 3 &&
      state.workspace.mainStreamCount === 1 &&
      state.workspace.subagentPanelCount === 2 &&
      state.workspace.openPanelCount === 2 &&
      childTrackIds.length === 1 &&
      childTrackIds[0] === selectedAgentId,
    "nested repeat should render main plus the selected child panel and its parent panel",
    state,
  );
  assert(
    state.connectors.length === 2 &&
      state.connectors.every(hasAlignedConnector),
    "nested connectors do not align first messages to parent messages",
    state,
  );
  assert(
    state.mainContentAgentFilters === 0,
    "nested main content should not render an agent selector",
    state,
  );
  assert(
    state.agentFilters.length === 1 &&
      state.agentFilters[0].options.length === 4 &&
      state.agentFilters[0].options.filter((option) => option.active).length ===
        1,
    "nested sidebar agent filter did not expose exactly one selected track",
    state,
  );
  assert(
    state.selectedAgentChips.length === 2 &&
      state.selectedAgentChips.some((chip) => chip.agentId === selectedAgentId),
    "nested selected child should open both parent and child sidebar chips",
    state,
  );
  assert(
    state.activityStreamCount === 0,
    "nested tool results should not render in a bottom activity stream",
    state,
  );
  assert(
    state.rows.length === 1 &&
      state.rows[0].agentId === selectedAgentId &&
      state.rows[0].messageIndex === "0",
    "nested sidebar is not scoped to the selected child subagent stream",
    state,
  );
  assert(
    state.activeRows.length === 1 &&
      state.activeRows[0].agentId === selectedAgentId &&
      state.activeRows[0].messageIndex === "0",
    "nested repeat click did not activate exactly the clicked row",
    state,
  );
  assert(
    state.toolActivities.some((activity) =>
      activity.text.includes("parent done"),
    ) &&
      state.toolActivities.some((activity) =>
        activity.text.includes("child A done"),
      ) &&
      state.toolActivities.some((activity) =>
        activity.text.includes("child B done"),
      ),
    "nested task tool outputs are missing from inline result cards",
    state,
  );
  assert(
    state.toolActivities.every(
      (activity) => activity.insideMessageGroup && !activity.visible,
    ),
    "nested tool results should be hidden inline cards before expansion",
    state,
  );
  assert(
    state.timelineSpacers.length === 0 && state.timelineIdleBreaks.length === 0,
    "nested tracks should not render timestamp-based timeline spacers",
    state,
  );
  assert(
    state.alignmentSpacers.length === 2 &&
      state.alignmentSpacers.every(
        (spacer) => spacer.status === "aligned" && spacer.connectorHeight > 0,
      ),
    "nested subagent tracks did not record connector-aware alignment spacers",
    state,
  );
  await page.close();
  return state;
}

async function verifyToolBodyIds(browser) {
  const page = await setupPage(browser);
  await runSyntheticSession(page, {
    id: "tool-repeat",
    messages: [
      baseMessage([
        {
          type: "tool",
          tool: "bash",
          state: { title: "first", input: { command: "one" }, output: "one" },
        },
        {
          type: "tool",
          tool: "bash",
          state: { title: "second", input: { command: "two" }, output: "two" },
        },
      ]),
    ],
    subagent_transcripts: [],
  });

  const state = await readIdentityState(page, ".message-item");
  const toolDuplicateIds = duplicateIdsFrom(state.toolBodyIds);
  assert(
    toolDuplicateIds.length === 0,
    "tool output bodies created duplicate ids",
    {
      ...state,
      toolDuplicateIds,
    },
  );
  assert(
    state.toolBodyIds.length === 2,
    "expected both tool output bodies to exist",
    state,
  );
  assert(
    state.nestedActivityCards === 0,
    "tool activities are nested in messages",
    state,
  );
  assert(
    state.toolActivities.length === 2 &&
      state.toolActivities[0].text.includes("one") &&
      state.toolActivities[1].text.includes("two") &&
      state.toolActivities.every(
        (activity) => activity.insideMessageGroup && !activity.visible,
      ),
    "inline tool activities do not include both hidden outputs",
    state,
  );
  assert(
    state.toolRefs.length === 2 &&
      new Set(state.toolRefs.map((ref) => ref.path)).size === 2 &&
      state.toolRefs.every((ref) => ref.hasButton),
    "message tool references do not point at distinct inline result buttons",
    state,
  );
  assert(
    state.activityStreamCount === 0,
    "tool outputs should not render in a bottom activity stream",
    state,
  );
  assert(
    state.rows.filter((row) => row.activityPath).length === 0,
    "tool rows should not appear in the sidebar before inline insertion",
    state,
  );

  await page.locator("[data-tool-result-button]").first().click();
  await page.waitForTimeout(100);
  const expandedFromMessage = await readIdentityState(page, ".message-item");
  const visibleFromMessage = expandedFromMessage.toolActivities.filter(
    (activity) => activity.visible,
  );
  const toolRowsAfterFirstInsert = expandedFromMessage.rows.filter(
    (row) => row.activityPath,
  );
  assert(
    visibleFromMessage.length === 1 &&
      visibleFromMessage[0].text.includes("one") &&
      visibleFromMessage[0].insideMessageGroup,
    "message tool result button did not reveal exactly one inline result",
    expandedFromMessage,
  );
  assert(
    toolRowsAfterFirstInsert.length === 1 &&
      toolRowsAfterFirstInsert[0].activityPath === "msg0__tool0-bash",
    "only the clicked inline tool result should be inserted into the sidebar",
    expandedFromMessage,
  );

  await page.locator("[data-tool-result-button]").nth(1).click();
  await page.waitForTimeout(100);
  const expandedFromSecondMessage = await readIdentityState(
    page,
    ".message-item",
  );
  const toolRowsAfterSecondInsert = expandedFromSecondMessage.rows.filter(
    (row) => row.activityPath,
  );
  assert(
    toolRowsAfterSecondInsert.length === 2 &&
      toolRowsAfterSecondInsert.some(
        (row) => row.activityPath === "msg0__tool1-bash",
      ),
    "second inline tool result should be inserted into the sidebar only after its message button is clicked",
    expandedFromSecondMessage,
  );

  await page
    .locator('.message-item.tool-entry[data-activity-path="msg0__tool1-bash"]')
    .click();
  await page.waitForTimeout(100);
  const expandedFromSidebar = await readIdentityState(page, ".message-item");
  const visibleFromSidebar = expandedFromSidebar.toolActivities.filter(
    (activity) => activity.visible,
  );
  assert(
    visibleFromSidebar.length === 2 &&
      visibleFromSidebar.some((activity) => activity.text.includes("two")) &&
      expandedFromSidebar.activeRows.length === 1 &&
      expandedFromSidebar.activeRows[0].activityPath === "msg0__tool1-bash",
    "sidebar tool row did not reveal and activate the inline result",
    expandedFromSidebar,
  );
  await page.close();
  return expandedFromSidebar;
}

async function verifyConnectorAlignmentAfterExpansion(browser) {
  const page = await setupPage(browser);
  const firstTranscript = {
    task_part_id: "first-task",
    agent_type: "general",
    summary: { id: "first-session", title: "First transcript" },
    messages: [
      baseMessage(
        [{ type: "text", text: "first answer" }],
        "stop",
        "2026-06-18T00:01:00Z",
      ),
    ],
    subagent_transcripts: [],
  };
  const secondTranscript = {
    task_part_id: "second-task",
    agent_type: "general",
    summary: { id: "second-session", title: "Second transcript" },
    messages: [
      baseMessage(
        [{ type: "text", text: "second answer" }],
        "stop",
        "2026-06-18T00:03:00Z",
      ),
    ],
    subagent_transcripts: [],
  };

  await runSyntheticSession(page, {
    id: "connector-realignment",
    messages: [
      baseMessage(
        [taskPart("first-task", "first-session", "first")],
        "tool-calls",
        "2026-06-18T00:00:00Z",
      ),
      baseMessage(
        [taskPart("second-task", "second-session", "second")],
        "tool-calls",
        "2026-06-18T00:02:00Z",
      ),
    ],
    subagent_transcripts: [firstTranscript, secondTranscript],
  });

  const subagentOptions = page.locator(
    '.agent-filter[data-agent-filter-location="sidebar"] .agent-filter-option[data-track-kind="subagent"]',
  );
  await subagentOptions.nth(0).click();
  await subagentOptions.nth(1).click();
  await page.waitForTimeout(100);

  const beforeExpansion = await readIdentityState(page, ".message-item");
  const firstToolButton = page
    .locator('[data-tool-result-button="msg0__tool0-first-task"]')
    .first();
  await firstToolButton.click();
  await page.waitForTimeout(100);
  const afterExpansion = await readIdentityState(page, ".message-item");

  assert(
    beforeExpansion.connectors.length === 2 &&
      beforeExpansion.connectors.every(hasAlignedConnector),
    "connectors should align before inline tool expansion",
    beforeExpansion,
  );
  assert(
    afterExpansion.connectors.length === 2 &&
      afterExpansion.connectors.every(hasAlignedConnector),
    "connectors should realign after inline tool expansion changes card heights",
    afterExpansion,
  );
  assert(
    afterExpansion.timelineSpacers.length === 0 &&
      afterExpansion.timelineIdleBreaks.length === 0,
    "connector realignment should not reintroduce timestamp timeline spacers",
    afterExpansion,
  );
  assert(
    afterExpansion.alignmentSpacers.every(
      (spacer) => spacer.status === "aligned" && spacer.connectorHeight > 0,
    ),
    "alignment spacers should record connector-aware measurements after expansion",
    afterExpansion,
  );

  await page.close();
  return { beforeExpansion, afterExpansion };
}

async function verifyAgentFilterScrollPreserved(browser) {
  const page = await setupPage(browser);
  const transcripts = Array.from({ length: 18 }, (_, index) => ({
    task_part_id: `task-${index}`,
    agent_type: "general",
    summary: {
      id: `session-${index}`,
      title: `Long selector transcript ${index + 1}`,
    },
    messages: [
      baseMessage(
        [{ type: "text", text: `answer ${index + 1}` }],
        "stop",
        `2026-06-18T00:${String(index + 1).padStart(2, "0")}:00Z`,
      ),
    ],
    subagent_transcripts: [],
  }));

  await runSyntheticSession(page, {
    id: "wide-agent-filter",
    messages: [
      baseMessage(
        transcripts.map((transcript, index) =>
          taskPart(
            `task-${index}`,
            transcript.summary.id,
            `prompt ${index + 1}`,
          ),
        ),
        "tool-calls",
        "2026-06-18T00:00:00Z",
      ),
    ],
    subagent_transcripts: transcripts,
  });

  const filter = page.locator(
    '.agent-filter[data-agent-filter-location="sidebar"]',
  );
  await filter.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  const beforeClick = await filter.evaluate((el) => ({
    scrollLeft: el.scrollLeft,
    maxScrollLeft: Math.max(0, el.scrollWidth - el.clientWidth),
  }));

  const lastSubagentOption = page
    .locator(
      '.agent-filter[data-agent-filter-location="sidebar"] .agent-filter-option[data-track-kind="subagent"]',
    )
    .last();
  const selectedAgentId =
    await lastSubagentOption.getAttribute("data-agent-id");
  await lastSubagentOption.click();
  await page.waitForTimeout(100);

  const state = await readIdentityState(page, ".message-item");
  const sidebarFilter = state.agentFilters.find(
    (agentFilter) => agentFilter.location === "sidebar",
  );

  assert(
    beforeClick.scrollLeft > 0 && beforeClick.maxScrollLeft > 0,
    "agent filter fixture did not create horizontal overflow",
    { beforeClick, state },
  );
  assert(
    sidebarFilter?.scrollLeft >= beforeClick.scrollLeft - 2,
    "selecting a far-right subagent reset the horizontal agent filter scroll",
    { beforeClick, state },
  );
  assert(
    sidebarFilter?.options.some(
      (option) => option.agentId === selectedAgentId && option.active,
    ),
    "far-right subagent option was not selected after click",
    { selectedAgentId, state },
  );

  await page.close();
  return { beforeClick, afterClick: sidebarFilter, selectedAgentId };
}

const browser = await chromium.launch({ headless: true });
try {
  const results = {
    agentStreamPresentation: await verifyAgentStreamPresentation(browser),
    repeatedTopLevelTranscript: await verifyRepeatedTopLevelTranscript(browser),
    repeatedNestedTranscript: await verifyRepeatedNestedTranscript(browser),
    toolBodyIds: await verifyToolBodyIds(browser),
    connectorAlignmentAfterExpansion:
      await verifyConnectorAlignmentAfterExpansion(browser),
    agentFilterScrollPreserved: await verifyAgentFilterScrollPreserved(browser),
  };
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} catch (error) {
  console.error(error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
