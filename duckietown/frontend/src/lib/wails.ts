import {
  GetVaultPath,
  SetVaultPath,
  SelectFolder,
  OpenVaultFolder,
  ListFiles,
  DeleteFile,
  RenameFile,
  OpenFile,
  GetFilePreview,
  SignInWithGoogle,
  SignOut,
  GetCurrentUser,
  SemanticSearch,
  ChatWithAgent,
} from "../../wailsjs/go/main/App";

import { EventsOn, EventsOff } from "../../wailsjs/runtime/runtime";

import type { SearchResult } from "../types";

export const wails = {
  // Auth
  signInWithGoogle: (): Promise<void> => SignInWithGoogle(),
  signOut: (): Promise<void> => SignOut(),
  getCurrentUser: () => GetCurrentUser(),

  // Vault
  getVaultPath: (): Promise<string> => GetVaultPath(),
  setVaultPath: (path: string): Promise<void> => SetVaultPath(path),
  selectFolder: (): Promise<string> => SelectFolder(),
  openVaultFolder: (): Promise<void> => OpenVaultFolder(),

  // Files
  listFiles: () => ListFiles(),
  deleteFile: (name: string) => DeleteFile(name),
  renameFile: (oldName: string, newName: string) =>
    RenameFile(oldName, newName),
  openFile: (name: string) => OpenFile(name),
  getFilePreview: (name: string): Promise<string> => GetFilePreview(name),

  // AI — semantic search
  semanticSearch: (query: string, topK = 50): Promise<SearchResult[]> =>
    SemanticSearch(query, topK),

  // AI — chat (streams back via events: chat-token, chat-sources, chat-done, chat-error)
  // fileName: optional — if provided, grounds the response on that specific file
  chatWithAgent: (
    message: string,
    history: Array<{ role: string; content: string }>,
    fileName = "",
  ): Promise<void> => ChatWithAgent(message, history, fileName),

  // Events
  on: EventsOn,
  off: EventsOff,
};
