// import { useState, useRef, useEffect } from "react";
// import {
//   Sparkles,
//   X,
//   Send,
//   Bot,
//   User,
//   FileText,
//   ChevronDown,
//   ChevronUp,
//   Loader2,
// } from "lucide-react";
// import { Button } from "@/components/ui/button";
// import { ScrollArea } from "@/components/ui/scroll-area";
// import { Badge } from "@/components/ui/badge";
// import { wails } from "../lib/wails";

// interface SourceFile {
//   file_name: string;
//   similarity: number;
// }

// interface Message {
//   id: string;
//   role: "user" | "assistant";
//   content: string;
//   sources?: SourceFile[];
//   streaming?: boolean;
// }

// interface Props {
//   open: boolean;
//   onClose: () => void;
//   // If set, the panel opens pre-loaded to summarise this file
//   targetFile?: string | null;
// }

// export function AIPanel({ open, onClose, targetFile }: Props) {
//   const [messages, setMessages] = useState<Message[]>([]);
//   const [input, setInput] = useState("");
//   const [isStreaming, setIsStreaming] = useState(false);
//   const bottomRef = useRef<HTMLDivElement>(null);
//   const inputRef = useRef<HTMLInputElement>(null);

//   // Reset chat when panel opens fresh
//   useEffect(() => {
//     if (open) {
//       setMessages([
//         {
//           id: "welcome",
//           role: "assistant",
//           content: targetFile
//             ? `I'll help you with **${targetFile}**. Ask me to summarise it or ask any question about its content.`
//             : "Ask me anything about your files — I can summarise documents, answer questions about their content, or help you find specific information.",
//         },
//       ]);
//       setInput("");
//       setTimeout(() => inputRef.current?.focus(), 100);

//       // Auto-summarise if a target file was passed
//       if (targetFile) {
//         setTimeout(() => {
//           sendMessage(`Summarise ${targetFile}`, targetFile);
//         }, 300);
//       }
//     }
//   }, [open, targetFile]);

//   // Scroll to bottom on new content
//   useEffect(() => {
//     bottomRef.current?.scrollIntoView({ behavior: "smooth" });
//   }, [messages]);

//   // Wire Wails events
//   useEffect(() => {
//     wails.on("chat-token", (data: { content: string }) => {
//       setMessages((prev) => {
//         const last = prev[prev.length - 1];
//         if (last?.role === "assistant" && last.streaming) {
//           return [
//             ...prev.slice(0, -1),
//             { ...last, content: last.content + data.content },
//           ];
//         }
//         return prev;
//       });
//     });

//     wails.on("chat-sources", (files: SourceFile[]) => {
//       setMessages((prev) => {
//         const last = prev[prev.length - 1];
//         if (last?.role === "assistant") {
//           return [...prev.slice(0, -1), { ...last, sources: files }];
//         }
//         return prev;
//       });
//     });

//     wails.on("chat-done", () => {
//       setIsStreaming(false);
//       setMessages((prev) => {
//         const last = prev[prev.length - 1];
//         if (last?.streaming) {
//           return [...prev.slice(0, -1), { ...last, streaming: false }];
//         }
//         return prev;
//       });
//     });

//     wails.on("chat-error", (err: string) => {
//       setIsStreaming(false);
//       setMessages((prev) => [
//         ...prev,
//         { id: Date.now().toString(), role: "assistant", content: `⚠️ ${err}` },
//       ]);
//     });

//     return () => {
//       wails.off("chat-token");
//       wails.off("chat-sources");
//       wails.off("chat-done");
//       wails.off("chat-error");
//     };
//   }, []);

//   const sendMessage = (text: string, fileContext?: string) => {
//     const q = text.trim();
//     if (!q || isStreaming) return;

//     const userMsg: Message = {
//       id: Date.now().toString(),
//       role: "user",
//       content: q,
//     };
//     const assistantMsg: Message = {
//       id: (Date.now() + 1).toString(),
//       role: "assistant",
//       content: "",
//       streaming: true,
//     };

//     setMessages((prev) => [...prev, userMsg, assistantMsg]);
//     setIsStreaming(true);

//     const history = messages
//       .filter((m) => m.id !== "welcome" && !m.streaming)
//       .map((m) => ({ role: m.role, content: m.content }));

//     wails.chatWithAgent(q, history, fileContext ?? targetFile ?? "");
//   };

//   const handleSend = () => {
//     sendMessage(input);
//     setInput("");
//   };

//   if (!open) return null;

//   return (
//     <div
//       className="flex flex-col bg-[#1a1a1a] border-l border-[#3e3e42] animate-in slide-in-from-right duration-200"
//       style={{ width: 360, minWidth: 360 }}
//     >
//       {/* Header */}
//       <div className="flex items-center gap-2 px-4 h-12 border-b border-[#3e3e42] shrink-0">
//         <Sparkles size={14} className="text-indigo-400" />
//         <span className="text-sm font-medium text-[#d4d4d4]">
//           Duckietown AI
//         </span>
//         {targetFile && (
//           <Badge
//             variant="outline"
//             className="text-[9px] font-mono ml-1 h-4 px-1.5 max-w-[120px] truncate"
//           >
//             {targetFile}
//           </Badge>
//         )}
//         <button
//           onClick={() => {
//             onClose();
//           }}
//           className="ml-auto text-[#4a4a4a] hover:text-[#d4d4d4] transition-colors"
//         >
//           <X size={14} />
//         </button>
//       </div>

//       {/* Messages */}
//       <ScrollArea className="flex-1">
//         <div className="flex flex-col gap-4 p-4">
//           {messages.map((msg) => (
//             <MessageBubble key={msg.id} message={msg} />
//           ))}
//           <div ref={bottomRef} />
//         </div>
//       </ScrollArea>

//       {/* Input */}
//       <div className="border-t border-[#3e3e42] p-3 shrink-0">
//         <div className="flex items-center gap-2 bg-[#252526] border border-[#3e3e42] rounded-lg px-3 py-2 focus-within:border-indigo-500/50 transition-colors">
//           <input
//             ref={inputRef}
//             value={input}
//             onChange={(e) => setInput(e.target.value)}
//             onKeyDown={(e) => {
//               if (e.key === "Enter" && !e.shiftKey) {
//                 e.preventDefault();
//                 handleSend();
//               }
//             }}
//             placeholder={
//               targetFile ? `Ask about ${targetFile}…` : "Ask about your files…"
//             }
//             disabled={isStreaming}
//             className="flex-1 bg-transparent border-none outline-none text-sm text-[#d4d4d4] placeholder:text-[#3a3a3a] disabled:opacity-50"
//           />
//           <Button
//             variant="ghost"
//             size="icon"
//             className="w-7 h-7 shrink-0"
//             onClick={handleSend}
//             disabled={!input.trim() || isStreaming}
//           >
//             {isStreaming ? (
//               <Loader2 size={13} className="animate-spin text-indigo-400" />
//             ) : (
//               <Send size={13} />
//             )}
//           </Button>
//         </div>
//         <p className="text-[10px] text-[#3a3a3a] mt-1.5 text-center">
//           Powered by Gemma 3 · answers grounded on your files
//         </p>
//       </div>
//     </div>
//   );
// }

// // ── Message bubble ─────────────────────────────────────────────────────────────

// function MessageBubble({ message }: { message: Message }) {
//   const [sourcesOpen, setSourcesOpen] = useState(false);
//   const isUser = message.role === "user";

//   return (
//     <div className={`flex gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
//       <div
//         className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5
//           ${isUser ? "bg-indigo-500/20" : "bg-[#2d2d30] border border-[#3e3e42]"}`}
//       >
//         {isUser ? (
//           <User size={11} className="text-indigo-400" />
//         ) : (
//           <Bot size={11} className="text-[#6a6a6a]" />
//         )}
//       </div>

//       <div
//         className={`flex flex-col gap-1 max-w-[82%] ${isUser ? "items-end" : "items-start"}`}
//       >
//         <div
//           className={`rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap
//             ${
//               isUser
//                 ? "bg-indigo-500/20 text-[#d4d4d4] border border-indigo-500/20"
//                 : "bg-[#252526] text-[#d4d4d4] border border-[#3e3e42]"
//             }`}
//         >
//           {message.content || (
//             <span className="flex gap-1 items-center">
//               <span
//                 className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce"
//                 style={{ animationDelay: "0ms" }}
//               />
//               <span
//                 className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce"
//                 style={{ animationDelay: "150ms" }}
//               />
//               <span
//                 className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce"
//                 style={{ animationDelay: "300ms" }}
//               />
//             </span>
//           )}
//         </div>

//         {/* Sources */}
//         {message.sources && message.sources.length > 0 && (
//           <div className="w-full">
//             <button
//               onClick={() => setSourcesOpen((v) => !v)}
//               className="flex items-center gap-1 text-[10px] text-[#4a4a4a] hover:text-[#6a6a6a] transition-colors"
//             >
//               <FileText size={9} />
//               {message.sources.length} source
//               {message.sources.length !== 1 ? "s" : ""}
//               {sourcesOpen ? <ChevronUp size={9} /> : <ChevronDown size={9} />}
//             </button>
//             {sourcesOpen && (
//               <div className="mt-1 flex flex-col gap-0.5">
//                 {message.sources.map((s) => (
//                   <div
//                     key={s.file_name}
//                     className="flex items-center justify-between text-[10px] px-2 py-1
//                       bg-[#2d2d30] border border-[#3e3e42] rounded text-[#6a6a6a]"
//                   >
//                     <span className="truncate mr-2">{s.file_name}</span>
//                     <span className="shrink-0 text-[9px] font-mono text-indigo-400/70">
//                       {Math.round(s.similarity * 100)}%
//                     </span>
//                   </div>
//                 ))}
//               </div>
//             )}
//           </div>
//         )}
//       </div>
//     </div>
//   );
// }


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
}

interface Props {
  open: boolean;
  onClose: () => void;
  targetFile?: string | null;
  // session key — increment to force a full remount and clear all state
  sessionKey: number;
}

export function AIPanel({ open, onClose, targetFile, sessionKey }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Initialize fresh messages whenever sessionKey changes (i.e. panel reopened)
  useEffect(() => {
    const welcome: Message = {
      id: "welcome",
      role: "assistant",
      content: targetFile
        ? `I'll help you with **${targetFile}**. Ask me to summarise it or ask any question about its content.`
        : "Ask me anything about your files — I can summarise documents, answer questions about content, or help find specific information.",
    };
    setMessages([welcome]);
    setInput("");
    setIsStreaming(false);
    setTimeout(() => inputRef.current?.focus(), 100);

    // Auto-summarise if a target file was passed
    if (targetFile) {
      setTimeout(() => {
        triggerSend(`Summarise ${targetFile}`, [], targetFile);
      }, 400);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  // Scroll to bottom on new content
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Wire Wails events — re-register whenever sessionKey changes so stale handlers don't fire
  useEffect(() => {
    wails.on("chat-token", (data: { content: string }) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          return [...prev.slice(0, -1), { ...last, content: last.content + data.content }];
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
        { id: Date.now().toString(), role: "assistant", content: `⚠️ ${err}` },
      ]);
    });

    return () => {
      wails.off("chat-token");
      wails.off("chat-sources");
      wails.off("chat-done");
      wails.off("chat-error");
    };
  }, [sessionKey]);

  const triggerSend = (
    text: string,
    currentMessages: Message[],
    fileContext?: string
  ) => {
    const q = text.trim();
    if (!q) return;

    const userMsg: Message = { id: Date.now().toString(), role: "user", content: q };
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

  const handleSend = () => {
    if (!input.trim() || isStreaming) return;
    triggerSend(input, messages);
    setInput("");
  };

  if (!open) return null;

  return (
    <div
      className="flex flex-col bg-[#1a1a1a] border-l border-[#3e3e42]"
      style={{ width: 360, minWidth: 360, maxWidth: 360 }}
    >
      {/* Header — fixed height */}
      <div className="flex items-center gap-2 px-4 h-12 border-b border-[#3e3e42] shrink-0">
        <Sparkles size={14} className="text-indigo-400 shrink-0" />
        <span className="text-sm font-medium text-[#d4d4d4]">Duckietown AI</span>
        {targetFile && (
          <Badge
            variant="outline"
            className="text-[9px] font-mono ml-1 h-4 px-1.5 max-w-[120px] truncate"
          >
            {targetFile}
          </Badge>
        )}
        <button
          onClick={onClose}
          className="ml-auto text-[#4a4a4a] hover:text-[#d4d4d4] transition-colors shrink-0"
        >
          <X size={14} />
        </button>
      </div>

      {/* Messages — ScrollArea with explicit flex-1 and min-h-0 to enable scroll */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-4 p-4 pb-2">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>
      </div>

      {/* Input — fixed at bottom */}
      <div className="border-t border-[#3e3e42] p-3 shrink-0">
        <div className="flex items-center gap-2 bg-[#252526] border border-[#3e3e42] rounded-lg px-3 py-2 focus-within:border-indigo-500/50 transition-colors">
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
            placeholder={targetFile ? `Ask about ${targetFile}…` : "Ask about your files…"}
            disabled={isStreaming}
            className="flex-1 bg-transparent border-none outline-none text-sm text-[#d4d4d4] placeholder:text-[#3a3a3a] disabled:opacity-50"
          />
          <Button
            variant="ghost"
            size="icon"
            className="w-7 h-7 shrink-0"
            onClick={handleSend}
            disabled={!input.trim() || isStreaming}
          >
            {isStreaming ? (
              <Loader2 size={13} className="animate-spin text-indigo-400" />
            ) : (
              <Send size={13} />
            )}
          </Button>
        </div>
        <p className="text-[10px] text-[#3a3a3a] mt-1.5 text-center">
          Powered by Gemma 3 · answers grounded on your files
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
          ${isUser ? "bg-indigo-500/20" : "bg-[#2d2d30] border border-[#3e3e42]"}`}
      >
        {isUser ? (
          <User size={11} className="text-indigo-400" />
        ) : (
          <Bot size={11} className="text-[#6a6a6a]" />
        )}
      </div>

      <div className={`flex flex-col gap-1 max-w-[82%] ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={`rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words
            ${isUser
              ? "bg-indigo-500/20 text-[#d4d4d4] border border-indigo-500/20"
              : "bg-[#252526] text-[#d4d4d4] border border-[#3e3e42]"
            }`}
        >
          {message.content || (
            <span className="flex gap-1 items-center">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: "300ms" }} />
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
              {message.sources.length} source{message.sources.length !== 1 ? "s" : ""}
              {sourcesOpen ? <ChevronUp size={9} /> : <ChevronDown size={9} />}
            </button>
            {sourcesOpen && (
              <div className="mt-1 flex flex-col gap-0.5">
                {message.sources.map((s) => (
                  <div
                    key={s.file_name}
                    className="flex items-center justify-between text-[10px] px-2 py-1
                      bg-[#2d2d30] border border-[#3e3e42] rounded text-[#6a6a6a]"
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