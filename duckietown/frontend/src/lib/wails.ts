// Typed wrappers around the Wails-generated Go bindings
// Wails auto-generates these in wailsjs/go/main/App.js - we just type them

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
} from "../../wailsjs/go/main/App";

import { EventsOn, EventsOff } from "../../wailsjs/runtime/runtime";

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

  // Events
  on: EventsOn,
  off: EventsOff,
};
