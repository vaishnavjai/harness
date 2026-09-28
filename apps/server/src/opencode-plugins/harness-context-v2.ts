type Tool = {
  name: string;
  description: string;
  input: Record<string, unknown>;
  options: { codemode: boolean };
  execute(input: unknown, context: { signal: AbortSignal }): Promise<{ content: { type: "text"; text: string }[] }>;
};
type Context = {
  options: { url: string; token: string };
  tool: { transform(callback: (editor: { add(tool: Tool): void }) => void): Promise<{ dispose(): Promise<void> }> };
};

// The only credential here authorizes these two read tools, never general host APIs.
export default {
  id: "harness.context",
  async setup(context: Context) {
    const registration = await context.tool.transform(editor => {
      for (const name of ["harness_context", "harness_query"]) {
        editor.add({
          name,
          description: name === "harness_context"
            ? "Read Harness app context and available read-only affordances. Use this to discover session.search and session.read for other conversations."
            : "Read a Harness affordance without changing the app or navigating. Use the exact id and arguments from harness_context; session.read includes live background-agent activity.",
          input: name === "harness_context" ? { type: "object", properties: {}, additionalProperties: false } : {
            type: "object", properties: { id: { type: "string" }, args: { type: "object", additionalProperties: true } },
            required: ["id"], additionalProperties: false,
          },
          options: { codemode: false },
          async execute(input, call) {
            const response = await fetch(context.options.url, {
              method: "POST", redirect: "error", signal: call.signal,
              headers: { Authorization: `Bearer ${context.options.token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ name, input }),
            });
            if (!response.ok) throw new Error(`Harness read failed (${response.status})`);
            return { content: [{ type: "text", text: await response.text() }] };
          },
        });
      }
    });
    return () => registration.dispose();
  },
};
