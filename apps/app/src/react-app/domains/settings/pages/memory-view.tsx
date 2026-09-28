/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Search } from "lucide-react";
import type {
  HarnessMemoryHit,
  HarnessMemoryProvider,
  HarnessMemorySettingsPatch,
  HarnessMemoryStatus,
} from "@harness/types/desktop-ipc";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import {
  memoryList,
  memoryProbeEndpoint,
  memoryRecall,
  memoryRetain,
  memorySetApiKey,
  memoryStart,
  memoryStatus,
  memoryStop,
  memoryUpdateSettings,
} from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import {
  LayoutSection,
  LayoutSectionContent,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemContent,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
  LayoutStack,
} from "../settings-layout";
import { SettingsFactRow } from "../settings-list";
import { SettingsNotice, SettingsStatusBadge } from "../settings-section";

const MEMORY_STATUS_KEY = ["memory", "status"] as const;
const MEMORY_LIST_KEY = ["memory", "list"] as const;

const PROVIDER_OPTIONS: Array<{ value: HarnessMemoryProvider; label: string; local: boolean }> = [
  { value: "ollama", label: "Ollama", local: true },
  { value: "openai-compatible", label: "vLLM, llama.cpp or other OpenAI-compatible server", local: true },
  { value: "lmstudio", label: "LM Studio", local: true },
  { value: "openai", label: "OpenAI (API key)", local: false },
  { value: "anthropic", label: "Anthropic (API key)", local: false },
  { value: "gemini", label: "Google Gemini (API key)", local: false },
  { value: "groq", label: "Groq (API key)", local: false },
];

function engineBadge(status: HarnessMemoryStatus): { label: string; tone: "ready" | "warning" | "neutral" | "error" } {
  switch (status.engine.state) {
    case "ready":
      return { label: `Running on 127.0.0.1:${status.engine.port ?? status.settings.port}`, tone: "ready" };
    case "starting":
      return { label: "Starting", tone: "warning" };
    case "stopping":
      return { label: "Stopping", tone: "warning" };
    case "failed":
      return { label: "Stopped after an error", tone: "error" };
    default:
      return { label: status.settings.enabled ? "Not running" : "Off", tone: "neutral" };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MemoryView() {
  if (!isDesktopRuntime()) {
    return (
      <LayoutStack>
        <SettingsNotice>Memory runs on your computer and is available in the Harness desktop app.</SettingsNotice>
      </LayoutStack>
    );
  }
  return <DesktopMemoryView />;
}

function DesktopMemoryView() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: MEMORY_STATUS_KEY,
    queryFn: () => memoryStatus(),
    refetchInterval: (query) => {
      const state = query.state.data?.engine.state;
      return state === "starting" || state === "stopping" ? 1_000 : 5_000;
    },
  });
  const setStatus = (next: HarnessMemoryStatus) => {
    queryClient.setQueryData(MEMORY_STATUS_KEY, next);
    void queryClient.invalidateQueries({ queryKey: MEMORY_LIST_KEY });
  };

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => (enabled ? memoryStart() : memoryStop()),
    onSuccess: (next) => {
      setStatus(next);
      toast.success(next.settings.enabled ? "Memory turned on" : "Memory turned off");
    },
    onError: (error) => {
      toast.error(describeError(error));
      void queryClient.invalidateQueries({ queryKey: MEMORY_STATUS_KEY });
    },
  });

  if (status.isPending) {
    return (
      <LayoutStack>
        <div className="h-24 animate-pulse rounded-xl bg-dls-hover" />
        <div className="h-64 animate-pulse rounded-xl bg-dls-hover" />
      </LayoutStack>
    );
  }
  if (status.isError || !status.data) {
    return (
      <LayoutStack>
        <SettingsNotice tone="error">Couldn't read memory status: {describeError(status.error)}</SettingsNotice>
      </LayoutStack>
    );
  }

  const current = status.data;
  const badge = engineBadge(current);
  const lastError = current.engine.lastError;

  return (
    <LayoutStack>
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>Local memory</LayoutSectionTitle>
        </LayoutSectionHeader>
        <LayoutSectionContent>
          <LayoutSectionItem>
            <LayoutSectionItemHeader>
              <LayoutSectionItemTitle>Remember across sessions</LayoutSectionItemTitle>
              <LayoutSectionItemDescription>
                Facts, experiences, observations and mental models, stored in {current.dataDir}
              </LayoutSectionItemDescription>
              <LayoutSectionItemHeaderActions>
                <SettingsStatusBadge label={badge.label} tone={badge.tone} />
                <Switch
                  aria-label="Remember across sessions"
                  checked={current.settings.enabled}
                  disabled={toggle.isPending || !current.runtimeAvailable}
                  onCheckedChange={(checked) => toggle.mutate(checked)}
                />
              </LayoutSectionItemHeaderActions>
            </LayoutSectionItemHeader>
            {!current.runtimeAvailable ? (
              <LayoutSectionItemContent>
                <SettingsNotice>
                  The memory engine isn't installed in this build. Package Harness with <code>npm run package</code>, or run{" "}
                  <code>node scripts/hindsight/prepare-runtime.mjs --dev</code> in a development checkout.
                </SettingsNotice>
              </LayoutSectionItemContent>
            ) : null}
            {lastError ? (
              <LayoutSectionItemContent>
                <SettingsNotice tone="error">{lastError}</SettingsNotice>
              </LayoutSectionItemContent>
            ) : null}
          </LayoutSectionItem>
          <LayoutSectionItem>
            <LayoutSectionItemContent className="flex flex-col gap-3">
              <SettingsFactRow
                label="Network"
                value={
                  current.egressHosts.length === 0
                    ? "Stays on this device: the engine only talks to 127.0.0.1"
                    : `Sends memory text only to ${current.egressHosts.join(", ")}`
                }
              />
            </LayoutSectionItemContent>
          </LayoutSectionItem>
        </LayoutSectionContent>
      </LayoutSection>

      <ModelEndpointSection status={current} onStatus={setStatus} />

      {current.engine.state === "ready" ? <MemoryBrowserSection /> : null}
    </LayoutStack>
  );
}

function ModelEndpointSection({ status, onStatus }: { status: HarnessMemoryStatus; onStatus: (next: HarnessMemoryStatus) => void }) {
  const { settings } = status;
  const [provider, setProvider] = useState<HarnessMemoryProvider>(settings.llm.provider);
  const [baseUrl, setBaseUrl] = useState(settings.llm.baseUrl ?? "");
  const [model, setModel] = useState(settings.llm.model);
  const [embeddingsModel, setEmbeddingsModel] = useState(settings.embeddings.model);
  const [embeddingsBaseUrl, setEmbeddingsBaseUrl] = useState(settings.embeddings.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    setProvider(settings.llm.provider);
    setBaseUrl(settings.llm.baseUrl ?? "");
    setModel(settings.llm.model);
    setEmbeddingsModel(settings.embeddings.model);
    setEmbeddingsBaseUrl(settings.embeddings.baseUrl ?? "");
  }, [settings.llm.provider, settings.llm.baseUrl, settings.llm.model, settings.embeddings.model, settings.embeddings.baseUrl]);

  const local = PROVIDER_OPTIONS.find((option) => option.value === provider)?.local ?? true;
  const dirty =
    provider !== settings.llm.provider ||
    baseUrl !== (settings.llm.baseUrl ?? "") ||
    model !== settings.llm.model ||
    embeddingsModel !== settings.embeddings.model ||
    embeddingsBaseUrl !== (settings.embeddings.baseUrl ?? "");

  const save = useMutation({
    mutationFn: () => {
      const patch: HarnessMemorySettingsPatch = {
        llm: { provider, model: model.trim(), ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}) },
        embeddings: { model: embeddingsModel.trim(), ...(embeddingsBaseUrl.trim() ? { baseUrl: embeddingsBaseUrl.trim() } : {}) },
      };
      return memoryUpdateSettings(patch);
    },
    onSuccess: (next) => {
      onStatus(next);
      toast.success("Model endpoint saved");
    },
    onError: (error) => toast.error(describeError(error)),
  });

  const storeKey = useMutation({
    mutationFn: (value: string | null) => memorySetApiKey({ kind: "llm", value }),
    onSuccess: (next, value) => {
      setApiKey("");
      onStatus(next);
      toast.success(value ? "API key saved to your OS keychain" : "API key removed");
    },
    onError: (error) => toast.error(describeError(error)),
  });

  const probe = useMutation({ mutationFn: () => memoryProbeEndpoint() });

  return (
    <LayoutSection>
      <LayoutSectionHeader>
        <LayoutSectionTitle>Model endpoint</LayoutSectionTitle>
      </LayoutSectionHeader>
      <LayoutSectionContent>
        <LayoutSectionItem>
          <LayoutSectionItemContent className="grid gap-3 @md/settings:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-dls-text">Provider</span>
              <Select
                value={provider}
                items={PROVIDER_OPTIONS}
                onValueChange={(value) => {
                  if (value) setProvider(value);
                }}
              >
                <SelectTrigger className="w-full" aria-label="Provider">
                  <SelectValue placeholder="Provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {PROVIDER_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-dls-text">Endpoint URL</span>
              <Input
                value={baseUrl}
                placeholder={status.llmBaseUrl}
                spellCheck={false}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-dls-text">Model</span>
              <Input value={model} spellCheck={false} onChange={(event) => setModel(event.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-dls-text">Embedding model</span>
              <Input value={embeddingsModel} spellCheck={false} onChange={(event) => setEmbeddingsModel(event.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5 text-sm @md/settings:col-span-2">
              <span className="font-medium text-dls-text">Embeddings URL</span>
              <Input
                value={embeddingsBaseUrl}
                placeholder={status.embeddingsBaseUrl}
                spellCheck={false}
                onChange={(event) => setEmbeddingsBaseUrl(event.target.value)}
              />
            </label>
          </LayoutSectionItemContent>
          <LayoutSectionItemContent className="flex flex-wrap items-center gap-2">
            <Button disabled={!dirty || save.isPending || !model.trim() || !embeddingsModel.trim()} onClick={() => save.mutate()}>
              Save endpoint
            </Button>
            <Button variant="outline" disabled={probe.isPending} onClick={() => probe.mutate()}>
              Check connection
            </Button>
            {probe.data ? (
              <SettingsStatusBadge
                tone={probe.data.reachable ? (probe.data.ok ? "ready" : "warning") : "error"}
                label={
                  probe.data.reachable
                    ? probe.data.ok
                      ? "Endpoint answered"
                      : `Endpoint answered with HTTP ${probe.data.status}`
                    : `Can't reach ${probe.data.url}`
                }
              />
            ) : null}
          </LayoutSectionItemContent>
        </LayoutSectionItem>

        {!local || status.apiKeys.llm ? (
          <LayoutSectionItem>
            <LayoutSectionItemHeader>
              <LayoutSectionItemTitle>API key</LayoutSectionItemTitle>
              <LayoutSectionItemDescription>
                {status.apiKeys.llm ? "Saved in your OS keychain" : "Not set"}
              </LayoutSectionItemDescription>
              <LayoutSectionItemHeaderActions>
                {status.apiKeys.llm ? (
                  <Button variant="outline" size="sm" disabled={storeKey.isPending} onClick={() => storeKey.mutate(null)}>
                    Remove key
                  </Button>
                ) : null}
              </LayoutSectionItemHeaderActions>
            </LayoutSectionItemHeader>
            <LayoutSectionItemContent className="flex items-center gap-2">
              <Input
                type="password"
                autoComplete="off"
                value={apiKey}
                placeholder={status.apiKeys.llm ? "Replace the saved key" : "Paste an API key"}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <Button disabled={!apiKey.trim() || storeKey.isPending} onClick={() => storeKey.mutate(apiKey.trim())}>
                <KeyRound size={14} />
                Save key
              </Button>
            </LayoutSectionItemContent>
          </LayoutSectionItem>
        ) : null}
      </LayoutSectionContent>
    </LayoutSection>
  );
}

function MemoryBrowserSection() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [draft, setDraft] = useState("");

  const recent = useQuery({ queryKey: MEMORY_LIST_KEY, queryFn: () => memoryList({ limit: 25 }) });
  const recall = useQuery({
    queryKey: ["memory", "recall", submittedQuery],
    queryFn: () => memoryRecall({ query: submittedQuery }),
    enabled: submittedQuery.length > 0,
  });
  const retain = useMutation({
    mutationFn: (content: string) => memoryRetain({ content, context: "Added in Settings" }),
    onSuccess: () => {
      setDraft("");
      toast.success("Remembered");
      void queryClient.invalidateQueries({ queryKey: MEMORY_LIST_KEY });
    },
    onError: (error) => toast.error(describeError(error)),
  });

  const hits: Array<Pick<HarnessMemoryHit, "id" | "text"> & { kind?: string | null }> = submittedQuery
    ? (recall.data ?? []).map((hit) => ({ id: hit.id, text: hit.text, kind: hit.type }))
    : (recent.data?.items ?? []).map((item) => ({ id: item.id, text: item.text, kind: item.fact_type }));
  const loading = submittedQuery ? recall.isFetching : recent.isPending;

  return (
    <LayoutSection>
      <LayoutSectionHeader>
        <LayoutSectionTitle>Memories</LayoutSectionTitle>
      </LayoutSectionHeader>
      <LayoutSectionContent>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmittedQuery(query.trim());
          }}
        >
          <Input value={query} placeholder="Ask what Harness remembers" onChange={(event) => setQuery(event.target.value)} />
          <Button type="submit" variant="outline">
            <Search size={14} />
            Recall
          </Button>
        </form>
        <div className="flex flex-col divide-y divide-dls-border">
          {loading ? (
            <div className="h-20 animate-pulse rounded-xl bg-dls-hover" />
          ) : hits.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">
              {submittedQuery ? "Nothing matches yet." : "No memories yet. What you remember below, or what the agent retains, appears here."}
            </p>
          ) : (
            hits.map((hit) => (
              <div key={hit.id} className="flex items-start justify-between gap-3 py-2.5 text-sm">
                <span className="text-dls-text">{hit.text}</span>
                {hit.kind ? <span className="shrink-0 font-mono text-xs text-muted-foreground">{hit.kind}</span> : null}
              </div>
            ))
          )}
        </div>
        {submittedQuery ? null : recent.data && recent.data.total > recent.data.items.length ? (
          <p className="text-xs text-muted-foreground">
            Showing {recent.data.items.length} of {recent.data.total}
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          <Textarea
            value={draft}
            rows={2}
            placeholder="Something Harness should remember, like a preference or a project fact"
            onChange={(event) => setDraft(event.target.value)}
          />
          <div>
            <Button disabled={!draft.trim() || retain.isPending} onClick={() => retain.mutate(draft.trim())}>
              Remember this
            </Button>
          </div>
        </div>
      </LayoutSectionContent>
    </LayoutSection>
  );
}
