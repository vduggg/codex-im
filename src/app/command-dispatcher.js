const { normalizeWorkspacePath } = require("../shared/workspace-paths");
const {
  MEMORY_ACTION_CONFIG,
  PANEL_ACTION_CONFIG,
  THREAD_ACTION_CONFIG,
  WORKSPACE_ACTION_CONFIG,
} = require("./card-action-config");

const TEXT_COMMAND_HANDLER_METHODS = {
  stop: "handleStopCommand",
  bind: "handleBindCommand",
  where: "handleWhereCommand",
  inspect_message: "handleMessageCommand",
  help: "handleHelpCommand",
  unknown_command: "handleUnknownCommand",
  workspace: "handleWorkspacesCommand",
  switch: "handleSwitchCommand",
  remove: "handleRemoveCommand",
  send: "handleSendCommand",
  new: "handleNewCommand",
  model: "handleModelCommand",
  effort: "handleEffortCommand",
  profile: "handleProfileCommand",
  provider: "handleProviderCommand",
  plan: "handlePlanCommand",
  memory: "handleMemoryCommand",
  today: "handleTodayCommand",
  todo: "handleTodoCommand",
  bridge: "handleBridgeCommand",
  recall: "handleRecallCommand",
  hub: "handleHubCommand",
  approve: "handleApprovalCommand",
  reject: "handleApprovalCommand",
};

const CARD_ACTION_KIND_METHODS = {
  memory: "handleMemoryCardAction",
  panel: "handlePanelCardAction",
  plan: "handlePlanCardAction",
  thread: "handleThreadCardAction",
  workspace: "handleWorkspaceCardAction",
};

const PANEL_CARD_ACTIONS = {
  open_threads: {
    feedback: PANEL_ACTION_CONFIG.open_threads.feedback,
    run: (runtime, normalized) => runtime.showThreadPicker(normalized, { replyToMessageId: normalized.messageId }),
  },
  new_thread: {
    feedback: PANEL_ACTION_CONFIG.new_thread.feedback,
    run: (runtime, normalized) => runtime.handleNewCommand(normalized),
  },
  show_messages: {
    feedback: PANEL_ACTION_CONFIG.show_messages.feedback,
    run: (runtime, normalized) => runtime.handleMessageCommand(normalized),
  },
  stop: {
    feedback: PANEL_ACTION_CONFIG.stop.feedback,
    run: (runtime, normalized) => runtime.handleStopCommand(normalized),
  },
  status: {
    feedback: PANEL_ACTION_CONFIG.status.feedback,
    run: (runtime, normalized) => runtime.showStatusPanel(normalized, { replyToMessageId: normalized.messageId }),
  },
  set_model: buildPanelSelectAction(PANEL_ACTION_CONFIG.set_model),
  set_effort: buildPanelSelectAction(PANEL_ACTION_CONFIG.set_effort),
};

const THREAD_CARD_ACTIONS = {
  switch: {
    feedback: THREAD_ACTION_CONFIG.switch.feedback,
    validate: (runtime, normalized, action) => {
      const { threadId: currentThreadId } = runtime.getCurrentThreadContext(normalized);
      if (currentThreadId && currentThreadId === action.threadId) {
        return { text: THREAD_ACTION_CONFIG.switch.alreadyCurrentText, kind: "info" };
      }
      return null;
    },
    run: (runtime, normalized, action) => (
      runtime.switchThreadById(normalized, action.threadId, { replyToMessageId: normalized.messageId })
    ),
  },
  messages: {
    feedback: THREAD_ACTION_CONFIG.messages.feedback,
    validate: (runtime, normalized, action) => {
      const { threadId: currentThreadId } = runtime.getCurrentThreadContext(normalized);
      if (!currentThreadId || currentThreadId !== action.threadId) {
        return { text: THREAD_ACTION_CONFIG.messages.notCurrentText, kind: "error" };
      }
      return null;
    },
    run: (runtime, normalized) => runtime.handleMessageCommand(normalized),
  },
};

const WORKSPACE_CARD_ACTIONS = {
  status: {
    feedback: WORKSPACE_ACTION_CONFIG.status.feedback,
    run: (runtime, normalized) => runtime.showStatusPanel(normalized, { replyToMessageId: normalized.messageId }),
  },
  remove: {
    feedback: WORKSPACE_ACTION_CONFIG.remove.feedback,
    run: (runtime, normalized, action) => (
      runtime.removeWorkspaceByPath(normalized, action.workspaceRoot, { replyToMessageId: normalized.messageId })
    ),
  },
  switch: {
    feedback: WORKSPACE_ACTION_CONFIG.switch.feedback,
    validate: (runtime, normalized, action) => {
      const { workspaceRoot: currentWorkspaceRoot } = runtime.getBindingContext(normalized);
      const targetWorkspaceRoot = normalizeWorkspacePath(action.workspaceRoot);
      if (currentWorkspaceRoot && targetWorkspaceRoot && currentWorkspaceRoot === targetWorkspaceRoot) {
        return { text: WORKSPACE_ACTION_CONFIG.switch.alreadyCurrentText, kind: "info" };
      }
      return null;
    },
    run: (runtime, normalized, action) => (
      runtime.switchWorkspaceByPath(normalized, action.workspaceRoot, { replyToMessageId: normalized.messageId })
    ),
  },
};

const MEMORY_CARD_ACTIONS = {
  panel: {
    feedback: MEMORY_ACTION_CONFIG.panel.feedback,
    run: (runtime, normalized) => runtime.handleMemoryCommand(normalized),
  },
  today: {
    feedback: MEMORY_ACTION_CONFIG.today.feedback,
    run: (runtime, normalized) => runtime.handleTodayCommand({
      ...normalized,
      text: "/codex today",
      command: "today",
    }),
  },
  todo_list: {
    feedback: MEMORY_ACTION_CONFIG.todo_list.feedback,
    run: (runtime, normalized) => runtime.handleTodoCommand({
      ...normalized,
      text: "/codex todo list",
      command: "todo",
    }),
  },
  todo_form: {
    feedback: MEMORY_ACTION_CONFIG.todo_form.feedback,
    run: (runtime, normalized) => runtime.handleTodoFormCommand(normalized),
  },
  todo_submit: {
    feedback: MEMORY_ACTION_CONFIG.todo_submit.feedback,
    validate: (_runtime, _normalized, action) => {
      const title = String(action?.formValue?.title || action?.formValue?.todo_title || "").trim();
      return title ? null : { text: MEMORY_ACTION_CONFIG.todo_submit.missingTitleText, kind: "error" };
    },
    run: (runtime, normalized, action) => runtime.handleTodoSubmitCardAction(action, normalized),
  },
  bridge_today: {
    feedback: MEMORY_ACTION_CONFIG.bridge_today.feedback,
    run: (runtime, normalized) => runtime.handleBridgeCommand({
      ...normalized,
      text: "/codex bridge",
      command: "bridge",
    }),
  },
  help: {
    feedback: MEMORY_ACTION_CONFIG.help.feedback,
    run: (runtime, normalized) => runtime.handleMemoryHelpCommand(normalized),
  },
};

async function dispatchTextCommand(runtime, normalized) {
  const handlerMethod = TEXT_COMMAND_HANDLER_METHODS[normalized.command];
  if (!handlerMethod || typeof runtime[handlerMethod] !== "function") {
    return false;
  }

  await runtime[handlerMethod](normalized);
  return true;
}

function dispatchCardAction(runtime, action, normalized) {
  const handlerMethod = CARD_ACTION_KIND_METHODS[action.kind];
  if (!handlerMethod || typeof runtime[handlerMethod] !== "function") {
    return null;
  }
  return runtime[handlerMethod](action, normalized);
}

function handlePanelCardAction(runtime, action, normalized) {
  return executeMappedCardAction(runtime, normalized, action, PANEL_CARD_ACTIONS);
}

function handleMemoryCardAction(runtime, action, normalized) {
  return executeMappedCardAction(runtime, normalized, action, MEMORY_CARD_ACTIONS);
}

function handleThreadCardAction(runtime, action, normalized) {
  return executeMappedCardAction(runtime, normalized, action, THREAD_CARD_ACTIONS);
}

function handleWorkspaceCardAction(runtime, action, normalized) {
  return executeMappedCardAction(runtime, normalized, action, WORKSPACE_CARD_ACTIONS);
}

function executeMappedCardAction(runtime, normalized, action, actionMap) {
  const handler = actionMap[action.action];
  if (!handler) {
    return null;
  }

  const validation = typeof handler.validate === "function"
    ? handler.validate(runtime, normalized, action)
    : null;
  if (validation?.text) {
    runtime.runCardActionTask(runtime.sendCardActionFeedbackByContext(
      normalized,
      validation.text,
      validation.kind || "error"
    ));
    return runtime.buildCardResponse({});
  }

  return runtime.queueCardActionWithFeedback(
    normalized,
    handler.feedback,
    () => handler.run(runtime, normalized, action)
  );
}

async function runCodexCommandFromCard(runtime, normalized, command, value) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) {
    return;
  }
  const synthetic = {
    ...normalized,
    text: `/codex ${command} ${normalizedValue}`,
    command,
  };
  if (command === "model") {
    await runtime.handleModelCommand(synthetic);
    return;
  }
  if (command === "effort") {
    await runtime.handleEffortCommand(synthetic);
  }
}

function buildPanelSelectAction({ command, feedback, missingValueText }) {
  return {
    feedback,
    validate: (_runtime, _normalized, action) => {
      if (!action.selectedValue) {
        console.warn(`[codex-im] panel ${command} missing selectedValue`, {
          actionKind: action.kind,
          actionName: action.action,
          selectedValue: action.selectedValue || "",
        });
        return { text: missingValueText, kind: "error" };
      }
      return null;
    },
    run: (runtime, normalized, action) => runCodexCommandFromCard(
      runtime,
      normalized,
      command,
      action.selectedValue
    ),
  };
}

module.exports = {
  dispatchTextCommand,
  dispatchCardAction,
  handleMemoryCardAction,
  handlePanelCardAction,
  handleThreadCardAction,
  handleWorkspaceCardAction,
};
