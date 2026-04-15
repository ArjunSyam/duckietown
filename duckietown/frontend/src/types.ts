export interface FileRecord {
  id?: string;
  name: string;
  size: number;
  mime_type: string;
  folder_path: string; // "" = root, "work" = inside work/, "work/invoices" = nested
  created_at: string;
  updated_at: string;
  storage_path: string;
}

export interface FolderRecord {
  path: string; // relative from vault root e.g. "work/invoices"
  name: string; // last segment e.g. "invoices"
  parent: string; // parent path e.g. "work", "" for root-level folders
  children: number; // number of direct subfolders
}

export type ViewMode = "grid" | "list";

export type FileTypeFilter =
  | "all"
  | "images"
  | "documents"
  | "videos"
  | "audio"
  | "other";

export interface WailsFileEvent {
  event_type: "created" | "modified" | "deleted";
  file_name: string;
  path?: string;
  folder?: string;
}

export interface SearchResult {
  file_name: string;
  similarity: number;
  snippet: string;
  modality: string;
  page: string;
}

export interface OrganiseResult {
  folder_name: string;
  files: string[];
  created: boolean;
  error?: string;
}
