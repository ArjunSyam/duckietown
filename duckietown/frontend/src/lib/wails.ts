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
} from "../../wailsjs/go/main/App";

import { EventsOn, EventsOff } from "../../wailsjs/runtime/runtime";

import type { SearchResult, FolderRecord, OrganiseResult } from "../types";

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

  // AI — chat
  chatWithAgent: (
    message: string,
    history: Array<{ role: string; content: string }>,
    fileName = "",
  ): Promise<void> => ChatWithAgent(message, history, fileName),

  // AI — folder organisation
  organiseFolder: (
    currentFolderPath: string,
    query: string,
    newFolderName: string,
  ): Promise<OrganiseResult> =>
    OrganiseFolder(currentFolderPath, query, newFolderName),

  // Events
  on: EventsOn,
  off: EventsOff,
};
