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
}

interface Props {
  open: boolean;
  onClose: () => void;
  targetFile?: string | null;
  sessionKey: number;
  currentFolder: string;
  onClearTargetFile?: () => void;
}

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
}: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isOrganising, setIsOrganising] = useState(false);
  const [isParsingIntent, setIsParsingIntent] = useState(false);
  const [chatModel, setChatModel] = useState(cachedChatModel);
  const bottomRef = useRef<HTMLDivElement>(null);
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
        ? `I'll help you with **${targetFile}**. Ask me to summarise it or ask any question about its content.\n\nYou can also ask me to organise files — for example:\n• _"Group all image files into a folder called photos"_\n• _"Move all legal documents into a folder named legal"_`
        : `Ask me anything about your files, or ask me to organise them.\n\nExamples:\n• _"What does the Q3 report say about revenue?"_\n• _"Summarise sample.pdf"_\n• _"Group all images into a folder called photos"_\n• _"Move all legal documents into legal"_`,
    };
    setMessages([welcome]);
    setInput("");
    setIsStreaming(false);
    setIsOrganising(false);
    setIsParsingIntent(false);
    setTimeout(() => inputRef.current?.focus(), 100);

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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Wire Wails streaming events
  useEffect(() => {
    wails.on("chat-token", (data: { content: string }) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          return [
            ...prev.slice(0, -1),
            { ...last, content: last.content + data.content },
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
    if (!msg.retryQuery || isStreaming || isOrganising || isParsingIntent) return;

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

  const triggerOrganise = async (
    query: string,
    folderName: string,
    typeFilter: string,
  ) => {
    setIsOrganising(true);
    const userMsg: Message = {
      id: Date.now().toString(),
      role: "user",
      content: `Organise files matching "${query}" into a folder called "${folderName}"`,
    };
    const pendingMsg: Message = {
      id: (Date.now() + 1).toString(),
      role: "assistant",
      content: `⏳ Searching for files${typeFilter ? ` (${typeFilter} files)` : ""} matching "${query}" and creating folder "${folderName}"…`,
      isOrganise: true,
    };
    setMessages((prev) => [...prev, userMsg, pendingMsg]);
    try {
      const result = await wails.organiseFolder(
        currentFolder,
        query,
        folderName,
        typeFilter ?? "",
      );
      const doneMsg: Message = {
        id: Date.now().toString(),
        role: "assistant",
        isOrganise: true,
        content: result.error
          ? `⚠️ ${result.error}`
          : result.files && result.files.length > 0
            ? `✅ Created folder **"${result.folder_name}"** and moved ${result.files.length} file${result.files.length !== 1 ? "s" : ""}:\n${result.files.map((f: string) => `• ${f}`).join("\n")}`
            : `✅ Created folder **"${result.folder_name}"** but no matching files were found to move.`,
      };
      setMessages((prev) => [...prev.slice(0, -1), doneMsg]);
    } catch (e) {
      setMessages((prev) => [
        ...prev.slice(0, -1),
        {
          id: Date.now().toString(),
          role: "assistant",
          content: `⚠️ Organisation failed: ${String(e)}`,
        },
      ]);
    } finally {
      setIsOrganising(false);
    }
  };

  const handleSend = async () => {
    const q = input.trim();
    if (!q || isStreaming || isOrganising || isParsingIntent) return;
    setInput("");

    setIsParsingIntent(true);
    try {
      const intent = await wails.parseOrganiseIntent(q);
      setIsParsingIntent(false);
      if (intent.is_organise && intent.folder_name) {
        await triggerOrganise(
          intent.query ?? q,
          intent.folder_name,
          intent.type_filter ?? "",
        );
        return;
      }
    } catch {
      setIsParsingIntent(false);
    }

    triggerChat(q, messages);
  };

  if (!open) return null;

  const busy = isStreaming || isOrganising || isParsingIntent;

  const placeholderText = () => {
    if (isOrganising) return "Organising files…";
    if (isParsingIntent) return "Understanding request…";
    if (targetFile) return `Ask about ${targetFile}…`;
    return "Ask about files, or say 'group all images into photos'…";
  };

  return (
    <div
      className="flex flex-col bg-[#1a1a1a] border-l border-[#3e3e42] min-w-0"
      style={{ width: 360, minWidth: 360, maxWidth: 360 }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 h-12 border-b border-[#3e3e42] shrink-0">
        <Sparkles size={14} className="text-indigo-400 shrink-0" />
        <span className="text-sm font-medium text-[#d4d4d4]">
          Duckietown AI
        </span>

        <button
          onClick={onClose}
          className="ml-auto text-[#4a4a4a] hover:text-[#d4d4d4] transition-colors shrink-0"
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
      <div className="flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-4 p-4 pb-2 min-w-0">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} onRetry={handleRetry} />
            ))}
            {isParsingIntent && (
              <div className="flex gap-2 items-center text-[11px] text-[#4a4a4a]">
                <Loader2 size={11} className="animate-spin text-indigo-400" />
                Understanding your request…
              </div>
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
          className={`rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere] min-w-0
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
