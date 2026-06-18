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
        <style>
          #mainContent { height: 720px; overflow: auto; }
          .message-item.active { outline: 2px solid red; }
          .tool-body { display: none; }
          .tool-body.expanded { display: block; }
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
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }, data);
}

function duplicateIdsFrom(ids) {
  return Array.from(
    new Set(ids.filter((id, index) => ids.indexOf(id) !== index)),
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
      agentFilters: Array.from(document.querySelectorAll(".agent-filter")).map(
        (filter) => ({
          location: filter.dataset.agentFilterLocation || null,
          options: Array.from(
            filter.querySelectorAll(".agent-filter-option"),
          ).map((option) => ({
            agentId: option.dataset.agentId || null,
            kind: option.dataset.trackKind || null,
            active: option.classList.contains("active"),
            text: option.textContent.replace(/\s+/g, " ").trim(),
          })),
        }),
      ),
      tracks: Array.from(document.querySelectorAll(".agent-track")).map(
        (el) => ({
          agentId: el.dataset.agentId || null,
          kind: el.dataset.trackKind || null,
          active: el.classList.contains("active"),
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
          return {
            subagentId: el.dataset.subagentId || null,
            sourceAgentId: el.dataset.sourceAgentId || null,
            sourceMessageId,
            spawnPromptId,
            firstMessageId,
            sourceMessageExists: Boolean(
              document.getElementById(sourceMessageId),
            ),
            spawnPromptExists: Boolean(document.getElementById(spawnPromptId)),
            firstMessageExists: Boolean(
              document.getElementById(firstMessageId),
            ),
          };
        },
      ),
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
        text: el.textContent.replace(/\s+/g, " ").trim(),
      })),
      toolRefs: Array.from(document.querySelectorAll(".part-activity-ref")).map(
        (el) => ({
          path: el.dataset.activityPath || null,
          linkedSubagentPath: el.dataset.linkedSubagentPath || null,
          text: el.textContent.replace(/\s+/g, " ").trim(),
        }),
      ),
    };
  }, selector);
}

function baseMessage(parts, finish = "tool-calls") {
  return {
    role: "assistant",
    time_created: "2026-06-18T00:00:00Z",
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

async function verifyRepeatedTopLevelTranscript(browser) {
  const page = await setupPage(browser);
  const sharedTranscript = {
    task_part_id: "unused-shared-task",
    agent_type: "general",
    summary: { id: "shared-session", title: "Shared transcript" },
    messages: [baseMessage([{ type: "text", text: "shared answer" }], "stop")],
    subagent_transcripts: [],
  };

  await runSyntheticSession(page, {
    id: "top-level-repeat",
    messages: [
      baseMessage([taskPart("main-a", "shared-session", "main A")]),
      baseMessage([taskPart("main-b", "shared-session", "main B")]),
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
    state.tracks.length === 3 &&
      subagentTrackIds.length === 2 &&
      new Set(subagentTrackIds).size === 2,
    "top-level repeat did not create distinct subagent tracks",
    state,
  );
  assert(
    state.agentFilters.length === 2 &&
      state.agentFilters.every((filter) => filter.options.length === 3) &&
      state.agentFilters.every(
        (filter) =>
          filter.options.filter((option) => option.active).length === 1,
      ),
    "top-level agent filter did not expose one selected track in each location",
    state,
  );
  assert(
    state.connectors.length === 2 &&
      state.connectors.every(
        (connector) =>
          connector.sourceMessageExists &&
          connector.spawnPromptExists &&
          connector.firstMessageExists,
      ),
    "top-level connectors do not resolve their linked DOM anchors",
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
      state.toolActivities.every((activity) => activity.linkedSubagentPath),
    "task tool results were not detached with subagent links",
    state,
  );
  assert(
    state.toolActivities.some((activity) =>
      activity.text.includes("main A done"),
    ) &&
      state.toolActivities.some((activity) =>
        activity.text.includes("main B done"),
      ),
    "task tool outputs are missing from detached activity cards",
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
    messages: [baseMessage([{ type: "text", text: "child answer" }], "stop")],
    subagent_transcripts: [],
  };
  const parentTranscript = {
    task_part_id: "parent-task",
    agent_type: "general",
    summary: { id: "parent-session", title: "Parent transcript" },
    messages: [
      baseMessage([taskPart("child-a", "child-session", "child A")]),
      baseMessage([taskPart("child-b", "child-session", "child B")]),
    ],
    subagent_transcripts: [childTranscript],
  };

  await runSyntheticSession(page, {
    id: "nested-repeat",
    messages: [
      baseMessage([taskPart("parent-task", "parent-session", "parent")]),
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
    state.tracks.length === 4 &&
      childTrackIds.length === 2 &&
      new Set(childTrackIds).size === 2,
    "nested repeat did not create distinct child subagent tracks",
    state,
  );
  assert(
    state.connectors.length === 3 &&
      state.connectors.every(
        (connector) =>
          connector.sourceMessageExists &&
          connector.spawnPromptExists &&
          connector.firstMessageExists,
      ),
    "nested connectors do not resolve their linked DOM anchors",
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
    "nested task tool outputs are missing from detached activity cards",
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
    "expected both tool outputs to render",
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
      state.toolActivities[1].text.includes("two"),
    "detached tool activities do not include both outputs",
    state,
  );
  assert(
    state.toolRefs.length === 2 &&
      new Set(state.toolRefs.map((ref) => ref.path)).size === 2,
    "message tool references do not point at distinct activities",
    state,
  );
  await page.close();
  return state;
}

const browser = await chromium.launch({ headless: true });
try {
  const results = {
    repeatedTopLevelTranscript: await verifyRepeatedTopLevelTranscript(browser),
    repeatedNestedTranscript: await verifyRepeatedNestedTranscript(browser),
    toolBodyIds: await verifyToolBodyIds(browser),
  };
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} catch (error) {
  console.error(error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
