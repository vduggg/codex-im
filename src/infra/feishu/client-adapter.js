// Feishu SDK adapter and compatibility helpers
class FeishuClientAdapter {
  constructor(client) {
    this.client = client;
  }

  async sendFileMessage({ chatId, fileName, fileBuffer, replyToMessageId = "", replyInThread = false }) {
    const fileKey = await this.uploadFile({
      fileName,
      fileBuffer,
    });
    if (!fileKey) {
      throw new Error("Feishu file upload did not return a file_key");
    }

    const content = JSON.stringify({ file_key: fileKey });
    if (replyToMessageId) {
      const replyMessage = resolveReplyMessageMethod(this.client);
      return replyMessage.call(this.client.im?.v1?.message || this.client.im?.message || this.client, {
        path: {
          message_id: normalizeMessageId(replyToMessageId),
        },
        data: {
          msg_type: "file",
          content,
          reply_in_thread: replyInThread,
        },
      });
    }

    const createMessage = resolveCreateMessageMethod(this.client);
    return createMessage.call(this.client.im?.v1?.message || this.client.im?.message || this.client, {
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "file",
        content,
      },
    });
  }

  async sendInteractiveCard({ chatId, card, replyToMessageId = "", replyInThread = false }) {
    if (replyToMessageId) {
      const replyMessage = resolveReplyMessageMethod(this.client);
      return replyMessage.call(this.client.im?.v1?.message || this.client.im?.message || this.client, {
        path: {
          message_id: normalizeMessageId(replyToMessageId),
        },
        data: {
          msg_type: "interactive",
          content: JSON.stringify(card),
          reply_in_thread: replyInThread,
        },
      });
    }

    const createMessage = resolveCreateMessageMethod(this.client);
    return createMessage.call(this.client.im?.v1?.message || this.client.im?.message || this.client, {
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
  }

  async patchInteractiveCard({ messageId, card }) {
    const patchMessage = resolvePatchMessageMethod(this.client);
    return patchMessage.call(this.client.im?.v1?.message || this.client.im?.message || this.client, {
      path: {
        message_id: messageId,
      },
      data: {
        content: JSON.stringify(card),
      },
    });
  }

  async createCardEntity({ card }) {
    const createCard = resolveCreateCardMethod(this.client);
    const response = await createCard.call(this.client.cardkit?.v1?.card || this.client.cardkit?.card || this.client, {
      data: {
        type: "card_json",
        data: JSON.stringify(card),
      },
    });
    assertFeishuBusinessOk(response, "card.create");
    const cardId = normalizeIdentifier(response?.data?.card_id || response?.card_id);
    if (!cardId) {
      throw new Error("Feishu CardKit card.create did not return card_id");
    }
    return cardId;
  }

  async sendCardByCardId({ chatId, cardId, replyToMessageId = "", replyInThread = false }) {
    const content = JSON.stringify({
      type: "card",
      data: { card_id: cardId },
    });
    if (replyToMessageId) {
      const replyMessage = resolveReplyMessageMethod(this.client);
      return replyMessage.call(this.client.im?.v1?.message || this.client.im?.message || this.client, {
        path: {
          message_id: normalizeMessageId(replyToMessageId),
        },
        data: {
          msg_type: "interactive",
          content,
          reply_in_thread: replyInThread,
        },
      });
    }

    const createMessage = resolveCreateMessageMethod(this.client);
    return createMessage.call(this.client.im?.v1?.message || this.client.im?.message || this.client, {
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content,
      },
    });
  }

  async streamCardContent({ cardId, elementId, content, sequence }) {
    const updateContent = resolveCardElementContentMethod(this.client);
    const response = await updateContent.call(
      this.client.cardkit?.v1?.cardElement || this.client.cardkit?.cardElement || this.client,
      {
        path: {
          card_id: cardId,
          element_id: elementId,
        },
        data: {
          content,
          sequence,
        },
      }
    );
    assertFeishuBusinessOk(response, "cardElement.content");
    return response;
  }

  async updateCardKitCard({ cardId, card, sequence }) {
    const updateCard = resolveUpdateCardMethod(this.client);
    const response = await updateCard.call(this.client.cardkit?.v1?.card || this.client.cardkit?.card || this.client, {
      path: {
        card_id: cardId,
      },
      data: {
        card: {
          type: "card_json",
          data: JSON.stringify(card),
        },
        sequence,
      },
    });
    assertFeishuBusinessOk(response, "card.update");
    return response;
  }

  async setCardStreamingMode({ cardId, streamingMode, sequence }) {
    const updateSettings = resolveCardSettingsMethod(this.client);
    const response = await updateSettings.call(this.client.cardkit?.v1?.card || this.client.cardkit?.card || this.client, {
      path: {
        card_id: cardId,
      },
      data: {
        settings: JSON.stringify({ streaming_mode: Boolean(streamingMode) }),
        sequence,
      },
    });
    assertFeishuBusinessOk(response, "card.settings");
    return response;
  }

  async createReaction({ messageId, emojiType }) {
    const createReaction = resolveCreateReactionMethod(this.client);
    return createReaction.call(
      this.client.im?.v1?.messageReaction || this.client.im?.messageReaction || this.client,
      {
        path: {
          message_id: messageId,
        },
        data: {
          reaction_type: {
            emoji_type: emojiType,
          },
        },
      }
    );
  }

  async deleteReaction({ messageId, reactionId }) {
    const deleteReaction = resolveDeleteReactionMethod(this.client);
    return deleteReaction.call(
      this.client.im?.v1?.messageReaction || this.client.im?.messageReaction || this.client,
      {
        path: {
          message_id: messageId,
          reaction_id: reactionId,
        },
      }
    );
  }

  async uploadFile({ fileName, fileBuffer }) {
    const createFile = resolveCreateFileMethod(this.client);
    const response = await createFile.call(this.client.im?.v1?.file || this.client.im?.file || this.client, {
      data: {
        file_type: "stream",
        file_name: normalizeFileName(fileName),
        file: fileBuffer,
      },
    });
    return normalizeIdentifier(response?.file_key || response?.data?.file_key);
  }
}

function resolveCreateMessageMethod(client) {
  const fn = client?.im?.v1?.message?.create || client?.im?.message?.create;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing message.create");
  }
  return fn;
}

function resolveReplyMessageMethod(client) {
  const fn = client?.im?.v1?.message?.reply || client?.im?.message?.reply;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing message.reply");
  }
  return fn;
}

function resolvePatchMessageMethod(client) {
  const fn = client?.im?.v1?.message?.patch || client?.im?.message?.patch;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing message.patch");
  }
  return fn;
}

function resolveCreateCardMethod(client) {
  const fn = client?.cardkit?.v1?.card?.create || client?.cardkit?.card?.create;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing cardkit.card.create");
  }
  return fn;
}

function resolveUpdateCardMethod(client) {
  const fn = client?.cardkit?.v1?.card?.update || client?.cardkit?.card?.update;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing cardkit.card.update");
  }
  return fn;
}

function resolveCardSettingsMethod(client) {
  const fn = client?.cardkit?.v1?.card?.settings || client?.cardkit?.card?.settings;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing cardkit.card.settings");
  }
  return fn;
}

function resolveCardElementContentMethod(client) {
  const fn = client?.cardkit?.v1?.cardElement?.content || client?.cardkit?.cardElement?.content;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing cardkit.cardElement.content");
  }
  return fn;
}

function resolveCreateFileMethod(client) {
  const fn = client?.im?.v1?.file?.create || client?.im?.file?.create;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing file.create");
  }
  return fn;
}

function normalizeMessageId(messageId) {
  const normalized = typeof messageId === "string" ? messageId.trim() : "";
  if (!normalized) {
    return "";
  }
  return normalized.split(":")[0];
}

function resolveCreateReactionMethod(client) {
  const fn = client?.im?.v1?.messageReaction?.create || client?.im?.messageReaction?.create;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing messageReaction.create");
  }
  return fn;
}

function resolveDeleteReactionMethod(client) {
  const fn = client?.im?.v1?.messageReaction?.delete || client?.im?.messageReaction?.delete;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing messageReaction.delete");
  }
  return fn;
}

function extractCardChatId(data) {
  return normalizeIdentifier(data?.context?.open_chat_id);
}

function patchWsClientForCardCallbacks(wsClient) {
  if (!wsClient || typeof wsClient.handleEventData !== "function") {
    return;
  }

  const originalHandleEventData = wsClient.handleEventData.bind(wsClient);
  wsClient.handleEventData = (data) => {
    const headers = Array.isArray(data?.headers) ? data.headers : [];
    const messageType = headers.find((header) => header?.key === "type")?.value;
    if (messageType === "card") {
      const patchedData = {
        ...data,
        headers: headers.map((header) => (
          header?.key === "type" ? { ...header, value: "event" } : header
        )),
      };
      return originalHandleEventData(patchedData);
    }
    return originalHandleEventData(data);
  };
}

function normalizeIdentifier(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function assertFeishuBusinessOk(response, apiName) {
  const code = Number(response?.code || 0);
  if (Number.isFinite(code) && code !== 0) {
    const message = normalizeIdentifier(response?.msg) || normalizeIdentifier(response?.message) || "unknown error";
    throw new Error(`Feishu ${apiName} failed: ${code} ${message}`);
  }
}

function normalizeFileName(fileName) {
  return typeof fileName === "string" && fileName.trim() ? fileName.trim() : "file";
}

module.exports = {
  FeishuClientAdapter,
  extractCardChatId,
  patchWsClientForCardCallbacks,
};
