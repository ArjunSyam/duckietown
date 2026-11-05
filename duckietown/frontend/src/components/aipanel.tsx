import { useState, useRef, useEffect } from "react";
import {
  Sparkles,
  X,
  Send,
  Bot,
  User,
  FileText,
  ChevronDown,
  ChevronUp,
  Loader2,
  FolderPlus,
  AlertTriangle,
  RotateCcw,
  Maximize2,
  Minimize2,
  RefreshCw,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { wails } from "../lib/wails";
import { FileTypeIcon } from "../lib/filetypes";
import type {
  FileHit,
  PlannedMove,
  ProposedGrouping,
  PlannedRename,
  RenameSelection,
} from "../types";

interface SourceFile {
  file_name: string;
  similarity: number;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: SourceFile[];
  streaming?: boolean;
  isOrganise?: boolean;
  isError?: boolean;
  errorDetail?: string;
  retryQuery?: string;
  retryFileContext?: string;
  // Tool-calling activity, attached to the in-flight streaming bubble.
  toolLabel?: string;
  fileResults?: FileHit[];
  // Organise preview card (search -> judge -> preview -> confirm -> move).
  isOrganisePreview?: boolean;
  planId?: string;
  targetFolder?: string;
  moves?: PlannedMove[];
  selectedFiles?: Record<string, boolean>;
  organiseDone?: boolean;
  // Clarification card for a too-vague organise instruction.
  isClarification?: boolean;
  proposedGroupings?: ProposedGrouping[];
  // Rename preview card (search -> propose names -> preview -> confirm -> rename).
  isRenamePreview?: boolean;
  renamePlanId?: string;
  renames?: PlannedRename[];
  renameSelections?: Record<string, { include: boolean; editedNewName: string }>;
  renameDone?: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  targetFile?: string | null;
  sessionKey: number;
  currentFolder: string;
  onClearTargetFile?: () => void;
  expanded: boolean;
  onToggleExpand: () => void;
}

const UNDO_RE = /\b(undo|revert|put (it|them|that) back)\b/i;

// Cached across panel opens — the model doesn't change at runtime.
let cachedChatModel: string | null = null;

function humanizeModel(id: string): string {
  if (!id) return "AI";
  const last = id.split("/").pop() ?? id;
  return last
    .replace(/-it$/i, "")
    .replace(/-instruct$/i, "")
    .split("-")
    .filter(Boolean)
    .map((part) =>
      part.length <= 3 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1),
    )
    .join(" ");
}

function parseError(raw: string): { friendly: string; detail: string } {
  const lower = raw.toLowerCase();
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("rate-limited")) {
    return {
      friendly: "The AI model is busy right now (rate limited). Try again in a moment.",
      detail: raw,
    };
  }
  if (lower.includes("not authenticated")) {
    return {
      friendly: "You're not signed in. Please sign in and try again.",
      detail: raw,
    };
  }
  if (lower.includes("sidecar") || lower.includes("econn") || lower.includes("network")) {
    return {
      friendly: "Couldn't reach the AI service. Check that Duckietown is running and try again.",
      detail: raw,
    };
  }
  return {
    friendly: "Something went wrong getting a response. Try again.",
    detail: raw,
  };
}

const markdownComponents: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  strong: ({ children }) => (
    <strong className="font-semibold text-[#eaeaea]">{children}</strong>
  ),
  em: ({ children }) => <em className="italic text-[#c0c0c0]">{children}</em>,
  ul: ({ children }) => (
    <ul className="list-disc pl-4 mb-2 last:mb-0 space-y-0.5">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-4 mb-2 last:mb-0 space-y-0.5">{children}</ol>
  ),
  li: ({ children }) => <li>{children}</li>,
  pre: ({ children }) => (
    <pre className="my-2 max-w-full overflow-x-auto rounded-md border border-[#3e3e42] bg-[#1a1a1a] p-2">
      {children}
    </pre>
  ),
  code: ({ className, children }) =>
    className ? (
      // fenced block — parent <pre> supplies the box, this just sets font
      <code className="text-[11px] font-mono">{children}</code>
    ) : (
      <code className="rounded bg-[#1a1a1a] border border-[#3e3e42] px-1 py-0.5 text-[11px] font-mono">
        {children}
      </code>
    ),
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) wails.openExternal(href);
      }}
      className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2 cursor-pointer [overflow-wrap:anywhere]"
    >
      {children}
    </a>
  ),
};

export function AIPanel({
  open,
  onClose,
  targetFile,
  sessionKey,
  currentFolder,
  onClearTargetFile,
  expanded,
  onToggleExpand,
}: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isOrganising, setIsOrganising] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [chatModel, setChatModel] = useState(cachedChatModel);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollWrapRef = useRef<HTMLDivElement>(null);
  const prevMsgCountRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guard against React Strict Mode double-firing the auto-summarise
  const autoSentRef = useRef(false);
  // Tracks the last (query, fileContext) sent, so Retry can resend it
  const lastRequestRef = useRef<{ query: string; fileContext?: string } | null>(null);

  useEffect(() => {
    if (cachedChatModel) return;
    wails
      .getChatModel()
      .then((model) => {
        cachedChatModel = model;
        setChatModel(model);
      })
      .catch(() => {
        // leave chatModel null — footer falls back to generic text
      });
  }, []);

  // Fresh state on every open (sessionKey increments each time panel opens)
  useEffect(() => {
    autoSentRef.current = false;

    const welcome: Message = {
      id: "welcome",
      role: "assistant",
      content: targetFile
        ? `I'll help you with **${targetFile}**. Ask me to summarise it or ask any question about its content.\n\nYou can also ask me to organise or rename files — for example:\n• _"Group all image files into a folder called photos"_\n• _"Move all legal documents into a folder named legal"_\n• _"Give my screenshots descriptive names"_`
        : `Ask me anything about your files, or ask me to organise or rename them.\n\nExamples:\n• _"What does the Q3 report say about revenue?"_\n• _"Summarise sample.pdf"_\n• _"Group all images into a folder called photos"_\n• _"Move all legal documents into legal"_\n• _"Give my screenshots descriptive names"_`,
    };
    setMessages([welcome]);
    setInput("");
    setIsStreaming(false);
    setIsOrganising(false);
    setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 100);

    if (targetFile) {
      // Use ref guard so React Strict Mode double-invoke doesn't send twice
      const timer = setTimeout(() => {
        if (autoSentRef.current) return;
        autoSentRef.current = true;
        triggerChat(`Summarise ${targetFile}`, [], targetFile);
      }, 400);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  // Auto-scroll, but don't fight the user: a brand-new message (sent, or an
  // assistant bubble appended) always scrolls smoothly; a token streaming
  // into the existing last bubble only follows if we were already at the
  // bottom, and jumps instantly rather than smooth-animating on every
  // token (which is what made the panel feel like it was jittering during
  // long responses — dozens of overlapping smooth-scroll calls per second).
  useEffect(() => {
    const isNewMessage = messages.length !== prevMsgCountRef.current;
    prevMsgCountRef.current = messages.length;

    const viewport = scrollWrapRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    const nearBottom =
      !viewport ||
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;

    if ((isNewMessage || nearBottom) && viewport) {
      viewport.scrollTo({
        top: viewport.scrollHeight,
        behavior: isNewMessage ? "smooth" : "auto",
      });
    }
  }, [messages]);

  // Wire Wails streaming events
  useEffect(() => {
    // Inserts a standalone card (organise preview/clarification/error)
    // BEFORE the currently-streaming assistant bubble rather than after it
    // — these can arrive mid-stream (triggered by a tool call), and the
    // token-append handler below always targets the last message, so the
    // streaming bubble must stay last or the rest of the answer gets lost.
    const insertBeforeStreaming = (card: Message) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          return [...prev.slice(0, -1), card, last];
        }
        return [...prev, card];
      });
    };

    wails.on("chat-token", (data: { content: string }) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          return [
            ...prev.slice(0, -1),
            { ...last, content: last.content + data.content, toolLabel: undefined },
          ];
        }
        return prev;
      });
    });
    wails.on("chat-sources", (files: SourceFile[]) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant") {
          return [...prev.slice(0, -1), { ...last, sources: files }];
        }
        return prev;
      });
    });
    wails.on("chat-tool-start", (data: { tool: string; label: string }) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          return [...prev.slice(0, -1), { ...last, toolLabel: data.label }];
        }
        return prev;
      });
    });
    wails.on("chat-search-results", (results: FileHit[]) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          return [
            ...prev.slice(0, -1),
            { ...last, fileResults: [...(last.fileResults ?? []), ...(results ?? [])] },
          ];
        }
        return prev;
      });
    });
    wails.on(
      "organise-plan-ready",
      (plan: { id: string; target_folder: string; moves: PlannedMove[] }) => {
        insertBeforeStreaming({
          id: plan.id,
          role: "assistant",
          content: "",
          isOrganisePreview: true,
          planId: plan.id,
          targetFolder: plan.target_folder,
          moves: plan.moves ?? [],
          selectedFiles: Object.fromEntries(
            (plan.moves ?? []).map((m) => [m.file_name, true]),
          ),
        });
      },
    );
    wails.on(
      "organise-clarification",
      (data: { proposed_groupings?: ProposedGrouping[] }) => {
        insertBeforeStreaming({
          id: Date.now().toString(),
          role: "assistant",
          content: "",
          isClarification: true,
          proposedGroupings: data.proposed_groupings ?? [],
        });
      },
    );
    wails.on("organise-plan-error", (err: string) => {
      insertBeforeStreaming({
        id: Date.now().toString(),
        role: "assistant",
        content: `⚠️ ${err}`,
        isError: true,
      });
    });
    wails.on(
      "rename-plan-ready",
      (plan: { id: string; renames: PlannedRename[] }) => {
        insertBeforeStreaming({
          id: plan.id,
          role: "assistant",
          content: "",
          isRenamePreview: true,
          renamePlanId: plan.id,
          renames: plan.renames ?? [],
          renameSelections: Object.fromEntries(
            (plan.renames ?? []).map((r) => [
              r.file_name,
              { include: true, editedNewName: r.new_name },
            ]),
          ),
        });
      },
    );
    wails.on("rename-plan-error", (err: string) => {
      insertBeforeStreaming({
        id: Date.now().toString(),
        role: "assistant",
        content: `⚠️ ${err}`,
        isError: true,
      });
    });
    wails.on("chat-done", () => {
      setIsStreaming(false);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.streaming) {
          return [...prev.slice(0, -1), { ...last, streaming: false }];
        }
        return prev;
      });
    });
    wails.on("chat-error", (err: string) => {
      setIsStreaming(false);
      const { friendly, detail } = parseError(err);
      const retry = lastRequestRef.current;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        // Finalize the in-flight streaming bubble in place (keeps its
        // sources) instead of appending a separate error bubble.
        if (last?.role === "assistant" && last.streaming) {
          return [
            ...prev.slice(0, -1),
            {
              ...last,
              content: friendly,
              streaming: false,
              isError: true,
              errorDetail: detail,
              retryQuery: retry?.query,
              retryFileContext: retry?.fileContext,
            },
          ];
        }
        return [
          ...prev,
          {
            id: Date.now().toString(),
            role: "assistant",
            content: friendly,
            isError: true,
            errorDetail: detail,
            retryQuery: retry?.query,
            retryFileContext: retry?.fileContext,
          },
        ];
      });
    });
    return () => {
      wails.off("chat-token");
      wails.off("chat-sources");
      wails.off("chat-tool-start");
      wails.off("chat-search-results");
      wails.off("organise-plan-ready");
      wails.off("organise-clarification");
      wails.off("organise-plan-error");
      wails.off("rename-plan-ready");
      wails.off("rename-plan-error");
      wails.off("chat-done");
      wails.off("chat-error");
    };
  }, [sessionKey]);

  const triggerChat = (
    text: string,
    currentMessages: Message[],
    fileContext?: string,
  ) => {
    const q = text.trim();
    if (!q) return;

    const userMsg: Message = {
      id: Date.now().toString(),
      role: "user",
      content: q,
    };
    const assistantMsg: Message = {
      id: (Date.now() + 1).toString(),
      role: "assistant",
      content: "",
      streaming: true,
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setIsStreaming(true);

    const history = currentMessages
      .filter((m) => m.id !== "welcome" && !m.streaming)
      .map((m) => ({ role: m.role, content: m.content }));

    const resolvedFileContext = fileContext ?? targetFile ?? "";
    lastRequestRef.current = { query: q, fileContext: resolvedFileContext };
    wails.chatWithAgent(q, history, resolvedFileContext);
  };

  const handleRetry = (msg: Message) => {
    if (!msg.retryQuery || isStreaming || isOrganising) return;

    setMessages((prev) => {
      const withoutFailed = prev.filter((m) => m.id !== msg.id);
      const assistantMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: "",
        streaming: true,
      };
      const history = withoutFailed
        .filter((m) => m.id !== "welcome" && !m.streaming)
        .map((m) => ({ role: m.role, content: m.content }));
      lastRequestRef.current = {
        query: msg.retryQuery!,
        fileContext: msg.retryFileContext,
      };
      wails.chatWithAgent(msg.retryQuery!, history, msg.retryFileContext ?? "");
      return [...withoutFailed, assistantMsg];
    });
    setIsStreaming(true);
  };

  // Organise preview card: toggle one file's checkbox.
  const toggleOrganiseFile = (msgId: string, fileName: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId
          ? {
              ...m,
              selectedFiles: {
                ...m.selectedFiles,
                [fileName]: !m.selectedFiles?.[fileName],
              },
            }
          : m,
      ),
    );
  };

  const handleConfirmOrganise = async (msg: Message) => {
    if (!msg.planId) return;
    setIsOrganising(true);
    const selectedNames = Object.entries(msg.selectedFiles ?? {})
      .filter(([, selected]) => selected)
      .map(([name]) => name);
    try {
      const result = await wails.confirmOrganisePlan(msg.planId, selectedNames);
      const failedSuffix =
        result.failed && result.failed.length > 0
          ? `\n\n${result.failed.length} failed: ${result.failed.map((f) => f.file_name).join(", ")}`
          : "";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id
            ? {
                ...m,
                organiseDone: true,
                content: result.error
                  ? `⚠️ ${result.error}`
                  : result.moved.length > 0
                    ? `Moved ${result.moved.length} file${result.moved.length !== 1 ? "s" : ""} to "${result.folder_name}":\n${result.moved.map((f) => `• ${f}`).join("\n")}${failedSuffix}`
                    : `No files were moved.${failedSuffix}`,
              }
            : m,
        ),
      );
    } catch (e) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id
            ? { ...m, organiseDone: true, content: `⚠️ Confirm failed: ${String(e)}` }
            : m,
        ),
      );
    } finally {
      setIsOrganising(false);
    }
  };

  const handleCancelOrganise = async (msg: Message) => {
    if (!msg.planId) return;
    try {
      await wails.cancelOrganisePlan(msg.planId);
    } catch {
      // A missing/expired plan is a no-op server-side anyway.
    }
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msg.id
          ? { ...m, organiseDone: true, content: "Cancelled — nothing was moved." }
          : m,
      ),
    );
  };

  // The sidecar may not emit an "organise-plan-ready"/"-clarification" event
  // for this call if build_plan errored outright (e.g. no matching files) —
  // that comes back as `preview.error` on the resolved promise instead, so
  // it has to be checked here rather than relying purely on events.
  const handlePickGrouping = async (grouping: ProposedGrouping) => {
    try {
      const preview = await wails.proposeOrganise(
        `Organise files into a folder called "${grouping.folder_name}" — ${grouping.description}`,
        currentFolder,
      );
      if (preview.error) {
        setMessages((prev) => [
          ...prev,
          { id: Date.now().toString(), role: "assistant", content: `⚠️ ${preview.error}`, isError: true },
        ]);
      }
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { id: Date.now().toString(), role: "assistant", content: `⚠️ ${String(e)}`, isError: true },
      ]);
    }
  };

  // Rename preview card: toggle one row's checkbox / edit its new name.
  const toggleRenameInclude = (msgId: string, fileName: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId
          ? {
              ...m,
              renameSelections: {
                ...m.renameSelections,
                [fileName]: {
                  ...(m.renameSelections?.[fileName] ?? { include: true, editedNewName: "" }),
                  include: !(m.renameSelections?.[fileName]?.include ?? true),
                },
              },
            }
          : m,
      ),
    );
  };

  const editRenameNewName = (msgId: string, fileName: string, newName: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId
          ? {
              ...m,
              renameSelections: {
                ...m.renameSelections,
                [fileName]: {
                  ...(m.renameSelections?.[fileName] ?? { include: true, editedNewName: "" }),
                  editedNewName: newName,
                },
              },
            }
          : m,
      ),
    );
  };

  const handleConfirmRename = async (msg: Message) => {
    if (!msg.renamePlanId) return;
    // Reuses the organise busy flag — rename and organise confirm/cancel
    // actions are never expected to run concurrently, so one flag covers
    // both rather than adding a near-duplicate piece of state.
    setIsOrganising(true);
    const selections: RenameSelection[] = (msg.renames ?? []).map((r) => {
      const sel = msg.renameSelections?.[r.file_name];
      return {
        file_name: r.file_name,
        include: sel?.include ?? true,
        edited_new_name: sel && sel.editedNewName !== r.new_name ? sel.editedNewName : undefined,
      };
    });
    try {
      const result = await wails.confirmRenamePlan(msg.renamePlanId, selections);
      const failedSuffix =
        result.failed && result.failed.length > 0
          ? `\n\n${result.failed.length} failed: ${result.failed.map((f) => f.file_name).join(", ")}`
          : "";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id
            ? {
                ...m,
                renameDone: true,
                content: result.error
                  ? `⚠️ ${result.error}`
                  : result.renamed.length > 0
                    ? `Renamed ${result.renamed.length} file${result.renamed.length !== 1 ? "s" : ""}:\n${result.renamed.map((r) => `• ${r.original} → ${r.final}`).join("\n")}${failedSuffix}`
                    : `No files were renamed.${failedSuffix}`,
              }
            : m,
        ),
      );
    } catch (e) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id
            ? { ...m, renameDone: true, content: `⚠️ Confirm failed: ${String(e)}` }
            : m,
        ),
      );
    } finally {
      setIsOrganising(false);
    }
  };

  const handleCancelRename = async (msg: Message) => {
    if (!msg.renamePlanId) return;
    try {
      await wails.cancelRenamePlan(msg.renamePlanId);
    } catch {
      // A missing/expired plan is a no-op server-side anyway.
    }
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msg.id
          ? { ...m, renameDone: true, content: "Cancelled — nothing was renamed." }
          : m,
      ),
    );
  };

  const handleBackfill = async () => {
    if (backfilling) return;
    setBackfilling(true);
    const pendingMsg: Message = {
      id: Date.now().toString(),
      role: "assistant",
      content: "⏳ Backfilling AI profiles for files indexed before this feature existed…",
      isOrganise: true,
    };
    setMessages((prev) => [...prev, pendingMsg]);
    try {
      const result = await wails.backfillFileProfiles();
      setMessages((prev) => [
        ...prev.slice(0, -1),
        {
          id: Date.now().toString(),
          role: "assistant",
          isOrganise: true,
          content: `Backfill complete — ${result.enriched} profiled, ${result.skipped} skipped, ${result.failed} failed.`,
        },
      ]);
    } catch (e) {
      setMessages((prev) => [
        ...prev.slice(0, -1),
        { id: Date.now().toString(), role: "assistant", content: `⚠️ Backfill failed: ${String(e)}` },
      ]);
    } finally {
      setBackfilling(false);
    }
  };

  // "Undo"/"revert" is handled by direct keyword match, not routed through
  // chat — none of the chat tools have a concept of "undo the last move",
  // so letting it through to the model would just misfire as a fresh
  // organise request. This is reliable and instant.
  const triggerUndo = async (requestText: string) => {
    setIsOrganising(true);
    const userMsg: Message = {
      id: Date.now().toString(),
      role: "user",
      content: requestText,
    };
    const pendingMsg: Message = {
      id: (Date.now() + 1).toString(),
      role: "assistant",
      content: "⏳ Undoing the last organise…",
      isOrganise: true,
    };
    setMessages((prev) => [...prev, userMsg, pendingMsg]);
    try {
      const result = await wails.undoLastOrganise();
      const doneMsg: Message = {
        id: Date.now().toString(),
        role: "assistant",
        isOrganise: true,
        content: result.error
          ? `⚠️ ${result.error === "nothing to undo" ? "There's nothing to undo — no organise action is on record." : result.error}`
          : result.files && result.files.length > 0
            ? `✅ Restored ${result.files.length} file${result.files.length !== 1 ? "s" : ""} to where they were:\n${result.files.map((f: string) => `• ${f}`).join("\n")}`
            : `⚠️ Nothing was restored — the files may have already been moved again.`,
      };
      setMessages((prev) => [...prev.slice(0, -1), doneMsg]);
    } catch (e) {
      setMessages((prev) => [
        ...prev.slice(0, -1),
        {
          id: Date.now().toString(),
          role: "assistant",
          content: `⚠️ Undo failed: ${String(e)}`,
        },
      ]);
    } finally {
      setIsOrganising(false);
    }
  };

  const handleSend = async () => {
    const q = input.trim();
    if (!q || isStreaming || isOrganising) return;
    setInput("");

    if (UNDO_RE.test(q)) {
      await triggerUndo(q);
      return;
    }

    // Organise-intent detection now happens inside /search/chat's own
    // tool-calling loop (propose_reorganisation), not as a pre-check here.
    triggerChat(q, messages);
  };

  if (!open) return null;

  const busy = isStreaming || isOrganising;

  const placeholderText = () => {
    if (isOrganising) return "Organising files…";
    if (targetFile) return `Ask about ${targetFile}…`;
    return "Ask about files, or say 'group all images into photos'…";
  };

  return (
    <div
      className="flex flex-col h-full min-h-0 shrink-0 bg-[#1a1a1a] border-l border-[#3e3e42] min-w-0"
      style={
        expanded
          ? { flex: "1 1 auto", minWidth: 0 }
          : { width: 360, minWidth: 360, maxWidth: 360 }
      }
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 h-12 border-b border-[#3e3e42] shrink-0">
        <Sparkles size={14} className="text-indigo-400 shrink-0" />
        <span className="text-sm font-medium text-[#d4d4d4]">
          Duckietown AI
        </span>

        <button
          onClick={handleBackfill}
          disabled={backfilling}
          title="Backfill AI profiles for files indexed before this feature existed"
          className="ml-auto text-[#4a4a4a] hover:text-[#d4d4d4] transition-colors shrink-0 disabled:opacity-40"
        >
          {backfilling ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <RefreshCw size={13} />
          )}
        </button>
        <button
          onClick={onToggleExpand}
          title={expanded ? "Collapse" : "Expand to full width"}
          className="text-[#4a4a4a] hover:text-[#d4d4d4] transition-colors shrink-0"
        >
          {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
        <button
          onClick={onClose}
          className="text-[#4a4a4a] hover:text-[#d4d4d4] transition-colors shrink-0"
        >
          <X size={14} />
        </button>
      </div>

      {/* File context bar */}
      {targetFile && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[#3e3e42] bg-[#202020] shrink-0 min-w-0">
          <FileTypeIcon name={targetFile} size={14} className="shrink-0" />
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-xs text-[#a0a0a0] truncate min-w-0 flex-1">
                  {targetFile}
                </span>
              </TooltipTrigger>
              <TooltipContent className="text-xs font-mono">
                {targetFile}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <button
            onClick={onClearTargetFile}
            title="Clear file context — ask about the whole vault"
            className="text-[#4a4a4a] hover:text-[#d4d4d4] transition-colors shrink-0"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollWrapRef} className="flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div
            className={`flex flex-col gap-4 p-4 pb-2 min-w-0 ${expanded ? "mx-auto max-w-3xl" : ""}`}
          >
            {messages.map((msg) =>
              msg.isOrganisePreview ? (
                <OrganisePreviewCard
                  key={msg.id}
                  message={msg}
                  busy={isOrganising}
                  onToggleFile={toggleOrganiseFile}
                  onConfirm={handleConfirmOrganise}
                  onCancel={handleCancelOrganise}
                />
              ) : msg.isRenamePreview ? (
                <RenamePreviewCard
                  key={msg.id}
                  message={msg}
                  busy={isOrganising}
                  onToggleInclude={toggleRenameInclude}
                  onEditName={editRenameNewName}
                  onConfirm={handleConfirmRename}
                  onCancel={handleCancelRename}
                />
              ) : msg.isClarification ? (
                <ClarificationCard
                  key={msg.id}
                  message={msg}
                  busy={isOrganising}
                  onPick={handlePickGrouping}
                />
              ) : (
                <MessageBubble key={msg.id} message={msg} onRetry={handleRetry} />
              ),
            )}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>
      </div>

      {/* Input */}
      <div className="border-t border-[#3e3e42] p-3 shrink-0">
        <div className="flex items-center gap-2 bg-[#252526] border border-[#3e3e42] rounded-lg px-3 py-2 focus-within:border-indigo-500/50 transition-colors">
          {isOrganising ? (
            <FolderPlus
              size={13}
              className="text-indigo-400 animate-pulse shrink-0"
            />
          ) : (
            <Sparkles size={13} className="text-[#3a3a3a] shrink-0" />
          )}
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={placeholderText()}
            disabled={busy}
            className="flex-1 min-w-0 bg-transparent border-none outline-none text-sm text-[#d4d4d4] placeholder:text-[#3a3a3a] disabled:opacity-50"
          />
          <Button
            variant="ghost"
            size="icon"
            className="w-7 h-7 shrink-0"
            onClick={handleSend}
            disabled={!input.trim() || busy}
          >
            {busy ? (
              <Loader2 size={13} className="animate-spin text-indigo-400" />
            ) : (
              <Send size={13} />
            )}
          </Button>
        </div>
        <p className="text-[10px] text-[#3a3a3a] mt-1.5 text-center truncate">
          {chatModel ? humanizeModel(chatModel) : "AI"} · ask questions or
          organise files with natural language
        </p>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  onRetry,
}: {
  message: Message;
  onRetry: (msg: Message) => void;
}) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const isUser = message.role === "user";

  return (
    <div className={`flex gap-2 min-w-0 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      <div
        className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5
        ${
          isUser
            ? "bg-indigo-500/20"
            : message.isError
              ? "bg-amber-500/15 border border-amber-500/30"
              : message.isOrganise
                ? "bg-emerald-500/20 border border-emerald-500/30"
                : "bg-[#2d2d30] border border-[#3e3e42]"
        }`}
      >
        {isUser ? (
          <User size={11} className="text-indigo-400" />
        ) : message.isError ? (
          <AlertTriangle size={11} className="text-amber-400" />
        ) : message.isOrganise ? (
          <FolderPlus size={11} className="text-emerald-400" />
        ) : (
          <Bot size={11} className="text-[#6a6a6a]" />
        )}
      </div>
      <div
        className={`flex flex-col gap-1 max-w-[82%] min-w-0 ${isUser ? "items-end" : "items-start"}`}
      >
        <div
          className={`rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere] min-w-0 max-w-full overflow-x-auto
          ${
            isUser
              ? "bg-indigo-500/20 text-[#d4d4d4] border border-indigo-500/20"
              : message.isError
                ? "bg-amber-500/10 text-[#d4d4d4] border border-amber-500/20"
                : message.isOrganise
                  ? "bg-emerald-500/10 text-[#d4d4d4] border border-emerald-500/20"
                  : "bg-[#252526] text-[#d4d4d4] border border-[#3e3e42]"
          }`}
        >
          {message.content ? (
            isUser ? (
              message.content
            ) : (
              <div className="[&>*:last-child]:mb-0">
                <ReactMarkdown components={markdownComponents}>
                  {message.content}
                </ReactMarkdown>
              </div>
            )
          ) : message.toolLabel ? (
            <span className="flex gap-1.5 items-center text-[#8a8a90]">
              <Loader2 size={11} className="animate-spin text-indigo-400 shrink-0" />
              {message.toolLabel}
            </span>
          ) : (
            <span className="flex gap-1 items-center">
              <span
                className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce"
                style={{ animationDelay: "0ms" }}
              />
              <span
                className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce"
                style={{ animationDelay: "150ms" }}
              />
              <span
                className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce"
                style={{ animationDelay: "300ms" }}
              />
            </span>
          )}
        </div>

        {!isUser && message.fileResults && message.fileResults.length > 0 && (
          <div className="w-full flex flex-col gap-1">
            {message.fileResults.map((f) => (
              <button
                key={f.file_name}
                onClick={() => wails.openFile(f.file_name)}
                title="Open file"
                className="flex items-start gap-2 text-left text-[11px] px-2 py-1.5 bg-[#2d2d30] border border-[#3e3e42] rounded hover:border-indigo-500/40 transition-colors min-w-0"
              >
                <FileTypeIcon
                  name={f.file_name}
                  mime={f.mime_type}
                  size={16}
                  className="shrink-0 mt-0.5"
                />
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="font-medium text-[#d4d4d4] truncate">{f.file_name}</span>
                    {f.folder_path && (
                      <span className="text-[9px] text-[#6a6a6a] truncate shrink-0">
                        in {f.folder_path}
                      </span>
                    )}
                  </span>
                  {(f.summary || f.snippet) && (
                    <span className="block text-[10px] text-[#8a8a90] line-clamp-2 mt-0.5">
                      {f.summary || f.snippet}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-[9px] font-mono text-indigo-400/70 mt-0.5">
                  {Math.round(f.score * 100)}%
                </span>
              </button>
            ))}
          </div>
        )}

        {message.isError && (
          <div className="w-full flex items-center gap-2">
            {message.retryQuery && (
              <button
                onClick={() => onRetry(message)}
                className="flex items-center gap-1 text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                <RotateCcw size={9} />
                Retry
              </button>
            )}
            {message.errorDetail && (
              <button
                onClick={() => setDetailsOpen((v) => !v)}
                className="flex items-center gap-1 text-[10px] text-[#4a4a4a] hover:text-[#6a6a6a] transition-colors"
              >
                Details
                {detailsOpen ? <ChevronUp size={9} /> : <ChevronDown size={9} />}
              </button>
            )}
          </div>
        )}
        {message.isError && detailsOpen && message.errorDetail && (
          <div className="w-full text-[10px] font-mono text-[#6a6a6a] bg-[#2d2d30] border border-[#3e3e42] rounded px-2 py-1.5 [overflow-wrap:anywhere] min-w-0">
            {message.errorDetail}
          </div>
        )}

        {message.sources && message.sources.length > 0 && (
          <div className="w-full">
            <button
              onClick={() => setSourcesOpen((v) => !v)}
              className="flex items-center gap-1 text-[10px] text-[#4a4a4a] hover:text-[#6a6a6a] transition-colors"
            >
              <FileText size={9} />
              {message.sources.length} source
              {message.sources.length !== 1 ? "s" : ""}
              {sourcesOpen ? <ChevronUp size={9} /> : <ChevronDown size={9} />}
            </button>
            {sourcesOpen && (
              <div className="mt-1 flex flex-col gap-0.5">
                {message.sources.map((s) => (
                  <div
                    key={s.file_name}
                    className="flex items-center justify-between text-[10px] px-2 py-1 bg-[#2d2d30] border border-[#3e3e42] rounded text-[#6a6a6a] min-w-0"
                  >
                    <span className="truncate mr-2">{s.file_name}</span>
                    <span className="shrink-0 text-[9px] font-mono text-indigo-400/70">
                      {Math.round(s.similarity * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Organise preview card: "Move N files to <folder>?" with per-file
// checkboxes (default all checked). Nothing moves until Confirm. ──────────

function OrganisePreviewCard({
  message,
  busy,
  onToggleFile,
  onConfirm,
  onCancel,
}: {
  message: Message;
  busy: boolean;
  onToggleFile: (msgId: string, fileName: string) => void;
  onConfirm: (msg: Message) => void;
  onCancel: (msg: Message) => void;
}) {
  const moves = message.moves ?? [];
  const selected = message.selectedFiles ?? {};
  const selectedCount = moves.filter((m) => selected[m.file_name]).length;

  if (message.organiseDone) {
    return (
      <div className="flex gap-2 min-w-0">
        <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 bg-emerald-500/20 border border-emerald-500/30">
          <FolderPlus size={11} className="text-emerald-400" />
        </div>
        <div className="rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words max-w-[82%] bg-emerald-500/10 text-[#d4d4d4] border border-emerald-500/20">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2 min-w-0">
      <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 bg-emerald-500/20 border border-emerald-500/30">
        <FolderPlus size={11} className="text-emerald-400" />
      </div>
      <div className="flex flex-col gap-2 max-w-[82%] min-w-0 rounded-xl px-3 py-2.5 bg-emerald-500/10 border border-emerald-500/20">
        <p className="text-xs text-[#d4d4d4]">
          Move {selectedCount} file{selectedCount !== 1 ? "s" : ""} to &ldquo;
          {message.targetFolder}&rdquo;?
        </p>
        <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
          {moves.length === 0 ? (
            <p className="text-[11px] text-[#6a6a6a]">No files matched.</p>
          ) : (
            moves.map((m) => (
              <label
                key={m.file_name}
                className="flex items-start gap-2 text-[11px] px-2 py-1 bg-black/15 rounded cursor-pointer min-w-0"
              >
                <input
                  type="checkbox"
                  checked={!!selected[m.file_name]}
                  onChange={() => onToggleFile(message.id, m.file_name)}
                  className="mt-0.5 accent-emerald-500"
                />
                <span className="flex-1 min-w-0">
                  <span className="text-[#d4d4d4] block truncate">{m.file_name}</span>
                  <span className="text-[#8a8a90] block truncate">{m.reason}</span>
                </span>
              </label>
            ))
          )}
        </div>
        <div className="flex items-center gap-2 mt-1">
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={busy || selectedCount === 0}
            onClick={() => onConfirm(message)}
          >
            Confirm
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            disabled={busy}
            onClick={() => onCancel(message)}
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Rename preview card: old name -> new name per row, inline-editable,
// checkbox per row (default all checked). Nothing renames until Confirm. ──

function RenamePreviewCard({
  message,
  busy,
  onToggleInclude,
  onEditName,
  onConfirm,
  onCancel,
}: {
  message: Message;
  busy: boolean;
  onToggleInclude: (msgId: string, fileName: string) => void;
  onEditName: (msgId: string, fileName: string, newName: string) => void;
  onConfirm: (msg: Message) => void;
  onCancel: (msg: Message) => void;
}) {
  const renames = message.renames ?? [];
  const selections = message.renameSelections ?? {};
  const selectedCount = renames.filter((r) => selections[r.file_name]?.include ?? true).length;

  if (message.renameDone) {
    return (
      <div className="flex gap-2 min-w-0">
        <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 bg-emerald-500/20 border border-emerald-500/30">
          <FolderPlus size={11} className="text-emerald-400" />
        </div>
        <div className="rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words max-w-[82%] bg-emerald-500/10 text-[#d4d4d4] border border-emerald-500/20">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2 min-w-0">
      <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 bg-emerald-500/20 border border-emerald-500/30">
        <FolderPlus size={11} className="text-emerald-400" />
      </div>
      <div className="flex flex-col gap-2 max-w-[82%] min-w-0 rounded-xl px-3 py-2.5 bg-emerald-500/10 border border-emerald-500/20">
        <p className="text-xs text-[#d4d4d4]">
          Rename {selectedCount} file{selectedCount !== 1 ? "s" : ""}?
        </p>
        <div className="flex flex-col gap-1 max-h-56 overflow-y-auto">
          {renames.length === 0 ? (
            <p className="text-[11px] text-[#6a6a6a]">No files matched.</p>
          ) : (
            renames.map((r) => {
              const sel = selections[r.file_name] ?? { include: true, editedNewName: r.new_name };
              return (
                <div
                  key={r.file_name}
                  className="flex items-start gap-2 text-[11px] px-2 py-1 bg-black/15 rounded min-w-0"
                >
                  <input
                    type="checkbox"
                    checked={sel.include}
                    onChange={() => onToggleInclude(message.id, r.file_name)}
                    className="mt-0.5 accent-emerald-500"
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-[#8a8a90] block truncate">{r.old_name}</span>
                    <input
                      type="text"
                      value={sel.editedNewName}
                      onChange={(e) => onEditName(message.id, r.file_name, e.target.value)}
                      disabled={!sel.include}
                      className="w-full bg-[#1a1a1a] border border-[#3e3e42] rounded px-1.5 py-0.5 text-[#d4d4d4] text-[11px] mt-0.5 disabled:opacity-40"
                    />
                    {r.extension_changed && (
                      <span className="text-amber-400 block mt-0.5">⚠ extension will change</span>
                    )}
                    <span className="text-[#8a8a90] block truncate mt-0.5">{r.reason}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
        <div className="flex items-center gap-2 mt-1">
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={busy || selectedCount === 0}
            onClick={() => onConfirm(message)}
          >
            Confirm
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            disabled={busy}
            onClick={() => onCancel(message)}
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Clarification card: shown when an organise instruction was too vague
// to act on — 2-4 proposed groupings to pick from instead of guessing. ────

function ClarificationCard({
  message,
  busy,
  onPick,
}: {
  message: Message;
  busy: boolean;
  onPick: (grouping: ProposedGrouping) => void;
}) {
  return (
    <div className="flex gap-2 min-w-0">
      <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 bg-[#2d2d30] border border-[#3e3e42]">
        <Bot size={11} className="text-[#6a6a6a]" />
      </div>
      <div className="flex flex-col gap-2 max-w-[82%] min-w-0">
        <p className="rounded-xl px-3 py-2 text-xs leading-relaxed bg-[#252526] text-[#d4d4d4] border border-[#3e3e42]">
          That's a bit broad — here are a few ways I could group things. Pick one:
        </p>
        <div className="flex flex-col gap-1.5">
          {(message.proposedGroupings ?? []).map((g) => (
            <button
              key={g.folder_name}
              disabled={busy}
              onClick={() => onPick(g)}
              className="text-left text-[11px] px-2.5 py-2 bg-[#252526] border border-[#3e3e42] rounded-lg hover:border-indigo-500/40 transition-colors disabled:opacity-50 min-w-0"
            >
              <span className="font-medium text-[#d4d4d4] block truncate">{g.folder_name}</span>
              <span className="block text-[#8a8a90] mt-0.5">{g.description}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
