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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { wails } from "../lib/wails";

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
}

interface Props {
  open: boolean;
  onClose: () => void;
  targetFile?: string | null;
  sessionKey: number;
  currentFolder: string;
}

export function AIPanel({
  open,
  onClose,
  targetFile,
  sessionKey,
  currentFolder,
}: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isOrganising, setIsOrganising] = useState(false);
  const [isParsingIntent, setIsParsingIntent] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fresh state on every open
  useEffect(() => {
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
      setTimeout(() => {
        triggerChat(`Summarise ${targetFile}`, [], targetFile);
      }, 400);
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
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: "assistant",
          content: `⚠️ ${err}`,
        },
      ]);
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

    wails.chatWithAgent(q, history, fileContext ?? targetFile ?? "");
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

    // Ask Gemma to parse intent — is this an organise request?
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
      // Intent parse failed — fall through to chat
    }

    // Regular chat
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
      className="flex flex-col bg-[#1a1a1a] border-l border-[#3e3e42]"
      style={{ width: 360, minWidth: 360, maxWidth: 360 }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 h-12 border-b border-[#3e3e42] shrink-0">
        <Sparkles size={14} className="text-indigo-400 shrink-0" />
        <span className="text-sm font-medium text-[#d4d4d4]">
          Duckietown AI
        </span>
        {targetFile && (
          <Badge
            variant="outline"
            className="text-[9px] font-mono ml-1 h-4 px-1.5 max-w-[120px] truncate"
          >
            {targetFile}
          </Badge>
        )}
        {currentFolder && (
          <Badge
            variant="outline"
            className="text-[9px] font-mono ml-1 h-4 px-1.5 max-w-[100px] truncate text-indigo-400/70"
          >
            {currentFolder}
          </Badge>
        )}
        <button
          onClick={onClose}
          className="ml-auto text-[#4a4a4a] hover:text-[#d4d4d4] transition-colors shrink-0"
        >
          <X size={14} />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-4 p-4 pb-2">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
            {/* Intent parsing indicator */}
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
            className="flex-1 bg-transparent border-none outline-none text-sm text-[#d4d4d4] placeholder:text-[#3a3a3a] disabled:opacity-50"
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
        <p className="text-[10px] text-[#3a3a3a] mt-1.5 text-center">
          Gemma 3 · ask questions or organise files with natural language
        </p>
      </div>
    </div>
  );
}

// ── Message bubble ─────────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const isUser = message.role === "user";

  return (
    <div className={`flex gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      <div
        className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5
          ${
            isUser
              ? "bg-indigo-500/20"
              : message.isOrganise
                ? "bg-emerald-500/20 border border-emerald-500/30"
                : "bg-[#2d2d30] border border-[#3e3e42]"
          }`}
      >
        {isUser ? (
          <User size={11} className="text-indigo-400" />
        ) : message.isOrganise ? (
          <FolderPlus size={11} className="text-emerald-400" />
        ) : (
          <Bot size={11} className="text-[#6a6a6a]" />
        )}
      </div>

      <div
        className={`flex flex-col gap-1 max-w-[82%] ${isUser ? "items-end" : "items-start"}`}
      >
        <div
          className={`rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words
            ${
              isUser
                ? "bg-indigo-500/20 text-[#d4d4d4] border border-indigo-500/20"
                : message.isOrganise
                  ? "bg-emerald-500/10 text-[#d4d4d4] border border-emerald-500/20"
                  : "bg-[#252526] text-[#d4d4d4] border border-[#3e3e42]"
            }`}
        >
          {message.content || (
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
                    className="flex items-center justify-between text-[10px] px-2 py-1 bg-[#2d2d30] border border-[#3e3e42] rounded text-[#6a6a6a]"
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
