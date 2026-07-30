export async function* streamChat({ baseURL, apiKey, model, messages, tools, signal }) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools?.length) body.tools = tools;

  let res;
  try {
    res = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    throw new Error(`Cannot reach ${baseURL}: ${e.message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text.slice(0, 500)}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const toolCalls = new Map();
  let usage = null;

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.usage) usage = json.usage;
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          yield { type: "text", text: delta.content };
        }
        if (delta.reasoning_content) {
          yield { type: "reasoning", text: delta.reasoning_content };
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const id = tc.index ?? 0;
            if (!toolCalls.has(id)) toolCalls.set(id, { id: "", name: "", arguments: "" });
            const acc = toolCalls.get(id);
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
          }
        }
      }
    }
  }

  const calls = [...toolCalls.values()].filter((t) => t.name);
  if (calls.length) yield { type: "tool_calls", calls };
  if (usage) yield { type: "usage", usage };
}

export async function complete({ baseURL, apiKey, model, messages, signal }) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, messages, stream: false }),
    signal,
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text().catch(() => "")).slice(0, 500)}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? "";
}
