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
  GetChatModel,
  ListFolders,
  CreateFolder,
  DeleteFolder,
  MoveFileToFolder,
  OrganiseFolder,
  UndoLastOrganise,
  ParseOrganiseIntent,
  ProposeOrganise,
  ConfirmOrganisePlan,
  CancelOrganisePlan,
  BackfillFileProfiles,
  ConfirmRenamePlan,
  CancelRenamePlan,
  GetExplorerIntegrationEnabled,
  SetExplorerIntegrationEnabled,
  RemoveExplorerIntegration,
} from "../../wailsjs/go/main/App";

import { EventsOn, EventsOff, BrowserOpenURL } from "../../wailsjs/runtime/runtime";

import type {
  SearchResult,
  FolderRecord,
  OrganiseResult,
  OrganisePreview,
  ConfirmOrganiseResult,
  BackfillResult,
  RenameSelection,
  ConfirmRenameResult,
} from "../types";

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

  // AI — parse organise intent (back-compat; the new UI flow uses
  // proposeOrganise/confirmOrganisePlan instead, see below)
  parseOrganiseIntent: (message: string): Promise<OrganiseIntent> =>
    ParseOrganiseIntent(message),

  // AI — the OpenRouter model id actually in use for chat
  getChatModel: (): Promise<string> => GetChatModel(),

  // AI — folder organisation
  // typeFilter: "image" | "text" | "audio" | "video" | ""
  organiseFolder: (
    currentFolderPath: string,
    query: string,
    newFolderName: string,
    typeFilter = "",
  ): Promise<OrganiseResult> =>
    OrganiseFolder(currentFolderPath, query, newFolderName, typeFilter),

  // AI — undo the most recent OrganiseFolder (one-shot, not a full history)
  undoLastOrganise: (): Promise<OrganiseResult> => UndoLastOrganise(),

  // AI — organise v2: search -> judge -> preview -> confirm -> move
  proposeOrganise: (
    message: string,
    currentFolder: string,
  ): Promise<OrganisePreview> => ProposeOrganise(message, currentFolder),
  confirmOrganisePlan: (
    planId: string,
    selectedFileNames: string[],
  ): Promise<ConfirmOrganiseResult> =>
    ConfirmOrganisePlan(planId, selectedFileNames),
  cancelOrganisePlan: (planId: string): Promise<void> =>
    CancelOrganisePlan(planId),

  // AI — backfill file profiles for files indexed before enrichment existed
  backfillFileProfiles: (): Promise<BackfillResult> => BackfillFileProfiles(),

  // AI — rename: search -> propose names -> preview -> confirm -> rename
  confirmRenamePlan: (
    planId: string,
    selections: RenameSelection[],
  ): Promise<ConfirmRenameResult> => ConfirmRenamePlan(planId, selections),
  cancelRenamePlan: (planId: string): Promise<void> => CancelRenamePlan(planId),

  // Windows Explorer integration (no-op on other OSes)
  getExplorerIntegrationEnabled: (): Promise<boolean> =>
    GetExplorerIntegrationEnabled(),
  setExplorerIntegrationEnabled: (enabled: boolean): Promise<void> =>
    SetExplorerIntegrationEnabled(enabled),
  removeExplorerIntegration: (): Promise<void> => RemoveExplorerIntegration(),

  // Events
  on: EventsOn,
  off: EventsOff,

  // Open a URL in the system browser instead of inside the Wails window
  openExternal: (url: string): void => BrowserOpenURL(url),
};
