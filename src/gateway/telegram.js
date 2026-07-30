const API = "https://api.telegram.org";

export function createTelegramClient(token, { baseUrl = API } = {}) {
  async function call(method, params = {}) {
    const res = await fetch(`${baseUrl}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(45000),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description || res.status}`);
    return json.result;
  }

  return {
    getMe: () => call("getMe"),
    getUpdates: (offset) => call("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] }),
    async sendMessage(chatId, text) {
      const chunks = [];
      let rest = String(text);
      while (rest.length > 4000) {
        chunks.push(rest.slice(0, 4000));
        rest = rest.slice(4000);
      }
      chunks.push(rest);
      for (const c of chunks) await call("sendMessage", { chat_id: chatId, text: c });
    },
  };
}
