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
  ListFolders,
  CreateFolder,
  DeleteFolder,
  MoveFileToFolder,
  OrganiseFolder,
  ParseOrganiseIntent,
} from "../../wailsjs/go/main/App";

import { EventsOn, EventsOff } from "../../wailsjs/runtime/runtime";

import type { SearchResult, FolderRecord, OrganiseResult } from "../types";

export interface OrganiseIntent {
  is_organise: boolean;
  query?: string;
  folder_name?: string;
  type_filter?: string;
  error?: string;
}

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

  // Folders
  listFolders: (): Promise<FolderRecord[]> => ListFolders(),
  createFolder: (relativePath: string): Promise<void> =>
    CreateFolder(relativePath),
  deleteFolder: (relativePath: string): Promise<void> =>
    DeleteFolder(relativePath),
  moveFileToFolder: (
    fileName: string,
    targetFolderPath: string,
  ): Promise<void> => MoveFileToFolder(fileName, targetFolderPath),

  // AI — semantic search
  semanticSearch: (query: string, topK = 50): Promise<SearchResult[]> =>
    SemanticSearch(query, topK),

  // AI — chat (streams back via events)
  chatWithAgent: (
    message: string,
    history: Array<{ role: string; content: string }>,
    fileName = "",
  ): Promise<void> => ChatWithAgent(message, history, fileName),

  // AI — parse organise intent via Gemma
  parseOrganiseIntent: (message: string): Promise<OrganiseIntent> =>
    ParseOrganiseIntent(message),

  // AI — folder organisation
  // typeFilter: "image" | "text" | "audio" | "video" | ""
  organiseFolder: (
    currentFolderPath: string,
    query: string,
    newFolderName: string,
    typeFilter = "",
  ): Promise<OrganiseResult> =>
    OrganiseFolder(currentFolderPath, query, newFolderName, typeFilter),

  // Events
  on: EventsOn,
  off: EventsOff,
};
